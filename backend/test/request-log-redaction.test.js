const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { redactQueryValues } = require("../src/lib/requestLog");

test("query values are redacted while the path and parameter names stay", () => {
  assert.equal(redactQueryValues("/api/records/patients?search=Juan%20Dela%20Cruz&limit=20"),
    "/api/records/patients?search=[redacted]&limit=[redacted]");
  assert.equal(redactQueryValues("/api/records/activity?account=admin1&limit=20&page=2"),
    "/api/records/activity?account=[redacted]&limit=[redacted]&page=[redacted]");
  assert.equal(redactQueryValues("/api/geocode?q=Purok+3,+Cabadbaran"), "/api/geocode?q=[redacted]");
  assert.equal(redactQueryValues("/api/records/patients?visit=42#ticket"), "/api/records/patients?visit=[redacted]");
  assert.equal(redactQueryValues("/api/records/patients?search=a&&flag"), "/api/records/patients?search=[redacted]&flag=[redacted]");
});

test("URLs without a query, an empty query or no value are logged unchanged or emptied", () => {
  assert.equal(redactQueryValues("/api/health"), "/api/health");
  assert.equal(redactQueryValues("/api/users/admin1"), "/api/users/admin1");
  assert.equal(redactQueryValues("/api/records/patients?"), "/api/records/patients");
  assert.equal(redactQueryValues(undefined), "");
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("the real backend request logger never writes Records search terms", { timeout: 20000 }, async () => {
  const port = await freePort();
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "city-health-log-redaction-"));
  const fixturePath = path.join(fixtureDirectory, "isolated.cjs");
  // Real entry point and Express. Supabase is replaced and dotenv disabled, so neither a
  // database nor backend/.env can be reached; the requests below need no database.
  fs.writeFileSync(fixturePath, `
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "dotenv") return { config: () => ({ parsed: {} }) };
      if (request === "@supabase/supabase-js") {
        const denied = () => { throw new Error("Test forbids database access"); };
        return { createClient: () => ({ from: denied, rpc: denied }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  `);
  const child = spawn(process.execPath, ["--require", fixturePath, path.resolve(__dirname, "../src/index.js")], {
    cwd: fixtureDirectory,
    env: {
      SystemRoot: process.env.SystemRoot || "", WINDIR: process.env.WINDIR || "",
      PORT: String(port), SUPABASE_URL: "https://isolated-test.invalid", SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key",
      JWT_SECRET: crypto.randomBytes(48).toString("base64url"), VOICE_SERVICE_AUTOSTART: "0"
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let stdout = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stdout += data; });
  try {
    const deadline = Date.now() + 10000;
    while (!/Queue backend listening/.test(stdout)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Backend did not start:\n${stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const base = `http://127.0.0.1:${port}/api`;
    const records = await fetch(`${base}/records/patients?search=${encodeURIComponent("Juan Dela Cruz")}&date=2026-10-23&limit=20`);
    assert.equal(records.status, 401, "unauthenticated: rejected before any database access");
    assert.equal((await fetch(`${base}/records/activity?account=admin1&page=1`)).status, 401);
    await fetch(`${base}/no-such-route?q=${encodeURIComponent("Purok 3, Cabadbaran")}`);
    await fetch(`${base}/health`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(stdout, /\] GET \/api\/records\/patients\?search=\[redacted\]&date=\[redacted\]&limit=\[redacted\]\n/);
    assert.match(stdout, /\] GET \/api\/records\/activity\?account=\[redacted\]&page=\[redacted\]\n/);
    assert.match(stdout, /\] GET \/api\/no-such-route\?q=\[redacted\]\n/);
    assert.match(stdout, /\] GET \/api\/health\n/);
    assert.doesNotMatch(stdout, /Juan|Dela|Cruz|Purok|Cabadbaran|2026-10-23&|account=admin1/);
  } finally {
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("close", resolve)));
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
