// WPS-A (proposed Weighted-Priority Scheduling with 10-minute Aging): the pure rank rules in
// src/lib/wpsPriority.js. effective = base + min(2, floor(waited / 10 min)); order: effective DESC,
// base DESC, registration ASC, id ASC. Without aging the order is the original WPS order.
const assert = require("node:assert/strict");
const test = require("node:test");
const { agingBonus, effectivePriority, compareWps, AGING_STEP_MS, AGING_MAX_BONUS } = require("../src/lib/wpsPriority");

const NOW = Date.parse("2026-10-29T03:00:00.000Z");
const MIN = 60 * 1000;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
let nextId = 1;
const visit = (base, msAgo, extra = {}) => ({ id: nextId++, priority_score: base, created_at: at(msAgo), status: "waiting", ...extra });
const order = (rows, aging = true) => rows.slice().sort((a, b) => compareWps(a, b, NOW, aging)).map((row) => row.id);

test("policy constants: 10-minute step, +2 cap", () => {
  assert.equal(AGING_STEP_MS, 10 * MIN);
  assert.equal(AGING_MAX_BONUS, 2);
});

test("bonus at 0, 9, 10, 20 minutes, the step edges and long waits", () => {
  const cases = [[0, 0], [1, 0], [9 * MIN, 0], [10 * MIN - 1, 0], [10 * MIN, 1], [19 * MIN + 59999, 1],
    [20 * MIN, 2], [29 * MIN, 2], [120 * MIN, 2], [24 * 60 * MIN, 2]];
  for (const [waited, bonus] of cases) assert.equal(agingBonus(at(waited), NOW, true), bonus, `${waited} ms`);
});

test("no bonus without aging, for a future registration, or an unreadable time", () => {
  assert.equal(agingBonus(at(45 * MIN), NOW, false), 0);
  assert.equal(agingBonus(new Date(NOW + 5 * MIN).toISOString(), NOW, true), 0);
  assert.equal(agingBonus("not a date", NOW, true), 0);
  assert.equal(agingBonus(null, NOW, true), 0);
});

test("effective priority per category never exceeds base + 2", () => {
  for (const base of [1, 2, 3, 4, 7, 13]) {
    assert.equal(effectivePriority(visit(base, 0), NOW, true), base);
    assert.equal(effectivePriority(visit(base, 15 * MIN), NOW, true), base + 1);
    assert.equal(effectivePriority(visit(base, 300 * MIN), NOW, true), base + AGING_MAX_BONUS);
  }
});

test("without aging the order is the original WPS order (score DESC, arrival ASC, id ASC)", () => {
  const rows = [visit(1, 50 * MIN), visit(4, 1 * MIN), visit(3, 30 * MIN), visit(1, 60 * MIN), visit(4, 2 * MIN)];
  const original = rows.slice().sort((a, b) => (b.priority_score - a.priority_score) ||
    Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id).map((row) => row.id);
  assert.deepEqual(order(rows, false), original);
});

test("aging lets a long-waiting Regular pass a newer lower category, but never a protected one", () => {
  const regular25 = visit(1, 25 * MIN);       // 1 + 2 = 3
  const indigenousNew = visit(2, 0);          // 2
  const soloParentNew = visit(1, 0);          // 1
  const pwdNew = visit(3, 0);                 // 3 (wins the tie on base)
  const seniorNew = visit(4, 0);              // 4
  assert.deepEqual(order([indigenousNew, regular25]), [regular25.id, indigenousNew.id]);
  assert.deepEqual(order([soloParentNew, regular25]), [regular25.id, soloParentNew.id]);
  assert.deepEqual(order([regular25, pwdNew]), [pwdNew.id, regular25.id], "equal effective: protected base first");
  assert.deepEqual(order([regular25, seniorNew]), [seniorNew.id, regular25.id], "a Regular never reaches a Senior");
});

test("ties: equal effective and base fall back to registration time, then id", () => {
  const a = visit(3, 12 * MIN);               // 3 + 1 = 4
  const b = visit(4, 0);                      // 4, higher base wins
  const c = visit(3, 15 * MIN);               // 3 + 1 = 4, earlier than a
  assert.deepEqual(order([a, b, c]), [b.id, c.id, a.id]);
  const sameTimeX = visit(2, 5 * MIN);
  const sameTimeY = { ...visit(2, 5 * MIN), created_at: sameTimeX.created_at };
  assert.deepEqual(order([sameTimeY, sameTimeX]), [sameTimeX.id, sameTimeY.id]);
});

test("a protected patient who waits also ages: a 20-minute PWD passes a new Senior", () => {
  const pwd20 = visit(3, 20 * MIN);           // 5
  const seniorNew = visit(4, 0);              // 4
  assert.deepEqual(order([seniorNew, pwd20]), [pwd20.id, seniorNew.id]);
});

test("aging updates over time without changing stored data", () => {
  const regular = visit(1, 0);
  const indigenous = visit(2, 0, { created_at: new Date(NOW + 1).toISOString() });
  const rankAt = (offset) => [regular, indigenous].slice().sort((a, b) => compareWps(a, b, NOW + offset, true)).map((r) => r.id);
  assert.deepEqual(rankAt(0), [indigenous.id, regular.id]);
  assert.deepEqual(rankAt(10 * MIN), [indigenous.id, regular.id], "both aged 1: Indigenous still higher");
  assert.deepEqual(rankAt(20 * MIN), [indigenous.id, regular.id], "1+2=3 vs 2+1=3 (1 ms short): base wins");
  assert.deepEqual(rankAt(20 * MIN + 1), [indigenous.id, regular.id], "both capped at +2: 3 vs 4");
  assert.equal(regular.priority_score, 1);
});

test("doctor queues are ranked separately: aging in one queue never reorders another", () => {
  const service = { "Doctor 1": "consultation", "Doctor 2": "prenatal", "Doctor 3": "family_planning" };
  const rows = [visit(1, 40 * MIN, { service_type: "consultation" }), visit(4, 0, { service_type: "prenatal" }),
    visit(2, 0, { service_type: "consultation" }), visit(1, 5 * MIN, { service_type: "family_planning" }),
    visit(3, 25 * MIN, { service_type: "prenatal" })];
  const heads = Object.fromEntries(Object.entries(service).map(([doctor, svc]) =>
    [doctor, order(rows.filter((row) => row.service_type === svc))[0]]));
  assert.deepEqual(heads, { "Doctor 1": rows[0].id, "Doctor 2": rows[4].id, "Doctor 3": rows[3].id });
});
