// F5: independent-connection PostgreSQL verification of requeue_patient_visit.
// Runs ONLY against the disposable LOCAL PostgreSQL 17 cluster used for R2.2: PHASE25_PG_URL must
// point at 127.0.0.1/localhost and the server must report cluster_name = PHASE25_PG_CLUSTER
// (default "r22-disposable-cancel-verification") and listen only on 127.0.0.1. A fresh database
// is created, the repository migrations plus the F5 migration are installed as a non-superuser
// "postgres" owner, and the database is dropped afterwards. Never reads .env or uses Supabase.
// Skipped unless PHASE25_PG_URL and PHASE25_PG_MODULE (path to a `pg` package) are set.
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const { MIGRATIONS, read, BASE_SCHEMA, SUPABASE_DEFAULT_PRIVILEGES, SEED } = require("./helpers/phase25CancelFixture");

const TARGET = process.env.PHASE25_PG_URL;
const CLUSTER = process.env.PHASE25_PG_CLUSTER || "r22-disposable-cancel-verification";
const F5 = "backend/scripts/20261022-f5-requeue-terminal-recovery.sql";
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

describe("F5 requeue_patient_visit on real PostgreSQL with independent connections", { skip: unavailable }, () => {
  let admin; let setup; let observer; let dbName; let testUrl;
  const sessions = {};

  async function connect(name, { serviceRole = true } = {}) {
    const client = new pg.Client({ connectionString: testUrl, application_name: `f5-${name}` });
    await client.connect();
    if (serviceRole) await client.query("SET ROLE service_role");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { name, client, pid };
  }

  before(async () => {
    admin = new pg.Client({ connectionString: TARGET, application_name: "f5-admin" });
    await admin.connect();
    await assertDisposableTarget(admin);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$`);
    dbName = `f5_requeue_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName} OWNER postgres TEMPLATE template0`);
    const url = new URL(TARGET); url.pathname = `/${dbName}`; testUrl = url.toString();
    setup = new pg.Client({ connectionString: testUrl, application_name: "f5-setup" });
    await setup.connect();
    assert.equal((await assertDisposableTarget(setup)).database, dbName);
    await setup.query("SET ROLE postgres");
    await setup.query(SUPABASE_DEFAULT_PRIVILEGES);
    await setup.query(BASE_SCHEMA);
    for (const script of MIGRATIONS) await setup.query(read(script));
    await setup.query(read(F5));
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

  // Seed (phase25CancelFixture): 2 GP in consultation on Doctor 1, 3 OB called on Doctor 2,
  // 5 no-show (Doctor 3), 6 cancelled (Doctor 1), 8 waiting FP, 7 orphan serving.
  beforeEach(async () => {
    // A failed scenario must not leave a transaction (and its locks) open for the next one.
    for (const session of Object.values(sessions)) await session.client.query("ROLLBACK").catch(() => {});
    await observer.client.query(SEED);
  });

  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0]?.value;
  const patient = (id) => one(observer.client, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
  const pointers = async () => Object.fromEntries((await observer.client.query("SELECT id_num, current_patient_id FROM public.counters ORDER BY id")).rows
    .map((row) => [row.id_num, row.current_patient_id == null ? null : Number(row.current_patient_id)]));
  const recoveryArgs = (snap, action, status) => [snap.id, action, snap.visit_state_revision, status ?? snap.status,
    snap.created_at, snap.called_at, snap.consultation_started_at, snap.completed_at, snap.counter_id,
    action === "requeue" ? "Synthetic requeue" : null];
  const call = (s, fn, snap, action, status) => one(s.client, `SELECT row_to_json(p) AS value FROM public.${fn}(
    $1, $2, 'frontdesk', $3, $4, $5, $6, $7, $8, $9, $10) p`, recoveryArgs(snap, action, status));
  const requeue = (s, snap, status) => call(s, "requeue_patient_visit", snap, "requeue", status);
  const undo = (s, snap) => call(s, "undo_patient_visit_waiting", snap, "undo");
  const complete = (s, id, number, startedAt) => one(s.client, `SELECT row_to_json(p) AS value FROM public.complete_patient_consultation(
    $1, $2, $3, $4, 'Synthetic completion') p`, [id, `Doctor ${number}`, `admin${number}`, startedAt]);

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

  test("Requeue waits for an in-flight Complete on the same counter; both commit, no deadlock", async () => {
    const { A, B } = sessions;
    await observer.client.query("UPDATE public.counters SET current_patient_id = 6 WHERE id_num = 'Doctor 3'"); // stale pointer
    const inConsultation = await patient(2);
    await B.client.query("BEGIN");
    await complete(B, 2, 1, inConsultation.consultation_started_at);
    const pending = settle(requeue(A, await patient(6)));
    await waitBlocked(A, B);
    await B.client.query("COMMIT");
    const result = await pending;
    assert.ok(result.ok, result.message);
    assert.equal(result.value.status, "waiting");
    const completed = await patient(2);
    assert.equal(completed.status, "completed");
    assert.equal(completed.consultation_started_at, inConsultation.consultation_started_at, "consultation start preserved");
    assert.deepEqual(await pointers(), { "Doctor 1": null, "Doctor 2": 3, "Doctor 3": null });
  });

  test("Complete waits for an in-flight Requeue holding the counters; both commit, no deadlock", async () => {
    const { A, B } = sessions;
    const inConsultation = await patient(2);
    await A.client.query("BEGIN");
    await requeue(A, await patient(6));
    const pending = settle(complete(B, 2, 1, inConsultation.consultation_started_at));
    await waitBlocked(B, A);
    await A.client.query("COMMIT");
    const result = await pending;
    assert.ok(result.ok, result.message);
    assert.equal((await patient(2)).status, "completed");
    assert.equal((await patient(6)).status, "waiting");
    assert.deepEqual(await pointers(), { "Doctor 1": null, "Doctor 2": 3, "Doctor 3": null });
  });

  for (const first of ["undo", "requeue"]) {
    test(`Requeue and Undo from one cancelled snapshot: ${first} commits first, the other gets 40001`, async () => {
      const { A, B } = sessions;
      const snap = await patient(6);
      const ops = { undo: (s) => undo(s, snap), requeue: (s) => requeue(s, snap) };
      const second = first === "undo" ? "requeue" : "undo";
      await A.client.query("BEGIN");
      await ops[first](A);
      const pending = settle(ops[second](B));
      await waitBlocked(B, A);
      await A.client.query("COMMIT");
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.code, "40001");
      const after = await patient(6);
      assert.equal(after.status, "waiting");
      assert.equal(after.created_at === snap.created_at, first === "undo", "the committed action's queue position stands");
    });
  }

  test("a Call during an uncommitted Requeue cannot claim the stale-pointer counter; it can once Requeue commits", async () => {
    const { A, B } = sessions;
    await observer.client.query("UPDATE public.counters SET current_patient_id = 5 WHERE id_num = 'Doctor 3'"); // no-show, stale
    const claim = () => B.client.query(`UPDATE public.counters SET current_patient_id = 8
      WHERE id_num = 'Doctor 3' AND is_online AND current_patient_id IS NULL`);
    await A.client.query("BEGIN");
    await requeue(A, await patient(5));
    // The committed row still points at 5, so the claim matches nothing: Call reports the doctor
    // as occupied instead of overwriting or waiting on an uncommitted release.
    assert.equal((await claim()).rowCount, 0);
    await A.client.query("COMMIT");
    assert.equal((await claim()).rowCount, 1, "the released counter is claimable after commit");
    assert.equal((await pointers())["Doctor 3"], 8);
    assert.equal((await patient(5)).status, "waiting");
  });

  // Known gap C1 (not fixed by F5): Call's patient CAS checks status/service/counter_id but not
  // visit_state_revision, so a Cancel + Requeue committed inside Call's two-step window is an ABA
  // the CAS cannot see. Pinned so it fails loudly once C1 is fixed; the same ABA exists with Undo.
  test("known C1 gap: Cancel + Requeue inside Call's two-step window leaves a serving visit without its counter", async () => {
    const { A, B } = sessions;
    const waiting = await patient(8);
    assert.equal(waiting.status, "waiting");
    assert.equal((await B.client.query(`UPDATE public.counters SET current_patient_id = 8
      WHERE id_num = 'Doctor 3' AND is_online AND current_patient_id IS NULL`)).rowCount, 1, "Call: claim");
    await A.client.query("BEGIN");
    await A.client.query("SELECT id FROM public.counters ORDER BY id FOR UPDATE");
    assert.equal((await A.client.query(`UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp()
      WHERE id = 8 AND status = 'waiting' AND visit_state_revision = $1`, [waiting.visit_state_revision])).rowCount, 1);
    await A.client.query("UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = 8");
    await A.client.query("COMMIT");
    const requeued = await requeue(A, await patient(8));
    assert.equal(requeued.status, "waiting");
    assert.notEqual(requeued.visit_state_revision, waiting.visit_state_revision);
    assert.equal((await pointers())["Doctor 3"], null, "Requeue released only this visit's pointer");
    const serveSql = `UPDATE public.patients SET status = 'serving', counter_id = 'Doctor 3', called_at = clock_timestamp()
      WHERE id = 8 AND status = 'waiting' AND service_type = 'family_planning' AND completed_at IS NULL AND counter_id IS NULL`;
    // A revision-guarded CAS (the C1 fix direction) refuses the delayed serve.
    assert.equal((await B.client.query(`${serveSql} AND visit_state_revision = $1`, [waiting.visit_state_revision])).rowCount, 0);
    assert.equal((await B.client.query(serveSql)).rowCount, 1, "C1 reproduced: the current Call CAS matches after the ABA");
    const after = await patient(8);
    assert.deepEqual([after.status, after.counter_id, (await pointers())["Doctor 3"]], ["serving", "Doctor 3", null],
      "serving visit without its counter pointer");
  });

  test("a serving visit is refused immediately even while its Complete is in flight, and keeps its start", async () => {
    const { A, B } = sessions;
    const inConsultation = await patient(2);
    await B.client.query("BEGIN");
    await complete(B, 2, 1, inConsultation.consultation_started_at);
    const direct = await settle(requeue(A, inConsultation));
    assert.equal(direct.ok, false);
    assert.match(direct.message, /Only cancelled or no-show/);
    const forged = settle(requeue(A, inConsultation, "cancelled"));
    await waitBlocked(A, B);
    await B.client.query("COMMIT");
    const result = await forged;
    assert.equal(result.code, "40001");
    const completed = await patient(2);
    assert.equal(completed.status, "completed");
    assert.equal(completed.consultation_started_at, inConsultation.consultation_started_at);
  });

  test("randomized Requeue / Undo / Cancel / Call / Start / Complete interleavings never deadlock or leave a pointer to a non-serving visit", { timeout: 120000 }, async () => {
    const workers = [sessions.A, sessions.B, sessions.C];
    const seed = Number(process.env.F5_PG_SOAK_SEED || 20261022);
    let state = seed;
    const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const tally = {};
    const doctorFor = { consultation: 1, prenatal: 2, family_planning: 3 };
    // Atomic Cancel stand-in: counters then patient in one transaction (the R2.2 lock order).
    async function cancelAtomic(s, snap) {
      await s.client.query("BEGIN");
      try {
        await s.client.query("SELECT id FROM public.counters ORDER BY id FOR UPDATE");
        const updated = (await s.client.query(`UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp()
          WHERE id = $1 AND status = $2 AND visit_state_revision = $3`, [snap.id, snap.status, snap.visit_state_revision])).rowCount;
        if (updated) await s.client.query("UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = $1", [snap.id]);
        await s.client.query("COMMIT");
        return updated;
      } catch (error) { await s.client.query("ROLLBACK"); throw error; }
    }
    async function callTwoStep(s, snap) {
      const number = doctorFor[snap.service_type];
      const claimed = (await s.client.query(`UPDATE public.counters SET current_patient_id = $1
        WHERE id_num = $2 AND is_online AND current_patient_id IS NULL`, [snap.id, `Doctor ${number}`])).rowCount;
      if (!claimed) return 0;
      const served = (await s.client.query(`UPDATE public.patients SET status = 'serving', counter_id = $2, called_at = clock_timestamp()
        WHERE id = $1 AND status = 'waiting' AND completed_at IS NULL AND counter_id IS NULL`, [snap.id, `Doctor ${number}`])).rowCount;
      if (!served) await s.client.query("UPDATE public.counters SET current_patient_id = NULL WHERE id_num = $2 AND current_patient_id = $1", [snap.id, `Doctor ${number}`]);
      return served;
    }
    async function operation(s) {
      const snap = await patient(pick([1, 2, 3, 5, 6, 8]));
      const number = doctorFor[snap.service_type];
      let op;
      if (snap.status === "waiting") op = pick(["call", "cancel", "requeue"]);
      else if (snap.status === "serving") op = snap.consultation_started_at ? pick(["complete", "cancel", "requeue"]) : pick(["start", "cancel", "requeue"]);
      else op = pick(["requeue", "undo", "requeue"]);
      let outcome;
      if (op === "requeue") outcome = await settle(requeue(s, snap));
      else if (op === "undo") outcome = await settle(undo(s, snap));
      else if (op === "cancel") outcome = await settle(cancelAtomic(s, snap));
      else if (op === "call") outcome = await settle(callTwoStep(s, snap));
      else if (op === "start") outcome = await settle(one(s.client, `SELECT row_to_json(p) AS value FROM public.start_patient_consultation($1, $2, $3, clock_timestamp()) p`,
        [snap.id, `Doctor ${number}`, `admin${number}`]));
      else outcome = await settle(complete(s, snap.id, number, snap.consultation_started_at));
      const key = `${op}:${snap.status}:${outcome.ok ? "ok" : outcome.code}`;
      tally[key] = (tally[key] || 0) + 1;
      assert.notEqual(outcome.code, "40P01", `deadlock in ${op}`);
      if (op === "requeue" && ["waiting", "serving"].includes(snap.status)) assert.equal(outcome.ok, false, "an active visit is never re-queued");
    }
    const OPS = Number(process.env.F5_PG_SOAK_OPS || 600);
    let done = 0;
    await Promise.all(workers.map(async (worker) => {
      while (done < OPS) { done += 1; await operation(worker); }
    }));
    const { rows } = await observer.client.query(`SELECT c.id_num, c.current_patient_id, p.status, p.counter_id
      FROM public.counters c LEFT JOIN public.patients p ON p.id = c.current_patient_id WHERE c.current_patient_id IS NOT NULL`);
    for (const row of rows) {
      assert.equal(row.status, "serving", `counter ${row.id_num} points at a ${row.status} visit`);
      assert.equal(row.counter_id, row.id_num);
    }
    const servingStarted = (await observer.client.query(`SELECT count(*)::int AS n FROM public.patients
      WHERE status <> 'serving' AND consultation_started_at IS NOT NULL AND status <> 'completed' AND status <> 'cancelled'`)).rows[0].n;
    assert.equal(servingStarted, 0, "no waiting or no-show visit keeps a consultation start");
    assert.ok(tally["requeue:serving:P0001"] || tally["requeue:waiting:P0001"], `active-visit Requeue was exercised: ${JSON.stringify(tally)}`);
  });
});
