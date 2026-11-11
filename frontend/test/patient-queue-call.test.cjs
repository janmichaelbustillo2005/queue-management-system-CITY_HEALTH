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

function patient(id, service = "consultation", score = 1, created = "2026-10-10T01:00:00Z") {
  return { id, id_num: `Test ${id}`, queue_number: `GP-${id}`, service_type: service,
    status: "waiting", priority_score: score, created_at: created,
    counter_id: null, called_at: null, accepted_at: null, consultation_started_at: null,
    completed_at: null, vulnerability_flags: [] };
}

function harness(rows, options = {}) {
  const hooks = [];
  let cursor = 0;
  const calls = [], notices = [];
  let refreshes = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  const props = {
    doctors: [1, 2, 3].map(number => ({ name: `Doctor ${number}`, assignment: "Test services" })),
    counters: [1, 2, 3].map(number => ({ id_num: `Doctor ${number}`, is_online: true, current_patient_id: null })),
    queueRows: rows, queueSettings: {},
    onRefresh: async () => { refreshes++; await options.refresh?.(props); },
    onNotify: (...args) => notices.push(args), onConfirm: options.confirm || (() => {}), ...options.props
  };
  const react = {
    useMemo: callback => callback(),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    }
  };
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, Set, Map, console,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: async (route, init) => {
        calls.push({ route, method: init.method, body: JSON.parse(init.body) });
        return options.request ? options.request(route, init) : { success: true };
      } };
      if (isServicesModule(name)) return loadServices();
      if (isQueueViewModule(name)) return loadQueueView();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(props); };
  return { render, props, calls, notices, get refreshes() { return refreshes; } };
}

function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach(node => nodes(node, predicate, result));
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
const buttons = (tree, label) => nodes(tree, node => node.type === "button" && text(node) === label);

test("Patient Management offers Cancel as its only queue action: no Call, Re-Call, Undo or Re-queue", () => {
  const rows = [patient(1), patient(2),
    { ...patient(3, "prenatal"), status: "serving", counter_id: "Doctor 2", called_at: "2026-10-10T01:01:00Z", accepted_at: "2026-10-10T01:02:00Z" },
    { ...patient(4, "family_planning"), status: "cancelled", counter_id: "Doctor 3", completed_at: "2026-10-10T01:03:00Z" },
    { ...patient(5, "family_planning"), status: "no-show", counter_id: "Doctor 3", completed_at: "2026-10-10T01:04:00Z" }];
  const h = harness(rows);
  const tree = h.render();
  for (const label of ["Call", "Call Now", "Calling...", "Re-Call", "Undo", "Re-queue", "Accept", "Complete"]) {
    assert.equal(buttons(tree, label).length, 0, label);
  }
  assert.equal(nodes(tree, node => node.type === "select").length, 0, "no doctor selection for a call");
  assert.equal(buttons(tree, "Cancel").length, 2, "the Doctor 1 head and the serving patient");
  assert.deepEqual(rows.filter(row => text(tree).includes(row.id_num)).length, 5, "every registered patient stays visible");
  assert.deepEqual(h.calls, []);
});

test("weighted priority and registration-time ties keep the same doctor head for Cancel", async () => {
  let confirmation;
  const h = harness([patient(1, "consultation", 1), patient(2, "checkup", 4, "2026-10-10T01:02:00Z"), patient(3, "consultation", 4)], {
    confirm: value => { confirmation = value; }
  });
  const cancelButtons = buttons(h.render(), "Cancel");
  assert.equal(cancelButtons.length, 1);
  cancelButtons[0].props.onClick();
  await confirmation.onConfirm("Left the clinic");
  assert.equal(h.calls[0].route, "/queue/cancel");
  assert.equal(h.calls[0].body.patient_id, 3);
});

test("a doctor's completion refresh hides the active row and retains consultation timestamps in completed records", async () => {
  const serving = { ...patient(1), status: "serving", counter_id: "Doctor 1", called_at: "2026-10-10T01:01:00Z",
    accepted_at: "2026-10-10T01:02:00Z", consultation_started_at: "2026-10-10T01:03:00Z" };
  const h = harness([serving], { refresh: async props => {
    props.queueRows = [{ ...serving, status: "completed", completed_at: "2026-10-10T01:10:00Z", service_duration_seconds: 420 }];
  } });
  assert.equal(buttons(h.render(), "Call Now").length, 0);
  assert.equal(buttons(h.render(), "Complete").length, 0);
  await h.props.onRefresh();
  assert.doesNotMatch(text(h.render()), /Test 1/);
  h.props.statusFilter = "completed";
  assert.match(text(h.render()), /Test 1/);
  assert.equal(h.props.queueRows[0].consultation_started_at, serving.consultation_started_at);
  assert.equal(h.props.queueRows[0].service_duration_seconds, 420);
  assert.equal(buttons(h.render(), "Undo").length, 0);
  assert.equal(buttons(h.render(), "Re-queue").length, 0);
  assert.deepEqual(h.calls, [], "Frontdesk never submits a consultation completion");
});

test("Frontdesk monitors called, accepted and started phases without exposing consultation mutations", async () => {
  for (const [phase, label] of [
    [{ awaiting_accept: true }, "Awaiting doctor acceptance"],
    [{ awaiting_accept: false, accepted_at: "2026-10-10T01:02:00Z" }, "Ready for consultation"],
    [{ awaiting_accept: false, accepted_at: "2026-10-10T01:02:00Z", consultation_started_at: "2026-10-10T01:03:00Z" }, "Consultation in progress"]
  ]) {
    const h = harness([{ ...patient(1), status: "serving", counter_id: "Doctor 1",
      called_at: "2026-10-10T01:01:00Z", ...phase }]);
    assert.ok(text(h.render()).includes(label));
    for (const action of ["Call Now", "Accept", "Start Consultation", "Complete", "Complete Consultation"])
      assert.equal(buttons(h.render(), action).length, 0);
    assert.equal(buttons(h.render(), "Cancel").length, 1);
    assert.deepEqual(h.calls, []);
    assert.equal(h.props.queueRows[0].status, "serving");
    assert.equal(h.props.queueRows[0].completed_at, null);
  }
});

test("Frontdesk cancellation retains the existing reason and doctor payload during consultation", async () => {
  let confirmation;
  const h = harness([{ ...patient(1), status: "serving", counter_id: "Doctor 1",
    called_at: "2026-10-10T01:01:00Z", accepted_at: "2026-10-10T01:02:00Z",
    consultation_started_at: "2026-10-10T01:03:00Z" }], { confirm: value => { confirmation = value; } });
  buttons(h.render(), "Cancel")[0].props.onClick();
  assert.equal(confirmation.requireReason, true);
  await confirmation.onConfirm("Patient requested cancellation");
  assert.deepEqual(h.calls, [{ route: "/queue/cancel", method: "POST", body: {
    patient_id: 1, reason: "Patient requested cancellation", counter_id: "Doctor 1"
  } }]);
  assert.equal(h.refreshes, 1);
  assert.equal(h.props.queueRows[0].completed_at, null, "only backend refresh can change patient timestamps");
});

test("Frontdesk shows the carryover visit blocking today's call and can cancel it explicitly", async () => {
  let confirmation;
  const previous = { ...patient(1), status: "serving", counter_id: "Doctor 1", called_at: "2026-10-09T01:00:00Z", awaiting_accept: true };
  const h = harness([previous, patient(2)], { confirm: value => { confirmation = value; } });
  h.props.counters[0].current_patient_id = previous.id;
  const tree = h.render();
  assert.ok(text(tree).includes("Test 1"));
  assert.ok(text(tree).includes("Serving GP-1"));
  assert.equal(buttons(tree, "Call Now").length, 0);
  buttons(tree, "Cancel")[0].props.onClick();
  await confirmation.onConfirm("Previous visit did not proceed");
  assert.equal(h.calls[0].body.patient_id, previous.id);
});

test("an unassigned serving patient stays visible and blocks the next call until explicitly cancelled", async () => {
  let confirmation;
  const h = harness([{ ...patient(1), status: "serving", counter_id: null }, patient(2)], {
    confirm: value => { confirmation = value; }
  });
  assert.ok(text(h.render()).includes("Test 1"));
  assert.ok(text(h.render()).includes("Serving 1"));
  assert.equal(buttons(h.render(), "Call Now").length, 0);
  buttons(h.render(), "Cancel")[0].props.onClick();
  await confirmation.onConfirm("Resolve legacy unassigned visit");
  assert.deepEqual(h.calls[0].body, { patient_id: 1, counter_id: "Doctor 1", reason: "Resolve legacy unassigned visit" });
});

test("active search finds patients beyond the first 20 without letting them bypass queue priority", () => {
  const h = harness(Array.from({ length: 25 }, (_, index) => patient(index + 1)));
  h.props.search = "Test 25";
  assert.ok(text(h.render()).includes("Test 25"));
  assert.equal(buttons(h.render(), "Call Now").length, 0);
});

test("frontdesk cancellation of a carryover visit frees the doctor to call today's patient through the real route and service", async () => {
  const { createHarness } = require("../../backend/test/helpers/queueHarness");
  const backend = createHarness();
  const previous = await backend.service.createQueueEntry({ idNum: "Previous visit", serviceType: "checkup", vulnerabilityFlags: [] });
  await backend.service.callPatient(previous.id, "Doctor 1");
  backend.advance(24 * 60 * 60 * 1000);
  const next = await backend.service.createQueueEntry({ idNum: "Today's visit", serviceType: "checkup", vulnerabilityFlags: [] });
  const overview = await backend.service.getQueueOverview();
  let confirmation;
  const h = harness(overview.patients, {
    props: { counters: overview.counters },
    confirm: value => { confirmation = value; },
    request: async (route, init) => {
      const response = await backend.request(init.method, route, JSON.parse(init.body), {
        id_num: "frontdesk", role: "admin", doctor_name: null
      });
      return response.status === 200 ? response.body : { error: response.body.message };
    },
    refresh: async props => {
      const refreshed = await backend.service.getQueueOverview();
      props.queueRows = refreshed.patients;
      props.counters = refreshed.counters;
    }
  });

  assert.equal(buttons(h.render(), "Call Now").length, 0);
  buttons(h.render(), "Cancel")[0].props.onClick();
  await confirmation.onConfirm("Previous visit did not proceed");
  assert.equal(buttons(h.render(), "Call Now").length, 0);
  const frontdesk = await backend.request("POST", "/queue/call", { patient_id: next.id }, { id_num: "frontdesk", role: "admin", doctor_name: null });
  assert.equal(frontdesk.status, 403);
  const called = await backend.request("POST", "/queue/call", { patient_id: next.id }, { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" });
  assert.equal(called.status, 200, called.body.message);
  assert.equal((await backend.service.getPatientById(next.id)).status, "serving");
  assert.equal((await backend.service.getQueueOverview()).counters[0].current_patient_id, next.id);
  assert.equal(h.notices.some(([type]) => type === "error"), false);
});

// Synchronized with Superadmin Queue Management (see queue-view-fixture.cjs): same columns,
// same cell values for the same record, same counters. Actions stay this page's own.
const viewFixture = require("./queue-view-fixture.cjs");
const tableRow = (tree, queueNumber) => nodes(tree, node => node.type === "tr" &&
  nodes(node, child => child.type === "span" && text(child) === queueNumber).length > 0)[0];

test("Patient Management shows the shared columns, including the registration Time, before its own Actions", () => {
  const tree = harness(viewFixture.ROWS, { props: { statusFilter: "all" } }).render();
  assert.deepEqual(nodes(tree, node => node.type === "th").map(node => text(node)), viewFixture.HEADERS);
  assert.equal(nodes(tree, node => node.type === "col").length, viewFixture.HEADERS.length);
});

test("Patient Management shows each record's queue, patient, doctor, service, priority, status and time as Queue Management does", () => {
  const tree = harness(viewFixture.ROWS, { props: { statusFilter: "all" } }).render();
  for (const [queueNumber, expected] of Object.entries(viewFixture.EXPECTED)) {
    assert.deepEqual(viewFixture.readCells(tableRow(tree, queueNumber), { text, nodes }), expected, queueNumber);
  }
});

test("Patient Management counters count Waiting, Serving, Completed and Cancelled from the loaded records", () => {
  const h = harness(viewFixture.ROWS);
  const counters = () => Object.fromEntries(nodes(h.render(), node => node.props?.["data-counter"])
    .map(node => [node.props["data-counter"], Number(text(node).replace(/\D+/g, ""))]));
  assert.deepEqual(counters(), viewFixture.COUNTS);
  h.props.queueRows = viewFixture.ROWS.map(row => row.id === 7 ? { ...row, status: "serving", counter_id: "Doctor 1" } : row);
  assert.deepEqual(counters(), { ...viewFixture.COUNTS, waiting: 0, serving: 2 }, "a status change updates the counters");
});

test("Patient Management keeps its own actions: View Ticket and head-only Cancel, nothing from Queue Management", () => {
  const tree = harness(viewFixture.ROWS, { props: { statusFilter: "all", onViewTicket() {} } }).render();
  assert.equal(buttons(tree, "View Ticket").length, 3);
  assert.equal(buttons(tree, "Cancel").length, 1, "only the serving head of Doctor 1 (its waiting patient waits for its turn)");
  for (const label of ["Call", "Undo", "Re-queue"]) assert.equal(buttons(tree, label).length, 0, label);
  assert.equal(nodes(tree, node => node.props?.title === "More actions").length, 0, "no Superadmin three-dot menu");
  assert.equal(nodes(tree, node => typeof node.type === "string" && /^Transfer to/.test(text(node)) && node.type === "button").length, 0);
});

test("EP1: Front Desk shows the doctor's display name while actions keep the counter id", () => {
  const rows = [{ ...patient(1), status: "waiting", counter_id: "Doctor 1" }];
  const h = harness(rows, { props: { doctorNames: { "Doctor 1": "Dr. Juan Dela Cruz" } } });
  const content = text(h.render());
  assert.match(content, /Dr\. Juan Dela Cruz/);
  assert.doesNotMatch(content, /Doctor 1(?!\d)/, "the counter id is not shown where a display name exists");
  const plain = text(harness(rows).render());
  assert.match(plain, /Doctor 1/, "without display names the counter id is shown, as before");
});
