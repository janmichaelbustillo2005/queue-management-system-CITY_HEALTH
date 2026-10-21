const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");

const registration = (name, service = "checkup") => ({
  idNum: name, serviceType: service, vulnerabilityFlags: []
});

test("Frontdesk can see and cancel yesterday's serving visit before calling today's queue", async () => {
  const h = createHarness();
  const previous = await h.service.createQueueEntry(registration("Previous visit"));
  await h.service.callPatient(previous.id, "Doctor 1");
  h.advance(24 * 60 * 60 * 1000);
  const next = await h.service.createQueueEntry(registration("Today's visit"));

  const overview = await h.request("GET", "/queue");
  assert.equal(overview.status, 200);
  assert.equal(overview.body.patients.filter((row) => row.id === previous.id).length, 1);
  assert.equal(overview.body.patients.find((row) => row.id === previous.id).status, "serving");
  assert.equal(overview.body.counters[0].current_patient_id, previous.id);
  const stats = await h.service.getQueueStats();
  assert.equal(stats.serving, 1, "active serving counts include the carryover visit");
  assert.equal(stats.today_total_patients, 1, "daily registration totals keep their Manila date range");
  assert.equal((await h.request("POST", "/queue/call", { patient_id: next.id, counterId: "Doctor 1" })).status, 400);

  assert.equal((await h.request("POST", "/queue/cancel", {
    patient_id: previous.id, counter_id: "Doctor 1", reason: "Previous visit did not proceed"
  })).status, 200);
  assert.equal((await h.request("POST", "/queue/call", { patient_id: next.id, counterId: "Doctor 1" })).status, 200);
  assert.equal((await h.service.getPatientById(previous.id)).status, "cancelled");
  assert.equal((await h.service.getPatientById(next.id)).status, "serving");
});

test("queue overview includes unassigned carryover serving visits without duplicating today's rows", async () => {
  const h = createHarness();
  const previous = await h.service.createQueueEntry(registration("Legacy carryover"));
  Object.assign(h.database.patients[0], { status: "serving", counter_id: null });
  h.advance(24 * 60 * 60 * 1000);
  const current = await h.service.createQueueEntry(registration("Current prenatal", "prenatal"));
  await h.service.callPatient(current.id, "Doctor 2");

  const before = clone(h.database.patients);
  const overview = await h.service.getQueueOverview();
  assert.deepEqual(clone(overview.patients.map((row) => row.id)).sort(), [previous.id, current.id]);
  assert.deepEqual(clone(h.database.patients), before, "reading the queue never resolves active visits automatically");
});

test("a carryover read failure reports unavailable instead of hiding the blocking patient", async () => {
  const h = createHarness();
  const previous = await h.service.createQueueEntry(registration("Preserved carryover"));
  await h.service.callPatient(previous.id, "Doctor 1");
  h.advance(24 * 60 * 60 * 1000);
  const before = clone(h.database.patients);
  h.database.beforeQuery = (query) => {
    if (query.table === "patients" && query.action === "select" && query.columns === "*" && query.orders.length === 0) {
      return { data: null, error: { message: "Isolated carryover read failure" } };
    }
  };
  const response = await h.request("GET", "/queue");
  assert.equal(response.status, 503);
  assert.deepEqual(clone(h.database.patients), before);
  assert.equal(h.database.counters[0].current_patient_id, previous.id);
});

for (const localFallback of [false, true]) {
  for (const [service, doctor] of [["checkup", "Doctor 1"], ["prenatal", "Doctor 2"], ["family_planning", "Doctor 3"]]) {
    test(`${localFallback ? "local" : "Supabase double"}: Undo keeps ${doctor}'s patient waiting without reserving any doctor`, async () => {
      const h = createHarness({ localFallback });
      await h.initialize();
      const patient = await h.service.createQueueEntry(registration("Undo visit", service));
      assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: doctor })).status, 200);
      assert.equal((await h.request("POST", "/queue/cancel", {
        patient_id: patient.id, counter_id: doctor, reason: "Isolated cancellation"
      })).status, 200);
      assert.equal((await h.request("POST", "/queue/undo", { patient_id: patient.id })).status, 200);

      const overview = await h.service.getQueueOverview();
      assert.ok(overview.counters.every((counter) => counter.current_patient_id == null));
      assert.equal(overview.patients.find((row) => row.id === patient.id).status, "waiting");
      const called = await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: doctor });
      assert.equal(called.status, 200, called.body.message);
      assert.equal((await h.service.getQueueOverview()).counters.find((counter) => counter.id_num === doctor).current_patient_id, patient.id);
    });
  }
}
