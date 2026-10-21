const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const clone = (value) => JSON.parse(JSON.stringify(value));
function load(relative, imports, clock) {
  const filename = path.resolve(__dirname, "../src", relative);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, {
    console: { warn() {}, info() {}, log() {} }, Date: FixedDate
  });
  wrapper((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

function harness(patients = [], now = "2026-10-15T03:00:00.000Z") {
  const clock = { now: Date.parse(now) }, calls = [];
  let unavailable = false;
  const supabase = { from(table) {
    assert.equal(table, "patients");
    const query = { filters: [], select() { return this; },
      gte(column, value) { this.column = column; this.filters.push(row => Date.parse(row[column]) >= Date.parse(value)); return this; },
      lte(column, value) { this.filters.push(row => Date.parse(row[column]) <= Date.parse(value)); return this; },
      order(column, options) { assert.equal(column, "id"); assert.equal(options.ascending, true); return this; },
      async range(start, end) {
        calls.push({ column: this.column, start, end });
        if (unavailable) return { data: null, error: { message: "Database read failed" } };
        return { data: clone(patients.filter(row => this.filters.every(filter => filter(row)))
          .sort((a, b) => a.id - b.id).slice(start, Math.min(end + 1, start + 1000))), error: null };
      }
    };
    return query;
  } };
  const service = load("services/queueService.js", {
    "../lib/supabase": supabase,
    "../config/env": { supabaseUrl: "https://isolated.test", supabaseServiceRoleKey: "isolated-test-key" },
    "node:crypto": crypto, bcryptjs: {}, "./notificationService": {}, "./settingsService": {}
  }, clock);
  return { service, patients, calls, clock, setUnavailable() { unavailable = true; } };
}

function patient(id, overrides = {}) {
  return { id, source: "admin", status: "waiting", created_at: "2026-10-15T00:00:00Z", called_at: null, completed_at: null, ...overrides };
}

test("dashboard uses Manila registration, completed and call dates with workflow-specific statuses", async () => {
  const h = harness([
    patient(1, { created_at: "2026-10-14T16:00:00Z" }),
    patient(2, { created_at: "2026-10-14T15:59:00Z", called_at: "2026-10-14T16:01:00Z", completed_at: "2026-10-15T01:00:00Z", status: "completed", source: "website" }),
    patient(3, { created_at: "2026-10-14T14:00:00Z", called_at: "2026-10-14T14:03:30Z", completed_at: "2026-10-14T14:06:00Z", status: "completed" }),
    patient(4, { called_at: "2026-10-15T00:01:30Z", status: "serving" }),
    patient(5, { created_at: "2026-10-15T01:00:00Z", called_at: "2026-10-15T01:02:00Z", completed_at: "2026-10-15T01:03:00Z", status: "cancelled" }),
    patient(6, { created_at: "2026-10-15T01:00:00Z", completed_at: "2026-10-15T01:04:00Z", status: "no-show" }),
    patient(7, { created_at: "2026-10-15T02:00:00Z", called_at: "2026-10-15T01:59:00Z", status: "serving", source: null }),
    patient(8, { created_at: "2026-10-15T04:00:00Z" })
  ]);
  const stats = clone(await h.service.getDashboardStats());
  assert.equal(stats.time_zone, "Asia/Manila");
  assert.equal(stats.today_date, "2026-10-15");
  assert.equal(stats.yesterday_date, "2026-10-14");
  assert.equal(stats.observed_at, "2026-10-15T03:00:00.000Z");
  assert.deepEqual(stats.today, { total_tokens: 5, served_tokens: 1, average_wait_minutes: 1.75, wait_samples: 2, walk_ins: 4 });
  assert.deepEqual(stats.yesterday, { total_tokens: 2, served_tokens: 1, average_wait_minutes: 3.5, wait_samples: 1, walk_ins: 1 });
});

test("midnight boundaries include carryover calls and completions without counting old registrations", async () => {
  const h = harness([
    patient(1, { created_at: "2026-10-14T16:00:00Z" }),
    patient(2, { created_at: "2026-10-13T16:00:00Z" }),
    patient(3, { created_at: "2026-10-13T15:59:59.999Z" }),
    patient(4, { created_at: "2026-10-12T16:00:00Z", called_at: "2026-10-14T16:00:00Z", completed_at: "2026-10-14T16:00:00Z", status: "completed" }),
    patient(5, { created_at: "2026-10-14T16:00:00.001Z" })
  ], "2026-10-14T16:00:00Z");
  const stats = await h.service.getDashboardStats();
  assert.equal(stats.today.total_tokens, 1);
  assert.equal(stats.yesterday.total_tokens, 1);
  assert.equal(stats.today.served_tokens, 1);
  assert.equal(stats.today.wait_samples, 1);
  assert.equal(stats.today.average_wait_minutes, 2880);
});

test("empty or invalid waiting samples stay empty; completion timestamp never substitutes for call", async () => {
  const h = harness([
    patient(1, { completed_at: "2026-10-15T01:00:00Z", status: "completed", source: "website" }),
    patient(2, { created_at: "invalid", called_at: "2026-10-15T01:00:00Z", status: "serving", source: null }),
    patient(3, { called_at: "invalid", status: "serving", source: "unknown" })
  ]);
  const stats = await h.service.getDashboardStats();
  assert.equal(stats.today.served_tokens, 1);
  assert.equal(stats.today.average_wait_minutes, null);
  assert.equal(stats.today.wait_samples, 0);
  assert.equal(stats.today.walk_ins, 0);
  assert.equal(stats.yesterday.average_wait_minutes, null);
});

test("waiting averages preserve sub-millisecond precision", async () => {
  const h = harness([patient(1, { created_at: "2026-10-15T02:00:00.000001Z", called_at: "2026-10-15T02:00:00.000061Z", status: "serving" })]);
  assert.equal((await h.service.getDashboardStats()).today.average_wait_minutes, 0.000001);
});

test("all date streams paginate beyond the database row cap and deduplicate shared records", async () => {
  const h = harness(Array.from({ length: 1201 }, (_, index) => patient(index + 1, {
    called_at: "2026-10-15T00:01:00Z", completed_at: "2026-10-15T00:03:00Z", status: "completed"
  })));
  const stats = await h.service.getDashboardStats();
  assert.equal(stats.today.total_tokens, 1201);
  assert.equal(stats.today.served_tokens, 1201);
  assert.equal(stats.today.wait_samples, 1201);
  assert.equal(stats.today.average_wait_minutes, 1);
  for (const column of ["created_at", "called_at", "completed_at"]) {
    assert.deepEqual(h.calls.filter(call => call.column === column).map(call => call.start), [0, 500, 1000]);
  }
});

test("fresh statistics follow registration, call and completion changes without writes", async () => {
  const h = harness([patient(1)]);
  assert.equal((await h.service.getDashboardStats()).today.wait_samples, 0);
  Object.assign(h.patients[0], { called_at: "2026-10-15T00:02:00Z", status: "serving" });
  assert.equal((await h.service.getDashboardStats()).today.average_wait_minutes, 2);
  Object.assign(h.patients[0], { completed_at: "2026-10-15T00:04:00Z", status: "completed" });
  h.patients.push(patient(2, { source: "website" }));
  const stats = await h.service.getDashboardStats();
  assert.equal(stats.today.served_tokens, 1);
  assert.equal(stats.today.total_tokens, 2);
  assert.equal(stats.today.walk_ins, 1);
});

test("configured database outages fail closed without fabricated empty statistics", async () => {
  const h = harness([patient(1)]);
  h.setUnavailable();
  await assert.rejects(h.service.getDashboardStats(), error => error.statusCode === 503);
  await assert.rejects(h.service.getDashboardStats(), error => error.statusCode === 503);
});

test("dashboard endpoint requires authenticated Superadmin, disables cache and preserves legacy stats", async () => {
  const h = harness([patient(1)]), handlers = new Map();
  const secret = "isolated-dashboard-stats-secret";
  const presence = { validateAuthSession: async claims => {
    if (!claims.jti) throw Object.assign(new Error("Session required"), { statusCode: 401 });
    return { session_id: claims.jti };
  } };
  const auth = load("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": { jwtSecret: secret }, "../services/presenceService": presence }, h.clock);
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) router[method] = (route, ...chain) => handlers.set(`${method.toUpperCase()} ${route}`, chain);
  load("routes/index.js", {
    express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto,
    "../config/env": { jwtSecret: secret }, "../middleware/auth": auth,
    "../services/presenceService": presence, "../services/queueService": { ...h.service, getQueueStats: async () => ({ waiting: 7 }) },
    "../services/settingsService": {}
  }, h.clock);
  async function request(route, role) {
    const token = role && jwt.sign({ role, jti: crypto.randomUUID() }, secret);
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = clone(body); return this; }, setHeader(name, value) { this.headers[name] = value; } };
    const chain = handlers.get(`GET ${route}`);
    async function run(index) {
      if (!chain[index]) return;
      let next;
      await chain[index](req, res, () => { next = run(index + 1); return next; });
      if (next) await next;
    }
    await run(0);
    return res;
  }
  assert.equal((await request("/stats/dashboard")).statusCode, 401);
  assert.equal((await request("/stats/dashboard", "admin")).statusCode, 403);
  assert.equal(h.calls.length, 0);
  const allowed = await request("/stats/dashboard", "superadmin");
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["Cache-Control"], "no-store");
  assert.equal(allowed.body.data.today.total_tokens, 1);
  assert.deepEqual((await request("/stats")).body, { success: true, data: { waiting: 7 } });
  h.setUnavailable();
  assert.equal((await request("/stats/dashboard", "superadmin")).statusCode, 503);
});
