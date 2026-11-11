// Algorithm Simulation page (Superadmin, Simulation Mode): controls, synthetic-only labelling,
// explanations and isolation from the API. Components run in a small hook renderer (no DOM) with
// fake timers; fetch throws, so any network use would fail the test.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const ROOT = path.join(__dirname, "..");
const SOURCES = {
  lib: "lib/algorithmSimulation.js", component: "components/AlgorithmSimulation.js",
  page: "pages/algorithm-simulation.js", navigation: "lib/navigation.js"
};
const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const [name, relative] of Object.entries(SOURCES)) {
    const filename = path.join(ROOT, relative);
    compiled[name] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

const Fragment = Symbol("Fragment");
const jsxRuntime = { jsx: (type, props, key) => ({ type, key, props: props || {} }), jsxs: (type, props, key) => ({ type, key, props: props || {} }), Fragment };
const css = new Proxy({}, { get: (_target, key) => (typeof key === "string" ? key : undefined) });

function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach((child) => nodes(child, predicate, found));
  else if (tree && typeof tree === "object" && tree.props) {
    if (predicate(tree)) found.push(tree);
    nodes(tree.props.children, predicate, found);
  }
  return found;
}
function text(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return text(tree.props?.children);
}
const button = (tree, label) => {
  const found = nodes(tree, (n) => n.type === "button" && text(n).trim() === label);
  assert.equal(found.length, 1, `one "${label}" button`);
  return found[0];
};
const byClass = (tree, name) => nodes(tree, (n) => String(n.props.className || "").split(/\s+/).includes(name));

// Runs function components with per-instance hooks and effects after each render.
function createHarness() {
  const instances = new Map();
  let active, pending = [];
  const slot = () => ({ instance: active, index: active.cursor++ });
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => v !== b[i]);
  const react = {
    useState(initial) {
      const { instance, index } = slot();
      if (!(index in instance.hooks)) instance.hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      const s = instance.hooks[index];
      return [s.value, (next) => { s.value = typeof next === "function" ? next(s.value) : next; }];
    },
    useRef(initial) {
      const { instance, index } = slot();
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
      return instance.hooks[index];
    },
    useMemo(callback, deps) {
      const { instance, index } = slot();
      const s = instance.hooks[index];
      if (!s || changed(s.deps, deps)) instance.hooks[index] = { deps, value: callback() };
      return instance.hooks[index].value;
    },
    useEffect(callback, deps) {
      const { instance, index } = slot();
      const s = instance.hooks[index];
      if (!s || changed(s.deps, deps)) {
        const next = { deps, cleanup: s?.cleanup };
        instance.hooks[index] = next;
        pending.push(() => { next.cleanup?.(); next.cleanup = callback() || undefined; });
      }
    }
  };
  function expand(node, at) {
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${at}[${child?.key ?? i}]`));
    if (!node || typeof node !== "object" || !node.props) return node;
    if (node.type === Fragment) return expand(node.props.children, at);
    if (typeof node.type === "function") {
      const id = `${at}/${node.type.name}`;
      if (!instances.has(id)) instances.set(id, { hooks: [] });
      const previous = active;
      active = instances.get(id);
      active.cursor = 0;
      const output = node.type(node.props);
      active = previous;
      return expand(output, id);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${at}>${String(node.type)}`) } };
  }
  // Fake browser: timers run only when the test fires them; fetch is forbidden.
  const timers = new Map();
  let nextTimer = 1, now = 0;
  const listeners = {};
  const globals = {
    window: { addEventListener: (name, fn) => { (listeners[name] ||= new Set()).add(fn); }, removeEventListener: (name, fn) => listeners[name]?.delete(fn) },
    performance: { now: () => now },
    setInterval: (fn) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearInterval: (id) => { timers.delete(id); },
    fetch: () => { throw new Error("the simulation must not use the network"); }
  };
  return {
    react, globals, listeners, timers,
    elapse(ms) { now += ms; for (const fn of [...timers.values()]) fn(); },
    render(element) {
      const tree = expand(element, "root");
      const effects = pending.splice(0);
      effects.forEach((effect) => effect());
      return tree;
    }
  };
}

function load(name, requireMap, globals = {}) {
  const module = { exports: {} };
  const filename = path.join(ROOT, SOURCES[name]);
  const localRequire = (spec) => {
    if (spec in requireMap) return requireMap[spec];
    if (spec.startsWith(".")) return require(path.resolve(path.dirname(filename), spec));
    throw new Error(`unexpected import ${spec} in ${SOURCES[name]}`);
  };
  vm.runInNewContext(compiled[name], { module, exports: module.exports, console, Math, Number, String, Object, Array, Set, Map, JSON, Symbol, ...globals, require: localRequire });
  return module.exports;
}
const loadLib = () => load("lib", {});

function mount() {
  const harness = createHarness();
  const lib = loadLib();
  const component = load("component", {
    react: harness.react, "react/jsx-runtime": jsxRuntime, "./AlgorithmSimulation.module.css": { __esModule: true, default: css },
    "../lib/algorithmSimulation": lib
  }, harness.globals);
  const Simulation = component.default;
  let tree;
  const view = {
    harness, lib,
    render() { tree = harness.render(jsxRuntime.jsx(Simulation, {})); tree = harness.render(jsxRuntime.jsx(Simulation, {})); return tree; },
    get tree() { return tree; },
    clock() { return text(byClass(tree, "clock")[0]); },
    click(label) { button(tree, label).props.onClick(); return view.render(); }
  };
  view.render();
  return view;
}

test("the page is labelled Simulation Mode — Synthetic Data Only and opens in side-by-side comparison", () => {
  const view = mount();
  const all = text(view.tree);
  assert.match(all, /Simulation Mode — Synthetic Data Only/);
  assert.equal(text(byClass(view.tree, "cornerBadge")).trim(), "Simulation Mode · Synthetic Data Only", "a fixed badge keeps the label in view while scrolling");
  assert.match(all, /Nothing here reads or changes patient records, the live queue, Call Now or the database/);
  assert.match(all, /identical for WPS-A and WRR/);
  assert.equal(view.clock(), "08:00:00");
  const pressed = nodes(view.tree, (n) => n.type === "button" && n.props["aria-pressed"] === true).map((n) => text(n));
  assert.deepEqual(pressed, ["Side-by-side comparison", "Scenario A — Regular-majorityA · 80% Regular / 20% Vulnerable"]);
  assert.deepEqual(nodes(view.tree, (n) => n.type === "h3" && /^(WPS-A|WRR) —/.test(text(n))).map(text),
    ["WPS-A — Weighted Priority Scheduling with Aging", "WRR — Weighted Round Robin (research baseline)"]);
  for (const label of ["Start", "Pause", "Next Step", "Reset"]) button(view.tree, label);
  assert.equal(button(view.tree, "Pause").props.disabled, true);
  assert.equal(byClass(view.tree, "doctor").length, 6, "three virtual doctors per algorithm");
});

test("Next Step moves to the next arrival, call or completion; Reset returns to opening", () => {
  const view = mount();
  const { buildRun, nextEventTime, clock } = view.lib;
  const run = buildRun("regular-majority", 20261029, 100);
  const first = nextEventTime([run.timelines["WPS-A"], run.timelines.WRR], 0);
  view.click("Next Step");
  assert.equal(view.clock(), clock(first));
  view.click("Next Step");
  assert.equal(view.clock(), clock(nextEventTime([run.timelines["WPS-A"], run.timelines.WRR], first)));
  assert.match(text(view.tree), /Serving/);
  view.click("Reset");
  assert.equal(view.clock(), "08:00:00");
});

test("Start and Pause run the simulated clock at the chosen speed", () => {
  const view = mount();
  view.click("Start");
  assert.equal(view.harness.timers.size, 1);
  assert.equal(button(view.tree, "Start").props.disabled, true);
  view.harness.elapse(1000);
  view.render();
  assert.equal(view.clock(), "08:02:00", "default speed is 2 simulated minutes per second");
  view.click("Pause");
  assert.equal(view.harness.timers.size, 0);
  view.harness.elapse(5000);
  assert.equal(view.render() && view.clock(), "08:02:00", "paused time stands still");
  nodes(view.tree, (n) => n.type === "select" && nodes(n, (o) => o.type === "option" && o.props.value === 20).length)[0].props.onChange({ target: { value: "20" } });
  view.render();
  view.click("Start");
  view.harness.elapse(1500);
  view.render();
  assert.equal(view.clock(), "08:32:00");
});

// Scenario buttons are labelled "<title><short description>"; pick one by its title.
function pickScenario(view, title) {
  const found = nodes(view.tree, (n) => n.type === "button" && text(n).startsWith(title));
  assert.equal(found.length, 1, `one "${title}" scenario`);
  found[0].props.onClick();
  return view.render();
}
const algorithmPanel = (tree, algorithm) => nodes(tree, (n) => n.type === "section" && n.props["aria-labelledby"] === `sim-${algorithm}`)[0];

test("the scenario picker offers Scenario A, Scenario B, the controlled case and the stress test", () => {
  const view = mount();
  const titles = nodes(byClass(view.tree, "scenarios")[0], (n) => n.type === "button").map((n) => text(nodes(n, (c) => c.type === "strong")[0]));
  assert.deepEqual(titles, ["Scenario A — Regular-majority", "Scenario B — Vulnerable-majority",
    "Controlled — one Regular before nine Vulnerable", "Stress — sustained higher-priority arrivals"]);
  view.click("Next Step");
  pickScenario(view, "Scenario B");
  assert.equal(view.clock(), "08:00:00", "a new scenario starts at opening");
  const run = view.lib.buildRun("vulnerable-majority", 20261029, 100);
  assert.equal(run.timelines["WPS-A"].patients.filter((p) => !p.vulnerable).length, 20);
  assert.match(text(view.tree), /Scenario B — Vulnerable-majority: 20% Regular and 80% Vulnerable.*Seed 20261029: 100 synthetic patients/);
  pickScenario(view, "Controlled");
  const count = nodes(view.tree, (n) => n.type === "input" && n.props.name === "count")[0];
  assert.equal(count.props.disabled, true);
  assert.equal(count.props.value, "13");
  assert.match(text(view.tree), /Seed 20261029 \(not used: nothing in the controlled case is random\): 13 synthetic patients/);
});

test("the Aging jump shows WPS-A's recalculated ranking and why the patient was selected", () => {
  const view = mount();
  pickScenario(view, "Scenario B");
  const run = view.lib.buildRun("vulnerable-majority", 20261029, 100);
  const decision = run.timelines["WPS-A"].decisions.find((d) => d.agingOvertake);
  const patient = run.timelines["WPS-A"].patients.find((p) => p.id === decision.patientId);
  view.click("Next Aging overtake");
  assert.equal(view.clock(), view.lib.clock(decision.now));
  const panel = algorithmPanel(view.tree, "WPS-A");
  const explanation = text(byClass(panel, "explanation")[0]);
  assert.match(explanation, new RegExp(`${decision.doctor} called ${patient.ticket} ${patient.category}`));
  assert.match(explanation, new RegExp(`registered ${view.lib.clock(patient.arrival)} · waited`));
  const top = decision.rankingDetail[0];
  assert.match(explanation, new RegExp(`base score ${top.base} \\+ Aging bonus ${top.bonus} .*= effective score ${top.effective}`));
  assert.match(explanation, /Aging changed this call: without the bonus \(original WPS\)/);
  assert.match(explanation, new RegExp(`Ranking recalculated at ${view.lib.clock(decision.now)} when ${decision.doctor} became available`));
  const ranking = nodes(byClass(panel, "explanation")[0], (n) => n.type === "table")[0];
  assert.deepEqual(nodes(ranking, (n) => n.type === "th").map(text), ["Position", "Ticket", "Registered", "Base", "Waited", "Aging bonus", "Effective"]);
  assert.equal(nodes(ranking, (n) => n.type === "tr" && n.props.className === "nextRow").length, 1, "the selected patient is marked");
  assert.match(text(panel), /10-minute Aging rule/);
  const headers = nodes(byClass(panel, "queue")[0], (n) => n.type === "th").map(text);
  for (const h of ["Order", "Registered", "Category", "Base score", "Aging bonus", "Effective score", "Waiting"]) assert.ok(headers.includes(h), h);
});

test("WRR mode shows its weighted rotation, the selection turn and the reason for each call", () => {
  const view = mount();
  pickScenario(view, "Scenario B");
  view.click("WRR");
  assert.equal(nodes(view.tree, (n) => n.type === "section" && /^sim-(WPS-A|WRR)$/.test(n.props["aria-labelledby"] || "")).length, 1);
  view.click("Next WRR lower-class turn");
  const all = text(view.tree);
  assert.match(all, /Weighted rotation/);
  assert.match(all, /turn: \d of \d left/);
  assert.match(all, /WRR turn \d+: class w\d+, call \d+ of \d+/);
  assert.match(all, /Class w\d had \d+ waiting and \d of \d calls? left/);
  assert.match(all, /Doctor \d called P\d{3}/);
  assert.match(all, /Recent events/);
  assert.doesNotMatch(all, /Next Aging overtake/, "single WRR mode offers only the WRR jump");
});

test("seed and patient count are validated; a new workload reloads the same patients for both algorithms", () => {
  const view = mount();
  const input = (name) => nodes(view.tree, (n) => n.type === "input" && n.props.name === name)[0];
  input("seed").props.onChange({ target: { value: "12x" } });
  view.render();
  view.click("Load workload");
  assert.match(text(nodes(view.tree, (n) => n.props.role === "alert")), /whole number .* for the seed/);
  input("seed").props.onChange({ target: { value: "7" } });
  input("count").props.onChange({ target: { value: "5" } });
  view.render();
  view.click("Load workload");
  assert.match(text(nodes(view.tree, (n) => n.props.role === "alert")), /patients from 20 to 400/);
  input("count").props.onChange({ target: { value: "150" } });
  view.render();
  view.click("Load workload");
  assert.equal(nodes(view.tree, (n) => n.props.role === "alert").length, 0);
  assert.match(text(view.tree), /Seed 7: 150 synthetic patients, identical for WPS-A and WRR/);
});

test("final results appear when the same workload finishes, computed from the simulated events", () => {
  const view = mount();
  pickScenario(view, "Stress");
  assert.match(text(view.tree), /appear when both algorithms have seen every synthetic patient/);
  view.click("Show final results");
  assert.match(text(view.tree), /Day complete/);
  const section = nodes(view.tree, (n) => n.type === "section" && n.props["aria-labelledby"] === "sim-final")[0];
  const run = view.lib.buildRun("sustained-arrivals", 20261029, 100);
  const rows = nodes(nodes(section, (n) => n.type === "table")[0], (n) => n.type === "tr").slice(1);
  assert.equal(rows.length, run.analysis.rows.length);
  for (const [i, row] of run.analysis.rows.entries()) {
    assert.deepEqual(nodes(rows[i], (n) => n.type === "td").map(text), [...row.shown, row.lowerIsBetter == null ? "n/a" : row.better || "tie"], row.label);
  }
  const all = text(section);
  for (const label of ["Average wait — Regular", "Maximum wait — Vulnerable", "95th-percentile wait — all patients", "Regular bypasses", "Priority-lane violations",
    "starvation evidence", "Throughput", "Mean utilization", "Patients completed"]) assert.match(all, new RegExp(label), label);
  assert.match(all, /Waiting time by classification/);
  assert.match(all, /still waiting is not starvation/);
  assert.match(all, /Registrations exceeded that capacity/);
  assert.match(all, /Evaluation criteria \(no overall winner is declared\)/);
  for (const line of run.analysis.findings.lines) assert.ok(all.includes(line), line);
});

test("keyboard: Space starts and pauses, Right arrow steps, R resets", () => {
  const view = mount();
  const press = (key) => { for (const fn of view.harness.listeners.keydown) fn({ key, target: { closest: () => null }, preventDefault() {} }); return view.render(); };
  press(" ");
  assert.equal(view.harness.timers.size, 1);
  press(" ");
  assert.equal(view.harness.timers.size, 0);
  press("ArrowRight");
  assert.notEqual(view.clock(), "08:00:00");
  press("r");
  assert.equal(view.clock(), "08:00:00");
});

test("helpers: playback clamps at the end, seeds are validated, the comparison marks the better value", () => {
  const lib = loadLib();
  assert.equal(lib.advance(10, 2, 1000, 600), 12);
  assert.equal(lib.advance(599, 20, 1000, 600), 600);
  assert.equal(lib.parseSeed(" 42 "), 42);
  for (const bad of ["", "-1", "1.5", "abc", "1234567890"]) assert.equal(lib.parseSeed(bad), null, bad);
  assert.equal(lib.formatDuration(75.5), "1:15:30");
  assert.equal(lib.formatDuration(9.25), "9:15");
  const run = lib.buildRun("vulnerable-majority", 20261029, 100);
  const end = Object.fromEntries(lib.ALGORITHM_IDS.map((a) => [a, lib.snapshotAt(run.timelines[a], run.end)]));
  const rows = lib.comparisonRows(end);
  const violations = rows.find((r) => r.label.startsWith("Priority-lane violations"));
  assert.equal(violations.values[0], "0");
  assert.equal(violations.better, "WPS-A");
  const completed = rows.find((r) => r.label === "Completed consultations");
  assert.equal(completed.values[0], completed.values[1], "both algorithms finish the same patients");
  assert.equal(completed.values[0], String(run.timelines["WPS-A"].patients.length));
  for (const label of ["Average wait (called patients)", "95th-percentile wait", "Maximum wait"]) {
    for (const value of rows.find((r) => r.label === label).values) assert.match(value, /^\d+\.\d min$/, `${label} uses one decimal for both algorithms`);
  }
  assert.equal(lib.sliderTime(run.end - 0.1, run.end), run.end, "the slider's last step reaches the exact end of the day");
  assert.equal(lib.sliderTime(120, run.end), 120);
});

test("dragging the time slider to its end completes every synthetic patient", () => {
  const view = mount();
  const slider = nodes(view.tree, (n) => n.type === "input" && n.props.type === "range")[0];
  const snapped = Math.floor(slider.props.max / 0.25) * 0.25;   // what a browser reports at the far right
  slider.props.onChange({ target: { value: String(snapped) } });
  const tree = view.render();
  const table = nodes(tree, (n) => n.type === "tr" && text(n).startsWith("Completed consultations"))[0];
  const total = view.lib.buildRun("regular-majority", 20261029, 100).timelines["WPS-A"].patients.length;
  assert.deepEqual(nodes(table, (n) => n.type === "td").map(text), [String(total), String(total)]);
  assert.match(text(tree), /Day complete/);
});

test("the page is Superadmin-only and the simulation never touches the API or database", () => {
  const route = (user) => {
    const harness = createHarness();
    const router = { replaced: [], replace(url) { this.replaced.push(url); } };
    const page = load("page", {
      react: harness.react, "react/jsx-runtime": jsxRuntime, "next/router": { useRouter: () => router },
      "../context/AuthContext": { useAuth: () => ({ user, loading: false }) },
      "../components/SiteFrame": { __esModule: true, default: function SiteFrame(props) { return { type: "site-frame", props }; } },
      "../components/AlgorithmSimulation": { __esModule: true, default: function AlgorithmSimulation() { return { type: "simulation", props: {} }; } }
    });
    const tree = harness.render(jsxRuntime.jsx(page.default, {}));
    return { tree, router };
  };
  for (const user of [null, { id_num: "frontdesk", role: "admin" }, { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" }]) {
    const { tree, router } = route(user);
    assert.deepEqual(router.replaced, ["/login"]);
    assert.equal(nodes(tree, (n) => n.type === "simulation").length, 0);
  }
  const { tree, router } = route({ id_num: "superadmin", role: "superadmin" });
  assert.deepEqual(router.replaced, []);
  assert.equal(tree.props.title, undefined, "the page names itself through its own Synthetic Data Only banner");
  for (const name of ["lib", "component", "page"]) {
    const source = fs.readFileSync(path.join(ROOT, SOURCES[name]), "utf8");
    assert.doesNotMatch(source, /lib\/api|request\(|fetch\(|supabase|localStorage/i, SOURCES[name]);
  }
  const lib = fs.readFileSync(path.join(ROOT, SOURCES.lib), "utf8");
  assert.match(lib, /from "\.\.\/\.\.\/backend\/simulation\/visual"/, "the page reuses the research simulator, not a copy");
});
