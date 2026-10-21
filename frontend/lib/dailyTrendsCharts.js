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
    cancelled: COLORS.red, "no-show": "#e11d48" };
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

export function buildActivityChart(data) {
  const rows = data?.hourly || [];
  const bars = (label, field, color) => ({
    type: "bar", label, data: rows.map((row) => finiteMetric(row[field])),
    backgroundColor: color, borderRadius: 3, maxBarThickness: 20, order: 2
  });
  const options = baseOptions();
  options.plugins.tooltip.callbacks = {
    label: ({ dataset, raw }) => `${dataset.label}: ${finiteMetric(raw) === null ? "No data available" : raw}`
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
          borderWidth: 2.5, tension: 0.25, pointRadius: 2, pointHoverRadius: 5, spanGaps: false, order: 1
        },
        bars("Cancelled / no-show", "cancelled_no_show", COLORS.red)
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
      if (value === null) return "No data available";
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
        fill: true, borderWidth: 2.5, tension: 0.3,
        pointRadius: 2.5, pointHoverRadius: 5, spanGaps: false
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
