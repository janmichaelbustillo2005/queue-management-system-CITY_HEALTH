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
    component: "../components/StatusAnalytics.js", charts: "../lib/statusAnalyticsCharts.js", sharedCharts: "../lib/dailyTrendsCharts.js"
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
  const metric = (value, previous, change_percent) => ({ value, previous, change_percent });
  return {
    time_zone: "Asia/Manila", observed_at: "2026-10-15T03:15:00.000Z",
    range: { date: "2026-10-15", view: "day", start_time: "00:00", end_time: "24:00",
      start_at: "2026-10-14T16:00:00.000Z", end_at: "2026-10-15T16:00:00.000Z",
      effective_end_at: "2026-10-15T03:15:00.000Z" },
    comparison_range: { date: "2026-10-14", view: "day", start_time: "00:00", end_time: "24:00",
      start_at: "2026-10-13T16:00:00.000Z", end_at: "2026-10-14T16:00:00.000Z",
      effective_end_at: "2026-10-14T03:15:00.000Z" },
    metrics: {
      total_patients: metric(16, 32, -50), waiting_patients: metric(8, 10, -20),
      currently_serving: metric(2, 0, null), completed_patients: metric(4, 8, -50),
      avg_wait_minutes: metric(8.5, 17, -50), avg_service_minutes: metric(12, null, null)
    },
    hourly: [
      { label: "09:00", start_at: "2026-10-15T01:00:00Z", end_at: "2026-10-15T02:00:00Z",
        arrivals: 7, served: 3, waiting: 12, cancelled_no_show: 2,
        avg_wait_minutes: 8.5, wait_samples: 2, avg_service_minutes: 12, service_samples: 3, avg_queue_length: 3.25 },
      { label: "10:00", start_at: "2026-10-15T02:00:00Z", end_at: "2026-10-15T03:00:00Z",
        arrivals: 9, served: 4, waiting: 8, cancelled_no_show: 1,
        avg_wait_minutes: null, wait_samples: 0, avg_service_minutes: 0, service_samples: 1, avg_queue_length: 8.5 },
      { label: "12:00", start_at: "2026-10-15T04:00:00Z", end_at: "2026-10-15T05:00:00Z",
        arrivals: null, served: null, waiting: null, cancelled_no_show: null,
        avg_wait_minutes: null, wait_samples: 0, avg_service_minutes: null, service_samples: 0, avg_queue_length: null }
    ],
    statuses: [
      { status: "waiting", label: "Waiting", count: 8, percentage: 50 },
      { status: "serving", label: "Serving", count: 2, percentage: 12.5 },
      { status: "completed", label: "Completed", count: 4, percentage: 25 },
      { status: "no-show", label: "No-show", count: 2, percentage: 12.5 }
    ],
    counters: [
      { id: 1, name: "Doctor 1", total_served: 3, avg_service_minutes: 8, total_service_minutes: 24,
        utilization_percent: null, active_service_minutes: 24, available_minutes: null,
        status: "Enabled", reason: "Historical counter operating time is not recorded." },
      { id: 2, name: "Doctor 2", total_served: 4, avg_service_minutes: 6.25, total_service_minutes: 25,
        utilization_percent: null, active_service_minutes: 25, available_minutes: null,
        status: "Disabled", reason: "Historical counter operating time is not recorded." }
    ],
    rates: { elapsed_hours: 11.25, arrival_rate_per_hour: 5.5, service_rate_per_hour: 3.25,
      completion_rate_percent: 25, completion_numerator: 4, completion_denominator: 16,
      operational_status: "Insufficient Data", description: "Observed arrivals and completed services per elapsed hour; service capacity is not recorded." },
    record_count: 16, notes: ["Counter availability history is not recorded."], ...overrides
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
  result.comparison_range = { ...result.range,
    date: new Date(start - 86400000 + 8 * 3600000).toISOString().slice(0, 10),
    start_at: new Date(start - 86400000).toISOString(), end_at: new Date(end - 86400000).toISOString(),
    effective_end_at: new Date(Math.min(end, Date.parse(result.observed_at)) - 86400000).toISOString() };
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
  const sharedModule = { exports: {} };
  vm.runInNewContext(compiled.sharedCharts, { ...environment, module: sharedModule, exports: sharedModule.exports });
  const chartModule = { exports: {} };
  vm.runInNewContext(compiled.charts, { ...environment, module: chartModule, exports: chartModule.exports,
    require(name) {
      if (name === "./dailyTrendsCharts") return sharedModule.exports;
      throw new Error(`Unexpected chart dependency: ${name}`);
    }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.component, { ...environment, module, exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/statusAnalyticsCharts") return chartModule.exports;
      if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        const call = { route, init }; calls.push(call);
        if (options.request) return options.request(call, calls.length, backend);
        if (backend.error) return { error: backend.error };
        return responseForRange(backend.value, route);
      } };
      throw new Error(`Unexpected Status Analytics dependency: ${name}`);
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

const headings = ["Patient Status Distribution", "Waiting vs. Service Time", "Patient Arrival and Service Rate",
  "Patient Arrivals vs. Served", "Counter Utilization", "Average Queue Length", "Counter Performance Summary"];
const activeCharts = h => h.charts.filter(chart => !chart.destroyed);
const arrivalChart = h => activeCharts(h).find(chart => chart.config.type === "bar");
const params = call => new URL(call.route, "http://localhost").searchParams;
function button(h, label) {
  const found = nodes(h.render(), node => node.type === "button" && content(node) === label)[0];
  assert.ok(found, `Missing ${label} button`);
  return found;
}

test("Status Analytics renders the requested panels and existing counters without inventing utilization", async () => {
  const h = harness();
  assert.match(content(h.render()), /Loading/);
  const tree = await h.settle();
  assert.equal(nodes(tree, node => node.type === "h2" && content(node) === "Status Analytics").length, 1);
  assert.match(content(tree), /Overall queue performance and operational efficiency/);
  assert.deepEqual(nodes(tree, node => node.type === "h3").map(content).slice(6), headings);
  assert.deepEqual(nodes(tree, node => node.type === "canvas").map(node => node.props["aria-label"]),
    [headings[0], headings[1], headings[3], headings[5]]);
  assert.equal(activeCharts(h).length, 4);
  assert.match(content(tree), /Asia\/Manila/);
  assert.equal(nodes(tree, node => node.props.role === "progressbar").length, 0,
    "current counter availability alone cannot establish recorded operating time");
  const table = nodes(tree, node => node.type === "table")[0];
  assert.ok(table);
  assert.deepEqual(nodes(table, node => node.type === "th" && node.props.scope === "col").map(content),
    ["Counter", "Total Served", "Average Service Time", "Total Service Time", "Utilization Rate", "Status"]);
  const rows = nodes(table, node => node.type === "tbody")[0];
  assert.match(content(rows), /Doctor 1.*3.*8.*24.*No data available.*Enabled/s);
  assert.match(content(rows), /Doctor 2.*4.*6\.3.*25.*No data available.*Disabled/s);
  assert.match(content(tree), /Insufficient Data/);
  assert.doesNotMatch(content(tree), /\bStable\b/);
  h.dispose();
  assert.equal(activeCharts(h).length, 0);
  assert.equal(h.timers.size, 0);
});

test("daily and custom overnight filters update a single shared response for all metrics and charts", async () => {
  const h = harness();
  await h.settle();
  assert.equal(h.field("Date").props.value, "2026-10-15");
  assert.equal(params(h.calls[0]).get("view"), "day");
  h.change("Date", "2026-10-14");
  assert.equal(h.calls.length, 1, "draft edits do not fetch partial analytics");
  await h.apply();
  assert.equal(h.calls.length, 2);
  assert.equal(params(h.calls[1]).get("date"), "2026-10-14");
  assert.equal(params(h.calls[1]).has("startTime"), false);
  h.change("View", "shift");
  await h.apply();
  assert.equal(h.calls.length, 2, "incomplete shift must not fetch");
  assert.match(content(h.render()), /Choose both a shift start and end time/);
  h.change("Shift starts", "22:30");
  h.change("Shift ends", "06:15");
  h.backend.value.hourly[0].arrivals = 42;
  h.backend.value.metrics.total_patients.value = 42;
  await h.apply();
  assert.equal(h.calls.length, 3);
  assert.equal(params(h.calls[2]).get("view"), "shift");
  assert.equal(params(h.calls[2]).get("startTime"), "22:30");
  assert.equal(params(h.calls[2]).get("endTime"), "06:15");
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 42);
  assert.match(content(h.render()), /Total Patients42/);
  assert.doesNotMatch(content(h.render()), /invalid or mismatched/);
  assert.ok(h.calls.every(call => call.route.startsWith("/analytics/status?")));
  h.dispose();
});

test("polling and manual refresh serialize slow requests and replace all chart instances", async () => {
  const first = deferred(), refresh = deferred();
  const h = harness({ request: (_call, number, backend) => number === 1 ? first.promise :
    number === 2 ? refresh.promise : response(backend.value) });
  await h.settle();
  assert.equal(h.calls.length, 1);
  await h.fire(15000);
  assert.equal(h.calls.length, 1);
  assert.equal(activeCharts(h).length, 0);
  first.resolve(response(data()));
  await h.settle();
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  button(h, "Refresh").props.onClick();
  await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(button(h, "Refresh").props.disabled, true);
  await h.fire(15000);
  assert.equal(h.calls.length, 2, "polling cannot overlap the manual refresh");
  const fresh = data(); fresh.hourly[0].arrivals = 23; fresh.metrics.total_patients.value = 23;
  refresh.resolve(response(fresh));
  await h.settle();
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 23);
  assert.match(content(h.render()), /Total Patients23/);
  assert.equal(activeCharts(h).length, 4);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.backend.value.hourly[0].arrivals = 31;
  await h.fire(15000);
  assert.equal(h.calls.length, 3);
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 31);
  assert.ok(h.calls.every(call => (call.init.method || "GET") === "GET" && call.init.cache === "no-store"));
  h.dispose();
});

test("changing the range aborts pending reads and rejects late results from an old filter", async () => {
  const first = deferred(), second = deferred();
  const h = harness({ request: (_call, number) => number === 1 ? first.promise : second.promise });
  await h.settle();
  h.change("Date", "2026-10-14");
  await h.apply();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].init.signal.aborted, true);
  const fresh = data(); fresh.hourly[0].arrivals = 42; fresh.metrics.total_patients.value = 42;
  second.resolve(responseForRange(fresh, h.calls[1].route));
  await h.settle();
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 42);
  first.resolve(response(data()));
  await h.settle();
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 42);
  assert.match(content(h.render()), /Total Patients42/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.dispose();
});

test("unmount aborts a pending request and prevents late data or timer writes", async () => {
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

test("errors retain the last response and recover consistently on a successful refresh", async () => {
  const h = harness();
  await h.settle();
  h.backend.error = "Connection unavailable";
  await h.fire(15000);
  assert.match(content(h.render()), /Connection unavailable/);
  assert.match(content(h.render()), /Showing the last successful result/);
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 7);
  h.backend.error = null;
  h.backend.value.hourly[0].arrivals = 33;
  h.backend.value.metrics.total_patients.value = 33;
  await h.fire(15000);
  assert.doesNotMatch(content(h.render()), /Connection unavailable|Showing the last successful result/);
  assert.equal(arrivalChart(h).config.data.datasets[0].data[0], 33);
  assert.match(content(h.render()), /Total Patients33/);
  h.dispose();
});

test("timed-out requests abort and retry without fabricating initial metrics", async () => {
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

test("the existing authorized-parent gate controls requests and all chart/timer cleanup", async () => {
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

test("delayed Chart.js readiness and drawing errors retry without duplicate analytics requests", async () => {
  const h = harness({ chart: null });
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(activeCharts(h).length, 0);
  assert.match(content(h.render()), /Preparing chart/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 500).length, 4);
  h.window.Chart = class { constructor() { throw new Error("Canvas temporarily unavailable"); } };
  await h.fire(500);
  assert.match(content(h.render()), /Unable to display this chart/);
  h.window.Chart = h.chartConstructor;
  await h.fire(3000);
  assert.equal(activeCharts(h).length, 4);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(content(h.render()), /Preparing chart|Unable to display this chart/);
  h.dispose();
  assert.equal(h.timers.size, 0);
});

test("six colored summary cards display real metrics, duration units, and honest missing baselines", async () => {
  const h = harness();
  const tree = await h.settle();
  const cards = nodes(tree, node => node.type === "article" && String(node.props.className).includes("metricCard"));
  assert.equal(cards.length, 6);
  assert.deepEqual(cards.map(card => content(nodes(card, node => node.type === "h3")[0])),
    ["Total Patients", "Waiting Patients", "Currently Serving", "Completed Patients", "Average Waiting Time", "Average Service Time"]);
  for (const [index, tone] of ["blue", "orange", "sky", "green", "purple", "gray"].entries()) {
    assert.ok(cards[index].props.className.split(" ").includes(tone), `${tone} card`);
    assert.equal(nodes(cards[index], node => node.type === "i").length, 1);
  }
  const values = cards.map(card => content(nodes(card, node => String(node.props.className).split(" ").includes("metricValue"))[0]));
  assert.deepEqual(values, ["16", "8", "2", "4", "8.5min", "12min"]);
  assert.match(content(cards[0]), /-50% vs prior equivalent period/);
  assert.match(content(cards[1]), /-20% vs prior equivalent period/);
  assert.match(content(cards[2]), /No prior baseline/);
  assert.match(content(cards[5]), /No prior baseline/);
  assert.doesNotMatch(content(tree), /NaN|Infinity/);
  const ratePanel = nodes(tree, node => String(node.props.className).split(" ").includes("ratePanel"))[0];
  assert.match(content(ratePanel), /5\.5patients\/hour/);
  assert.match(content(ratePanel), /3\.25patients\/hour/);
  assert.match(content(ratePanel), /Observed service rate/);
  assert.match(content(ratePanel), /Completion rate25%/);
  assert.match(content(ratePanel), /4 of 16 period arrivals completed by the cutoff/);
  assert.match(content(ratePanel), /does not measure service capacity/);
  h.dispose();
});

test("status doughnut preserves actual statuses with patient-count and percentage tooltips", () => {
  const h = harness();
  const config = h.helpers.buildStatusChart(data({ statuses: [
    { status: "waiting", label: "Waiting", count: 8, percentage: 50 },
    { status: "no-show", label: "No-show", count: 2, percentage: 12.5 },
    { status: "deferred", label: "Deferred", count: 6, percentage: 37.5 }
  ] }));
  assert.equal(config.type, "doughnut");
  assert.deepEqual(Array.from(config.data.labels), ["Waiting", "No-show", "Deferred"]);
  assert.deepEqual(Array.from(config.data.datasets[0].data), [8, 2, 6]);
  assert.equal(config.data.datasets[0].backgroundColor.length, 3);
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataIndex: 1 }), "No-show: 2 (12.5%)");
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataIndex: 2 }), "Deferred: 6 (37.5%)");
});

test("hourly wait/service lines preserve valid zeros, missing durations, colors, and sample-aware hover units", () => {
  const h = harness();
  const config = h.helpers.buildTimeComparisonChart(data());
  assert.equal(config.type, "line");
  assert.deepEqual(Array.from(config.data.labels), ["09:00", "10:00", "12:00"]);
  const [wait, service] = config.data.datasets;
  assert.deepEqual(Array.from(wait.data), [8.5, null, null]);
  assert.deepEqual(Array.from(service.data), [12, 0, null]);
  assert.equal(wait.borderColor, "#8b5cf6");
  assert.equal(service.borderColor, "#10b981");
  assert.equal(wait.spanGaps, false);
  assert.equal(service.spanGaps, false);
  assert.equal(config.options.scales.y.title.text, "Minutes");
  const label = config.options.plugins.tooltip.callbacks.label;
  assert.match(label({ dataset: wait, raw: 8.5, dataIndex: 0 }), /8\.5 min.*2 valid visits/);
  assert.match(label({ dataset: service, raw: 0, dataIndex: 1 }), /0 min.*1 valid visit\b/);
  assert.match(label({ dataset: wait, raw: null, dataIndex: 1 }), /No data available/);
  assert.equal(config.options.interaction.intersect, false);
});

test("blue/green grouped arrival bars use separate event counts and the red queue area uses historical interval averages", () => {
  const h = harness();
  const bars = h.helpers.buildArrivalsServedChart(data());
  assert.equal(bars.type, "bar");
  assert.deepEqual(Array.from(bars.data.datasets[0].data), [7, 9, null]);
  assert.deepEqual(Array.from(bars.data.datasets[1].data), [3, 4, null]);
  assert.equal(bars.data.datasets[0].backgroundColor, "#3b82f6");
  assert.equal(bars.data.datasets[1].backgroundColor, "#10b981");
  assert.notEqual(bars.options.scales?.x?.stacked, true);
  assert.equal(bars.options.plugins.tooltip.callbacks.label({ dataset: bars.data.datasets[1], raw: 4 }), "Patients served: 4");
  const queue = h.helpers.buildQueueLengthChart(data());
  assert.equal(queue.type, "line");
  assert.deepEqual(Array.from(queue.data.datasets[0].data), [3.25, 8.5, null],
    "historical time-weighted interval averages must not reuse current waiting or arrivals");
  assert.equal(queue.data.datasets[0].borderColor, "#ef4444");
  assert.equal(queue.data.datasets[0].fill, true);
  assert.equal(queue.data.datasets[0].spanGaps, false);
  assert.match(queue.options.plugins.tooltip.callbacks.label({ raw: 3.25 }), /3\.25 patients/);
  assert.match(queue.options.plugins.tooltip.callbacks.label({ raw: null }), /No data available/);
  for (const chart of [bars, queue]) {
    assert.equal(chart.options.responsive, true);
    assert.equal(chart.options.maintainAspectRatio, false);
  }
});

test("missing and invalid numeric values cannot become fake zeros or changes from a zero baseline", () => {
  const h = harness();
  for (const missing of [null, undefined, "8", NaN, Infinity, -1]) assert.equal(h.helpers.finiteMetric(missing), null);
  assert.equal(h.helpers.finiteMetric(0), 0);
  assert.equal(h.helpers.metricComparison({ value: null, previous: 2, change_percent: -100 }), "No data available");
  assert.equal(h.helpers.metricComparison({ value: 1, previous: 0, change_percent: null }), "No prior baseline");
  assert.equal(h.helpers.metricComparison({ value: 0, previous: 0, change_percent: 0 }), "0% vs prior equivalent period");
  assert.equal(h.helpers.metricComparison({ value: 3, previous: 2, change_percent: 50 }), "+50% vs prior equivalent period");
  const malformed = data({ hourly: [{ label: "09:00", arrivals: "7", served: -1, avg_wait_minutes: NaN,
    avg_service_minutes: Infinity, avg_queue_length: "3.25" }] });
  for (const build of ["buildTimeComparisonChart", "buildArrivalsServedChart", "buildQueueLengthChart"]) {
    for (const dataset of h.helpers[build](malformed).data.datasets) assert.deepEqual(Array.from(dataset.data), [null]);
  }
});

test("empty and incomplete data keep valid zero counts while displaying unsupported metrics honestly", async () => {
  const emptyMetrics = Object.fromEntries(Object.keys(data().metrics).map(key => [key,
    { value: key.startsWith("avg_") ? null : 0, previous: null, change_percent: null }]));
  const h = harness({ backend: { value: data({ metrics: emptyMetrics, hourly: [], statuses: [], counters: [], record_count: 0,
    rates: { ...data().rates, arrival_rate_per_hour: null, service_rate_per_hour: null, completion_rate_percent: null,
      completion_numerator: 0, completion_denominator: 0 } }) } });
  const empty = await h.settle();
  assert.match(content(empty), /No queue visits recorded in this range/);
  assert.equal(nodes(empty, node => node.type === "canvas").length, 0);
  assert.match(content(empty), /Total Patients0/);
  assert.match(content(empty), /Average Waiting TimeNo data available/);
  assert.ok((content(empty).match(/No data available/g) || []).length >= 8);
  h.backend.value = data({ hourly: data().hourly.map(row => ({ ...row,
    avg_wait_minutes: null, avg_service_minutes: null, avg_queue_length: null })) });
  await h.fire(15000);
  assert.deepEqual(nodes(h.render(), node => node.type === "canvas").map(node => node.props["aria-label"]),
    [headings[0], headings[3]]);
  assert.equal(activeCharts(h).length, 2);
  h.dispose();
});

test("malformed or mismatched results fail safely and a manual retry recovers immediately", async () => {
  const cases = [
    data({ metrics: null }), data({ rates: null }), data({ hourly: [null] }), data({ counters: [{}] }),
    data({ statuses: null }), data({ observed_at: "not a timestamp" }), data({ time_zone: "UTC" }),
    data({ range: { ...data().range, date: "2026-10-14" } })
  ];
  let reply = response(cases[0]);
  const h = harness({ request: () => clone(reply) });
  await h.settle();
  for (let i = 0; i < cases.length; i++) {
    if (i) { reply = response(cases[i]); await h.fire(15000); }
    assert.match(content(h.render()), /invalid or mismatched status analytics result/);
    assert.equal(activeCharts(h).length, 0);
  }
  reply = response(data());
  const previousReads = h.calls.length;
  button(h, "Retry now").props.onClick();
  await h.settle();
  assert.equal(h.calls.length, previousReads + 1);
  assert.equal(activeCharts(h).length, 4);
  assert.doesNotMatch(content(h.render()), /invalid or mismatched/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.dispose();
});

