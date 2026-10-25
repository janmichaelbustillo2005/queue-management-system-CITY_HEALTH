// R2.2 / W1: independent-connection PostgreSQL verification of cancel_patient_visit.
// Runs ONLY against a disposable LOCAL PostgreSQL 17 cluster: PHASE25_PG_URL must point at
// 127.0.0.1/localhost and the server must report cluster_name = PHASE25_PG_CLUSTER
// (default "r22-disposable-cancel-verification") and listen only on 127.0.0.1. The suite
// creates a fresh database, installs the repository migrations and the W1 migration
// (20261025-w1-atomic-cancel.sql) as a non-superuser "postgres" owner (as in Supabase's SQL editor), and drops the
// database afterwards. It never reads .env and never connects to Supabase.
// Skipped unless PHASE25_PG_URL and PHASE25_PG_MODULE (path to a `pg` package) are set.
// Optional: PHASE25_PG_EVIDENCE=<file> writes the operation order, observed lock waits and
// before/after state of every scenario as JSON.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID, randomBytes } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const {
  CANCEL, HELPER, MIGRATIONS, proposalSql, nodeFunction, read,
  BASE_SCHEMA, SUPABASE_DEFAULT_PRIVILEGES, ACCOUNTS, SEED
} = require("./helpers/phase25CancelFixture");

const TARGET = process.env.PHASE25_PG_URL;
const CLUSTER = process.env.PHASE25_PG_CLUSTER || "r22-disposable-cancel-verification";
let pg;
let unavailable;
if (!TARGET || !process.env.PHASE25_PG_MODULE) {
  unavailable = "Disposable local PostgreSQL not configured; set PHASE25_PG_URL and PHASE25_PG_MODULE.";
} else {
  pg = require(process.env.PHASE25_PG_MODULE);
}

const getDoctorForService = nodeFunction("getDoctorForService");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, message: error.message }));
const evidence = { target: null, tests: [] };

// Refuse anything that is not the disposable loopback cluster, before any SQL that writes.
async function assertDisposableTarget(client) {
  const url = new URL(TARGET);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "PHASE25_PG_URL must be a loopback address");
  assert.ok(!/supabase/i.test(TARGET), "Supabase targets are never allowed");
  const { rows: [server] } = await client.query(`SELECT current_setting('cluster_name') AS cluster,
    host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('listen_addresses') AS listen,
    current_setting('server_version') AS version, current_setting('server_version_num')::int AS version_num,
    current_setting('data_directory') AS data_directory, current_database() AS database`);
  assert.equal(server.cluster, CLUSTER, "unexpected cluster_name: not the disposable test cluster");
  assert.equal(server.address, "127.0.0.1");
  assert.equal(server.listen, "127.0.0.1", "the test server must listen on loopback only");
  assert.ok(server.version_num >= 170000, "PostgreSQL 17 or later is required");
  return server;
}

describe("R2.2 cancel_patient_visit on real PostgreSQL with independent connections", { skip: unavailable }, () => {
  let admin; let observer; let setup; let dbName; let testUrl;
  const sessions = {};          // independent connections: A, B, C (service_role) and soak workers
  let A; let B; let C;
  const actors = {};

  async function connect(name, { serviceRole = true } = {}) {
    const client = new pg.Client({ connectionString: testUrl, application_name: `r22-${name}` });
    await client.connect();
    if (serviceRole) await client.query("SET ROLE service_role");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { name, client, pid };
  }

  before(async () => {
    admin = new pg.Client({ connectionString: TARGET, application_name: "r22-admin" });
    await admin.connect();
    evidence.target = await assertDisposableTarget(admin);
    // Cluster-wide synthetic roles. "postgres" is deliberately NOT a superuser and has no
    // BYPASSRLS, like Supabase's role; service_role bypasses RLS, like Supabase's.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$`);
    dbName = `r22_cancel_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName} OWNER postgres TEMPLATE template0`);
    const url = new URL(TARGET); url.pathname = `/${dbName}`; testUrl = url.toString();
    evidence.target.test_database = dbName;

    setup = new pg.Client({ connectionString: testUrl, application_name: "r22-setup" });
    await setup.connect();
    assert.equal((await assertDisposableTarget(setup)).database, dbName);
    // Install exactly as the Supabase SQL editor would: as the non-superuser owner.
    await setup.query("SET ROLE postgres");
    await setup.query(SUPABASE_DEFAULT_PRIVILEGES);
    await setup.query(BASE_SCHEMA);
    for (const script of MIGRATIONS) await setup.query(read(script));
    await setup.query(proposalSql());
    await setup.query("RESET ROLE");

    observer = await connect("observer", { serviceRole: false });
    for (const name of ["A", "B", "C"]) sessions[name] = await connect(name);
    ({ A, B, C } = sessions);
  });

  after(async () => {
    for (const session of Object.values(sessions)) await session.client.end().catch(() => {});
    if (observer) await observer.client.end().catch(() => {});
    if (setup) await setup.end().catch(() => {});
    if (admin && dbName && process.env.PHASE25_PG_KEEP !== "1") await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    if (admin) await admin.end();
    if (process.env.PHASE25_PG_EVIDENCE) fs.writeFileSync(process.env.PHASE25_PG_EVIDENCE, JSON.stringify(evidence, null, 2));
  });

  beforeEach(async () => {
    await observer.client.query(SEED);
    for (const [idNum, [role, doctor]] of Object.entries(ACCOUNTS)) actors[idNum] = await login(idNum, role, doctor);
  });

  async function login(idNum, role, doctor) {
    const session = randomUUID();
    const revision = (await observer.client.query("SELECT auth_revision FROM public.users WHERE id_num = $1", [idNum])).rows[0].auth_revision;
    await observer.client.query("SELECT public.create_staff_auth_session($1, $2, $3, $4, $5)", [session, idNum, role, doctor, revision]);
    return { session, idNum, role, doctor };
  }
  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0]?.value;
  const patient = (id) => one(observer.client, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
  const pointer = async (doctor) => {
    const value = (await observer.client.query("SELECT current_patient_id FROM public.counters WHERE id_num = $1", [doctor])).rows[0]?.current_patient_id;
    return value == null ? null : Number(value);
  };
  const state = async () => ({
    patients: await one(observer.client, "SELECT coalesce(json_agg(row_to_json(p) ORDER BY p.id), '[]') AS value FROM public.patients p"),
    counters: await one(observer.client, "SELECT coalesce(json_agg(json_build_object('id', c.id, 'id_num', c.id_num, 'current_patient_id', c.current_patient_id) ORDER BY c.id), '[]') AS value FROM public.counters c"),
    sessions: await one(observer.client, "SELECT coalesce(json_agg(json_build_object('user', s.user_id_num, 'revoked', s.revoked_at IS NOT NULL) ORDER BY s.user_id_num, s.created_at), '[]') AS value FROM public.staff_auth_sessions s")
  });
  const clinical = (rows) => rows.map(({ id, status, counter_id, called_at, consultation_started_at, completed_at, created_at, reason, visit_state_revision }) =>
    ({ id, status, counter_id, called_at, consultation_started_at, completed_at, created_at, reason, visit_state_revision }));

  // --- operations, issued as the backend issues them (RPCs and PostgREST-style single statements)
  function cancel(session, patientId, actorName, current, { reason = "Synthetic reason", requested = null, overrides = {} } = {}) {
    const actor = actors[actorName];
    const args = {
      p_patient_id: patientId, p_session_id: actor.session, p_user_id_num: actor.idNum, p_role: actor.role,
      p_doctor_name: actor.doctor, p_expected_revision: current.visit_state_revision, p_expected_status: current.status,
      p_reason: reason, p_requested_counter: requested, ...overrides
    };
    const entries = Object.entries(args);
    return one(session.client, `SELECT row_to_json(p) AS value FROM public.cancel_patient_visit(${
      entries.map(([key], index) => `${key} => $${index + 1}`).join(", ")}) p`, entries.map(([, value]) => value));
  }
  const complete = (s, id, number, startedAt) => one(s.client, `SELECT row_to_json(p) AS value FROM public.complete_patient_consultation(
    $1, $2, $3, $4, 'Synthetic completion') p`, [id, `Doctor ${number}`, `admin${number}`, startedAt]);
  const start = (s, id, number) => one(s.client, `SELECT row_to_json(p) AS value FROM public.start_patient_consultation(
    $1, $2, $3, clock_timestamp()) p`, [id, `Doctor ${number}`, `admin${number}`]);
  const recover = (s, fn, action, snap) => one(s.client, `SELECT row_to_json(p) AS value FROM public.${fn}(
    $1, $2, 'frontdesk', $3, $4, $5, $6, $7, $8, $9, $10) p`, [snap.id, action, snap.visit_state_revision, snap.status,
    snap.created_at, snap.called_at, snap.consultation_started_at, snap.completed_at, snap.counter_id,
    action === "requeue" ? "Synthetic requeue" : null]);
  const rowCount = async (s, sql, values) => (await s.client.query(sql, values)).rowCount;
  const noShowCas = (s, snap) => rowCount(s, `UPDATE public.patients SET status = 'no-show', completed_at = clock_timestamp(),
    reason = 'Synthetic no-show' WHERE id = $1 AND status = $2 AND visit_state_revision = $3`, [snap.id, snap.status, snap.visit_state_revision]);
  const releaseAll = (s, id) => rowCount(s, "UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = $1", [id]);
  const recallCas = (s, snap) => rowCount(s, `UPDATE public.patients SET called_at = clock_timestamp()
    WHERE id = $1 AND status = 'serving' AND consultation_started_at IS NULL AND visit_state_revision = $2`, [snap.id, snap.visit_state_revision]);
  const claim = (s, id, doctor) => rowCount(s, `UPDATE public.counters SET current_patient_id = $1
    WHERE id_num = $2 AND is_online AND current_patient_id IS NULL`, [id, doctor]);
  const serve = (s, id, doctor, serviceType) => rowCount(s, `UPDATE public.patients SET status = 'serving', counter_id = $2,
    called_at = clock_timestamp() WHERE id = $1 AND status = 'waiting' AND service_type = $3 AND completed_at IS NULL
    AND counter_id IS NULL`, [id, doctor, serviceType]);
  const compensate = (s, id, doctor) => rowCount(s, "UPDATE public.counters SET current_patient_id = NULL WHERE id_num = $2 AND current_patient_id = $1", [id, doctor]);

  // --- barriers and evidence
  async function waitBlocked(ev, waiter, holders) {
    const list = [].concat(holders);
    const deadline = Date.now() + 8000;
    for (;;) {
      const { rows: [row] } = await observer.client.query(`SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid = $1`, [waiter.pid]);
      if (row?.wait_event_type === "Lock" && list.some((h) => row.blockers.includes(h.pid))) {
        const locks = (await observer.client.query(`SELECT locktype, mode, relation::regclass::text AS relation
          FROM pg_locks WHERE pid = $1 AND NOT granted`, [waiter.pid])).rows;
        const blockedBy = list.filter((h) => row.blockers.includes(h.pid)).map((h) => h.name).join("+");
        ev.waits.push({ ms: Date.now() - ev.started, waiter: waiter.name, blocked_by: blockedBy, wait_event: row.wait_event, locks });
        ev.log(waiter.name, `observed waiting on ${blockedBy} (${row.wait_event})`);
        return;
      }
      if (Date.now() > deadline) throw new Error(`${waiter.name} was not observed waiting on ${list.map((h) => h.name).join("/")}`);
      await sleep(15);
    }
  }
  async function step(ev, session, label, action) {
    ev.log(session.name, label);
    const outcome = await settle(action());
    ev.log(session.name, `${label} -> ${outcome.ok ? "ok" : outcome.code}`);
    return outcome;
  }
  // Starts an operation that is expected to block. Returns { pending } (not the promise itself,
  // which an async function would adopt and so wait for).
  async function blockedStep(ev, session, holder, label, action) {
    ev.log(session.name, `${label} (expected to wait)`);
    const pending = settle(action()).then((outcome) => { ev.log(session.name, `${label} -> ${outcome.ok ? "ok" : outcome.code}`); return outcome; });
    await waitBlocked(ev, session, holder);
    return { pending };
  }
  const exec = (ev, session, sql) => step(ev, session, sql, () => session.client.query(sql));

  function scenario(name, body, options = {}) {
    test(name, options, async () => {
      const ev = { name, steps: [], waits: [], started: Date.now(), before: await state() };
      ev.log = (conn, text) => ev.steps.push({ ms: Date.now() - ev.started, conn, step: text });
      try {
        await body(ev);
        ev.result = "pass";
      } catch (error) {
        ev.result = "fail"; ev.error = error.message;
        throw error;
      } finally {
        for (const session of Object.values(sessions)) await session.client.query("ROLLBACK").catch(() => {});
        ev.after = await state();
        delete ev.log;
        evidence.tests.push(ev);
      }
    });
  }
  const expectCode = (outcome, code) => assert.equal(outcome.ok ? "ok" : outcome.code, code, outcome.message);
  const expectOk = (outcome) => { assert.ok(outcome.ok, `${outcome.code}: ${outcome.message}`); return outcome.value; };
  async function setDeadlockTimeout(session, value) {
    await session.client.query("ROLLBACK").catch(() => {});
    await session.client.query("RESET ROLE");
    await session.client.query(`SET deadlock_timeout = '${value}'`);
    await session.client.query("SET ROLE service_role");
  }

  // ===========================================================================
  describe("environment, ownership, grants and effective RLS (real roles)", () => {
    test("target is the disposable loopback cluster and the draft installed as a NON-superuser owner", async () => {
      const server = await assertDisposableTarget(observer.client);
      assert.equal(server.database, dbName);
      const { rows } = await observer.client.query(`SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig,
          r.rolname AS owner, r.rolsuper, r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid IN (to_regprocedure($1), to_regprocedure($2)) ORDER BY 1`, [CANCEL, HELPER]);
      const rpc = rows.find((row) => row.signature.startsWith("cancel"));
      const helper = rows.find((row) => row.signature.startsWith("qms"));
      assert.deepEqual([rpc.prosecdef, rpc.proconfig, rpc.owner, rpc.rolsuper, rpc.rolbypassrls],
        [true, ['search_path=""', "lock_timeout=5s"], "postgres", false, false]);
      assert.deepEqual([helper.prosecdef, helper.proconfig, helper.owner], [false, ['search_path=""'], "postgres"]);
    });

    test("tables are RLS-enabled, not FORCE, and owned by the function owner (owner bypass is what makes the RPC work)", async () => {
      const { rows } = await observer.client.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c WHERE c.oid IN ('public.patients'::regclass, 'public.counters'::regclass, 'public.users'::regclass, 'public.staff_auth_sessions'::regclass)
        ORDER BY 1`);
      for (const row of rows) assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity, row.owner], [true, false, "postgres"], row.relname);
      assert.equal((await observer.client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('patients','counters','users')")).rows[0].n, 0);
    });

    test("EXECUTE: only service_role on the RPC, nobody on the helper; anon/authenticated calls fail", async () => {
      const privilege = async (role, fn) => (await observer.client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn])).rows[0].ok;
      assert.deepEqual(await Promise.all(["anon", "authenticated", "service_role"].map((role) => privilege(role, CANCEL))), [false, false, true]);
      assert.deepEqual(await Promise.all(["anon", "authenticated", "service_role"].map((role) => privilege(role, HELPER))), [false, false, false]);
      const current = await patient(1);
      for (const role of ["anon", "authenticated"]) {
        const probe = await connect(`probe-${role}`, { serviceRole: false });
        try {
          await probe.client.query(`SET ROLE ${role}`);
          expectCode(await settle(cancel(probe, 1, "frontdesk", current)), "42501");
          expectCode(await settle(probe.client.query("SELECT public.qms_resolve_doctor_counter('Doctor 1')")), "42501");
        } finally { await probe.client.end(); }
      }
      expectCode(await settle(sessions.A.client.query("SELECT public.qms_resolve_doctor_counter('Doctor 1')")), "42501");
      assert.deepEqual(await patient(1), current);
    });

    test("FORCE ROW LEVEL SECURITY on patients makes the non-superuser owner fail closed with a misleading P0002", async () => {
      await observer.client.query("ALTER TABLE public.patients FORCE ROW LEVEL SECURITY");
      try {
        const current = await patient(2);
        expectCode(await settle(cancel(sessions.A, 2, "admin1", current)), "P0002");
        assert.deepEqual(await patient(2), current);
        assert.equal(await pointer("Doctor 1"), 2);
      } finally { await observer.client.query("ALTER TABLE public.patients NO FORCE ROW LEVEL SECURITY"); }
    });
  });

  // ===========================================================================
  describe("contract on real PostgreSQL (single connection per call)", () => {
    test("SQLSTATE matrix and no writes on every refusal", async () => {
      const before = await state();
      const A = sessions.A;
      expectCode(await settle(cancel(A, 1, "frontdesk", await patient(1), { reason: "  " })), "22023");
      expectCode(await settle(cancel(A, 1, "frontdesk", await patient(1), { reason: "x".repeat(1001) })), "22023");
      expectCode(await settle(cancel(A, 1, "frontdesk", await patient(1), { requested: "Doctor 9" })), "22023");
      expectCode(await settle(cancel(A, 999, "frontdesk", { visit_state_revision: randomUUID(), status: "waiting" })), "P0002");
      expectCode(await settle(cancel(A, 2, "admin2", await patient(2))), "42501");
      expectCode(await settle(cancel(A, 7, "admin1", await patient(7))), "42501");
      expectCode(await settle(cancel(A, 1, "frontdesk", { ...(await patient(1)), visit_state_revision: randomUUID() })), "40001");
      expectCode(await settle(cancel(A, 4, "admin1", await patient(4))), "QM001");
      expectCode(await settle(cancel(A, 5, "admin3", await patient(5))), "QM002");
      expectCode(await settle(cancel(A, 1, "frontdesk", await patient(1), { requested: "Doctor 2" })), "QM003");
      expectCode(await settle(cancel(A, 2, "admin1", await patient(2), { overrides: { p_session_id: actors.admin2.session } })), "28000");
      expectCode(await settle(cancel(A, 2, "admin1", await patient(2), { overrides: { p_role: "superadmin" } })), "28000");
      assert.deepEqual(await state(), before);
    });

    test("success preserves consultation history and releases only that visit's counter; repeat is idempotent", async () => {
      const before = await patient(2);
      const after = await cancel(sessions.A, 2, "admin1", before);
      assert.deepEqual([after.status, after.reason, after.called_at, after.consultation_started_at, after.created_at, after.counter_id],
        ["cancelled", "Synthetic reason", before.called_at, before.consultation_started_at, before.created_at, "Doctor 1"]);
      assert.notEqual(after.visit_state_revision, before.visit_state_revision);
      assert.deepEqual([await pointer("Doctor 1"), await pointer("Doctor 2")], [null, 3]);
      assert.deepEqual(await cancel(sessions.B, 2, "frontdesk", after, { reason: "Other" }), after);
    });

    test("revoked, expired, password-changed and reassigned sessions are refused on real PostgreSQL", async () => {
      const before = await state();
      await observer.client.query("SELECT public.revoke_staff_auth_session($1, 'admin1')", [actors.admin1.session]);
      expectCode(await settle(cancel(sessions.A, 2, "admin1", await patient(2))), "28000");
      await observer.client.query(`UPDATE public.staff_auth_sessions SET created_at = clock_timestamp() - interval '9 hours',
        expires_at = clock_timestamp() - interval '1 second' WHERE session_id = $1`, [actors.frontdesk.session]);
      expectCode(await settle(cancel(sessions.A, 1, "frontdesk", await patient(1))), "28000");
      await observer.client.query("UPDATE public.users SET password = 'changed-synthetic' WHERE id_num = 'admin2'");
      expectCode(await settle(cancel(sessions.A, 3, "admin2", await patient(3))), "28000");
      await observer.client.query("UPDATE public.users SET doctor_name = 'Doctor 1' WHERE id_num = 'admin3'");
      await observer.client.query("UPDATE public.staff_auth_sessions SET revoked_at = NULL WHERE session_id = $1", [actors.admin3.session]);
      expectCode(await settle(cancel(sessions.A, 2, "admin3", await patient(2))), "28000");
      assert.deepEqual(clinical((await state()).patients), clinical(before.patients));
      assert.deepEqual((await state()).counters, before.counters);
    });

    test("rollback: a failing or suppressed counter release leaves patient and counters untouched", async () => {
      await observer.client.query("SET ROLE postgres");
      await observer.client.query(`
        CREATE FUNCTION public.r22_fail_release() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.current_patient_id IS NULL AND current_setting('r22.mode', true) = 'fail' THEN
          RAISE EXCEPTION 'synthetic release failure' USING ERRCODE = 'XX001'; END IF;
          IF NEW.current_patient_id IS NULL AND current_setting('r22.mode', true) = 'skip' THEN RETURN NULL; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER r22_fail_release BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.r22_fail_release();`);
      await observer.client.query("RESET ROLE");
      try {
        for (const [mode, code] of [["fail", "XX001"], ["skip", "QM500"]]) {
          const before = await state();
          await sessions.A.client.query(`SET r22.mode = '${mode}'`);
          expectCode(await settle(cancel(sessions.A, 2, "admin1", await patient(2))), code);
          assert.deepEqual(await state(), before, `${mode}: no partial commit`);
        }
      } finally {
        await sessions.A.client.query("RESET r22.mode");
        await observer.client.query("DROP TRIGGER r22_fail_release ON public.counters; DROP FUNCTION public.r22_fail_release()");
      }
    });
  });

  // ===========================================================================
  describe("independent-connection races with transaction barriers", () => {

    scenario("1a. Cancel vs Cancel (same snapshot): the waiter re-reads after commit and gets 40001; retry is idempotent", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      const first = expectOk(await step(ev, A, "cancel P3 (frontdesk, 'First')", () => cancel(A, 3, "frontdesk", snap, { reason: "First" })));
      const waiting = await blockedStep(ev, B, A, "cancel P3 (superadmin, same snapshot)", () => cancel(B, 3, "superadmin", snap, { reason: "Second" }));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      assert.deepEqual(await patient(3), first);
      assert.deepEqual(expectOk(await step(ev, B, "retry with fresh snapshot", async () => cancel(B, 3, "superadmin", await patient(3)))), first);
      assert.equal(await pointer("Doctor 2"), null);
    });

    scenario("1b. Cancel vs Cancel: if the holder rolls back, the waiter's cancel is the only transition", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "cancel P3 (frontdesk)", () => cancel(A, 3, "frontdesk", snap, { reason: "Rolled back" })));
      const waiting = await blockedStep(ev, B, A, "cancel P3 (admin2, same snapshot)", () => cancel(B, 3, "admin2", snap, { reason: "Winner" }));
      await exec(ev, A, "ROLLBACK");
      const winner = expectOk(await waiting.pending);
      assert.equal(winner.reason, "Winner");
      assert.equal(await pointer("Doctor 2"), null);
    });

    scenario("1c. Cancels of different doctors' patients serialize on the counter locks; both succeed", async (ev) => {
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "cancel P2 (admin1)", async () => cancel(A, 2, "admin1", await patient(2))));
      const p3 = await patient(3);
      const waiting = await blockedStep(ev, B, A, "cancel P3 (admin2)", () => cancel(B, 3, "admin2", p3));
      await exec(ev, A, "COMMIT");
      expectOk(await waiting.pending);
      assert.deepEqual([await pointer("Doctor 1"), await pointer("Doctor 2")], [null, null]);
    });

    scenario("2a. Complete holds the doctor counter; the waiting Cancel then sees a completed visit (40001, then QM001)", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      const completed = expectOk(await step(ev, A, "complete_patient_consultation P2", () => complete(A, 2, 1, snap.consultation_started_at)));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin1, pre-completion snapshot)", () => cancel(B, 2, "admin1", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      expectCode(await step(ev, B, "cancel P2 with fresh snapshot", async () => cancel(B, 2, "admin1", await patient(2))), "QM001");
      assert.deepEqual(await patient(2), completed, "completed history unchanged");
    });

    scenario("2b. Cancel holds the locks; the waiting Complete fails after commit and cannot overwrite the cancellation", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      const cancelled = expectOk(await step(ev, A, "cancel P2 (admin1)", () => cancel(A, 2, "admin1", snap)));
      const waiting = await blockedStep(ev, B, A, "complete_patient_consultation P2", () => complete(B, 2, 1, snap.consultation_started_at));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "42501");
      assert.deepEqual(await patient(2), cancelled);
    });

    scenario("2c. Start holds Doctor 2's counter; the waiting Cancel gets 40001; a fresh Cancel keeps the start time", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "start_patient_consultation P3", () => start(A, 3, 2)));
      const waiting = await blockedStep(ev, B, A, "cancel P3 (admin2, pre-start snapshot)", () => cancel(B, 3, "admin2", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      const started = await patient(3);
      const cancelled = expectOk(await step(ev, B, "cancel P3 fresh", () => cancel(B, 3, "admin2", started)));
      assert.equal(cancelled.consultation_started_at, started.consultation_started_at);
    });

    scenario("3a. No-show CAS holds the patient; Cancel waits holding all counters; No-show's separate release waits behind Cancel; no deadlock", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      assert.equal((await step(ev, A, "no-show CAS on P3", () => noShowCas(A, snap))).value, 1);
      const cancelling = await blockedStep(ev, B, A, "cancel P3 (admin2, same snapshot)", () => cancel(B, 3, "admin2", snap));
      const releasing = await blockedStep(ev, C, B, "no-show's second statement: release counters of P3", () => releaseAll(C, 3));
      await exec(ev, A, "COMMIT");
      expectCode(await cancelling.pending, "40001");
      assert.equal(expectOk(await releasing.pending), 1);
      assert.equal((await patient(3)).status, "no-show");
      assert.equal(await pointer("Doctor 2"), null);
    });

    scenario("3b. Cancel holds the patient; the waiting No-show CAS re-evaluates and matches no row", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      const cancelled = expectOk(await step(ev, A, "cancel P3 (admin2)", () => cancel(A, 3, "admin2", snap)));
      const waiting = await blockedStep(ev, B, A, "no-show CAS on P3 (same snapshot)", () => noShowCas(B, snap));
      await exec(ev, A, "COMMIT");
      assert.equal(expectOk(await waiting.pending), 0);
      assert.deepEqual(await patient(3), cancelled);
    });

    scenario("4a. Recall CAS holds the patient; the waiting Cancel gets 40001; recalled time is kept", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      assert.equal((await step(ev, A, "recall CAS on P3", () => recallCas(A, snap))).value, 1);
      const waiting = await blockedStep(ev, B, A, "cancel P3 (admin2, pre-recall snapshot)", () => cancel(B, 3, "admin2", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      const recalled = await patient(3);
      assert.equal(expectOk(await step(ev, B, "cancel fresh", () => cancel(B, 3, "admin2", recalled))).called_at, recalled.called_at);
    });

    scenario("4b. Cancel holds the patient; a delayed Recall matches no row", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "cancel P3", () => cancel(A, 3, "admin2", snap)));
      const waiting = await blockedStep(ev, B, A, "recall CAS on P3", () => recallCas(B, snap));
      await exec(ev, A, "COMMIT");
      assert.equal(expectOk(await waiting.pending), 0);
      assert.equal((await patient(3)).called_at, snap.called_at);
    });

    scenario("5a. Requeue holds the no-show patient; the waiting Cancel (holding all counters) gets 40001", async (ev) => {
      const snap = await patient(5);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "recover_patient_visit requeue P5", () => recover(A, "recover_patient_visit", "requeue", snap)));
      const waiting = await blockedStep(ev, B, A, "cancel P5 (admin3, no-show snapshot)", () => cancel(B, 5, "admin3", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      assert.equal((await patient(5)).status, "waiting");
    });

    scenario("5b. Cancel holds the patient; the waiting Requeue gets 40001", async (ev) => {
      const snap = await patient(3);
      await exec(ev, A, "BEGIN");
      const cancelled = expectOk(await step(ev, A, "cancel P3", () => cancel(A, 3, "frontdesk", snap)));
      const waiting = await blockedStep(ev, B, A, "requeue P3 (serving snapshot)", () => recover(B, "recover_patient_visit", "requeue", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      assert.deepEqual(await patient(3), cancelled);
    });

    scenario("6a. Undo holds all counters; a delayed repeat Cancel gets 40001, never 'already cancelled'", async (ev) => {
      const snap = await patient(6);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "undo_patient_visit_waiting P6", () => recover(A, "undo_patient_visit_waiting", "undo", snap)));
      const waiting = await blockedStep(ev, B, A, "repeat cancel P6 (cancelled snapshot)", () => cancel(B, 6, "admin1", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "40001");
      assert.equal((await patient(6)).status, "waiting");
    });

    scenario("6b. An idempotent repeat Cancel (releasing a stale pointer) does not invalidate a concurrent Undo", async (ev) => {
      await observer.client.query("UPDATE public.counters SET current_patient_id = 6 WHERE id_num = 'Doctor 3'");
      const snap = await patient(6);
      await exec(ev, A, "BEGIN");
      assert.deepEqual(expectOk(await step(ev, A, "repeat cancel P6", () => cancel(A, 6, "admin1", snap))), snap);
      const waiting = await blockedStep(ev, B, A, "undo P6 (same snapshot)", () => recover(B, "undo_patient_visit_waiting", "undo", snap));
      await exec(ev, A, "COMMIT");
      assert.equal(expectOk(await waiting.pending).status, "waiting");
      assert.equal(await pointer("Doctor 3"), null);
    });

    scenario("7a. Call's committed counter claim is released by the waiting Cancel; Call's patient update then fails cleanly", async (ev) => {
      const snap = await patient(8);
      await exec(ev, A, "BEGIN");
      assert.equal((await step(ev, A, "Call: claim Doctor 3 for P8", () => claim(A, 8, "Doctor 3"))).value, 1);
      const waiting = await blockedStep(ev, B, A, "cancel P8 (admin3)", () => cancel(B, 8, "admin3", snap));
      await exec(ev, A, "COMMIT");
      expectOk(await waiting.pending);
      assert.equal((await step(ev, A, "Call: serve CAS P8", () => serve(A, 8, "Doctor 3", "family_planning"))).value, 0);
      assert.equal((await step(ev, A, "Call: compensate", () => compensate(A, 8, "Doctor 3"))).value, 0);
      assert.deepEqual([(await patient(8)).status, await pointer("Doctor 3")], ["cancelled", null]);
    });

    scenario("7b. C1 under real concurrency: a claim waiting behind a committed Cancel still points the counter at the cancelled visit", async (ev) => {
      const snap = await patient(8);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "cancel P8 (admin3)", () => cancel(A, 8, "admin3", snap)));
      const waiting = await blockedStep(ev, B, A, "Call: claim Doctor 3 for P8 (pre-checked P8 as waiting)", () => claim(B, 8, "Doctor 3"));
      await exec(ev, A, "COMMIT");
      assert.equal(expectOk(await waiting.pending), 1, "C1 reproduced: the claim's only condition is current_patient_id IS NULL");
      assert.equal((await step(ev, B, "Call: serve CAS P8", () => serve(B, 8, "Doctor 3", "family_planning"))).value, 0);
      ev.log("B", "process stops before compensation (simulated)");
      assert.deepEqual([(await patient(8)).status, await pointer("Doctor 3")], ["cancelled", 8]);
      assert.equal((await step(ev, C, "Doctor 3 Call for another FP patient", () => claim(C, 5, "Doctor 3"))).value, 0, "Doctor 3 is blocked");
      const cancelled = await patient(8);
      assert.deepEqual(expectOk(await step(ev, C, "repeat cancel P8 repairs", () => cancel(C, 8, "admin3", cancelled))), cancelled);
      assert.equal(await pointer("Doctor 3"), null);
    });

    scenario("7c. A completed Call makes a waiting snapshot stale (40001); a fresh Cancel releases the doctor", async (ev) => {
      const snap = await patient(8);
      assert.equal((await step(ev, A, "Call: claim", () => claim(A, 8, "Doctor 3"))).value, 1);
      assert.equal((await step(ev, A, "Call: serve", () => serve(A, 8, "Doctor 3", "family_planning"))).value, 1);
      expectCode(await step(ev, B, "cancel P8 (waiting snapshot)", () => cancel(B, 8, "admin3", snap)), "40001");
      expectOk(await step(ev, B, "cancel P8 fresh", async () => cancel(B, 8, "admin3", await patient(8))));
      assert.equal(await pointer("Doctor 3"), null);
    });

    scenario("8a. Logout (session revocation) holding the session row: the waiting Cancel re-reads it and is refused", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      await step(ev, A, "revoke_staff_auth_session(admin1)", () => A.client.query("SELECT public.revoke_staff_auth_session($1, 'admin1')", [actors.admin1.session]));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin1)", () => cancel(B, 2, "admin1", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "28000");
      assert.deepEqual(await patient(2), snap);
      assert.equal(await pointer("Doctor 1"), 2);
    });

    scenario("8b. Cancel holding the session FOR SHARE: logout and heartbeat wait, then succeed after the commit", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "cancel P2 (admin1)", () => cancel(A, 2, "admin1", snap)));
      const a = actors.admin1;
      const heartbeat = await blockedStep(ev, B, A, "heartbeat_staff_auth_session(admin1)",
        () => B.client.query("SELECT public.heartbeat_staff_auth_session($1, $2, $3, $4)", [a.session, a.idNum, a.role, a.doctor]));
      const logout = await blockedStep(ev, C, [A, B], "revoke_staff_auth_session(admin1)",
        () => C.client.query("SELECT public.revoke_staff_auth_session($1, 'admin1')", [a.session]));
      await exec(ev, A, "COMMIT");
      expectOk(await heartbeat.pending); expectOk(await logout.pending);
      assert.equal((await patient(2)).status, "cancelled");
    });

    scenario("8c. Password change holding the account row: the waiting Cancel is refused (session revoked by trigger)", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      await step(ev, A, "UPDATE users SET password (admin1)", () => A.client.query("UPDATE public.users SET password = 'changed-synthetic' WHERE id_num = 'admin1'"));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin1)", () => cancel(B, 2, "admin1", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "28000");
      assert.deepEqual(await patient(2), snap);
    });

    scenario("9a. Doctor reassignment committed while Cancel waits: the old token cannot act for either doctor", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      await step(ev, A, "reassign admin2 -> Doctor 1", () => A.client.query("UPDATE public.users SET doctor_name = 'Doctor 1' WHERE id_num = 'admin2'"));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin2, token claims Doctor 2)", () => cancel(B, 2, "admin2", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "28000");
      assert.deepEqual(await patient(2), snap);
    });

    scenario("9b. Counter renamed while Cancel waits: the doctor fails closed; Frontdesk cancels and releases the renamed counter", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      await step(ev, A, "rename counter Doctor 1", () => A.client.query("UPDATE public.counters SET id_num = 'Doctor 1 relief' WHERE id_num = 'Doctor 1'"));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin1)", () => cancel(B, 2, "admin1", snap));
      await exec(ev, A, "COMMIT");
      expectCode(await waiting.pending, "42501");
      expectOk(await step(ev, B, "cancel P2 (frontdesk)", () => cancel(B, 2, "frontdesk", snap)));
      assert.equal(await pointer("Doctor 1 relief"), null);
    });

    scenario("9c. Counter re-pointed to another patient while Cancel waits: that patient's counter is never released", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      await step(ev, A, "move Doctor 1 pointer P2 -> P1", () => A.client.query("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'"));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin1)", () => cancel(B, 2, "admin1", snap));
      await exec(ev, A, "COMMIT");
      assert.equal(expectOk(await waiting.pending).status, "cancelled");
      assert.equal(await pointer("Doctor 1"), 1);
    });

    scenario("9d. A cross-doctor Cancel queued behind the owner's rolled-back Cancel is still refused", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "cancel P2 (admin1)", () => cancel(A, 2, "admin1", snap)));
      const waiting = await blockedStep(ev, B, A, "cancel P2 (admin2)", () => cancel(B, 2, "admin2", snap));
      await exec(ev, A, "ROLLBACK");
      expectCode(await waiting.pending, "42501");
      assert.deepEqual(await patient(2), snap);
    });

    scenario("10a. After a partial (W1) two-step cancel, two concurrent repeats both succeed without rewriting the patient", async (ev) => {
      await observer.client.query("UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp(), reason = 'Two-step first write' WHERE id = 3");
      const snap = await patient(3);
      assert.equal(await pointer("Doctor 2"), 3, "W1 state: counter still points at the cancelled visit");
      await exec(ev, A, "BEGIN");
      assert.deepEqual(expectOk(await step(ev, A, "repeat cancel P3 (frontdesk)", () => cancel(A, 3, "frontdesk", snap))), snap);
      const waiting = await blockedStep(ev, B, A, "repeat cancel P3 (admin2)", () => cancel(B, 3, "admin2", snap));
      await exec(ev, A, "COMMIT");
      assert.deepEqual(expectOk(await waiting.pending), snap);
      assert.deepEqual(await patient(3), snap, "revision unchanged: the patient row was never rewritten");
      assert.equal(await pointer("Doctor 2"), null);
    });

    scenario("10b. A delayed request with an old revision is refused after Cancel -> Undo restored the same status (ABA)", async (ev) => {
      const original = await patient(1);
      const cancelled = expectOk(await step(ev, A, "cancel P1", () => cancel(A, 1, "frontdesk", original)));
      expectOk(await step(ev, A, "undo P1", () => recover(A, "undo_patient_visit_waiting", "undo", cancelled)));
      expectCode(await step(ev, B, "delayed cancel P1 (original waiting snapshot)", () => cancel(B, 1, "frontdesk", original)), "40001");
      assert.equal((await patient(1)).status, "waiting");
    });
  });

  // ===========================================================================
  describe("lock timeout and deadlock handling", () => {

    for (const [label, holdSql, patientId, actorName] of [
      ["a counter row", "SELECT id FROM public.counters WHERE id = 2 FOR UPDATE", 3, "admin2"],
      ["the patient row", "SELECT id FROM public.patients WHERE id = 2 FOR UPDATE", 2, "admin1"],
      ["the account row", "SELECT id_num FROM public.users WHERE id_num = 'admin1' FOR UPDATE", 2, "admin1"]
    ]) {
      scenario(`L. Holding ${label} beyond 5 s: Cancel fails with 55P03, writes nothing and releases its other locks`, async (ev) => {
        const snap = await patient(patientId);
        const before = await state();
        await exec(ev, A, "BEGIN");
        await exec(ev, A, holdSql);
        const t0 = Date.now();
        const waiting = await blockedStep(ev, B, A, `cancel P${patientId} (${actorName})`, () => cancel(B, patientId, actorName, snap));
        const outcome = await waiting.pending;
        const elapsed = Date.now() - t0;
        ev.log("B", `elapsed ${elapsed} ms`);
        expectCode(outcome, "55P03");
        assert.ok(elapsed >= 4900 && elapsed < 8000, `lock_timeout elapsed ${elapsed} ms`);
        expectOk(await step(ev, A, "lock every counter NOWAIT", () => A.client.query("SELECT id FROM public.counters ORDER BY id FOR UPDATE NOWAIT")));
        await exec(ev, A, "ROLLBACK");
        assert.deepEqual(await state(), before);
      }, { timeout: 30000 });
    }

    scenario("D1. Reverse-order counter update (as clearTodaysQueues may) deadlocks with Cancel; the other side is the victim; Cancel succeeds", async (ev) => {
      const snap = await patient(2);
      await setDeadlockTimeout(A, "100ms");
      try {
        await exec(ev, A, "BEGIN");
        await exec(ev, A, "UPDATE public.counters SET current_patient_id = current_patient_id WHERE id = 3");
        const cancelling = await blockedStep(ev, B, A, "cancel P2 (admin1)", () => cancel(B, 2, "admin1", snap));
        const reverse = await step(ev, A, "UPDATE counters WHERE id = 1 (reverse order)",
          () => A.client.query("UPDATE public.counters SET current_patient_id = current_patient_id WHERE id = 1"));
        expectCode(reverse, "40P01");
        await exec(ev, A, "ROLLBACK");
        assert.equal(expectOk(await cancelling.pending).status, "cancelled");
        assert.deepEqual([await pointer("Doctor 1"), await pointer("Doctor 2")], [null, 3]);
      } finally { await setDeadlockTimeout(A, "1s"); }
    }, { timeout: 30000 });

    scenario("D2. Same deadlock with Cancel as the victim: 40P01, nothing written, the other transaction proceeds", async (ev) => {
      const snap = await patient(2);
      const before = await state();
      await setDeadlockTimeout(A, "10s");
      try {
        await exec(ev, A, "BEGIN");
        await exec(ev, A, "UPDATE public.counters SET current_patient_id = current_patient_id WHERE id = 3");
        const t0 = Date.now();
        const cancelling = await blockedStep(ev, B, A, "cancel P2 (admin1)", () => cancel(B, 2, "admin1", snap));
        const reverse = step(ev, A, "UPDATE counters WHERE id = 1 (reverse order)",
          () => A.client.query("UPDATE public.counters SET current_patient_id = current_patient_id WHERE id = 1"));
        const outcome = await cancelling.pending;
        ev.log("B", `elapsed ${Date.now() - t0} ms`);
        expectCode(outcome, "40P01");
        expectOk(await reverse);
        await exec(ev, A, "ROLLBACK");
        assert.deepEqual(await state(), before, "the cancel victim committed nothing");
      } finally { await setDeadlockTimeout(A, "1s"); }
    }, { timeout: 30000 });
  });

  // ===========================================================================
  describe("F5 and adjacent two-step findings (existing behavior, not fixed here)", () => {

    scenario("F5a. Requeue of a visit in consultation erases its start and leaves the doctor's counter pointing at it", async (ev) => {
      const snap = await patient(2);
      const requeued = expectOk(await step(ev, A, "requeue P2 (serving, in consultation)", () => recover(A, "recover_patient_visit", "requeue", snap)));
      assert.deepEqual([requeued.status, requeued.consultation_started_at, requeued.called_at, requeued.counter_id], ["waiting", null, null, null]);
      assert.equal(await pointer("Doctor 1"), 2, "F5: pointer left behind");
      assert.equal((await step(ev, B, "Call: claim Doctor 1 for P2", () => claim(B, 2, "Doctor 1"))).value, 0);
      assert.equal((await step(ev, B, "Call: claim Doctor 1 for P1", () => claim(B, 1, "Doctor 1"))).value, 0, "Doctor 1 blocked for every GP patient");
      expectOk(await step(ev, B, "atomic cancel repairs", () => cancel(B, 2, "frontdesk", requeued)));
      assert.equal(await pointer("Doctor 1"), null);
    });

    scenario("F5b. Requeue racing the doctor's Complete: Complete waits on the patient, then fails; the start time is gone", async (ev) => {
      const snap = await patient(2);
      await exec(ev, A, "BEGIN");
      expectOk(await step(ev, A, "requeue P2", () => recover(A, "recover_patient_visit", "requeue", snap)));
      const completing = await blockedStep(ev, B, A, "complete P2 (admin1)", () => complete(B, 2, 1, snap.consultation_started_at));
      await exec(ev, A, "COMMIT");
      const outcome = await completing.pending;
      assert.ok(!outcome.ok);
      ev.log("B", `complete refused: ${outcome.code} ${outcome.message}`);
      assert.equal((await patient(2)).consultation_started_at, null);
      assert.equal(await pointer("Doctor 1"), 2);
    });

    scenario("F5c. Requeue of a cancelled visit with a W1 stale pointer carries the pointer into the waiting queue", async (ev) => {
      await observer.client.query("UPDATE public.counters SET current_patient_id = 6 WHERE id_num = 'Doctor 3'");
      const requeued = expectOk(await step(ev, A, "requeue P6 (cancelled, stale pointer)", async () => recover(A, "recover_patient_visit", "requeue", await patient(6))));
      assert.equal(requeued.status, "waiting");
      assert.equal(await pointer("Doctor 3"), 6);
      assert.equal((await step(ev, B, "Call: claim Doctor 3 for P8", () => claim(B, 8, "Doctor 3"))).value, 0);
    });

    scenario("N1. Two-step No-show: its delayed second statement releases a NEW legitimate assignment after Undo and Call", async (ev) => {
      const snap = await patient(3);
      assert.equal((await step(ev, A, "no-show CAS P3 (first statement)", () => noShowCas(A, snap))).value, 1);
      ev.log("A", "second statement delayed");
      const noShow = await patient(3);
      expectOk(await step(ev, B, "undo P3", () => recover(B, "undo_patient_visit_waiting", "undo", noShow)));
      assert.equal((await step(ev, B, "Call: claim Doctor 2 for P3", () => claim(B, 3, "Doctor 2"))).value, 1);
      assert.equal((await step(ev, B, "Call: serve P3", () => serve(B, 3, "Doctor 2", "prenatal"))).value, 1);
      assert.equal((await step(ev, A, "no-show second statement: release counters of P3", () => releaseAll(A, 3))).value, 1);
      assert.deepEqual([(await patient(3)).status, await pointer("Doctor 2")], ["serving", null], "serving visit lost its counter");
    });
  });

  // ===========================================================================
  const SOAK_OPS = Number(process.env.PHASE25_PG_SOAK_OPS || 150);
  test(`soak: 4 independent connections x ${SOAK_OPS} randomized operations; no deadlocks or lock timeouts among ordered operations`, { timeout: 600000 }, async () => {
    // Seeded PRNG so a failure is reproducible.
    const seed = Number(process.env.PHASE25_PG_SOAK_SEED || 20261022);
    let s = seed >>> 0;
    const random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (list) => list[Math.floor(random() * list.length)];
    await observer.client.query(`UPDATE public.counters SET current_patient_id = NULL;
      UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp() WHERE status IN ('waiting', 'serving')`);
    const services = ["consultation", "prenatal", "family_planning", "checkup", "maternity", "family_planning"];
    // 12 active visit slots; a completed visit is replaced by a newly registered one.
    const register = async (client, i) => Number((await client.query(`INSERT INTO public.patients (id_num, queue_number, service_type)
      VALUES ($1, $2, $3) RETURNING id`, [`Synthetic soak ${i}`, `S-${i}`, services[i % services.length]])).rows[0].id);
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(await register(observer.client, i));
    const allIds = new Set(ids);
    const workers = [];
    for (let i = 1; i <= 4; i += 1) workers.push(await connect(`W${i}`));
    const results = [];
    const completions = new Map();
    const doctorOf = (row) => row.counter_id || getDoctorForService(row.service_type);
    const expected = {
      cancel: ["40001", "42501", "QM001", "QM002"], complete: ["42501", "P0001"], start: ["42501", "P0001"],
      undo: ["40001", "P0001"], requeue: ["40001", "P0001"]
    };
    async function operate(w) {
      // Prefer active visits so most operations contend on the same few rows.
      let id; let snap;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        id = Number(pick(ids));
        snap = await one(w.client, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
        if (snap.status !== "completed" || random() < 0.15) break;
      }
      const status = snap.status;
      let op;
      if (status === "waiting") op = random() < 0.6 ? "call" : "cancel";
      else if (status === "serving" && !snap.consultation_started_at) op = pick(["start", "start", "cancel", "noshow", "recall"]);
      else if (status === "serving") op = pick(["complete", "complete", "cancel"]);
      else if (status === "completed") op = pick(["cancel", "undo"]);
      else op = pick(["undo", "undo", "requeue", "cancel"]);
      const number = snap.counter_id ? Number(snap.counter_id.slice(-1)) : null;
      const actor = pick(["frontdesk", "superadmin", "admin1", "admin2", "admin3"]);
      const record = { worker: w.name, op, id, status, actor };
      let outcome;
      if (op === "cancel") outcome = await settle(cancel(w, id, actor, snap));
      else if (op === "start") outcome = await settle(start(w, id, number));
      else if (op === "complete") outcome = await settle(complete(w, id, number, snap.consultation_started_at));
      else if (op === "undo") outcome = await settle(recover(w, "undo_patient_visit_waiting", "undo", snap));
      else if (op === "requeue") outcome = await settle(recover(w, "recover_patient_visit", "requeue", snap));
      else if (op === "recall") outcome = await settle(recallCas(w, snap));
      else if (op === "noshow") {
        outcome = await settle(noShowCas(w, snap));
        if (outcome.ok && outcome.value === 1) await releaseAll(w, id);
      } else {
        // Node's Call: claim, conditional patient update, compensation if the update lost.
        const doctor = getDoctorForService(snap.service_type);
        outcome = await settle(claim(w, id, doctor));
        if (outcome.ok && outcome.value === 1) {
          const served = await serve(w, id, doctor, snap.service_type);
          if (served === 0) {
            const latest = await one(w.client, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
            if (!(latest.status === "serving" && latest.counter_id === doctor)) await compensate(w, id, doctor);
          }
        }
      }
      record.result = outcome.ok ? "ok" : outcome.code;
      if (outcome.ok && op === "complete") {
        completions.set(id, outcome.value);
        const slot = ids.indexOf(id);
        if (slot >= 0) { ids[slot] = await register(w.client, allIds.size); allIds.add(ids[slot]); }
      }
      if (outcome.ok && op === "cancel" && actor.startsWith("admin")) {
        record.ownerCheck = doctorOf(outcome.value) === `Doctor ${actor.slice(-1)}`;
      }
      if (!outcome.ok && expected[op] && !expected[op].includes(outcome.code)) record.unexpected = outcome.message;
      results.push(record);
    }
    try {
      await Promise.all(workers.map(async (w) => { for (let i = 0; i < SOAK_OPS; i += 1) await operate(w); }));
    } finally {
      for (const w of workers) await w.client.end();
    }
    const final = (await state()).patients.filter((row) => allIds.has(row.id));
    const counters = (await state()).counters;
    const tally = {};
    for (const r of results) tally[`${r.op}:${r.result}`] = (tally[`${r.op}:${r.result}`] || 0) + 1;
    const pointedTerminal = counters.filter((c) => c.current_patient_id && ["cancelled", "no-show", "completed"].includes(final.find((p) => p.id === c.current_patient_id)?.status));
    const servingWithoutCounter = final.filter((p) => p.status === "serving" && counters.find((c) => c.id_num === p.counter_id)?.current_patient_id !== p.id);
    const changedCompletions = [...completions].filter(([id, row]) => {
      const now = final.find((p) => p.id === id);
      return now.status !== "completed" || now.completed_at !== row.completed_at || now.consultation_started_at !== row.consultation_started_at;
    });
    evidence.soak = {
      seed, operations: results.length, tally,
      deadlocks: results.filter((r) => r.result === "40P01").length,
      lock_timeouts: results.filter((r) => r.result === "55P03").length,
      unexpected: results.filter((r) => r.unexpected),
      cross_doctor_cancels: results.filter((r) => r.ownerCheck === false),
      counters_pointing_at_terminal_visits: pointedTerminal,
      serving_visits_without_their_counter: servingWithoutCounter.map((p) => p.id),
      completed_history_changed: changedCompletions.map(([id]) => id)
    };
    assert.equal(results.length, 4 * SOAK_OPS);
    assert.equal(evidence.soak.deadlocks, 0);
    assert.equal(evidence.soak.lock_timeouts, 0);
    assert.deepEqual(evidence.soak.unexpected, []);
    assert.deepEqual(evidence.soak.cross_doctor_cancels, []);
    assert.deepEqual(evidence.soak.completed_history_changed, []);
    assert.deepEqual(pointedTerminal, [], "no counter points at a terminal visit");
  });
});
