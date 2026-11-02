// Experimental scenarios for comparing WPS-A and WRR when Regular patients outnumber Vulnerable
// patients and vice versa (Algorithm Simulation page and the Chapter IV report; research only,
// never the live queue). Each scenario builds ONE seeded synthetic workload that both algorithms
// then serve in the same shared queue with three general doctors, so a difference between them
// comes from the scheduling rule alone. EVERY NUMBER HERE IS AN ASSUMPTION, not a clinic measurement.
//
// "Vulnerable" means at least one approved registration classification (Senior Citizen, PWD,
// Pregnant, Indigenous Person, Solo Parent). It is a priority-lane category, not clinical urgency.
// Base priority is the live registration rule (computePriorityScore in src/services/queueService.js):
// the weights of the ticked classifications summed (cumulative), Regular = 1. A Solo Parent alone
// therefore has base 1, the same as a Regular patient.
// Pure functions without Node built-ins, so the same module runs in the browser.
const { createRng, priorityScore, groupOf, EPOCH, DOCTOR_FOR_SERVICE } = require("./engine");
const { SERVICE_MINUTES } = require("./scenarios");

const MINUTE_MS = 60 * 1000;
const DEFAULT_COUNT = 100;
const MIN_COUNT = 20;
const MAX_COUNT = 400;
const DOCTOR_COUNT = 3;

// Share of each classification among Vulnerable patients (assumed), cumulative ones included.
const VULNERABLE_MIX = [
  [["senior"], 34], [["pwd"], 14], [["pregnant"], 16], [["indigenous"], 8], [["solo_parent"], 8],
  [["senior", "pwd"], 10], [["pregnant", "solo_parent"], 5], [["pregnant", "indigenous"], 3], [["pwd", "solo_parent"], 2]
];
// Stress test: only classifications with base 3 or more. Under WPS-A a Regular patient's effective
// priority is at most 1 + 2 = 3 and a tie goes to the higher base, so none of these can be passed.
const HIGHER_PRIORITY_MIX = [[["senior"], 45], [["pwd"], 20], [["pregnant"], 20], [["senior", "pwd"], 15]];
const STRESS_REGULAR_SHARE = 0.15;
const STRESS_RATE_PER_HOUR = 24;

// Relative registrations per hour of the 08:00-16:00 window (assumed): a morning peak, a lunch dip.
const HOURLY_PROFILE = [16, 15, 13, 10, 7, 8, 6, 5];

// Service type sets the consultation length (lognormal, SERVICE_MINUTES); every doctor is a general doctor.
const SERVICES_PREGNANT = [["prenatal", 80], ["maternity", 20]];
const SERVICES_OTHER = [["consultation", 65], ["checkup", 20], ["family_planning", 15]];

// The controlled case: three patients already in a 20-minute consultation at opening, one Regular
// at 08:01, then nine Vulnerable patients one minute apart from 08:02; every later consultation
// takes exactly 10 minutes. Nothing in it is random.
const CONTROLLED = {
  warmUpMinutes: 20, consultationMinutes: 10, regularAt: 1, firstVulnerableAt: 2,
  vulnerable: [["senior"], ["pwd"], ["pregnant"], ["senior"], ["indigenous"], ["pwd"], ["senior", "pwd"], ["pregnant"], ["senior"]]
};

// Largest-remainder apportionment: exactly `total` items in the given shares (ties to the earlier entry).
function apportion(total, shares) {
  const sum = shares.reduce((s, [, w]) => s + w, 0);
  const exact = shares.map(([, w]) => (total * w) / sum);
  const counts = exact.map(Math.floor);
  const order = exact.map((_, i) => i).sort((a, b) => (exact[b] - counts[b]) - (exact[a] - counts[a]) || a - b);
  for (let left = total - counts.reduce((s, c) => s + c, 0), k = 0; left > 0; left -= 1, k += 1) counts[order[k]] += 1;
  return shares.flatMap(([value], i) => Array.from({ length: counts[i] }, () => value.slice()));
}

function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function makePatient(id, arrival, flags, rng, { serviceTime, role } = {}) {
  const service = rng ? rng.pick(flags.includes("pregnant") ? SERVICES_PREGNANT : SERVICES_OTHER)
    : flags.includes("pregnant") ? "prenatal" : "consultation";
  const { mean, cv } = SERVICE_MINUTES[service];
  return {
    id, arrival, service, doctor: DOCTOR_FOR_SERVICE[service], flags, group: groupOf(flags), priority_score: priorityScore(flags),
    created_at: new Date(EPOCH + Math.round(arrival * MINUTE_MS)).toISOString(),
    serviceTime: serviceTime ?? Math.max(1, rng.lognormal(mean, cv)),
    ...(role ? { role } : {})
  };
}

// Scenario A/B: exactly round(count x regularShare) Regular patients, the rest apportioned over
// VULNERABLE_MIX, shuffled over `count` staggered registrations drawn from HOURLY_PROFILE.
function mixWorkload({ count, seed, regularShare }) {
  const rng = createRng(seed);
  const regular = Math.round(count * regularShare);
  const flags = shuffle([...Array.from({ length: regular }, () => []), ...apportion(count - regular, VULNERABLE_MIX)], rng);
  const hours = HOURLY_PROFILE.map((weight, hour) => [hour, weight]);
  const arrivals = Array.from({ length: count }, () => (rng.pick(hours) + rng.next()) * 60).sort((a, b) => a - b);
  return arrivals.map((t, i) => makePatient(i + 1, t, flags[i], rng));
}

// Stress: an opening crowd of ten in the first minute (three take the doctors, the fourth is the
// Regular patient followed through the test, the other six are Senior/PWD/Pregnant), then the
// rest spread uniformly at random after it at 24 per hour (a Poisson stream given its count),
// above the three doctors' capacity of about 18 per hour.
const STRESS_OPENING = 10;
const STRESS_TRACKED = 3;
function stressWorkload({ count, seed }) {
  const rng = createRng(seed);
  const window = ((count - STRESS_OPENING) / STRESS_RATE_PER_HOUR) * 60;
  const opening = Array.from({ length: STRESS_OPENING }, () => rng.next()).sort((a, b) => a - b);
  const stream = Array.from({ length: count - STRESS_OPENING }, () => 1 + rng.next() * window).sort((a, b) => a - b);
  const regular = Math.round(count * STRESS_REGULAR_SHARE);
  const higher = shuffle(apportion(count - regular, HIGHER_PRIORITY_MIX), rng);
  const openingFlags = higher.splice(0, STRESS_OPENING - 1);
  openingFlags.splice(STRESS_TRACKED, 0, []);
  const flags = [...openingFlags, ...shuffle([...higher, ...Array.from({ length: regular - 1 }, () => [])], rng)];
  return [...opening, ...stream].map((t, i) => makePatient(i + 1, t, flags[i], rng, { role: i === STRESS_TRACKED ? "tracked" : undefined }));
}

function controlledWorkload() {
  const c = CONTROLLED;
  return [
    ...[1, 2, 3].map((id) => makePatient(id, 0, [], null, { serviceTime: c.warmUpMinutes, role: "warm-up" })),
    makePatient(4, c.regularAt, [], null, { serviceTime: c.consultationMinutes, role: "tracked" }),
    ...c.vulnerable.map((flags, i) => makePatient(5 + i, c.firstVulnerableAt + i, flags, null, { serviceTime: c.consultationMinutes }))
  ];
}

const EXPERIMENTS = {
  "regular-majority": {
    label: "Scenario A — Regular-majority", short: "A · 80% Regular / 20% Vulnerable", regularShare: 0.8,
    description: "80% Regular and 20% Vulnerable patients registering through the day (morning peak, lunch dip)",
    build: ({ count, seed }) => mixWorkload({ count, seed, regularShare: 0.8 })
  },
  "vulnerable-majority": {
    label: "Scenario B — Vulnerable-majority", short: "B · 20% Regular / 80% Vulnerable", regularShare: 0.2,
    description: "20% Regular and 80% Vulnerable patients registering through the day (morning peak, lunch dip)",
    build: ({ count, seed }) => mixWorkload({ count, seed, regularShare: 0.2 })
  },
  "early-regular": {
    label: "Controlled — one Regular before nine Vulnerable", short: "Controlled · 1 Regular, then 9 Vulnerable", fixedCount: 13,
    description: "Three doctors busy until 08:20; a Regular registers at 08:01, then nine Vulnerable patients from 08:02 to 08:10; 10-minute consultations (no randomness)",
    build: controlledWorkload
  },
  "sustained-arrivals": {
    label: "Stress — sustained higher-priority arrivals", short: "Stress · 24/hour, 85% Senior/PWD/Pregnant",
    description: "An opening crowd of ten (the followed Regular registers fourth, after the three doctors are taken), then continuous registrations at 24 per hour, above the ~18 per hour three doctors can see; 85% Senior/PWD/Pregnant, 15% Regular",
    build: stressWorkload
  }
};

function generateExperimentWorkload(name, { seed, count = DEFAULT_COUNT } = {}) {
  const experiment = EXPERIMENTS[name];
  if (!experiment) throw new Error(`Unknown experiment ${name}`);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("The seed must be a whole number of 0 or more");
  if (!experiment.fixedCount && (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT)) {
    throw new Error(`The patient count must be a whole number from ${MIN_COUNT} to ${MAX_COUNT}`);
  }
  return experiment.build({ count, seed });
}

// Demand against capacity: consultation minutes registered per hour of the day over the three
// doctors' 180 minutes. A load above 1 means arrivals exceed what the doctors can see in that hour.
function workloadProfile(workload) {
  const hours = Math.max(1, Math.ceil(Math.max(...workload.map((p) => p.arrival)) / 60 + 1e-9));
  const hourly = Array.from({ length: hours }, (_, h) => {
    const inHour = workload.filter((p) => p.arrival >= h * 60 && p.arrival < (h + 1) * 60);
    return { hour: h, arrivals: inHour.length, load: inHour.reduce((s, p) => s + p.serviceTime, 0) / (DOCTOR_COUNT * 60) };
  });
  const lastArrival = Math.max(...workload.map((p) => p.arrival));
  const consultationMinutes = workload.reduce((s, p) => s + p.serviceTime, 0);
  return {
    patients: workload.length, lastArrival, consultationMinutes,
    meanConsultation: consultationMinutes / workload.length,
    capacityPerHour: (DOCTOR_COUNT * 60) / (consultationMinutes / workload.length),
    offeredLoad: lastArrival > 0 ? consultationMinutes / (DOCTOR_COUNT * lastArrival) : null,
    hourly, overloadedHours: hourly.filter((h) => h.load > 1).map((h) => h.hour)
  };
}

module.exports = {
  EXPERIMENTS, DEFAULT_COUNT, MIN_COUNT, MAX_COUNT, VULNERABLE_MIX, HIGHER_PRIORITY_MIX, HOURLY_PROFILE, CONTROLLED,
  STRESS_RATE_PER_HOUR, STRESS_REGULAR_SHARE, apportion, generateExperimentWorkload, workloadProfile
};
