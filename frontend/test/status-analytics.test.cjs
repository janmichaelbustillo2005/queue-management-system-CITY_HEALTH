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
    outcomes: { total: 16, live: true, carry_in: { waiting: 1, serving: 0 }, statuses: [
      { status: "completed", label: "Completed", count: 4, percentage: 25 },
      { status: "waiting", label: "Waiting", count: 8, percentage: 50 },
      { status: "serving", label: "Being served", count: 2, percentage: 12.5 },
      { status: "cancelled", label: "Cancelled", count: 0, percentage: 0 },
      { status: "no-show", label: "No-show", count: 2, percentage: 12.5 }
    ] },
    duration_samples: { wait: 2, service: 4 },
    record_count: 16, notes: ["Counter availability history is not recorded."], ...overrides
  };
}
const withTotal = (value, total) => { value.outcomes.total = total; return value; };
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
      if (name === "next/link") return { __esModule: true, default: "a" };
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

const cardTitles = ["Total Patients", "Completed", "Waiting", "Being Served", "Cancelled", "No-show"];
const panelTitles = ["Status Breakdown", "Waiting & Service Times", "Doctor Performance"];
const activeCharts = h => h.charts.filter(chart => !chart.destroyed);
const breakdownChart = h => activeCharts(h).find(chart => chart.config.type === "doughnut");
const params = call => new URL(call.route, "http://localhost").searchParams;
const metricCards = tree => nodes(tree, node => node.type === "article" && String(node.props.className).includes("metricCard"));
const cardValue = (tree, title) => {
  const card = metricCards(tree).find(item => content(nodes(item, node => node.type === "h3")[0]) === title);
  assert.ok(card, `Missing ${title} card`);
  return content(nodes(card, node => String(node.props.className).split(" ").includes("metricValue"))[0]);
};
function button(h, label) {
  const found = nodes(h.render(), node => node.type === "button" && content(node) === label)[0];
  assert.ok(found, `Missing ${label} button`);
  return found;
}

test("Status Analytics shows status cards, one breakdown chart, times and doctor performance without the removed panels", async () => {
  const h = harness();
  assert.match(content(h.render()), /Loading/);
  const tree = await h.settle();
  assert.equal(nodes(tree, node => node.type === "h2" && content(node) === "Status Analytics").length, 1);
  assert.deepEqual(nodes(tree, node => node.type === "h3").map(content), [...cardTitles, ...panelTitles]);
  assert.deepEqual(nodes(tree, node => node.type === "canvas").map(node => node.props["aria-label"]), ["Status Breakdown"]);
  assert.equal(activeCharts(h).length, 1);
  for (const removed of [/Counter Utilization/, /Average Queue Length/, /Arrivals vs\. Served/, /Waiting vs\. Service Time/,
    /arrival rate/i, /service rate/i, /Insufficient Data/, /Utilization/, /prior equivalent period/, /No prior baseline/]) {
    assert.doesNotMatch(content(tree), removed);
  }
  assert.equal(nodes(tree, node => node.props.role === "progressbar").length, 0);
  const table = nodes(tree, node => node.type === "table")[0];
  assert.deepEqual(nodes(table, node => node.type === "th" && node.props.scope === "col").map(content),
    ["Doctor", "Patients Completed", "Average Service Time", "Total Service Time"]);
  const rows = content(nodes(table, node => node.type === "tbody")[0]);
  assert.match(rows, /Doctor 138 min24 min/);
  assert.match(rows, /Doctor 246\.3 min25 min/);
  assert.doesNotMatch(rows, /Enabled|Disabled/, "today's enabled setting is not a historical fact about the period");
  assert.match(content(tree), /Not counted above: 1 patient still waiting who registered on an earlier day\./);
  const backlogLinks = nodes(tree, node => node.props?.href === "/queue-backlog");
  assert.equal(backlogLinks.length, 1, "the carry-in note links to the Historical Backlog");
  assert.equal(content(backlogLinks[0]), "View Historical Backlog");
  assert.match(content(tree), /Patients registered so far in this period, by their status right now\./);
  assert.match(content(tree), /How to read these numbers/);
  assert.match(content(tree), /Asia\/Manila/);
  h.dispose();
  assert.equal(activeCharts(h).length, 0);
  assert.equal(h.timers.size, 0);
});

test("the status cards add up to Total Patients and show each status's share", async () => {
  const h = harness();
  const tree = await h.settle();
  const cards = metricCards(tree);
  assert.deepEqual(cards.map(card => content(nodes(card, node => node.type === "h3")[0])), cardTitles);
  for (const [index, tone] of ["blue", "green", "orange", "sky", "red", "rose"].entries()) {
    assert.ok(cards[index].props.className.split(" ").includes(tone), `${tone} card`);
    assert.equal(nodes(cards[index], node => node.type === "i").length, 1);
  }
  const values = cardTitles.map(title => cardValue(tree, title));
  assert.deepEqual(values, ["16", "4", "8", "2", "0", "2"]);
  assert.equal(values.slice(1).reduce((sum, value) => sum + Number(value), 0), Number(values[0]));
  assert.match(content(cards[0]), /Down 50% vs same time yesterday/);
  assert.match(content(cards[1]), /25% of patients/);
  assert.match(content(cards[4]), /0% of patients/);
  assert.doesNotMatch(content(tree), /NaN|Infinity/);
  h.dispose();
});

test("waiting and service times explain what they measure, how many patients they use, and whether waiting improved", async () => {
  const h = harness();
  const tree = await h.settle();
  const rows = nodes(tree, node => String(node.props.className).split(" ").includes("timeRow"));
  assert.equal(rows.length, 2);
  assert.match(content(rows[0]), /Average waiting time8\.5 min/);
  assert.match(content(rows[0]), /From registration until the patient is called · based on 2 patients/);
  const waitComparison = nodes(rows[0], node => String(node.props.className).includes("timeComparison"))[0];
  assert.equal(content(waitComparison), "Down 50% vs same time yesterday");
  assert.ok(waitComparison.props.className.split(" ").includes("better"), "shorter waiting is an improvement");
  assert.match(content(rows[1]), /Average service time12 min/);
  assert.match(content(rows[1]), /based on 4 consultations/);
  assert.match(content(rows[1]), /No comparison available/);
  h.dispose();
});

test("a finished period compares with the day before and reports current statuses without a live carry-in note", async () => {
  const past = data({ outcomes: { ...data().outcomes, live: false, carry_in: null } });
  past.observed_at = "2026-10-16T03:15:00.000Z";
  const h = harness({ backend: { value: past } });
  const tree = await h.settle();
  assert.match(content(tree), /Patients registered in this period, by their current status\./);
  assert.match(content(metricCards(tree)[0]), /Down 50% vs the day before/);
  assert.doesNotMatch(content(tree), /Not counted above/);
  assert.equal(nodes(tree, node => node.props?.href === "/queue-backlog").length, 0);
  h.dispose();
});

test("only earlier-day waiting patients offer the Historical Backlog link; reporting numbers are unchanged", async () => {
  const servingOnly = data({ outcomes: { ...data().outcomes, carry_in: { waiting: 0, serving: 2 } } });
  const h = harness({ backend: { value: servingOnly } });
  const tree = await h.settle();
  assert.match(content(tree), /Not counted above: 2 patients being served who registered on an earlier day\./);
  assert.equal(nodes(tree, node => node.props?.href === "/queue-backlog").length, 0, "no backlog link without earlier-day waiting visits");
  assert.equal(cardValue(tree, "Total Patients"), "16", "carry-in visits stay out of the period's registrations");
  h.dispose();
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
  withTotal(h.backend.value, 42);
  await h.apply();
  assert.equal(h.calls.length, 3);
  assert.equal(params(h.calls[2]).get("view"), "shift");
  assert.equal(params(h.calls[2]).get("startTime"), "22:30");
  assert.equal(params(h.calls[2]).get("endTime"), "06:15");
  assert.equal(cardValue(h.render(), "Total Patients"), "42");
  assert.doesNotMatch(content(h.render()), /invalid or mismatched/);
  assert.ok(h.calls.every(call => call.route.startsWith("/analytics/status?")));
  h.dispose();
});

test("polling and manual refresh serialize slow requests and replace the chart instance", async () => {
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
  const fresh = data(); fresh.outcomes.statuses[1].count = 23;
  refresh.resolve(response(fresh));
  await h.settle();
  assert.equal(breakdownChart(h).config.data.datasets[0].data[1], 23);
  assert.equal(activeCharts(h).length, 1);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.backend.value.outcomes.statuses[1].count = 31;
  await h.fire(15000);
  assert.equal(h.calls.length, 3);
  assert.equal(breakdownChart(h).config.data.datasets[0].data[1], 31);
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
  second.resolve(responseForRange(withTotal(data(), 42), h.calls[1].route));
  await h.settle();
  assert.equal(cardValue(h.render(), "Total Patients"), "42");
  first.resolve(response(data()));
  await h.settle();
  assert.equal(cardValue(h.render(), "Total Patients"), "42");
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
  assert.equal(cardValue(h.render(), "Total Patients"), "16");
  h.backend.error = null;
  withTotal(h.backend.value, 33);
  await h.fire(15000);
  assert.doesNotMatch(content(h.render()), /Connection unavailable|Showing the last successful result/);
  assert.equal(cardValue(h.render(), "Total Patients"), "33");
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
  assert.equal(activeCharts(h).length, 1);
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
  assert.equal(activeCharts(h).length, 1);
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
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 500).length, 1);
  h.window.Chart = class { constructor() { throw new Error("Canvas temporarily unavailable"); } };
  await h.fire(500);
  assert.match(content(h.render()), /Unable to display this chart/);
  h.window.Chart = h.chartConstructor;
  await h.fire(3000);
  assert.equal(activeCharts(h).length, 1);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(content(h.render()), /Preparing chart|Unable to display this chart/);
  h.dispose();
  assert.equal(h.timers.size, 0);
});

test("the breakdown doughnut uses fixed status colours, skips empty statuses and explains each slice", () => {
  const h = harness();
  const config = h.helpers.buildOutcomeChart(data().outcomes);
  assert.equal(config.type, "doughnut");
  assert.deepEqual(Array.from(config.data.labels), ["Completed", "Waiting", "Being served", "No-show"]);
  assert.deepEqual(Array.from(config.data.datasets[0].data), [4, 8, 2, 2]);
  assert.deepEqual(Array.from(config.data.datasets[0].backgroundColor),
    ["completed", "waiting", "serving", "no-show"].map(status => h.helpers.statusColor(status)));
  const label = config.options.plugins.tooltip.callbacks.label;
  assert.equal(label({ dataIndex: 3 }), "No-show: 2 patients (12.5%)");
  assert.equal(h.helpers.buildOutcomeChart(null).data.labels.length, 0);
});

test("comparisons use plain words and only judge metrics where lower is better", () => {
  const h = harness();
  for (const missing of [null, undefined, "8", NaN, Infinity, -1]) assert.equal(h.helpers.finiteMetric(missing), null);
  assert.equal(h.helpers.finiteMetric(0), 0);
  const compare = h.helpers.metricComparison;
  assert.equal(compare({ value: null, previous: 2, change_percent: -100 }), "No data available");
  assert.equal(compare({ value: 3, previous: null, change_percent: null }), "No comparison available");
  assert.equal(compare({ value: 1, previous: 0, change_percent: null }, "vs the day before"), "Up from 0 vs the day before");
  assert.equal(compare({ value: 0, previous: 0, change_percent: 0 }, "vs the day before"), "No change vs the day before");
  assert.equal(compare({ value: 3, previous: 2, change_percent: 50 }, "vs same time yesterday"), "Up 50% vs same time yesterday");
  assert.equal(compare({ value: 1, previous: 2, change_percent: -50 }, "vs same time yesterday"), "Down 50% vs same time yesterday");
  const tone = h.helpers.comparisonTone;
  assert.equal(tone({ value: 5, previous: 10 }, "lower"), "better");
  assert.equal(tone({ value: 15, previous: 10 }, "lower"), "worse");
  assert.equal(tone({ value: 15, previous: 10 }), "neutral");
  assert.equal(tone({ value: 15, previous: null }, "lower"), "neutral");
  assert.equal(tone({ value: 18.125, previous: 18 }, "lower"), "neutral", "a 0.7% change is not flagged as worse");
  assert.equal(tone({ value: 19, previous: 18 }, "lower"), "worse");
  const range = data().range;
  assert.equal(h.helpers.comparisonLabel({ range }), "vs same time yesterday");
  assert.equal(h.helpers.comparisonLabel({ range: { ...range, effective_end_at: range.end_at } }), "vs the day before");
  assert.equal(h.helpers.comparisonLabel({ range: { ...range, view: "shift", effective_end_at: range.end_at } }), "vs same shift the day before");
});

test("an empty period shows zero patients honestly with no chart and unavailable averages", async () => {
  const emptyMetrics = Object.fromEntries(Object.keys(data().metrics).map(key => [key,
    { value: key.startsWith("avg_") ? null : 0, previous: null, change_percent: null }]));
  const h = harness({ backend: { value: data({ metrics: emptyMetrics, counters: [], record_count: 0,
    duration_samples: { wait: 0, service: 0 },
    outcomes: { total: 0, live: true, carry_in: { waiting: 0, serving: 0 },
      statuses: data().outcomes.statuses.map(row => ({ ...row, count: 0, percentage: 0 })) } }) } });
  const empty = await h.settle();
  assert.match(content(empty), /No patients registered in this range/);
  assert.equal(nodes(empty, node => node.type === "canvas").length, 0);
  assert.equal(cardValue(empty, "Total Patients"), "0");
  assert.equal(cardValue(empty, "Completed"), "0");
  assert.match(content(empty), /Average waiting timeNo data available/);
  assert.doesNotMatch(content(empty), /Not counted above|based on 0/);
  assert.doesNotMatch(content(empty), /NaN|Infinity/);
  h.dispose();
});

test("malformed or mismatched results fail safely and a manual retry recovers immediately", async () => {
  const cases = [
    data({ metrics: null }), data({ outcomes: null }), data({ outcomes: { ...data().outcomes, statuses: null } }),
    data({ outcomes: { ...data().outcomes, carry_in: { waiting: "1" } } }), data({ counters: [{}] }),
    data({ observed_at: "not a timestamp" }), data({ time_zone: "UTC" }),
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
  assert.equal(activeCharts(h).length, 1);
  assert.doesNotMatch(content(h.render()), /invalid or mismatched/);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 15000).length, 1);
  h.dispose();
});
