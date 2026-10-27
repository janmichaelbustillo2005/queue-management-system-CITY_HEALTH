// H1 Stage 1: Historical Backlog cancellation on REAL PostgreSQL 17 with independent connections
// (separate backend instances, each with its own pool). Uses the C1/F5/W1 disposable loopback
// cluster fixture: skips unless PHASE25_PG_URL and PHASE25_PG_MODULE are set, and refuses any
// target that is not the loopback test cluster. Synthetic rows only; never Supabase.
// Two kinds of interleaving are forced:
//   * contention: a blocker holds every counter row lock (as an in-flight W1/C1/F5 transaction
//     would) so competing requests queue inside PostgreSQL, then it is released;
//   * pause: one backend is held just before its W1 RPC (after its own validation read) while
//     another request commits, proving W1's in-transaction revision check closes the gap.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const {
  unavailable, startCluster, stopCluster, SEQUENCE, createDatabase, assertConsistent, patient, pointers, snapshot,
  resetQueue, holdCounters, waitForLockWaiters, backend, signInAll, post, one, register
} = require("./helpers/c1f5w1Fixture");

const REASON = "Development test concluded — visit not served.";
const PRESERVED = ["id", "id_num", "queue_number", "service_type", "created_at", "called_at", "consultation_started_at",
  "counter_id", "priority_score", "vulnerability_flags", "mobile_number"];

describe("H1 backlog cancel on real PostgreSQL 17 (independent connections)", { skip: unavailable }, () => {
  let db;
  before(async () => {
    await startCluster();
    db = await createDatabase("h1_backlog", SEQUENCE.map((step) => step.migration));
  });
  after(async () => { await stopCluster(); });
  beforeEach(async () => { await resetQueue(db); });

  // An earlier-day waiting visit; `extra` adds history such as an old call (#89-style).
  async function historicalVisit(ticket, { service = "consultation", calledBy = null, flags = [], priority = 1 } = {}) {
    return Number(await one(db, `INSERT INTO public.patients (id_num, queue_number, service_type, created_at, called_at, counter_id,
        priority_score, vulnerability_flags, mobile_number)
      VALUES ($1, $2, $3, now() - interval '3 days', CASE WHEN $4::text IS NULL THEN NULL ELSE now() - interval '3 days' + interval '5 minutes' END,
        $4, $5, $6::jsonb, '09170000000') RETURNING id AS value`,
      [`Synthetic ${ticket}`, ticket, service, calledBy, priority, JSON.stringify(flags)]));
  }
  const reviewed = async (h, token, id) => {
    const response = await h.request("GET", "/queue/backlog/:id", { token, params: { id: String(id) } });
    assert.equal(response.status, 200, response.body?.message);
    return response.body.visit;
  };
  const cancel = (h, token, visit, { reason = REASON, acknowledge = false } = {}) => h.request("POST", "/queue/backlog/:id/cancel",
    { token, params: { id: String(visit.id) }, body: { reason, expected_revision: visit.visit_state_revision, acknowledge_review: acknowledge } });
  const describeResult = (result) => (result.status ? [result.status, result.body?.message] : String(result));

  // Starts every request while all counters are locked, waits until each one is queued inside
  // PostgreSQL, then releases. The blocker is always released, even when contention is not reached.
  async function contend(starters, expectedWaiters = starters.length) {
    const blocker = await holdCounters(db);
    const racing = starters.map((start) => start());
    try {
      await waitForLockWaiters(db, expectedWaiters);
    } catch (error) {
      await blocker.release();
      const settled = await Promise.allSettled(racing);
      throw new Error(`${error.message}; answers: ${JSON.stringify(settled.map((s) => describeResult(s.value ?? s.reason)))}`);
    }
    await blocker.release();
    return Promise.all(racing);
  }
  // A backend that stops just before the named RPC until `release()` is called.
  async function pausedBefore(rpcName) {
    let arrived, release;
    const reached = new Promise((resolve) => { arrived = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const h = await backend(db, { pause: async (request) => {
      if (request.kind === "rpc" && request.name === rpcName) { arrived(); await gate; }
    } });
    return { h, reached, release };
  }
  async function deadlocks() {
    return Number(await one(db, "SELECT deadlocks AS value FROM pg_stat_database WHERE datname = current_database()"));
  }

  test("a historical waiting visit is cancelled through W1 with its record preserved", async () => {
    const id = await historicalVisit("HB-PLAIN", { priority: 3, flags: ["senior"] });
    const h = await backend(db);
    const tokens = await signInAll(h);
    const before = await patient(db, id);
    const counters = await pointers(db);
    const visit = await reviewed(h, tokens.superadmin, id);
    assert.equal(visit.requires_review, false);
    const response = await cancel(h, tokens.superadmin, visit);
    assert.equal(response.status, 200, response.body?.message);
    assert.ok(h.rpcs().includes("cancel_patient_visit"));
    assert.equal(h.tableWrites("patients").length, 0, "no direct patient UPDATE from the backend");
    const after = await patient(db, id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.reason, REASON);
    assert.ok(Date.parse(after.completed_at) > Date.parse(after.created_at));
    assert.notEqual(after.visit_state_revision, before.visit_state_revision);
    for (const key of PRESERVED) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(await pointers(db), counters);
    await assertConsistent(db);
  });

  test("a #89-style visit (old call, stored assignment, no pointer) needs acknowledgement and keeps its history", async () => {
    const id = await historicalVisit("OB-089", { service: "prenatal", calledBy: "Doctor 2" });
    const h = await backend(db);
    const tokens = await signInAll(h);
    const visit = await reviewed(h, tokens.superadmin, id);
    assert.deepEqual(visit.flags.map((flag) => flag.code), ["previously_called", "stored_assignment"]);
    assert.equal(visit.cancel_blocked, null);
    const before = await snapshot(db);
    const refused = await cancel(h, tokens.superadmin, visit);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /requires review/);
    assert.deepEqual(await snapshot(db), before);
    const response = await cancel(h, tokens.superadmin, visit, { acknowledge: true });
    assert.equal(response.status, 200, response.body?.message);
    const after = await patient(db, id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.counter_id, "Doctor 2");
    assert.equal(after.called_at, before.patients.find((row) => row.id === id).called_at);
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    await assertConsistent(db);
  });

  test("two Superadmin sessions on separate backends: exactly one cancel commits", async () => {
    const id = await historicalVisit("HB-RACE");
    const first = await backend(db), second = await backend(db);
    const [a, b] = [await signInAll(first), await signInAll(second)];
    const visit = await reviewed(first, a.superadmin, id);
    const deadlocksBefore = await deadlocks();
    const results = await contend([
      () => cancel(first, a.superadmin, visit, { reason: "First session" }),
      () => cancel(second, b.superadmin, visit, { reason: "Second session" })
    ]);
    const committed = results.filter((result) => result.status === 200 && !result.body.already_cancelled);
    assert.equal(committed.length, 1, JSON.stringify(results.map(describeResult)));
    const loser = results.find((result) => result !== committed[0]);
    assert.equal(loser.status, 409, "the waiting loser re-checks the revision under W1's locks");
    assert.match(loser.body.message, /Patient visit changed/);
    const row = await patient(db, id);
    assert.equal(row.status, "cancelled");
    assert.equal(row.reason, committed[0] === results[0] ? "First session" : "Second session");
    assert.equal(await deadlocks(), deadlocksBefore);
    await assertConsistent(db);
  });

  test("a duplicate cancel after commit is reported as already cancelled and writes nothing", async () => {
    const id = await historicalVisit("HB-DUP");
    const h = await backend(db);
    const tokens = await signInAll(h);
    const visit = await reviewed(h, tokens.superadmin, id);
    assert.equal((await cancel(h, tokens.superadmin, visit)).status, 200);
    const once = await snapshot(db);
    const rpcs = h.rpcs().length;
    const repeat = await cancel(h, tokens.superadmin, visit, { reason: "Another reason" });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.already_cancelled, true);
    assert.deepEqual(h.rpcs().slice(rpcs), ["validate_staff_auth_session"], "no cancel RPC for a repeat");
    assert.deepEqual(await snapshot(db), once);
  });

  test("a stale reviewed revision is refused before W1, and inside W1 when it changes after the backend's check", async () => {
    const id = await historicalVisit("HB-STALE");
    const h = await backend(db);
    const tokens = await signInAll(h);
    const visit = await reviewed(h, tokens.superadmin, id);
    await db.observer.query("UPDATE public.patients SET visit_state_revision = gen_random_uuid() WHERE id = $1", [id]);
    let before = await snapshot(db);
    let response = await cancel(h, tokens.superadmin, visit);
    assert.equal(response.status, 409);
    assert.match(response.body.message, /changed after it was reviewed/);
    assert.deepEqual(await snapshot(db), before);

    const fresh = await reviewed(h, tokens.superadmin, id);
    const paused = await pausedBefore("cancel_patient_visit");
    const ptokens = await signInAll(paused.h);
    const pending = cancel(paused.h, ptokens.superadmin, fresh);
    await paused.reached;
    await db.observer.query("UPDATE public.patients SET visit_state_revision = gen_random_uuid() WHERE id = $1", [id]);
    before = await snapshot(db);
    paused.release();
    response = await pending;
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Patient visit changed/);
    assert.deepEqual(await snapshot(db), before);
  });

  test("a session revoked before the RPC is refused inside W1 with nothing changed", async () => {
    const id = await historicalVisit("HB-REVOKE");
    const paused = await pausedBefore("cancel_patient_visit");
    const tokens = await signInAll(paused.h);
    const visit = await reviewed(paused.h, tokens.superadmin, id);
    const pending = cancel(paused.h, tokens.superadmin, visit);
    await paused.reached;
    await db.observer.query("UPDATE public.staff_auth_sessions SET revoked_at = now() WHERE user_id_num = 'superadmin' AND revoked_at IS NULL");
    const before = await snapshot(db);
    paused.release();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.match(response.body.message, /expired or was revoked/);
    assert.deepEqual((await snapshot(db)).patients, before.patients);
    assert.deepEqual((await snapshot(db)).counters, before.counters);
  });

  test("a revocation issued while a cancel holds its session lock waits for that cancel; later requests are refused", async () => {
    const id = await historicalVisit("HB-REVOKE-LATE");
    const h = await backend(db);
    const tokens = await signInAll(h);
    const visit = await reviewed(h, tokens.superadmin, id);
    const blocker = await holdCounters(db);
    const cancelling = cancel(h, tokens.superadmin, visit);
    await waitForLockWaiters(db, 1);
    // W1 holds the session row FOR SHARE while it waits for the counters; the revocation queues.
    const revoker = await db.connect("h1-revoker");
    const revoking = revoker.query("UPDATE public.staff_auth_sessions SET revoked_at = now() WHERE user_id_num = 'superadmin' AND revoked_at IS NULL");
    await waitForLockWaiters(db, 2);
    await blocker.release();
    const response = await cancelling;
    await revoking;
    await revoker.end();
    assert.equal(response.status, 200, "authorized at its start and held stable until commit");
    assert.equal((await patient(db, id)).status, "cancelled");
    assert.equal((await h.request("GET", "/queue/backlog", { token: tokens.superadmin })).status, 401);
    await assertConsistent(db);
  });

  test("a historical visit cannot be Called: Call ranks only today's queue, so it never races a backlog cancel", async () => {
    const id = await historicalVisit("HB-NOCALL");
    const desk = await backend(db);
    const d = await signInAll(desk);
    const before = await snapshot(db);
    const called = await post(desk, d.frontdesk, "/queue/call", { patient_id: id });
    assert.equal(called.status, 400);
    assert.match(called.body.message, /next eligible patient/);
    assert.ok(!desk.rpcs().includes("call_patient_visit"));
    assert.deepEqual(await snapshot(db), before);
  });

  test("a backlog cancel contending with a Call of today's patient for the same doctor: both commit, no deadlock", async () => {
    const id = await historicalVisit("HB-CALL");
    const sa = await backend(db), desk = await backend(db);
    const [a, d] = [await signInAll(sa), await signInAll(desk)];
    const today = await register(desk, db, d.frontdesk, { name: "Synthetic today", service: "consultation" });
    const visit = await reviewed(sa, a.superadmin, id);
    const deadlocksBefore = await deadlocks();
    const [cancelled, called] = await contend([
      () => cancel(sa, a.superadmin, visit),
      () => post(desk, d.frontdesk, "/queue/call", { patient_id: today })
    ]);
    assert.equal(cancelled.status, 200, JSON.stringify(describeResult(cancelled)));
    assert.equal(called.status, 200, JSON.stringify(describeResult(called)));
    assert.equal((await patient(db, id)).status, "cancelled");
    assert.equal((await patient(db, today)).status, "serving");
    assert.equal((await pointers(db))["Doctor 1"], today, "W1 never releases another patient's counter");
    assert.equal(await deadlocks(), deadlocksBefore);
    await assertConsistent(db);
  });

  test("a Call of today's patient committing between the backend's check and W1 keeps its counter", async () => {
    const id = await historicalVisit("HB-CALL-GAP");
    const paused = await pausedBefore("cancel_patient_visit");
    const desk = await backend(db);
    const [a, d] = [await signInAll(paused.h), await signInAll(desk)];
    const today = await register(desk, db, d.frontdesk, { name: "Synthetic today", service: "checkup" });
    const visit = await reviewed(paused.h, a.superadmin, id);
    const pending = cancel(paused.h, a.superadmin, visit);
    await paused.reached;
    const called = await post(desk, d.frontdesk, "/queue/call", { patient_id: today });
    assert.equal(called.status, 200, called.body?.message);
    paused.release();
    const response = await pending;
    assert.equal(response.status, 200, response.body?.message);
    assert.equal((await patient(db, id)).status, "cancelled");
    assert.equal((await pointers(db))["Doctor 1"], today);
    await assertConsistent(db);
  });

  test("Cancel then Requeue (F5) during a paused backlog cancel: the requeued visit is never cancelled by the stale review", async () => {
    const id = await historicalVisit("HB-REQUEUE");
    const paused = await pausedBefore("cancel_patient_visit");
    const other = await backend(db);
    const [a, o] = [await signInAll(paused.h), await signInAll(other)];
    const visit = await reviewed(paused.h, a.superadmin, id);
    const pending = cancel(paused.h, a.superadmin, visit, { reason: "Stale review" });
    await paused.reached;
    // Another Superadmin cancels and requeues the same visit (an A-B-A of its status).
    assert.equal((await post(other, o.superadmin, "/queue/cancel", { patient_id: id, reason: "Other cancel" })).status, 200);
    const requeued = await post(other, o.superadmin, "/queue/requeue", { patient_id: id, reason: "Requeued for test" });
    assert.equal(requeued.status, 200, requeued.body?.message);
    paused.release();
    const response = await pending;
    assert.equal(response.status, 409);
    const row = await patient(db, id);
    assert.equal(row.status, "waiting", "the requeued visit stays waiting");
    assert.notEqual(row.reason, "Stale review");
    await assertConsistent(db);
  });

  test("a backlog cancel contending with Requeue of another visit: both commit, no deadlock, counters consistent", async () => {
    const id = await historicalVisit("HB-BUSY");
    const other = await historicalVisit("HB-OTHER", { service: "prenatal" });
    await db.observer.query("UPDATE public.patients SET status = 'cancelled', completed_at = now(), reason = 'x' WHERE id = $1", [other]);
    const sa = await backend(db), desk = await backend(db);
    const [a, d] = [await signInAll(sa), await signInAll(desk)];
    const visit = await reviewed(sa, a.superadmin, id);
    const deadlocksBefore = await deadlocks();
    const [cancelled, requeued] = await contend([
      () => cancel(sa, a.superadmin, visit),
      () => post(desk, d.superadmin, "/queue/requeue", { patient_id: other, reason: "Back in queue" })
    ]);
    assert.equal(cancelled.status, 200, JSON.stringify(describeResult(cancelled)));
    assert.equal(requeued.status, 200, JSON.stringify(describeResult(requeued)));
    assert.equal(await deadlocks(), deadlocksBefore);
    await assertConsistent(db);
  });

  test("a lock timeout or a dropped database connection rolls back and is never reported as success", async () => {
    const id = await historicalVisit("HB-TIMEOUT");
    const h = await backend(db);
    const tokens = await signInAll(h);
    const visit = await reviewed(h, tokens.superadmin, id);
    const before = await snapshot(db);
    // W1's lock_timeout (5 s) expires behind a stuck counter holder: 55P03, nothing committed.
    const blocker = await holdCounters(db);
    const timedOut = await cancel(h, tokens.superadmin, visit);
    await blocker.release();
    assert.equal(timedOut.status, 503);
    assert.match(timedOut.body.message, /could not be completed and nothing was changed/);
    assert.deepEqual((await snapshot(db)).patients, before.patients);

    // The backend's connection is terminated while W1 waits: the transaction rolls back.
    const second = await holdCounters(db);
    const dropping = cancel(h, tokens.superadmin, visit);
    await waitForLockWaiters(db, 1);
    await db.observer.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = 'h1_backlog-backend'`);
    const dropped = await dropping;
    await second.release();
    assert.ok([503].includes(dropped.status), JSON.stringify(describeResult(dropped)));
    assert.deepEqual((await snapshot(db)).patients, before.patients);
    assert.equal((await patient(db, id)).status, "waiting");
    await assertConsistent(db);
  });

  test("a pointed (anomalous) visit stays blocked and its counter is never released", async () => {
    const id = await historicalVisit("HB-POINTED");
    await db.observer.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = 'Doctor 1'", [id]);
    const h = await backend(db);
    const tokens = await signInAll(h);
    const visit = await reviewed(h, tokens.superadmin, id);
    assert.equal(visit.flags[0].code, "counter_conflict");
    const response = await cancel(h, tokens.superadmin, visit, { acknowledge: true });
    assert.equal(response.status, 409);
    assert.equal((await patient(db, id)).status, "waiting");
    assert.equal((await pointers(db))["Doctor 1"], id);
    assert.ok(!h.rpcs().includes("cancel_patient_visit"));
  });
});
