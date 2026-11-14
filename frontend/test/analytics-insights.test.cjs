const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");
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
  const analyticsCharts = load(await compile("lib/analyticsCharts.js"), { "./dailyTrendsCharts": dailyTrends, "./services": loadServices() });
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState: (initial) => { const view = { value: initial }; views.push(view); return [view.value, (next) => { view.value = next; }]; },
    useMemo: (factory) => factory(), useRef: () => ({ current: null }), useEffect: () => {}
  };
  charts = load(await compile("lib/insightsCharts.js"), { "./analyticsCharts": analyticsCharts, "./services": loadServices() });
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
  const shown = { data: performance.data, isDatasetVisible: () => true };
  same(performance.options.plugins.tooltip.callbacks.footer([{ chart: shown, dataIndex: 0 }]),
    [`Total: ${payload.volumes[0].total} patient${payload.volumes[0].total === 1 ? "" : "s"}`]);
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

// Patient Arrival Trend with the 13 offered services: three days, a few busy services, most idle.
const offered = () => loadServices().OFFERED_SERVICES.map((row) => row.value);
function manyServiceTrends() {
  const counts = {
    medical_consultation: [5, 0, 7], maternal_healthcare: [2, 1, 3], family_planning: [1, 0, 3], child_healthcare: [3, 0, 2],
    dental_healthcare: [0, 0, 1], nutrition: [1, 0, 1], diagnostic_imaging: [0, 2, 1], womens_health: [0, 0, 0],
    mental_healthcare: [0, 0, 1], medical_documentation: [2, 0, 0], marriage_preparation: [0, 0, 1], environmental_health: [0, 0, 0], food_safety: [0, 0, 0]
  };
  const byService = offered().map((service) => ({ service, counts: counts[service] }));
  const total = [0, 1, 2].map((day) => byService.reduce((sum, row) => sum + row.counts[day], 0));
  return { grouping: "day", periods: ["2026-11-10", "2026-11-11", "2026-11-12"], arrivals: { total, by_service: byService },
    wait: { overall: [], samples: [], by_service: [] } };
}
// The tooltip Chart.js would build at one point (index mode), with the chart's filter and sort applied.
function tooltipAt(config, dataIndex, { width = 900, hidden = [] } = {}) {
  const chart = { width, data: config.data, isDatasetVisible: (index) => !hidden.includes(index) };
  const tip = config.options.plugins.tooltip;
  const items = config.data.datasets.map((dataset, datasetIndex) => ({ chart, dataset, datasetIndex, dataIndex, raw: dataset.data[dataIndex] }))
    .filter((item) => chart.isDatasetVisible(item.datasetIndex)).filter((item) => tip.filter(item)).sort(tip.itemSort);
  return {
    title: tip.callbacks.title(items),
    lines: items.flatMap((item) => [tip.callbacks.label(item), tip.callbacks.afterLabel(item)].filter(Boolean)),
    footer: tip.callbacks.footer(items)
  };
}

test("arrival trend: every service has its own fixed line style, and All patients stands out", () => {
  const values = [...offered(), ...loadServices().FORMER_SERVICES.map((row) => row.value)];
  const looks = values.map((service) => JSON.stringify(charts.arrivalServiceStyle(service)));
  assert.equal(new Set(looks).size, values.length, "no two services share a hue and dash pattern");
  const config = charts.arrivalTrendChart(manyServiceTrends(), brand);
  const [all, ...services] = config.data.datasets;
  assert.equal(all.label, "All patients");
  assert.equal(all.borderColor, brand.forest);
  assert.ok(services.every((dataset) => dataset.borderWidth < all.borderWidth && dataset.pointRadius === 0 && dataset.order > all.order));
  // A filter that removes some services leaves the others' look unchanged.
  const subset = manyServiceTrends();
  subset.arrivals.by_service = subset.arrivals.by_service.filter((row) => ["nutrition", "child_healthcare", "medical_consultation"].includes(row.service));
  const nutrition = (cfg) => cfg.data.datasets.find((dataset) => dataset.service === "nutrition");
  same([nutrition(charts.arrivalTrendChart(subset, brand)).hue, nutrition(charts.arrivalTrendChart(subset, brand)).borderDash],
    [nutrition(config).hue, nutrition(config).borderDash]);
  // The canvas legend is off (the page lists services below); ticks never rotate into each other.
  assert.equal(config.options.plugins.legend.display, false);
  assert.equal(config.options.scales.x.ticks.maxRotation, 0);
  // Services with no arrivals at all in the period get no line, as before; the values are the payload's.
  same(services.map((dataset) => dataset.service).sort(),
    offered().filter((key) => !["womens_health", "environmental_health", "food_safety"].includes(key)).sort());
  same(all.data, manyServiceTrends().arrivals.total);
});

test("arrival trend tooltip: date, total, the busiest services first, and a summary of the rest", () => {
  const config = charts.arrivalTrendChart(manyServiceTrends(), brand);
  const day = tooltipAt(config, 2);
  assert.equal(day.title, "Thu, Nov 12, 2026");
  same(day.lines, ["Total: 20 patients", "By service, most first:", "Medical consultation: 7", "Maternal healthcare: 3", "Family planning: 3",
    "Child healthcare: 2", "Dental healthcare: 1"]);
  same(day.footer, ["+ 4 more services (4 patients)", "1 service with no arrivals", "Full breakdown in the list below"]);
  // A narrow chart lists fewer services; nothing is lost, the footer counts the rest.
  const narrow = tooltipAt(config, 2, { width: 360 });
  assert.equal(narrow.lines.length, 2 + 3);
  assert.equal(narrow.footer[0], "+ 6 more services (7 patients)");
  // Hidden lines are left out and said so.
  const consultation = config.data.datasets.findIndex((dataset) => dataset.service === "medical_consultation");
  const hidden = tooltipAt(config, 2, { hidden: [consultation] });
  assert.doesNotMatch(hidden.lines.join("\n"), /Medical consultation/);
  assert.match(hidden.footer.join("\n"), /1 hidden service not listed/);
  // A quiet day still names the total first.
  same(tooltipAt(config, 1).lines.slice(0, 3), ["Total: 3 patients", "By service, most first:", "Diagnostic imaging: 2"]);
  const week = { ...manyServiceTrends(), grouping: "week" };
  assert.equal(tooltipAt(charts.arrivalTrendChart(week, brand), 0).title, "Week of Nov 10, 2026");
  assert.equal(charts.arrivalPeriodTitle("2026-10", "month"), "October 2026");
});

test("arrival breakdown lists every service with exact counts, for the period or for one point", () => {
  const trends = manyServiceTrends();
  const whole = charts.arrivalBreakdown(trends);
  assert.equal(whole.title, "Selected period");
  assert.equal(whole.total, 37);
  assert.equal(whole.rows.reduce((sum, row) => sum + row.count, 0), whole.total, "services add up to the total");
  assert.equal(whole.rows.length, 10, "services with arrivals in the period");
  same(whole.rows.slice(0, 2).map((row) => [row.label, row.count]), [["Medical consultation", 12], ["Maternal healthcare", 6]]);
  const point = charts.arrivalBreakdown(trends, 1);
  assert.equal(point.title, "Wed, Nov 11, 2026");
  assert.equal(point.total, 3);
  assert.equal(point.withArrivals, 2);
  same(point.rows.map((row) => row.service), whole.rows.map((row) => row.service), "the order does not jump while hovering");
  assert.equal(point.rows.find((row) => row.service === "medical_consultation").count, 0, "a service with no arrivals that day shows 0");
  assert.equal(charts.arrivalBreakdown(trends, 99).period, null, "an index outside the period falls back to the whole period");
  assert.equal(charts.arrivalBreakdown(undefined).rows.length, 0);
});

test("the arrival trend panel shows the chart and a toggleable service grid instead of the canvas legend", () => {
  const payload = build();
  payload.trends = manyServiceTrends();
  const panel = nodes(render("DetailedInsights", payload), (node) => node.props?.["aria-label"] === "Patient arrivals by service")[0];
  const content = text(panel);
  assert.match(content, /Selected period/);
  assert.match(content, /37\s+patient/);
  assert.match(content, /10\s+of\s+10\s+service/);
  const toggles = nodes(panel, (node) => node.type === "button" && "aria-pressed" in node.props);
  assert.equal(toggles.length, 10);
  assert.ok(toggles.every((button) => button.props["aria-pressed"] === true));
  assert.match(content, /Show all/);
  assert.doesNotMatch(content, /undefined|NaN|\[object/);
});

// Average Wait Time Trend with several services over four days: gaps, a lone value, a 0-minute wait.
function manyServiceWaitTrends() {
  const waits = {
    medical_consultation: { values: [12.5, null, 20, 18], samples: [4, 0, 5, 3] },
    maternal_healthcare: { values: [95, null, 110, null], samples: [2, 0, 1, 0] },
    family_planning: { values: [null, null, 6, null], samples: [0, 0, 2, 0] },
    child_healthcare: { values: [3, null, 4.5, 2], samples: [1, 0, 2, 1] },
    dental_healthcare: { values: [0, null, null, null], samples: [1, 0, 0, 0] },
    nutrition: { values: [8, null, 9, 7], samples: [1, 0, 1, 1] },
    diagnostic_imaging: { values: [30, null, 25, 40], samples: [1, 0, 2, 1] },
    mental_healthcare: { values: [null, null, 15, null], samples: [0, 0, 1, 0] },
    womens_health: { values: [null, null, null, null], samples: [0, 0, 0, 0] }
  };
  const byService = Object.entries(waits).map(([service, row]) => ({ service, ...row }));
  return { grouping: "day", periods: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"],
    arrivals: { total: [11, 0, 14, 6], by_service: [] },
    wait: { overall: [24.1, null, 26.2, 15.3], samples: [10, 0, 14, 6], by_service: byService } };
}

test("wait trend: All services stands out, each service keeps its arrival-trend look, and the canvas legend is off", () => {
  const trends = manyServiceWaitTrends();
  const config = charts.waitTrendChart(trends, brand);
  const [all, ...services] = config.data.datasets;
  assert.equal(all.label, "All services");
  assert.equal(all.borderColor, brand.forest);
  assert.ok(services.every((dataset) => dataset.borderWidth < all.borderWidth && dataset.order > all.order));
  assert.equal(config.options.plugins.legend.display, false);
  assert.equal(config.options.scales.x.ticks.maxRotation, 0);
  // Every service has its own look (previously most services shared one fallback grey).
  assert.equal(new Set(services.map((dataset) => `${dataset.hue}${JSON.stringify(dataset.borderDash)}`)).size, services.length);
  for (const dataset of services) {
    const look = charts.arrivalServiceStyle(dataset.service);
    same([dataset.hue, dataset.borderDash], [look.hue, look.dash]);
  }
  // A service measured at 0 minutes is real data and keeps its line; one never measured gets none.
  assert.ok(services.some((dataset) => dataset.service === "dental_healthcare"));
  assert.ok(!services.some((dataset) => dataset.service === "womens_health"));
  // Values are the payload's, gaps stay null (never zero), and the axis stays linear from zero.
  same(all.data, trends.wait.overall);
  same(services.find((dataset) => dataset.service === "maternal_healthcare").data, [95, null, 110, null]);
  assert.ok(config.data.datasets.every((dataset) => dataset.spanGaps === false));
  assert.equal(config.options.scales.y.type, undefined, "default linear scale, no log transform");
  assert.equal(config.options.scales.y.beginAtZero, true);
  // A lone value between gaps keeps a visible point; joined values draw as a line only.
  same(services.find((dataset) => dataset.service === "family_planning").pointRadius, [0, 0, 2.5, 0]);
  same(services.find((dataset) => dataset.service === "medical_consultation").pointRadius, [2.5, 0, 0, 0]);
});

test("wait trend tooltip: date, All services first, the longest service waits next, and a summary of the rest", () => {
  const config = charts.waitTrendChart(manyServiceWaitTrends(), brand);
  const day = tooltipAt(config, 2);
  assert.equal(day.title, "Wed, Nov 11, 2026");
  same(day.lines, ["All services: 26.2 min average (14 patients)", "By service, longest wait first:",
    "Maternal healthcare: 110 min (1 patient)", "Diagnostic imaging: 25 min (2 patients)", "Medical consultation: 20 min (5 patients)",
    "Mental healthcare: 15 min (1 patient)", "Nutrition: 9 min (1 patient)", "Family planning: 6 min (2 patients)"]);
  same(day.footer, ["+ 1 more service with shorter waits", "1 service with no patients called", "Full breakdown in the list below"]);
  assert.equal(tooltipAt(config, 2, { width: 360 }).lines.length, 2 + 3, "a narrow chart lists fewer services");
  // A period with no patient called says so instead of showing 0.
  same(tooltipAt(config, 1).lines, ["All services: no patients called"]);
  // A 0-minute average is shown as 0 min, not as missing.
  assert.match(tooltipAt(config, 0).lines.join("\n"), /Dental healthcare: 0 min \(1 patient\)/);
  // Hidden lines are left out and said so.
  const maternal = config.data.datasets.findIndex((dataset) => dataset.service === "maternal_healthcare");
  const hidden = tooltipAt(config, 2, { hidden: [maternal] });
  assert.doesNotMatch(hidden.lines.join("\n"), /Maternal/);
  assert.match(hidden.footer.join("\n"), /1 hidden service not listed/);
});

test("wait breakdown: exact backend averages for the period, the payload's values for one point", () => {
  const trends = manyServiceWaitTrends();
  const stats = { by_service: [{ key: "medical_consultation", samples: 12, avg: 17.1 }, { key: "nutrition", samples: 99, avg: 8 }] };
  const whole = charts.waitBreakdown(trends, stats);
  assert.equal(whole.title, "Selected period");
  assert.equal(whole.samples, 30);
  assert.equal(whole.minutes, null, "no re-averaging of rounded period values");
  assert.equal(whole.rows.length, 8);
  assert.equal(whole.rows[0].service, "medical_consultation", "most patients measured first");
  assert.equal(whole.rows[0].minutes, 17.1);
  assert.equal(whole.rows.find((row) => row.service === "nutrition").minutes, null, "sample counts differ, so the figure is left out");
  const point = charts.waitBreakdown(trends, stats, 2);
  assert.equal(point.title, "Wed, Nov 11, 2026");
  same([point.minutes, point.samples], [26.2, 14]);
  same(point.rows.map((row) => row.service), whole.rows.map((row) => row.service), "the order does not jump while hovering");
  const maternal = point.rows.find((row) => row.service === "maternal_healthcare");
  same([maternal.minutes, maternal.samples], [110, 1]);
  assert.equal(point.rows.find((row) => row.service === "dental_healthcare").minutes, null);
  // With the real builder the per-service figures for the whole period come straight from insights.wait.
  const payload = build();
  const real = charts.waitBreakdown(payload.trends, payload.wait);
  const consultation = payload.wait.by_service.find((row) => row.key === "consultation");
  assert.equal(real.rows.find((row) => row.service === "consultation").minutes, consultation.avg);
});

test("the wait trend panel lists every measured service as a toggle, with All services toggleable too", () => {
  const payload = build();
  payload.trends = manyServiceWaitTrends();
  const panel = nodes(render("DetailedInsights", payload), (node) => node.props?.["aria-label"] === "Average wait by service")[0];
  const content = text(panel);
  assert.match(content, /All services/);
  assert.match(content, /30\s+patients\s+called/);
  const toggles = nodes(panel, (node) => node.type === "button" && "aria-pressed" in node.props);
  assert.equal(toggles.length, 1 + 8);
  assert.ok(toggles.every((button) => button.props["aria-pressed"] === true));
  assert.match(content, /Show all/);
  assert.match(content, /Hide all services/);
  assert.match(content, /axis rescales to the lines shown/);
  assert.doesNotMatch(content, /undefined|NaN|\[object/);
});

// Shared dispatch: a visit no doctor was recorded on is "Unassigned", as getVisitDoctor does.
const sharedCtx = () => ctx({ doctorOf: (row) => row.counter_id || "Unassigned" });

test("doctor performance: Unassigned is kept out of the bars and every record is still accounted for", () => {
  const payload = build({ ctx: sharedCtx() });
  const unassigned = payload.volumes.find((row) => row.doctor === "Unassigned");
  assert.ok(unassigned, "the fixture has unassigned visits");
  const summary = charts.doctorPerformance(payload.volumes);
  same(summary.unassigned, unassigned);
  assert.ok(summary.doctors.every((row) => row.doctor !== "Unassigned"));
  assert.equal(summary.total, payload.volumes.reduce((sum, row) => sum + row.total, 0), "doctors + unassigned = every record");
  assert.equal(summary.total, 24);
  for (const outcome of summary.outcomeTotals) {
    assert.equal(outcome.count, summary.doctors.reduce((sum, row) => sum + row[outcome.key], 0));
  }
  for (const row of payload.volumes) assert.equal(row.completed + row.cancelled + row.no_show + row.in_queue, row.total, row.doctor);
  const config = charts.doctorPerformanceChart(payload.volumes);
  same(config.data.labels, summary.doctors.map((row) => row.doctor), "doctor order is the payload's");
  same(datasetValues(config, "Still in the queue"), summary.doctors.map((row) => row.in_queue));
  assert.equal(config.options.indexAxis, "y");
  assert.equal(config.options.plugins.legend.display, false);
  // Only unassigned visits: no doctor bars, but the summary still holds them.
  const onlyUnassigned = [{ ...unassigned }];
  assert.equal(charts.doctorPerformanceChart(onlyUnassigned), null);
  assert.equal(charts.doctorPerformance(onlyUnassigned).total, unassigned.total);
});

test("doctor performance tooltip: doctor name, every outcome count including zeros, and the total", () => {
  const volumes = [{ doctor: "Doctor 1", total: 16, completed: 8, cancelled: 6, no_show: 0, in_queue: 2 },
    { doctor: "Unassigned", total: 40, completed: 0, cancelled: 30, no_show: 4, in_queue: 6 }];
  const config = charts.doctorPerformanceChart(volumes);
  const tip = config.options.plugins.tooltip;
  const chart = { data: config.data, isDatasetVisible: () => true };
  const items = config.data.datasets.map((dataset, datasetIndex) => ({ chart, dataset, datasetIndex, dataIndex: 0, raw: dataset.data[0] }));
  assert.equal(tip.callbacks.title(items), "Doctor 1");
  same(items.map(tip.callbacks.label), ["Completed: 8", "Cancelled: 6", "No-show: 0", "Still in the queue: 2"]);
  same(tip.callbacks.footer(items), ["Total: 16 patients"]);
  const partly = { data: config.data, isDatasetVisible: (index) => index !== 1 };
  same(tip.callbacks.footer([{ chart: partly, dataIndex: 0 }]), ["Total: 16 patients", "1 hidden outcome not listed"]);
  // Outcome colours are all distinct, and the stacked segments are separated by a white gap.
  assert.equal(new Set(charts.DOCTOR_OUTCOMES.map((outcome) => outcome.color)).size, 4);
  assert.ok(config.data.datasets.every((dataset) => dataset.borderColor === "#ffffff"));
});

test("the doctor performance panel shows outcome toggles, the Unassigned section and the all-records line", () => {
  const payload = build({ ctx: sharedCtx() });
  const tree = render("DetailedInsights", payload);
  const content = text(tree);
  const unassigned = payload.volumes.find((row) => row.doctor === "Unassigned");
  const section = nodes(tree, (node) => node.props?.["aria-label"] === "Unassigned visits")[0];
  assert.ok(section);
  assert.match(text(section), /not attributed to an individual doctor/);
  const outcomes = nodes(tree, (node) => node.props?.["aria-label"] === "Outcomes across the doctors")[0];
  assert.equal(nodes(outcomes, (node) => node.type === "button" && "aria-pressed" in node.props).length, 4);
  assert.match(content, new RegExp(`All records:\\s+24\\s+=\\s+${24 - unassigned.total}\\s+attributed to doctors \\+\\s+${unassigned.total}\\s+unassigned`));
  assert.doesNotMatch(content, /undefined|NaN|\[object/);
  // Without unassigned visits there is no Unassigned section.
  assert.equal(nodes(render("DetailedInsights", build()), (node) => node.props?.["aria-label"] === "Unassigned visits").length, 0);
});
