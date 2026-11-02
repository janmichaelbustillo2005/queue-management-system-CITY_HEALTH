// Visual simulation timeline for the Superadmin Algorithm Simulation page (research only; never
// the live queue, Call Now or the database). Like report.js's trace, it reruns the unchanged
// engine on one seeded workload in the shared queue (three general doctors) with an observing
// wrapper around the policy, then adds what the page shows: each call's ranking with the Aging
// bonus, WRR's class turns, a plain-language reason and the priority-rule checks. snapshotAt()
// reads the state at any simulated minute; at the end of the day its metrics equal dayMetrics().
// The page offers the Regular/Vulnerable experiments (experiment-scenarios.js); the earlier
// research scenarios (scenarios.js) still build here so the committed evidence stays reproducible.
// Pure functions without Node built-ins, so the same module runs in the browser.
const { generateWorkload, runSimulation, DOCTORS, PROTECTED } = require("./engine");
const { POLICIES } = require("./policies");
const { SCENARIOS } = require("./scenarios");
const { EXPERIMENTS, DEFAULT_COUNT, generateExperimentWorkload, workloadProfile } = require("./experiment-scenarios");
const { dayMetrics, percentile, jain } = require("./metrics");
const { AGING_STEP_MS, AGING_MAX_BONUS, agingBonus, compareWps } = require("../src/lib/wpsPriority");

const [WPS, WPS_A, WRR] = Object.keys(POLICIES);
const ALGORITHMS = { "WPS-A": WPS_A, WRR };
const DEFAULT_SCENARIO = "regular-majority";
const DEFAULT_SEED = 20261029;
const MINUTE_MS = 60 * 1000;
const AGING_STEP_MINUTES = AGING_STEP_MS / MINUTE_MS;
const GROUP_LABEL = { senior: "Senior", pwd: "PWD", pregnant: "Pregnant", indigenous: "Indigenous", solo_parent: "Solo parent", regular: "Regular" };

const clock = (minutes) => {
  const total = Math.round((8 * 60 + minutes) * 60);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
const ticket = (p) => `P${String(p.id).padStart(3, "0")}`;
const category = (p) => (p.flags.length ? p.flags.map((f) => GROUP_LABEL[f]).join(" + ") : GROUP_LABEL.regular);
const label = (p) => `${ticket(p)} ${category(p)}`;
const minutes = (value) => `${value.toFixed(1)} min`;
const isProtected = (p) => p.flags.some((f) => PROTECTED.includes(f));
const byArrival = (a, b) => a.arrival - b.arrival || a.id - b.id;
// WRR has no ranking of its own between calls; the page lists its classes highest weight first.
const byClass = (a, b) => b.priority_score - a.priority_score || byArrival(a, b);
const RANKING_ROWS = 6;

function explainWpsA(chosen, waiting, rankedAt, now) {
  const row = (p) => ({ bonus: agingBonus(p.created_at, rankedAt, true), base: p.priority_score });
  const ranked = waiting.slice().sort((a, b) => compareWps(a, b, rankedAt, true));
  if (ranked[0].id !== chosen.id) throw new Error("WPS-A trace does not match the production ranking");
  const c = row(chosen);
  const capped = now - chosen.arrival >= AGING_MAX_BONUS * AGING_STEP_MINUTES ? `, capped at +${AGING_MAX_BONUS}` : "";
  const reason = [`${label(chosen)} waited ${minutes(now - chosen.arrival)}: base score ${c.base} + Aging bonus ${c.bonus} ` +
    `(+1 per full ${AGING_STEP_MINUTES} minutes waited${capped}) = effective score ${c.base + c.bonus}.`];
  const next = ranked[1];
  if (!next) reason.push("It was the only patient waiting.");
  else {
    const n = row(next);
    if (c.base + c.bonus > n.base + n.bonus) reason.push(`Highest effective score: ${c.base + c.bonus} beats the next patient, ${label(next)}, at ${n.base + n.bonus} (base ${n.base} + bonus ${n.bonus}).`);
    else if (c.base > n.base) reason.push(`Tied at effective score ${c.base + c.bonus} with ${label(next)}; the higher base score wins the tie (${c.base} vs ${n.base}), so a protected category stays ahead.`);
    else if (chosen.arrival < next.arrival) reason.push(`Tied on effective and base score with ${label(next)}; the earlier registration (${clock(chosen.arrival)}) is called first.`);
    else reason.push(`Tied with ${label(next)} on score and registration time; the lower ticket number is called first.`);
  }
  const withoutAging = waiting.slice().sort((a, b) => compareWps(a, b, rankedAt, false))[0];
  const agingOvertake = withoutAging.id !== chosen.id;
  if (agingOvertake) reason.push(`Aging changed this call: without the bonus (original WPS) ${label(withoutAging)}, base ${withoutAging.priority_score}, would have been called first.`);
  // The ranking recalculated at this call, top rows first, as the page shows it.
  const rankingDetail = ranked.slice(0, RANKING_ROWS).map((p, i) => {
    const r = row(p);
    return { id: p.id, position: i + 1, base: r.base, bonus: r.bonus, effective: r.base + r.bonus, waited: now - p.arrival };
  });
  return { ranking: ranked.map((p) => p.id), reason, agingOvertake, rankingDetail };
}

function explainWrr(chosen, waiting, turn) {
  const classes = turn.order.map((w) => `w${w} (${w} per turn)`).join(" → ");
  const reason = [`Weighted rotation: ${classes}; the weight is the priority score, and inside a class patients are served first come, first served.`];
  for (const step of turn.visited.slice(0, -1)) {
    reason.push(step.waiting === 0 ? `Class w${step.weight} had nobody waiting, so its turn was skipped.`
      : `Class w${step.weight} had used its ${step.weight} call${step.weight === 1 ? "" : "s"} this turn, so the rotation moved on.`);
  }
  const last = turn.visited[turn.visited.length - 1];
  reason.push(`Class w${last.weight} had ${last.waiting} waiting and ${last.credit} of ${last.weight} call${last.weight === 1 ? "" : "s"} left: ` +
    `it serves its earliest registration, ${label(chosen)} (${clock(chosen.arrival)}). ${turn.credit} call${turn.credit === 1 ? "" : "s"} left for w${last.weight}.`);
  const higher = waiting.filter((p) => p.priority_score > chosen.priority_score).length;
  if (higher) reason.push(`${higher} patient${higher === 1 ? "" : "s"} with a higher score ${higher === 1 ? "was" : "were"} waiting; WRR gives lower classes regular turns instead of always serving the highest score.`);
  return { ranking: waiting.slice().sort(byClass).map((p) => p.id), reason, rotation: turn };
}

// One algorithm's seeded day. The workload depends only on scenario, seed and patient count, so
// WPS-A and WRR built with the same arguments see identical patients, consultation lengths and
// three doctors. `count` applies to the experiments; the research scenarios ignore it.
function buildTimeline({ scenario = DEFAULT_SCENARIO, seed = DEFAULT_SEED, count = DEFAULT_COUNT, algorithm }) {
  const policyName = ALGORITHMS[algorithm];
  if (!policyName) throw new Error(`Unknown algorithm ${algorithm}; use ${Object.keys(ALGORITHMS).join(" or ")}`);
  const experiment = EXPERIMENTS[scenario];
  if (!experiment && !SCENARIOS[scenario]) throw new Error(`Unknown scenario ${scenario}`);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("The seed must be a whole number of 0 or more");
  const workload = experiment ? generateExperimentWorkload(scenario, { seed, count }) : generateWorkload(SCENARIOS[scenario], seed);
  if (!workload.length) throw new Error("This scenario and seed produced no patients");
  const epoch = Date.parse(workload[0].created_at) - workload[0].arrival * MINUTE_MS;
  const log = [];
  const make = (key) => {
    const inner = POLICIES[policyName](key);
    return {
      select(waiting, now) {
        const queue = waiting.slice();   // the engine removes the chosen patient afterwards
        const chosen = inner.select(waiting, now);
        log.push({ now, chosen, queue, turn: inner.inspect?.() });
        return chosen;
      }
    };
  };
  const run = runSimulation(workload, make, { dispatch: "shared" });
  if (run.served.length !== log.length || run.served.some((p, i) => p.id !== log[i].chosen.id)) throw new Error("trace does not match the served order");

  let turnNumber = 0;
  const decisions = run.served.map((p, index) => {
    const { now, chosen, queue, turn } = log[index];
    const rankedAt = epoch + now * MINUTE_MS;
    const explained = algorithm === "WPS-A" ? explainWpsA(chosen, queue, rankedAt, now) : explainWrr(chosen, queue, turn);
    if (turn) {
      // A class turn starts at the first call and whenever the rotation had to move on.
      if (index === 0 || turn.visited.length > 1) turnNumber += 1;
      explained.turn = { number: turnNumber, weight: turn.current, call: turn.current - turn.credit, of: turn.current };
    }
    // Patients who registered before the one called and are left waiting: this call overtook them.
    const overtaken = queue.filter((w) => byArrival(w, chosen) < 0);
    const regularOverProtected = chosen.group === "regular" && queue.some(isProtected);
    if (regularOverProtected) {
      explained.reason.push(`Priority-lane violation: a Regular patient was called while ${queue.filter(isProtected).length} Senior/PWD/Pregnant patient(s) waited.`);
    }
    return {
      index, now, doctor: p.servedBy, patientId: p.id, start: p.start, end: p.end, wait: p.wait,
      waitingIds: queue.map((w) => w.id), regularOverProtected,
      overtakenIds: overtaken.map((w) => w.id), overtakenRegular: overtaken.filter((w) => !w.flags.length).length,
      lowerScoreFirst: chosen.priority_score < Math.max(...queue.map((w) => w.priority_score)),
      ...explained
    };
  });
  const served = Object.fromEntries(run.served.map((p) => [p.id, p]));
  const callOrder = Object.fromEntries(run.served.map((p, i) => [p.id, i + 1]));
  const patients = workload.map((p) => ({
    id: p.id, ticket: ticket(p), category: category(p), group: p.group, flags: p.flags, service: p.service,
    vulnerable: p.flags.length > 0, role: p.role || null,
    base: p.priority_score, arrival: p.arrival, consultation: p.serviceTime, created_at: p.created_at,
    doctor: served[p.id].servedBy, start: served[p.id].start, end: served[p.id].end, wait: served[p.id].wait, callOrder: callOrder[p.id]
  }));
  const events = [
    ...patients.map((p) => ({ t: p.arrival, kind: "arrival", patientId: p.id })),
    ...decisions.map((d) => ({ t: d.start, kind: "call", patientId: d.patientId, doctor: d.doctor, decision: d.index })),
    ...patients.map((p) => ({ t: p.end, kind: "complete", patientId: p.id, doctor: p.doctor }))
  ].sort((a, b) => a.t - b.t || ["complete", "arrival", "call"].indexOf(a.kind) - ["complete", "arrival", "call"].indexOf(b.kind) || a.patientId - b.patientId);
  // cutoff: the last registration, after which the queue only drains.
  const profile = workloadProfile(workload);
  return {
    algorithm, policyName, scenario, description: (experiment || SCENARIOS[scenario]).description, seed, count: workload.length,
    epoch, doctors: DOCTORS, patients, decisions, events, end: run.makespan, cutoff: profile.lastArrival, profile, metrics: dayMetrics(run)
  };
}

// The state at simulated minute t: who is waiting (with the Aging bonus as of t), what each
// doctor is doing, and the metrics of everything called or completed so far.
function snapshotAt(timeline, t) {
  const { patients, decisions, doctors, algorithm, epoch } = timeline;
  const rankedAt = epoch + t * MINUTE_MS;
  const aging = algorithm === "WPS-A";
  const queue = patients.filter((p) => p.arrival <= t && p.start > t);
  const sorted = queue.map((p) => ({ ...p, priority_score: p.base }))
    .sort(aging ? (a, b) => compareWps(a, b, rankedAt, true) : byClass);
  const waiting = sorted.map((p, i) => {
    const bonus = aging ? agingBonus(p.created_at, rankedAt, true) : 0;
    return { ...p, order: i + 1, bonus, effective: p.base + bonus, waited: t - p.arrival };
  });
  const called = patients.filter((p) => p.start <= t);
  const completed = called.filter((p) => p.end <= t);
  const doctorStates = doctors.map((name) => {
    const mine = called.filter((p) => p.doctor === name);
    const serving = mine.find((p) => p.end > t) || null;
    const busy = mine.reduce((sum, p) => sum + Math.min(p.end, t) - p.start, 0);
    return {
      name, status: serving ? "Serving" : "Available", serving,
      progress: serving ? (t - serving.start) / serving.consultation : null,
      completed: mine.filter((p) => p.end <= t).length,
      lastCompleted: mine.filter((p) => p.end <= t).sort((a, b) => b.end - a.end)[0] || null,
      utilization: t > 0 ? busy / t : 0
    };
  });
  const made = decisions.filter((d) => d.now <= t);
  const waits = called.map((p) => p.wait);
  const avgWait = (list) => (list.length ? list.reduce((s, p) => s + p.wait, 0) / list.length : null);
  return {
    t, clock: clock(t), waiting, doctors: doctorStates, latest: made[made.length - 1] || null,
    metrics: {
      arrived: patients.filter((p) => p.arrival <= t).length, waiting: waiting.length, called: called.length, completed: completed.length,
      avgWait: waits.length ? waits.reduce((s, v) => s + v, 0) / waits.length : null,
      p95Wait: percentile(waits, 95), maxWait: waits.length ? Math.max(...waits) : null,
      longestWaitingNow: waiting.length ? Math.max(...waiting.map((p) => p.waited)) : null,
      jainFairness: waits.length ? jain(waits) : null,
      utilization: Object.fromEntries(doctorStates.map((d) => [d.name, d.utilization])),
      regularBeforeProtected: made.filter((d) => d.regularOverProtected).length,
      lowerScoreFirst: made.filter((d) => d.lowerScoreFirst).length,
      agingOvertakes: made.filter((d) => d.agingOvertake).length,
      regularAvgWait: avgWait(called.filter((p) => !p.vulnerable)), vulnerableAvgWait: avgWait(called.filter((p) => p.vulnerable)),
      regularBypasses: made.reduce((s, d) => s + d.overtakenRegular, 0),
      regularWaiting: waiting.filter((p) => !p.vulnerable).length
    },
    finished: t >= timeline.end
  };
}

// The next event strictly after t, across one or more timelines (the comparison steps both).
function nextEventTime(timelines, t) {
  const next = Math.min(...timelines.flatMap((tl) => tl.events.filter((e) => e.t > t + 1e-9).slice(0, 1).map((e) => e.t)));
  return Number.isFinite(next) ? next : null;
}

// Calls worth pausing on: WPS-A calls the Aging bonus changed, and WRR calls where a lower class
// took its turn while a higher score waited.
function highlightTimes(timeline) {
  return timeline.decisions.filter((d) => (timeline.algorithm === "WPS-A" ? d.agingOvertake : d.lowerScoreFirst)).map((d) => d.now);
}

// Number of patients waiting at each whole minute, for the comparison chart.
function queueLengthSeries(timeline) {
  const length = Math.ceil(timeline.end);
  return Array.from({ length: length + 1 }, (_, m) => timeline.patients.filter((p) => p.arrival <= m && p.start > m).length);
}

// The page offers the experiments only; the research scenarios remain for the committed reports.
const SCENARIO_OPTIONS = Object.entries(EXPERIMENTS).map(([value, s]) => ({
  value, label: s.label, short: s.short, description: s.description, fixedCount: s.fixedCount || null
}));

module.exports = {
  ALGORITHMS, DEFAULT_SCENARIO, DEFAULT_SEED, DEFAULT_COUNT, SCENARIO_OPTIONS, AGING_STEP_MINUTES, AGING_MAX_BONUS,
  buildTimeline, snapshotAt, nextEventTime, highlightTimes, queueLengthSeries, clock
};
