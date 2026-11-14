const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");

let componentCode, componentCodeWithHandlers;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../components/DoctorAdmin.js");
  const source = fs.readFileSync(filename, "utf8");
  const marker = "  async function handleAccept(patientId) {";
  assert.ok(source.includes(marker), "Accept handler probe must observe the real component handler");
  const options = {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  };
  [componentCode, componentCodeWithHandlers] = (await Promise.all([
    swc.transform(source, options),
    swc.transform(source.replace(marker, `  __captureAcceptHandler(handleAccept);\n${marker}`), options)
  ])).map(({ code }) => code);
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const calledAt = "2026-10-10T01:01:00.000Z";
const acceptedAt = "2026-10-10T01:02:00.000Z";
const startedAt = "2026-10-10T01:03:00.000Z";
const completedAt = "2026-10-10T01:08:00.000Z";

function serving(id = 1, state = {}) {
  return { id, id_num: `Test patient ${id}`, queue_number: `GP-${id}`, service_type: "consultation",
    status: "serving", priority_score: 1, created_at: "2026-10-10T01:00:00.000Z",
    counter_id: "Doctor 1", called_at: calledAt, awaiting_accept: true, accepted_at: null,
    consultation_started_at: null, completed_at: null,
    confirmed_at: "2026-10-10T01:00:30.000Z", confirmed_by: "frontdesk", ...state };
}
function doctor(number, patientId = null) {
  return { id: number, id_num: `Doctor ${number}`, name: `Doctor ${number}`,
    is_online: true, current_patient_id: patientId };
}

async function harness(initialRows, options = {}) {
  const hooks = [], effectDeps = [], effects = [], calls = [];
  let cursor = 0, acceptHandler;
  const props = { doctorId: 1, doctorName: "Doctor 1", ...options.props };
  const user = options.user || { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };
  const backend = { storage_mode: options.storageMode || "supabase", patients: clone(initialRows), counters: clone(options.counters ||
    [doctor(1, initialRows.find((row) => row.status === "serving" && row.counter_id === "Doctor 1")?.id), doctor(2), doctor(3)]) };
  const settings = { refreshInterval: 5, allowQueueReassignment: true, doctor1Online: true, doctor2Online: true, doctor3Online: true };
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useMemo(callback) { cursor++; return callback(); },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
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
  // Observe the real closure to exercise its guard even when the button is hidden.
  const code = options.exposeAcceptHandler ? componentCodeWithHandlers : componentCode;
  vm.runInNewContext(code, {
    module, exports: module.exports, Set, Map, console,
    __captureAcceptHandler: (handler) => { acceptHandler = handler; },
    window: { setTimeout: () => 1 }, setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../context/AuthContext") return { useAuth: () => ({ user }) };
      if (name === "../components/SiteFrame") return () => {};
      if (name === "./DoctorQueueNotifications") return () => {};
      if (name === "./SettingsModal") return { defaultQueueSettings: settings };
      if (name === "../lib/queueSettings") return {
        loadLocalQueueSettings: () => settings, fetchQueueSettings: async () => settings,
        mergeQueueSettings: (value) => ({ ...settings, ...value })
      };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        calls.push({ route, method: init.method || "GET", ...(init.body ? { body: JSON.parse(init.body) } : {}) });
        if (route === "/queue" && !init.method) return options.queueResponse ? options.queueResponse(backend) : clone(backend);
        if (route === "/account-cancellation-requests/mine") return { success: true, request: null };
        return options.request ? options.request(route, init, backend) : { success: true };
      } };
      if (isServicesModule(name)) return loadServices();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(props); };
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      render();
      effects.splice(0).forEach((effect) => effect());
      await tick();
    }
    return render();
  };
  await flush();
  const baselineReads = calls.filter((call) => call.route === "/queue").length;
  return { render, flush, backend, calls,
    invokeAccept(patientId) { assert.equal(typeof acceptHandler, "function"); return acceptHandler(patientId); },
    get actions() { return calls.filter((call) => call.method === "POST" && call.route.startsWith("/queue/")); },
    get refreshes() { return calls.filter((call) => call.route === "/queue").length - baselineReads; } };
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
const button = (tree, label) => nodes(tree, (node) => node.type === "button" &&
  (node.props["aria-label"] === label || text(node).trim() === label))[0];

const statValues = (tree) => nodes(tree, (node) => node.props?.className === "text-2xl font-bold brand-text").map(text);

test("a confirmed empty queue reports no patients with loaded counts", async () => {
  const tree = (await harness([])).render();
  assert.match(text(tree), /No patients in your queue/);
  assert.doesNotMatch(text(tree), /Queue unavailable/);
  assert.deepEqual(statValues(tree), ["0", "0", "0", "0"]);
});

test("a failed queue read is shown as unavailable, never as an empty queue or zero counts", async () => {
  let failing = true;
  const h = await harness([serving()], {
    queueResponse: (backend) => (failing ? { error: "Cannot reach the API. Start the backend." } : clone(backend))
  });
  let tree = h.render();
  assert.match(text(tree), /Cannot reach the API/);
  assert.match(text(tree), /Queue unavailable/);
  assert.doesNotMatch(text(tree), /No patients in your queue/);
  assert.deepEqual(statValues(tree), ["—", "—", "—", "—"]);
  assert.equal(button(tree, "Accept patient"), undefined);

  failing = false;
  await button(tree, "Retry").props.onClick();
  tree = await h.flush();
  assert.doesNotMatch(text(tree), /Queue unavailable|Cannot reach the API/);
  assert.ok(text(tree).includes("Test patient 1"));
  assert.ok(button(tree, "Accept patient"));
});

test("a queue read that later fails hides the stale rows instead of offering actions on them", async () => {
  let failing = false;
  const h = await harness([serving()], {
    queueResponse: (backend) => (failing ? { error: "Authentication session revoked" } : clone(backend))
  });
  assert.ok(button(h.render(), "Accept patient"));
  failing = true;
  await button(h.render(), "Refresh").props.onClick();
  const tree = h.render();
  assert.match(text(tree), /Queue unavailable/);
  assert.equal(button(tree, "Accept patient"), undefined);
  assert.equal(h.actions.length, 0);
});

test("called patient shows Accept separately from consultation actions", async () => {
  const h = await harness([serving()]);
  const tree = h.render();
  assert.ok(button(tree, "Accept patient"));
  assert.match(text(tree), /Called, awaiting acceptance/);
  assert.equal(button(tree, "Start Consultation"), undefined);
  assert.equal(button(tree, "Complete Consultation"), undefined);
  assert.equal(button(tree, "Re-Call").props.disabled, true);
});

test("Doctor Dashboard identifies temporary consultation records only when the backend reports local fallback", async () => {
  const local = await harness([serving()], { storageMode: "local_fallback" });
  assert.match(text(local.render()), /Development session: consultation records are temporary and will be lost when the backend restarts\./);
  const persisted = await harness([serving()], { storageMode: "supabase" });
  assert.doesNotMatch(text(persisted.render()), /Development session: consultation records are temporary/);
});

test("Accept posts once to the existing endpoint and refreshes acceptance without starting consultation", async () => {
  let finish;
  const h = await harness([serving()], { request: () => new Promise((resolve) => { finish = resolve; }) });
  const accept = button(h.render(), "Accept patient");
  const pending = accept.props.onClick();
  await accept.props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/accept", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(button(h.render(), "Accept patient").props.disabled, true);
  assert.equal(button(h.render(), "Cancel").props.disabled, true);
  Object.assign(h.backend.patients[0], { awaiting_accept: false, accepted_at: acceptedAt });
  finish({ success: true, accepted_at: acceptedAt });
  await pending;
  assert.equal(h.backend.patients[0].consultation_started_at, null);
  assert.equal(h.backend.patients[0].called_at, calledAt);
  assert.match(text(h.render()), /Accepted, ready for consultation/);
  assert.ok(button(h.render(), "Start Consultation"));
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("accepted patient can Start with only patient_id and renders the refreshed server timestamp", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    request: async (route, init, backend) => {
      assert.equal(route, "/queue/start");
      backend.patients[0].consultation_started_at = startedAt;
      return { success: true, consultation_started_at: startedAt };
    }
  });
  await button(h.render(), "Start Consultation").props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/start", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(h.refreshes, 1);
  assert.equal(h.backend.patients[0].status, "serving");
  assert.equal(h.backend.patients[0].completed_at, null);
  assert.equal(h.backend.patients[0].called_at, calledAt);
  assert.equal(h.backend.patients[0].accepted_at, acceptedAt);
  assert.match(text(h.render()), /Consultation in progress/);
  assert.ok(text(h.render()).includes(new Date(startedAt).toLocaleString()));
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.ok(button(h.render(), "Complete Consultation"));
});

test("start pending locks all actions for that patient and creates no optimistic timestamp", async () => {
  let finish;
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    request: () => new Promise((resolve) => { finish = resolve; })
  });
  const start = button(h.render(), "Start Consultation");
  const pending = start.props.onClick();
  await start.props.onClick();
  const loading = button(h.render(), "Starting...");
  assert.equal(loading.props.disabled, true);
  assert.equal(loading.props["aria-busy"], true);
  assert.equal(button(h.render(), "Cancel").props.disabled, true);
  assert.equal(button(h.render(), "Re-Call").props.disabled, true);
  await button(h.render(), "Cancel").props.onClick();
  await button(h.render(), "Re-Call").props.onClick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.backend.patients[0].consultation_started_at, null);
  assert.doesNotMatch(text(h.render()), /Consultation in progress/);
  finish({ success: true });
  await pending;
  assert.equal(button(h.render(), "Start Consultation").props.disabled, false);
});

test("failed start refreshes stale state, exposes success:false message and releases the lock", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    request: async () => ({ success: false, message: "The consultation could not start" })
  });
  await button(h.render(), "Start Consultation").props.onClick();
  assert.match(text(h.render()), /The consultation could not start/);
  assert.equal(h.refreshes, 1);
  assert.equal(h.backend.patients[0].consultation_started_at, null);
  assert.equal(button(h.render(), "Start Consultation").props.disabled, false);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("started patient can complete without client timestamp, duration, or doctor override fields", async () => {
  let finish;
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt })], {
    request: () => new Promise((resolve) => { finish = resolve; })
  });
  const complete = button(h.render(), "Complete Consultation");
  const pending = complete.props.onClick();
  await complete.props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/complete", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(button(h.render(), "Completing...").props.disabled, true);
  assert.equal(button(h.render(), "Cancel").props.disabled, true);
  assert.equal(h.backend.patients[0].completed_at, null);
  Object.assign(h.backend.patients[0], { status: "completed", completed_at: completedAt, service_duration_seconds: 300 });
  h.backend.counters[0].current_patient_id = null;
  finish({ success: true });
  await pending;
  assert.equal(h.backend.patients[0].consultation_started_at, startedAt);
  assert.equal(h.backend.patients[0].service_duration_seconds, 300);
  assert.equal(h.backend.counters[0].current_patient_id, null);
  assert.doesNotMatch(text(h.render()), /Test patient 1/);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("failed completion retains in-progress UI and refreshes without marking completed", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt })], {
    request: async () => { throw new Error("Counter assignment changed"); }
  });
  await button(h.render(), "Complete Consultation").props.onClick();
  assert.match(text(h.render()), /Counter assignment changed/);
  assert.equal(h.backend.patients[0].status, "serving");
  assert.equal(h.backend.patients[0].completed_at, null);
  assert.equal(h.refreshes, 1);
  assert.equal(button(h.render(), "Complete Consultation").props.disabled, false);
});

test("missing acceptance timestamp never exposes Start or Complete even if awaiting flag is false", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: null })]);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
  assert.equal(button(h.render(), "Re-Call").props.disabled, true);
});

test("persisted consultation start keeps Complete and Re-Call available after acceptance JSON is lost", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: null, consultation_started_at: startedAt })]);
  assert.match(text(h.render()), /Consultation in progress/);
  assert.equal(button(h.render(), "Accept patient"), undefined);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Re-Call").props.disabled, false);
  await button(h.render(), "Complete Consultation").props.onClick();
  await button(h.render(), "Re-Call").props.onClick();
  assert.deepEqual(h.actions.map((action) => action.route), ["/queue/complete", "/queue/re-call"]);
  assert.equal(h.backend.patients[0].consultation_started_at, startedAt);
  assert.equal(h.backend.patients[0].accepted_at, null, "the UI must not reconstruct a historical acceptance timestamp");
});

test("a doctor dashboard does not show another doctor's patient or consultation controls", async () => {
  const h = await harness([serving(2, { counter_id: "Doctor 2", service_type: "prenatal", awaiting_accept: false, accepted_at: acceptedAt })], {
    counters: [doctor(1), doctor(2, 2), doctor(3)]
  });
  assert.doesNotMatch(text(h.render()), /Test patient 2/);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
  assert.equal(h.actions.length, 0);
});

test("a doctor account viewing a different doctor, or Superadmin, cannot access consultation mutations", async () => {
  for (const user of [
    { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" },
    { id_num: "superadmin", role: "superadmin", doctor_name: null }
  ]) {
    for (const consultation_started_at of [null, startedAt]) {
      const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at })], { user });
      assert.equal(button(h.render(), "Start Consultation"), undefined);
      assert.equal(button(h.render(), "Complete Consultation"), undefined);
      // Super Admin navigates with the shared sidebar; the doctor's own account action is absent.
      if (user.role === "superadmin") assert.equal(h.render().props.accountActions.length, 0);
      else assert.deepEqual(Array.from(h.render().props.accountActions, action => action.label), ["Cancel Account"]);
    }
  }
});

test("a doctor's Cancel Account action only opens the confirmation, and an empty reason sends nothing", async () => {
  const h = await harness([]);
  const posts = () => h.calls.filter((call) => call.route === "/account-cancellation-requests" && call.method === "POST");
  const action = h.render().props.accountActions[0];
  assert.equal(action.label, "Cancel Account");
  action.onClick();
  await h.flush();
  assert.match(text(h.render()), /Cancel Account Request/);
  assert.match(text(h.render()), /stay active until a Super Admin reviews and approves/);
  assert.equal(posts().length, 0, "opening the request never submits it");
  button(h.render(), "Submit").props.onClick();
  await h.flush();
  assert.equal(posts().length, 0);
  assert.match(text(h.render()), /Please provide a reason for cancel before submitting\./);
});

test("stale Start is rejected locally when the current doctor counter belongs to another patient", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    counters: [doctor(1, 99), doctor(2), doctor(3)]
  });
  await button(h.render(), "Start Consultation").props.onClick();
  assert.equal(h.actions.length, 0);
  assert.match(text(h.render()), /counter no longer has this patient/);
});

test("waiting and completed rows do not offer consultation actions", async () => {
  const h = await harness([
    serving(1, { status: "waiting", called_at: null, counter_id: null }),
    serving(2, { status: "completed", awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt, completed_at: completedAt })
  ]);
  assert.equal(button(h.render(), "Accept patient"), undefined);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("Re-Call remains a separate existing endpoint before and during consultation", async () => {
  for (const consultation_started_at of [null, startedAt]) {
    const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at })]);
    await button(h.render(), "Re-Call").props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/re-call", method: "POST", body: { patient_id: 1, counterId: "Doctor 1" } }]);
    assert.equal(h.backend.patients[0].consultation_started_at, consultation_started_at);
    assert.equal(h.backend.patients[0].accepted_at, acceptedAt);
  }
});

test("Cancel remains available in accepted and started phases, requires reason and locks duplicate confirmation", async () => {
  for (const consultation_started_at of [null, startedAt]) {
    let finish;
    const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at })], {
      request: () => new Promise((resolve) => { finish = resolve; })
    });
    await button(h.render(), "Cancel").props.onClick();
    await button(h.render(), "Confirm").props.onClick();
    assert.equal(h.actions.length, 0);
    assert.match(text(h.render()), /Please provide a reason/);
    const textarea = nodes(h.render(), (node) => node.type === "textarea")[0];
    textarea.props.onChange({ target: { value: "Patient requested cancellation" } });
    const confirm = button(h.render(), "Confirm");
    const pending = confirm.props.onClick();
    await confirm.props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/cancel", method: "POST", body: {
      patient_id: 1, reason: "Patient requested cancellation", counter_id: "Doctor 1"
    } }]);
    assert.equal(button(h.render(), "Confirming...").props.disabled, true);
    finish({ success: true });
    await pending;
    assert.equal(button(h.render(), "Confirm"), undefined);
  }
});

test("existing cancelled patient Undo remains available and shares duplicate-action protection", async () => {
  let finish;
  const h = await harness([serving(1, { status: "cancelled", counter_id: null })], {
    request: () => new Promise((resolve) => { finish = resolve; })
  });
  const undo = button(h.render(), "Undo");
  assert.ok(undo);
  const pending = undo.props.onClick();
  await undo.props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/undo", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(button(h.render(), "Undo").props.disabled, true);
  assert.equal(button(h.render(), "Re-queue").props.disabled, true);
  finish({ success: true });
  await pending;
});

test("Doctor 2 and Doctor 3 can start only their mapped active patient with the same endpoint contract", async () => {
  for (const number of [2, 3]) {
    const doctorName = `Doctor ${number}`;
    const h = await harness([serving(number, { counter_id: doctorName, service_type: number === 2 ? "prenatal" : "family_planning",
      awaiting_accept: false, accepted_at: acceptedAt })], {
      props: { doctorId: number, doctorName }, user: { id_num: `admin${number}`, role: "admin", doctor_name: doctorName },
      counters: [doctor(1), doctor(2, number === 2 ? number : null), doctor(3, number === 3 ? number : null)]
    });
    await button(h.render(), "Start Consultation").props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/start", method: "POST", body: { patient_id: number } }]);
  }
});

const consultationServices = ["consultation", "prenatal", "family_planning"];
const assignmentForms = [
  ["canonical name", (number) => `Doctor ${number}`],
  ["compact alias", (number) => `doctor${number}`],
  ["case and whitespace alias", (number) => `  dOcToR   ${number}  `],
  ["numeric counter ID", (number) => number + 100],
  ["string counter ID", (number) => String(number + 100)]
];
const restrictedUsers = (number) => [
  { id_num: "another-doctor", role: "admin", doctor_name: `Doctor ${number % 3 + 1}` },
  { id_num: "another-doctor-counter-id", role: "admin", doctor_name: (number % 3 + 1) + 100 },
  { id_num: "frontdesk", role: "admin", doctor_name: null },
  { id_num: "superadmin", role: "superadmin", doctor_name: null },
  { id_num: "superadmin-forged-assignment", role: "superadmin", doctor_name: `Doctor ${number}` },
  { id_num: "non-admin", role: "staff", doctor_name: `Doctor ${number}` }
];
const assignedCounters = (number, patientId) => [1, 2, 3].map((counterNumber) => ({
  ...doctor(counterNumber, counterNumber === number ? patientId : null), id: counterNumber + 100
}));

for (const number of [1, 2, 3]) {
  const doctorName = `Doctor ${number}`;
  for (const [label, assignment] of assignmentForms) {
    test(`${doctorName}: assigned ${label} can Accept, Start and Complete the visible patient`, async () => {
      const h = await harness([serving(number, { counter_id: number + 100, service_type: consultationServices[number - 1] })], {
        props: { doctorId: number, doctorName },
        user: { id_num: `admin${number}`, role: "admin", doctor_name: assignment(number) },
        counters: assignedCounters(number, number),
        request: async (route, init, backend) => {
          const patient = backend.patients[0];
          if (route === "/queue/accept") Object.assign(patient, { awaiting_accept: false, accepted_at: acceptedAt });
          if (route === "/queue/start") patient.consultation_started_at = startedAt;
          if (route === "/queue/complete") {
            Object.assign(patient, { status: "completed", completed_at: completedAt });
            backend.counters[number - 1].current_patient_id = null;
          }
          return { success: true };
        }
      });
      assert.ok(text(h.render()).includes(`Test patient ${number}`));
      assert.equal(button(h.render(), "Accept patient").props.disabled, false);
      assert.equal(button(h.render(), "Cancel").props.disabled, false);
      await button(h.render(), "Accept patient").props.onClick();
      assert.equal(h.backend.patients[0].consultation_started_at, null);
      assert.equal(button(h.render(), "Accept patient"), undefined);
      await button(h.render(), "Start Consultation").props.onClick();
      await button(h.render(), "Complete Consultation").props.onClick();
      assert.deepEqual(h.actions, ["accept", "start", "complete"].map((action) => ({
        route: `/queue/${action}`, method: "POST", body: { patient_id: number }
      })));
      assert.equal(h.backend.patients[0].called_at, calledAt);
      assert.equal(h.backend.patients[0].accepted_at, acceptedAt);
      assert.equal(h.backend.patients[0].consultation_started_at, startedAt);
      assert.equal(h.backend.counters[number - 1].current_patient_id, null);
    });
  }

  test(`${doctorName}: unauthorized viewers retain monitoring and Cancel across all consultation phases`, async () => {
    const phases = [
      { awaiting_accept: true, accepted_at: null, consultation_started_at: null },
      { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: null },
      { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt }
    ];
    for (const user of restrictedUsers(number)) {
      for (const phase of phases) {
        const h = await harness([serving(number, {
          counter_id: number + 100, service_type: consultationServices[number - 1], ...phase
        })], { user, props: { doctorId: number, doctorName }, counters: assignedCounters(number, number) });
        const tree = h.render();
        const context = `${user.id_num}, ${phase.awaiting_accept ? "awaiting" : phase.consultation_started_at ? "started" : "accepted"}`;
        assert.ok(text(tree).includes(`Test patient ${number}`), context);
        for (const label of ["Accept patient", "Start Consultation", "Complete Consultation"]) {
          assert.equal(button(tree, label), undefined, `${context}: ${label}`);
        }
        assert.equal(button(tree, "Cancel").props.disabled, false, context);
        assert.equal(button(tree, "Re-Call").props.disabled, phase.awaiting_accept, context);
        assert.equal(h.actions.length, 0, context);
      }
    }
  });

  test(`${doctorName}: the Accept handler blocks unauthorized direct invocation before POST`, async () => {
    for (const user of restrictedUsers(number)) {
      const h = await harness([serving(number, {
        counter_id: number + 100, service_type: consultationServices[number - 1]
      })], { user, exposeAcceptHandler: true, props: { doctorId: number, doctorName }, counters: assignedCounters(number, number) });
      const before = clone(h.backend);
      await h.invokeAccept(number);
      assert.equal(h.actions.length, 0, user.id_num);
      assert.equal(h.refreshes, 0, user.id_num);
      assert.deepEqual(h.backend, before, user.id_num);
      assert.match(text(h.render()), /Only the assigned doctor can accept this patient/);
      assert.equal(button(h.render(), "Cancel").props.disabled, false, user.id_num);
    }
  });
}

function waiting(id, state = {}) {
  return serving(id, { status: "waiting", counter_id: null, called_at: null, awaiting_accept: false, ...state });
}
const inQueue = (tree, id) => text(tree).includes(`Test patient ${id}`);

test("a registered patient appears directly in the assigned doctor's queue, and in no other doctor's", async () => {
  const rows = [waiting(1), waiting(2, { service_type: "prenatal" }), waiting(3, { service_type: "family_planning" }),
    waiting(4, { counter_id: "Doctor 2" })];
  const h = await harness(rows);
  const tree = await h.flush();
  assert.equal(inQueue(tree, 1), true);
  for (const id of [2, 3, 4]) assert.equal(inQueue(tree, id), false, `patient ${id}`);
  const second = await harness(rows, { props: { doctorId: 2, doctorName: "Doctor 2" }, user: { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" } });
  const secondTree = await second.flush();
  assert.equal(inQueue(secondTree, 2), true);
  assert.equal(inQueue(secondTree, 4), true, "a stored assignment wins over the service mapping");
  assert.equal(inQueue(secondTree, 1), false);
});

test("Call belongs to the priority head only and sends the call the voice announcer follows", async () => {
  const h = await harness([waiting(1), waiting(2, { priority_score: 4, created_at: "2026-10-10T01:05:00.000Z" })]);
  const tree = await h.flush();
  assert.equal(nodes(tree, (node) => node.type === "button" && text(node).trim() === "Call").length, 1);
  assert.match(text(tree), /Waiting for turn/);
  assert.equal(button(tree, "Confirm"), undefined, "the row has no Confirm");
  assert.equal(nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === "Cancel").length, 1, "Cancel sits beside Call");
  await button(tree, "Call").props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/call", method: "POST", body: { patient_id: 2 } }]);
  assert.ok(h.refreshes >= 1);
});

test("Cancel beside Call needs a reason and cancels the waiting patient against this doctor", async () => {
  const h = await harness([waiting(1)]);
  await button(await h.flush(), "Cancel").props.onClick();
  await button(h.render(), "Confirm").props.onClick();
  assert.equal(h.actions.length, 0, "the popup still requires a reason");
  const reason = nodes(h.render(), (node) => node.type === "textarea")[0];
  reason.props.onChange({ target: { value: "Patient left" } });
  await button(h.render(), "Confirm").props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/cancel", method: "POST",
    body: { patient_id: 1, reason: "Patient left", counter_id: "Doctor 1" } }]);
});

test("after the doctor's Call the row goes straight to Start Consultation, with no confirm step", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })]);
  const tree = await h.flush();
  assert.equal(button(tree, "Accept patient"), undefined);
  assert.ok(button(tree, "Start Consultation"));
  assert.ok(button(tree, "Cancel"));
  assert.equal(button(tree, "Re-Call").props.disabled, false);
});

test("a serving patient holds the queue: nobody waiting can be called until that visit ends", async () => {
  const h = await harness([serving(1), waiting(2)]);
  const tree = await h.flush();
  assert.equal(button(tree, "Call"), undefined);
  assert.match(text(tree), /Waiting for turn/);
  assert.ok(button(tree, "Accept patient"), "Accept stays on the called patient");
  assert.ok(button(tree, "Cancel"));
});

test("two quick clicks send one Call, and a backend refusal is shown", async () => {
  const pending = [];
  const h = await harness([waiting(1)], { request: () => new Promise((resolve) => pending.push(resolve)) });
  const call = button(await h.flush(), "Call");
  const first = call.props.onClick();
  await call.props.onClick();
  assert.equal(h.actions.length, 1);
  assert.equal(button(h.render(), "Calling...").props.disabled, true);
  pending[0]({ success: false, message: "Call the next eligible patient" });
  await first;
  assert.match(text(await h.flush()), /Call the next eligible patient/);
  assert.equal(button(h.render(), "Call").props.disabled, false);
});

test("a disabled or occupied counter blocks Call and explains why", async () => {
  for (const counters of [[{ ...doctor(1), is_online: false }, doctor(2), doctor(3)], [doctor(1, 99), doctor(2), doctor(3)]]) {
    const h = await harness([waiting(1)], { counters });
    const call = button(await h.flush(), "Call");
    assert.equal(call.props.disabled, true);
    assert.ok(call.props.title.length > 0);
    await call.props.onClick();
    assert.equal(h.actions.length, 0);
  }
});

test("Super Admin viewing a doctor's queue sees waiting patients but does not call from it", async () => {
  const h = await harness([waiting(1)], { user: { id_num: "superadmin", role: "superadmin" } });
  const tree = await h.flush();
  assert.equal(inQueue(tree, 1), true);
  assert.equal(button(tree, "Call"), undefined);
});

test("shared dispatch: every doctor sees the unassigned queue, and a reservation stays with its doctor", async () => {
  const rows = [waiting(1, { service_type: "family_planning" }), waiting(2, { counter_id: "Doctor 3" }), waiting(3, { service_type: "laboratory" })];
  const h = await harness(rows, { queueResponse: (backend) => ({ ...clone(backend), dispatch_mode: "shared" }) });
  const tree = await h.flush();
  assert.equal(inQueue(tree, 1), true);
  assert.equal(inQueue(tree, 2), false);
  assert.equal(inQueue(tree, 3), false, "a service outside the shared queue cannot be called");
  assert.equal(button(tree, "Cancel"), undefined, "an uncalled shared visit has no owning doctor to cancel it");
  await button(tree, "Call").props.onClick();
  assert.equal(h.actions[0].body.patient_id, 1);
});

// RR1 round-robin dispatch: a doctor's queue is only the visit assigned to it, never the shared queue.
const roundRobinQueue = (backend) => ({ ...clone(backend), dispatch_mode: "shared", dispatch_strategy: "round_robin" });

test("RR1: the doctor sees and calls only the visit assigned to it, not unassigned or other doctors' visits", async () => {
  const rows = [waiting(1, { counter_id: "Doctor 1" }), waiting(2), waiting(3, { counter_id: "Doctor 2", priority_score: 4 })];
  const h = await harness(rows, { queueResponse: roundRobinQueue });
  const tree = await h.flush();
  assert.equal(inQueue(tree, 1), true);
  assert.equal(inQueue(tree, 2), false, "an unassigned shared visit is not offered");
  assert.equal(inQueue(tree, 3), false, "another doctor's assigned visit is not offered");
  assert.match(text(tree), /Assigned by rotation/);
  await button(tree, "Call").props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/call", method: "POST", body: { patient_id: 1 } }]);
});

test("RR1: with nothing assigned the doctor has nothing to call, even when the shared queue is not empty", async () => {
  const h = await harness([waiting(2), waiting(3)], { queueResponse: roundRobinQueue });
  const tree = await h.flush();
  assert.equal(button(tree, "Call"), undefined);
  assert.equal(inQueue(tree, 2) || inQueue(tree, 3), false);
});

test("EP1: the Doctor Queue heading shows the assigned account's display name and keeps the icon and Queue label", async () => {
  const fallback = await harness([]);
  assert.equal(fallback.render().props.title, "Doctor 1 Queue", "no display name set: unchanged");
  assert.equal(fallback.render().props.icon, "fas fa-user-md");

  const names = { "Doctor 1": "Dr. Juan Dela Cruz", "Doctor 2": "Dr. Other" };
  const h = await harness([], { queueResponse: (backend) => ({ ...clone(backend), doctor_display_names: names }) });
  assert.equal(h.render().props.title, "Dr. Juan Dela Cruz Queue");
  assert.equal(h.render().props.icon, "fas fa-user-md");

  // Renaming again is picked up on the next queue read, without a reload.
  names["Doctor 1"] = "Dr. Maria Santos";
  await h.flush();
  assert.equal(h.render().props.title, "Dr. Maria Santos Queue");
});

// FC1 Front Desk confirmation: a visit reaches the doctor only after the Front Desk confirmed it.
const pending = (id, state = {}) => waiting(id, { confirmed_at: null, confirmed_by: null, ...state });

test("FC1: a visit pending Front Desk confirmation is not in the doctor's queue or counts and cannot be called", async () => {
  const h = await harness([pending(1, { priority_score: 4 }), waiting(2)]);
  const tree = await h.flush();
  assert.equal(inQueue(tree, 1), false, "the pending visit is not shown to the doctor");
  assert.equal(inQueue(tree, 2), true);
  const calls = nodes(tree, (node) => node.type === "button" && text(node).trim() === "Call");
  assert.equal(calls.length, 1, "the confirmed visit is the doctor's next patient despite the pending higher priority");
  await calls[0].props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/call", method: "POST", body: { patient_id: 2 } }]);
});

test("FC1: with only pending visits the doctor has nobody to call; Matching Waiting counts confirmed visits only", async () => {
  const h = await harness([pending(1), pending(2)]);
  const tree = await h.flush();
  assert.equal(inQueue(tree, 1), false);
  assert.equal(inQueue(tree, 2), false);
  assert.equal(nodes(tree, (node) => node.type === "button" && text(node).trim() === "Call").length, 0);
  assert.match(text(tree), /0Matching Waiting/);
  assert.deepEqual(h.actions, []);
});
