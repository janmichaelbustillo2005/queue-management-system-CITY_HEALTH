// Visual simulation timeline (backend/simulation/visual.js) for the Algorithm Simulation page:
// it reproduces the research engine exactly, is deterministic, gives both algorithms the same
// workload, explains each call truthfully, and stays offline (no database, API or env).
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { POLICIES } = require("../simulation/policies");
const { generateWorkload, runSimulation } = require("../simulation/engine");
const { SCENARIOS } = require("../simulation/scenarios");
const { dayMetrics } = require("../simulation/metrics");
const { runAll, DISPATCH_MODES } = require("../simulation/run");
const { agingBonus, compareWps } = require("../src/lib/wpsPriority");
const { buildTimeline, snapshotAt, nextEventTime, highlightTimes, queueLengthSeries, clock } = require("../simulation/visual");

const [, WPS_A, WRR] = Object.keys(POLICIES);
const POLICY = { "WPS-A": WPS_A, WRR };
const SEEDS = [20261029, 20261030, 7];
const RESULTS = path.join(__dirname, "../../docs/research/simulation-results-20261030");
const close = (a, b) => Math.abs(a - b) < 1e-9;

test("the timeline reproduces the engine's shared-queue day exactly for every scenario", () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    for (const seed of SEEDS) {
      for (const algorithm of ["WPS-A", "WRR"]) {
        const tl = buildTimeline({ scenario, seed, algorithm });
        const run = runSimulation(generateWorkload(SCENARIOS[scenario], seed), POLICIES[POLICY[algorithm]], { dispatch: "shared" });
        const key = `${scenario}/${seed}/${algorithm}`;
        assert.deepEqual(tl.decisions.map((d) => [d.patientId, d.doctor, d.start, d.end, d.wait]),
          run.served.map((p) => [p.id, p.servedBy, p.start, p.end, p.wait]), key);
        assert.deepEqual(tl.metrics, dayMetrics(run), key);
        assert.equal(tl.end, run.makespan, key);
      }
    }
  }
});

test("the same scenario and seed always give the same timeline; another seed gives another day", () => {
  for (const algorithm of ["WPS-A", "WRR"]) {
    const a = JSON.stringify(buildTimeline({ scenario: "priority-surge", seed: 20261029, algorithm }));
    assert.equal(JSON.stringify(buildTimeline({ scenario: "priority-surge", seed: 20261029, algorithm })), a, algorithm);
    assert.notEqual(JSON.stringify(buildTimeline({ scenario: "priority-surge", seed: 20261030, algorithm })), a, algorithm);
  }
});

test("WPS-A and WRR receive identical patients, registration times, consultation lengths and three doctors", () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    const [a, b] = ["WPS-A", "WRR"].map((algorithm) => buildTimeline({ scenario, seed: 20261029, algorithm }));
    const workload = (tl) => tl.patients.map((p) => [p.id, p.arrival, p.created_at, p.consultation, p.base, p.flags.join("+"), p.service]);
    assert.deepEqual(workload(a), workload(b), scenario);
    assert.deepEqual(a.doctors, ["Doctor 1", "Doctor 2", "Doctor 3"]);
    assert.deepEqual(b.doctors, a.doctors);
  }
});

test("the Algorithm Simulation's inspect() addition leaves every committed simulation result unchanged", () => {
  const committed = JSON.parse(fs.readFileSync(path.join(RESULTS, "results.json"), "utf8"));
  const byMode = Object.fromEntries(DISPATCH_MODES.map((dispatch) => [dispatch, runAll({ replications: committed.replications, baseSeed: committed.baseSeed, dispatch })]));
  assert.deepEqual(JSON.parse(JSON.stringify(byMode)), committed.byMode);
});

test("WPS-A calls the top of the production ranking, and the reason names the Aging bonus truthfully", () => {
  const tl = buildTimeline({ scenario: "long-waits", seed: 20261029, algorithm: "WPS-A" });
  const byId = Object.fromEntries(tl.patients.map((p) => [p.id, { ...p, priority_score: p.base }]));
  for (const d of tl.decisions) {
    const rankedAt = tl.epoch + d.now * 60000;
    const ranked = d.waitingIds.map((id) => byId[id]).sort((a, b) => compareWps(a, b, rankedAt, true));
    assert.equal(ranked[0].id, d.patientId);
    assert.deepEqual(d.ranking, ranked.map((p) => p.id));
    const original = d.waitingIds.map((id) => byId[id]).sort((a, b) => compareWps(a, b, rankedAt, false))[0];
    assert.equal(d.agingOvertake, original.id !== d.patientId);
    const p = byId[d.patientId], bonus = agingBonus(p.created_at, rankedAt, true);
    assert.match(d.reason[0], new RegExp(`base score ${p.base} \\+ Aging bonus ${bonus} .*= effective score ${p.base + bonus}`));
    assert.equal(d.regularOverProtected, false, "WPS-A never calls a Regular while a protected patient waits");
  }
  // The committed sample trace: at 09:55:04 Doctor 1 calls P032 Regular (1 → 3) over the new P053 Indigenous (2).
  const call = tl.decisions.find((d) => clock(d.now) === "09:55:04");
  assert.equal(call.patientId, 32);
  assert.equal(call.doctor, "Doctor 1");
  assert.equal(call.agingOvertake, true);
  assert.match(call.reason.join(" "), /without the bonus \(original WPS\) P053 Indigenous, base 2, would have been called first/);
});

test("the timeline's calls match the committed sample trace for WPS-A and WRR", () => {
  const sample = JSON.parse(fs.readFileSync(path.join(RESULTS, "sample-trace.json"), "utf8"));
  for (const algorithm of ["WPS-A", "WRR"]) {
    const tl = buildTimeline({ scenario: sample.scenario, seed: sample.seed, algorithm });
    const committed = sample.decisions[algorithm];
    const ours = tl.decisions.filter((d) => committed.some((c) => close(c.now, d.now) && c.doctor === d.doctor));
    assert.deepEqual(ours.map((d) => [d.patientId, d.doctor]), committed.map((c) => [c.chosen, c.doctor]), algorithm);
  }
});

test("WRR follows its weighted rotation: skipped classes were empty or spent, and the class serves its earliest arrival", () => {
  for (const scenario of ["long-waits", "priority-surge"]) {
    const tl = buildTimeline({ scenario, seed: 20261029, algorithm: "WRR" });
    const byId = Object.fromEntries(tl.patients.map((p) => [p.id, p]));
    for (const d of tl.decisions) {
      const { visited, order, current, credit } = d.rotation;
      const served = visited[visited.length - 1];
      assert.equal(served.weight, byId[d.patientId].base);
      assert.ok(served.waiting > 0 && served.credit > 0);
      assert.equal(current, served.weight);
      assert.equal(credit, served.credit - 1);
      for (const step of visited.slice(0, -1)) assert.ok(step.waiting === 0 || step.credit === 0, "a class is passed over only when empty or spent");
      assert.deepEqual(order, order.slice().sort((a, b) => b - a), "classes rotate from the highest weight down");
      const sameClass = d.waitingIds.map((id) => byId[id]).filter((p) => p.base === served.weight);
      assert.equal(Math.min(...sameClass.map((p) => p.arrival)), byId[d.patientId].arrival, "first come, first served inside the class");
      assert.equal(d.reason.some((r) => r.startsWith("Priority-lane violation")), d.regularOverProtected);
    }
    assert.equal(tl.decisions.filter((d) => d.regularOverProtected).length, tl.metrics.regularBeforeProtected, scenario);
  }
});

test("snapshots: every patient is in exactly one state, doctors serve one at a time, the bonus follows the 10-minute rule", () => {
  for (const algorithm of ["WPS-A", "WRR"]) {
    const tl = buildTimeline({ scenario: "high-volume", seed: 20261029, algorithm });
    for (let t = 0; t <= tl.end + 1; t += 7.5) {
      const s = snapshotAt(tl, t);
      const serving = s.doctors.filter((d) => d.serving).length;
      const done = s.doctors.reduce((sum, d) => sum + d.completed, 0);
      const notArrived = tl.patients.filter((p) => p.arrival > t).length;
      assert.equal(s.waiting.length + serving + done + notArrived, tl.patients.length, `${algorithm} at ${t}`);
      assert.equal(s.metrics.completed, done);
      for (const d of s.doctors) {
        assert.equal(d.status, d.serving ? "Serving" : "Available");
        if (d.serving) assert.ok(d.progress >= 0 && d.progress <= 1);
      }
      for (const w of s.waiting) {
        const steps = w.waited / 10;   // skip the instant of a 10-minute boundary (registration times are whole milliseconds)
        if (Math.abs(steps - Math.round(steps)) > 1e-6) {
          assert.equal(w.bonus, algorithm === "WPS-A" ? Math.min(2, Math.floor(steps)) : 0, `bonus of ${w.ticket} at ${t}`);
        }
        assert.equal(w.effective, w.base + w.bonus);
      }
    }
  }
});

test("at the end of the day the live metrics equal the research metrics", () => {
  for (const algorithm of ["WPS-A", "WRR"]) {
    const tl = buildTimeline({ scenario: "unequal-workload", seed: 20261030, algorithm });
    const m = snapshotAt(tl, tl.end).metrics;
    assert.equal(m.completed, tl.metrics.patients);
    assert.equal(m.waiting, 0);
    for (const key of ["avgWait", "p95Wait", "maxWait", "jainFairness"]) assert.ok(close(m[key], tl.metrics[key]), key);
    for (const doctor of tl.doctors) assert.ok(close(m.utilization[doctor], tl.metrics.utilization[doctor]), doctor);
    assert.equal(m.regularBeforeProtected, tl.metrics.regularBeforeProtected);
    assert.equal(m.lowerScoreFirst, tl.metrics.priorityInversions);
  }
});

test("stepping visits every event in order, and the highlights and queue series agree with the timeline", () => {
  const tl = buildTimeline({ scenario: "low-volume", seed: 20261029, algorithm: "WRR" });
  const times = [];
  for (let t = nextEventTime([tl], -1); t != null; t = nextEventTime([tl], t)) times.push(t);
  assert.deepEqual(times, [...new Set(tl.events.map((e) => e.t))]);
  assert.deepEqual(highlightTimes(tl), tl.decisions.filter((d) => d.lowerScoreFirst).map((d) => d.now));
  const series = queueLengthSeries(tl);
  assert.equal(series.length, Math.ceil(tl.end) + 1);
  assert.equal(series[60], snapshotAt(tl, 60).waiting.length);
});

test("bad input is refused with a clear message", () => {
  assert.throws(() => buildTimeline({ algorithm: "FIFO" }), /Unknown algorithm/);
  assert.throws(() => buildTimeline({ algorithm: "WRR", scenario: "nope" }), /Unknown scenario/);
  assert.throws(() => buildTimeline({ algorithm: "WRR", seed: -1 }), /seed/);
});

test("the simulator used by the page is offline: no database, API, file system or environment access", () => {
  const files = ["simulation/visual.js", "simulation/engine.js", "simulation/policies.js", "simulation/scenarios.js", "simulation/metrics.js", "src/lib/wpsPriority.js"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    for (const r of requires) assert.ok(/^\.\.?\//.test(r), `${file} requires only local simulator modules, not ${r}`);
    assert.doesNotMatch(source, /supabase|process\.env|fetch\(|XMLHttpRequest/i, file);
  }
});
