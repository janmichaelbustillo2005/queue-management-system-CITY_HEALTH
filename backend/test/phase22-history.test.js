const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");
const { getDateFilterRange } = require("../src/lib/businessDay");

const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const clockTime = Date.parse("2026-10-10T04:00:00.000Z");
const first = { id_num: "October 9 sixty seconds", service_type: "consultation", counter_id: "Doctor 1", status: "completed",
  created_at: "2026-10-09T01:00:00.000Z", consultation_started_at: "2026-10-09T01:01:00.000Z", completed_at: "2026-10-09T01:02:00.000Z" };
const second = { id_num: "October 10 one hundred twenty seconds", service_type: "consultation", counter_id: "Doctor 1", status: "completed",
  created_at: "2026-10-10T01:00:00.000Z", consultation_started_at: "2026-10-10T01:01:00.000Z", completed_at: "2026-10-10T01:03:00.000Z" };

async function setup(localFallback, fixtures = [first, second]) {
  const h = createHarness({ localFallback, clock: { now: clockTime } });
  await h.initialize();
  for (const fixture of fixtures) {
    const patient = await h.service.createQueueEntry({ idNum: fixture.id_num, serviceType: fixture.service_type, vulnerabilityFlags: [] });
    const stored = localFallback ? await h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
    Object.assign(stored, fixture);
  }
  return h;
}

test("historical date helper uses specific/inclusive Manila dates and calendar week/month presets", () => {
  const now = new Date("2026-10-10T20:00:00.000Z"); // Sunday, October 11 in Manila.
  assert.deepEqual(getDateFilterRange({ date: "2026-10-09" }, now), {
    start: "2026-10-08T16:00:00.000Z", end: "2026-10-09T16:00:00.000Z"
  });
  assert.deepEqual(getDateFilterRange({ startDate: "2026-10-09", endDate: "2026-10-10" }, now), {
    start: "2026-10-08T16:00:00.000Z", end: "2026-10-10T16:00:00.000Z"
  });
  assert.deepEqual(getDateFilterRange({ dateFilter: "today" }, now), {
    start: "2026-10-10T16:00:00.000Z", end: "2026-10-11T16:00:00.000Z"
  });
  assert.deepEqual(getDateFilterRange({ dateFilter: "week" }, now), {
    start: "2026-10-04T16:00:00.000Z", end: "2026-10-11T16:00:00.000Z"
  });
  assert.deepEqual(getDateFilterRange({ dateFilter: "month" }, now), {
    start: "2026-09-30T16:00:00.000Z", end: "2026-10-31T16:00:00.000Z"
  });
  assert.equal(getDateFilterRange({ dateFilter: "" }, now), null);
  assert.equal(getDateFilterRange({ dateFilter: "all" }, now), null);
});

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "mock Supabase";

  test(`${mode}: October 9 and October 10 analytics use their own actual consultation durations`, async () => {
    const h = await setup(localFallback);
    const ninth = await h.service.getAnalytics("2026-10-09", "2026-10-09");
    const tenth = await h.service.getAnalytics("2026-10-10", "2026-10-10");
    assert.equal(ninth.metrics.totalPatients, 1);
    assert.equal(ninth.metrics.avgServiceTime, 1);
    assert.equal(tenth.metrics.totalPatients, 1);
    assert.equal(tenth.metrics.avgServiceTime, 2);
    assert.deepEqual(clone(ninth.charts.dailyTrends.labels), ["Oct 9, 2026"]);
    assert.equal((await h.service.getQueueOverview()).patients.length, 1, "Historical reads do not broaden the active day queue");
  });

  test(`${mode}: inclusive ranges, specific dates, empty ranges and All Time records agree with exports`, async () => {
    const h = await setup(localFallback);
    const range = { startDate: "2026-10-09", endDate: "2026-10-10" };
    const all = await h.service.getAnalytics();
    const both = await h.service.getAnalytics(range.startDate, range.endDate);
    assert.equal(all.metrics.totalPatients, 2);
    assert.equal(both.metrics.avgServiceTime, 1.5);
    assert.equal((await h.service.getAnalytics("2026-10-08", "2026-10-08")).metrics.totalPatients, 0);
    const specific = await h.service.getTransactions({ dateFilter: "date", date: "2026-10-09" });
    assert.deepEqual(clone(specific.transactions.map((row) => row.id)), [1]);
    for (const filters of [range, { dateFilter: "" }, { dateFilter: "all" }]) {
      const records = await h.service.getTransactions(filters);
      const exports = await h.service.getPatientsForExport(filters);
      assert.equal(records.pagination.totalRecords, 2);
      assert.deepEqual(clone(exports.map((row) => row.id)), clone(records.transactions.map((row) => row.id)));
      assert.match(h.service.buildCsv(exports), /October 9 sixty seconds/);
      assert.match(h.service.buildCsv(exports), /October 10 one hundred twenty seconds/);
    }
  });

  test(`${mode}: one-sided date ranges remain bounded in both storage modes`, async () => {
    const h = await setup(localFallback);
    const fromTenth = await h.service.getTransactions({ startDate: "2026-10-10" });
    const throughNinth = await h.service.getTransactions({ endDate: "2026-10-09" });
    assert.deepEqual(clone(fromTenth.transactions.map((row) => row.id)), [2]);
    assert.deepEqual(clone(throughNinth.transactions.map((row) => row.id)), [1]);
  });

  test(`${mode}: Today/This Week/This Month record presets match the export dataset`, async () => {
    const h = await setup(localFallback, [first, second,
      { ...first, id_num: "Previous month", created_at: "2026-09-30T01:00:00.000Z" },
      { ...first, id_num: "Previous Sunday", created_at: "2026-10-04T01:00:00.000Z" },
      { ...first, id_num: "Next month", created_at: "2026-11-01T01:00:00.000Z" }
    ]);
    for (const [dateFilter, expected] of [["today", [2]], ["week", [1, 2]], ["month", [4, 1, 2]]]) {
      const records = await h.service.getTransactions({ dateFilter });
      const exported = await h.service.getPatientsForExport({ dateFilter });
      assert.deepEqual(clone(records.transactions.map((row) => row.id)), expected);
      assert.deepEqual(clone(exported.map((row) => row.id)), expected);
    }
  });

  test(`${mode}: Manila date filtering includes midnight and final microsecond, excluding adjacent days`, async () => {
    const base = { service_type: "prenatal", status: "completed", counter_id: "Doctor 2" };
    const h = await setup(localFallback, [
      { ...base, id_num: "Before October 9", created_at: "2026-10-08T15:59:59.999999Z" },
      { ...base, id_num: "October 9 midnight", created_at: "2026-10-09T00:00:00+08:00" },
      { ...base, id_num: "October 9 last microsecond", created_at: "2026-10-09T15:59:59.999999Z" },
      { ...base, id_num: "October 10 midnight", created_at: "2026-10-10T00:00:00+08:00" }
    ]);
    const records = await h.service.getTransactions({ date: "2026-10-09" });
    assert.deepEqual(clone(records.transactions.map((row) => row.id)), [2, 3]);
    assert.deepEqual(clone((await h.service.getPatientsForExport({ date: "2026-10-10" })).map((row) => row.id)), [4]);
  });

  test(`${mode}: service/status/doctor filters respect stored ownership, counter aliases and unassigned services`, async () => {
    const h = await setup(localFallback, [
      first,
      { ...first, id_num: "Numeric Doctor 2 alias", service_type: "prenatal", counter_id: "2" },
      { ...first, id_num: "Compact Doctor 2 alias", service_type: "maternity", counter_id: "doctor2" },
      { ...first, id_num: "Stored doctor wins", service_type: "consultation", counter_id: "Doctor 2" },
      { ...first, id_num: "Unassigned waiting prenatal", service_type: "prenatal", status: "waiting", counter_id: null },
      { ...first, id_num: "Unassigned historical family planning", service_type: "family_planning", counter_id: null }
    ]);
    for (const doctor of ["Doctor 2", "2", "doctor2"]) {
      const records = await h.service.getTransactions({ date: "2026-10-09", doctor });
      assert.deepEqual(clone(records.transactions.map((row) => row.id)), [2, 3, 4, 5]);
    }
    const filtered = { date: "2026-10-09", doctor: "Doctor 2", service: "prenatal", status: "completed" };
    assert.deepEqual(clone((await h.service.getPatientsForExport(filtered)).map((row) => row.id)), [2]);
    assert.equal((await h.service.getAnalytics("", "", filtered)).metrics.totalPatients, 1);
    assert.deepEqual(clone((await h.service.getTransactions({ doctor: "Doctor 3" })).transactions.map((row) => row.id)), [6]);
  });

  test(`${mode}: historical duration averages exclude legacy, cancelled, no-show, unstarted and invalid intervals`, async () => {
    const base = { ...first, counter_id: null };
    const h = await setup(localFallback, [first, second,
      { ...base, id_num: "Legacy", consultation_started_at: null },
      { ...base, id_num: "Cancelled", status: "cancelled" },
      { ...base, id_num: "No-show", status: "no-show" },
      { ...base, id_num: "Unstarted", status: "serving", consultation_started_at: null, completed_at: null },
      { ...base, id_num: "Invalid", consultation_started_at: "not a timestamp" },
      { ...base, id_num: "Zero", completed_at: base.consultation_started_at },
      { ...base, id_num: "Negative", completed_at: "2026-10-09T01:00:00.000Z" }
    ]);
    assert.equal((await h.service.getAnalytics("2026-10-09", "2026-10-09")).metrics.avgServiceTime, 1);
    const exports = await h.service.getPatientsForExport({ date: "2026-10-09" });
    assert.equal(exports.filter((row) => row.service_duration_seconds != null).length, 1);
    assert.equal(exports.find((row) => row.id_num === "October 9 sixty seconds").service_duration_seconds, 60);
    assert.equal((await h.service.getAnalytics("2026-10-10", "2026-10-10")).metrics.avgServiceTime, 2);
  });

  test(`${mode}: records and analytics routes/export retain identical selected range, service and doctor`, async () => {
    const h = await setup(localFallback);
    const query = { dateFilter: "range", startDate: "2026-10-09", endDate: "2026-10-09", doctor: "Doctor 1", service: "consultation", status: "completed" };
    const records = await h.request("GET", "/transactions", {}, superadmin, query);
    const analytics = await h.request("GET", "/analytics", {}, superadmin, query);
    const recordsCsv = await h.request("GET", "/queue/export", {}, superadmin, query);
    const analyticsCsv = await h.request("GET", "/analytics/export", {}, superadmin, query);
    assert.equal(records.status, 200);
    assert.equal(analytics.status, 200);
    assert.equal(recordsCsv.status, 200);
    assert.equal(analyticsCsv.status, 200);
    assert.deepEqual(records.body.transactions.map((row) => row.id), [1]);
    assert.equal(analytics.body.metrics.avgServiceTime, 1);
    assert.match(recordsCsv.body, /October 9 sixty seconds/);
    assert.doesNotMatch(recordsCsv.body, /October 10 one hundred twenty seconds/);
    assert.equal(analyticsCsv.body, h.service.buildCsv(analytics.body.tableData));
    assert.equal(recordsCsv.headers["Content-Type"], "text/csv");
    assert.equal((await h.request("GET", "/queue/export", {}, superadmin, { dateFilter: "" })).body.split("\n").length, 3);
    assert.equal((await h.request("GET", "/analytics", {}, superadmin, { dateFilter: "" })).body.metrics.totalPatients, 2);
  });

  test(`${mode}: invalid calendars/presets/ranges/doctors/pagination return 400 before patient writes`, async () => {
    const h = await setup(localFallback);
    for (const query of [
      { date: "2026-02-30" }, { dateFilter: "not a preset" }, { dateFilter: "date" },
      { dateFilter: "range", startDate: "2026-10-09" },
      { startDate: "2026-10-10", endDate: "2026-10-09" },
      { date: "2026-10-09", startDate: "2026-10-09" }, { doctor: "Doctor 9" }
    ]) {
      for (const route of ["/transactions", "/queue/export", "/analytics", "/analytics/export"]) {
        const response = await h.request("GET", route, {}, superadmin, query);
        assert.equal(response.status, 400, `${route} ${JSON.stringify(query)}: ${response.body?.message}`);
      }
    }
    assert.equal((await h.request("GET", "/transactions", {}, superadmin, { page: "-1" })).status, 400);
    assert.equal((await h.request("GET", "/transactions", {}, superadmin, { limit: "1.5" })).status, 400);
    assert.equal(h.database.calls.filter((call) => call.table === "patients" && call.action === "update").length, 0);
  });
}

test("mock Supabase: historical pagination/stats/CSV include more than 1000 equal-time records without duplicates", async () => {
  const h = await setup(false, []);
  h.database.maxRows = 37;
  for (let id = 1107; id >= 1; id -= 1) {
    h.database.patients.push({ ...first, id, id_num: `Historical ${id}`, status: id % 2 ? "completed" : "cancelled" });
  }
  const all = await h.service.getPatientsForExport({ date: "2026-10-09" });
  assert.equal(all.length, 1107);
  assert.equal(new Set(all.map((row) => row.id)).size, 1107);
  assert.deepEqual(clone(all.slice(0, 3).map((row) => row.id)), [1, 2, 3]);
  const ids = [];
  for (let page = 1; page <= 6; page += 1) {
    const records = await h.service.getTransactions({ page, limit: 200, date: "2026-10-09" });
    ids.push(...records.transactions.map((row) => row.id));
    assert.equal(records.pagination.totalRecords, 1107);
    assert.equal(records.pagination.totalPages, 6);
    assert.equal(records.stats.completed, 554);
    assert.equal(records.stats.cancelled, 553);
  }
  assert.deepEqual(ids, Array.from({ length: 1107 }, (_, index) => index + 1));
  assert.equal(h.service.buildCsv(all).split("\n").length, 1108);
  assert.equal((await h.service.getAnalytics("2026-10-09", "2026-10-09")).metrics.totalPatients, 1107);
});

test("mock Supabase: All Time daily charts retain separate years and Manila hours", async () => {
  const h = await setup(false, [
    { ...first, id_num: "Previous year", created_at: "2025-10-08T16:00:00.000Z" },
    { ...first, id_num: "This year offset", created_at: "2026-10-09T00:00:00+08:00" }
  ]);
  const analytics = await h.service.getAnalytics();
  assert.deepEqual(clone(analytics.charts.dailyTrends.labels), ["Oct 9, 2025", "Oct 9, 2026"]);
  assert.deepEqual(clone(analytics.charts.hourly.labels), ["00:00"]);
  assert.deepEqual(clone(analytics.charts.hourly.data), [2]);
});

test("mock Supabase: analytics default dates use the server Manila calendar after UTC midnight divergence", async () => {
  const h = await setup(false, [{ ...second, created_at: "2026-10-10T16:10:00.000Z" }]);
  h.clock.now = Date.parse("2026-10-10T16:20:00.000Z");
  const response = await h.request("GET", "/analytics", {}, superadmin);
  assert.equal(response.status, 200);
  assert.equal(response.body.metrics.totalPatients, 1, "Default Manila end date includes October 11 at 00:10");
  const exported = await h.request("GET", "/queue/export", {}, superadmin);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers["Content-Disposition"], 'attachment; filename="queue_data_2026-10-11.csv"');
});
