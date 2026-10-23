// Phase B.2 Records compatibility: actual migration, preflight, verify, rollback and No-show
// SQL executed in disposable in-memory PGlite databases that model the development
// project's known schema (helpers/liveKnownSchema.js). Synthetic rows only. Never reads
// credentials, connects to Supabase or touches real patient records.
//
// PGlite limits (see docs/phase-b2-records-installation.md): one connection (no lock or
// concurrency behaviour), a superuser installer (Supabase's postgres is not), no PostgREST
// (NOTIFY pgrst and PGRST* errors are not exercised here) and no BYPASSRLS service_role.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { describe, test, before, after } = require("node:test");
const { liveKnownDatabase, readScript } = require("./helpers/liveKnownSchema");

let PGlite;
let unavailable;
try {
  ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional PGlite is not installed; use the temporary package instructions in docs/phase2-consultation.md.";
}

const B2 = "20261023-phase-b2-records.sql";
const PREFLIGHT = "20261023-phase-b2-preflight.sql";
const VERIFY = "20261023-phase-b2-verify.sql";
const ROLLBACK = "20261023-phase-b2-rollback.sql";
const NO_SHOW = "20261023-no-show-enum.sql";
const NO_SHOW_VERIFY = "20261023-no-show-enum-verify.sql";
const RECORDS_FN = "public.get_central_records(text,jsonb,integer,integer)";
const PATIENT_FIELDS = ["called_at", "completed_at", "consultation_started_at", "created_at", "doctor", "doctor_source", "id",
  "patient_name", "priority_score", "queue_number", "service_type", "status"];
const IDENTITY_FIELDS = ["account_status", "authenticated", "created_at", "display_name", "doctor", "doctor_resolved", "id",
  "last_login", "last_seen", "online", "position", "role", "staff_profile"];

const records = async (db, category, filters = {}, page = 1, limit = 20) =>
  (await db.query("SELECT public.get_central_records($1, $2::jsonb, $3, $4) AS r", [category, JSON.stringify(filters), page, limit])).rows[0].r;
const scalar = async (db, sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
// Runs a whole SQL file. A failed file leaves its transaction aborted; always clean up.
async function runFile(db, name) {
  try {
    return await db.exec(readScript(name));
  } catch (error) {
    await db.exec("ROLLBACK").catch(() => {});
    throw error;
  }
}
async function preflight(db) {
  const results = await runFile(db, PREFLIGHT);
  const rows = results.find((result) => result.rows?.[0]?.gate !== undefined).rows;
  return { rows, status: Object.fromEntries(rows.map((row) => [row.gate, row.status])), detail: Object.fromEntries(rows.map((row) => [row.gate, row.detail])) };
}
async function seedStaff(db) {
  await db.exec(`
    INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
      ('superadmin', 'synthetic', 'superadmin', NULL), ('admin1', 'synthetic', 'admin', 'Doctor 1'),
      ('admin2', 'synthetic', 'admin', 'doctor 2'), ('admin3', 'synthetic', 'admin', '3'),
      ('frontdesk', 'synthetic', 'admin', NULL), ('frontdesk2', 'synthetic', 'admin', 'Front Desk'),
      ('frontdesk3', 'synthetic', 'admin', ' frontdesk '), ('admin9', 'synthetic', 'admin', 'Doctor 9');
    INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
      ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');
  `);
}
// 25 synthetic visits; names and identifiers are stored exactly as entered in id_num.
async function seedPatients(db) {
  const rows = [
    ["Juan Dela Cruz", "GP-001", "consultation", "waiting", null, "2026-10-22T16:30:00Z"], // Manila 2026-10-23 00:30
    ["PHIL-123-SYNTH", "GP-002", "checkup", "serving", "Doctor 1", "2026-10-22T15:30:00Z"], // Manila 2026-10-22 23:30
    ["Maria Santos", "OB-001", "prenatal", "serving", "Doctor 2", "2026-10-22T01:00:00Z"],
    ["Ana Reyes", "FP-001", "family_planning", "completed", "Doctor 3", "2026-10-22T02:00:00Z"],
    ["Pedro Penduko 100%_", "GP-003", "consultation", "cancelled", "1", "2026-10-22T03:00:00Z"], // numeric alias
    ["Legacy Unresolved", "GP-004", "consultation", "completed", "Doctor 9", "2026-10-21T03:00:00Z"],
    ["Unknown Service", "XX-001", "dental", "waiting", null, "2026-10-21T04:00:00Z"] // routes to Doctor 1
  ];
  // ids 9 and 10 share a timestamp: numeric id must break the tie (10 before 9).
  for (let i = 0; i < 18; i += 1) {
    const created = i === 1 || i === 2 ? "2026-10-20T05:00:00Z" : `2026-10-20T0${i % 9}:${String(i).padStart(2, "0")}:00Z`;
    rows.push([`Synthetic Filler ${i}`, `GP-1${String(i).padStart(2, "0")}`, "consultation", "completed", "Doctor 1", created]);
  }
  for (const [name, ticket, service, status, counter, created] of rows) {
    await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, created_at, mobile_number,
      philhealth_id, birthdate, residency, sex, priority_score, vulnerability_flags, source)
      VALUES ($1, $2, $3, $4, $5, $6, '09000000000', 'PH-SECRET', '1950-01-01', 'Synthetic Zone', 'X', 1, '["senior"]', 'website')`,
    [name, ticket, service, status, counter, created]);
  }
}
const snapshot = async (db) => (await db.query(`SELECT
  (SELECT json_agg(p ORDER BY id) FROM public.patients p) AS patients,
  (SELECT json_agg(u ORDER BY id_num) FROM public.users u) AS users,
  (SELECT json_agg(c ORDER BY id) FROM public.counters c) AS counters,
  (SELECT json_agg(s ORDER BY session_id) FROM public.staff_auth_sessions s) AS sessions,
  (SELECT CASE WHEN to_regclass('public.staff_auth_activity') IS NOT NULL
     THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.staff_auth_activity', false, true, '')))[1]::text END) AS activity`)).rows[0];
// ACLs, RLS flags and function grants of everything that existed before B.2.
const privileges = async (db) => (await db.query(`SELECT
  (SELECT json_agg(json_build_object('t', relname, 'acl', relacl::text, 'rls', relrowsecurity, 'force', relforcerowsecurity) ORDER BY relname)
     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')) AS tables,
  (SELECT json_agg(json_build_object('f', p.oid::regprocedure::text, 'acl', p.proacl::text) ORDER BY p.oid::regprocedure::text)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('create_staff_auth_session', 'validate_staff_auth_session',
       'heartbeat_staff_auth_session', 'revoke_staff_auth_session', 'revoke_staff_user_sessions', 'get_staff_doctor_presence')) AS functions`)).rows[0];

// Actual backend modules, loaded in isolation and backed by a PGlite database.
function loadModule(file, imports, context = {}) {
  const module = { exports: {} };
  vm.runInNewContext(`(function (require, module, exports) {${fs.readFileSync(path.join(__dirname, "..", file), "utf8")}\n})`, context)(
    (name) => { if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`); return imports[name]; }, module, module.exports);
  return module.exports;
}
function supabaseFor(db) {
  return { rpc: async (name, parameters = {}) => {
    assert.match(name, /^[a-z_]+$/);
    const entries = Object.entries(parameters);
    const named = entries.map(([key], index) => `${key} => $${index + 1}`).join(", ");
    try {
      const result = await db.query(`SELECT to_jsonb(public.${name}(${named})) AS value`,
        entries.map(([, value]) => value !== null && typeof value === "object" ? JSON.stringify(value) : value));
      return { data: result.rows[0].value, error: null };
    } catch (error) {
      return { data: null, error: { code: error.code, message: error.message } };
    }
  } };
}
const SECRET = "phase-b2-isolated-tests";
function backendFor(db) {
  const supabase = supabaseFor(db);
  const presence = loadModule("src/services/presenceService.js", { "../lib/supabase": supabase });
  const auth = loadModule("src/middleware/auth.js", { jsonwebtoken: jwt, "../config/env": { jwtSecret: SECRET }, "../services/presenceService": presence });
  let chain;
  const logs = [];
  const router = { use: (...handlers) => { chain = handlers; }, get: (_path, handler) => chain.push(handler) };
  loadModule("src/routes/records.js", { express: { Router: () => router }, "../middleware/auth": auth, "../lib/supabase": supabase },
    { console: { warn: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) } });
  // Same steps as POST /auth/login after the password check (routes/index.js).
  async function login(idNum) {
    const user = (await db.query("SELECT id_num, role::text AS role, doctor_name, auth_revision FROM public.users WHERE id_num = $1", [idNum])).rows[0];
    const jti = randomUUID();
    const session = await presence.createAuthSession(user, jti);
    const claims = { id_num: user.id_num, role: user.role, doctor_name: user.doctor_name, jti };
    return { claims, token: jwt.sign({ ...claims, exp: Math.floor(Date.parse(session.expires_at) / 1000) }, SECRET, { algorithm: "HS256" }) };
  }
  async function get(token, category, query = {}) {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, params: { category }, query };
    const res = { code: 200, headers: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader(key, value) { this.headers[key] = value; } };
    // authorizeRole calls next() without returning it, so await every step explicitly.
    const pending = [];
    const run = async (index) => {
      if (chain[index]) await chain[index](req, res, () => { const step = run(index + 1); pending.push(step); return step; });
    };
    await run(0);
    while (pending.length) await pending.shift();
    return res;
  }
  return { presence, login, get, logs };
}
// Values built inside a vm context carry its prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
// SQL text without comments and string literals, for structural checks.
const sqlCode = (name) => readScript(name).replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
const activity = async (db, account) => (await records(db, "activity", { account }, 1, 100)).rows.map((row) => row.event);

describe("Phase B.2 Records compatibility (PostgreSQL)", { skip: unavailable }, () => {
  describe("1. original Phase B on the known schema", () => {
    let db;
    before(async () => { db = await liveKnownDatabase(PGlite); await seedStaff(db); await runFile(db, "20261014-phase-b-records.sql"); });
    after(async () => db && db.close());

    test("installs without error but every category fails at runtime on the missing name columns", async () => {
      for (const category of ["patients", "staff", "accounts", "activity"]) {
        await assert.rejects(records(db, category), (error) => error.code === "42703" && /first_name|last_name/.test(error.message), category);
      }
    });
    test("its verify script cannot run on this schema", async () => {
      await assert.rejects(runFile(db, "20261014-phase-b-verify.sql"), (error) => error.code === "42703");
    });
    test("the original Phase B files are kept unchanged as history", () => {
      assert.match(readScript("20261014-phase-b-records.sql"), /concat_ws\(' ',p\.first_name,p\.last_name\)/);
      assert.match(readScript("20261014-phase-b-verify.sql"), /first_name,last_name,mobile_number/);
    });
  });

  describe("2. dependency gate", () => {
    test("without Phase A the migration stops with 55000 and installs nothing", async () => {
      const db = await liveKnownDatabase(PGlite, { migrations: ["20261010-phase2-consultation-lifecycle.sql"] });
      try {
        const report = await preflight(db);
        assert.equal(report.status.overall, "FAIL");
        assert.equal(report.status["table public.staff_auth_sessions"], "FAIL");
        await assert.rejects(runFile(db, B2), (error) => error.code === "55000" && /staff_auth_sessions/.test(error.message));
        assert.equal(await scalar(db, "SELECT to_regclass('public.staff_auth_activity') IS NULL"), true);
        assert.equal(await scalar(db, `SELECT to_regprocedure('${RECORDS_FN}') IS NULL`), true);
      } finally { await db.close(); }
    });
    test("without Phase 2's consultation_started_at the migration stops and names the column", async () => {
      const db = await liveKnownDatabase(PGlite, { migrations: ["20261012-phase-a-auth-presence.sql"] });
      try {
        assert.equal((await preflight(db)).status["required columns"], "FAIL");
        await assert.rejects(runFile(db, B2), (error) => error.code === "55000" && /patients\.consultation_started_at/.test(error.message));
        assert.equal(await scalar(db, `SELECT to_regprocedure('${RECORDS_FN}') IS NULL`), true);
      } finally { await db.close(); }
    });
    test("an activity table with an unexpected shape is refused, not reused", async () => {
      const db = await liveKnownDatabase(PGlite);
      try {
        await db.exec("CREATE TABLE public.staff_auth_activity (id bigint, user_id_num text, event text, occurred_at timestamptz, note text)");
        assert.equal((await preflight(db)).status["table public.staff_auth_activity"], "FAIL");
        await assert.rejects(runFile(db, B2), (error) => error.code === "55000" && /unexpected shape/.test(error.message));
      } finally { await db.close(); }
    });
  });

  describe("3-13. Phase B.2 installed on the known schema", () => {
    let db;
    let backend;
    let before_;
    let privilegesBefore;
    let preflightBefore;
    let earlySession;
    before(async () => {
      db = await liveKnownDatabase(PGlite);
      await seedStaff(db);
      await seedPatients(db);
      backend = backendFor(db);
      // A JWT session issued before installation must keep working afterwards.
      earlySession = await backend.login("admin2");
      before_ = await snapshot(db);
      privilegesBefore = await privileges(db);
      preflightBefore = await preflight(db);
      await runFile(db, B2);
    });
    after(async () => db && db.close());

    test("preflight passes on the known pre-B.2 state and reports it accurately", () => {
      const { status, detail } = preflightBefore;
      assert.equal(status.overall, "PASS");
      assert.equal(status["read-only session"], "PASS");
      assert.match(detail["patients.first_name / last_name"], /^absent/);
      assert.match(detail["users.created_at"], /^absent/);
      assert.match(detail["enum queue_status / no-show"], /no-show absent/);
      assert.match(detail["current get_central_records"], /^absent/);
      assert.match(detail["current revoke_staff_auth_session body"], /^Phase A/);
      assert.equal(status["browser grants on public.patients"], "WARN", "existing broad grants are reported, not changed");
      assert.equal(status["definer can read public.patients"], "PASS");
    });

    test("installation writes no patient, user, counter or session row and changes no existing grant or RLS flag", async () => {
      const now = await snapshot(db);
      for (const key of ["patients", "users", "counters", "sessions"]) assert.deepEqual(now[key], before_[key], key);
      assert.equal(now.activity, "0", "no activity is backfilled");
      assert.deepEqual(await privileges(db), privilegesBefore);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'public.patients'::regclass AND attname IN ('first_name', 'last_name')"), 0,
        "no patient identity columns are fabricated");
    });

    test("3. every category returns the documented contract", async () => {
      await backend.login("superadmin");
      for (const category of ["patients", "staff", "accounts", "activity"]) {
        const result = await records(db, category);
        assert.deepEqual(Object.keys(result).sort(), ["limit", "observed_at", "page", "rows", "total"], category);
        assert.equal(result.page, 1);
        assert.equal(result.limit, 20);
        assert.ok(Number.isInteger(result.total));
      }
      assert.deepEqual(Object.keys((await records(db, "patients")).rows[0]).sort(), PATIENT_FIELDS);
      assert.deepEqual(Object.keys((await records(db, "accounts")).rows[0]).sort(), IDENTITY_FIELDS);
      assert.deepEqual(Object.keys((await records(db, "staff")).rows[0]).sort(), IDENTITY_FIELDS);
      assert.deepEqual(Object.keys((await records(db, "activity")).rows[0]).sort(), ["account", "event", "id", "occurred_at"]);
    });

    test("4. patient names and identifiers are shown exactly as stored in id_num", async () => {
      const rows = (await records(db, "patients", {}, 1, 100)).rows;
      const byTicket = Object.fromEntries(rows.map((row) => [row.queue_number, row]));
      assert.equal(byTicket["GP-001"].patient_name, "Juan Dela Cruz");
      assert.equal(byTicket["GP-002"].patient_name, "PHIL-123-SYNTH");
      assert.equal(byTicket["GP-003"].patient_name, "Pedro Penduko 100%_");
    });

    test("5. positions: Super Admin, Doctor and Frontdesk follow the app's assignment convention", async () => {
      const byId = Object.fromEntries((await records(db, "accounts", {}, 1, 100)).rows.map((row) => [row.id, row]));
      assert.equal(byId.superadmin.position, "Super Admin");
      for (const id of ["admin1", "admin2", "admin3", "admin9"]) assert.equal(byId[id].position, "Doctor", id);
      for (const id of ["frontdesk", "frontdesk2", "frontdesk3"]) {
        assert.equal(byId[id].position, "Frontdesk", id);
        assert.equal(byId[id].doctor, null, id);
        assert.equal(byId[id].doctor_resolved, null, id);
        assert.equal(byId[id].display_name, id);
      }
      assert.deepEqual([byId.admin2.doctor, byId.admin2.doctor_resolved, byId.admin2.display_name], ["Doctor 2", true, "Doctor 2"]);
      assert.deepEqual([byId.admin3.doctor, byId.admin3.doctor_resolved], ["Doctor 3", true]);
      assert.deepEqual([byId.admin9.doctor, byId.admin9.doctor_resolved], ["Doctor 9", false]);
      for (const row of Object.values(byId)) assert.equal(row.created_at, null, "creation dates are not recorded");
      assert.deepEqual((await records(db, "staff", { position: "Frontdesk" })).rows.map((row) => row.id).sort(), ["frontdesk", "frontdesk2", "frontdesk3"]);
      assert.deepEqual((await records(db, "staff", { position: "Super Admin" })).rows.map((row) => row.id), ["superadmin"]);
      assert.equal((await records(db, "staff", { position: "Doctor" })).total, 4);
    });

    test("6. doctor = stored assignment, else service routing, and the source is reported", async () => {
      const byDoctor = async (doctor) => (await records(db, "patients", { doctor }, 1, 100)).rows.map((row) => row.queue_number).sort();
      const doctor1 = await byDoctor("Doctor 1");
      for (const ticket of ["GP-001", "GP-002", "GP-003", "XX-001"]) assert.ok(doctor1.includes(ticket), ticket);
      assert.ok(!doctor1.includes("GP-004"), "an unresolved stored assignment is never re-routed by service");
      assert.deepEqual(await byDoctor("doctor 01"), doctor1);
      assert.deepEqual(await byDoctor("1"), doctor1);
      assert.deepEqual(await byDoctor(" DOCTOR 1 "), doctor1);
      assert.deepEqual(await byDoctor("Doctor 2"), ["OB-001"]);
      assert.deepEqual(await byDoctor("Doctor 3"), ["FP-001"]);
      const source = Object.fromEntries((await records(db, "patients", {}, 1, 100)).rows.map((row) => [row.queue_number, [row.doctor, row.doctor_source]]));
      assert.deepEqual(source["GP-001"], ["Doctor 1", "service"]);
      assert.deepEqual(source["XX-001"], ["Doctor 1", "service"]);
      assert.deepEqual(source["GP-002"], ["Doctor 1", "assigned"]);
      assert.deepEqual(source["GP-003"], ["Doctor 1", "assigned"]);
      assert.deepEqual(source["GP-004"], ["Doctor 9", "unresolved"]);
      assert.deepEqual((await records(db, "staff", { doctor: "Doctor 2" })).rows.map((row) => row.id), ["admin2"]);
      assert.deepEqual((await records(db, "staff", { doctor: "3" })).rows.map((row) => row.id), ["admin3"]);
    });

    test("7. search and filters combine; wildcard characters are literal", async () => {
      assert.deepEqual((await records(db, "patients", { search: "dela" })).rows.map((r) => r.queue_number), ["GP-001"]);
      assert.deepEqual((await records(db, "patients", { search: "  PHIL-123 " })).rows.map((r) => r.queue_number), ["GP-002"]);
      assert.deepEqual((await records(db, "patients", { search: "100%_" })).rows.map((r) => r.queue_number), ["GP-003"]);
      assert.equal((await records(db, "patients", { search: "%" })).total, 1);
      assert.equal((await records(db, "patients", { search: "ob-0" })).total, 1);
      assert.equal((await records(db, "patients", { search: "PH-SECRET" })).total, 0, "private identifiers are not searchable");
      assert.equal((await records(db, "patients", { status: "cancelled" })).total, 1);
      assert.equal((await records(db, "patients", { service: "family_planning" })).total, 1);
      assert.equal((await records(db, "patients", { service: "unknown-service" })).total, 0);
      assert.deepEqual((await records(db, "patients", { date: "2026-10-23" })).rows.map((r) => r.queue_number), ["GP-001"]);
      assert.equal((await records(db, "patients", { date: "2026-10-22" })).total, 4, "23:30 Manila stays on the 22nd");
      assert.deepEqual((await records(db, "patients", { visit: "3" })).rows.map((r) => r.queue_number), ["OB-001"]);
      assert.deepEqual((await records(db, "patients", { status: "serving", doctor: "Doctor 2", date: "2026-10-22", search: "maria" })).rows.map((r) => r.queue_number), ["OB-001"]);
      assert.deepEqual((await records(db, "staff", { search: "front" })).rows.map((r) => r.id).sort(), ["frontdesk", "frontdesk2", "frontdesk3"]);
      assert.deepEqual((await records(db, "staff", { role: "superadmin" })).rows.map((r) => r.id), ["superadmin"]);
      assert.deepEqual((await records(db, "accounts", { role: "admin", position: "Doctor", search: "doctor 9" })).rows.map((r) => r.id), ["admin9"]);
    });

    test("8. pages are disjoint and complete, newest first, ties broken by numeric id", async () => {
      const seen = [];
      for (let page = 1; page <= 3; page += 1) {
        const result = await records(db, "patients", {}, page, 10);
        assert.equal(result.total, 25);
        seen.push(...result.rows);
      }
      assert.equal(seen.length, 25);
      assert.equal(new Set(seen.map((row) => row.id)).size, 25);
      for (let i = 1; i < seen.length; i += 1) {
        const a = seen[i - 1], b = seen[i];
        assert.ok(Date.parse(a.created_at) > Date.parse(b.created_at) || (a.created_at === b.created_at && a.id > b.id), `${a.id} before ${b.id}`);
      }
      const ids = seen.map((row) => row.id);
      assert.equal(ids.indexOf(9), ids.indexOf(10) + 1, "id 10 sorts before id 9, not as text");
      assert.deepEqual((await records(db, "patients", {}, 4, 10)).rows, []);
      assert.equal((await records(db, "patients", {}, 4, 10)).total, 25);
      const staff = [];
      for (let page = 1; page <= 3; page += 1) staff.push(...(await records(db, "staff", {}, page, 3)).rows.map((row) => row.id));
      assert.deepEqual([...staff].sort(), ["admin1", "admin2", "admin3", "admin9", "frontdesk", "frontdesk2", "frontdesk3", "superadmin"]);
    });

    test("9. invalid inputs raise 22023, never a storage error", async () => {
      const invalid = [
        ["patients", { status: "bogus" }], ["patients", { status: "No-show" }], ["patients", { date: "2026-02-31" }],
        ["patients", { date: "23-10-2026" }], ["patients", { date: "2026-1-01" }], ["patients", { date: "0000-01-01" }],
        ["patients", { doctor: "Doctor 9" }], ["patients", { doctor: "Nobody" }], ["patients", { visit: "abc" }],
        ["patients", { visit: "1".repeat(19) }], ["accounts", { position: "Admin" }], ["accounts", { position: "frontdesk" }],
        ["accounts", { presence: "maybe" }], ["accounts", { role: "root" }], ["patients", { unknown: "x" }],
        ["patients", { search: 5 }], ["patients", { search: null }], ["patients", { search: "x".repeat(101) }], ["patients", []],
        ["patients", "text"], ["patients", null], ["nope", {}], [null, {}]
      ];
      for (const [category, filters] of invalid) {
        await assert.rejects(records(db, category, filters), (error) => error.code === "22023", `${category} ${JSON.stringify(filters)}`);
      }
      for (const [page, limit] of [[0, 20], [1, 0], [1, 101], [100001, 20], [null, 20], [1, null]]) {
        await assert.rejects(records(db, "patients", {}, page, limit), (error) => error.code === "22023", `${page}/${limit}`);
      }
      assert.equal((await db.query("SELECT public.get_central_records('patients', NULL, 1, 20) AS r")).rows[0].r.total, 25, "SQL NULL filters mean no filters");
      assert.equal((await records(db, "patients", { search: "x".repeat(100) })).total, 0);
    });

    test("10. the API: only a validated Superadmin session reads Records; SQL validation errors become 400", async () => {
      const superadmin = await backend.login("superadmin");
      const doctor = await backend.login("admin1");
      const frontdesk = await backend.login("frontdesk");
      for (const category of ["patients", "staff", "accounts", "activity"]) {
        assert.equal((await backend.get(null, category)).code, 401, category);
        assert.equal((await backend.get(doctor.token, category)).code, 403, category);
        assert.equal((await backend.get(frontdesk.token, category)).code, 403, category);
        const ok = await backend.get(superadmin.token, category);
        assert.equal(ok.code, 200, category);
        assert.ok(Array.isArray(ok.body.rows));
        assert.equal(ok.headers["Cache-Control"], "no-store");
      }
      assert.equal((await backend.get(jwt.sign({ id_num: "superadmin", role: "superadmin", jti: randomUUID() }, "wrong-secret"), "patients")).code, 403);
      const forged = jwt.sign({ id_num: "admin1", role: "superadmin", doctor_name: "Doctor 1", jti: doctor.claims.jti }, SECRET);
      assert.equal((await backend.get(forged, "patients")).code, 401, "a role claim not matching the stored account is refused");
      const unknownDoctor = await backend.get(superadmin.token, "patients", { doctor: "Doctor 9" });
      assert.deepEqual([unknownDoctor.code, unknownDoctor.body.message], [400, "Invalid records filter"]);
      assert.ok(backend.logs.includes("[records] GET /api/records/patients failed: 22023"));
      assert.ok(!backend.logs.some((line) => /Doctor 9|Unknown doctor/.test(line)), "database text is not logged");
      const filtered = await backend.get(superadmin.token, "patients", { doctor: "doctor 2", status: "serving" });
      assert.deepEqual(filtered.body.rows.map((row) => row.queue_number), ["OB-001"]);
      const noShow = await backend.get(superadmin.token, "patients", { status: "no-show" });
      assert.deepEqual([noShow.code, noShow.body.total], [200, 0]);
      await backend.presence.revokeAuthSession(superadmin.claims);
      assert.equal((await backend.get(superadmin.token, "patients")).code, 401, "a logged-out Superadmin token is refused");
    });

    test("11. Phase A sessions, logout and revocation keep their behaviour; activity is recorded alongside", async () => {
      // Issued before installation, still valid; its logout is recorded.
      await backend.presence.validateAuthSession(earlySession.claims);
      await backend.presence.heartbeatAuthSession(earlySession.claims);
      assert.deepEqual(await activity(db, "admin2"), [], "pre-installation logins are not backfilled");
      assert.deepEqual(plain(await backend.presence.revokeAuthSession(earlySession.claims)), { revoked: true });
      assert.deepEqual(await activity(db, "admin2"), ["logout"]);

      const session = await backend.login("admin3");
      assert.deepEqual(await activity(db, "admin3"), ["login"]);
      const loginAt = (await records(db, "activity", { account: "admin3" })).rows[0].occurred_at;
      const sessionAt = await scalar(db, "SELECT to_jsonb(created_at) FROM public.staff_auth_sessions WHERE session_id = $1", [session.claims.jti]);
      assert.equal(loginAt, sessionAt, "login time is the session's own creation time");
      await backend.presence.validateAuthSession(session.claims);
      assert.deepEqual(plain(await backend.presence.revokeAuthSession(session.claims)), { revoked: true });
      assert.deepEqual(plain(await backend.presence.revokeAuthSession(session.claims)), { revoked: true }, "logout stays idempotent");
      assert.deepEqual(await activity(db, "admin3"), ["logout", "login"], "one logout per session");
      await assert.rejects(backend.presence.validateAuthSession(session.claims), (error) => error.statusCode === 401);
      // Someone else's logout request cannot revoke or record anything.
      const other = await backend.login("admin1");
      await db.query("SELECT public.revoke_staff_auth_session($1, 'admin3')", [other.claims.jti]);
      await backend.presence.validateAuthSession(other.claims);
      assert.deepEqual(await activity(db, "admin3"), ["logout", "login"]);

      // Account changes and administrative revocation end sessions but are not logouts.
      const changed = await backend.login("admin9");
      await db.query("UPDATE public.users SET doctor_name = 'Doctor 3' WHERE id_num = 'admin9'");
      await assert.rejects(backend.presence.validateAuthSession(changed.claims), (error) => error.statusCode === 401);
      await db.query("UPDATE public.users SET doctor_name = 'Doctor 9' WHERE id_num = 'admin9'");
      const bulk = await backend.login("frontdesk2");
      assert.deepEqual(plain(await backend.presence.revokeUserSessions("frontdesk2")), { revoked_count: 1 });
      await assert.rejects(backend.presence.validateAuthSession(bulk.claims), (error) => error.statusCode === 401);
      assert.deepEqual(await activity(db, "admin9"), ["login"]);
      assert.deepEqual(await activity(db, "frontdesk2"), ["login"]);

      // Login failures are unchanged: a stale credential revision is refused and leaves nothing.
      const admin1Activity = await activity(db, "admin1");
      const stale = (await db.query("SELECT id_num, role::text AS role, doctor_name FROM public.users WHERE id_num = 'admin1'")).rows[0];
      await assert.rejects(backend.presence.createAuthSession({ ...stale, auth_revision: randomUUID() }, randomUUID()),
        (error) => error.statusCode === 401 && /expired or was revoked/.test(error.message));
      await assert.rejects(backend.presence.createAuthSession({ ...stale, auth_revision: undefined }, randomUUID()),
        (error) => error.statusCode === 503);
      assert.deepEqual(await activity(db, "admin1"), admin1Activity, "refused logins record nothing");

      const presence = Object.fromEntries((await records(db, "accounts", {}, 1, 100)).rows.map((row) => [row.id, row]));
      assert.equal(presence.admin3.authenticated, false);
      assert.equal(presence.admin1.authenticated, true);
      assert.equal(presence.admin1.online, true);
      await db.query("UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '76 seconds' WHERE user_id_num = 'admin1'");
      const stale1 = (await records(db, "accounts", { search: "admin1" })).rows[0];
      assert.deepEqual([stale1.online, stale1.authenticated], [false, true], "presence stays distinct from authentication");
      assert.deepEqual(await activity(db, "admin1"), admin1Activity, "a heartbeat timeout is not a logout");
    });

    test("11b. activity storage failures never block sign-in and never keep a session alive", async () => {
      await db.exec(`CREATE FUNCTION public.test_fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated activity storage failure' USING ERRCODE = '53100'; END $$;
        CREATE TRIGGER test_fail_activity BEFORE INSERT ON public.staff_auth_activity FOR EACH ROW EXECUTE FUNCTION public.test_fail_activity();`);
      try {
        const countBefore = await scalar(db, "SELECT count(*)::int FROM public.staff_auth_activity");
        const session = await backend.login("frontdesk3");
        await backend.presence.validateAuthSession(session.claims);
        assert.deepEqual(plain(await backend.presence.revokeAuthSession(session.claims)), { revoked: true });
        await assert.rejects(backend.presence.validateAuthSession(session.claims), (error) => error.statusCode === 401,
          "the logout took effect although its activity could not be stored");
        assert.equal(await scalar(db, "SELECT count(*)::int FROM public.staff_auth_activity"), countBefore);
        assert.equal(await scalar(db, "SELECT count(*)::int FROM public.staff_auth_sessions WHERE user_id_num = 'frontdesk3' AND revoked_at IS NOT NULL"), 1);
      } finally {
        await db.exec("DROP TRIGGER test_fail_activity ON public.staff_auth_activity; DROP FUNCTION public.test_fail_activity();");
      }
    });

    test("12. the No-show filter returns zero rows while queue_status lacks the value", async () => {
      assert.equal(await scalar(db, "SELECT 'no-show' = ANY (enum_range(NULL::public.queue_status)::text[])"), false);
      const result = await records(db, "patients", { status: "no-show" });
      assert.deepEqual([result.total, result.rows], [0, []]);
      assert.equal((await records(db, "patients", { status: "no-show", doctor: "Doctor 1", date: "2026-10-22" })).total, 0);
      await assert.rejects(db.query("SELECT 'no-show'::public.queue_status"), (error) => error.code === "22P02",
        "marking No-show is still impossible: the workflow is not activated by B.2");
    });

    test("13. no sensitive field leaves the function and browser roles cannot reach Records", async () => {
      const all = JSON.stringify([await records(db, "patients", {}, 1, 100), await records(db, "accounts", {}, 1, 100), await records(db, "activity", {}, 1, 100)]);
      assert.doesNotMatch(all, /PH-SECRET|09000000000|Synthetic Zone|1950-01-01|senior|website|synthetic"|auth_revision|password|visit_state_revision/);
      const signatures = [RECORDS_FN, "public.revoke_staff_auth_session(uuid,text)", "public.record_staff_login()"];
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const signature of signatures) {
          const expected = role === "service_role" && signature !== "public.record_staff_login()";
          assert.equal(await scalar(db, "SELECT has_function_privilege($1, $2, 'EXECUTE')", [role, signature]), expected, `${role} ${signature}`);
        }
        assert.equal(await scalar(db, "SELECT has_table_privilege($1, 'public.staff_auth_activity', 'SELECT')", [role]), role === "service_role", role);
        assert.equal(await scalar(db, "SELECT has_table_privilege($1, 'public.staff_auth_activity', 'INSERT,UPDATE,DELETE,TRUNCATE')", [role]), false, role);
        assert.equal(await scalar(db, "SELECT has_sequence_privilege($1, pg_get_serial_sequence('public.staff_auth_activity', 'id'), 'USAGE,SELECT,UPDATE')", [role]), false, role);
      }
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(records(db, "patients"), (error) => error.code === "42501", role);
          await assert.rejects(db.query("SELECT * FROM public.staff_auth_activity"), (error) => error.code === "42501", role);
          await assert.rejects(db.query("SELECT public.revoke_staff_auth_session(gen_random_uuid(), 'admin1')"), (error) => error.code === "42501", role);
        } finally { await db.exec("RESET ROLE"); }
      }
      await db.exec("SET ROLE service_role");
      try {
        assert.equal((await records(db, "patients")).total, 25, "service_role reads through the definer function");
        await assert.rejects(db.query("INSERT INTO public.staff_auth_activity (user_id_num, event) VALUES ('superadmin', 'login')"),
          (error) => error.code === "42501", "the backend cannot fabricate activity");
      } finally { await db.exec("RESET ROLE"); }
      const functions = (await db.query(`SELECT p.oid::regprocedure::text AS f, p.prosecdef, p.proconfig, p.provolatile FROM pg_proc p
        WHERE p.oid = ANY (ARRAY['${RECORDS_FN}', 'public.revoke_staff_auth_session(uuid,text)', 'public.record_staff_login()']::regprocedure[])`)).rows;
      assert.equal(functions.length, 3);
      for (const fn of functions) {
        assert.equal(fn.prosecdef, true, fn.f);
        assert.deepEqual(fn.proconfig, ['search_path=""'], fn.f);
      }
      assert.equal(functions.find((fn) => fn.f.startsWith("get_central_records")).provolatile, "s", "the read model is STABLE (read-only)");
      // Dynamic SQL: only B.2's REVOKE on the identity sequence, whose name is regclass-quoted.
      for (const name of [B2, PREFLIGHT, VERIFY, ROLLBACK]) {
        const dynamic = sqlCode(name).match(/\bEXECUTE\s+(?!FUNCTION\b|ON\b)\S+/gi) || [];
        assert.deepEqual(dynamic, name === B2 ? ["EXECUTE pg_catalog.format(''," ] : [], name);
      }
    });

    test("preflight reports the installed state", async () => {
      const { status, detail } = await preflight(db);
      assert.equal(status.overall, "PASS");
      assert.match(detail["current get_central_records"], /Phase B\.2 installed/);
      assert.match(detail["current revoke_staff_auth_session body"], /records explicit logout/);
      assert.equal(status["table public.staff_auth_activity"], "PASS");
      assert.equal(detail["trigger staff_login_activity"], "present");
      assert.equal(status["browser execute on Phase A / Records functions"], "PASS");
    });
  });

  describe("14-15. repeatable installation, preflight, verification and rollback", () => {
    let db;
    let phaseARevokeSource;
    before(async () => {
      db = await liveKnownDatabase(PGlite);
      await seedStaff(db);
      await seedPatients(db);
      phaseARevokeSource = await scalar(db, "SELECT prosrc FROM pg_proc WHERE oid = 'public.revoke_staff_auth_session(uuid,text)'::regprocedure");
    });
    after(async () => db && db.close());

    test("14. B.2 installs over the original Phase B and re-installs idempotently, keeping activity", async () => {
      await runFile(db, "20261014-phase-b-records.sql");
      assert.match((await preflight(db)).detail["current get_central_records"], /original Phase B/);
      await runFile(db, B2);
      const backend = backendFor(db);
      const session = await backend.login("admin1");
      await backend.presence.revokeAuthSession(session.claims);
      const activityBefore = await scalar(db, "SELECT json_agg(a ORDER BY id) FROM public.staff_auth_activity a");
      await runFile(db, B2);
      await runFile(db, B2);
      assert.deepEqual(await scalar(db, "SELECT json_agg(a ORDER BY id) FROM public.staff_auth_activity a"), activityBefore);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM pg_proc WHERE proname = 'get_central_records'"), 1);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM pg_trigger WHERE tgname = 'staff_login_activity'"), 1);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM pg_indexes WHERE tablename = 'staff_auth_activity'"), 3);
      await backend.login("admin1");
      assert.deepEqual(await activity(db, "admin1"), ["login", "logout", "login"], "one login row per session after re-installs");
      assert.equal((await records(db, "patients")).total, 25);
      // The original Phase B granted INSERT and sequence use; B.2 narrows them.
      assert.equal(await scalar(db, "SELECT has_table_privilege('service_role', 'public.staff_auth_activity', 'INSERT')"), false);
    });

    test("15a. the preflight is read-only and returns identical results when repeated", async () => {
      const first = await preflight(db);
      const second = await preflight(db);
      assert.deepEqual(second.rows, first.rows);
      assert.equal(first.status.overall, "PASS");
      assert.match(readScript(PREFLIGHT), /^BEGIN TRANSACTION READ ONLY;$/m);
      const statements = readScript(PREFLIGHT).replace(/--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean);
      assert.deepEqual(statements.map((statement) => statement.split(/\s+/)[0]), ["BEGIN", "WITH", "COMMIT"], "one read-only query");
      assert.doesNotMatch(sqlCode(PREFLIGHT), /\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|CREATE\s+(TABLE|FUNCTION)|ALTER\s+(TABLE|TYPE)|DROP\s|TRUNCATE\s)/i);
    });

    test("15b. the verification script passes repeatedly and leaves no rows behind", async () => {
      const before_ = await snapshot(db);
      for (let run = 0; run < 2; run += 1) {
        const results = await runFile(db, VERIFY);
        assert.match(results.at(-2).rows[0].result, /^Phase B\.2 verification passed/);
        assert.deepEqual(await snapshot(db), before_, `run ${run + 1}`);
      }
      assert.equal(await scalar(db, "SELECT count(*)::int FROM public.users WHERE id_num LIKE 'b2-verify-%'"), 0);
    });

    test("15c. verification detects a Phase A re-apply that silently stops logout recording", async () => {
      await runFile(db, "20261012-phase-a-auth-presence.sql");
      await assert.rejects(runFile(db, VERIFY), /Phase A body/);
      await runFile(db, B2);
      await runFile(db, VERIFY);
    });

    test("15d. rollback restores Phase A exactly, keeps activity history and can be repeated; B.2 re-installs afterwards", async () => {
      const activityRows = await scalar(db, "SELECT count(*)::int FROM public.staff_auth_activity");
      const before_ = await snapshot(db);
      await runFile(db, ROLLBACK);
      await runFile(db, ROLLBACK);
      assert.equal(await scalar(db, "SELECT prosrc FROM pg_proc WHERE oid = 'public.revoke_staff_auth_session(uuid,text)'::regprocedure"), phaseARevokeSource);
      assert.equal(await scalar(db, `SELECT to_regprocedure('${RECORDS_FN}') IS NULL AND to_regprocedure('public.record_staff_login()') IS NULL`), true);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM pg_trigger WHERE tgname = 'staff_login_activity'"), 0);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM public.staff_auth_activity"), activityRows);
      for (const key of ["patients", "users", "counters"]) assert.deepEqual((await snapshot(db))[key], before_[key], key);
      const backend = backendFor(db);
      const session = await backend.login("admin2");
      await backend.presence.revokeAuthSession(session.claims);
      await assert.rejects(backend.presence.validateAuthSession(session.claims), (error) => error.statusCode === 401);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM public.staff_auth_activity"), activityRows, "Phase A behaviour: nothing recorded");
      const superadmin = await backend.login("superadmin");
      const response = await backend.get(superadmin.token, "patients");
      assert.equal(response.code, 503, "Records fails closed after rollback");
      assert.match(response.body.message, /missing or incompatible/);
      assert.equal((await preflight(db)).status.overall, "PASS");
      await runFile(db, B2);
      await runFile(db, VERIFY);
    });
  });

  describe("12b. No-show enum as a separate, independent dependency", () => {
    test("B.2 does not need it; once added, the same Records filter returns no-show visits", async () => {
      const db = await liveKnownDatabase(PGlite);
      try {
        await seedStaff(db);
        await runFile(db, B2);
        await assert.rejects(runFile(db, NO_SHOW_VERIFY), /no-show is not installed/);
        await runFile(db, NO_SHOW);
        await runFile(db, NO_SHOW); // IF NOT EXISTS
        assert.deepEqual(await scalar(db, "SELECT enum_range(NULL::public.queue_status)::text[]"), ["waiting", "serving", "completed", "cancelled", "no-show"]);
        const results = await runFile(db, NO_SHOW_VERIFY);
        assert.match(results.at(-2).rows[0].result, /^No-show verification passed/);
        assert.equal(await scalar(db, "SELECT count(*)::int FROM public.patients"), 0, "the verification visit is rolled back");
        await db.query("INSERT INTO public.patients (id_num, queue_number, service_type, status) VALUES ('Synthetic', 'NS-1', 'checkup', 'no-show')");
        assert.deepEqual((await records(db, "patients", { status: "no-show" })).rows.map((row) => row.queue_number), ["NS-1"]);
        assert.equal((await preflight(db)).status.overall, "PASS");
        await runFile(db, VERIFY);
      } finally { await db.close(); }
    });
    test("the enum migration installs without B.2 and is a single additive statement", async () => {
      const db = await liveKnownDatabase(PGlite);
      try {
        await runFile(db, NO_SHOW);
        await runFile(db, NO_SHOW_VERIFY);
        const statements = readScript(NO_SHOW).replace(/--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean);
        assert.deepEqual(statements, ["ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'no-show' AFTER 'cancelled'", "NOTIFY pgrst, 'reload schema'"]);
        assert.doesNotMatch(readScript(B2), /ALTER TYPE|ADD VALUE/, "B.2 never changes the enum");
      } finally { await db.close(); }
    });
  });
});
