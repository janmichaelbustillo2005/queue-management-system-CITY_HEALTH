const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let componentCode, presenceCode;
before(async () => {
  await swc.loadBindings();
  const compile = async (relative, jsx = false) => {
    const filename = path.join(__dirname, relative);
    return (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx }, ...(jsx ? {
        transform: { react: { runtime: "automatic" } }
      } : {}) },
      module: { type: "commonjs" }
    })).code;
  };
  [componentCode, presenceCode] = await Promise.all([
    compile("../pages/index.js", true), compile("../lib/doctorPresence.js")
  ]);
  componentCode += "\nmodule.exports.dashboardHelpers = { formatDashboardChange, buildDashboardCards };";
});

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const observedAt = "2026-10-15T02:00:00.000Z";
const counter = (number, state = {}) => ({ id: number, id_num: `Doctor ${number}`,
  is_online: true, current_patient_id: null, ...state });
const presence = (number, online = true) => ({ doctor_name: `Doctor ${number}`, online, last_seen_at: observedAt });
const summary = (today = {}, yesterday = {}) => ({
  observed_at: observedAt, time_zone: "Asia/Manila", today_date: "2026-10-15", yesterday_date: "2026-10-14",
  today: { total_tokens: 1234, served_tokens: 90, average_wait_minutes: 12.5, wait_samples: 100, walk_ins: 10, ...today },
  yesterday: { total_tokens: 1000, served_tokens: 100, average_wait_minutes: 10, wait_samples: 110, walk_ins: 5, ...yesterday }
});
const titles = ["Total Tokens Today", "Served Tokens", "Average Waiting Time", "Active Counters", "No. of Walk-ins"];

async function harness(options = {}) {
  const hooks = [], dependencies = [], effects = [], cleanups = [], calls = [], intervals = new Map();
  let cursor = 0, timerId = 0, now = 1000;
  const performance = { now: () => now };
  const presenceModule = { exports: {} };
  vm.runInNewContext(presenceCode, { module: presenceModule, exports: presenceModule.exports, performance });
  const presenceHelpers = presenceModule.exports;
  const backend = { summary: summary(), counters: [counter(1), counter(2), counter(3)],
    doctors: [presence(1), presence(2), presence(3)], patients: [], error: null, ...options.backend };
  const settings = { autoRefresh: false, refreshInterval: 5, showCompleted: true, maxQueues: 100,
    doctor1Online: true, doctor2Online: true, doctor3Online: true };
  const user = options.user === undefined ? { id_num: "superadmin", role: "superadmin" } : options.user;
  const router = { isReady: true, query: { section: "home" }, push() {} };
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
      const index = cursor++, previous = dependencies[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        dependencies[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
      }
    }
  };
  const module = { exports: {} };
  const SiteFrame = () => {};
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, performance, AbortController, Set, Map, console,
    document: { addEventListener() {}, removeEventListener() {} },
    window: { confirm: () => true, prompt: () => null, setTimeout() {} },
    setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }, setTimeout: () => ++timerId, clearTimeout() {},
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link") return () => {};
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../components/SiteFrame") return SiteFrame;
      if (name === "../context/AuthContext") return { useAuth: () => ({ user, loading: false }) };
      if (name === "../components/SettingsModal") return { __esModule: true, default: () => {}, defaultQueueSettings: settings };
      if (name === "../lib/doctorPresence") return presenceHelpers;
      if (name === "../lib/queueSettings") return {
        loadLocalQueueSettings: () => settings, fetchQueueSettings: async () => settings,
        applyCounterAvailability: value => value, clearActiveQueues: async () => ({ success: true }),
        exportQueueData: async () => {}, saveQueueSettings: async value => value
      };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        calls.push({ route, method: init.method || "GET", cache: init.cache });
        if (route === "/stats/dashboard") {
          if (backend.error) throw new Error(backend.error);
          return options.request ? options.request(backend) : clone({ success: true, data: backend.summary });
        }
        if (route === "/queue") return clone({ patients: backend.patients, counters: backend.counters });
        if (route === "/stats") return { data: { waiting: 0, serving: 0, completed: 0, today_total_patients: 0 } };
        if (route === "/doctors/presence") return clone({ success: true, doctors: backend.doctors,
          counters: backend.counters, observed_at: observedAt, timeout_seconds: 75 });
        return { success: true };
      } };
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
    backend, calls, render, flush, helpers: module.exports.dashboardHelpers, presenceHelpers,
    snapshot(doctors = backend.doctors) { return presenceHelpers.captureDoctorPresence({
      success: true, doctors, observed_at: observedAt, timeout_seconds: 75
    }, now); },
    async poll() { now += 5000; [...intervals.values()].forEach(timer => timer.callback()); return flush(); },
    card(title) { return nodes(render(), node => node.type === "article" && node.props["aria-label"] === title)[0]; },
    dispose() { cleanups.forEach(cleanup => cleanup?.()); }
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
const cardByTitle = (cards, title) => cards.find(card => card.title === title);

test("dashboard uses real metric values, signed comparisons, and a minutes unit", async () => {
  const h = await harness();
  const cards = h.helpers.buildDashboardCards(summary(), h.backend.counters, h.snapshot(), 1000);
  assert.deepEqual(Array.from(cards, card => card.title), titles);
  assert.equal(cardByTitle(cards, titles[0]).value, "1,234");
  assert.match(cardByTitle(cards, titles[0]).comparison, /\+23\.4%.*yesterday/i);
  assert.equal(cardByTitle(cards, titles[1]).value, "90");
  assert.match(cardByTitle(cards, titles[1]).comparison, /-10\.0%.*yesterday/i);
  assert.equal(cardByTitle(cards, titles[2]).value, "12.5 min");
  assert.match(cardByTitle(cards, titles[2]).comparison, /\+25\.0%.*yesterday/i);
  assert.equal(cardByTitle(cards, titles[4]).value, "10");
  assert.match(cardByTitle(cards, titles[4]).comparison, /\+100\.0%/);
  h.dispose();
});

test("zero baselines and absent waiting samples never invent an increase or a measured wait", async () => {
  const h = await harness();
  const { formatDashboardChange, buildDashboardCards } = h.helpers;
  assert.match(formatDashboardChange(0, 0), /0\.0%/);
  assert.match(formatDashboardChange(5, 0), /No prior baseline/i);
  assert.match(formatDashboardChange(0, 5), /-100\.0%/);
  const cards = buildDashboardCards(summary({ average_wait_minutes: null, wait_samples: 0 },
    { average_wait_minutes: null, wait_samples: 0 }), [], null, 1000);
  assert.equal(cardByTitle(cards, titles[2]).value, "—");
  assert.match(cardByTitle(cards, titles[2]).comparison, /No calls yet/i);
  const firstWait = buildDashboardCards(summary({}, { average_wait_minutes: null, wait_samples: 0 }), [], null, 1000);
  assert.match(cardByTitle(firstWait, titles[2]).comparison, /No prior baseline/i);
  for (const card of buildDashboardCards(null, null, null, 1000)) {
    assert.match(card.value, /—/);
    assert.doesNotMatch(card.value + card.comparison, /NaN|Infinity|undefined/);
  }
  h.dispose();
});

test("active counters require enabled state and verified presence, including occupied counters", async () => {
  const h = await harness();
  const counters = [counter(1, { current_patient_id: 77 }), counter(2), counter(3, { is_online: false })];
  const cards = h.helpers.buildDashboardCards(summary(), counters,
    h.snapshot([presence(1), presence(2, false), presence(3)]), 1000);
  const active = cardByTitle(cards, titles[3]);
  assert.equal(active.value, "1/3", "serving an assigned patient still makes a counter operational");
  assert.match(active.comparison, /33\.3%.*operational/i);
  const missingEnabled = h.helpers.buildDashboardCards(summary(), counters, h.snapshot([presence(1)]), 1000);
  assert.equal(cardByTitle(missingEnabled, titles[3]).value, "—/3");
  assert.match(cardByTitle(missingEnabled, titles[3]).comparison, /Presence unavailable/i);
  const knownDisabled = h.helpers.buildDashboardCards(summary(), [counter(1), counter(2, { is_online: false })], h.snapshot([presence(1)]), 1000);
  assert.equal(cardByTitle(knownDisabled, titles[3]).value, "1/2", "disabled counters do not need session proof");
  const stale = h.helpers.buildDashboardCards(summary(), counters, h.snapshot(), 16000);
  assert.equal(cardByTitle(stale, titles[3]).value, "—/3");
  h.dispose();
});

test("the replacement is one five-card dashboard group and preserves navigation and dashboard sections", async () => {
  const h = await harness();
  const tree = h.render();
  const groups = nodes(tree, node => /\bdashboard-stat-grid\b/.test(node.props.className || ""));
  assert.equal(groups.length, 1);
  const cards = nodes(groups[0], node => node.type === "article");
  assert.deepEqual(cards.map(card => card.props["aria-label"]), titles);
  assert.ok(cards.every(card => /\bdashboard-stat-card\b/.test(card.props.className)));
  assert.equal(nodes(tree, node => node.type === "h3" && ["Queue Management", "Analytics", "Records"].includes(text(node))).length, 0);
  // Navigation now comes from the shared shell for the signed-in role; the page only names its section.
  assert.equal(tree.props.title, "Dashboard");
  assert.equal(tree.props.sidebarLinks, undefined);
  assert.equal(typeof tree.props.onSettings, "function");
  assert.match(text(tree), /Recent Activity/);
  assert.match(text(tree), /System Status/);
  assert.match(text(tree), /Doctor Sessions/);
  h.dispose();
});

test("dashboard metrics refresh independently of the existing queue auto-refresh preference", async () => {
  const h = await harness();
  assert.match(text(h.card(titles[0])), /1,234/);
  const queueReads = h.calls.filter(call => call.route === "/queue").length;
  h.backend.summary = summary({ total_tokens: 1235, served_tokens: 91, average_wait_minutes: 14.2, walk_ins: 11 });
  h.backend.counters[0].is_online = false;
  await h.poll();
  assert.match(text(h.card(titles[0])), /1,235/);
  assert.match(text(h.card(titles[1])), /91/);
  assert.match(text(h.card(titles[2])), /14\.2 min/);
  assert.match(text(h.card(titles[3])), /2\/3/);
  assert.match(text(h.card(titles[4])), /11/);
  assert.equal(h.calls.filter(call => call.route === "/queue").length, queueReads);
  const dashboardReads = h.calls.filter(call => call.route === "/stats/dashboard");
  assert.ok(dashboardReads.length >= 2);
  assert.ok(dashboardReads.every(call => call.cache === "no-store"));
  assert.ok(h.calls.every(call => call.method === "GET"), "monitoring must not mutate queue records");
  h.dispose();
});

test("failed and malformed dashboard reads clear old metrics and recover on a fresh response", async () => {
  let malformed = false;
  const h = await harness({ request: backend => malformed ? { success: true, data: {} } : { success: true, data: clone(backend.summary) } });
  h.backend.error = "Disconnected";
  await h.poll();
  for (const title of [titles[0], titles[1], titles[2], titles[4]]) assert.match(text(h.card(title)), /—/);
  h.backend.error = null;
  malformed = true;
  await h.poll();
  assert.match(text(h.card(titles[0])), /—/);
  malformed = false;
  h.backend.summary = summary({ total_tokens: 2000 });
  await h.poll();
  assert.match(text(h.card(titles[0])), /2,000/);
  h.dispose();
});
