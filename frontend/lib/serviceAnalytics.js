import { serviceLabel } from "./analyticsCharts";

// The By Service section of Analytics → Detailed Data: four cards (outcomes per service, overall
// outcome distribution, average wait per service, summary table) drawn from ONE model built here.
// The model reads only the backend's `tableData` (one row per service, `summarizeVisits`), its
// `totals`, and the wait sample counts in `insights.wait.by_service`; nothing is recounted, so the
// charts and the table cannot disagree.

// Outcome colours. The hues follow the requested Completed green / Cancelled red / No-show slate
// blue / In Queue amber; the steps were adjusted with the dataviz palette validator so green and
// red stay distinguishable for red-green colour-blind readers (all checks pass in stacking order).
// `ink` is the readable text colour for values written in that outcome's colour.
export const SERVICE_OUTCOMES = [
  { key: "completed", label: "Completed", color: "#15803D", ink: "#15803D", onColor: "#ffffff" },
  { key: "cancelled", label: "Cancelled", color: "#F87171", ink: "#B91C1C", onColor: "#1F2937" },
  { key: "no_show", label: "No-show", color: "#5570B0", ink: "#3F5793", onColor: "#ffffff" },
  { key: "in_queue", label: "In Queue", color: "#E9A20F", ink: "#92400E", onColor: "#1F2937", title: "Still waiting or being served" }
];
// Only shown if a visit holds a status outside the five known ones, so every visit stays counted.
export const OTHER_OUTCOME = { key: "other", label: "Other status", color: "#9CA3AF", ink: "#4B5563", onColor: "#1F2937" };

export const WAIT_LINE = { line: "#166534", point: "#15803D", fill: "rgba(22, 163, 74, 0.12)" };
const GRID = "#E5E7EB";
const AXIS_INK = "#4B5563";
const LABEL_INK = "#1F2937";
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const count = (value) => Math.max(0, Math.round(Number(value) || 0));
const sumOf = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0);
const plural = (value, word) => `${value} ${word}${value === 1 ? "" : "s"}`;
export const percentText = (value) => (value == null ? "—" : `${value.toFixed(1)}%`);
export const minutesValue = (value) => (value == null ? "—" : Number(value).toFixed(1));

// Wait samples per service from the insights payload (same visits, same registration-to-call rule
// as Avg Wait). null when the insights are unavailable; then the table's figure is shown as before.
function waitSamplesOf(wait) {
  if (!Array.isArray(wait?.by_service)) return null;
  return new Map(wait.by_service.map((row) => [row.key, count(row.samples)]));
}

function measuredMinutes(value, samples) {
  if (samples === 0) return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) ? minutes : null;
}

export function serviceAnalytics(tableData, totals, wait) {
  const samples = waitSamplesOf(wait);
  const rows = (Array.isArray(tableData) ? tableData : []).map((row) => {
    const waitSamples = samples && samples.has(row.service_type) ? samples.get(row.service_type) : null;
    const outcomes = {
      completed: count(row.completed),
      cancelled: count(row.cancelled),
      no_show: count(row.no_show),
      in_queue: count(row.waiting) + count(row.serving)
    };
    const total = count(row.total_patients);
    const known = outcomes.completed + outcomes.cancelled + outcomes.no_show + outcomes.in_queue;
    return {
      service: row.service_type,
      label: serviceLabel(row.service_type),
      total,
      ...outcomes,
      other: Math.max(0, total - known),
      waitSamples,
      avgWait: measuredMinutes(row.avg_wait_time, waitSamples),
      avgService: row.avg_service_time ?? "0.0",
      completion: row.completion_rate ?? "0.0"
    };
  });
  const total = sumOf(rows, "total");
  const outcomes = [...SERVICE_OUTCOMES, ...(sumOf(rows, "other") ? [OTHER_OUTCOME] : [])].map((outcome) => {
    const value = sumOf(rows, outcome.key);
    return { ...outcome, count: value, percent: total ? (value * 100) / total : null };
  });
  const allSamples = samples ? [...samples.values()].reduce((sum, value) => sum + value, 0) : null;
  return {
    rows,
    total,
    outcomes,
    // The backend's own totals row, shown as the table footer, as before.
    totals: totals ? { ...totals, avgWait: measuredMinutes(totals.avg_wait_time, allSamples) } : null,
    // The section is internally consistent when the service rows add up to the backend's total.
    consistent: !totals || count(totals.total_patients) === total,
    unmeasured: rows.filter((row) => row.avgWait == null).map((row) => row.label),
    measured: rows.some((row) => row.avgWait != null)
  };
}

// "Environmental Health" → ["Environmental", "Health"]: whole words, lines of about `width` letters.
export function wrapLabel(text, width = 12) {
  const lines = [];
  String(text).split(/\s+/).filter(Boolean).forEach((word) => {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  });
  return lines.length > 1 ? lines : lines[0] || "";
}

const tooltip = (extra) => ({
  backgroundColor: "#172033", padding: 12, cornerRadius: 8, caretPadding: 6, boxWidth: 10, boxHeight: 10, boxPadding: 4,
  titleFont: { size: 13, weight: "bold" }, titleMarginBottom: 8, bodyFont: { size: 12 }, bodySpacing: 3, ...extra
});
const serviceAxis = () => ({
  grid: { display: false },
  border: { color: GRID },
  ticks: { autoSkip: false, maxRotation: 45, minRotation: 0, color: AXIS_INK, font: { size: 10 } }
});
const valueAxis = (title, extra = {}) => ({
  beginAtZero: true,
  grid: { color: GRID },
  border: { display: false },
  title: { display: true, text: title, color: AXIS_INK, font: { size: 11 } },
  ticks: { color: AXIS_INK, font: { size: 11 }, padding: 6 },
  ...extra
});

// Card 1: each service's total written above its stack.
const stackTotals = (rows) => ({
  id: "serviceStackTotals",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = LABEL_INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    rows.forEach((row, index) => {
      let top = Infinity;
      let x = null;
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const bar = chart.getDatasetMeta(datasetIndex).data[index];
        if (!bar || !chart.isDatasetVisible(datasetIndex)) return;
        top = Math.min(top, bar.y);
        x = bar.x;
      });
      if (x != null && Number.isFinite(top)) ctx.fillText(String(row.total), x, top - 4);
    });
    ctx.restore();
  }
});

export function outcomeBarChart(model) {
  if (!model?.total) return null;
  const { rows } = model;
  return {
    type: "bar",
    data: {
      labels: rows.map((row) => wrapLabel(row.label)),
      datasets: model.outcomes.map((outcome) => ({
        label: outcome.label, outcome: outcome.key, data: rows.map((row) => row[outcome.key]),
        backgroundColor: outcome.color, hoverBackgroundColor: outcome.color,
        // A 2px white gap between stacked segments keeps thin segments readable as their own block.
        borderColor: "#ffffff", borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, borderSkipped: false,
        barPercentage: 0.72, categoryPercentage: 0.86, maxBarThickness: 44
      }))
    },
    plugins: [stackTotals(rows)],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 22, right: 4, left: 0 } },
      interaction: { mode: "index", axis: "x", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: tooltip({
          // An "Other status" segment is listed only when it holds visits.
          filter: (item) => item.dataset.outcome !== OTHER_OUTCOME.key || item.raw > 0,
          callbacks: {
            title: (items) => (items.length ? `Service: ${rows[items[0].dataIndex].label}` : ""),
            beforeBody: (items) => (items.length ? `Total Patients: ${rows[items[0].dataIndex].total}` : ""),
            label: ({ dataset, raw }) => `${dataset.label}: ${raw}`
          }
        })
      },
      scales: {
        x: { ...serviceAxis(), stacked: true },
        y: valueAxis("Patients", { stacked: true, grace: "6%", ticks: { color: AXIS_INK, font: { size: 11 }, padding: 6, precision: 0 } })
      }
    }
  };
}

// Card 2: each segment's share written on it when the arc is wide enough to hold the text.
const MIN_LABEL_ANGLE = 0.42;
const arcPercents = (shown) => ({
  id: "serviceArcPercents",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    ctx.save();
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    meta.data.forEach((arc, index) => {
      const outcome = shown[index];
      if (!outcome || arc.endAngle - arc.startAngle < MIN_LABEL_ANGLE) return;
      const { x, y } = arc.tooltipPosition();
      ctx.fillStyle = outcome.onColor;
      ctx.fillText(percentText(outcome.percent), x, y);
    });
    ctx.restore();
  }
});

export function outcomeDonutChart(model) {
  if (!model?.total) return null;
  const shown = model.outcomes.filter((outcome) => outcome.count > 0);
  return {
    type: "doughnut",
    data: {
      labels: shown.map((outcome) => outcome.label),
      datasets: [{
        label: "Patients", data: shown.map((outcome) => outcome.count), backgroundColor: shown.map((outcome) => outcome.color),
        borderColor: "#ffffff", borderWidth: 2, hoverOffset: 6
      }]
    },
    plugins: [arcPercents(shown)],
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      layout: { padding: 6 },
      plugins: {
        legend: { display: false },
        tooltip: tooltip({
          callbacks: {
            title: () => "",
            label: ({ dataIndex }) => {
              const outcome = shown[dataIndex];
              return `${outcome.label}: ${plural(outcome.count, "patient")} (${percentText(outcome.percent)})`;
            }
          }
        })
      }
    }
  };
}

// Card 3: the average beside each point, skipped where it would collide with the previous label.
const pointValues = {
  id: "serviceWaitValues",
  afterDatasetsDraw(chart) {
    const values = chart.data.datasets[0]?.data || [];
    const { ctx, chartArea } = chart;
    let lastRight = -Infinity;
    ctx.save();
    ctx.font = `600 10.5px ${FONT}`;
    ctx.fillStyle = LABEL_INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    chart.getDatasetMeta(0).data.forEach((point, index) => {
      const value = values[index];
      if (value == null || point.skip) return;
      const text = minutesValue(value);
      const half = ctx.measureText(text).width / 2;
      const x = Math.min(Math.max(point.x, chartArea.left + half), chartArea.right - half);
      if (x - half < lastRight + 4) return;
      ctx.fillText(text, x, Math.max(point.y - 8, chartArea.top + 12));
      lastRight = x + half;
    });
    ctx.restore();
  }
};

export function waitLineChart(model) {
  if (!model?.measured) return null;
  const { rows } = model;
  return {
    type: "line",
    data: {
      labels: rows.map((row) => wrapLabel(row.label)),
      datasets: [{
        label: "Average wait (minutes)", data: rows.map((row) => row.avgWait),
        borderColor: WAIT_LINE.line, backgroundColor: WAIT_LINE.fill, borderWidth: 2, fill: "origin",
        // Straight segments, no smoothing; a service without a measured wait is a gap, never zero.
        tension: 0, spanGaps: false,
        pointRadius: 4.5, pointHoverRadius: 6.5, pointHitRadius: 14,
        pointBackgroundColor: WAIT_LINE.point, pointBorderColor: "#ffffff", pointBorderWidth: 2
      }]
    },
    plugins: [pointValues],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 18, right: 10, left: 0 } },
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: tooltip({
          filter: (item) => item.raw != null,
          callbacks: {
            title: (items) => (items.length ? `Service: ${rows[items[0].dataIndex].label}` : ""),
            label: ({ raw }) => `Average Wait Time: ${minutesValue(raw)} minutes`,
            afterLabel: ({ dataIndex }) => {
              const samples = rows[dataIndex].waitSamples;
              return samples == null ? "" : `Patients called: ${samples}`;
            }
          }
        })
      },
      scales: {
        x: serviceAxis(),
        y: valueAxis("Minutes", { grace: "12%" })
      }
    }
  };
}
