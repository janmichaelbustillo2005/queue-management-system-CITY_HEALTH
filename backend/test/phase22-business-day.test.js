const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");
const { getBusinessDate, getBusinessDayRange } = require("../src/lib/businessDay");

const beforeMidnight = Date.parse("2026-10-10T15:59:20.000Z");
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const registration = (name, serviceType = "consultation") => ({ idNum: name, serviceType, vulnerabilityFlags: [] });

async function setup(localFallback) {
  const h = createHarness({ localFallback, clock: { now: beforeMidnight } });
  await h.initialize();
  return h;
}

async function stored(h, patient, localFallback) {
  return localFallback ? h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
}

async function startPatient(h, number) {
  const serviceType = ["consultation", "prenatal", "family_planning"][number - 1];
  const patient = await h.service.createQueueEntry(registration(`Midnight Doctor ${number}`, serviceType));
  await h.service.callPatient(patient.id, `Doctor ${number}`);
  assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number))).status, 200);
  h.advance(1000);
  await h.service.startConsultation(patient.id, doctor(number));
  return patient;
}

test("Manila business dates change at 16:00 UTC and use exclusive next midnight", () => {
  assert.equal(getBusinessDate("2026-10-10T15:59:59.999Z"), "2026-10-10");
  assert.equal(getBusinessDate("2026-10-10T16:00:00.000Z"), "2026-10-11");
  for (const instant of ["2026-10-11T00:00:00+08:00", "2026-10-10T09:00:00-07:00"]) {
    assert.equal(getBusinessDate(instant), "2026-10-11");
  }
  assert.deepEqual(getBusinessDayRange("2026-10-11"), {
    start: "2026-10-10T16:00:00.000Z", end: "2026-10-11T16:00:00.000Z"
  });
  for (const invalid of ["2026-02-30", "2026-13-01", "2026-1-1", "", "not a date"]) {
    assert.throws(() => getBusinessDayRange(invalid));
  }
});

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "mock Supabase";

  test(`${mode}: serving patients stay visible across midnight while previous waiting/history stays out`, async () => {
    const h = await setup(localFallback);
    const first = await startPatient(h, 1);
    const second = await startPatient(h, 2);
    const waiting = await h.service.createQueueEntry(registration("Yesterday waiting", "family_planning"));
    const completed = await h.service.createQueueEntry(registration("Yesterday completed"));
    Object.assign(await stored(h, completed, localFallback), { status: "completed", completed_at: new Date(h.clock.now).toISOString() });
    const cancelled = await h.service.createQueueEntry(registration("Yesterday cancelled"));
    await h.service.cancelPatient(cancelled.id);
    const noShow = await h.service.createQueueEntry(registration("Yesterday no-show"));
    Object.assign(await stored(h, noShow, localFallback), { status: "no-show", completed_at: new Date(h.clock.now).toISOString() });
    const before = await h.service.getQueueOverview();
    assert.equal(before.patients.filter((row) => row.status === "serving").length, 2);
    h.advance(60000);
    const todayWaiting = await h.service.createQueueEntry(registration("Today's waiting", "family_planning"));
    const after = await h.service.getQueueOverview();
    assert.deepEqual(clone(after.patients.map((row) => row.id)), [first.id, second.id, todayWaiting.id]);
    for (const excluded of [waiting, completed, cancelled, noShow]) assert.ok(!after.patients.some((row) => row.id === excluded.id));
    assert.equal(after.counters[0].current_patient_id, first.id);
    assert.equal(after.counters[1].current_patient_id, second.id);
    assert.equal(after.patients.find((row) => row.id === second.id).counter_id, "Doctor 2");
    const display = await h.service.getDisplayData();
    assert.deepEqual(clone(display.all_serving.map((row) => row.id).sort()), [first.id, second.id]);
    assert.deepEqual(clone(display.waiting_queue.map((row) => row.id)), [todayWaiting.id]);
    assert.equal(display.voice_announcements.length, 2);
    assert.deepEqual(clone(await h.service.getQueueStats()), { waiting: 1, serving: 2, completed: 0, today_total_patients: 1 });
    assert.equal((await h.service.findActiveDuplicate({ idNum: "Midnight Doctor 2" })).id, second.id);
  });

  test(`${mode}: only the assigned doctor completes the prior-day consultation after midnight`, async () => {
    const h = await setup(localFallback);
    const patient = await startPatient(h, 2);
    const before = clone(await h.service.getPatientById(patient.id));
    h.advance(60000);
    const wrong = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(1));
    assert.equal(wrong.status, 403);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    const completed = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(2));
    assert.equal(completed.status, 200, completed.body.message);
    const record = await h.service.getPatientById(patient.id);
    assert.equal(record.status, "completed");
    assert.equal(record.consultation_started_at, before.consultation_started_at);
    assert.equal(completed.body.patient.service_duration_seconds, 60);
    const after = await h.service.getQueueOverview();
    assert.equal(after.counters[1].current_patient_id, null);
    assert.equal(after.patients.length, 0, "A historical completed registration leaves the active dashboard");
    assert.equal((await h.service.getDisplayData()).voice_announcements.length, 0);
  });

  test(`${mode}: today's authorized call ignores previous-day waiting priority`, async () => {
    const h = await setup(localFallback);
    const old = await h.service.createQueueEntry(registration("Old high priority", "family_planning"));
    (await stored(h, old, localFallback)).priority_score = 100;
    h.advance(60000);
    const today = await h.service.createQueueEntry(registration("Today's family planning", "family_planning"));
    await assert.rejects(h.service.callPatient(old.id, "Doctor 3"), /next eligible patient/i);
    await h.service.callPatient(today.id, "Doctor 3");
    assert.equal((await h.service.getPatientById(old.id)).status, "waiting");
    assert.equal((await h.service.getPatientById(today.id)).status, "serving");
    assert.equal((await h.service.getQueueOverview()).counters[2].current_patient_id, today.id);
  });

  test(`${mode}: today's reset preserves prior-day active counter, consultation and acceptance`, async () => {
    const h = await setup(localFallback);
    const old = await startPatient(h, 2);
    const oldWaiting = await h.service.createQueueEntry(registration("Yesterday uncalled", "family_planning"));
    const oldRecord = clone(await h.service.getPatientById(old.id));
    const acceptedAt = h.settings.getAcceptedAt(old.id);
    h.advance(60000);
    const today = await startPatient(h, 1);
    const todayWaiting = await h.service.createQueueEntry(registration("Today's uncalled", "family_planning"));
    const response = await h.request("POST", "/queue/clear", {}, superadmin);
    assert.equal(response.status, 200, response.body.message);
    assert.deepEqual(clone(await h.service.getPatientById(old.id)), oldRecord);
    assert.equal((await h.service.getPatientById(oldWaiting.id)).status, "waiting");
    assert.equal((await h.service.getPatientById(today.id)).status, "cancelled");
    assert.equal((await h.service.getPatientById(todayWaiting.id)).status, "cancelled");
    assert.equal(h.settings.getAcceptedAt(old.id), acceptedAt);
    assert.equal(h.settings.getAcceptedAt(today.id), null);
    const after = await h.service.getQueueOverview();
    assert.equal(after.counters[0].current_patient_id, null);
    assert.equal(after.counters[1].current_patient_id, old.id);
    assert.deepEqual(clone((await h.service.getDisplayData()).voice_announcements.map((event) => event.id)), [old.id]);
    h.advance(1000);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: old.id }, doctor(2))).status, 200);
  });
}

test("mock Supabase: active retrieval and call priority page beyond 1000 under a smaller server cap", async () => {
  const h = await setup(false);
  h.database.maxRows = 73;
  for (let id = 1105; id >= 1; id -= 1) {
    h.database.patients.push({ id, id_num: `Paged patient ${id}`, queue_number: `GP-${id}`,
      service_type: "consultation", status: "waiting", created_at: "2026-10-10T01:00:00.000Z",
      priority_score: id === 1105 ? 100 : 0, counter_id: null, called_at: null, completed_at: null });
  }
  h.database.patients.push({ id: 2000, id_num: "Old serving", queue_number: "OB-001", service_type: "prenatal",
    status: "serving", created_at: "2026-10-09T01:00:00.000Z", counter_id: "Doctor 2", called_at: "2026-10-09T01:01:00.000Z" });
  h.database.counters[1].current_patient_id = 2000;
  const overview = await h.service.getQueueOverview();
  assert.equal(overview.patients.length, 1106);
  assert.equal(new Set(overview.patients.map((row) => row.id)).size, 1106);
  assert.deepEqual(clone(overview.patients.slice(0, 4).map((row) => row.id)), [2000, 1, 2, 3]);
  await assert.rejects(h.service.callPatient(1, "Doctor 1"), /next eligible patient/i);
  await h.service.callPatient(1105, "Doctor 1");
  assert.equal(h.database.counters[0].current_patient_id, 1105);
  assert.equal(h.database.counters[1].current_patient_id, 2000);
});

test("mock Supabase: day query includes the last PostgreSQL microsecond and excludes next midnight waiting", async () => {
  const h = await setup(false);
  h.database.patients.push(
    { id: 1, service_type: "consultation", status: "waiting", created_at: "2026-10-11T00:00:00+08:00" },
    { id: 2, service_type: "consultation", status: "waiting", created_at: "2026-10-10T15:59:59.999999Z" },
    { id: 3, service_type: "consultation", status: "waiting", created_at: "2026-10-10T00:00:00+08:00" }
  );
  assert.deepEqual(clone((await h.service.getQueueOverview()).patients.map((row) => row.id)), [3, 2]);
});

test("mock Supabase: reset under a one-row response cap clears every archived pointer and acceptance", async () => {
  const h = await setup(false);
  const old = await startPatient(h, 2);
  const oldRecord = clone(await h.service.getPatientById(old.id));
  const oldAcceptedAt = h.settings.getAcceptedAt(old.id);
  h.advance(60000);
  const first = await startPatient(h, 1);
  const third = await startPatient(h, 3);
  const waiting = [];
  for (let number = 0; number < 4; number += 1) {
    waiting.push(await h.service.createQueueEntry(registration(`Today reset waiting ${number}`)));
  }
  h.database.maxRows = 1;
  const response = await h.request("POST", "/queue/clear", {}, superadmin);
  assert.equal(response.status, 200, response.body.message);
  for (const patient of [first, third, ...waiting]) {
    assert.equal((await h.service.getPatientById(patient.id)).status, "cancelled");
    assert.equal(h.settings.getAcceptedAt(patient.id), null);
    assert.equal(h.settings.isAwaitingAccept(patient.id), false);
  }
  assert.equal(h.database.counters[0].current_patient_id, null);
  assert.equal(h.database.counters[2].current_patient_id, null);
  assert.equal(h.database.counters[1].current_patient_id, old.id);
  assert.deepEqual(clone(await h.service.getPatientById(old.id)), oldRecord);
  assert.equal(h.settings.getAcceptedAt(old.id), oldAcceptedAt);
});
