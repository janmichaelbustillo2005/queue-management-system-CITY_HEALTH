// ISOLATED TEST BACKEND for browser checks. Runs the REAL Express routes, auth middleware and
// services (queueService, presenceService, settingsService) against a disposable in-memory PGlite
// database. The Supabase client is replaced before any backend module loads, so no request can
// reach a Supabase project. Synthetic accounts and patients only; everything is lost on exit.
//
// Refuses to start when backend/.env exists (it could hold production settings), and binds to
// 127.0.0.1 only. Settings, acceptance and voice files go to EVIDENCE_DIR/runtime-data.
//
// Environment:
//   PHASE2_PGLITE_MODULE  path to an installed @electric-sql/pglite package (required)
//   QMS_SCRIPTS_DIR       folder with the SQL scripts (required; see rr1-wps-a-aging-postgres.test.js)
//   EVIDENCE_DIR          where the synthetic credentials, runtime files and request log go (required)
//   ISOLATED_WPS_AGING    "1" (default) or "0"
//   ISOLATED_PORT         API port, default 4100; ISOLATED_ADMIN_PORT test-control port, default 4199
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const Module = require("node:module");

const backendDir = path.resolve(__dirname, "../..");
const fail = (message) => { console.error(`[isolated] REFUSED: ${message}`); process.exit(1); };

// Optional: node server.js <config.json> supplies the variables above as a JSON object.
if (process.argv[2]) {
  for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(process.argv[2], "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = String(value);
  }
}

// ---- Guards ---------------------------------------------------------------------------------
if (fs.existsSync(path.join(backendDir, ".env"))) fail("backend/.env exists here. Run from a checkout without it.");
for (const name of ["PHASE2_PGLITE_MODULE", "QMS_SCRIPTS_DIR", "EVIDENCE_DIR"]) {
  if (!process.env[name]) fail(`${name} is not set.`);
}
const evidenceDir = path.resolve(process.env.EVIDENCE_DIR);
const port = Number(process.env.ISOLATED_PORT || 4100);
const adminPort = Number(process.env.ISOLATED_ADMIN_PORT || 4199);
const aging = (process.env.ISOLATED_WPS_AGING ?? "1") === "1";

// ---- Backend configuration (set before src/config/env.js is loaded) ---------------------------
Object.assign(process.env, {
  NODE_ENV: "development",
  PORT: String(port),
  // Unreachable on purpose; the client below replaces the Supabase library entirely.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: "isolated-test-not-a-key",
  JWT_SECRET: crypto.randomBytes(48).toString("base64url"),
  DOCTOR_DISPATCH_MODE: "round_robin",
  DISPATCH_SWEEP_SECONDS: "15",
  WPS_AGING: aging ? "1" : "0",
  DATA_DIR: path.join(evidenceDir, "runtime-data"),
  VOICE_SERVICE_AUTOSTART: "0",
  GATEWAY_API_TOKEN: "",
  FRONTEND_URL: "http://localhost:3100,http://127.0.0.1:3100"
});
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { PGlite } = require(process.env.PHASE2_PGLITE_MODULE);
const { liveKnownDatabase, readScript } = require("../helpers/liveKnownSchema");
const { createPgRestClient } = require("../helpers/pgRestClient");

// The disposable database: the development project's known state plus every later script the
// backend uses, in installation order. The patient-records script is a labelled stand-in.
const LATER_SCRIPTS = ["20261023-phase-b2-records.sql", "20261025-c1-atomic-call.sql",
  "20261022-f5-requeue-terminal-recovery.sql", "20261025-w1-atomic-cancel.sql", "20261103-patient-records.sql",
  "add-account-cancellation-requests.sql", "20261110-ar1-staff-archive.sql", "20261111-ep1-staff-display-name.sql",
  "20261109-rr1-round-robin-dispatch.sql", "20261111-fc1-front-desk-confirmation.sql"];
const ACCOUNTS = { superadmin: ["superadmin", null], frontdesk: ["admin", null],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"] };

async function main() {
  const db = await liveKnownDatabase(PGlite);
  for (const script of LATER_SCRIPTS) await db.exec(readScript(script));
  await db.exec("ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'no-show' AFTER 'cancelled';");
  await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");

  const bcrypt = require("bcryptjs");
  const passwords = {};
  for (const [idNum, [role, doctor]] of Object.entries(ACCOUNTS)) {
    passwords[idNum] = `Syn-${crypto.randomBytes(9).toString("base64url")}`;
    await db.query("INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ($1, $2, $3, $4)",
      [idNum, bcrypt.hashSync(passwords[idNum], 8), role, doctor]);
  }
  await db.exec(`INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
    ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');`);
  fs.writeFileSync(path.join(evidenceDir, "synthetic-accounts.local.txt"),
    "Synthetic accounts of the disposable isolated test database (valid only while it runs).\n" +
    Object.entries(passwords).map(([idNum, value]) => `${idNum}\t${value}`).join("\n") + "\n", { mode: 0o600 });

  // Replace the Supabase library for every backend module before any of them loads.
  const supabasePath = require.resolve(path.join(backendDir, "src/lib/supabase.js"));
  const stub = new Module(supabasePath, module);
  stub.filename = supabasePath;
  stub.loaded = true;
  stub.exports = createPgRestClient({ query: (sql, values) => db.query(sql, values) });
  require.cache[supabasePath] = stub;

  const env = require(path.join(backendDir, "src/config/env"));
  if (!/^http:\/\/127\.0\.0\.1:9$/.test(env.supabaseUrl)) fail("SUPABASE_URL is not the isolated placeholder.");
  const express = require("express");
  const cors = require("cors");
  const routes = require(path.join(backendDir, "src/routes"));
  const records = require(path.join(backendDir, "src/routes/records"));
  const { requestDispatch } = require(path.join(backendDir, "src/services/queueService"));

  const requestLog = fs.createWriteStream(path.join(evidenceDir, "logs", "isolated-backend-requests.log"), { flags: "a" });
  const app = express();
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || /^http:\/\/(localhost|127\.0\.0\.1):3100$/.test(origin)), credentials: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    res.on("finish", () => requestLog.write(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode}\n`));
    next();
  });
  app.use("/api/records", records);
  app.use("/api", routes);
  app.use((error, _req, res, _next) => res.status(500).json({ success: false, message: error.message }));
  app.listen(port, "127.0.0.1", () => {
    console.log(`[isolated] API http://127.0.0.1:${port}/api  WPS_AGING=${aging ? "1" : "0"}  database: PGlite in memory`);
    requestDispatch();
    setInterval(() => { requestDispatch(); }, env.dispatchSweepSeconds * 1000).unref();
  });

  // ---- Test control (127.0.0.1 only): synthetic visits and simulated doctor presence --------
  const api = async (method, route, { token, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const simulated = new Map();   // account -> { token, timer }

  async function setPresence(account, on) {
    const current = simulated.get(account);
    if (!on) {
      if (current) { clearInterval(current.timer); await api("POST", "/auth/logout", { token: current.token }); simulated.delete(account); }
      return { account, simulated_presence: false };
    }
    if (current) return { account, simulated_presence: true };
    const login = await api("POST", "/auth/login", { body: { id_num: account, password: passwords[account] } });
    if (login.status !== 200) throw new Error(`login ${account}: ${login.status}`);
    const token = login.body.token;
    const timer = setInterval(() => { api("POST", "/auth/heartbeat", { token }).catch(() => {}); }, 25000);
    simulated.set(account, { token, timer });
    return { account, simulated_presence: true };
  }

  // A synthetic visit already registered, assigned and (optionally) confirmed, backdated by
  // `secondsAgo`. Recorded in the assignment history like a round-robin registration.
  async function addVisit({ ticket, score = 1, flags = [], secondsAgo = 0, doctor = "Doctor 1", confirmed = true, createdAt = null }) {
    const { rows: [row] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score,
        vulnerability_flags, counter_id, created_at, confirmed_at, confirmed_by, source)
      VALUES ($1, $2, 'medical_consultation', 'waiting', $3, $4::jsonb, $5,
        COALESCE($8::timestamptz, clock_timestamp() - ($6 * interval '1 second')),
        CASE WHEN $7 THEN clock_timestamp() END, CASE WHEN $7 THEN 'frontdesk' END, 'isolated-test')
      RETURNING id, queue_number, created_at`,
      [`Synthetic ${ticket}`, ticket, score, JSON.stringify(flags), doctor, secondsAgo, confirmed, createdAt]);
    await db.query(`INSERT INTO public.patient_assignment_history (patient_id, new_doctor, previous_status, new_status, reason, automatic)
      VALUES ($1, $2, 'waiting', 'waiting', 'round_robin_assignment', true)`, [row.id, doctor]);
    return { id: Number(row.id), queue_number: row.queue_number, created_at: row.created_at };
  }

  async function state() {
    const { rows } = await db.query(`SELECT id::int, queue_number, status, priority_score, counter_id, created_at, confirmed_at IS NOT NULL AS confirmed,
        called_at, round(extract(epoch FROM clock_timestamp() - created_at) / 60, 2)::float AS waited_minutes
      FROM public.patients ORDER BY id`);
    const { rows: [rotation] } = await db.query("SELECT last_doctor, rotation_date FROM public.doctor_rotation_state");
    return { wps_aging: aging, visits: rows, rotation, simulated_presence: [...simulated.keys()] };
  }

  const control = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data, null, 2)); };
    try {
      const input = body ? JSON.parse(body) : {};
      if (req.method === "GET" && req.url === "/state") return send(200, await state());
      if (req.method === "POST" && req.url === "/presence") return send(200, await setPresence(input.account, input.on !== false));
      if (req.method === "POST" && req.url === "/visits") {
        const created = [];
        for (const visit of Array.isArray(input) ? input : [input]) created.push(await addVisit(visit));
        await requestDispatch();
        return send(200, created);
      }
      if (req.method === "POST" && req.url === "/sql-check") {
        // Read-only: the database's own aging formula at fixed synthetic instants.
        await db.exec("RESET ROLE");
        try {
          const { rows } = await db.query(`SELECT m AS minutes, public.qms_rr_effective_priority(1, '2026-11-14T10:00:00+08'::timestamptz,
              '2026-11-14T10:00:00+08'::timestamptz + make_interval(mins => m), true) AS regular_effective
            FROM unnest(ARRAY[0, 9, 10, 19, 20, 30]) AS m`);
          return send(200, rows);
        } finally {
          await db.exec("SET ROLE service_role");
        }
      }
      return send(404, { error: "unknown control route" });
    } catch (error) {
      return send(500, { error: error.message });
    }
  });
  control.listen(adminPort, "127.0.0.1", () => console.log(`[isolated] test control http://127.0.0.1:${adminPort} (state, presence, visits, sql-check)`));
}

main().catch((error) => { console.error("[isolated] failed to start:", error); process.exit(1); });
