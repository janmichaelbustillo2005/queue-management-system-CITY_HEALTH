// WPS-A versus WRR on the Regular/Vulnerable experiments (experiment-scenarios.js): performance
// metrics computed from the simulated events of both timelines (registrations, calls, consultation
// starts and ends), the comparison per metric, the call-order differences and plain-language
// findings. The Algorithm Simulation page and the Chapter IV report (experiment-report.js) use the
// same functions. Research only; never the live queue. Pure functions, so it also runs in the browser.
//
// Terms:
//   bypass      - a call that went to a patient who registered after one who was left waiting.
//   cut-off     - the last registration; afterwards the queue only drains. "Still waiting at the
//                 cut-off" is NOT starvation: the simulation drains the queue and serves everyone.
//   starvation evidence - still waiting at the cut-off after sitting through the last
//                 STARVATION_WINDOW minutes of arrivals in which every one of at least
//                 STARVATION_MIN_CALLS calls went to a later registration.
const { buildTimeline, ALGORITHMS } = require("./visual");
const { percentile, summarize } = require("./metrics");
const { AGING_MAX_BONUS, AGING_STEP_MS } = require("../src/lib/wpsPriority");

const ALGORITHM_IDS = Object.keys(ALGORITHMS);
const STARVATION_WINDOW = 60;
const STARVATION_MIN_CALLS = 3;
const CAP_MINUTES = (AGING_MAX_BONUS * AGING_STEP_MS) / 60000;
const GROUPS = ["regular", "senior", "pwd", "pregnant", "indigenous", "solo_parent", "multiple"];
const GROUP_LABELS = {
  regular: "Regular", senior: "Senior", pwd: "PWD", pregnant: "Pregnant", indigenous: "Indigenous",
  solo_parent: "Solo Parent", multiple: "Cumulative (2+ classifications)"
};
const EPS = 1e-9;

const average = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
function waitStats(list) {
  const waits = list.map((p) => p.wait);
  return { n: waits.length, avg: average(waits), p95: percentile(waits, 95), max: waits.length ? Math.max(...waits) : null };
}

function experimentMetrics(timeline) {
  const { patients, decisions, doctors, end, cutoff } = timeline;
  const regular = patients.filter((p) => !p.vulnerable);
  const vulnerable = patients.filter((p) => p.vulnerable);
  const byId = Object.fromEntries(patients.map((p) => [p.id, p]));
  const bypasses = {};
  const cappedBypasses = {};   // bypasses after the patient had waited long enough for the +2 cap
  for (const d of decisions) {
    for (const id of d.overtakenIds) {
      bypasses[id] = (bypasses[id] || 0) + 1;
      if (d.now - byId[id].arrival >= CAP_MINUTES) cappedBypasses[id] = (cappedBypasses[id] || 0) + 1;
    }
  }
  const total = (list, counts) => list.reduce((s, p) => s + (counts[p.id] || 0), 0);
  const busy = Object.fromEntries(doctors.map((d) => [d, 0]));
  for (const p of patients) busy[p.doctor] += p.end - p.start;
  const utilization = Object.fromEntries(doctors.map((d) => [d, end ? busy[d] / end : 0]));

  const stillWaiting = patients.filter((p) => p.arrival <= cutoff + EPS && p.start > cutoff + EPS);
  const windowCalls = decisions.filter((d) => d.now > cutoff - STARVATION_WINDOW + EPS && d.now <= cutoff + EPS);
  const starved = stillWaiting.filter((p) => p.arrival <= cutoff - STARVATION_WINDOW + EPS &&
    windowCalls.length >= STARVATION_MIN_CALLS && windowCalls.every((d) => d.overtakenIds.includes(p.id)));
  const tracked = patients.find((p) => p.role === "tracked");

  return {
    patients: patients.length,
    completed: patients.filter((p) => p.end <= end + EPS).length,
    completedAtCutoff: patients.filter((p) => p.end <= cutoff + EPS).length,
    overall: waitStats(patients), regular: waitStats(regular), vulnerable: waitStats(vulnerable),
    byGroup: Object.fromEntries(GROUPS.filter((g) => patients.some((p) => p.group === g)).map((g) => [g, waitStats(patients.filter((p) => p.group === g))])),
    throughputPerHour: end ? patients.length / (end / 60) : null, makespan: end,
    utilization, meanUtilization: average(Object.values(utilization)),
    regularBypasses: total(regular, bypasses), regularsBypassed: regular.filter((p) => bypasses[p.id]).length,
    maxRegularBypasses: Math.max(0, ...regular.map((p) => bypasses[p.id] || 0)),
    regularCappedBypasses: total(regular, cappedBypasses),
    regularsPastCap: regular.filter((p) => p.wait >= CAP_MINUTES).length,
    vulnerableBypasses: total(vulnerable, bypasses),
    laneViolations: decisions.filter((d) => d.regularOverProtected).length,
    priorityInversions: decisions.filter((d) => d.lowerScoreFirst).length,
    agingOvertakes: decisions.filter((d) => d.agingOvertake).length,
    cutoff,
    stillWaitingAtCutoff: { total: stillWaiting.length, regular: stillWaiting.filter((p) => !p.vulnerable).length, vulnerable: stillWaiting.filter((p) => p.vulnerable).length },
    longestRegularWaitAtCutoff: Math.max(0, ...stillWaiting.filter((p) => !p.vulnerable).map((p) => cutoff - p.arrival)),
    regularServedAfterCutoff: regular.filter((p) => p.start > cutoff + EPS).length,
    starvation: {
      windowMinutes: STARVATION_WINDOW, callsInWindow: windowCalls.length,
      regular: starved.filter((p) => !p.vulnerable).map((p) => p.ticket), vulnerable: starved.filter((p) => p.vulnerable).map((p) => p.ticket)
    },
    tracked: tracked ? {
      ticket: tracked.ticket, category: tracked.category, arrival: tracked.arrival, start: tracked.start, wait: tracked.wait,
      callOrder: tracked.callOrder, bypasses: bypasses[tracked.id] || 0, cappedBypasses: cappedBypasses[tracked.id] || 0,
      servedAfterCutoff: tracked.start > cutoff + EPS
    } : null
  };
}

// The comparison rows: [key, label, value(metrics), lowerIsBetter (null: not a quality measure), unit].
// Capacity measures differ only by when the last consultations end, so a gap under 1% is a tie.
const RELATIVE_TIE = { throughput: 0.01, utilization: 0.01, makespan: 0.01 };
const METRIC_ROWS = [
  ["completed", "Patients completed", (m) => m.completed, null, "count"],
  ["avgWait", "Average wait — all patients", (m) => m.overall.avg, true, "min"],
  ["p95Wait", "95th-percentile wait — all patients", (m) => m.overall.p95, true, "min"],
  ["maxWait", "Maximum wait — all patients", (m) => m.overall.max, true, "min"],
  ["regularAvg", "Average wait — Regular", (m) => m.regular.avg, true, "min"],
  ["regularP95", "95th-percentile wait — Regular", (m) => m.regular.p95, true, "min"],
  ["regularMax", "Maximum wait — Regular", (m) => m.regular.max, true, "min"],
  ["vulnerableAvg", "Average wait — Vulnerable", (m) => m.vulnerable.avg, true, "min"],
  ["vulnerableP95", "95th-percentile wait — Vulnerable", (m) => m.vulnerable.p95, true, "min"],
  ["vulnerableMax", "Maximum wait — Vulnerable", (m) => m.vulnerable.max, true, "min"],
  ["regularBypasses", "Regular bypasses (a later registration called while a Regular waited)", (m) => m.regularBypasses, true, "count"],
  ["maxRegularBypasses", "Most bypasses of a single Regular patient", (m) => m.maxRegularBypasses, true, "count"],
  ["regularCappedBypasses", `Regular bypasses after ${CAP_MINUTES} min of waiting (Aging bonus at its +${AGING_MAX_BONUS} cap)`, (m) => m.regularCappedBypasses, true, "count"],
  ["laneViolations", "Priority-lane violations (Regular called while a Senior/PWD/Pregnant patient waited)", (m) => m.laneViolations, true, "count"],
  ["priorityInversions", "Calls of a lower base score while a higher one waited", (m) => m.priorityInversions, null, "count"],
  ["stillWaitingRegular", "Regular patients still waiting when registrations stopped", (m) => m.stillWaitingAtCutoff.regular, true, "count"],
  ["starvationRegular", `Regular patients with starvation evidence (every call in the last ${STARVATION_WINDOW} min of arrivals bypassed them)`, (m) => m.starvation.regular.length, true, "count"],
  ["throughput", "Throughput (patients per hour until the queue emptied)", (m) => m.throughputPerHour, false, "rate"],
  ["utilization", "Mean utilization of the three doctors", (m) => m.meanUtilization, false, "pct"],
  ["makespan", "Time to finish the whole workload", (m) => m.makespan, true, "min"]
];

function formatValue(value, unit) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (unit === "min") return `${value.toFixed(1)} min`;
  if (unit === "rate") return value.toFixed(2);
  if (unit === "pct") return `${(value * 100).toFixed(1)}%`;
  return String(value);
}

// "better" compares the values as displayed, so a difference too small to show is a tie.
function compareMetrics(metrics) {
  return METRIC_ROWS.map(([key, label, pick, lowerIsBetter, unit]) => {
    const values = ALGORITHM_IDS.map((a) => pick(metrics[a]));
    const shown = values.map((v) => formatValue(v, unit));
    const material = !RELATIVE_TIE[key] || Math.abs(values[0] - values[1]) >= RELATIVE_TIE[key] * Math.max(Math.abs(values[0]), Math.abs(values[1]));
    let better = null;
    if (lowerIsBetter != null && values.every((v) => v != null && Number.isFinite(v)) && shown[0] !== shown[1] && material) {
      better = (values[0] < values[1]) === lowerIsBetter ? ALGORITHM_IDS[0] : ALGORITHM_IDS[1];
    }
    return { key, label, values, shown, unit, lowerIsBetter, better };
  });
}

// How differently the two algorithms ordered the same patients.
function compareOrder(timelines) {
  const [a, b] = ALGORITHM_IDS.map((id) => Object.fromEntries(timelines[id].patients.map((p) => [p.id, p])));
  const patients = timelines[ALGORITHM_IDS[0]].patients;
  const shifts = patients.map((p) => Math.abs(a[p.id].callOrder - b[p.id].callOrder));
  const meanPosition = (map, vulnerable) => average(patients.filter((p) => p.vulnerable === vulnerable).map((p) => map[p.id].callOrder));
  // Pairs in which a Regular who registered later was called before a Vulnerable patient.
  const regularAhead = (map) => {
    let pairs = 0;
    for (const v of patients.filter((p) => p.vulnerable)) {
      for (const r of patients.filter((p) => !p.vulnerable)) if (r.arrival > v.arrival && map[r.id].callOrder < map[v.id].callOrder) pairs += 1;
    }
    return pairs;
  };
  const maps = { [ALGORITHM_IDS[0]]: a, [ALGORITHM_IDS[1]]: b };
  return {
    sameOrder: shifts.every((s) => s === 0), positionsChanged: shifts.filter((s) => s > 0).length, meanShift: average(shifts),
    meanPosition: Object.fromEntries(ALGORITHM_IDS.map((id) => [id, { regular: meanPosition(maps[id], false), vulnerable: meanPosition(maps[id], true) }])),
    laterRegularAheadOfVulnerable: Object.fromEntries(ALGORITHM_IDS.map((id) => [id, regularAhead(maps[id])]))
  };
}

// Both timelines must come from one workload: same registrations, classifications and consultations.
function sameWorkload(timelines) {
  const key = (tl) => JSON.stringify(tl.patients.map((p) => [p.id, p.arrival, p.created_at, p.flags, p.base, p.service, p.consultation]));
  const [a, b] = ALGORITHM_IDS.map((id) => timelines[id]);
  return key(a) === key(b) && JSON.stringify(a.doctors) === JSON.stringify(b.doctors);
}

// The evaluation criteria, in order of importance. No overall winner is declared from them.
const CRITERIA = [
  { id: "lane", importance: "Primary", label: "Priority-lane protection of Vulnerable patients",
    metrics: ["laneViolations", "vulnerableAvg", "vulnerableP95", "vulnerableMax"],
    why: "The office's priority policy puts Senior, PWD and Pregnant patients ahead of Regular patients; a call that breaks it is visible to patients and staff." },
  { id: "bounded", importance: "Primary", label: "Bounded waiting for Regular patients (no starvation)",
    metrics: ["regularMax", "regularP95", "maxRegularBypasses", "starvationRegular"],
    why: "A Regular patient must eventually be seen even on a day with many Vulnerable registrations." },
  { id: "average", importance: "Secondary", label: "Average waiting time",
    metrics: ["avgWait", "regularAvg"],
    why: "Matters for overall satisfaction, but averages can hide a few very long waits." },
  { id: "capacity", importance: "Context", label: "Throughput and doctor utilization",
    metrics: ["throughput", "utilization", "makespan"],
    why: "Both algorithms keep every free doctor busy whenever someone waits, so these are expected to match; a difference only reflects which consultation lengths ended last." }
];

function criterionResult(rows, criterion) {
  const wins = Object.fromEntries(ALGORITHM_IDS.map((a) => [a, 0]));
  for (const row of rows.filter((r) => criterion.metrics.includes(r.key) && r.better)) wins[row.better] += 1;
  const [a, b] = ALGORITHM_IDS;
  const leader = wins[a] === wins[b] ? null : wins[a] > wins[b] ? a : b;
  return { ...criterion, wins, leader };
}

const min = (v) => (v == null ? "—" : `${v.toFixed(1)} min`);

// Plain-language findings for one run, every number taken from the metrics above.
function findings({ metrics, rows, ordering, profile }) {
  const [A, B] = ALGORITHM_IDS;
  const wa = metrics[A], wr = metrics[B];
  const lines = [];
  if (profile.overloadedHours.length) {
    const peak = Math.max(...profile.hourly.map((h) => h.load));
    lines.push(`Registrations exceeded what three doctors can see in ${profile.overloadedHours.length} hour(s) (starting ${profile.overloadedHours.map((h) => `${String(8 + h).padStart(2, "0")}:00`).join(", ")}; peak load ${peak.toFixed(2)} × capacity), so a queue built up.`);
  } else lines.push(`Registrations never exceeded the three doctors' hourly capacity (peak load ${Math.max(...profile.hourly.map((h) => h.load)).toFixed(2)} × capacity).`);
  if (ordering.sameOrder) {
    lines.push("Both algorithms called every patient in the same order, so every waiting-time result is identical: in this workload WRR's rotation never had to choose differently from WPS-A.");
  } else {
    lines.push(`The two algorithms called ${ordering.positionsChanged} of ${wa.patients} patients at a different position (mean shift ${ordering.meanShift.toFixed(1)} places).`);
    lines.push(`Regular patients: average ${min(wa.regular.avg)} under WPS-A vs ${min(wr.regular.avg)} under WRR; longest ${min(wa.regular.max)} vs ${min(wr.regular.max)}.`);
    lines.push(`Vulnerable patients: average ${min(wa.vulnerable.avg)} under WPS-A vs ${min(wr.vulnerable.avg)} under WRR; longest ${min(wa.vulnerable.max)} vs ${min(wr.vulnerable.max)}.`);
  }
  lines.push(`Priority-lane violations: WPS-A ${wa.laneViolations}, WRR ${wr.laneViolations}. ` +
    (wr.laneViolations ? "WRR gives the Regular class its turn even while Senior/PWD/Pregnant patients wait." : "WRR did not need to call a Regular ahead of a waiting Senior/PWD/Pregnant patient in this run."));
  lines.push(`Aging cap: ${wa.regularsPastCap} Regular patient(s) waited ${CAP_MINUTES} minutes or more under WPS-A (bonus capped at +${AGING_MAX_BONUS}); they were bypassed ${wa.regularCappedBypasses} more time(s) after reaching the cap. ` +
    "A Regular's effective priority stops at 3, so it can never pass a waiting Senior, PWD or Pregnant patient; the cap limits reordering, not waiting time.");
  if (wa.starvation.regular.length || wr.starvation.regular.length) {
    lines.push(`Starvation evidence (still waiting when registrations stopped, bypassed by every call in the last ${STARVATION_WINDOW} minutes of arrivals): WPS-A ${wa.starvation.regular.length} Regular patient(s), WRR ${wr.starvation.regular.length}.`);
  } else if (wa.stillWaitingAtCutoff.regular || wr.stillWaitingAtCutoff.regular) {
    lines.push(`Regular patients still waiting when registrations stopped: WPS-A ${wa.stillWaitingAtCutoff.regular}, WRR ${wr.stillWaitingAtCutoff.regular}. None meets the starvation-evidence rule; all were served as the queue drained.`);
  }
  if (wa.tracked) {
    lines.push(`Followed Regular ${wa.tracked.ticket}: called ${ordinal(wa.tracked.callOrder)} after ${min(wa.tracked.wait)} and ${wa.tracked.bypasses} bypass(es) under WPS-A; ` +
      `${ordinal(wr.tracked.callOrder)} after ${min(wr.tracked.wait)} and ${wr.tracked.bypasses} bypass(es) under WRR.`);
  }
  lines.push(`Throughput ${formatValue(wa.throughputPerHour, "rate")} vs ${formatValue(wr.throughputPerHour, "rate")} patients/hour and mean utilization ${formatValue(wa.meanUtilization, "pct")} vs ${formatValue(wr.meanUtilization, "pct")}: both algorithms keep every free doctor busy, so capacity is not what separates them.`);
  return { lines, criteria: CRITERIA.map((c) => criterionResult(rows, c)) };
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

function analyzeExperiment(timelines) {
  if (!sameWorkload(timelines)) throw new Error("WPS-A and WRR must serve the identical workload");
  const first = timelines[ALGORITHM_IDS[0]];
  const metrics = Object.fromEntries(ALGORITHM_IDS.map((a) => [a, experimentMetrics(timelines[a])]));
  const rows = compareMetrics(metrics);
  const ordering = compareOrder(timelines);
  const result = { scenario: first.scenario, seed: first.seed, count: first.count, profile: first.profile, metrics, rows, ordering };
  return { ...result, findings: findings(result) };
}

function runExperiment({ scenario, seed, count }) {
  return analyzeExperiment(Object.fromEntries(ALGORITHM_IDS.map((algorithm) => [algorithm, buildTimeline({ scenario, seed, count, algorithm })])));
}

// One experiment over consecutive seeds: mean ± 95% CI of every comparison row, and in how many
// seeds each algorithm was better on it.
function replicate({ scenario, count, baseSeed, replications }) {
  const runs = Array.from({ length: replications }, (_, i) => runExperiment({ scenario, count, seed: baseSeed + i }));
  const rows = METRIC_ROWS.map(([key, label, , lowerIsBetter, unit], index) => ({
    key, label, unit, lowerIsBetter,
    summary: Object.fromEntries(ALGORITHM_IDS.map((a, i) => [a, summarize(runs.map((r) => r.rows[index].values[i]))])),
    better: Object.fromEntries([...ALGORITHM_IDS, "tie"].map((a) => [a, runs.filter((r) => (r.rows[index].better || "tie") === a).length]))
  }));
  const byGroup = Object.fromEntries(GROUPS.map((g) => [g, Object.fromEntries(ALGORITHM_IDS.map((a) => [a, {
    avg: summarize(runs.map((r) => r.metrics[a].byGroup[g]?.avg)), max: summarize(runs.map((r) => r.metrics[a].byGroup[g]?.max))
  }]))]).filter(([, v]) => v[ALGORITHM_IDS[0]].avg != null));
  return {
    scenario, count, baseSeed, replications, rows, byGroup,
    sameOrderRuns: runs.filter((r) => r.ordering.sameOrder).length,
    overloadedRuns: runs.filter((r) => r.profile.overloadedHours.length).length,
    offeredLoad: summarize(runs.map((r) => r.profile.offeredLoad)),
    laterRegularAheadOfVulnerable: Object.fromEntries(ALGORITHM_IDS.map((a) => [a, summarize(runs.map((r) => r.ordering.laterRegularAheadOfVulnerable[a]))]))
  };
}

module.exports = {
  ALGORITHM_IDS, CRITERIA, METRIC_ROWS, GROUP_LABELS, STARVATION_WINDOW, STARVATION_MIN_CALLS, CAP_MINUTES,
  experimentMetrics, compareMetrics, compareOrder, sameWorkload, analyzeExperiment, runExperiment, replicate, formatValue, findings
};
