// Research comparison policies. WPS (original) and WPS-A (10-minute aging) wrap the production
// rank function; WRR is the comparison algorithm and is never used by the live queue.
const { wpsPolicy } = require("./engine");

// Weighted Round Robin per doctor. Each distinct priority score is a class whose weight is the
// score (Senior 4, PWD/Pregnant 3, Indigenous 2, Regular/Solo Parent 1; combinations use their
// summed score). Classes are visited from the highest weight down; a class may send up to
// `weight` patients (first come, first served inside the class) before the turn moves on. An
// empty class is skipped and keeps no credit. The cycle resumes where it stopped.
function wrrPolicy() {
  const order = [];     // every class weight seen so far, highest first
  let current = null;   // the class whose turn it is (tracked by weight, so new classes cannot shift it)
  let credit = 0;       // patients the current class may still send this turn
  return {
    select(waiting) {
      for (const weight of new Set(waiting.map((p) => p.priority_score))) if (!order.includes(weight)) order.push(weight);
      order.sort((a, b) => b - a);
      if (current == null) { current = order[0]; credit = current; }
      for (let step = 0; step <= order.length; step += 1) {
        const inClass = waiting.filter((p) => p.priority_score === current);
        if (inClass.length && credit > 0) {
          credit -= 1;
          return inClass.reduce((a, b) => (a.arrival < b.arrival || (a.arrival === b.arrival && a.id < b.id) ? a : b));
        }
        current = order[(order.indexOf(current) + 1) % order.length];
        credit = current;
      }
      throw new Error("WRR found no patient to serve");
    }
  };
}

const POLICIES = {
  "WPS (original)": wpsPolicy(false),
  "WPS-A (10-min aging, +2 cap)": wpsPolicy(true),
  "WRR (weights = priority score)": wrrPolicy
};

module.exports = { POLICIES, wrrPolicy };
