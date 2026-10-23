// S1: the /setup maintenance endpoints require a verified, persisted Superadmin session.
// Runs the REAL JWT middleware, presenceService and queueService over synthetic data only
// (see helpers/realAuthRouteHarness.js). No .env, network, Supabase or real patients.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRealAuthHarness } = require("./helpers/realAuthRouteHarness");

const REVISION = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function patient(h, id, fields) {
  const at = new Date(h.clock.now - (100 - id) * 1000).toISOString();
  return {
    id, visit_state_revision: REVISION(id), queue_number: `GP-${String(id).padStart(3, "0")}`,
    id_num: `Synthetic Patient ${id}`, mobile_number: "09000000000", service_type: "consultation",
    status: "waiting", priority_score: 1, vulnerability_flags: [], source: "admin", created_at: at,
    called_at: null, consultation_started_at: null, completed_at: null, counter_id: null, reason: null,
    ...fields
  };
}

// Doctor 3's counter is absent so an authorized seed has something to create, and a legacy
// "technical" visit exists so the former rename default would visibly rewrite history.
function fixture() {
  const h = createRealAuthHarness();
  h.database.patients.push(
    patient(h, 1, {}),
    patient(h, 2, { service_type: "prenatal", queue_number: "OB-001" }),
    patient(h, 3, { service_type: "technical", status: "completed", called_at: new Date(h.clock.now).toISOString(),
      completed_at: new Date(h.clock.now).toISOString(), counter_id: "Doctor 1" })
  );
  h.database.counters = h.database.counters.filter((counter) => counter.id_num !== "Doctor 3");
  h.database.counters[1].is_online = false;
  return h;
}

const snapshot = (h) => JSON.parse(JSON.stringify({ patients: h.database.patients, counters: h.database.counters }));

const ROUTES = ["/setup/counters", "/setup/service-type"];
const REJECTED = [
  ["anonymous request", () => ({}), 401],
  ["non-Bearer authorization header", () => ({ authorization: "Basic c3VwZXJhZG1pbjpzdXBlcmFkbWlu" }), 401],
  ["token signed with another secret", (h) => ({ token: h.sign({ id_num: "superadmin", role: "superadmin", doctor_name: null, jti: REVISION(900) }, "attacker-secret") }), 403],
  ["expired JWT", (h) => ({ token: h.sign({ id_num: "superadmin", role: "superadmin", doctor_name: null,
    jti: h.signIn("superadmin").session.session_id, exp: Math.floor(Date.now() / 1000) - 60 }) }), 403],
  ["revoked Superadmin session", (h) => {
    const login = h.signIn("superadmin");
    login.session.revoked_at = new Date().toISOString();
    return { token: login.token };
  }, 401],
  ["Superadmin session expired in storage", (h) => {
    const login = h.signIn("superadmin");
    login.session.expires_at = new Date(Date.now() - 1000).toISOString();
    return { token: login.token };
  }, 401],
  ["Superadmin account deleted after login", (h) => {
    const login = h.signIn("superadmin");
    h.database.users = h.database.users.filter((user) => user.id_num !== "superadmin");
    return { token: login.token };
  }, 401],
  ["Superadmin demoted after login", (h) => {
    const login = h.signIn("superadmin");
    h.database.users.find((user) => user.id_num === "superadmin").role = "admin";
    return { token: login.token };
  }, 401],
  ["Doctor 1", (h) => ({ token: h.signIn("admin1").token }), 403],
  ["Doctor 2", (h) => ({ token: h.signIn("admin2").token }), 403],
  ["Doctor 3", (h) => ({ token: h.signIn("admin3").token }), 403],
  ["Frontdesk without a label", (h) => ({ token: h.signIn("frontdesk").token }), 403],
  ["Frontdesk with the legacy \"Front Desk\" label", (h) => ({ token: h.signIn("frontdesk2").token }), 403],
  ["forged Superadmin claim on a doctor's valid session", (h) => {
    const login = h.signIn("admin1");
    return { token: h.sign({ id_num: "admin1", role: "superadmin", doctor_name: null, jti: login.session.session_id }) };
  }, 401],
  ["forged Superadmin identity with a fabricated session", (h) => ({
    token: h.sign({ id_num: "superadmin", role: "superadmin", doctor_name: null, jti: REVISION(901) })
  }), 401],
  ["doctor sending a Superadmin role in the body", (h) => ({
    token: h.signIn("admin1").token, body: { role: "superadmin", id_num: "superadmin", doctor_name: null }
  }), 403]
];

for (const route of ROUTES) {
  for (const [label, makeRequest, expected] of REJECTED) {
    test(`${route} rejects ${label} with ${expected} and changes nothing`, async () => {
      const h = fixture();
      const options = makeRequest(h);
      const before = snapshot(h);
      const body = { ...(options.body || {}), oldValue: "technical", newValue: "doc_processing" };
      const response = await h.request("POST", route, { ...options, body });
      assert.equal(response.status, expected, JSON.stringify(response.body));
      assert.equal(response.body.success, false);
      assert.deepEqual(snapshot(h), before);
      assert.equal(h.database.calls.some((call) => call.action !== "select"), false, "no database write was attempted");
    });
  }
}

test("Superadmin seeding inserts only missing doctor counters and preserves existing counters and patients", async () => {
  const h = fixture();
  h.database.counters[0].current_patient_id = 3;
  const before = snapshot(h);
  const { token } = h.signIn("superadmin");

  const first = await h.request("POST", "/setup/counters", { token });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { success: true, created: 1 });
  assert.deepEqual(h.database.patients, before.patients);
  assert.deepEqual(h.database.counters.slice(0, 2), before.counters, "ids, availability and patient pointers are unchanged");
  const created = h.database.counters.find((counter) => counter.id_num === "Doctor 3");
  assert.deepEqual(created.service_types, ["family_planning"]);
  assert.equal(created.current_patient_id, null);

  const repeat = await h.request("POST", "/setup/counters", { token });
  assert.deepEqual(repeat.body, { success: true, created: 0 });
  assert.equal(h.database.counters.filter((counter) => counter.id_num === "Doctor 3").length, 1, "no duplicate initialization");
  assert.equal(h.database.users.length, 6, "no account seeding");
});

test("service type renaming is disabled even for a verified Superadmin and writes nothing", async () => {
  const h = fixture();
  const before = snapshot(h);
  const { token } = h.signIn("superadmin");
  for (const body of [{}, { oldValue: "technical", newValue: "doc_processing" }, { oldValue: "consultation", newValue: "family_planning" }]) {
    const response = await h.request("POST", "/setup/service-type", { token, body });
    assert.equal(response.status, 410);
    assert.equal(response.body.success, false);
    assert.match(response.body.message, /disabled/);
  }
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.database.calls.some((call) => call.action !== "select"), false);
  assert.deepEqual(h.database.patients.map((row) => row.service_type), ["consultation", "prenatal", "technical"]);
});

test("rejected setup attempts leave service-to-doctor routing and WPS Call order intact", async () => {
  const h = fixture();
  h.database.counters[1].is_online = true;
  // A later, higher-priority GP patient must be called before the earlier regular one.
  h.database.patients.push(patient(h, 4, { queue_number: "GP-004", priority_score: 4, vulnerability_flags: ["senior"] }));
  for (const route of ROUTES) {
    await h.request("POST", route, { body: { oldValue: "consultation", newValue: "family_planning" } });
    await h.request("POST", route, { token: h.signIn("admin2").token, body: { oldValue: "prenatal", newValue: "consultation" } });
  }
  assert.deepEqual(h.database.patients.map((row) => row.service_type), ["consultation", "prenatal", "technical", "consultation"]);

  const frontdesk = h.signIn("frontdesk").token;
  const outOfOrder = await h.request("POST", "/queue/call", { token: frontdesk, body: { patient_id: 1 } });
  assert.equal(outOfOrder.status, 400);
  assert.match(outOfOrder.body.message, /according to queue priority/);

  const wrongDoctor = await h.request("POST", "/queue/call", { token: h.signIn("admin2").token, body: { patient_id: 4, counterId: "Doctor 2" } });
  assert.equal(wrongDoctor.status, 400);
  assert.match(wrongDoctor.body.message, /assigned to Doctor 1/);

  const called = await h.request("POST", "/queue/call", { token: frontdesk, body: { patient_id: 4 } });
  assert.equal(called.status, 200, JSON.stringify(called.body));
  const row = h.database.patients.find((item) => item.id === 4);
  assert.equal(row.status, "serving");
  assert.equal(row.counter_id, "Doctor 1");
  assert.equal(h.database.counters.find((counter) => counter.id_num === "Doctor 1").current_patient_id, 4);

  const prenatal = await h.request("POST", "/queue/call", { token: h.signIn("admin2").token, body: { patient_id: 2 } });
  assert.equal(prenatal.status, 200, JSON.stringify(prenatal.body));
  assert.equal(h.database.patients.find((item) => item.id === 2).counter_id, "Doctor 2");
});

test("R1, R2 and R2.1 protections still hold through the real authentication path", async () => {
  const h = fixture();
  h.database.counters[1].is_online = true;
  await h.request("POST", "/setup/service-type", {});
  await h.request("POST", "/setup/counters", {});

  const display = await h.request("GET", "/display");
  assert.equal(display.status, 200);
  assert.doesNotMatch(JSON.stringify(display.body), /Synthetic Patient|09000000000/, "R1: no names or contact numbers");

  const before = snapshot(h);
  const doctor2 = h.signIn("admin2").token;
  const crossCancel = await h.request("POST", "/queue/cancel", { token: doctor2, body: { patient_id: 1, reason: "test" } });
  assert.equal(crossCancel.status, 403, "R2: a doctor cannot cancel another doctor's patient");
  const crossNoShow = await h.request("POST", "/queue/no-show", { token: doctor2, body: { patient_id: 1 } });
  assert.equal(crossNoShow.status, 403, "R2.1: a doctor cannot mark another doctor's patient");
  const forgedBody = await h.request("POST", "/queue/cancel", {
    token: doctor2, body: { patient_id: 1, reason: "test", role: "superadmin", id_num: "superadmin", doctor_name: "Doctor 1" }
  });
  assert.equal(forgedBody.status, 403, "body identity fields are ignored");
  assert.deepEqual(snapshot(h), before);

  const frontdeskCancel = await h.request("POST", "/queue/cancel", { token: h.signIn("frontdesk").token, body: { patient_id: 1, reason: "Synthetic test" } });
  assert.equal(frontdeskCancel.status, 200, "Frontdesk keeps its cross-doctor cancellation");
  assert.equal(h.database.patients.find((row) => row.id === 1).status, "cancelled");
});

test("startup still seeds counters directly, not through the protected HTTP route", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  assert.match(source, /await seedCounters\(\);/);
  assert.doesNotMatch(source, /\/setup\//);
});
