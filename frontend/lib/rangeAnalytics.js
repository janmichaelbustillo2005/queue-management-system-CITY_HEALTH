// Shared, side-effect-free helpers for the Superadmin Trends Analytics and Status Analytics tabs:
// date-range filters, labels, Chart.js configurations and the records-table helpers.
// Every number comes from the backend (GET /analytics/trends, /analytics/status/*); nothing here
// invents a value. Unknown values stay null and are shown as "No data available".
import { serviceName } from "./services";

export const COLORS = {
  arrivals: "#3B82F6", completed: "#16A34A", waiting: "#F59E0B", serving: "#3B82F6", cancelled: "#EF4444", records: "#7C3AED",
  other: "#94A3B8", green: "#00884A", greenFill: "rgba(0, 136, 74, 0.12)", ink: "#142238", muted: "#64748B", grid: "#EEF2F6"
};
// Doctor 1–3: dark, medium and light green (fixed by doctor, never by rank). The light greens have a
// darker outline, and doctors are always named in the legend and tooltips, never by colour alone.
export const DOCTOR_COLORS = ["#00843D", "#4ADE80", "#86EFAC", "#0D9488", "#84CC16"];
export const DOCTOR_BORDERS = ["#00843D", "#22C55E", "#4ADE80", "#0D9488", "#4D7C0F"];
// Visits by Doctor (Status): one bar per doctor, again fixed by doctor.
export const DOCTOR_BAR_COLORS = ["#00843D", "#22C55E", "#4ADE80", "#0D9488", "#84CC16"];
// Ranked bars (services): dark green for the largest, lightening down the list.
export const GREEN_SHADES = ["#00843D", "#0E9645", "#16A34A", "#22C55E", "#4ADE80", "#6EE7A0", "#86EFAC"];
export function rankShade(index, count) {
  if (count <= 1) return GREEN_SHADES[0];
  return GREEN_SHADES[Math.round(Math.min(index, count - 1) * (GREEN_SHADES.length - 1) / (count - 1))];
}

export const STATUS_META = {
  completed: { label: "Completed", color: COLORS.completed, icon: "fas fa-check-circle" },
  waiting: { label: "Waiting", color: COLORS.waiting, icon: "fas fa-hourglass-half" },
  serving: { label: "Serving", color: COLORS.serving, icon: "fas fa-user-md" },
  cancelled: { label: "Cancelled", color: COLORS.cancelled, icon: "fas fa-times-circle" }
};
export function statusMeta(status) {
  return STATUS_META[status] || {
    label: String(status || "unknown").replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    color: COLORS.other, icon: "fas fa-circle"
  };
}

export const RANGE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "12m", label: "Last 12 Months" },
  { value: "custom", label: "Custom Range" }
];
export const MAX_RANGE_DAYS = 366;
export const REFRESH_INTERVAL_MS = 15000;
export const REQUEST_TIMEOUT_MS = 10000;
export const CLINIC_START_HOUR = 8;
export const CLINIC_END_HOUR = 17;

export const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const MANILA = "Asia/Manila";

export function manilaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: MANILA, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(Date.parse(`${value}T00:00:00+08:00`)) &&
  manilaToday(new Date(`${value}T00:00:00+08:00`)) === value;
const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");

export function defaultDraft(now = new Date()) {
  const today = manilaToday(now);
  return { range: "today", startDate: today, endDate: today, startTime: "", endTime: "" };
}

// The validated query for a draft filter. Throws an Error whose message is shown beside the filters.
export function makeRangeQuery(draft = {}) {
  const range = draft.range;
  if (!RANGE_OPTIONS.some((option) => option.value === range)) throw new Error("Choose a date range.");
  if (range !== "custom") return { range };
  const { startDate, endDate } = draft;
  if (!validDate(startDate) || !validDate(endDate)) throw new Error("Choose a valid start and end date.");
  if (startDate > endDate) throw new Error("The start date must be on or before the end date.");
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error(`Choose a range of at most ${MAX_RANGE_DAYS} days.`);
  const startTime = draft.startTime || "", endTime = draft.endTime || "";
  if (!startTime && !endTime) return { range, startDate, endDate };
  if (startDate !== endDate) throw new Error("Hours can only be set when the start and end date are the same day.");
  if (!validTime(startTime) || !validTime(endTime)) throw new Error("Choose both a start and an end time, or clear both.");
  if (startTime === endTime) throw new Error("The start and end times must differ.");
  return { range, startDate, endDate, startTime, endTime };
}

export const queryString = (query) => new URLSearchParams(Object.entries(query).filter(([, value]) => value)).toString();

// The backend echoes the period it computed; a result for another filter is never shown.
export function samePeriod(period, query) {
  if (!period || period.range !== query.range) return false;
  if (query.range !== "custom") return true;
  return period.start_date === query.startDate && period.end_date === query.endDate &&
    (!query.startTime || (period.start_time === query.startTime && period.end_time === query.endTime));
}

const isTimestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isList = (value) => Array.isArray(value) && value.every((row) => row && typeof row === "object" && !Array.isArray(row));
const isMetric = (value) => value && (value.value === null || finite(value.value) !== null);
const isBreakdown = (value) => value && (finite(value.total) !== null) && isList(value.statuses) &&
  value.statuses.every((row) => typeof row.status === "string" && finite(row.count) !== null) &&
  value.statuses.reduce((sum, row) => sum + row.count, 0) === value.total;

export function isTrendsData(data, query) {
  return Boolean(data && data.time_zone === MANILA && isTimestamp(data.observed_at) && samePeriod(data.period, query) &&
    isTimestamp(data.period.start_at) && isTimestamp(data.period.end_at) &&
    ["total_visits", "completed", "avg_wait_minutes", "avg_service_minutes"].every((key) => isMetric(data.kpis?.[key])) &&
    (data.kpis.new_patient_records === undefined || isMetric(data.kpis.new_patient_records)) &&
    isList(data.buckets) && data.buckets.every((row) => isTimestamp(row.start_at)) && isBreakdown(data.outcome) &&
    isList(data.services) && isList(data.workload?.groups) && Array.isArray(data.workload?.doctors));
}

export function isStatusOverviewData(data, query, filters) {
  return Boolean(data && data.time_zone === MANILA && isTimestamp(data.observed_at) && samePeriod(data.period, query) &&
    ["service", "status"].every((key) => (data.filters?.[key] || "") === (filters[key] || "")) &&
    isBreakdown(data.cohort) && isList(data.by_doctor?.doctors) && finite(data.by_doctor?.unassigned) !== null &&
    isList(data.by_service) && isList(data.completion_trend) && data.times && typeof data.times === "object");
}

// ---- Words and labels --------------------------------------------------------------------------

export const formatNumber = (value, decimals = 0) => finite(value) === null ? "No data available"
  : value.toLocaleString("en-PH", { maximumFractionDigits: decimals });
export const formatMinutes = (value) => finite(value) === null ? "No data available" : `${formatNumber(value, 1)} min`;
export const formatPercent = (value) => finite(value) === null ? "—" : `${formatNumber(value, 1)}%`;
export const plural = (count, word, many = `${word}s`) => `${formatNumber(count)} ${count === 1 ? word : many}`;

const formatter = (options) => new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, ...options });
const DAY_LABEL = formatter({ month: "short", day: "numeric" });
const DAY_FULL = formatter({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const DATE_YEAR = formatter({ month: "short", day: "numeric", year: "numeric" });
const MONTH_LABEL = formatter({ month: "short", year: "numeric" });
const MONTH_FULL = formatter({ month: "long", year: "numeric" });
const TIME = formatter({ hour: "numeric", minute: "2-digit" });
const DATE_TIME = formatter({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const midnightOf = (date) => new Date(`${date}T00:00:00+08:00`);

export function readableDateTime(value) {
  return isTimestamp(value) ? DATE_TIME.format(new Date(value)) : "";
}
export function readableTime(value) {
  return isTimestamp(value) ? TIME.format(new Date(value)) : "";
}
export function readableDate(date) {
  return validDate(date) ? DATE_YEAR.format(midnightOf(date)) : "";
}

function clockLabel(iso) {
  const time = new Date(iso);
  const minutes = time.getUTCMinutes();
  const hour = (time.getUTCHours() + 8) % 24;
  return `${hour % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

// A month interval that does not cover the whole calendar month (the first or last of a range).
function partialMonth(start, end) {
  if (!validDate(start) || !validDate(end || "")) return false;
  const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86400000).toISOString().slice(8, 10);
  return start.slice(8) !== "01" || next !== "01";
}

// Axis label for one interval: "8 AM" for an hour (marked "+1d" past midnight), "Nov 12" for a day,
// "Nov 2026" for a month.
export function bucketLabel(bucket, period) {
  if (period?.granularity === "hour") return `${clockLabel(bucket.start_at)}${bucket.date !== period.start_date ? " +1d" : ""}`;
  if (period?.granularity === "month") return MONTH_LABEL.format(midnightOf(bucket.date));
  return DAY_LABEL.format(midnightOf(bucket.date));
}
export function bucketTitle(bucket, period) {
  if (period?.granularity === "hour") return `${clockLabel(bucket.start_at)} – ${clockLabel(bucket.end_at)}, ${DAY_LABEL.format(midnightOf(bucket.date))}`;
  if (period?.granularity === "month") {
    const month = MONTH_FULL.format(midnightOf(bucket.date));
    return partialMonth(bucket.date, bucket.end_date)
      ? `${month} (${DAY_LABEL.format(midnightOf(bucket.date))}–${DAY_LABEL.format(midnightOf(bucket.end_date)).split(" ")[1]})` : month;
  }
  return DAY_FULL.format(midnightOf(bucket.date));
}
export function groupLabel(group, period) {
  if (period?.granularity === "hour") return clockLabel(group.start_at);
  if (period?.granularity === "month") return MONTH_LABEL.format(midnightOf(group.start_date));
  if (group.start_date === group.end_date) return DAY_LABEL.format(midnightOf(group.start_date));
  const first = DAY_LABEL.format(midnightOf(group.start_date)), last = DAY_LABEL.format(midnightOf(group.end_date));
  return first.split(" ")[0] === last.split(" ")[0] ? `${first}–${last.split(" ")[1]}` : `${first}–${last}`;
}

export function describePeriod(period) {
  if (!period) return "";
  if (period.days === 1) {
    const hours = period.time_window ? `${period.start_time}–${period.end_time}` : "Full day";
    return `${DAY_FULL.format(midnightOf(period.start_date))} · ${hours}`;
  }
  return `${DATE_YEAR.format(midnightOf(period.start_date))} – ${DATE_YEAR.format(midnightOf(period.end_date))} · ${period.days} days`;
}

// Who the counted visits belong to (`patients` from the backend, the same calculation on both tabs):
// visits linked to a patient record, the distinct registered patients behind them, and visits with
// no linked record, which are never matched to a patient. "" when the links are unavailable.
export function patientLinksText(patients) {
  const visits = finite(patients?.visits), linked = finite(patients?.linked_visits);
  const distinct = finite(patients?.distinct_patients), unlinked = finite(patients?.unlinked_visits);
  if (!visits || linked === null || distinct === null || unlinked === null) return "";
  const have = (count) => count === 1 ? "has" : "have";
  const parts = [linked
    ? `${plural(linked, "visit")} ${linked === 1 ? "is" : "are"} linked to ${plural(distinct, "registered patient")} in Patient Records`
    : "No visit is linked to a registered patient in Patient Records"];
  if (unlinked) parts.push(`${plural(unlinked, "visit")} ${have(unlinked)} no linked patient record and ${unlinked === 1 ? "is" : "are"} counted as ${unlinked === 1 ? "a visit" : "visits"} only`);
  return `Of the ${plural(visits, "visit")} counted: ${parts.join("; ")}.`;
}

export function rangeName(query) {
  return RANGE_OPTIONS.find((option) => option.value === query?.range)?.label || "";
}

// "▲ 12.5% vs previous 7 days". Direction only: whether a change is good depends on context
// (more visits, a longer consultation), so no change is coloured as good or bad.
export function comparison(metric, label) {
  if (finite(metric?.value) === null) return { text: "No data available", direction: null };
  if (finite(metric?.previous) === null || !Number.isFinite(metric?.change_percent)) {
    return { text: metric?.previous === 0 && metric.value > 0 ? "No comparison available (none in the previous period)" : "No comparison available", direction: null };
  }
  if (metric.change_percent === 0) return { text: `No change ${label}`, direction: "flat" };
  return {
    text: `${formatNumber(Math.abs(metric.change_percent), 1)}% ${label}`,
    direction: metric.change_percent > 0 ? "up" : "down"
  };
}

// ---- Clinic-hours window --------------------------------------------------------------------------

function hasActivity(bucket) {
  const positive = (value) => finite(value) !== null && value > 0;
  return ["arrivals", "completed", "cancelled", "waiting", "new_patient_records", "wait_samples", "service_samples"].some((field) => positive(bucket[field])) ||
    (!bucket.future && bucket.waiting === null && "waiting" in bucket);
}

// A full single day shows clinic hours (8 AM–5 PM), widened to every hour with activity, so no
// record is ever hidden. Multi-day ranges and custom hours are shown whole.
export function visibleBuckets(buckets, period, mode = "clinic") {
  const rows = buckets || [];
  if (mode !== "clinic" || period?.granularity !== "hour" || period?.time_window) return { rows, trimmed: false };
  let first = CLINIC_START_HOUR, last = CLINIC_END_HOUR - 1;
  rows.forEach((row) => {
    if (row.hour == null || !hasActivity(row)) return;
    first = Math.min(first, row.hour);
    last = Math.max(last, row.hour);
  });
  const shown = rows.filter((row) => row.hour == null || (row.hour >= first && row.hour <= last));
  return { rows: shown, trimmed: shown.length < rows.length, first, last: last + 1 };
}
export function windowText(window) {
  if (!window?.trimmed) return "";
  const hour = (value) => `${value % 12 || 12} ${value < 12 || value === 24 ? "AM" : "PM"}`;
  return `${hour(window.first)} – ${hour(window.last)}`;
}

// ---- Chart.js configurations ------------------------------------------------------------------

const TOOLTIP = { backgroundColor: "#142238", titleColor: "#fff", bodyColor: "#E2E8F0", padding: 10, cornerRadius: 8, boxPadding: 4,
  titleFont: { size: 12, weight: "600" }, bodyFont: { size: 12 } };
const TICKS = { color: COLORS.muted, font: { size: 11 } };

function cartesian({ yTitle, integer = true, horizontal = false, xTitle = "" } = {}) {
  const value = {
    beginAtZero: true, border: { display: false }, grid: { color: COLORS.grid },
    title: { display: Boolean(yTitle), text: yTitle, color: COLORS.muted, font: { size: 11 } },
    ticks: { ...TICKS, ...(integer ? { precision: 0 } : {}) }
  };
  const category = {
    grid: { display: false }, border: { color: "#E2E8F0" },
    title: { display: Boolean(xTitle), text: xTitle, color: COLORS.muted, font: { size: 11 } },
    ticks: { ...TICKS, maxRotation: 0, autoSkip: true, autoSkipPadding: 10 }
  };
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: horizontal ? { mode: "nearest", axis: "y", intersect: false } : { mode: "index", intersect: false },
    layout: { padding: { top: 18, right: horizontal ? 34 : 8 } },
    plugins: { legend: { display: false }, tooltip: { ...TOOLTIP } },
    ...(horizontal ? { indexAxis: "y" } : {}),
    scales: horizontal ? { x: value, y: category } : { x: category, y: value }
  };
}

// Draws each bar's exact count at its end, in text ink (not the bar colour). Options
// (options.plugins.qmsValueLabels): skipZero leaves empty bars unlabelled; bars thinner than
// minSize pixels are left unlabelled so crowded groups stay readable (the tooltip still has them).
export const valueLabels = {
  id: "qmsValueLabels",
  defaults: { skipZero: false, minSize: 0 },
  afterDatasetsDraw(chart, _args, options = {}) {
    const { ctx } = chart, horizontal = chart.options.indexAxis === "y";
    ctx.save();
    ctx.font = "700 11px Arial, Helvetica, sans-serif";
    ctx.fillStyle = COLORS.ink;
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden) return;
      meta.data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (finite(value) === null || (options.skipZero && value === 0)) return;
        const size = horizontal ? bar.height : bar.width;
        if (options.minSize && Number.isFinite(size) && size < options.minSize) return;
        ctx.textAlign = horizontal ? "left" : "center";
        ctx.textBaseline = horizontal ? "middle" : "bottom";
        ctx.fillText(formatNumber(value), horizontal ? bar.x + 6 : bar.x, horizontal ? bar.y : bar.y - 4);
      });
    });
    ctx.restore();
  }
};

// Writes each point's value just above it (Completion Trend). Unknown points get no label.
export const pointLabels = {
  id: "qmsPointLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "700 11px Arial, Helvetica, sans-serif";
    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden) return;
      meta.data.forEach((point, index) => {
        const value = dataset.data[index];
        if (finite(value) === null) return;
        ctx.fillText(formatNumber(value), point.x, point.y - 7);
      });
    });
    ctx.restore();
  }
};

// A soft vertical gradient under a line: the series colour at the top fading to clear.
function areaGradient(color, strength = 0.18) {
  return (context) => {
    const { chart } = context;
    const area = chart.chartArea;
    const rgb = color.replace("#", "").match(/../g).map((hex) => parseInt(hex, 16)).join(", ");
    if (!area) return `rgba(${rgb}, ${strength / 2})`;
    const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    gradient.addColorStop(0, `rgba(${rgb}, ${strength})`);
    gradient.addColorStop(1, `rgba(${rgb}, 0.01)`);
    return gradient;
  };
}

// Long service names wrap onto two lines instead of being cut off.
export function wrapLabel(text, width = 22) {
  const words = String(text).split(" "), lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && `${last} ${word}`.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length > 1 ? lines : lines[0] || "";
}

function missing(bucket, field) {
  if (bucket?.future) return "No data available (not reached yet)";
  return field === "waiting" ? "No data available (cannot be reconstructed)" : "No data available";
}

// Arrivals are drawn widest and underneath (higher `order` draws first), so a series with the
// same values, e.g. every arrival completed the same day, stays visible on top of it. Waiting is a
// snapshot (patients still waiting at the end of each interval), not an event count, so it is dashed.
// New patient records are not drawn here; they are in the KPI card and the Trend Records table.
export const ACTIVITY_SERIES = [
  { field: "arrivals", label: "Patient Arrivals", color: COLORS.arrivals, width: 3, order: 4, fill: true },
  { field: "completed", label: "Completed", color: COLORS.completed, width: 2, order: 3, fill: true },
  { field: "waiting", label: "Waiting (at interval end)", color: COLORS.waiting, dashed: true, width: 2, order: 1 },
  { field: "cancelled", label: "Cancelled", color: COLORS.cancelled, width: 2, order: 2 }
];

export function buildActivityChart(rows, period) {
  const options = cartesian({ yTitle: "Number of Visits" });
  options.plugins.tooltip.callbacks = {
    title: (items) => items.length ? bucketTitle(rows[items[0].dataIndex], period) : "",
    label: ({ dataset, raw, dataIndex }) => `${dataset.label}: ${finite(raw) === null ? missing(rows[dataIndex], dataset.field) : formatNumber(raw)}`
  };
  return {
    type: "line",
    data: {
      labels: rows.map((row) => bucketLabel(row, period)),
      datasets: ACTIVITY_SERIES.map((series) => ({
        label: series.label, field: series.field, data: rows.map((row) => finite(row[series.field])),
        borderColor: series.color, backgroundColor: series.fill ? areaGradient(series.color, 0.14) : series.color,
        pointBackgroundColor: series.color, borderWidth: series.width, order: series.order, fill: series.fill ? "origin" : false,
        ...(series.dashed ? { borderDash: [5, 4] } : {}),
        // Straight segments: a curve between two intervals would suggest values nobody measured.
        tension: 0, pointRadius: 3, pointHoverRadius: 5, pointBorderColor: "#fff", pointBorderWidth: 1,
        spanGaps: false
      }))
    },
    options
  };
}

export function buildHorizontalBars(rows, { label = "Visits", limit = 7 } = {}) {
  const shown = (rows || []).slice(0, limit);
  const options = cartesian({ horizontal: true, yTitle: "" });
  options.scales.x.title = { display: true, text: "Number of Visits", color: COLORS.muted, font: { size: 11 } };
  options.plugins.tooltip.callbacks = {
    title: (items) => items.length ? serviceName(shown[items[0].dataIndex].service) || "Service not recorded" : "",
    label: ({ raw }) => `${label}: ${formatNumber(raw)}`
  };
  return {
    type: "bar",
    data: {
      labels: shown.map((row) => wrapLabel(row.service === "not_recorded" ? "Service not recorded" : serviceName(row.service))),
      datasets: [{ label, data: shown.map((row) => row.count), backgroundColor: shown.map((_row, index) => rankShade(index, shown.length)),
        borderRadius: 3, borderSkipped: "start", maxBarThickness: 18, categoryPercentage: 0.8, barPercentage: 0.8 }]
    },
    options,
    plugins: [valueLabels]
  };
}

export function buildStatusDoughnut(statuses, { totalWord = "visits" } = {}) {
  const rows = (statuses || []).filter((row) => (finite(row.count) ?? 0) > 0);
  return {
    type: "doughnut",
    data: {
      labels: rows.map((row) => statusMeta(row.status).label),
      datasets: [{
        data: rows.map((row) => row.count), backgroundColor: rows.map((row) => statusMeta(row.status).color),
        borderWidth: rows.length > 1 ? 2 : 0, borderColor: "#fff", hoverOffset: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "70%", layout: { padding: 4 },
      plugins: {
        legend: { display: false },
        tooltip: { ...TOOLTIP, callbacks: { label: ({ dataIndex }) => {
          const row = rows[dataIndex];
          return `${statusMeta(row.status).label}: ${plural(row.count, totalWord.replace(/s$/, ""), totalWord)} (${formatPercent(row.percentage)})`;
        } } }
      }
    }
  };
}

export function doctorLabel(doctor, names) {
  const name = typeof names?.[doctor] === "string" ? names[doctor].trim() : "";
  return name && name !== doctor ? `${name} (${doctor})` : doctor;
}

export function buildWorkloadChart(workload, groups, period, names) {
  const doctors = workload?.doctors || [];
  const options = cartesian({ yTitle: "Completed Visits" });
  options.plugins.qmsValueLabels = { skipZero: true, minSize: 9 };
  options.plugins.tooltip.callbacks = {
    title: (items) => {
      if (!items.length) return "";
      const group = groups[items[0].dataIndex];
      return period?.granularity === "hour" ? bucketTitle({ ...group, date: group.start_date }, period) : groupLabel(group, period);
    },
    label: ({ dataset, raw, dataIndex }) => `${dataset.label}: ${finite(raw) === null ? missing(groups[dataIndex]) : plural(raw, "consultation")}`
  };
  return {
    type: "bar",
    data: {
      labels: groups.map((group) => groupLabel(group, period)),
      datasets: doctors.map((doctor, index) => ({
        label: doctorLabel(doctor, names), data: groups.map((group) => finite(group.counts?.[doctor])),
        backgroundColor: DOCTOR_COLORS[index % DOCTOR_COLORS.length], borderColor: DOCTOR_BORDERS[index % DOCTOR_BORDERS.length],
        borderWidth: 1, borderRadius: 2, borderSkipped: "start", maxBarThickness: 22, categoryPercentage: 0.78, barPercentage: 0.94
      }))
    },
    options,
    plugins: [valueLabels]
  };
}

// A single green line with a light gradient area, for minutes or counts over time. `labels` writes
// each point's value above it.
export function buildAreaLine(rows, period, { field, label, unit = "count", samplesField = null, labels = false }) {
  const minutes = unit === "minutes";
  const options = cartesian({ yTitle: minutes ? "Minutes" : "Completed Visits", integer: !minutes });
  options.plugins.tooltip.callbacks = {
    title: (items) => items.length ? bucketTitle(rows[items[0].dataIndex], period) : "",
    label: ({ raw, dataIndex }) => {
      const row = rows[dataIndex];
      if (finite(raw) === null) return row?.future ? missing(row) : minutes ? "No data available (no patient called)" : "No data available";
      if (!minutes) return `${label}: ${formatNumber(raw)}`;
      const samples = finite(row?.[samplesField]);
      return `${label}: ${formatMinutes(raw)}${samples ? ` · ${plural(samples, "patient")}` : ""}`;
    }
  };
  return {
    type: "line",
    data: {
      labels: rows.map((row) => bucketLabel(row, period)),
      datasets: [{
        label, data: rows.map((row) => finite(row[field])), borderColor: COLORS.completed, backgroundColor: areaGradient(COLORS.completed, 0.22),
        fill: "origin", borderWidth: 2, tension: 0,
        pointRadius: 3.5, pointHoverRadius: 5, pointBackgroundColor: COLORS.completed, pointBorderColor: "#fff", pointBorderWidth: 1, spanGaps: false
      }]
    },
    options,
    plugins: labels ? [pointLabels] : []
  };
}

export function buildDoctorBars(doctors, names) {
  const rows = doctors || [];
  const options = cartesian({ yTitle: "Assigned Visits" });
  options.interaction = { mode: "nearest", axis: "x", intersect: false };
  options.plugins.tooltip.callbacks = {
    title: (items) => items.length ? doctorLabel(rows[items[0].dataIndex].doctor, names) : "",
    label: ({ dataIndex }) => {
      const row = rows[dataIndex];
      return [`Assigned visits: ${formatNumber(row.total)}`,
        ...["completed", "waiting", "serving", "cancelled"].map((status) => `${statusMeta(status).label}: ${formatNumber(row[status] ?? 0)}`)];
    }
  };
  return {
    type: "bar",
    data: {
      labels: rows.map((row) => wrapLabel(doctorLabel(row.doctor, names), 18)),
      datasets: [{ label: "Assigned visits", data: rows.map((row) => row.total),
        backgroundColor: rows.map((_row, index) => DOCTOR_BAR_COLORS[index % DOCTOR_BAR_COLORS.length]), borderRadius: 3,
        borderSkipped: "start", maxBarThickness: 64, categoryPercentage: 0.7, barPercentage: 0.9 }]
    },
    options,
    plugins: [valueLabels]
  };
}

// ---- Records tables ------------------------------------------------------------------------------

export function searchRows(rows, text, columns) {
  const needle = String(text || "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => columns.some((column) => String(column.text ? column.text(row) : row[column.key] ?? "").toLowerCase().includes(needle)));
}

export function sortRows(rows, column, direction = "asc") {
  if (!column) return rows;
  const valueOf = column.sort || ((row) => row[column.key]);
  const sign = direction === "desc" ? -1 : 1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const first = valueOf(a.row), second = valueOf(b.row);
    // Unknown values always sort last, whichever the direction.
    if (first == null || second == null) return first == null && second == null ? a.index - b.index : first == null ? 1 : -1;
    const order = typeof first === "number" && typeof second === "number" ? first - second : String(first).localeCompare(String(second), undefined, { numeric: true });
    return order * sign || a.index - b.index;
  }).map((item) => item.row);
}

export function pageRows(rows, page, size) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages };
}

// CSV with quoting; cells that a spreadsheet would run as a formula are prefixed with '.
export function toCsv(columns, rows) {
  const cell = (value) => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [columns.map((column) => cell(column.label)), ...rows.map((row) => columns.map((column) => cell(column.csv ? column.csv(row) : column.text ? column.text(row) : row[column.key])))]
    .map((line) => line.join(",")).join("\r\n");
}
