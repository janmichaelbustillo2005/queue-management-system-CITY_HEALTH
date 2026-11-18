// Trends Analytics and Status Analytics date-range reports (rangeAnalyticsService).
// Every expected figure below is worked out by hand from the fixture visits.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

function loadService(database = null) {
  const stubs = {
    [path.resolve(__dirname, "../src/lib/supabase.js")]: database ? fakeSupabase(database) : {},
    [path.resolve(__dirname, "../src/config/env.js")]: database ? { supabaseUrl: "http://db", supabaseServiceRoleKey: "key" } : {}
  };
  const original = Module._load;
  Module._load = function load(request, parent, ...rest) {
    const resolved = Module._resolveFilename(request, parent, ...rest);
    if (resolved in stubs) return stubs[resolved];
    return original.call(this, request, parent, ...rest);
  };
  try {
    for (const name of ["rangeAnalyticsService", "statusAnalyticsService", "dailyTrendsService"]) {
      delete require.cache[path.resolve(__dirname, `../src/services/${name}.js`)];
    }
    return require("../src/services/rangeAnalyticsService");
  } finally {
    Module._load = original;
  }
}

function fakeSupabase(database) {
  return {
    from(table) {
      const query = {
        filters: [],
        columns: "",
        select(columns) { this.columns = columns; return this; },
        lte(column, value) { this.filters.push((row) => Date.parse(row[column]) <= Date.parse(value)); return this; },
        gte(column, value) { this.filters.push((row) => Date.parse(row[column]) >= Date.parse(value)); return this; },
        or() { return this; },
        order() { return this; },
        range(from, to) {
          // Like PostgREST: a missing table is PGRST205, a missing column 42703.
          if (!database[table]) return Promise.resolve({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}'` } });
          if (table === "patients" && database.noRecordLink && this.columns.includes("patient_record_id")) {
            return Promise.resolve({ data: null, error: { code: "42703", message: "column patients.patient_record_id does not exist" } });
          }
          (database.reads ||= []).push({ table, columns: this.columns });
          const rows = database[table].filter((row) => this.filters.every((keep) => keep(row)));
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        }
      };
      return query;
    }
  };
}

const at = (time, day = "2026-10-15") => `${day}T${time}:00+08:00`;
const NOW = new Date(at("10:30"));
const visit = (id, overrides) => ({ id, status: "waiting", created_at: at("08:00"), called_at: null, consultation_started_at: null,
  completed_at: null, counter_id: null, service_type: "medical_consultation", queue_number: `MC-${String(id).padStart(3, "0")}`, ...overrides });
const counters = [{ id: 1, id_num: "Doctor 1" }, { id: 2, id_num: "Doctor 2" }, { id: 3, id_num: "Doctor 3" }];
const patients = [
  // Today: completed by Doctor 1 — waited 10 min, served 18 min.
  visit(1, { status: "completed", called_at: at("08:10"), consultation_started_at: at("08:12"), completed_at: at("08:30"), counter_id: "Doctor 1" }),
  // Today: completed by Doctor 2, stored under the counter id "2" — waited 40, served 20.
  visit(2, { status: "completed", created_at: at("08:20"), called_at: at("09:00"), consultation_started_at: at("09:05"), completed_at: at("09:25"), counter_id: "2", service_type: "family_planning" }),
  // Today: still waiting, no doctor assigned yet.
  visit(3, { created_at: at("09:10") }),
  // Today: cancelled at 09:45 before any call; assigned to Doctor 1.
  visit(4, { status: "cancelled", created_at: at("09:30"), completed_at: at("09:45"), counter_id: "Doctor 1", service_type: "dental_healthcare" }),
  // Today: being served by Doctor 3 — waited 5 min.
  visit(5, { status: "serving", created_at: at("10:00"), called_at: at("10:05"), consultation_started_at: at("10:06"), counter_id: "Doctor 3" }),
  // Registered yesterday 16:00, called today 08:00 (waited 960 min), completed today 08:20 by Doctor 2 (served 19 min).
  visit(6, { status: "completed", created_at: at("16:00", "2026-10-14"), called_at: at("08:00"), consultation_started_at: at("08:01"), completed_at: at("08:20"), counter_id: "Doctor 2", service_type: "maternal_healthcare" }),
  // Yesterday morning: the comparison period's only visit, completed by Doctor 1.
  visit(7, { status: "completed", created_at: at("08:00", "2026-10-14"), called_at: at("08:30", "2026-10-14"), consultation_started_at: at("08:31", "2026-10-14"), completed_at: at("08:50", "2026-10-14"), counter_id: "Doctor 1" }),
  // Registered two days ago and still waiting (a carry-in).
  visit(8, { created_at: at("15:00", "2026-10-13") })
];

const service = loadService();
const today = () => service.buildPeriod({ range: "today" }, NOW);
const bucketAt = (data, hour) => data.buckets.find((bucket) => bucket.hour === hour);

test("periods: presets end today in Manila, custom ranges are validated, one day is hourly", () => {
  const day = today();
  assert.equal(day.granularity, "hour");
  assert.equal(day.start_at, "2026-10-14T16:00:00.000Z");
  assert.equal(day.end_at, "2026-10-15T16:00:00.000Z");
  assert.equal(day.effective_end_at, NOW.toISOString());
  assert.equal(day.live, true);
  const week = service.buildPeriod({ range: "7d" }, NOW);
  assert.deepEqual([week.start_date, week.end_date, week.days, week.granularity], ["2026-10-09", "2026-10-15", 7, "day"]);
  const month = service.buildPeriod({ range: "30d" }, NOW);
  assert.deepEqual([month.start_date, month.days], ["2026-09-16", 30]);
  const past = service.buildPeriod({ range: "custom", startDate: "2026-10-01", endDate: "2026-10-03" }, NOW);
  assert.deepEqual([past.days, past.live, past.effective_end_at], [3, false, "2026-10-03T16:00:00.000Z"]);
  const shift = service.buildPeriod({ range: "custom", startDate: "2026-10-14", endDate: "2026-10-14", startTime: "22:00", endTime: "06:00" }, NOW);
  assert.deepEqual([shift.start_at, shift.end_at, shift.time_window], ["2026-10-14T14:00:00.000Z", "2026-10-14T22:00:00.000Z", true]);
  for (const [query, message] of [
    [{ range: "week" }, /Choose Today/],
    [{ range: "custom", startDate: "2026-10-05", endDate: "2026-10-01" }, /on or before/],
    [{ range: "custom", startDate: "2026-02-30", endDate: "2026-03-01" }, /valid start and end/],
    [{ range: "custom", startDate: "2025-01-01", endDate: "2026-10-01" }, /at most 366 days/],
    [{ range: "today", startTime: "08:00", endTime: "12:00" }, /single-day custom range/],
    [{ range: "custom", startDate: "2026-10-01", endDate: "2026-10-02", startTime: "08:00", endTime: "12:00" }, /single-day custom range/]
  ]) assert.throws(() => service.buildPeriod(query, NOW), (error) => error.statusCode === 400 && message.test(error.message));
});

test("comparison periods are the equivalent previous window, cut to elapsed time while live", () => {
  const day = service.comparisonPeriod(today());
  assert.deepEqual([day.start_at, day.effective_end_at, day.label], ["2026-10-13T16:00:00.000Z", "2026-10-14T02:30:00.000Z", "vs same time yesterday"]);
  const week = service.comparisonPeriod(service.buildPeriod({ range: "7d" }, NOW));
  assert.deepEqual([week.start_date, week.end_date, week.label], ["2026-10-02", "2026-10-08", "vs previous 7 days (same elapsed time)"]);
  const past = service.comparisonPeriod(service.buildPeriod({ range: "custom", startDate: "2026-10-01", endDate: "2026-10-03" }, NOW));
  assert.deepEqual([past.start_date, past.end_date, past.label], ["2026-09-28", "2026-09-30", "vs previous 3 days"]);
});

test("Trends KPIs: visits by registration, completions by completion time, real averages and comparisons", () => {
  const data = service.aggregateTrendsAnalytics(patients, counters, today(), NOW);
  assert.deepEqual(data.kpis.total_visits, { value: 5, previous: 1, change_percent: 400 });
  // Visit 6 registered yesterday but completed today: a completion today, not a visit today.
  assert.deepEqual(data.kpis.completed, { value: 3, previous: 1, change_percent: 200 });
  assert.equal(data.kpis.avg_wait_minutes.value, (10 + 40 + 5 + 960) / 4);
  assert.equal(data.kpis.avg_wait_minutes.previous, 30);
  assert.equal(data.kpis.avg_service_minutes.value, (18 + 20 + 19) / 3);
  assert.deepEqual(data.samples, { wait: 4, service: 3 });
});

test("Trends activity series: events in their own hour, waiting is a reconstructed snapshot, future hours are unknown", () => {
  const data = service.aggregateTrendsAnalytics(patients, counters, today(), NOW);
  assert.equal(data.buckets.length, 24);
  const pick = (bucket) => [bucket.arrivals, bucket.completed, bucket.cancelled, bucket.waiting];
  assert.deepEqual(pick(bucketAt(data, 8)), [2, 2, 0, 2]);
  assert.deepEqual(pick(bucketAt(data, 9)), [2, 1, 1, 2]);
  assert.deepEqual(pick(bucketAt(data, 10)), [1, 0, 0, 2], "the hour in progress uses the stored statuses");
  assert.deepEqual(pick(bucketAt(data, 0)), [0, 0, 0, 2], "carry-ins were waiting overnight");
  assert.deepEqual(pick(bucketAt(data, 11)), [null, null, null, null]);
  assert.equal(bucketAt(data, 8).avg_wait_minutes, (10 + 960) / 2);
  assert.equal(bucketAt(data, 9).avg_wait_minutes, 40);
  assert.equal(bucketAt(data, 7).avg_wait_minutes, null, "an hour without calls has no average, not zero");
  assert.equal(bucketAt(data, 8).avg_service_minutes, (18 + 19) / 2);
  const arrivals = data.buckets.reduce((sum, bucket) => sum + (bucket.arrivals ?? 0), 0);
  assert.equal(arrivals, data.kpis.total_visits.value);
});

test("Trends outcome, service volume and doctor workload use real statuses, services and stored doctors", () => {
  const data = service.aggregateTrendsAnalytics(patients, counters, today(), NOW);
  assert.equal(data.outcome.total, 5);
  assert.deepEqual(data.outcome.statuses.map((row) => [row.status, row.count]), [["completed", 2], ["waiting", 1], ["serving", 1], ["cancelled", 1]]);
  assert.equal(data.outcome.statuses.reduce((sum, row) => sum + row.count, 0), data.outcome.total);
  assert.deepEqual(data.services, [
    { service: "medical_consultation", count: 3 }, { service: "dental_healthcare", count: 1 }, { service: "family_planning", count: 1 }
  ]);
  assert.deepEqual(data.workload.doctors, ["Doctor 1", "Doctor 2", "Doctor 3"]);
  const eight = data.workload.groups.find((group) => group.hour === 8);
  assert.deepEqual(eight.counts, { "Doctor 1": 1, "Doctor 2": 1, "Doctor 3": 0 });
  assert.deepEqual(data.workload.groups.find((group) => group.hour === 9).counts, { "Doctor 1": 0, "Doctor 2": 1, "Doctor 3": 0 });
  assert.equal(data.workload.groups.find((group) => group.hour === 12).counts["Doctor 1"], null);
  assert.equal(data.workload.unattributed, 0);
});

test("Trends multi-day ranges are daily, and 30 days of doctor workload is grouped into at most eight intervals", () => {
  const week = service.aggregateTrendsAnalytics(patients, counters, service.buildPeriod({ range: "7d" }, NOW), NOW);
  assert.deepEqual(week.buckets.map((bucket) => bucket.date), ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
  assert.deepEqual(week.buckets.map((bucket) => bucket.arrivals), [0, 0, 0, 0, 1, 2, 5]);
  assert.deepEqual(week.buckets.map((bucket) => bucket.completed), [0, 0, 0, 0, 0, 1, 3]);
  assert.equal(week.kpis.total_visits.value, 8);
  assert.deepEqual([week.kpis.total_visits.previous, week.kpis.total_visits.change_percent], [0, null], "no percentage from a zero baseline");
  assert.equal(week.workload.group_days, 1);
  const month = service.aggregateTrendsAnalytics(patients, counters, service.buildPeriod({ range: "30d" }, NOW), NOW);
  assert.equal(month.workload.group_days, 4);
  assert.equal(month.workload.groups.length, 8);
  assert.deepEqual([month.workload.groups[0].start_date, month.workload.groups[0].end_date], ["2026-09-16", "2026-09-19"]);
  assert.deepEqual([month.workload.groups[7].start_date, month.workload.groups[7].end_date], ["2026-10-14", "2026-10-15"]);
  assert.deepEqual(month.workload.groups[7].counts, { "Doctor 1": 2, "Doctor 2": 2, "Doctor 3": 0 });
});

test("an empty period reports zero visits and unavailable averages, never invented values", () => {
  const data = service.aggregateTrendsAnalytics([], counters, today(), NOW);
  assert.equal(data.kpis.total_visits.value, 0);
  assert.equal(data.kpis.avg_wait_minutes.value, null);
  assert.equal(data.kpis.avg_service_minutes.value, null);
  assert.equal(data.outcome.total, 0);
  assert.ok(data.outcome.statuses.every((row) => row.percentage === null));
  assert.deepEqual(data.services, []);
});

test("Status overview: registration cohort by current status, carry-ins apart, assigned visits by doctor", () => {
  const data = service.aggregateStatusOverview(patients, counters, today(), {}, NOW);
  assert.equal(data.cohort.total, 5);
  assert.deepEqual(data.cohort.statuses.map((row) => row.count), [2, 1, 1, 1]);
  assert.deepEqual(data.cohort.carry_in, { waiting: 1, serving: 0 });
  assert.deepEqual(data.by_doctor.doctors.map((row) => [row.doctor, row.total, row.completed, row.cancelled, row.serving]),
    [["Doctor 1", 2, 1, 1, 0], ["Doctor 2", 1, 1, 0, 0], ["Doctor 3", 1, 0, 0, 1]]);
  assert.equal(data.by_doctor.unassigned, 1, "the waiting visit with no doctor is never placed under a doctor");
  assert.equal(data.by_doctor.doctors.reduce((sum, row) => sum + row.total, 0) + data.by_doctor.unassigned, data.cohort.total);
  assert.equal(data.completion_trend.find((bucket) => bucket.hour === 8).completed, 2);
  assert.equal(data.completion_trend.find((bucket) => bucket.hour === 9).completed, 1);
  assert.equal(data.completion_trend.find((bucket) => bucket.hour === 15).completed, null);
  assert.equal(data.times.avg_wait_minutes, (10 + 40 + 5 + 960) / 4);
  assert.equal(data.times.avg_service_minutes, 19);
});

test("Status filters combine and narrow cards, charts and averages together", () => {
  const doctor = service.aggregateStatusOverview(patients, counters, today(), { doctor: "Doctor 1" }, NOW);
  assert.equal(doctor.cohort.total, 2);
  assert.deepEqual(doctor.cohort.statuses.map((row) => row.count), [1, 0, 0, 1]);
  assert.equal(doctor.completion_trend.find((bucket) => bucket.hour === 8).completed, 1);
  assert.deepEqual([doctor.times.avg_wait_minutes, doctor.times.avg_service_minutes], [10, 18]);
  const unassigned = service.aggregateStatusOverview(patients, counters, today(), { doctor: "unassigned" }, NOW);
  assert.deepEqual([unassigned.cohort.total, unassigned.by_doctor.unassigned], [1, 1]);
  const waiting = service.aggregateStatusOverview(patients, counters, today(), { status: "waiting" }, NOW);
  assert.equal(waiting.cohort.total, 1);
  assert.equal(waiting.times.avg_wait_minutes, null);
  assert.ok(waiting.completion_trend.every((bucket) => !bucket.completed));
  const combined = service.aggregateStatusOverview(patients, counters, today(), { service: "medical_consultation", doctor: "Doctor 3" }, NOW);
  assert.deepEqual([combined.cohort.total, combined.by_service[0].service], [1, "medical_consultation"]);
  const byCounterId = service.aggregateStatusOverview(patients, counters, today(), { doctor: "2" }, NOW);
  assert.equal(byCounterId.filters.doctor, "Doctor 2");
  for (const filters of [{ status: "no-show" }, { doctor: "Doctor 9" }, { service: "DROP TABLE" }]) {
    assert.throws(() => service.aggregateStatusOverview(patients, counters, today(), filters, NOW), (error) => error.statusCode === 400);
  }
});

test("Status records list ticket, patient name, service, doctor and times only, newest first", () => {
  const data = service.statusRecords(patients, counters, today(), {}, NOW);
  assert.equal(data.total, 5);
  assert.deepEqual(data.records.map((row) => row.id), [5, 4, 3, 2, 1]);
  const cancelled = data.records.find((row) => row.id === 4);
  assert.deepEqual([cancelled.ticket, cancelled.status, cancelled.completed_at, cancelled.cancelled_at], ["MC-004", "cancelled", null, at("09:45")]);
  assert.equal(data.records.find((row) => row.id === 2).doctor, "Doctor 2");
  assert.equal(data.records.find((row) => row.id === 3).doctor, null);
  for (const row of data.records) assert.deepEqual(Object.keys(row).sort(), ["called_at", "cancelled_at", "completed_at", "doctor", "id", "patient_name", "registered_at", "service", "status", "ticket"]);
  // The name is the visit's own stored name (patients.id_num), blank names are null; nothing else about the patient is returned.
  const named = service.statusRecords([{ ...patients[0], id_num: "  Dela Cruz, Maria  ", contact_number: "0917" }, { ...patients[2], id_num: " " }], counters, today(), {}, NOW);
  assert.deepEqual(named.records.map((row) => row.patient_name), [null, "Dela Cruz, Maria"]);
  assert.ok(named.records.every((row) => !("contact_number" in row)));
  assert.equal(service.statusRecords(patients, counters, today(), { status: "completed" }, NOW).total, 2);
});

test("the services read through the database and report connection problems as 503", async () => {
  const realNow = Date.now;
  Date.now = () => NOW.getTime();
  const RealDate = global.Date;
  global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); } static now() { return NOW.getTime(); } };
  try {
    const database = { patients, counters };
    const live = loadService(database);
    const trends = await live.getTrendsAnalytics({ range: "today" });
    assert.equal(trends.kpis.total_visits.value, 5);
    const overview = await live.getStatusOverview({ range: "today", doctor: "Doctor 1" });
    assert.equal(overview.cohort.total, 2);
    const patientReads = () => database.reads.filter((read) => read.table === "patients").map((read) => read.columns.split(","));
    assert.ok(patientReads().every((columns) => !columns.includes("id_num")), "Trends and the Status overview never read patient names");
    const before = patientReads().length;
    const records = await live.getStatusRecords({ range: "today" });
    assert.equal(records.total, 5);
    assert.ok(patientReads().slice(before).every((columns) => columns.includes("id_num")), "the records table reads the stored name");
    await assert.rejects(live.getTrendsAnalytics({ range: "never" }), (error) => error.statusCode === 400);
    const offline = loadService();
    await assert.rejects(offline.getTrendsAnalytics({ range: "today" }), (error) => error.statusCode === 503);
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});

test("periods: Last 12 Months and custom ranges over 62 days are grouped by calendar month", () => {
  const year = service.buildPeriod({ range: "12m" }, NOW);
  assert.deepEqual([year.start_date, year.end_date, year.days, year.granularity, year.live], ["2025-11-01", "2026-10-15", 349, "month", true]);
  const back = service.comparisonPeriod(year);
  assert.deepEqual([back.start_date, back.end_date, back.label], ["2024-11-01", "2025-10-15", "vs same period a year earlier (same elapsed time)"]);
  assert.equal(service.buildPeriod({ range: "custom", startDate: "2026-08-01", endDate: "2026-10-01" }, NOW).granularity, "day", "62 days stay daily");
  assert.equal(service.buildPeriod({ range: "custom", startDate: "2026-07-31", endDate: "2026-10-01" }, NOW).granularity, "month", "63 days are monthly");
});

test("Trends by month: twelve calendar-month intervals that add up to the KPIs", () => {
  const data = service.aggregateTrendsAnalytics(patients, counters, service.buildPeriod({ range: "12m" }, NOW), NOW);
  assert.equal(data.buckets.length, 12);
  assert.deepEqual([data.buckets[0].date, data.buckets[0].end_date], ["2025-11-01", "2025-11-30"]);
  assert.deepEqual([data.buckets[11].date, data.buckets[11].end_date], ["2026-10-01", "2026-10-15"], "the current month runs to today");
  assert.deepEqual(data.buckets.map((bucket) => bucket.arrivals), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]);
  assert.equal(data.buckets.reduce((sum, bucket) => sum + bucket.arrivals, 0), data.kpis.total_visits.value);
  assert.equal(data.buckets[11].completed, 4);
  assert.equal(data.buckets[11].waiting, 2, "the month in progress uses the stored statuses");
  assert.deepEqual([data.workload.granularity, data.workload.group_days, data.workload.groups.length], ["month", null, 12]);
  assert.deepEqual(data.workload.groups[11].counts, { "Doctor 1": 2, "Doctor 2": 2, "Doctor 3": 0 });
  const status = service.aggregateStatusOverview(patients, counters, service.buildPeriod({ range: "12m" }, NOW), {}, NOW);
  assert.equal(status.cohort.total, 8);
  assert.equal(status.completion_trend.length, 12);
  assert.equal(status.completion_trend[11].completed, 4);
});

const linked = patients.map((row) => ({ ...row, patient_record_id: { 1: 101, 2: 101, 5: 102, 7: 103 }[row.id] ?? null }));
const profiles = [
  { id: 101, created_at: at("08:00") },
  { id: 102, created_at: at("09:58") },
  { id: 103, created_at: at("07:59", "2026-10-14") },
  { id: 104, created_at: at("11:00", "2026-10-14") },
  { id: 104, created_at: at("11:00", "2026-10-14") }
];

test("Trends patient registrations: patient records by creation time, each linked patient counted once", () => {
  const data = service.aggregateTrendsAnalytics(linked, counters, today(), NOW, { profiles });
  // Yesterday up to 10:30 had record 103 only; 104 (11:00 yesterday) is past the same-time cut.
  assert.deepEqual(data.kpis.new_patient_records, { value: 2, previous: 1, change_percent: 100 });
  assert.equal(bucketAt(data, 8).new_patient_records, 1);
  assert.equal(bucketAt(data, 9).new_patient_records, 1);
  assert.equal(bucketAt(data, 7).new_patient_records, 0);
  assert.equal(bucketAt(data, 11).new_patient_records, null, "a future hour is unknown, not zero");
  // Today's five visits: 1 and 2 belong to record 101, 5 to record 102, 3 and 4 have no record.
  assert.deepEqual(data.patients, { visits: 5, distinct_patients: 2, linked_visits: 3, unlinked_visits: 2 });
  const week = service.aggregateTrendsAnalytics(linked, counters, service.buildPeriod({ range: "7d" }, NOW), NOW, { profiles });
  assert.equal(week.kpis.new_patient_records.value, 4, "a duplicated row is counted once");
  assert.deepEqual(week.buckets.map((bucket) => bucket.new_patient_records), [0, 0, 0, 0, 0, 2, 2]);
  assert.deepEqual(week.patients, { visits: 8, distinct_patients: 3, linked_visits: 4, unlinked_visits: 4 });
});

test("Trends patient registrations are unavailable, not zero, when the database cannot supply them", () => {
  const data = service.aggregateTrendsAnalytics(patients, counters, today(), NOW, { profiles: null, linksKnown: false });
  assert.deepEqual(data.kpis.new_patient_records, { value: null, previous: null, change_percent: null });
  assert.equal(bucketAt(data, 8).new_patient_records, null);
  assert.equal(data.patients, null);
  assert.ok(data.notes.some((note) => /patient records table could not be read/.test(note)));
  assert.ok(data.notes.some((note) => /no patient record link/.test(note)));
});

test("the Trends service reads patient_records and tolerates a database without patient records", async () => {
  const realNow = Date.now;
  Date.now = () => NOW.getTime();
  const RealDate = global.Date;
  global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); } static now() { return NOW.getTime(); } };
  try {
    const full = await loadService({ patients: linked, counters, patient_records: profiles }).getTrendsAnalytics({ range: "today" });
    assert.equal(full.kpis.new_patient_records.value, 2);
    assert.equal(full.patients.distinct_patients, 2);
    const bare = await loadService({ patients, counters, noRecordLink: true }).getTrendsAnalytics({ range: "today" });
    assert.equal(bare.kpis.total_visits.value, 5, "visits are still read without the link column");
    assert.equal(bare.patients, null);
    assert.equal(bare.kpis.new_patient_records.value, null);
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});

test("Status uses the same patient-record calculation as Trends, narrowed by its filters", () => {
  const period = today();
  const trends = service.aggregateTrendsAnalytics(linked, counters, period, NOW, { profiles });
  const status = service.aggregateStatusOverview(linked, counters, period, {}, NOW);
  assert.deepEqual(status.patients, trends.patients, "both tabs report the same linked, distinct and unlinked figures");
  assert.equal(status.patients.visits, status.cohort.total, "the figures describe exactly the visits on the status cards");
  assert.equal(status.patients.linked_visits + status.patients.unlinked_visits, status.cohort.total);
  // Filtered to completed: visits 1 and 2, both record 101 — one registered patient, nothing guessed.
  const completed = service.aggregateStatusOverview(linked, counters, period, { status: "completed" }, NOW);
  assert.deepEqual(completed.patients, { visits: 2, distinct_patients: 1, linked_visits: 2, unlinked_visits: 0 });
  const bare = service.aggregateStatusOverview(patients, counters, period, {}, NOW, { linksKnown: false });
  assert.equal(bare.patients, null, "unavailable, not zero, without the link column");
  assert.ok(bare.notes.some((note) => /no patient record link/.test(note)));
});

test("the Status service passes the visit link through and tolerates a database without it", async () => {
  const realNow = Date.now;
  Date.now = () => NOW.getTime();
  const RealDate = global.Date;
  global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); } static now() { return NOW.getTime(); } };
  try {
    const full = await loadService({ patients: linked, counters, patient_records: profiles }).getStatusOverview({ range: "today" });
    assert.deepEqual(full.patients, { visits: 5, distinct_patients: 2, linked_visits: 3, unlinked_visits: 2 });
    const bare = await loadService({ patients, counters, noRecordLink: true }).getStatusOverview({ range: "today" });
    assert.equal(bare.cohort.total, 5, "visits are still counted without the link column");
    assert.equal(bare.patients, null);
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});
