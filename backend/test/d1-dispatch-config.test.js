// DOCTOR_DISPATCH_MODE is read once at startup. Unset means round robin (RR1, the default since
// 2026-11-11); "service" (the former fixed routing) and "shared" (D1) must be chosen explicitly;
// anything else stops the backend.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

function loadEnv(value) {
  const filename = path.resolve(__dirname, "../src/config/env.js");
  const processEnv = { JWT_SECRET: crypto.randomBytes(48).toString("base64url") };
  if (value !== undefined) processEnv.DOCTOR_DISPATCH_MODE = value;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    __dirname: path.dirname(filename), module, process: { env: processEnv, platform: "linux" },
    require: (name) => name === "path" ? path : { config() {} }
  }, { filename });
  return module.exports;
}

test("the dispatch mode defaults to round robin, not the former service routing", () => {
  assert.equal(loadEnv(undefined).doctorDispatchMode, "round_robin");
  assert.equal(loadEnv("").doctorDispatchMode, "round_robin");
  assert.equal(loadEnv("  ").doctorDispatchMode, "round_robin");
});

test("round_robin, shared and service are accepted in any case", () => {
  assert.equal(loadEnv("round_robin").doctorDispatchMode, "round_robin");
  assert.equal(loadEnv(" Round_Robin ").doctorDispatchMode, "round_robin");
  assert.equal(loadEnv("shared").doctorDispatchMode, "shared");
  assert.equal(loadEnv(" Shared ").doctorDispatchMode, "shared");
  assert.equal(loadEnv("SERVICE").doctorDispatchMode, "service");
});

test("an unknown dispatch mode stops the backend instead of guessing a policy", () => {
  for (const value of ["auto", "separate", "flexible", "doctor-pickup"]) {
    assert.throws(() => loadEnv(value), (error) => error.code === "INVALID_DOCTOR_DISPATCH_MODE" && /service or shared/.test(error.message));
  }
});
