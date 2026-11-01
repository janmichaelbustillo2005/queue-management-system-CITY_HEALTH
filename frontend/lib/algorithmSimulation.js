// Algorithm Simulation page (Superadmin, Simulation Mode). Every number comes from the research
// simulator in backend/simulation: visual.js reruns the unchanged engine, WPS-A ranking
// (src/lib/wpsPriority.js) and WRR policy on one seeded synthetic workload. Nothing here calls the
// API, reads patient records or touches the live queue.
import {
  DEFAULT_SCENARIO, DEFAULT_SEED, SCENARIO_OPTIONS, AGING_STEP_MINUTES, AGING_MAX_BONUS,
  buildTimeline, snapshotAt, nextEventTime, highlightTimes, queueLengthSeries, clock
} from "../../backend/simulation/visual";

export { DEFAULT_SCENARIO, DEFAULT_SEED, SCENARIO_OPTIONS, AGING_STEP_MINUTES, AGING_MAX_BONUS, snapshotAt, nextEventTime, clock };

export const ALGORITHM_IDS = ["WPS-A", "WRR"];
export const MODES = [
  { id: "WPS-A", label: "WPS-A", icon: "fas fa-sort-amount-down" },
  { id: "WRR", label: "WRR", icon: "fas fa-sync-alt" },
  { id: "compare", label: "Side-by-side comparison", icon: "fas fa-columns" }
];
export const ALGORITHM_INFO = {
  "WPS-A": {
    title: "WPS-A — Weighted Priority Scheduling with Aging",
    summary: `Calls the highest effective score: base priority score + 1 for every full ${AGING_STEP_MINUTES} minutes waited (at most +${AGING_MAX_BONUS}). Ties go to the higher base score, then the earlier registration.`
  },
  WRR: {
    title: "WRR — Weighted Round Robin (research baseline)",
    summary: "Priority classes take turns from the highest weight down; each class may send as many patients per turn as its weight (its priority score), first come, first served inside the class. Not used by the live queue."
  }
};
// Simulated minutes per real second.
export const SPEEDS = [0.5, 1, 2, 5, 10, 20];
export const DEFAULT_SPEED = 2;
export const SCENARIO_LABELS = {
  "low-volume": "Low volume", "medium-volume": "Medium volume", "high-volume": "High volume",
  "priority-surge": "Priority surge", "unequal-workload": "Unequal workload", "long-waits": "Long waits (morning overload)"
};

// Both algorithms on the same seeded day: identical patients, consultation lengths and doctors.
export function buildRun(scenario, seed) {
  const timelines = Object.fromEntries(ALGORITHM_IDS.map((algorithm) => [algorithm, buildTimeline({ scenario, seed, algorithm })]));
  return {
    scenario, seed, timelines,
    series: Object.fromEntries(ALGORITHM_IDS.map((algorithm) => [algorithm, queueLengthSeries(timelines[algorithm])])),
    highlights: Object.fromEntries(ALGORITHM_IDS.map((algorithm) => [algorithm, highlightTimes(timelines[algorithm])])),
    end: Math.max(...ALGORITHM_IDS.map((algorithm) => timelines[algorithm].end))
  };
}

export const visibleAlgorithms = (mode) => (mode === "compare" ? ALGORITHM_IDS : [mode]);

// The playback clock: advance by real elapsed time at the chosen speed, never past the end.
export function advance(t, speed, elapsedMs, end) {
  return Math.min(end, t + (speed * Math.max(0, elapsedMs)) / 1000);
}

// The time slider moves in quarter minutes; its last step means the exact end of the day.
export const SLIDER_STEP = 0.25;
export const sliderTime = (value, end) => (value > end - SLIDER_STEP ? end : Math.max(0, value));

export function nextHighlight(times, t) {
  const next = times.find((time) => time > t + 1e-9);
  return next == null ? null : next;
}

// A seed is a whole number; anything else keeps the current seed.
export function parseSeed(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number(text);
}

export const formatMinutes = (value, digits = 1) => (value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)} min`);
export const formatPercent = (value) => (value == null || !Number.isFinite(value) ? "—" : `${Math.round(value * 100)}%`);
// Waiting duration as m:ss (or h:mm:ss past an hour).
export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const total = Math.max(0, Math.floor(minutes * 60));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// The categories in each WRR class (weight = priority score), from the day's patients.
export function classLabels(timeline) {
  const labels = {};
  for (const p of timeline.patients) (labels[p.base] ||= new Set()).add(p.category);
  return Object.fromEntries(Object.entries(labels).map(([weight, set]) => [weight, [...set].sort().join(", ")]));
}

// The last few arrivals, calls and completions up to t, newest first.
export function recentEvents(timeline, t, count = 8) {
  const byId = Object.fromEntries(timeline.patients.map((p) => [p.id, p]));
  return timeline.events.filter((e) => e.t <= t + 1e-9).slice(-count).reverse().map((e) => {
    const p = byId[e.patientId];
    const text = e.kind === "arrival" ? `${p.ticket} ${p.category} registered (base score ${p.base})`
      : e.kind === "call" ? `${e.doctor} called ${p.ticket} ${p.category} after ${formatMinutes(p.wait)}`
      : `${e.doctor} completed ${p.ticket} ${p.category} (${formatMinutes(p.consultation)} consultation)`;
    return { key: `${e.kind}-${e.patientId}`, kind: e.kind, clock: clock(e.t), text };
  });
}

// Rows for the comparison table; "better" names the algorithm with the better value, if any.
export function comparisonRows(snapshots) {
  const [a, b] = ALGORITHM_IDS.map((id) => snapshots[id].metrics);
  const row = (label, key, format, lowerIsBetter) => {
    const pick = (m) => (typeof key === "function" ? key(m) : m[key]);
    const values = [pick(a), pick(b)];
    let better = null;
    if (lowerIsBetter != null && values.every((v) => v != null && Number.isFinite(v)) && Math.abs(values[0] - values[1]) > 1e-9) {
      better = (values[0] < values[1]) === lowerIsBetter ? ALGORITHM_IDS[0] : ALGORITHM_IDS[1];
    }
    return { label, values: values.map((value) => format(value)), better };
  };
  const count = (v) => (v == null ? "—" : String(v));
  const fairness = (v) => (v == null ? "—" : v.toFixed(3));
  return [
    row("Completed consultations", "completed", count, null),
    row("Waiting now", "waiting", count, null),
    row("Average wait (called patients)", "avgWait", formatMinutes, true),
    row("95th-percentile wait", "p95Wait", formatMinutes, true),
    row("Maximum wait", "maxWait", formatMinutes, true),
    row("Longest wait still in the queue", "longestWaitingNow", formatMinutes, true),
    row("Jain fairness index (1 = equal waits)", "jainFairness", fairness, false),
    ...["Doctor 1", "Doctor 2", "Doctor 3"].map((d) => row(`${d} utilization`, (m) => m.utilization[d], formatPercent, null)),
    row("Priority-lane violations (Regular called while Senior/PWD/Pregnant waited)", "regularBeforeProtected", count, true),
    row("Calls of a lower base score while a higher one waited", "lowerScoreFirst", count, null),
    row("Calls changed by the Aging bonus", "agingOvertakes", count, null)
  ];
}
