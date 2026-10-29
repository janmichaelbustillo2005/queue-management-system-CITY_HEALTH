// Synthetic workload scenarios. EVERY NUMBER HERE IS AN ASSUMPTION chosen for a plausible
// small city health office; none is measured from the clinic. Replace them with observed values
// (arrival counts per hour, consultation durations, category shares) before drawing conclusions
// about the real clinic. All three policies always see the identical patients for a given seed.
const OPEN_MINUTES = 8 * 60;                       // 8:00-16:00 registration window (assumed)

// Consultation length per service: lognormal mean (minutes) and coefficient of variation (assumed).
const SERVICE_MINUTES = {
  consultation: { mean: 9, cv: 0.5 }, checkup: { mean: 7, cv: 0.4 },
  prenatal: { mean: 12, cv: 0.4 }, maternity: { mean: 14, cv: 0.5 }, family_planning: { mean: 10, cv: 0.4 }
};

// Category mix per service: [flags, share] (assumed). Prenatal/maternity patients are mostly pregnant.
const CATEGORIES = {
  default: [[[], 58], [["senior"], 20], [["pwd"], 6], [["indigenous"], 5], [["solo_parent"], 6], [["senior", "pwd"], 3], [["pregnant"], 2]],
  prenatal: [[["pregnant"], 80], [["pregnant", "indigenous"], 6], [["pregnant", "solo_parent"], 6], [[], 8]],
  maternity: [[["pregnant"], 60], [[], 30], [["solo_parent"], 10]],
  family_planning: [[[], 70], [["solo_parent"], 15], [["indigenous"], 8], [["pwd"], 7]]
};

const SERVICE_MIX = [["consultation", 45], ["checkup", 10], ["prenatal", 15], ["maternity", 5], ["family_planning", 25]];
const UNEQUAL_MIX = [["consultation", 62], ["checkup", 13], ["prenatal", 10], ["maternity", 3], ["family_planning", 12]];

const base = { openMinutes: OPEN_MINUTES, serviceMinutes: SERVICE_MINUTES, categories: CATEGORIES, services: SERVICE_MIX };

// Arrival rates are patients per hour for the whole clinic: [[fromMinute, perHour], ...].
const SCENARIOS = {
  "low-volume": { ...base, rates: [[0, 8]], description: "8 arrivals/hour all day (assumed quiet day)" },
  "medium-volume": { ...base, rates: [[0, 14]], description: "14 arrivals/hour all day" },
  "high-volume": { ...base, rates: [[0, 19]], description: "19 arrivals/hour all day; Doctor 1 near saturation" },
  "priority-surge": {
    ...base, rates: [[0, 12], [90, 20], [150, 12]],
    categories: { ...CATEGORIES, default: [[[], 25], [["senior"], 55], [["pwd"], 10], [["senior", "pwd"], 10]] },
    description: "12/hour with a 20/hour burst from 09:30 to 10:30 in which most Doctor 1 arrivals are Senior/PWD"
  },
  "unequal-workload": { ...base, rates: [[0, 15]], services: UNEQUAL_MIX, description: "15/hour, 75% of arrivals for Doctor 1" },
  "long-waits": {
    ...base, rates: [[0, 24], [240, 16]],
    description: "morning overload (24/hour for 4 h, then 16/hour): queues and waits grow long"
  }
};

module.exports = { SCENARIOS, OPEN_MINUTES, SERVICE_MINUTES, CATEGORIES, SERVICE_MIX };
