const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const clone = value => JSON.parse(JSON.stringify(value));
const date = "2026-10-15";
const at = (time, day = date) => `${day}T${time}:00+08:00`;
const patient = (id, overrides = {}) => ({ id, status: "waiting", created_at: at("08:00"), called_at: null,
  consultation_started_at: null, completed_at: null, counter_id: null, ...overrides });
const counter = (id, overrides = {}) => ({ id, id_num: `Doctor ${id}`, is_online: true, ...overrides });

function load(relative, imports, clock) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const filename = path.resolve(__dirname, "../src", relative), module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { Date: FixedDate, console });
  wrapper(name => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

function harness(patients = [], options = {}) {
  const clock = { now: Date.parse(options.now || at("10:30")) }, calls = [];
  const database = { patients, counters: options.counters || [counter(1), counter(2, { is_online: false })] };
  let failure = null;
  const supabase = { from(table) {
    assert.ok(["patients", "counters"].includes(table));
    const query = {
      filters: [], columns: null,
      select(columns) { this.columns = columns; return this; },
      lte(column, value) { this.filters.push(row => Date.parse(row[column]) <= Date.parse(value)); return this; },
      or(expression) {
        this.expression = expression;
        assert.ok(!expression.includes("no-show"), "Never query an unsupported no-show enum value");
        const clauses = expression.split(/,(?![^()]*\))/).map(clause => {
          const [, column, operator, value] = clause.match(/^(\w+)\.(gte|in|is)\.(.+)$/) || [];
          assert.ok(column, `Unexpected overlap filter: ${clause}`);
          if (operator === "gte") return row => Date.parse(row[column]) >= Date.parse(value);
          if (operator === "is") { assert.equal(value, "null"); return row => row[column] == null; }
          const values = value.slice(1, -1).split(",");
          return row => values.includes(row[column]);
        });
        this.filters.push(row => clauses.some(clause => clause(row)));
        return this;
      },
      order(column, ordering) { assert.equal(column, "id"); assert.equal(ordering.ascending, true); return this; },
      async range(start, end) {
        calls.push({ table, start, end, columns: this.columns, overlap: this.expression });
        if (failure === "transport") throw new Error("Isolated transport outage");
        if (failure) return { data: null, error: { message: "Isolated database outage" } };
        const rows = database[table].filter(row => this.filters.every(filter => filter(row))).sort((a, b) => Number(a.id) - Number(b.id));
        return { data: clone(rows.slice(start, Math.min(end + 1, start + 1000))), error: null };
      }
    };
    return query;
  } };
  const imports = { "../lib/supabase": supabase,
    "../config/env": options.unconfigured ? {} : { supabaseUrl: "https://isolated.test", supabaseServiceRoleKey: "isolated-key" } };
  const daily = load("services/dailyTrendsService.js", imports, clock);
  const service = load("services/statusAnalyticsService.js", { ...imports, "./dailyTrendsService": daily }, clock);
  const aggregate = (rows = patients, filter = { date }, counters = database.counters) => clone(service.aggregateStatusAnalytics(
    rows, counters, daily.buildRange(filter, new Date(clock.now)), new Date(clock.now)));
  return { clock, calls, service, daily, database, aggregate, setFailure(value = "query") { failure = value; } };
}

const shift = (startTime = "08:00", endTime = "12:00") => ({ date, view: "shift", startTime, endTime });
const hour = (result, time) => {
  const bucket = result.hourly.find(item => item.label.startsWith(`${time}`));
  assert.ok(bucket, `Missing interval ${time}`);
  return bucket;
};

test("same elapsed preceding-day comparison excludes yesterday's later events and reconstructs snapshots", () => {
  const h = harness([
    patient(1, { status: "completed", created_at: at("08:10"), called_at: at("08:20"), consultation_started_at: at("08:30"), completed_at: at("08:50") }),
    patient(2, { created_at: at("10:00") }),
    patient(3, { status: "completed", created_at: at("08:10", "2026-10-14"), called_at: at("08:15", "2026-10-14"),
      consultation_started_at: at("08:20", "2026-10-14"), completed_at: at("08:30", "2026-10-14") }),
    patient(4, { status: "completed", created_at: at("09:00", "2026-10-14"), called_at: at("11:00", "2026-10-14"),
      consultation_started_at: at("11:05", "2026-10-14"), completed_at: at("11:10", "2026-10-14") }),
    patient(5, { status: "completed", created_at: at("11:00", "2026-10-14"), called_at: at("11:05", "2026-10-14"),
      consultation_started_at: at("11:10", "2026-10-14"), completed_at: at("11:30", "2026-10-14") })
  ]);
  const result = h.aggregate(undefined, shift());
  assert.equal(result.comparison_range.start_at, "2026-10-14T00:00:00.000Z");
  assert.equal(result.comparison_range.effective_end_at, "2026-10-14T02:30:00.000Z");
  assert.equal(result.metrics.total_patients.value, 2);
  assert.equal(result.metrics.total_patients.previous, 2);
  assert.equal(result.metrics.total_patients.change_percent, 0);
  assert.equal(result.metrics.completed_patients.previous, 1);
  assert.equal(result.metrics.waiting_patients.previous, 1, "Later completed patient was still waiting at yesterday's equivalent cutoff");
  assert.equal(result.metrics.waiting_patients.value, 1);
  assert.equal(result.metrics.avg_wait_minutes.value, 10);
  assert.equal(result.metrics.avg_wait_minutes.previous, 5);
  assert.equal(result.metrics.avg_wait_minutes.change_percent, 100);
  assert.equal(result.metrics.avg_service_minutes.value, 20);
  assert.equal(result.metrics.avg_service_minutes.previous, 10);
});

test("queue length integrates carry-in patient-time and partial hours instead of counting arrivals or snapshots", () => {
  const h = harness([
    patient(1, { created_at: at("07:30") }),
    patient(2, { status: "completed", created_at: at("08:15"), called_at: at("08:45"), consultation_started_at: at("09:00"), completed_at: at("09:15") }),
    patient(3, { status: "serving", created_at: at("08:45"), called_at: at("09:15") })
  ], { now: at("09:30") });
  const result = h.aggregate(undefined, shift("08:00", "10:00"));
  assert.equal(hour(result, "08:00").arrivals, 2);
  assert.equal(hour(result, "08:00").waiting, 2);
  assert.equal(hour(result, "08:00").avg_queue_length, 1.75);
  assert.equal(hour(result, "09:00").avg_queue_length, 1.5);
  assert.equal(result.metrics.waiting_patients.value, 1);
  assert.equal(result.metrics.currently_serving.value, 1);
  assert.equal(result.metrics.avg_service_minutes.value, 15);
});

test("incomplete and undone waiting histories invalidate only intersecting hourly averages", () => {
  const h = harness([
    patient(1, { status: "cancelled", created_at: at("08:15"), completed_at: at("08:45") }),
    patient(2, { status: "completed", created_at: at("09:10"), consultation_started_at: at("09:40"), completed_at: at("09:55") }),
    patient(3, { created_at: at("10:05"), called_at: at("10:10") })
  ]);
  const result = h.aggregate(undefined, shift());
  assert.equal(hour(result, "08:00").avg_queue_length, 0.5);
  assert.equal(hour(result, "09:00").avg_queue_length, null);
  assert.equal(hour(result, "10:00").avg_queue_length, null);
  assert.equal(hour(result, "11:00").avg_queue_length, null, "Future is unavailable, not an empty observed interval");
  assert.equal(result.metrics.waiting_patients.value, 1, "Present stored status remains reliable after Undo");
  assert.ok(result.notes.some(note => note.includes("intersecting hours")));
});

test("completed past intervals retain correct historical waiting and called-phase serving snapshots", () => {
  const h = harness([
    patient(1, { status: "completed", created_at: at("08:00"), called_at: at("08:30"), consultation_started_at: at("08:40"), completed_at: at("09:30") }),
    patient(2, { created_at: at("08:45") }),
    patient(3, { status: "cancelled", created_at: at("08:00"), completed_at: at("08:50") })
  ]);
  const result = h.aggregate(undefined, shift("08:00", "09:00"));
  assert.equal(result.metrics.waiting_patients.value, 1);
  assert.equal(result.metrics.currently_serving.value, 1);
  assert.equal(result.metrics.completed_patients.value, 0);
  assert.equal(result.metrics.total_patients.value, 3);
  assert.equal(hour(result, "08:00").avg_queue_length, (30 + 15 + 50) / 60);
});

test("ambiguous past snapshots become unavailable while a recorded consultation establishes later serving", () => {
  const h = harness([patient(1, { status: "completed", created_at: at("08:00"), consultation_started_at: at("09:10"), completed_at: at("10:00") })]);
  const before = h.aggregate(undefined, shift("08:00", "09:00"));
  assert.equal(before.metrics.waiting_patients.value, null);
  assert.equal(before.metrics.currently_serving.value, null);
  const after = h.aggregate(undefined, shift("09:00", "09:30"));
  assert.equal(after.metrics.waiting_patients.value, 0);
  assert.equal(after.metrics.currently_serving.value, 1);
  assert.equal(hour(after, "09:00").avg_queue_length, null);
  const undone = h.aggregate([patient(2, { called_at: at("08:10") })], shift("08:00", "09:00"));
  assert.equal(undone.metrics.waiting_patients.value, null);
  assert.equal(undone.metrics.currently_serving.value, null);
});

test("duration metrics use patient-weighted samples and real service starts, retaining microseconds", () => {
  const h = harness([
    patient(1, { status: "completed", created_at: at("08:40"), called_at: at("08:50"), consultation_started_at: at("08:50"), completed_at: at("09:00") }),
    patient(2, { status: "completed", created_at: at("08:30"), called_at: at("08:50"), consultation_started_at: at("09:40"), completed_at: at("10:00") }),
    patient(3, { status: "completed", created_at: at("09:00"), called_at: at("10:00"), consultation_started_at: at("10:00"), completed_at: at("10:30") })
  ]);
  const result = h.aggregate(undefined, shift());
  assert.equal(result.metrics.avg_wait_minutes.value, 30);
  assert.equal(result.metrics.avg_service_minutes.value, 20);
  assert.equal(hour(result, "08:00").avg_wait_minutes, 15);
  assert.equal(hour(result, "10:00").avg_wait_minutes, 60);
  assert.equal(hour(result, "09:00").avg_service_minutes, 10);
  assert.equal(hour(result, "10:00").avg_service_minutes, 25);
  const precise = h.aggregate([patient(4, { status: "completed", created_at: "2026-10-15T08:00:00.000001+08:00",
    called_at: "2026-10-15T00:00:00.000061Z", consultation_started_at: "2026-10-15T00:00:00.000101Z",
    completed_at: "2026-10-15T08:00:00.000901+08:00" })]);
  assert.equal(precise.metrics.avg_wait_minutes.value, 0.000001);
  assert.equal(precise.metrics.avg_service_minutes.value, 0.0008 / 60);
});

test("legacy, invalid and interrupted visits do not create fake completed-service or waiting samples", () => {
  const h = harness([
    patient(1, { status: "completed", called_at: at("08:10"), completed_at: at("09:00") }),
    patient(2, { status: "completed", called_at: at("07:59"), consultation_started_at: at("08:10"), completed_at: at("08:09") }),
    patient(3, { status: "cancelled", called_at: at("08:10"), consultation_started_at: at("08:15"), completed_at: at("09:00"), counter_id: "Doctor 1" }),
    patient(4, { status: "completed", called_at: "invalid", consultation_started_at: "invalid", completed_at: at("09:00") })
  ]);
  const result = h.aggregate();
  assert.equal(result.metrics.avg_wait_minutes.value, 10);
  assert.equal(result.metrics.avg_service_minutes.value, null);
  assert.equal(result.counters[0].active_service_minutes, 45);
  assert.equal(result.counters[0].avg_service_minutes, null);
});

test("malformed nonnull start and end timestamps use identical card and hourly duration samples", () => {
  const h = harness([
    patient(1, { status: "completed", called_at: at("08:10"), consultation_started_at: "invalid", completed_at: at("09:00") }),
    patient(2, { status: "serving", created_at: at("08:20"), called_at: at("08:30"), completed_at: "invalid" }),
    patient(3, { status: "completed", called_at: at("08:20"), consultation_started_at: at("08:30"), completed_at: at("09:00") }),
    patient(4, { status: "completed", created_at: at("08:30"), called_at: at("09:00"), consultation_started_at: at("09:10"), completed_at: at("10:00") })
  ]);
  const result = h.aggregate(undefined, shift());
  assert.equal(result.metrics.avg_wait_minutes.value, 25);
  assert.equal(result.metrics.avg_service_minutes.value, 40);
  assert.equal(hour(result, "08:00").wait_samples, 1, "Malformed nonnull start/end records are excluded from both card and chart");
  assert.equal(hour(result, "08:00").avg_wait_minutes, 20);
  assert.equal(hour(result, "09:00").wait_samples, 1);
  assert.equal(hour(result, "09:00").avg_wait_minutes, 30);
  assert.equal(hour(result, "09:00").service_samples, 1);
  assert.equal(hour(result, "10:00").service_samples, 1);
  for (const [metric, samples] of [["avg_wait_minutes", "wait_samples"], ["avg_service_minutes", "service_samples"]]) {
    const count = result.hourly.reduce((sum, bucket) => sum + (bucket[samples] || 0), 0);
    const total = result.hourly.reduce((sum, bucket) => sum + (bucket[metric] || 0) * (bucket[samples] || 0), 0);
    assert.equal(count, 2);
    assert.equal(result.metrics[metric].value, total / count);
  }
});

test("observed rates share elapsed hours and arrival-cohort completion percentage excludes carry-in completions", () => {
  const h = harness([
    ...[1, 2, 3].map(id => patient(id, { status: "completed", created_at: at("07:00"), called_at: at("07:10"), consultation_started_at: at("07:30"), completed_at: at(`08:${id}0`) })),
    patient(4, { status: "completed", created_at: at("08:10"), called_at: at("08:20"), consultation_started_at: at("08:30"), completed_at: at("09:00") }),
    patient(5, { created_at: at("09:00") })
  ], { now: at("10:00") });
  const result = h.aggregate(undefined, shift());
  assert.equal(result.metrics.completed_patients.value, 4);
  assert.equal(result.metrics.total_patients.value, 2);
  assert.equal(result.rates.elapsed_hours, 2);
  assert.equal(result.rates.arrival_rate_per_hour, 1);
  assert.equal(result.rates.service_rate_per_hour, 2);
  assert.equal(result.rates.completion_rate_percent, 50);
  assert.equal(result.rates.completion_numerator, 1);
  assert.equal(result.rates.completion_denominator, 2);
  assert.equal(result.rates.operational_status, "Insufficient Data");
  assert.match(result.rates.description, /throughput/);
  assert.ok(result.notes.some(note => note.includes("not theoretical service capacity")));
});

test("exact end boundaries exclude events and cohort completions while current observation includes its instant", () => {
  const h = harness([
    patient(1, { status: "completed", called_at: at("08:10"), consultation_started_at: at("08:20"), completed_at: at("09:00") }),
    patient(2, { created_at: at("09:00") })
  ]);
  const past = h.aggregate(undefined, shift("08:00", "09:00"));
  assert.equal(past.metrics.total_patients.value, 1);
  assert.equal(past.metrics.completed_patients.value, 0);
  assert.equal(past.metrics.currently_serving.value, 1);
  assert.equal(past.rates.completion_numerator, 0);
  assert.equal(past.rates.completion_rate_percent, 0);
  h.clock.now = Date.parse(at("09:00"));
  const endingNow = h.aggregate(undefined, shift("08:00", "09:00"));
  assert.equal(endingNow.metrics.total_patients.value, 1);
  assert.equal(endingNow.metrics.completed_patients.value, 0);
  assert.equal(endingNow.metrics.currently_serving.value, 1, "A selected period ending exactly now still uses its exclusive-end snapshot");
  assert.equal(endingNow.metrics.waiting_patients.value, 0);
  assert.equal(endingNow.rates.completion_numerator, 0);
  assert.equal(endingNow.hourly.reduce((sum, bucket) => sum + (bucket.service_samples || 0), 0), 0);
  assert.equal(endingNow.metrics.avg_service_minutes.value, null);
  const current = h.aggregate(undefined, shift("08:00", "10:00"));
  assert.equal(current.metrics.total_patients.value, 2);
  assert.equal(current.metrics.completed_patients.value, 1);
  assert.equal(current.rates.completion_numerator, 1);
  assert.equal(current.rates.completion_rate_percent, 50);
  assert.equal(hour(current, "09:00").service_samples, 1, "An event exactly at observation belongs to its hour even before that hour has elapsed");
  assert.equal(hour(current, "09:00").avg_service_minutes, current.metrics.avg_service_minutes.value);
});

test("counter summaries group full completed durations while recorded active time clips and merges intervals", () => {
  const h = harness([
    patient(1, { status: "completed", created_at: at("07:00"), called_at: at("08:00"), consultation_started_at: at("08:10"), completed_at: at("09:10"), counter_id: "Doctor 1" }),
    patient(2, { status: "completed", created_at: at("07:00"), called_at: at("08:20"), consultation_started_at: at("08:30"), completed_at: at("09:00"), counter_id: 1 }),
    patient(3, { status: "serving", called_at: at("09:50"), consultation_started_at: at("10:00"), counter_id: "Doctor 1" }),
    patient(4, { status: "completed", called_at: at("08:20"), completed_at: at("09:00"), counter_id: "Doctor 2" })
  ]);
  const result = h.aggregate(undefined, shift("08:30", "12:00"));
  assert.deepEqual(result.counters[0], { id: 1, name: "Doctor 1", total_served: 2, avg_service_minutes: 45,
    total_service_minutes: 90, active_service_minutes: 70, available_minutes: null, utilization_percent: null, status: "Enabled" });
  assert.equal(result.counters[1].total_served, 1);
  assert.equal(result.counters[1].avg_service_minutes, null);
  assert.equal(result.counters[1].total_service_minutes, null);
  assert.equal(result.counters[1].status, "Disabled");
  assert.ok(result.notes.some(note => note.includes("not historical presence")));
});

test("distribution uses only actual stored statuses and unique visits without mutating records", () => {
  const rows = [patient(1), patient("1"), patient(2, { status: "cancelled", completed_at: at("09:00") }),
    { status: "waiting", created_at: at("08:00") }];
  const before = clone(rows), h = harness(rows), result = h.aggregate();
  assert.equal(result.metrics.total_patients.value, 2);
  assert.equal(result.record_count, 2);
  assert.deepEqual(result.statuses, [{ status: "waiting", label: "Waiting", count: 1, percentage: 50 },
    { status: "cancelled", label: "Cancelled", count: 1, percentage: 50 }]);
  assert.deepEqual(rows, before);
  assert.ok(result.notes.some(note => note.includes("without a unique")));
});

test("observed empty and future periods distinguish zero counts, unavailable samples and valid zero comparisons", () => {
  const h = harness([]);
  const empty = h.aggregate(undefined, shift());
  assert.equal(empty.metrics.total_patients.value, 0);
  assert.equal(empty.metrics.total_patients.previous, 0);
  assert.equal(empty.metrics.total_patients.change_percent, 0);
  assert.equal(empty.metrics.avg_wait_minutes.value, null);
  assert.equal(empty.rates.arrival_rate_per_hour, 0);
  assert.equal(empty.rates.completion_rate_percent, null);
  assert.equal(hour(empty, "08:00").avg_queue_length, 0);
  assert.equal(empty.counters[0].total_served, 0);
  assert.deepEqual(empty.statuses, []);
  const future = h.aggregate(undefined, { date: "2026-10-16" });
  assert.ok(Object.values(future.metrics).every(item => item.value === null && item.previous === null && item.change_percent === null));
  assert.ok(future.hourly.every(item => item.avg_queue_length === null));
  assert.equal(future.rates.arrival_rate_per_hour, null);
  assert.equal(future.rates.service_rate_per_hour, null);
  assert.equal(future.counters[0].total_served, null);
  const newActivity = h.aggregate([patient(1)], shift());
  assert.equal(newActivity.metrics.total_patients.change_percent, null, "A zero prior baseline must not invent an infinite percentage");
});

test("Manila custom shifts group partial and overnight hours with calendar-valid filters", async () => {
  const h = harness([
    patient(1, { created_at: at("22:29") }),
    patient(2, { status: "completed", created_at: at("22:30"), called_at: at("23:59"), consultation_started_at: at("00:00", "2026-10-16"), completed_at: at("00:30", "2026-10-16") }),
    patient(3, { created_at: at("00:05", "2026-10-16") }),
    patient(4, { created_at: at("01:15", "2026-10-16") })
  ], { now: at("02:00", "2026-10-16") });
  const result = h.aggregate(undefined, shift("22:30", "01:15"));
  assert.equal(result.metrics.total_patients.value, 2);
  assert.equal(result.metrics.completed_patients.value, 1);
  assert.equal(result.metrics.waiting_patients.value, 2);
  assert.equal(result.rates.elapsed_hours, 2.75);
  assert.equal(hour(result, "22:30").arrivals, 1);
  assert.equal(hour(result, "00:00").served, 1);
  assert.match(hour(result, "00:00").label, /\(\+1 day\)/);
  assert.equal(result.comparison_range.effective_end_at, "2026-10-14T17:15:00.000Z");
  for (const filter of [{ date: "2026-02-29" }, { date: "2026-04-31" }, { date: [date] },
    { date, view: ["day"] }, shift("08:00", "08:00"), shift("24:00", "09:00"), { ...shift(), startTime: ["08:00"] }]) {
    await assert.rejects(h.service.getStatusAnalytics(filter), error => error.statusCode === 400);
  }
});

test("paged read-only database aggregation includes carry-ins and more than 1000 patients and counters", async () => {
  const h = harness(Array.from({ length: 1201 }, (_, index) => patient(index + 1, { created_at: at("23:00", "2026-10-13") })),
    { counters: Array.from({ length: 1001 }, (_, index) => counter(index + 1)) });
  const result = clone(await h.service.getStatusAnalytics({ date }));
  assert.equal(result.metrics.waiting_patients.value, 1201);
  assert.equal(result.metrics.waiting_patients.previous, 1201);
  assert.equal(result.metrics.total_patients.value, 0);
  assert.equal(result.counters.length, 1001);
  assert.deepEqual(h.calls.filter(call => call.table === "patients").map(call => call.start), [0, 500, 1000]);
  assert.deepEqual(h.calls.filter(call => call.table === "counters").map(call => call.start), [0, 500, 1000]);
  assert.ok(h.calls.filter(call => call.table === "patients").every(call => call.overlap.includes("created_at.gte.2026-10-13T16:00:00.000Z")));
  assert.ok(h.calls.filter(call => call.table === "counters").every(call => call.columns === "id,id_num,is_online"));
});

test("fresh database reads reflect registration, call, consultation, completion and cancellation", async () => {
  const h = harness([patient(1)]);
  assert.equal((await h.service.getStatusAnalytics({ date })).metrics.waiting_patients.value, 1);
  Object.assign(h.database.patients[0], { status: "serving", called_at: at("10:10"), counter_id: "Doctor 1" });
  let result = await h.service.getStatusAnalytics({ date });
  assert.equal(result.metrics.waiting_patients.value, 0);
  assert.equal(result.metrics.currently_serving.value, 1);
  h.database.patients[0].consultation_started_at = at("10:15");
  assert.equal((await h.service.getStatusAnalytics({ date })).counters[0].active_service_minutes, 15);
  Object.assign(h.database.patients[0], { status: "completed", completed_at: at("10:25") });
  h.database.patients.push(patient(2, { status: "cancelled", created_at: at("10:05"), completed_at: at("10:20") }));
  result = await h.service.getStatusAnalytics({ date });
  assert.equal(result.metrics.completed_patients.value, 1);
  assert.equal(result.metrics.avg_service_minutes.value, 10);
  assert.equal(result.counters[0].total_served, 1);
  assert.equal(result.statuses.find(item => item.status === "cancelled").count, 1);
});

test("database and transport failures fail closed and missing configuration performs no reads", async () => {
  for (const failure of ["query", "transport"]) {
    const h = harness([patient(1)]);
    h.setFailure(failure);
    await assert.rejects(h.service.getStatusAnalytics({ date }), error => error.statusCode === 503 && /Status Analytics/.test(error.message));
    h.setFailure(null);
    assert.equal((await h.service.getStatusAnalytics({ date })).metrics.total_patients.value, 1);
  }
  const h = harness([], { unconfigured: true });
  await assert.rejects(h.service.getStatusAnalytics({ date }), error => error.statusCode === 503);
  assert.equal(h.calls.length, 0);
});

test("Status Analytics route preserves Superadmin auth, validates functional filters, no-store and outage errors", async () => {
  const h = harness([patient(1)]), routes = new Map(), secret = "isolated-status-analytics-secret";
  const presence = { validateAuthSession: async () => ({ session_id: "isolated" }) };
  const auth = load("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": { jwtSecret: secret }, "../services/presenceService": presence }, h.clock);
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) router[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  load("routes/index.js", { express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto,
    "../config/env": { jwtSecret: secret }, "../middleware/auth": auth, "../services/presenceService": presence,
    "../services/queueService": {}, "../services/settingsService": {}, "../services/statusAnalyticsService": h.service }, h.clock);
  async function request(role, query = { date }) {
    const token = role && jwt.sign({ role, jti: crypto.randomUUID() }, secret);
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, query };
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name] = value; }, json(body) { this.body = clone(body); return this; } };
    const handlers = routes.get("get /analytics/status");
    assert.ok(handlers, "Root integration must retain the scoped Status Analytics route");
    async function run(index) {
      if (!handlers[index]) return;
      let next;
      await handlers[index](req, res, () => { next = run(index + 1); return next; });
      if (next) await next;
    }
    await run(0);
    return res;
  }
  assert.equal((await request()).statusCode, 401);
  assert.equal((await request("admin")).statusCode, 403);
  assert.equal(h.calls.length, 0);
  const success = await request("superadmin", shift("08:15", "09:30"));
  assert.equal(success.statusCode, 200);
  assert.equal(success.headers["Cache-Control"], "no-store");
  assert.equal(success.body.data.range.view, "shift");
  assert.equal(success.body.data.hourly.length, 2);
  assert.equal(success.body.data.range.start_time, "08:15");
  assert.equal((await request("superadmin", { date: [date] })).statusCode, 400);
  h.setFailure();
  assert.equal((await request("superadmin")).statusCode, 503);
});
