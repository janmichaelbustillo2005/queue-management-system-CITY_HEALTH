// I2: independent verification of integration/d1-wpsa-wrr on disposable PostgreSQL 17
// (helpers/c1f5w1Fixture.js; every function draft installed: C1, F5, W1, D1, D1-R, WPS-A, D1-A).
//   1. the four dispatch x aging configurations through the real backend;
//   2. Node (compareWps), PostgreSQL (D1-A) and the rendered Frontdesk table pick the same head at
//      the 10- and 20-minute step edges (+/-1 ms);
//   3. the Indigenous / PWD / Pregnant aging scenario (policy risk);
//   4. three doctors draining a mixed shared queue concurrently: every visit served once.
// Set I2_EVIDENCE_DIR to write the evidence as JSON.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");
const { compareWps, effectivePriority } = require("../src/lib/wpsPriority");

const { C1, F5, W1, post, expectStatus, patient, pointers, assertConsistent } = f;
const DRAFTS = ["20261029-d1-shared-call.sql", "20261029-d1r-records-shared.sql", "20261029-wps-a-call-aging.sql", "20261029-d1a-shared-wps-a-call.sql"];
const MIN = 60 * 1000;
const WINDOW = ["1999-12-31T16:00:00.000Z", "2100-01-01T00:00:00.000Z"];
const PRIORITY_REFUSAL = /according to (queue )?priority/;
const frontendDir = path.resolve(__dirname, "../../frontend");
const evidence = {};

let tableCode;
let unavailable = f.unavailable;
if (!unavailable && !fs.existsSync(path.join(frontendDir, "node_modules/next/dist/build/swc"))) unavailable = "frontend dependencies missing";

before(async () => {
  if (unavailable) return;
  await f.startCluster();
  const swc = require(path.join(frontendDir, "node_modules/next/dist/build/swc"));
  await swc.loadBindings();
  const filename = path.join(frontendDir, "components/PatientQueueTable.js");
  tableCode = (await swc.transform(fs.readFileSync(filename, "utf8"), { filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } }, module: { type: "commonjs" } })).code;
});
after(async () => {
  if (process.env.I2_EVIDENCE_DIR && Object.keys(evidence).length) {
    fs.mkdirSync(process.env.I2_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.I2_EVIDENCE_DIR, "i2-independent-evidence.json"), JSON.stringify(evidence, null, 2));
  }
  if (!unavailable) await f.stopCluster();
});

// The queue number whose row offers Call Now in the rendered Frontdesk table.
function renderedHead(rows, dispatchMode) {
  const hooks = []; let cursor = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  const react = {
    useMemo: (cb) => cb(), useEffect: () => {}, useCallback: (cb) => cb,
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? initial() : initial; return [hooks[i], () => {}]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; }
  };
  vm.runInNewContext(tableCode, { module, exports: module.exports, Set, Map, console,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: async () => { throw new Error("read-only"); } };
      throw new Error(`Unexpected dependency: ${name}`);
    } });
  const tree = module.exports.default({
    doctors: [1, 2, 3].map((n) => ({ name: `Doctor ${n}`, assignment: "General" })),
    counters: [1, 2, 3].map((n) => ({ id_num: `Doctor ${n}`, is_online: true, current_patient_id: null })),
    queueRows: rows, queueSettings: {}, dispatchMode, doctorPresence: { "Doctor 1": true, "Doctor 2": true, "Doctor 3": true },
    onRefresh: async () => {}, onNotify: () => {}, onConfirm: () => {}
  });
  const nodes = (n, pred, out = []) => { if (Array.isArray(n)) n.forEach((c) => nodes(c, pred, out)); else if (n && typeof n === "object") { if (pred(n)) out.push(n); nodes(n.props?.children, pred, out); } return out; };
  const text = (n) => Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" ? text(n.props?.children) : n == null || typeof n === "boolean" ? "" : String(n);
  const heads = nodes(tree, (n) => n.type === "tr").filter((row) => nodes(row, (n) => n.type === "button").some((b) => /^Call/.test(text(b))))
    .map((row) => (text(row).match(/[A-Z]{2}-\d+/) || [])[0]);
  return [...new Set(heads)];
}

describe("I2 independent verification (all drafts installed)", { skip: unavailable }, () => {
  let db; let serial = 0;
  before(async () => { db = await f.createDatabase("i2_verify", [C1.migration, F5.migration, W1.migration, ...DRAFTS]); });
  beforeEach(() => f.resetQueue(db));

  const insert = async (base, createdAt, service = "consultation", flags = []) => Number(await f.one(db, `INSERT INTO public.patients
      (id_num, queue_number, service_type, status, created_at, priority_score, vulnerability_flags)
      VALUES ('Synthetic I2', $1, $2, 'waiting', $3, $4, $5::jsonb) RETURNING id AS value`,
    [`IV-${String(++serial).padStart(3, "0")}`, service, createdAt, base, JSON.stringify(flags)]));
  const queueNumber = async (id) => (await patient(db, id)).queue_number;

  test("1. four configurations: each Call goes through its own function, ranks as configured, assigns as configured", async () => {
    const expected = {
      "service/plain": "call_patient_visit", "service/aging": "call_patient_visit_wps_a",
      "shared/plain": "call_patient_visit_shared", "shared/aging": "call_patient_visit_shared_wps_a"
    };
    evidence.matrix = {};
    for (const [label, rpc] of Object.entries(expected)) {
      await f.resetQueue(db);
      const [mode, aging] = label.split("/");
      const h = await f.backend(db, { doctorDispatchMode: mode, envOverrides: { wpsAging: aging === "aging" } });
      const tokens = await f.signInAll(h);
      const now = Date.now();
      const regular = await insert(1, new Date(now - 25 * MIN).toISOString());
      const indigenous = await insert(2, new Date(now - MIN).toISOString(), "consultation", ["indigenous"]);
      const [head, other] = aging === "aging" ? [regular, indigenous] : [indigenous, regular];
      const doctor = mode === "shared" ? "Doctor 3" : "Doctor 1";      // shared: a general doctor takes a consultation
      const body = (id) => (mode === "shared" ? { patient_id: id, counterId: doctor } : { patient_id: id });
      h.log.length = 0;
      expectStatus(await post(h, tokens.frontdesk, "/queue/call", body(other)), 400, PRIORITY_REFUSAL);
      expectStatus(await post(h, tokens.frontdesk, "/queue/call", body(head)), 200);
      const used = h.rpcs().filter((name) => name.startsWith("call_patient_visit"));
      assert.deepEqual(used, [rpc], label);
      const called = await patient(db, head);
      assert.equal(called.counter_id, doctor, label);
      assert.equal((await pointers(db))[doctor], head);
      assert.equal((await patient(db, other)).status, "waiting");
      await assertConsistent(db);
      evidence.matrix[label] = { rpc: used[0], head: called.queue_number, assignedTo: doctor };
    }
  });

  test("2. Node, PostgreSQL (D1-A) and the Frontdesk table agree at the 10- and 20-minute edges", async () => {
    const cases = [
      // [label, [base, ageMs, service, flags], [base, ageMs, service, flags], expected head index]
      ["Indigenous 20m-1ms vs new PWD", [2, 20 * MIN - 1, "family_planning", ["indigenous"]], [3, 0, "consultation", ["pwd"]], 1],
      ["Indigenous 20m vs new PWD", [2, 20 * MIN, "family_planning", ["indigenous"]], [3, 0, "consultation", ["pwd"]], 0],
      ["Indigenous 20m+1ms vs new PWD", [2, 20 * MIN + 1, "family_planning", ["indigenous"]], [3, 0, "consultation", ["pwd"]], 0],
      ["Indigenous 25m vs PWD 10m-1ms", [2, 25 * MIN, "consultation", ["indigenous"]], [3, 10 * MIN - 1, "prenatal", ["pwd"]], 0],
      ["Indigenous 25m vs PWD 10m", [2, 25 * MIN, "consultation", ["indigenous"]], [3, 10 * MIN, "prenatal", ["pwd"]], 1],
      ["Indigenous 25m vs PWD 10m+1ms", [2, 25 * MIN, "consultation", ["indigenous"]], [3, 10 * MIN + 1, "prenatal", ["pwd"]], 1],
      ["Regular 20m-1ms vs new Indigenous", [1, 20 * MIN - 1, "checkup", []], [2, 0, "maternity", ["indigenous"]], 1],
      ["Regular 20m vs new Indigenous", [1, 20 * MIN, "checkup", []], [2, 0, "maternity", ["indigenous"]], 0],
      ["Regular 90m vs new Pregnant", [1, 90 * MIN, "consultation", []], [3, 0, "prenatal", ["pregnant"]], 1],
      ["Indigenous 20m vs new Senior", [2, 20 * MIN, "family_planning", ["indigenous"]], [4, 0, "consultation", ["senior"]], 1]
    ];
    const direct = await db.connect("i2-direct");
    await direct.query("SET ROLE service_role");
    evidence.boundaries = [];
    try {
      for (const [label, a, b, expectedIndex] of cases) {
        await f.resetQueue(db);
        const rankedAt = Date.now();
        const ids = [];
        for (const [base, age, service, flags] of [a, b]) ids.push(await insert(base, new Date(rankedAt - age).toISOString(), service, flags));
        const rows = await Promise.all(ids.map((id) => patient(db, id)));
        const nodeHead = rows.slice().sort((x, y) => compareWps(x, y, rankedAt, true))[0].id;
        // The backend's GET /queue row shape at rankedAt (effective_priority computed by the same function).
        const uiRows = rows.map((row) => ({ ...row, effective_priority: effectivePriority(row, rankedAt, true), recall_count: 0 }));
        const uiHeads = renderedHead(uiRows, "shared");
        const sqlResult = {};
        for (const row of rows) {
          await direct.query("BEGIN");
          try {
            await direct.query("SELECT id FROM public.call_patient_visit_shared_wps_a($1, 'Doctor 2', 'frontdesk', $2, $3, $4, $5)",
              [row.id, row.visit_state_revision, ...WINDOW, new Date(rankedAt).toISOString()]);
            sqlResult[row.id] = "called";
          } catch (error) {
            sqlResult[row.id] = PRIORITY_REFUSAL.test(error.message) ? "refused" : `error ${error.code}: ${error.message}`;
          } finally { await direct.query("ROLLBACK"); }
        }
        const expectedHead = ids[expectedIndex];
        evidence.boundaries.push({ label, expected: rows[expectedIndex].queue_number, node: await queueNumber(nodeHead), ui: uiHeads, sql: sqlResult });
        assert.equal(nodeHead, expectedHead, `${label}: Node`);
        assert.deepEqual(uiHeads, [rows[expectedIndex].queue_number], `${label}: Frontdesk table`);
        assert.equal(sqlResult[expectedHead], "called", `${label}: SQL head`);
        assert.equal(sqlResult[ids[1 - expectedIndex]], "refused", `${label}: SQL non-head`);
      }
    } finally { await direct.end(); }
  });

  test("3. policy scenario: an Indigenous patient waiting 20 min is called before newly arrived PWD and Pregnant patients", async () => {
    const order = async (aging) => {
      await f.resetQueue(db);
      const h = await f.backend(db, { doctorDispatchMode: "shared", envOverrides: { wpsAging: aging } });
      const tokens = await f.signInAll(h);
      const now = Date.now();
      const ids = {
        indigenous: await insert(2, new Date(now - 21 * MIN).toISOString(), "family_planning", ["indigenous"]),
        pwd: await insert(3, new Date(now - 3 * MIN).toISOString(), "consultation", ["pwd"]),
        pregnant: await insert(3, new Date(now - 2 * MIN).toISOString(), "prenatal", ["pregnant"]),
        senior: await insert(4, new Date(now - MIN).toISOString(), "checkup", ["senior"])
      };
      const served = [];
      for (let step = 0; step < 4; step += 1) {
        const waiting = Object.entries(ids).filter(([name]) => !served.includes(name));
        let called = null;
        for (const [name, id] of waiting) {
          const response = await post(h, tokens.frontdesk, "/queue/call", { patient_id: id, counterId: "Doctor 1" });
          if (response.status === 200) { called = [name, id]; break; }
          assert.match(response.body.message, PRIORITY_REFUSAL);
        }
        assert.ok(called, "one waiting visit is callable");
        served.push(called[0]);
        for (const action of ["accept", "start", "complete"]) expectStatus(await post(h, tokens.admin1, `/queue/${action}`, { patient_id: called[1] }), 200);
      }
      await assertConsistent(db);
      return served;
    };
    const withAging = await order(true);
    const withoutAging = await order(false);
    evidence.indigenousPolicyScenario = { withAging, withoutAging };
    assert.deepEqual(withoutAging, ["senior", "pwd", "pregnant", "indigenous"]);
    assert.deepEqual(withAging, ["senior", "indigenous", "pwd", "pregnant"],
      "POLICY RISK: with the +2 cap the 21-minute Indigenous visit (2+2=4) precedes new PWD and Pregnant visits (3)");
  });

  test("4. three doctors drain a mixed shared queue concurrently: each visit once, one at a time per doctor, every service by several doctors", async () => {
    const services = ["consultation", "checkup", "prenatal", "maternity", "family_planning"];
    const categories = [[1, []], [4, ["senior"]], [3, ["pwd"]], [3, ["pregnant"]], [2, ["indigenous"]], [1, ["solo_parent"]]];
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 30; i += 1) {
      const [base, flags] = categories[(i * 7) % categories.length];
      ids.push(await insert(base, new Date(now - ((i * 13) % 45) * MIN - i).toISOString(), services[i % services.length], flags));
    }
    const backends = [await f.backend(db, { doctorDispatchMode: "shared", envOverrides: { wpsAging: true } }),
      await f.backend(db, { doctorDispatchMode: "shared", envOverrides: { wpsAging: true } }),
      await f.backend(db, { doctorDispatchMode: "shared", envOverrides: { wpsAging: true } })];
    const tokens = await f.signInAll(backends[0]);
    const doctorTokens = [tokens.admin1, tokens.admin2, tokens.admin3];
    const servedBy = new Map();
    const timeline = [];
    let refusals = 0;
    await Promise.all([0, 1, 2].map(async (d) => {
      const h = backends[d];
      for (;;) {
        const overview = (await h.request("GET", "/queue", { token: tokens.frontdesk })).body;
        const waiting = overview.patients.filter((row) => row.status === "waiting" && ids.includes(Number(row.id)))
          .sort((x, y) => (y.effective_priority - x.effective_priority) || (y.priority_score - x.priority_score) ||
            Date.parse(x.created_at) - Date.parse(y.created_at) || x.id - y.id);
        if (!waiting.length) return;
        const response = await post(h, doctorTokens[d], "/queue/call", { patient_id: waiting[0].id });   // doctor picks up the head
        if (response.status !== 200) { refusals += 1; continue; }
        const id = Number(waiting[0].id);
        assert.ok(!servedBy.has(id), `visit ${id} assigned twice`);
        const doctor = `Doctor ${d + 1}`;
        servedBy.set(id, doctor);
        timeline.push({ id, doctor, service: waiting[0].service_type, at: Date.now() });
        assert.equal((await patient(db, id)).counter_id, doctor);
        for (const action of ["accept", "start", "complete"]) expectStatus(await post(h, doctorTokens[d], `/queue/${action}`, { patient_id: id }), 200);
      }
    }));
    assert.equal(servedBy.size, ids.length, "every visit served exactly once");
    for (const id of ids) assert.equal((await patient(db, id)).status, "completed");
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    const doctorsPerService = Object.fromEntries(services.map((s) => [s, [...new Set(timeline.filter((t) => t.service === s).map((t) => t.doctor))].sort()]));
    const perDoctor = Object.fromEntries(["Doctor 1", "Doctor 2", "Doctor 3"].map((doc) => [doc, timeline.filter((t) => t.doctor === doc).length]));
    evidence.threeDoctorDrain = { visits: ids.length, refusedRaces: refusals, perDoctor, doctorsPerService };
    for (const doc of Object.keys(perDoctor)) assert.ok(perDoctor[doc] > 0, `${doc} served patients`);
    assert.ok(Object.values(doctorsPerService).filter((list) => list.length > 1).length >= 3, "services are handled by several doctors");
    await assertConsistent(db);
  });
});
