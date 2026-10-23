const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

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
    completed_at: null, awaiting_accept: false, vulnerability_flags: [] };
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
  const backend = { patients: clone(initialRows), counters: clone(options.counters || [doctor(1), doctor(2), doctor(3)]) };
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
    nodes(node, child => child.type === "option" && child.props.value === "consultation").length)[0]
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
  change(node => node.type === "select" && nodes(node, child => child.props?.value === "prenatal").length, "prenatal");
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
    fullName: "Synthetic Registration Patient", service_type: "prenatal", mobile_number: "9123456789",
    residency: "Synthetic Development Address", philhealth_id: "SYNTHETIC-ID", birthdate: "1990-01-02",
    sex: "Female", vulnerabilityFlags: ["pregnant"]
  });
});

test("Superadmin dashboard shows the section named in the URL, so links, history and reload agree", async () => {
  const h = await harness([], { section: "home" });
  const sections = () => nodes(h.render(), node => /\bmax-w-6xl\b/.test(node.props?.className || "") && /\bcontainer\b/.test(node.props.className));
  const shown = () => sections().map(node => !/\bhidden\b/.test(node.props.className));
  assert.equal(h.render().props.title, "Dashboard");
  // Section containers in page order: home, staff, queue. (Staff loads accounts this harness does not serve.)
  assert.deepEqual(shown(), [true, false, false]);
  for (const [section, title, visible] of [
    ["queue", "Queue Management", [false, false, true]],
    ["unknown-value", "Dashboard", [true, false, false]],
    ["queue", "Queue Management", [false, false, true]]
  ]) {
    h.router.query = { section };
    await h.flush();
    assert.equal(h.render().props.title, title, section);
    assert.deepEqual(shown(), visible, section);
  }
  assert.equal(h.navigations.length, 0, "the page follows the URL instead of rewriting it");
});
