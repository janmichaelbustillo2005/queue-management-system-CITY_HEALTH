// Research report for the scheduling simulation (not used by the live queue). Reads the
// results.json written by run.js and writes, next to it: comparison tables (tables.md), paired
// effects that separate queue structure from scheduling policy (paired-effects.md), every
// replication as CSV (per-replication.csv), SVG charts (charts/) and a step-by-step decision
// trace of one seeded day (sample-trace.md / .json). The trace reruns the unchanged engine on
// one workload with an observing wrapper around each policy; nothing here alters a result.
// Usage (from backend/): node simulation/report.js <resultsDir> [traceScenario] [traceSeed]
const fs = require("node:fs");
const path = require("node:path");
const { generateWorkload, runSimulation, DOCTORS } = require("./engine");
const { POLICIES } = require("./policies");
const { SCENARIOS } = require("./scenarios");
const { summarize } = require("./metrics");
const { effectivePriority } = require("../src/lib/wpsPriority");

const [WPS, WPS_A, WRR] = Object.keys(POLICIES);
const SHORT = { [WPS]: "WPS", [WPS_A]: "WPS-A", [WRR]: "WRR" };
const MODES = { service: "Service dispatch (legacy: fixed doctor per service)", shared: "Shared queue (D1 Model A: three general doctors)" };
const SCENARIO_LABEL = { "low-volume": "Low", "medium-volume": "Medium", "high-volume": "High", "priority-surge": "Surge", "unequal-workload": "Unequal", "long-waits": "Long waits" };
const GROUPS = ["senior", "pwd", "pregnant", "indigenous", "solo_parent", "multiple", "regular"];
const GROUP_LABEL = { senior: "Senior", pwd: "PWD", pregnant: "Pregnant", indigenous: "Indigenous", solo_parent: "Solo parent", multiple: "Multiple", regular: "Regular" };
const PROTECTED_GROUPS = ["senior", "pwd", "pregnant"];

const fixed = (v, d) => v.toFixed(d).replace(/^-(0\.?0*)$/, "$1");  // no "-0.0"
const f1 = (s, d = 1) => (s == null ? "–" : `${fixed(s.mean, d)} ± ${fixed(s.ci95, d)}`);
const clock = (minutes) => {
  const total = Math.round((8 * 60 + minutes) * 60);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
const label = (p) => `P${String(p.id).padStart(3, "0")} ${GROUP_LABEL[p.group]}`;

// ---------- paired effects ----------
// For each seed the two runs served the identical patients, so the per-seed difference isolates
// the change (queue structure or policy). Reported as mean ± 95% CI over the seeds, plus how
// many seeds improved (difference < 0).
const METRICS = { avgWait: "Average wait", p95Wait: "P95 wait", maxWait: "Maximum wait" };
function paired(byMode, [modeA, policyA], [modeB, policyB], scenario, metric) {
  const a = byMode[modeA][scenario].policies[policyA].replications;
  const b = byMode[modeB][scenario].policies[policyB].replications;
  const diffs = b.map((day, i) => day[metric] - a[i][metric]);
  return { ...summarize(diffs), improved: diffs.filter((d) => d < -1e-9).length, worse: diffs.filter((d) => d > 1e-9).length };
}
const COMPARISONS = [
  { key: "structure", title: "Queue structure: shared − service (both WPS)", a: ["service", WPS], b: ["shared", WPS] },
  { key: "wpsaShared", title: "Policy in the shared queue: WPS-A − WPS", a: ["shared", WPS], b: ["shared", WPS_A] },
  { key: "wrrShared", title: "Policy in the shared queue: WRR − WPS", a: ["shared", WPS], b: ["shared", WRR] },
  { key: "wpsaService", title: "Policy in service dispatch: WPS-A − WPS", a: ["service", WPS], b: ["service", WPS_A] },
  { key: "wrrService", title: "Policy in service dispatch: WRR − WPS", a: ["service", WPS], b: ["service", WRR] }
];
function pairedEffects(byMode) {
  const scenarios = Object.keys(byMode.shared);
  return Object.fromEntries(COMPARISONS.map((c) => [c.key, { ...c, rows: Object.fromEntries(scenarios.map((s) =>
    [s, Object.fromEntries(Object.keys(METRICS).map((m) => [m, paired(byMode, c.a, c.b, s, m)]))])) }]));
}
function pairedMarkdown(effects, { replications }) {
  const lines = ["# Paired effects: queue structure versus scheduling policy", "",
    `Each value is the per-seed difference (minutes) between two runs on the same ${replications} synthetic workloads, as mean ± 95% CI.`,
    "Negative means shorter waits. \"Better / worse seeds\" counts seeds where the change shortened / lengthened that wait.", ""];
  for (const { title, rows } of Object.values(effects)) {
    lines.push(`## ${title}`, "", "| Scenario | Average wait | P95 wait | Maximum wait | Better / worse seeds (max wait) |", "|---|---|---|---|---|");
    for (const [s, m] of Object.entries(rows)) {
      lines.push(`| ${s} | ${f1(m.avgWait)} | ${f1(m.p95Wait)} | ${f1(m.maxWait)} | ${m.maxWait.improved} / ${m.maxWait.worse} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- head to head: WRR versus WPS-A ----------
// The two candidate policies compared directly on the same seeds, plus a two-part decision rule:
// (1) priority-lane compliance: no Regular may be called while a Senior/PWD/Pregnant patient waits,
// on any simulated day; (2) among compliant policies, shorter worst-case waits are better.
const protectedMax = (day) => Math.max(0, ...PROTECTED_GROUPS.concat("multiple").map((g) => day.byGroup[g]?.maxWait ?? 0));
const HEAD_TO_HEAD_METRICS = {
  avgWait: { label: "Average wait (min)", pick: (day) => day.avgWait },
  p95Wait: { label: "P95 wait (min)", pick: (day) => day.p95Wait },
  maxWait: { label: "Maximum wait (min)", pick: (day) => day.maxWait },
  regularMax: { label: "Longest Regular wait (min)", pick: (day) => day.byGroup.regular?.maxWait ?? 0 },
  protectedMax: { label: "Longest Senior/PWD/Pregnant wait (min)", pick: protectedMax },
  regularBeforeProtected: { label: "Regular called while Senior/PWD/Pregnant waited (per day)", pick: (day) => day.regularBeforeProtected }
};
function headToHead(byMode) {
  const out = { rows: {}, compliance: {} };
  for (const mode of Object.keys(MODES)) {
    out.rows[mode] = Object.fromEntries(Object.entries(byMode[mode]).map(([s, { policies }]) => {
      const a = policies[WPS_A].replications, w = policies[WRR].replications;
      return [s, Object.fromEntries(Object.entries(HEAD_TO_HEAD_METRICS).map(([key, { pick }]) => {
        const diffs = w.map((day, i) => pick(day) - pick(a[i]));
        return [key, { ...summarize(diffs), wrrLower: diffs.filter((d) => d < -1e-9).length, wrrHigher: diffs.filter((d) => d > 1e-9).length }];
      }))];
    }));
    out.compliance[mode] = Object.fromEntries(Object.keys(POLICIES).map((p) => {
      const days = Object.values(byMode[mode]).flatMap(({ policies }) => policies[p].replications);
      return [SHORT[p], { days: days.length, compliantDays: days.filter((d) => d.regularBeforeProtected === 0).length }];
    }));
  }
  return out;
}
function headToHeadMarkdown(h2h, { replications }) {
  const lines = ["# Head to head: WRR versus WPS-A", "",
    `Per-seed difference WRR − WPS-A on the same ${replications} synthetic days per scenario (mean ± 95% CI). Negative = WRR lower.`,
    "\"WRR lower / higher\" counts the days on which WRR's value was lower / higher than WPS-A's.", "",
    "## Decision rule", "",
    "1. **Priority-lane compliance (must pass):** on no simulated day may a Regular patient be called while a Senior, PWD or",
    "   pregnant patient is waiting.",
    "2. **Then** prefer the compliant policy with the shorter P95 and maximum waits, especially for Regular patients.", "",
    "| Dispatch | Policy | Days with zero violations | Passes rule 1 |", "|---|---|---|---|"];
  for (const [mode, policies] of Object.entries(h2h.compliance)) for (const [p, c] of Object.entries(policies)) {
    lines.push(`| ${mode} | ${p} | ${c.compliantDays} of ${c.days} | ${c.compliantDays === c.days ? "yes" : "**no**"} |`);
  }
  for (const [mode, rows] of Object.entries(h2h.rows)) {
    lines.push("", `## ${MODES[mode]}`, "", `| Scenario | ${Object.values(HEAD_TO_HEAD_METRICS).map((m) => m.label).join(" | ")} |`,
      `|---|${Object.keys(HEAD_TO_HEAD_METRICS).map(() => "---").join("|")}|`);
    for (const [s, m] of Object.entries(rows)) {
      lines.push(`| ${s} | ${Object.keys(HEAD_TO_HEAD_METRICS).map((k) => `${f1(m[k])} <small>(${m[k].wrrLower}/${m[k].wrrHigher})</small>`).join(" | ")} |`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------- tables ----------
function tablesMarkdown(byMode, { replications, baseSeed }) {
  const lines = ["# Comparison tables", "",
    `Synthetic workloads only. ${replications} paired replications per scenario (seeds ${baseSeed}–${baseSeed + replications - 1}); every policy and both dispatch modes serve the identical patients for a seed. Values: mean ± 95% CI, minutes unless stated.`, ""];
  const scenarios = Object.keys(byMode.shared);
  const section = (title, header, row) => {
    lines.push(`## ${title}`, "", header, `|${header.split("|").slice(1, -1).map(() => "---").join("|")}|`);
    for (const s of scenarios) for (const mode of Object.keys(MODES)) for (const p of Object.keys(POLICIES)) {
      lines.push(`| ${s} | ${mode} | ${SHORT[p]} | ${row(byMode[mode][s].policies[p])} |`);
    }
    lines.push("");
  };
  section("Waiting time", "| Scenario | Dispatch | Policy | Average | P95 | Maximum | Waits > 60 min (count) |",
    (m) => [f1(m.avgWait), f1(m.p95Wait), f1(m.maxWait), f1(m.waitsOver60)].join(" | "));
  section("Average wait by priority group", `| Scenario | Dispatch | Policy | ${GROUPS.map((g) => GROUP_LABEL[g]).join(" | ")} |`,
    (m) => GROUPS.map((g) => f1(m.byGroup[g]?.avgWait)).join(" | "));
  section("Maximum wait by priority group", `| Scenario | Dispatch | Policy | ${GROUPS.map((g) => GROUP_LABEL[g]).join(" | ")} |`,
    (m) => GROUPS.map((g) => f1(m.byGroup[g]?.maxWait)).join(" | "));
  section("Throughput and doctor utilization", "| Scenario | Dispatch | Policy | Patients | Throughput /h | Day length (min) | Util. Doctor 1 | Util. Doctor 2 | Util. Doctor 3 |",
    (m) => [f1(m.patients), f1(m.throughputPerHour, 2), f1(m.makespanMinutes, 0), ...DOCTORS.map((d) => f1(m.utilization[d], 2))].join(" | "));
  section("Protected-priority ordering (decisions per day)", "| Scenario | Dispatch | Policy | Lower score served while higher waited | Regular served while Senior/PWD/Pregnant waited | Jain fairness |",
    (m) => [f1(m.priorityInversions), f1(m.regularBeforeProtected), f1(m.jainFairness, 3)].join(" | "));
  return lines.join("\n");
}

function perReplicationCsv(byMode, { baseSeed }) {
  const header = ["dispatch", "scenario", "policy", "seed", "patients", "avg_wait", "p95_wait", "max_wait", "waits_over_60", "waits_over_120",
    "throughput_per_hour", "day_minutes", ...DOCTORS.map((d) => `util_${d.replace(" ", "_").toLowerCase()}`), "lower_score_first", "regular_before_protected",
    "decisions", "jain", ...GROUPS.flatMap((g) => [`${g}_n`, `${g}_avg_wait`, `${g}_max_wait`])];
  const rows = [header.join(",")];
  const n = (v, d = 4) => (v == null ? "" : Number(v.toFixed(d)));
  for (const [mode, results] of Object.entries(byMode)) for (const [s, { policies }] of Object.entries(results)) {
    for (const [p, m] of Object.entries(policies)) m.replications.forEach((day, i) => rows.push([mode, s, SHORT[p], baseSeed + i, day.patients,
      n(day.avgWait), n(day.p95Wait), n(day.maxWait), day.starvation.over60, day.starvation.over120, n(day.throughputPerHour), n(day.makespanMinutes),
      ...DOCTORS.map((d) => n(day.utilization[d])), day.priorityInversions, day.regularBeforeProtected, day.decisions, n(day.jainFairness),
      ...GROUPS.flatMap((g) => [day.byGroup[g]?.n ?? 0, n(day.byGroup[g]?.avgWait), n(day.byGroup[g]?.maxWait)])].join(",")));
  }
  return rows.join("\n") + "\n";
}

// ---------- sample trace ----------
// Wraps a policy so every selection is recorded with the queue it saw. In shared dispatch there is
// one queue, so the n-th selection is the n-th served patient (checked below).
function traceDay(scenarioName, seed, policyName) {
  const workload = generateWorkload(SCENARIOS[scenarioName], seed);
  const epoch = Date.parse(workload[0].created_at) - workload[0].arrival * 60000;
  const aging = policyName === WPS_A;
  const log = [];
  const make = (key) => {
    const inner = POLICIES[policyName](key);
    return {
      select(waiting, now) {
        const chosen = inner.select(waiting, now);
        const rankedAt = epoch + now * 60000;
        log.push({ now, chosenId: chosen.id, waiting: waiting.map((p) => ({ id: p.id, group: p.group, service: p.service, arrival: p.arrival,
          base: p.priority_score, effective: policyName === WRR ? p.priority_score : effectivePriority(p, rankedAt, aging) })) });
        return chosen;
      }
    };
  };
  const { served } = runSimulation(workload, make, { dispatch: "shared" });
  if (served.length !== log.length || served.some((p, i) => p.id !== log[i].chosenId)) throw new Error("trace does not match the served order");
  return { workload, decisions: served.map((p, i) => ({ ...log[i], doctor: p.servedBy, start: p.start, end: p.end, wait: p.wait, patient: p })) };
}

// The window opens two decisions before the first call where WPS-A (aging) chooses a different
// patient from WPS, so ranking, the aging bonus and WRR's class turns are all visible.
function sampleTrace(scenarioName, seed, windowMinutes = 20) {
  const days = Object.fromEntries(Object.keys(POLICIES).map((p) => [p, traceDay(scenarioName, seed, p)]));
  const first = days[WPS_A].decisions.findIndex((d, i) => d.chosenId !== days[WPS].decisions[i].chosenId);
  const from = first < 0 ? 60 : days[WPS].decisions[Math.max(0, first - 2)].now;
  const to = from + windowMinutes;
  return { scenario: scenarioName, seed, dispatch: "shared", from, to, workload: days[WPS].workload, days };
}

function rankingCell(decision, policyName) {
  if (policyName === WRR) {
    const classes = {};
    for (const w of decision.waiting) classes[w.base] = (classes[w.base] || 0) + 1;
    return `classes waiting: ${Object.keys(classes).sort((a, b) => b - a).map((k) => `w${k}×${classes[k]}`).join(", ")}; served class w${decision.patient.priority_score}`;
  }
  const ranked = decision.waiting.slice().sort((a, b) => b.effective - a.effective || b.base - a.base || a.arrival - b.arrival || a.id - b.id);
  const shown = ranked.slice(0, 4).map((w) => `${label(w)} ${policyName === WPS_A ? `${w.base}→${w.effective}` : w.base}`);
  return `${shown.join(" > ")}${ranked.length > 4 ? ` > … (${ranked.length - 4} more)` : ""}`;
}

function traceMarkdown(trace) {
  const { scenario, seed, from, to, workload, days } = trace;
  const lines = [`# Sample simulation trace — ${scenario}, seed ${seed}, shared queue (three general doctors)`, "",
    "Synthetic patients generated by `simulation/engine.js` for this seed. Clock: the registration window opens at 08:00.",
    `Window shown: ${clock(from)}–${clock(to)}, opening two calls before the first call where WPS-A chooses a different patient from WPS.`,
    "All three policies receive exactly these arrivals and consultation lengths; only the choice of the next patient differs.", "",
    "Scores: Senior 4, PWD 3, Pregnant 3, Indigenous 2, Solo parent 1, Regular 1 (combinations add). WPS-A shows `base→effective`",
    "(+1 per full 10 minutes waited, at most +2). WRR serves classes by weight (class w4 up to 4 patients per turn, w3 up to 3, …).", "",
    "## Arrivals in the window", "", "| Arrival | Patient | Service | Score | Consultation length (min) |", "|---|---|---|---|---|"];
  for (const p of workload.filter((w) => w.arrival >= from && w.arrival < to)) {
    lines.push(`| ${clock(p.arrival)} | ${label(p)} | ${p.service} | ${p.priority_score} | ${p.serviceTime.toFixed(1)} |`);
  }
  for (const [policyName, day] of Object.entries(days)) {
    lines.push("", `## ${policyName}`, "", "| Decision time | Doctor freed | Waiting | Ranking (WPS/WPS-A) or class selection (WRR) | Called | Arrived | Start | Completes | Waited (min) |", "|---|---|---|---|---|---|---|---|---|");
    for (const d of day.decisions.filter((x) => x.now >= from && x.now < to)) {
      lines.push(`| ${clock(d.now)} | ${d.doctor} | ${d.waiting.length} | ${rankingCell(d, policyName)} | **${label(d.patient)}** | ${clock(d.patient.arrival)} | ${clock(d.start)} | ${clock(d.end)} | ${d.wait.toFixed(1)} |`);
    }
  }
  // Same patients, three outcomes: the lifecycle of the patients who arrived in the window.
  lines.push("", "## Lifecycle of the window's arrivals under each policy", "", "| Patient | Arrived | " +
    Object.keys(days).map((p) => `${SHORT[p]}: doctor, start → completion (wait)`).join(" | ") + " |", `|---|---|${Object.keys(days).map(() => "---").join("|")}|`);
  for (const p of workload.filter((w) => w.arrival >= from && w.arrival < to)) {
    lines.push(`| ${label(p)} | ${clock(p.arrival)} | ${Object.values(days).map((day) => {
      const d = day.decisions.find((x) => x.patient.id === p.id);
      return `${d.doctor}, ${clock(d.start)} → ${clock(d.end)} (${d.wait.toFixed(1)})`;
    }).join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

function traceJson(trace) {
  const { scenario, seed, dispatch, from, to, workload, days } = trace;
  return {
    scenario, seed, dispatch, window: { fromMinute: from, toMinute: to, from: clock(from), to: clock(to) },
    arrivals: workload.filter((w) => w.arrival >= from && w.arrival < to).map(({ id, arrival, service, flags, group, priority_score, serviceTime }) =>
      ({ id, arrival, service, flags, group, priority_score, serviceTime })),
    decisions: Object.fromEntries(Object.entries(days).map(([p, day]) => [SHORT[p], day.decisions.filter((d) => d.now >= from && d.now < to)
      .map((d) => ({ now: d.now, doctor: d.doctor, chosen: d.patient.id, start: d.start, end: d.end, wait: d.wait, waiting: d.waiting }))]))
  };
}

// ---------- SVG charts ----------
const COLORS = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7",
    s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", service: "#6250d6", shared: "#008300" },
  dark: { surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835",
    s1: "#3987e5", s2: "#d95926", s3: "#199e70", service: "#9085e9", shared: "#008300" }
};
const POLICY_COLOR = { [WPS]: "s1", [WPS_A]: "s2", [WRR]: "s3" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const styleBlock = () => {
  const vars = (c) => Object.entries(c).map(([k, v]) => `--${k}:${v};`).join("");
  return `<style>svg{${vars(COLORS.light)}}@media (prefers-color-scheme: dark){svg{${vars(COLORS.dark)}}}
text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;fill:var(--ink2);font-size:12px}
.t{fill:var(--ink);font-size:15px;font-weight:600}.st{font-size:12px}.pt{fill:var(--ink);font-size:13px;font-weight:600}
.ax{fill:var(--muted);font-size:11px}.grid{stroke:var(--grid);stroke-width:1}.base{stroke:var(--axis);stroke-width:1}
.ci{stroke:var(--ink2);stroke-width:1}</style>`;
};
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};
const ticksFor = (lo, hi) => {
  const step = niceMax((hi - lo) / 4);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
};
// A bar from the baseline y0 to the data end y1, 4px rounded at the data end only.
function barPath(x, w, y0, y1) {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = Math.min(4, w / 2, h);
  if (y1 < y0) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

// Small-multiple grouped bars. panels: [{ title, categories, series: [{ name, color, values: [{ v, ci, tip }] }], subLabels? }]
function barChart({ title, subtitle, unit, panels, columns = panels.length, panelWidth = 440, panelHeight = 230, sharedScale = true, showCi = false }) {
  const left = 52, gapX = 60, top = 70, legendH = 28, gapY = 70;
  const rows = Math.ceil(panels.length / columns);
  const width = left + columns * panelWidth + (columns - 1) * gapX + 16;
  const height = top + legendH + rows * (panelHeight + gapY) + 10;
  const extent = (p) => {
    const vals = p.series.flatMap((s) => s.values.flatMap((x) => (x.v == null ? [] : [x.v - (showCi ? x.ci || 0 : 0), x.v + (showCi ? x.ci || 0 : 0)])));
    return [Math.min(0, ...vals), Math.max(0, ...vals)];
  };
  const all = panels.map(extent);
  const global = [Math.min(...all.map((e) => e[0])), Math.max(...all.map((e) => e[1]))];
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">`, styleBlock(),
    `<rect width="100%" height="100%" fill="var(--surface)"/>`, `<text class="t" x="${left}" y="26">${esc(title)}</text>`,
    `<text class="st" x="${left}" y="46">${esc(subtitle)}</text>`];
  // Legend: one row, every series named (identity never by color alone).
  const legendSeries = panels[0].series;
  let lx = left;
  if (legendSeries.length > 1) for (const s of legendSeries) {
    out.push(`<rect x="${lx}" y="${top - 6}" width="12" height="12" rx="3" fill="var(--${s.color})"/><text x="${lx + 18}" y="${top + 4}">${esc(s.name)}</text>`);
    lx += 30 + s.name.length * 6.6;
  }
  panels.forEach((panel, index) => {
    const col = index % columns, row = Math.floor(index / columns);
    const x0 = left + col * (panelWidth + gapX), y0 = top + legendH + row * (panelHeight + gapY) + 20;
    let [lo, hi] = sharedScale ? global : all[index];
    hi = hi > 0 ? niceMax(hi) : 0;
    lo = lo < 0 ? -niceMax(-lo) : 0;
    const y = (v) => y0 + panelHeight - ((v - lo) / (hi - lo || 1)) * panelHeight;
    out.push(`<text class="pt" x="${x0}" y="${y0 - 10}">${esc(panel.title)}</text>`);
    for (const t of ticksFor(lo, hi)) {
      out.push(`<line class="grid" x1="${x0}" x2="${x0 + panelWidth}" y1="${y(t)}" y2="${y(t)}"/>`,
        `<text class="ax" x="${x0 - 6}" y="${y(t) + 4}" text-anchor="end">${Number.isInteger(t) ? t : t.toFixed(2)}</text>`);
    }
    out.push(`<line class="base" x1="${x0}" x2="${x0 + panelWidth}" y1="${y(0)}" y2="${y(0)}"/>`);
    const band = panelWidth / panel.categories.length;
    const n = panel.series.length;
    const bw = Math.min(24, (band * 0.78 - (n - 1) * 2) / n);
    panel.categories.forEach((category, ci) => {
      const gx = x0 + ci * band + (band - (n * bw + (n - 1) * 2)) / 2;
      panel.series.forEach((s, si) => {
        const value = s.values[ci];
        if (!value || value.v == null) return;
        const bx = gx + si * (bw + 2);
        out.push(`<path d="${barPath(bx, bw, y(0), y(value.v))}" fill="var(--${s.color})"><title>${esc(value.tip || `${s.name}, ${category}: ${value.v.toFixed(2)} ${unit}`)}</title></path>`);
        if (showCi && value.ci) out.push(`<line class="ci" x1="${bx + bw / 2}" x2="${bx + bw / 2}" y1="${y(value.v - value.ci)}" y2="${y(value.v + value.ci)}"/>`);
        if (panel.subLabels) out.push(`<text class="ax" x="${bx + bw / 2}" y="${y(0) + 13}" text-anchor="middle">${esc(panel.subLabels[si])}</text>`);
      });
      out.push(`<text x="${x0 + ci * band + band / 2}" y="${y0 + panelHeight + (panel.subLabels ? 30 : 18)}" text-anchor="middle">${esc(category)}</text>`);
    });
  });
  out.push(`<text class="ax" x="${left}" y="${height - 8}">Synthetic simulation (backend/simulation). Hover a bar for its value; numbers are in tables.md.</text>`, "</svg>");
  return out.join("\n");
}

function charts(byMode, effects, { replications }) {
  const scenarios = Object.keys(byMode.shared);
  const cats = scenarios.map((s) => SCENARIO_LABEL[s] || s);
  const sub = `Mean of ${replications} paired synthetic days per scenario; identical patients for every policy and dispatch mode.`;
  const policySeries = (mode, pick) => Object.keys(POLICIES).map((p) => ({ name: SHORT[p], color: POLICY_COLOR[p],
    values: scenarios.map((s) => { const v = pick(byMode[mode][s].policies[p]); return v && { v: v.mean, ci: v.ci95 }; }) }));
  const modePanels = (pick) => Object.entries(MODES).map(([mode, t]) => ({ title: t, categories: cats, series: policySeries(mode, pick) }));
  const out = {};
  for (const [metric, name] of Object.entries(METRICS)) {
    out[`wait-${metric.replace("Wait", "")}.svg`] = barChart({ title: `${name} by scenario, dispatch mode and policy (minutes)`, subtitle: sub, unit: "min",
      panels: modePanels((m) => m[metric]) });
  }
  for (const scenario of ["long-waits", "priority-surge"]) {
    out[`wait-by-group-${scenario}.svg`] = barChart({ title: `Average wait by priority group — ${scenario} (minutes)`, subtitle: sub, unit: "min",
      panels: Object.entries(MODES).map(([mode, t]) => ({ title: t, categories: GROUPS.map((g) => GROUP_LABEL[g]),
        series: Object.keys(POLICIES).map((p) => ({ name: SHORT[p], color: POLICY_COLOR[p],
          values: GROUPS.map((g) => { const v = byMode[mode][scenario].policies[p].byGroup[g]?.avgWait; return v && { v: v.mean, ci: v.ci95 }; }) })) })) });
  }
  out["throughput.svg"] = barChart({ title: "Throughput (patients served per hour of the working day), WPS", subtitle: `${sub} Policy changes throughput by < 0.05/h.`, unit: "patients/h",
    panels: [{ title: "Service dispatch versus shared queue", categories: cats, series: Object.keys(MODES).map((mode) => ({ name: mode === "service" ? "Service dispatch (legacy)" : "Shared queue (D1)", color: mode,
      values: scenarios.map((s) => ({ v: byMode[mode][s].policies[WPS].throughputPerHour.mean })) })) }], panelWidth: 900 });
  out["utilization.svg"] = barChart({ title: "Doctor utilization (busy time ÷ day length), WPS", subtitle: `${sub} Bars per scenario: Doctor 1, 2, 3. Policy changes utilization by ≤ 0.01.`, unit: "",
    panels: Object.entries(MODES).map(([mode, t]) => ({ title: t, categories: cats, subLabels: ["1", "2", "3"],
      series: DOCTORS.map((d) => ({ name: d, color: mode, values: scenarios.map((s) => ({ v: byMode[mode][s].policies[WPS].utilization[d].mean, tip: `${d}, ${s}: ${byMode[mode][s].policies[WPS].utilization[d].mean.toFixed(2)}` })) })) })) });
  out["protected-ordering.svg"] = barChart({ title: "Protected-priority ordering: decisions per day that deviate from strict priority", subtitle: sub, unit: "decisions/day",
    columns: 2, panels: [
      ...Object.entries(MODES).map(([mode, t]) => ({ title: `Lower score served while a higher score waited — ${mode}`, categories: cats, series: policySeries(mode, (m) => m.priorityInversions) })),
      ...Object.entries(MODES).map(([mode, t]) => ({ title: `Regular served while Senior/PWD/Pregnant waited — ${mode}`, categories: cats, series: policySeries(mode, (m) => m.regularBeforeProtected) }))
    ] });
  const effectSeries = (metric) => [["structure", "Queue structure (shared − service, WPS)", "service"], ["wpsaShared", "WPS-A − WPS (shared)", "s2"], ["wrrShared", "WRR − WPS (shared)", "s3"]]
    .map(([key, name, color]) => ({ name, color, values: scenarios.map((s) => ({ v: effects[key].rows[s][metric].mean, ci: effects[key].rows[s][metric].ci95 })) }));
  out["effects-structure-vs-policy.svg"] = barChart({ title: "Where the improvement comes from: change in wait per paired seed (minutes; below 0 = shorter)",
    subtitle: `${sub} Whiskers: 95% CI of the paired difference.`, unit: "min", sharedScale: false, showCi: true, columns: 1, panelWidth: 900, panelHeight: 200,
    panels: Object.entries(METRICS).map(([metric, name]) => ({ title: name, categories: cats, series: effectSeries(metric) })) });
  // The policy effects alone, at their own scale, in both dispatch modes.
  const policyEffect = (mode, metric) => [[mode === "shared" ? "wpsaShared" : "wpsaService", "WPS-A − WPS", "s2"], [mode === "shared" ? "wrrShared" : "wrrService", "WRR − WPS", "s3"]]
    .map(([key, name, color]) => ({ name, color, values: scenarios.map((s) => ({ v: effects[key].rows[s][metric].mean, ci: effects[key].rows[s][metric].ci95 })) }));
  out["effects-policy-only.svg"] = barChart({ title: "Scheduling-policy effect alone: change in wait versus WPS per paired seed (minutes; below 0 = shorter)",
    subtitle: `${sub} Whiskers: 95% CI of the paired difference. Each panel has its own scale.`, unit: "min", sharedScale: false, showCi: true, columns: 2,
    panels: Object.entries(METRICS).flatMap(([metric, name]) => Object.entries(MODES).map(([mode]) => ({ title: `${name} — ${mode === "shared" ? "shared queue" : "service dispatch"}`, categories: cats, series: policyEffect(mode, metric) }))) });
  return out;
}

// Three measures at their own scales; one bar per dispatch mode per scenario.
function headToHeadChart(h2h, { replications }) {
  const scenarios = Object.keys(h2h.rows.shared);
  const cats = scenarios.map((s) => SCENARIO_LABEL[s] || s);
  const series = (key) => Object.keys(MODES).map((mode) => ({ name: mode === "service" ? "Service dispatch (legacy)" : "Shared queue (D1)", color: mode,
    values: scenarios.map((s) => ({ v: h2h.rows[mode][s][key].mean, ci: h2h.rows[mode][s][key].ci95 })) }));
  return barChart({ title: "WRR versus WPS-A on the same days: WRR − WPS-A (below 0 = WRR lower)",
    subtitle: `Mean of ${replications} paired synthetic days per scenario. Whiskers: 95% CI. Each panel has its own scale.`, unit: "",
    sharedScale: false, showCi: true, columns: 3, panelWidth: 320,
    panels: [["maxWait", "Maximum wait (min)"], ["protectedMax", "Longest Senior/PWD/Pregnant wait (min)"], ["regularBeforeProtected", "Regular before waiting protected (/day)"]]
      .map(([key, title]) => ({ title, categories: cats, series: series(key) })) });
}

function writeReport(dir, traceScenario = "long-waits", traceSeed) {
  const results = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
  const { byMode, replications, baseSeed } = results;
  const effects = pairedEffects(byMode);
  const h2h = headToHead(byMode);
  const trace = sampleTrace(traceScenario, traceSeed ?? baseSeed);
  fs.mkdirSync(path.join(dir, "charts"), { recursive: true });
  const files = {
    "tables.md": tablesMarkdown(byMode, results),
    "paired-effects.md": pairedMarkdown(effects, results),
    "paired-effects.json": JSON.stringify(Object.fromEntries(Object.entries(effects).map(([k, v]) => [k, { title: v.title, rows: v.rows }])), null, 1),
    "head-to-head.md": headToHeadMarkdown(h2h, results),
    "head-to-head.json": JSON.stringify(h2h, null, 1),
    "charts/head-to-head-wrr-vs-wpsa.svg": headToHeadChart(h2h, results),
    "per-replication.csv": perReplicationCsv(byMode, results),
    "sample-trace.md": traceMarkdown(trace),
    "sample-trace.json": JSON.stringify(traceJson(trace), null, 1),
    ...Object.fromEntries(Object.entries(charts(byMode, effects, results)).map(([name, svg]) => [`charts/${name}`, svg]))
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return Object.keys(files);
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || "simulation-output");
  const written = writeReport(dir, process.argv[3] || "long-waits", process.argv[4] ? Number(process.argv[4]) : undefined);
  console.log(`Wrote ${written.length} files to ${dir}`);
}

module.exports = { writeReport, pairedEffects, headToHead, sampleTrace, traceDay, barChart };
