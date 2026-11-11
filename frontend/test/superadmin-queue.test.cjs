const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");
const { isQueueViewModule, loadQueueView } = require("./queue-view-module.cjs");

let componentCode;
let presenceHelpers;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../pages/index.js");
  const result = await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  });
  componentCode = result.code;
  const presenceFilename = path.join(__dirname, "../lib/doctorPresence.js");
  const helpers = await swc.transform(fs.readFileSync(presenceFilename, "utf8"), {
    filename: presenceFilename, jsc: { parser: { syntax: "ecmascript" } }, module: { type: "commonjs" }
  });
  const helperModule = { exports: {} };
  vm.runInNewContext(helpers.code, { module: helperModule, exports: helperModule.exports });
  presenceHelpers = helperModule.exports;
});

function patient(id, service = "consultation", score = 1, created = "2026-10-10T01:00:00Z") {
  return { id, id_num: `Test patient ${id}`, queue_number: `TEST-${id}`, service_type: service,
    status: "waiting", priority_score: score, created_at: created,
    counter_id: null, called_at: null, accepted_at: null, consultation_started_at: null,
    completed_at: null, awaiting_accept: false, vulnerability_flags: [], confirmed_at: created, confirmed_by: "frontdesk" };
}
function doctor(number, state = {}) {
  return { id: number, id_num: `Doctor ${number}`, is_online: true, current_patient_id: null, ...state };
}
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(initialRows, options = {}) {
  const hooks = [], effectDeps = [], effects = [], calls = [], cleanups = [];
  const windowListeners = new Map(), intervals = new Map(), timeouts = new Map(), navigations = [];
  let timerId = 0;
  let cursor = 0;
  const backend = { patients: clone(initialRows), counters: clone(options.counters || [doctor(1), doctor(2), doctor(3)]), ...clone(options.backendExtra || {}) };
  const settings = { showCompleted: true, maxQueues: 100, autoRefresh: false,
    doctor1Online: true, doctor2Online: true, doctor3Online: true, ...options.settings };
  const user = { id_num: "superadmin", role: "superadmin" };
  const router = { isReady: true, query: { section: options.section || "queue" }, push(...args) {
    navigations.push(args);
    if (args[0]?.query) router.query = { ...args[0].query };
    return Promise.resolve(true);
  } };
  const timerApi = {
    setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); }
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useMemo(callback) { cursor++; return callback(); },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = effectDeps[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        effectDeps[index] = deps;
        effects.push({ index, callback });
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, Set, Map, console, AbortController,
    document: { addEventListener() {}, removeEventListener() {} },
    window: {
      confirm: () => true, prompt: () => options.cancelReason === undefined ? "Test cancellation reason" : options.cancelReason,
      ...timerApi,
      addEventListener(name, callback) {
        if (!windowListeners.has(name)) windowListeners.set(name, new Set());
        windowListeners.get(name).add(callback);
      },
      removeEventListener(name, callback) { windowListeners.get(name)?.delete(callback); }
    }, confirm: () => true,
    ...timerApi,
    fetch: async () => ({ json: async () => [] }),
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link") return () => {};
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../context/AuthContext") return { useAuth: () => ({ user, loading: false }) };
      if (name === "../components/SiteFrame") return () => {};
      if (name === "../components/SettingsModal") return { __esModule: true, default: () => {}, defaultQueueSettings: settings };
      if (name === "../components/StaffArchives") return { StaffArchivesModal: () => null, StaffConfirmDialog: () => null };
      if (name === "../components/StaffProfileDialog") return { StaffProfileDialog: () => null };
      if (name === "../lib/queueSettings") return {
        loadLocalQueueSettings: () => settings, fetchQueueSettings: async () => settings,
        applyCounterAvailability: value => value, clearActiveQueues: async () => ({ success: true }),
        exportQueueData: async () => {}, saveQueueSettings: async value => value
      };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        calls.push({ route, method: init.method || "GET", ...(init.body ? { body: JSON.parse(init.body) } : {}) });
        if (route === "/queue" && !init.method) return clone(backend);
        if (route === "/stats") return { data: {} };
        if (route === "/doctors/presence") return { success: true, doctors: [1, 2, 3].map(number => ({
          doctor_name: `Doctor ${number}`, online: true, last_seen_at: new Date().toISOString()
        })), observed_at: new Date().toISOString(), timeout_seconds: 75 };
        return options.request ? options.request(route, init, backend) : { success: true };
      } };
      if (name === "../lib/doctorPresence") return presenceHelpers;
      if (isServicesModule(name)) return loadServices();
      if (isQueueViewModule(name)) return loadQueueView();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(); };
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      render();
      effects.splice(0).forEach(({ index, callback }) => {
        cleanups[index]?.();
        cleanups[index] = callback();
      });
      await tick();
    }
    return render();
  };
  await flush();
  const baselineReads = calls.filter(call => call.route === "/queue" && call.method === "GET").length;
  return {
    render, flush, calls, backend, router, navigations, intervals,
    dispatchWindow(name, event) {
      for (const callback of windowListeners.get(name) || []) callback(event);
    },
    unmount() { cleanups.forEach(cleanup => typeof cleanup === "function" && cleanup()); },
    get actions() { return calls.filter(call => call.method === "POST" && call.route.startsWith("/queue/")); },
    get refreshes() { return calls.filter(call => call.route === "/queue" && call.method === "GET").length - baselineReads; },
    get rows() { return clone(hooks.find(value => Array.isArray(value) && value.some(row => row?.id_num && "status" in row)) || []); }
  };
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
const buttons = (tree, label) => nodes(tree, node => node.type === "button" && text(node).trim() === label);
const row = (tree, id) => nodes(tree, node => node.type === "tr" &&
  nodes(node, child => child.type === "span" && text(child) === `TEST-${id}`).length > 0)[0];
const callButton = (tree, id) => buttons(row(tree, id), "Call")[0];
function serving(id, state = {}) {
  return { ...patient(id), status: "serving", counter_id: "Doctor 1", called_at: "2026-10-10T01:01:00Z", ...state };
}

test("Superadmin Call uses selected patient and mapped counter, leaving the transition to the backend", async () => {
  let finish;
  const h = await harness([patient(1)], { request: () => new Promise(resolve => { finish = resolve; }) });
  const before = h.rows;
  const pending = callButton(h.render(), 1).props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/call", method: "POST", body: { patient_id: 1, counterId: "Doctor 1" } }]);
  assert.deepEqual(h.rows, before, "pending call must not fabricate serving status or timestamps");
  finish({ success: true });
  await pending;
  await h.flush();
  assert.deepEqual(h.rows, before, "refresh is the source of truth even after a success response");
  assert.equal(h.refreshes, 1);
});

test("Superadmin selects one weighted-priority head per doctor with registration time and ID tie breaks", async () => {
  const h = await harness([
    patient(1, "checkup", 1), patient(10, "consultation", 4),
    patient(8, "checkup", 4, "2026-10-10T00:59:00Z"), patient(7, "consultation", 4, "2026-10-10T00:59:00Z"),
    patient(20, "prenatal", 2), patient(21, "maternity", 1), patient(30, "family_planning", 1)
  ]);
  const tree = h.render();
  assert.equal(buttons(tree, "Call").length, 3);
  for (const id of [1, 10, 8, 21]) assert.equal(callButton(tree, id), undefined);
  for (const id of [7, 20, 30]) await callButton(h.render(), id).props.onClick();
  assert.deepEqual(h.actions.map(action => action.body), [
    { patient_id: 7, counterId: "Doctor 1" },
    { patient_id: 20, counterId: "Doctor 2" },
    { patient_id: 30, counterId: "Doctor 3" }
  ]);
});

test("Superadmin offline and occupied doctors cannot be called, including stale direct handler clicks", async () => {
  for (const state of [{ is_online: false }, { current_patient_id: 99 }]) {
    const h = await harness([patient(1)], { counters: [doctor(1, state), doctor(2), doctor(3)] });
    const button = callButton(h.render(), 1);
    assert.equal(button.props.disabled, true);
    await button.props.onClick();
    assert.equal(h.actions.length, 0);
    assert.match(text(h.render()), /offline|unavailable|occupied|serving|busy/i);
  }
});

test("Superadmin prevents a second same-doctor call when a serving row conflicts with a cleared counter pointer", async () => {
  const h = await harness([patient(1), serving(99)]);
  const button = callButton(h.render(), 1);
  assert.equal(button.props.disabled, true);
  await button.props.onClick();
  assert.equal(h.actions.length, 0);
});

test("Superadmin duplicate clicks are locked immediately and other doctors stay independently callable", async () => {
  const releases = [];
  const h = await harness([patient(1), patient(2, "prenatal"), patient(3, "family_planning")], {
    request: () => new Promise(resolve => releases.push(resolve))
  });
  const firstButton = callButton(h.render(), 1);
  const first = firstButton.props.onClick();
  const duplicate = firstButton.props.onClick();
  assert.equal(h.actions.length, 1);
  await duplicate;
  const loading = nodes(row(h.render(), 1), node => node.type === "button" && /calling|call\.\.\./i.test(text(node)))[0];
  assert.ok(loading, "pending call should show its loading state");
  assert.equal(loading.props.disabled, true);
  assert.equal(buttons(row(h.render(), 1), "Cancel")[0].props.disabled, true);
  const secondButton = callButton(h.render(), 2), thirdButton = callButton(h.render(), 3);
  assert.equal(secondButton.props.disabled, false);
  assert.equal(thirdButton.props.disabled, false);
  const second = secondButton.props.onClick(), third = thirdButton.props.onClick();
  assert.deepEqual(h.actions.map(action => action.body.counterId), ["Doctor 1", "Doctor 2", "Doctor 3"]);
  releases.forEach(resolve => resolve({ success: true }));
  await Promise.all([first, second, third]);
  assert.equal(callButton(h.render(), 1).props.disabled, false);
});

test("Superadmin displays API errors, refreshes authoritative state, and releases the action lock", async () => {
  const h = await harness([patient(1)], { request: async () => ({ error: "Call the highest-priority patient first" }) });
  const before = h.rows;
  await callButton(h.render(), 1).props.onClick();
  await h.flush();
  assert.match(text(h.render()), /Call the highest-priority patient first/);
  assert.deepEqual(h.rows, before);
  assert.equal(h.rows[0].completed_at, null);
  assert.equal(h.rows[0].called_at, null);
  assert.equal(h.refreshes, 1);
  assert.equal(callButton(h.render(), 1).props.disabled, false);
});

test("Superadmin monitors called, accepted and started phases without consultation completion controls", async () => {
  for (const [phase, label] of [
    [{ awaiting_accept: true }, "Awaiting doctor acceptance"],
    [{ awaiting_accept: false, accepted_at: "2026-10-10T01:02:00Z" }, "Ready for consultation"],
    [{ awaiting_accept: false, accepted_at: "2026-10-10T01:02:00Z", consultation_started_at: "2026-10-10T01:03:00Z" }, "Consultation in progress"]
  ]) {
    const h = await harness([serving(1, phase)], { counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)] });
    const patientRow = row(h.render(), 1);
    assert.ok(text(patientRow).includes(label));
    for (const action of ["Call", "Accept", "Start Consultation", "Complete", "Complete Consultation"])
      assert.equal(buttons(patientRow, action).length, 0);
    assert.equal(buttons(patientRow, "Cancel").length, 1);
    assert.equal(h.actions.length, 0);
    assert.equal(h.rows[0].status, "serving");
    assert.equal(h.rows[0].completed_at, null);
  }
});

test("Superadmin Cancel waits for server state before and during consultation without inventing timestamps", async () => {
  for (const consultation_started_at of [null, "2026-10-10T01:03:00Z"]) {
    let finish;
    const h = await harness([serving(1, { accepted_at: "2026-10-10T01:02:00Z", consultation_started_at })], {
      counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)],
      request: () => new Promise(resolve => { finish = resolve; })
    });
    const before = h.rows;
    const pending = buttons(row(h.render(), 1), "Cancel")[0].props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/cancel", method: "POST", body:
      { patient_id: 1, reason: "Test cancellation reason", counter_id: "Doctor 1" } }]);
    assert.deepEqual(h.rows, before, "Cancel must preserve state while pending");
    finish({ error: "Cancel rejected by server" });
    await pending;
    await h.flush();
    assert.deepEqual(h.rows, before);
    assert.match(text(h.render()), /Cancel rejected by server/);
    assert.equal(h.refreshes, 1);
  }
});

test("Superadmin legacy completed-record Undo preserves history until the backend refresh confirms the transition", async () => {
  let finish;
  const completed = { ...serving(1), status: "completed", completed_at: "2026-10-10T01:10:00Z" };
  const h = await harness([completed], { request: () => new Promise(resolve => { finish = resolve; }) });
  nodes(row(h.render(), 1), node => node.type === "button" && node.props.title === "More actions")[0].props.onClick();
  const before = h.rows;
  buttons(row(h.render(), 1), "Undo")[0].props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/undo", method: "POST", body: { patient_id: 1 } }]);
  assert.deepEqual(h.rows, before);
  finish({ error: "Undo rejected by server" });
  await tick();
  await h.flush();
  assert.deepEqual(h.rows, before);
  assert.match(text(h.render()), /Undo rejected by server/);
  assert.equal(h.refreshes, 1);
});

test("Superadmin retains genuine completed consultation history without Undo or Re-queue actions", async () => {
  const completed = { ...serving(1), status: "completed", accepted_at: "2026-10-10T01:02:00Z",
    consultation_started_at: "2026-10-10T01:03:00Z", completed_at: "2026-10-10T01:10:00Z", service_duration_seconds: 420 };
  const h = await harness([completed]);
  const patientRow = row(h.render(), 1);
  assert.ok(patientRow, "completed consultation remains visible in history-enabled monitoring");
  assert.match(text(patientRow), /completed/);
  assert.equal(nodes(patientRow, node => node.type === "button" && node.props.title === "More actions").length, 0);
  for (const action of ["Undo", "Re-queue", "Complete", "Complete Consultation"])
    assert.equal(buttons(patientRow, action).length, 0);
  assert.deepEqual(h.rows, [completed]);
  assert.equal(h.actions.length, 0);

  const activeOnly = await harness([completed], { settings: { showCompleted: false } });
  assert.equal(row(activeOnly.render(), 1), undefined, "existing monitoring history filter still hides completed records");
  assert.deepEqual(activeOnly.rows, [completed], "filtering must not delete completed history");
});

test("Superadmin Cancel requires a nonempty reason and a dismissed prompt leaves the patient untouched", async () => {
  for (const cancelReason of [null, "", "   "]) {
    const h = await harness([patient(1)], { cancelReason });
    const before = h.rows;
    await buttons(row(h.render(), 1), "Cancel")[0].props.onClick();
    assert.equal(h.actions.length, 0);
    assert.deepEqual(h.rows, before);
  }
});

test("Superadmin counter cards show schema-backed doctor identity and resolve the active patient pointer", async () => {
  const h = await harness([serving(1)], { counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)] });
  const tree = h.render();
  assert.deepEqual(nodes(tree, node => node.type === "h4").map(text), ["Doctor 1", "Doctor 2", "Doctor 3"]);
  assert.ok(nodes(tree, node => node.type === "div" && /Serving:/.test(text(node)) &&
    nodes(node, child => child.type === "span" && text(child) === "Test patient 1").length > 0).length);
});

test("Superadmin reports orphan legacy serving rows as inconsistent and blocks misleading completion", async () => {
  const h = await harness([serving(1, { counter_id: null, called_at: null })]);
  const patientRow = row(h.render(), 1);
  assert.match(text(patientRow), /inconsistent|assignment|not assigned|unassigned|needs review/i);
  const complete = buttons(patientRow, "Complete")[0];
  if (complete) {
    assert.equal(complete.props.disabled, true);
    await complete.props.onClick();
  }
  assert.equal(h.actions.length, 0);
  assert.equal(h.rows[0].status, "serving", "UI must not silently repair existing live records");
});

test("Superadmin registration renders only the backend-created waiting record without a temporary callable patient", async () => {
  let finish;
  const h = await harness([], { request: () => new Promise(resolve => { finish = resolve; }) });
  buttons(h.render(), "Add Patient")[0].props.onClick();
  nodes(h.render(), node => node.type === "input" && node.props.placeholder === "Enter full name")[0]
    .props.onChange({ target: { value: "Registered patient" } });
  nodes(h.render(), node => node.type === "select" &&
    nodes(node, child => child.type === "option" && child.props.value === "medical_consultation").length)[0]
    .props.onChange({ target: { value: "family_planning" } });
  const registrationForm = nodes(h.render(), node => node.type === "form" &&
    nodes(node, child => child.type === "input" && child.props.placeholder === "Enter full name").length)[0];
  registrationForm.props.onSubmit({ preventDefault() {} });
  const registration = h.calls.filter(call => call.route === "/queue" && call.method === "POST");
  assert.equal(registration.length, 1);
  assert.equal(registration[0].body.fullName, "Registered patient");
  assert.equal(registration[0].body.service_type, "family_planning");
  assert.deepEqual(h.rows, [], "no optimistic patient should enter the calling workflow");
  const created = { ...patient(1, "family_planning"), id_num: "Registered patient" };
  h.backend.patients = [created];
  finish({ success: true, queue_number: created.queue_number, priority_score: 1 });
  await tick();
  await h.flush();
  assert.deepEqual(h.rows, [created]);
  assert.equal(h.rows[0].status, "waiting");
  assert.equal(h.rows[0].counter_id, null);
  assert.equal(h.rows[0].called_at, null);
  assert.equal(h.rows[0].completed_at, null);
  assert.equal(h.refreshes, 1);
});

test("Superadmin registration offers Family Planning and previews the existing backend senior/pregnant weights", async () => {
  const h = await harness([]);
  buttons(h.render(), "Add Patient")[0].props.onClick();
  assert.equal(nodes(h.render(), node => node.type === "option" && node.props.value === "family_planning").length, 1);
  const toggle = label => {
    const option = nodes(h.render(), node => node.type === "label" && text(node).startsWith(label))[0];
    nodes(option, node => node.type === "input" && node.props.type === "checkbox")[0].props.onChange();
  };
  toggle("Senior Citizen");
  assert.match(text(h.render()), /Score:\s*4/);
  toggle("Pregnant");
  assert.match(text(h.render()), /Score:\s*7/);
});

function manualEntry(h) {
  return nodes(h.render(), node => node.type === "form" &&
    nodes(node, child => child.type === "input" && child.props.placeholder === "Enter full name").length)[0];
}
function manualField(h, predicate) {
  return nodes(manualEntry(h), node => ["input", "select"].includes(node.type) && predicate(node))[0];
}
async function fillManualEntry(h) {
  buttons(h.render(), "Add Patient")[0].props.onClick();
  const change = (predicate, value) => manualField(h, predicate).props.onChange({ target: { value } });
  change(node => node.props.placeholder === "Enter full name", "Synthetic Registration Patient");
  change(node => node.type === "select" && nodes(node, child => child.props?.value === "maternal_healthcare").length, "maternal_healthcare");
  change(node => node.props.placeholder === "9123456789", "9123456789");
  change(node => node.props.placeholder === "Enter PhilHealth ID", "SYNTHETIC-ID");
  change(node => node.props.type === "date", "1990-01-02");
  change(node => node.type === "select" && nodes(node, child => child.props?.value === "Female").length, "Female");
  change(node => node.props.placeholder === "Search address...", "Synthetic Development Address");
  const pregnant = nodes(manualEntry(h), node => node.type === "label" && text(node).startsWith("Pregnant"))[0];
  nodes(pregnant, node => node.type === "input")[0].props.onChange();
  await h.flush();
}
function manualValues(h) {
  return clone(nodes(manualEntry(h), node => ["input", "select"].includes(node.type))
    .map(node => ({ type: node.type, value: node.props.value, checked: node.props.checked })));
}
function unloadEvent(h) {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  h.dispatchWindow("beforeunload", event);
  return event;
}

test("Superadmin warns on reload only for unsaved entry and removes the warning on unmount", async () => {
  const h = await harness([]);
  assert.equal(unloadEvent(h).prevented, false, "pristine page must not block reload");
  await fillManualEntry(h);
  const dirty = unloadEvent(h);
  assert.equal(dirty.prevented, true);
  assert.ok(dirty.returnValue === "" || dirty.returnValue === true,
    "browser unload warning requires returnValue as well as preventDefault");
  h.unmount();
  assert.equal(unloadEvent(h).prevented, false, "unmounted page must remove its listener");
});

test("Superadmin queue and presence polling preserve the open entry and every patient field", async () => {
  const h = await harness([], { settings: { autoRefresh: true, refreshInterval: 5 } });
  await fillManualEntry(h);
  const before = manualValues(h);
  const beforeNavigations = h.navigations.length;
  for (const interval of Array.from(h.intervals.values())) await interval.callback();
  await h.flush();
  assert.ok(manualEntry(h), "polling must leave the entry form open");
  assert.deepEqual(manualValues(h), before);
  assert.equal(h.navigations.length, beforeNavigations);
  assert.equal(h.calls.some(call => call.route === "/queue" && call.method === "POST"), false);
  assert.ok(h.refreshes > 0, "queue polling actually ran");
  assert.ok(h.calls.filter(call => call.route === "/doctors/presence").length > 1, "presence polling actually ran");
});

test("Superadmin pending and failed registration keep all entered fields visible and block duplicate submits", async () => {
  let finish;
  const h = await harness([], { request: () => new Promise(resolve => { finish = resolve; }) });
  await fillManualEntry(h);
  const before = manualValues(h);
  const submit = manualEntry(h).props.onSubmit;
  const staleCancel = buttons(h.render(), "Cancel")[0].props.onClick;
  const first = submit({ preventDefault() {} });
  const duplicate = submit({ preventDefault() {} });
  assert.equal(h.calls.filter(call => call.route === "/queue" && call.method === "POST").length, 1);
  assert.ok(manualEntry(h), "entry must remain open until the server confirms success");
  assert.deepEqual(manualValues(h), before);
  for (const control of nodes(manualEntry(h), node => ["input", "select", "button"].includes(node.type))) {
    assert.equal(control.props.disabled, true, "pending registration controls must prevent edits and repeated clicks");
  }
  assert.equal(buttons(h.render(), "Cancel")[0].props.disabled, true);
  staleCancel();
  assert.ok(manualEntry(h), "a stale Cancel handler cannot hide a pending registration");
  assert.deepEqual(manualValues(h), before);
  finish({ error: "Synthetic development registration failure" });
  await Promise.all([first, duplicate]);
  await h.flush();
  assert.ok(manualEntry(h), "failed registration must remain open");
  assert.deepEqual(manualValues(h), before);
  assert.match(text(h.render()), /Synthetic development registration failure/);
  assert.equal(nodes(manualEntry(h), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, false);
  assert.equal(buttons(h.render(), "Cancel")[0].props.disabled, false);
  assert.equal(unloadEvent(h).prevented, true);
});

test("Superadmin successful registration closes and clears entry only after save and removes unload warning", async () => {
  let finish;
  const h = await harness([], { request: () => new Promise(resolve => { finish = resolve; }) });
  await fillManualEntry(h);
  const submit = manualEntry(h).props.onSubmit({ preventDefault() {} });
  assert.ok(manualEntry(h));
  finish({ success: true, queue_number: "OB-SYNTHETIC", priority_score: 3 });
  await submit;
  await h.flush();
  assert.equal(manualEntry(h), undefined);
  assert.equal(unloadEvent(h).prevented, false, "saved patient must not leave a dirty-entry warning");
  buttons(h.render(), "Add Patient")[0].props.onClick();
  for (const control of nodes(manualEntry(h), node => ["input", "select"].includes(node.type))) {
    if (control.props.type === "checkbox") assert.equal(control.props.checked, false);
    else assert.equal(control.props.value, "");
  }
  const payload = h.calls.find(call => call.route === "/queue" && call.method === "POST").body;
  assert.deepEqual(payload, {
    fullName: "Synthetic Registration Patient", service_type: "maternal_healthcare", mobile_number: "9123456789",
    residency: "Synthetic Development Address", philhealth_id: "SYNTHETIC-ID", birthdate: "1990-01-02",
    sex: "Female", vulnerabilityFlags: ["pregnant"]
  });
});

test("Superadmin dashboard shows the section named in the URL, so links, history and reload agree", async () => {
  const h = await harness([], { section: "home" });
  const sections = () => nodes(h.render(), node => /\bmax-w-6xl\b/.test(node.props?.className || "") && /\bcontainer\b/.test(node.props.className));
  const shown = () => sections().map(node => !/\bhidden\b/.test(node.props.className));
  assert.equal(h.render().props.title, undefined);
  // Section containers in page order: home, staff, queue. (Staff loads accounts this harness does not serve.)
  assert.deepEqual(shown(), [true, false, false]);
  for (const [section, title, visible] of [
    ["queue", undefined, [false, false, true]],
    ["unknown-value", undefined, [true, false, false]],
    ["queue", undefined, [false, false, true]]
  ]) {
    h.router.query = { section };
    await h.flush();
    assert.equal(h.render().props.title, title, section);
    assert.deepEqual(shown(), visible, section);
  }
  assert.equal(h.navigations.length, 0, "the page follows the URL instead of rewriting it");
});

// RR1 round-robin dispatch (dispatch_strategy "round_robin"): the backend assigns doctors; staff
// monitor, never call, and may transfer a consultation whose doctor signed out.
function roundRobin(dispatch = {}, adjust = () => {}) {
  const value = { dispatch_mode: "shared", dispatch_strategy: "round_robin", dispatch: {
    available: true, all_unavailable: false, interventions: [], history: [], doctors: [1, 2, 3].map((number) => ({
      doctor_name: `Doctor ${number}`, enabled: true, signed_in: true, last_seen_at: "2026-10-10T01:00:00Z",
      serving_patient_id: null, waiting_count: 0, eligible: true })), ...dispatch } };
  adjust(value.dispatch.doctors);
  return value;
}

test("RR1: staff see each visit's assigned doctor and reassignment, and have no Call action", async () => {
  const assigned = { ...patient(2, "prenatal", 1, "2026-10-10T01:02:00Z"), counter_id: "Doctor 2" };
  const h = await harness([assigned, patient(3, "checkup", 1, "2026-10-10T01:03:00Z")], { backendExtra: roundRobin(
    { next_doctor: "Doctor 3", history: [{ patient_id: 2, reason: "doctor_unavailable" }, { patient_id: 2, reason: "round_robin_reassignment" }] },
    (doctors) => { doctors[1].waiting_count = 1; }) });
  const tree = await h.flush();
  const content = text(tree);
  assert.match(content, /Assigned to Doctor 2, waiting for the doctor to call/);
  assert.match(content, /Waiting for an available doctor/);
  assert.match(content, /Reassigned/);
  // Each doctor shows its own waiting list size; a busy doctor still takes its turn.
  assert.match(text(nodes(tree, (node) => node.props?.["data-rr-waiting"] === "Doctor 2")[0]), /Assigned, waiting: 1$/);
  assert.match(text(nodes(tree, (node) => node.props?.["data-rr-waiting"] === "Doctor 3")[0]), /Assigned, waiting: 0 · Next in rotation/);
  assert.equal(nodes(tree, (node) => node.type === "button" && /Call/.test(text(node))).length, 0);
});

test("RR1: all doctors unavailable and an active consultation needing intervention are both announced", async () => {
  const h = await harness([serving(1, { consultation_started_at: "2026-10-10T01:02:00Z" })], {
    counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)],
    backendExtra: roundRobin({ all_unavailable: true, interventions: [{ patient_id: 1, doctor: "Doctor 1" }] },
      (doctors) => doctors.forEach((item) => { item.signed_in = false; item.eligible = false; })) });
  const tree = await h.flush();
  assert.equal(nodes(tree, (node) => node.props?.["data-rr-all-unavailable"] !== undefined).length, 1);
  assert.match(text(nodes(tree, (node) => node.props?.["data-rr-intervention"] !== undefined)[0]), /Doctor 1 signed out during an active consultation \(TEST-1\)/);
  assert.match(text(tree), /Doctor signed out\. Needs staff review/);
  assert.equal(nodes(tree, (node) => node.type === "button" && /Transfer to/.test(text(node))).length, 0, "no signed-in doctor to transfer to");
});

test("RR1: a consultation is transferred only to a signed-in, free doctor, through POST /queue/transfer", async () => {
  const h = await harness([serving(1, { consultation_started_at: "2026-10-10T01:02:00Z" })], {
    counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)],
    backendExtra: roundRobin({ interventions: [{ patient_id: 1, doctor: "Doctor 1" }] }, (doctors) => {
      Object.assign(doctors[0], { signed_in: false, serving_patient_id: 1, eligible: false });
      Object.assign(doctors[2], { serving_patient_id: 9, eligible: false });
    }) });
  const tree = await h.flush();
  const transfers = nodes(tree, (node) => node.type === "button" && /Transfer to/.test(text(node)));
  assert.deepEqual(transfers.map((node) => text(node).trim()), ["Transfer to Doctor 2"]);
  await transfers[0].props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/transfer", method: "POST", body: { patient_id: 1, doctor: "Doctor 2" } }]);
  assert.ok(h.refreshes >= 1);
});

test("RR1: Patient Management shows the readable service name, never the stored key alone", async () => {
  const h = await harness([patient(4, "family_planning")], { backendExtra: roundRobin() });
  const cells = nodes(h.render(), (node) => node.type === "span" && node.props.title === "family_planning");
  assert.deepEqual(cells.map(text), ["Family planning"]);
});

// Synchronized with Front Desk Patient Management (see queue-view-fixture.cjs): same columns,
// same cell values for the same record, same counters, same search/status/doctor filters.
// The Superadmin actions (Call, Transfer, Cancel, three-dot Undo) are unchanged.
const viewFixture = require("./queue-view-fixture.cjs");
const queueTable = tree => nodes(tree, node => node.type === "table" &&
  nodes(node, child => child.type === "th" && text(child) === "Patient Info").length > 0)[0];
const queueRow = (tree, queueNumber) => nodes(queueTable(tree), node => node.type === "tr" &&
  nodes(node, child => child.type === "span" && text(child) === queueNumber).length > 0)[0];
const shownQueueNumbers = tree => nodes(queueTable(tree), node => node.type === "span" && node.props.className?.includes("queue-number")).map(text);
const filterControl = (tree, index) => nodes(nodes(tree, node => node.props?.["data-queue-filters"])[0],
  node => node.type === "select" || node.type === "input")[index];

test("Queue Management shows the shared columns, including the assigned Doctor, before its own Actions", async () => {
  const h = await harness(viewFixture.ROWS);
  assert.deepEqual(nodes(queueTable(h.render()), node => node.type === "th").map(node => text(node)), viewFixture.HEADERS);
});

test("Queue Management shows each record's queue, patient, doctor, service, priority, status and time as Patient Management does", async () => {
  const h = await harness(viewFixture.ROWS);
  const tree = h.render();
  for (const [queueNumber, expected] of Object.entries(viewFixture.EXPECTED)) {
    assert.deepEqual(viewFixture.readCells(queueRow(tree, queueNumber), { text, nodes }), expected, queueNumber);
  }
});

test("Queue Management counters count Waiting, Serving, Completed and Cancelled from the loaded records", async () => {
  const h = await harness(viewFixture.ROWS);
  const counters = () => Object.fromEntries(nodes(h.render(), node => node.props?.["data-counter"])
    .map(node => [node.props["data-counter"], Number(text(node).replace(/\D+/g, ""))]));
  assert.deepEqual(counters(), viewFixture.COUNTS);
  h.backend.patients = h.backend.patients.map(row => row.id === 43 ? { ...row, status: "waiting", counter_id: null, completed_at: null } : row);
  // The section's Refresh reads the database again; counters follow the new records.
  const section = nodes(h.render(), node => node.type === "div" && node.props.className?.includes("max-w-6xl") &&
    nodes(node, child => child.props?.["data-queue-counters"]).length > 0)[0];
  const refresh = nodes(section, node => node.type === "button" && text(node).trim() === "Refresh")[0];
  await refresh.props.onClick();
  await h.flush();
  assert.deepEqual(counters(), { ...viewFixture.COUNTS, waiting: 2, cancelled: 0 });
});

test("Queue Management search, status and doctor filters match Patient Management, and Reset restores the Settings view", async () => {
  const h = await harness(viewFixture.ROWS);
  assert.deepEqual(shownQueueNumbers(h.render()), ["GP-007", "OB-043", "GP-008"], "existing weighted-priority order");
  filterControl(h.render(), 1).props.onChange({ target: { value: "cancelled" } });
  assert.deepEqual(shownQueueNumbers(h.render()), ["OB-043"]);
  filterControl(h.render(), 1).props.onChange({ target: { value: "all" } });
  filterControl(h.render(), 2).props.onChange({ target: { value: "serving person" } });
  assert.deepEqual(shownQueueNumbers(h.render()), ["GP-008"], "search by patient name");
  filterControl(h.render(), 2).props.onChange({ target: { value: "ob-043" } });
  assert.deepEqual(shownQueueNumbers(h.render()), ["OB-043"], "search by queue number");
  filterControl(h.render(), 2).props.onChange({ target: { value: "" } });
  filterControl(h.render(), 0).props.onChange({ target: { value: "Doctor 1" } });
  assert.deepEqual(shownQueueNumbers(h.render()), ["GP-007", "GP-008"]);
  const counters = Object.fromEntries(nodes(h.render(), node => node.props?.["data-counter"])
    .map(node => [node.props["data-counter"], Number(text(node).replace(/\D+/g, ""))]));
  assert.deepEqual(counters, { waiting: 1, serving: 1, completed: 0, cancelled: 0 }, "counters follow the doctor filter, as on Patient Management");
  const reset = nodes(h.render(), node => node.type === "button" && text(node).trim() === "Reset Filters")[0];
  assert.equal(reset.props.disabled, false);
  reset.props.onClick();
  assert.deepEqual(shownQueueNumbers(h.render()), ["GP-007", "OB-043", "GP-008"]);
  assert.equal(nodes(h.render(), node => node.type === "button" && text(node).trim() === "Reset Filters")[0].props.disabled, true);
});

test("Queue Management's default view still follows Settings: final visits hidden when Show completed is off", async () => {
  const h = await harness(viewFixture.ROWS, { settings: { showCompleted: false } });
  assert.deepEqual(shownQueueNumbers(h.render()), ["GP-007", "GP-008"]);
  filterControl(h.render(), 1).props.onChange({ target: { value: "cancelled" } });
  assert.deepEqual(shownQueueNumbers(h.render()), ["OB-043"], "an explicit Cancelled filter still finds it");
});

test("Queue Management keeps its own actions and does not gain Patient Management's View Ticket", async () => {
  const h = await harness(viewFixture.ROWS);
  const tree = h.render();
  assert.equal(buttons(tree, "View Ticket").length, 0);
  assert.equal(nodes(queueRow(tree, "GP-007"), node => node.type === "button" && /Call/.test(text(node))).length, 1, "the waiting head keeps its Call button");
  assert.equal(nodes(queueTable(tree), node => node.type === "button" && /Cancel/.test(text(node))).length, 2, "Cancel on the waiting and serving visits only");
  const lastFinal = nodes(queueRow(tree, "OB-043"), node => node.type === "button");
  assert.deepEqual(lastFinal.map(node => node.props.title), ["More actions"], "the latest final visit keeps only the three-dot menu");
  lastFinal[0].props.onClick();
  assert.deepEqual(buttons(queueRow(h.render(), "OB-043"), "Undo").length, 1, "the three-dot menu still opens Undo");
});

test("EP1: Superadmin monitoring, filters, assignments and transfers show display names; values stay counter ids", async () => {
  const names = { "Doctor 1": "Dr. Juan Dela Cruz", "Doctor 2": "Dr. Maria Santos" };
  const h = await harness([serving(1, { consultation_started_at: "2026-10-10T01:02:00Z" }),
    { ...patient(2, "prenatal", 1, "2026-10-10T01:02:00Z"), counter_id: "Doctor 2" }], {
    counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)],
    backendExtra: { ...roundRobin({ interventions: [{ patient_id: 1, doctor: "Doctor 1" }] }, (doctors) => {
      Object.assign(doctors[0], { signed_in: false, serving_patient_id: 1, eligible: false });
      Object.assign(doctors[2], { serving_patient_id: 9, eligible: false });
    }), doctor_display_names: names } });
  const tree = await h.flush();
  const content = text(tree);
  // Doctor monitoring cards.
  assert.equal(nodes(tree, (node) => node.type === "h4" && text(node) === "Dr. Juan Dela Cruz").length, 1);
  assert.equal(nodes(tree, (node) => node.type === "h4" && text(node) === "Doctor 3").length, 1, "no display name: counter id");
  // Assignment text and the intervention notice.
  assert.match(content, /Assigned to Dr\. Maria Santos, waiting for the doctor to call/);
  assert.match(content, /Dr\. Juan Dela Cruz signed out during an active consultation/);
  // Doctor filter: label is the display name, value is still the counter id.
  const option = nodes(tree, (node) => node.type === "option" && node.props.value === "Doctor 2")[0];
  assert.equal(text(option), "Dr. Maria Santos");
  // Transfer: label shows the name, the request still names the counter.
  const transfer = nodes(tree, (node) => node.type === "button" && /Transfer to/.test(text(node)));
  assert.deepEqual(transfer.map((node) => text(node).trim()), ["Transfer to Dr. Maria Santos"]);
  await transfer[0].props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/transfer", method: "POST", body: { patient_id: 1, doctor: "Doctor 2" } }]);
});

// FC1 Front Desk confirmation: Superadmin sees each waiting visit's confirmation state; a pending
// visit keeps its row but is never a doctor's next patient, so it offers no Call.
test("FC1: a pending visit shows Pending Confirmation and no Call; the doctor's first confirmed visit is callable", async () => {
  const pendingVisit = { ...patient(1, "consultation", 4), confirmed_at: null, confirmed_by: null };
  const h = await harness([pendingVisit, patient(2)]);
  const tree = h.render();
  assert.match(text(row(tree, 1)), /Pending Confirmation/);
  assert.equal(callButton(tree, 1), undefined);
  assert.match(text(row(tree, 2)), /Confirmed/);
  assert.equal(buttons(tree, "Confirm Patient").length, 0, "Superadmin gains no confirmation permission");
  await callButton(h.render(), 2).props.onClick();
  assert.deepEqual(h.actions.map(action => action.body), [{ patient_id: 2, counterId: "Doctor 1" }]);
});
