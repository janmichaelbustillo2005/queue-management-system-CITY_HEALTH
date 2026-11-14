// OC1 one Front Desk confirmation at a time per doctor, on REAL PostgreSQL 17 with independent
// connections (the c1f5w1 fixture: a disposable loopback cluster only; Supabase targets are
// refused). Each race is forced by holding the counter row locks on another connection and waiting
// until the contenders are queued behind them (pg_stat_activity), so the database, not the
// test's timing, decides the outcome. Skips unless PHASE25_PG_URL and PHASE25_PG_MODULE are set.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const FC1 = "20261111-fc1-front-desk-confirmation.sql";
const OC1 = "20261113-oc1-one-confirmation-per-doctor.sql";
const DOCTOR_OF = { consultation: "Doctor 1", prenatal: "Doctor 2", family_planning: "Doctor 3" };

describe("OC1 one confirmation per doctor on real PostgreSQL 17 (independent connections)", { skip: f.unavailable }, () => {
  let db;
  let h;
  let other;   // a second backend instance (a second Front Desk server) sharing the database
  let tokens;

  before(async () => {
    await f.startCluster();
    db = await f.createDatabase("oc1", [f.C1.migration, f.F5.migration, f.W1.migration, FC1, OC1]);
  });
  after(async () => { await f.stopCluster(); });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await f.backend(db);
    other = await f.backend(db);
    tokens = await f.signInAll(h);
  });

  async function visit(ticket, { service = "consultation", priority = 0, minutesAgo = 0 } = {}) {
    return Number(await f.one(db, `INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score,
        vulnerability_flags, created_at) VALUES ($1, $2, $3, 'waiting', $4, '[]', clock_timestamp() - ($5 * interval '1 minute'))
      RETURNING id AS value`, [`Synthetic ${ticket}`, ticket, service, priority, minutesAgo]));
  }
  const confirm = (harness, id) => f.post(harness, tokens.frontdesk, "/queue/confirm", { patient_id: id });
  const confirmed = async () => (await db.observer.query(`SELECT service_type, queue_number FROM public.patients
    WHERE status = 'waiting' AND confirmed_at IS NOT NULL ORDER BY queue_number`)).rows;
  // The invariant: no doctor ever holds more than one confirmed or active visit (serving included).
  async function assertOnePerDoctor() {
    const perDoctor = {};
    for (const row of await confirmed()) perDoctor[DOCTOR_OF[row.service_type]] = (perDoctor[DOCTOR_OF[row.service_type]] || 0) + 1;
    for (const [doctor, count] of Object.entries(perDoctor)) assert.ok(count <= 1, `${doctor} has ${count} confirmed visits`);
    const { rows } = await db.observer.query(`SELECT d, count(*)::int AS n FROM (SELECT public.qms_oc1_active_doctor(p.status::text,
        p.service_type, p.counter_id, p.confirmed_at, p.confirmed_for, p.completed_at, p.created_at, public.qms_oc1_day_start()) AS d
      FROM public.patients p) x WHERE d IS NOT NULL GROUP BY d HAVING count(*) > 1`);
    assert.deepEqual(rows, [], "a doctor has more than one confirmed or active visit");
    await f.assertConsistent(db);
  }
  const notPresent = (harness, id) => f.post(harness, tokens.frontdesk, "/queue/not-present", { patient_id: id });
  const present = (harness, id) => f.post(harness, tokens.frontdesk, "/queue/present", { patient_id: id });
  async function race(requests, waiters) {
    const blocker = await f.holdCounters(db);
    const racing = requests();
    await f.waitForLockWaiters(db, waiters);
    await blocker.release();
    return Promise.all(racing);
  }

  test("simultaneous confirmations from two servers for the same doctor: exactly one is saved", async () => {
    const head = await visit("GP-001", { minutesAgo: 3 });
    const second = await visit("GP-002", { minutesAgo: 2 });
    const third = await visit("GP-003", { minutesAgo: 1 });
    const blocker = await f.holdCounters(db);
    const racing = [confirm(h, head), confirm(other, head), confirm(other, second), confirm(h, third)];
    await f.waitForLockWaiters(db, 4);
    await blocker.release();
    const results = await Promise.all(racing);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 409, 409]);
    assert.equal(results.slice(0, 2).filter((r) => r.body.already_confirmed === false).length, 1, "one write for the double click");
    assert.deepEqual(await confirmed(), [{ service_type: "consultation", queue_number: "GP-001" }]);
    await assertOnePerDoctor();
  });

  test("simultaneous confirmations for all three doctors: each doctor gets its own head, none blocks another", async () => {
    const heads = [await visit("GP-001", { minutesAgo: 5 }), await visit("OB-001", { service: "prenatal", minutesAgo: 5 }),
      await visit("FP-001", { service: "family_planning", minutesAgo: 5 })];
    const seconds = [await visit("GP-002"), await visit("OB-002", { service: "prenatal" }), await visit("FP-002", { service: "family_planning" })];
    const blocker = await f.holdCounters(db);
    const racing = [...heads.map((id, i) => confirm(i % 2 ? other : h, id)), ...seconds.map((id, i) => confirm(i % 2 ? h : other, id))];
    await f.waitForLockWaiters(db, 6);
    await blocker.release();
    const results = await Promise.all(racing);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 409, 409, 409]);
    assert.deepEqual((await confirmed()).map((r) => r.queue_number), ["FP-001", "GP-001", "OB-001"]);
    await assertOnePerDoctor();
  });

  test("the lost-update race: a confirmation still in flight on one connection is seen by the next one", async () => {
    // Without the counter lock, the second transaction would read the first confirmation as not
    // yet committed, see the newly registered senior as Doctor 1's head, and confirm it too.
    const regular = await visit("GP-001", { minutesAgo: 2 });
    const first = await db.connect("oc1-first-desk");
    try {
      await first.query("SET ROLE service_role");
      await first.query("BEGIN");
      await first.query(`SELECT public.confirm_next_patient_visit($1, 'frontdesk', now() - interval '1 day', now() + interval '1 day',
        clock_timestamp(), false, 'service')`, [regular]);
      const senior = await visit("GP-002", { priority: 4 });   // committed while the first desk is still open
      const second = confirm(other, senior);
      await f.waitForLockWaiters(db, 1);
      await first.query("COMMIT");
      const result = await second;
      assert.equal(result.status, 409);
      assert.match(result.body.message, /Doctor 1 already has an active patient \(GP-001\)/);
    } finally {
      await first.end();
    }
    assert.deepEqual(await confirmed(), [{ service_type: "consultation", queue_number: "GP-001" }]);
    await assertOnePerDoctor();
  });

  test("a confirmation racing the doctor's Call and Complete: the next patient unlocks only after the commit", async () => {
    const current = await visit("GP-001", { minutesAgo: 2 });
    const next = await visit("GP-002", { minutesAgo: 1 });
    f.expectStatus(await confirm(h, current), 200);
    // The Call and the next confirmation queue behind the same counters; whichever runs second sees the first.
    const blocker = await f.holdCounters(db);
    const racing = [f.post(h, tokens.admin1, "/queue/call", { patient_id: current }), confirm(other, next)];
    await f.waitForLockWaiters(db, 2);
    await blocker.release();
    const [called, early] = await Promise.all(racing);
    f.expectStatus(called, 200);
    f.expectStatus(early, 409, /already has an active patient/);
    f.expectStatus(await f.post(h, tokens.admin1, "/queue/start", { patient_id: current }), 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.expectStatus(await f.post(h, tokens.admin1, "/queue/complete", { patient_id: current }), 200);
    f.expectStatus(await confirm(other, next), 200);
    await assertOnePerDoctor();
  });

  test("Not Present and Confirm of the same patient at once: exactly one applies", async () => {
    const head = await visit("GP-001", { minutesAgo: 2 });
    const next = await visit("GP-002", { minutesAgo: 1 });
    const [confirmedResult, markedResult] = await race(() => [confirm(h, head), notPresent(other, head)], 2);
    const row = await f.patient(db, head);
    if (row.confirmed_at != null) {
      f.expectStatus(confirmedResult, 200);
      f.expectStatus(markedResult, 409, /already confirmed/);
      assert.equal(row.not_present_at, null);
    } else {
      f.expectStatus(markedResult, 200);
      f.expectStatus(confirmedResult, 409, /Not Present/);
      f.expectStatus(await confirm(h, next), 200);
    }
    await assertOnePerDoctor();
  });

  test("Present of an earlier patient racing Confirm of the next one: never two confirmations, WPS order kept", async () => {
    const earlier = await visit("GP-001", { minutesAgo: 3 });
    const later = await visit("GP-002", { minutesAgo: 1 });
    f.expectStatus(await notPresent(h, earlier), 200);
    const [back, confirmedLater] = await race(() => [present(other, earlier), confirm(h, later)], 2);
    f.expectStatus(back, 200);
    if (confirmedLater.status === 200) {
      // The confirmation ran first: the returning patient waits for that visit to finish.
      assert.equal((await f.patient(db, earlier)).confirmed_at, null);
      f.expectStatus(await confirm(h, earlier), 409, /already has an active patient/);
    } else {
      // Present ran first: the earlier patient is the doctor's next patient again.
      f.expectStatus(confirmedLater, 409, /Only the next patient/);
      f.expectStatus(await confirm(h, earlier), 200);
    }
    await assertOnePerDoctor();
  });

  test("Undo racing a confirmation for the same doctor: exactly one applies; the loser is told why", async () => {
    const first = await visit("GP-001", { minutesAgo: 3 });
    const second = await visit("GP-002", { minutesAgo: 1 });
    f.expectStatus(await confirm(h, first), 200);
    f.expectStatus(await f.post(h, tokens.admin1, "/queue/call", { patient_id: first }), 200);
    f.expectStatus(await f.post(h, tokens.frontdesk, "/queue/cancel", { patient_id: first, reason: "Mistake", counter_id: "Doctor 1" }), 200);
    const [undone, confirmedSecond] = await race(() => [f.post(other, tokens.frontdesk, "/queue/undo", { patient_id: first }), confirm(h, second)], 2);
    const statuses = [undone.status, confirmedSecond.status].sort();
    assert.deepEqual(statuses, [200, 409], `${undone.body.message} / ${confirmedSecond.body.message}`);
    if (undone.status === 409) assert.match(undone.body.message, /^Undo was not applied\. Doctor 1 already has an active patient \(GP-002\)/);
    else assert.match(confirmedSecond.body.message, /Doctor 1 already has an active patient \(GP-001\)/);
    await assertOnePerDoctor();
  });

  test("three doctors, each with Confirm, Not Present and Undo traffic at once: one active patient per doctor", async () => {
    const services = ["consultation", "prenatal", "family_planning"];
    const lists = [];
    for (const [i, service] of services.entries()) {
      const prefix = ["GP", "OB", "FP"][i];
      lists.push([await visit(`${prefix}-001`, { service, minutesAgo: 4 }), await visit(`${prefix}-002`, { service, minutesAgo: 3 }),
        await visit(`${prefix}-003`, { service, minutesAgo: 2 })]);
    }
    const results = await race(() => lists.flatMap(([a, b, c]) => [confirm(h, a), confirm(other, b), notPresent(other, a), confirm(h, c)]), 12);
    assert.ok(results.every((r) => [200, 409].includes(r.status)), results.map((r) => r.body.message).join(" | "));
    const perDoctor = await db.observer.query(`SELECT service_type, count(*)::int AS n FROM public.patients
      WHERE status = 'waiting' AND confirmed_at IS NOT NULL GROUP BY 1 ORDER BY 1`);
    for (const row of perDoctor.rows) assert.equal(row.n, 1, row.service_type);
    await assertOnePerDoctor();
  });
});
