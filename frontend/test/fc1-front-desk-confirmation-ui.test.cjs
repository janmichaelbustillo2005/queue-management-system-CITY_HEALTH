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
const { isQueuePaginationModule, loadQueuePagination } = require("./queue-pagination-module.cjs");

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
    confirmed_at: null, confirmed_by: null,
    // OC1 (GET /queue): a pending visit at the head of a free doctor's list is confirmable.
    confirmable: true, confirmation_blocked: null, confirmation_blocked_by: null, ...overrides };
}
const confirmed = (id, overrides = {}) => patient(id, { confirmed_at: `2026-11-11T01:0${id}:30Z`, confirmed_by: "frontdesk", confirmable: false, ...overrides });
const blocked = (id, reason, by, overrides = {}) => patient(id, { confirmable: false, confirmation_blocked: reason, confirmation_blocked_by: by, ...overrides });

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
      if (isQueuePaginationModule(name)) return loadQueuePagination({ jsx, jsxs: jsx, Fragment: "fragment" });
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

test("Confirm Patient posts only the visit id to /queue/confirm immediately (no dialog), refreshes and notifies", async () => {
  const h = harness([patient(1)]);
  await buttons(h.render(), "Confirm Patient")[0].props.onClick();
  assert.equal(h.confirmation, null, "no confirmation dialog is opened");
  assert.deepEqual(h.calls, [{ route: "/queue/confirm", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.notices, [["success", "Doctor 1: Patient confirmed"]]);
});

test("a refused confirmation shows a clear error, refreshes the table and confirms nothing", async () => {
  const h = harness([patient(1)], { request: () => ({ error: "Doctor 1 already has a confirmed patient (GP-4).", status: 409 }) });
  await buttons(h.render(), "Confirm Patient")[0].props.onClick();
  assert.equal(h.confirmation, null);
  assert.deepEqual(h.notices, [["error", "GP-1 was not confirmed: Doctor 1 already has a confirmed patient (GP-4)."]]);
  assert.equal(h.refreshes, 1, "the stale table is reloaded so it shows who can be confirmed now");
});

test("a network failure while confirming is reported, never silent", async () => {
  const h = harness([patient(1)], { request: () => { throw new Error("Failed to fetch"); } });
  await buttons(h.render(), "Confirm Patient")[0].props.onClick();
  assert.deepEqual(h.notices.map(([type]) => type), ["error"]);
  assert.match(h.notices[0][1], /GP-1 was not confirmed: Failed to fetch/);
});

test("a double click sends a single confirmation", async () => {
  let release;
  const h = harness([patient(1)], { request: () => new Promise((resolve) => { release = () => resolve({ success: true }); }) });
  const button = buttons(h.render(), "Confirm Patient")[0];
  const first = button.props.onClick();
  const second = button.props.onClick();
  await second;
  release();
  await first;
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes, 1);
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

// OC1 one confirmation at a time per doctor.
test("only the visit the backend marks confirmable shows Confirm Patient; the others say why and keep Cancel", () => {
  const h = harness([
    patient(1),
    blocked(2, "not_next_for_doctor", "GP-1"),
    blocked(3, "doctor_has_active_patient", "GP-4", { counter_id: "Doctor 2", service_type: "prenatal" }),
    confirmed(4, { counter_id: "Doctor 2", service_type: "prenatal" }),
    blocked(5, "awaiting_doctor_assignment", null)
  ]);
  const tree = h.render();
  assert.equal(buttons(tree, "Confirm Patient").length, 1);
  assert.equal(buttons(rowOf(tree, 1), "Confirm Patient").length, 1);
  assert.match(text(rowOf(tree, 2)), /Waiting for turn \(GP-1 is next\)/);
  assert.match(text(rowOf(tree, 3)), /Waiting for GP-4 to finish/);
  assert.match(text(rowOf(tree, 5)), /Awaiting doctor assignment/);
  for (const id of [2, 3, 5]) {
    assert.equal(buttons(rowOf(tree, id), "Confirm Patient").length, 0, `row ${id}`);
    assert.equal(buttons(rowOf(tree, id), "Cancel").length, 1, `row ${id} can still be cancelled`);
    assert.match(text(rowOf(tree, id)), /Pending Confirmation/, "the badge and other row data are unchanged");
  }
});

test("each doctor's own next patient is confirmable at the same time", () => {
  const h = harness([
    patient(1), blocked(2, "not_next_for_doctor", "GP-1"),
    patient(3, { counter_id: "Doctor 2", service_type: "prenatal" }), patient(5, { counter_id: "Doctor 3", service_type: "family_planning" })
  ]);
  const tree = h.render();
  assert.deepEqual([1, 2, 3, 5].map((id) => buttons(rowOf(tree, id), "Confirm Patient").length), [1, 0, 1, 1]);
});

test("a visit without the backend's confirmable flag (or blocked) never posts a confirmation", async () => {
  const legacy = patient(1);
  delete legacy.confirmable;
  const h = harness([legacy, blocked(2, "not_next_for_doctor", "GP-1")]);
  const tree = h.render();
  assert.equal(buttons(tree, "Confirm Patient").length, 0, "fails closed without the flag");
  assert.match(text(rowOf(tree, 1)), /Waiting for turn/);
  assert.equal(h.confirmation, null);
  assert.deepEqual(h.calls, []);
});

// OC1 Not Present.
const away = (id, overrides = {}) => patient(id, { confirmable: false, confirmation_blocked: "patient_not_present",
  not_present_at: `2026-11-11T01:1${id}:00Z`, not_present_by: "frontdesk", ...overrides });

test("Patient Management has no Not Present action (removed 2026-11-13); pending rows keep Confirm Patient and Cancel", () => {
  const h = harness([patient(1), blocked(2, "not_next_for_doctor", "GP-1")]);
  const tree = h.render();
  assert.equal(nodes(tree, (node) => node.type === "button" && /not present/i.test(text(node))).length, 0);
  assert.deepEqual([buttons(rowOf(tree, 1), "Confirm Patient").length, buttons(rowOf(tree, 1), "Cancel").length], [1, 1]);
  assert.deepEqual([buttons(rowOf(tree, 2), "Confirm Patient").length, buttons(rowOf(tree, 2), "Cancel").length], [0, 1]);
});

test("a Not Present patient shows the badge, Mark Present and Cancel, and never Confirm Patient", async () => {
  const h = harness([away(1, { confirmable: true })]);
  const tree = h.render();
  const row = rowOf(tree, 1);
  assert.match(text(row), /Not Present/);
  assert.match(text(row), /Pending Confirmation/);
  assert.equal(nodes(row, (node) => node.props?.["data-presence"] === "not-present").length, 1);
  assert.equal(buttons(row, "Confirm Patient").length, 0, "even a stale confirmable flag cannot confirm an absent patient");
  assert.equal(buttons(row, "Cancel").length, 1);
  buttons(row, "Mark Present")[0].props.onClick();
  assert.equal(h.confirmation.title, "Mark Present");
  assert.match(h.confirmation.message, /original place/);
  await h.confirmation.onConfirm("");
  assert.deepEqual(h.calls, [{ route: "/queue/present", method: "POST", body: { patient_id: 1 } }]);
});

test("Superadmin sees the Not Present state but has no presence actions", () => {
  const h = harness([away(1), patient(2)], { props: { canConfirm: false } });
  const tree = h.render();
  assert.match(text(rowOf(tree, 1)), /Not Present/);
  for (const label of ["Mark Present", "Not Present", "Confirm Patient"]) {
    assert.equal(nodes(tree, (node) => node.type === "button" && text(node).trim() === label).length, 0, label);
  }
});
