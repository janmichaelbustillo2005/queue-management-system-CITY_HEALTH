const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let charts;

before(async () => {
  await swc.loadBindings();
  const compile = async (relative) => (await swc.transform(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"), {
    filename: relative, jsc: { parser: { syntax: "ecmascript" } }, module: { type: "commonjs" }
  })).code;
  const load = (code, dependencies = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, Intl, require: (name) => dependencies[name] });
    return module.exports;
  };
  const dailyTrends = load(await compile("lib/dailyTrendsCharts.js"));
  charts = load(await compile("lib/analyticsCharts.js"), { "./dailyTrendsCharts": dailyTrends });
});

const colors = (config) => Array.from(config.data.datasets[0].backgroundColor);

test("each service, sex and status keeps the same colour whatever order the data arrives in", () => {
  const forward = charts.buildAnalyticsCharts({ serviceTypes: { labels: ["consultation", "prenatal"], data: [3, 1] },
    sexDistribution: { labels: ["Male", "Female"], data: [1, 1] } });
  const reverse = charts.buildAnalyticsCharts({ serviceTypes: { labels: ["prenatal", "consultation"], data: [1, 3] },
    sexDistribution: { labels: ["Female", "Male"], data: [1, 1] } });
  assert.deepEqual(colors(forward.serviceTypesChart), colors(reverse.serviceTypesChart).reverse());
  assert.equal(charts.sexColor("Female"), "#ec4899");
  assert.deepEqual(colors(reverse.sexDistributionChart), ["#ec4899", "#3b82f6"]);
  assert.equal(charts.statusColor("completed"), charts.statusColor("completed", 3));
  assert.notEqual(charts.statusColor("completed"), charts.statusColor("cancelled"));
  assert.equal(charts.sexColor("Not recorded"), "#9ca3af");
});

test("charts show readable labels instead of stored database values", () => {
  const built = charts.buildAnalyticsCharts({
    serviceTypes: { labels: ["family_planning", "checkup"], data: [1, 1] },
    priorityCategories: { labels: ["solo_parent", "regular"], data: [1, 2] }
  });
  assert.deepEqual(Array.from(built.serviceTypesChart.data.labels), ["Family Planning", "Medical Check-up"]);
  assert.deepEqual(Array.from(built.priorityChart.data.labels), ["Solo Parent", "Regular (no priority)"]);
  assert.equal(charts.statusLabel("no-show"), "No-show");
  assert.equal(charts.serviceLabel("dental_care"), "Dental Care");
  assert.equal(charts.readableLabel(""), "Not recorded");
});

test("pie tooltips include the share of the total", () => {
  const built = charts.buildAnalyticsCharts({ serviceTypes: { labels: ["prenatal", "consultation"], data: [1, 3] } });
  const label = built.serviceTypesChart.options.plugins.tooltip.callbacks.label;
  assert.equal(label({ label: "Prenatal", raw: 1, dataset: built.serviceTypesChart.data.datasets[0] }), "Prenatal: 1 (25%)");
});

test("trend, hourly and residency charts use count axes and the residency chart is horizontal", () => {
  const built = charts.buildAnalyticsCharts({
    dailyTrends: { labels: ["Oct 9, 2026", "Oct 10, 2026"], data: [2, 0] },
    hourly: { labels: ["08:00", "09:00"], data: [0, 4] },
    residency: { labels: ["Sumile", "Not recorded"], data: [3, 1] }
  });
  assert.equal(built.patientsPerDayChart.type, "line");
  assert.deepEqual(Array.from(built.patientsPerDayChart.data.datasets[0].data), [2, 0]);
  assert.equal(built.arrivalsByHourChart.type, "bar");
  assert.equal(built.arrivalsByHourChart.options.scales.y.ticks.precision, 0);
  assert.equal(built.residencyChart.options.indexAxis, "y");
  assert.equal(colors(built.residencyChart)[1], "#9ca3af");
});

test("empty or all-zero series count as no data, and only Distribution and Trends draw page charts", () => {
  assert.equal(charts.hasChartData({ labels: [], data: [] }), false);
  assert.equal(charts.hasChartData({ labels: ["Oct 9"], data: [0] }), false);
  assert.equal(charts.hasChartData(undefined), false);
  assert.equal(charts.hasChartData({ labels: ["Oct 9"], data: [1] }), true);
  assert.deepEqual(Object.keys(charts.TAB_CHARTS), ["distribution", "trends"]);
  assert.equal(charts.TAB_CHARTS.distribution.length, 5);
});
