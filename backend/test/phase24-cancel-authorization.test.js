// R2: Cancel authorization and doctor-ownership protection.
// Synthetic fixtures only. The "mock Supabase" mode runs the real service against an
// isolated fake PostgREST client; "development memory" runs the local fallback.
// Neither is an independent-connection PostgreSQL concurrency test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createHarness, clone } = require("./helpers/queueHarness");

const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const SERVICE = { 1: "consultation", 2: "prenatal", 3: "family_planning" };
const BASE_TIME = Date.parse("2026-10-14T01:00:00.000Z");

const registration = (name, service, flags = []) => ({
  idNum: name, serviceType: service, vulnerabilityFlags: flags, mobileNumber: "09170001234",
  residency: "Sentinel Barangay Zone 9", philhealthId: "PHIL-SENTINEL-77", birthdate: "1951-02-03", sex: "X-SENTINEL"
});

async function setup(localFallback, options = {}) {
  const h = createHarness({ localFallback, clock: { now: BASE_TIME }, ...options });
  await h.initialize();
  return h;
}

// Registers a patient for the doctor's service and calls it (serving, awaiting acceptance).
async function calledPatient(h, number, name = `Patient D${number}`, flags = []) {
  const patient = await h.service.createQueueEntry(registration(name, SERVICE[number], flags));
  h.advance();
  await h.service.callPatient(patient.id, `Doctor ${number}`);
  h.advance();
  return patient;
}
async function acceptedPatient(h, number, name) {
  const patient = await calledPatient(h, number, name);
  const response = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number));
  assert.equal(response.status, 200, response.body?.message);
  h.advance();
  return patient;
}
async function startedPatient(h, number, name) {
  const patient = await acceptedPatient(h, number, name);
  const response = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(number));
  assert.equal(response.status, 200, response.body?.message);
  h.advance();
  return patient;
}
async function waitingPatient(h, number, name = `Waiting D${number}`, flags = []) {
  const patient = await h.service.createQueueEntry(registration(name, SERVICE[number], flags));
  h.advance();
  return patient;
}

const cancelBody = (patient, extra = {}) => ({ patient_id: patient.id, reason: "Synthetic cancellation", ...extra });
const cancel = (h, patient, user, extra) => h.request("POST", "/queue/cancel", cancelBody(patient, extra), user);

async function row(h, patient) { return clone(await h.service.getPatientById(patient.id)); }
// Every patient row plus every counter pointer: proves "nothing else changed".
async function snapshot(h, patients, counterIds = null) {
  const rows = [];
  for (const patient of patients) rows.push(await row(h, patient));
  const counters = (await h.service.getQueueOverview()).counters
    .filter((counter) => !counterIds || counterIds.includes(counter.id))
    .map((counter) => ({ id: counter.id, current_patient_id: counter.current_patient_id ?? null }));
  return clone({ rows, counters });
}
const counterPointer = async (h, number) =>
  (await h.service.getQueueOverview()).counters.find((counter) => counter.id_num === `Doctor ${number}`).current_patient_id ?? null;

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "mock Supabase";

  test(`${mode}: Doctor 1 cancels its own serving patient; counter is released and history is kept`, async () => {
    const h = await setup(localFallback);
    const mine = await startedPatient(h, 1);
    const otherDoctor = await startedPatient(h, 2);
    const before = await row(h, mine);
    const otherBefore = await snapshot(h, [otherDoctor], [2, 3]);
    h.advance();
    const response = await cancel(h, mine, doctor(1), { counter_id: "Doctor 1" });
    assert.equal(response.status, 200, response.body.message);
    assert.equal(response.body.already_cancelled, undefined);
    const after = await row(h, mine);
    assert.equal(after.status, "cancelled");
    assert.equal(after.reason, "Synthetic cancellation");
    assert.ok(after.completed_at, "cancellation time recorded");
    assert.equal(before.completed_at ?? null, null);
    // Consultation history, call time and assignment are preserved by cancellation.
    for (const field of ["counter_id", "called_at", "created_at", "consultation_started_at", "queue_number", "priority_score"]) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.equal(after.counter_id, "Doctor 1");
    assert.equal(await counterPointer(h, 1), null, "own counter released");
    assert.deepEqual(await snapshot(h, [otherDoctor], [2, 3]), otherBefore, "other doctor's patient and counter are untouched");
    assert.equal(await counterPointer(h, 2), otherDoctor.id);
  });

  test(`${mode}: Doctor 1 may also cancel an unaccepted called patient and a waiting patient routed to Doctor 1`, async () => {
    const h = await setup(localFallback);
    const called = await calledPatient(h, 1);
    const waiting = await waitingPatient(h, 1);
    assert.equal((await cancel(h, called, doctor(1))).status, 200);
    assert.equal((await cancel(h, waiting, doctor(1), { counter_id: "Doctor 1" })).status, 200);
    assert.equal((await row(h, called)).status, "cancelled");
    const cancelledWaiting = await row(h, waiting);
    assert.equal(cancelledWaiting.status, "cancelled");
    assert.equal(cancelledWaiting.counter_id, "Doctor 1", "validated, canonical doctor only");
    assert.equal(await counterPointer(h, 1), null);
  });

  for (const [attacker, victim] of [[2, 1], [3, 2], [1, 3]]) {
    test(`${mode}: Doctor ${attacker} cannot cancel Doctor ${victim}'s serving patient`, async () => {
      const h = await setup(localFallback);
      const owned = await startedPatient(h, victim);
      const mine = await startedPatient(h, attacker);
      const before = await snapshot(h, [owned, mine]);
      h.advance(5000);
      for (const extra of [{}, { counter_id: `Doctor ${attacker}` }, { counter_id: `Doctor ${victim}` }, { counterId: `Doctor ${attacker}` }]) {
        const response = await cancel(h, owned, doctor(attacker), extra);
        assert.equal(response.status, 403, JSON.stringify(extra));
      }
      assert.deepEqual(await snapshot(h, [owned, mine]), before, "no patient, counter, timestamp or attribution changed");
      // The rightful doctor can still finish the consultation afterwards.
      const done = await h.request("POST", "/queue/complete", { patient_id: owned.id }, doctor(victim));
      assert.equal(done.status, 200, done.body.message);
      assert.equal((await row(h, owned)).status, "completed");
    });
  }

  test(`${mode}: forged counter_id is rejected and never becomes the patient's attribution`, async () => {
    const h = await setup(localFallback);
    const mine = await startedPatient(h, 1);
    const waiting = await waitingPatient(h, 2);
    const before = await snapshot(h, [mine, waiting]);
    // Own patient with a different doctor's label: contradiction, not a re-assignment.
    assert.equal((await cancel(h, mine, doctor(1), { counter_id: "Doctor 2" })).status, 409);
    assert.equal((await cancel(h, mine, FRONTDESK, { counter_id: "Doctor 3" })).status, 409);
    assert.equal((await cancel(h, mine, SUPERADMIN, { counterId: "Doctor 2" })).status, 409);
    // Waiting patient routed to Doctor 2 cannot be attributed to Doctor 1 by staff.
    assert.equal((await cancel(h, waiting, FRONTDESK, { counter_id: "Doctor 1" })).status, 409);
    // Unknown counters and disagreeing alias fields are bad requests.
    assert.equal((await cancel(h, mine, FRONTDESK, { counter_id: "Doctor 99" })).status, 400);
    assert.equal((await cancel(h, mine, FRONTDESK, { counter_id: "Doctor 1", counterId: "Doctor 2" })).status, 400);
    assert.deepEqual(await snapshot(h, [mine, waiting]), before);
    // A truthful numeric counter id is accepted as a consistency check.
    assert.equal((await cancel(h, mine, FRONTDESK, { counter_id: "1" })).status, 200);
    assert.equal((await row(h, mine)).counter_id, "Doctor 1");
  });

  test(`${mode}: actor fields in the body are ignored; only the verified identity counts`, async () => {
    const h = await setup(localFallback);
    const owned = await startedPatient(h, 1);
    const before = await snapshot(h, [owned]);
    const forged = {
      role: "superadmin", id_num: "superadmin", doctor_name: "Doctor 1", counter_id: "Doctor 1", counterId: "Doctor 1",
      user: SUPERADMIN, actor: SUPERADMIN, cancelled_by: "admin1", auth_revision: "forged"
    };
    const response = await h.request("POST", "/queue/cancel", cancelBody(owned, forged), doctor(2));
    assert.equal(response.status, 403);
    assert.deepEqual(await snapshot(h, [owned]), before);
  });

  test(`${mode}: unauthorized roles, unknown or stale accounts and stale tokens are rejected before any change`, async () => {
    const h = await setup(localFallback);
    const owned = await startedPatient(h, 1);
    const waiting = await waitingPatient(h, 1);
    const before = await snapshot(h, [owned, waiting]);
    const rejected = [
      [null, 401],                                                    // no verified identity at all
      [{ id_num: "viewer1", role: "viewer", doctor_name: "Doctor 1" }, 403], // unsupported role
      [{ id_num: "admin1", role: "patient", doctor_name: "Doctor 1" }, 403],
      [{ id_num: "", role: "admin", doctor_name: "Doctor 1" }, 403],         // no account id
      [{ id_num: "ghost", role: "admin", doctor_name: "Doctor 1" }, 403],    // not a persisted account
      [{ id_num: "admin1", role: "superadmin", doctor_name: null }, 403],    // token role differs from the account
      [{ id_num: "admin1", role: "admin", doctor_name: "Doctor 2" }, 403],   // token doctor differs from the account
      [{ id_num: "admin1", role: "admin", doctor_name: null }, 403],         // Doctor 1 account posing as Frontdesk
      [{ id_num: "frontdesk", role: "admin", doctor_name: "Doctor 1" }, 403] // Frontdesk account claiming a doctor
    ];
    for (const [user, status] of rejected) {
      for (const target of [owned, waiting]) {
        const response = await cancel(h, target, user);
        assert.equal(response.status, status, JSON.stringify(user));
      }
    }
    assert.deepEqual(await snapshot(h, [owned, waiting]), before);
  });

  test(`${mode}: a doctor account reassigned after sign-in is refused with its old token`, async () => {
    // Development memory has fixed seed accounts; this scenario is covered by the mock-database run.
    if (localFallback) return;
    const h = await setup(localFallback);
    const owned = await startedPatient(h, 1);
    h.database.users.find((user) => user.id_num === "admin1").doctor_name = "Doctor 3";
    const before = await snapshot(h, [owned]);
    assert.equal((await cancel(h, owned, doctor(1))).status, 403);
    assert.deepEqual(await snapshot(h, [owned]), before);
  });

  test(`${mode}: repeated cancellation is idempotent and changes nothing`, async () => {
    const h = await setup(localFallback);
    const patient = await startedPatient(h, 1);
    const other = await startedPatient(h, 2);
    assert.equal((await cancel(h, patient, doctor(1), { counter_id: "Doctor 1" })).status, 200);
    const afterFirst = await snapshot(h, [patient, other]);
    h.advance(60000);
    const second = await h.request("POST", "/queue/cancel", cancelBody(patient, { reason: "A different reason" }), doctor(1));
    assert.equal(second.status, 200);
    assert.equal(second.body.already_cancelled, true);
    assert.match(second.body.message, /already cancelled/i);
    for (const user of [FRONTDESK, SUPERADMIN]) {
      h.advance(1000);
      const repeat = await cancel(h, patient, user, { reason: "Another attempt" });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.body.already_cancelled, true);
    }
    const final = await snapshot(h, [patient, other]);
    assert.deepEqual(final, afterFirst, "reason, completion time, assignment, revision and counters are unchanged");
    assert.equal(final.rows[0].reason, "Synthetic cancellation");
  });

  test(`${mode}: repeating a cancel never releases a doctor's newer patient`, async () => {
    const h = await setup(localFallback);
    const first = await acceptedPatient(h, 1, "First Patient");
    assert.equal((await cancel(h, first, doctor(1))).status, 200);
    const second = await acceptedPatient(h, 1, "Second Patient");
    assert.equal(await counterPointer(h, 1), second.id);
    const before = await snapshot(h, [first, second]);
    assert.equal((await cancel(h, first, doctor(1))).body.already_cancelled, true);
    assert.equal((await cancel(h, first, FRONTDESK, { counter_id: "Doctor 1" })).body.already_cancelled, true);
    assert.deepEqual(await snapshot(h, [first, second]), before);
    assert.equal(await counterPointer(h, 1), second.id, "Doctor 1 still holds the second patient");
    assert.equal((await row(h, second)).status, "serving");
  });

  test(`${mode}: another doctor cannot even repeat-cancel a cancelled patient`, async () => {
    const h = await setup(localFallback);
    const patient = await startedPatient(h, 1);
    assert.equal((await cancel(h, patient, doctor(1))).status, 200);
    const before = await snapshot(h, [patient]);
    assert.equal((await cancel(h, patient, doctor(2), { counter_id: "Doctor 2" })).status, 403);
    assert.deepEqual(await snapshot(h, [patient]), before);
  });

  test(`${mode}: a completed consultation cannot be cancelled and its history is preserved`, async () => {
    const h = await setup(localFallback);
    const patient = await startedPatient(h, 2);
    h.advance(10000);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(2))).status, 200);
    const before = await snapshot(h, [patient]);
    h.advance(5000);
    for (const user of [doctor(2), FRONTDESK, SUPERADMIN]) {
      const response = await cancel(h, patient, user, { counter_id: "Doctor 2" });
      assert.equal(response.status, 400);
      assert.match(response.body.message, /completed consultation cannot be cancelled/i);
    }
    assert.deepEqual(await snapshot(h, [patient]), before);
    const stored = await row(h, patient);
    assert.equal(stored.status, "completed");
    assert.ok(stored.consultation_started_at && stored.completed_at);
  });

  test(`${mode}: a no-show record keeps its outcome and cannot be rewritten as a cancellation`, async () => {
    const h = await setup(localFallback);
    const patient = await calledPatient(h, 3);
    h.advance(11 * 60 * 1000);
    assert.equal((await h.request("POST", "/queue/no-show", { patient_id: patient.id, reason: "Did not arrive" }, FRONTDESK)).status, 200);
    const before = await snapshot(h, [patient]);
    h.advance(1000);
    const response = await cancel(h, patient, FRONTDESK);
    assert.equal(response.status, 409);
    assert.deepEqual(await snapshot(h, [patient]), before);
    assert.equal((await row(h, patient)).status, "no-show");
  });

  test(`${mode}: cancelling releases only the cancelled patient's counter`, async () => {
    const h = await setup(localFallback);
    const one = await startedPatient(h, 1);
    const two = await startedPatient(h, 2);
    const three = await acceptedPatient(h, 3);
    const waiting = await waitingPatient(h, 1);
    const twoThreeBefore = await snapshot(h, [two, three], [2, 3]);
    h.advance();
    assert.equal((await cancel(h, waiting, FRONTDESK)).status, 200);
    assert.equal(await counterPointer(h, 1), one.id, "cancelling a waiting patient releases nothing");
    assert.equal((await cancel(h, one, SUPERADMIN)).status, 200);
    assert.equal(await counterPointer(h, 1), null);
    assert.deepEqual((await snapshot(h, [two, three], [2, 3])), twoThreeBefore);
    assert.equal(await counterPointer(h, 2), two.id);
    assert.equal(await counterPointer(h, 3), three.id);
  });

  test(`${mode}: Frontdesk and Superadmin keep their existing cancellation capability`, async () => {
    const h = await setup(localFallback);
    const a = await startedPatient(h, 1);
    const b = await acceptedPatient(h, 2);
    const c = await waitingPatient(h, 3);
    const d = await waitingPatient(h, 1);
    assert.equal((await cancel(h, a, FRONTDESK, { counter_id: "Doctor 1" })).status, 200);
    assert.equal((await cancel(h, b, SUPERADMIN)).status, 200);
    assert.equal((await cancel(h, c, FRONTDESK, { counter_id: "Doctor 3" })).status, 200);
    assert.equal((await cancel(h, d, SUPERADMIN, { counter_id: "Doctor 1" })).status, 200);
    for (const patient of [a, b, c, d]) assert.equal((await row(h, patient)).status, "cancelled");
    assert.equal((await row(h, a)).counter_id, "Doctor 1");
    assert.equal((await row(h, b)).counter_id, "Doctor 2");
    assert.equal(await counterPointer(h, 1), null);
    assert.equal(await counterPointer(h, 2), null);
    // A reason is still required, and a missing patient is a 404.
    const missingReason = await h.request("POST", "/queue/cancel", { patient_id: c.id, reason: "  " }, FRONTDESK);
    assert.equal(missingReason.status, 400);
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: 987654, reason: "x" }, FRONTDESK)).status, 404);
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: "abc", reason: "x" }, FRONTDESK)).status, 400);
  });

  test(`${mode}: a serving patient without a valid assignment can be recovered by Frontdesk but not by a doctor`, async () => {
    const h = await setup(localFallback);
    const orphan = await h.service.createQueueEntry(registration("Legacy Orphan", "consultation"));
    h.advance();
    const stored = localFallback ? await h.service.getPatientById(orphan.id) : h.database.patients.find((item) => item.id === orphan.id);
    Object.assign(stored, { status: "serving", called_at: new Date(h.clock.now).toISOString(), counter_id: null });
    const before = await snapshot(h, [orphan]);
    assert.equal((await cancel(h, orphan, doctor(1))).status, 403);
    assert.equal((await cancel(h, orphan, doctor(2))).status, 403);
    assert.deepEqual(await snapshot(h, [orphan]), before);
    h.advance();
    assert.equal((await cancel(h, orphan, FRONTDESK)).status, 200);
    const after = await row(h, orphan);
    assert.equal(after.status, "cancelled");
    assert.equal(after.counter_id, null, "no assignment is invented for an unassigned visit");
  });

  test(`${mode}: a doctor cannot cancel a waiting patient routed to another doctor`, async () => {
    const h = await setup(localFallback);
    const waiting = await waitingPatient(h, 2);
    const before = await snapshot(h, [waiting]);
    assert.equal((await cancel(h, waiting, doctor(1))).status, 403);
    assert.equal((await cancel(h, waiting, doctor(3), { counter_id: "Doctor 2" })).status, 403);
    assert.deepEqual(await snapshot(h, [waiting]), before);
  });

  test(`${mode}: a cancelled in-progress visit retains consultation history and Undo still restores clean waiting`, async () => {
    const h = await setup(localFallback);
    const patient = await startedPatient(h, 1);
    const before = await row(h, patient);
    h.advance(30000);
    assert.equal((await cancel(h, patient, doctor(1))).status, 200);
    const cancelled = await row(h, patient);
    assert.equal(cancelled.consultation_started_at, before.consultation_started_at);
    assert.equal(cancelled.called_at, before.called_at);
    h.advance();
    const undo = await h.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK);
    assert.equal(undo.status, 200, undo.body?.message);
    const waiting = await row(h, patient);
    assert.equal(waiting.status, "waiting");
    for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(waiting[field], null, field);
    assert.notEqual(waiting.visit_state_revision, cancelled.visit_state_revision);
    // Cancelling the recovered waiting visit again is a fresh, valid cancellation.
    h.advance();
    assert.equal((await cancel(h, patient, FRONTDESK)).body.already_cancelled, undefined);
  });

  test(`${mode}: normal Call -> Accept -> Start -> Complete and weighted-priority order are unchanged`, async () => {
    const h = await setup(localFallback);
    const regular = await waitingPatient(h, 1, "Regular One");
    const senior = await waitingPatient(h, 1, "Senior One", ["senior"]);
    const other = await waitingPatient(h, 3, "Family One");
    const waitingBefore = (await h.request("GET", "/display", {}, null)).body.waiting_queue.map((entry) => entry.queue_number);
    assert.deepEqual(waitingBefore, [senior, regular, other].map((patient) => patient.queue_number), "priority DESC then arrival");
    // Lower priority cannot jump the senior; the head is called for its mapped doctor.
    assert.equal((await h.request("POST", "/queue/call", { patient_id: regular.id, counterId: "Doctor 1" }, FRONTDESK)).status, 400);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: senior.id, counterId: "Doctor 1" }, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: senior.id }, doctor(1))).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/start", { patient_id: senior.id }, doctor(1))).status, 200);
    h.advance(5000);
    const complete = await h.request("POST", "/queue/complete", { patient_id: senior.id, counter_id: "Doctor 1" }, doctor(1));
    assert.equal(complete.status, 200, complete.body.message);
    const done = await row(h, senior);
    assert.equal(done.status, "completed");
    assert.equal(done.counter_id, "Doctor 1");
    assert.equal(await counterPointer(h, 1), null);
    assert.equal((await row(h, regular)).status, "waiting");
    assert.equal((await row(h, other)).status, "waiting");
  });
}

// ---------------------------------------------------------------------------
// Concurrency interleavings. These use the isolated fake client's hooks, so they
// verify the service's conditional-write and revision logic, not PostgreSQL row
// locking between independent connections.
// ---------------------------------------------------------------------------
// W1: Cancel's write is the cancel_patient_visit RPC; with it absent only a waiting visit
// without a counter pointer is cancelled, by a single compare-and-set (the "absent" runs).
const beforeCancelWrite = (h, installed, intervene) => {
  if (!installed) h.database.cancelRpcInstalled = false;
  const hook = installed ? "beforeRpc" : "beforeQuery";
  h.database[hook] = async (operation) => {
    if (installed ? operation !== "cancel_patient_visit" : operation.table !== "patients" || operation.action !== "update") return undefined;
    h.database[hook] = null;
    await intervene();
    return undefined;
  };
};

test("mock Supabase: Complete committed by another instance before Cancel's write wins; completed history is not overwritten", async () => {
  const h = await setup(false);
  const patient = await startedPatient(h, 2);
  h.advance(10000);
  let raced = false;
  h.database.beforeRpc = async (name) => {
    if (raced || name !== "cancel_patient_visit") return undefined;
    raced = true;
    h.database.beforeRpc = null;
    const done = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(2));
    assert.equal(done.status, 200, done.body.message);
    return undefined;
  };
  const response = await cancel(h, patient, doctor(2));
  assert.equal(response.status, 409, response.body.message);
  const stored = await row(h, patient);
  assert.equal(stored.status, "completed");
  assert.ok(stored.consultation_started_at && stored.completed_at);
  assert.notEqual(stored.reason, "Synthetic cancellation");
});

// F5: a waiting visit can no longer be re-queued, so the waiting -> waiting ABA is produced by
// a committed Cancel followed by Undo (both rotate the revision and restore "waiting").
for (const installed of [true, false]) test(`mock Supabase (W1 RPC ${installed ? "installed" : "absent"}): a Cancel and Undo between Cancel's validation and write make the stale Cancel fail without touching the new visit`, async () => {
  const h = await setup(false);
  const patient = await waitingPatient(h, 1);
  let revisionAtRace;
  beforeCancelWrite(h, installed, async () => {
    h.advance();
    const intervening = await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Intervening cancellation" }, FRONTDESK);
    assert.equal(intervening.status, 200, intervening.body.message);
    const undo = await h.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK);
    assert.equal(undo.status, 200, undo.body.message);
    revisionAtRace = (await row(h, patient)).visit_state_revision;
  });
  const response = await cancel(h, patient, FRONTDESK);
  assert.equal(response.status, 409, response.body.message);
  const stored = await row(h, patient);
  assert.equal(stored.status, "waiting", "the stale Cancel did not apply");
  assert.equal(stored.visit_state_revision, revisionAtRace);
  assert.notEqual(stored.reason, "Synthetic cancellation");
});

for (const installed of [true, false]) test(`mock Supabase (W1 RPC ${installed ? "installed" : "absent"}): a Call between Cancel's validation and write cannot be overwritten by the stale Cancel`, async () => {
  const h = await setup(false);
  const patient = await waitingPatient(h, 3);
  beforeCancelWrite(h, installed, async () => {
    h.advance();
    await h.service.callPatient(patient.id, "Doctor 3");
  });
  const response = await cancel(h, patient, FRONTDESK);
  assert.equal(response.status, 409);
  const stored = await row(h, patient);
  assert.equal(stored.status, "serving");
  assert.equal(stored.counter_id, "Doctor 3");
  assert.equal(await counterPointer(h, 3), patient.id, "the new call keeps its counter");
});

// F5: Requeue of a serving visit is refused outright, so the in-flight Requeue starts from a
// cancelled snapshot and loses to a committed Undo + Call + Cancel (cancelled -> cancelled ABA).
test("mock Supabase: Cancel committed while Requeue is in flight makes the stale Requeue fail", async () => {
  const h = await setup(false);
  const patient = await startedPatient(h, 1);
  assert.equal((await cancel(h, patient, doctor(1))).status, 200);
  h.advance();
  h.database.beforeRpc = async (name) => {
    if (name !== "recover_patient_visit") return;
    h.database.beforeRpc = null;
    h.advance();
    assert.equal((await h.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id }, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await cancel(h, patient, doctor(1))).status, 200);
  };
  h.advance();
  const requeue = await h.request("POST", "/queue/requeue", { patient_id: patient.id }, FRONTDESK);
  assert.equal(requeue.status, 409, requeue.body?.message);
  const stored = await row(h, patient);
  assert.equal(stored.status, "cancelled", "the committed Cancel stands");
  assert.equal(stored.reason, "Synthetic cancellation");
});

test("mock Supabase: Cancel between Undo's snapshot and commit makes the stale Undo fail and keeps the cancellation", async () => {
  const h = await setup(false);
  const patient = await startedPatient(h, 1);
  assert.equal((await cancel(h, patient, doctor(1))).status, 200);
  let cancelledAgain;
  h.database.beforeRpc = async (name) => {
    if (name !== "undo_patient_visit_waiting") return;
    h.database.beforeRpc = null;
    h.advance();
    // Another instance undoes and the visit is cancelled again before this Undo commits.
    const undo = await h.service.undoPatientAction(patient.id, FRONTDESK);
    assert.equal(undo.status, "waiting");
    h.advance();
    assert.equal((await cancel(h, patient, FRONTDESK)).status, 200);
    cancelledAgain = await row(h, patient);
  };
  h.advance();
  const stale = await h.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK);
  assert.equal(stale.status, 409, stale.body?.message);
  assert.deepEqual(await row(h, patient), cancelledAgain);
});

test("mock Supabase: two simultaneous Cancels write once; the loser is rejected or idempotent, never a rewrite", async () => {
  const h = await setup(false);
  const patient = await startedPatient(h, 1);
  h.advance();
  const results = await Promise.all([
    cancel(h, patient, doctor(1), { reason: "First reason" }),
    cancel(h, patient, FRONTDESK, { reason: "Second reason" })
  ]);
  const stored = await row(h, patient);
  assert.equal(stored.status, "cancelled");
  const winners = results.filter((response) => response.status === 200 && !response.body.already_cancelled);
  assert.equal(winners.length, 1, "exactly one request performs the cancellation");
  for (const response of results) assert.ok([200, 409].includes(response.status), String(response.status));
  assert.equal(stored.reason, winners[0] === results[0] ? "First reason" : "Second reason");
  assert.equal(await counterPointer(h, 1), null);
});

// ---------------------------------------------------------------------------
// Real authentication middleware + real route: revoked, expired and malformed
// sessions never reach the service, and the service receives the verified
// token claims rather than anything from the request body.
// ---------------------------------------------------------------------------
function loadSource(relative, imports) {
  const filename = path.resolve(__dirname, "../src", relative);
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { console, Date });
  wrapper((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

function routeHarness() {
  const secret = "isolated-r2-route-test-secret";
  const handlers = new Map();
  const cancelCalls = [];
  const sessions = new Map();
  const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const presence = {
    async validateAuthSession(claims) {
      const session = sessions.get(claims.jti);
      if (!session || session.revoked || session.id_num !== claims.id_num) throw fail(401, "Authentication session expired or revoked");
      return session;
    }
  };
  const auth = loadSource("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": { jwtSecret: secret }, "../services/presenceService": presence });
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) router[method] = (route, ...chain) => handlers.set(`${method.toUpperCase()} ${route}`, chain);
  const cleared = [];
  loadSource("routes/index.js", {
    express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto, "../config/env": { jwtSecret: secret },
    "../middleware/auth": auth, "../lib/businessDay": require("../src/lib/businessDay"), "../lib/wpsPriority": require("../src/lib/wpsPriority"), "../services/presenceService": presence,
    "../services/queueService": {
      cancelPatient: async (...args) => { cancelCalls.push(args); return { id: args[0], status: "cancelled" }; }
    },
    "../services/settingsService": { clearAwaitingAccept: (id) => cleared.push(id) }
  });
  const sign = (claims, options = {}, key = secret) => jwt.sign(claims, key, { algorithm: "HS256", expiresIn: "1h", ...options });
  async function post(token, body) {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body };
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    const chain = handlers.get("POST /queue/cancel");
    const run = async (index) => { if (chain[index]) await chain[index](req, res, () => run(index + 1)); };
    await run(0);
    return res;
  }
  return { sessions, cancelCalls, cleared, sign, post, secret };
}

test("route: missing, malformed, expired, wrongly signed and revoked sessions never reach Cancel", async () => {
  const r = routeHarness();
  const claims = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1", jti: "session-1" };
  r.sessions.set("session-1", { ...claims });
  const body = { patient_id: 5, reason: "Synthetic" };
  assert.equal((await r.post(null, body)).statusCode, 401);
  assert.equal((await r.post("not-a-jwt", body)).statusCode, 403);
  assert.equal((await r.post(r.sign(claims, { expiresIn: -60 }), body)).statusCode, 403, "expired token");
  assert.equal((await r.post(r.sign(claims, {}, "a-different-secret"), body)).statusCode, 403, "wrong signature");
  const noneToken = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  assert.equal((await r.post(noneToken, body)).statusCode, 403, "unsigned token");
  r.sessions.get("session-1").revoked = true;
  assert.equal((await r.post(r.sign(claims), body)).statusCode, 401, "revoked session");
  assert.equal((await r.post(r.sign({ ...claims, jti: "unknown-session" }), body)).statusCode, 401, "unknown session");
  assert.equal(r.cancelCalls.length, 0);
  assert.deepEqual(r.cleared, []);
});

test("route: the service receives the verified token claims, not identity fields from the body", async () => {
  const r = routeHarness();
  const claims = { id_num: "admin2", role: "admin", doctor_name: "Doctor 2", jti: "session-2" };
  r.sessions.set("session-2", { ...claims });
  const forged = { patient_id: "7", reason: "  Synthetic  ", counter_id: "Doctor 2", role: "superadmin", id_num: "superadmin", doctor_name: "Doctor 1",
    user: { id_num: "superadmin", role: "superadmin" } };
  const response = await r.post(r.sign(claims), forged);
  assert.equal(response.statusCode, 200, response.body?.message);
  assert.equal(r.cancelCalls.length, 1);
  const [patientId, reason, counterId, actor] = r.cancelCalls[0];
  assert.equal(patientId, 7);
  assert.equal(reason, "Synthetic");
  assert.equal(counterId, "Doctor 2");
  assert.equal(actor.id_num, "admin2");
  assert.equal(actor.role, "admin");
  assert.equal(actor.doctor_name, "Doctor 2");
  assert.ok(!JSON.stringify(actor).includes("superadmin"));
  assert.deepEqual(r.cleared, ["7"]);
});

test("route: conflicting counter aliases and a missing reason are rejected before the service is called", async () => {
  const r = routeHarness();
  const claims = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1", jti: "session-3" };
  r.sessions.set("session-3", { ...claims });
  assert.equal((await r.post(r.sign(claims), { patient_id: 1, reason: "x", counter_id: "Doctor 1", counterId: "Doctor 2" })).statusCode, 400);
  assert.equal((await r.post(r.sign(claims), { patient_id: 1, reason: "   " })).statusCode, 400);
  assert.equal(r.cancelCalls.length, 0);
});
