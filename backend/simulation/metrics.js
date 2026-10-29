// Metrics for one simulated day, and their mean with a 95% confidence interval across replications.
const { DOCTORS } = require("./engine");

const STARVATION_MINUTES = [60, 120];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
}
const mean = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
// Jain's fairness index over individual waits: 1 when everyone waits equally, 1/n at worst.
function jain(values) {
  const sum = values.reduce((s, v) => s + v, 0);
  const squares = values.reduce((s, v) => s + v * v, 0);
  return squares === 0 ? 1 : (sum * sum) / (values.length * squares);
}

function dayMetrics({ served, busy, makespan, inversions }) {
  const waits = served.map((p) => p.wait);
  const groups = {};
  for (const p of served) (groups[p.group] ||= []).push(p.wait);
  return {
    patients: served.length,
    avgWait: mean(waits), p95Wait: percentile(waits, 95), maxWait: Math.max(...waits),
    jainFairness: jain(waits),
    throughputPerHour: served.length / (makespan / 60),
    makespanMinutes: makespan,
    utilization: Object.fromEntries(DOCTORS.map((d) => [d, makespan ? busy[d] / makespan : 0])),
    starvation: Object.fromEntries(STARVATION_MINUTES.map((m) => [`over${m}`, waits.filter((w) => w > m).length])),
    priorityInversions: inversions.anyBase,
    regularBeforeProtected: inversions.regularOverProtected,
    decisions: inversions.decisions,
    byGroup: Object.fromEntries(Object.entries(groups).map(([g, w]) => [g, { n: w.length, avgWait: mean(w), p95Wait: percentile(w, 95), maxWait: Math.max(...w) }]))
  };
}

// Mean and normal-approximation 95% CI half-width of a numeric field across replications.
function summarize(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const m = mean(v);
  const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)) : 0;
  return { mean: m, ci95: 1.96 * sd / Math.sqrt(v.length), min: Math.min(...v), max: Math.max(...v), n: v.length };
}

module.exports = { dayMetrics, summarize, percentile, jain, STARVATION_MINUTES };
