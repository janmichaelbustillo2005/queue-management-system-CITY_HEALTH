const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");
const insightsModule = require("../src/services/analyticsInsights");

// Sunday 2026-10-11 16:00 in Manila. Synthetic visits only; times are UTC (Manila is UTC+8).
const clockTime = Date.parse("2026-10-11T08:00:00.000Z");
const visits = [
  { id_num: "Synthetic A", service_type: "consultation", counter_id: "Doctor 1", status: "completed",
    created_at: "2026-10-09T01:00:00.000Z", called_at: "2026-10-09T01:10:00.000Z",
    consultation_started_at: "2026-10-09T01:10:00.000Z", completed_at: "2026-10-09T01:16:00.000Z" },
  { id_num: "Synthetic B", service_type: "prenatal", counter_id: "Doctor 2", status: "no-show",
    created_at: "2026-10-09T03:30:00.000Z", called_at: "2026-10-09T03:40:00.000Z", completed_at: "2026-10-09T03:55:00.000Z",
    reason: "Did not answer the call" },
  { id_num: "Synthetic C", service_type: "family_planning", counter_id: null, status: "cancelled",
    created_at: "2026-10-11T00:00:00.000Z", completed_at: "2026-10-11T00:45:00.000Z", reason: "Patient left" },
  { id_num: "Synthetic D", service_type: "checkup", counter_id: null, status: "waiting",
    created_at: "2026-10-11T05:00:00.000Z" }
];

async function setup(localFallback, fixtures = visits, configure) {
  const h = createHarness({ localFallback, clock: { now: clockTime } });
  if (configure) configure(h);
  await h.initialize();
  for (const fixture of fixtures) {
    const patient = await h.service.createQueueEntry({ idNum: fixture.id_num, serviceType: "consultation", vulnerabilityFlags: [] });
    const stored = localFallback ? await h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
    Object.assign(stored, fixture);
  }
  return h;
}

// Completed Doctor 1 consultations: `count` a day for `days` days ending 2026-10-11, each
// registered at 09:00 Manila, called 5 minutes later and finished `minutes` after the call.
function completedVisits({ days, count, minutes, endDay = 11 }) {
  const rows = [];
  for (let day = endDay - days + 1; day <= endDay; day += 1) {
    for (let index = 0; index < count; index += 1) {
      const created = Date.parse(`2026-10-${String(day).padStart(2, "0")}T01:00:00.000Z`) + index * 60000;
      rows.push({ id_num: `Synthetic ${day}-${index}`, service_type: "consultation", counter_id: "Doctor 1", status: "completed",
        created_at: new Date(created).toISOString(), called_at: new Date(created + 5 * 60000).toISOString(),
        consultation_started_at: new Date(created + 6 * 60000).toISOString(),
        completed_at: new Date(created + (5 + minutes) * 60000).toISOString() });
    }
  }
  return rows;
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "mock Supabase";

  test(`${mode}: the existing analytics are unchanged and the additional sections are added beside them`, async () => {
    const h = await setup(localFallback);
    const analytics = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    assert.deepEqual(Object.keys(analytics), ["metrics", "charts", "tableData", "totals", "doctorTable", "insights"]);
    assert.deepEqual(clone(analytics.totals), {
      total_patients: 4, completed: 1, cancelled: 1, no_show: 1, waiting: 1, serving: 0,
      avg_wait_time: "21.7", avg_service_time: "6.0", completion_rate: "25.0"
    });
    const { insights } = analytics;
    assert.deepEqual(clone(insights.journey.stages.map((stage) => [stage.key, stage.count, stage.share])),
      [["registered", 4, 100], ["called", 2, 50], ["started", 1, 25], ["completed", 1, 25]]);
    assert.deepEqual(clone(insights.journey.exits),
      { cancelled_before_call: 1, cancelled_after_call: 0, no_show: 1, still_waiting: 1, still_serving: 0 });
    assert.equal(insights.journey.durations.registered_to_called.avg, 10);
    assert.equal(insights.journey.durations.started_to_completed.avg, 6);
    assert.equal(insights.journey.durations.registered_to_completed.avg, 16);
  });

  test(`${mode}: abandonment separates cancellations before and after the call from no-shows`, async () => {
    const h = await setup(localFallback);
    const { abandonment } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
    assert.deepEqual(clone({ ...abandonment, top_reasons: undefined }), {
      resolved: 3, completed: 1, cancelled: 1, cancelled_before_call: 1, cancelled_after_call: 0, no_show: 1, abandoned: 2,
      abandonment_rate: 66.7, cancellation_rate: 33.3, no_show_rate: 33.3, in_progress: 1, waiting_from_earlier_days: 0
    });
    assert.deepEqual(clone(abandonment.top_reasons.map((row) => [row.reason, row.total])),
      [["Did not answer the call", 1], ["Patient left", 1]]);
  });

  test(`${mode}: wait times are broken down by service, doctor, date and hour of arrival`, async () => {
    const h = await setup(localFallback);
    const { wait } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
    assert.deepEqual(clone(wait.by_service.map((row) => [row.key, row.visits, row.samples, row.avg])), [
      ["consultation", 1, 1, 10], ["checkup", 1, 0, null], ["prenatal", 1, 1, 10], ["family_planning", 1, 1, 45]
    ]);
    assert.deepEqual(clone(wait.by_doctor.map((row) => [row.key, row.visits])), [["Doctor 1", 2], ["Doctor 2", 1], ["Doctor 3", 1]]);
    assert.deepEqual(clone(wait.by_date.map((row) => [row.key, row.visits, row.avg])), [["2026-10-09", 2, 10], ["2026-10-11", 2, 45]]);
    assert.deepEqual(clone(wait.by_hour.map((row) => row.key)), [8, 9, 11, 13]);
  });

  test(`${mode}: SLA uses the configured target and counts compliant, late and still-waiting patients`, async () => {
    const h = await setup(localFallback);
    let { sla } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
    assert.deepEqual(clone({ ...sla, by_service: undefined, by_doctor: undefined }), {
      target_minutes: 30, measured: 2, compliant: 2, non_compliant: 0, rate: 100,
      left_after_target: 1, waiting_over_target_now: 1
    });
    h.settings.saveQueueSettings({ slaTargetWaitMinutes: 5 });
    ({ sla } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights);
    assert.deepEqual([sla.target_minutes, sla.compliant, sla.non_compliant, sla.rate], [5, 0, 2, 0]);
    assert.deepEqual(clone(sla.by_doctor.map((row) => [row.key, row.measured, row.non_compliant])), [["Doctor 1", 1, 1], ["Doctor 2", 1, 1]]);
    assert.equal(h.settings.saveQueueSettings({ slaTargetWaitMinutes: "never" }).slaTargetWaitMinutes, 30);
  });

  test(`${mode}: service demand includes offered services nobody requested and names the most and least requested`, async () => {
    const h = await setup(localFallback);
    const { demand } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
    assert.equal(demand.total, 4);
    assert.deepEqual(clone(demand.services.map((row) => [row.service, row.count, row.share])), [
      ["consultation", 1, 25], ["checkup", 1, 25], ["prenatal", 1, 25], ["family_planning", 1, 25], ["maternity", 0, 0]
    ]);
    assert.equal(demand.most_requested.length, 4);
    assert.deepEqual(clone(demand.least_requested.map((row) => row.service)), ["maternity"]);
  });

  test(`${mode}: peak traffic averages arrivals over every day of the period, including quiet days`, async () => {
    const h = await setup(localFallback);
    const { peak } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
    assert.equal(peak.days_observed, 3);
    assert.deepEqual(clone(peak.weekdays.filter((day) => day.days_observed).map((day) => [day.weekday, day.total, day.avg_per_day])),
      [["Friday", 2, 2], ["Saturday", 0, 0], ["Sunday", 2, 2]]);
    assert.equal(peak.busiest_weekday.weekday, "Friday");
    assert.equal(peak.quietest_weekday, null, "Friday and Sunday tie, so neither is quieter");
    assert.deepEqual(clone(peak.busiest_date), { date: "2026-10-09", count: 2 });
    assert.deepEqual(clone(peak.hours.map((row) => row.hour)), [8, 9, 10, 11, 12, 13]);
    assert.equal(peak.slots, undefined);
  });

  test(`${mode}: staffing and forecasting say the history is insufficient instead of guessing`, async () => {
    const h = await setup(localFallback);
    const { staffing, forecast } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
    assert.equal(staffing.sufficient, false);
    assert.match(staffing.message, /at least 7 days .* 20 completed visits.*Found 3 days and 1 visit;/);
    assert.equal(forecast.available, true);
    assert.equal(forecast.sufficient, false);
    const doctorOne = forecast.estimates.find((row) => row.doctor === "Doctor 1");
    assert.deepEqual([doctorOne.waiting, doctorOne.estimate_minutes], [1, null]);
    assert.match(doctorOne.note, /Not enough completed visits/);
    assert.equal(forecast.historical.sufficient, false);
  });

  test(`${mode}: the status and service filters apply to the new sections`, async () => {
    const h = await setup(localFallback);
    const { insights } = await h.service.getAnalytics("2026-10-09", "2026-10-11", { service: "prenatal" });
    assert.deepEqual(clone(insights.demand.services.map((row) => row.service)), ["prenatal"]);
    assert.deepEqual(clone(insights.wait.by_service.map((row) => row.key)), ["prenatal"]);
    assert.deepEqual(clone(insights.filters), { status: "", service: "prenatal", doctor: "" });
    const completed = (await h.service.getAnalytics("2026-10-09", "2026-10-11", { status: "completed" })).insights;
    assert.equal(completed.journey.stages[0].count, 1);
    assert.equal(completed.abandonment.abandonment_rate, 0);
  });
}

test("local fallback: utilization explains that sign-in sessions are not available", async () => {
  const h = await setup(true);
  const { utilization } = (await h.service.getAnalytics("2026-10-09", "2026-10-11")).insights;
  assert.equal(utilization.available, false);
  assert.match(utilization.message, /local fallback/);
});

test("a session table that cannot be read marks only utilization unavailable", async () => {
  const h = await setup(false);
  const { insights, metrics } = await h.service.getAnalytics("2026-10-09", "2026-10-11");
  assert.equal(metrics.totalPatients, 4);
  assert.equal(insights.utilization.available, false);
  assert.match(insights.utilization.message, /Doctor sign-in sessions could not be read/);
  assert.equal(insights.sla.measured, 2);
});

test("utilization compares signed-in time with time spent on called visits, whatever the status filter", async () => {
  const h = await setup(false, visits, (harness) => {
    harness.database.staff_auth_sessions = [
      // One hour signed in around visit A (called 01:10, finished 01:16).
      { doctor_name: "Doctor 1", created_at: "2026-10-09T00:30:00.000Z", last_seen_at: "2026-10-09T01:30:00.000Z",
        revoked_at: null, expires_at: "2026-10-09T08:30:00.000Z" },
      // Signed out after 20 minutes; the revocation ends the session before its last heartbeat.
      { doctor_name: "Doctor 2", created_at: "2026-10-09T03:20:00.000Z", last_seen_at: "2026-10-09T04:00:00.000Z",
        revoked_at: "2026-10-09T03:40:00.000Z", expires_at: "2026-10-09T11:20:00.000Z" },
      { doctor_name: null, created_at: "2026-10-09T00:00:00.000Z", last_seen_at: "2026-10-09T05:00:00.000Z",
        revoked_at: null, expires_at: "2026-10-09T08:00:00.000Z" }
    ];
  });
  for (const filters of [{}, { status: "waiting" }]) {
    const { utilization, volumes } = (await h.service.getAnalytics("2026-10-09", "2026-10-11", filters)).insights;
    assert.equal(utilization.available, true);
    assert.equal(utilization.breaks_recorded, false);
    assert.deepEqual(clone(utilization.doctors.map(({ doctor, signed_in_minutes, busy_minutes, idle_minutes, utilization: rate, busy_outside_session_minutes }) =>
      [doctor, signed_in_minutes, busy_minutes, idle_minutes, rate, busy_outside_session_minutes])), [
      ["Doctor 1", 60, 6, 54, 10, 0],
      // B was called at 03:40, exactly when the session ended, and finished at 03:55.
      ["Doctor 2", 20, 0, 20, 0, 15],
      ["Doctor 3", 0, 0, 0, null, 0]
    ]);
    if (!filters.status) {
      assert.deepEqual(clone(volumes.map(({ doctor, total, completed, completed_share, completed_per_signed_in_hour }) =>
        [doctor, total, completed, completed_share, completed_per_signed_in_hour])), [
        ["Doctor 1", 2, 1, 100, 1], ["Doctor 2", 1, 0, 0, 0], ["Doctor 3", 1, 0, 0, null]
      ]);
    }
  }
});

test("staffing turns hourly arrivals and doctor time per patient into doctors needed", async () => {
  // Three patients at 09:00 every day for a week, each taking 20 doctor-minutes: one hour of work
  // in that hour needs ceil(60 / (60 × 85%)) = 2 doctors.
  const h = await setup(false, completedVisits({ days: 7, count: 3, minutes: 20 }));
  const { staffing } = (await h.service.getAnalytics("2026-10-05", "2026-10-11")).insights;
  assert.equal(staffing.sufficient, true);
  assert.deepEqual(clone(staffing.basis), {
    days_observed: 7, samples: 21, avg_doctor_minutes: 20, target_utilization: 85, enabled_doctors: 3, min_days: 7, min_samples: 20
  });
  assert.equal(staffing.peak_need, 2);
  assert.equal(staffing.over_capacity, 0);
  assert.equal(staffing.slots.length, 7);
  assert.deepEqual(clone(staffing.slots[0]), {
    weekday: staffing.slots[0].weekday, hour: 9, avg_arrivals: 3, workload_minutes: 60, doctors_needed: 2, top_service: "consultation"
  });
});

test("the forecast multiplies the live queue by recorded doctor time and skips offline doctors", async () => {
  const live = [
    { id_num: "Live serving", service_type: "consultation", counter_id: "Doctor 1", status: "serving",
      created_at: "2026-10-11T07:40:00.000Z", called_at: "2026-10-11T07:56:00.000Z" },
    { id_num: "Live waiting 1", service_type: "consultation", status: "waiting", created_at: "2026-10-11T07:50:00.000Z" },
    { id_num: "Live waiting 2", service_type: "checkup", status: "waiting", created_at: "2026-10-11T07:55:00.000Z" },
    // An earlier day's waiting visit is backlog, not today's queue.
    { id_num: "Old waiting", service_type: "consultation", status: "waiting", created_at: "2026-10-10T07:55:00.000Z" }
  ];
  const h = await setup(false, [...completedVisits({ days: 1, count: 5, minutes: 12, endDay: 10 }), ...live], (harness) => {
    harness.database.counters[2].is_online = false;
  });
  const { forecast } = (await h.service.getAnalytics("2026-10-10", "2026-10-11")).insights;
  assert.equal(forecast.sufficient, true);
  assert.equal(forecast.mode, "service");
  assert.deepEqual(clone(forecast.estimates.map(({ doctor, waiting, serving, avg_minutes, basis, estimate_minutes, note }) =>
    [doctor, waiting, serving, avg_minutes, basis, estimate_minutes, note])), [
    // 12 − 4 minutes left with the current patient, then 2 × 12.
    ["Doctor 1", 2, 1, 12, "doctor", 32, null],
    ["Doctor 2", 0, 0, 12, "all_doctors", 0, null],
    ["Doctor 3", 0, 0, 12, "all_doctors", null, "Doctor is offline."]
  ]);
  const filtered = (await h.service.getAnalytics("2026-10-10", "2026-10-11", { service: "checkup" })).insights.forecast;
  assert.deepEqual(clone(filtered.estimates.map((row) => row.doctor)), ["Doctor 1"]);
});

test("a visit left open past the day it was called is neither doctor time nor busy time", async () => {
  // Five 12-minute visits on 2026-10-10, plus one called that day but only closed two days later.
  const leftOpen = { id_num: "Synthetic open", service_type: "consultation", counter_id: "Doctor 1", status: "completed",
    created_at: "2026-10-10T02:00:00.000Z", called_at: "2026-10-10T02:05:00.000Z",
    consultation_started_at: "2026-10-12T00:00:00.000Z", completed_at: "2026-10-12T00:05:00.000Z" };
  const h = await setup(false, [...completedVisits({ days: 1, count: 5, minutes: 12, endDay: 10 }), leftOpen], (harness) => {
    harness.database.staff_auth_sessions = [{ doctor_name: "Doctor 1", created_at: "2026-10-10T00:00:00.000Z",
      last_seen_at: "2026-10-10T09:00:00.000Z", revoked_at: null, expires_at: "2026-10-10T09:00:00.000Z" }];
  });
  const { forecast, utilization } = (await h.service.getAnalytics("2026-10-10", "2026-10-11")).insights;
  const doctorOne = forecast.estimates.find((row) => row.doctor === "Doctor 1");
  assert.deepEqual([doctorOne.avg_minutes, doctorOne.samples], [12, 5]);
  const busy = utilization.doctors.find((row) => row.doctor === "Doctor 1");
  // The five synthetic visits overlap (called 01:05–01:09, each lasting 12 minutes), so one
  // doctor's busy time is their union, 01:05–01:21; the visit left open adds nothing.
  assert.deepEqual([busy.busy_minutes, busy.open_past_day_visits], [16, 1]);
});

test("Export keeps the By Service CSV first, then adds the additional sections under the same filters", async () => {
  const h = await setup(false);
  const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
  const query = { dateFilter: "range", startDate: "2026-10-09", endDate: "2026-10-11" };
  const response = await h.request("GET", "/analytics/export", {}, superadmin, query);
  assert.equal(response.status, 200);
  const page = (await h.request("GET", "/analytics", {}, superadmin, query)).body;
  const [byService, ...sections] = response.body.split("\n\n");
  assert.equal(byService, h.service.buildCsv(page.tableData), "the existing export block is unchanged");
  const titles = sections.map((block) => JSON.parse(block.split("\n")[0]));
  for (const title of ["Average wait time by service", "Average wait time by doctor", "Average wait time by date", "Average wait time by arrival hour",
    "Average service time by doctor", "Patient journey", "Abandonment", "Transaction volume by doctor", "SLA compliance (called within 30 minutes)",
    "Arrivals by weekday", "Service demand", "Staffing recommendations", "Patient satisfaction", "Cross-branch comparison",
    "Average wait (min) by arrival hour and service", "Average wait (min) per day", "Patient arrivals per day", "Patient outcomes",
    "Patient arrival forecast"]) {
    assert.ok(titles.includes(title), `missing ${title}`);
  }
  // The exported figures are the page's figures.
  const abandonment = sections.find((block) => block.startsWith('"Abandonment"'));
  assert.ok(abandonment.includes(`"Abandonment rate (%)","${page.insights.abandonment.abandonment_rate}"`));
  assert.match(response.body, /Staffing recommendations need at least 7 days/);
  assert.doesNotMatch(response.body, /undefined|NaN|\[object/);
});

test("insights CSV exports an error note when the sections failed and nothing when absent", () => {
  assert.equal(insightsModule.buildInsightsCsv(undefined), "");
  assert.equal(insightsModule.buildInsightsCsv({ error: "Could not compute." }), '"Additional analytics"\n"Note"\n"Could not compute."');
});

test("if the additional sections fail, the existing analytics still load", async () => {
  const h = await setup(false);
  const original = insightsModule.buildAnalyticsInsights;
  insightsModule.buildAnalyticsInsights = () => { throw new Error("synthetic failure"); };
  try {
    const analytics = await h.service.getAnalytics("2026-10-09", "2026-10-11");
    assert.equal(analytics.metrics.totalPatients, 4);
    assert.equal(analytics.tableData.length, 4);
    assert.match(analytics.insights.error, /figures above are unaffected/);
  } finally {
    insightsModule.buildAnalyticsInsights = original;
  }
});

test("stats use the nearest-rank 90th percentile and interval helpers merge overlaps", () => {
  assert.deepEqual(insightsModule.stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { samples: 10, avg: 5.5, median: 5.5, p90: 9, max: 10 });
  assert.deepEqual(insightsModule.stats([]), { samples: 0, avg: null, median: null, p90: null, max: null });
  assert.deepEqual(insightsModule.mergeIntervals([[5, 8], [1, 3], [2, 4]]), [[1, 4], [5, 8]]);
  assert.equal(insightsModule.overlapLength([[0, 10]], [[2, 4], [8, 12]]), 4);
});
