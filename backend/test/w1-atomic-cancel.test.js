// W1: Cancel changes the patient and its doctor counter together or not at all, never reports a
// cancellation the database did not confirm, and never withdraws another call's acceptance.
// Synthetic data only. The mock Supabase harness models cancel_patient_visit's checks and
// all-or-nothing commit; PostgreSQL locking is covered by w1-atomic-cancel-concurrency.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");
const { createRealAuthHarness } = require("./helpers/realAuthRouteHarness");

const BASE_TIME = Date.parse("2026-10-25T02:00:00.000Z"); // 10:00 Manila
const SERVICE = { 1: "consultation", 2: "prenatal", 3: "family_planning" };
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });

function harness({ installed = true, requeue = false, call = false } = {}) {
  const database = createDatabase();
  if (!installed) database.cancelRpcInstalled = false;
  database.requeueRpcInstalled = requeue;
  database.callRpcInstalled = call;
  return createHarness({ database, clock: { now: BASE_TIME } });
}

async function register(h, number = 1, name = `Synthetic W1 D${number}`) {
  const patient = await h.service.createQueueEntry({ idNum: name, serviceType: SERVICE[number], mobileNumber: "09170000000" });
  h.advance();
  return patient;
}
async function called(h, number = 1, name) {
  const patient = await register(h, number, name);
  const response = await h.request("POST", "/queue/call", { patient_id: patient.id }, FRONTDESK);
  assert.equal(response.status, 200, response.body.message);
  h.advance();
  return patient;
}
async function accepted(h, number = 1, name) {
  const patient = await called(h, number, name);
  const response = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number));
  assert.equal(response.status, 200, response.body.message);
  h.advance();
  return patient;
}

const row = (h, id) => clone(h.database.patients.find((patient) => patient.id === id));
const pointer = (h, number) => h.database.counters[number - 1].current_patient_id;
const cancel = (h, patient, user = FRONTDESK, body = {}) =>
  h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Synthetic W1 cancellation", ...body }, user);
const directWrites = (h) => h.database.calls.filter((entry) => entry.action === "update" && ["patients", "counters"].includes(entry.table));
const cancelRpcs = (h) => h.database.calls.filter((entry) => entry.action === "rpc" && entry.function === "cancel_patient_visit");
// Application-side cancellation effects: pending acceptance, acceptance time and recall count.
const sideState = (h, id) => ({ awaiting: h.settings.isAwaitingAccept(id), acceptedAt: h.settings.getAcceptedAt(id), recalls: h.settings.getRecallCount(id) });

// ---------------------------------------------------------------------------
// Before installation (the development database today)
// ---------------------------------------------------------------------------
test("not installed: a serving visit fails closed (503) - patient, counter, acceptance and recall count unchanged, no write attempted", async () => {
  const h = harness({ installed: false });
  const waitingCall = await called(h, 1);
  const inConsultation = await accepted(h, 2);
  assert.equal((await h.request("POST", "/queue/start", { patient_id: inConsultation.id }, doctor(2))).status, 200);
  h.settings.incrementRecallCount(waitingCall.id);
  for (const [patient, number] of [[waitingCall, 1], [inConsultation, 2]]) {
    const before = { visit: row(h, patient.id), side: sideState(h, patient.id), voice: clone(h.settings.getVoiceAnnouncementEvents()) };
    h.database.calls.length = 0;
    const response = await cancel(h, patient, FRONTDESK);
    assert.equal(response.status, 503, response.body.message);
    assert.match(response.body.message, /W1 database migration.*Nothing was changed/);
    assert.equal(response.body.success, false);
    assert.deepEqual(row(h, patient.id), before.visit);
    assert.equal(pointer(h, number), patient.id);
    assert.deepEqual(sideState(h, patient.id), before.side);
    assert.deepEqual(clone(h.settings.getVoiceAnnouncementEvents()), before.voice);
    assert.deepEqual(directWrites(h), [], "the unsafe two-step is never attempted");
  }
});

test("not installed: a waiting visit without a counter pointer is cancelled by one compare-and-set and no counter write", async () => {
  const h = harness({ installed: false });
  const patient = await register(h, 3);
  const response = await cancel(h, patient, doctor(3));
  assert.equal(response.status, 200, response.body.message);
  const after = row(h, patient.id);
  assert.deepEqual([after.status, after.reason, after.called_at, after.counter_id], ["cancelled", "Synthetic W1 cancellation", null, null]);
  assert.ok(after.completed_at);
  assert.deepEqual(directWrites(h).map((entry) => entry.table), ["patients"]);
  assert.equal(cancelRpcs(h).length, 1, "the RPC was tried first");
  // Existing authorization still applies on this path.
  const other = await register(h, 1);
  assert.equal((await cancel(h, other, doctor(2))).status, 403);
  assert.equal(row(h, other.id).status, "waiting");
  for (const user of [FRONTDESK, SUPERADMIN, doctor(1)]) {
    const visit = await register(h, 1, `Synthetic W1 ${user.id_num}`);
    assert.equal((await cancel(h, visit, user)).status, 200, user.id_num);
  }
});

test("not installed: a pointer to a waiting or already-cancelled visit is never released outside the RPC (503); a clean repeat is idempotent", async () => {
  const h = harness({ installed: false });
  const reserved = await register(h, 1);
  h.database.counters[0].current_patient_id = reserved.id; // legacy Phase 2.1 reservation
  const before = row(h, reserved.id);
  assert.equal((await cancel(h, reserved)).status, 503);
  assert.deepEqual([row(h, reserved.id), pointer(h, 1)], [before, reserved.id]);

  const stale = await register(h, 2);
  assert.equal((await cancel(h, stale)).status, 200);
  h.database.counters[1].current_patient_id = stale.id; // what the pre-W1 two-step could leave behind
  const cancelled = row(h, stale.id);
  h.database.calls.length = 0;
  const repeat = await cancel(h, stale, FRONTDESK, { reason: "Repeat" });
  assert.equal(repeat.status, 503, repeat.body.message);
  assert.deepEqual([row(h, stale.id), pointer(h, 2), directWrites(h)], [cancelled, stale.id, []]);
  h.database.counters[1].current_patient_id = null;
  const clean = await cancel(h, stale, FRONTDESK, { reason: "Repeat" });
  assert.deepEqual([clean.status, clean.body.already_cancelled], [200, true]);
  assert.deepEqual(row(h, stale.id), cancelled, "original reason, completion time and revision kept");
});

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------
test("installed: one RPC carries the persisted-session claims and the authorized snapshot; no separate patient or counter write", async () => {
  const h = harness();
  const patient = await called(h, 2);
  const snapshot = row(h, patient.id);
  h.database.calls.length = 0;
  const user = { ...doctor(2), jti: "8a6f2c1e-4b7d-4e2a-9c3f-1d2e3f4a5b6c" };
  const response = await cancel(h, patient, user, { reason: "  Left the clinic  ", counter_id: "Doctor 2" });
  assert.equal(response.status, 200, response.body.message);
  assert.deepEqual(cancelRpcs(h).map((entry) => entry.args), [{
    p_patient_id: patient.id, p_session_id: user.jti, p_user_id_num: "admin2", p_role: "admin", p_doctor_name: "Doctor 2",
    p_expected_revision: snapshot.visit_state_revision, p_expected_status: "serving", p_reason: "Left the clinic",
    p_requested_counter: "Doctor 2"
  }]);
  assert.deepEqual(directWrites(h), []);
  const after = row(h, patient.id);
  assert.deepEqual([after.status, after.reason, after.called_at, after.counter_id, after.created_at],
    ["cancelled", "Left the clinic", snapshot.called_at, "Doctor 2", snapshot.created_at]);
  assert.notEqual(after.visit_state_revision, snapshot.visit_state_revision);
  assert.equal(pointer(h, 2), null);
});

test("installed: database outcomes map to 400/401/403/404/409/503 and none of them changes the patient, counter, acceptance or recall count", async () => {
  const cases = [
    ["22023", 400, /invalid/i], ["28000", 401, /sign in again/i], ["42501", 403, /not permitted/i], ["P0002", 404, /not found/i],
    ["40001", 409, /changed/i], ["QM001", 400, /completed/i], ["QM002", 409, /no-show/i], ["QM003", 409, /does not match/i],
    ["QM500", 503, /nothing was changed/], ["40P01", 503, /nothing was changed/], ["55P03", 503, /nothing was changed/],
    ["57014", 503, /nothing was changed/], ["53300", 503, /nothing was changed/], ["08006", 503, /nothing was changed/],
    [undefined, 503, /Could not confirm the cancellation/], ["throw", 503, /Could not confirm the cancellation/],
    ["PGRST202", 503, /W1 database migration/]
  ];
  const messages = { "22023": "Invalid", "28000": "Your session expired; sign in again", "42501": "Not permitted", P0002: "Patient not found",
    "40001": "Patient visit changed", QM001: "A completed consultation cannot be cancelled", QM002: "Marked no-show", QM003: "The requested doctor does not match" };
  for (const [code, status, message] of cases) {
    const h = harness();
    const patient = await called(h, 1);
    h.settings.incrementRecallCount(patient.id);
    const before = { visit: row(h, patient.id), side: sideState(h, patient.id) };
    h.database.beforeRpc = async (name) => {
      if (name !== "cancel_patient_visit") return undefined;
      if (code === "throw") throw new Error("socket hang up");
      return { data: null, error: { code, message: messages[code] || "database failure" } };
    };
    const response = await cancel(h, patient);
    assert.equal(response.status, status, `${code}: ${response.body.message}`);
    assert.match(response.body.message, message, String(code));
    assert.deepEqual(row(h, patient.id), before.visit, `${code}: patient unchanged`);
    assert.equal(pointer(h, 1), patient.id, `${code}: counter unchanged`);
    assert.deepEqual(sideState(h, patient.id), before.side, `${code}: acceptance and recall count unchanged`);
  }
});

test("installed: a row that does not prove the transition is never reported as a cancellation", async () => {
  const forgedRows = [
    (row) => ({ ...row, status: "serving" }),
    (row) => ({ ...row, status: "cancelled" }), // revision not rotated
    (row) => ({ ...row, id: row.id + 1, status: "cancelled", visit_state_revision: "00000000-0000-4000-8000-000000000000" }),
    () => null
  ];
  for (const forge of forgedRows) {
    const h = harness();
    const patient = await called(h, 3);
    const before = { visit: row(h, patient.id), side: sideState(h, patient.id) };
    h.database.beforeRpc = async (name) => (name === "cancel_patient_visit" ? { data: forge(row(h, patient.id)), error: null } : undefined);
    const response = await cancel(h, patient);
    assert.equal(response.status, 503, response.body.message);
    assert.match(response.body.message, /Could not confirm the cancellation/);
    assert.deepEqual(sideState(h, patient.id), before.side, "no acceptance change for an unconfirmed result");
  }
});

test("installed: success withdraws only this patient's pending acceptance and recall count; other calls and announcements stay", async () => {
  const h = harness();
  const announced = await accepted(h, 1, "Synthetic W1 announced");
  const target = await called(h, 2, "Synthetic W1 target");
  const bystander = await called(h, 3, "Synthetic W1 bystander");
  h.settings.incrementRecallCount(target.id);
  h.settings.incrementRecallCount(bystander.id);
  const others = { announced: sideState(h, announced.id), bystander: sideState(h, bystander.id) };
  const voiceBefore = clone(h.settings.getVoiceAnnouncementEvents());
  assert.equal(h.settings.isAwaitingAccept(target.id), true);

  const response = await cancel(h, target, doctor(2));
  assert.equal(response.status, 200, response.body.message);
  assert.deepEqual(sideState(h, target.id), { awaiting: false, acceptedAt: null, recalls: 0 });
  assert.deepEqual({ announced: sideState(h, announced.id), bystander: sideState(h, bystander.id) }, others);
  assert.deepEqual(clone(h.settings.getVoiceAnnouncementEvents()), voiceBefore, "no announcement is added or removed");
  const display = (await h.request("GET", "/display", {}, null)).body;
  assert.ok(display.voice_announcements.some((event) => event.id === announced.id), "the other doctor's announcement remains");
  assert.ok(!display.all_serving.some((entry) => entry.id === target.id));
  assert.deepEqual([pointer(h, 1), pointer(h, 2), pointer(h, 3)], [announced.id, null, bystander.id]);

  // The idempotent repeat touches nothing either.
  const repeat = await cancel(h, target, FRONTDESK, { reason: "Again" });
  assert.deepEqual([repeat.status, repeat.body.already_cancelled], [200, true]);
  assert.deepEqual({ announced: sideState(h, announced.id), bystander: sideState(h, bystander.id) }, others);
});

test("installed (W1 with F5 and C1): a delayed Cancel loses to Cancel + Requeue + Call and never clears the new call's counter or acceptance", async () => {
  for (const [requeue, call] of [[true, true], [true, false], [false, true], [false, false]]) {
    const h = harness({ requeue, call });
    const patient = await called(h, 3);
    let raced = false;
    // The delayed request authorized the serving snapshot; before its write, other operators act.
    h.database.beforeRpc = async (name) => {
      if (name !== "cancel_patient_visit" || raced) return undefined;
      raced = true;
      assert.equal((await cancel(h, patient, FRONTDESK, { reason: "Intervening" })).status, 200);
      h.advance();
      const recovered = await h.request("POST", requeue ? "/queue/requeue" : "/queue/undo", { patient_id: patient.id }, FRONTDESK);
      assert.equal(recovered.status, 200, recovered.body.message);
      h.advance();
      assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id }, FRONTDESK)).status, 200);
      return undefined;
    };
    const late = await cancel(h, patient, doctor(3), { reason: "Delayed" });
    assert.equal(late.status, 409, `${requeue}/${call}: ${late.body.message}`);
    const after = row(h, patient.id);
    assert.deepEqual([after.status, after.counter_id, pointer(h, 3)], ["serving", "Doctor 3", patient.id], `${requeue}/${call}: new pair intact`);
    assert.equal(h.settings.isAwaitingAccept(patient.id), true, "the new call still awaits the doctor's Accept");
    assert.notEqual(after.reason, "Delayed");
  }
});

test("installed: the Cancel reason is required and limited to 1000 characters before any database call", async () => {
  const h = harness();
  const patient = await register(h, 1);
  for (const reason of ["", "   ", "x".repeat(1001)]) {
    h.database.calls.length = 0;
    const response = await cancel(h, patient, FRONTDESK, { reason });
    assert.equal(response.status, 400, response.body.message);
    assert.deepEqual(cancelRpcs(h), []);
  }
  const ok = await cancel(h, patient, FRONTDESK, { reason: ` ${"y".repeat(1000)} ` });
  assert.equal(ok.status, 200, ok.body.message);
  assert.equal(row(h, patient.id).reason, "y".repeat(1000));
});

// ---------------------------------------------------------------------------
// Real JWT middleware and Phase A sessions
// ---------------------------------------------------------------------------
test("real middleware: a session revoked between validation and the RPC is 401 (sign in again); permission denials stay 403", async () => {
  const h = createRealAuthHarness({ clock: { now: Date.now() } });
  const register3 = (number, name) => h.service.createQueueEntry({ idNum: name, serviceType: SERVICE[number], mobileNumber: "09170000000" });
  const serving = await register3(1, "Synthetic W1 real D1");
  await h.service.callPatient(serving.id, "Doctor 1");
  const before = clone(h.database.patients.find((entry) => entry.id === serving.id));
  const { token, session } = h.signIn("admin1");
  h.database.beforeRpc = async (name) => {
    if (name === "cancel_patient_visit") session.revoked_at = new Date().toISOString(); // logout lands mid-request
  };
  const revoked = await h.request("POST", "/queue/cancel", { token, body: { patient_id: serving.id, reason: "Synthetic" } });
  assert.equal(revoked.status, 401, revoked.body.message);
  assert.match(revoked.body.message, /expired or was revoked/);
  assert.deepEqual(clone(h.database.patients.find((entry) => entry.id === serving.id)), before);
  assert.equal(h.database.counters[0].current_patient_id, serving.id);
  h.database.beforeRpc = null;
  // The revoked token is now refused by the middleware itself, also with 401.
  assert.equal((await h.request("POST", "/queue/cancel", { token, body: { patient_id: serving.id, reason: "Synthetic" } })).status, 401);

  // Valid sessions without permission: 403. Doctor 1 cannot cancel Doctor 2 or Doctor 3 patients.
  const ob = await register3(2, "Synthetic W1 real D2");
  await h.service.callPatient(ob.id, "Doctor 2");
  const fp = await register3(3, "Synthetic W1 real D3");
  const doctor1 = h.signIn("admin1").token;
  for (const patient of [ob, fp]) {
    const denied = await h.request("POST", "/queue/cancel", { token: doctor1, body: { patient_id: patient.id, reason: "Synthetic" } });
    assert.equal(denied.status, 403, denied.body.message);
  }
  assert.equal(h.database.counters[1].current_patient_id, ob.id);
  // The owner, Frontdesk (both labels) and Superadmin keep their authority.
  assert.equal((await h.request("POST", "/queue/cancel", { token: h.signIn("admin3").token, body: { patient_id: fp.id, reason: "Synthetic" } })).status, 200);
  assert.equal((await h.request("POST", "/queue/cancel", { token: h.signIn("frontdesk2").token, body: { patient_id: ob.id, reason: "Synthetic" } })).status, 200);
  assert.equal(h.database.counters[1].current_patient_id, null);
  assert.equal((await h.request("POST", "/queue/cancel", { token: h.signIn("frontdesk").token, body: { patient_id: serving.id, reason: "Synthetic" } })).status, 200);
  const again = await register3(1, "Synthetic W1 real superadmin");
  await h.service.callPatient(again.id, "Doctor 1");
  assert.equal((await h.request("POST", "/queue/cancel", { token: h.signIn("superadmin").token, body: { patient_id: again.id, reason: "Synthetic" } })).status, 200);
  assert.deepEqual(h.database.counters.map((counter) => counter.current_patient_id), [null, null, null]);
});
