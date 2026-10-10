const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const backendDir = path.resolve(__dirname, "../..");
const clone = (value) => JSON.parse(JSON.stringify(value));

function createDatabase() {
  return {
    patients: [],
    counters: [
      { id: 1, id_num: "Doctor 1", service_types: ["consultation", "checkup"], is_online: true, current_patient_id: null },
      { id: 2, id_num: "Doctor 2", service_types: ["prenatal", "maternity"], is_online: true, current_patient_id: null },
      { id: 3, id_num: "Doctor 3", service_types: ["family_planning"], is_online: true, current_patient_id: null }
    ],
    display_settings: [{ id: 1, company_name: "Test Health Office", refresh_interval: 5 }],
    calls: [],
    beforeQuery: null
  };
}

// Executes filters at write time to model PostgREST conditional updates. This is
// intentionally an isolated fake, not a PostgreSQL integration test.
function fakeSupabase(database, now, localFallback) {
  class Query {
    constructor(table) {
      this.table = table;
      this.action = "select";
      this.filters = [];
      this.orders = [];
      this.maximum = Infinity;
      this.columns = "*";
    }
    select(columns = "*") { this.columns = columns; return this; }
    update(payload) { this.action = "update"; this.payload = clone(payload); return this; }
    insert(payload) { this.action = "insert"; this.payload = clone(payload); return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    neq(key, value) { this.filters.push((row) => row[key] !== value); return this; }
    is(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    gte(key, value) { this.filters.push((row) => row[key] >= value); return this; }
    lte(key, value) { this.filters.push((row) => row[key] <= value); return this; }
    like(key, value) { this.filters.push((row) => String(row[key]).startsWith(value.replace(/%$/, ""))); return this; }
    order(key, options = {}) { this.orders.push({ key, ascending: options.ascending !== false }); return this; }
    limit(value) { this.maximum = value; return this; }
    single() { this.singular = true; return this.execute(); }
    maybeSingle() { this.singular = true; return this.execute(); }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      database.calls.push({ table: this.table, action: this.action, payload: this.payload });
      if (localFallback) return { data: null, error: { message: "Supabase unreachable (isolated test)" } };
      if (database.beforeQuery) {
        const result = await database.beforeQuery(this);
        if (result) return result;
      }
      const table = database[this.table];
      if (!Array.isArray(table)) throw new Error(`Unexpected table: ${this.table}`);
      let rows;
      if (this.action === "insert") {
        const payloads = Array.isArray(this.payload) ? this.payload : [this.payload];
        rows = payloads.map((payload) => ({
          id: Math.max(0, ...table.map((row) => row.id)) + 1,
          created_at: new Date(now()).toISOString(),
          called_at: null,
          completed_at: null,
          counter_id: null,
          reason: null,
          ...payload
        }));
        table.push(...rows);
      } else {
        rows = table.filter((row) => this.filters.every((filter) => filter(row)));
        if (this.action === "update") rows.forEach((row) => Object.assign(row, this.payload));
      }
      for (let i = this.orders.length - 1; i >= 0; i -= 1) {
        const { key, ascending } = this.orders[i];
        rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (ascending ? 1 : -1));
      }
      rows = rows.slice(0, this.maximum).map((row) => {
        if (this.columns === "*") return clone(row);
        return Object.fromEntries(this.columns.split(",").map((key) => [key.trim(), clone(row[key.trim()] ?? null)]));
      });
      return { data: this.singular ? rows[0] || null : rows, error: null };
    }
  }
  return { from: (table) => new Query(table) };
}

function createVirtualFs(files = new Map()) {
  return {
    files,
    existsSync: (file) => files.has(file),
    mkdirSync: (file) => files.set(file, ""),
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error(`Missing virtual file ${file}`);
      return files.get(file);
    },
    writeFileSync: (file, contents) => files.set(file, contents)
  };
}

function loadModule(relativePath, imports, clock) {
  const filename = path.join(backendDir, relativePath);
  const module = { exports: {} };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Date: TestDate,
    console: { warn() {}, error() {}, log() {}, info() {} },
    setTimeout,
    clearTimeout
  });
  const wrapper = new vm.Script(`(function(require, module, exports, __dirname, __filename) {\n${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  wrapper.runInContext(context)((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name} in ${filename}`);
    return imports[name];
  }, module, module.exports, path.dirname(filename), filename);
  return module.exports;
}

function createHarness(options = {}) {
  const database = options.database || createDatabase();
  const clock = options.clock || { now: Date.now() };
  const virtualFs = createVirtualFs(options.files);
  const loadSettings = () => loadModule("src/services/settingsService.js", { fs: virtualFs, path, crypto }, clock);
  const settings = loadSettings();
  const notifications = [];
  const service = loadModule("src/services/queueService.js", {
    "../lib/supabase": fakeSupabase(database, () => clock.now, options.localFallback),
    bcryptjs: {},
    "./notificationService": {
      sendQueueCreatedNotification: (...args) => notifications.push({ type: "created", args }),
      sendQueueCalledNotification: async (...args) => notifications.push({ type: "called", args })
    },
    "./settingsService": settings
  }, clock);
  const handlers = new Map();
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (route, ...middleware) => handlers.set(`${method.toUpperCase()} ${route}`, middleware.at(-1));
  }
  loadModule("src/routes/index.js", {
    express: { Router: () => router },
    jsonwebtoken: {},
    "../config/env": {},
    "../middleware/auth": { authenticateToken() {}, authorizeRole: () => () => {} },
    "../services/queueService": service,
    "../services/settingsService": settings
  }, clock);

  return {
    service, settings, database, clock, virtualFs, loadSettings, notifications,
    async initialize() {
      if (options.localFallback) await service.getDisplaySettings();
    },
    async request(method, route, body = {}, user = { id_num: "frontdesk", role: "admin", doctor_name: null }) {
      const handler = handlers.get(`${method.toUpperCase()} ${route}`);
      if (!handler) throw new Error(`Missing route ${method} ${route}`);
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = clone(data); return this; } };
      await handler({ body, user, query: {}, params: {} }, response);
      return { status: response.statusCode, body: response.body };
    },
    advance(milliseconds = 1000) { clock.now += milliseconds; }
  };
}

module.exports = { createHarness, createDatabase, clone };
