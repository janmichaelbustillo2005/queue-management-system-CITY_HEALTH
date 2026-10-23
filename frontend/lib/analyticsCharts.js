import { statusColor } from "./dailyTrendsCharts";

// Readable labels and fixed colours for the Analytics page. The backend sends
// stable keys (e.g. "family_planning", "no-show"); each key always keeps the
// same colour, whatever order or subset of categories a period contains.

export const SERVICE_LABELS = {
  consultation: "General Consultation",
  checkup: "Medical Check-up",
  prenatal: "Prenatal",
  maternity: "Maternity",
  family_planning: "Family Planning"
};

export const STATUS_LABELS = {
  waiting: "Waiting",
  serving: "Serving",
  completed: "Completed",
  cancelled: "Cancelled",
  "no-show": "No-show"
};

export const PRIORITY_LABELS = {
  senior: "Senior Citizen",
  pwd: "PWD",
  pregnant: "Pregnant",
  indigenous: "Indigenous People",
  solo_parent: "Solo Parent",
  regular: "Regular (no priority)"
};

const NOT_RECORDED = "Not recorded";
const NEUTRAL = "#9ca3af";
const FALLBACK_COLORS = ["#64748b", "#06b6d4", "#d946ef", "#84cc16", "#f97316"];
const SERVICE_COLORS = {
  consultation: "#167d3f", checkup: "#3b82f6", prenatal: "#ec4899", maternity: "#a855f7", family_planning: "#c6a51b"
};
const SEX_COLORS = { Male: "#3b82f6", Female: "#ec4899", [NOT_RECORDED]: NEUTRAL };
const PRIORITY_COLORS = {
  senior: "#f59e0b", pwd: "#0ea5e9", pregnant: "#ec4899", indigenous: "#8b5cf6", solo_parent: "#14b8a6", regular: NEUTRAL
};

// Each tab draws only the canvases it renders.
export const TAB_CHARTS = {
  distribution: ["serviceTypesChart", "sexDistributionChart", "priorityChart", "ageGroupChart", "residencyChart"],
  trends: ["patientsPerDayChart", "arrivalsByHourChart"]
};

export function readableLabel(value, labels = {}) {
  if (labels[value]) return labels[value];
  const text = String(value ?? "").replace(/[_-]+/g, " ").trim();
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : NOT_RECORDED;
}

export const serviceLabel = (value) => readableLabel(value, SERVICE_LABELS);
export const statusLabel = (value) => readableLabel(value, STATUS_LABELS);
export const priorityLabel = (value) => readableLabel(value, PRIORITY_LABELS);

function colorFor(key, palette, index) {
  if (palette[key]) return palette[key];
  return key === NOT_RECORDED ? NEUTRAL : FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export const serviceColor = (key, index = 0) => colorFor(key, SERVICE_COLORS, index);
export const sexColor = (key, index = 0) => colorFor(key, SEX_COLORS, index);
export const priorityColor = (key, index = 0) => colorFor(key, PRIORITY_COLORS, index);
export { statusColor };

function series(chart) {
  const labels = Array.isArray(chart?.labels) ? chart.labels : [];
  const data = Array.isArray(chart?.data) ? chart.data : [];
  return { keys: labels, data: labels.map((_, index) => Number(data[index]) || 0) };
}

export function hasChartData(chart) {
  return series(chart).data.some((value) => value > 0);
}

function percentTooltip({ label, raw, dataset }) {
  const total = dataset.data.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const share = total ? ` (${((raw * 100) / total).toLocaleString(undefined, { maximumFractionDigits: 1 })}%)` : "";
  return `${label}: ${raw}${share}`;
}

function shareChart(type, chart, labelOf, colorOf) {
  const { keys, data } = series(chart);
  return {
    type,
    data: {
      labels: keys.map(labelOf),
      datasets: [{ label: "Patients", data, backgroundColor: keys.map(colorOf), borderColor: "#ffffff", borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, padding: 8, font: { size: 11 } } },
        tooltip: { callbacks: { label: percentTooltip } }
      }
    }
  };
}

function countAxes(horizontal = false) {
  const count = { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, title: { display: true, text: "Patients", font: { size: 10 } } };
  const category = { ticks: { font: { size: 10 }, autoSkip: true, maxRotation: horizontal ? 0 : 45 }, grid: { display: false } };
  return horizontal ? { x: count, y: category } : { x: category, y: count };
}

function barChart(chart, labelOf, colorOf, { horizontal = false } = {}) {
  const { keys, data } = series(chart);
  return {
    type: "bar",
    data: {
      labels: keys.map(labelOf),
      datasets: [{ label: "Patients", data, backgroundColor: keys.map(colorOf), borderRadius: 4, maxBarThickness: 42 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? "y" : "x",
      plugins: { legend: { display: false } },
      scales: countAxes(horizontal)
    }
  };
}

export function buildAnalyticsCharts(charts = {}, brand = {}) {
  const primary = brand.primary || "#167d3f";
  const forest = brand.forest || "#0b3d2e";
  const daily = series(charts.dailyTrends);
  return {
    serviceTypesChart: shareChart("doughnut", charts.serviceTypes, serviceLabel, serviceColor),
    sexDistributionChart: shareChart("pie", charts.sexDistribution, (value) => value, sexColor),
    priorityChart: barChart(charts.priorityCategories, priorityLabel, priorityColor, { horizontal: true }),
    ageGroupChart: barChart(charts.ageGroups, (value) => value, (key) => (key === NOT_RECORDED ? NEUTRAL : primary)),
    residencyChart: barChart(charts.residency, (value) => value, (key) => (key === NOT_RECORDED ? NEUTRAL : forest), { horizontal: true }),
    patientsPerDayChart: {
      type: "line",
      data: {
        labels: daily.keys,
        datasets: [{
          label: "Patients", data: daily.data, borderColor: primary, backgroundColor: `${primary}22`,
          // Monotone curves never overshoot, so the line cannot suggest counts that did not occur.
          fill: true, cubicInterpolationMode: "monotone", pointRadius: daily.data.length > 45 ? 0 : 3, pointHoverRadius: 5
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: countAxes()
      }
    },
    arrivalsByHourChart: barChart(charts.hourly, (value) => value, () => forest)
  };
}
