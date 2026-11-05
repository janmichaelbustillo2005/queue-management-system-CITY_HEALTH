import { serviceColor, serviceLabel } from "./analyticsCharts";

// Chart.js configurations for the Detailed Data charts. Each builder reads only the backend's
// `insights` payload and returns null when there is nothing to draw, so the page shows a message
// instead of an empty or invented chart.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OUTCOME_COLORS = { completed: "#16a34a", cancelled: "#dc2626", "no-show": "#be123c", waiting: "#f59e0b", serving: "#0ea5e9" };

const number = (value) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const minutesText = (value) => (value == null ? "no data" : `${number(value)} min`);

function dateLabel(date) {
  const [year, month, day] = String(date).split("-").map(Number);
  return day ? `${MONTHS[month - 1]} ${day}` : `${MONTHS[month - 1]} ${year}`;
}
export function periodLabel(period, grouping) {
  if (grouping === "week") return `Week of ${dateLabel(period)}`;
  return dateLabel(period);
}
const GROUPING_TITLES = { day: "Day", week: "Week (starting Monday)", month: "Month" };

const legend = { position: "bottom", labels: { boxWidth: 10, padding: 8, font: { size: 11 } } };
const tooltip = (callbacks) => ({ backgroundColor: "#172033", padding: 10, cornerRadius: 8, callbacks });
const axis = (title, extra = {}) => ({ title: { display: true, text: title, font: { size: 10 } }, ticks: { font: { size: 10 } }, ...extra });
const categoryAxis = (title) => axis(title, { grid: { display: false }, ticks: { font: { size: 10 }, autoSkip: true, maxRotation: 45 } });
const valueAxis = (title, extra = {}) => axis(title, { beginAtZero: true, ...extra });
const base = (extra = {}) => ({ responsive: true, maintainAspectRatio: false, ...extra });
const hasValue = (values) => values.some((value) => value != null && value > 0);

// Customer experience -------------------------------------------------------------------------

export function waitTrendChart(trends, brand) {
  if (!trends?.periods?.length || !hasValue(trends.wait.overall)) return null;
  const services = trends.wait.by_service.filter((row) => hasValue(row.values));
  const samplesOf = (dataset, index) => (dataset.samples ? dataset.samples[index] : 0);
  return {
    type: "line",
    data: {
      labels: trends.periods.map((period) => periodLabel(period, trends.grouping)),
      datasets: [
        { label: "All services", data: trends.wait.overall, samples: trends.wait.samples, borderColor: brand.forest, backgroundColor: brand.forest,
          borderWidth: 3, pointRadius: trends.periods.length > 45 ? 0 : 3, cubicInterpolationMode: "monotone" },
        ...(services.length > 1 ? services.map((row) => ({
          label: serviceLabel(row.service), data: row.values, samples: row.samples, borderColor: serviceColor(row.service),
          backgroundColor: serviceColor(row.service), borderWidth: 1.5, pointRadius: 2, cubicInterpolationMode: "monotone"
        })) : [])
      ]
    },
    options: base({
      interaction: { mode: "index", intersect: false },
      plugins: { legend, tooltip: tooltip({
        label: ({ dataset, raw, dataIndex }) => (raw == null ? `${dataset.label}: no patients`
          : `${dataset.label}: ${minutesText(raw)} average (${plural(samplesOf(dataset, dataIndex), "patient")})`)
      }) },
      scales: { x: categoryAxis(GROUPING_TITLES[trends.grouping]), y: valueAxis("Average wait (minutes)") }
    })
  };
}

function doughnut(rows, colorOf, unit) {
  const shown = rows.filter((row) => row.count > 0);
  if (!shown.length) return null;
  const total = shown.reduce((sum, row) => sum + row.count, 0);
  return {
    type: "doughnut",
    data: {
      labels: shown.map((row) => row.label),
      datasets: [{ label: unit, data: shown.map((row) => row.count), backgroundColor: shown.map(colorOf), borderColor: "#ffffff", borderWidth: 2, hoverOffset: 5 }]
    },
    options: base({
      cutout: "60%",
      plugins: { legend, tooltip: tooltip({
        label: ({ label, raw }) => `${label}: ${plural(raw, unit)} (${number((raw * 100) / total)}%)`
      }) }
    })
  };
}

// Staff and operational efficiency ------------------------------------------------------------

export function doctorPerformanceChart(volumes) {
  const rows = volumes || [];
  if (!rows.some((row) => row.total > 0)) return null;
  const series = [
    ["completed", "Completed", OUTCOME_COLORS.completed], ["cancelled", "Cancelled", OUTCOME_COLORS.cancelled],
    ["no_show", "No-show", OUTCOME_COLORS["no-show"]], ["in_queue", "Still in the queue", OUTCOME_COLORS.waiting]
  ];
  return {
    type: "bar",
    data: {
      labels: rows.map((row) => row.doctor),
      datasets: series.map(([key, label, color]) => ({ label, data: rows.map((row) => row[key]), backgroundColor: color, maxBarThickness: 48 }))
    },
    options: base({
      interaction: { mode: "index", intersect: false },
      plugins: { legend, tooltip: tooltip({
        label: ({ dataset, raw }) => `${dataset.label}: ${raw}`,
        footer: (items) => `Patients handled: ${rows[items[0].dataIndex].total}`
      }) },
      scales: { x: { stacked: true, ...categoryAxis("Doctor") }, y: valueAxis("Patients", { stacked: true, ticks: { precision: 0, font: { size: 10 } } }) }
    })
  };
}

// Traffic and flow ----------------------------------------------------------------------------

export function arrivalTrendChart(trends, brand) {
  if (!trends?.periods?.length || !hasValue(trends.arrivals.total)) return null;
  const services = trends.arrivals.by_service.filter((row) => hasValue(row.counts));
  return {
    type: "line",
    data: {
      labels: trends.periods.map((period) => periodLabel(period, trends.grouping)),
      datasets: [
        { label: "All patients", data: trends.arrivals.total, borderColor: brand.primary, backgroundColor: `${brand.primary}22`, fill: true,
          borderWidth: 3, pointRadius: trends.periods.length > 45 ? 0 : 3, cubicInterpolationMode: "monotone" },
        ...(services.length > 1 ? services.map((row) => ({
          label: serviceLabel(row.service), data: row.counts, borderColor: serviceColor(row.service), backgroundColor: serviceColor(row.service),
          borderWidth: 1.5, pointRadius: 2, cubicInterpolationMode: "monotone"
        })) : [])
      ]
    },
    options: base({
      interaction: { mode: "index", intersect: false },
      plugins: { legend, tooltip: tooltip({ label: ({ dataset, raw }) => `${dataset.label}: ${plural(raw, "patient")}` }) },
      scales: { x: categoryAxis(GROUPING_TITLES[trends.grouping]), y: valueAxis("Patients registered", { ticks: { precision: 0, font: { size: 10 } } }) }
    })
  };
}

// Weekly Queue Heatmap: arrivals per weekday in two-hour intervals from 8 AM to 6 PM. Arrivals
// outside those hours are not drawn; `outside` counts them so the page can say so. They stay in
// every other figure.
export const HEAT_COLORS = ["#dcfce7", "#a7e3b5", "#6cc287", "#2f9a55", "#14642f"];
const clock = (hour) => `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
const OPEN_INTERVALS = [8, 10, 12, 14, 16].map((from) => ({ from, to: from + 2, label: clock(from), range: `${clock(from)} – ${clock(from + 2)}` }));

export function weeklyHeatmap(peak) {
  const matrix = peak?.matrix || [];
  const hours = (peak?.hours || []).map((row) => row.hour);
  const countIn = (counts, from, to) => counts.reduce((sum, count, index) => sum + (hours[index] >= from && hours[index] < to ? count : 0), 0);
  const columns = OPEN_INTERVALS;
  const rows = matrix.map((row) => ({ weekday: row.weekday, cells: columns.map((column) => countIn(row.counts, column.from, column.to)) }));
  const max = Math.max(0, ...rows.flatMap((row) => row.cells));
  const total = rows.reduce((sum, row) => sum + row.cells.reduce((rowSum, count) => rowSum + count, 0), 0);
  const all = matrix.reduce((sum, row) => sum + row.counts.reduce((rowSum, count) => rowSum + count, 0), 0);
  return { columns, rows, max, total, outside: all - total };
}

// Five shades of green; an empty cell stays neutral.
export function heatColor(count, max) {
  if (!count || !max) return null;
  return HEAT_COLORS[Math.min(HEAT_COLORS.length - 1, Math.ceil((count / max) * HEAT_COLORS.length) - 1)];
}

// The Service Demand donut: the page draws the total in the centre and its own legend beside it.
export function demandChart(demand) {
  const config = doughnut((demand?.services || []).map((row) => ({ ...row, label: serviceLabel(row.service) })), (row) => serviceColor(row.service), "patient");
  if (!config) return null;
  config.options.cutout = "70%";
  config.options.plugins.legend = { display: false };
  return config;
}
