// Research simulation report (backend/simulation/report.js): the trace is faithful to the engine,
// paired effects are computed per seed, and the written report is reproducible.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runAll, DISPATCH_MODES } = require("../simulation/run");
const { POLICIES } = require("../simulation/policies");
const { generateWorkload, runSimulation } = require("../simulation/engine");
const { SCENARIOS } = require("../simulation/scenarios");
const { writeReport, pairedEffects, headToHead, sampleTrace, traceDay } = require("../simulation/report");

const [WPS, WPS_A, WRR] = Object.keys(POLICIES);

test("the trace observes the engine without changing it: same served order, times and doctors", () => {
  for (const policy of [WPS, WPS_A, WRR]) {
    const { decisions } = traceDay("long-waits", 20261029, policy);
    const { served } = runSimulation(generateWorkload(SCENARIOS["long-waits"], 20261029), POLICIES[policy], { dispatch: "shared" });
    assert.deepEqual(decisions.map((d) => [d.patient.id, d.doctor, d.start, d.end]), served.map((p) => [p.id, p.servedBy, p.start, p.end]), policy);
    for (const d of decisions) assert.ok(d.waiting.some((w) => w.id === d.patient.id), "the called patient was waiting");
  }
});

test("the sample window shows WPS-A choosing differently from WPS, and every policy sees the same arrivals", () => {
  const trace = sampleTrace("long-waits", 20261029);
  const inWindow = (policy) => trace.days[policy].decisions.filter((d) => d.now >= trace.from && d.now < trace.to).map((d) => d.patient.id);
  assert.notDeepEqual(inWindow(WPS_A), inWindow(WPS));
  const wpsA = trace.days[WPS_A].decisions.find((d) => d.now >= trace.from && d.waiting.some((w) => w.effective > w.base));
  assert.ok(wpsA, "an aging bonus is visible in the window");
  for (const d of trace.days[WPS_A].decisions) for (const w of d.waiting) assert.ok(w.effective - w.base >= 0 && w.effective - w.base <= 2);
});

test("paired effects are per-seed differences on identical workloads", () => {
  const byMode = Object.fromEntries(DISPATCH_MODES.map((dispatch) => [dispatch, runAll({ replications: 3, baseSeed: 9, dispatch })]));
  const effects = pairedEffects(byMode);
  const s = "priority-surge";
  const expected = byMode.shared[s].policies[WRR].replications.map((day, i) => day.maxWait - byMode.shared[s].policies[WPS].replications[i].maxWait);
  assert.ok(Math.abs(effects.wrrShared.rows[s].maxWait.mean - expected.reduce((a, b) => a + b, 0) / 3) < 1e-9);
  assert.equal(effects.wrrShared.rows[s].maxWait.n, 3);
});

test("the written report is reproducible byte for byte", () => {
  const dirs = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "sim-report-")));
  try {
    for (const dir of dirs) {
      const byMode = Object.fromEntries(DISPATCH_MODES.map((dispatch) => [dispatch, runAll({ replications: 2, baseSeed: 20261029, dispatch })]));
      fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ replications: 2, baseSeed: 20261029, byMode }, null, 1));
      writeReport(dir);
    }
    const files = ["tables.md", "paired-effects.md", "head-to-head.md", "per-replication.csv", "sample-trace.md", "sample-trace.json", "charts/wait-max.svg", "charts/effects-policy-only.svg", "charts/head-to-head-wrr-vs-wpsa.svg"];
    for (const file of files) assert.equal(fs.readFileSync(path.join(dirs[0], file), "utf8"), fs.readFileSync(path.join(dirs[1], file), "utf8"), file);
    assert.equal(fs.readFileSync(path.join(dirs[0], "per-replication.csv"), "utf8").trim().split("\n").length, 1 + 2 * 6 * 3 * 2);
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("head to head: WRR − WPS-A per seed, and the priority-lane rule passes WPS and WPS-A on every day", () => {
  const byMode = Object.fromEntries(DISPATCH_MODES.map((dispatch) => [dispatch, runAll({ replications: 3, baseSeed: 9, dispatch })]));
  const h2h = headToHead(byMode);
  const s = "long-waits";
  const wrr = byMode.shared[s].policies[WRR].replications, wpsa = byMode.shared[s].policies[WPS_A].replications;
  const expected = wrr.map((day, i) => day.maxWait - wpsa[i].maxWait).reduce((a, b) => a + b, 0) / 3;
  assert.ok(Math.abs(h2h.rows.shared[s].maxWait.mean - expected) < 1e-9);
  for (const mode of DISPATCH_MODES) {
    for (const policy of ["WPS", "WPS-A"]) assert.equal(h2h.compliance[mode][policy].compliantDays, h2h.compliance[mode][policy].days, `${mode} ${policy}`);
    const days = Object.values(byMode[mode]).flatMap(({ policies }) => policies[WRR].replications);
    assert.equal(h2h.compliance[mode].WRR.compliantDays, days.filter((d) => d.regularBeforeProtected === 0).length);
  }
});
