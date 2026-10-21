const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const clone = (value) => JSON.parse(JSON.stringify(value));
const date = "2026-10-15";
const at = (time, day = date) => `${day}T${time}:00+08:00`;
const patient = (id, overrides = {}) => ({ id, status: "waiting", created_at: at("08:00"), called_at: null,
  consultation_started_at: null, completed_at: null, counter_id: null, ...overrides });
const counter = (id) => ({ id, id_num: `Doctor ${id}` });

function load(relative, imports, clock) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const filename = path.resolve(__dirname, "../src", relative), module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { Date: FixedDate, console });
  wrapper((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

function harness(patients = [], options = {}) {
  const clock = { now: Date.parse(options.now || at("10:30")) }, calls = [];
  const database = { patients, counters: options.counters || [counter(1), counter(2)] };
  let failure = null;
  const supabase = { from(table) {
    assert.ok(["patients", "counters"].includes(table));
    const query = {
      filters: [], columns: null,
      select(columns) { this.columns = columns; return this; },
      lte(column, value) { this.filters.push(row => Date.parse(row[column]) <= Date.parse(value)); return this; },
      or(expression) {
        this.expression = expression;
        const clauses = expression.split(/,(?![^()]*\))/).map((clause) => {
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
  const service = load("services/dailyTrendsService.js", {
    "../lib/supabase": supabase,
    "../config/env": options.unconfigured ? {} : { supabaseUrl: "https://isolated.test", supabaseServiceRoleKey: "isolated-key" }
  }, clock);
  const aggregate = (rows = patients, filter = { date }, counters = database.counters) => clone(service.aggregateDailyTrends(
    rows, counters, service.buildRange(filter, new Date(clock.now)), new Date(clock.now)));
  return { clock, calls, service, database, aggregate, setFailure(value = "query") { failure = value; } };
}

const hour = (result, label) => {
  const bucket = result.hourly.find(item => item.label === label);
  assert.ok(bucket, `Missing interval ${label}`);
  return bucket;
};

test("strict Manila daily/custom shift ranges validate dates, query arrays, clock boundaries, and overnight dates", () => {
  const h = harness([], { now: "2026-10-14T16:00:00Z" }), range = clone(h.service.buildRange({}, new Date(h.clock.now)));
  assert.equal(range.date, date);
  assert.equal(range.start_at, "2026-10-14T16:00:00.000Z");
  assert.equal(range.end_at, "2026-10-15T16:00:00.000Z");
  assert.equal(range.end_time, "24:00");
  const overnight = h.service.buildRange({ date, view: "shift", startTime: "22:30", endTime: "01:15" }, new Date(h.clock.now));
  assert.equal(overnight.start_at, "2026-10-15T14:30:00.000Z");
  assert.equal(overnight.end_at, "2026-10-15T17:15:00.000Z");
  const labels = h.aggregate([], { date, view: "shift", startTime: "22:30", endTime: "01:15" }).hourly.map(item => item.label);
  assert.deepEqual(labels, ["22:30–23:00", "23:00–24:00", "00:00–01:00 (+1 day)", "01:00–01:15 (+1 day)"]);
  for (const filter of [{ date: "2026-02-29" }, { date: "2026-04-31" }, { date: "2026-1-01" }, { date: [date] },
    { date, view: ["day"] }, { date, view: "shift" }, { date, view: "shift", startTime: "08:00", endTime: "08:00" },
    { date, view: "shift", startTime: "24:00", endTime: "09:00" }, { date, view: "shift", startTime: ["08:00"], endTime: "09:00" }]) {
    assert.throws(() => h.service.buildRange(filter), error => error.statusCode === 400);
  }
  assert.doesNotThrow(() => h.service.buildRange({ date: "2024-02-29" }));
});

test("hourly events, actual waiting backlog, real statuses, carry-ins, and future intervals use distinct semantics", async () => {
  const h = harness([
    patient(1, { created_at: at("23:50", "2026-10-14") }),
    patient(2, { status: "completed", created_at: at("08:10"), called_at: at("09:05"), consultation_started_at: at("09:10"), completed_at: at("10:00"), counter_id: "Doctor 1" }),
    patient(3, { status: "cancelled", created_at: at("09:20"), completed_at: at("09:40") }),
    patient(4, { status: "no-show", created_at: at("08:20"), called_at: at("08:25"), completed_at: at("09:00") }),
    patient(5, { created_at: at("10:40") }),
    patient(6, { status: "completed", created_at: at("18:00", "2026-10-14"), called_at: at("18:05", "2026-10-14"),
      consultation_started_at: at("18:10", "2026-10-14"), completed_at: at("18:20", "2026-10-14") })
  ]);
  const result = clone(await h.service.getDailyTrends({ date }));
  assert.equal(result.record_count, 4);
  assert.equal(result.has_activity, true);
  assert.equal(hour(result, "07:00–08:00").waiting, 1, "Carry-in backlog is waiting even without new arrivals");
  assert.equal(hour(result, "08:00–09:00").arrivals, 2);
  assert.equal(hour(result, "08:00–09:00").waiting, 2);
  assert.equal(hour(result, "09:00–10:00").arrivals, 1);
  assert.equal(hour(result, "09:00–10:00").cancelled_no_show, 2);
  assert.equal(hour(result, "09:00–10:00").waiting, 1);
  assert.equal(hour(result, "09:00–10:00").avg_wait_minutes, 55);
  assert.equal(hour(result, "10:00–11:00").served, 1);
  assert.equal(hour(result, "10:00–11:00").avg_service_minutes, 50);
  assert.equal(hour(result, "10:00–11:00").waiting, 1);
  for (const field of ["arrivals", "served", "waiting", "cancelled_no_show", "wait_samples", "service_samples", "avg_wait_minutes", "avg_service_minutes"]) {
    assert.equal(hour(result, "11:00–12:00")[field], null, `${field} must not invent future values`);
  }
  assert.deepEqual(result.statuses.map(({ status, count, percentage }) => ({ status, count, percentage })), [
    { status: "waiting", count: 1, percentage: 25 }, { status: "completed", count: 1, percentage: 25 },
    { status: "cancelled", count: 1, percentage: 25 }, { status: "no-show", count: 1, percentage: 25 }
  ]);
  assert.equal(result.counters[0].active_service_minutes, 50);
  assert.equal(result.counters[0].utilization_percent, null);
  assert.equal(result.counters[0].available_minutes, null);
  assert.deepEqual(result.peak_hours.map(item => [item.label, item.arrivals]), [["08:00–09:00", 2], ["09:00–10:00", 1]]);
});

test("half-open event buckets and left-limit snapshots handle exact hour, observation and midnight boundaries", () => {
  const h = harness([
    patient(1, { created_at: at("08:00"), called_at: at("09:00"), status: "serving" }),
    patient(2, { created_at: at("09:00") }),
    patient(3, { created_at: at("00:00", "2026-10-16") }),
    patient(4, { created_at: at("00:00"), called_at: at("00:00"), status: "completed", completed_at: at("00:00") })
  ], { now: at("09:00") });
  const result = h.aggregate();
  assert.equal(hour(result, "08:00–09:00").arrivals, 1);
  assert.equal(hour(result, "08:00–09:00").waiting, 1, "Call exactly at 09:00 occurs after the 08:00 interval snapshot");
  assert.equal(hour(result, "09:00–10:00").arrivals, 1);
  assert.equal(hour(result, "09:00–10:00").waiting, 1, "Current status includes arrivals exactly at observation time");
  assert.equal(hour(result, "09:00–10:00").avg_wait_minutes, 60);
  assert.equal(hour(result, "00:00–01:00").served, 1);
  assert.equal(result.record_count, 3);
});

test("a carry-in serving visit remains in the range cohort before consultation starts without inventing service minutes", () => {
  const h = harness([patient(1, { status: "serving", created_at: at("22:00", "2026-10-14"),
    called_at: at("23:00", "2026-10-14"), counter_id: "Doctor 1" })]);
  const result = h.aggregate();
  assert.equal(result.record_count, 1);
  assert.deepEqual(result.statuses, [{ status: "serving", label: "Serving", count: 1, percentage: 100 }]);
  assert.equal(hour(result, "08:00–09:00").waiting, 0);
  assert.equal(hour(result, "08:00–09:00").arrivals, 0);
  assert.equal(result.counters[0].active_service_minutes, null);
  assert.ok(result.hourly.every(bucket => bucket.avg_service_minutes == null));
});

test("missing calls, terminal times, and undone visits produce unknown historical waiting but correct present status", () => {
  const h = harness([
    patient(1, { status: "completed", called_at: null, consultation_started_at: at("09:10"), completed_at: at("10:00") }),
    patient(2, { status: "cancelled", completed_at: null }),
    patient(3, { status: "waiting", called_at: at("08:05") }),
    patient(4, { status: "serving", called_at: null })
  ]);
  const result = h.aggregate();
  assert.equal(hour(result, "08:00–09:00").waiting, null);
  assert.equal(hour(result, "09:00–10:00").waiting, null);
  assert.equal(hour(result, "10:00–11:00").waiting, 1);
  assert.equal(hour(result, "10:00–11:00").served, 1);
  assert.equal(hour(result, "10:00–11:00").avg_service_minutes, 50, "Actual start/end remain sufficient for a completed service sample");
  assert.equal(result.hourly.reduce((total, bucket) => total + (bucket.wait_samples || 0), 0), 0);
  assert.ok(result.notes.some(note => note.includes("historical waiting snapshots are unavailable")));
  assert.ok(result.notes.some(note => note.includes("Recall") && note.includes("Requeue") && note.includes("Undo")));
});

test("invalid and legacy service timestamps never become fake durations or substitute call/completion waiting", () => {
  const h = harness([
    patient(1, { status: "completed", called_at: at("08:10"), completed_at: at("09:00") }),
    patient(2, { status: "completed", called_at: at("07:59"), consultation_started_at: at("08:10"), completed_at: at("08:09") }),
    patient(3, { status: "completed", called_at: at("08:10"), consultation_started_at: at("09:00"), completed_at: at("09:00") }),
    patient(4, { status: "cancelled", called_at: at("08:10"), consultation_started_at: at("08:15"), completed_at: at("09:00"), counter_id: "Doctor 1" }),
    patient(5, { status: "completed", called_at: "invalid", consultation_started_at: "invalid", completed_at: at("09:00") })
  ]);
  const result = h.aggregate();
  assert.ok(result.hourly.every(bucket => bucket.avg_service_minutes == null));
  assert.equal(hour(result, "08:00–09:00").avg_wait_minutes, 10, "Cancelled visits and invalid order do not enter serving/completed wait averages");
  assert.equal(hour(result, "08:00–09:00").wait_samples, 2);
  assert.equal(result.counters[0].active_service_minutes, 45, "A consultation interrupted by cancellation has recorded active service time");
});

test("duration calculations retain PostgreSQL microseconds and equivalent timestamp offsets", () => {
  const h = harness([patient(1, { status: "completed", created_at: "2026-10-15T08:00:00.000001+08:00",
    called_at: "2026-10-15T00:00:00.000061Z", consultation_started_at: "2026-10-15T00:00:00.000101Z",
    completed_at: "2026-10-15T08:00:00.000901+08:00" })]);
  const result = h.aggregate(), bucket = hour(result, "08:00–09:00");
  assert.equal(bucket.avg_wait_minutes, 0.000001);
  assert.equal(bucket.avg_service_minutes, 0.0008 / 60);
});

test("counter recorded service clips to shift, merges overlapping intervals and includes an actual running consultation", () => {
  const h = harness([
    patient(1, { status: "completed", created_at: at("07:00"), called_at: at("08:00"), consultation_started_at: at("08:10"), completed_at: at("09:10"), counter_id: "Doctor 1" }),
    patient(2, { status: "completed", created_at: at("07:00"), called_at: at("08:20"), consultation_started_at: at("08:30"), completed_at: at("09:00"), counter_id: 1 }),
    patient(3, { status: "serving", called_at: at("09:50"), consultation_started_at: at("10:00"), counter_id: "Doctor 1" })
  ]);
  const full = h.aggregate(), shift = h.aggregate(undefined, { date, view: "shift", startTime: "08:30", endTime: "09:00" });
  assert.equal(full.counters[0].active_service_minutes, 90);
  assert.equal(shift.counters[0].active_service_minutes, 30);
  assert.equal(full.counters[1].active_service_minutes, null);
  assert.ok(full.counters.every(item => item.utilization_percent === null && item.available_minutes === null));
  assert.ok(full.notes.some(note => note.includes("Login sessions are not operating-time records")));
});

test("overnight custom shifts clip partial hours and group next-day arrivals and completions separately", () => {
  const h = harness([
    patient(1, { created_at: at("22:29") }),
    patient(2, { created_at: at("22:30"), called_at: at("23:59"), consultation_started_at: at("00:00", "2026-10-16"),
      completed_at: at("00:30", "2026-10-16"), status: "completed" }),
    patient(3, { created_at: at("00:05", "2026-10-16") }),
    patient(4, { created_at: at("01:15", "2026-10-16") })
  ], { now: at("02:00", "2026-10-16") });
  const result = h.aggregate(undefined, { date, view: "shift", startTime: "22:30", endTime: "01:15" });
  assert.equal(result.record_count, 3);
  assert.equal(hour(result, "22:30–23:00").arrivals, 1);
  assert.equal(hour(result, "22:30–23:00").waiting, 2);
  assert.equal(hour(result, "00:00–01:00 (+1 day)").arrivals, 1);
  assert.equal(hour(result, "00:00–01:00 (+1 day)").served, 1);
  assert.equal(hour(result, "00:00–01:00 (+1 day)").avg_service_minutes, 30);
  assert.equal(hour(result, "01:00–01:15 (+1 day)").arrivals, 0);
});

test("unique queue-record identifiers prevent duplicates while separate visits by one patient remain distinct", () => {
  const rows = [patient(1), patient("1"), patient(2), { status: "waiting", created_at: at("08:00") }];
  const h = harness(rows), before = clone(rows), result = h.aggregate();
  assert.equal(result.record_count, 2);
  assert.equal(hour(result, "08:00–09:00").arrivals, 2);
  assert.equal(hour(result, "08:00–09:00").waiting, 2);
  assert.ok(result.notes.some(note => note.includes("without a unique queue-record identifier")));
  assert.deepEqual(rows, before, "Analytics must not mutate any queue record");
});

test("valid empty periods have real zero counts, unavailable durations, no ranked fake hours and no utilization", async () => {
  const h = harness([], { now: at("12:00", "2026-10-16") });
  const result = clone(await h.service.getDailyTrends({ date }));
  assert.equal(result.record_count, 0);
  assert.equal(result.has_activity, false);
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.peak_hours, []);
  assert.ok(result.hourly.every(bucket => bucket.arrivals === 0 && bucket.waiting === 0 && bucket.served === 0 && bucket.cancelled_no_show === 0));
  assert.ok(result.hourly.every(bucket => bucket.avg_wait_minutes === null && bucket.avg_service_minutes === null));
  assert.ok(result.counters.every(item => item.utilization_percent === null && item.active_service_minutes === null));
  const future = clone(await h.service.getDailyTrends({ date: "2026-10-17" }));
  assert.ok(future.hourly.every(bucket => bucket.arrivals === null && bucket.waiting === null));
});

test("database reads paginate beyond row caps for patients and every existing counter, preserving carry-in backlog", async () => {
  const h = harness(Array.from({ length: 1201 }, (_, index) => patient(index + 1, { created_at: at("23:00", "2026-10-14") })),
    { counters: Array.from({ length: 1001 }, (_, index) => counter(index + 1)) });
  h.database.patients.push(patient(1202, { status: "completed", created_at: at("01:00", "2026-10-14"), called_at: at("01:01", "2026-10-14"), completed_at: at("01:02", "2026-10-14") }));
  const result = clone(await h.service.getDailyTrends({ date }));
  assert.equal(result.record_count, 1201);
  assert.equal(result.counters.length, 1001);
  assert.equal(hour(result, "08:00–09:00").arrivals, 0);
  assert.equal(hour(result, "08:00–09:00").waiting, 1201);
  assert.deepEqual(h.calls.filter(call => call.table === "patients").map(call => call.start), [0, 500, 1000]);
  assert.deepEqual(h.calls.filter(call => call.table === "counters").map(call => call.start), [0, 500, 1000]);
  assert.ok(h.calls.filter(call => call.table === "patients").every(call => call.overlap.includes("status.in.(waiting,serving)")));
});

test("fresh reads reflect queue registration, call, start, completion and cancellation updates without writes", async () => {
  const h = harness([patient(1)]);
  assert.equal(hour(await h.service.getDailyTrends({ date }), "10:00–11:00").waiting, 1);
  Object.assign(h.database.patients[0], { status: "serving", called_at: at("10:10"), counter_id: "Doctor 1" });
  assert.equal(hour(await h.service.getDailyTrends({ date }), "10:00–11:00").waiting, 0);
  h.database.patients[0].consultation_started_at = at("10:15");
  assert.equal((await h.service.getDailyTrends({ date })).counters[0].active_service_minutes, 15);
  Object.assign(h.database.patients[0], { status: "completed", completed_at: at("10:25") });
  h.database.patients.push(patient(2, { status: "cancelled", created_at: at("10:05"), completed_at: at("10:20") }));
  const result = await h.service.getDailyTrends({ date });
  assert.equal(hour(result, "10:00–11:00").served, 1);
  assert.equal(hour(result, "10:00–11:00").cancelled_no_show, 1);
  assert.equal(hour(result, "10:00–11:00").avg_service_minutes, 10);
});

test("database query/transport outages and missing configuration fail closed without fabricated empty statistics", async () => {
  for (const failure of ["query", "transport"]) {
    const h = harness([patient(1)]);
    h.setFailure(failure);
    await assert.rejects(h.service.getDailyTrends({ date }), error => error.statusCode === 503);
    h.setFailure(null);
    assert.equal((await h.service.getDailyTrends({ date })).record_count, 1);
  }
  const unconfigured = harness([], { unconfigured: true });
  await assert.rejects(unconfigured.service.getDailyTrends({ date }), error => error.statusCode === 503);
  assert.equal(unconfigured.calls.length, 0);
});

test("Daily Trends route retains Superadmin authentication, functional query filters, no-store and validation/outage errors", async () => {
  const h = harness([patient(1)]), routes = new Map(), secret = "isolated-daily-trends-secret";
  const presence = { validateAuthSession: async () => ({ session_id: "isolated" }) };
  const auth = load("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": { jwtSecret: secret }, "../services/presenceService": presence }, h.clock);
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) router[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers);
  load("routes/index.js", { express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto,
    "../lib/businessDay": require("../src/lib/businessDay"),
    "../config/env": { jwtSecret: secret }, "../middleware/auth": auth, "../services/presenceService": presence,
    "../services/queueService": {}, "../services/settingsService": {}, "../services/dailyTrendsService": h.service }, h.clock);
  async function request(role, query = { date }) {
    const token = role && jwt.sign({ role, jti: crypto.randomUUID() }, secret);
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, query };
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name] = value; }, json(body) { this.body = clone(body); return this; } };
    const handlers = routes.get("get /analytics/daily-trends");
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
  const success = await request("superadmin", { date, view: "shift", startTime: "08:15", endTime: "09:30" });
  assert.equal(success.statusCode, 200);
  assert.equal(success.headers["Cache-Control"], "no-store");
  assert.equal(success.body.data.range.view, "shift");
  assert.equal(success.body.data.hourly.length, 2);
  assert.equal(success.body.data.hourly[0].label, "08:15–09:00");
  assert.equal((await request("superadmin", { date: [date] })).statusCode, 400);
  h.setFailure();
  assert.equal((await request("superadmin")).statusCode, 503);
});
