// OC1 one Front Desk confirmation at a time per doctor. The REAL routes, JWT middleware and
// services (pgBackendHarness) against a fresh, synthetic, in-memory PGlite database with FC1 + OC1
// (and RR1 where stated). Never loads .env or the Supabase client and never touches real data.
// PGlite has ONE connection: "simultaneous" requests interleave at statement boundaries; the
// lock-contention races run on real PostgreSQL in oc1-one-confirmation-concurrency.test.js.
const assert = require("node:assert/strict");
const { describe, test, before, beforeEach, after } = require("node:test");
const bcrypt = require("bcryptjs");
const { liveKnownDatabase, readScript } = require("./helpers/liveKnownSchema");
const { createPgBackendHarness } = require("./helpers/pgBackendHarness");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to the installed package.";
}

const DEVELOPMENT_STATE = ["20261023-phase-b2-records.sql", "20261025-c1-atomic-call.sql",
  "20261022-f5-requeue-terminal-recovery.sql", "20261025-w1-atomic-cancel.sql", "20261103-patient-records.sql",
  "add-account-cancellation-requests.sql", "20261110-ar1-staff-archive.sql"];
const RR1 = "20261109-rr1-round-robin-dispatch.sql";
const FC1 = "20261111-fc1-front-desk-confirmation.sql";
const OC1 = "20261113-oc1-one-confirmation-per-doctor.sql";
const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const ACCOUNTS = {
  superadmin: ["superadmin", null], frontdesk: ["admin", null], frontdesk2: ["admin", "Front Desk"],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const DOCTOR_ACCOUNT = { "Doctor 1": "admin1", "Doctor 2": "admin2", "Doctor 3": "admin3" };
const BUSY = /already has an active patient/;
const NOT_NEXT = /Only the next patient in/;
const password = (idNum) => `synthetic-${idNum}-password`;

async function freshDatabase(scripts) {
  const db = await liveKnownDatabase(PGlite);
  for (const script of scripts) await db.exec(readScript(script));
  await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  await db.exec(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  return db;
}

function helpers(getDb, getH, tokens) {
  const db = () => getDb();
  const h = () => getH();
  const row = async (id) => (await db().query("SELECT row_to_json(p) AS v FROM public.patients p WHERE id = $1", [id])).rows[0].v;
  const idOf = async (queueNumber) =>
    Number((await db().query("SELECT id FROM public.patients WHERE queue_number = $1", [queueNumber])).rows[0].id);
  async function register(name, { service = "medical_consultation", flags = [] } = {}) {
    const response = await h().request("POST", "/queue", { token: tokens.frontdesk, body: { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: name, service_type: service, vulnerabilityFlags: flags } });
    assert.equal(response.status, 200, response.body.message);
    return { ...response.body, id: await idOf(response.body.queue_number) };
  }
  // A visit written directly (service dispatch needs the former service keys; aging needs a past
  // registration time). Pending confirmation, like every new visit.
  async function insert(ticket, { service = "consultation", priority = 0, minutesAgo = 0, doctor = null } = {}) {
    const { rows: [inserted] } = await db().query(`INSERT INTO public.patients (id_num, queue_number, service_type, status,
        priority_score, vulnerability_flags, counter_id, created_at)
      VALUES ($1, $2, $3, 'waiting', $4, '[]', $5, clock_timestamp() - ($6 * interval '1 minute')) RETURNING id`,
      [`Synthetic ${ticket}`, ticket, service, priority, doctor, minutesAgo]);
    return { id: Number(inserted.id), queue_number: ticket };
  }
  const confirm = (id, token = tokens.frontdesk) => h().request("POST", "/queue/confirm", { token, body: { patient_id: id } });
  const call = (doctor, id) => h().request("POST", "/queue/call", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  async function finish(doctor, id) {
    const token = tokens[DOCTOR_ACCOUNT[doctor]];
    const started = await h().request("POST", "/queue/start", { token, body: { patient_id: id } });
    assert.equal(started.status, 200, started.body.message);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const completed = await h().request("POST", "/queue/complete", { token, body: { patient_id: id } });
    assert.equal(completed.status, 200, completed.body.message);
  }
  async function serve(doctor, id) {
    const called = await call(doctor, id);
    assert.equal(called.status, 200, called.body.message);
    await finish(doctor, id);
  }
  const queue = async () => {
    const response = await h().request("GET", "/queue", { token: tokens.frontdesk });
    assert.equal(response.status, 200, response.body.message);
    return response.body.patients;
  };
  const listed = async (id) => (await queue()).find((p) => Number(p.id) === Number(id));
  // The pending visits the screens offer Confirm Patient for, by queue number.
  const confirmable = async () => (await queue()).filter((p) => p.confirmable).map((p) => p.queue_number).sort();
  const confirmedCount = async (doctor) => Number((await db().query(`SELECT count(*) AS n FROM public.patients
    WHERE counter_id = $1 AND status = 'waiting' AND confirmed_at IS NOT NULL`, [doctor])).rows[0].n);
  // The database decision for one visit, rolled back: does confirm_next_patient_visit accept it?
  async function databaseAccepts(id, { mode, aging = false }) {
    await db().query("BEGIN");
    try {
      await db().query(`SELECT public.confirm_next_patient_visit($1, 'frontdesk', now() - interval '1 day', now() + interval '1 day',
        clock_timestamp(), $2, $3)`, [id, aging, mode]);
      return true;
    } catch (error) {
      if (error.code !== "P0001") throw error;
      return false;
    } finally {
      await db().query("ROLLBACK");
    }
  }
  return { row, register, insert, confirm, call, finish, serve, queue, listed, confirmable, confirmedCount, databaseAccepts };
}

async function resetRoundRobin(db) {
  await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
    DELETE FROM public.staff_auth_sessions; DELETE FROM public.patient_assignment_history;
    UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL, rotation_date = NULL;
    INSERT INTO public.counters (id_num, is_online) VALUES ('Doctor 1', true), ('Doctor 2', true), ('Doctor 3', true);`);
}

describe("OC1 with round-robin dispatch: one confirmation at a time for each doctor (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  const tokens = {};
  const s = helpers(() => db, () => h, tokens);

  before(async () => { db = await freshDatabase([...DEVELOPMENT_STATE, RR1, FC1, OC1]); });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await resetRoundRobin(db);
    h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, { doctorDispatchMode: "round_robin" });
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  });

  // Nine regular patients: rotation gives each doctor three, in registration order.
  async function nine() {
    const byDoctor = { "Doctor 1": [], "Doctor 2": [], "Doctor 3": [] };
    for (let i = 1; i <= 9; i++) {
      const visit = await s.register(`Patient ${i}`);
      byDoctor[visit.assigned_doctor].push(visit);
    }
    for (const doctor of DOCTORS) assert.equal(byDoctor[doctor].length, 3, doctor);
    return byDoctor;
  }

  test("each doctor's earliest pending patient is the only one with Confirm Patient; the database refuses the others", async () => {
    const byDoctor = await nine();
    assert.deepEqual(await s.confirmable(), DOCTORS.map((d) => byDoctor[d][0].queue_number).sort());
    for (const doctor of DOCTORS) {
      const [head, second, third] = byDoctor[doctor];
      for (const waiting of [second, third]) {
        const entry = await s.listed(waiting.id);
        assert.equal(entry.confirmable, false);
        assert.equal(entry.confirmation_blocked, "not_next_for_doctor");
        assert.equal(entry.confirmation_blocked_by, head.queue_number);
        const before = await s.row(waiting.id);
        const refused = await s.confirm(waiting.id);
        assert.equal(refused.status, 409, `${doctor} ${waiting.queue_number}`);
        assert.match(refused.body.message, NOT_NEXT);
        assert.deepEqual(await s.row(waiting.id), before, "a refused confirmation changes nothing");
      }
    }
  });

  test("each doctor independently: the next patient unlocks only when the previous visit is completed", async () => {
    const byDoctor = await nine();
    // Confirm every doctor's first patient: Doctor 1's open visit never blocks Doctor 2 or 3.
    for (const doctor of DOCTORS) assert.equal((await s.confirm(byDoctor[doctor][0].id)).status, 200, doctor);
    assert.deepEqual(await s.confirmable(), [], "every doctor now has an active patient");
    for (const doctor of DOCTORS) {
      const entry = await s.listed(byDoctor[doctor][1].id);
      assert.equal(entry.confirmation_blocked, "doctor_has_active_patient");
      assert.equal(entry.confirmation_blocked_by, byDoctor[doctor][0].queue_number);
      const refused = await s.confirm(byDoctor[doctor][1].id);
      assert.equal(refused.status, 409);
      assert.match(refused.body.message, BUSY);
    }

    // Doctor 2 runs ahead through its whole list while Doctor 1 and Doctor 3 are mid-transaction.
    assert.equal((await s.call("Doctor 1", byDoctor["Doctor 1"][0].id)).status, 200);
    for (let i = 0; i < 3; i++) {
      const visit = byDoctor["Doctor 2"][i];
      if (i > 0) {
        assert.equal((await s.listed(visit.id)).confirmable, true, `Doctor 2 #${i + 1} unlocks after #${i}`);
        assert.equal((await s.confirm(visit.id)).status, 200);
      }
      // Called and in consultation is still active: the following patient stays locked.
      assert.equal((await s.call("Doctor 2", visit.id)).status, 200);
      if (i < 2) assert.equal((await s.confirm(byDoctor["Doctor 2"][i + 1].id)).status, 409, "serving blocks the next confirmation");
      await s.finish("Doctor 2", visit.id);
    }
    assert.equal((await s.confirm(byDoctor["Doctor 1"][1].id)).status, 409, "Doctor 1 is still serving its first patient");
    assert.equal((await s.confirm(byDoctor["Doctor 3"][1].id)).status, 409, "Doctor 3's confirmed patient is still waiting");

    // Doctor 1 and Doctor 3 finish theirs, one patient at a time.
    await s.finish("Doctor 1", byDoctor["Doctor 1"][0].id);
    await s.serve("Doctor 3", byDoctor["Doctor 3"][0].id);
    for (const doctor of ["Doctor 1", "Doctor 3"]) {
      for (const visit of byDoctor[doctor].slice(1)) {
        assert.equal((await s.listed(visit.id)).confirmable, true, `${doctor} ${visit.queue_number}`);
        assert.equal((await s.confirm(visit.id)).status, 200);
        assert.equal(await s.confirmedCount(doctor), 1);
        await s.serve(doctor, visit.id);
      }
    }
    const statuses = (await db.query("SELECT status, count(*)::int AS n FROM public.patients GROUP BY status")).rows;
    assert.deepEqual(statuses, [{ status: "completed", n: 9 }]);
  });

  test("cancelled and no-show patients never block the next eligible patient", async () => {
    // The development project's known schema has no 'no-show' status label; production does.
    await db.exec("RESET ROLE; ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'no-show'; SET ROLE service_role;");
    const byDoctor = await nine();
    // Doctor 1: the pending first patient leaves -> the second is next immediately.
    const [d1a, d1b, d1c] = byDoctor["Doctor 1"];
    assert.equal((await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: d1a.id, reason: "Left" } })).status, 200);
    assert.equal((await s.listed(d1b.id)).confirmable, true);
    assert.equal((await s.confirm(d1b.id)).status, 200);
    // The confirmed second patient is cancelled while waiting -> the third is next.
    assert.equal((await s.confirm(d1c.id)).status, 409);
    assert.equal((await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: d1b.id, reason: "Left" } })).status, 200);
    assert.equal((await s.confirm(d1c.id)).status, 200);

    // Doctor 2: the called patient is marked no-show -> the next one unlocks.
    const [d2a, d2b] = byDoctor["Doctor 2"];
    assert.equal((await s.confirm(d2a.id)).status, 200);
    assert.equal((await s.call("Doctor 2", d2a.id)).status, 200);
    // The existing no-show rule waits 10 minutes after the call.
    await db.query("UPDATE public.patients SET called_at = called_at - interval '15 minutes' WHERE id = $1", [d2a.id]);
    const noShow = await h.request("POST", "/queue/no-show", { token: tokens.admin2, body: { patient_id: d2a.id, reason: "Did not come in" } });
    assert.equal(noShow.status, 200, noShow.body.message);
    assert.equal((await s.confirm(d2b.id)).status, 200);

    // Doctor 3: the serving patient is cancelled -> the next one unlocks.
    const [d3a, d3b] = byDoctor["Doctor 3"];
    assert.equal((await s.confirm(d3a.id)).status, 200);
    assert.equal((await s.call("Doctor 3", d3a.id)).status, 200);
    const cancelled = await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: d3a.id, reason: "Left", counter_id: "Doctor 3" } });
    assert.equal(cancelled.status, 200, cancelled.body.message);
    assert.equal((await s.confirm(d3b.id)).status, 200);
  });

  test("WPS is unchanged: a later senior is the doctor's next patient; priorities, tickets and doctors are untouched", async () => {
    const regulars = [];
    for (let i = 1; i <= 3; i++) regulars.push(await s.register(`Regular ${i}`));
    const senior = await s.register("Senior", { flags: ["senior"] });
    assert.equal(senior.assigned_doctor, "Doctor 1");
    const before = (await db.query("SELECT id, queue_number, priority_score, counter_id, created_at FROM public.patients ORDER BY id")).rows;

    const entry = await s.listed(regulars[0].id);
    assert.equal(entry.confirmable, false, "the earlier regular patient waits behind the senior");
    assert.equal(entry.confirmation_blocked_by, senior.queue_number);
    assert.match((await s.confirm(regulars[0].id)).body.message, NOT_NEXT);
    assert.equal((await s.confirm(senior.id)).status, 200);
    assert.equal((await s.confirm(regulars[1].id)).status, 200, "Doctor 2 is independent");
    await s.serve("Doctor 1", senior.id);
    assert.equal((await s.confirm(regulars[0].id)).status, 200, "then the regular patient is next");

    const afterRows = (await db.query("SELECT id, queue_number, priority_score, counter_id, created_at FROM public.patients ORDER BY id")).rows;
    assert.deepEqual(afterRows, before, "no ticket, priority, doctor or registration time changed");
  });

  test("a visit pending reassignment has no doctor and cannot be confirmed; it does not block anyone", async () => {
    const assigned = await s.register("Assigned");
    const unassigned = await s.insert("GP-900", { service: "medical_consultation" });
    const entry = await s.listed(unassigned.id);
    assert.equal(entry.confirmable, false);
    assert.equal(entry.confirmation_blocked, "awaiting_doctor_assignment");
    const refused = await s.confirm(unassigned.id);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /waiting for a doctor assignment/);
    assert.equal((await s.confirm(assigned.id)).status, 200);
  });

  test("the rule cannot be bypassed: direct function calls, FC1's old entry point and table writes are refused", async () => {
    const [head, second] = [await s.register("Head 1"), await s.register("Head 2"), await s.register("Head 3"), await s.register("Second 1")]
      .filter((v) => v.assigned_doctor === "Doctor 1");
    await assert.rejects(db.query(`SELECT public.confirm_next_patient_visit($1, 'frontdesk', now() - interval '1 day', now() + interval '1 day',
      clock_timestamp(), false, 'round_robin')`, [second.id]), (error) => error.code === "P0001" && error.hint === "not_next_for_doctor");
    await assert.rejects(db.query(`SELECT public.confirm_next_patient_visit($1, 'admin1', now() - interval '1 day', now() + interval '1 day',
      clock_timestamp(), false, 'round_robin')`, [head.id]), (error) => error.code === "42501");
    // FC1's confirm_patient_visit (an older backend) and a direct write cannot add a confirmation.
    await assert.rejects(db.query("SELECT public.confirm_patient_visit($1, 'frontdesk', now() - interval '1 day', now() + interval '1 day')", [second.id]),
      (error) => error.code === "P0001" && error.hint === "one_confirmation_per_doctor");
    await assert.rejects(db.query("UPDATE public.patients SET confirmed_at = now(), confirmed_by = 'frontdesk' WHERE id = $1", [second.id]),
      (error) => error.code === "P0001" && error.hint === "one_confirmation_per_doctor");
    assert.equal((await s.row(second.id)).confirmed_at, null);
    assert.equal((await s.confirm(head.id)).status, 200);
    await assert.rejects(db.query(`SELECT public.confirm_next_patient_visit($1, 'frontdesk', now() - interval '1 day', now() + interval '1 day',
      clock_timestamp(), false, 'round_robin')`, [second.id]), (error) => error.code === "P0001" && error.hint === "doctor_has_active_patient");
    // The browser roles cannot reach the function at all.
    for (const role of ["anon", "authenticated"]) {
      const { rows: [grant] } = await db.query(`SELECT has_function_privilege($1,
        'public.confirm_next_patient_visit(bigint,text,timestamptz,timestamptz,timestamptz,boolean,text)', 'EXECUTE') AS allowed`, [role]);
      assert.equal(grant.allowed, false, role);
    }
  });

  test("simultaneous confirmations: one per doctor is saved; a double click is idempotent", async () => {
    const byDoctor = await nine();
    const d1 = byDoctor["Doctor 1"];
    const results = await Promise.all([
      s.confirm(d1[0].id), s.confirm(d1[0].id, tokens.frontdesk2), s.confirm(d1[1].id), s.confirm(d1[2].id, tokens.frontdesk2),
      s.confirm(byDoctor["Doctor 2"][0].id), s.confirm(byDoctor["Doctor 3"][0].id)
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 409, 409, 200, 200]);
    assert.equal(results.slice(0, 2).filter((r) => r.body.already_confirmed === false).length, 1, "the double click writes once");
    for (const doctor of DOCTORS) assert.equal(await s.confirmedCount(doctor), 1, doctor);
  });

  test("the screens' Confirm Patient flag matches the database decision, with and without WPS aging", async () => {
    for (const aging of [false, true]) {
      await resetRoundRobin(db);
      h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) },
        { doctorDispatchMode: "round_robin", envOverrides: { wpsAging: aging } });
      for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
      // Doctor 1: a regular patient waiting 25 minutes (aging +2) and a solo parent (1) just now.
      const waited = await s.insert("GP-101", { minutesAgo: 25, doctor: "Doctor 1", service: "medical_consultation" });
      const soloParent = await s.insert("GP-102", { priority: 1, doctor: "Doctor 1", service: "medical_consultation" });
      // Doctor 2: a confirmed patient is active. Doctor 3: two equal regular patients.
      const active = await s.insert("GP-201", { doctor: "Doctor 2", service: "medical_consultation" });
      assert.equal((await s.confirm(active.id)).status, 200);
      const behind = await s.insert("GP-202", { priority: 4, doctor: "Doctor 2", service: "medical_consultation" });
      const first = await s.insert("GP-301", { minutesAgo: 2, doctor: "Doctor 3", service: "medical_consultation" });
      const next = await s.insert("GP-302", { minutesAgo: 1, doctor: "Doctor 3", service: "medical_consultation" });

      const expectedHead = aging ? waited : soloParent;
      assert.deepEqual(await s.confirmable(), [expectedHead.queue_number, first.queue_number].sort(), `aging ${aging}`);
      for (const visit of [waited, soloParent, behind, first, next]) {
        assert.equal(await s.databaseAccepts(visit.id, { mode: "round_robin", aging }), (await s.listed(visit.id)).confirmable,
          `${visit.queue_number}, aging ${aging}`);
      }
    }
  });
});

describe("OC1 with service dispatch (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  const tokens = {};
  const s = helpers(() => db, () => h, tokens);

  before(async () => { db = await freshDatabase([...DEVELOPMENT_STATE, FC1, OC1]); });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
      DELETE FROM public.staff_auth_sessions;
      INSERT INTO public.counters (id_num, service_types, is_online) VALUES ('Doctor 1', '["consultation","checkup"]', true),
        ('Doctor 2', '["prenatal","maternity"]', true), ('Doctor 3', '["family_planning"]', true);`);
    h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) });
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  });

  test("each service's doctor has its own single confirmable patient and its own completion unlock", async () => {
    const lists = {
      "Doctor 1": [await s.insert("GP-001", { minutesAgo: 9 }), await s.insert("GP-002", { minutesAgo: 8, service: "checkup" })],
      "Doctor 2": [await s.insert("OB-001", { minutesAgo: 7, service: "prenatal" }), await s.insert("OB-002", { minutesAgo: 6, service: "maternity" })],
      "Doctor 3": [await s.insert("FP-001", { minutesAgo: 5, service: "family_planning" }), await s.insert("FP-002", { minutesAgo: 4, service: "family_planning" })]
    };
    assert.deepEqual(await s.confirmable(), ["FP-001", "GP-001", "OB-001"]);
    for (const doctor of DOCTORS) {
      const [first, second] = lists[doctor];
      assert.equal((await s.confirm(second.id)).status, 409);
      assert.equal((await s.confirm(first.id)).status, 200);
      assert.equal((await s.confirm(second.id)).status, 409);
      for (const other of DOCTORS.filter((d) => d !== doctor)) {
        // The other doctors' state is whatever their own transactions left it.
        assert.ok(["not_next_for_doctor", "doctor_has_active_patient", null].includes((await s.listed(lists[other][0].id)).confirmation_blocked));
      }
    }
    await s.serve("Doctor 2", lists["Doctor 2"][0].id);
    assert.deepEqual(await s.confirmable(), ["OB-002"], "only Doctor 2 finished its transaction");
    assert.equal((await s.confirm(lists["Doctor 2"][1].id)).status, 200);
  });

  test("a previous day's serving visit occupies its doctor, as it blocks that doctor's Call", async () => {
    const { rows: [old] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at, created_at)
      VALUES ('Yesterday', 'GP-OLD', 'consultation', 'serving', 'Doctor 1', now() - interval '1 day', now() - interval '1 day') RETURNING id`);
    await db.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = 'Doctor 1'", [old.id]);
    const today = await s.insert("GP-001");
    const ob = await s.insert("OB-001", { service: "prenatal" });
    const entry = await s.listed(today.id);
    assert.equal(entry.confirmation_blocked, "doctor_has_active_patient");
    assert.equal(entry.confirmation_blocked_by, "GP-OLD");
    assert.equal((await s.confirm(today.id)).status, 409);
    assert.equal((await s.confirm(ob.id)).status, 200, "Doctor 2 is not affected");
    const cancelled = await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: Number(old.id), reason: "Stale", counter_id: "Doctor 1" } });
    assert.equal(cancelled.status, 200, cancelled.body.message);
    assert.equal((await s.confirm(today.id)).status, 200);
  });
});

describe("OC1 with shared (D1) dispatch: no doctor before the Call, so no doctor rule (isolated PGlite)", { skip: unavailable }, () => {
  test("every pending visit stays confirmable, as before OC1", async () => {
    const db = await freshDatabase([...DEVELOPMENT_STATE, FC1, OC1]);
    try {
      await db.exec(`INSERT INTO public.counters (id_num, is_online) VALUES ('Doctor 1', true), ('Doctor 2', true), ('Doctor 3', true);`);
      const h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, { doctorDispatchMode: "shared" });
      const tokens = { frontdesk: (await h.login("frontdesk", password("frontdesk"))).token };
      const s = helpers(() => db, () => h, tokens);
      const a = await s.insert("GP-001", { minutesAgo: 2 });
      const b = await s.insert("GP-002", { minutesAgo: 1 });
      assert.deepEqual(await s.confirmable(), ["GP-001", "GP-002"]);
      assert.equal((await s.confirm(b.id)).status, 200);
      assert.equal((await s.confirm(a.id)).status, 200);
    } finally {
      await db.close();
    }
  });
});

describe("OC1 installation lifecycle (isolated PGlite)", { skip: unavailable }, () => {
  const lastRows = async (db, sql) => (await db.exec(sql)).filter((result) => result.fields.length).pop().rows;

  test("preflight requires FC1; install is repeatable and keeps every row; verify passes; FC1 still verifies; rollback removes only OC1", async () => {
    const db = await liveKnownDatabase(PGlite);
    try {
      for (const script of [...DEVELOPMENT_STATE, RR1]) await db.exec(readScript(script));
      const withoutFc1 = await lastRows(db, readScript("20261113-oc1-preflight.sql"));
      assert.equal(withoutFc1[0].all_pass, false, "FC1 is required");
      await assert.rejects(db.exec(readScript(OC1)), /OC1 requires FC1/);
      await db.exec("ROLLBACK");
      assert.equal((await db.query("SELECT to_regprocedure('public.qms_oc1_visit_doctor(text,text,text)') IS NULL AS absent")).rows[0].absent, true,
        "nothing is installed without FC1");

      await db.exec(readScript(FC1));
      await db.exec(`INSERT INTO public.counters (id_num) VALUES ('Doctor 1'), ('Doctor 2'), ('Doctor 3');
        INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id) VALUES
          ('Existing waiting', 'GP-001', 'consultation', 'waiting', 'Doctor 1'), ('Existing done', 'GP-002', 'consultation', 'completed', 'Doctor 1');`);
      const data = async () => (await db.query(`SELECT id, status, counter_id, queue_number, priority_score, created_at,
        visit_state_revision, confirmed_at FROM public.patients ORDER BY id`)).rows;
      const preWithoutOc1Columns = await lastRows(db, readScript("20261113-oc1-preflight.sql"));
      assert.deepEqual(preWithoutOc1Columns.filter((row) => !row.passed), []);
      const pre = await lastRows(db, readScript("20261113-oc1-preflight.sql"));
      assert.equal(pre.length, 8);
      assert.equal(pre[2].actual, "FC1 version", "the guard OC1 replaces is FC1's reviewed version");
      assert.deepEqual(pre.filter((row) => !row.passed), []);
      const before = await data();

      await db.exec(readScript(OC1));
      await db.exec(readScript(OC1));
      assert.deepEqual(await data(), before, "installation updates no patient row");
      const verify = await lastRows(db, readScript("20261113-oc1-verify.sql"));
      assert.equal(verify.length, 10);
      assert.equal(verify[8].actual, "equal", "OC1's WPS-A formula is RR1's");
      assert.deepEqual(verify.filter((row) => !row.passed), []);
      assert.deepEqual((await lastRows(db, readScript("20261111-fc1-verify.sql"))).filter((row) => !row.passed), [], "FC1 still verifies");
      assert.equal((await lastRows(db, readScript("20261113-oc1-preflight.sql"))).every((row) => row.passed), true, "re-run preflight");

      // Re-running FC1 later (e.g. after a Call script) restores FC1's guard: verify says so, and
      // re-running OC1 restores OC1's.
      await db.exec(readScript(FC1));
      assert.deepEqual((await lastRows(db, readScript("20261113-oc1-verify.sql"))).filter((row) => !row.passed).map((row) => row.position), [5]);
      await db.exec(readScript(OC1));
      assert.deepEqual((await lastRows(db, readScript("20261113-oc1-verify.sql"))).filter((row) => !row.passed), []);

      await db.exec(readScript("20261113-oc1-rollback.sql"));
      await db.exec(readScript("20261113-oc1-rollback.sql"));
      const leftovers = (await db.query(`SELECT
          to_regprocedure('public.confirm_next_patient_visit(bigint,text,timestamptz,timestamptz,timestamptz,boolean,text)') IS NULL AS confirm_gone,
          to_regprocedure('public.qms_oc1_visit_doctor(text,text,text)') IS NULL AS helper_gone,
          to_regprocedure('public.qms_oc1_guard_confirmation()') IS NULL AS guard_gone,
          NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'patients_one_confirmation_per_doctor') AS trigger_gone,
          to_regprocedure('public.set_patient_presence(bigint,text,timestamptz,timestamptz,boolean)') IS NULL AS presence_gone,
          to_regprocedure('public.confirm_patient_visit(bigint,text,timestamptz,timestamptz)') IS NOT NULL AS fc1_kept,
          (SELECT md5(replace(prosrc, E'\\r\\n', E'\\n')) FROM pg_proc WHERE proname = 'qms_guard_front_desk_confirmation') AS fc1_guard,
          (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'patients'
            AND column_name IN ('confirmed_for', 'not_present_at', 'not_present_by')) AS kept_columns`)).rows[0];
      assert.deepEqual(leftovers, { confirm_gone: true, helper_gone: true, guard_gone: true, trigger_gone: true, presence_gone: true,
        fc1_kept: true, fc1_guard: "383dbaea4d0ca70da328ba64a7dfcfaa", kept_columns: 3 });
      assert.deepEqual((await lastRows(db, readScript("20261111-fc1-verify.sql"))).filter((row) => !row.passed), [], "FC1 intact after rollback");
      assert.deepEqual(await data(), before);

      await db.exec(readScript(OC1));
      assert.deepEqual((await lastRows(db, readScript("20261113-oc1-verify.sql"))).filter((row) => !row.passed), [], "reinstall");
    } finally {
      await db.close();
    }
  });
});

describe("OC1 strict rule: Not Present, reassignment, Undo, transfer and direct writes (round robin, isolated PGlite)", { skip: unavailable }, () => {
  let db;
  let h;
  const tokens = {};
  const s = helpers(() => db, () => h, tokens);
  const signOut = (doctor) => h.request("POST", "/auth/logout", { token: tokens[DOCTOR_ACCOUNT[doctor]] });
  const signIn = async (doctor) => { tokens[DOCTOR_ACCOUNT[doctor]] = (await h.login(DOCTOR_ACCOUNT[doctor], password(DOCTOR_ACCOUNT[doctor]))).token; };
  const post = (route, body, token = tokens.frontdesk) => h.request("POST", route, { token, body });
  const notPresent = (id, token) => post("/queue/not-present", { patient_id: id }, token);
  const present = (id, token) => post("/queue/present", { patient_id: id }, token);
  const doctorOf = async (id) => (await s.row(id)).counter_id;
  // The invariant, read straight from the database: no doctor has two active visits.
  async function assertOneActivePerDoctor() {
    const { rows } = await db.query(`SELECT d, count(*)::int AS n FROM (SELECT public.qms_oc1_active_doctor(p.status::text, p.service_type,
        p.counter_id, p.confirmed_at, p.confirmed_for, p.completed_at, p.created_at, public.qms_oc1_day_start()) AS d
      FROM public.patients p) x WHERE d IS NOT NULL GROUP BY d HAVING count(*) > 1`);
    assert.deepEqual(rows, [], "a doctor has more than one confirmed or active patient");
  }

  before(async () => {
    db = await freshDatabase([...DEVELOPMENT_STATE, RR1, FC1, OC1]);
    await db.exec("RESET ROLE; ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'no-show'; SET ROLE service_role;");
  });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await resetRoundRobin(db);
    h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, { doctorDispatchMode: "round_robin", envOverrides: { wpsAging: true } });
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  });

  async function nine() {
    const byDoctor = { "Doctor 1": [], "Doctor 2": [], "Doctor 3": [] };
    for (let i = 1; i <= 9; i++) {
      const visit = await s.register(`Patient ${i}`);
      byDoctor[visit.assigned_doctor].push(visit);
    }
    return byDoctor;
  }

  test("Not Present, for each doctor: the next patient becomes confirmable; the absent one keeps ticket, priority, time and doctor", async () => {
    const byDoctor = await nine();
    const kept = "SELECT queue_number, priority_score, created_at, counter_id, status FROM public.patients WHERE id = $1";
    for (const doctor of DOCTORS) {
      const [absent, second, third] = byDoctor[doctor];
      const before = (await db.query(kept, [absent.id])).rows[0];
      const marked = await notPresent(absent.id);
      assert.equal(marked.status, 200, marked.body.message);
      assert.equal(marked.body.changed, true);
      assert.deepEqual((await db.query(kept, [absent.id])).rows[0], before, `${doctor}: nothing but presence changes`);
      const entry = await s.listed(absent.id);
      assert.equal(entry.confirmable, false);
      assert.equal(entry.confirmation_blocked, "patient_not_present");
      assert.notEqual(entry.not_present_at, null);
      const refused = await s.confirm(absent.id);
      assert.equal(refused.status, 409);
      assert.match(refused.body.message, /marked Not Present/);
      assert.equal((await s.listed(second.id)).confirmable, true, `${doctor}: the next patient is not blocked`);
      assert.equal((await s.listed(third.id)).confirmable, false);
    }
    // Each doctor confirms and starts serving its second patient; the absent patients return meanwhile.
    for (const doctor of DOCTORS) {
      const [absent, second, third] = byDoctor[doctor];
      assert.equal((await s.confirm(second.id)).status, 200);
      assert.equal((await s.call(doctor, second.id)).status, 200);
      const back = await present(absent.id);
      assert.equal(back.status, 200, back.body.message);
      const entry = await s.listed(absent.id);
      assert.equal(entry.confirmable, false, "a returning patient never interrupts the active visit");
      assert.equal(entry.confirmation_blocked, "doctor_has_active_patient");
      assert.equal((await s.row(second.id)).status, "serving", "the visit in progress is untouched");
      await s.finish(doctor, second.id);
      // Original WPS rank: registered before the third patient, so it is next again.
      assert.equal((await s.listed(absent.id)).confirmable, true, `${doctor}: the returning patient keeps its place`);
      assert.equal((await s.listed(third.id)).confirmation_blocked_by, absent.queue_number);
    }
    await assertOneActivePerDoctor();
  });

  test("Not Present keeps WPS-A: the returning patient's aging continued while it was set aside", async () => {
    // Doctor 1: a regular patient registered 25 minutes ago (aging +2) and a solo parent (1) now.
    const waited = await s.insert("GP-101", { minutesAgo: 25, doctor: "Doctor 1", service: "medical_consultation" });
    const soloParent = await s.insert("GP-102", { priority: 1, doctor: "Doctor 1", service: "medical_consultation" });
    assert.equal((await s.listed(waited.id)).confirmable, true, "aging puts the long wait first");
    assert.equal((await notPresent(waited.id)).status, 200);
    assert.equal((await s.listed(soloParent.id)).confirmable, true);
    assert.equal((await present(waited.id)).status, 200);
    assert.equal((await s.listed(waited.id)).confirmable, true, "back at its aged rank");
    assert.equal((await s.listed(soloParent.id)).confirmable, false);
  });

  test("Not Present is Frontdesk-only, pending-only, idempotent, cleared by Re-queue, and cannot be written directly", async () => {
    const [a, b] = [await s.register("A"), await s.register("B")];
    for (const idNum of ["admin1", "superadmin"]) assert.equal((await notPresent(a.id, tokens[idNum])).status, 403, idNum);
    assert.equal((await notPresent(a.id)).status, 200);
    const again = await notPresent(a.id, tokens.frontdesk2);
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false, "a second desk changes nothing");
    assert.equal((await s.confirm(b.id)).status, 200);
    const confirmedRefused = await notPresent(b.id);
    assert.equal(confirmedRefused.status, 409);
    assert.match(confirmedRefused.body.message, /already confirmed/);
    await assert.rejects(db.query("UPDATE public.patients SET not_present_at = NULL, not_present_by = NULL WHERE id = $1", [a.id]),
      (error) => error.code === "P0001" && error.hint === "patient_not_present");
    await assert.rejects(db.query("UPDATE public.patients SET not_present_at = now(), not_present_by = 'frontdesk' WHERE id = $1", [b.id]),
      (error) => error.code === "P0001");
    // Cancel keeps the history; Re-queue starts a new, present turn.
    assert.equal((await post("/queue/cancel", { patient_id: a.id, reason: "Left" })).status, 200);
    assert.notEqual((await s.row(a.id)).not_present_at, null);
    const requeued = await post("/queue/requeue", { patient_id: a.id });
    assert.equal(requeued.status, 200, requeued.body.message);
    const row = await s.row(a.id);
    assert.equal(row.not_present_at, null);
    assert.equal(row.confirmed_at, null);
  });

  test("automatic reassignment clears the confirmation; the new doctor's Front Desk confirms again", async () => {
    const byDoctor = await nine();
    const moved = byDoctor["Doctor 2"][0];
    assert.equal((await s.confirm(moved.id)).status, 200);
    assert.equal((await s.confirm(byDoctor["Doctor 1"][0].id)).status, 200, "Doctor 1 is busy with its own confirmed patient");
    assert.equal((await signOut("Doctor 2")).status, 200);   // the logout route runs the dispatcher
    const row = await s.row(moved.id);
    assert.notEqual(row.counter_id, "Doctor 2");
    assert.equal(row.confirmed_at, null, "the confirmation for Doctor 2 does not carry over");
    assert.equal(row.confirmed_for, null);
    for (const key of ["queue_number", "priority_score", "created_at"]) assert.deepEqual(row[key], moved[key] ?? row[key]);
    await assertOneActivePerDoctor();
    const newDoctor = row.counter_id;
    const entry = await s.listed(moved.id);
    assert.equal(entry.confirmable, newDoctor === "Doctor 3" && entry.confirmable, "confirmable only when it is the new doctor's next free patient");
    // Free the new doctor and walk its list: the moved patient is confirmed again under it.
    const list = (await s.queue()).filter((p) => p.counter_id === newDoctor && p.status === "waiting");
    for (const p of list.filter((p) => p.confirmed_at != null)) await s.serve(newDoctor, Number(p.id));
    for (;;) {
      const next = (await s.queue()).find((p) => p.counter_id === newDoctor && p.confirmable);
      if (!next) break;
      assert.equal((await s.confirm(Number(next.id))).status, 200);
      if (Number(next.id) === moved.id) break;
      await s.serve(newDoctor, Number(next.id));
    }
    const reconfirmed = await s.row(moved.id);
    assert.notEqual(reconfirmed.confirmed_at, null);
    assert.equal(reconfirmed.confirmed_for, newDoctor);
    assert.equal((await s.call(newDoctor, moved.id)).status, 200);
    await assertOneActivePerDoctor();
  });

  test("a confirmed patient held while no doctor is available keeps its confirmation only if its own doctor takes it back", async () => {
    const visit = await s.register("Held");   // Doctor 1
    assert.equal((await s.confirm(visit.id)).status, 200);
    // All three become unavailable at once (heartbeats lost), so nobody can take the patient.
    await db.query(`UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '90 seconds'`);
    await h.queue.requestDispatch();
    assert.equal(await doctorOf(visit.id), null, "pending reassignment");
    assert.notEqual((await s.row(visit.id)).confirmed_at, null, "not reassigned yet: still Doctor 1's patient");
    // Doctor 1 cannot get a new confirmation while its held patient still counts as its active one.
    const waiting = await s.insert("GP-500", { service: "medical_consultation", doctor: "Doctor 1" });
    assert.equal((await s.listed(waiting.id)).confirmation_blocked, "doctor_has_active_patient");
    await db.query("UPDATE public.patients SET counter_id = NULL WHERE id = $1", [waiting.id]);
    await signIn("Doctor 2");
    await h.queue.requestDispatch();
    assert.equal(await doctorOf(visit.id), "Doctor 2");
    assert.equal((await s.row(visit.id)).confirmed_at, null, "placed with another doctor: confirm again");
    await assertOneActivePerDoctor();
  });

  test("Undo is refused while the doctor has another confirmed or active patient, with a clear message; allowed once it is free", async () => {
    for (const doctor of DOCTORS) {
      await resetRoundRobin(db);
      for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
      const byDoctor = await nine();
      const [first, second] = byDoctor[doctor];
      assert.equal((await s.confirm(first.id)).status, 200);
      assert.equal((await s.call(doctor, first.id)).status, 200);
      assert.equal((await post("/queue/cancel", { patient_id: first.id, reason: "Mistake", counter_id: doctor })).status, 200);
      assert.equal((await s.confirm(second.id)).status, 200, `${doctor}: the next patient is confirmed`);
      const before = await s.row(first.id);
      const refused = await post("/queue/undo", { patient_id: first.id });
      assert.equal(refused.status, 409, refused.body.message);
      assert.match(refused.body.message, new RegExp(`^Undo was not applied\\. ${doctor} already has an active patient \\(${second.queue_number}\\)`));
      assert.match(refused.body.message, /only one confirmed or active patient/);
      assert.deepEqual(await s.row(first.id), before, "nothing changed");
      await assertOneActivePerDoctor();
      // Another doctor's Undo is unaffected by this doctor's state; once free, the Undo is applied.
      await s.serve(doctor, second.id);
      const undone = await post("/queue/undo", { patient_id: first.id });
      assert.equal(undone.status, 200, undone.body.message);
      const restored = await s.row(first.id);
      assert.equal(restored.status, "waiting");
      assert.equal(restored.counter_id, doctor, "back to its doctor");
      assert.notEqual(restored.confirmed_at, null, "Undo to the same doctor keeps the confirmation");
      assert.equal((await s.confirm(byDoctor[doctor][2].id)).status, 409, "the restored patient is the doctor's active patient");
      await assertOneActivePerDoctor();
    }
  });

  test("Undo of a visit cancelled before confirmation is never blocked (it returns pending)", async () => {
    const [a, b] = [await s.register("A"), await s.register("B"), await s.register("C"), await s.register("D")]
      .filter((v) => v.assigned_doctor === "Doctor 1");
    assert.equal((await post("/queue/cancel", { patient_id: a.id, reason: "Left" })).status, 200);
    assert.equal((await s.confirm(b.id)).status, 200);
    const undone = await post("/queue/undo", { patient_id: a.id });
    assert.equal(undone.status, 200, undone.body.message);
    assert.equal((await s.row(a.id)).confirmed_at, null);
    await assertOneActivePerDoctor();
  });

  test("a transfer to a doctor with a confirmed or active patient is refused with a clear message", async () => {
    const [p1, p2, p3] = [await s.register("P1"), await s.register("P2"), await s.register("P3")];
    assert.equal((await s.confirm(p1.id)).status, 200);
    assert.equal((await s.call("Doctor 1", p1.id)).status, 200);
    assert.equal((await s.confirm(p2.id)).status, 200);   // Doctor 2 has a confirmed waiting patient
    await db.query(`UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '90 seconds' WHERE user_id_num = 'admin1'`);
    await h.queue.requestDispatch();
    const refused = await post("/queue/transfer", { patient_id: p1.id, doctor: "Doctor 2" });
    assert.equal(refused.status, 409, refused.body.message);
    assert.match(refused.body.message, /^The transfer was not applied\. Doctor 2 already has an active patient/);
    assert.equal(await doctorOf(p1.id), "Doctor 1");
    const moved = await post("/queue/transfer", { patient_id: p1.id, doctor: "Doctor 3" });
    assert.equal(moved.status, 200, moved.body.message);
    assert.equal((await s.row(p1.id)).confirmed_for, "Doctor 3", "the confirmation follows the serving doctor");
    assert.equal((await s.listed(p3.id)).confirmation_blocked, "doctor_has_active_patient");
    await assertOneActivePerDoctor();
  });

  test("direct writes cannot give a doctor a second active patient", async () => {
    const [a, b] = [await s.register("A"), await s.register("B"), await s.register("C"), await s.register("D")]
      .filter((v) => v.assigned_doctor === "Doctor 1");
    assert.equal((await s.confirm(a.id)).status, 200);
    await assert.rejects(db.query("UPDATE public.patients SET status = 'serving', called_at = now() WHERE id = $1", [b.id]),
      (error) => error.code === "P0001");
    await assert.rejects(db.query("UPDATE public.patients SET counter_id = 'Doctor 1', status = 'serving', called_at = now() WHERE id = (SELECT id FROM public.patients WHERE counter_id = 'Doctor 2' LIMIT 1)"),
      (error) => error.code === "P0001");
    await assertOneActivePerDoctor();
  });

  test("WPS-A is the same calculation in JavaScript, the Call's SQL and the confirmation's SQL", async () => {
    const { effectivePriority } = require("../src/lib/wpsPriority");
    // The helpers are closed to service_role (the backend); compare them as their owner.
    await db.exec("RESET ROLE");
    const { rows } = await db.query(`SELECT s AS score, m AS minutes, a AS aging,
        public.qms_oc1_effective_priority(s, now() - m * interval '1 minute', now(), a) AS oc1,
        public.qms_rr_effective_priority(s, now() - m * interval '1 minute', now(), a) AS rr,
        (now() - m * interval '1 minute') AS created_at, now() AS ranked_at
      FROM generate_series(0, 4) s, generate_series(-5, 45) m, (VALUES (true), (false)) v(a)`)
      .finally(() => db.exec("SET ROLE service_role"));
    assert.equal(rows.length, 5 * 51 * 2);
    for (const row of rows) {
      assert.equal(row.oc1, row.rr, JSON.stringify(row));
      const js = effectivePriority({ priority_score: row.score, created_at: new Date(row.created_at).toISOString() }, new Date(row.ranked_at).getTime(), row.aging);
      assert.equal(js, row.oc1, JSON.stringify(row));
    }
    // Weights unchanged: senior 4, PWD 3, pregnant 3, indigenous 2, solo parent 1, regular (no flag) base weight 1.
    const scores = {};
    for (const flag of ["senior", "pwd", "pregnant", "indigenous", "solo_parent"]) scores[flag] = (await s.register(flag, { flags: [flag] })).id;
    const regular = await s.register("regular");
    const stored = async (id) => (await s.row(id)).priority_score;
    assert.deepEqual([await stored(scores.senior), await stored(scores.pwd), await stored(scores.pregnant), await stored(scores.indigenous),
      await stored(scores.solo_parent), await stored(regular.id)], [4, 3, 3, 2, 1, 1]);
  });

  test("simultaneous Not Present, Present and Confirm requests for the same doctor leave one consistent outcome", async () => {
    const [a, b, c] = [await s.register("A"), await s.register("x"), await s.register("y"), await s.register("B"), await s.register("x2"),
      await s.register("y2"), await s.register("C")].filter((v) => v.assigned_doctor === "Doctor 1");
    const results = await Promise.all([s.confirm(a.id), notPresent(a.id, tokens.frontdesk2), s.confirm(b.id), present(c.id)]);
    const row = await s.row(a.id);
    // Either A was confirmed first (Not Present then refused), or set aside first (A cannot be confirmed).
    if (row.confirmed_at != null) {
      assert.equal(results[1].status, 409);
      assert.equal(results[2].status, 409, "B cannot also be confirmed");
    } else {
      assert.notEqual(row.not_present_at, null);
      assert.equal(results[0].status, 409);
    }
    await assertOneActivePerDoctor();
  });
});
