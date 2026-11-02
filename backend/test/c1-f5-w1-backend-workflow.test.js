// C1 + F5 + W1 through the REAL backend on disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js).
// Routes, JWT middleware, Phase A session checks, queueService and settingsService run unchanged
// against real SQL; RPC responses go through the backend's own mapping. Configurations:
//   A. C1, F5 and W1 installed (after the approved installation);
//   B. none installed (today's development database);
//   C. the partial states an installation passes through (C1; C1 + F5).
// Races use real row locks: a blocker holds every counter, competing requests (from separate
// backend instances where the in-process guards would otherwise serialize them) queue on the
// lock in a controlled order, and the blocker is released.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const jwt = require("jsonwebtoken");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, CANCEL_MIGRATION_REQUIRED, post, register, expectStatus, effects, patient, pointers, assertConsistent } = f;

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

const PRIORITY_REFUSAL = /according to queue priority/;
const STALE = /changed|no longer eligible/i;

// Called (serving, awaiting acceptance) on its doctor.
async function called(h, db, tokens, details) {
  const id = await register(h, db, tokens.frontdesk, details);
  expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
  return id;
}
// Accepted and in consultation on its doctor.
async function consulting(h, db, tokens, doctorToken, details) {
  const id = await called(h, db, tokens, details);
  expectStatus(await post(h, doctorToken, "/queue/accept", { patient_id: id }), 200);
  expectStatus(await post(h, doctorToken, "/queue/start", { patient_id: id }), 200);
  return id;
}
// Inserts a legacy pre-W1 defect directly: a cancelled visit that a counter still points at.
async function staleCancelled(db, doctor = "Doctor 3") {
  const id = Number(await f.one(db, `INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id,
      called_at, completed_at, reason, priority_score)
    VALUES ('Synthetic stale pointer', 'FP-900', 'family_planning', 'cancelled', $1, now() - interval '9 minutes',
      now() - interval '8 minutes', 'Synthetic', 1) RETURNING id AS value`, [doctor]));
  await db.observer.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = $2", [id, doctor]);
  return id;
}

describe("A. C1, F5 and W1 installed: real backend workflow", { skip: f.unavailable }, () => {
  let db; let h; let tokens;
  before(async () => {
    db = await f.createDatabase("c1f5w1_installed", [C1.migration, F5.migration, W1.migration]);
  });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await f.backend(db);
    tokens = await f.signInAll(h);
  });

  test("Registration -> Waiting -> Call -> Accept -> Start -> Complete through C1, preserving timestamps", async () => {
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic GP", mobile: "09170000001" });
    const waiting = await patient(db, id);
    assert.equal(waiting.status, "waiting");

    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    assert.ok(h.rpcs().includes("call_patient_visit"));
    assert.deepEqual(h.tableWrites("counters"), [], "the installed C1 function writes the counter, not the backend");
    const serving = await patient(db, id);
    assert.equal(serving.status, "serving");
    assert.equal(serving.counter_id, "Doctor 1");
    assert.equal((await pointers(db))["Doctor 1"], id);
    assert.deepEqual(effects(h, id), { sms: 1, awaiting: true, voice: 0 }, "acceptance, not the call, drives voice");

    const accept = await post(h, tokens.admin1, "/queue/accept", { patient_id: id });
    expectStatus(accept, 200);
    assert.deepEqual(effects(h, id), { sms: 1, awaiting: false, voice: 1 });
    expectStatus(await post(h, tokens.admin1, "/queue/start", { patient_id: id }), 200);
    const started = await patient(db, id);
    assert.equal(started.called_at, serving.called_at);
    assert.ok(Date.parse(started.consultation_started_at) >= Date.parse(started.called_at));

    expectStatus(await post(h, tokens.admin1, "/queue/complete", { patient_id: id }), 200);
    const done = await patient(db, id);
    assert.equal(done.status, "completed");
    assert.equal(done.created_at, waiting.created_at);
    assert.equal(done.called_at, serving.called_at);
    assert.equal(done.consultation_started_at, started.consultation_started_at);
    assert.ok(Date.parse(done.completed_at) > Date.parse(done.consultation_started_at));
    assert.equal((await pointers(db))["Doctor 1"], null);
    await assertConsistent(db);
  });

  test("Weighted-Priority order and service mapping hold for Call", async () => {
    const regular = await register(h, db, tokens.frontdesk, { name: "Synthetic regular" });
    const senior = await register(h, db, tokens.frontdesk, { name: "Synthetic senior", flags: ["senior"] });
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: regular }), 400, PRIORITY_REFUSAL);
    assert.equal((await patient(db, regular)).status, "waiting");
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: senior }), 200);

    const prenatal = await register(h, db, tokens.frontdesk, { name: "Synthetic prenatal", service: "prenatal" });
    const fp = await register(h, db, tokens.frontdesk, { name: "Synthetic FP", service: "family_planning" });
    // Existing contract: a doctor naming another doctor's patient is refused before the RPC (400).
    expectStatus(await post(h, tokens.admin1, "/queue/call", { patient_id: prenatal }), 400, /assigned to Doctor 2/);
    expectStatus(await post(h, tokens.admin2, "/queue/call", { patient_id: prenatal }), 200);
    expectStatus(await post(h, tokens.superadmin, "/queue/call", { patient_id: fp }), 200);
    assert.deepEqual(await pointers(db), { "Doctor 1": senior, "Doctor 2": prenatal, "Doctor 3": fp });
    assert.equal((await patient(db, prenatal)).counter_id, "Doctor 2");
    assert.equal((await patient(db, fp)).counter_id, "Doctor 3");
    // A doctor busy with a patient cannot call the next one.
    const next = await register(h, db, tokens.frontdesk, { name: "Synthetic next GP" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: next }), 400, /already serving/);
    await assertConsistent(db);
  });

  test("Cancel while waiting, while called and in consultation (W1) keeps history and releases only its counter", async () => {
    const waiting = await register(h, db, tokens.frontdesk, { name: "Synthetic waiting", service: "prenatal" });
    const calledId = await called(h, db, tokens, { name: "Synthetic called", mobile: "09170000002" });
    const inConsult = await consulting(h, db, tokens, tokens.admin3, { name: "Synthetic FP consult", service: "family_planning" });
    const before = { called: await patient(db, calledId), consult: await patient(db, inConsult) };

    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: waiting, reason: "Left" }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: calledId, reason: " Left after call " }), 200);
    expectStatus(await post(h, tokens.admin3, "/queue/cancel", { patient_id: inConsult, reason: "Referred" }), 200);
    assert.deepEqual(h.rpcs().filter((name) => name === "cancel_patient_visit").length, 3);
    assert.deepEqual(h.tableWrites("counters"), []);

    const after = { waiting: await patient(db, waiting), called: await patient(db, calledId), consult: await patient(db, inConsult) };
    assert.equal(after.waiting.status, "cancelled");
    assert.equal(after.called.reason, "Left after call");
    assert.equal(after.called.called_at, before.called.called_at);
    assert.equal(after.consult.consultation_started_at, before.consult.consultation_started_at);
    assert.equal(after.consult.counter_id, "Doctor 3");
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    assert.deepEqual(effects(h, calledId), { sms: 1, awaiting: false, voice: 0 }, "cancel adds no SMS or voice event");
    // A repeat Cancel (stale tab) is idempotent and writes nothing.
    const repeat = await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: calledId, reason: "Again" });
    expectStatus(repeat, 200);
    assert.equal(repeat.body.already_cancelled, true);
    assert.deepEqual(await patient(db, calledId), after.called);
    // Completed history cannot be cancelled.
    const done = await consulting(h, db, tokens, tokens.admin1, { name: "Synthetic done" });
    expectStatus(await post(h, tokens.admin1, "/queue/complete", { patient_id: done }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: done, reason: "x" }), 400, /completed consultation/);
    await assertConsistent(db);
  });

  test("Requeue after an authorized Cancel (F5) returns the visit to the back of its tier; it can be called again", async () => {
    const id = await called(h, db, tokens, { name: "Synthetic GP" });
    const behind = await register(h, db, tokens.frontdesk, { name: "Synthetic GP behind" });
    expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: id, reason: "Stepped out" }), 200);
    const cancelled = await patient(db, id);
    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id, reason: "Returned" }), 200);
    assert.ok(h.rpcs().includes("requeue_patient_visit"));
    assert.ok(!h.rpcs().includes("recover_patient_visit"));
    const requeued = await patient(db, id);
    assert.equal(requeued.status, "waiting");
    assert.equal(requeued.counter_id, null);
    assert.equal(requeued.called_at, null);
    assert.ok(Date.parse(requeued.created_at) > Date.parse(cancelled.created_at));
    assert.deepEqual(effects(h, id), { sms: 0, awaiting: false, voice: 0 });
    // Same tier, later registration: the patient registered meanwhile is called first.
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 400, PRIORITY_REFUSAL);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: behind }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: behind, reason: "x" }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    await assertConsistent(db);
    // Active visits are never re-queued.
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id }), 409, /being served/);
  });

  test("Requeue releases a legacy stale counter pointer together with the recovery (F5)", async () => {
    const id = await staleCancelled(db);
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id }), 200);
    assert.equal((await pointers(db))["Doctor 3"], null);
    assert.equal((await patient(db, id)).status, "waiting");
    await assertConsistent(db);
  });

  test("Duplicate requests across two backend instances: one transition, one set of side effects", async () => {
    const other = await f.backend(db);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic dup", mobile: "09170000003" });
    const calls = await Promise.all([post(h, tokens.frontdesk, "/queue/call", { patient_id: id }),
      post(other, tokens.frontdesk, "/queue/call", { patient_id: id })]);
    assert.equal(calls.filter((r) => r.status === 200).length, 1, JSON.stringify(calls.map((r) => [r.status, r.body.message])));
    assert.ok([400, 409].includes(calls.find((r) => r.status !== 200).status));
    assert.equal(effects(h, id).sms + effects(other, id).sms, 1, "exactly one call SMS");

    const cancels = await Promise.all([post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "a" }),
      post(other, tokens.admin1, "/queue/cancel", { patient_id: id, reason: "b" })]);
    const fresh = cancels.filter((r) => r.status === 200 && !r.body.already_cancelled);
    assert.equal(fresh.length, 1, JSON.stringify(cancels.map((r) => [r.status, r.body.message])));
    for (const r of cancels.filter((x) => !fresh.includes(x))) assert.ok(r.status === 409 || r.body.already_cancelled, r.body.message);

    const requeues = await Promise.all([post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id }),
      post(other, tokens.superadmin, "/queue/requeue", { patient_id: id })]);
    assert.equal(requeues.filter((r) => r.status === 200).length, 1, JSON.stringify(requeues.map((r) => [r.status, r.body.message])));
    assert.ok(requeues.some((r) => r.status === 409));
    await assertConsistent(db);
  });

  test("Invalid, revoked and changed sessions are refused, including inside the W1/C1 transaction", async () => {
    const id = await called(h, db, tokens, { name: "Synthetic session" });
    const before = await patient(db, id);
    // Forged signature (middleware 403), logged-out session (401).
    const forged = jwt.sign(jwt.decode(tokens.superadmin), "not-the-server-secret", { algorithm: "HS256" });
    expectStatus(await post(h, forged, "/queue/cancel", { patient_id: id, reason: "x" }), 403);
    const spare = await h.login("frontdesk", "synthetic-frontdesk-password");
    expectStatus(await post(h, spare.token, "/auth/logout", {}), 200);
    expectStatus(await post(h, spare.token, "/queue/cancel", { patient_id: id, reason: "x" }), 401);

    // Revoked AFTER the middleware validated it, before the W1 function runs: 28000 -> 401.
    let revokeOnce = true;
    const racing = await f.backend(db, {
      pause: async (request) => {
        if (request.kind === "rpc" && request.name === "cancel_patient_visit" && revokeOnce) {
          revokeOnce = false;
          await db.observer.query("UPDATE public.staff_auth_sessions SET revoked_at = now() WHERE user_id_num = 'admin1'");
        }
      }
    });
    const admin1 = await racing.login("admin1", "synthetic-admin1-password");
    expectStatus(await post(racing, admin1.token, "/queue/cancel", { patient_id: id, reason: "x" }), 401, /sign in again/i);
    assert.deepEqual(await patient(db, id), before);
    assert.equal((await pointers(db))["Doctor 1"], id);

    // Doctor reassigned AFTER the middleware check, before the C1 function runs: 42501 -> 403.
    const waitingGp = await register(h, db, tokens.frontdesk, { name: "Synthetic reassigned", service: "prenatal" });
    let reassignOnce = true;
    const reassigning = await f.backend(db, {
      pause: async (request) => {
        if (request.kind === "rpc" && request.name === "call_patient_visit" && reassignOnce) {
          reassignOnce = false;
          // Direct catalog write: the account-change trigger revokes admin2's sessions as well.
          await db.observer.query("UPDATE public.users SET doctor_name = 'Doctor 3' WHERE id_num = 'admin2'");
        }
      }
    });
    const admin2 = await reassigning.login("admin2", "synthetic-admin2-password");
    expectStatus(await post(reassigning, admin2.token, "/queue/call", { patient_id: waitingGp }), 403, /assigned to your doctor/);
    assert.equal((await patient(db, waitingGp)).status, "waiting");
    assert.equal((await pointers(db))["Doctor 2"], null);
    assert.deepEqual(effects(reassigning, waitingGp), { sms: 0, awaiting: false, voice: 0 });
    await db.observer.query("UPDATE public.users SET doctor_name = 'Doctor 2' WHERE id_num = 'admin2'");
    await assertConsistent(db);
  });

  test("Cross-doctor authorization for Call, Cancel, Requeue and consultation actions", async () => {
    const gp = await called(h, db, tokens, { name: "Synthetic GP" });
    expectStatus(await post(h, tokens.admin2, "/queue/cancel", { patient_id: gp, reason: "x" }), 403);
    expectStatus(await post(h, tokens.admin3, "/queue/accept", { patient_id: gp }), 403);
    const fp = await register(h, db, tokens.frontdesk, { name: "Synthetic FP", service: "family_planning" });
    expectStatus(await post(h, tokens.admin1, "/queue/call", { patient_id: fp }), 400, /assigned to Doctor 3/);
    expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: gp, reason: "own" }), 200);
    expectStatus(await post(h, tokens.admin2, "/queue/requeue", { patient_id: gp }), 403);
    expectStatus(await post(h, tokens.admin1, "/queue/requeue", { patient_id: gp }), 200);
    assert.equal((await patient(db, fp)).status, "waiting");
    await assertConsistent(db);
  });

  test("Counter availability: an offline doctor cannot be called or receive registrations", async () => {
    const fp = await register(h, db, tokens.frontdesk, { name: "Synthetic FP", service: "family_planning" });
    expectStatus(await post(h, tokens.superadmin, "/counters/availability", { doctors: { "Doctor 3": false } }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: fp }), 400, /offline/);
    expectStatus(await post(h, tokens.frontdesk, "/queue", { fullName: "Synthetic late", service_type: "family_planning" }), 400, /offline|unavailable/i);
    assert.equal((await patient(db, fp)).status, "waiting");
    assert.deepEqual(effects(h, fp), { sms: 0, awaiting: false, voice: 0 });
    expectStatus(await post(h, tokens.superadmin, "/counters/availability", { doctors: { "Doctor 3": true } }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: fp }), 200);
  });

  // ---- Races on real locks -------------------------------------------------------------
  // `first` reaches the counter lock before `second`; returns both responses.
  async function race(first, second) {
    const blocker = await f.holdCounters(db);
    let a; let b;
    try {
      a = first();
      await f.waitForLockWaiters(db, 1);
      b = second();
      await f.waitForLockWaiters(db, 2);
    } finally {
      await blocker.release();
    }
    return Promise.all([a, b]);
  }

  for (const order of ["Call first", "Cancel first"]) {
    test(`Simultaneous Call and Cancel of a waiting visit (${order}): one wins, the other changes nothing`, async () => {
      const caller = await f.backend(db);
      const canceller = await f.backend(db);
      const id = await register(h, db, tokens.frontdesk, { name: "Synthetic race", mobile: "09170000004" });
      const call = () => post(caller, tokens.frontdesk, "/queue/call", { patient_id: id });
      const cancel = () => post(canceller, tokens.admin1, "/queue/cancel", { patient_id: id, reason: "Race" });
      const [callResult, cancelResult] = order === "Call first"
        ? await race(call, cancel)
        : (await race(cancel, call)).reverse();
      const row = await patient(db, id);
      if (order === "Call first") {
        expectStatus(callResult, 200);
        expectStatus(cancelResult, 409, STALE);
        assert.equal(row.status, "serving");
        assert.equal((await pointers(db))["Doctor 1"], id);
        assert.deepEqual(effects(caller, id), { sms: 1, awaiting: true, voice: 0 });
      } else {
        expectStatus(cancelResult, 200);
        expectStatus(callResult, 409, STALE);
        assert.equal(row.status, "cancelled");
        assert.equal((await pointers(db))["Doctor 1"], null);
        assert.deepEqual(effects(caller, id), { sms: 0, awaiting: false, voice: 0 }, "a refused Call sends no SMS or acceptance");
      }
      await assertConsistent(db);
    });
  }

  for (const order of ["repeat Cancel first", "Requeue first"]) {
    test(`Simultaneous Cancel and Requeue of a cancelled visit with a stale pointer (${order})`, async () => {
      const canceller = await f.backend(db);
      const requeuer = await f.backend(db);
      const id = await staleCancelled(db);
      const cancel = () => post(canceller, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "Again" });
      const requeue = () => post(requeuer, tokens.superadmin, "/queue/requeue", { patient_id: id });
      const [cancelResult, requeueResult] = order === "repeat Cancel first"
        ? await race(cancel, requeue)
        : (await race(requeue, cancel)).reverse();
      if (order === "repeat Cancel first") {
        // The repeat releases the pointer without writing the visit; Requeue's snapshot still holds.
        expectStatus(cancelResult, 200);
        assert.equal(cancelResult.body.already_cancelled, true);
        expectStatus(requeueResult, 200);
      } else {
        expectStatus(requeueResult, 200);
        expectStatus(cancelResult, 409, STALE);
      }
      assert.equal((await patient(db, id)).status, "waiting");
      assert.equal((await pointers(db))["Doctor 3"], null);
      await assertConsistent(db);
    });
  }

  test("Cancel of a serving visit racing a Requeue: Requeue is refused, Cancel releases the counter", async () => {
    const id = await called(h, db, tokens, { name: "Synthetic serving race" });
    const blocker = await f.holdCounters(db);
    let cancel; let requeueResult;
    try {
      cancel = post(h, tokens.admin1, "/queue/cancel", { patient_id: id, reason: "Race" });
      await f.waitForLockWaiters(db, 1);
      // Sees the visit still serving (the Cancel is uncommitted) and refuses before taking any lock.
      requeueResult = await post(await f.backend(db), tokens.frontdesk, "/queue/requeue", { patient_id: id });
    } finally {
      await blocker.release();
    }
    const cancelResult = await cancel;
    expectStatus(cancelResult, 200);
    expectStatus(requeueResult, 409, /being served/);
    assert.equal((await patient(db, id)).status, "cancelled");
    assert.equal((await pointers(db))["Doctor 1"], null);
    await assertConsistent(db);
  });

  for (const order of ["Call first", "Requeue first"]) {
    test(`Requeue of a senior visit racing a Call of the regular head (${order}): priority decided under the lock`, async () => {
      const seniorId = await called(h, db, tokens, { name: "Synthetic senior", flags: ["senior"] });
      expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: seniorId, reason: "Stepped out" }), 200);
      const regular = await register(h, db, tokens.frontdesk, { name: "Synthetic regular head" });
      const caller = await f.backend(db);
      const requeuer = await f.backend(db);
      const call = () => post(caller, tokens.frontdesk, "/queue/call", { patient_id: regular });
      const requeue = () => post(requeuer, tokens.superadmin, "/queue/requeue", { patient_id: seniorId });
      const [callResult, requeueResult] = order === "Call first"
        ? await race(call, requeue)
        : (await race(requeue, call)).reverse();
      expectStatus(requeueResult, 200);
      if (order === "Call first") {
        expectStatus(callResult, 200);
        assert.equal((await patient(db, regular)).status, "serving");
      } else {
        // C1 re-ranks under its locks: the re-queued senior now outranks the regular patient.
        expectStatus(callResult, 400, PRIORITY_REFUSAL);
        assert.equal((await patient(db, regular)).status, "waiting");
        assert.deepEqual(effects(caller, regular), { sms: 0, awaiting: false, voice: 0 });
      }
      assert.equal((await patient(db, seniorId)).status, "waiting");
      await assertConsistent(db);
    });
  }

  test("F5's counters-then-account lock order does not deadlock with W1 and a concurrent account update", async () => {
    // F5 locks counters, then (inside recover_patient_visit) the account FOR SHARE; W1 locks the
    // account FOR SHARE, then counters. A writer queued on the same account row must not close a cycle.
    const stale = await staleCancelled(db);
    const servingId = await called(h, db, tokens, { name: "Synthetic W1 subject" });
    const writer = await db.connect("c1f5w1-account-writer");
    const blocker = await f.holdCounters(db);
    let requeue; let cancel; let update;
    try {
      requeue = post(await f.backend(db), tokens.frontdesk, "/queue/requeue", { patient_id: stale });
      await f.waitForLockWaiters(db, 1);
      cancel = post(await f.backend(db), tokens.frontdesk, "/queue/cancel", { patient_id: servingId, reason: "Race" });
      await f.waitForLockWaiters(db, 2);
      update = writer.query("UPDATE public.users SET password = password WHERE id_num = 'frontdesk'");
      await f.waitForLockWaiters(db, 3);
    } finally {
      await blocker.release();
    }
    const [requeueResult, cancelResult] = await Promise.all([requeue, cancel]);
    await update;
    await writer.end();
    expectStatus(requeueResult, 200);
    expectStatus(cancelResult, 200);
    assert.equal((await patient(db, stale)).status, "waiting");
    assert.equal((await patient(db, servingId)).status, "cancelled");
    await assertConsistent(db);
  });
});

describe("B. none installed (a database that never had C1/F5/W1): fallbacks fail closed", { skip: f.unavailable }, () => {
  let db; let h; let tokens;
  // I2 Finding 8: the two-step Call needs the explicit ALLOW_LEGACY_TWO_STEP_CALL opt-in.
  const LEGACY = { envOverrides: { allowLegacyTwoStepCall: true } };
  before(async () => { db = await f.createDatabase("c1f5w1_absent"); });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await f.backend(db, LEGACY);
    tokens = await f.signInAll(h);
  });

  test("Call without the opt-in refuses (503) with the C1 message and changes nothing", async () => {
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic GP", mobile: "09170000004" });
    const strict = await f.backend(db);
    const before = await f.snapshot(db);
    expectStatus(await post(strict, tokens.frontdesk, "/queue/call", { patient_id: id }), 503, /atomic C1 database function/);
    assert.ok(strict.rpcs().includes("call_patient_visit"), "C1 was tried");
    assert.equal(strict.tableWrites("counters").length + strict.tableWrites("patients").length, 0, "no two-step write");
    assert.deepEqual(await f.snapshot(db), before);
    assert.deepEqual(effects(strict, id), { sms: 0, awaiting: false, voice: 0 });
    await assertConsistent(db);
  });

  test("Call with the opt-in falls back to the revision-guarded two-step and works", async () => {
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic GP", mobile: "09170000005" });
    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    assert.ok(h.rpcs().includes("call_patient_visit"), "the backend tries C1 first");
    assert.equal(h.tableWrites("counters").length, 1, "then claims the counter itself");
    assert.equal((await pointers(db))["Doctor 1"], id);
    assert.deepEqual(effects(h, id), { sms: 1, awaiting: true, voice: 0 });
    await assertConsistent(db);
  });

  test("Call fallback rejects a visit whose revision changed between its two statements; the claim is released", async () => {
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic GP", mobile: "09170000006" });
    let interleaved = false;
    const racing = await f.backend(db, {
      ...LEGACY,
      pause: async (request) => {
        if (!interleaved && request.kind === "table" && request.table === "patients" && request.action === "update") {
          interleaved = true;
          // A Cancel + Undo committed in the window: same status and fields, new revision.
          await db.observer.query("UPDATE public.patients SET status = 'cancelled', completed_at = now() WHERE id = $1", [id]);
          await db.observer.query("UPDATE public.patients SET status = 'waiting', completed_at = NULL WHERE id = $1", [id]);
        }
      }
    });
    expectStatus(await post(racing, tokens.frontdesk, "/queue/call", { patient_id: id }), 400, /no longer eligible/);
    assert.equal((await patient(db, id)).status, "waiting");
    assert.equal((await pointers(db))["Doctor 1"], null, "the fallback released its own claim");
    assert.deepEqual(effects(racing, id), { sms: 0, awaiting: false, voice: 0 });
    await assertConsistent(db);
  });

  test("Cancel: waiting still cancels; serving fails closed with a migration message and changes nothing", async () => {
    const waiting = await register(h, db, tokens.frontdesk, { name: "Synthetic waiting", service: "prenatal" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: waiting, reason: "Left" }), 200);
    assert.equal((await patient(db, waiting)).status, "cancelled");

    const servingId = await called(h, db, tokens, { name: "Synthetic serving" });
    const before = await f.snapshot(db);
    for (const token of [tokens.frontdesk, tokens.admin1, tokens.superadmin]) {
      expectStatus(await post(h, token, "/queue/cancel", { patient_id: servingId, reason: "x" }), 503, CANCEL_MIGRATION_REQUIRED);
    }
    assert.deepEqual(await f.snapshot(db), before);
    assert.equal(effects(h, servingId).awaiting, true, "the pending acceptance survives a refused Cancel");
    await assertConsistent(db);
  });

  test("Requeue: falls back to recover_patient_visit, but refuses (503) a visit a counter still points at", async () => {
    const id = await called(h, db, tokens, { name: "Synthetic GP" });
    // Without W1 a serving visit cannot be cancelled; use a waiting one.
    expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: id, reason: "x" }), 503, CANCEL_MIGRATION_REQUIRED);
    const waiting = await register(h, db, tokens.frontdesk, { name: "Synthetic OB", service: "prenatal" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: waiting, reason: "x" }), 200);
    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: waiting }), 200);
    assert.deepEqual(h.rpcs(), ["validate_staff_auth_session", "requeue_patient_visit", "recover_patient_visit"]);

    const stale = await staleCancelled(db);
    const before = await f.snapshot(db);
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: stale }), 503, /counter still points at this visit/);
    assert.deepEqual(await f.snapshot(db), before, "the counter pointer is kept, not corrupted");
  });

  test("Messages distinguish a missing migration (503) from an invalid patient state (400/409)", async () => {
    const servingId = await called(h, db, tokens, { name: "Synthetic GP" });
    const missing = await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: servingId, reason: "x" });
    expectStatus(missing, 503, /migration/);
    const waiting = await register(h, db, tokens.frontdesk, { name: "Synthetic OB", service: "prenatal" });
    const invalid = [
      await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: waiting }),
      await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: servingId }),
      await post(h, tokens.frontdesk, "/queue/call", { patient_id: servingId })
    ];
    assert.deepEqual(invalid.map((r) => r.status), [409, 409, 400]);
    for (const r of invalid) assert.doesNotMatch(r.body.message, /migration/i);
  });
});

describe("C. partial states during installation", { skip: f.unavailable }, () => {
  test("C1 only: Call uses C1; serving Cancel still fails closed; stale-pointer Requeue still refused", async () => {
    const db = await f.createDatabase("c1f5w1_c1only", [C1.migration]);
    const h = await f.backend(db);
    const tokens = await f.signInAll(h);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic GP" });
    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    assert.deepEqual(h.tableWrites("counters"), []);
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "x" }), 503, CANCEL_MIGRATION_REQUIRED);
    const stale = await staleCancelled(db);
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: stale }), 503, /counter still points/);
  });

  test("C1 + F5: stale-pointer Requeue now repairs; serving Cancel still fails closed until W1", async () => {
    const db = await f.createDatabase("c1f5w1_c1f5", [C1.migration, F5.migration]);
    const h = await f.backend(db);
    const tokens = await f.signInAll(h);
    const stale = await staleCancelled(db);
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: stale }), 200);
    assert.equal((await pointers(db))["Doctor 3"], null);
    const id = await called(h, db, tokens, { name: "Synthetic GP" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "x" }), 503, CANCEL_MIGRATION_REQUIRED);
    await assertConsistent(db);
  });
});

