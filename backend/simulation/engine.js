// Research simulation (not used by the live queue): a seeded discrete-event model of the clinic
// for comparing scheduling policies on identical synthetic workloads. Three doctors,
// non-preemptive consultations; a doctor picks the next patient the moment it becomes free.
// Times are minutes from opening. Two dispatch modes, matching D1's DOCTOR_DISPATCH_MODE:
//   "service" - each service goes to its fixed doctor (the current behavior; three queues);
//   "shared"  - D1 Model A (provisional, pending approval): all doctors are general doctors and
//               take the head of ONE Weighted-Priority queue; the doctor is chosen at Call.
// Results are reported per mode; neither mode is assumed to be the approved one.
//
// WPS and WPS-A use the production rank function (src/lib/wpsPriority.js); WRR is in
// policies.js. Every workload parameter is an ASSUMPTION documented in scenarios.js; in shared
// mode every doctor is assumed to take the same time for a given service.
const { compareWps } = require("../src/lib/wpsPriority");

const DOCTOR_FOR_SERVICE = {
  consultation: "Doctor 1", checkup: "Doctor 1", prenatal: "Doctor 2", maternity: "Doctor 2", family_planning: "Doctor 3"
};
const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const WEIGHTS = { senior: 4, pwd: 3, pregnant: 3, indigenous: 2, solo_parent: 1 };
const PROTECTED = ["senior", "pwd", "pregnant"];
const EPOCH = Date.parse("2026-01-05T00:00:00.000Z");
const MINUTE_MS = 60 * 1000;

// mulberry32: small, fast, deterministic per seed.
function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    exponential: (mean) => -mean * Math.log(1 - next()),
    // Lognormal with the given mean and coefficient of variation.
    lognormal(mean, cv) {
      const sigma2 = Math.log(1 + cv * cv);
      const mu = Math.log(mean) - sigma2 / 2;
      const z = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
      return Math.exp(mu + Math.sqrt(sigma2) * z);
    },
    pick(weighted) {
      const total = weighted.reduce((sum, [, w]) => sum + w, 0);
      let r = next() * total;
      for (const [value, w] of weighted) { r -= w; if (r < 0) return value; }
      return weighted[weighted.length - 1][0];
    }
  };
}

const priorityScore = (flags) => flags.reduce((sum, flag) => sum + (WEIGHTS[flag] || 0), 0) || 1;
const groupOf = (flags) => flags.length === 0 ? "regular" : flags.length > 1 ? "multiple" : flags[0];

// Arrivals follow a piecewise-constant Poisson process: `rates` is [[fromMinute, perHour], ...].
function generateWorkload(scenario, seed) {
  const rng = createRng(seed);
  const patients = [];
  const { openMinutes, rates, services, categories } = scenario;
  let t = 0;
  for (;;) {
    const rate = [...rates].reverse().find(([from]) => t >= from)[1];
    t += rng.exponential(60 / rate);
    if (t >= openMinutes) break;
    const service = rng.pick(services);
    const flags = rng.pick(categories[service] || categories.default);
    const { mean, cv } = scenario.serviceMinutes[service];
    patients.push({
      id: patients.length + 1, arrival: t, service, doctor: DOCTOR_FOR_SERVICE[service], flags,
      group: groupOf(flags), priority_score: priorityScore(flags),
      created_at: new Date(EPOCH + Math.round(t * MINUTE_MS)).toISOString(),
      serviceTime: Math.max(1, rng.lognormal(mean, cv))
    });
  }
  return patients;
}

// The three compared policies. `select(waiting, now)` returns the patient to serve next.
function wpsPolicy(aging) {
  return () => ({
    select: (waiting, now) => waiting.slice().sort((a, b) => compareWps(a, b, EPOCH + now * MINUTE_MS, aging))[0]
  });
}

// Serves `chosen` on `doctor` at `now`; returns when the doctor is free again.
function record(served, busy, inversions, chosen, waiting, doctor, now) {
  inversions.decisions += 1;
  if (chosen.priority_score < Math.max(...waiting.map((p) => p.priority_score))) inversions.anyBase += 1;
  if (chosen.group === "regular" && waiting.some((p) => p.flags.some((f) => PROTECTED.includes(f)))) {
    inversions.regularOverProtected += 1;
  }
  waiting.splice(waiting.indexOf(chosen), 1);
  served.push({ ...chosen, servedBy: doctor, start: now, wait: now - chosen.arrival, end: now + chosen.serviceTime });
  busy[doctor] += chosen.serviceTime;
  return now + chosen.serviceTime;
}

// One queue served by `doctors`: whenever the earliest-free doctor is free it takes the policy's
// pick from the patients who have arrived by then; if none has, the longest-idle doctor takes the
// next arrival. `policy` is one instance shared by the queue (WRR keeps its cycle per queue).
function serveQueue(pending, doctors, policy, served, busy, inversions) {
  const freeAt = Object.fromEntries(doctors.map((d) => [d, 0]));
  const waiting = [];
  let i = 0;
  while (i < pending.length || waiting.length) {
    const doctor = doctors.reduce((a, b) => (freeAt[b] < freeAt[a] ? b : a));
    let now = freeAt[doctor];
    while (i < pending.length && pending[i].arrival <= now) waiting.push(pending[i++]);
    if (!waiting.length) { freeAt[doctor] = pending[i].arrival; continue; }
    freeAt[doctor] = record(served, busy, inversions, policy.select(waiting, now), waiting, doctor, now);
  }
}

function runSimulation(patients, makePolicy, { dispatch = "service" } = {}) {
  if (!["service", "shared"].includes(dispatch)) throw new Error(`Unknown dispatch mode ${dispatch}`);
  const served = [];
  const busy = Object.fromEntries(DOCTORS.map((d) => [d, 0]));
  const inversions = { anyBase: 0, regularOverProtected: 0, decisions: 0 };
  const byArrival = (a, b) => a.arrival - b.arrival || a.id - b.id;
  if (dispatch === "shared") {
    serveQueue(patients.slice().sort(byArrival), DOCTORS, makePolicy("shared"), served, busy, inversions);
  } else {
    for (const doctor of DOCTORS) {
      serveQueue(patients.filter((p) => p.doctor === doctor).sort(byArrival), [doctor], makePolicy(doctor), served, busy, inversions);
    }
  }
  const makespan = Math.max(0, ...served.map((p) => p.end));
  return { served, busy, makespan, inversions };
}

module.exports = { DOCTORS, PROTECTED, WEIGHTS, createRng, generateWorkload, runSimulation, wpsPolicy, priorityScore, groupOf };
