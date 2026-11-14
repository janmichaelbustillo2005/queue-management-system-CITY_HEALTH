// Doctor queue notifications: GET /queue my_queue, the signed-in doctor's own waiting count from the
// same overview Front Desk Patient Management reads. The counting rule (lib/confirmationGate.js
// buildDoctorWaitingSummary) and the route, with the REAL JWT middleware, session validation and
// queueService over the isolated in-memory database (helpers/realAuthRouteHarness.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildDoctorWaitingSummary, waitingVisitDoctor } = require("../src/lib/confirmationGate");
const { createRealAuthHarness } = require("./helpers/realAuthRouteHarness");

const today = (minute = 0) => new Date(Date.now() - (60 - minute) * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 36 * 3600000).toISOString();
const routeOf = (service) => ({ prenatal: "Doctor 2", maternity: "Doctor 2", family_planning: "Doctor 3" }[service] || "Doctor 1");
const inToday = (p) => p.created_at !== YESTERDAY;

let nextId = 1;
function visit(overrides = {}) {
  const id = nextId++;
  return {
    id, id_num: `Synthetic patient ${id}`, queue_number: `GP-${String(id).padStart(3, "0")}`, service_type: "consultation",
    status: "waiting", priority_score: 1, created_at: today(id % 50), counter_id: null, called_at: null,
    completed_at: null, confirmed_at: null, confirmed_by: null, confirmed_for: null, not_present_at: null, ...overrides
  };
}
const confirmed = (overrides = {}) => visit({ confirmed_at: today(), confirmed_by: "frontdesk", ...overrides });
const summaryFor = (patients, doctor, mode = "round_robin") =>
  buildDoctorWaitingSummary({ patients, doctor, mode, inQueueWindow: inToday, routeOf });

// Test 1 data: 5 / 3 / 2 waiting, plus visits that must never count.
function scenario() {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(visit({ counter_id: "Doctor 1" }));
  rows.push(confirmed({ counter_id: "Doctor 2" }), visit({ counter_id: "Doctor 2" }),
    visit({ counter_id: "Doctor 2", not_present_at: today(), service_type: "prenatal" }));
  rows.push(visit({ counter_id: "Doctor 3" }), confirmed({ counter_id: "Doctor 3" }));
  rows.push(
    visit({ counter_id: "Doctor 2", status: "serving", called_at: today() }),
    visit({ counter_id: "Doctor 2", status: "completed", completed_at: today() }),
    visit({ counter_id: "Doctor 2", status: "cancelled" }),
    visit({ counter_id: "Doctor 2", status: "no-show" }),
    visit({ counter_id: "Doctor 2", created_at: YESTERDAY }),
    visit({ counter_id: null }) // round robin: pending reassignment, no doctor yet
  );
  return rows;
}

test("each doctor's waiting count covers only its own waiting visits, confirmed or pending", () => {
  const rows = scenario();
  assert.deepEqual([1, 2, 3].map((n) => summaryFor(rows, `Doctor ${n}`).waiting), [5, 3, 2]);
  const doctor2 = summaryFor(rows, "Doctor 2");
  assert.deepEqual({ ready: doctor2.ready, awaiting: doctor2.awaiting_confirmation, notPresent: doctor2.not_present },
    { ready: 1, awaiting: 1, notPresent: 1 });
  assert.equal(doctor2.visit_ids.length, 3);
  assert.equal(new Set([1, 2, 3].flatMap((n) => summaryFor(rows, `Doctor ${n}`).visit_ids)).size, 10, "no visit counts for two doctors");
});

test("serving, completed, cancelled, no-show, earlier days and duplicate records are excluded", () => {
  const rows = scenario();
  const duplicate = { ...rows[0] };
  assert.equal(summaryFor([...rows, duplicate], "Doctor 1").waiting, 5);
  const ids = summaryFor(rows, "Doctor 2").visit_ids;
  for (const row of rows.filter((p) => p.status !== "waiting" || p.created_at === YESTERDAY)) {
    assert.ok(!ids.includes(row.id), `${row.status} visit ${row.id} must not count`);
  }
});

test("Front Desk confirmation moves a visit between the breakdowns but not in or out of the count", () => {
  const pending = visit({ counter_id: "Doctor 2" });
  const before = summaryFor([pending], "Doctor 2");
  const after = summaryFor([{ ...pending, confirmed_at: today(), confirmed_by: "frontdesk", confirmed_for: "Doctor 2" }], "Doctor 2");
  assert.equal(before.waiting, 1);
  assert.equal(after.waiting, 1);
  assert.deepEqual(before.visit_ids, after.visit_ids);
  assert.deepEqual([before.ready, after.ready], [0, 1]);
});

test("calling a patient removes it from the count; Undo back to waiting restores it", () => {
  const row = confirmed({ counter_id: "Doctor 2" });
  assert.equal(summaryFor([{ ...row, status: "serving", called_at: today() }], "Doctor 2").waiting, 0);
  // Round-robin Undo returns counter_id NULL; the confirmation remembers its doctor (OC1 confirmed_for).
  assert.equal(summaryFor([{ ...row, counter_id: null, confirmed_for: "Doctor 2" }], "Doctor 2").waiting, 1);
  assert.equal(waitingVisitDoctor({ ...row, counter_id: null, confirmed_for: "Doctor 2" }, "round_robin", routeOf), "Doctor 2");
});

test("dispatch modes: service routes an unassigned visit by service; shared leaves it with no doctor", () => {
  const rows = [visit({ service_type: "prenatal" }), visit({ service_type: "consultation" })];
  assert.equal(summaryFor(rows, "Doctor 2", "service").waiting, 1);
  assert.equal(summaryFor(rows, "Doctor 1", "service").waiting, 1);
  assert.equal(summaryFor(rows, "Doctor 2", "shared").waiting, 0);
  assert.equal(summaryFor(rows, "Doctor 2", "round_robin").waiting, 0);
});

test("a legacy numeric assignment is matched through the doctor's counter", () => {
  const rows = [visit({ counter_id: "2" })];
  const normalizeDoctor = (value) => (String(value) === "2" ? "Doctor 2" : String(value));
  assert.equal(buildDoctorWaitingSummary({ patients: rows, doctor: "Doctor 2", mode: "round_robin", inQueueWindow: inToday, routeOf, normalizeDoctor }).waiting, 1);
});

// This harness runs the backend in service dispatch, where an unassigned visit routes by its
// service (covered above), so the round-robin "no doctor yet" row is left out here.
function seeded() {
  const h = createRealAuthHarness();
  h.database.patients.push(...scenario().filter((row) => row.counter_id).map((row) => ({ ...row })));
  return h;
}
const myQueue = async (h, account) => (await h.request("GET", "/queue", { token: h.signIn(account).token })).body;

test("GET /queue gives each doctor account only its own count, chosen from the validated session", async () => {
  const h = seeded();
  for (const [account, doctor, waiting] of [["admin1", "Doctor 1", 5], ["admin2", "Doctor 2", 3], ["admin3", "Doctor 3", 2]]) {
    const body = await myQueue(h, account);
    assert.equal(body.success, true);
    assert.equal(body.my_queue.doctor, doctor);
    assert.equal(body.my_queue.waiting, waiting);
    assert.equal(body.my_queue.visit_ids.length, waiting);
    assert.match(body.my_queue.business_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(body.my_queue).sort(),
      ["awaiting_confirmation", "business_date", "doctor", "not_present", "observed_at", "ready", "visit_ids", "waiting"],
      "the summary carries counts and visit ids only, never names or tickets");
  }
});

test("Front Desk and Superadmin get no doctor count; existing GET /queue fields are unchanged", async () => {
  const h = seeded();
  for (const account of ["frontdesk", "frontdesk2", "superadmin"]) {
    const body = await myQueue(h, account);
    assert.equal(body.success, true);
    assert.equal(body.my_queue, null, account);
    assert.ok(Array.isArray(body.patients) && Array.isArray(body.counters));
  }
});

test("a token claiming another doctor is refused before any count is computed", async () => {
  const h = seeded();
  const { session } = h.signIn("admin2");
  const forged = h.sign({ id_num: "admin2", role: "admin", doctor_name: "Doctor 1", jti: session.session_id });
  const response = await h.request("GET", "/queue", { token: forged });
  assert.equal(response.status, 401);
  assert.equal(response.body.my_queue, undefined);
});

test("a new registration for Doctor 2 raises only Doctor 2's count", async () => {
  const h = seeded();
  const before = await Promise.all(["admin1", "admin2", "admin3"].map((a) => myQueue(h, a)));
  const arrival = visit({ counter_id: "Doctor 2" });
  h.database.patients.push(arrival);
  const after = await Promise.all(["admin1", "admin2", "admin3"].map((a) => myQueue(h, a)));
  assert.deepEqual(before.map((b) => b.my_queue.waiting), [5, 3, 2]);
  assert.deepEqual(after.map((b) => b.my_queue.waiting), [5, 4, 2]);
  assert.ok(after[1].my_queue.visit_ids.includes(arrival.id));
  assert.ok(!after[0].my_queue.visit_ids.includes(arrival.id) && !after[2].my_queue.visit_ids.includes(arrival.id));
});
