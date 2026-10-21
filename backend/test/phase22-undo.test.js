const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const baseTime = Date.parse("2026-10-14T01:00:00.000Z");
const services = ["consultation", "prenatal", "family_planning"];
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function setup(localFallback = false, options = {}) {
  const h = createHarness({ localFallback, clock: { now: baseTime }, ...options });
  await h.initialize();
  return h;
}
async function active(h, number) {
  const patient = await h.service.createQueueEntry({ idNum: `Patient ${number}`, serviceType: services[number - 1],
    mobileNumber: "000", vulnerabilityFlags: ["senior"] });
  assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
  h.advance();
  assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number))).status, 200);
  h.advance();
  const started = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(number));
  assert.equal(started.status, 200, started.body.message);
  return patient;
}
async function cancel(h, patient, number) {
  h.advance();
  const response = await h.request("POST", "/queue/cancel", {
    patient_id: patient.id, reason: "Cancelled after start", counter_id: `Doctor ${number}`
  }, doctor(number));
  assert.equal(response.status, 200, response.body.message);
  return clone(await h.service.getPatientById(patient.id));
}
const cleanWaiting = (after, before) => {
  assert.equal(after.status, "waiting");
  for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(after[field], null, field);
  for (const field of ["created_at", "priority_score", "service_type", "reason", "queue_number", "vulnerability_flags"]) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.notEqual(after.visit_state_revision, before.visit_state_revision);
};

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "deployed RPC model";
  for (const number of [1, 2, 3]) {
    test(`Phase 2.2 ${mode}: Doctor ${number} call/accept/start/cancel/Undo returns clean waiting and can be called again`, async () => {
      const h = await setup(localFallback);
      const patient = await active(h, number);
      // Other doctors' consultations must survive this Undo and the next Call.
      for (const other of [1, 2, 3].filter(value => value !== number)) await active(h, other);
      const before = await cancel(h, patient, number);
      const countersBefore = clone((await h.service.getQueueOverview()).counters);
      const othersBefore = clone((await h.service.getQueueOverview()).patients.filter(row => row.id !== patient.id));
      const response = await h.request("POST", "/queue/undo", { patient_id: patient.id });
      assert.equal(response.status, 200, response.body.message);
      cleanWaiting(await h.service.getPatientById(patient.id), before);
      assert.deepEqual(clone((await h.service.getQueueOverview()).counters), countersBefore);
      assert.deepEqual(clone((await h.service.getQueueOverview()).patients.filter(row => row.id !== patient.id)), othersBefore);
      const repeated = await h.request("POST", "/queue/undo", { patient_id: patient.id });
      assert.equal(repeated.status, 400);
      assert.deepEqual(clone((await h.service.getQueueOverview()).counters), countersBefore);
      const called = await h.request("POST", "/queue/call", { patient_id: patient.id });
      assert.equal(called.status, 200, called.body.message);
      const afterCall = await h.service.getPatientById(patient.id);
      assert.equal(afterCall.counter_id, `Doctor ${number}`);
      assert.equal(afterCall.status, "serving");
      const countersAfter = (await h.service.getQueueOverview()).counters;
      assert.equal(countersAfter[number - 1].current_patient_id, patient.id);
      for (const other of [1, 2, 3].filter(value => value !== number)) {
        assert.deepEqual(clone(countersAfter[other - 1]), countersBefore[other - 1]);
      }
      h.advance();
      assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number))).status, 200);
      assert.equal((await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctor(number))).status, 200);
    });
  }

  test(`Phase 2.2 ${mode}: Undo clears every stale pointer to this patient and preserves busy/offline counters`, async () => {
    const h = await setup(localFallback);
    const patient = await active(h, 2);
    const busy = await active(h, 3);
    const before = await cancel(h, patient, 2);
    if (localFallback) {
      // The existing local availability setter returns the in-memory row;
      // overview counters are presentation copies and cannot inject state.
      (await h.service.setCounterOnline("Doctor 1", false)).current_patient_id = patient.id;
      (await h.service.setCounterOnline("Doctor 2", true)).current_patient_id = patient.id;
    } else {
      h.database.counters[0].current_patient_id = patient.id;
      h.database.counters[0].is_online = false;
      h.database.counters[1].current_patient_id = patient.id;
    }
    const state = counters => clone(counters.map(({ id, id_num, service_types, is_online, current_patient_id }) =>
      ({ id, id_num, service_types, is_online, current_patient_id })));
    const countersBefore = state((await h.service.getQueueOverview()).counters);
    const response = await h.request("POST", "/queue/undo", { patient_id: patient.id });
    assert.equal(response.status, 200, response.body.message);
    cleanWaiting(await h.service.getPatientById(patient.id), before);
    const countersAfter = (await h.service.getQueueOverview()).counters;
    assert.deepEqual(state(countersAfter), countersBefore.map(counter => ({ ...counter,
      current_patient_id: counter.current_patient_id === patient.id ? null : counter.current_patient_id })));
    assert.equal(countersAfter[2].current_patient_id, busy.id);
  });

  test(`Phase 2.2 ${mode}: busy correct counter is never overwritten by Undo`, async () => {
    const h = await setup(localFallback);
    const patient = await active(h, 2);
    const before = await cancel(h, patient, 2);
    const busy = await active(h, 2);
    const countersBefore = clone((await h.service.getQueueOverview()).counters);
    assert.equal((await h.request("POST", "/queue/undo", { patient_id: patient.id })).status, 200);
    cleanWaiting(await h.service.getPatientById(patient.id), before);
    assert.deepEqual(clone((await h.service.getQueueOverview()).counters), countersBefore);
    const called = await h.request("POST", "/queue/call", { patient_id: patient.id });
    assert.equal(called.status, 400);
    assert.match(called.body.message, /already serving/);
    assert.equal((await h.service.getQueueOverview()).counters[1].current_patient_id, busy.id);
  });
}

test("Phase 2.2 RPC model: competing Undo/Requeue consumes one terminal revision and preserves unrelated counters", { timeout: 10000 }, async () => {
  const database = createDatabase();
  const files = new Map();
  const first = await setup(false, { database, files });
  const second = await setup(false, { database, files, clock: first.clock });
  const patient = await active(first, 2);
  await cancel(first, patient, 2);
  const countersBefore = clone(database.counters);
  const entered = deferred();
  const resume = deferred();
  let waiting = 0;
  database.beforeRpc = async name => {
    if (!["recover_patient_visit", "undo_patient_visit_waiting"].includes(name)) return;
    if (++waiting === 2) entered.resolve();
    await resume.promise;
  };
  const requests = [first.request("POST", "/queue/undo", { patient_id: patient.id }),
    second.request("POST", "/queue/requeue", { patient_id: patient.id })];
  try { await entered.promise; } finally { resume.resolve(); }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.deepEqual(clone(database.counters), countersBefore);
  assert.equal(database.patients[0].status, "waiting");
});

test("Phase 2.2 RPC model: a delayed Undo cannot clear counters from a newer call/start cycle", { timeout: 10000 }, async () => {
  const database = createDatabase();
  const files = new Map();
  const first = await setup(false, { database, files });
  const second = await setup(false, { database, files, clock: first.clock });
  const patient = await active(first, 2);
  await cancel(first, patient, 2);
  const entered = deferred();
  const resume = deferred();
  let paused = false;
  database.beforeRpc = async (name, args) => {
    if (name === "undo_patient_visit_waiting" && args.p_action === "undo" && !paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
  };
  const delayed = first.request("POST", "/queue/undo", { patient_id: patient.id });
  await entered.promise;
  let before;
  try {
    assert.equal((await second.request("POST", "/queue/undo", { patient_id: patient.id })).status, 200);
    assert.equal((await second.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    second.advance();
    assert.equal((await second.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(2))).status, 200);
    second.advance();
    assert.equal((await second.request("POST", "/queue/start", { patient_id: patient.id }, doctor(2))).status, 200);
    before = { patients: clone(database.patients), counters: clone(database.counters) };
  } finally { resume.resolve(); }
  assert.equal((await delayed).status, 409);
  assert.deepEqual({ patients: clone(database.patients), counters: clone(database.counters) }, before);
});

test("Phase 2.2 RPC model: a missing versioned Undo RPC fails before writes and never retries the old recovery RPC", async () => {
  const h = await setup();
  const patient = await active(h, 2);
  await cancel(h, patient, 2);
  const before = { patients: clone(h.database.patients), counters: clone(h.database.counters) };
  h.database.beforeRpc = async name => {
    assert.equal(name, "undo_patient_visit_waiting");
    return { data: null, error: { code: "PGRST202", message: "Versioned Undo RPC not installed" } };
  };
  const response = await h.request("POST", "/queue/undo", { patient_id: patient.id });
  assert.equal(response.status, 503);
  assert.match(response.body.message, /Phase 2\.2 database migration/);
  assert.deepEqual({ patients: clone(h.database.patients), counters: clone(h.database.counters) }, before);
  assert.equal(h.database.calls.filter(call => call.function === "recover_patient_visit").length, 0);
});
