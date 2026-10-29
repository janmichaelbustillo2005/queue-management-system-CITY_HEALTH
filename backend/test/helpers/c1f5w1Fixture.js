// Shared fixture for the C1 + F5 + W1 installation-readiness suites on disposable PostgreSQL 17
// (c1-f5-w1-installation-sequence.test.js, c1-f5-w1-backend-workflow.test.js).
// Databases start in the development project's known state: liveKnownSchema (no 'no-show'
// label) plus the migrations the development project has (Phase 2, A, 2.1, 2.2, B.2), installed
// by a non-superuser "postgres" owner, with Supabase-like API roles and default privileges.
// The backend is the REAL routes/middleware/services through pgBackendHarness (service_role).
// Runs ONLY against the loopback cluster used for R2.2/F5/C1/W1: PHASE25_PG_URL must be
// 127.0.0.1/localhost and the server must report cluster_name = PHASE25_PG_CLUSTER (default
// "r22-disposable-cancel-verification"). Never reads .env or uses Supabase. Synthetic rows only.
// Suites skip unless PHASE25_PG_URL and PHASE25_PG_MODULE (path to a `pg` package) are set.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { liveKnownSchema, INSTALLED_MIGRATIONS } = require("./liveKnownSchema");
const { createPgBackendHarness } = require("./pgBackendHarness");

const TARGET = process.env.PHASE25_PG_URL;
const CLUSTER = process.env.PHASE25_PG_CLUSTER || "r22-disposable-cancel-verification";
let pg;
let unavailable;
if (!TARGET || !process.env.PHASE25_PG_MODULE) {
  unavailable = "Disposable local PostgreSQL not configured; set PHASE25_PG_URL and PHASE25_PG_MODULE.";
} else {
  pg = require(process.env.PHASE25_PG_MODULE);
}

const read = (name) => fs.readFileSync(path.join(__dirname, "..", "..", "scripts", name), "utf8");
const BASELINE = [...INSTALLED_MIGRATIONS, "20261023-phase-b2-records.sql"];
const CALL = "public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)";
const REQUEUE = "public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)";
const CANCEL = "public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)";
const HELPER = "public.qms_resolve_doctor_counter(text)";
const C1 = { name: "C1", preflight: "20261025-c1-preflight.sql", migration: "20261025-c1-atomic-call.sql",
  verify: "20261025-c1-verify.sql", rollback: "20261025-c1-rollback.sql", preflightRows: 19, verifyRows: 14,
  functions: { [CALL]: true } };
const F5 = { name: "F5", preflight: "20261025-f5-preflight.sql", migration: "20261022-f5-requeue-terminal-recovery.sql",
  verify: "20261025-f5-verify.sql", rollback: "20261025-f5-rollback.sql", preflightRows: 22, verifyRows: 17,
  functions: { [REQUEUE]: true } };
const W1 = { name: "W1", preflight: "20261025-w1-preflight.sql", migration: "20261025-w1-atomic-cancel.sql",
  verify: "20261025-w1-verify.sql", rollback: "20261025-w1-rollback.sql", preflightRows: 28, verifyRows: null,
  functions: { [CANCEL]: true, [HELPER]: false } };
const SEQUENCE = [C1, F5, W1];
const CANCEL_MIGRATION_REQUIRED = /needs the W1 database migration/;

// Synthetic accounts. Not the demonstration credentials; they exist only in the disposable database.
const ACCOUNTS = {
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"],
  frontdesk: ["admin", null], superadmin: ["superadmin", null]
};
const password = (idNum) => `synthetic-${idNum}-password`;

async function assertDisposableTarget(client) {
  const url = new URL(TARGET);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "PHASE25_PG_URL must be a loopback address");
  assert.ok(!/supabase/i.test(TARGET), "Supabase targets are never allowed");
  const { rows: [server] } = await client.query(`SELECT current_setting('cluster_name') AS cluster,
    host(inet_server_addr()) AS address, current_setting('listen_addresses') AS listen,
    current_setting('server_version_num')::int AS version_num, current_database() AS database`);
  assert.equal(server.cluster, CLUSTER, "unexpected cluster_name: not the disposable test cluster");
  assert.equal(server.address, "127.0.0.1");
  assert.equal(server.listen, "127.0.0.1", "the test server must listen on loopback only");
  assert.ok(server.version_num >= 170000, "PostgreSQL 17 or later is required");
  return server;
}

let admin;
let seedSql;
const databases = [];

async function startCluster() {
  admin = new pg.Client({ connectionString: TARGET, application_name: "c1f5w1-admin" });
  await admin.connect();
  await assertDisposableTarget(admin);
  // Supabase-like cluster roles: the installer "postgres" is not a superuser and owns the tables.
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$`);
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  seedSql = `
    INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
      ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');
    INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`;
}

async function stopCluster() {
  for (const db of databases) {
    await db.pool.end().catch(() => {});
    await db.observer.end().catch(() => {});
    await db.setup.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`);
  }
  if (admin) await admin.end();
}

// A fresh database in the development project's reported state plus `migrations`.
async function createDatabase(prefix, migrations = []) {
  const name = `${prefix}_${Date.now()}_${randomBytes(3).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name} OWNER postgres TEMPLATE template0`);
  const url = new URL(TARGET); url.pathname = `/${name}`;
  const connect = async (applicationName) => {
    const client = new pg.Client({ connectionString: url.toString(), application_name: applicationName });
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    return client;
  };
  const setup = await connect(`${prefix}-installer`);
  assert.equal((await assertDisposableTarget(setup)).database, name);
  await setup.query("SET ROLE postgres");
  await setup.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await setup.query(liveKnownSchema);
  for (const script of BASELINE) await setup.query(read(script));
  await setup.query(seedSql);
  for (const script of migrations) await setup.query(read(script));
  const observer = await connect(`${prefix}-observer`);
  // The backend's connection: PostgREST runs requests as service_role in UTC.
  const pool = new pg.Pool({ connectionString: url.toString(), max: 16, application_name: `${prefix}-backend` });
  pool.on("connect", (client) => { client.query("SET ROLE service_role; SET TIME ZONE 'UTC'").catch(() => {}); });
  const db = { name, url: url.toString(), setup, observer, pool, connect };
  databases.push(db);
  return db;
}

// Every row of a multi-statement script's final tabular check result.
async function scriptResults(client, script) {
  return [].concat(await client.query(read(script))).filter((result) => result.rows?.length);
}
async function runChecks(client, step, kind) {
  const results = await scriptResults(client, step[kind]);
  if (kind === "verify" && step.verifyRows === null) {
    assert.deepEqual(results.at(-1).rows, [{ result: `${step.name} verification passed` }]);
    return results;
  }
  const rows = results.filter((result) => "passed" in result.rows[0]).at(-1).rows;
  assert.equal(rows.length, kind === "preflight" ? step.preflightRows : step.verifyRows, `${step[kind]} row count`);
  assert.deepEqual(rows.filter((row) => !row.passed).map((row) => `${row.position} ${row.check_name}: ${row.actual}`), []);
  assert.ok(rows.every((row) => row.all_pass === true && Number(row.failed_count) === 0));
  return results;
}

async function installStep(db, step) {
  await runChecks(db.setup, step, "preflight");
  await db.setup.query(read(step.migration));
  await runChecks(db.setup, step, "verify");
}

async function functionPrivileges(db, signature) {
  const { rows: [row] } = await db.observer.query(`SELECT
      has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated,
      has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_role,
      EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = $1::regprocedure))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public,
      pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = $1::regprocedure)) AS owner`, [signature]);
  return row;
}
const installed = async (db, signature) =>
  (await db.observer.query("SELECT to_regprocedure($1) IS NOT NULL AS present", [signature])).rows[0].present;

// Patient/counter invariants; each count must be 0 in every consistent state.
async function violations(db) {
  const { rows: [row] } = await db.observer.query(`SELECT
    (SELECT count(*) FROM public.counters c JOIN public.patients p ON p.id = c.current_patient_id
      WHERE p.status::text <> 'serving')::int AS pointer_to_inactive_visit,
    (SELECT count(*) FROM public.counters c JOIN public.patients p ON p.id = c.current_patient_id
      WHERE p.counter_id IS DISTINCT FROM c.id_num)::int AS pointer_to_other_doctors_visit,
    (SELECT count(*) FROM public.patients p WHERE p.status::text = 'serving' AND NOT EXISTS (
      SELECT 1 FROM public.counters c WHERE c.current_patient_id = p.id AND c.id_num = p.counter_id))::int AS serving_without_pointer,
    (SELECT count(*) FROM (SELECT current_patient_id FROM public.counters WHERE current_patient_id IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1) d)::int AS visit_with_two_pointers,
    (SELECT count(*) FROM (SELECT counter_id FROM public.patients WHERE status::text = 'serving'
      GROUP BY 1 HAVING count(*) > 1) d)::int AS doctor_serving_twice`);
  return row;
}
async function assertConsistent(db) {
  assert.deepEqual(await violations(db), {
    pointer_to_inactive_visit: 0, pointer_to_other_doctors_visit: 0, serving_without_pointer: 0,
    visit_with_two_pointers: 0, doctor_serving_twice: 0
  });
}

const one = async (db, sql, values) => (await db.observer.query(sql, values)).rows[0]?.value;
const patient = (db, id) => one(db, "SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id]);
async function pointers(db) {
  const { rows } = await db.observer.query("SELECT id_num, current_patient_id FROM public.counters ORDER BY id");
  return Object.fromEntries(rows.map((row) => [row.id_num, row.current_patient_id == null ? null : Number(row.current_patient_id)]));
}
// Patients, counters, accounts and sessions as stored (used to prove "nothing changed").
const snapshot = (db) => one(db, `SELECT json_build_object(
    'patients', (SELECT json_agg(row_to_json(p) ORDER BY p.id) FROM public.patients p),
    'counters', (SELECT json_agg(row_to_json(c) ORDER BY c.id) FROM public.counters c),
    'users', (SELECT json_agg(row_to_json(u) ORDER BY u.id_num) FROM public.users u),
    'sessions', (SELECT json_agg(row_to_json(s) ORDER BY s.session_id) FROM public.staff_auth_sessions s)) AS value`);

async function resetQueue(db) {
  await db.observer.query(`UPDATE public.counters SET current_patient_id = NULL, is_online = true;
    DELETE FROM public.patients;`);
}

// Holds every counter row lock, as an in-flight id-ordered transaction would.
async function holdCounters(db) {
  const client = await db.connect("c1f5w1-blocker");
  await client.query("BEGIN");
  await client.query("SELECT id FROM public.counters ORDER BY id FOR UPDATE");
  return { release: async () => { await client.query("COMMIT"); await client.end(); } };
}
async function waitForLockWaiters(db, count) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const waiting = Number(await one(db, `SELECT count(*) AS value FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`));
    if (waiting >= count) return;
    if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A backend instance with every database request logged; `pause` may hold a request.
async function backend(db, { pause, clockOffsetMs, doctorDispatchMode, envOverrides } = {}) {
  const log = [];
  const h = createPgBackendHarness(db.pool, {
    onRequest: async (request) => { log.push(request); if (pause) await pause(request); }, clockOffsetMs, doctorDispatchMode, envOverrides
  });
  h.log = log;
  h.rpcs = () => log.filter((entry) => entry.kind === "rpc").map((entry) => entry.name);
  h.tableWrites = (table) => log.filter((entry) => entry.kind === "table" && entry.table === table && entry.action !== "select");
  return h;
}
async function signInAll(h) {
  const tokens = {};
  for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  return tokens;
}
const post = (h, token, route, body) => h.request("POST", route, { token, body });

async function register(h, db, token, { name, service = "consultation", flags = [], mobile = null }) {
  const response = await post(h, token, "/queue", { fullName: name, service_type: service, mobile_number: mobile, vulnerabilityFlags: flags });
  assert.equal(response.status, 200, response.body?.message);
  return Number(await one(db, "SELECT id AS value FROM public.patients WHERE queue_number = $1", [response.body.queue_number]));
}
function expectStatus(response, status, pattern) {
  assert.equal(response.status, status, `${response.status} ${response.body?.message}`);
  if (pattern) assert.match(response.body.message, pattern);
}
// Side effects that must only follow a committed transition.
const effects = (h, id) => ({
  sms: h.sms.filter((entry) => entry.type === "called").length,
  awaiting: h.settings.isAwaitingAccept(id),
  voice: h.settings.getVoiceAnnouncementEvents().filter((event) => Number(event.patient_id) === id).length
});

module.exports = {
  unavailable, startCluster, stopCluster, SEQUENCE, C1, F5, W1, CALL, REQUEUE, CANCEL, HELPER, CANCEL_MIGRATION_REQUIRED, ACCOUNTS, read,
  createDatabase, scriptResults, runChecks, installStep, functionPrivileges, installed, violations, assertConsistent,
  one, patient, pointers, snapshot, resetQueue, holdCounters, waitForLockWaiters, backend, signInAll, post, register,
  expectStatus, effects
};
