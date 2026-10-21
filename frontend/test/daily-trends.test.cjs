const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const [name, relative] of Object.entries({
    component: "../components/DailyTrends.js", charts: "../lib/dailyTrendsCharts.js"
  })) {
    const filename = path.join(__dirname, relative);
    compiled[name] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function data(overrides = {}) {
  return {
    time_zone: "Asia/Manila", observed_at: "2026-10-15T03:15:00.000Z",
    range: { date: "2026-10-15", view: "day", start_time: "00:00", end_time: "24:00",
      start_at: "2026-10-14T16:00:00.000Z", end_at: "2026-10-15T16:00:00.000Z",
      effective_end_at: "2026-10-15T03:15:00.000Z" },
    hourly: [
      { label: "09:00", start_at: "2026-10-15T01:00:00Z", end_at: "2026-10-15T02:00:00Z",
        arrivals: 7, served: 3, waiting: 12, cancelled_no_show: 2,
        avg_wait_minutes: 8.5, wait_samples: 2, avg_service_minutes: 12, service_samples: 3 },
      { label: "10:00", start_at: "2026-10-15T02:00:00Z", end_at: "2026-10-15T03:00:00Z",
        arrivals: 9, served: 4, waiting: 8, cancelled_no_show: 1,
        avg_wait_minutes: null, wait_samples: 0, avg_service_minutes: 0, service_samples: 1 },
      { label: "12:00", start_at: "2026-10-15T04:00:00Z", end_at: "2026-10-15T05:00:00Z",
        arrivals: null, served: null, waiting: null, cancelled_no_show: null,
        avg_wait_minutes: null, wait_samples: 0, avg_service_minutes: null, service_samples: 0 }
    ],
    statuses: [
      { status: "waiting", label: "Waiting", count: 8, percentage: 50 },
      { status: "serving", label: "Serving", count: 2, percentage: 12.5 },
      { status: "completed", label: "Completed", count: 4, percentage: 25 },
      { status: "no-show", label: "No-show", count: 2, percentage: 12.5 }
    ],
    counters: [
      { id: 1, name: "Doctor 1", utilization_percent: null, active_service_minutes: 24,
        available_minutes: null, reason: "Historical counter operating time is not recorded." },
      { id: 2, name: "Doctor 2", utilization_percent: 25, active_service_minutes: 15,
        available_minutes: 60, reason: null }
    ],
    peak_hours: [
      { label: "10:00", arrivals: 9, start_at: "2026-10-15T02:00:00Z", end_at: "2026-10-15T03:00:00Z" },
      { label: "09:00", arrivals: 7, start_at: "2026-10-15T01:00:00Z", end_at: "2026-10-15T02:00:00Z" }
    ],
    record_count: 16, notes: [], has_activity: true, ...overrides
  };
}
const response = value => ({ success: true, data: clone(value) });
function responseForRange(value, route) {
  const selected = new URL(route, "http://localhost").searchParams;
  const result = clone(value);
  const date = selected.get("date"), view = selected.get("view");
  const startTime = view === "shift" ? selected.get("startTime") : "00:00";
  const endTime = view === "shift" ? selected.get("endTime") : "24:00";
  const start = Date.parse(`${date}T${startTime}:00+08:00`);
  let end = Date.parse(`${date}T${endTime}:00+08:00`);
  if (end < start) end += 86400000;
  result.range = { date, view, start_time: startTime, end_time: endTime,
    start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(),
    effective_end_at: new Date(Math.min(end, Date.parse(result.observed_at))).toISOString() };
  return response(result);
}
const nodes = (tree, predicate, result = []) => {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, predicate, result));
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

// A small renderer executes each function component with its own hooks and
// attaches canvas refs, so effects are verified without a DOM dependency.
function harness(options = {}) {
  const instances = new Map(), native = new Map(), timers = new Map(), calls = [], charts = [];
  const events = new Map();
  let active, timerId = 0, pendingEffects = [], disposed = false;
  const backend = { value: data(), error: null, ...options.backend };
  const props = { enabled: true, ...options.props };
  const same = (first, second) => first && second && first.length === second.length && first.every((item, i) => item === second[i]);
  const hook = () => {
    const index = active.cursor++;
    return { instance: active, index, slot: active.hooks[index] };
  };
  const memo = (callback, deps) => {
    const { instance, index, slot } = hook();
    if (!slot || !same(slot.deps, deps)) instance.hooks[index] = { deps, value: callback() };
    return instance.hooks[index].value;
  };
  const react = {
    useState(initial) {
      const { instance, index } = hook();
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === "function" ? initial() : initial;
      return [instance.hooks[index], next => {
        instance.hooks[index] = typeof next === "function" ? next(instance.hooks[index]) : next;
      }];
    },
    useRef(initial) {
      const { instance, index } = hook();
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
      return instance.hooks[index];
    },
    useMemo: memo,
    useCallback(callback, deps) { return memo(() => callback, deps); },
    useEffect(callback, deps) {
      const { instance, index, slot } = hook();
      if (!slot || !same(slot.deps, deps)) {
        instance.hooks[index] = { deps, cleanup: slot?.cleanup };
        pendingEffects.push(() => {
          instance.hooks[index].cleanup?.();
          instance.hooks[index].cleanup = callback();
        });
      }
    }
  };
  const jsx = (type, nodeProps, key) => ({ type, props: nodeProps || {}, key });
  const setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  const window = {
    setTimeout, clearTimeout,
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name) { events.delete(name); },
    Chart: class {
      constructor(context, config) { this.context = context; this.config = config; this.destroyed = false; charts.push(this); }
      destroy() { this.destroyed = true; }
    }
  };
  const chartConstructor = window.Chart;
  if (options.chart === null) window.Chart = null;
  const document = { visibilityState: "visible", hidden: false,
    addEventListener: window.addEventListener, removeEventListener: window.removeEventListener };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-10-15T03:15:00.000Z"])); }
    static now() { return new Date("2026-10-15T03:15:00.000Z").getTime(); }
  }
  const environment = { console, AbortController, URLSearchParams, Intl, Date: FixedDate, Set, Map,
    setTimeout, clearTimeout, window, document };
  const chartModule = { exports: {} };
  vm.runInNewContext(compiled.charts, { ...environment, module: chartModule, exports: chartModule.exports });
  const module = { exports: {} };
  vm.runInNewContext(compiled.component, { ...environment, module, exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/dailyTrendsCharts") return chartModule.exports;
      if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        const call = { route, init }; calls.push(call);
        if (options.request) return options.request(call, calls.length, backend);
        if (backend.error) return { error: backend.error };
        return responseForRange(backend.value, route);
      } };
      throw new Error(`Unexpected Daily Trends dependency: ${name}`);
    }
  });
  function expand(tree, address, seen) {
    if (Array.isArray(tree)) return tree.map((node, index) => expand(node, `${address}/${node?.key ?? index}`, seen));
    if (!tree || typeof tree !== "object") return tree;
    if (typeof tree.type === "function") {
      let instance = instances.get(address);
      if (!instance || instance.type !== tree.type) {
        instance?.hooks.forEach(slot => slot?.cleanup?.());
        instance = { type: tree.type, hooks: [], cursor: 0 }; instances.set(address, instance);
      }
      seen.add(address); active = instance; instance.cursor = 0;
      const output = tree.type(tree.props); active = null;
      return expand(output, `${address}/output`, seen);
    }
    if (tree.props.ref) {
      if (!native.has(address)) native.set(address, { getContext: () => ({ canvas: { address } }) });
      if (typeof tree.props.ref === "function") tree.props.ref(native.get(address));
      else tree.props.ref.current = native.get(address);
    }
    return { ...tree, props: { ...tree.props, children: expand(tree.props.children, `${address}/children`, seen) } };
  }
  const render = () => {
    const seen = new Set();
    const tree = expand(jsx(module.exports.default, props), "root", seen);
    for (const [address, instance] of instances) if (!seen.has(address)) {
      instance.hooks.forEach(slot => slot?.cleanup?.()); instances.delete(address);
    }
    return tree;
  };
  const settle = async () => {
    for (let pass = 0; pass < 4; pass++) {
      render(); pendingEffects.splice(0).forEach(effect => effect()); await tick();
    }
    return render();
  };
  return {
    backend, props, calls, charts, timers, render, settle, window, chartConstructor,
    helpers: chartModule.exports, exports: module.exports,
    field(label) { return nodes(render(), node => node.props["aria-label"] === label && ["select", "input"].includes(node.type))[0]; },
    change(label, value) {
      const field = this.field(label); assert.ok(field, `Missing field: ${label}`);
      field.props.onChange({ target: { value } });
    },
    async apply() {
      const form = nodes(render(), node => node.type === "form")[0];
      if (form?.props.onSubmit) form.props.onSubmit({ preventDefault() {} });
      else nodes(render(), node => node.type === "button" && /Apply range/.test(content(node)))[0].props.onClick();
      return settle();
    },
    async fire(delay) {
      const matching = [...timers].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of matching) { timers.delete(id); timer.callback(); }
      return settle();
    },
    dispose() {
      if (disposed) return;
      disposed = true; instances.forEach(instance => instance.hooks.forEach(slot => slot?.cleanup?.()));
      pendingEffects = [];
    }
  };
}

test("activity chart uses four real hourly series with the specified bars, waiting line, and future gaps", () => {
  const h = harness();
  const config = h.helpers.buildActivityChart(data());
  assert.equal(config.type, "bar");
  assert.deepEqual(Array.from(config.data.labels), ["09:00", "10:00", "12:00"]);
  const [arrivals, served, waiting, cancelled] = config.data.datasets;
  assert.deepEqual(Array.from(config.data.datasets, dataset => dataset.type), ["bar", "bar", "line", "bar"]);
  assert.deepEqual(Array.from(arrivals.data), [7, 9, null]);
  assert.deepEqual(Array.from(served.data), [3, 4, null]);
  assert.deepEqual(Array.from(waiting.data), [12, 8, null], "waiting snapshots must not reuse arrival counts");
  assert.deepEqual(Array.from(cancelled.data), [2, 1, null]);
  assert.equal(arrivals.backgroundColor, "#3b82f6");
  assert.equal(served.backgroundColor, "#10b981");
  assert.equal(waiting.borderColor, "#f59e0b");
  assert.equal(cancelled.backgroundColor, "#ef4444");
  assert.equal(waiting.spanGaps, false);
  assert.equal(config.options.responsive, true);
  assert.equal(config.options.maintainAspectRatio, false);
  assert.match(config.options.plugins.tooltip.callbacks.label({ dataset: waiting, raw: 12 }), /Waiting patients: 12/);
  assert.match(config.options.plugins.tooltip.callbacks.label({ dataset: waiting, raw: null }), /No data available/);
});

test("waiting and service charts retain zero durations, omit missing values, and disclose valid visit samples", () => {
  const h = harness();
  for (const [metric, values, color, sampleText] of [
    ["wait", [8.5, null, null], "#8b5cf6", /8\.5 min.*2 valid visits/],
    ["service", [12, 0, null], "#10b981", /12 min.*3 valid visits/]
  ]) {
    const config = h.helpers.buildDurationChart(data(), metric);
    const dataset = config.data.datasets[0];
    assert.equal(config.type, "line");
    assert.deepEqual(Array.from(dataset.data), values);
    assert.equal(dataset.borderColor, color);
    assert.equal(dataset.fill, true);
    assert.equal(dataset.spanGaps, false);
    assert.equal(config.options.scales.y.title.text, "Minutes");
    const tooltip = config.options.plugins.tooltip.callbacks.label;
    assert.match(tooltip({ raw: values[0], dataIndex: 0 }), sampleText);
    assert.match(tooltip({ raw: null, dataIndex: 2 }), /No data available/);
    if (metric === "service") assert.match(tooltip({ raw: 0, dataIndex: 1 }), /0 min.*1 valid visit\b/);
  }
});

test("status doughnut uses actual backend statuses and counts with count/percentage tooltips", () => {
  const h = harness();
  const sample = data({ statuses: [
    { status: "waiting", label: "Waiting", count: 8, percentage: 50 },
    { status: "no-show", label: "No-show", count: 2, percentage: 12.5 },
    { status: "deferred", label: "Deferred", count: 6, percentage: 37.5 }
  ] });
  const config = h.helpers.buildStatusChart(sample);
  assert.equal(config.type, "doughnut");
  assert.deepEqual(Array.from(config.data.labels), ["Waiting", "No-show", "Deferred"]);
  assert.deepEqual(Array.from(config.data.datasets[0].data), [8, 2, 6]);
  assert.equal(config.data.datasets[0].backgroundColor.length, 3);
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataIndex: 1 }), "No-show: 2 (12.5%)");
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataIndex: 2 }), "Deferred: 6 (37.5%)");
  assert.equal(config.options.responsive, true);
});

test("invalid numeric metrics cannot become measured zeroes, NaN, or invented chart values", () => {
  const h = harness();
  for (const missing of [null, undefined, "8", NaN, Infinity, -1]) assert.equal(h.helpers.finiteMetric(missing), null);
  assert.equal(h.helpers.finiteMetric(0), 0);
  const config = h.helpers.buildActivityChart(data({ hourly: [{ label: "09:00", arrivals: "7", served: NaN,
    waiting: -1, cancelled_no_show: Infinity }] }));
  for (const dataset of config.data.datasets) assert.deepEqual(Array.from(dataset.data), [null]);
});

test("date and daily/shift filters use Manila dates and accept an explicitly entered overnight shift", () => {
  const h = harness();
  assert.equal(h.helpers.getManilaToday(new Date("2026-10-14T15:59:59.000Z")), "2026-10-14");
  assert.equal(h.helpers.getManilaToday(new Date("2026-10-14T16:00:00.000Z")), "2026-10-15");
  assert.deepEqual(clone(h.helpers.makeFilters("2026-10-15", "day", "09:00", "17:00")),
    { date: "2026-10-15", view: "day" });
  assert.deepEqual(clone(h.helpers.makeFilters("2026-10-15", "shift", "22:30", "06:15")),
    { date: "2026-10-15", view: "shift", startTime: "22:30", endTime: "06:15" });
  for (const date of ["", "2026-02-30", "2026-13-01", "10/15/2026"]) {
    assert.throws(() => h.helpers.makeFilters(date), /valid date/i);
  }
  for (const times of [["", ""], ["8:00", "17:00"], ["24:00", "17:00"], ["09:00", "09:00"]]) {
    assert.throws(() => h.helpers.makeFilters("2026-10-15", "shift", ...times), /shift/i);
  }
  assert.throws(() => h.helpers.makeFilters("2026-10-15", "invented"), /valid view/i);
});

const headings = ["Patient Queue Activity", "Average Waiting Time", "Average Service Time", "Queue Status Distribution", "Counter Utilization", "Peak Hours"];
const activeCharts = h => h.charts.filter(chart => !chart.destroyed);
const activityChart = h => activeCharts(h).find(chart => chart.config.data.datasets.length === 4);
const params = call => new URL(call.route, "http://localhost").searchParams;

test("Daily Trends renders all six panels, real status labels, recorded utilization, and ranked arrivals", async () => {
  const h = harness();
  assert.match(content(h.render()), /Loading/);
  const tree = await h.settle();
  assert.deepEqual(nodes(tree, node => node.type === "h3").map(content), headings);
  assert.equal(nodes(tree, node => node.type === "h2" && content(node) === "Daily Trends").length, 1);
  assert.deepEqual(nodes(tree, node => node.type === "canvas").map(node => node.props["aria-label"]), headings.slice(0, 4));
  assert.equal(activeCharts(h).length, 4);
  assert.match(content(tree), /Asia\/Manila/);
  const statuses = nodes(tree, node => node.props["aria-label"] === "Queue statuses")[0];
  assert.match(content(statuses), /Waiting850%/);
  assert.match(content(statuses), /No-show212\.5%/);
  const progress = nodes(tree, node => node.props.role === "progressbar");
  assert.equal(progress.length, 1, "a counter with no recorded operating time must not get an invented percentage");
  assert.equal(progress[0].props["aria-label"], "Doctor 2 utilization");
  assert.equal(progress[0].props["aria-valuenow"], 25);
  assert.match(content(tree), /Doctor 1No data available.*Historical counter operating time/s);
  assert.match(content(tree), /15 active min \/ 60 available min/);
  const peaks = nodes(tree, node => node.type === "ol")[0];
  assert.deepEqual(nodes(peaks, node => node.type === "li").map(content), ["110:009 arrivals", "209:007 arrivals"]);
  h.dispose();
  assert.equal(activeCharts(h).length, 0, "unmount releases every chart instance");
});

test("daily and explicitly entered overnight shift filters apply locally without changing other analytics filters", async () => {
  const h = harness();
  await h.settle();
  assert.equal(h.field("Date").props.value, "2026-10-15");
  assert.equal(params(h.calls[0]).get("date"), "2026-10-15");
  assert.equal(params(h.calls[0]).get("view"), "day");
  h.change("Date", "2026-10-14");
  assert.equal(h.calls.length, 1, "editing the draft does not send requests");
  await h.apply();
  assert.equal(h.calls.length, 2);
  assert.equal(params(h.calls[1]).get("date"), "2026-10-14");
  assert.equal(params(h.calls[1]).has("startTime"), false);
  h.change("View", "shift");
  assert.equal(h.field("Shift starts").props.value, "");
  assert.equal(h.field("Shift ends").props.value, "");
  await h.apply();
  assert.equal(h.calls.length, 2);
  assert.match(content(h.render()), /Choose both a shift start and end time/);
  h.change("Shift starts", "22:30");
  h.change("Shift ends", "06:15");
  await h.apply();
  assert.equal(h.calls.length, 3);
  assert.equal(params(h.calls[2]).get("view"), "shift");
  assert.equal(params(h.calls[2]).get("startTime"), "22:30");
  assert.equal(params(h.calls[2]).get("endTime"), "06:15");
  assert.doesNotMatch(content(h.render()), /invalid or mismatched/);
  assert.equal(activeCharts(h).length, 4);
  assert.ok(h.calls.every(call => call.route.startsWith("/analytics/daily-trends?")));
  h.dispose();
});

test("a slow request never overlaps polling, and each settled refresh updates the chart from read-only data", async () => {
  const initial = deferred();
  const h = harness({ request: (_call, number, backend) => number === 1 ? initial.promise : response(backend.value) });
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(activeCharts(h).length, 0);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 15000), false);
  await h.fire(15000);
  assert.equal(h.calls.length, 1);
  initial.resolve(response(data()));
  await h.settle();
  assert.equal(activityChart(h).config.data.datasets[0].data[0], 7);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.backend.value.hourly[0].arrivals = 23;
  await h.fire(15000);
  assert.equal(h.calls.length, 2);
  assert.equal(activityChart(h).config.data.datasets[0].data[0], 23);
  assert.equal(activeCharts(h).length, 4, "refresh replaces charts instead of accumulating canvas instances");
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  assert.ok(h.calls.every(call => (call.init.method || "GET") === "GET"));
  assert.ok(h.calls.every(call => call.init.cache === "no-store"));
  h.dispose();
  assert.equal(h.timers.size, 0);
});

test("changing range aborts the earlier request and ignores its late response", async () => {
  const first = deferred(), second = deferred();
  const h = harness({ request: (_call, number) => number === 1 ? first.promise : second.promise });
  await h.settle();
  h.change("Date", "2026-10-14");
  await h.apply();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.calls[1].init.signal.aborted, false);
  const fresh = data(); fresh.range.date = "2026-10-14"; fresh.hourly[0].arrivals = 42;
  second.resolve(response(fresh));
  await h.settle();
  assert.equal(activityChart(h).config.data.datasets[0].data[0], 42);
  first.resolve(response(data()));
  await h.settle();
  assert.equal(activityChart(h).config.data.datasets[0].data[0], 42);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.dispose();
});

test("unmount aborts a pending request and leaves no refreshes or late chart writes", async () => {
  const pending = deferred();
  const h = harness({ request: () => pending.promise });
  await h.settle();
  h.dispose();
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  pending.resolve(response(data()));
  await tick();
  assert.equal(h.timers.size, 0);
  assert.equal(h.charts.length, 0);
});

test("empty ranges and unavailable durations render honest no-data states", async () => {
  const h = harness({ backend: { value: data({ hourly: [], statuses: [], counters: [], peak_hours: [],
    record_count: 0, has_activity: false }) } });
  const empty = await h.settle();
  assert.match(content(empty), /No queue visits recorded in this range/);
  assert.equal(nodes(empty, node => node.type === "canvas").length, 0);
  assert.equal((content(empty).match(/No data available/g) || []).length, 6);
  h.backend.value = data({ hourly: data().hourly.map(row => ({ ...row, avg_wait_minutes: null,
    wait_samples: 0, avg_service_minutes: null, service_samples: 0 })) });
  await h.fire(15000);
  assert.deepEqual(nodes(h.render(), node => node.type === "canvas").map(node => node.props["aria-label"]),
    ["Patient Queue Activity", "Queue Status Distribution"]);
  assert.equal(activeCharts(h).length, 2);
  h.dispose();
});

test("API errors identify stale data and recover automatically from the next successful response", async () => {
  const h = harness();
  await h.settle();
  h.backend.error = "Connection unavailable";
  await h.fire(15000);
  assert.match(content(h.render()), /Connection unavailable/);
  assert.match(content(h.render()), /Showing the last successful result/);
  assert.equal(activityChart(h).config.data.datasets[0].data[0], 7);
  h.backend.error = null;
  h.backend.value.hourly[0].arrivals = 33;
  await h.fire(15000);
  assert.doesNotMatch(content(h.render()), /Connection unavailable|Showing the last successful result/);
  assert.equal(activityChart(h).config.data.datasets[0].data[0], 33);
  h.dispose();
});

test("timed-out requests abort, show an error, and retry without inventing initial metrics", async () => {
  const h = harness({ request: (call, number) => number > 1 ? response(data()) : new Promise(resolve => {
    call.init.signal.addEventListener("abort", () => resolve({ error: "aborted" }), { once: true });
  }) });
  await h.settle();
  await h.fire(10000);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.match(content(h.render()), /request timed out/i);
  assert.equal(activeCharts(h).length, 0);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  await h.fire(15000);
  assert.equal(h.calls.length, 2);
  assert.equal(activeCharts(h).length, 4);
  assert.doesNotMatch(content(h.render()), /request timed out/i);
  h.dispose();
});

test("auth gating prevents analytics requests until the authorized parent enables the section", async () => {
  const h = harness({ props: { enabled: false } });
  await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.props.enabled = true;
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(activeCharts(h).length, 4);
  h.props.enabled = false;
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(activeCharts(h).length, 0);
  h.dispose();
});

test("charts wait for the existing Chart.js library and recover from draw errors without extra API reads", async () => {
  const h = harness({ chart: null });
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(activeCharts(h).length, 0);
  assert.match(content(h.render()), /Preparing chart/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 500).length, 4);
  h.window.Chart = class { constructor() { throw new Error("Canvas temporarily unavailable"); } };
  await h.fire(500);
  assert.match(content(h.render()), /Unable to display this chart/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 3000).length, 4);
  h.window.Chart = h.chartConstructor;
  await h.fire(3000);
  assert.equal(activeCharts(h).length, 4);
  assert.equal(h.calls.length, 1, "chart-library retries reuse the successful analytics response");
  assert.doesNotMatch(content(h.render()), /Preparing chart|Unable to display this chart/);
  h.dispose();
  assert.equal(h.timers.size, 0);
});

test("malformed and mismatched API results show errors safely and a manual retry recovers immediately", async () => {
  const cases = [
    data({ hourly: [null] }), data({ counters: [{}] }), data({ statuses: null }),
    data({ observed_at: "not a timestamp" }), data({ time_zone: "UTC" }),
    data({ range: { ...data().range, date: "2026-10-14" } })
  ];
  let reply = response(cases[0]);
  const h = harness({ request: () => clone(reply) });
  await h.settle();
  for (let i = 0; i < cases.length; i++) {
    if (i) { reply = response(cases[i]); await h.fire(15000); }
    assert.match(content(h.render()), /invalid or mismatched daily trends result/);
    assert.equal(activeCharts(h).length, 0);
  }
  reply = response(data());
  const retry = nodes(h.render(), node => node.type === "button" && content(node) === "Retry now")[0];
  const previousReads = h.calls.length;
  retry.props.onClick();
  await h.settle();
  assert.equal(h.calls.length, previousReads + 1);
  assert.equal(activeCharts(h).length, 4);
  assert.doesNotMatch(content(h.render()), /invalid or mismatched/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.dispose();
});
