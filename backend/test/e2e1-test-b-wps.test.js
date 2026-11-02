// E2E-1 Test B: Weighted-Priority Scheduling through the REAL backend on disposable PostgreSQL 17
// (helpers/c1f5w1Fixture.js: loopback cluster, synthetic rows, C1 + F5 + W1 installed). The
// Frontdesk registration route (/queue/website) registers a Regular patient first and a Senior
// patient second; the Frontdesk Patient Management table (frontend PatientQueueTable, compiled
// with the frontend's own Next.js SWC) is rendered on the backend's own GET /queue response, so
// the head shown to staff and the head C1 enforces are compared directly.
// Set E2E1_EVIDENCE_DIR to write the step-by-step database evidence as JSON.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, test, before, after } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, expectStatus, effects, patient, pointers, assertConsistent } = f;
const frontendDir = path.resolve(__dirname, "../../frontend");
const PRIORITY_REFUSAL = /according to queue priority/;

let tableCode;
let unavailable = f.unavailable;
if (!unavailable && !fs.existsSync(path.join(frontendDir, "node_modules/next/dist/build/swc"))) {
  unavailable = "frontend dependencies are not installed (needed to render PatientQueueTable)";
}

before(async () => {
  if (unavailable) return;
  await f.startCluster();
  const swc = require(path.join(frontendDir, "node_modules/next/dist/build/swc"));
  await swc.loadBindings();
  const filename = path.join(frontendDir, "components/PatientQueueTable.js");
  tableCode = (await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  })).code;
});
after(async () => { if (!unavailable) await f.stopCluster(); });

// Renders the Frontdesk queue table on GET /queue data; returns each doctor's rows with the
// action offered on each (Call Now only appears on the doctor's head).
function renderTable(overview) {
  const hooks = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  const react = {
    useMemo: (callback) => callback(),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], () => {}];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    }
  };
  vm.runInNewContext(tableCode, {
    module, exports: module.exports, Set, Map, console,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: async () => { throw new Error("read-only render"); } };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const tree = module.exports.default({
    doctors: [1, 2, 3].map((n) => ({ name: `Doctor ${n}`, assignment: "Synthetic" })),
    counters: overview.counters, queueRows: overview.patients, queueSettings: overview.queue_settings || {},
    onRefresh: async () => {}, onNotify: () => {}, onConfirm: () => {}
  });
  const nodes = (node, predicate, out = []) => {
    if (Array.isArray(node)) node.forEach((child) => nodes(child, predicate, out));
    else if (node && typeof node === "object") { if (predicate(node)) out.push(node); nodes(node.props?.children, predicate, out); }
    return out;
  };
  const text = (node) => Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);
  // Each table row whose text contains a synthetic queue number, with the buttons it offers.
  return nodes(tree, (node) => node.type === "tr").map((row) => ({
    text: text(row),
    buttons: nodes(row, (node) => node.type === "button").map(text)
  })).filter((row) => /GP-\d+/.test(row.text));
}

describe("E2E-1 Test B: WPS priority selection (Regular registered first, Senior second)", { skip: unavailable }, () => {
  let db; let h; let tokens;
  const evidence = { steps: [] };
  const record = async (step, ids) => {
    const rows = {};
    for (const [label, id] of Object.entries(ids)) rows[label] = await patient(db, id);
    evidence.steps.push({ step, at: new Date().toISOString(), patients: rows, counters: await pointers(db) });
  };

  before(async () => {
    db = await f.createDatabase("e2e1_test_b", [C1.migration, F5.migration, W1.migration]);
    await f.resetQueue(db);
    h = await f.backend(db);
    tokens = await f.signInAll(h);
  });
  after(() => {
    if (process.env.E2E1_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.E2E1_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.E2E1_EVIDENCE_DIR, "test-b-wps-evidence.json"), JSON.stringify(evidence, null, 2));
    }
  });

  test("Regular then Senior: Senior heads Doctor 1, C1 refuses the Regular, both complete in WPS order", async () => {
    // 1-2. Frontdesk registration exactly as the form sends it (the form ticks Senior from the birthdate).
    const regularResponse = await h.request("POST", "/queue/website", { body: {
      fullName: "E2E1B Regular Test", serviceType: "consultation", birthdate: "1995-06-20", sex: "Female",
      residency: "E2E1 Synthetic Address", vulnerabilityFlags: [] } });
    expectStatus(regularResponse, 200);
    await new Promise((resolve) => setTimeout(resolve, 15)); // strictly later registration
    const seniorResponse = await h.request("POST", "/queue/website", { body: {
      fullName: "E2E1B Senior Test", serviceType: "consultation", birthdate: "1955-03-10", sex: "Male",
      residency: "E2E1 Synthetic Address", vulnerabilityFlags: ["senior"] } });
    expectStatus(seniorResponse, 200);
    const idOf = async (queueNumber) => Number(await f.one(db, "SELECT id AS value FROM public.patients WHERE queue_number = $1", [queueNumber]));
    const regular = await idOf(regularResponse.body.queue_number);
    const senior = await idOf(seniorResponse.body.queue_number);
    const ids = { regular, senior };
    await record("registered", ids);

    const r0 = await patient(db, regular);
    const s0 = await patient(db, senior);
    assert.equal(r0.priority_score, 1, "Regular gets the base weight 1");
    assert.equal(s0.priority_score, 4, "Senior Citizen weight is 4");
    assert.equal(regularResponse.body.priority_score, 1);
    assert.equal(seniorResponse.body.priority_score, 4);
    assert.ok(Date.parse(s0.created_at) > Date.parse(r0.created_at), "Senior registered later");
    assert.equal(r0.status, "waiting");
    assert.equal(s0.status, "waiting");

    // 3-4. Backend overview and the Frontdesk table agree: Senior is Doctor 1's head.
    const overview = await h.request("GET", "/queue", { token: tokens.frontdesk });
    expectStatus(overview, 200);
    const rows = renderTable(overview.body);
    const seniorRow = rows.find((row) => row.text.includes(s0.queue_number));
    const regularRow = rows.find((row) => row.text.includes(r0.queue_number));
    assert.ok(seniorRow.buttons.includes("Call Now"), "Call Now is offered on the Senior row");
    assert.ok(!regularRow.buttons.includes("Call Now"), "the Regular row waits for its turn");
    assert.match(regularRow.text, /Waiting for turn/);
    assert.ok(rows.indexOf(seniorRow) < rows.indexOf(regularRow), "Senior listed above Regular");
    evidence.frontendTable = rows.map((row) => ({ text: row.text.replace(/\s+/g, " ").slice(0, 120), buttons: row.buttons }));

    // 5. The backend refuses the lower-priority patient before any write...
    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: regular }), 400, PRIORITY_REFUSAL);
    assert.deepEqual(h.log.filter((entry) => entry.kind !== "rpc" && entry.action !== "select"), [], "no table write");
    // ...and C1 itself refuses it too: a separate service_role connection calls the function
    // directly with the Regular's current revision, as a client that skipped the backend check would.
    const direct = await db.connect("e2e1b-direct-c1");
    try {
      await direct.query("SET ROLE service_role");
      await assert.rejects(direct.query(`SELECT * FROM public.call_patient_visit($1, 'Doctor 1', 'frontdesk', $2,
          $3::timestamptz, $4::timestamptz)`,
        [regular, r0.visit_state_revision, "1999-12-31T16:00:00.000Z", "2100-01-01T00:00:00.000Z"]),
      (error) => { evidence.c1DirectRefusal = { code: error.code, message: error.message }; return PRIORITY_REFUSAL.test(error.message); });
    } finally { await direct.end(); }
    assert.deepEqual(await patient(db, regular), r0, "refused call leaves the Regular row byte-for-byte unchanged");
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    assert.equal(effects(h, regular).sms, 0);
    await record("c1-refused-regular", ids);

    // 6-7. C1 calls the Senior on Doctor 1.
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: senior }), 200);
    const s1 = await patient(db, senior);
    assert.equal(s1.status, "serving");
    assert.equal(s1.counter_id, "Doctor 1");
    assert.notEqual(s1.visit_state_revision, s0.visit_state_revision);
    assert.deepEqual(await pointers(db), { "Doctor 1": senior, "Doctor 2": null, "Doctor 3": null });
    assert.equal((await patient(db, regular)).status, "waiting");
    // While Doctor 1 is busy the Regular cannot be called either.
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: regular }), 400, /already serving/);
    await record("senior-called", ids);

    // 8-9. Doctor 1 accepts, starts and completes; the counter is released.
    expectStatus(await post(h, tokens.admin1, "/queue/accept", { patient_id: senior }), 200);
    assert.equal(effects(h, senior).voice, 1, "acceptance records one voice announcement");
    expectStatus(await post(h, tokens.admin1, "/queue/start", { patient_id: senior }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/complete", { patient_id: senior }), 200);
    const s2 = await patient(db, senior);
    assert.equal(s2.status, "completed");
    assert.equal(s2.called_at, s1.called_at);
    assert.ok(Date.parse(s2.completed_at) > Date.parse(s2.consultation_started_at));
    assert.equal((await pointers(db))["Doctor 1"], null);
    await record("senior-completed", ids);

    // The Regular is now the head in both views and is resolved through the same workflow.
    const after = renderTable((await h.request("GET", "/queue", { token: tokens.frontdesk })).body);
    assert.ok(after.find((row) => row.text.includes(r0.queue_number)).buttons.includes("Call Now"));
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: regular }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/accept", { patient_id: regular }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/start", { patient_id: regular }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/complete", { patient_id: regular }), 200);
    const r2 = await patient(db, regular);
    assert.equal(r2.status, "completed");
    assert.ok(Date.parse(r2.called_at) > Date.parse(s2.called_at), "Senior was called before the earlier Regular");
    await record("regular-completed", ids);

    // 10. History is consistent: no counter points anywhere, timestamps are ordered, invariants hold.
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    for (const row of [s2, r2]) {
      assert.ok(Date.parse(row.created_at) <= Date.parse(row.called_at));
      assert.ok(Date.parse(row.called_at) <= Date.parse(row.consultation_started_at));
      assert.ok(Date.parse(row.consultation_started_at) <= Date.parse(row.completed_at));
      assert.equal(row.counter_id, "Doctor 1");
    }
    await assertConsistent(db);
  });
});
