const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

function loadEnvConfig(values) {
  const filename = path.resolve(__dirname, "../src/config/env.js");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    __dirname: path.dirname(filename), module,
    process: { env: { JWT_SECRET: crypto.randomBytes(48).toString("base64url"), ...values } },
    require: (name) => name === "path" ? path : { config() {} }
  }, { filename });
  return module.exports;
}

test("FRONTEND_URL accepts several sites and ignores trailing slashes", () => {
  const { frontendUrls } = loadEnvConfig({ FRONTEND_URL: "https://clinic.example.org/, https://other.example.org" });
  assert.deepEqual([...frontendUrls], ["https://clinic.example.org", "https://other.example.org"]);
});

test("a production backend refuses to start without Supabase instead of using sample accounts", () => {
  for (const database of [{}, { SUPABASE_URL: "https://isolated-test.invalid" }, { SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key" }]) {
    assert.throws(() => loadEnvConfig({ NODE_ENV: "production", ...database }), { code: "MISSING_DATABASE_CONFIGURATION" });
  }
  const configured = { NODE_ENV: "production", SUPABASE_URL: "https://isolated-test.invalid", SUPABASE_SERVICE_ROLE_KEY: "isolated-test-key" };
  assert.equal(loadEnvConfig(configured).isProduction, true);
  assert.equal(loadEnvConfig({}).isProduction, false);
});

test("backend configuration loads backend/.env regardless of the launch directory", () => {
  // A7: the configuration requires a generated secret, so the test supplies one.
  const isolatedSecret = crypto.randomBytes(48).toString("base64url");
  const filename = path.resolve(__dirname, "../src/config/env.js");
  const expectedPath = path.resolve(__dirname, "../.env");
  for (const launchDirectory of [path.resolve(__dirname, "../.."), path.resolve(__dirname, ".."), path.resolve(__dirname, "../../frontend")]) {
    const processState = { cwd: () => launchDirectory, env: {} };
    let requestedPath;
    const dotenv = {
      config({ path: configPath }) {
        requestedPath = configPath;
        // Isolate configuration loading from actual credentials on disk.
        if (configPath === expectedPath) processState.env.JWT_SECRET = isolatedSecret;
      }
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      __dirname: path.dirname(filename), module, process: processState,
      require: (name) => name === "path" ? path : dotenv
    }, { filename });
    assert.equal(requestedPath, expectedPath, launchDirectory);
    assert.equal(module.exports.jwtSecret, isolatedSecret, launchDirectory);
  }
});
