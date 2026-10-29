const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

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

test("Call Now sends selected patient and camel-case doctor payload to call, refreshes without completing", async () => {
  const h = harness([patient(1)]);
  await buttons(h.render(), "Call Now")[0].props.onClick();
  assert.deepEqual(h.calls, [{ route: "/queue/call", method: "POST", body: { patient_id: 1, counterId: "Doctor 1" } }]);
  assert.equal(h.refreshes, 1);
  assert.match(h.notices[0][1], /called successfully/);
  assert.equal(h.props.queueRows[0].completed_at, null);
  assert.equal(h.props.queueRows[0].status, "waiting", "frontend leaves the actual transition to the backend");
});

test("two immediate clicks issue one request and show Calling/disabled until refresh finishes", async () => {
  let finish;
  const h = harness([patient(1)], { request: () => new Promise(resolve => { finish = resolve; }) });
  const button = buttons(h.render(), "Call Now")[0];
  const first = button.props.onClick();
  await button.props.onClick();
  assert.equal(h.calls.length, 1);
  const loading = buttons(h.render(), "Calling...")[0];
  assert.equal(loading.props.disabled, true);
  assert.equal(loading.props["aria-busy"], true);
  assert.equal(buttons(h.render(), "Cancel")[0].props.disabled, true);
  finish({ success: true });
  await first;
  assert.equal(buttons(h.render(), "Call Now")[0].props.disabled, false);
});

test("weighted priority and registration-time ties restrict Call Now to the eligible doctor head", async () => {
  const h = harness([patient(1, "consultation", 1), patient(2, "checkup", 4, "2026-10-10T01:02:00Z"), patient(3, "consultation", 4)]);
  const callButtons = buttons(h.render(), "Call Now");
  assert.equal(callButtons.length, 1);
  await callButtons[0].props.onClick();
  assert.equal(h.calls[0].body.patient_id, 3);
});

test("offline and occupied doctor disable calls and handlers reject stale direct clicks", async () => {
  for (const state of [{ is_online: false }, { current_patient_id: 99 }]) {
    const h = harness([patient(1)]);
    Object.assign(h.props.counters[0], state);
    const button = buttons(h.render(), "Call Now")[0];
    assert.equal(button.props.disabled, true);
    await button.props.onClick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.notices[0][0], "error");
  }
});

test("backend rejection refreshes eligibility and releases the call lock", async () => {
  const h = harness([patient(1)], { request: async () => ({ error: "Call the highest-priority patient first" }) });
  await buttons(h.render(), "Call Now")[0].props.onClick();
  assert.equal(h.refreshes, 1);
  assert.equal(h.notices[0][0], "error");
  assert.equal(buttons(h.render(), "Call Now")[0].props.disabled, false);
});

test("a pending Doctor 1 call leaves Doctor 2 and Doctor 3 independently callable", async () => {
  const releases = [];
  const h = harness([patient(1), patient(2, "prenatal"), patient(3, "family_planning")], {
    request: () => new Promise(resolve => releases.push(resolve))
  });
  const first = buttons(h.render(), "Call Now")[0].props.onClick();
  const otherButtons = buttons(h.render(), "Call Now");
  assert.equal(otherButtons.length, 2);
  assert.equal(otherButtons[0].props.disabled, false);
  const second = otherButtons[0].props.onClick();
  const third = buttons(h.render(), "Call Now")[0].props.onClick();
  assert.deepEqual(h.calls.map(call => call.body.counterId), ["Doctor 1", "Doctor 2", "Doctor 3"]);
  releases.forEach(resolve => resolve({ success: true }));
  await Promise.all([first, second, third]);
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

test("a disabled Call Now explains the doctor's occupied counter", () => {
  const h = harness([patient(1)]);
  h.props.counters[0].current_patient_id = 99;
  h.props.counters[0].current_patient_queue_number = "GP-099";
  const button = buttons(h.render(), "Call Now")[0];
  assert.equal(button.props.disabled, true);
  assert.match(button.props.title, /GP-099/);
});

test("frontdesk cancellation of a carryover visit enables today's Call Now through the real route and service", async () => {
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
  const call = buttons(h.render(), "Call Now")[0];
  assert.equal(call.props.disabled, false);
  await call.props.onClick();
  assert.equal((await backend.service.getPatientById(next.id)).status, "serving");
  assert.equal((await backend.service.getQueueOverview()).counters[0].current_patient_id, next.id);
  assert.equal(h.notices.some(([type]) => type === "error"), false);
});
