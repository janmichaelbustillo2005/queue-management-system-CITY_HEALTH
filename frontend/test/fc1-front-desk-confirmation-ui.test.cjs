// FC1 Front Desk confirmation in Patient Management (components/PatientQueueTable.js): the
// confirmation badge, Confirm Patient (Frontdesk only), and the doctor head skipping pending
// visits. Rendered with the same isolated harness as patient-queue-call.test.cjs.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");
const { isQueueViewModule, loadQueueView } = require("./queue-view-module.cjs");

let componentCode;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../components/PatientQueueTable.js");
  const result = await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  });
  componentCode = result.code;
});

function patient(id, overrides = {}) {
  return { id, id_num: `Test ${id}`, queue_number: `GP-${id}`, service_type: "consultation", status: "waiting",
    priority_score: 1, created_at: `2026-11-11T01:0${id}:00Z`, counter_id: null, called_at: null, accepted_at: null,
    consultation_started_at: null, completed_at: null, vulnerability_flags: [],
    confirmed_at: null, confirmed_by: null, ...overrides };
}
const confirmed = (id, overrides = {}) => patient(id, { confirmed_at: `2026-11-11T01:0${id}:30Z`, confirmed_by: "frontdesk", ...overrides });

function harness(rows, options = {}) {
  const calls = [], notices = [];
  let confirmation = null;
  let refreshes = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  const props = {
    doctors: [1, 2, 3].map((number) => ({ name: `Doctor ${number}`, assignment: "Test services" })),
    counters: [1, 2, 3].map((number) => ({ id_num: `Doctor ${number}`, is_online: true, current_patient_id: null })),
    queueRows: rows, queueSettings: {}, canConfirm: true,
    onRefresh: async () => { refreshes++; },
    onNotify: (...args) => notices.push(args), onConfirm: (value) => { confirmation = value; }, ...options.props
  };
  const react = {
    useMemo: (callback) => callback(),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial })
  };
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, Set, Map, console,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: async (route, init) => {
        calls.push({ route, method: init.method, body: JSON.parse(init.body) });
        return options.request ? options.request(route, init) : { success: true, message: "Patient confirmed" };
      } };
      if (isServicesModule(name)) return loadServices();
      if (isQueueViewModule(name)) return loadQueueView();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return {
    render: () => module.exports.default(props), props, calls, notices,
    get confirmation() { return confirmation; }, get refreshes() { return refreshes; }
  };
}

function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach((node) => nodes(node, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
const buttons = (tree, label) => nodes(tree, (node) => node.type === "button" && text(node).trim() === label);
const rowOf = (tree, id) => nodes(tree, (node) => node.type === "tr" && text(node).includes(`GP-${id}`))[0];

test("a new visit shows Pending Confirmation with Confirm Patient and Cancel; a confirmed visit shows Confirmed", () => {
  const h = harness([patient(1), confirmed(2)]);
  const tree = h.render();
  assert.match(text(rowOf(tree, 1)), /Pending Confirmation/);
  assert.equal(buttons(rowOf(tree, 1), "Confirm Patient").length, 1);
  assert.equal(buttons(rowOf(tree, 1), "Cancel").length, 1, "an absent patient can still be cancelled");
  assert.match(text(rowOf(tree, 2)), /Confirmed/);
  assert.equal(buttons(rowOf(tree, 2), "Confirm Patient").length, 0, "a confirmed visit cannot be confirmed again");
  const badges = nodes(tree, (node) => node.props?.["data-confirmation"] != null).map((node) => node.props["data-confirmation"]);
  assert.deepEqual(badges.sort(), ["confirmed", "pending"]);
});

test("Confirm Patient asks first, then posts only the visit id to /queue/confirm and refreshes", async () => {
  const h = harness([patient(1)]);
  buttons(h.render(), "Confirm Patient")[0].props.onClick();
  assert.deepEqual(h.calls, [], "nothing is sent before the Front Desk confirms the dialog");
  assert.equal(h.confirmation.title, "Confirm Patient");
  assert.equal(h.confirmation.requireReason, undefined);
  assert.match(h.confirmation.message, /Test 1 \(GP-1\) is present/);
  assert.match(h.confirmation.message, /does not change/);
  await h.confirmation.onConfirm("");
  assert.deepEqual(h.calls, [{ route: "/queue/confirm", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.notices.map(([type]) => type), ["success"]);
});

test("a pending visit is never the doctor's head: the first confirmed visit is, and keeps the existing head actions", async () => {
  const h = harness([patient(1, { priority_score: 4 }), confirmed(2), confirmed(3)]);
  const tree = h.render();
  assert.equal(buttons(rowOf(tree, 2), "Cancel").length, 1, "the confirmed head offers the existing Cancel");
  assert.match(text(rowOf(tree, 3)), /Waiting for turn/);
  assert.equal(buttons(tree, "Call").length, 0, "Front Desk never calls");
  buttons(rowOf(tree, 1), "Cancel")[0].props.onClick();
  assert.equal(h.confirmation.requireReason, true);
  await h.confirmation.onConfirm("Left before confirmation");
  assert.deepEqual(h.calls, [{ route: "/queue/cancel", method: "POST",
    body: { patient_id: 1, reason: "Left before confirmation", counter_id: "Doctor 1" } }]);
});

test("Superadmin (canConfirm false) sees the state but has no Confirm Patient", () => {
  const h = harness([patient(1)], { props: { canConfirm: false } });
  const tree = h.render();
  assert.equal(buttons(tree, "Confirm Patient").length, 0);
  assert.match(text(rowOf(tree, 1)), /Pending Confirmation/);
  assert.match(text(rowOf(tree, 1)), /Awaiting Front Desk Confirmation/);
});

test("cancelled, serving and completed visits show no confirmation action", () => {
  const h = harness([
    patient(1, { status: "cancelled", counter_id: "Doctor 1", completed_at: "2026-11-11T02:00:00Z" }),
    confirmed(2, { status: "serving", counter_id: "Doctor 2", service_type: "prenatal", called_at: "2026-11-11T02:00:00Z" })
  ]);
  const tree = h.render();
  assert.equal(buttons(tree, "Confirm Patient").length, 0);
  assert.doesNotMatch(text(tree), /Pending Confirmation/);
});
