import { finiteMetric, getManilaToday, makeFilters, statusColor } from "./dailyTrendsCharts";

export { finiteMetric, getManilaToday, makeFilters, statusColor };

export const METRIC_KEYS = ["total_patients", "waiting_patients", "currently_serving", "completed_patients", "avg_wait_minutes", "avg_service_minutes"];

export function isStatusAnalyticsData(data, filters) {
  const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
  const numeric = (value) => value === null || finiteMetric(value) !== null;
  const rows = (value, label) => Array.isArray(value) && value.every((row) => row && typeof row === "object" && !Array.isArray(row) && typeof row[label] === "string");
  const outcomes = data?.outcomes;
  return Boolean(data && data.time_zone === "Asia/Manila" && timestamp(data.observed_at) &&
    data.range?.date === filters.date && data.range?.view === filters.view &&
    timestamp(data.range.start_at) && timestamp(data.range.end_at) &&
    Date.parse(data.range.end_at) > Date.parse(data.range.start_at) &&
    (filters.view !== "shift" || (data.range.start_time === filters.startTime && data.range.end_time === filters.endTime)) &&
    METRIC_KEYS.every((key) => data.metrics?.[key] && numeric(data.metrics[key].value) && numeric(data.metrics[key].previous) &&
      (data.metrics[key].change_percent === null || Number.isFinite(data.metrics[key].change_percent))) &&
    outcomes && typeof outcomes === "object" && numeric(outcomes.total) && typeof outcomes.live === "boolean" &&
    rows(outcomes.statuses, "label") && outcomes.statuses.every((row) => finiteMetric(row.count) !== null) &&
    (outcomes.carry_in === null || (finiteMetric(outcomes.carry_in?.waiting) !== null && finiteMetric(outcomes.carry_in?.serving) !== null)) &&
    rows(data.counters, "name") && finiteMetric(data.record_count) !== null &&
    (data.notes === undefined || (Array.isArray(data.notes) && data.notes.every((note) => typeof note === "string"))));
}

// What "previous" means, in words: the backend compares with the same clock
// window on the day before, cut to the time that has passed so far.
export function comparisonLabel(data) {
  const ongoing = Date.parse(data?.range?.effective_end_at) < Date.parse(data?.range?.end_at);
  if (ongoing) return "vs same time yesterday";
  return data?.range?.view === "shift" ? "vs same shift the day before" : "vs the day before";
}

export function metricComparison(metric, label = "vs the day before") {
  if (finiteMetric(metric?.value) === null) return "No data available";
  if (finiteMetric(metric?.previous) === null) return "No comparison available";
  if (metric.previous === 0) return metric.value === 0 ? `No change ${label}` : `Up from 0 ${label}`;
  const change = metric.change_percent;
  if (!Number.isFinite(change)) return "No comparison available";
  if (change === 0) return `No change ${label}`;
  return `${change > 0 ? "Up" : "Down"} ${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })}% ${label}`;
}

// Changes smaller than this are everyday noise, not an improvement or a problem.
const MEANINGFUL_CHANGE = 0.05;

// "lower" metrics (waiting time) improve when they fall; neutral ones carry no judgement.
export function comparisonTone(metric, better = "neutral") {
  const value = finiteMetric(metric?.value), previous = finiteMetric(metric?.previous);
  if (better === "neutral" || value === null || previous === null || value === previous) return "neutral";
  if (previous > 0 && Math.abs(value - previous) / previous < MEANINGFUL_CHANGE) return "neutral";
  return (value < previous) === (better === "lower") ? "better" : "worse";
}

export function buildOutcomeChart(outcomes) {
  const rows = (outcomes?.statuses || []).filter((row) => (finiteMetric(row.count) ?? 0) > 0);
  return {
    type: "doughnut",
    data: {
      labels: rows.map((row) => row.label),
      datasets: [{
        data: rows.map((row) => row.count),
        backgroundColor: rows.map((row, index) => statusColor(row.status, index)),
        borderWidth: 3, borderColor: "#fff", hoverOffset: 5
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "70%",
      layout: { padding: 7 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#172033", padding: 12, cornerRadius: 10,
          callbacks: {
            label: ({ dataIndex }) => {
              const row = rows[dataIndex];
              const share = finiteMetric(row?.percentage);
              const patients = row?.count === 1 ? "patient" : "patients";
              return `${row?.label}: ${row?.count} ${patients}${share === null ? "" : ` (${share.toLocaleString(undefined, { maximumFractionDigits: 1 })}%)`}`;
            }
          }
        }
      }
    }
  };
}
