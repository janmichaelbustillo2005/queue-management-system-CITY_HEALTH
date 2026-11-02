// Research simulation (backend/simulation): reproducibility, conservation and policy mechanics.
const assert = require("node:assert/strict");
const test = require("node:test");
const { generateWorkload, runSimulation, wpsPolicy } = require("../simulation/engine");
const { POLICIES, wrrPolicy } = require("../simulation/policies");
const { SCENARIOS } = require("../simulation/scenarios");
const { dayMetrics, percentile, jain } = require("../simulation/metrics");
const { runAll } = require("../simulation/run");

const patient = (id, score, arrival, serviceTime = 10) => ({ id, priority_score: score, arrival, serviceTime, doctor: "Doctor 1",
  flags: score === 1 ? [] : score === 4 ? ["senior"] : score === 3 ? ["pwd"] : ["indigenous"],
  group: score === 1 ? "regular" : score === 4 ? "senior" : score === 3 ? "pwd" : "indigenous",
  created_at: new Date(Date.parse("2026-01-05T00:00:00.000Z") + arrival * 60000).toISOString() });

test("the same seed gives the same workload and the same results", () => {
  const a = generateWorkload(SCENARIOS["medium-volume"], 7);
  const b = generateWorkload(SCENARIOS["medium-volume"], 7);
  assert.deepEqual(a, b);
  assert.notDeepEqual(generateWorkload(SCENARIOS["medium-volume"], 8), a);
  assert.deepEqual(JSON.stringify(runAll({ replications: 2, baseSeed: 5 })), JSON.stringify(runAll({ replications: 2, baseSeed: 5 })));
});

test("every policy serves every patient exactly once, never before arrival, one at a time per doctor", () => {
  const workload = generateWorkload(SCENARIOS["high-volume"], 11);
  for (const [name, makePolicy] of Object.entries(POLICIES)) {
    const { served, busy, makespan } = runSimulation(workload, makePolicy);
    assert.deepEqual(served.map((p) => p.id).sort((x, y) => x - y), workload.map((p) => p.id).sort((x, y) => x - y), name);
    for (const p of served) assert.ok(p.start >= p.arrival - 1e-9 && p.wait >= 0);
    for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) {
      const own = served.filter((p) => p.doctor === doctor).sort((x, y) => x.start - y.start);
      for (let i = 1; i < own.length; i += 1) assert.ok(own[i].start >= own[i - 1].end - 1e-9, `${name} ${doctor} overlaps`);
      assert.ok(busy[doctor] <= makespan + 1e-9);
    }
    // Work-conserving: identical service times mean identical doctor busy time under every policy.
    assert.equal(Math.round(Object.values(busy).reduce((s, v) => s + v, 0)), Math.round(workload.reduce((s, p) => s + p.serviceTime, 0)));
  }
});

test("original WPS never serves a lower score while a higher one waits; WPS-A serves a 20-minute Regular before a new Indigenous", () => {
  const workload = generateWorkload(SCENARIOS["priority-surge"], 3);
  assert.equal(runSimulation(workload, POLICIES["WPS (original)"]).inversions.anyBase, 0);
  // Doctor busy until minute 25 with the first patient; then Regular (arrived 1) vs Indigenous (arrived 24).
  const rows = [patient(1, 1, 0, 25), patient(2, 1, 1), patient(3, 2, 24)];
  const order = (policy) => runSimulation(rows, policy).served.map((p) => p.id);
  assert.deepEqual(order(wpsPolicy(false)), [1, 3, 2]);
  assert.deepEqual(order(wpsPolicy(true)), [1, 2, 3]);
});

test("WRR: highest class first, up to its weight per turn, first come first served inside a class", () => {
  // All present at the start (first patient occupies the doctor so the rest queue up).
  const rows = [patient(1, 1, 0, 1), ...[2, 3, 4, 5, 6].map((id) => patient(id, 4, 0.1 + id / 100)),
    patient(7, 1, 0.2), patient(8, 1, 0.3), patient(9, 3, 0.4)];
  const served = runSimulation(rows, wrrPolicy).served.map((p) => p.id);
  // Seniors (weight 4) send 4, then PWD (3) sends its 1, then Regular (1) sends 1, then Seniors again.
  assert.deepEqual(served, [1, 2, 3, 4, 5, 9, 7, 6, 8]);
});

test("metrics: percentile, Jain index and per-group summaries", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([0, 10], 95), 9.5);
  assert.equal(jain([5, 5, 5]), 1);
  assert.ok(Math.abs(jain([0, 0, 9]) - 1 / 3) < 1e-12);
  const m = dayMetrics(runSimulation([patient(1, 1, 0), patient(2, 4, 1)], POLICIES["WPS (original)"]));
  assert.equal(m.patients, 2);
  assert.equal(m.byGroup.senior.avgWait, 9);
  assert.equal(m.byGroup.regular.avgWait, 0);
});

test("shared dispatch (D1 Model A): every patient once, no doctor overlap, any free doctor takes the head", () => {
  const workload = generateWorkload(SCENARIOS["unequal-workload"], 17);
  for (const [name, makePolicy] of Object.entries(POLICIES)) {
    const { served } = runSimulation(workload, makePolicy, { dispatch: "shared" });
    assert.equal(served.length, workload.length, name);
    assert.equal(new Set(served.map((p) => p.id)).size, workload.length);
    for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) {
      const own = served.filter((p) => p.servedBy === doctor).sort((x, y) => x.start - y.start);
      for (let i = 1; i < own.length; i += 1) assert.ok(own[i].start >= own[i - 1].end - 1e-9, `${name} ${doctor} overlaps`);
    }
    assert.ok(new Set(served.filter((p) => p.service === "consultation").map((p) => p.servedBy)).size > 1,
      `${name}: consultations are spread over general doctors`);
  }
  assert.equal(runSimulation(workload, POLICIES["WPS (original)"], { dispatch: "shared" }).inversions.anyBase, 0,
    "WPS never serves a lower score while a higher one waits in the shared queue");
  // Three consultations arriving together go to three different free doctors at once.
  const together = [patient(1, 1, 0), patient(2, 4, 0), patient(3, 3, 0)];
  const served = runSimulation(together, POLICIES["WPS (original)"], { dispatch: "shared" }).served;
  assert.deepEqual(served.map((p) => [p.id, p.start]), [[2, 0], [3, 0], [1, 0]]);
  assert.equal(new Set(served.map((p) => p.servedBy)).size, 3);
  assert.throws(() => runSimulation(together, POLICIES["WPS (original)"], { dispatch: "other" }), /Unknown dispatch/);
});

test("I1: every policy and dispatch mode sees identical patients, service times and doctor availability", () => {
  const { DOCTORS } = require("../simulation/engine");
  for (const scenario of Object.values(SCENARIOS)) {
    const workload = generateWorkload(scenario, 20261029);
    const expected = new Map(workload.map((p) => [p.id, p.serviceTime]));
    const totalWork = workload.reduce((sum, p) => sum + p.serviceTime, 0);
    for (const [name, makePolicy] of Object.entries(POLICIES)) {
      for (const dispatch of ["service", "shared"]) {
        const { served, busy } = runSimulation(workload, makePolicy, { dispatch });
        assert.equal(served.length, workload.length, `${name} ${dispatch}`);
        for (const p of served) assert.equal(p.serviceTime, expected.get(p.id), "service time is fixed by the workload");
        assert.ok(Math.abs(DOCTORS.reduce((sum, d) => sum + busy[d], 0) - totalWork) < 1e-6, "same total doctor time");
        if (dispatch === "shared") {
          // All three doctors are available all day: whenever a patient has to wait, every doctor is busy.
          for (const p of served.filter((q) => q.wait > 1e-9)) {
            for (const d of DOCTORS) {
              assert.ok(served.some((q) => q.servedBy === d && q.start <= p.arrival && q.end > p.arrival), `${name}: ${d} idle while ${p.id} waited`);
            }
          }
        }
      }
    }
  }
});
