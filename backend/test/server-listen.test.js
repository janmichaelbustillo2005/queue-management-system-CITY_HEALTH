const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

test("an occupied port reports listen failure without success logs or database seeding", { timeout: 15000 }, async () => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "0.0.0.0", resolve);
  });
  const port = occupied.address().port;
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "city-health-listen-test-"));
  const fixturePath = path.join(fixtureDirectory, "isolated-supabase.cjs");
  // The child uses the real backend entry point and Express. Replace only its
  // Supabase client: even a regression must never contact an external database.
  fs.writeFileSync(fixturePath, `
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "@supabase/supabase-js") {
        return { createClient: () => ({ from: () => {
          console.error("UNEXPECTED_DATABASE_ACCESS");
          throw new Error("Test forbids database access");
        } }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  `);
  let child;
  let timeout;
  try {
    child = spawn(process.execPath, ["--require", fixturePath, path.resolve(__dirname, "../src/index.js")], {
      // This temporary working directory contains no .env file. Whitelist the
      // child's environment so actual Supabase credentials cannot be inherited.
      cwd: fixtureDirectory,
      env: {
        SystemRoot: process.env.SystemRoot || "",
        WINDIR: process.env.WINDIR || "",
        PORT: String(port),
        SUPABASE_URL: "https://isolated-test.invalid",
        SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key",
        // A7: startup requires a generated secret; never the developer's own.
        JWT_SECRET: crypto.randomBytes(48).toString("base64url")
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Backend child did not exit after its listen failure"));
      }, 10000);
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 1);
    assert.match(stderr, new RegExp(`Queue backend could not listen on port ${port}: EADDRINUSE`));
    assert.doesNotMatch(stdout, /Queue backend listening|Counters seeded successfully/);
    assert.doesNotMatch(stdout + stderr, /UNEXPECTED_DATABASE_ACCESS|Error seeding counters/);
  } finally {
    clearTimeout(timeout);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise((resolve) => occupied.close(resolve));
    fs.unlinkSync(fixturePath);
    fs.rmdirSync(fixtureDirectory);
  }
});
