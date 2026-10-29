// D1: DOCTOR_DISPATCH_MODE is read once at startup. The default keeps the service-routed
// workflow; only "shared" enables the provisional shared queue; anything else stops the backend.
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

test("the dispatch mode defaults to the existing service routing", () => {
  assert.equal(loadEnv(undefined).doctorDispatchMode, "service");
  assert.equal(loadEnv("").doctorDispatchMode, "service");
  assert.equal(loadEnv("  ").doctorDispatchMode, "service");
});

test("shared and service are accepted in any case", () => {
  assert.equal(loadEnv("shared").doctorDispatchMode, "shared");
  assert.equal(loadEnv(" Shared ").doctorDispatchMode, "shared");
  assert.equal(loadEnv("SERVICE").doctorDispatchMode, "service");
});

test("an unknown dispatch mode stops the backend instead of guessing a policy", () => {
  for (const value of ["auto", "separate", "flexible", "doctor-pickup"]) {
    assert.throws(() => loadEnv(value), (error) => error.code === "INVALID_DOCTOR_DISPATCH_MODE" && /service or shared/.test(error.message));
  }
});
