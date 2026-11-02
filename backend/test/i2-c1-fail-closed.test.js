// I2 Finding 8: when call_patient_visit (C1) cannot be used, Call refuses (503) and changes
// nothing, unless ALLOW_LEGACY_TWO_STEP_CALL opts a database that never had C1 back into the
// older two-statement Call. 42703 (undefined column) is never read as "function missing".
// Synthetic data only. PostgreSQL behavior: i2-c1-fail-closed-postgres.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const C1_REQUIRED = /atomic C1 database function/;

function loadEnv(values) {
  const filename = path.resolve(__dirname, "../src/config/env.js");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    __dirname: path.dirname(filename), module,
    process: { env: { JWT_SECRET: crypto.randomBytes(48).toString("base64url"), ...values }, platform: process.platform },
    require: (name) => name === "path" ? path : { config() {} }
  }, { filename });
  return module.exports;
}

async function waitingVisit(options = {}) {
  const database = createDatabase();
  const h = createHarness({ database, clock: { now: Date.parse("2026-10-29T02:00:00.000Z") }, ...options });
  const patient = await h.service.createQueueEntry({ idNum: "Synthetic Finding8", serviceType: "consultation", mobileNumber: "09170000000" });
  h.advance();
  return { h, database, patient };
}

function assertUnchanged(h, before, id) {
  assert.deepEqual(clone(h.database.patients), before.patients, "no patient row changed");
  assert.deepEqual(clone(h.database.counters), before.counters, "no counter changed");
  assert.equal(h.settings.isAwaitingAccept(id), false, "no pending acceptance");
  assert.equal(h.notifications.filter((entry) => entry.type === "called").length, 0, "no SMS");
  assert.equal(h.settings.getVoiceAnnouncementEvents().length, 0, "no voice event");
}

test("ALLOW_LEGACY_TWO_STEP_CALL is off unless explicitly enabled", () => {
  assert.equal(loadEnv({}).allowLegacyTwoStepCall, false);
  for (const value of ["1", "true", "YES", " on "]) assert.equal(loadEnv({ ALLOW_LEGACY_TWO_STEP_CALL: value }).allowLegacyTwoStepCall, true, value);
  for (const value of ["", "0", "false", "no", "off", "legacy"]) assert.equal(loadEnv({ ALLOW_LEGACY_TWO_STEP_CALL: value }).allowLegacyTwoStepCall, false, value);
});

for (const code of ["PGRST202", "PGRST204", "42883"]) {
  test(`without the opt-in, C1 answering ${code} refuses the Call (503) and changes nothing`, async () => {
    const { h, patient } = await waitingVisit({ allowLegacyTwoStepCall: false });
    h.database.beforeRpc = (name) => name === "call_patient_visit"
      ? { data: null, error: { code, message: "Could not find the function public.call_patient_visit" } } : null;
    const before = { patients: clone(h.database.patients), counters: clone(h.database.counters) };
    await assert.rejects(h.service.callPatient(patient.id, "Doctor 1", FRONTDESK), (error) => error.statusCode === 503 && C1_REQUIRED.test(error.message));
    assertUnchanged(h, before, patient.id);
  });
}

test("42703 from inside C1 is an error, not a missing function: even with the opt-in nothing falls back", async () => {
  for (const allowLegacyTwoStepCall of [false, true]) {
    const { h, patient } = await waitingVisit({ allowLegacyTwoStepCall });
    h.database.beforeRpc = (name) => name === "call_patient_visit"
      ? { data: null, error: { code: "42703", message: "column \"x\" does not exist" } } : null;
    const before = { patients: clone(h.database.patients), counters: clone(h.database.counters) };
    await assert.rejects(h.service.callPatient(patient.id, "Doctor 1", FRONTDESK), (error) => error.statusCode === 503 && !C1_REQUIRED.test(error.message), String(allowLegacyTwoStepCall));
    assertUnchanged(h, before, patient.id);
  }
});

test("without the opt-in, a visit with no state revision (C1 cannot be used) is refused, not called in two steps", async () => {
  const { h, patient } = await waitingVisit({ allowLegacyTwoStepCall: false });
  h.database.patients.find((row) => row.id === patient.id).visit_state_revision = null;
  const before = { patients: clone(h.database.patients), counters: clone(h.database.counters) };
  await assert.rejects(h.service.callPatient(patient.id, "Doctor 1", FRONTDESK), (error) => error.statusCode === 503 && C1_REQUIRED.test(error.message));
  assertUnchanged(h, before, patient.id);
});

test("with C1 available the opt-in changes nothing: Call is atomic either way", async () => {
  for (const allowLegacyTwoStepCall of [false, true]) {
    const { h, patient } = await waitingVisit({ allowLegacyTwoStepCall });
    h.database.callRpcInstalled = true;
    await h.service.callPatient(patient.id, "Doctor 1", FRONTDESK);
    const row = h.database.patients.find((entry) => entry.id === patient.id);
    assert.equal(row.status, "serving");
    assert.equal(h.database.counters[0].current_patient_id, patient.id);
    assert.equal(h.database.calls.filter((entry) => entry.action === "rpc" && entry.function === "call_patient_visit").length, 1);
  }
});

test("with the opt-in and no C1, the revision-guarded two-step Call still works", async () => {
  const { h, patient } = await waitingVisit({ allowLegacyTwoStepCall: true });
  await h.service.callPatient(patient.id, "Doctor 1", FRONTDESK);
  assert.equal(h.database.patients.find((entry) => entry.id === patient.id).status, "serving");
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
});
