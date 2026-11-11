// D1 shared dispatch (dispatch_mode "shared") in Frontdesk Patient Management and the queue
// ticket. Service mode is covered unchanged by patient-queue-call and queue-ticket tests.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");
const { isQueueViewModule, loadQueueView } = require("./queue-view-module.cjs");

let tableCode, ticketCode;
before(async () => {
  await swc.loadBindings();
  const compile = async (relative) => {
    const filename = path.join(__dirname, relative);
    return (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  };
  [tableCode, ticketCode] = await Promise.all([compile("../components/PatientQueueTable.js"), compile("../lib/queueTicket.js")]);
});

function patient(id, service = "consultation", overrides = {}) {
  return { id, id_num: `Synthetic ${id}`, queue_number: `Q-${id}`, service_type: service, status: "waiting",
    priority_score: 1, created_at: `2026-10-29T01:0${id}:00Z`, counter_id: null, called_at: null,
    consultation_started_at: null, completed_at: null, vulnerability_flags: [], confirmed_at: `2026-10-29T01:0${id}:30Z`, confirmed_by: "frontdesk", ...overrides };
}

function table(rows, { counters, request } = {}) {
  const hooks = [];
  let cursor = 0;
  const calls = [], notices = [], confirms = [];
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  const props = {
    doctors: [1, 2, 3].map((number) => ({ name: `Doctor ${number}`, assignment: "Test" })),
    counters: counters || [1, 2, 3].map((number) => ({ id_num: `Doctor ${number}`, is_online: true, current_patient_id: null })),
    queueRows: rows, queueSettings: {}, dispatchMode: "shared",
    onRefresh: async () => {}, onNotify: (...args) => notices.push(args), onConfirm: (options) => confirms.push(options)
  };
  const react = {
    useMemo: (callback) => callback(),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    }
  };
  vm.runInNewContext(tableCode, {
    module, exports: module.exports, Set, Map, console, Date, Math,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: async (route, init) => {
        calls.push({ route, body: JSON.parse(init.body) });
        return request ? request(route, init) : { success: true };
      } };
      if (isServicesModule(name)) return loadServices();
      if (isQueueViewModule(name)) return loadQueueView();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(props); };
  return { render, props, calls, notices, confirms };
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
const buttons = (tree, label) => nodes(tree, (node) => node.type === "button" && text(node) === label);
const rowsOf = (tree) => nodes(tree, (node) => node.type === "tr" && node.props.className?.includes("brand-hover-subtle"));

test("one shared queue: Frontdesk cannot call or choose a doctor, and only its priority head can be cancelled", async () => {
  const rows = [
    patient(1, "consultation"),
    patient(2, "family_planning", { priority_score: 4 }),          // Senior registered later: head
    patient(3, "prenatal", { status: "serving", counter_id: "Doctor 2", called_at: "2026-10-29T01:05:00Z" })
  ];
  const h = table(rows);
  const tree = h.render();
  assert.equal(buttons(tree, "Call Now").length, 0);
  assert.equal(nodes(tree, (node) => node.type === "select").length, 0, "no doctor to choose");
  const labels = rowsOf(tree).map((row) => text(row.props.children[2]).trim());
  assert.deepEqual(labels, ["Doctor 2", "Next available", "Next available"], "a serving visit shows its actual doctor");
  assert.match(text(tree), /Waiting for turn/);
  buttons(tree, "Cancel").forEach((button) => button.props.onClick());
  assert.ok(h.confirms.some((options) => options.message.includes("(Q-2)")), "the priority head");
  assert.equal(h.confirms.some((options) => options.message.includes("(Q-1)")), false);
});

test("cancelling the shared head names no doctor; a served visit is cancelled against its actual doctor", async () => {
  const rows = [patient(1, "prenatal"), patient(2, "consultation", { status: "serving", counter_id: "Doctor 3", called_at: "2026-10-29T01:05:00Z" })];
  const h = table(rows);
  const tree = h.render();
  const cancels = buttons(tree, "Cancel");
  assert.equal(cancels.length, 2);
  for (const button of cancels) button.props.onClick();
  const confirmFor = (queue) => h.confirms.find((options) => options.message.includes(`(${queue})`));
  assert.match(confirmFor("Q-1").message, /from the shared queue/);
  await confirmFor("Q-1").onConfirm("left");
  await confirmFor("Q-2").onConfirm("referred");
  const bodies = h.calls.map((call) => call.body);
  assert.ok(bodies.some((body) => body.patient_id === 1 && body.reason === "left" && !("counter_id" in body)));
  assert.ok(bodies.some((body) => body.patient_id === 2 && body.counter_id === "Doctor 3"));
});

test("an uncalled cancellation stays in view without queue actions until the next call", () => {
  const rows = [
    patient(1, "consultation", { status: "cancelled", completed_at: "2026-10-29T01:10:00Z" }),
    patient(2, "prenatal", { status: "serving", counter_id: "Doctor 1", called_at: "2026-10-29T01:05:00Z" })
  ];
  let tree = table(rows).render();
  assert.match(text(tree), /Q-1/);
  assert.equal(buttons(tree, "Undo").length, 0);
  assert.equal(buttons(tree, "Re-queue").length, 0);
  rows[1].called_at = "2026-10-29T01:20:00Z";
  tree = table(rows).render();
  assert.doesNotMatch(text(tree), /Q-1/, "hidden once a later patient is called");
});

function ticketHelpers() {
  const module = { exports: {} };
  vm.runInNewContext(ticketCode, {
    module, exports: module.exports, console, URL, Blob, Date,
    require(name) {
      if (name === "./api") return { request: async () => ({ dispatch_mode: "shared", patients: [patient(5, "maternity")] }) };
      if (name === "./branding") return { SYSTEM_BRANDING: { logoSrc: "/logo.png" } };
      if (isServicesModule(name)) return loadServices();
      if (isQueueViewModule(name)) return loadQueueView();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return module.exports;
}

test("tickets: no doctor is promised at registration; the actual doctor appears after the call", async () => {
  const t = ticketHelpers();
  const waiting = t.createQueueTicket(patient(5, "maternity"), { dispatchMode: "shared" });
  assert.equal(waiting.doctorName, "Next available doctor");
  assert.match(t.queuePassSvgContents(waiting), /Doctor assigned when called/);
  assert.match(t.thermalTicketHtml(waiting), /Assigned: Next available doctor/);
  const called = t.createQueueTicket(patient(5, "maternity", { status: "serving", counter_id: "Doctor 3" }), { dispatchMode: "shared" });
  assert.equal(called.doctorName, "Doctor 3");
  assert.match(t.queuePassSvgContents(called), /Assigned to Doctor 3/);
  assert.equal(t.createQueueTicket(patient(5, "maternity")).doctorName, "Doctor 2", "service mode keeps the routed doctor");
  assert.equal((await t.fetchExistingQueueTicket(5)).doctorName, "Next available doctor", "the /queue dispatch mode is honoured");
});

test("tickets: patients ahead counts the whole shared queue, not only the same service", () => {
  const t = ticketHelpers();
  const rows = [patient(1, "consultation"), patient(2, "family_planning", { priority_score: 4 }), patient(3, "prenatal")];
  assert.equal(t.getPatientsAheadSnapshot(rows, rows[2], "shared"), 2);
  assert.equal(t.getPatientsAheadSnapshot(rows, rows[2]), 0, "service mode counts only the prenatal doctor's queue");
});

test("I1 shared queue with WPS-A: the head follows effective_priority, and a protected category wins a tie", () => {
  const rows = [
    patient(1, "consultation", { priority_score: 1, effective_priority: 3, created_at: "2026-10-29T01:00:00Z" }), // Regular aged +2
    patient(2, "prenatal", { priority_score: 3, effective_priority: 3, created_at: "2026-10-29T01:25:00Z" }),     // Pregnant, new
    patient(3, "family_planning", { priority_score: 2, effective_priority: 2, created_at: "2026-10-29T01:20:00Z" })
  ];
  const headQueue = () => {
    const h = table(rows);
    buttons(h.render(), "Cancel")[0].props.onClick();
    return h.confirms[0].message;
  };
  assert.match(headQueue(), /\(Q-2\)/, "the tie at 3 goes to the higher base priority");
  rows[1].status = "completed";
  assert.match(headQueue(), /\(Q-1\)/, "then the aged Regular before the newer Indigenous visit");
});

test("I1 tickets: patients ahead in the shared queue use the aged rank", () => {
  const t = ticketHelpers();
  const rows = [patient(1, "consultation", { effective_priority: 3 }), patient(2, "prenatal", { priority_score: 2, effective_priority: 2 }),
    patient(3, "family_planning", { effective_priority: 1 })];
  assert.equal(t.getPatientsAheadSnapshot(rows, rows[1], "shared"), 1, "the aged Regular is ahead of the Indigenous visit");
});
