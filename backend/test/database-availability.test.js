const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");

const registration = { idNum: "Isolated availability patient", serviceType: "checkup", vulnerabilityFlags: [] };

for (const table of ["display_settings", "counters", "patients", "users"]) {
  for (const transportThrows of [false, true]) {
    test(`configured Supabase ${table} ${transportThrows ? "transport" : "read"} outage returns 503 and recovers without hiding patients`, async () => {
      const h = createHarness();
      const patient = await h.service.createQueueEntry(registration);
      const before = clone(h.database.patients);
      h.database.beforeQuery = (query) => {
        if (query.table !== table) return;
        if (transportThrows) throw new Error("fetch failed (isolated outage)");
        return { data: null, error: { code: "XX000", message: "isolated database outage" } };
      };
      const read = table === "users" ? () => h.service.getUsers() : () => h.service.getDisplayData();
      await assert.rejects(read(), (error) => error.statusCode === 503);
      assert.equal(h.service.getQueueStorageMode(), "supabase");
      assert.deepEqual(clone(h.database.patients), before);
      h.database.beforeQuery = null;
      const recovered = await h.service.getQueueOverview();
      assert.equal(recovered.storage_mode, "supabase");
      assert.equal(recovered.patients.length, 1);
      assert.equal(recovered.patients[0].id, patient.id);
    });
  }
}

test("configured database outage rejects registration and login without using local patients or accounts", async () => {
  const h = createHarness();
  h.database.beforeQuery = () => ({ data: null, error: { message: "fetch failed (isolated outage)" } });
  const registered = await h.request("POST", "/queue/website", { fullName: registration.idNum, serviceType: registration.serviceType });
  assert.equal(registered.status, 503);
  const login = await h.request("POST", "/auth/login", { id_num: "frontdesk", password: "isolated-password" });
  assert.equal(login.status, 503);
  assert.equal(h.service.getQueueStorageMode(), "supabase");
  assert.equal(h.database.patients.length, 0);
  h.database.beforeQuery = null;
  assert.equal((await h.service.getQueueOverview()).patients.length, 0);
});

test("a statistics outage after a committed registration retains one successful persisted patient", async () => {
  const h = createHarness();
  h.database.beforeQuery = (query) => {
    if (query.table === "patients" && query.action === "select" && query.columns === "*") {
      return { data: null, error: { message: "fetch failed (isolated statistics outage)" } };
    }
  };
  const patient = await h.service.createQueueEntry(registration);
  assert.equal(h.service.getQueueStorageMode(), "supabase");
  assert.equal(h.database.patients.length, 1);
  assert.equal(h.database.patients[0].id, patient.id);
  h.database.beforeQuery = null;
  assert.equal((await h.service.getQueueOverview()).patients.length, 1);
});

test("a failed cancellation reports an error and retains database mode, the patient and the persisted pointer", async () => {
  const h = createHarness();
  const patient = await h.service.createQueueEntry(registration);
  await h.service.callPatient(patient.id, "Doctor 1");
  const before = JSON.parse(JSON.stringify(h.database.patients[0]));
  // W1: the patient and its counter change in one RPC, so an outage leaves both as they were.
  h.database.beforeRpc = (name) => {
    if (name === "cancel_patient_visit") return { data: null, error: { message: "fetch failed (isolated cancellation outage)" } };
  };
  const cancelled = await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Isolated cancellation" });
  assert.equal(cancelled.status, 503);
  assert.equal(h.service.getQueueStorageMode(), "supabase");
  assert.deepEqual(h.database.patients[0], before);
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
});

test("missing Supabase configuration retains the temporary local development workflow", async () => {
  const h = createHarness({ localFallback: true });
  await h.initialize();
  const patient = await h.service.createQueueEntry(registration);
  const overview = await h.service.getQueueOverview();
  assert.equal(overview.storage_mode, "local_fallback");
  assert.equal(overview.patients[0].id, patient.id);
  assert.equal(h.database.patients.length, 0);
});
