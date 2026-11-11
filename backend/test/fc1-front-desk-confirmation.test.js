// FC1 Front Desk confirmation: routes and service over the isolated fake database and over
// development memory. The real SQL (trigger, confirm_patient_visit, FC1 Call functions) is
// covered by fc1-front-desk-confirmation-postgres.test.js.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHarness } = require("./helpers/queueHarness");

const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const doctor = (n) => ({ id_num: `admin${n}`, role: "admin", doctor_name: `Doctor ${n}` });
const AWAITING = /not been confirmed by the Front Desk/;

async function setup({ localFallback = false } = {}) {
  const h = createHarness({ localFallback });
  h.database.autoConfirmVisits = false;
  h.database.callRpcInstalled = true;
  await h.initialize();
  return h;
}
const register = async (h, name, flags = []) => {
  const response = await h.request("POST", "/queue", { fullName: name, service_type: "consultation", vulnerabilityFlags: flags }, FRONTDESK);
  assert.equal(response.status, 200, response.body.message);
  const overview = await h.service.getQueueOverview();
  return overview.patients.find((p) => p.queue_number === response.body.queue_number);
};
const stored = async (h, id) => h.service.getPatientById(id);

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "fake database";

  test(`${mode}: a new visit is Pending and cannot be called by its doctor or by Superadmin`, async () => {
    const h = await setup({ localFallback });
    const visit = await register(h, "Pending");
    assert.equal(visit.confirmed_at, null);
    assert.equal(visit.confirmed_by, null);
    const byDoctor = await h.request("POST", "/queue/call", { patient_id: visit.id }, doctor(1));
    assert.equal(byDoctor.status, 409);
    assert.match(byDoctor.body.message, AWAITING);
    const bySuperadmin = await h.request("POST", "/queue/call", { patient_id: visit.id, counterId: "Doctor 1" }, SUPERADMIN);
    assert.equal(bySuperadmin.status, 409);
    const after = await stored(h, visit.id);
    assert.equal(after.status, "waiting");
    assert.equal(after.called_at, null);
    assert.equal((await h.service.getCounters())[0].current_patient_id, null);
  });

  test(`${mode}: the Front Desk confirms once; the doctor may then call; nothing else changes`, async () => {
    const h = await setup({ localFallback });
    const visit = await register(h, "Present");
    const confirmed = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
    assert.equal(confirmed.status, 200, confirmed.body.message);
    assert.equal(confirmed.body.already_confirmed, false);
    assert.equal(confirmed.body.patient.confirmed_by, "frontdesk");
    const after = await stored(h, visit.id);
    assert.equal(after.status, "waiting");
    assert.equal(after.counter_id, visit.counter_id);
    assert.equal(after.queue_number, visit.queue_number);
    assert.equal(after.priority_score, visit.priority_score);
    assert.notEqual(after.confirmed_at, null);

    const repeat = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.already_confirmed, true);
    assert.equal((await stored(h, visit.id)).confirmed_at, after.confirmed_at, "the original confirmation is kept");

    const called = await h.request("POST", "/queue/call", { patient_id: visit.id }, doctor(1));
    assert.equal(called.status, 200, called.body.message);
    assert.equal((await stored(h, visit.id)).status, "serving");
  });

  test(`${mode}: doctors and Superadmin cannot confirm; cancelled visits cannot be confirmed`, async () => {
    const h = await setup({ localFallback });
    const visit = await register(h, "Authority");
    for (const user of [doctor(1), doctor(2), SUPERADMIN]) {
      const response = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, user);
      assert.equal(response.status, 403, user.id_num);
    }
    assert.equal((await stored(h, visit.id)).confirmed_at, null);
    assert.equal((await h.request("POST", "/queue/confirm", { patient_id: 0 }, FRONTDESK)).status, 400);

    const cancelled = await h.request("POST", "/queue/cancel", { patient_id: visit.id, reason: "Left" }, FRONTDESK);
    assert.equal(cancelled.status, 200, cancelled.body.message);
    const refused = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
    assert.equal(refused.status, 409);
    assert.equal((await stored(h, visit.id)).confirmed_at, null);
  });

  test(`${mode}: the doctor's next patient is its highest-priority confirmed visit; pending visits keep their rank`, async () => {
    const h = await setup({ localFallback });
    const senior = await register(h, "Senior", ["senior"]);
    const regular = await register(h, "Regular");
    await h.request("POST", "/queue/confirm", { patient_id: regular.id }, FRONTDESK);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: regular.id }, doctor(1))).status, 200);
    const pending = await stored(h, senior.id);
    assert.equal(pending.status, "waiting");
    assert.equal(pending.priority_score, senior.priority_score);
  });

  test(`${mode}: Re-queue needs a new confirmation`, async () => {
    const h = await setup({ localFallback });
    const visit = await register(h, "Requeue");
    await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
    await h.request("POST", "/queue/cancel", { patient_id: visit.id, reason: "Out" }, FRONTDESK);
    if (!localFallback) h.database.requeueRpcInstalled = true;
    const requeued = await h.request("POST", "/queue/requeue", { patient_id: visit.id }, FRONTDESK);
    assert.equal(requeued.status, 200, requeued.body.message);
    const after = await stored(h, visit.id);
    assert.equal(after.status, "waiting");
    assert.equal(after.confirmed_at, null);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: visit.id }, doctor(1))).status, 409);
  });
}

test("fake database: a database without the FC1 columns refuses every Call (fail closed) and changes nothing", async () => {
  const h = await setup();
  const visit = await register(h, "No migration");
  for (const row of h.database.patients) { delete row.confirmed_at; delete row.confirmed_by; }
  const before = JSON.stringify(h.database.patients);
  const called = await h.request("POST", "/queue/call", { patient_id: visit.id }, doctor(1));
  assert.equal(called.status, 503);
  assert.match(called.body.message, /20261111-fc1-front-desk-confirmation\.sql/);
  const confirmed = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
  assert.equal(confirmed.status, 503);
  assert.equal(JSON.stringify(h.database.patients), before);
  assert.equal(h.database.calls.some((c) => c.action === "rpc" && c.function === "call_patient_visit"), false);
});

test("fake database: a missing confirm function reports the migration; a database refusal of an unconfirmed Call is 409", async () => {
  const h = await setup();
  const visit = await register(h, "Partial install");
  h.database.confirmRpcInstalled = false;
  const confirmed = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
  assert.equal(confirmed.status, 503);
  assert.match(confirmed.body.message, /20261111-fc1-front-desk-confirmation\.sql/);

  // The backend read the visit as confirmed, but the database (the authority) says it is not.
  h.database.patients.find((p) => p.id === visit.id).confirmed_at = new Date(h.clock.now).toISOString();
  h.database.patients.find((p) => p.id === visit.id).confirmed_by = "frontdesk";
  h.database.beforeRpc = (name) => (name === "call_patient_visit"
    ? { data: null, error: { code: "P0001", hint: "awaiting_front_desk_confirmation", message: "not confirmed" } } : null);
  const called = await h.request("POST", "/queue/call", { patient_id: visit.id }, doctor(1));
  assert.equal(called.status, 409);
  assert.match(called.body.message, AWAITING);
  assert.equal((await stored(h, visit.id)).status, "waiting");
});

test("fake database: Confirm writes only through confirm_patient_visit and never runs the doctor dispatcher", async () => {
  const h = await setup();
  const visit = await register(h, "Isolation");
  const countersBefore = JSON.stringify(h.database.counters);
  const callsBefore = h.database.calls.length;
  const confirmed = await h.request("POST", "/queue/confirm", { patient_id: visit.id }, FRONTDESK);
  assert.equal(confirmed.status, 200, confirmed.body.message);
  const made = h.database.calls.slice(callsBefore);
  assert.deepEqual(made.filter((c) => c.action === "rpc").map((c) => c.function), ["confirm_patient_visit"]);
  assert.equal(made.some((c) => c.action === "update" || c.action === "insert"), false);
  assert.equal(JSON.stringify(h.database.counters), countersBefore);
  const queue = await h.request("GET", "/queue", {}, FRONTDESK);
  assert.equal(queue.body.patients.find((p) => p.id === visit.id).confirmed_by, "frontdesk");
});
