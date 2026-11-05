const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
// The page renders exactly what the backend builds, so the payloads come from the real builder.
const { buildAnalyticsInsights } = require("../../backend/src/services/analyticsInsights");

let insights;
let charts;
const views = [];

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
  const analyticsCharts = load(await compile("lib/analyticsCharts.js"), { "./dailyTrendsCharts": dailyTrends });
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState: (initial) => { const view = { value: initial }; views.push(view); return [view.value, (next) => { view.value = next; }]; },
    useMemo: (factory) => factory(), useRef: () => ({ current: null }), useEffect: () => {}
  };
  charts = load(await compile("lib/insightsCharts.js"), { "./analyticsCharts": analyticsCharts });
  insights = load(await compile("components/AnalyticsInsights.js", true), {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "next/link": "Link", "../lib/analyticsCharts": analyticsCharts,
    "../lib/insightsCharts": charts
  });
});

// Expands function components so the whole tree can be searched as text.
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
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
const render = (component, payload) => expand({ type: insights[component], props: { insights: payload } });

const now = Date.parse("2026-10-11T08:00:00.000Z");
const doctorFor = (service) => ({ prenatal: "Doctor 2", maternity: "Doctor 2", family_planning: "Doctor 3" })[service] || "Doctor 1";
const ctx = (extra = {}) => ({
  doctorOf: (row) => row.counter_id || doctorFor(row.service_type),
  serviceDoctor: doctorFor,
  waitMinutes: (row) => {
    const end = row.called_at || row.completed_at;
    return end ? Math.round((Date.parse(end) - Date.parse(row.created_at)) / 60000) : null;
  },
  serviceMinutes: (row) => (row.status === "completed" && row.consultation_started_at
    ? (Date.parse(row.completed_at) - Date.parse(row.consultation_started_at)) / 60000 : null),
  serviceOrder: ["consultation", "checkup", "prenatal", "maternity", "family_planning"],
  configuredServices: ["consultation", "checkup", "prenatal", "maternity", "family_planning"],
  doctorNames: ["Doctor 1", "Doctor 2", "Doctor 3"],
  shared: false,
  ...extra
});
// Three completed consultations at 09:00 every day for a week, then a live queue for Doctor 1.
const history = [];
for (let day = 5; day <= 11; day += 1) {
  for (let index = 0; index < 3; index += 1) {
    const created = Date.parse(`2026-10-${String(day).padStart(2, "0")}T01:00:00.000Z`) + index * 60000;
    history.push({ service_type: "consultation", counter_id: "Doctor 1", status: "completed", reason: null,
      created_at: new Date(created).toISOString(), called_at: new Date(created + 5 * 60000).toISOString(),
      consultation_started_at: new Date(created + 6 * 60000).toISOString(), completed_at: new Date(created + 25 * 60000).toISOString() });
  }
}
history.push({ service_type: "prenatal", counter_id: null, status: "cancelled", reason: "Patient left",
  created_at: "2026-10-10T02:00:00.000Z", called_at: null, completed_at: "2026-10-10T03:00:00.000Z" });
const liveQueue = [
  { service_type: "consultation", counter_id: null, status: "waiting", created_at: "2026-10-11T07:50:00.000Z" },
  { service_type: "consultation", counter_id: "Doctor 1", status: "serving", created_at: "2026-10-11T07:40:00.000Z", called_at: "2026-10-11T07:56:00.000Z" }
];
const counters = [{ id_num: "Doctor 1", is_online: true }, { id_num: "Doctor 2", is_online: true }, { id_num: "Doctor 3", is_online: false }];
const sessions = [{ doctor_name: "Doctor 1", created_at: "2026-10-11T00:00:00.000Z", last_seen_at: "2026-10-11T08:00:00.000Z",
  revoked_at: null, expires_at: "2026-10-11T08:00:00.000Z" }];
const range = { start: "2026-10-04T16:00:00.000Z", end: "2026-10-11T16:00:00.000Z" };
const build = (overrides = {}) => buildAnalyticsInsights({
  rows: [...history, ...liveQueue], visits: [...history, ...liveQueue], sessions, live: { patients: liveQueue, counters },
  range, now, slaTargetMinutes: 30, ctx: ctx(), ...overrides
});

test("Detailed Data no longer shows the removed sections anywhere", () => {
  const content = text(render("DetailedInsights", build()));
  for (const title of ["Wait Time by Service and Time of Day", "Average Service Time by Doctor and Service", "Patient Journey",
    "Abandonment Rate", "Average Wait Time Breakdown", "SLA Compliance", "Doctor Utilization", "Transaction Volume by Doctor",
    "Peak Hours and Days", "Predictive Insights", "Wait-Time Forecast", "Staffing Recommendations", "Patient Satisfaction",
    "Patient Arrival Forecast", "View Details"]) {
    assert.doesNotMatch(content, new RegExp(title), title);
  }
  // Service Demand remains only once: the donut inside Traffic & Flow.
  assert.equal(content.match(/Service Demand/g).length, 1);
  assert.match(content, /single facility, so there is no cross-branch comparison/);
  assert.doesNotMatch(content, /undefined|NaN|\bnull\b|\[object/);
});

test("a status filter is called out, and missing or failed insights never break the tab", () => {
  const filtered = build({ ctx: ctx({ statusFilter: "completed" }) });
  assert.match(text(render("DetailedInsights", filtered)), /Status filter is set to\s+Completed/);
  assert.match(text(render("DetailedInsights", undefined)), /appear here once the selected period has loaded/);
  assert.match(text(render("DetailedInsights", { error: "The additional analytics could not be computed." })), /could not be computed/);
});

const brand = { primary: "#167d3f", forest: "#0b3d2e" };
// Chart configurations are built in another VM realm, so compare plain copies.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
const datasetValues = (config, label) => config.data.datasets.find((dataset) => dataset.label === label).data;

test("Detailed Data keeps the wait trend, doctor performance, Traffic & Flow and arrival trend charts", () => {
  const tree = render("DetailedInsights", build());
  const canvases = nodes(tree, (node) => node.type === "canvas").map((node) => node.props["aria-label"]);
  same(canvases, ["Average Wait Time Trend", "Doctor Performance Comparison", "Service demand distribution", "Patient Arrival Trend"]);
  const content = text(tree);
  for (const title of ["Customer Experience", "Staff and Operational Efficiency", "Traffic & Flow", "Weekly Queue Heatmap"]) {
    assert.match(content, new RegExp(title));
  }
});

test("chart values are the payload's values, so charts match the tables and cards", () => {
  const payload = build();
  const trend = charts.waitTrendChart(payload.trends, brand);
  same(datasetValues(trend, "All services"), payload.trends.wait.overall);
  assert.equal(trend.data.labels.length, 7);
  assert.equal(trend.options.scales.x.title.text, "Day");
  // 21 completed consultations at 09:00, 1 cancelled prenatal at 10:00, 2 live consultations.
  same(charts.arrivalTrendChart(payload.trends, brand).data.datasets[0].data.reduce((sum, value) => sum + value, 0), 24);
  const performance = charts.doctorPerformanceChart(payload.volumes);
  same(datasetValues(performance, "Completed"), payload.volumes.map((row) => row.completed));
  same(charts.demandChart(payload.demand).data.datasets[0].data, [23, 1], "services nobody requested are left out of the donut");
  // Each tooltip shows exact figures.
  assert.match(trend.options.plugins.tooltip.callbacks.label({ dataset: trend.data.datasets[0], raw: 5, dataIndex: 0 }), /5 min average \(3 patients\)/);
  assert.equal(performance.options.plugins.tooltip.callbacks.footer([{ dataIndex: 0 }]), `Patients handled: ${payload.volumes[0].total}`);
});

test("charts with nothing to show return no configuration instead of an empty chart", () => {
  const empty = build({ rows: [], visits: [], sessions: [], live: { patients: [], counters } });
  for (const [name, input] of [["waitTrendChart", empty.trends], ["arrivalTrendChart", empty.trends],
    ["doctorPerformanceChart", empty.volumes], ["demandChart", empty.demand]]) {
    assert.equal(charts[name](input, brand), null, name);
  }
  const content = text(render("DetailedInsights", empty));
  assert.match(content, /No data for the selected filters|No visits match the selected filters/);
  assert.doesNotMatch(content, /undefined|NaN|\[object/);
});

test("trend charts group by week beyond two months and by month beyond a year", () => {
  const weekly = build({ range: { start: "2026-06-30T16:00:00.000Z", end: "2026-10-11T16:00:00.000Z" } }).trends;
  assert.equal(weekly.grouping, "week");
  assert.equal(weekly.periods[0], "2026-06-29", "weeks start on Monday");
  assert.equal(charts.periodLabel(weekly.periods[0], "week"), "Week of Jun 29");
  const monthly = build({ range: { start: "2025-01-01T16:00:00.000Z", end: "2026-10-11T16:00:00.000Z" } }).trends;
  assert.equal(monthly.grouping, "month");
  assert.equal(monthly.periods.at(-1), "2026-10");
  assert.equal(charts.periodLabel("2026-10", "month"), "Oct 2026");
});

test("Traffic & Flow puts the weekly heatmap beside the service demand donut, with totals matching Total Patients", () => {
  const payload = build();
  const tree = render("DetailedInsights", payload);
  const overview = nodes(tree, (node) => node.type === "section" && node.props["aria-labelledby"] === "traffic-flow-title")[0];
  const content = text(overview);
  assert.match(content, /Traffic & Flow/);
  assert.match(content, /Weekly Queue Heatmap/);
  assert.match(content, /Service Demand/);
  assert.match(content, /\b24\s+Total\b/, "the donut centre shows every visit");
  assert.match(content, /General Consultation\s+95\.8%/);
  assert.match(content, /Prenatal\s+4\.2%/);
  assert.equal(nodes(overview, (node) => node.type === "canvas").length, 1);
  // Seven weekdays × five two-hour intervals; each cell describes itself for hover, focus and screen readers.
  const cells = nodes(overview, (node) => node.props?.role === "cell");
  assert.equal(cells.length, 35);
  assert.ok(cells.some((cell) => cell.props["aria-label"] === "Sunday, 8 AM – 10 AM: 3 patients"));
  assert.ok(cells.some((cell) => cell.props["aria-label"] === "Monday, 4 PM – 6 PM: 0 patients"));
  // Grid order: an empty corner slot and the five time headers, then each row starts with its day.
  const grid = nodes(overview, (node) => node.props?.role === "table")[0];
  const slots = nodes(grid.props.children, (node) => ["columnheader", "rowheader", "cell"].includes(node.props?.role))
    .map((node) => (node.props.role === "cell" ? "cell" : text(node).trim() || "corner"));
  same(slots.slice(0, 6), ["corner", "8 AM", "10 AM", "12 PM", "2 PM", "4 PM"]);
  same(slots.slice(6, 12), ["Mon", "cell", "cell", "cell", "cell", "cell"]);
  same(slots.slice(-6), ["Sun", "cell", "cell", "cell", "cell", "cell"]);
  assert.doesNotMatch(content, /6 PM \+|Before 8 AM/);
  assert.doesNotMatch(content, /View Details/);
});

test("the weekly heatmap shows 8 AM to 4 PM only, in green shades by volume, and counts arrivals outside those hours separately", () => {
  const peak = build().peak;
  const heat = charts.weeklyHeatmap(peak);
  same(heat.columns.map((column) => column.label), ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM"]);
  same(heat.rows.map((row) => row.weekday), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  assert.equal(heat.total, peak.total_arrivals);
  assert.equal(heat.max, 3);
  assert.equal(charts.heatColor(0, heat.max), null, "an empty cell stays neutral");
  assert.equal(charts.heatColor(3, 3), charts.HEAT_COLORS[4], "the busiest interval is the darkest green");
  assert.equal(charts.heatColor(1, 6), charts.HEAT_COLORS[0]);
  assert.equal(heat.outside, 0);
  // Early and evening arrivals get no column; they are counted as outside the heatmap, not dropped.
  const offHours = { hours: [6, 7, 8, 17, 18, 19].map((hour) => ({ hour })), matrix: [{ weekday: "Monday", counts: [1, 0, 2, 4, 3, 1] }] };
  const withOffHours = charts.weeklyHeatmap(offHours);
  same(withOffHours.columns.map((column) => column.label), ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM"]);
  same(withOffHours.rows[0].cells, [2, 0, 0, 0, 4]);
  assert.equal(withOffHours.total, 6);
  assert.equal(withOffHours.outside, 5);
  assert.equal(charts.weeklyHeatmap(undefined).total, 0);
});

test("the service demand donut hides its own legend and keeps exact tooltips", () => {
  const demand = build().demand;
  const donut = charts.demandChart(demand);
  assert.equal(donut.options.plugins.legend.display, false);
  assert.equal(donut.options.cutout, "70%");
  assert.equal(donut.options.plugins.tooltip.callbacks.label({ label: "Prenatal", raw: 1 }), "Prenatal: 1 patient (4.2%)");
});
