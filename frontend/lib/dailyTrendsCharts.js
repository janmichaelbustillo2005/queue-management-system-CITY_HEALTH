const COLORS = {
  blue: "#3b82f6",
  green: "#10b981",
  orange: "#f59e0b",
  red: "#ef4444",
  purple: "#8b5cf6"
};

export const finiteMetric = (value) => Number.isFinite(value) && value >= 0 ? value : null;

export function getManilaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function makeFilters(date, view = "day", startTime = "", endTime = "") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      Number.isNaN(Date.parse(`${date}T00:00:00+08:00`)) ||
      getManilaToday(new Date(`${date}T00:00:00+08:00`)) !== date) {
    throw new Error("Choose a valid date.");
  }
  if (view !== "day" && view !== "shift") throw new Error("Choose a valid view.");
  if (view === "day") return { date, view };
  const validTime = (time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time || "");
  if (!validTime(startTime) || !validTime(endTime)) {
    throw new Error("Choose both a shift start and end time.");
  }
  if (startTime === endTime) throw new Error("Choose different shift start and end times.");
  return { date, view, startTime, endTime };
}

export function isDailyTrendsData(data, filters) {
  const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
  const rows = (value, label) => Array.isArray(value) && value.every((row) =>
    row !== null && typeof row === "object" && !Array.isArray(row) && typeof row[label] === "string");
  return Boolean(data && data.time_zone === "Asia/Manila" && timestamp(data.observed_at) &&
    data.range?.date === filters.date && data.range?.view === filters.view &&
    timestamp(data.range.start_at) && timestamp(data.range.end_at) &&
    Date.parse(data.range.end_at) > Date.parse(data.range.start_at) &&
    (filters.view !== "shift" || (data.range.start_time === filters.startTime && data.range.end_time === filters.endTime)) &&
    rows(data.hourly, "label") && rows(data.statuses, "label") &&
    rows(data.counters, "name") && rows(data.peak_hours, "label") &&
    finiteMetric(data.record_count) !== null &&
    (data.notes === undefined || (Array.isArray(data.notes) && data.notes.every((note) => typeof note === "string"))));
}

export function statusColor(status, index = 0) {
  const known = { waiting: COLORS.orange, serving: COLORS.blue, completed: COLORS.green,
    cancelled: COLORS.red };
  return known[status] || [COLORS.purple, "#06b6d4", "#64748b", "#d946ef"][index % 4];
}

function baseOptions(unit = "patients") {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 8, right: 8 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#172033", titleColor: "#fff", bodyColor: "#e2e8f0",
        padding: 12, cornerRadius: 10, boxPadding: 5
      }
    },
    scales: {
      x: {
        grid: { display: false }, border: { display: false },
        ticks: {
          color: "#64748b", font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12,
          callback(value) {
            const interval = String(this.getLabelForValue(value));
            const start = interval.split("–")[0];
            return `${start}${interval.includes("(+1 day)") ? " +1d" : ""}`;
          }
        }
      },
      y: {
        beginAtZero: true, border: { display: false },
        grid: { color: "#eef2f6" },
        title: { display: true, text: unit === "minutes" ? "Minutes" : "Patients", color: "#64748b", font: { size: 11 } },
        ticks: { color: "#64748b", font: { size: 11 }, ...(unit === "patients" ? { precision: 0 } : {}) }
      }
    }
  };
}

// The clinic normally operates 8:00 AM – 5:00 PM (Asia/Manila).
export const CLINIC_START_HOUR = 8;
export const CLINIC_END_HOUR = 17;

const manilaHour = (iso) => {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).getUTCHours() : null;
};

// An hour has activity when any measured series is non-zero, or when its waiting
// snapshot could not be reconstructed (unknown is not the same as zero).
function hasHourActivity(row) {
  const positive = (value) => finiteMetric(value) !== null && value > 0;
  return ["arrivals", "served", "waiting", "cancelled", "wait_samples", "service_samples"].some((field) => positive(row[field])) ||
    (finiteMetric(row.arrivals) !== null && row.waiting === null);
}

// Full-day view shows clinic hours, widened to cover every hour with recorded
// activity, so nothing legitimate is hidden. Only hours with no activity at all
// outside 8:00–17:00 are left out. Custom shifts are always shown in full.
export function visibleHours(data, mode = "clinic") {
  const rows = data?.hourly || [];
  if (mode !== "clinic" || data?.range?.view !== "day") return { rows, trimmed: false };
  const hours = rows.map((row) => manilaHour(row.start_at));
  if (hours.some((hour) => hour === null)) return { rows, trimmed: false };
  let first = CLINIC_START_HOUR, last = CLINIC_END_HOUR - 1;
  rows.forEach((row, index) => {
    if (!hasHourActivity(row)) return;
    first = Math.min(first, hours[index]);
    last = Math.max(last, hours[index]);
  });
  const shown = rows.filter((_row, index) => hours[index] >= first && hours[index] <= last);
  return { rows: shown, trimmed: shown.length < rows.length, first, last: last + 1 };
}

const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;
export function windowLabel(window) {
  return window?.trimmed ? `${hourLabel(window.first)}–${hourLabel(window.last)}` : "";
}

// Totals for the whole selected range, from the same hourly rows as the charts.
// Averages are weighted by valid samples; no samples means unavailable, not zero.
export function summarizeTrends(data) {
  const rows = (data?.hourly || []).filter((row) => finiteMetric(row.arrivals) !== null);
  if (!rows.length) return null;
  const sum = (field) => rows.reduce((total, row) => total + (finiteMetric(row[field]) ?? 0), 0);
  const weighted = (avgField, sampleField) => {
    let minutes = 0, samples = 0;
    for (const row of rows) {
      const average = finiteMetric(row[avgField]), count = finiteMetric(row[sampleField]);
      if (average === null || !count) continue;
      minutes += average * count;
      samples += count;
    }
    return { value: samples ? minutes / samples : null, samples };
  };
  return {
    arrivals: sum("arrivals"), served: sum("served"), cancelled: sum("cancelled"),
    wait: weighted("avg_wait_minutes", "wait_samples"), service: weighted("avg_service_minutes", "service_samples")
  };
}

// Busiest hours first; tied hours share a rank (1, 1, 3) and keep clock order.
export function rankPeakHours(rows, limit = 5) {
  const peaks = (rows || []).filter((row) => finiteMetric(row.arrivals) !== null && row.arrivals > 0)
    .slice().sort((a, b) => b.arrivals - a.arrivals || String(a.start_at || a.label).localeCompare(String(b.start_at || b.label)));
  let rank = 0;
  const ranked = peaks.map((row, index) => {
    if (index === 0 || row.arrivals !== peaks[index - 1].arrivals) rank = index + 1;
    return { ...row, rank };
  });
  return { rows: ranked.slice(0, limit), total: ranked.length, largest: ranked[0]?.arrivals ?? 0 };
}

// Missing values: a future hour has not happened yet; a past one could not be measured.
function missingReason(row) {
  if (!row) return "No data available";
  return finiteMetric(row.arrivals) === null ? "No data available (hour not reached yet)" : "No data available (cannot be reconstructed)";
}

export function buildActivityChart(data) {
  const rows = data?.hourly || [];
  const bars = (label, field, color) => ({
    type: "bar", label, data: rows.map((row) => finiteMetric(row[field])),
    backgroundColor: color, borderRadius: 3, maxBarThickness: 18, categoryPercentage: 0.72, barPercentage: 0.9, order: 2
  });
  const options = baseOptions();
  options.plugins.tooltip.callbacks = {
    label: ({ dataset, raw, dataIndex }) => `${dataset.label}: ${finiteMetric(raw) === null ? missingReason(rows[dataIndex]) : raw}`
  };
  return {
    type: "bar",
    data: {
      labels: rows.map((row) => row.label),
      datasets: [
        bars("Patient arrivals", "arrivals", COLORS.blue),
        bars("Patients served", "served", COLORS.green),
        {
          type: "line", label: "Waiting patients", data: rows.map((row) => finiteMetric(row.waiting)),
          borderColor: COLORS.orange, backgroundColor: COLORS.orange,
          borderWidth: 2, tension: 0.25, pointRadius: 3, pointHoverRadius: 5, spanGaps: false, order: 1
        },
        bars("Cancelled", "cancelled", COLORS.red)
      ]
    },
    options
  };
}

export function buildDurationChart(data, metric = "wait") {
  const rows = data?.hourly || [];
  const waiting = metric === "wait";
  const field = waiting ? "avg_wait_minutes" : "avg_service_minutes";
  const samples = waiting ? "wait_samples" : "service_samples";
  const color = waiting ? COLORS.purple : COLORS.green;
  const options = baseOptions("minutes");
  options.plugins.tooltip.callbacks = {
    label: ({ raw, dataIndex }) => {
      const value = finiteMetric(raw);
      if (value === null) {
        const row = rows[dataIndex];
        return row && finiteMetric(row.arrivals) === null ? missingReason(row) : `No data available${row ? " (no valid visits this hour)" : ""}`;
      }
      const count = finiteMetric(rows[dataIndex]?.[samples]);
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} min${count === null ? "" : ` · ${count} valid ${count === 1 ? "visit" : "visits"}`}`;
    }
  };
  return {
    type: "line",
    data: {
      labels: rows.map((row) => row.label),
      datasets: [{
        label: waiting ? "Average waiting time" : "Average service time",
        data: rows.map((row) => finiteMetric(row[field])),
        borderColor: color, backgroundColor: waiting ? "rgba(139, 92, 246, 0.11)" : "rgba(16, 185, 129, 0.11)",
        // Points stay visible so an hour with a lone value is never lost between gaps.
        fill: true, borderWidth: 2, tension: 0.3,
        pointRadius: 3.5, pointHoverRadius: 6, spanGaps: false
      }]
    },
    options
  };
}

export function buildStatusChart(data) {
  const rows = data?.statuses || [];
  return {
    type: "doughnut",
    data: {
      labels: rows.map((row) => row.label),
      datasets: [{
        data: rows.map((row) => finiteMetric(row.count)),
        backgroundColor: rows.map((row, index) => statusColor(row.status, index)),
        borderWidth: 3, borderColor: "#fff", hoverOffset: 5
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "73%",
      layout: { padding: 7 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#172033", padding: 12, cornerRadius: 10,
          callbacks: {
            label: ({ dataIndex }) => {
              const row = rows[dataIndex];
              const percentage = finiteMetric(row?.percentage);
              return `${row?.label}: ${row?.count ?? "No data available"}${percentage === null ? "" : ` (${percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%)`}`;
            }
          }
        }
      }
    }
  };
}
