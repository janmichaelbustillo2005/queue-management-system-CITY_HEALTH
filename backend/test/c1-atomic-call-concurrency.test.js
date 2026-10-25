// C1: independent-connection PostgreSQL verification of call_patient_visit
// (20261025-c1-atomic-call.sql). Runs ONLY against the disposable LOCAL PostgreSQL 17 cluster
// used for R2.2/F5: PHASE25_PG_URL must point at 127.0.0.1/localhost, the server must report
// cluster_name = PHASE25_PG_CLUSTER (default "r22-disposable-cancel-verification") and listen
// only on 127.0.0.1. A fresh database is created, the repository migrations plus F5 and C1 are
// installed as a non-superuser "postgres" owner, and the database is dropped afterwards.
// Never reads .env or uses Supabase. Synthetic rows only.
// Skipped unless PHASE25_PG_URL and PHASE25_PG_MODULE (path to a `pg` package) are set.
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const { MIGRATIONS, read, nodeFunction, BASE_SCHEMA, SUPABASE_DEFAULT_PRIVILEGES, SEED } = require("./helpers/phase25CancelFixture");

const TARGET = process.env.PHASE25_PG_URL;
const CLUSTER = process.env.PHASE25_PG_CLUSTER || "r22-disposable-cancel-verification";
const F5 = "backend/scripts/20261022-f5-requeue-terminal-recovery.sql";
const C1 = "backend/scripts/20261025-c1-atomic-call.sql";
const C1_PREFLIGHT = "backend/scripts/20261025-c1-preflight.sql";
const C1_VERIFY = "backend/scripts/20261025-c1-verify.sql";
const SIGNATURE = "public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)";
// Starts at the seed's Manila business day (2000-01-01, as getTodayRange builds it) and stays open
// so visits re-queued during a test (created_at = now) remain in the queue being ranked.
const WINDOW = { start: "1999-12-31T16:00:00.000Z", end: "2100-01-01T00:00:00.000Z" };
let pg;
let unavailable;
if (!TARGET || !process.env.PHASE25_PG_MODULE) {
  unavailable = "Disposable local PostgreSQL not configured; set PHASE25_PG_URL and PHASE25_PG_MODULE.";
} else {
  pg = require(process.env.PHASE25_PG_MODULE);
}

const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, message: error.message }));

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

describe("C1 call_patient_visit on real PostgreSQL with independent connections", { skip: unavailable }, () => {
  let admin; let setup; let observer; let dbName; let testUrl;
  const sessions = {};

  async function connect(name, { serviceRole = true } = {}) {
    const client = new pg.Client({ connectionString: testUrl, application_name: `c1-${name}` });
    await client.connect();
    if (serviceRole) await client.query("SET ROLE service_role");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { name, client, pid };
  }

  before(async () => {
    admin = new pg.Client({ connectionString: TARGET, application_name: "c1-admin" });
    await admin.connect();
    await assertDisposableTarget(admin);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$`);
    dbName = `c1_call_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName} OWNER postgres TEMPLATE template0`);
    const url = new URL(TARGET); url.pathname = `/${dbName}`; testUrl = url.toString();
    setup = new pg.Client({ connectionString: testUrl, application_name: "c1-setup" });
    await setup.connect();
    assert.equal((await assertDisposableTarget(setup)).database, dbName);
    await setup.query("SET ROLE postgres");
    await setup.query(SUPABASE_DEFAULT_PRIVILEGES);
    await setup.query(BASE_SCHEMA);
    for (const script of MIGRATIONS) await setup.query(read(script));
    await setup.query(read(F5));
    await setup.query(read(C1));
    await setup.query("RESET ROLE");
    observer = await connect("observer", { serviceRole: false });
    for (const name of ["A", "B", "C"]) sessions[name] = await connect(name);
  });

  after(async () => {
    for (const session of Object.values(sessions)) await session.client.end().catch(() => {});
    if (observer) await observer.client.end().catch(() => {});
    if (setup) await setup.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    if (admin) await admin.end();
  });

  // Seed (phase25CancelFixture): 1 waiting GP, 2 GP in consultation on Doctor 1, 3 OB called on
  // Doctor 2, 4 completed, 5 no-show (Doctor 3), 6 cancelled (Doctor 1), 7 orphan serving GP,
  // 8 waiting FP. Doctor 3 is free, so FP visits are the Call subjects.
  beforeEach(async () => {
    for (const session of [...Object.values(sessions), observer]) await session.client.query("ROLLBACK").catch(() => {});
    await observer.client.query(SEED);
  });

  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0]?.value;
  const patient = (id) => one(observer.client, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
  const pointers = async () => Object.fromEntries((await observer.client.query("SELECT id_num, current_patient_id FROM public.counters ORDER BY id")).rows
    .map((row) => [row.id_num, row.current_patient_id == null ? null : Number(row.current_patient_id)]));
  const addWaiting = async (service, createdAt, priority = 0, extra = {}) => Number(await one(observer.client, `INSERT INTO public.patients
      (id_num, queue_number, service_type, status, created_at, priority_score, counter_id)
      VALUES ('Synthetic added', 'FP-X', $1, 'waiting', $2, $3, $4) RETURNING id AS value`,
    [service, createdAt, priority, extra.counter_id ?? null]));

  const callRpc = (s, id, doctor, user, revision, window = WINDOW) => one(s.client,
    "SELECT row_to_json(p) AS value FROM public.call_patient_visit($1, $2, $3, $4, $5, $6) p",
    [id, doctor, user, revision, window.start, window.end]);
  const call = async (s, id, doctor = "Doctor 3", user = "frontdesk") => callRpc(s, id, doctor, user, (await patient(id)).visit_state_revision);
  const recoveryArgs = (snap, action) => [snap.id, action, snap.visit_state_revision, snap.status, snap.created_at, snap.called_at,
    snap.consultation_started_at, snap.completed_at, snap.counter_id, action === "requeue" ? "Synthetic requeue" : null];
  const recover = (s, fn, snap, action) => one(s.client, `SELECT row_to_json(p) AS value FROM public.${fn}(
    $1, $2, 'frontdesk', $3, $4, $5, $6, $7, $8, $9, $10) p`, recoveryArgs(snap, action));
  const requeue = (s, snap) => recover(s, "requeue_patient_visit", snap, "requeue");
  const undo = (s, snap) => recover(s, "undo_patient_visit_waiting", snap, "undo");
  const complete = (s, id, number, startedAt) => one(s.client, `SELECT row_to_json(p) AS value FROM public.complete_patient_consultation(
    $1, $2, $3, $4, 'Synthetic completion') p`, [id, `Doctor ${number}`, `admin${number}`, startedAt]);
  // The current backend Cancel: two PostgREST statements (patient CAS, then pointer release).
  const cancelCas = (s, snap) => s.client.query(`UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp(),
    reason = 'Synthetic cancel' WHERE id = $1 AND status = $2 AND visit_state_revision = $3`, [snap.id, snap.status, snap.visit_state_revision]);
  const cancelRelease = (s, id) => s.client.query("UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = $1", [id]);
  const cancelAtomic = async (s, snap) => {
    await s.client.query("BEGIN");
    try {
      await s.client.query("SELECT id FROM public.counters ORDER BY id FOR UPDATE");
      const updated = (await cancelCas(s, snap)).rowCount;
      if (updated) await cancelRelease(s, snap.id);
      await s.client.query("COMMIT");
      return updated;
    } catch (error) { await s.client.query("ROLLBACK"); throw error; }
  };
  // The pre-C1 Call, and the backend's fallback while C1 is not installed (revision-guarded CAS).
  const claim = (s, id, doctor = "Doctor 3") => s.client.query(`UPDATE public.counters SET current_patient_id = $1
    WHERE id_num = $2 AND is_online AND current_patient_id IS NULL`, [id, doctor]);
  const serveCas = (s, id, revision, doctor = "Doctor 3") => s.client.query(`UPDATE public.patients
    SET status = 'serving', counter_id = $2, called_at = clock_timestamp()
    WHERE id = $1 AND status = 'waiting' AND completed_at IS NULL AND counter_id IS NULL
      AND ($3::uuid IS NULL OR visit_state_revision = $3)`, [id, doctor, revision]);
  const releaseClaim = (s, id, doctor = "Doctor 3") => s.client.query(
    "UPDATE public.counters SET current_patient_id = NULL WHERE id_num = $2 AND current_patient_id = $1", [id, doctor]);

  // The patient/counter relationship every committed state must satisfy.
  async function assertConsistent(label = "") {
    const { rows } = await observer.client.query(`
      SELECT c.id_num, c.current_patient_id AS pid, p.status::text AS status, p.counter_id
        FROM public.counters c LEFT JOIN public.patients p ON p.id = c.current_patient_id
        WHERE c.current_patient_id IS NOT NULL`);
    for (const row of rows) {
      assert.equal(row.status, "serving", `${label}: ${row.id_num} points at a ${row.status} visit`);
      assert.equal(row.counter_id, row.id_num, `${label}: ${row.id_num} points at a visit assigned to ${row.counter_id}`);
    }
    const { rows: serving } = await observer.client.query(`
      SELECT p.id, p.counter_id, p.called_at, (SELECT array_agg(c.id_num) FROM public.counters c WHERE c.current_patient_id = p.id) AS owners
        FROM public.patients p WHERE p.status = 'serving' AND p.counter_id IS NOT NULL`);
    for (const row of serving) {
      assert.deepEqual(row.owners, [row.counter_id], `${label}: serving visit ${row.id} on ${row.counter_id} has counters ${row.owners}`);
      assert.ok(row.called_at, `${label}: serving visit ${row.id} has no call time`);
    }
  }

  async function waitBlocked(waiter, holder) {
    const deadline = Date.now() + 8000;
    for (;;) {
      const { rows: [row] } = await observer.client.query(
        "SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1", [waiter.pid]);
      if (row?.wait_event_type === "Lock" && row.blockers.includes(holder.pid)) return;
      if (Date.now() > deadline) assert.fail(`${waiter.name} never waited on ${holder.name}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("installed function: SECURITY DEFINER, empty search_path, 5s lock_timeout, EXECUTE only for service_role", async () => {
    const { rows: [fn] } = await observer.client.query(`SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [SIGNATURE]);
    assert.ok(fn, "function installed");
    assert.equal(fn.prosecdef, true);
    assert.deepEqual([...fn.proconfig].sort(), ["lock_timeout=5s", 'search_path=""']);
    assert.equal(fn.owner, "postgres");
    assert.deepEqual([fn.anon, fn.authenticated, fn.service_role, fn.public_execute], [false, false, true, false]);
    for (const role of ["anon", "authenticated"]) {
      await observer.client.query(`SET ROLE ${role}`);
      const denied = await settle(observer.client.query("SELECT public.call_patient_visit(8, 'Doctor 3', 'frontdesk', gen_random_uuid(), now(), now() + interval '1 day')"));
      await observer.client.query("RESET ROLE");
      assert.equal(denied.code, "42501", `${role} cannot execute`);
    }
  });

  test("preflight and post-install verification scripts report all PASS on this database", async () => {
    for (const script of [C1_PREFLIGHT, C1_VERIFY]) {
      // Both are single READ ONLY transactions ending with a tabular PASS/FAIL result.
      const results = await observer.client.query(read(script));
      const last = [].concat(results).filter((result) => result.command === "SELECT").at(-1);
      const failed = last.rows.filter((row) => row.passed !== true);
      assert.deepEqual(failed, [], `${script}: ${JSON.stringify(failed)}`);
      assert.ok(last.rows.length >= 10, `${script} returned its checks`);
    }
    await assertConsistent("after verification");
  });

  test("the SQL service-to-doctor mapping equals getDoctorForService for known, legacy and unknown services", async () => {
    const sql = read(C1);
    const blocks = [...sql.matchAll(/CASE\s+WHEN (\w+)\.service_type IN \('consultation'[\s\S]*?ELSE 'Doctor 1'\s+END/g)]
      .map(([block, alias]) => block.replaceAll(`${alias}.`, "x.").replace(/\s+/g, " "));
    assert.equal(blocks.length, 3, "routing, busy-doctor and priority checks");
    assert.equal(new Set(blocks).size, 1, "every CASE block is identical");
    const getDoctorForService = nodeFunction("getDoctorForService");
    for (const service of ["consultation", "checkup", "prenatal", "maternity", "family_planning", "dental", "laboratory", "", "Family_Planning"]) {
      const doctor = await one(observer.client, `SELECT ${blocks[0]} AS value FROM (VALUES ($1::text)) AS x(service_type)`, [service]);
      assert.equal(doctor, getDoctorForService(service), service);
    }
  });

  test("a successful Call commits one consistent patient and counter pair", async () => {
    const before = await patient(8);
    const called = await call(sessions.A, 8);
    assert.equal(called.status, "serving");
    assert.equal(called.counter_id, "Doctor 3");
    assert.ok(called.called_at);
    assert.equal(called.completed_at, null);
    assert.equal(called.consultation_started_at, null);
    assert.equal(called.created_at, before.created_at, "registration order is preserved");
    assert.notEqual(called.visit_state_revision, before.visit_state_revision);
    assert.deepEqual(await patient(8), called, "the returned row is the committed row");
    assert.deepEqual(await pointers(), { "Doctor 1": 2, "Doctor 2": 3, "Doctor 3": 8 });
    await assertConsistent();
  });

  // C1 Scenario B, the exact F5-audit defect: Cancel and Requeue commit between the two stages of Call.
  test("before/after: Cancel + Requeue inside Call's window - legacy two-step corrupts, the fallback and the RPC refuse", async () => {
    const { A, B } = sessions;
    const variants = {
      // Pre-C1 Call: no revision in the patient CAS.
      legacy: { revisionGuard: false },
      // Post-C1 backend while the migration is not installed.
      fallback: { revisionGuard: true }
    };
    const outcome = {};
    for (const [name, { revisionGuard }] of Object.entries(variants)) {
      await observer.client.query(SEED);
      const snap = await patient(8);
      assert.equal((await claim(B, 8)).rowCount, 1, `${name}: Call stage 1 claims Doctor 3`);
      assert.equal(await cancelAtomic(A, snap), 1, `${name}: Cancel commits and releases the claim`);
      await requeue(A, await patient(8));
      const served = (await serveCas(B, 8, revisionGuard ? snap.visit_state_revision : null)).rowCount;
      if (!served) await releaseClaim(B, 8);
      const after = await patient(8);
      outcome[name] = { served, status: after.status, counter_id: after.counter_id, pointer: (await pointers())["Doctor 3"] };
    }
    assert.deepEqual(outcome.legacy, { served: 1, status: "serving", counter_id: "Doctor 3", pointer: null },
      "C1 reproduced on the pre-fix statements: serving visit without its counter");
    assert.deepEqual(outcome.fallback, { served: 0, status: "waiting", counter_id: null, pointer: null });
    await assertConsistent("fallback");

    await observer.client.query(SEED);
    const snap = await patient(8);
    await cancelAtomic(A, snap);
    await requeue(A, await patient(8));
    const stale = await settle(callRpc(B, 8, "Doctor 3", "frontdesk", snap.visit_state_revision));
    assert.equal(stale.code, "40001", stale.message);
    const after = await patient(8);
    assert.deepEqual([after.status, after.counter_id, after.called_at], ["waiting", null, null]);
    assert.equal((await pointers())["Doctor 3"], null);
    await assertConsistent("rpc");
  });

  test("Call vs Cancel: Cancel waiting on an uncommitted Call matches no row after the Call commits", async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await A.client.query("BEGIN");
    await callRpc(A, 8, "Doctor 3", "frontdesk", snap.visit_state_revision);
    const cancel = settle(cancelCas(B, snap));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    // The backend answers 409 and, without a successful CAS, never runs its counter release.
    assert.equal((await cancel).value.rowCount, 0, "Cancel of the waiting snapshot is stale");
    assert.equal((await patient(8)).status, "serving");
    assert.equal((await pointers())["Doctor 3"], 8);
    await assertConsistent();
  });

  test("Call vs Cancel: a Call waiting on an uncommitted Cancel fails with 40001 and claims nothing", async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await A.client.query("BEGIN");
    assert.equal((await cancelCas(A, snap)).rowCount, 1);
    const pending = settle(callRpc(B, 8, "Doctor 3", "frontdesk", snap.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    await cancelRelease(A, 8);
    const result = await pending;
    assert.equal(result.code, "40001", result.message);
    const after = await patient(8);
    assert.deepEqual([after.status, after.called_at], ["cancelled", null]);
    assert.equal((await pointers())["Doctor 3"], null, "no counter is left on the cancelled visit");
    await assertConsistent();
  });

  test("Call vs Cancel then Requeue in flight: Call waits for Requeue's counter locks, then refuses the old revision", async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await cancelAtomic(A, snap);
    await A.client.query("BEGIN");
    await requeue(A, await patient(8));
    const pending = settle(callRpc(B, 8, "Doctor 3", "frontdesk", snap.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    assert.equal((await pending).code, "40001");
    assert.equal((await patient(8)).status, "waiting");
    assert.equal((await pointers())["Doctor 3"], null);
    // A fresh read of the re-queued visit is callable (authorized Requeue then Call).
    assert.equal((await call(B, 8)).status, "serving");
    await assertConsistent();
  });

  test("Call vs Undo: an Undo ABA (cancel then undo, same status and registration) is refused; an in-flight Undo is waited for", async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await cancelAtomic(A, snap);
    await A.client.query("BEGIN");
    const undone = await undo(A, await patient(8));
    assert.equal(undone.created_at, snap.created_at, "Undo keeps the queue position, so only the revision differs");
    const pending = settle(callRpc(B, 8, "Doctor 3", "frontdesk", snap.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    assert.equal((await pending).code, "40001");
    const after = await patient(8);
    assert.deepEqual([after.status, after.counter_id, (await pointers())["Doctor 3"]], ["waiting", null, null]);
    await assertConsistent();
  });

  test("Call vs Complete: Call waits for the doctor's in-flight Complete, then calls the next patient", async () => {
    const { A, B } = sessions;
    await observer.client.query("UPDATE public.patients SET status = 'cancelled', completed_at = now() WHERE id = 7"); // orphan out of the way
    const inConsultation = await patient(2);
    const next = await patient(1);
    await A.client.query("BEGIN");
    await complete(A, 2, 1, inConsultation.consultation_started_at);
    const pending = settle(callRpc(B, 1, "Doctor 1", "frontdesk", next.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    const result = await pending;
    assert.ok(result.ok, result.message);
    const completed = await patient(2);
    assert.equal(completed.status, "completed");
    assert.equal(completed.consultation_started_at, inConsultation.consultation_started_at, "consultation start preserved");
    assert.equal((await pointers())["Doctor 1"], 1);
    await assertConsistent();
  });

  test("Call while the doctor is busy, or with a legacy orphan serving visit, refuses and changes nothing", async () => {
    const before = await patient(1);
    let result = await settle(call(sessions.A, 1, "Doctor 1"));
    assert.equal(result.code, "P0001");
    assert.match(result.message, /Doctor 1 is already serving a patient/);
    await observer.client.query("UPDATE public.counters SET current_patient_id = NULL WHERE id_num = 'Doctor 1'");
    await observer.client.query("UPDATE public.patients SET status = 'completed', completed_at = now() WHERE id = 2");
    result = await settle(call(sessions.A, 1, "Doctor 1"));
    assert.match(result.message, /already serving/, "orphan serving GP (counter_id NULL) still blocks Doctor 1");
    assert.deepEqual(await patient(1), before);
    assert.equal((await pointers())["Doctor 1"], null);
  });

  test("two simultaneous Calls for one patient: exactly one commits; the other fails without touching the counter", async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await A.client.query("BEGIN");
    await callRpc(A, 8, "Doctor 3", "frontdesk", snap.visit_state_revision);
    const second = settle(callRpc(B, 8, "Doctor 3", "admin3", snap.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    const result = await second;
    assert.equal(result.ok, false);
    assert.equal(result.code, "40001");
    const after = await patient(8);
    assert.equal(after.status, "serving");
    assert.equal((await pointers())["Doctor 3"], 8);
    // A duplicate retry of the same request (same revision) is refused, too.
    assert.equal((await settle(callRpc(B, 8, "Doctor 3", "frontdesk", snap.visit_state_revision))).code, "40001");
    assert.deepEqual(await patient(8), after, "the winner's call time and revision are unchanged");
    await assertConsistent();
  });

  test("two waiting patients contending for Doctor 3: one serves, the other stays waiting and the counter has one pointer", async () => {
    const { A, B } = sessions;
    const tied = await addWaiting("family_planning", "2000-01-01 08:04:00+00", 0); // same priority and time as 8, higher id
    const first = await patient(8);
    const second = await patient(tied);
    await A.client.query("BEGIN");
    await callRpc(A, 8, "Doctor 3", "frontdesk", first.visit_state_revision);
    const pending = settle(callRpc(B, tied, "Doctor 3", "frontdesk", second.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    const result = await pending;
    assert.equal(result.code, "P0001");
    assert.match(result.message, /already serving/);
    assert.deepEqual(await patient(tied), second);
    assert.equal((await pointers())["Doctor 3"], 8);
    await assertConsistent();
  });

  test("Weighted-Priority order: priority_score, then registration time in milliseconds, then id; other days do not compete", async () => {
    const regular = 8; // priority 0, 08:04:00
    const senior = await addWaiting("family_planning", "2000-01-01 08:30:00+00", 2);
    const seniorEarlier = await addWaiting("family_planning", "2000-01-01 08:20:00.000900+00", 2);
    const seniorSameMs = await addWaiting("family_planning", "2000-01-01 08:20:00.000100+00", 2); // later id, earlier microseconds
    const yesterdayUrgent = await addWaiting("family_planning", "1999-12-31 08:00:00+00", 9);
    for (const id of [regular, senior, seniorSameMs, yesterdayUrgent]) {
      const result = await settle(call(sessions.A, id));
      assert.equal(result.code, "P0001", `visit ${id} is not next`);
      assert.match(result.message, /next eligible patient for Doctor 3 according to queue priority/);
    }
    // The backend compares created_at at millisecond precision, then id: seniorEarlier wins the tie.
    assert.equal((await call(sessions.A, seniorEarlier)).status, "serving");
    await assertConsistent();
  });

  test("Counter unavailable: offline is refused; an offline toggle in flight is waited for and then refused", async () => {
    const { A, B } = sessions;
    await observer.client.query("UPDATE public.counters SET is_online = false WHERE id_num = 'Doctor 3'");
    let result = await settle(call(B, 8));
    assert.equal(result.code, "P0001");
    assert.match(result.message, /offline/);
    await observer.client.query("UPDATE public.counters SET is_online = true WHERE id_num = 'Doctor 3'");
    await A.client.query("BEGIN");
    await A.client.query("UPDATE public.counters SET is_online = false WHERE id_num = 'Doctor 3'");
    const pending = settle(call(B, 8));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    result = await pending;
    assert.match(result.message, /offline/);
    assert.equal((await patient(8)).status, "waiting");
    assert.equal((await pointers())["Doctor 3"], null);
  });

  test("forged or mismatched identities and assignments are refused; Frontdesk, the legacy label and Superadmin may call", async () => {
    const snap = await patient(8);
    const refused = [
      ["admin1", "Doctor 3", "42501", /assigned to your doctor/],
      ["admin2", "Doctor 3", "42501", /assigned to your doctor/],
      ["nobody", "Doctor 3", "42501", /staff account/],
      ["frontdesk", "Doctor 1", "P0001", /assigned to another doctor/],
      ["frontdesk", "Doctor 9", "22023", /required/],
      [null, "Doctor 3", "22023", /required/]
    ];
    for (const [user, doctor, code, message] of refused) {
      const result = await settle(callRpc(sessions.A, 8, doctor, user, snap.visit_state_revision));
      assert.equal(result.code, code, `${user} -> ${doctor}: ${result.message}`);
      assert.match(result.message, message);
    }
    assert.equal((await settle(callRpc(sessions.A, 8, "Doctor 3", "frontdesk", null))).code, "22023", "a revision is required");
    assert.equal((await settle(callRpc(sessions.A, 8, "Doctor 3", "frontdesk", snap.visit_state_revision,
      { start: WINDOW.end, end: WINDOW.start }))).code, "22023", "an empty queue window is refused");
    assert.equal((await settle(callRpc(sessions.A, 999, "Doctor 3", "frontdesk", snap.visit_state_revision))).code, "P0002");
    // A conflicting stored assignment or a pointer from another counter.
    await observer.client.query("UPDATE public.patients SET counter_id = 'Doctor 2' WHERE id = 8");
    assert.match((await settle(call(sessions.A, 8))).message, /conflicting doctor assignment/);
    await observer.client.query("UPDATE public.patients SET counter_id = NULL WHERE id = 8");
    await observer.client.query("UPDATE public.counters SET current_patient_id = 8 WHERE id_num = 'Doctor 2'");
    assert.match((await settle(call(sessions.A, 8))).message, /already assigned to another doctor/);
    await observer.client.query("UPDATE public.counters SET current_patient_id = 3 WHERE id_num = 'Doctor 2'");
    assert.equal((await patient(8)).status, "waiting");
    assert.equal((await pointers())["Doctor 3"], null);
    for (const user of ["frontdesk", "frontdesk2", "superadmin", "admin3"]) {
      await observer.client.query(SEED);
      assert.equal((await call(sessions.A, 8, "Doctor 3", user)).status, "serving", user);
      await assertConsistent(user);
    }
  });

  test("an account reassigned while Node was validating is re-checked under the users lock", async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await A.client.query("BEGIN");
    await A.client.query("UPDATE public.users SET doctor_name = 'Doctor 1' WHERE id_num = 'admin3'");
    const pending = settle(callRpc(B, 8, "Doctor 3", "admin3", snap.visit_state_revision));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    const result = await pending;
    assert.equal(result.code, "42501");
    assert.deepEqual(await patient(8), snap);
  });

  test("a legacy Phase 2.1 Undo reservation is called in place, without a second pointer", async () => {
    await observer.client.query("UPDATE public.patients SET counter_id = 'Doctor 3' WHERE id = 8");
    await observer.client.query("UPDATE public.counters SET current_patient_id = 8 WHERE id_num = 'Doctor 3'");
    const called = await call(sessions.A, 8);
    assert.deepEqual([called.status, called.counter_id], ["serving", "Doctor 3"]);
    assert.equal((await pointers())["Doctor 3"], 8);
    await assertConsistent();
  });

  test("a Call stuck behind a held counter lock gives up after lock_timeout with nothing committed", { timeout: 20000 }, async () => {
    const { A, B } = sessions;
    const snap = await patient(8);
    await A.client.query("BEGIN");
    await A.client.query("SELECT id FROM public.counters WHERE id_num = 'Doctor 1' FOR UPDATE");
    const result = await settle(callRpc(B, 8, "Doctor 3", "frontdesk", snap.visit_state_revision));
    await A.client.query("ROLLBACK");
    assert.equal(result.code, "55P03");
    assert.deepEqual(await patient(8), snap);
    assert.equal((await pointers())["Doctor 3"], null);
  });

  // Remaining dependency (not C1): the current backend Cancel releases counters in a separate
  // statement by patient id. If a Requeue and a new atomic Call commit between Cancel's two
  // statements, the delayed release clears the NEW legitimate assignment. The atomic Cancel
  // proposal (phase25 rev2) closes it; the same shape is N1 for No-show. Pinned to fail loudly
  // once Cancel releases only inside its own transaction.
  test("known Cancel dependency: a delayed two-step Cancel release clears a later valid Call's counter", async () => {
    const { A, B } = sessions;
    assert.equal((await cancelCas(A, await patient(8))).rowCount, 1, "Cancel statement 1");
    await requeue(B, await patient(8));
    assert.equal((await call(B, 8)).status, "serving", "a correct atomic Call of the re-queued visit");
    await cancelRelease(A, 8); // Cancel statement 2 (delayed)
    const after = await patient(8);
    assert.deepEqual([after.status, after.counter_id, (await pointers())["Doctor 3"]], ["serving", "Doctor 3", null],
      "dependency reproduced: Cancel's release is not tied to its own revision");
    // The atomic Cancel stand-in (counters locked, CAS and release in one transaction) cannot do this.
    await observer.client.query(SEED);
    const snap = await patient(8);
    await cancelAtomic(A, snap);
    await requeue(B, await patient(8));
    await call(B, 8);
    assert.equal(await cancelAtomic(A, snap), 0, "a repeated atomic Cancel with the old snapshot matches nothing");
    await assertConsistent("atomic cancel");
  });

  test("randomized Call / Cancel / Requeue / Undo / Start / Complete interleavings never deadlock or break a patient/counter pair", { timeout: 180000 }, async (t) => {
    const workers = [sessions.A, sessions.B, sessions.C];
    const seed = Number(process.env.C1_PG_SOAK_SEED || 20261025);
    let state = seed;
    const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const tally = {};
    const doctorFor = { consultation: 1, prenatal: 2, family_planning: 3 };
    await observer.client.query("UPDATE public.patients SET status = 'cancelled', completed_at = now() WHERE id = 7"); // no orphan
    for (const [service, minute, priority] of [["family_planning", 10, 2], ["consultation", 11, 0], ["prenatal", 12, 4], ["family_planning", 13, 0]]) {
      await addWaiting(service, `2000-01-01 08:${minute}:00+00`, priority);
    }
    const ids = (await observer.client.query("SELECT id FROM public.patients ORDER BY id")).rows.map((row) => Number(row.id));
    const topWaiting = async (number) => one(observer.client, `SELECT w.id AS value FROM public.patients w
      WHERE w.status = 'waiting' AND (CASE WHEN w.service_type IN ('consultation','checkup') THEN 1
        WHEN w.service_type IN ('prenatal','maternity') THEN 2 ELSE 3 END) = $1
      ORDER BY coalesce(w.priority_score, 0) DESC, date_trunc('milliseconds', w.created_at), w.id LIMIT 1`, [number]);
    async function operation(s) {
      let snap = await patient(pick(ids));
      // Mostly target the doctor's actual next patient so Calls make progress.
      const top = snap.status === "waiting" && random() < 0.7 ? await topWaiting(doctorFor[snap.service_type]) : null;
      if (top != null) snap = (await patient(top)) || snap;
      const number = doctorFor[snap.service_type];
      let op;
      if (snap.status === "waiting") op = pick(["call", "call", "call", "cancel"]);
      else if (snap.status === "serving") op = snap.consultation_started_at ? pick(["complete", "cancel"]) : pick(["start", "cancel", "call"]);
      else op = pick(["requeue", "undo"]);
      let outcome;
      if (op === "call") outcome = await settle(callRpc(s, snap.id, `Doctor ${number}`, pick(["frontdesk", "superadmin", `admin${number}`]), snap.visit_state_revision));
      else if (op === "cancel") outcome = await settle(cancelAtomic(s, snap));
      else if (op === "requeue") outcome = await settle(requeue(s, snap));
      else if (op === "undo") outcome = await settle(undo(s, snap));
      else if (op === "start") outcome = await settle(one(s.client, "SELECT row_to_json(p) AS value FROM public.start_patient_consultation($1, $2, $3, clock_timestamp()) p",
        [snap.id, `Doctor ${number}`, `admin${number}`]));
      else outcome = await settle(complete(s, snap.id, number, snap.consultation_started_at));
      const key = `${op}:${snap.status}:${outcome.ok ? "ok" : outcome.code}`;
      tally[key] = (tally[key] || 0) + 1;
      assert.notEqual(outcome.code, "40P01", `deadlock in ${op}`);
      assert.notEqual(outcome.code, "55P03", `lock timeout in ${op}`);
      if (op === "call" && snap.status !== "waiting") assert.equal(outcome.ok, false, "only a waiting visit can be called");
    }
    const OPS = Number(process.env.C1_PG_SOAK_OPS || 900);
    let done = 0;
    let checks = 0;
    await Promise.all([
      ...workers.map(async (worker) => { while (done < OPS) { done += 1; await operation(worker); } }),
      // Committed states are sampled while the workers run, not only at the end.
      (async () => { while (done < OPS) { await assertConsistent(`sample ${checks}`); checks += 1; await new Promise((r) => setTimeout(r, 5)); } })()
    ]);
    await assertConsistent("final");
    t.diagnostic(`seed ${seed}, ${OPS} operations, ${checks} consistency samples: ${JSON.stringify(tally)}`);
    assert.ok(checks > 10, `consistency sampled during the run (${checks})`);
    assert.ok(tally["call:waiting:ok"] > 20, `Calls succeeded: ${JSON.stringify(tally)}`);
    assert.ok(Object.keys(tally).some((key) => key.startsWith("call:waiting:") && !key.endsWith(":ok")), `Calls were refused too: ${JSON.stringify(tally)}`);
  });
});
