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
  { id_num: "Synthetic B", service_type: "prenatal", counter_id: "doctor 2", status: "cancelled",
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
    assert.deepEqual(clone(charts.serviceTypes), { labels: ["family_planning", "consultation", "checkup", "prenatal"], data: [1, 1, 1, 1] });
    assert.deepEqual(clone(charts.status), { labels: ["waiting", "completed", "cancelled"], data: [1, 1, 2] });
    assert.deepEqual(clone(charts.sexDistribution), { labels: ["Male", "Female", "Not recorded"], data: [1, 2, 1] });
    // B turns 26 the day after the visit, so is still 25 (18–35) on that date.
    assert.deepEqual(clone(charts.ageGroups), { labels: ["0–5", "18–35", "60+", "Not recorded"], data: [1, 1, 1, 1] });
    assert.deepEqual(clone(charts.residency), { labels: ["Poblacion 1", "Sumile", "Not recorded"], data: [2, 1, 1] });
    assert.deepEqual(clone(charts.priorityCategories), { labels: ["senior", "pwd", "pregnant", "regular"], data: [1, 1, 1, 2] });
  });

  test(`${mode}: service and doctor tables include cancelled and in-queue counts with overall totals`, async () => {
    const h = await setup(localFallback);
    const analytics = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    const prenatal = analytics.tableData.find((row) => row.service_type === "prenatal");
    assert.equal(prenatal.cancelled, 1);
    assert.equal("no_show" in prenatal, false);
    assert.equal(prenatal.completion_rate, "0.0");
    assert.deepEqual(clone(analytics.totals), {
      total_patients: 4, completed: 1, cancelled: 2, waiting: 1, serving: 0,
      avg_wait_time: "10.0", avg_service_time: "6.0", completion_rate: "25.0"
    });
    assert.deepEqual(clone(analytics.doctorTable.map(({ doctor, total_patients, completed, cancelled, waiting }) =>
      [doctor, total_patients, completed, cancelled, waiting])), [
      ["Doctor 1", 2, 1, 0, 1],
      ["Doctor 2", 1, 0, 1, 0],
      ["Doctor 3", 1, 0, 1, 0]
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

// Patient Age Groups: age is whole years on the visit's Asia/Manila date (birthday reached or not).
test("age at visit follows the calendar, not the birth year", async () => {
  const h = createHarness({ localFallback: true, clock: { now: clockTime } });
  const age = h.service.getAgeAtVisit;
  const visit = "2026-11-18T02:00:00.000Z"; // Nov 18, 2026 10:00 Manila
  assert.equal(age("2000-11-20", visit), 25, "birthday two days after the visit: still 25");
  assert.equal(age("2000-11-18", visit), 26, "birthday on the visit date counts");
  assert.equal(age("2000-11-17", visit), 26);
  assert.equal(age("2026-11-18", visit), 0, "born on the visit date");
  assert.equal(age("2026-11-19", visit), null, "a birthdate after the visit is not an age");
  for (const bad of ["2001-02-30", "2001-13-01", "2001-00-10", "2001-1-5", "not a date", "", null, undefined]) {
    assert.equal(age(bad, visit), null, `invalid birthdate ${bad}`);
  }
  assert.equal(age("2004-02-29", "2026-02-28T02:00:00.000Z"), 21, "leap-day birthday not yet reached on Feb 28");
  assert.equal(age("2004-02-29", "2026-03-01T02:00:00.000Z"), 22);
  // 16:30 UTC on Nov 17 is already Nov 18 in Manila, so the birthday has been reached.
  assert.equal(age("2000-11-18", "2026-11-17T16:30:00.000Z"), 26);
  assert.equal(age("2000-11-18", "2026-11-17T15:30:00.000Z"), 25);
  // A historical visit uses the age on that day, not today's age.
  assert.equal(age("1966-06-01", "2026-05-31T02:00:00.000Z"), 59);
  assert.equal(age("1966-06-01", "2026-06-01T02:00:00.000Z"), 60);
});

for (const localFallback of [false, true]) {
  test(`${localFallback ? "local fallback" : "mock Supabase"}: Patient Age Groups boundaries, one group per visit, totals reconcile`, async () => {
    const visitAt = "2026-10-10T02:00:00.000Z"; // Oct 10, 2026 Manila
    const born = (years, monthDay = "10-10") => `${2026 - years}-${monthDay}`;
    const cases = [
      ["5", born(5), "0–5"], ["6", born(6), "6–17"], ["17", born(17), "6–17"], ["18", born(18), "18–35"],
      ["35", born(35), "18–35"], ["36", born(36), "36–59"], ["59", born(59), "36–59"], ["60", born(60), "60+"],
      ["turns 18 tomorrow", born(18, "10-11"), "6–17"], ["no birthdate", null, "Not recorded"],
      ["impossible date", "2001-02-30", "Not recorded"], ["future birthdate", "2026-12-01", "Not recorded"]
    ];
    const h = await setup(localFallback, cases.map(([name, birthdate]) => ({
      id_num: `Synthetic ${name}`, service_type: "consultation", status: "completed", created_at: visitAt, birthdate, vulnerability_flags: []
    })));
    const { charts, metrics } = await h.service.getAnalytics("2026-10-10", "2026-10-10");
    const expected = new Map();
    cases.forEach(([, , group]) => expected.set(group, (expected.get(group) || 0) + 1));
    assert.deepEqual(clone(charts.ageGroups), {
      labels: ["0–5", "6–17", "18–35", "36–59", "60+", "Not recorded"],
      data: ["0–5", "6–17", "18–35", "36–59", "60+", "Not recorded"].map((group) => expected.get(group))
    });
    assert.equal(charts.ageGroups.data.reduce((sum, n) => sum + n, 0), metrics.totalPatients, "every visit counted exactly once");
  });
}

// Imported visits that list AGE only carry the estimated birthdate (registration year - age)-05-16. Each one
// must give exactly the listed age on the visit date (2026-11-16), so the age groups match the source list.
for (const localFallback of [false, true]) {
  test(`${localFallback ? "local fallback" : "mock Supabase"}: estimated birthdates reproduce the listed ages and their age groups`, async () => {
    const ages = [39, 62, 49, 36, 43, 60, 54, 45, 49, 37, 60, 27, 33, 35, 42, 50, 65, 57, 46, 51, 33, 24, 56, 73, 62];
    const visitAt = "2026-11-16T02:00:00.000Z";
    const h = await setup(localFallback, ages.map((age, i) => ({ id_num: `Synthetic import ${i + 1}`, service_type: "consultation",
      status: "completed", created_at: visitAt, birthdate: `${2026 - age}-05-16`, vulnerability_flags: [] })));
    ages.forEach((age) => assert.equal(h.service.getAgeAtVisit(`${2026 - age}-05-16`, visitAt), age));
    const { charts, metrics } = await h.service.getAnalytics("2026-11-16", "2026-11-16");
    assert.deepEqual(clone(charts.ageGroups), { labels: ["18–35", "36–59", "60+"], data: [5, 14, 6] });
    assert.equal(metrics.totalPatients, 25);
  });
}
