// Weighted-Priority Scheduling (WPS) order for waiting visits, with optional 10-minute Aging
// (WPS-A, proposed; off unless WPS_AGING is enabled). The constants and rules match the WPS-A
// call function in backend/scripts/20261029-wps-a-call-aging.sql; a test compares the two.
//   effective = priority_score + min(MAX_BONUS, floor(waited / STEP)), waited = rankedAt -
//   created_at in whole milliseconds (a visit registered after rankedAt gets no bonus).
//   Order: effective DESC, priority_score DESC (a protected category wins a tie), created_at
//   ASC, id ASC. Without aging the bonus is 0, which is the original WPS order.
// Only waiting visits are ranked, so a consultation in progress is never preempted.
const AGING_STEP_MS = 10 * 60 * 1000;
const AGING_MAX_BONUS = 2;

function agingBonus(createdAt, rankedAt, aging) {
  if (!aging) return 0;
  const waited = Number(rankedAt) - Date.parse(createdAt);
  if (!Number.isFinite(waited) || waited <= 0) return 0;
  return Math.min(AGING_MAX_BONUS, Math.floor(waited / AGING_STEP_MS));
}

function effectivePriority(patient, rankedAt, aging) {
  return (patient.priority_score || 0) + agingBonus(patient.created_at, rankedAt, aging);
}

function compareWps(a, b, rankedAt, aging) {
  return effectivePriority(b, rankedAt, aging) - effectivePriority(a, rankedAt, aging) ||
    (b.priority_score || 0) - (a.priority_score || 0) ||
    Date.parse(a.created_at) - Date.parse(b.created_at) ||
    Number(a.id) - Number(b.id);
}

module.exports = { AGING_STEP_MS, AGING_MAX_BONUS, agingBonus, effectivePriority, compareWps };
