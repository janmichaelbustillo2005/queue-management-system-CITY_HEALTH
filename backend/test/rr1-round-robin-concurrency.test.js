// RR1 round-robin assignment at registration on REAL PostgreSQL 17 with independent connections (the c1f5w1
// fixture: a disposable loopback cluster only; Supabase targets are refused). Each race is forced
// by holding a real row lock on another connection and waiting until the contenders are queued
// behind it (pg_stat_activity), so the database, not the test's timing, decides the outcome.
// Skips unless PHASE25_PG_URL and PHASE25_PG_MODULE are set (see c1f5w1Fixture.js).
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const RR1 = "20261109-rr1-round-robin-dispatch.sql";
// FC1 is installed after RR1 (the backend refuses every Call without it). These races are about
// assignment and ticket numbers, so visits are confirmed on arrival (as in the PGlite suite).
const FC1 = "20261111-fc1-front-desk-confirmation.sql";
const CONFIRMED_ON_ARRIVAL = `ALTER TABLE public.patients ALTER COLUMN confirmed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN confirmed_by SET DEFAULT 'frontdesk';`;
const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const ACCOUNT = { "Doctor 1": "admin1", "Doctor 2": "admin2", "Doctor 3": "admin3" };

describe("RR1 round-robin dispatch on real PostgreSQL 17 (independent connections)", { skip: f.unavailable }, () => {
  let db;
  let h;
  let other;   // a second backend instance sharing the database, as a second server would
  let tokens;

  before(async () => {
    await f.startCluster();
    db = await f.createDatabase("rr1", [f.C1.migration, f.F5.migration, f.W1.migration, RR1, FC1]);
    await db.setup.query(CONFIRMED_ON_ARRIVAL);
  });
  after(async () => { await f.stopCluster(); });

  beforeEach(async () => {
    await db.observer.query(`UPDATE public.counters SET current_patient_id = NULL, is_online = true;
      DELETE FROM public.patients; DELETE FROM public.patient_assignment_history; DELETE FROM public.staff_auth_sessions;
      UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL, rotation_date = NULL;`);
    h = await f.backend(db, { doctorDispatchMode: "round_robin" });
    other = await f.backend(db, { doctorDispatchMode: "round_robin" });
    tokens = await f.signInAll(h);
  });

  // ---- helpers ----------------------------------------------------------------------------
  const one = (sql, values) => f.one(db, sql, values);
  async function visit(ticket, { priority = 1, minutesAgo = 0, service = "consultation" } = {}) {
    return Number(await one(`INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score,
        vulnerability_flags, created_at) VALUES ($1, $2, $3, 'waiting', $4, '[]', clock_timestamp() - ($5 * interval '1 minute'))
      RETURNING id AS value`, [`Synthetic ${ticket}`, ticket, service, priority, minutesAgo]));
  }
  const doctorOf = async (id) => (await f.patient(db, id)).counter_id;
  const signOut = (doctor) => db.observer.query(`UPDATE public.staff_auth_sessions SET revoked_at = clock_timestamp()
    WHERE user_id_num = $1 AND revoked_at IS NULL`, [ACCOUNT[doctor]]);
  const goStale = (doctor) => db.observer.query(`UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '90 seconds'
    WHERE user_id_num = $1`, [ACCOUNT[doctor]]);
  const dispatch = (harness = h) => harness.queue.runRoundRobinDispatch();
  const history = async (reason) => (await db.observer.query(`SELECT patient_id, previous_doctor, new_doctor, reason FROM public.patient_assignment_history
    WHERE $1::text IS NULL OR reason = $1 ORDER BY id`, [reason ?? null])).rows;
  async function holdRotation() {
    const client = await db.connect("rr1-rotation-blocker");
    await client.query("BEGIN");
    await client.query("SELECT 1 FROM public.doctor_rotation_state WHERE id = 1 FOR UPDATE");
    return { release: async () => { await client.query("COMMIT"); await client.end(); } };
  }
  const settle = (promises) => Promise.allSettled(promises);
  // Ownership invariants on top of the fixture's patient/counter invariants: one visit per ticket,
  // and a waiting visit belongs to at most one known doctor.
  async function assertSingleOwnership() {
    await f.assertConsistent(db);
    const { rows: [row] } = await db.observer.query(`SELECT
      (SELECT count(*) FROM (SELECT queue_number FROM public.patients GROUP BY 1 HAVING count(*) > 1) d)::int AS duplicate_tickets,
      (SELECT count(*) FROM public.patients p WHERE p.status::text = 'waiting' AND p.counter_id IS NOT NULL
        AND p.counter_id NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3'))::int AS waiting_with_unknown_doctor`);
    assert.deepEqual(row, { duplicate_tickets: 0, waiting_with_unknown_doctor: 0 });
  }
  // register_visit_round_robin on its own connection, as a separate backend request would run it.
  // The database assigns the ticket number; the proposal only carries the service code.
  async function registerDirect(name, { proposal = "GP-001", extra = {}, withTicket = false } = {}) {
    const client = await db.connect(`rr1-register-${name}`);
    try {
      await client.query("SET ROLE service_role");
      const { rows: [row] } = await client.query(`SELECT (r).counter_id AS doctor, (r).queue_number AS ticket, (r).id AS id
        FROM (SELECT public.register_visit_round_robin($1::jsonb,
          date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila',
          (date_trunc('day', now() AT TIME ZONE 'Asia/Manila') + interval '1 day') AT TIME ZONE 'Asia/Manila') AS r) s`,
        [JSON.stringify({ queue_number: proposal, id_num: `Synthetic ${name}`, service_type: "medical_consultation", priority_score: 1, ...extra })]);
      return withTicket ? row : row.doctor;
    } finally { await client.end(); }
  }

  // ---- R1 ---------------------------------------------------------------------------------
  test("R1: six registrations queued on the rotation lock are assigned D1, D2, D3, D1, D2, D3 in commit order", async () => {
    const blocker = await holdRotation();
    const registrations = Array.from({ length: 6 }, (_, i) => registerDirect(`R1-${i}`));
    await f.waitForLockWaiters(db, 6);
    await blocker.release();
    const results = await settle(registrations);
    assert.deepEqual(results.map((r) => r.status), Array(6).fill("fulfilled"), JSON.stringify(results.map((r) => r.reason?.message)));
    assert.deepEqual((await history("round_robin_assignment")).map((row) => row.new_doctor), [...DOCTORS, ...DOCTORS]);
    assert.deepEqual(results.map((r) => r.value).sort(), [...DOCTORS, ...DOCTORS].sort());
    await assertSingleOwnership();
  });

  test("R1b: registrations through two backends at once never share a rotation position or a ticket", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      f.post(i % 2 ? other : h, tokens.frontdesk, "/queue", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: `R1b ${i}`, service_type: "medical_consultation" })));
    assert.deepEqual(responses.map((r) => r.status), Array(6).fill(200), JSON.stringify(responses.map((r) => r.body?.message)));
    assert.deepEqual((await history("round_robin_assignment")).map((row) => row.new_doctor), [...DOCTORS, ...DOCTORS]);
    await assertSingleOwnership();
  });

  test("R1c: dispatch passes from two backends assign each unassigned visit exactly once, in rotation", async () => {
    for (let i = 0; i < 6; i += 1) await visit(`R1C-${i}`, { minutesAgo: 10 - i });
    const blocker = await holdRotation();
    const passes = [dispatch(h), dispatch(other), dispatch(h), dispatch(other)];
    await f.waitForLockWaiters(db, 4);
    await blocker.release();
    const results = await settle(passes);
    assert.deepEqual(results.map((r) => r.status), Array(4).fill("fulfilled"), JSON.stringify(results.map((r) => r.reason?.message)));
    assert.equal(results.reduce((sum, r) => sum + r.value.assigned.length, 0), 6, "six assignments in total");
    const assigned = await history("round_robin_assignment");
    assert.deepEqual(assigned.map((row) => row.new_doctor), [...DOCTORS, ...DOCTORS]);
    assert.equal(new Set(assigned.map((row) => row.patient_id)).size, 6, "no visit assigned twice");
    await assertSingleOwnership();
  });

  test("R1d: a doctor signing out while a registration waits for the rotation lock is not assigned", async () => {
    const blocker = await holdRotation();
    const pending = registerDirect("R1D-1");
    await f.waitForLockWaiters(db, 1);
    await signOut("Doctor 1");   // committed while the registration is queued; it reads presence after its locks
    await blocker.release();
    assert.equal(await pending, "Doctor 2");
  });

  // ---- R2 ---------------------------------------------------------------------------------
  test("R2: a dispatch racing the assigned doctor's Call never gives that doctor a second visit", async () => {
    const p1 = await visit("R2-1", { minutesAgo: 5 });
    await visit("R2-2", { minutesAgo: 4 });
    await signOut("Doctor 2"); await signOut("Doctor 3");
    await dispatch();
    assert.equal(await doctorOf(p1), "Doctor 1");
    const counters = await f.holdCounters(db);
    const racing = [f.post(h, tokens.admin1, "/queue/call", { patient_id: p1 }), dispatch(other)];
    await f.waitForLockWaiters(db, 2);
    await counters.release();
    const [called, pass] = await settle(racing);
    assert.equal(called.value.status, 200, called.value.body?.message);
    assert.equal(pass.status, "fulfilled", pass.reason?.message);
    assert.equal((await f.patient(db, p1)).status, "serving");
    await assertSingleOwnership();
  });

  // ---- R3 ---------------------------------------------------------------------------------
  test("R3: a doctor signing out while a dispatch waits for its lock receives nothing", async () => {
    const p1 = await visit("R3-1", { minutesAgo: 5 });
    const blocker = await holdRotation();
    const pass = dispatch();
    await f.waitForLockWaiters(db, 1);
    await signOut("Doctor 1");   // committed while the pass is queued; it reads presence after its locks
    await blocker.release();
    await pass;
    assert.equal(await doctorOf(p1), "Doctor 2");
    assert.ok(!(await history()).some((row) => row.new_doctor === "Doctor 1"));
  });

  // ---- R4 ---------------------------------------------------------------------------------
  test("R4: the same visit called twice at once (two connections): one Call wins, the other changes nothing", async () => {
    const p1 = await visit("R4-1");
    await signOut("Doctor 2"); await signOut("Doctor 3");
    await dispatch();
    const revision = (await f.patient(db, p1)).visit_state_revision;
    const callAs = async (doctor, account) => {
      const client = await db.connect(`rr1-call-${account}`);
      try {
        await client.query("SET ROLE service_role");
        return await client.query(`SELECT id FROM public.call_patient_visit_rr($1, $2, $3, $4,
          now() - interval '1 day', now() + interval '1 day', now(), false)`, [p1, doctor, account, revision]);
      } finally { await client.end(); }
    };
    const counters = await f.holdCounters(db);
    const racing = [callAs("Doctor 1", "admin1"), callAs("Doctor 1", "admin1"), callAs("Doctor 2", "admin2")];
    await f.waitForLockWaiters(db, 3);
    await counters.release();
    const results = await settle(racing);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.reason?.message)));
    // The visit revision is checked before ownership, so once the winner commits both losers see a
    // changed visit (40001); an owner check (42501) would refuse the other doctor just the same.
    const codes = results.filter((r) => r.status === "rejected").map((r) => r.reason.code);
    assert.equal(codes.length, 2);
    assert.ok(codes.every((code) => ["40001", "42501"].includes(code)), codes.join());
    const row = await f.patient(db, p1);
    assert.equal(row.status, "serving");
    assert.equal(row.counter_id, "Doctor 1");
    await assertSingleOwnership();
  });

  // ---- R5 ---------------------------------------------------------------------------------
  test("R5: two staff transfers of one consultation at once: exactly one wins", async () => {
    const p1 = await visit("R5-1");
    await signOut("Doctor 2"); await signOut("Doctor 3");
    await dispatch();
    assert.equal((await f.post(h, tokens.admin1, "/queue/call", { patient_id: p1 })).status, 200);
    await goStale("Doctor 1");
    tokens.admin2 = (await h.login("admin2", "synthetic-admin2-password")).token;
    tokens.admin3 = (await h.login("admin3", "synthetic-admin3-password")).token;
    const blocker = await holdRotation();
    const racing = [
      f.post(h, tokens.frontdesk, "/queue/transfer", { patient_id: p1, doctor: "Doctor 2" }),
      f.post(other, tokens.superadmin, "/queue/transfer", { patient_id: p1, doctor: "Doctor 3" })
    ];
    await f.waitForLockWaiters(db, 2);
    await blocker.release();
    const results = (await settle(racing)).map((r) => r.value);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body.message)));
    assert.ok(results.some((r) => r.status === 409), "the loser sees a changed visit");
    await assertSingleOwnership();
  });

  // ---- R6 ---------------------------------------------------------------------------------
  test("R6: Cancel racing a dispatch never leaves the cancelled visit assigned", async () => {
    const p1 = await visit("R6-1", { minutesAgo: 5 });
    const p2 = await visit("R6-2", { minutesAgo: 4 });
    await signOut("Doctor 2"); await signOut("Doctor 3");
    const counters = await f.holdCounters(db);
    const racing = [f.post(h, tokens.frontdesk, "/queue/cancel", { patient_id: p1, reason: "Left before being called" }), dispatch(other)];
    await f.waitForLockWaiters(db, 2);
    await counters.release();
    const results = await settle(racing);
    const cancelled = results[0].value;
    if (cancelled.status === 409) {
      // The dispatch won: assigning the visit rotated its revision, so W1 refused the stale Cancel
      // and changed nothing. Frontdesk refreshes and cancels again.
      assert.match(cancelled.body.message, /changed/);
      assert.equal((await f.patient(db, p1)).status, "waiting");
      const retried = await f.post(h, tokens.frontdesk, "/queue/cancel", { patient_id: p1, reason: "Left before being called" });
      assert.equal(retried.status, 200, retried.body?.message);
    } else {
      assert.equal(cancelled.status, 200, cancelled.body?.message);
    }
    await dispatch();
    assert.equal((await f.patient(db, p1)).status, "cancelled");
    assert.equal(await doctorOf(p2), "Doctor 1");
    await assertSingleOwnership();
  });

  // ---- R7 ---------------------------------------------------------------------------------
  test("R7: availability switched off while a dispatch runs leaves that doctor with no waiting visit", async () => {
    for (let i = 0; i < 3; i += 1) await visit(`R7-${i}`, { minutesAgo: 5 - i });
    const counters = await f.holdCounters(db);
    const racing = [dispatch(other), f.post(h, tokens.superadmin, "/counters/availability", { doctors: { "Doctor 2": false } })];
    await f.waitForLockWaiters(db, 2);
    await counters.release();
    const results = await settle(racing);
    assert.equal(results[1].value.status, 200, results[1].value.body?.message);
    await dispatch();
    assert.equal(Number(await one("SELECT count(*) AS value FROM public.patients WHERE status = 'waiting' AND counter_id = 'Doctor 2'")), 0);
    await assertSingleOwnership();
  });

  // ---- R8 ---------------------------------------------------------------------------------
  test("R8: parallel sweeps after a doctor drops record one reassignment and one intervention, never more", async () => {
    const serving = await visit("R8-S", { minutesAgo: 9 });
    const pending = await visit("R8-P", { minutesAgo: 8 });
    await signOut("Doctor 2"); await signOut("Doctor 3");
    await dispatch();
    assert.equal((await f.post(h, tokens.admin1, "/queue/call", { patient_id: serving })).status, 200);
    await signOut("Doctor 1");
    await db.observer.query("UPDATE public.staff_auth_sessions SET revoked_at = NULL WHERE user_id_num = 'admin2'");
    // Doctor 1 serves `serving` and still holds `pending`, which must be reassigned exactly once.
    assert.equal(await doctorOf(pending), "Doctor 1");
    const blocker = await holdRotation();
    const sweeps = [dispatch(h), dispatch(other), dispatch(h), dispatch(other), dispatch(h)];
    await f.waitForLockWaiters(db, 5);
    await blocker.release();
    const results = await settle(sweeps);
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.reason?.message)));
    // One row per move (2026-11-11): previous_doctor Doctor 1 -> new_doctor Doctor 2, no release row.
    const moves = (await history("round_robin_reassignment")).filter((row) => Number(row.patient_id) === pending);
    assert.deepEqual(moves.map((row) => [row.previous_doctor, row.new_doctor]), [["Doctor 1", "Doctor 2"]]);
    assert.equal((await history("doctor_unavailable")).length, 0);
    assert.equal((await history("intervention_required")).length, 1);
    assert.equal(await doctorOf(pending), "Doctor 2");
    assert.equal((await f.patient(db, serving)).counter_id, "Doctor 1", "the active consultation is not moved");
    await assertSingleOwnership();
  });

  // ---- R10-R12: ticket numbers under real contention (2026-11-11) -------------------------
  test("R10: 24 registrations queued on the rotation lock with the SAME proposed ticket get unique, gap-free tickets", async () => {
    const blocker = await holdRotation();
    const registrations = Array.from({ length: 24 }, (_, i) => registerDirect(`R10-${i}`, { proposal: "GP-001", withTicket: true }));
    await f.waitForLockWaiters(db, 24);
    await blocker.release();
    const results = await settle(registrations);
    assert.deepEqual(results.map((r) => r.status), Array(24).fill("fulfilled"), JSON.stringify(results.map((r) => r.reason?.message)));
    const rows = (await db.observer.query("SELECT id::int AS id, queue_number, counter_id FROM public.patients ORDER BY id")).rows;
    assert.equal(rows.length, 24);
    assert.deepEqual(rows.map((row) => row.queue_number), Array.from({ length: 24 }, (_, i) => `GP-${String(i + 1).padStart(3, "0")}`),
      "unique, contiguous, in commit order");
    assert.deepEqual(rows.map((row) => row.counter_id), Array.from({ length: 24 }, (_, i) => DOCTORS[i % 3]), "exact rotation in commit order");
    assert.deepEqual((await history("round_robin_assignment")).map((row) => Number(row.patient_id)), rows.map((row) => row.id));
    assert.deepEqual(results.map((r) => r.value.ticket).sort(), rows.map((row) => row.queue_number).sort(), "each caller got its saved ticket");
    await assertSingleOwnership();
  });

  test("R11: 24 registrations through three backends and three routes at once: each saved once, unique tickets per code, exact rotation", async () => {
    const third = await f.backend(db, { doctorDispatchMode: "round_robin" });
    const desks = [h, other, third];
    const services = ["medical_consultation", "family_planning", "prenatal", "dental_healthcare", "maternity", "nutrition"];
    const blocker = await holdRotation();
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const harness = desks[i % 3];
      const serviceType = services[i % services.length];
      const name = `R11-${i}`;
      if (i % 3 === 0) return f.post(harness, tokens.frontdesk, "/queue", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: name, service_type: serviceType });
      if (i % 3 === 1) return harness.request("POST", "/queue/website", { body: { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: name, serviceType } });
      return f.post(harness, tokens.frontdesk, "/patient-records/visits", {
        firstName: name, lastName: "Concurrent", sex: "Female", birthdate: "1990-01-01", residency: "Purok 1, Poblacion 1, Cabadbaran City, Agusan del Norte", serviceType });
    });
    await f.waitForLockWaiters(db, 12);
    await blocker.release();
    const responses = await Promise.all(jobs);
    assert.deepEqual(responses.map((r) => r.status), Array(24).fill(200), JSON.stringify(responses.map((r) => r.body?.message)));
    const rows = (await db.observer.query("SELECT id::int AS id, queue_number, service_type, counter_id FROM public.patients ORDER BY id")).rows;
    assert.equal(rows.length, 24, "every valid registration saved exactly once");
    assert.equal(new Set(rows.map((row) => row.queue_number)).size, 24, "every ticket number is unique");
    const code = { medical_consultation: "MC", family_planning: "FP", prenatal: "OB", dental_healthcare: "DH", maternity: "OB", nutrition: "NT" };
    for (const prefix of ["MC", "FP", "OB", "DH", "NT"]) {
      const numbers = rows.filter((row) => code[row.service_type] === prefix).map((row) => row.queue_number);
      assert.ok(numbers.length > 0, prefix);
      assert.deepEqual(numbers, numbers.map((_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`), prefix);
    }
    assert.deepEqual(rows.map((row) => row.counter_id), Array.from({ length: 24 }, (_, i) => DOCTORS[i % 3]));
    const saved = new Set(rows.map((row) => row.queue_number));
    assert.ok(responses.every((r) => saved.has(r.body.queue_number)), "each response shows its saved ticket");
    const { rows: [pointer] } = await db.observer.query("SELECT last_doctor, last_patient_id::int AS last FROM public.doctor_rotation_state");
    assert.deepEqual(pointer, { last_doctor: "Doctor 3", last: rows.at(-1).id });
    await assertSingleOwnership();
  });

  test("R12: a registration failing mid-burst consumes neither a ticket number nor a rotation turn", async () => {
    const blocker = await holdRotation();
    const registrations = Array.from({ length: 9 }, (_, i) => registerDirect(`R12-${i}`,
      { withTicket: true, extra: i === 4 ? { birthdate: "not-a-date" } : {} }));
    await f.waitForLockWaiters(db, 9);
    await blocker.release();
    const results = await settle(registrations);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(results[4].status, "rejected");
    const rows = (await db.observer.query("SELECT queue_number, counter_id FROM public.patients ORDER BY id")).rows;
    assert.deepEqual(rows.map((row) => row.queue_number), Array.from({ length: 8 }, (_, i) => `GP-${String(i + 1).padStart(3, "0")}`), "no gap");
    assert.deepEqual(rows.map((row) => row.counter_id), Array.from({ length: 8 }, (_, i) => DOCTORS[i % 3]), "no skipped turn");
    assert.equal((await history("round_robin_assignment")).length, 8);
    await assertSingleOwnership();
  });

  // ---- R9 ---------------------------------------------------------------------------------
  test("R9: a randomized burst of registrations, dispatches, calls, completions and sign-outs deadlocks nothing", async () => {
    const errors = [];
    const note = (promise) => promise.then((response) => {
      if (response && typeof response.status === "number" && response.status >= 500) errors.push(response.body?.message);
    }).catch((error) => errors.push(error.message));
    for (let round = 0; round < 10; round += 1) {
      const work = [];
      for (let i = 0; i < 4; i += 1) {
        work.push(note(f.post(i % 2 ? h : other, tokens.frontdesk, "/queue", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: `R9 ${round}-${i}`, service_type: ["medical_consultation", "maternal_healthcare", "family_planning", "child_healthcare"][i] })));
      }
      work.push(note(dispatch(h)), note(dispatch(other)));
      for (const doctor of DOCTORS) {
        // The head of the doctor's own list (all Regular: first come, first served).
        const own = await one("SELECT id AS value FROM public.patients WHERE status = 'waiting' AND counter_id = $1 ORDER BY created_at, id LIMIT 1", [doctor]);
        const serving = await one("SELECT id AS value FROM public.patients WHERE status = 'serving' AND counter_id = $1 LIMIT 1", [doctor]);
        const token = tokens[ACCOUNT[doctor]];
        if (serving) {
          // Finish the current consultation (Start, then Complete), which frees the doctor.
          work.push(note((async () => {
            await f.post(h, token, "/queue/start", { patient_id: Number(serving) });
            return f.post(other, token, "/queue/complete", { patient_id: Number(serving) });
          })()));
        } else if (own) {
          work.push(note(f.post(round % 2 ? h : other, token, "/queue/call", { patient_id: Number(own) })));
        }
      }
      await Promise.all(work);
      if (round === 2) { await goStale("Doctor 3"); await dispatch(); }
      if (round === 4) { tokens.admin3 = (await h.login("admin3", "synthetic-admin3-password")).token; }
      await assertSingleOwnership();
    }
    assert.deepEqual(errors.filter((message) => /deadlock|40P01/i.test(String(message))), []);
    assert.deepEqual(errors, [], "no request failed with a server error");
    assert.ok(Number(await one("SELECT count(*) AS value FROM public.patients WHERE status = 'completed'")) > 0, "the burst served patients");
  });
});
