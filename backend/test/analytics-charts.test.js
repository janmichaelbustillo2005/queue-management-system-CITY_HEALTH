const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");

const clockTime = Date.parse("2026-10-11T08:00:00.000Z");
// Synthetic visits only. Times are UTC; Manila is UTC+8.
const visits = [
  { id_num: "Synthetic A", service_type: "consultation", counter_id: "Doctor 1", status: "completed",
    created_at: "2026-10-09T01:00:00.000Z", called_at: "2026-10-09T01:10:00.000Z",
    consultation_started_at: "2026-10-09T01:10:00.000Z", completed_at: "2026-10-09T01:16:00.000Z",
    sex: "male", birthdate: "1950-05-01", residency: "Poblacion 1", vulnerability_flags: ["senior", "pwd"] },
  { id_num: "Synthetic B", service_type: "prenatal", counter_id: "doctor 2", status: "no-show",
    created_at: "2026-10-09T03:30:00.000Z", sex: "Female", birthdate: "2000-10-10",
    residency: "  poblacion   1 ", vulnerability_flags: ["pregnant"] },
  { id_num: "Synthetic C", service_type: "family_planning", counter_id: null, status: "cancelled",
    created_at: "2026-10-11T00:00:00.000Z", sex: "", birthdate: null, residency: "", vulnerability_flags: [] },
  { id_num: "Synthetic D", service_type: "checkup", counter_id: null, status: "waiting",
    created_at: "2026-10-11T05:00:00.000Z", sex: "F", birthdate: "2024-01-01", residency: "Sumile", vulnerability_flags: [] }
];

async function setup(localFallback, fixtures = visits) {
  const h = createHarness({ localFallback, clock: { now: clockTime } });
  await h.initialize();
  for (const fixture of fixtures) {
    const patient = await h.service.createQueueEntry({ idNum: fixture.id_num, serviceType: "consultation", vulnerabilityFlags: [] });
    const stored = localFallback ? await h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
    Object.assign(stored, fixture);
  }
  return h;
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "mock Supabase";

  test(`${mode}: hours are in clock order with empty hours shown as zero`, async () => {
    const h = await setup(localFallback);
    const { charts } = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    // 09:00 is registered on the first day and 08:00 only on the last day.
    assert.deepEqual(clone(charts.hourly.labels), ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"]);
    assert.deepEqual(clone(charts.hourly.data), [1, 1, 0, 1, 0, 1]);
  });

  test(`${mode}: patients per day lists every day of a bounded range, including days without visits`, async () => {
    const h = await setup(localFallback);
    const { charts } = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    assert.deepEqual(clone(charts.dailyTrends.labels), ["Oct 9, 2026", "Oct 10, 2026", "Oct 11, 2026"]);
    assert.deepEqual(clone(charts.dailyTrends.data), [2, 0, 2]);
  });

  test(`${mode}: ranges longer than a year list only days with visits`, async () => {
    const h = await setup(localFallback);
    const { charts } = await h.service.getAnalytics("2024-01-01", "2026-10-11");
    assert.deepEqual(clone(charts.dailyTrends.labels), ["Oct 9, 2026", "Oct 11, 2026"]);
  });

  test(`${mode}: categories keep a fixed order with readable sex, age, residency and priority groups`, async () => {
    const h = await setup(localFallback);
    const { charts } = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    assert.deepEqual(clone(charts.serviceTypes), { labels: ["consultation", "checkup", "prenatal", "family_planning"], data: [1, 1, 1, 1] });
    assert.deepEqual(clone(charts.status), { labels: ["waiting", "completed", "cancelled", "no-show"], data: [1, 1, 1, 1] });
    assert.deepEqual(clone(charts.sexDistribution), { labels: ["Male", "Female", "Not recorded"], data: [1, 2, 1] });
    // B turns 26 the day after the visit, so is still 25 (18–35) on that date.
    assert.deepEqual(clone(charts.ageGroups), { labels: ["0–5", "18–35", "60+", "Not recorded"], data: [1, 1, 1, 1] });
    assert.deepEqual(clone(charts.residency), { labels: ["Poblacion 1", "Sumile", "Not recorded"], data: [2, 1, 1] });
    assert.deepEqual(clone(charts.priorityCategories), { labels: ["senior", "pwd", "pregnant", "regular"], data: [1, 1, 1, 2] });
  });

  test(`${mode}: service and doctor tables include no-show and in-queue counts with overall totals`, async () => {
    const h = await setup(localFallback);
    const analytics = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    const prenatal = analytics.tableData.find((row) => row.service_type === "prenatal");
    assert.equal(prenatal.no_show, 1);
    assert.equal(prenatal.completion_rate, "0.0");
    assert.deepEqual(clone(analytics.totals), {
      total_patients: 4, completed: 1, cancelled: 1, no_show: 1, waiting: 1, serving: 0,
      avg_wait_time: "10.0", avg_service_time: "6.0", completion_rate: "25.0"
    });
    assert.deepEqual(clone(analytics.doctorTable.map(({ doctor, total_patients, completed, cancelled, no_show, waiting }) =>
      [doctor, total_patients, completed, cancelled, no_show, waiting])), [
      ["Doctor 1", 2, 1, 0, 0, 1],
      ["Doctor 2", 1, 0, 0, 1, 0],
      ["Doctor 3", 1, 0, 1, 0, 0]
    ]);
    assert.equal(analytics.doctorTable[0].avg_service_time, "6.0");
  });

  test(`${mode}: a legacy numeric counter id is reported under its doctor`, async () => {
    const h = await setup(localFallback, [visits[0]]);
    const doctorTwo = (await h.service.getCounters()).find((counter) => counter.id_num === "Doctor 2");
    const [stored] = localFallback ? [await h.service.getPatientById(1)] : h.database.patients;
    stored.counter_id = String(doctorTwo.id);
    const { doctorTable } = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    assert.deepEqual(clone(doctorTable.map((row) => row.doctor)), ["Doctor 2"]);
  });
}
