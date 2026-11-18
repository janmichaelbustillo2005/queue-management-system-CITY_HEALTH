// Trends Analytics and Status Analytics tabs. The API responses are produced by the real backend
// aggregation (backend/src/services/rangeAnalyticsService.js) from fixture visits, so these tests
// also hold the screens to the backend's actual response shape.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const swc = require("next/dist/build/swc");

const FILES = {
  services: "lib/services.js", lib: "lib/rangeAnalytics.js", kit: "components/AnalyticsDashboard.js",
  trends: "components/TrendsAnalytics.js", status: "components/StatusAnalytics.js"
};
const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const [name, relative] of Object.entries(FILES)) {
    const filename = path.join(__dirname, "..", relative);
    compiled[name] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

// ---- Backend fixtures ----------------------------------------------------------------------------
function loadBackend() {
  const root = path.resolve(__dirname, "../../backend/src");
  const stubs = { [path.join(root, "lib/supabase.js")]: {}, [path.join(root, "config/env.js")]: {} };
  const original = Module._load;
  Module._load = function load(request, parent, ...rest) {
    const resolved = Module._resolveFilename(request, parent, ...rest);
    return resolved in stubs ? stubs[resolved] : original.call(this, request, parent, ...rest);
  };
  try { return require(path.join(root, "services/rangeAnalyticsService.js")); } finally { Module._load = original; }
}
const backend = loadBackend();
const NOW_ISO = "2026-10-15T02:30:00.000Z"; // 10:30 AM Manila
const NOW = new Date(NOW_ISO);
const at = (time, day = "2026-10-15") => `${day}T${time}:00+08:00`;
const visit = (id, overrides) => ({ id, status: "waiting", created_at: at("08:00"), called_at: null, consultation_started_at: null,
  completed_at: null, counter_id: null, service_type: "medical_consultation", queue_number: `MC-${String(id).padStart(3, "0")}`, ...overrides });
const counters = [{ id: 1, id_num: "Doctor 1" }, { id: 2, id_num: "Doctor 2" }, { id: 3, id_num: "Doctor 3" }];
const patients = [
  visit(1, { status: "completed", called_at: at("08:10"), consultation_started_at: at("08:12"), completed_at: at("08:30"), counter_id: "Doctor 1" }),
  visit(2, { status: "completed", created_at: at("08:20"), called_at: at("09:00"), consultation_started_at: at("09:05"), completed_at: at("09:25"), counter_id: "Doctor 2", service_type: "family_planning" }),
  visit(3, { created_at: at("09:10") }),
  visit(4, { status: "cancelled", created_at: at("09:30"), completed_at: at("09:45"), counter_id: "Doctor 1", service_type: "dental_healthcare" }),
  visit(5, { status: "serving", created_at: at("10:00"), called_at: at("10:05"), consultation_started_at: at("10:06"), counter_id: "Doctor 3" }),
  visit(8, { created_at: at("15:00", "2026-10-13") })
];
// Patient Records: visits 1 and 2 belong to record 201 (created today), visit 5 to record 202
// (created yesterday, a returning patient); the others were registered without a record.
patients.forEach((row) => { row.patient_record_id = { 1: 201, 2: 201, 5: 202 }[row.id] ?? null; });
// The name stored on the visit (patients.id_num), read only for the Queue Status Records table.
patients.forEach((row) => { row.id_num = { 1: "Ramos, Juan P.", 4: "Dela Cruz, Maria L." }[row.id] ?? null; });
const profiles = [{ id: 201, created_at: at("08:00") }, { id: 202, created_at: at("09:00", "2026-10-14") }];
function apiResponse(route) {
  const url = new URL(route, "http://localhost");
  const query = Object.fromEntries(url.searchParams);
  try {
    const period = backend.buildPeriod(query, NOW);
    const names = { "Doctor 1": "Dr. Santos" };
    if (url.pathname === "/analytics/trends") return { success: true, data: backend.aggregateTrendsAnalytics(patients, counters, period, NOW, { profiles }), doctor_display_names: names };
    if (url.pathname === "/analytics/status/overview") return { success: true, data: backend.aggregateStatusOverview(patients, counters, period, query, NOW), doctor_display_names: names };
    if (url.pathname === "/analytics/status/records") return { success: true, data: backend.statusRecords(patients, counters, period, query, NOW) };
  } catch (error) {
    return { success: false, error: error.message };
  }
  throw new Error(`Unexpected route ${route}`);
}

// ---- Module loading and a small hooks renderer ----------------------------------------------------
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodes = (tree, predicate, result = []) => {
  if (Array.isArray(tree)) tree.forEach((child) => nodes(child, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
};
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (tree && typeof tree === "object") return content(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
const css = new Proxy({}, { get: (_target, key) => key === "__esModule" ? true : key === "default" ? css : key });

function modules(environment, extra = {}) {
  const loaded = {};
  const load = (name, map) => {
    const module = { exports: {} };
    vm.runInNewContext(compiled[name], { ...environment, module, exports: module.exports, require(request) {
      if (request in map) return map[request];
      if (request.endsWith(".module.css")) return css;
      throw new Error(`Unexpected dependency ${request} from ${name}`);
    } });
    return module.exports;
  };
  loaded.services = load("services", {});
  loaded.lib = load("lib", { "./services": loaded.services });
  if (extra.react) {
    const common = { react: extra.react, "react/jsx-runtime": extra.jsxRuntime, "../lib/rangeAnalytics": loaded.lib, "../lib/services": loaded.services,
      "../lib/api": extra.api, "next/link": { __esModule: true, default: "Link" } };
    loaded.kit = load("kit", common);
    loaded.trends = load("trends", { ...common, "./AnalyticsDashboard": loaded.kit });
    loaded.status = load("status", { ...common, "./AnalyticsDashboard": loaded.kit });
  }
  return loaded;
}

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW_ISO])); }
  static now() { return Date.parse(NOW_ISO); }
}
const baseEnvironment = { console, URLSearchParams, URL, Intl, Date: FixedDate, Math, Number, String, Object, Array, JSON, Set, Map, Promise, Error };
const lib = () => modules(baseEnvironment).lib;

function harness(which, options = {}) {
  const instances = new Map(), timers = new Map(), calls = [], charts = [];
  let active, timerId = 0, pendingEffects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const hook = () => { const index = active.cursor++; return { instance: active, index, slot: active.hooks[index] }; };
  const memo = (callback, deps) => {
    const { instance, index, slot } = hook();
    if (!slot || !same(slot.deps, deps)) instance.hooks[index] = { deps, value: callback() };
    return instance.hooks[index].value;
  };
  const react = {
    useState(initial) {
      const { instance, index } = hook();
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === "function" ? initial() : initial;
      return [instance.hooks[index], (next) => { instance.hooks[index] = typeof next === "function" ? next(instance.hooks[index]) : next; }];
    },
    useRef(initial) {
      const { instance, index } = hook();
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
      return instance.hooks[index];
    },
    useMemo: memo,
    useEffect(callback, deps) {
      const { instance, index, slot } = hook();
      if (!slot || !same(slot.deps, deps)) {
        instance.hooks[index] = { deps, cleanup: slot?.cleanup };
        pendingEffects.push(() => { instance.hooks[index].cleanup?.(); instance.hooks[index].cleanup = callback(); });
      }
    }
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const window = { Chart: class { constructor(context, config) { this.config = config; this.destroyed = false; charts.push(this); } destroy() { this.destroyed = true; } } };
  const api = { request: async (route) => {
    calls.push(route);
    if (options.request) return options.request(route, calls.length);
    return apiResponse(route);
  } };
  const environment = { ...baseEnvironment, AbortController, setTimeout, clearTimeout, window };
  const loaded = modules(environment, { react, jsxRuntime: { jsx, jsxs: jsx, Fragment: "Fragment" }, api });
  const Component = loaded[which].default;
  const native = new Map();
  function expand(tree, address, seen) {
    if (Array.isArray(tree)) return tree.map((node, index) => expand(node, `${address}/${node?.key ?? index}`, seen));
    if (!tree || typeof tree !== "object") return tree;
    if (typeof tree.type === "function") {
      let instance = instances.get(address);
      if (!instance || instance.type !== tree.type) {
        instance?.hooks.forEach((slot) => slot?.cleanup?.());
        instance = { type: tree.type, hooks: [], cursor: 0 };
        instances.set(address, instance);
      }
      seen.add(address); active = instance; instance.cursor = 0;
      const output = tree.type(tree.props); active = null;
      return expand(output, `${address}/output`, seen);
    }
    if (tree.props.ref) {
      if (!native.has(address)) native.set(address, { getContext: () => ({}) });
      tree.props.ref.current = native.get(address);
    }
    return { ...tree, props: { ...tree.props, children: expand(tree.props.children, `${address}/children`, seen) } };
  }
  const render = () => {
    const seen = new Set();
    const tree = expand(jsx(Component, { enabled: options.enabled ?? true }), "root", seen);
    for (const [address, instance] of instances) if (!seen.has(address)) { instance.hooks.forEach((slot) => slot?.cleanup?.()); instances.delete(address); }
    return tree;
  };
  const settle = async () => {
    for (let pass = 0; pass < 6; pass++) { render(); pendingEffects.splice(0).forEach((effect) => effect()); await tick(); }
    return render();
  };
  const field = (label) => nodes(render(), (node) => node.props?.["aria-label"] === label && ["select", "input"].includes(node.type))[0];
  return {
    calls, charts, timers, render, settle, lib: loaded.lib,
    change(label, value) { const found = field(label); assert.ok(found, `Missing field ${label}`); found.props.onChange({ target: { value } }); },
    async apply() { nodes(render(), (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} }); return settle(); },
    async click(label) {
      const found = nodes(render(), (node) => node.type === "button" && (node.props["aria-label"] === label || content(node) === label))[0];
      assert.ok(found, `Missing button ${label}`);
      found.props.onClick();
      return settle();
    },
    async fire(delay) {
      for (const [id, timer] of [...timers].filter(([, timer]) => timer.delay === delay)) { timers.delete(id); timer.callback(); }
      return settle();
    },
    dispose() { instances.forEach((instance) => instance.hooks.forEach((slot) => slot?.cleanup?.())); pendingEffects = []; }
  };
}
const params = (route) => new URL(route, "http://localhost").searchParams;
const kpis = (tree) => nodes(tree, (node) => node.type === "article" && String(node.props.className).includes("kpi "))
  .map((card) => [content(nodes(card, (node) => node.type === "h3")[0]), content(nodes(card, (node) => String(node.props.className).includes("kpiValue"))[0])]);
const cardTitles = (tree) => nodes(tree, (node) => node.type === "article" && String(node.props.className).startsWith("card"))
  .map((card) => content(nodes(card, (node) => node.type === "h3")[0]));
const canvases = (tree) => nodes(tree, (node) => node.type === "canvas").map((node) => node.props["aria-label"]);
const tableRows = (tree, title) => {
  const region = nodes(tree, (node) => node.props?.role === "region" && node.props["aria-label"] === title)[0];
  return nodes(nodes(region, (node) => node.type === "tbody")[0], (node) => node.type === "tr").map((row) => nodes(row, (node) => node.type === "td").map(content));
};

// ---- Pure helpers --------------------------------------------------------------------------------
test("date-range filters: presets, validated custom ranges, optional hours for one day only", () => {
  const { makeRangeQuery, defaultDraft } = lib();
  assert.deepEqual({ ...defaultDraft(NOW) }, { range: "today", startDate: "2026-10-15", endDate: "2026-10-15", startTime: "", endTime: "" });
  assert.deepEqual({ ...makeRangeQuery({ range: "7d", startDate: "x" }) }, { range: "7d" });
  assert.deepEqual({ ...makeRangeQuery({ range: "custom", startDate: "2026-10-01", endDate: "2026-10-07" }) },
    { range: "custom", startDate: "2026-10-01", endDate: "2026-10-07" });
  assert.deepEqual({ ...makeRangeQuery({ range: "custom", startDate: "2026-10-01", endDate: "2026-10-01", startTime: "22:00", endTime: "06:00" }) },
    { range: "custom", startDate: "2026-10-01", endDate: "2026-10-01", startTime: "22:00", endTime: "06:00" });
  for (const [draft, message] of [
    [{ range: "week" }, /Choose a date range/],
    [{ range: "custom", startDate: "2026-10-09", endDate: "2026-10-01" }, /on or before/],
    [{ range: "custom", startDate: "2026-02-30", endDate: "2026-03-01" }, /valid start and end/],
    [{ range: "custom", startDate: "2024-01-01", endDate: "2026-01-01" }, /at most 366/],
    [{ range: "custom", startDate: "2026-10-01", endDate: "2026-10-02", startTime: "08:00", endTime: "12:00" }, /same day/],
    [{ range: "custom", startDate: "2026-10-01", endDate: "2026-10-01", startTime: "08:00" }, /both a start and an end/],
    [{ range: "custom", startDate: "2026-10-01", endDate: "2026-10-01", startTime: "08:00", endTime: "08:00" }, /must differ/]
  ]) assert.throws(() => makeRangeQuery(draft), message);
});

test("labels: 12-hour clock for hours, short dates for days, compact interval names", () => {
  const { bucketLabel, bucketTitle, groupLabel, describePeriod } = lib();
  const day = { granularity: "hour", start_date: "2026-10-15", days: 1, start_time: "00:00", end_time: "24:00" };
  assert.equal(bucketLabel({ start_at: "2026-10-15T00:00:00.000Z", date: "2026-10-15" }, day), "8 AM");
  assert.equal(bucketLabel({ start_at: "2026-10-15T05:00:00.000Z", date: "2026-10-15" }, day), "1 PM");
  assert.equal(bucketLabel({ start_at: "2026-10-15T16:30:00.000Z", date: "2026-10-16" }, day), "12:30 AM +1d");
  assert.equal(bucketTitle({ start_at: "2026-10-15T00:00:00.000Z", end_at: "2026-10-15T01:00:00.000Z", date: "2026-10-15" }, day), "8 AM – 9 AM, Oct 15");
  const range = { granularity: "day", start_date: "2026-10-30", end_date: "2026-11-05", days: 7 };
  assert.equal(bucketLabel({ date: "2026-11-01" }, range), "Nov 1");
  assert.equal(groupLabel({ start_date: "2026-11-01", end_date: "2026-11-04" }, range), "Nov 1–4");
  assert.equal(groupLabel({ start_date: "2026-10-30", end_date: "2026-11-02" }, range), "Oct 30–Nov 2");
  assert.equal(describePeriod(range), "Oct 30, 2026 – Nov 5, 2026 · 7 days");
  const months = { granularity: "month", start_date: "2025-11-01", end_date: "2026-10-15", days: 349 };
  assert.equal(bucketLabel({ date: "2026-10-01" }, months), "Oct 2026");
  assert.equal(bucketTitle({ date: "2025-11-01", end_date: "2025-11-30" }, months), "November 2025");
  assert.equal(bucketTitle({ date: "2026-10-01", end_date: "2026-10-15" }, months), "October 2026 (Oct 1–15)", "a partial month says so");
  assert.equal(groupLabel({ start_date: "2026-02-01", end_date: "2026-02-28" }, months), "Feb 2026");
});

test("Trends: Last 12 Months is monthly, and the monthly records add up to the KPIs", async () => {
  const h = harness("trends");
  await h.settle();
  h.change("Date range", "12m");
  const tree = await h.apply();
  assert.equal(params(h.calls.at(-1)).get("range"), "12m");
  assert.deepEqual(kpis(tree).slice(0, 3), [["Total Patient Visits", "6"], ["Completed Consultations", "2"], ["New Patient Records", "2"]]);
  const rows = tableRows(tree, "Trend Records");
  assert.equal(rows.length, 12, "one row per calendar month");
  assert.deepEqual(rows[0].slice(0, 5), ["October 2026 (Oct 1–15)", "6", "2", "2", "1"]);
  assert.deepEqual(rows[1].slice(0, 5), ["September 2026", "0", "0", "0", "0"]);
  assert.match(content(tree), /Monthly summary of patient queue activity/);
  assert.match(content(tree), /compare with the same period a year earlier/);
  h.dispose();
});

test("comparisons state direction and period, never a percentage from a missing or zero baseline", () => {
  const { comparison } = lib();
  const label = "vs previous 7 days";
  assert.deepEqual({ ...comparison({ value: 12, previous: 10, change_percent: 20 }, label) }, { text: "20% vs previous 7 days", direction: "up" });
  assert.deepEqual({ ...comparison({ value: 8, previous: 10, change_percent: -20 }, label) }, { text: "20% vs previous 7 days", direction: "down" });
  assert.equal(comparison({ value: 5, previous: 0, change_percent: null }, label).text, "No comparison available (none in the previous period)");
  assert.equal(comparison({ value: 5, previous: null, change_percent: null }, label).text, "No comparison available");
  assert.equal(comparison({ value: null, previous: 3, change_percent: null }, label).text, "No data available");
  assert.equal(comparison({ value: 0, previous: 0, change_percent: 0 }, label).text, "No change vs previous 7 days");
});

test("clinic hours show 8 AM–5 PM and widen to every hour with activity; multi-day ranges are never trimmed", () => {
  const { visibleBuckets } = lib();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, arrivals: 0, completed: 0, cancelled: 0, waiting: 0, future: false }));
  const day = { granularity: "hour", time_window: false };
  const quiet = visibleBuckets(hours, day);
  assert.deepEqual([quiet.rows.length, quiet.first, quiet.last, quiet.trimmed], [9, 8, 17, true]);
  hours[6].arrivals = 1; hours[19].waiting = null;
  const wide = visibleBuckets(hours, day);
  assert.deepEqual([wide.first, wide.last], [6, 20], "an early arrival and an unknown evening snapshot are both kept");
  assert.equal(visibleBuckets(hours, day, "all").rows.length, 24);
  assert.equal(visibleBuckets(hours, { granularity: "day" }).rows.length, 24);
});

test("activity chart: the four approved series, nonnegative integer axis, gaps for unknown and future values", () => {
  const { buildActivityChart } = lib();
  const data = backend.aggregateTrendsAnalytics(patients, counters, backend.buildPeriod({ range: "today" }, NOW), NOW);
  const rows = data.buckets.filter((row) => row.hour >= 8 && row.hour <= 11);
  const built = buildActivityChart(rows, data.period);
  const chart = { ...JSON.parse(JSON.stringify(built)), options: { ...JSON.parse(JSON.stringify(built.options)), plugins: built.options.plugins } };
  assert.equal(chart.type, "line");
  assert.deepEqual(chart.data.labels, ["8 AM", "9 AM", "10 AM", "11 AM"]);
  // New patient records are not a visit series; they stay in the KPI card and the Trend Records table.
  assert.deepEqual(chart.data.datasets.map((set) => set.label), ["Patient Arrivals", "Completed", "Waiting (at interval end)", "Cancelled"]);
  assert.deepEqual(chart.data.datasets.map((set) => set.borderColor), ["#3B82F6", "#16A34A", "#F59E0B", "#EF4444"]);
  assert.deepEqual(chart.data.datasets[0].data, [2, 2, 1, null]);
  assert.deepEqual(chart.data.datasets[2].borderDash, [5, 4], "the waiting snapshot is visibly distinct from the event counts");
  assert.deepEqual([...built.data.datasets.map((set) => set.fill)], ["origin", "origin", false, false], "light areas under arrivals and completed only");
  assert.equal(typeof built.data.datasets[0].backgroundColor, "function", "the area is a gradient sized to the chart");
  assert.ok(chart.data.datasets.every((set) => set.tension === 0 && set.spanGaps === false), "straight segments, no invented in-between values");
  assert.deepEqual(chart.data.datasets.map((set) => set.order), [4, 3, 1, 2], "arrivals are drawn underneath, so equal series stay visible");
  assert.equal(chart.options.scales.y.title.text, "Number of Visits");
  assert.equal(chart.options.scales.y.ticks.precision, 0);
  assert.equal(chart.options.scales.y.beginAtZero, true);
  const label = chart.options.plugins.tooltip.callbacks.label;
  assert.equal(label({ dataset: built.data.datasets[0], raw: null, dataIndex: 3 }), "Patient Arrivals: No data available (not reached yet)");
  assert.equal(chart.options.plugins.tooltip.callbacks.title([{ dataIndex: 0 }]), "8 AM – 9 AM, Oct 15");
});

test("service bars use real service names, keep the top entries, wrap long names and print exact counts", () => {
  const { buildHorizontalBars, valueLabels, wrapLabel } = lib();
  const services = [{ service: "medical_consultation", count: 9 }, { service: "environmental_health", count: 4 }, { service: "food_safety", count: 2 },
    { service: "nutrition", count: 1 }, { service: "not_recorded", count: 1 }, { service: "dental_healthcare", count: 1 }];
  const chart = buildHorizontalBars(services, { limit: 5 });
  assert.equal(chart.options.indexAxis, "y");
  assert.deepEqual(chart.data.datasets[0].data, [9, 4, 2, 1, 1]);
  assert.deepEqual(chart.data.labels.map((label) => [].concat(label).join(" ")), ["Medical consultation", "Environmental health", "Food safety", "Nutrition", "Service not recorded"]);
  assert.ok(chart.plugins.includes(valueLabels));
  assert.equal(chart.options.plugins.tooltip.callbacks.title([{ dataIndex: 1 }]), "Environmental health");
  assert.deepEqual([].concat(wrapLabel("Medical documentation and certificates", 22)), ["Medical documentation", "and certificates"]);
  // Ranked bars run from dark to light green, whatever the number of bars.
  assert.deepEqual(chart.data.datasets[0].backgroundColor, ["#00843D", "#16A34A", "#22C55E", "#6EE7A0", "#86EFAC"]);
  const all = buildHorizontalBars(Array.from({ length: 13 }, (_, index) => ({ service: `s${index}`, count: 13 - index })), { limit: 13 });
  assert.equal(all.data.datasets[0].backgroundColor[0], "#00843D");
  assert.equal(all.data.datasets[0].backgroundColor[12], "#86EFAC");
});

test("doctor charts: fixed green per doctor, labelled bars, crowded or empty bars left unlabelled", () => {
  const { buildWorkloadChart, buildDoctorBars, valueLabels, DOCTOR_COLORS } = lib();
  assert.deepEqual([...DOCTOR_COLORS.slice(0, 3)], ["#00843D", "#4ADE80", "#86EFAC"]);
  const workload = { doctors: ["Doctor 1", "Doctor 2", "Doctor 3"] };
  const groups = [{ start_date: "2026-10-01", end_date: "2026-10-04", counts: { "Doctor 1": 3, "Doctor 2": 0, "Doctor 3": 2 } }];
  const chart = buildWorkloadChart(workload, groups, { granularity: "day" }, {});
  assert.deepEqual(chart.data.datasets.map((set) => set.backgroundColor), ["#00843D", "#4ADE80", "#86EFAC"]);
  assert.ok(chart.plugins.includes(valueLabels));
  assert.deepEqual({ ...chart.options.plugins.qmsValueLabels }, { skipZero: true, minSize: 9 });
  assert.equal(chart.options.scales.y.title.text, "Completed Visits");
  // The label plugin skips zero and too-thin bars.
  const drawn = [];
  const fake = {
    options: {}, data: { datasets: [{ data: [3, 0, 5] }] },
    getDatasetMeta: () => ({ hidden: false, data: [{ x: 10, y: 50, width: 20 }, { x: 40, y: 90, width: 20 }, { x: 70, y: 30, width: 6 }] }),
    ctx: { save() {}, restore() {}, fillText: (text) => drawn.push(text) }
  };
  valueLabels.afterDatasetsDraw(fake, {}, { skipZero: true, minSize: 9 });
  assert.deepEqual(drawn, ["3"]);
  const bars = buildDoctorBars([{ doctor: "Doctor 1", total: 9 }, { doctor: "Doctor 2", total: 8 }, { doctor: "Doctor 3", total: 8 }], {});
  assert.deepEqual(bars.data.datasets[0].backgroundColor, ["#00843D", "#22C55E", "#4ADE80"]);
  assert.equal(bars.options.scales.y.title.text, "Assigned Visits");
});

test("completion trend writes each known value above its point", () => {
  const { buildAreaLine, pointLabels } = lib();
  const rows = [{ start_at: at("08:00"), date: "2026-10-15", completed: 1 }, { start_at: at("09:00"), date: "2026-10-15", completed: 0 }, { start_at: at("10:00"), date: "2026-10-15", completed: null, future: true }];
  const chart = buildAreaLine(rows, { granularity: "hour", start_date: "2026-10-15" }, { field: "completed", label: "Completed", labels: true });
  assert.ok(chart.plugins.includes(pointLabels));
  assert.equal(buildAreaLine(rows, { granularity: "hour" }, { field: "completed", label: "Completed" }).plugins.length, 0, "labels only when asked");
  const drawn = [];
  pointLabels.afterDatasetsDraw({ data: chart.data, getDatasetMeta: () => ({ hidden: false, data: rows.map((_, index) => ({ x: index, y: 10 })) }),
    ctx: { save() {}, restore() {}, fillText: (text) => drawn.push(text) } });
  assert.deepEqual(drawn, ["1", "0"], "zero is a real count; an unknown point gets no label");
});

test("page list: every page up to seven, otherwise first, last and the pages around the current one", async () => {
  const { pageList } = modules(baseEnvironment, { react: {}, jsxRuntime: { jsx() {}, jsxs() {}, Fragment: "Fragment" }, api: {} }).kit;
  assert.deepEqual([...pageList(1, 5)], [1, 2, 3, 4, 5]);
  assert.deepEqual([...pageList(1, 12)], [1, 2, 3, 4, 5, "gap-end", 12]);
  assert.deepEqual([...pageList(6, 12)], [1, "gap-start", 5, 6, 7, "gap-end", 12]);
  assert.deepEqual([...pageList(12, 12)], [1, "gap-start", 8, 9, 10, 11, 12]);
});

test("doughnuts colour each status consistently and leave out empty statuses", () => {
  const { buildStatusDoughnut } = lib();
  const chart = buildStatusDoughnut([{ status: "completed", count: 3, percentage: 60 }, { status: "waiting", count: 0, percentage: 0 },
    { status: "serving", count: 1, percentage: 20 }, { status: "cancelled", count: 1, percentage: 20 }]);
  assert.deepEqual(chart.data.labels, ["Completed", "Serving", "Cancelled"]);
  assert.deepEqual(chart.data.datasets[0].backgroundColor, ["#16A34A", "#3B82F6", "#EF4444"]);
  assert.equal(chart.options.plugins.tooltip.callbacks.label({ dataIndex: 0 }), "Completed: 3 visits (60%)");
});

test("table helpers: search across shown text, stable sorting with unknowns last, clamped pages, safe CSV", () => {
  const { searchRows, sortRows, pageRows, toCsv } = lib();
  const columns = [{ key: "ticket", label: "Ticket" }, { key: "wait", label: "Wait" }];
  const rows = [{ ticket: "MC-002", wait: 5 }, { ticket: "FP-001", wait: null }, { ticket: "MC-010", wait: 2 }];
  assert.deepEqual(searchRows(rows, "mc-", columns).map((row) => row.ticket), ["MC-002", "MC-010"]);
  assert.deepEqual(sortRows(rows, columns[1], "asc").map((row) => row.ticket), ["MC-010", "MC-002", "FP-001"]);
  assert.deepEqual(sortRows(rows, columns[1], "desc").map((row) => row.ticket), ["MC-002", "MC-010", "FP-001"]);
  assert.deepEqual(sortRows(rows, columns[0], "asc").map((row) => row.ticket), ["FP-001", "MC-002", "MC-010"]);
  const paged = pageRows(rows, 9, 2);
  assert.deepEqual([paged.page, paged.pages, paged.rows.length], [2, 2, 1]);
  assert.equal(toCsv(columns, [{ ticket: '=HYPERLINK("x")', wait: 'a"b' }]), '"Ticket","Wait"\r\n"\'=HYPERLINK(""x"")","a""b"');
});

test("results for another period or filter are rejected", () => {
  const { isTrendsData, isStatusOverviewData } = lib();
  const trends = backend.aggregateTrendsAnalytics(patients, counters, backend.buildPeriod({ range: "today" }, NOW), NOW);
  assert.equal(isTrendsData(trends, { range: "today" }), true);
  assert.equal(isTrendsData(trends, { range: "7d" }), false);
  assert.equal(isTrendsData({ ...trends, outcome: { ...trends.outcome, total: 99 } }, { range: "today" }), false, "statuses must add up to the total");
  const overview = backend.aggregateStatusOverview(patients, counters, backend.buildPeriod({ range: "today" }, NOW), { status: "waiting" }, NOW);
  assert.equal(isStatusOverviewData(overview, { range: "today" }, { status: "waiting" }), true);
  assert.equal(isStatusOverviewData(overview, { range: "today" }, { status: "" }), false);
});

// ---- Trends Analytics ------------------------------------------------------------------------------
test("Trends Analytics renders the approved layout from real backend values", async () => {
  const h = harness("trends");
  assert.match(content(h.render()), /Loading/);
  const tree = await h.settle();
  assert.equal(content(nodes(tree, (node) => node.type === "h2")[0]), "Trends Analytics");
  assert.match(content(tree), /Monitor patient queue activity, service performance, and overall trends over time\./);
  assert.deepEqual(kpis(tree), [["Total Patient Visits", "5"], ["Completed Consultations", "2"], ["New Patient Records", "1"],
    ["Average Waiting Time", "18.3min"], ["Average Service Time", "19min"]]);
  assert.match(content(tree), /Of the 5 visits counted: 3 visits are linked to 2 registered patients in Patient Records; 2 visits have no linked patient record and are counted as visits only\./);
  assert.doesNotMatch(content(tree), /5 visits[^.;]*belong to 2/, "never implies that every visit belongs to the registered patients");
  assert.deepEqual(cardTitles(tree), ["Patient Queue Activity Trend", "Patient Volume by Service", "Consultation Outcome",
    "Doctor Workload Trend", "Average Waiting Time Trend", "Trend Records"]);
  assert.deepEqual(canvases(tree), ["Patient Queue Activity Trend", "Patient Volume by Service", "Consultation Outcome",
    "Doctor Workload Trend", "Average Waiting Time Trend"]);
  assert.equal(h.charts.filter((chart) => !chart.destroyed).length, 5);
  assert.match(content(tree), /40%Completed/, "2 of 5 registered visits completed");
  assert.match(content(tree), /Total5100%/, "the outcome legend ends with the total");
  assert.match(content(tree), /Registered, completed, waiting, and cancelled visits over time\./);
  assert.match(content(tree), /Hourly average waiting time in minutes\./);
  const legends = nodes(tree, (node) => node.type === "ul" && node.props["aria-label"] === "Chart legend").map(content);
  assert.deepEqual(legends, ["Patient ArrivalsCompletedWaiting (at interval end)Cancelled", "Dr. Santos (Doctor 1)Doctor 2Doctor 3"], "legends sit below the activity and workload charts");
  // Patient Volume by Service: the top services, or every one of the 13 offered services (zeros included).
  const serviceBars = () => h.charts.filter((chart) => !chart.destroyed && chart.config.options.indexAxis === "y").at(-1).config.data.datasets[0].data;
  assert.deepEqual([...serviceBars()], [3, 1, 1]);
  const all = await h.click("All services");
  assert.equal(serviceBars().length, 13);
  assert.equal(serviceBars().reduce((sum, value) => sum + value, 0), 5, "showing all services adds no visits");
  assert.ok(nodes(all, (node) => node.type === "button" && content(node) === "Top 7").length, "and can go back to the top services");
  assert.match(content(tree), /Dr\. Santos \(Doctor 1\)/, "doctors carry their current display name and stable ID");
  assert.match(content(tree), /Asia\/Manila/);
  assert.match(content(tree), /refreshes every 15 seconds/);
  // Clinic hours 8 AM–5 PM, today's hours so far: 8, 9 and 10 AM.
  // Columns: hour, arrivals, new patient records, completed, cancelled.
  assert.deepEqual(tableRows(tree, "Trend Records").map((row) => row.slice(0, 5)), [
    ["10 AM – 11 AM, Oct 15", "1", "0", "0", "0"], ["9 AM – 10 AM, Oct 15", "2", "0", "1", "1"], ["8 AM – 9 AM, Oct 15", "2", "1", "1", "0"],
    ...Array.from({ length: 8 }, (_, index) => [`${(7 - index) % 12 || 12} ${7 - index < 12 ? "AM" : "PM"} – ${(8 - index) % 12 || 12} ${8 - index < 12 ? "AM" : "PM"}, Oct 15`, "0", "0", "0", "0"])
  ].slice(0, 11));
  assert.equal([...h.timers.values()].filter((timer) => timer.delay === 15000).length, 1, "a live period refreshes");
  h.dispose();
  assert.equal(h.charts.filter((chart) => !chart.destroyed).length, 0);
});

test("Trends: Last 7 Days and custom ranges reload every section; invalid ranges never send a request", async () => {
  const h = harness("trends");
  await h.settle();
  h.change("Date range", "7d");
  let tree = await h.apply();
  assert.equal(params(h.calls.at(-1)).get("range"), "7d");
  assert.deepEqual(kpis(tree)[0], ["Total Patient Visits", "6"]);
  assert.equal(tableRows(tree, "Trend Records").length, 7, "one row per day");
  h.change("Date range", "custom");
  h.change("Start date", "2026-10-14");
  h.change("End date", "2026-10-13");
  const before = h.calls.length;
  tree = await h.apply();
  assert.equal(h.calls.length, before);
  assert.match(content(tree), /The start date must be on or before the end date\./);
  h.change("Start date", "2026-10-01");
  h.change("End date", "2026-10-03");
  tree = await h.apply();
  const sent = params(h.calls.at(-1));
  assert.deepEqual([sent.get("range"), sent.get("startDate"), sent.get("endDate")], ["custom", "2026-10-01", "2026-10-03"]);
  assert.deepEqual(kpis(tree).map(([, value]) => value), ["0", "0", "0", "No data available", "No data available"]);
  assert.match(content(tree), /No queue visits or patient records were recorded in this period/);
  assert.equal(canvases(tree).length, 0, "no empty chart grids for an empty period");
  assert.match(content(tree), /finished period/);
  assert.equal([...h.timers.values()].filter((timer) => timer.delay === 15000).length, 0, "a finished period is not polled");
  h.dispose();
});

test("Trends: manual Refresh reloads the applied range while retaining unapplied date edits", async () => {
  const h = harness("trends");
  await h.settle();
  h.change("Date range", "7d");
  const applied = await h.apply();
  h.change("Date range", "custom");
  h.change("Start date", "2026-10-14");
  h.change("End date", "2026-10-15");
  const before = h.calls.length;
  const refreshed = await h.click("Refresh");
  assert.equal(h.calls.length, before + 1, "Refresh sends one new Trends request");
  assert.deepEqual(Object.fromEntries(params(h.calls.at(-1))), { range: "7d" });
  assert.deepEqual(kpis(refreshed), kpis(applied));
  assert.deepEqual(tableRows(refreshed, "Trend Records"), tableRows(applied, "Trend Records"));
  for (const [label, value] of [["Date range", "custom"], ["Start date", "2026-10-14"], ["End date", "2026-10-15"]]) {
    assert.equal(nodes(refreshed, (node) => node.props?.["aria-label"] === label)[0].props.value, value, `${label} draft stays visible`);
  }
  h.dispose();
});

test("Trends: an API failure shows a clear error and no invented figures; Retry recovers", async () => {
  let fail = true;
  const h = harness("trends", { request: (route) => fail ? { success: false, error: "Analytics could not read the queue database." } : apiResponse(route) });
  let tree = await h.settle();
  assert.match(content(tree), /Analytics could not read the queue database\. No figures are shown until the data loads\./);
  assert.ok(kpis(tree).every(([, value]) => value === "—" || value === "No data available"));
  fail = false;
  tree = await h.click("Retry");
  assert.doesNotMatch(content(tree), /could not read/);
  assert.equal(kpis(tree)[0][1], "5");
  h.dispose();
});

// ---- Status Analytics ------------------------------------------------------------------------------
test("Status Analytics renders cards, three charts, completion trend, average times and the records table", async () => {
  const h = harness("status");
  const tree = await h.settle();
  assert.equal(content(nodes(tree, (node) => node.type === "h2")[0]), "Status Analytics");
  const cards = kpis(tree);
  assert.deepEqual(cards, [["Total Visits", "5"], ["Waiting", "1"], ["Serving", "1"], ["Completed", "2"], ["Cancelled", "1"]]);
  // The same patient-record calculation and wording as Trends Analytics.
  assert.match(content(tree), /Of the 5 visits counted: 3 visits are linked to 2 registered patients in Patient Records; 2 visits have no linked patient record and are counted as visits only\./);
  assert.equal(cards.slice(1).reduce((sum, [, value]) => sum + Number(value), 0), 5, "the statuses add up to Total Visits");
  assert.match(content(tree), /40% of total visits/);
  assert.deepEqual(cardTitles(tree), ["Queue Status Distribution", "Visits by Doctor", "Visits by Service (Top 5)", "Completion Trend", "Average Times", "Queue Status Records"]);
  assert.deepEqual(canvases(tree), ["Queue Status Distribution", "Visits by Doctor", "Visits by Service (Top 5)", "Completion Trend"]);
  assert.match(content(tree), /5Total Visits/);
  assert.match(content(tree), /Assigned visits, any status\. 1 unassigned visit not shown\./, "unassigned visits are never placed under a doctor");
  assert.match(content(tree), /Average Waiting Time18\.3minsFrom registration to callBased on 3 called patients/);
  assert.match(content(tree), /Average Service Time19minsFrom consultation start to completionBased on 2 completed consultations/);
  assert.match(content(tree), /Not counted above: 1 patient still waiting who registered before this period\./);
  assert.equal(nodes(tree, (node) => node.type === "Link" && node.props.href === "/queue-backlog").length, 0, "no link to the removed Historical Backlog");
  // Columns: #, ticket, patient name, service, doctor, registration, call, completion, status. One day: clock times only.
  const rows = tableRows(tree, "Queue Status Records");
  assert.deepEqual(rows.map((row) => row[0]), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(rows.map((row) => row[1]), ["MC-005", "MC-004", "MC-003", "MC-002", "MC-001"]);
  assert.deepEqual(rows[1].slice(2), ["Dela Cruz, Maria L.", "Dental healthcare", "Dr. Santos (Doctor 1)", "9:30 AM", "—", "Cancelled 9:45 AM", "Cancelled"]);
  assert.deepEqual([rows[2][2], rows[2][4]], ["Not recorded", "Unassigned"], "a visit without a stored name says so; no name is guessed");
  assert.match(content(tree), /Showing 1 to 5 of 5 records/);
  const searchBox = nodes(tree, (node) => node.type === "input" && node.props["aria-label"] === "Search patient, ticket, or service")[0];
  assert.equal(searchBox.props.placeholder, "Search patient, ticket, or service...");
  h.change("Search patient, ticket, or service", "dela cruz");
  const found = h.render();
  assert.deepEqual(tableRows(found, "Queue Status Records").map((row) => row.slice(0, 3)), [["1", "MC-004", "Dela Cruz, Maria L."]]);
  assert.match(content(found), /Showing 1 to 1 of 1 matching record/);
  h.dispose();
});

test("Status filters combine and narrow cards, charts and records together", async () => {
  const h = harness("status");
  await h.settle();
  h.change("Doctor", "Doctor 1");
  h.change("Status", "completed");
  const tree = await h.apply();
  for (const path of ["/analytics/status/overview", "/analytics/status/records"]) {
    const sent = params(h.calls.filter((route) => route.startsWith(path)).at(-1));
    assert.deepEqual([sent.get("doctor"), sent.get("status"), sent.get("service")], ["Doctor 1", "completed", null]);
  }
  assert.deepEqual(kpis(tree).map(([, value]) => value), ["1", "0", "0", "1", "0"]);
  assert.deepEqual(tableRows(tree, "Queue Status Records").map((row) => row[1]), ["MC-001"]);
  assert.match(content(tree), /Doctor: Dr\. Santos \(Doctor 1\)/);
  assert.match(content(tree), /Status: Completed/);
  h.change("Doctor", "");
  h.change("Status", "waiting");
  const waiting = await h.apply();
  assert.match(content(waiting), /No data available — the status filter excludes completed visits\./);
  assert.match(content(waiting), /Average Service TimeNo data available/);
  assert.doesNotMatch(content(waiting), /Average Service Time0/, "a missing average is never shown as zero");
  h.dispose();
});

test("Status: manual Refresh reloads overview and records with applied filters while retaining unapplied edits", async () => {
  const h = harness("status");
  await h.settle();
  h.change("Date range", "7d");
  h.change("Service", "medical_consultation");
  h.change("Doctor", "Doctor 1");
  h.change("Status", "completed");
  const applied = await h.apply();
  h.change("Date range", "30d");
  h.change("Service", "family_planning");
  h.change("Doctor", "Doctor 2");
  h.change("Status", "waiting");
  const before = h.calls.length;
  const refreshed = await h.click("Refresh");
  const requests = h.calls.slice(before);
  assert.deepEqual(requests.map((route) => new URL(route, "http://localhost").pathname).sort(),
    ["/analytics/status/overview", "/analytics/status/records"]);
  for (const route of requests) {
    assert.deepEqual(Object.fromEntries(params(route)), {
      range: "7d", service: "medical_consultation", doctor: "Doctor 1", status: "completed"
    });
  }
  assert.deepEqual(kpis(refreshed), kpis(applied));
  assert.deepEqual(tableRows(refreshed, "Queue Status Records"), tableRows(applied, "Queue Status Records"));
  for (const [label, value] of [["Date range", "30d"], ["Service", "family_planning"], ["Doctor", "Doctor 2"], ["Status", "waiting"]]) {
    assert.equal(nodes(refreshed, (node) => node.props?.["aria-label"] === label)[0].props.value, value, `${label} draft stays visible`);
  }
  h.dispose();
});

test("patient-record wording: linked visits, distinct registered patients and unlinked visits are stated apart", () => {
  const { patientLinksText } = lib();
  assert.equal(patientLinksText({ visits: 27, distinct_patients: 1, linked_visits: 2, unlinked_visits: 25 }),
    "Of the 27 visits counted: 2 visits are linked to 1 registered patient in Patient Records; 25 visits have no linked patient record and are counted as visits only.");
  assert.equal(patientLinksText({ visits: 3, distinct_patients: 2, linked_visits: 3, unlinked_visits: 0 }),
    "Of the 3 visits counted: 3 visits are linked to 2 registered patients in Patient Records.");
  assert.equal(patientLinksText({ visits: 1, distinct_patients: 0, linked_visits: 0, unlinked_visits: 1 }),
    "Of the 1 visit counted: No visit is linked to a registered patient in Patient Records; 1 visit has no linked patient record and is counted as a visit only.");
  assert.equal(patientLinksText(null), "", "unavailable links show nothing rather than a guess");
  assert.equal(patientLinksText({ visits: 0, distinct_patients: 0, linked_visits: 0, unlinked_visits: 0 }), "");
});
