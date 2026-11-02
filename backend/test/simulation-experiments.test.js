// Regular/Vulnerable experiments (backend/simulation/experiment-scenarios.js, experiments.js) for
// the Algorithm Simulation page and the Chapter IV report: exact patient mixes, staggered
// registrations, identical workloads for WPS-A and WRR, the production WPS-A rule at 0, 10 and
// 20+ minutes, WRR's class turns, the controlled early-Regular case, starvation under sustained
// arrivals, metrics recomputed from the simulated events, and reproducibility by seed.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { WEIGHTS, priorityScore, runSimulation } = require("../simulation/engine");
const { POLICIES } = require("../simulation/policies");
const {
  EXPERIMENTS, DEFAULT_COUNT, CONTROLLED, generateExperimentWorkload, workloadProfile, apportion, VULNERABLE_MIX
} = require("../simulation/experiment-scenarios");
const { runExperiment, analyzeExperiment, experimentMetrics, sameWorkload, STARVATION_WINDOW } = require("../simulation/experiments");
const { buildTimeline, clock } = require("../simulation/visual");
const { buildReport, toMarkdown } = require("../simulation/experiment-report");
const wpsPriority = require("../src/lib/wpsPriority");

const SEED = 20261029;
const SEEDS = [SEED, 20261030, 7];
const MIX = ["regular-majority", "vulnerable-majority"];
const ALL = Object.keys(EXPERIMENTS);
const both = (scenario, seed = SEED, count = DEFAULT_COUNT) =>
  Object.fromEntries(["WPS-A", "WRR"].map((algorithm) => [algorithm, buildTimeline({ scenario, seed, count, algorithm })]));
const close = (a, b) => Math.abs(a - b) < 1e-9;
const RESULTS = path.join(__dirname, "../../docs/research/experiment-results-20261102");

test("Scenario A is exactly 80% Regular / 20% Vulnerable and Scenario B the reverse, at any patient count", () => {
  for (const count of [DEFAULT_COUNT, 150, 37]) {
    for (const [scenario, share] of [["regular-majority", 0.8], ["vulnerable-majority", 0.2]]) {
      for (const seed of SEEDS) {
        const workload = generateExperimentWorkload(scenario, { seed, count });
        assert.equal(workload.length, count);
        assert.equal(workload.filter((p) => !p.flags.length).length, Math.round(count * share), `${scenario} ${count} ${seed}`);
      }
    }
  }
  const b = generateExperimentWorkload("vulnerable-majority", { seed: SEED, count: 100 });
  const groups = new Set(b.filter((p) => p.flags.length).map((p) => p.flags.join("+")));
  for (const g of ["senior", "pwd", "pregnant", "indigenous", "solo_parent", "senior+pwd", "pregnant+solo_parent"]) assert.ok(groups.has(g), g);
  // Scenario A's 20 Vulnerable patients by largest remainder over the assumed mix.
  const tally = (list) => list.reduce((t, f) => ({ ...t, [f.join("+")]: (t[f.join("+")] || 0) + 1 }), {});
  assert.deepEqual(tally(apportion(20, VULNERABLE_MIX)), { senior: 7, pwd: 3, pregnant: 3, indigenous: 2, solo_parent: 2, "senior+pwd": 2, "pregnant+solo_parent": 1 });
  assert.equal(apportion(80, VULNERABLE_MIX).length, 80);
});

test("base priority follows the live registration rule, cumulative classifications summed, Regular = 1", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/queueService.js"), "utf8");
  const block = /const VULNERABILITY_WEIGHTS = \{([^}]+)\}/.exec(source)[1];
  const live = Object.fromEntries([...block.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(WEIGHTS, live, "the simulator uses the live weights");
  assert.match(source, /return score === 0 \? 1 : score;/, "Regular base 1 in the live rule");
  for (const scenario of ALL) {
    for (const p of generateExperimentWorkload(scenario, { seed: SEED, count: 60 })) {
      assert.equal(p.priority_score, p.flags.length ? p.flags.reduce((s, f) => s + live[f], 0) : 1, `${scenario} ${p.flags}`);
      for (const flag of p.flags) assert.ok(Object.hasOwn(live, flag), `approved classification ${flag}`);
      assert.ok(!(p.flags.includes("senior") && p.flags.includes("pregnant")), "no Senior + Pregnant combination");
    }
  }
  assert.equal(priorityScore(["senior", "pwd"]), 7);
  assert.equal(priorityScore(["solo_parent"]), 1, "a Solo Parent alone has the same base as a Regular patient");
});

test("registrations are staggered through the day, not all at once", () => {
  for (const scenario of MIX) {
    const workload = generateExperimentWorkload(scenario, { seed: SEED, count: 100 });
    const arrivals = workload.map((p) => p.arrival);
    assert.deepEqual(arrivals, arrivals.slice().sort((a, b) => a - b));
    assert.ok(arrivals[0] >= 0 && arrivals[arrivals.length - 1] < 8 * 60);
    assert.equal(new Set(workload.map((p) => p.created_at)).size, 100, "no two patients register at the same instant");
    const perHour = workloadProfile(workload).hourly.map((h) => h.arrivals);
    assert.ok(Math.max(...perHour) < 30 && perHour.filter((n) => n > 0).length === 8, `${perHour}`);
    assert.ok(perHour[0] + perHour[1] > perHour[6] + perHour[7], "a morning peak");
  }
  const stress = generateExperimentWorkload("sustained-arrivals", { seed: SEED, count: 100 });
  const stream = stress.slice(10).map((p) => p.arrival);
  assert.ok(stream.every((t, i) => i === 0 || t >= stream[i - 1]));
  assert.ok(close(workloadProfile(stress).lastArrival, stream[stream.length - 1]));
});

test("WPS-A and WRR receive the identical workload, three doctors and the same dispatch mode", () => {
  for (const scenario of ALL) {
    for (const seed of SEEDS) {
      const timelines = both(scenario, seed);
      assert.ok(sameWorkload(timelines), `${scenario} ${seed}`);
      assert.deepEqual(timelines["WPS-A"].doctors, ["Doctor 1", "Doctor 2", "Doctor 3"]);
      const busy = (tl) => tl.patients.reduce((s, p) => s + (p.end - p.start), 0);
      assert.ok(close(busy(timelines["WPS-A"]), busy(timelines.WRR)), "same total consultation time");
      for (const tl of Object.values(timelines)) {
        assert.equal(tl.patients.length, tl.decisions.length, "every patient is called exactly once");
        const run = runSimulation(generateExperimentWorkload(scenario, { seed, count: DEFAULT_COUNT }),
          POLICIES[tl.policyName], { dispatch: "shared" });
        assert.deepEqual(tl.decisions.map((d) => [d.patientId, d.doctor, d.start]), run.served.map((p) => [p.id, p.servedBy, p.start]),
          "the page timeline is the unchanged engine in shared dispatch");
      }
    }
  }
  assert.throws(() => analyzeExperiment({ "WPS-A": both("regular-majority")["WPS-A"], WRR: both("regular-majority", 7).WRR }), /identical workload/);
});

test("WPS-A: effective priority = base + min(2, floor(waited / 10 min)) at 0, 10 and 20+ minutes, recalculated at every call", () => {
  const T0 = Date.parse("2026-01-05T08:00:00.000Z");
  const at = (minutes) => new Date(T0 - minutes * 60000).toISOString();
  for (const [waited, bonus] of [[0, 0], [9.99, 0], [10, 1], [19.99, 1], [20, 2], [45, 2], [240, 2]]) {
    assert.equal(wpsPriority.agingBonus(at(waited), T0, true), bonus, `${waited} min`);
    assert.equal(wpsPriority.effectivePriority({ priority_score: 3, created_at: at(waited) }, T0, true), 3 + bonus);
  }
  // The controlled Regular (P004, registered 08:01) at each call while it waits: +0 at 08:00 (not
  // yet registered), +1 at 08:20 (19 min), +2 from 08:30 (29 min) on; its effective priority stops at 3.
  const tl = both("early-regular")["WPS-A"];
  const regular = tl.patients.find((p) => p.id === 4);
  const seen = tl.decisions.filter((d) => d.waitingIds.includes(4) || d.patientId === 4).map((d) => {
    const bonus = wpsPriority.agingBonus(regular.created_at, tl.epoch + d.now * 60000, true);
    return `${clock(d.now)} waited ${(d.now - regular.arrival).toFixed(0)} +${bonus}=${regular.base + bonus}`;
  });
  assert.deepEqual([...new Set(seen)], ["08:20:00 waited 19 +1=2", "08:30:00 waited 29 +2=3", "08:40:00 waited 39 +2=3", "08:50:00 waited 49 +2=3"]);
  const first = tl.decisions[0];
  assert.deepEqual(first.rankingDetail.map((r) => r.bonus), [0, 0, 0], "no bonus at 0 minutes");
  for (const scenario of ["vulnerable-majority", "sustained-arrivals"]) {
    for (const d of both(scenario)["WPS-A"].decisions) {
      for (const r of d.rankingDetail) {
        const steps = r.waited / 10;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) assert.equal(r.bonus, Math.min(2, Math.floor(steps)));
        assert.equal(r.effective, r.base + r.bonus);
      }
      assert.equal(d.rankingDetail[0].id, d.patientId, "the patient called is the top of the recalculated ranking");
      const ranks = d.rankingDetail;
      for (let i = 1; i < ranks.length; i += 1) {
        assert.ok(ranks[i - 1].effective > ranks[i].effective || (ranks[i - 1].effective === ranks[i].effective && ranks[i - 1].base >= ranks[i].base),
          "ties go to the higher base, then the earlier registration");
      }
    }
  }
});

test("the experiments rank with the production WPS-A function, which matches the PostgreSQL call functions", () => {
  const visual = fs.readFileSync(path.join(__dirname, "../simulation/visual.js"), "utf8");
  const engine = fs.readFileSync(path.join(__dirname, "../simulation/engine.js"), "utf8");
  assert.match(engine, /require\("\.\.\/src\/lib\/wpsPriority"\)/);
  assert.match(visual, /require\("\.\.\/src\/lib\/wpsPriority"\)/);
  assert.equal(wpsPriority.AGING_STEP_MS, 600000);
  assert.equal(wpsPriority.AGING_MAX_BONUS, 2);
  for (const file of ["20261029-wps-a-call-aging.sql", "20261029-d1a-shared-wps-a-call.sql"]) {
    const sql = fs.readFileSync(path.join(__dirname, "../scripts", file), "utf8");
    assert.match(sql, /ORDER BY COALESCE\(w\.priority_score, 0\) \+ LEAST\(2, GREATEST\(0, pg_catalog\.floor\(\s*EXTRACT\(EPOCH FROM \(pg_catalog\.date_trunc\('milliseconds', p_ranked_at\)\s*- pg_catalog\.date_trunc\('milliseconds', w\.created_at\)\)\) \/ 600\)\)\)::INTEGER DESC,\s*COALESCE\(w\.priority_score, 0\) DESC,\s*pg_catalog\.date_trunc\('milliseconds', w\.created_at\) ASC, w\.id ASC/, file);
  }
});

test("controlled case: one early Regular before nine Vulnerable patients", () => {
  const timelines = both("early-regular");
  const r = analyzeExperiment(timelines);
  const order = (tl) => tl.decisions.map((d) => tl.patients.find((p) => p.id === d.patientId)).filter((p) => p.role !== "warm-up");
  const wpsA = order(timelines["WPS-A"]);
  // WPS-A: every Vulnerable here has base 2 or more; the Regular's 1 + 2 never passes them (ties go to the higher base).
  assert.equal(wpsA[wpsA.length - 1].id, 4, "WPS-A calls the early Regular last");
  assert.equal(r.metrics["WPS-A"].tracked.wait, 49);
  assert.equal(r.metrics["WPS-A"].tracked.bypasses, CONTROLLED.vulnerable.length);
  assert.equal(r.metrics["WPS-A"].laneViolations, 0);
  // WRR: one turn per class from the highest weight; the Regular class gets its turn before the last PWD/Pregnant.
  const wrr = order(timelines.WRR);
  assert.deepEqual(wrr.map((p) => p.base), [7, 4, 4, 4, 3, 3, 3, 2, 1, 3]);
  assert.equal(r.metrics.WRR.tracked.wait, 39);
  assert.equal(r.metrics.WRR.tracked.callOrder, 12);
  assert.equal(r.metrics.WRR.laneViolations, 1);
  assert.equal(generateExperimentWorkload("early-regular", { seed: 1 }).length, 13);
  assert.deepEqual(generateExperimentWorkload("early-regular", { seed: 1 }), generateExperimentWorkload("early-regular", { seed: 99 }), "nothing in it is random");
});

test("WRR selects by class turn: the highest class first, at most its weight per turn, first come first served inside it", () => {
  const tl = both("early-regular").WRR;
  const turns = tl.decisions.slice(3).map((d) => `${d.turn.number}:w${d.turn.weight} ${d.turn.call}/${d.turn.of}`);
  // Turns 1-3 are the warm-up Regulars at opening; from 08:20 each class takes one turn, highest first.
  assert.deepEqual(turns, ["4:w7 1/7", "5:w4 1/4", "5:w4 2/4", "5:w4 3/4", "6:w3 1/3", "6:w3 2/3", "6:w3 3/3", "7:w2 1/2", "8:w1 1/1", "9:w3 1/3"]);
  for (const scenario of ["vulnerable-majority", "sustained-arrivals"]) {
    const wrr = both(scenario).WRR;
    const byId = Object.fromEntries(wrr.patients.map((p) => [p.id, p]));
    for (const d of wrr.decisions) {
      assert.equal(d.turn.weight, byId[d.patientId].base);
      assert.ok(d.turn.call >= 1 && d.turn.call <= d.turn.of);
      const sameClass = d.waitingIds.map((id) => byId[id]).filter((p) => p.base === d.turn.weight);
      assert.equal(Math.min(...sameClass.map((p) => p.arrival)), byId[d.patientId].arrival);
    }
  }
});

test("stress: sustained higher-priority arrivals starve Regular patients under WPS-A, not under WRR", () => {
  for (const seed of SEEDS) {
    const r = runExperiment({ scenario: "sustained-arrivals", seed, count: DEFAULT_COUNT });
    const [a, w] = [r.metrics["WPS-A"], r.metrics.WRR];
    assert.ok(r.profile.offeredLoad > 1, "arrivals exceed the doctors' capacity");
    assert.ok(r.profile.overloadedHours.length >= 2);
    assert.ok(a.starvation.regular.length > 0, `WPS-A starvation evidence for seed ${seed}`);
    assert.equal(w.starvation.regular.length, 0, `no WRR starvation evidence for seed ${seed}`);
    assert.ok(a.stillWaitingAtCutoff.regular >= a.starvation.regular.length, "starvation evidence is a subset of still waiting");
    assert.equal(a.completed, DEFAULT_COUNT, "the queue still drains: still waiting is not the same as never served");
    assert.equal(a.laneViolations, 0);
    assert.ok(w.laneViolations > 0, "WRR's fairness costs priority-lane violations");
    assert.ok(w.regular.max < a.regular.max && w.vulnerable.avg > a.vulnerable.avg);
    // Why WPS-A starves them: every call in the window went to a later registration with base 3 or more,
    // which a capped Regular (1 + 2 = 3, ties to the higher base) can never pass.
    const tl = buildTimeline({ scenario: "sustained-arrivals", seed, algorithm: "WPS-A" });
    const byTicket = Object.fromEntries(tl.patients.map((p) => [p.ticket, p]));
    const byId = Object.fromEntries(tl.patients.map((p) => [p.id, p]));
    for (const ticket of a.starvation.regular) {
      const p = byTicket[ticket];
      assert.ok(tl.cutoff - p.arrival >= STARVATION_WINDOW);
      for (const d of tl.decisions.filter((x) => x.now > tl.cutoff - STARVATION_WINDOW && x.now <= tl.cutoff)) {
        assert.ok(byId[d.patientId].base >= 3 && byId[d.patientId].arrival > p.arrival);
      }
    }
  }
});

test("the metrics are recomputed from the simulated events", () => {
  for (const scenario of ALL) {
    const timelines = both(scenario);
    for (const [algorithm, tl] of Object.entries(timelines)) {
      const m = experimentMetrics(tl);
      const regular = tl.patients.filter((p) => !p.flags.length);
      const waits = regular.map((p) => p.start - p.arrival);
      assert.ok(close(m.regular.avg, waits.reduce((s, v) => s + v, 0) / waits.length), `${scenario} ${algorithm}`);
      assert.ok(close(m.regular.max, Math.max(...waits)));
      assert.ok(close(m.overall.avg, tl.metrics.avgWait) && close(m.overall.p95, tl.metrics.p95Wait) && close(m.overall.max, tl.metrics.maxWait));
      assert.ok(close(m.throughputPerHour, tl.metrics.throughputPerHour));
      for (const d of tl.doctors) assert.ok(close(m.utilization[d], tl.metrics.utilization[d]));
      assert.equal(m.laneViolations, tl.metrics.regularBeforeProtected);
      assert.equal(m.priorityInversions, tl.metrics.priorityInversions);
      // A bypass: a call went to a later registration while a Regular waited.
      let bypasses = 0;
      const byId = Object.fromEntries(tl.patients.map((p) => [p.id, p]));
      for (const d of tl.decisions) {
        const chosen = byId[d.patientId];
        bypasses += d.waitingIds.map((id) => byId[id]).filter((p) => !p.flags.length && p.id !== chosen.id && (p.arrival < chosen.arrival || (p.arrival === chosen.arrival && p.id < chosen.id))).length;
      }
      assert.equal(m.regularBypasses, bypasses);
      assert.equal(m.completed, tl.patients.length);
    }
  }
});

test("the same seed and count give the same workload and results; another seed gives another workload", () => {
  for (const scenario of [...MIX, "sustained-arrivals"]) {
    const a = JSON.stringify(runExperiment({ scenario, seed: SEED, count: 120 }));
    assert.equal(JSON.stringify(runExperiment({ scenario, seed: SEED, count: 120 })), a, scenario);
    assert.notEqual(JSON.stringify(runExperiment({ scenario, seed: SEED + 1, count: 120 })), a, scenario);
    assert.deepEqual(generateExperimentWorkload(scenario, { seed: 5, count: 80 }), generateExperimentWorkload(scenario, { seed: 5, count: 80 }));
  }
});

test("bad experiment input is refused with a clear message", () => {
  assert.throws(() => generateExperimentWorkload("nope", { seed: 1 }), /Unknown experiment/);
  assert.throws(() => generateExperimentWorkload("regular-majority", { seed: 1, count: 5 }), /from 20 to 400/);
  assert.throws(() => generateExperimentWorkload("regular-majority", { seed: 1, count: 12.5 }), /whole number/);
  assert.throws(() => generateExperimentWorkload("regular-majority", { seed: -2 }), /seed/);
});

test("the committed experiment report is reproduced byte for byte from its seeds", () => {
  const committed = JSON.parse(fs.readFileSync(path.join(RESULTS, "experiment-results.json"), "utf8"));
  const report = buildReport({ replications: committed.replications, baseSeed: committed.baseSeed });
  assert.equal(JSON.stringify(report, null, 1), JSON.stringify(committed, null, 1));
  // Git may check the file out with CRLF line endings on Windows; the content is what must match.
  assert.equal(toMarkdown(report), fs.readFileSync(path.join(RESULTS, "experiment-results.md"), "utf8").replace(/\r\n/g, "\n"));
});

test("the experiment modules used by the page are offline: no database, API, file system or environment access", () => {
  for (const file of ["simulation/experiment-scenarios.js", "simulation/experiments.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    for (const r of requires) assert.ok(/^\.\.?\//.test(r), `${file} requires only local simulator modules, not ${r}`);
    assert.doesNotMatch(source, /supabase|process\.env|fetch\(|XMLHttpRequest/i, file);
  }
});
