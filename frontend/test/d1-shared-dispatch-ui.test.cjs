// D1 shared dispatch (dispatch_mode "shared") in Frontdesk Patient Management and the queue
// ticket. Service mode is covered unchanged by patient-queue-call and queue-ticket tests.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

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
    consultation_started_at: null, completed_at: null, vulnerability_flags: [], ...overrides };
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
const doctorSelect = (tree) => nodes(tree, (node) => node.type === "select")[0];
const rowsOf = (tree) => nodes(tree, (node) => node.type === "tr" && node.props.className?.includes("brand-hover-subtle"));

test("one shared queue: only its priority head can be called, and Frontdesk chooses among free doctors", async () => {
  const rows = [
    patient(1, "consultation"),
    patient(2, "family_planning", { priority_score: 4 }),          // Senior registered later: head
    patient(3, "prenatal", { status: "serving", counter_id: "Doctor 2", called_at: "2026-10-29T01:05:00Z" })
  ];
  const counters = [
    { id_num: "Doctor 1", is_online: true, current_patient_id: null },
    { id_num: "Doctor 2", is_online: true, current_patient_id: 3 },
    { id_num: "Doctor 3", is_online: true, current_patient_id: null }
  ];
  const h = table(rows, { counters });
  let tree = h.render();
  assert.equal(buttons(tree, "Call Now").length, 1, "one Call Now for the whole queue");
  const select = doctorSelect(tree);
  assert.deepEqual(nodes(select, (node) => node.type === "option").map((option) => option.props.value), ["Doctor 1", "Doctor 3"],
    "Doctor 2 is serving, so it is not offered");
  assert.equal(select.props.value, "Doctor 1");
  select.props.onChange({ target: { value: "Doctor 3" } });
  tree = h.render();
  await buttons(tree, "Call Now")[0].props.onClick();
  assert.deepEqual(h.calls, [{ route: "/queue/call", body: { patient_id: 2, counterId: "Doctor 3" } }],
    "the family planning head is called to the selected doctor");
  const labels = rowsOf(tree).map((row) => text(row.props.children[2]).trim());
  assert.deepEqual(labels, ["Doctor 2", "Next available", "Next available"], "a serving visit shows its actual doctor");
  assert.match(text(tree), /Waiting for turn/);
});

test("offline or busy doctors leave nobody to call; a stale click sends nothing", async () => {
  const counters = [
    { id_num: "Doctor 1", is_online: false, current_patient_id: null },
    { id_num: "Doctor 2", is_online: true, current_patient_id: 8 },
    { id_num: "Doctor 3", is_online: false, current_patient_id: null }
  ];
  const h = table([patient(1, "prenatal")], { counters });
  const tree = h.render();
  const call = buttons(tree, "Call Now")[0];
  assert.equal(call.props.disabled, true);
  assert.equal(text(doctorSelect(tree)), "No doctor available");
  await call.props.onClick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices[0][0], "error");
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

test("an uncalled cancellation stays in the shared lane for Undo/Re-queue until the next call", () => {
  const rows = [
    patient(1, "consultation", { status: "cancelled", completed_at: "2026-10-29T01:10:00Z" }),
    patient(2, "prenatal", { status: "serving", counter_id: "Doctor 1", called_at: "2026-10-29T01:05:00Z" })
  ];
  let tree = table(rows).render();
  assert.equal(buttons(tree, "Undo").length, 1);
  rows[1].called_at = "2026-10-29T01:20:00Z";
  tree = table(rows).render();
  assert.equal(buttons(tree, "Undo").length, 0, "hidden once a later patient is called");
});

function ticketHelpers() {
  const module = { exports: {} };
  vm.runInNewContext(ticketCode, {
    module, exports: module.exports, console, URL, Blob, Date,
    require(name) {
      if (name === "./api") return { request: async () => ({ dispatch_mode: "shared", patients: [patient(5, "maternity")] }) };
      if (name === "./branding") return { SYSTEM_BRANDING: { logoSrc: "/logo.png" } };
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
