const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");

let componentCode, helperCode;
before(async () => {
  await swc.loadBindings();
  const componentFilename = path.join(__dirname, "../pages/index.js");
  const helperFilename = path.join(__dirname, "../lib/doctorPresence.js");
  const [component, helper] = await Promise.all([
    swc.transform(fs.readFileSync(componentFilename, "utf8"), {
      filename: componentFilename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    }),
    swc.transform(fs.readFileSync(helperFilename, "utf8"), {
      filename: helperFilename, jsc: { parser: { syntax: "ecmascript" } }, module: { type: "commonjs" }
    })
  ]);
  componentCode = component.code;
  helperCode = helper.code;
});

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const serverNow = "2026-10-11T16:00:00.000Z";
const lastSeen = "2026-10-11T15:58:00.000Z";
const counter = (number, state = {}) => ({ id: number, id_num: `Doctor ${number}`, is_online: true,
  current_patient_id: null, ...state });
const presence = (number, online = true, state = {}) => ({ doctor_name: `Doctor ${number}`, online,
  last_seen_at: online ? serverNow : lastSeen, ...state });
const patient = (id, state = {}) => ({ id, id_num: `Patient ${id}`, queue_number: `TEST-${id}`,
  status: "serving", service_type: "consultation", priority_score: 1, counter_id: "Doctor 1",
  called_at: serverNow, created_at: serverNow, consultation_started_at: serverNow,
  completed_at: null, vulnerability_flags: [], ...state });

async function harness(options = {}) {
  const hooks = [], effectDeps = [], effects = [], cleanup = [], calls = [], intervals = new Map();
  let cursor = 0, timerId = 0;
  let user = options.user === undefined ? { id_num: "superadmin", role: "superadmin" } : options.user;
  const clock = { wall: options.browserNow ?? Date.parse(serverNow), monotonic: 1000 };
  const BrowserDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.wall])); }
    static now() { return clock.wall; }
  };
  const performance = { now: () => clock.monotonic };
  const helperModule = { exports: {} };
  vm.runInNewContext(helperCode, { module: helperModule, exports: helperModule.exports, Date: BrowserDate, performance });
  const helpers = helperModule.exports;
  const backend = {
    patients: clone(options.patients || []),
    counters: clone(options.counters || [counter(1), counter(2), counter(3)]),
    doctors: clone(options.doctors || [presence(1), presence(2), presence(3)]),
    presenceError: null, presenceHold: null,
    presencePayload: undefined
  };
  const settings = { autoRefresh: false, refreshInterval: 5, showCompleted: true, maxQueues: 100,
    doctor1Online: true, doctor2Online: true, doctor3Online: true, ...options.settings };
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
      const index = cursor++, previous = effectDeps[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        effectDeps[index] = deps;
        effects.push(() => { cleanup[index]?.(); cleanup[index] = callback(); });
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, Date: BrowserDate, performance, AbortController, Set, Map, console,
    document: { addEventListener() {}, removeEventListener() {} },
    window: { confirm: () => true, prompt: () => null, setTimeout() {} }, confirm: () => true,
    setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }, setTimeout: () => ++timerId, clearTimeout() {},
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link" || name === "../components/SiteFrame") return () => {};
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../context/AuthContext") return { useAuth: () => ({ user, loading: false }) };
      if (name === "../components/SettingsModal") return { __esModule: true, default: () => {}, defaultQueueSettings: settings };
      if (name === "../lib/doctorPresence") return helpers;
      if (name === "../lib/queueSettings") return {
        loadLocalQueueSettings: () => settings, fetchQueueSettings: async () => settings,
        applyCounterAvailability: value => value, clearActiveQueues: async () => ({ success: true }),
        exportQueueData: async () => {}, saveQueueSettings: async value => value
      };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        calls.push({ route, method: init.method || "GET", cache: init.cache, signal: init.signal });
        if (route === "/queue") return clone({ patients: backend.patients, counters: backend.counters });
        if (route === "/stats") return { data: {} };
        if (route === "/doctors/presence") {
          if (backend.presenceHold) return backend.presenceHold;
          if (backend.presenceError) return { error: backend.presenceError };
          if (backend.presencePayload !== undefined) return clone(backend.presencePayload);
          return clone({ success: true, doctors: backend.doctors, counters: backend.counters,
            observed_at: serverNow, timeout_seconds: 75 });
        }
        return { success: true };
      } };
      if (isServicesModule(name)) return loadServices();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(); };
  const flush = async () => {
    for (let i = 0; i < 3; i++) { render(); effects.splice(0).forEach(effect => effect()); await tick(); }
    return render();
  };
  await flush();
  return {
    backend, calls, render, flush, helpers,
    setUser(next) { user = next; },
    async poll(elapsed = 5000) {
      clock.wall += elapsed; clock.monotonic += elapsed;
      [...intervals.values()].filter(timer => timer.delay === 5000).forEach(timer => timer.callback());
      return flush();
    },
    card(number) { return nodes(render(), node => node.props["data-doctor-status"] === `Doctor ${number}`)[0]; },
    get patientRows() { return clone(hooks.find(value => Array.isArray(value) && value.some(row => row?.status && row?.queue_number)) || []); },
    dispose() { cleanup.forEach(callback => callback?.()); }
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
const labels = card => nodes(card, node => node.type === "span").map(text);

test("doctor cards independently show verified presence, counter setting, availability, and last seen", async () => {
  const h = await harness({ doctors: [presence(1), presence(2, false), presence(3)],
    counters: [counter(1), counter(2), counter(3, { is_online: false })] });
  assert.deepEqual(nodes(h.render(), node => node.type === "h4").map(text), ["Doctor 1", "Doctor 2", "Doctor 3"]);
  assert.ok(labels(h.card(1)).includes("Online"));
  assert.match(text(h.card(1)), /Counter: EnabledAvailable/);
  assert.ok(labels(h.card(2)).includes("Offline"));
  assert.match(text(h.card(2)), /Counter: Enabled/);
  assert.equal(nodes(h.card(2), node => node.type === "time")[0].props.dateTime, lastSeen);
  assert.ok(labels(h.card(3)).includes("Online"), "disabled counter does not imply a logged-out doctor");
  assert.match(text(h.card(3)), /Counter: DisabledAvailable/);
  h.dispose();
});

test("an online occupied doctor shows Serving and the current patient's queue number", async () => {
  const h = await harness({ patients: [patient(7)], counters: [counter(1, { current_patient_id: 7 }), counter(2), counter(3)] });
  assert.ok(labels(h.card(1)).includes("Online"));
  assert.match(text(h.card(1)), /Serving/);
  assert.match(text(h.card(1)), /Current queue: TEST-7/);
  assert.match(text(h.card(2)), /Available/);
  h.dispose();
});

test("doctor logout while occupied warns Superadmin and leaves consultation and assignment intact", async () => {
  const initial = patient(7);
  const h = await harness({ patients: [initial], counters: [counter(1, { current_patient_id: 7 }), counter(2), counter(3)] });
  h.backend.doctors[0] = presence(1, false);
  await h.poll();
  assert.ok(labels(h.card(1)).includes("Offline"));
  assert.match(text(h.card(1)), /Current queue: TEST-7/);
  assert.ok(nodes(h.card(1), node => node.props.role === "alert" && /offline.*assigned patient.*preserved/i.test(text(node))).length);
  assert.deepEqual(h.patientRows, [initial]);
  assert.deepEqual(h.backend.patients, [initial]);
  assert.equal(h.backend.counters[0].current_patient_id, 7);
  assert.equal(h.calls.some(call => call.method !== "GET"), false);
  assert.ok(labels(h.card(2)).includes("Online"), "Doctor 1 logout must not alter another doctor's presence");
  h.dispose();
});

test("an occupied patient outside today's rows keeps the persisted queue number and recovery information", async () => {
  const h = await harness({ doctors: [presence(1, false), presence(2), presence(3)],
    counters: [counter(1, { current_patient_id: 79, current_patient_name: "Previous day patient", current_patient_queue_number: "PREV-79" }), counter(2), counter(3)] });
  assert.match(text(h.card(1)), /Current queue: PREV-79/);
  assert.match(text(h.card(1)), /Assigned patient ID: 79/);
  assert.match(text(h.card(1)), /Status unavailable/);
  assert.match(text(h.card(1)), /outside the current queue view.*authorized recovery/i);
  assert.equal(h.backend.counters[0].current_patient_id, 79);
  assert.deepEqual(h.patientRows, []);
  h.dispose();
});

test("a failed monitoring poll shows Unknown immediately and a restored request returns verified status", async () => {
  const h = await harness();
  h.backend.presenceError = "Network unavailable";
  await h.poll();
  for (const number of [1, 2, 3]) {
    assert.ok(labels(h.card(number)).includes("Unknown"));
    assert.equal(labels(h.card(number)).includes("Offline"), false, "failure cannot assert a doctor logged out");
    assert.equal(labels(h.card(number)).includes("Online"), false, "failure cannot retain the old Online label");
  }
  h.backend.presenceError = null;
  await h.poll();
  assert.ok(labels(h.card(1)).includes("Online"));
  assert.ok(h.calls.filter(call => call.route === "/doctors/presence").every(call => call.cache === "no-store" && call.signal));
  h.dispose();
});

test("a stalled monitoring request expires the previously verified Online snapshot to Unknown", async () => {
  const h = await harness();
  h.backend.presenceHold = new Promise(() => {});
  await h.poll(15001);
  for (const number of [1, 2, 3]) assert.ok(labels(h.card(number)).includes("Unknown"));
  h.dispose();
});

test("a browser clock years away from the server does not invalidate freshly received presence", async () => {
  const h = await harness({ browserNow: Date.parse("2030-01-01T00:00:00.000Z") });
  assert.ok(labels(h.card(1)).includes("Online"));
  await h.poll();
  assert.ok(labels(h.card(1)).includes("Online"));
  const snapshot = h.helpers.captureDoctorPresence({ success: true, doctors: [presence(1)], observed_at: serverNow, timeout_seconds: 75 }, 42);
  assert.equal(h.helpers.doctorPresenceStatus(snapshot, "Doctor 1", 43).label, "Online");
  assert.equal(h.helpers.doctorPresenceStatus(snapshot, "Doctor 1", 15042).label, "Unknown");
  h.dispose();
});

test("presence polls refresh occupied and enabled counter state when automatic queue refresh is disabled", async () => {
  const h = await harness({ patients: [patient(7, { status: "waiting", called_at: null, consultation_started_at: null })] });
  const queueReads = h.calls.filter(call => call.route === "/queue").length;
  h.backend.counters[0] = counter(1, { current_patient_id: 79, current_patient_queue_number: "NEW-79", current_patient_name: "New assignment" });
  h.backend.counters[2] = counter(3, { is_online: false });
  await h.poll();
  assert.match(text(h.card(1)), /Current queue: NEW-79/);
  assert.match(text(h.card(1)), /Assigned patient ID: 79/);
  assert.match(text(h.card(3)), /Counter: Disabled/);
  assert.equal(h.calls.filter(call => call.route === "/queue").length, queueReads, "queue auto-refresh preference stays intact");
  assert.equal(h.patientRows[0].status, "waiting");
  assert.ok(h.calls.filter(call => call.route === "/doctors/presence").length >= 2);
  h.dispose();
});

test("missing, malformed, and unauthorized doctor presence cannot fabricate an Online indicator", async () => {
  const h = await harness();
  h.backend.presencePayload = { success: true, doctors: [presence(1), { doctor_name: "Doctor 2", online: "true" }], observed_at: serverNow, timeout_seconds: 75 };
  await h.poll();
  assert.ok(labels(h.card(1)).includes("Online"));
  assert.ok(labels(h.card(2)).includes("Unknown"));
  assert.ok(labels(h.card(3)).includes("Unknown"));
  h.backend.presencePayload = { success: true, doctors: [presence(1)], observed_at: "invalid timestamp" };
  await h.poll();
  assert.ok(labels(h.card(1)).includes("Unknown"));
  h.dispose();
  const denied = await harness({ user: { id_num: "admin1", role: "doctor", doctor_name: "Doctor 1" } });
  await denied.poll();
  assert.equal(denied.calls.some(call => call.route === "/doctors/presence"), false);
  denied.dispose();
});

test("a refreshed free counter clears Serving while the intentionally unrefreshed queue still contains its old patient", async () => {
  const h = await harness({ patients: [patient(7)], counters: [counter(1, { current_patient_id: 7 }), counter(2), counter(3)] });
  assert.match(text(h.card(1)), /Serving/);
  h.backend.counters[0] = counter(1);
  await h.poll();
  assert.match(text(h.card(1)), /Available/);
  assert.doesNotMatch(text(h.card(1)), /Serving|TEST-7/);
  assert.equal(h.patientRows[0].status, "serving", "queue refresh preference remains independent");
  h.dispose();
});
