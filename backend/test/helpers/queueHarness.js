const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const backendDir = path.resolve(__dirname, "../..");
const clone = (value) => JSON.parse(JSON.stringify(value));

// PostgreSQL equality includes microseconds, which JavaScript Date discards.
function timestampMicroseconds(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] || "";
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}

function createDatabase() {
  return {
    patients: [],
    counters: [
      { id: 1, id_num: "Doctor 1", service_types: ["consultation", "checkup"], is_online: true, current_patient_id: null },
      { id: 2, id_num: "Doctor 2", service_types: ["prenatal", "maternity"], is_online: true, current_patient_id: null },
      { id: 3, id_num: "Doctor 3", service_types: ["family_planning"], is_online: true, current_patient_id: null }
    ],
    display_settings: [{ id: 1, company_name: "Test Health Office", refresh_interval: 5 }],
    users: [
      { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" },
      { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" },
      { id_num: "admin3", role: "admin", doctor_name: "Doctor 3" },
      { id_num: "frontdesk", role: "admin", doctor_name: null },
      { id_num: "superadmin", role: "superadmin", doctor_name: null }
    ],
    calls: [],
    beforeQuery: null,
    beforeRpc: null,
    beforeRpcCommit: null
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
      this.offset = 0;
      this.rangeEnd = Infinity;
      this.columns = "*";
    }
    select(columns = "*") { this.columns = columns; return this; }
    update(payload) { this.action = "update"; this.payload = clone(payload); return this; }
    insert(payload) { this.action = "insert"; this.payload = clone(payload); return this; }
    upsert(payload, options = {}) { this.action = "upsert"; this.payload = clone(payload); this.upsertOptions = options; return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    neq(key, value) { this.filters.push((row) => row[key] !== value); return this; }
    is(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    compare(key, value, accepts) {
      this.filters.push((row) => {
        const actual = timestampMicroseconds(row[key]);
        const expected = timestampMicroseconds(value);
        return accepts(actual != null && expected != null ? actual : row[key], actual != null && expected != null ? expected : value);
      });
      return this;
    }
    gte(key, value) { return this.compare(key, value, (actual, expected) => actual >= expected); }
    lte(key, value) { return this.compare(key, value, (actual, expected) => actual <= expected); }
    lt(key, value) { return this.compare(key, value, (actual, expected) => actual < expected); }
    like(key, value) { this.filters.push((row) => String(row[key]).startsWith(value.replace(/%$/, ""))); return this; }
    order(key, options = {}) { this.orders.push({ key, ascending: options.ascending !== false }); return this; }
    limit(value) { this.maximum = value; return this; }
    range(from, to) { this.offset = from; this.rangeEnd = to; return this; }
    single() { this.singular = true; this.required = true; return this.execute(); }
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
      if (this.action === "insert" || this.action === "upsert") {
        const payloads = Array.isArray(this.payload) ? this.payload : [this.payload];
        let nextId = Math.max(0, ...table.map((row) => Number(row.id) || 0)) + 1;
        rows = [];
        for (const payload of payloads) {
          const conflictKeys = (this.upsertOptions?.onConflict || "id").split(",").map((key) => key.trim());
          const existing = this.action === "upsert" && table.find((row) => conflictKeys.every((key) => row[key] === payload[key]));
          if (existing) {
            if (!this.upsertOptions.ignoreDuplicates) {
              Object.assign(existing, payload);
              if (this.table === "patients") existing.visit_state_revision = crypto.randomUUID();
              rows.push(existing);
            }
            continue;
          }
          const defaults = this.table === "counters"
            ? { service_types: [], is_online: true, current_patient_id: null }
            : { called_at: null, completed_at: null, consultation_started_at: null, counter_id: null, reason: null };
          if (this.table === "patients") defaults.visit_state_revision = crypto.randomUUID();
          const inserted = { id: nextId++, created_at: new Date(now()).toISOString(), ...defaults, ...payload };
          table.push(inserted);
          rows.push(inserted);
        }
      } else {
        rows = table.filter((row) => this.filters.every((filter) => filter(row)));
        if (this.action === "update") rows.forEach((row) => {
          Object.assign(row, this.payload);
          // Model the database trigger, including updates that restore every
          // status/timestamp field to its previous value within one millisecond.
          if (this.table === "patients") row.visit_state_revision = crypto.randomUUID();
        });
      }
      for (let i = this.orders.length - 1; i >= 0; i -= 1) {
        const { key, ascending } = this.orders[i];
        rows.sort((a, b) => {
          const first = timestampMicroseconds(a[key]);
          const second = timestampMicroseconds(b[key]);
          const left = first != null && second != null ? first : a[key];
          const right = first != null && second != null ? second : b[key];
          return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      rows = rows.slice(this.offset, Math.min(this.rangeEnd + 1, this.offset + this.maximum, this.offset + (database.maxRows || Infinity))).map((row) => {
        if (this.columns === "*") return clone(row);
        return Object.fromEntries(this.columns.split(",").map((key) => [key.trim(), clone(row[key.trim()] ?? null)]));
      });
      if (this.required && rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: this.singular ? rows[0] || null : rows, error: null };
    }
  }
  // Model the RPC boundary and all-or-nothing commit for service/route tests.
  // This does not execute the SQL migration or prove PostgreSQL locking behavior.
  async function rpc(name, args) {
    database.calls.push({ action: "rpc", function: name, args: clone(args) });
    if (localFallback) return { data: null, error: { message: "Supabase unreachable (isolated test)" } };
    if (database.beforeRpc) {
      const result = await database.beforeRpc(name, args);
      if (result) return result;
    }
    // The F5 Requeue entry point is a reviewed, uninstalled migration: absent unless a test opts in.
    if (name === "requeue_patient_visit" && !database.requeueRpcInstalled) {
      return { data: null, error: { code: "PGRST202", message: "Could not find the function public.requeue_patient_visit" } };
    }
    // The C1 atomic Call is a reviewed, uninstalled migration: absent unless a test opts in.
    if (name === "call_patient_visit" && !database.callRpcInstalled) {
      return { data: null, error: { code: "PGRST202", message: "Could not find the function public.call_patient_visit" } };
    }
    // The W1 atomic Cancel is also uninstalled, but without it a serving visit cannot be
    // cancelled at all (fail closed), so it is emulated unless a test sets
    // cancelRpcInstalled = false to model the current database. W1 tests cover both.
    if (name === "cancel_patient_visit" && database.cancelRpcInstalled === false) {
      return { data: null, error: { code: "PGRST202", message: "Could not find the function public.cancel_patient_visit" } };
    }
    if (name === "complete_patient_consultation" && !Object.hasOwn(args, "p_expected_started_at")) {
      return { data: null, error: { code: "PGRST202", message: "Required completion RPC argument p_expected_started_at is missing" } };
    }
    const previous = database.rpcQueue || Promise.resolve();
    let release;
    database.rpcQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const patients = clone(database.patients);
      const counters = clone(database.counters);
      const patient = patients.find((row) => row.id === args.p_patient_id);
      const counter = counters.find((row) => row.id_num === args.p_doctor_name);
      const user = database.users.find((row) => row.id_num === args.p_user_id_num);
      const timestamp = new Date(database.clock ? database.clock.now : now()).toISOString();
      if (["recover_patient_visit", "undo_patient_visit_waiting", "requeue_patient_visit"].includes(name)) {
        if (name === "undo_patient_visit_waiting" && args.p_action !== "undo") {
          return { data: null, error: { code: "22023", message: "This recovery entry point only permits Undo" } };
        }
        if (name === "requeue_patient_visit" && args.p_action !== "requeue") {
          return { data: null, error: { code: "22023", message: "This recovery entry point only permits Requeue" } };
        }
        if (name === "requeue_patient_visit" && !["cancelled", "no-show", "completed"].includes(args.p_expected_status)) {
          return { data: null, error: { code: "P0001", message: "Only cancelled or no-show visits can be re-queued" } };
        }
        if (!user || !["admin", "superadmin"].includes(user.role)) {
          return { data: null, error: { code: "42501", message: "An authenticated queue operator is required" } };
        }
        if (!patient) return { data: null, error: { code: "P0002", message: "Patient not found" } };
        if (!["requeue", "undo"].includes(args.p_action)) {
          return { data: null, error: { code: "P0001", message: "Unsupported patient recovery action" } };
        }
        const equalTimestamp = (actual, expected) => actual == null && expected == null
          || actual != null && expected != null && timestampMicroseconds(actual) !== null
            && timestampMicroseconds(actual) === timestampMicroseconds(expected);
        if (!args.p_expected_revision || patient.visit_state_revision !== args.p_expected_revision
          || patient.status !== args.p_expected_status
          || !equalTimestamp(patient.created_at, args.p_expected_created_at)
          || !equalTimestamp(patient.called_at, args.p_expected_called_at)
          || !equalTimestamp(patient.consultation_started_at, args.p_expected_started_at)
          || !equalTimestamp(patient.completed_at, args.p_expected_completed_at)
          || (patient.counter_id ?? null) !== args.p_expected_counter_id) {
          return { data: null, error: { code: "40001", message: "Patient visit state changed; refresh before recovery" } };
        }
        if (patient.status === "completed" && patient.consultation_started_at) {
          return { data: null, error: { code: "P0001", message: "Completed consultation history must be preserved. Register a new visit instead." } };
        }
        if (args.p_action === "undo" && !["completed", "cancelled", "no-show"].includes(patient.status)) {
          return { data: null, error: { code: "P0001", message: "Only completed, cancelled, or no-show patients can be undone" } };
        }
        patient.status = "waiting";
        patient.completed_at = null;
        patient.consultation_started_at = null;
        if (args.p_action === "requeue") {
          patient.created_at = timestamp;
          patient.called_at = null;
          patient.counter_id = null;
          patient.reason = args.p_reason ?? null;
          if (name === "requeue_patient_visit") {
            for (const row of counters) {
              if (row.current_patient_id === patient.id) row.current_patient_id = null;
            }
          }
        } else {
          patient.called_at = null;
          patient.counter_id = null;
          for (const row of counters) {
            if (row.current_patient_id === patient.id) row.current_patient_id = null;
          }
        }
        patient.visit_state_revision = crypto.randomUUID();
        if (database.beforeRpcCommit) await database.beforeRpcCommit({ name, args, patients, counters });
        database.patients.splice(0, database.patients.length, ...patients);
        database.counters.splice(0, database.counters.length, ...counters);
        return { data: database.rpcReturnsArray ? [clone(patient)] : clone(patient), error: null };
      }
      if (name === "cancel_patient_visit") {
        // Mirrors 20261025-w1-atomic-cancel.sql step by step, with all-or-nothing writes;
        // PostgreSQL locking itself is covered by w1-atomic-cancel-concurrency.test.js.
        const fail = (code, message) => ({ data: null, error: { code, message } });
        const blank = (value) => (value == null || value === "" ? null : value);
        const trimmed = (value) => String(value ?? "").trim();
        const resolve = (value) => {
          const raw = trimmed(value).toLowerCase();
          const number = raw.match(/^(?:doctor\s*)?(\d+)$/)?.[1];
          return raw ? [...counters].sort((a, b) => a.id - b.id).find((row) => trimmed(row.id_num).toLowerCase() === raw ||
            String(row.id) === raw || (number && String(row.id_num).toLowerCase() === `doctor ${Number(number)}`)) || null : null;
        };
        const doctorFor = (service) => ["consultation", "checkup"].includes(service) ? "Doctor 1"
          : ["prenatal", "maternity"].includes(service) ? "Doctor 2" : service === "family_planning" ? "Doctor 3" : "Doctor 1";
        if (!args.p_patient_id || !args.p_session_id || !trimmed(args.p_user_id_num) || !args.p_role ||
            !args.p_expected_revision || !args.p_expected_status) {
          return fail("22023", "A patient, authenticated session and visit snapshot are required");
        }
        const reason = trimmed(args.p_reason);
        if (!reason) return fail("22023", "Reason for cancel is required");
        if (reason.length > 1000) return fail("22023", "Reason for cancel is too long (maximum 1000 characters)");
        if (!user || !["admin", "superadmin"].includes(user.role) || user.role !== args.p_role ||
            blank(user.doctor_name) !== blank(args.p_doctor_name)) {
          return fail("28000", "Your account no longer matches your session. Sign in again.");
        }
        const session = database.sessions?.get(args.p_session_id);
        if ((database.revokedSessions || new Set()).has(args.p_session_id) || (database.sessions &&
            (!session || session.user_id_num !== args.p_user_id_num || session.role !== args.p_role ||
             session.doctor_name !== blank(args.p_doctor_name) || session.revoked_at || Date.parse(session.expires_at) <= Date.parse(timestamp)))) {
          return fail("28000", "Your authentication session expired or was revoked. Please sign in again.");
        }
        const assignment = trimmed(user.doctor_name).toLowerCase();
        const kind = user.role === "superadmin" ? "superadmin" : ["", "front desk", "frontdesk"].includes(assignment) ? "frontdesk" : "doctor";
        const actorCounter = kind === "doctor" ? resolve(user.doctor_name) : null;
        if (kind === "doctor" && !actorCounter) return fail("42501", "Your current account is not assigned to this doctor. Sign in again.");
        if (!patient) return fail("P0002", "Patient not found");
        const owner = trimmed(patient.counter_id) ? resolve(patient.counter_id)
          : patient.status !== "serving" ? resolve(doctorFor(patient.service_type)) : null;
        if (kind === "doctor" && (!owner || owner.id !== actorCounter.id)) return fail("42501", "You can only cancel patients assigned to your doctor.");
        const requested = trimmed(args.p_requested_counter) ? resolve(args.p_requested_counter) : null;
        if (trimmed(args.p_requested_counter)) {
          if (!requested) return fail("22023", "The requested doctor is not a valid counter");
          if (owner && requested.id !== owner.id) return fail("QM003", "The requested doctor does not match this patient's assigned doctor");
        }
        if (patient.visit_state_revision !== args.p_expected_revision || patient.status !== args.p_expected_status) {
          return fail("40001", "Patient visit changed; refresh before retrying cancellation");
        }
        if (patient.status === "completed") return fail("QM001", "A completed consultation cannot be cancelled");
        if (patient.status === "no-show") return fail("QM002", "This patient was marked no-show. Undo the no-show before cancelling.");
        if (patient.status !== "cancelled") {
          if (!["waiting", "serving"].includes(patient.status)) return fail("QM500", "Unsupported visit status");
          const stamp = !trimmed(patient.counter_id) && owner && requested?.id === owner.id ? owner.id_num : null;
          Object.assign(patient, { status: "cancelled", completed_at: timestamp, reason, visit_state_revision: crypto.randomUUID() });
          if (stamp) patient.counter_id = stamp;
        }
        for (const row of counters) if (row.current_patient_id === patient.id) row.current_patient_id = null;
        if (database.beforeRpcCommit) await database.beforeRpcCommit({ name, args, patients, counters });
        database.patients.splice(0, database.patients.length, ...patients);
        database.counters.splice(0, database.counters.length, ...counters);
        return { data: database.rpcReturnsArray ? [clone(patient)] : clone(patient), error: null };
      }
      if (name === "call_patient_visit") {
        // Mirrors 20261025-c1-atomic-call.sql's checks and all-or-nothing writes; PostgreSQL
        // locking itself is covered by c1-atomic-call-concurrency.test.js.
        const fail = (code, message) => ({ data: null, error: { code, message } });
        const doctorFor = (service) => ["consultation", "checkup"].includes(service) ? "Doctor 1"
          : ["prenatal", "maternity"].includes(service) ? "Doctor 2" : service === "family_planning" ? "Doctor 3" : "Doctor 1";
        if (!args.p_user_id_num || !args.p_expected_revision || !args.p_queue_start || !args.p_queue_end ||
            !["Doctor 1", "Doctor 2", "Doctor 3"].includes(args.p_doctor_name)) {
          return fail("22023", "A patient, doctor, staff identity, visit revision and queue window are required");
        }
        if (!user || !["admin", "superadmin"].includes(user.role)) return fail("42501", "An authenticated staff account is required to call patients");
        const assignment = String(user.doctor_name ?? "").trim();
        if (user.role === "admin" && !["", "front desk", "frontdesk"].includes(assignment.toLowerCase()) && assignment !== args.p_doctor_name) {
          return fail("42501", "You can only call patients assigned to your doctor.");
        }
        if (!counter) return fail("P0001", `${args.p_doctor_name} counter was not found`);
        if (!patient) return fail("P0002", "Patient not found");
        if (patient.visit_state_revision !== args.p_expected_revision) return fail("40001", "Patient visit changed; refresh the queue before calling");
        if (patient.status !== "waiting" || patient.completed_at != null) return fail("P0001", "Only a waiting patient without a completion timestamp can be called");
        if (doctorFor(patient.service_type) !== args.p_doctor_name) return fail("P0001", "This patient is assigned to another doctor");
        if (patient.counter_id != null && patient.counter_id !== args.p_doctor_name) return fail("P0001", "This waiting patient has a conflicting doctor assignment");
        if (counter.is_online !== true) return fail("P0001", `${args.p_doctor_name} is marked offline in System Settings. Enable availability before calling patients.`);
        const reserved = patient.counter_id === args.p_doctor_name && counter.current_patient_id === patient.id;
        if ((counter.current_patient_id != null && !reserved) || patients.some((row) => row.status === "serving" && row.id !== patient.id &&
            (row.counter_id === args.p_doctor_name || (row.counter_id == null && doctorFor(row.service_type) === args.p_doctor_name)))) {
          return fail("P0001", `${args.p_doctor_name} is already serving a patient`);
        }
        if (counters.some((row) => row.id !== counter.id && row.current_patient_id === patient.id)) return fail("P0001", "This patient is already assigned to another doctor");
        const start = timestampMicroseconds(args.p_queue_start);
        const end = timestampMicroseconds(args.p_queue_end);
        const next = patients.filter((row) => row.status === "waiting" && doctorFor(row.service_type) === args.p_doctor_name &&
            timestampMicroseconds(row.created_at) >= start && timestampMicroseconds(row.created_at) < end)
          .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)[0];
        if (next?.id !== patient.id) return fail("P0001", `Call the next eligible patient for ${args.p_doctor_name} according to queue priority`);
        Object.assign(patient, { status: "serving", counter_id: args.p_doctor_name, called_at: timestamp, visit_state_revision: crypto.randomUUID() });
        counter.current_patient_id = patient.id;
        if (database.beforeRpcCommit) await database.beforeRpcCommit({ name, args, patients, counters });
        database.patients.splice(0, database.patients.length, ...patients);
        database.counters.splice(0, database.counters.length, ...counters);
        return { data: database.rpcReturnsArray ? [clone(patient)] : clone(patient), error: null };
      }
      if (!user || user.role !== "admin" || user.doctor_name !== args.p_doctor_name) {
        return { data: null, error: { code: "42501", message: "Authenticated doctor identity no longer matches" } };
      }
      if (!patient) return { data: null, error: { code: "P0001", message: "Patient not found" } };
      if (patient.counter_id !== args.p_doctor_name || !counter || counter.current_patient_id !== patient.id) {
        return { data: null, error: { code: "P0001", message: "Patient is not assigned to this doctor's active counter" } };
      }
      if (counters.some((row) => row.id_num !== args.p_doctor_name && row.current_patient_id === patient.id)) {
        return { data: null, error: { code: "P0001", message: "Patient has a conflicting active counter assignment" } };
      }
      if (patient.status !== "serving" || !patient.called_at || patient.completed_at) {
        return { data: null, error: { code: "P0001", message: "Only an active serving patient can receive consultation actions" } };
      }
      if (name === "start_patient_consultation") {
        if (patient.consultation_started_at) return { data: null, error: { code: "P0001", message: "Consultation has already started" } };
        if (!args.p_accepted_at || !Number.isFinite(Date.parse(args.p_accepted_at))) {
          return { data: null, error: { code: "P0001", message: "A valid doctor acceptance is required before starting consultation" } };
        }
        if (Date.parse(args.p_accepted_at) < Date.parse(patient.called_at)) {
          return { data: null, error: { code: "P0001", message: "Accept the current call before starting consultation" } };
        }
        patient.consultation_started_at = timestamp;
      } else if (name === "complete_patient_consultation") {
        if (!patient.consultation_started_at || Date.parse(timestamp) <= Date.parse(patient.consultation_started_at)) {
          return { data: null, error: { code: "P0001", message: "Start consultation before completing it; completion must be after the start" } };
        }
        const expectedStart = timestampMicroseconds(args.p_expected_started_at);
        if (expectedStart === null) {
          return { data: null, error: { code: "P0001", message: "An expected consultation start is required" } };
        }
        if (expectedStart !== timestampMicroseconds(patient.consultation_started_at)) {
          return { data: null, error: { code: "P0001", message: "Consultation attempt changed; refresh before completing" } };
        }
        patient.status = "completed";
        patient.completed_at = timestamp;
        patient.reason = args.p_reason || null;
        counter.current_patient_id = null;
      } else {
        throw new Error(`Unexpected RPC: ${name}`);
      }
      patient.visit_state_revision = crypto.randomUUID();
      if (database.beforeRpcCommit) await database.beforeRpcCommit({ name, args, patients, counters });
      database.patients.splice(0, database.patients.length, ...patients);
      database.counters.splice(0, database.counters.length, ...counters);
      return { data: database.rpcReturnsArray ? [clone(patient)] : clone(patient), error: null };
    } catch (error) {
      return { data: null, error: { code: "P0001", message: error.message } };
    } finally {
      release();
    }
  }
  return { from: (table) => new Query(table), rpc };
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
  const supabase = fakeSupabase(database, () => clock.now, options.localFallback);
  // SQL integration tests retain isolated reads while executing real migration RPCs.
  if (options.rpc) supabase.rpc = options.rpc;
  const service = loadModule("src/services/queueService.js", {
    "../lib/supabase": supabase,
    "../config/env": options.localFallback ? {} : { supabaseUrl: "https://isolated-test.invalid", supabaseServiceRoleKey: "isolated-test-key" },
    bcryptjs: {},
    "../lib/businessDay": require("../../src/lib/businessDay"), "../lib/wpsPriority": require("../../src/lib/wpsPriority"),
    "node:crypto": crypto,
    "./notificationService": {
      sendQueueCreatedNotification: (...args) => notifications.push({ type: "created", args }),
      sendQueueCalledNotification: async (...args) => notifications.push({ type: "called", args })
    },
    "./settingsService": settings
  }, clock);
  const handlers = new Map();
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (route, ...middleware) => handlers.set(`${method.toUpperCase()} ${route}`, middleware);
  }
  loadModule("src/routes/index.js", {
    express: { Router: () => router },
    jsonwebtoken: {},
    "node:crypto": crypto,
    "../config/env": {},
    "../lib/businessDay": require("../../src/lib/businessDay"), "../lib/wpsPriority": require("../../src/lib/wpsPriority"),
    "../middleware/auth": {
      // Requests provide an already verified identity. JWT cryptography itself
      // is outside this isolated route/service harness.
      authenticateToken: (req, res, next) => req.user ? next() : res.status(401).json({ success: false, message: "Authentication required" }),
      authorizeRole: (roles) => (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ success: false, message: "Unauthorized access" })
    },
    "../services/queueService": service,
    // Queue regression tests supply an already authenticated identity. Session
    // SQL and real JWT/middleware behavior have separate Phase A tests.
    "../services/presenceService": options.presence || {},
    "../services/settingsService": settings
  }, clock);

  return {
    service, settings, database, clock, virtualFs, loadSettings, notifications,
    async initialize() {
      if (options.localFallback) await service.getDisplaySettings();
    },
    async request(method, route, body = {}, user = { id_num: "frontdesk", role: "admin", doctor_name: null }, query = {}) {
      const middleware = handlers.get(`${method.toUpperCase()} ${route}`);
      if (!middleware) throw new Error(`Missing route ${method} ${route}`);
      const response = {
        statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
        json(data) { this.body = clone(data); return this; }, send(data) { this.body = data; return this; },
        setHeader(name, value) { this.headers[name] = value; return this; }
      };
      // The real middleware only admits tokens whose jti names a valid persisted session.
      if (user && !Object.hasOwn(user, "jti")) user = { ...user, jti: crypto.randomUUID() };
      const request = { body, user, query, params: {} };
      const run = async (index) => {
        const handler = middleware[index];
        if (!handler) return;
        let nextResult;
        await handler(request, response, () => { nextResult = run(index + 1); return nextResult; });
        if (nextResult) await nextResult;
      };
      await run(0);
      return { status: response.statusCode, body: response.body, headers: response.headers };
    },
    advance(milliseconds = 1000) { clock.now += milliseconds; }
  };
}

module.exports = { createHarness, createDatabase, clone };
