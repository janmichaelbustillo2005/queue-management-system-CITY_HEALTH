// A7: JWT_SECRET is required and validated at startup; there is no built-in fallback.
// Configuration is loaded from the real config/env.js with stubbed dotenv, and tokens run
// through the real login route, JWT middleware and presenceService over synthetic data.
// Every secret here is generated per run. No .env, network, Supabase or real accounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const jwt = require("jsonwebtoken");
const { createRealAuthHarness } = require("./helpers/realAuthRouteHarness");

const ENV_FILE = path.resolve(__dirname, "../src/config/env.js");
const generated = (bytes = 48) => crypto.randomBytes(bytes).toString("base64url");

// Loads the real config module; dotenv is stubbed so backend/.env is never read.
function loadConfig(variables) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(ENV_FILE, "utf8"), {
    __dirname: path.dirname(ENV_FILE), module, process: { env: { ...variables }, platform: process.platform },
    require: (name) => (name === "path" ? path : { config() {} })
  }, { filename: ENV_FILE });
  return module.exports;
}

function assertRejected(value, reason) {
  const variables = value === undefined ? {} : { JWT_SECRET: value };
  assert.throws(() => loadConfig(variables), (error) => {
    assert.equal(error.code, "INVALID_JWT_SECRET");
    assert.match(error.message, /JWT_SECRET/);
    assert.match(error.message, reason);
    // Short dictionary samples ("secret") occur in the guidance text itself; every longer
    // or generated value, including "change-me" and "default_secret", must be absent.
    if (typeof value === "string" && value.length >= 9) assert.ok(!error.message.includes(value), "the secret value is never echoed");
    return true;
  });
}

test("a missing JWT_SECRET is rejected; there is no fallback", () => {
  assertRejected(undefined, /missing or empty/);
});

test("an empty or whitespace-only JWT_SECRET is rejected", () => {
  for (const value of ["", " ", "\t\n"]) assertRejected(value, /missing or empty/);
});

test("the former fallback and sample placeholders are rejected regardless of case or padding", () => {
  for (const value of ["default_secret", "change-me", "CHANGE-ME", "changeme", "Change_Me", "replace-me",
    "your-jwt-secret", "secret", "jwtsecret", "example", "password", "test",
    `change-me-${generated()}`, `${generated(24)}default_secret${generated(24)}`]) {
    assertRejected(value, /sample or placeholder/);
  }
});

test("short, repetitive or whitespace-containing values are rejected without echoing them", () => {
  assertRejected(generated(16), /at least 43 characters/);
  assertRejected("isolated-listen-test-secret", /at least 43 characters/);
  assertRejected("a".repeat(64), /too repetitive/);
  assertRejected("ab12".repeat(16), /too repetitive/);
  assertRejected(`${generated(24)} ${generated(24)}`, /whitespace/);
});

test("independently generated secrets are accepted exactly as configured", () => {
  for (const value of [generated(32), generated(48), crypto.randomBytes(48).toString("base64"), crypto.randomBytes(32).toString("hex")]) {
    assert.equal(loadConfig({ JWT_SECRET: value }).jwtSecret, value);
  }
});

test("the real backend refuses to start with an invalid secret and never prints it", { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "city-health-a7-"));
  const fixture = path.join(directory, "isolated-supabase.cjs");
  fs.writeFileSync(fixture, `
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "@supabase/supabase-js") {
        return { createClient: () => ({ from: () => { console.error("UNEXPECTED_DATABASE_ACCESS"); throw new Error("forbidden"); } }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  `);
  try {
    // An empty value is kept as-is by dotenv, so backend/.env cannot supply a secret here.
    for (const value of ["", generated(12), "change-me"]) {
      const child = spawn(process.execPath, ["--require", fixture, path.resolve(__dirname, "../src/index.js")], {
        cwd: directory,
        env: {
          SystemRoot: process.env.SystemRoot || "", WINDIR: process.env.WINDIR || "", PORT: "0",
          SUPABASE_URL: "https://isolated-test.invalid", SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key",
          VOICE_SERVICE_AUTOSTART: "0", JWT_SECRET: value
        },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error("backend did not exit")); }, 15000);
        child.once("close", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.notEqual(code, 0);
      assert.match(output, /Invalid JWT_SECRET in backend\/\.env/);
      assert.doesNotMatch(output, /Queue backend listening|Counters seeded|UNEXPECTED_DATABASE_ACCESS/);
      if (value) assert.ok(!output.includes(value), "startup output never contains the secret");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Token behavior with the validated configuration.
// ---------------------------------------------------------------------------
const ACCOUNTS = {
  superadmin: { role: "superadmin", doctor_name: null },
  admin1: { role: "admin", doctor_name: "Doctor 1" },
  admin2: { role: "admin", doctor_name: "Doctor 2" },
  admin3: { role: "admin", doctor_name: "Doctor 3" },
  frontdesk: { role: "admin", doctor_name: null },
  frontdesk2: { role: "admin", doctor_name: "Front Desk" }
};

function configuredHarness() {
  const config = loadConfig({ JWT_SECRET: generated() });
  const h = createRealAuthHarness({ env: config });
  const at = (offset) => new Date(h.clock.now - offset).toISOString();
  const base = { priority_score: 1, vulnerability_flags: [], called_at: null, consultation_started_at: null, completed_at: null, counter_id: null, reason: null };
  h.database.patients.push(
    { ...base, id: 1, visit_state_revision: crypto.randomUUID(), queue_number: "GP-001", id_num: "Synthetic GP", service_type: "consultation", status: "waiting", created_at: at(60000) },
    { ...base, id: 2, visit_state_revision: crypto.randomUUID(), queue_number: "OB-001", id_num: "Synthetic OB", service_type: "prenatal", status: "waiting", created_at: at(50000) },
    { ...base, id: 3, visit_state_revision: crypto.randomUUID(), queue_number: "FP-001", id_num: "Synthetic FP", service_type: "family_planning", status: "waiting", created_at: at(40000) }
  );
  const login = (id) => h.request("POST", "/auth/login", { body: { id_num: id, password: `synthetic-${id}-password` } });
  return { h, config, login };
}

test("Superadmin, Doctors 1–3 and Frontdesk log in and receive tokens signed only with the configured secret", async () => {
  const { h, config, login } = configuredHarness();
  const records = JSON.stringify([h.database.patients, h.database.counters]);
  for (const [id, expected] of Object.entries(ACCOUNTS)) {
    const response = await login(id);
    assert.equal(response.status, 200, `${id}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(response.body.user, { id_num: id, ...expected });
    const { header, payload } = jwt.decode(response.body.token, { complete: true });
    assert.equal(header.alg, "HS256");
    const claims = jwt.verify(response.body.token, config.jwtSecret, { algorithms: ["HS256"] });
    assert.equal(claims.id_num, id);
    assert.equal(claims.role, expected.role);
    assert.equal(claims.doctor_name, expected.doctor_name);
    assert.equal(payload.auth_revision, undefined);
    assert.ok(h.sessions.has(claims.jti), "a persisted session backs the token");
    for (const previous of ["default_secret", "change-me"]) {
      assert.throws(() => jwt.verify(response.body.token, previous), /invalid signature/);
    }
    assert.equal((await h.request("GET", "/queue", { token: response.body.token })).status, 200);
  }
  assert.equal((await login("admin1").then(() => h.request("POST", "/auth/login", { body: { id_num: "admin1", password: "wrong" } }))).status, 401);
  assert.equal(JSON.stringify([h.database.patients, h.database.counters]), records, "authentication never writes patients or counters");
});

test("invalid, previously-signed, unsigned and expired tokens are rejected with the existing contract", async () => {
  const { h, login } = configuredHarness();
  const valid = jwt.decode((await login("superadmin")).body.token);
  const claims = { id_num: "superadmin", role: "superadmin", doctor_name: null, jti: valid.jti };
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  for (const [label, token] of [
    ["garbage", "not-a-jwt"],
    ["signed with the old fallback", h.sign(claims, "default_secret")],
    ["signed with the .env.example placeholder", h.sign(claims, "change-me")],
    ["signed with another generated secret", h.sign(claims, generated())],
    ["alg none", unsigned],
    ["expired", h.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 30 })]
  ]) {
    const response = await h.request("GET", "/queue", { token });
    assert.equal(response.status, 403, label);
    assert.equal(response.body.message, "Invalid or expired token", label);
  }
  assert.equal((await h.request("GET", "/queue", {})).status, 401);
});

test("a revoked persisted session is rejected after logout while the patient record is unchanged", async () => {
  const { h, login } = configuredHarness();
  const { token } = (await login("admin1")).body;
  assert.equal((await h.request("GET", "/queue", { token })).status, 200);
  const before = JSON.stringify(h.database.patients);
  assert.equal((await h.request("POST", "/auth/logout", { token })).status, 200);
  const after = await h.request("GET", "/queue", { token });
  assert.equal(after.status, 401);
  assert.match(after.body.message, /expired or was revoked/);
  assert.equal(JSON.stringify(h.database.patients), before);

  const other = (await login("admin1")).body.token;
  assert.equal((await h.request("GET", "/queue", { token: other })).status, 200, "a fresh login works after logout");
});

test("role and doctor assignment are enforced from the persisted account, not from token edits", async () => {
  const { h, login } = configuredHarness();
  const tokens = {};
  for (const id of Object.keys(ACCOUNTS)) tokens[id] = (await login(id)).body.token;

  // S1 setup restriction under the configured secret.
  assert.equal((await h.request("POST", "/setup/counters", { token: tokens.superadmin })).status, 200);
  for (const id of ["admin1", "admin2", "admin3", "frontdesk", "frontdesk2"]) {
    assert.equal((await h.request("POST", "/setup/counters", { token: tokens[id] })).status, 403, id);
  }
  assert.equal((await h.request("POST", "/setup/service-type", { token: tokens.superadmin })).status, 410);

  // A token re-signed with the right secret but edited claims no longer matches its session.
  const doctor2 = jwt.decode(tokens.admin2);
  for (const forged of [{ role: "superadmin", doctor_name: null }, { doctor_name: "Doctor 1" }]) {
    const token = h.sign({ id_num: "admin2", role: "admin", doctor_name: "Doctor 2", jti: doctor2.jti, ...forged });
    assert.equal((await h.request("POST", "/setup/counters", { token })).status, 401);
    assert.equal((await h.request("POST", "/queue/cancel", { token, body: { patient_id: 1, reason: "test" } })).status, 401);
  }

  // R2: doctors act only on their own service; Frontdesk keeps cross-doctor actions.
  assert.equal((await h.request("POST", "/queue/cancel", { token: tokens.admin2, body: { patient_id: 1, reason: "test" } })).status, 403);
  assert.equal((await h.request("POST", "/queue/no-show", { token: tokens.admin3, body: { patient_id: 2 } })).status, 403);
  assert.equal(h.database.patients.every((row) => row.status === "waiting"), true);
  assert.equal((await h.request("POST", "/queue/cancel", { token: tokens.admin3, body: { patient_id: 3, reason: "Synthetic own patient" } })).status, 200);
  assert.equal((await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: 2, reason: "Synthetic" } })).status, 200);

  // Service-to-doctor mapping: Doctor 1 calls its GP patient; Doctor 2 cannot.
  assert.equal((await h.request("POST", "/queue/call", { token: tokens.admin2, body: { patient_id: 1, counterId: "Doctor 2" } })).status, 400);
  assert.equal((await h.request("POST", "/queue/call", { token: tokens.admin1, body: { patient_id: 1 } })).status, 200);
  assert.equal(h.database.patients.find((row) => row.id === 1).counter_id, "Doctor 1");

  // R1: the anonymous display still publishes no patient names.
  assert.doesNotMatch(JSON.stringify((await h.request("GET", "/display")).body), /Synthetic (GP|OB|FP)/);
});
