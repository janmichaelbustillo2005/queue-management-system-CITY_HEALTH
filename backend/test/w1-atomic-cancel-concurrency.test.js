// W1: independent-connection PostgreSQL verification of cancel_patient_visit
// (20261025-w1-atomic-cancel.sql) together with C1 call_patient_visit and F5
// requeue_patient_visit. Runs ONLY against the disposable LOCAL PostgreSQL 17 cluster used for
// R2.2/F5/C1: PHASE25_PG_URL must point at 127.0.0.1/localhost, the server must report
// cluster_name = PHASE25_PG_CLUSTER (default "r22-disposable-cancel-verification") and listen
// only on 127.0.0.1. Fresh databases are created with the migrations the development project is
// reported to have (Phase 2, A, 2.1, 2.2, B.2; never the superseded Phase B) plus F5, C1 and W1,
// installed as a non-superuser "postgres" owner, and dropped afterwards. Never reads .env or
// uses Supabase. Synthetic rows only.
// Skipped unless PHASE25_PG_URL and PHASE25_PG_MODULE (path to a `pg` package) are set.
// Optional: W1_PG_SOAK_SEEDS (comma-separated) and W1_PG_SOAK_OPS size the randomized soak.
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const { read, nodeFunction, BASE_SCHEMA, SUPABASE_DEFAULT_PRIVILEGES, ACCOUNTS, SEED } = require("./helpers/phase25CancelFixture");

const TARGET = process.env.PHASE25_PG_URL;
const CLUSTER = process.env.PHASE25_PG_CLUSTER || "r22-disposable-cancel-verification";
const SCRIPTS = "backend/scripts/";
const STACK = [
  "20261010-phase2-consultation-lifecycle.sql", "20261012-phase-a-auth-presence.sql", "20261012-phase21-stale-recovery.sql",
  "20261014-phase22-undo-waiting.sql", "20261023-phase-b2-records.sql",
  "20261022-f5-requeue-terminal-recovery.sql", "20261025-c1-atomic-call.sql"
];
const W1 = "20261025-w1-atomic-cancel.sql";
const CANCEL = "public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)";
const HELPER = "public.qms_resolve_doctor_counter(text)";
const WINDOW = { start: "1999-12-31T16:00:00.000Z", end: "2100-01-01T00:00:00.000Z" };
let pg;
let unavailable;
if (!TARGET || !process.env.PHASE25_PG_MODULE) {
  unavailable = "Disposable local PostgreSQL not configured; set PHASE25_PG_URL and PHASE25_PG_MODULE.";
} else {
  pg = require(process.env.PHASE25_PG_MODULE);
}

const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, message: error.message }));
const outcomeCode = (outcome) => (outcome.ok ? "ok" : outcome.code);
const expectCode = (outcome, code) => assert.equal(outcomeCode(outcome), code, outcome.message);
const expectOk = (outcome) => { assert.ok(outcome.ok, `${outcome.code}: ${outcome.message}`); return outcome.value; };

async function assertDisposableTarget(client) {
  const url = new URL(TARGET);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "PHASE25_PG_URL must be a loopback address");
  assert.ok(!/supabase/i.test(TARGET), "Supabase targets are never allowed");
  const { rows: [server] } = await client.query(`SELECT current_setting('cluster_name') AS cluster,
    host(inet_server_addr()) AS address, current_setting('listen_addresses') AS listen,
    current_setting('server_version_num')::int AS version_num, current_database() AS database`);
  assert.equal(server.cluster, CLUSTER, "unexpected cluster_name: not the disposable test cluster");
  assert.equal(server.address, "127.0.0.1");
  assert.equal(server.listen, "127.0.0.1", "the test server must listen on loopback only");
  assert.ok(server.version_num >= 170000, "PostgreSQL 17 or later is required");
  return server;
}

// Creates a fresh database owned by the non-superuser "postgres" role and installs `scripts`.
async function createDatabase(admin, prefix, { schema = BASE_SCHEMA, scripts = [...STACK, W1] } = {}) {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$`);
  const name = `${prefix}_${Date.now()}_${randomBytes(3).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name} OWNER postgres TEMPLATE template0`);
  const url = new URL(TARGET); url.pathname = `/${name}`;
  const setup = new pg.Client({ connectionString: url.toString(), application_name: `${prefix}-setup` });
  await setup.connect();
  assert.equal((await assertDisposableTarget(setup)).database, name);
  await setup.query("SET ROLE postgres");
  await setup.query(SUPABASE_DEFAULT_PRIVILEGES);
  await setup.query(schema);
  for (const script of scripts) await setup.query(read(SCRIPTS + script));
  await setup.query("RESET ROLE");
  return { name, url: url.toString(), setup };
}

// Every row of a multi-statement READ ONLY script's final tabular result.
async function scriptChecks(client, script) {
  const results = [].concat(await client.query(read(SCRIPTS + script)));
  return results.filter((result) => result.rows?.length && "passed" in result.rows[0]).at(-1).rows;
}

describe("W1 cancel_patient_visit with C1 and F5 on real PostgreSQL (independent connections)", { skip: unavailable }, () => {
  let admin; let db; let observer;
  const sessions = {};
  const actors = {};

  async function connect(name, { serviceRole = true } = {}) {
    const client = new pg.Client({ connectionString: db.url, application_name: `w1-${name}` });
    await client.connect();
    if (serviceRole) await client.query("SET ROLE service_role");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { name, client, pid };
  }

  before(async () => {
    admin = new pg.Client({ connectionString: TARGET, application_name: "w1-admin" });
    await admin.connect();
    await assertDisposableTarget(admin);
    db = await createDatabase(admin, "w1_cancel");
    observer = await connect("observer", { serviceRole: false });
    for (const name of ["A", "B", "C", "D"]) sessions[name] = await connect(name);
  });

  after(async () => {
    for (const session of Object.values(sessions)) await session.client.end().catch(() => {});
    if (observer) await observer.client.end().catch(() => {});
    if (db) await db.setup.end().catch(() => {});
    if (admin && db) await admin.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`);
    if (admin) await admin.end();
  });

  // Seed (phase25CancelFixture): 1 waiting GP, 2 GP in consultation on Doctor 1, 3 OB called on
  // Doctor 2, 4 completed, 5 no-show (Doctor 3), 6 cancelled (Doctor 1), 7 orphan serving GP,
  // 8 waiting FP. Doctor 3 is free, so FP visits are the Call subjects.
  // The seed truncates staff_auth_sessions, so every actor signs in again after it.
  async function reseed() {
    await observer.client.query(SEED);
    for (const [idNum, [role, doctor]] of Object.entries(ACCOUNTS)) {
      const session = randomUUID();
      const revision = (await observer.client.query("SELECT auth_revision FROM public.users WHERE id_num = $1", [idNum])).rows[0].auth_revision;
      await observer.client.query("SELECT public.create_staff_auth_session($1, $2, $3, $4, $5)", [session, idNum, role, doctor, revision]);
      actors[idNum] = { session, idNum, role, doctor };
    }
  }
  beforeEach(async () => {
    for (const session of [...Object.values(sessions), observer]) await session.client.query("ROLLBACK").catch(() => {});
    await reseed();
  });

  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0]?.value;
  const patient = (id) => one(observer.client, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
  const pointers = async () => Object.fromEntries((await observer.client.query("SELECT id_num, current_patient_id FROM public.counters ORDER BY id")).rows
    .map((row) => [row.id_num, row.current_patient_id == null ? null : Number(row.current_patient_id)]));
  const state = async () => ({
    patients: await one(observer.client, "SELECT json_agg(row_to_json(p) ORDER BY p.id) AS value FROM public.patients p"),
    counters: await pointers()
  });
  // The fields the report captures: status, assignment, timestamps, reason and revision.
  const visit = async (id) => {
    const row = await patient(id);
    const counters = await pointers();
    return { status: row.status, counter_id: row.counter_id, called_at: row.called_at, consultation_started_at: row.consultation_started_at,
      completed_at: row.completed_at, reason: row.reason, revision: row.visit_state_revision,
      pointed_by: Object.entries(counters).filter(([, pid]) => pid === id).map(([doctor]) => doctor) };
  };

  // --- operations, issued exactly as the backend issues them
  function cancel(s, id, actorName, snap, { reason = "Synthetic reason", requested = null, overrides = {} } = {}) {
    const actor = actors[actorName];
    const args = {
      p_patient_id: id, p_session_id: actor.session, p_user_id_num: actor.idNum, p_role: actor.role,
      p_doctor_name: actor.doctor, p_expected_revision: snap.visit_state_revision, p_expected_status: snap.status,
      p_reason: reason, p_requested_counter: requested, ...overrides
    };
    const entries = Object.entries(args);
    return one(s.client, `SELECT row_to_json(p) AS value FROM public.cancel_patient_visit(${
      entries.map(([key], index) => `${key} => $${index + 1}`).join(", ")}) p`, entries.map(([, value]) => value));
  }
  const call = (s, snap, doctor = "Doctor 3", user = "frontdesk") => one(s.client,
    "SELECT row_to_json(p) AS value FROM public.call_patient_visit($1, $2, $3, $4, $5, $6) p",
    [snap.id, doctor, user, snap.visit_state_revision, WINDOW.start, WINDOW.end]);
  const recover = (s, fn, snap, action) => one(s.client, `SELECT row_to_json(p) AS value FROM public.${fn}(
    $1, $2, 'frontdesk', $3, $4, $5, $6, $7, $8, $9, $10) p`, [snap.id, action, snap.visit_state_revision, snap.status, snap.created_at,
    snap.called_at, snap.consultation_started_at, snap.completed_at, snap.counter_id, action === "requeue" ? "Synthetic requeue" : null]);
  const requeue = (s, snap) => recover(s, "requeue_patient_visit", snap, "requeue");
  const undo = (s, snap) => recover(s, "undo_patient_visit_waiting", snap, "undo");
  const start = (s, id, number) => one(s.client, "SELECT row_to_json(p) AS value FROM public.start_patient_consultation($1, $2, $3, clock_timestamp()) p",
    [id, `Doctor ${number}`, `admin${number}`]);
  const complete = (s, id, number, startedAt) => one(s.client, `SELECT row_to_json(p) AS value FROM public.complete_patient_consultation(
    $1, $2, $3, $4, 'Synthetic completion') p`, [id, `Doctor ${number}`, `admin${number}`, startedAt]);
  // The pre-W1 backend Cancel: two PostgREST statements (patient compare-and-set, then pointer release).
  const legacyCancelCas = (s, snap) => s.client.query(`UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp(),
    reason = 'Synthetic legacy cancel' WHERE id = $1 AND status = $2 AND visit_state_revision = $3`, [snap.id, snap.status, snap.visit_state_revision]);
  const legacyCancelRelease = (s, id) => s.client.query("UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = $1", [id]);

  // Every committed state: each pointer refers to a serving visit assigned to that counter, and
  // each assigned serving visit has exactly its own counter's pointer.
  async function assertConsistent(label = "") {
    const { rows } = await observer.client.query(`SELECT c.id_num, p.id, p.status::text AS status, p.counter_id
      FROM public.counters c JOIN public.patients p ON p.id = c.current_patient_id`);
    for (const row of rows) {
      assert.equal(row.status, "serving", `${label}: ${row.id_num} points at ${row.status} visit ${row.id}`);
      assert.equal(row.counter_id, row.id_num, `${label}: ${row.id_num} points at a visit assigned to ${row.counter_id}`);
    }
    const { rows: serving } = await observer.client.query(`SELECT p.id, p.counter_id,
        (SELECT array_agg(c.id_num) FROM public.counters c WHERE c.current_patient_id = p.id) AS owners
      FROM public.patients p WHERE p.status = 'serving' AND p.counter_id IS NOT NULL`);
    for (const row of serving) assert.deepEqual(row.owners, [row.counter_id], `${label}: serving visit ${row.id} on ${row.counter_id} has counters ${row.owners}`);
  }

  async function waitBlocked(waiter, holders) {
    const list = [].concat(holders);
    const deadline = Date.now() + 8000;
    for (;;) {
      const { rows: [row] } = await observer.client.query(
        "SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1", [waiter.pid]);
      if (row?.wait_event_type === "Lock" && list.some((holder) => row.blockers.includes(holder.pid))) return;
      if (Date.now() > deadline) assert.fail(`${waiter.name} never waited on ${list.map((holder) => holder.name).join("/")}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  // Starts an operation that must block on `holders`; returns { pending } once the wait is observed.
  async function blocked(waiter, holders, action) {
    const pending = settle(action());
    await waitBlocked(waiter, holders);
    return { pending };
  }

  // ---------------------------------------------------------------------------
  describe("installation alongside C1 and F5", () => {
    test("catalog: SECURITY DEFINER, empty search_path, 5s lock_timeout, owner postgres; only service_role executes the RPC, nobody the helper", async () => {
      const { rows } = await observer.client.query(`SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig,
          pg_get_userbyid(p.proowner) AS owner, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
          EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
        FROM pg_proc p WHERE p.oid IN (to_regprocedure($1), to_regprocedure($2)) ORDER BY 1`, [CANCEL, HELPER]);
      const [rpc, helper] = rows;
      assert.equal(rpc.signature, "cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)");
      assert.equal(rpc.prosecdef, true);
      assert.deepEqual([...rpc.proconfig].sort(), ["lock_timeout=5s", 'search_path=""']);
      assert.equal(rpc.owner, "postgres");
      assert.deepEqual([rpc.anon, rpc.authenticated, rpc.service_role, rpc.public_execute], [false, false, true, false]);
      assert.deepEqual([helper.prosecdef, helper.anon, helper.authenticated, helper.service_role, helper.public_execute], [false, false, false, false, false]);
      for (const role of ["anon", "authenticated"]) {
        await observer.client.query(`SET ROLE ${role}`);
        const denied = await settle(observer.client.query(`SELECT public.cancel_patient_visit(1, gen_random_uuid(), 'frontdesk', 'admin', NULL,
          gen_random_uuid(), 'waiting', 'x')`));
        await observer.client.query("RESET ROLE");
        assert.equal(denied.code, "42501", `${role} cannot execute`);
      }
    });

    test("W1 preflight passes, the rolled-back verify passes and keeps nothing, and the C1 checks still pass after W1", async () => {
      // Installed here already, so the overload check sees exactly the W1 signatures.
      const preflight = await scriptChecks(observer.client, "20261025-w1-preflight.sql");
      assert.equal(preflight.length, 28);
      assert.deepEqual(preflight.filter((row) => !row.passed).map((row) => row.check_name), []);
      const before = await state();
      const verify = [].concat(await observer.client.query(read(SCRIPTS + "20261025-w1-verify.sql")));
      assert.deepEqual(verify.find((result) => result.rows?.[0]?.result)?.rows, [{ result: "W1 verification passed" }]);
      assert.deepEqual(await state(), before, "the verification rolled back every synthetic row");
      assert.equal(Number(await one(observer.client, "SELECT count(*) AS value FROM public.users WHERE id_num LIKE 'w1v-%'")), 0);
      for (const script of ["20261025-c1-preflight.sql", "20261025-c1-verify.sql"]) {
        const rows = await scriptChecks(observer.client, script);
        assert.deepEqual(rows.filter((row) => !row.passed).map((row) => row.check_name), [], script);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("W1 reproduction (Scenario A) and its correction", () => {
    test("before: the two-step Cancel's delayed release clears the counter of a later Requeue + Call (F5 and C1 installed)", async (t) => {
      const { A, B } = sessions;
      expectOk(await settle(call(B, await patient(8))));
      const serving = await patient(8);
      const steps = [{ step: "P8 called on Doctor 3", ...(await visit(8)) }];
      assert.equal((await legacyCancelCas(A, serving)).rowCount, 1, "Cancel statement 1 commits the patient");
      steps.push({ step: "legacy Cancel: patient committed, release delayed", ...(await visit(8)) });
      expectOk(await settle(requeue(B, await patient(8))));
      steps.push({ step: "F5 Requeue (releases the pointer itself)", ...(await visit(8)) });
      expectOk(await settle(call(B, await patient(8))));
      steps.push({ step: "C1 Call of the re-queued visit", ...(await visit(8)) });
      assert.equal((await legacyCancelRelease(A, 8)).rowCount, 1, "the delayed statement 2 matches the NEW assignment");
      steps.push({ step: "legacy Cancel: delayed release resumes", ...(await visit(8)) });
      t.diagnostic(`before: ${JSON.stringify(steps)}`);
      const corrupt = steps.at(-1);
      assert.deepEqual([corrupt.status, corrupt.counter_id, corrupt.pointed_by], ["serving", "Doctor 3", []], "W1 reproduced");
      await assert.rejects(() => assertConsistent("legacy"), /has counters null/);
    });

    test("before: the same corruption through Phase 2.2 Undo, which is installed on the development project today", async () => {
      const { A, B } = sessions;
      const serving = await patient(3); // OB visit on Doctor 2
      assert.equal((await legacyCancelCas(A, serving)).rowCount, 1);
      expectOk(await settle(undo(B, await patient(3))));
      expectOk(await settle(call(B, await patient(3), "Doctor 2")));
      await legacyCancelRelease(A, 3);
      const after = await visit(3);
      assert.deepEqual([after.status, after.counter_id, after.pointed_by], ["serving", "Doctor 2", []], "W1 reproduced via Undo");
    });

    test("after: the atomic Cancel exposes no intermediate state, and the old Cancel can never touch the new assignment", async (t) => {
      const { A, B, C } = sessions;
      expectOk(await settle(call(B, await patient(8))));
      const serving = await patient(8);
      const steps = [{ step: "P8 called on Doctor 3", ...(await visit(8)) }];
      await A.client.query("BEGIN");
      const cancelled = expectOk(await settle(cancel(A, 8, "frontdesk", serving)));
      // Held open ("delayed"): other sessions see the visit unchanged, and Requeue/Call cannot run.
      assert.deepEqual({ step: steps[0].step, ...(await visit(8)) }, steps[0], "nothing is visible before commit");
      const racingCall = await blocked(C, A, () => call(C, serving));
      steps.push({ step: "Cancel uncommitted; a Call with the old snapshot waits", ...(await visit(8)) });
      await A.client.query("COMMIT");
      expectCode(await racingCall.pending, "40001");
      steps.push({ step: "Cancel committed: patient and pointer changed together", ...(await visit(8)) });
      assert.deepEqual([cancelled.status, (await visit(8)).pointed_by], ["cancelled", []]);
      expectOk(await settle(requeue(B, await patient(8))));
      expectOk(await settle(call(B, await patient(8))));
      steps.push({ step: "F5 Requeue then C1 Call", ...(await visit(8)) });
      // The old Cancel replayed with either snapshot it ever held is refused before any write.
      expectCode(await settle(cancel(A, 8, "frontdesk", serving)), "40001");
      expectCode(await settle(cancel(A, 8, "frontdesk", cancelled)), "40001");
      steps.push({ step: "old Cancel replayed with its serving and cancelled snapshots", ...(await visit(8)) });
      t.diagnostic(`after: ${JSON.stringify(steps)}`);
      const final = steps.at(-1);
      assert.deepEqual([final.status, final.counter_id, final.pointed_by], ["serving", "Doctor 3", ["Doctor 3"]]);
      assert.equal(final.revision, steps.at(-2).revision, "the refused replays wrote nothing");
      await assertConsistent("after");
    });

    test("after: a Cancel concurrent with an in-flight Requeue + Call sequence serializes and leaves one consistent pair", async () => {
      const { A, B, C } = sessions;
      expectOk(await settle(call(B, await patient(8))));
      expectOk(await settle(cancel(A, 8, "frontdesk", await patient(8))));
      const cancelledSnap = await patient(8);
      await B.client.query("BEGIN");
      expectOk(await settle(requeue(B, cancelledSnap)));
      const repeat = await blocked(A, B, () => cancel(A, 8, "admin3", cancelledSnap));
      await B.client.query("COMMIT");
      expectCode(await repeat.pending, "40001");
      await C.client.query("BEGIN");
      expectOk(await settle(call(C, await patient(8))));
      const late = await blocked(A, C, () => cancel(A, 8, "frontdesk", cancelledSnap));
      await C.client.query("COMMIT");
      expectCode(await late.pending, "40001");
      assert.deepEqual((await visit(8)).pointed_by, ["Doctor 3"]);
      await assertConsistent("requeue+call vs cancel");
    });
  });

  // ---------------------------------------------------------------------------
  describe("races between independent transactions (lock waits observed in pg_stat_activity)", () => {
    test("Scenario B: concurrent Cancels from one snapshot - exactly one commits; the fresh retry is an idempotent repeat", async () => {
      const { A, B } = sessions;
      const snap = await patient(2);
      await A.client.query("BEGIN");
      const first = expectOk(await settle(cancel(A, 2, "admin1", snap)));
      const second = await blocked(B, A, () => cancel(B, 2, "frontdesk", snap, { reason: "Second" }));
      await A.client.query("COMMIT");
      expectCode(await second.pending, "40001");
      const retry = expectOk(await settle(cancel(B, 2, "frontdesk", await patient(2), { reason: "Retry" })));
      assert.deepEqual([retry.reason, retry.visit_state_revision], [first.reason, first.visit_state_revision], "the repeat wrote nothing");
      assert.deepEqual((await visit(2)).pointed_by, []);
    });

    test("Scenario B: Doctor, Frontdesk and Superadmin cancel the same visit simultaneously - one success, two 40001", async () => {
      const { A, B, C } = sessions;
      const snap = await patient(3);
      const outcomes = await Promise.all([["admin2", A], ["frontdesk", B], ["superadmin", C]]
        .map(([who, s]) => settle(cancel(s, 3, who, snap, { reason: `By ${who}` }))));
      assert.deepEqual(outcomes.map(outcomeCode).sort(), ["40001", "40001", "ok"]);
      const after = await visit(3);
      assert.equal(after.reason, outcomes.find((outcome) => outcome.ok).value.reason);
      assert.deepEqual([after.status, after.pointed_by], ["cancelled", []]);
    });

    test("Scenario C: Cancel vs Complete, both orders - no deadlock, completed history is never overwritten", async () => {
      const { A, B } = sessions;
      let snap = await patient(2);
      await A.client.query("BEGIN");
      expectOk(await settle(complete(A, 2, 1, snap.consultation_started_at)));
      const lateCancel = await blocked(B, A, () => cancel(B, 2, "frontdesk", snap));
      await A.client.query("COMMIT");
      expectCode(await lateCancel.pending, "40001");
      const completed = await visit(2);
      assert.deepEqual([completed.status, completed.reason, completed.pointed_by], ["completed", "Synthetic completion", []]);
      expectCode(await settle(cancel(B, 2, "frontdesk", await patient(2))), "QM001");
      assert.deepEqual(await visit(2), completed);

      await reseed();
      snap = await patient(2);
      await A.client.query("BEGIN");
      expectOk(await settle(cancel(A, 2, "admin1", snap)));
      const lateComplete = await blocked(B, A, () => complete(B, 2, 1, snap.consultation_started_at));
      await A.client.query("COMMIT");
      assert.equal((await lateComplete.pending).ok, false, "Complete of a cancelled visit fails");
      const cancelled = await visit(2);
      assert.deepEqual([cancelled.status, cancelled.consultation_started_at, cancelled.called_at, cancelled.pointed_by],
        ["cancelled", snap.consultation_started_at, snap.called_at, []], "consultation history preserved");
    });

    test("Scenario D: Cancel vs Undo, both orders, including Undo racing the repeat Cancel of a cancelled visit", async () => {
      const { A, B } = sessions;
      const serving = await patient(3);
      await A.client.query("BEGIN");
      expectOk(await settle(cancel(A, 3, "admin2", serving)));
      const undoServing = await blocked(B, A, () => undo(B, serving));
      await A.client.query("COMMIT");
      expectCode(await undoServing.pending, "40001");
      const cancelledSnap = await patient(3);
      await B.client.query("BEGIN");
      expectOk(await settle(undo(B, cancelledSnap)));
      const repeat = await blocked(A, B, () => cancel(A, 3, "frontdesk", cancelledSnap));
      await B.client.query("COMMIT");
      expectCode(await repeat.pending, "40001");
      const waiting = await visit(3);
      assert.deepEqual([waiting.status, waiting.counter_id, waiting.pointed_by], ["waiting", null, []]);
      // Repeat Cancel first (it releases a legacy stale pointer under its locks), Undo after.
      await reseed();
      await observer.client.query("UPDATE public.counters SET current_patient_id = 6 WHERE id_num = 'Doctor 3'");
      const stale = await patient(6);
      await A.client.query("BEGIN");
      const idempotent = expectOk(await settle(cancel(A, 6, "frontdesk", stale)));
      assert.equal(idempotent.visit_state_revision, stale.visit_state_revision);
      const undoAfter = await blocked(B, A, () => undo(B, stale));
      await A.client.query("COMMIT");
      expectOk(await undoAfter.pending);
      assert.deepEqual([(await visit(6)).status, (await pointers())["Doctor 3"]], ["waiting", null]);
    });

    test("Scenario E: Cancel vs atomic Call, both orders - the loser gets 40001 and the counter matches the winner", async () => {
      const { A, B } = sessions;
      let snap = await patient(8);
      await A.client.query("BEGIN");
      expectOk(await settle(call(A, snap)));
      const lateCancel = await blocked(B, A, () => cancel(B, 8, "frontdesk", snap));
      await A.client.query("COMMIT");
      expectCode(await lateCancel.pending, "40001");
      assert.deepEqual([(await visit(8)).status, (await visit(8)).pointed_by], ["serving", ["Doctor 3"]]);

      await reseed();
      snap = await patient(8);
      await A.client.query("BEGIN");
      expectOk(await settle(cancel(A, 8, "admin3", snap)));
      const lateCall = await blocked(B, A, () => call(B, snap));
      await A.client.query("COMMIT");
      expectCode(await lateCall.pending, "40001");
      assert.deepEqual([(await visit(8)).status, (await pointers())["Doctor 3"]], ["cancelled", null]);
      await assertConsistent("cancel vs call");
    });

    test("Cancel vs F5 Requeue: an in-flight Requeue makes the repeat Cancel stale; an in-flight repeat Cancel is waited for", async () => {
      const { A, B } = sessions;
      const snap = await patient(6);
      await A.client.query("BEGIN");
      expectOk(await settle(requeue(A, snap)));
      const repeat = await blocked(B, A, () => cancel(B, 6, "frontdesk", snap));
      await A.client.query("COMMIT");
      expectCode(await repeat.pending, "40001");
      assert.equal((await visit(6)).status, "waiting");
      await reseed();
      const fresh = await patient(6);
      await B.client.query("BEGIN");
      expectOk(await settle(cancel(B, 6, "frontdesk", fresh)));
      const inFlight = await blocked(A, B, () => requeue(A, fresh));
      await B.client.query("COMMIT");
      expectOk(await inFlight.pending);
    });

    test("doctor counter reassignment in flight: Cancel releases only pointers that still name its visit", async () => {
      const { A, B } = sessions;
      const snap = await patient(2);
      // Doctor 1's counter is re-pointed at another visit while the Cancel waits for it.
      await A.client.query("BEGIN");
      await A.client.query("UPDATE public.counters SET current_patient_id = 7 WHERE id_num = 'Doctor 1'");
      const waiting = await blocked(B, A, () => cancel(B, 2, "frontdesk", snap));
      await A.client.query("COMMIT");
      expectOk(await waiting.pending);
      assert.deepEqual(await pointers(), { "Doctor 1": 7, "Doctor 2": 3, "Doctor 3": null });
      // The doctor account reassigned while its Cancel waits on the account row: sign in again (28000).
      await reseed();
      const before = await state();
      await A.client.query("BEGIN");
      await A.client.query("UPDATE public.users SET doctor_name = 'Doctor 3' WHERE id_num = 'admin2'");
      const reassigned = await blocked(B, A, () => cancel(B, 3, "admin2", before.patients[2]));
      await A.client.query("COMMIT");
      expectCode(await reassigned.pending, "28000");
      assert.deepEqual((await state()).counters, before.counters);
    });

    test("logout in flight: the waiting Cancel re-reads the revoked session (28000); a Cancel holding the session delays logout", async () => {
      const { A, B } = sessions;
      const snap = await patient(2);
      await A.client.query("BEGIN");
      await A.client.query("SELECT public.revoke_staff_auth_session($1, 'admin1')", [actors.admin1.session]);
      const waiting = await blocked(B, A, () => cancel(B, 2, "admin1", snap));
      await A.client.query("COMMIT");
      expectCode(await waiting.pending, "28000");
      assert.deepEqual(await patient(2), snap);
      await B.client.query("BEGIN");
      expectOk(await settle(cancel(B, 2, "frontdesk", snap)));
      const logout = await blocked(A, B, () => A.client.query("SELECT public.revoke_staff_auth_session($1, 'frontdesk')", [actors.frontdesk.session]));
      await B.client.query("COMMIT");
      expectOk(await logout.pending);
    });

    test("a Cancel stuck behind a held counter lock gives up after lock_timeout (55P03) with nothing committed", async () => {
      const { A, B } = sessions;
      const before = await state();
      await A.client.query("BEGIN");
      await A.client.query("SELECT id FROM public.counters WHERE id_num = 'Doctor 2' FOR UPDATE");
      const started = Date.now();
      const outcome = await settle(cancel(B, 2, "frontdesk", await patient(2)));
      await A.client.query("ROLLBACK");
      expectCode(outcome, "55P03");
      assert.ok(Date.now() - started >= 4500, "waited for the 5s lock_timeout");
      assert.deepEqual(await state(), before);
    });

    test("a Cancel backend terminated while waiting, and a failure after its writes, leave patient and counters unchanged", async () => {
      const { A } = sessions;
      const victim = await connect("victim");
      // The termination below is intended. pg reports it as a client 'error' event, which without a
      // listener is thrown as unhandled and can fail the test under load before `pending` settles.
      victim.client.on("error", () => {});
      try {
        const before = await state();
        await A.client.query("BEGIN");
        await A.client.query("SELECT id FROM public.counters ORDER BY id FOR UPDATE");
        const pending = settle(cancel(victim, 2, "frontdesk", await patient(2)));
        await waitBlocked(victim, A);
        await observer.client.query("SELECT pg_terminate_backend($1)", [victim.pid]);
        assert.equal((await pending).ok, false);
        await A.client.query("ROLLBACK");
        assert.deepEqual(await state(), before);
      } finally {
        await victim.client.end().catch(() => {});
      }
      // A failing counter write after the patient update rolls both back.
      await observer.client.query(`CREATE FUNCTION public.w1_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic counter failure'; END $$`);
      await observer.client.query("CREATE TRIGGER w1_test_fail BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.w1_test_fail()");
      try {
        const before = await state();
        assert.equal((await settle(cancel(A, 2, "frontdesk", await patient(2)))).ok, false);
        assert.deepEqual(await state(), before);
      } finally {
        await observer.client.query("DROP TRIGGER w1_test_fail ON public.counters; DROP FUNCTION public.w1_test_fail()");
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("eligibility, authorization and validation (every refusal leaves no change)", () => {
    async function refused(outcomePromise, code) {
      const before = await state();
      expectCode(await settle(outcomePromise()), code);
      assert.deepEqual(await state(), before);
    }

    test("eligible: waiting and serving (called or in consultation); refused: completed, no-show, stale snapshot", async () => {
      const { A } = sessions;
      await refused(() => cancel(A, 4, "frontdesk", {}), "22023"); // no snapshot
      await refused(async () => cancel(A, 4, "admin1", await patient(4)), "QM001");
      await refused(async () => cancel(A, 5, "admin3", await patient(5)), "QM002");
      await refused(async () => cancel(A, 1, "frontdesk", { ...(await patient(1)), visit_state_revision: randomUUID() }), "40001");
      await refused(async () => cancel(A, 1, "frontdesk", { ...(await patient(1)), status: "serving" }), "40001");
      for (const [id, actor] of [[1, "admin1"], [3, "admin2"], [2, "admin1"], [7, "frontdesk"]]) {
        const before = await patient(id);
        const after = expectOk(await settle(cancel(A, id, actor, before)));
        assert.deepEqual([after.status, after.called_at, after.consultation_started_at, after.created_at, after.counter_id],
          ["cancelled", before.called_at, before.consultation_started_at, before.created_at, before.counter_id], `visit ${id} history kept`);
        assert.ok(after.completed_at);
        assert.deepEqual((await visit(id)).pointed_by, []);
      }
      assert.deepEqual(await pointers(), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    });

    test("cross-doctor: Doctor 1 cannot cancel Doctor 2 or Doctor 3 visits (nor the reverse); orphan visits are Frontdesk/Superadmin only", async () => {
      const { A } = sessions;
      for (const [id, actor] of [[3, "admin1"], [8, "admin1"], [2, "admin2"], [8, "admin2"], [1, "admin3"], [3, "admin3"], [7, "admin1"]]) {
        await refused(async () => cancel(A, id, actor, await patient(id)), "42501");
      }
      expectOk(await settle(cancel(A, 8, "admin3", await patient(8))));
    });

    test("Frontdesk (no assignment and the legacy 'Front Desk' label) and Superadmin keep cross-doctor cancellation", async () => {
      const { A } = sessions;
      for (const [id, actor] of [[2, "frontdesk"], [3, "frontdesk2"], [8, "superadmin"], [7, "superadmin"]]) {
        expectOk(await settle(cancel(A, id, actor, await patient(id))));
      }
      assert.deepEqual(await pointers(), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    });

    test("forged sessions, roles, doctors and accounts are 28000; forged counters and patients are refused", async () => {
      const { A } = sessions;
      const forged = [
        [3, "admin1", { p_session_id: randomUUID() }, "28000"],
        [3, "admin1", { p_session_id: actors.admin2.session }, "28000"],
        [3, "admin2", { p_user_id_num: "admin1", p_doctor_name: "Doctor 1" }, "28000"],
        [3, "admin1", { p_role: "superadmin", p_doctor_name: null }, "28000"],
        [3, "admin1", { p_doctor_name: "Doctor 2" }, "28000"],
        [3, "frontdesk", { p_doctor_name: "Doctor 2" }, "28000"],
        [3, "frontdesk2", { p_doctor_name: null }, "28000"],
        [3, "frontdesk", { p_user_id_num: "ghost" }, "28000"],
        [999, "frontdesk", {}, "P0002"]
      ];
      for (const [id, actor, overrides, code] of forged) {
        await refused(async () => cancel(A, id, actor, (await patient(id)) || { visit_state_revision: randomUUID(), status: "waiting" }, { overrides }), code);
      }
      await refused(async () => cancel(A, 3, "frontdesk", await patient(3), { requested: "Doctor 1" }), "QM003");
      await refused(async () => cancel(A, 3, "frontdesk", await patient(3), { requested: "Doctor 9" }), "22023");
      // A forged requested doctor on an orphan serving visit is never stamped onto it.
      const orphan = expectOk(await settle(cancel(A, 7, "frontdesk", await patient(7), { requested: "Doctor 1" })));
      assert.equal(orphan.counter_id, null);
    });

    test("reason: required, trimmed, at most 1000 characters", async () => {
      const { A } = sessions;
      for (const reason of [null, "", "   \t\n"]) await refused(async () => cancel(A, 1, "frontdesk", await patient(1), { reason }), "22023");
      await refused(async () => cancel(A, 1, "frontdesk", await patient(1), { reason: "x".repeat(1001) }), "22023");
      const ok = expectOk(await settle(cancel(A, 1, "frontdesk", await patient(1), { reason: `  ${"y".repeat(1000)}  ` })));
      assert.equal(ok.reason, "y".repeat(1000));
    });
  });

  // ---------------------------------------------------------------------------
  test("randomized Cancel / Call / Requeue / Undo / Start / Complete / heartbeat soak: no deadlock, no lock timeout, no broken pair", { timeout: 600000 }, async (t) => {
    const seeds = String(process.env.W1_PG_SOAK_SEEDS || "20261025,7,4242").split(",").map(Number);
    const OPS = Number(process.env.W1_PG_SOAK_OPS || 1500);
    const doctorFor = { consultation: 1, prenatal: 2, family_planning: 3 };
    for (const seed of seeds) {
      await reseed();
      await observer.client.query("UPDATE public.patients SET status = 'cancelled', completed_at = now() WHERE id IN (5, 7)"); // no no-show, no orphan
      for (const [service, minute, priority] of [["family_planning", 10, 2], ["consultation", 11, 0], ["prenatal", 12, 4], ["family_planning", 13, 0], ["consultation", 14, 1]]) {
        await observer.client.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, created_at, priority_score)
          VALUES ('Synthetic soak', 'SK-X', $1, 'waiting', $2, $3)`, [service, `2000-01-01 08:${minute}:00+00`, priority]);
      }
      const ids = (await observer.client.query("SELECT id FROM public.patients ORDER BY id")).rows.map((row) => Number(row.id));
      let rng = seed;
      const random = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
      const pick = (list) => list[Math.floor(random() * list.length)];
      const topWaiting = (number) => one(observer.client, `SELECT w.id AS value FROM public.patients w WHERE w.status = 'waiting'
        AND (CASE WHEN w.service_type IN ('consultation','checkup') THEN 1 WHEN w.service_type IN ('prenatal','maternity') THEN 2 ELSE 3 END) = $1
        ORDER BY coalesce(w.priority_score, 0) DESC, date_trunc('milliseconds', w.created_at), w.id LIMIT 1`, [number]);
      const tally = {};
      async function operation(s) {
        let snap = await patient(pick(ids));
        if (snap.status === "waiting" && random() < 0.7) snap = (await patient(await topWaiting(doctorFor[snap.service_type]))) || snap;
        const number = doctorFor[snap.service_type];
        const op = random() < 0.05 ? "heartbeat" : snap.status === "waiting" ? pick(["call", "call", "cancel"])
          : snap.status === "serving" ? (snap.consultation_started_at ? pick(["complete", "cancel"]) : pick(["start", "cancel", "cancel"]))
            : pick(["requeue", "undo", "cancel"]);
        const actor = pick(["frontdesk", "superadmin", `admin${number}`]);
        let outcome;
        if (op === "cancel") outcome = await settle(cancel(s, snap.id, actor, snap));
        else if (op === "call") outcome = await settle(call(s, snap, `Doctor ${number}`, actor));
        else if (op === "requeue") outcome = await settle(requeue(s, snap));
        else if (op === "undo") outcome = await settle(undo(s, snap));
        else if (op === "start") outcome = await settle(start(s, snap.id, number));
        else if (op === "complete") outcome = await settle(complete(s, snap.id, number, snap.consultation_started_at));
        else {
          const a = actors[actor];
          outcome = await settle(s.client.query("SELECT public.heartbeat_staff_auth_session($1, $2, $3, $4)", [a.session, a.idNum, a.role, a.doctor]));
        }
        const key = `${op}:${op === "heartbeat" ? "-" : snap.status}:${outcomeCode(outcome)}`;
        tally[key] = (tally[key] || 0) + 1;
        assert.notEqual(outcome.code, "40P01", `deadlock in ${op}`);
        assert.notEqual(outcome.code, "55P03", `lock timeout in ${op}`);
        if (op === "cancel" && !["completed"].includes(snap.status)) {
          assert.ok(outcome.ok || ["40001", "42501"].includes(outcome.code), `unexpected cancel outcome ${outcome.code}: ${outcome.message}`);
        }
      }
      let done = 0;
      let samples = 0;
      const workers = Object.values(sessions);
      await Promise.all([
        ...workers.map(async (worker) => { while (done < OPS) { done += 1; await operation(worker); } }),
        (async () => { while (done < OPS) { await assertConsistent(`seed ${seed} sample ${samples}`); samples += 1; await new Promise((r) => setTimeout(r, 5)); } })()
      ]);
      await assertConsistent(`seed ${seed} final`);
      t.diagnostic(`seed ${seed}: ${OPS} operations on ${workers.length} connections, ${samples} mid-run consistency samples: ${JSON.stringify(tally)}`);
      assert.ok(samples > 10);
      assert.ok((tally["cancel:serving:ok"] || 0) > 10 && (tally["cancel:waiting:ok"] || 0) > 10, JSON.stringify(tally));
      assert.ok((tally["call:waiting:ok"] || 0) > 10 && (tally["requeue:cancelled:ok"] || 0) > 5, JSON.stringify(tally));
      assert.ok(Object.keys(tally).some((key) => key.startsWith("cancel:") && key.endsWith(":40001")), `stale cancels were exercised: ${JSON.stringify(tally)}`);
    }
  });
});

describe("W1 on the development project's known schema (queue_status without 'no-show', Phase B.2)", { skip: unavailable }, () => {
  let admin; let db;
  before(async () => {
    admin = new pg.Client({ connectionString: TARGET, application_name: "w1-live-admin" });
    await admin.connect();
    await assertDisposableTarget(admin);
    db = await createDatabase(admin, "w1_live", {
      schema: BASE_SCHEMA.replace("'cancelled', 'no-show'", "'cancelled'"),
      scripts: STACK
    });
  });
  after(async () => {
    if (db) await db.setup.end().catch(() => {});
    if (admin && db) await admin.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`);
    if (admin) await admin.end();
  });

  test("preflight passes before install; install, verify and a cancel work without the no-show label; mapping matches Node", async () => {
    const { setup } = db;
    assert.equal(Number((await setup.query("SELECT count(*) AS n FROM pg_enum WHERE enumtypid = 'public.queue_status'::regtype AND enumlabel = 'no-show'")).rows[0].n), 0);
    await setup.query("INSERT INTO public.counters (id_num) VALUES ('Doctor 1'), ('Doctor 2'), ('Doctor 3')");
    await setup.query("SET ROLE postgres");
    const preflight = await scriptChecks(setup, "20261025-w1-preflight.sql");
    assert.deepEqual(preflight.filter((row) => !row.passed).map((row) => `${row.check_name}: ${row.actual}`), []);
    await setup.query(read(SCRIPTS + W1));
    const verify = [].concat(await setup.query(read(SCRIPTS + "20261025-w1-verify.sql")));
    assert.deepEqual(verify.find((result) => result.rows?.[0]?.result)?.rows, [{ result: "W1 verification passed" }]);
    await setup.query("RESET ROLE");
    assert.equal(Number((await setup.query("SELECT count(*) AS n FROM public.patients")).rows[0].n), 0, "verify kept nothing");
    // The owner mapping CASE equals getDoctorForService for known, legacy and unknown services.
    const getDoctorForService = nodeFunction("getDoctorForService");
    for (const service of ["consultation", "checkup", "prenatal", "maternity", "family_planning", "dental", "laboratory", "unknown-x"]) {
      const { rows: [row] } = await setup.query(`SELECT c.id_num FROM public.counters c WHERE c.id = public.qms_resolve_doctor_counter(CASE
        WHEN $1 IN ('consultation', 'checkup') THEN 'Doctor 1' WHEN $1 IN ('prenatal', 'maternity') THEN 'Doctor 2'
        WHEN $1 = 'family_planning' THEN 'Doctor 3' ELSE 'Doctor 1' END)`, [service]);
      assert.equal(row.id_num, getDoctorForService(service), service);
    }
    const source = read(SCRIPTS + W1).replace(/\r\n/g, "\n");
    assert.ok(source.includes(`WHEN v_patient.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
      WHEN v_patient.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
      WHEN v_patient.service_type = 'family_planning' THEN 'Doctor 3'
      ELSE 'Doctor 1' END`), "the migration uses the CASE checked above");
  });
});
