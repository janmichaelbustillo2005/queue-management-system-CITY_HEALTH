import { serviceColor, serviceLabel } from "./analyticsCharts";
import { FORMER_SERVICES, OFFERED_SERVICES, SERVICE_LABELS } from "./services";

// Chart.js configurations for the Detailed Data charts. Each builder reads only the backend's
// `insights` payload and returns null when there is nothing to draw, so the page shows a message
// instead of an empty or invented chart.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

// Average Wait Time Trend: a bold "All services" line over thin per-service lines, drawn with the
// same per-service look as the Patient Arrival Trend. The page draws the service legend itself (a
// toggleable grid below the chart), so the canvas legend is off. Hiding lines rescales the linear
// minutes axis to the lines still shown, so services with short waits can be read on their own;
// the axis itself is never transformed.
//
// A value is the payload's average for that period, or null when no patient was called in it:
// null stays a gap (never zero), and a lone value between gaps keeps a visible point.
export const WAIT_ALL = "__all__";
const WAIT_TOOLTIP_SERVICES = { wide: 6, narrow: 3 };
const measured = (samples) => (samples || []).some((count) => Number(count) > 0);
const waitServices = (trends) => (trends?.wait?.by_service || []).filter((row) => measured(row.samples));
const isolatedPoints = (values, radius) => values.map((value, index) => (value != null && values[index - 1] == null && values[index + 1] == null ? radius : 0));
const patientsMeasured = (count) => plural(Number(count) || 0, "patient");

// The visible service lines at one point: measured ones by longest wait first, then the rest.
function waitRanking(chart, dataIndex) {
  return chart.data.datasets
    .map((dataset, datasetIndex) => ({ dataset, datasetIndex, value: dataset.data[dataIndex] }))
    .filter((row) => row.dataset.service && chart.isDatasetVisible(row.datasetIndex))
    .sort((a, b) => (a.value == null) - (b.value == null) || (b.value ?? 0) - (a.value ?? 0));
}
const waitTooltipLimit = (chart) => (chart.width < 480 ? WAIT_TOOLTIP_SERVICES.narrow : WAIT_TOOLTIP_SERVICES.wide);

export function waitTrendChart(trends, brand) {
  if (!trends?.periods?.length || !measured(trends.wait?.samples)) return null;
  const services = waitServices(trends);
  const lines = services.length > 1 ? services : [];
  const many = trends.periods.length > 45;
  return {
    type: "line",
    data: {
      labels: trends.periods.map((period) => periodLabel(period, trends.grouping)),
      datasets: [
        { label: "All services", key: WAIT_ALL, data: trends.wait.overall, samples: trends.wait.samples, hue: brand.forest,
          borderColor: brand.forest, backgroundColor: brand.forest, borderWidth: 3,
          pointRadius: many ? isolatedPoints(trends.wait.overall, 3) : 3, pointHoverRadius: 5, pointBackgroundColor: brand.forest,
          pointBorderColor: "#ffffff", pointBorderWidth: 1.5, spanGaps: false, cubicInterpolationMode: "monotone", order: 0 },
        ...lines.map((row) => {
          const { hue, dash } = arrivalServiceStyle(row.service);
          return {
            label: serviceLabel(row.service), key: row.service, service: row.service, data: row.values, samples: row.samples, hue,
            borderColor: hue, backgroundColor: hue, borderDash: dash, borderWidth: SERVICE_LINE, pointRadius: isolatedPoints(row.values, 2.5),
            pointHoverRadius: 4, pointHitRadius: 6, spanGaps: false, cubicInterpolationMode: "monotone", order: 1
          };
        })
      ]
    },
    options: base({
      layout: { padding: { top: 8, right: 8 } },
      interaction: { mode: "index", intersect: false, axis: "x" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip({
            title: (items) => (items.length ? arrivalPeriodTitle(trends.periods[items[0].dataIndex], trends.grouping) : ""),
            label: ({ dataset, raw, dataIndex }) => {
              const count = dataset.samples?.[dataIndex];
              if (!dataset.service) return raw == null ? "All services: no patients called" : `All services: ${minutesText(raw)} average (${patientsMeasured(count)})`;
              return `${dataset.label}: ${minutesText(raw)} (${patientsMeasured(count)})`;
            },
            afterLabel: ({ dataset, chart, dataIndex }) => (!dataset.service && waitRanking(chart, dataIndex).some((row) => row.value != null)
              ? "By service, longest wait first:" : ""),
            labelColor: ({ dataset }) => ({ borderColor: dataset.hue, backgroundColor: dataset.hue }),
            footer: (items) => {
              if (!items.length) return [];
              const { chart, dataIndex } = items[0];
              const ranking = waitRanking(chart, dataIndex);
              const withData = ranking.filter((row) => row.value != null);
              const rest = withData.length - Math.min(withData.length, waitTooltipLimit(chart));
              const idle = ranking.length - withData.length;
              const hidden = chart.data.datasets.filter((dataset, index) => dataset.service && !chart.isDatasetVisible(index)).length;
              const lines = [];
              if (rest) lines.push(`+ ${plural(rest, "more service")} with shorter waits`);
              if (idle) lines.push(`${plural(idle, "service")} with no patients called`);
              if (hidden) lines.push(`${plural(hidden, "hidden service")} not listed`);
              if (lines.length) lines.push("Full breakdown in the list below");
              return lines;
            }
          }),
          // All services always shows; a service shows only with a measured wait, the longest few first.
          filter: (item) => {
            if (!item.dataset.service) return true;
            if (item.raw == null) return false;
            return waitRanking(item.chart, item.dataIndex).slice(0, waitTooltipLimit(item.chart))
              .some((row) => row.datasetIndex === item.datasetIndex);
          },
          itemSort: (a, b) => (a.dataset.service ? 1 : 0) - (b.dataset.service ? 1 : 0) || (b.raw ?? 0) - (a.raw ?? 0),
          padding: 12, caretPadding: 8, usePointStyle: true, boxWidth: 8, boxHeight: 8, boxPadding: 4,
          titleFont: { size: 13, weight: "bold" }, titleMarginBottom: 8, bodyFont: { size: 12 }, bodySpacing: 3,
          footerFont: { size: 11, weight: "normal" }, footerColor: "#cbd5e1", footerMarginTop: 8
        }
      },
      scales: {
        x: { ...categoryAxis(GROUPING_TITLES[trends.grouping]), ticks: { font: { size: 11 }, autoSkip: true, autoSkipPadding: 14, maxRotation: 0 } },
        y: valueAxis("Average wait (minutes)", { grace: "8%", grid: { color: "#e5ece8" }, border: { display: false },
          ticks: { padding: 6, font: { size: 11 } } })
      }
    })
  };
}

// The service list below the wait chart: every measured service with its average and patient count,
// for the whole period or for one period when `index` is set. Values are the payload's, unchanged.
// For the whole period, a service's average is the backend's exact figure for that service
// (`insights.wait.by_service`, the Avg Wait card's rule) when it covers the same patients as the
// trend; otherwise it is left out rather than re-averaged from rounded period values.
export function waitBreakdown(trends, waitStats, index = null) {
  const periods = trends?.periods || [];
  const at = Number.isInteger(index) && index >= 0 && index < periods.length ? index : null;
  const stats = new Map((waitStats?.by_service || []).map((row) => [row.key, row]));
  const rows = waitServices(trends).map((row) => {
    const periodSamples = sumOf(row.samples);
    const exact = stats.get(row.service);
    const wholeAverage = exact && exact.samples === periodSamples ? exact.avg : null;
    return {
      service: row.service, label: serviceLabel(row.service), ...arrivalServiceStyle(row.service), periodSamples,
      minutes: at == null ? wholeAverage : row.values[at] ?? null,
      samples: at == null ? periodSamples : Number(row.samples[at]) || 0
    };
  }).sort((a, b) => b.periodSamples - a.periodSamples);
  const overall = trends?.wait?.overall || [];
  const samples = trends?.wait?.samples || [];
  return {
    period: at,
    title: at == null ? "Selected period" : arrivalPeriodTitle(periods[at], trends.grouping),
    minutes: at == null ? null : overall[at] ?? null,
    samples: at == null ? sumOf(samples) : Number(samples[at]) || 0,
    rows,
    withData: rows.filter((row) => row.minutes != null).length,
    toggleable: rows.length > 1
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

// Doctor Performance Comparison. The backend groups visits with no doctor recorded on them under
// "Unassigned"; that group is kept out of the doctor bars (it would set the scale and flatten them)
// and shown beside the chart with its own counts, so every record is still accounted for.
//
// Outcome colours, validated with the dataviz palette checker in stacking order: green, light red,
// violet, amber. The previous cancelled red and no-show rose were too close to tell apart.
export const UNASSIGNED_DOCTOR = "Unassigned";
export const DOCTOR_OUTCOMES = [
  { key: "completed", label: "Completed", color: "#15803d" },
  { key: "cancelled", label: "Cancelled", color: "#f87171" },
  { key: "no_show", label: "No-show", color: "#6d28d9" },
  { key: "in_queue", label: "Still in the queue", color: "#f59e0b" }
];
const DOCTOR_ROW_PX = 40;
const DOCTOR_AXIS_PX = 64;
const DOCTOR_LABEL_CHARS = 20;
const shortName = (name) => (name.length > DOCTOR_LABEL_CHARS ? `${name.slice(0, DOCTOR_LABEL_CHARS - 1)}…` : name);

// Doctors, the Unassigned group and outcome totals, all straight from the payload's counts.
export function doctorPerformance(volumes) {
  const rows = (volumes || []).filter((row) => row.total > 0);
  const doctors = rows.filter((row) => row.doctor !== UNASSIGNED_DOCTOR);
  const unassigned = rows.find((row) => row.doctor === UNASSIGNED_DOCTOR) || null;
  const outcomeTotals = DOCTOR_OUTCOMES.map((outcome) => ({ ...outcome, count: sumOf(doctors.map((row) => row[outcome.key])) }));
  const doctorTotal = sumOf(doctors.map((row) => row.total));
  return {
    doctors, unassigned, outcomeTotals, doctorTotal,
    total: doctorTotal + (unassigned ? unassigned.total : 0),
    // Canvas height: one row per doctor plus the axis, so bars keep their thickness with any count.
    height: Math.max(170, doctors.length * DOCTOR_ROW_PX + DOCTOR_AXIS_PX)
  };
}

// Each bar's total of its shown outcomes, written just past its end.
const barTotals = {
  id: "doctorBarTotals",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const ends = new Map();
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      chart.getDatasetMeta(datasetIndex).data.forEach((bar, index) => {
        const end = ends.get(index) || { x: -Infinity, y: bar.y, sum: 0 };
        end.sum += Number(dataset.data[index]) || 0;
        end.x = Math.max(end.x, bar.x);
        ends.set(index, end);
      });
    });
    ctx.save();
    ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "#334155";
    ctx.textBaseline = "middle";
    ends.forEach((end) => { if (end.sum > 0) ctx.fillText(String(end.sum), end.x + 6, end.y); });
    ctx.restore();
  }
};

export function doctorPerformanceChart(volumes) {
  const { doctors } = doctorPerformance(volumes);
  if (!doctors.length) return null;
  return {
    type: "bar",
    data: {
      labels: doctors.map((row) => row.doctor),
      datasets: DOCTOR_OUTCOMES.map((outcome) => ({
        label: outcome.label, outcome: outcome.key, data: doctors.map((row) => row[outcome.key]), backgroundColor: outcome.color,
        // A 2px white gap between stacked segments keeps small segments visible as their own block.
        borderColor: "#ffffff", borderWidth: { top: 0, bottom: 0, left: 0, right: 2 }, borderSkipped: false,
        barPercentage: 0.75, categoryPercentage: 0.85, maxBarThickness: 26
      }))
    },
    plugins: [barTotals],
    options: base({
      indexAxis: "y",
      layout: { padding: { right: 34, top: 4 } },
      interaction: { mode: "index", axis: "y", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip({
            title: (items) => (items.length ? doctors[items[0].dataIndex].doctor : ""),
            label: ({ dataset, raw }) => `${dataset.label}: ${raw}`,
            footer: (items) => {
              if (!items.length) return [];
              const { chart, dataIndex } = items[0];
              const hidden = chart.data.datasets.filter((dataset, index) => !chart.isDatasetVisible(index)).length;
              return [`Total: ${plural(doctors[dataIndex].total, "patient")}`, ...(hidden ? [`${plural(hidden, "hidden outcome")} not listed`] : [])];
            }
          }),
          padding: 12, caretPadding: 6, boxWidth: 10, boxHeight: 10, boxPadding: 4,
          titleFont: { size: 13, weight: "bold" }, titleMarginBottom: 8, bodyFont: { size: 12 }, bodySpacing: 3,
          footerFont: { size: 12, weight: "bold" }, footerMarginTop: 8
        }
      },
      scales: {
        x: valueAxis("Patients", { stacked: true, grid: { color: "#e5ece8" }, border: { display: false },
          ticks: { precision: 0, font: { size: 11 } } }),
        y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 },
          callback(value) { return shortName(String(this.getLabelForValue(value))); } } }
      }
    })
  };
}

// Traffic and flow ----------------------------------------------------------------------------

// Patient Arrival Trend: one bold "All patients" line over thin per-service lines. The page draws
// the service legend itself (a grid below the chart), so the canvas legend is off.
//
// Each service keeps one look whatever the filters show: eight validated hues, and past eight a
// service reuses a hue with a dashed, then a dotted line, so no two services look alike.
const TREND_HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const TREND_DASHES = [[], [6, 4], [2, 3]];
const TREND_SERVICE_ORDER = [...new Set([...OFFERED_SERVICES, ...FORMER_SERVICES].map((row) => row.value).concat(Object.keys(SERVICE_LABELS)))];
const TREND_SLOTS = TREND_HUES.length * TREND_DASHES.length;
const SERVICE_LINE = 1.75;
const TOOLTIP_SERVICES = { wide: 5, narrow: 3 };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function arrivalServiceStyle(service) {
  let slot = TREND_SERVICE_ORDER.indexOf(service);
  if (slot < 0) slot = [...String(service)].reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) % TREND_SLOTS, 7);
  slot %= TREND_SLOTS;
  return { hue: TREND_HUES[slot % TREND_HUES.length], dash: TREND_DASHES[Math.floor(slot / TREND_HUES.length)] };
}

// The tooltip and breakdown heading: "Wed, Nov 12, 2026", "Week of Nov 10, 2026" or "November 2026".
export function arrivalPeriodTitle(period, grouping) {
  const [year, month, day] = String(period).split("-").map(Number);
  if (!day) return `${MONTH_NAMES[month - 1]} ${year}`;
  const date = `${MONTHS[month - 1]} ${day}, ${year}`;
  if (grouping === "week") return `Week of ${date}`;
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}, ${date}`;
}

const sumOf = (values) => values.reduce((sum, value) => sum + (Number(value) || 0), 0);
const trendServices = (trends) => (trends?.arrivals?.by_service || []).filter((row) => hasValue(row.counts));

// The visible service lines at one point, most patients first (ties keep the legend order).
function serviceRanking(chart, dataIndex) {
  return chart.data.datasets
    .map((dataset, datasetIndex) => ({ dataset, datasetIndex, value: Number(dataset.data[dataIndex]) || 0 }))
    .filter((row) => row.dataset.service && chart.isDatasetVisible(row.datasetIndex))
    .sort((a, b) => b.value - a.value);
}
const tooltipLimit = (chart) => (chart.width < 480 ? TOOLTIP_SERVICES.narrow : TOOLTIP_SERVICES.wide);

export function arrivalTrendChart(trends, brand) {
  if (!trends?.periods?.length || !hasValue(trends.arrivals.total)) return null;
  const services = trendServices(trends);
  const lines = services.length > 1 ? services : [];
  const many = trends.periods.length > 45;
  return {
    type: "line",
    data: {
      labels: trends.periods.map((period) => periodLabel(period, trends.grouping)),
      datasets: [
        { label: "All patients", data: trends.arrivals.total, hue: brand.forest, borderColor: brand.forest, backgroundColor: `${brand.primary}1f`,
          fill: "origin", borderWidth: 3, pointRadius: many ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: brand.forest,
          pointBorderColor: "#ffffff", pointBorderWidth: 1.5, cubicInterpolationMode: "monotone", order: 0 },
        ...lines.map((row) => {
          const { hue, dash } = arrivalServiceStyle(row.service);
          return {
            label: serviceLabel(row.service), service: row.service, data: row.counts, hue, borderColor: hue, backgroundColor: hue,
            borderDash: dash, borderWidth: SERVICE_LINE, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 6,
            cubicInterpolationMode: "monotone", order: 1
          };
        })
      ]
    },
    options: base({
      layout: { padding: { top: 8, right: 8 } },
      interaction: { mode: "index", intersect: false, axis: "x" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip({
            title: (items) => (items.length ? arrivalPeriodTitle(trends.periods[items[0].dataIndex], trends.grouping) : ""),
            label: ({ dataset, raw }) => (dataset.service ? `${dataset.label}: ${raw}` : `Total: ${plural(raw, "patient")}`),
            afterLabel: ({ dataset, chart, dataIndex }) => (!dataset.service && serviceRanking(chart, dataIndex).some((row) => row.value > 0)
              ? "By service, most first:" : ""),
            labelColor: ({ dataset }) => ({ borderColor: dataset.hue, backgroundColor: dataset.hue }),
            footer: (items) => {
              if (!items.length) return [];
              const { chart, dataIndex } = items[0];
              const ranking = serviceRanking(chart, dataIndex);
              const busy = ranking.filter((row) => row.value > 0);
              const rest = busy.slice(tooltipLimit(chart));
              const idle = ranking.length - busy.length;
              const hidden = chart.data.datasets.filter((dataset, index) => dataset.service && !chart.isDatasetVisible(index)).length;
              const lines = [];
              if (rest.length) lines.push(`+ ${plural(rest.length, "more service")} (${plural(sumOf(rest.map((row) => row.value)), "patient")})`);
              if (idle) lines.push(`${plural(idle, "service")} with no arrivals`);
              if (hidden) lines.push(`${plural(hidden, "hidden service")} not listed`);
              if (lines.length) lines.push("Full breakdown in the list below");
              return lines;
            }
          }),
          // The total always shows; services show only with arrivals, the busiest few, most first.
          filter: (item) => {
            if (!item.dataset.service) return true;
            if (!item.raw) return false;
            return serviceRanking(item.chart, item.dataIndex).slice(0, tooltipLimit(item.chart))
              .some((row) => row.datasetIndex === item.datasetIndex);
          },
          itemSort: (a, b) => (a.dataset.service ? 1 : 0) - (b.dataset.service ? 1 : 0) || b.raw - a.raw,
          padding: 12, caretPadding: 8, usePointStyle: true, boxWidth: 8, boxHeight: 8, boxPadding: 4,
          titleFont: { size: 13, weight: "bold" }, titleMarginBottom: 8, bodyFont: { size: 12 }, bodySpacing: 3,
          footerFont: { size: 11, weight: "normal" }, footerColor: "#cbd5e1", footerMarginTop: 8
        }
      },
      scales: {
        x: { ...categoryAxis(GROUPING_TITLES[trends.grouping]), ticks: { font: { size: 11 }, autoSkip: true, autoSkipPadding: 14, maxRotation: 0 } },
        y: valueAxis("Patients registered", { grace: "8%", grid: { color: "#e5ece8" }, border: { display: false },
          ticks: { precision: 0, padding: 6, font: { size: 11 } } })
      }
    })
  };
}

// The breakdown below the chart: every service with its count for the whole period, or for one
// period when `index` is set. Rows keep one order (most patients over the whole period first) so
// the list does not jump while the pointer moves; counts are the payload's, unchanged.
export function arrivalBreakdown(trends, index = null) {
  const periods = trends?.periods || [];
  const at = Number.isInteger(index) && index >= 0 && index < periods.length ? index : null;
  const services = trendServices(trends);
  const rows = services.map((row) => ({
    service: row.service, label: serviceLabel(row.service), ...arrivalServiceStyle(row.service),
    periodTotal: sumOf(row.counts), count: at == null ? sumOf(row.counts) : Number(row.counts[at]) || 0
  })).sort((a, b) => b.periodTotal - a.periodTotal);
  const totals = trends?.arrivals?.total || [];
  return {
    period: at,
    title: at == null ? "Selected period" : arrivalPeriodTitle(periods[at], trends.grouping),
    total: at == null ? sumOf(totals) : Number(totals[at]) || 0,
    rows,
    withArrivals: rows.filter((row) => row.count > 0).length,
    toggleable: services.length > 1
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
