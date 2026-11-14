const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { loadServices } = require("./services-module.cjs");
// The cards must show exactly what the backend's /analytics builds, so the payloads come from the
// real getAnalytics (local fallback, synthetic visits only).
const { createHarness } = require("../../backend/test/helpers/queueHarness");

let lib;
let view;
const plain = (value) => JSON.parse(JSON.stringify(value));

before(async () => {
  await swc.loadBindings();
  const compile = async (relative, jsx = false) => (await swc.transform(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"), {
    filename: relative,
    jsc: { parser: { syntax: "ecmascript", jsx }, transform: jsx ? { react: { runtime: "automatic" } } : undefined },
    module: { type: "commonjs" }
  })).code;
  const load = (code, dependencies) => {
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, Intl, Date, Math, Number, String, require: (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    } });
    return module.exports;
  };
  const dailyTrends = load(await compile("lib/dailyTrendsCharts.js"), {});
  const analyticsCharts = load(await compile("lib/analyticsCharts.js"), { "./dailyTrendsCharts": dailyTrends, "./services": loadServices() });
  lib = load(await compile("lib/serviceAnalytics.js"), { "./analyticsCharts": analyticsCharts });
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = { useState: (initial) => [initial, () => {}], useMemo: (factory) => factory(), useRef: () => ({ current: null }), useEffect: () => {} };
  view = load(await compile("components/ServiceAnalytics.js", true), {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "../lib/serviceAnalytics": lib
  });
});

function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join("|");
  if (node && typeof node === "object") return text(node.props?.children);
  return node == null || typeof node === "boolean" ? "" : String(node);
}
function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach((node) => nodes(node, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
}
const cells = (row) => nodes(row, (node) => node.type === "th" || node.type === "td").map((cell) => text(cell).replace(/\|/g, ""));
const render = (props) => expand({ type: view.default, props });

// Sunday 2026-10-11 16:00 in Manila; times are UTC (Manila is UTC+8).
const clockTime = Date.parse("2026-10-11T08:00:00.000Z");
const visit = (id, service, status, created, extra = {}) => ({ id_num: `Synthetic ${id}`, service_type: service, status, created_at: created, ...extra });
const visits = [
  visit("A", "consultation", "completed", "2026-10-11T01:00:00.000Z", { counter_id: "Doctor 1", called_at: "2026-10-11T01:10:00.000Z",
    consultation_started_at: "2026-10-11T01:10:00.000Z", completed_at: "2026-10-11T01:16:00.000Z" }),
  visit("B", "consultation", "cancelled", "2026-10-11T01:05:00.000Z", { completed_at: "2026-10-11T01:30:00.000Z" }),
  visit("C", "consultation", "serving", "2026-10-11T02:00:00.000Z", { counter_id: "Doctor 1", called_at: "2026-10-11T02:41:00.000Z" }),
  visit("D", "consultation", "waiting", "2026-10-11T03:00:00.000Z"),
  visit("E", "prenatal", "no-show", "2026-10-11T03:30:00.000Z", { counter_id: "Doctor 2", called_at: "2026-10-11T03:50:00.000Z",
    completed_at: "2026-10-11T03:55:00.000Z" }),
  visit("F", "prenatal", "completed", "2026-10-11T04:00:00.000Z", { counter_id: "Doctor 2", called_at: "2026-10-11T04:05:00.000Z",
    consultation_started_at: "2026-10-11T04:05:00.000Z", completed_at: "2026-10-11T04:20:00.000Z" }),
  // Waiting only: nobody in this service was called, so it has no average wait.
  visit("G", "family_planning", "waiting", "2026-10-11T05:00:00.000Z"),
  visit("H", "family_planning", "waiting", "2026-10-11T05:10:00.000Z")
];

async function analyticsFor(fixtures = visits, filters = {}) {
  const h = createHarness({ localFallback: true, clock: { now: clockTime } });
  await h.initialize();
  for (const fixture of fixtures) {
    const patient = await h.service.createQueueEntry({ idNum: fixture.id_num, serviceType: "consultation", vulnerabilityFlags: [] });
    Object.assign(await h.service.getPatientById(patient.id), fixture);
  }
  return plain(await h.service.getAnalytics("", "", filters));
}
const modelOf = (analytics) => lib.serviceAnalytics(analytics.tableData, analytics.totals, analytics.insights?.wait);

test("one model: every service adds up, the outcomes add up to the backend's total, and order is the backend's", async () => {
  const analytics = await analyticsFor();
  const model = modelOf(analytics);
  assert.equal(model.consistent, true);
  assert.equal(model.total, analytics.totals.total_patients);
  assert.equal(model.total, analytics.metrics.totalPatients);
  assert.deepEqual(plain(model.rows.map((row) => row.service)), analytics.tableData.map((row) => row.service_type), "backend order (most patients first)");
  for (const row of model.rows) {
    const source = analytics.tableData.find((item) => item.service_type === row.service);
    assert.equal(row.total, row.completed + row.cancelled + row.no_show + row.in_queue, row.label);
    assert.equal(row.in_queue, source.waiting + source.serving, "In Queue = waiting + serving");
    assert.equal(row.other, 0);
  }
  const outcomes = Object.fromEntries(model.outcomes.map((outcome) => [outcome.key, outcome.count]));
  assert.deepEqual(plain(outcomes), { completed: 2, cancelled: 1, no_show: 1, in_queue: 4 });
  assert.equal(outcomes.completed, analytics.totals.completed);
  assert.equal(outcomes.in_queue, analytics.totals.waiting + analytics.totals.serving);
  assert.deepEqual(plain(model.outcomes.map((outcome) => outcome.percent)), [25, 12.5, 12.5, 50]);
});

test("average wait reuses the backend's Avg Wait; a service nobody was called in is a gap, not zero", async () => {
  const analytics = await analyticsFor();
  const model = modelOf(analytics);
  const byService = Object.fromEntries(model.rows.map((row) => [row.service, row]));
  for (const row of model.rows.filter((item) => item.avgWait != null)) {
    assert.equal(row.avgWait.toFixed(1), analytics.tableData.find((item) => item.service_type === row.service).avg_wait_time);
  }
  // The existing rule ends the wait at the call, or at completed_at when never called (B, cancelled
  // after 25 minutes); D is still waiting and is not measured: (10 + 25 + 41) / 3.
  assert.equal(byService.consultation.avgWait, 25.3);
  assert.equal(byService.family_planning.avgWait, null);
  assert.equal(analytics.tableData.find((item) => item.service_type === "family_planning").avg_wait_time, "0.0", "the backend's 0.0 placeholder");
  assert.deepEqual(plain(model.unmeasured), ["Family planning"]);

  const config = lib.waitLineChart(model);
  assert.deepEqual(plain(config.data.datasets[0].data), model.rows.map((row) => row.avgWait));
  assert.equal(config.data.datasets[0].spanGaps, false);
  assert.equal(config.data.datasets[0].tension, 0, "no smoothing");
  const tip = config.options.plugins.tooltip.callbacks;
  const at = model.rows.findIndex((row) => row.service === "prenatal");
  assert.equal(tip.title([{ dataIndex: at }]), `Service: ${model.rows[at].label}`);
  assert.equal(tip.label({ raw: model.rows[at].avgWait }), `Average Wait Time: ${model.rows[at].avgWait.toFixed(1)} minutes`);
  assert.equal(tip.afterLabel({ dataIndex: at }), "Patients called: 2");

  // Without the insights payload the samples are unknown, so the table's own figure is shown as before.
  const fallback = lib.serviceAnalytics(analytics.tableData, analytics.totals, undefined);
  assert.equal(fallback.rows.find((row) => row.service === "family_planning").avgWait, 0);
});

test("stacked bars: one dataset per outcome in the fixed colours, values from the table, tooltip with total first", async () => {
  const model = modelOf(await analyticsFor());
  const config = lib.outcomeBarChart(model);
  assert.deepEqual(plain(config.data.datasets.map((dataset) => [dataset.label, dataset.backgroundColor])),
    [["Completed", "#15803D"], ["Cancelled", "#F87171"], ["No-show", "#5570B0"], ["In Queue", "#E9A20F"]]);
  config.data.datasets.forEach((dataset) => assert.deepEqual(plain(dataset.data), model.rows.map((row) => row[dataset.outcome])));
  assert.equal(config.options.scales.y.beginAtZero, true);
  assert.equal(config.options.scales.y.ticks.precision, 0, "integer patient counts");
  assert.equal(config.options.scales.x.stacked && config.options.scales.y.stacked, true);
  const tip = config.options.plugins.tooltip.callbacks;
  const first = [{ dataIndex: 0 }];
  assert.equal(tip.title(first), `Service: ${model.rows[0].label}`);
  assert.equal(tip.beforeBody(first), `Total Patients: ${model.rows[0].total}`);
  assert.equal(tip.label({ dataset: { label: "In Queue" }, raw: 2 }), "In Queue: 2");
  assert.deepEqual(plain(lib.wrapLabel("Environmental Health")), ["Environmental", "Health"]);
  assert.equal(lib.wrapLabel("Dental"), "Dental");
});

test("donut: zero outcomes are left out of the ring but kept in the legend; percentages use the real total", async () => {
  const analytics = await analyticsFor(visits.filter((row) => row.status !== "no-show"));
  const model = modelOf(analytics);
  const config = lib.outcomeDonutChart(model);
  assert.deepEqual(plain(config.data.labels), ["Completed", "Cancelled", "In Queue"]);
  assert.deepEqual(plain(config.data.datasets[0].data), [2, 1, 4]);
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataIndex: 2 }), "In Queue: 4 patients (57.1%)");
  const tree = render({ tableData: analytics.tableData, totals: analytics.totals, wait: analytics.insights.wait });
  const legend = nodes(tree, (node) => node.type === "table" && node.props.className === "svc-legend-table")[0];
  const rows = nodes(legend, (node) => node.type === "tr").map(cells);
  assert.deepEqual(rows, [["Outcome", "Patients", "Percentage"], ["Completed", "2", "28.6%"], ["Cancelled", "1", "14.3%"],
    ["No-show", "0", "0.0%"], ["In Queue", "4", "57.1%"], ["Total", "7", "100.0%"]]);
});

test("the four cards render in order, and the summary table matches the charts and the backend totals", async () => {
  const analytics = await analyticsFor();
  const tree = render({ tableData: analytics.tableData, totals: analytics.totals, wait: analytics.insights.wait });
  assert.deepEqual(nodes(tree, (node) => node.type === "article").map((card) => text(nodes(card, (node) => node.type === "h4")[0]).replace(/\|/g, "")),
    ["Patients by Service and Outcome", "Overall Outcome Distribution", "Average Wait Time by Service", "By Service (Summary)"]);
  const table = nodes(tree, (node) => node.type === "table" && node.props.className === "svc-table")[0];
  const rows = nodes(table, (node) => node.type === "tr").map(cells);
  assert.deepEqual(rows[0], ["Service", "Total", "Completed", "Cancelled", "No-show", "In Queue", "Avg Wait", "Avg Service", "Completion"]);
  const source = analytics.tableData;
  source.forEach((item, index) => {
    const row = rows[index + 1];
    assert.equal(row[1], String(item.total_patients));
    assert.equal(row[5], String(item.waiting + item.serving));
    assert.equal(row[7], `${item.avg_service_time}m`);
    assert.equal(row[8], `${item.completion_rate}%`);
  });
  const family = rows.find((row) => row[0] === "Family planning");
  assert.equal(family[6], "—", "no measured wait is not shown as 0.0m");
  const footer = rows[rows.length - 1];
  assert.deepEqual(footer, ["All", "8", "2", "1", "1", "4", `${analytics.totals.avg_wait_time}m`, `${analytics.totals.avg_service_time}m`, `${analytics.totals.completion_rate}%`]);
});

test("empty, loading and error states never draw a chart or invent numbers", async () => {
  const empty = render({ tableData: [], totals: null });
  assert.equal(lib.outcomeBarChart(lib.serviceAnalytics([], null)), null);
  assert.equal(lib.outcomeDonutChart(lib.serviceAnalytics([], null)), null);
  assert.equal(lib.waitLineChart(lib.serviceAnalytics([], null)), null);
  assert.equal(nodes(empty, (node) => node.type === "canvas").length, 0);
  assert.match(text(empty), /No visits match the selected filters\./);
  assert.deepEqual(plain(lib.serviceAnalytics([], null).outcomes.map((outcome) => outcome.percent)), [null, null, null, null], "no 0% of nothing");

  const loading = render({ tableData: [], status: "loading" });
  assert.equal(nodes(loading, (node) => node.type === "table").length, 0);
  assert.equal((text(loading).match(/Loading analytics/g) || []).length, 4);
  assert.equal((text(render({ status: "error" })).match(/could not be loaded/g) || []).length, 4);

  // Visits exist but nobody was called yet: bars and donut draw, the wait chart explains why it is empty.
  const waitingOnly = await analyticsFor(visits.filter((row) => row.status === "waiting"));
  const model = modelOf(waitingOnly);
  assert.ok(lib.outcomeBarChart(model));
  assert.equal(lib.waitLineChart(model), null);
  assert.match(text(render({ tableData: waitingOnly.tableData, totals: waitingOnly.totals, wait: waitingOnly.insights.wait })),
    /No patient has been called yet, so there is no waiting time to show\./);
});

test("filters reach every card together: a service filter narrows the bars, donut, line and table alike", async () => {
  const analytics = await analyticsFor(visits, { service: "prenatal" });
  const model = modelOf(analytics);
  assert.deepEqual(plain(model.rows.map((row) => row.service)), ["prenatal"]);
  assert.equal(model.total, 2);
  assert.deepEqual(plain(lib.outcomeDonutChart(model).data.datasets[0].data), [1, 1]);
  assert.deepEqual(plain(lib.waitLineChart(model).data.datasets[0].data), [model.rows[0].avgWait]);
});

test("a visit with an unknown status still counts: it shows as Other status instead of breaking the totals", () => {
  const row = { service_type: "consultation", total_patients: 3, completed: 1, cancelled: 0, no_show: 0, waiting: 1, serving: 0,
    avg_wait_time: "5.0", avg_service_time: "4.0", completion_rate: "33.3" };
  const model = lib.serviceAnalytics([row], row);
  assert.equal(model.rows[0].other, 1);
  assert.deepEqual(plain(model.outcomes.map((outcome) => [outcome.key, outcome.count])),
    [["completed", 1], ["cancelled", 0], ["no_show", 0], ["in_queue", 1], ["other", 1]]);
  assert.equal(lib.outcomeBarChart(model).data.datasets.length, 5);
  assert.match(text(render({ tableData: [row], totals: row })), /1 visit has a status outside these columns; it is counted in Total\./);
});
