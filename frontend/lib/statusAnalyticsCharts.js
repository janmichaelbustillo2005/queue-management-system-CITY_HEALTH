import { finiteMetric, getManilaToday, makeFilters, statusColor, buildStatusChart } from "./dailyTrendsCharts";

export { finiteMetric, getManilaToday, makeFilters, statusColor, buildStatusChart };

export const METRIC_KEYS = ["total_patients", "waiting_patients", "currently_serving", "completed_patients", "avg_wait_minutes", "avg_service_minutes"];

export function isStatusAnalyticsData(data, filters) {
  const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
  const numeric = (value) => value === null || finiteMetric(value) !== null;
  const rows = (value, label) => Array.isArray(value) && value.every((row) => row && typeof row === "object" && !Array.isArray(row) && typeof row[label] === "string");
  return Boolean(data && data.time_zone === "Asia/Manila" && timestamp(data.observed_at) &&
    data.range?.date === filters.date && data.range?.view === filters.view &&
    timestamp(data.range.start_at) && timestamp(data.range.end_at) &&
    Date.parse(data.range.end_at) > Date.parse(data.range.start_at) &&
    (filters.view !== "shift" || (data.range.start_time === filters.startTime && data.range.end_time === filters.endTime)) &&
    METRIC_KEYS.every((key) => data.metrics?.[key] && numeric(data.metrics[key].value) && numeric(data.metrics[key].previous) &&
      (data.metrics[key].change_percent === null || Number.isFinite(data.metrics[key].change_percent))) &&
    rows(data.hourly, "label") && rows(data.statuses, "label") && rows(data.counters, "name") &&
    data.rates && ["arrival_rate_per_hour", "service_rate_per_hour", "completion_rate_percent"].every((key) => numeric(data.rates[key])) &&
    typeof data.rates.operational_status === "string" && finiteMetric(data.record_count) !== null &&
    (data.notes === undefined || (Array.isArray(data.notes) && data.notes.every((note) => typeof note === "string"))));
}

export function metricComparison(metric) {
  if (finiteMetric(metric?.value) === null) return "No data available";
  if (finiteMetric(metric?.previous) === null) return "No prior baseline";
  if (!Number.isFinite(metric?.change_percent)) return "No prior baseline";
  const value = metric.change_percent;
  return `${value > 0 ? "+" : ""}${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}% vs prior equivalent period`;
}

function options(unit, integer = false) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 8, right: 5 } },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: "#172033", titleColor: "#fff", bodyColor: "#e2e8f0", padding: 11, cornerRadius: 9, boxPadding: 5 }
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: {
        color: "#64748b", font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6,
        callback(value) {
          const interval = String(this.getLabelForValue(value));
          return `${interval.split("\u2013")[0]}${interval.includes("(+1 day)") ? " +1d" : ""}`;
        }
      } },
      y: { beginAtZero: true, border: { display: false }, grid: { color: "#eef2f6" },
        title: { display: true, text: unit, color: "#64748b", font: { size: 10 } },
        ticks: { color: "#64748b", font: { size: 10 }, ...(integer ? { precision: 0 } : {}) } }
    }
  };
}

const valueText = (value) => finiteMetric(value) === null ? "No data available" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function buildTimeComparisonChart(data) {
  const rows = data?.hourly || [];
  const config = options("Minutes");
  config.plugins.tooltip.callbacks = {
    label: ({ dataset, raw, dataIndex }) => {
      if (finiteMetric(raw) === null) return `${dataset.label}: No data available`;
      const sampleKey = dataset.sampleKey;
      const count = finiteMetric(rows[dataIndex]?.[sampleKey]);
      return `${dataset.label}: ${valueText(raw)} min${count === null ? "" : ` · ${count} valid ${count === 1 ? "visit" : "visits"}`}`;
    }
  };
  return { type: "line", data: { labels: rows.map((row) => row.label), datasets: [
    { label: "Average waiting time", sampleKey: "wait_samples", data: rows.map((row) => finiteMetric(row.avg_wait_minutes)), borderColor: "#8b5cf6", backgroundColor: "#8b5cf6" },
    { label: "Average service time", sampleKey: "service_samples", data: rows.map((row) => finiteMetric(row.avg_service_minutes)), borderColor: "#10b981", backgroundColor: "#10b981" }
  ].map((dataset) => ({ ...dataset, borderWidth: 2.5, tension: .25, pointRadius: 2, pointHoverRadius: 5, spanGaps: false, fill: false })) }, options: config };
}

export function buildArrivalsServedChart(data) {
  const rows = data?.hourly || [];
  const config = options("Patients", true);
  config.plugins.tooltip.callbacks = { label: ({ dataset, raw }) => `${dataset.label}: ${valueText(raw)}` };
  return { type: "bar", data: { labels: rows.map((row) => row.label), datasets: [
    { label: "Patient arrivals", data: rows.map((row) => finiteMetric(row.arrivals)), backgroundColor: "#3b82f6", borderRadius: 3, maxBarThickness: 16 },
    { label: "Patients served", data: rows.map((row) => finiteMetric(row.served)), backgroundColor: "#10b981", borderRadius: 3, maxBarThickness: 16 }
  ] }, options: config };
}

export function buildQueueLengthChart(data) {
  const rows = data?.hourly || [];
  const config = options("Average waiting patients");
  config.plugins.tooltip.callbacks = { label: ({ raw }) => `Time-weighted average queue: ${valueText(raw)}${finiteMetric(raw) === null ? "" : " patients"}` };
  return { type: "line", data: { labels: rows.map((row) => row.label), datasets: [{
    label: "Average queue length", data: rows.map((row) => finiteMetric(row.avg_queue_length)),
    borderColor: "#ef4444", backgroundColor: "rgba(239, 68, 68, .10)", fill: true,
    borderWidth: 2.5, tension: .25, pointRadius: 2, pointHoverRadius: 5, spanGaps: false
  }] }, options: config };
}
