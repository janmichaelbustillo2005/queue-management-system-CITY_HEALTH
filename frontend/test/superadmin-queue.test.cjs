const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let componentCode;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../pages/index.js");
  const result = await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  });
  componentCode = result.code;
});

function patient(id, service = "consultation", score = 1, created = "2026-10-10T01:00:00Z") {
  return { id, id_num: `Test patient ${id}`, queue_number: `TEST-${id}`, service_type: service,
    status: "waiting", priority_score: score, created_at: created,
    counter_id: null, called_at: null, completed_at: null, awaiting_accept: false, vulnerability_flags: [] };
}
function doctor(number, state = {}) {
  return { id: number, id_num: `Doctor ${number}`, is_online: true, current_patient_id: null, ...state };
}
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(initialRows, options = {}) {
  const hooks = [], effectDeps = [], effects = [], calls = [];
  let cursor = 0;
  const backend = { patients: clone(initialRows), counters: clone(options.counters || [doctor(1), doctor(2), doctor(3)]) };
  const settings = { showCompleted: true, maxQueues: 100, autoRefresh: false,
    doctor1Online: true, doctor2Online: true, doctor3Online: true, ...options.settings };
  const user = { id_num: "superadmin", role: "superadmin" };
  const router = { isReady: true, query: { section: "queue" }, push() {} };
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
        effects.push(callback);
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, Set, Map, console,
    document: { addEventListener() {}, removeEventListener() {} },
    window: { confirm: () => true, prompt: () => options.cancelReason === undefined ? "Test cancellation reason" : options.cancelReason, setTimeout() {} }, confirm: () => true,
    setInterval: () => 1, clearInterval() {},
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
        return options.request ? options.request(route, init, backend) : { success: true };
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(); };
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      render();
      effects.splice(0).forEach(effect => effect());
      await tick();
    }
    return render();
  };
  await flush();
  const baselineReads = calls.filter(call => call.route === "/queue" && call.method === "GET").length;
  return {
    render, flush, calls, backend,
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

test("Superadmin waiting-for-acceptance patient cannot be completed before the existing doctor acceptance", async () => {
  const h = await harness([serving(1, { awaiting_accept: true })], { counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)] });
  const complete = buttons(row(h.render(), 1), "Complete")[0];
  assert.equal(complete.props.disabled, true);
  await complete.props.onClick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.rows[0].status, "serving");
  assert.equal(h.rows[0].completed_at, null);
});

test("Superadmin Complete and Cancel wait for server state and do not invent completion timestamps", async () => {
  for (const [label, route] of [["Complete", "/queue/complete"], ["Cancel", "/queue/cancel"]]) {
    let finish;
    const h = await harness([serving(1)], {
      counters: [doctor(1, { current_patient_id: 1 }), doctor(2), doctor(3)],
      request: () => new Promise(resolve => { finish = resolve; })
    });
    const before = h.rows;
    const pending = buttons(row(h.render(), 1), label)[0].props.onClick();
    assert.deepEqual(h.actions, [{ route, method: "POST", body: label === "Cancel"
      ? { patient_id: 1, reason: "Test cancellation reason", counter_id: "Doctor 1" }
      : { patient_id: 1 } }]);
    assert.deepEqual(h.rows, before, `${label} must preserve state while pending`);
    finish({ error: `${label} rejected by server` });
    await pending;
    await h.flush();
    assert.deepEqual(h.rows, before);
    assert.match(text(h.render()), new RegExp(`${label} rejected by server`));
    assert.equal(h.refreshes, 1);
  }
});

test("Superadmin Undo preserves the completed record until the backend refresh confirms the transition", async () => {
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
