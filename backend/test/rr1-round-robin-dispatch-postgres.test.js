// RR1 availability-based round-robin assignment at registration. The REAL routes, JWT
// middleware, presenceService, queueService and settingsService (pgBackendHarness) run with
// DOCTOR_DISPATCH_MODE=round_robin against a fresh, synthetic, in-memory PGlite database in the
// development project's known state plus B.2, C1, F5, W1, patient records, AR1 and RR1. Never
// loads .env or the Supabase client and never touches real data.
// PGlite has ONE connection: "concurrent" requests interleave at statement boundaries, so the
// concurrency tests check the observable invariants; real lock contention is covered by
// rr1-round-robin-concurrency.test.js on PostgreSQL 17.
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
// FC1 Front Desk confirmation is installed after RR1 (the backend refuses every Call without it).
// These tests are about doctor assignment, so the column defaults model a Front Desk that confirms
// every visit the moment it is saved; fc1-front-desk-confirmation-postgres.test.js covers FC1.
const FC1 = "20261111-fc1-front-desk-confirmation.sql";
const CONFIRMED_ON_ARRIVAL = `ALTER TABLE public.patients ALTER COLUMN confirmed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN confirmed_by SET DEFAULT 'frontdesk';`;
const ACCOUNTS = {
  superadmin: ["superadmin", null], frontdesk: ["admin", null],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const DOCTOR_ACCOUNT = { "Doctor 1": "admin1", "Doctor 2": "admin2", "Doctor 3": "admin3" };
// The 13 services registration offers (frontend/lib/services.js) and the 4 former keys.
const OFFERED = ["medical_consultation", "maternal_healthcare", "family_planning", "child_healthcare",
  "dental_healthcare", "nutrition", "diagnostic_imaging", "womens_health", "mental_healthcare",
  "medical_documentation", "marriage_preparation", "environmental_health", "food_safety"];
const FORMER = ["consultation", "checkup", "prenatal", "maternity"];
const password = (idNum) => `synthetic-${idNum}-password`;

async function freshDatabase({ withRr1 = true } = {}) {
  const db = await liveKnownDatabase(PGlite);
  for (const script of [...DEVELOPMENT_STATE, ...(withRr1 ? [RR1] : []), FC1]) await db.exec(readScript(script));
  await db.exec(CONFIRMED_ON_ARRIVAL);
  await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  await db.exec(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  return db;
}

describe("RR1 round-robin assignment at registration (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  let tokens;

  before(async () => { db = await freshDatabase(); });
  after(async () => { if (db) await db.close(); });

  function backend(options = {}) {
    const log = [];
    const pool = { query: (sql, values) => db.query(sql, values) };
    const harness = createPgBackendHarness(pool, {
      doctorDispatchMode: "round_robin", ...options,
      onRequest: async (request) => { log.push(request); if (options.onRequest) await options.onRequest(request); }
    });
    harness.log = log;
    return harness;
  }

  beforeEach(async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
      DELETE FROM public.staff_auth_sessions; DELETE FROM public.patient_assignment_history;
      RESET ROLE; DELETE FROM public.patient_records; UPDATE public.users SET archived_at = NULL, archived_by = NULL; SET ROLE service_role;
      UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL, rotation_date = NULL;
      INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
        ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');`);
    h = backend();
    tokens = {};
    tokens.frontdesk = (await h.login("frontdesk", password("frontdesk"))).token;
    tokens.superadmin = (await h.login("superadmin", password("superadmin"))).token;
  });

  // ---- helpers ----------------------------------------------------------------------------
  async function signIn(doctor, harness = h) {
    const idNum = DOCTOR_ACCOUNT[doctor];
    const session = await harness.login(idNum, password(idNum));
    tokens[idNum] = session.token;
    return session.token;
  }
  const signInAll = async () => { for (const doctor of DOCTORS) await signIn(doctor); };
  const signOut = (doctor) => h.request("POST", "/auth/logout", { token: tokens[DOCTOR_ACCOUNT[doctor]] });
  // Heartbeat stopped: the session's last heartbeat falls outside the 75-second presence window.
  const goStale = (doctor) => db.query(`UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '90 seconds'
    WHERE user_id_num = $1`, [DOCTOR_ACCOUNT[doctor]]);
  const setAvailable = (doctor, on) => h.request("POST", "/counters/availability",
    { token: tokens.superadmin, body: { doctors: { [doctor]: on } } });
  const sweep = (harness = h) => harness.queue.requestDispatch();

  // Front Desk registration (the real route). Returns the response plus the saved visit's id.
  async function register(name, { service = "medical_consultation", flags = [], token = tokens.frontdesk, harness = h } = {}) {
    const response = await harness.request("POST", "/queue", { token, body: { fullName: name, service_type: service, vulnerabilityFlags: flags } });
    let id = null;
    if (response.status === 200) {
      id = Number((await db.query("SELECT id FROM public.patients WHERE queue_number = $1", [response.body.queue_number])).rows[0].id);
    }
    return { ...response, id };
  }
  async function registerMany(count, options) {
    const doctors = [];
    for (let i = 0; i < count; i += 1) {
      const response = await register(`Patient ${i + 1}`, options);
      assert.equal(response.status, 200, response.body.message);
      doctors.push(response.body.assigned_doctor);
    }
    return doctors;
  }
  // A visit inserted directly with no doctor (e.g. registered before round robin was switched on).
  async function unassignedVisit(ticket, { priority = 1, minutesAgo = 0, service = "medical_consultation" } = {}) {
    const { rows: [row] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score,
        vulnerability_flags, created_at) VALUES ($1, $2, $3, 'waiting', $4, '[]', clock_timestamp() - ($5 * interval '1 minute')) RETURNING id`,
      [`Synthetic ${ticket}`, ticket, service, priority, minutesAgo]);
    return Number(row.id);
  }
  const patient = async (id) => (await db.query("SELECT row_to_json(p) AS v FROM public.patients p WHERE id = $1", [id])).rows[0].v;
  const doctorOf = async (id) => (await patient(id)).counter_id;
  const patientCount = async () => Number((await db.query("SELECT count(*) AS n FROM public.patients")).rows[0].n);
  const rotation = async () => (await db.query(`SELECT last_doctor, last_patient_id,
      rotation_date = (now() AT TIME ZONE 'Asia/Manila')::date AS today FROM public.doctor_rotation_state`)).rows[0];
  const history = async (id) => (await db.query(`SELECT patient_id::int AS patient_id, reason, previous_doctor, new_doctor, automatic, detail,
      created_at FROM public.patient_assignment_history WHERE ($1::bigint IS NULL OR patient_id = $1) ORDER BY id`, [id ?? null])).rows;
  // Every waiting visit of the day is with exactly one eligible doctor, or pending with none.
  async function assertNoLostOrMisassigned() {
    await db.exec("RESET ROLE");   // qms_rr_doctor_state is closed to the API roles
    const { rows } = await db.query(`SELECT p.id::int AS id, p.counter_id, d.eligible FROM public.patients p
      LEFT JOIN public.qms_rr_doctor_state(now() - interval '1 day', now() + interval '1 day') d ON d.doctor_name = p.counter_id
      WHERE p.status = 'waiting'`);
    await db.exec("SET ROLE service_role");
    for (const row of rows) {
      if (row.counter_id) assert.equal(row.eligible, true, `visit ${row.id} is with unavailable ${row.counter_id}`);
    }
    // The saved doctor always equals the last assignment recorded for the visit.
    const { rows: mismatched } = await db.query(`SELECT p.id FROM public.patients p
      JOIN LATERAL (SELECT h.new_doctor FROM public.patient_assignment_history h WHERE h.patient_id = p.id
        AND h.reason <> 'intervention_required' ORDER BY h.id DESC LIMIT 1) l ON true
      WHERE p.status = 'waiting' AND p.counter_id IS DISTINCT FROM l.new_doctor`);
    assert.deepEqual(mismatched, [], "history and saved doctor agree");
  }
  const call = (doctor, id) => h.request("POST", "/queue/call", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  const start = (doctor, id) => h.request("POST", "/queue/start", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  const complete = (doctor, id) => h.request("POST", "/queue/complete", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  const overview = async (token = tokens.frontdesk) => (await h.request("GET", "/queue", { token })).body;
  async function assertConsistent() {
    const { rows } = await db.query(`SELECT
        (SELECT count(*) FROM (SELECT counter_id FROM public.patients WHERE status = 'serving'
          GROUP BY counter_id HAVING count(*) > 1) d) AS doctors_with_two_serving,
        (SELECT count(*) FROM (SELECT current_patient_id FROM public.counters WHERE current_patient_id IS NOT NULL
          GROUP BY current_patient_id HAVING count(*) > 1) d) AS visits_on_two_counters,
        (SELECT count(*) FROM public.patients p WHERE p.status = 'serving' AND NOT EXISTS
          (SELECT 1 FROM public.counters c WHERE c.current_patient_id = p.id AND c.id_num = p.counter_id)) AS serving_without_its_counter,
        (SELECT count(*) FROM (SELECT queue_number FROM public.patients GROUP BY queue_number HAVING count(*) > 1) d) AS duplicate_tickets`);
    assert.deepEqual(Object.values(rows[0]).map(Number), [0, 0, 0, 0], JSON.stringify(rows[0]));
  }

  // ---- Round robin --------------------------------------------------------------------------
  test("all doctors eligible: patients 1-9 go Doctor 1, 2, 3, 1, 2, 3, 1, 2, 3", async () => {
    await signInAll();
    assert.deepEqual(await registerMany(9), [...DOCTORS, ...DOCTORS, ...DOCTORS]);
    const rows = (await db.query("SELECT queue_number, counter_id, status FROM public.patients ORDER BY id")).rows;
    assert.deepEqual(rows.map((row) => row.counter_id), [...DOCTORS, ...DOCTORS, ...DOCTORS], "stored on the visit");
    assert.deepEqual(rows.map((row) => row.queue_number),
      ["GP-001", "GP-002", "GP-003", "GP-004", "GP-005", "GP-006", "GP-007", "GP-008", "GP-009"], "queue numbering unchanged");
    assert.ok(rows.every((row) => row.status === "waiting"));
    const state = await rotation();
    assert.equal(state.last_doctor, "Doctor 3");
    assert.equal(state.today, true, "the pointer belongs to today's Manila operating date");
    const log = await history();
    assert.equal(log.length, 9);
    assert.ok(log.every((row) => row.reason === "round_robin_assignment" && row.automatic === true));
    await assertConsistent();
  });

  test("the rotation is kept in the database: shared by every Front Desk session and backend, not reset by refresh or re-login", async () => {
    await signInAll();
    assert.deepEqual(await registerMany(2), ["Doctor 1", "Doctor 2"]);
    // "Page refresh": reading the queue changes nothing.
    await overview();
    await overview(tokens.superadmin);
    // A second backend instance with Super Admin's session continues the same rotation.
    const other = backend();
    const third = await register("Other backend", { harness: other, token: tokens.superadmin });
    assert.equal(third.body.assigned_doctor, "Doctor 3");
    // Front Desk signs out and back in.
    await h.request("POST", "/auth/logout", { token: tokens.frontdesk });
    tokens.frontdesk = (await h.login("frontdesk", password("frontdesk"))).token;
    assert.equal((await register("After re-login")).body.assigned_doctor, "Doctor 1");
  });

  test("a new operating day starts at the first eligible doctor; earlier days keep their assignments", async () => {
    await signInAll();
    // Yesterday ended with Doctor 1; a completed visit and its history belong to yesterday.
    const { rows: [old] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id,
        priority_score, created_at, completed_at) VALUES ('Yesterday', 'GP-900', 'medical_consultation', 'completed', 'Doctor 2', 1,
        now() - interval '1 day', now() - interval '1 day') RETURNING id`);
    await db.query(`INSERT INTO public.patient_assignment_history (patient_id, new_doctor, previous_status, new_status, reason, automatic, created_at)
      VALUES ($1, 'Doctor 2', 'waiting', 'waiting', 'round_robin_assignment', true, now() - interval '1 day')`, [old.id]);
    await db.query(`UPDATE public.doctor_rotation_state SET last_doctor = 'Doctor 1',
      rotation_date = (now() AT TIME ZONE 'Asia/Manila')::date - 1`);
    assert.deepEqual(await registerMany(4), ["Doctor 1", "Doctor 2", "Doctor 3", "Doctor 1"]);
    const kept = await patient(Number(old.id));
    assert.equal(kept.counter_id, "Doctor 2");
    assert.equal(kept.status, "completed");
    assert.equal((await history(Number(old.id))).length, 1);
    assert.equal((await rotation()).today, true);
    // Within the same day the pointer is respected (no reset after each registration).
    await db.query("UPDATE public.doctor_rotation_state SET last_doctor = 'Doctor 2'");
    assert.equal((await register("Same day")).body.assigned_doctor, "Doctor 3");
  });

  // The acceptance sequence of 2026-11-11, checked against the saved rows (not the responses):
  // six patients across six services, then one doctor offline, two offline, and both back. The
  // doctor is read from the database right after each registration AND at the end: a doctor going
  // offline hands its waiting patients to the doctors still available, and does not take them back.
  test("acceptance: mixed services rotate 1-2-3; one and two doctors offline are skipped; returning doctors rejoin", async (t) => {
    await signInAll();
    const steps = [];
    const reg = async (label, service) => {
      const response = await register(label, { service });
      assert.equal(response.status, 200, response.body.message);
      steps.push({ id: response.id, label, service, answered: response.body.assigned_doctor, saved: await doctorOf(response.id) });
    };
    const services = ["medical_consultation", "maternal_healthcare", "family_planning", "dental_healthcare", "child_healthcare", "food_safety"];
    for (const [i, service] of services.entries()) await reg(`Patient ${i + 1}`, service);
    // One doctor unavailable (System Settings toggle).
    assert.equal((await setAvailable("Doctor 2", false)).status, 200);
    for (const service of ["nutrition", "womens_health", "mental_healthcare", "diagnostic_imaging"]) await reg(`D2 off ${service}`, service);
    // Two doctors unavailable (Doctor 3 also signs out): every patient goes to Doctor 1.
    assert.equal((await signOut("Doctor 3")).status, 200);
    for (const service of ["medical_documentation", "marriage_preparation", "environmental_health"]) await reg(`Only D1 ${service}`, service);
    // Both return: they rejoin the rotation in their fixed places.
    assert.equal((await setAvailable("Doctor 2", true)).status, 200);
    await signIn("Doctor 3");
    for (const service of ["medical_consultation", "family_planning", "maternal_healthcare", "nutrition"]) await reg(`Back ${service}`, service);

    const rows = (await db.query("SELECT id, queue_number, service_type, counter_id FROM public.patients ORDER BY id")).rows;
    t.diagnostic(`\n #  ticket  service                 saved at registration  saved at the end (after automatic reassignment)\n${rows.map((row, i) =>
      `${String(i + 1).padStart(2)}  ${row.queue_number}  ${row.service_type.padEnd(22)}  ${steps[i].saved.padEnd(21)}  ${row.counter_id}   (${steps[i].label})`).join("\n")}`);
    assert.deepEqual(rows.map((row) => Number(row.id)), steps.map((step) => step.id));
    assert.deepEqual(steps.map((step) => step.saved), [
      "Doctor 1", "Doctor 2", "Doctor 3", "Doctor 1", "Doctor 2", "Doctor 3", // all three eligible
      "Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3",                         // Doctor 2 unavailable
      "Doctor 1", "Doctor 1", "Doctor 1",                                     // only Doctor 1
      "Doctor 2", "Doctor 3", "Doctor 1", "Doctor 2"                          // both returned
    ]);
    assert.deepEqual(steps.map((step) => step.answered), steps.map((step) => step.saved), "the response names the saved doctor");
    assert.equal((await rotation()).last_doctor, "Doctor 2", "the persisted pointer is the last saved assignment");
    // Doctor 2 off: its patients 2 and 5 alternate to Doctor 1 and Doctor 3. Doctor 3 off: all of
    // its patients go to Doctor 1. Neither takes anything back on returning.
    assert.deepEqual(rows.map((row) => row.counter_id), [
      "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1",
      "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1", "Doctor 1",
      "Doctor 2", "Doctor 3", "Doctor 1", "Doctor 2"]);
    const moves = (await history()).filter((row) => row.reason === "round_robin_reassignment");
    const id = (n) => steps[n - 1].id;
    assert.deepEqual(moves.map((row) => [row.patient_id, row.previous_doctor, row.new_doctor, row.detail]), [
      [id(2), "Doctor 2", "Doctor 1", "doctor_disabled"], [id(5), "Doctor 2", "Doctor 3", "doctor_disabled"],
      [id(3), "Doctor 3", "Doctor 1", "doctor_signed_out"], [id(5), "Doctor 3", "Doctor 1", "doctor_signed_out"],
      [id(6), "Doctor 3", "Doctor 1", "doctor_signed_out"], [id(8), "Doctor 3", "Doctor 1", "doctor_signed_out"],
      [id(10), "Doctor 3", "Doctor 1", "doctor_signed_out"]]);
    assert.ok(moves.every((row) => row.automatic && row.created_at));
    await assertNoLostOrMisassigned();
    await assertConsistent();
  });

  // ---- Availability ---------------------------------------------------------------------------
  test("an offline doctor is skipped: Doctor 1, 3, 1, 3, 1, 3", async () => {
    await signIn("Doctor 1");
    await signIn("Doctor 3");
    assert.deepEqual(await registerMany(6), ["Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3"]);
    assert.ok(!(await history()).some((row) => row.new_doctor === "Doctor 2"));
  });

  test("a doctor with a stopped heartbeat is offline and skipped", async () => {
    await signInAll();
    await goStale("Doctor 2");
    assert.deepEqual(await registerMany(4), ["Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3"]);
  });

  test("a signed-in doctor marked unavailable in System Settings is skipped; availability is not changed by the rotation", async () => {
    await signInAll();
    const off = await setAvailable("Doctor 2", false);
    assert.equal(off.status, 200, off.body.message);
    assert.deepEqual(await registerMany(4), ["Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3"]);
    const counters = (await db.query("SELECT id_num, is_online FROM public.counters ORDER BY id_num")).rows;
    assert.deepEqual(counters.map((row) => row.is_online), [true, false, true], "the rotation never toggles availability");
  });

  test("an archived doctor is excluded and cannot sign back in; its waiting patients are reassigned automatically", async () => {
    await signInAll();
    const held = await register("Doctor 1 patient");
    const moved = await register("Doctor 2 patient");
    assert.equal(moved.body.assigned_doctor, "Doctor 2");
    // The service call behind POST /users/:id_num/archive (the harness has no route for it), then
    // the dispatch pass that route triggers.
    await h.queue.archiveUser("admin2", { id_num: "superadmin" });
    await sweep();
    assert.equal(await doctorOf(moved.id), "Doctor 3", "next after Doctor 2 among the available doctors");
    assert.equal(await doctorOf(held.id), "Doctor 1", "an available doctor's patient is never moved");
    assert.deepEqual((await history(moved.id)).map((row) => [row.reason, row.previous_doctor, row.new_doctor, row.detail]),
      [["round_robin_assignment", null, "Doctor 2", null], ["round_robin_reassignment", "Doctor 2", "Doctor 3", "doctor_signed_out"]]);
    assert.deepEqual(await registerMany(4), ["Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3"]);
    const login = await h.request("POST", "/auth/login", { body: { id_num: "admin2", password: password("admin2") } });
    assert.notEqual(login.status, 200);
    assert.deepEqual(await registerMany(2), ["Doctor 1", "Doctor 3"]);
  });

  test("a doctor who becomes unavailable mid-rotation is skipped, then rejoins in its stable place", async () => {
    await signInAll();
    assert.equal((await register("Patient 1")).body.assigned_doctor, "Doctor 1");
    assert.equal((await signOut("Doctor 2")).status, 200);
    assert.equal((await register("Patient 2")).body.assigned_doctor, "Doctor 3");
    assert.equal((await register("Patient 3")).body.assigned_doctor, "Doctor 1");
    await signIn("Doctor 2");
    assert.equal((await register("Patient 4")).body.assigned_doctor, "Doctor 2");
    assert.equal((await register("Patient 5")).body.assigned_doctor, "Doctor 3");
    assert.equal((await register("Patient 6")).body.assigned_doctor, "Doctor 1", "the returning doctor is not given every new patient");
  });

  test("only one doctor available: every patient goes to that doctor (even while it serves), then the others rejoin in order", async () => {
    await signIn("Doctor 2");
    assert.deepEqual(await registerMany(3), ["Doctor 2", "Doctor 2", "Doctor 2"]);
    const first = Number((await db.query("SELECT id FROM public.patients ORDER BY id LIMIT 1")).rows[0].id);
    const called = await call("Doctor 2", first);
    assert.equal(called.status, 200, called.body.message);
    const busy = await register("While serving");
    assert.equal(busy.status, 200, busy.body.message);
    assert.equal(busy.body.assigned_doctor, "Doctor 2", "a serving doctor is still available and keeps receiving patients");
    assert.equal(await doctorOf(busy.id), "Doctor 2", "the assignment is saved on the visit");
    await signIn("Doctor 1");
    await signIn("Doctor 3");
    assert.deepEqual(await registerMany(4), ["Doctor 3", "Doctor 1", "Doctor 2", "Doctor 3"]);
    assert.equal((await rotation()).last_doctor, "Doctor 3", "the persisted pointer matches the last assignment");
  });

  test("the registration response names the assigned doctor with its display name (EP1) when one is set", async () => {
    await db.exec(`RESET ROLE; ALTER TABLE public.users ADD COLUMN IF NOT EXISTS display_name TEXT;
      UPDATE public.users SET display_name = 'Dr. Ana Santos' WHERE id_num = 'admin2'; SET ROLE service_role;`);
    try {
      await signInAll();
      const one = await register("Patient 1");
      assert.equal(one.body.assigned_doctor, "Doctor 1");
      assert.equal(one.body.assigned_doctor_name, null, "no display name: the counter name is the label");
      const two = await register("Patient 2");
      assert.equal(two.body.assigned_doctor, "Doctor 2");
      assert.equal(two.body.assigned_doctor_name, "Dr. Ana Santos");
      assert.equal(await doctorOf(two.id), "Doctor 2", "the counter, not the label, is stored");
    } finally {
      await db.exec("RESET ROLE; UPDATE public.users SET display_name = NULL; SET ROLE service_role;");
    }
  });

  test("no online and available doctor: registration is refused, nothing is saved and the rotation does not move", async () => {
    await signInAll();
    await registerMany(1);
    // Each sign-out hands the waiting patient to the next available doctor; after the last one it
    // is held as pending reassignment. The snapshot is taken after that.
    for (const doctor of DOCTORS) await signOut(doctor);
    assert.deepEqual((await history()).map((row) => [row.reason, row.previous_doctor, row.new_doctor]), [
      ["round_robin_assignment", null, "Doctor 1"], ["round_robin_reassignment", "Doctor 1", "Doctor 2"],
      ["round_robin_reassignment", "Doctor 2", "Doctor 3"], ["doctor_unavailable", "Doctor 3", null]]);
    assert.equal((await db.query("SELECT counter_id FROM public.patients")).rows[0].counter_id, null);
    const before = await rotation();
    const historyBefore = await history();
    const refused = await register("No Doctor");
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /^No Available Doctors/);
    assert.match(refused.body.message, /no online and available doctors/);
    assert.equal(await patientCount(), 1, "no visit was created");
    assert.deepEqual(await rotation(), before);
    assert.deepEqual(await history(), historyBefore);
    // A new patient through Patient Management: no permanent record is saved either.
    const viaRecords = await h.request("POST", "/patient-records/visits", { token: tokens.frontdesk, body: {
      firstName: "Nora", lastName: "Waiting", sex: "Female", birthdate: "1990-01-01", residency: "Barangay 1",
      serviceType: "maternal_healthcare" } });
    assert.equal(viaRecords.status, 409);
    assert.match(viaRecords.body.message, /^No Available Doctors/);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.patient_records")).rows[0].n), 0);
    // A doctor signs in: it receives the patient who was waiting, then the next registration.
    await signIn("Doctor 1");
    assert.equal((await register("Now Served")).body.assigned_doctor, "Doctor 1");
    assert.equal(await patientCount(), 2);
  });

  test("the database re-checks availability at commit: a doctor signed out after the backend's check is never assigned", async () => {
    await signIn("Doctor 1");
    await signIn("Doctor 2");
    const racing = backend({
      onRequest: async (request) => {
        if (request.kind === "rpc" && request.name === "register_visit_round_robin") {
          await db.query("UPDATE public.staff_auth_sessions SET revoked_at = clock_timestamp() WHERE user_id_num = 'admin1'");
        }
      }
    });
    const response = await register("Race", { harness: racing });
    assert.equal(response.status, 200, response.body.message);
    assert.equal(response.body.assigned_doctor, "Doctor 2");
  });

  // ---- Database integrity -----------------------------------------------------------------------
  test("ticket numbers are assigned by the database under the rotation lock; a failed registration consumes neither a number nor a turn", async () => {
    await signInAll();
    await registerMany(1);                                       // GP-001 -> Doctor 1
    const window = (await db.query(`SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila') AS s`)).rows[0].s;
    // FROM, not (fn(...)).*: the latter calls the function once per output column.
    const direct = (visit) => db.query(`SELECT * FROM public.register_visit_round_robin($1::jsonb, $2::timestamptz, $2::timestamptz + interval '1 day')`,
      [JSON.stringify({ id_num: "Direct", service_type: "medical_consultation", ...visit }), window]);
    // A failure after the number was chosen (a bad birthdate fails the insert) rolls back the
    // number, the visit, the history and the pointer together.
    const before = await rotation();
    await assert.rejects(direct({ queue_number: "GP-001", birthdate: "not-a-date" }));
    assert.deepEqual(await rotation(), before, "no turn consumed");
    assert.equal((await history()).length, 1);
    assert.equal(await patientCount(), 1);
    // A proposal that is already taken (or stale) is not an error: the database picks the next
    // free number of the same service code, in the existing format.
    const { rows: [taken] } = await direct({ queue_number: "GP-001" });
    assert.equal(taken.queue_number, "GP-002", "the failed attempt did not use up GP-002");
    assert.equal(taken.counter_id, "Doctor 2");
    const { rows: [family] } = await direct({ queue_number: "FP-777", service_type: "family_planning" });
    assert.equal(family.queue_number, "FP-001", "per service code, highest + 1, three digits");
    await assert.rejects(direct({ queue_number: "bad" }), (error) => error.code === "22023");
    // Through the backend: another writer takes the proposed number first; the database simply
    // assigns the next one, with no retry and exactly one rotation step.
    const racing = backend({
      onRequest: async (request) => {
        if (request.kind === "rpc" && request.name === "register_visit_round_robin") {
          await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, priority_score)
            VALUES ('Other Writer', $1, 'medical_consultation', 'completed', 'Doctor 1', 1)`, [request.args.p_visit.queue_number]);
        }
      }
    });
    const response = await register("Raced", { harness: racing });
    assert.equal(response.status, 200, response.body.message);
    assert.equal(response.body.queue_number, "GP-004", "GP-003 was taken by the other writer");
    assert.equal(response.body.assigned_doctor, "Doctor 1");
    assert.equal((await history()).length, 4);
    // The unique index refuses a duplicate from any writer.
    await assert.rejects(db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score)
      VALUES ('Dup', 'GP-004', 'medical_consultation', 'waiting', 1)`), (error) => error.code === "23505");
    await assertConsistent();
  });

  test("simultaneous registrations from two Front Desk backends never reuse a rotation position", async () => {
    await signInAll();
    const other = backend();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      register(`Concurrent ${i}`, { harness: i % 2 ? other : h, token: i % 2 ? tokens.superadmin : tokens.frontdesk })));
    assert.deepEqual(responses.map((r) => r.status), Array(6).fill(200), JSON.stringify(responses.map((r) => r.body.message)));
    // Serialized by the rotation lock: in commit order the doctors cycle exactly.
    const order = (await history()).map((row) => row.new_doctor);
    assert.deepEqual(order, [...DOCTORS, ...DOCTORS]);
    const perDoctor = (await db.query("SELECT counter_id, count(*)::int AS n FROM public.patients GROUP BY counter_id ORDER BY counter_id")).rows;
    assert.deepEqual(perDoctor, DOCTORS.map((doctor) => ({ counter_id: doctor, n: 2 })));
    assert.equal(await patientCount(), 6, "no duplicate visit");
    await assertConsistent();
  });

  test("24 simultaneous registrations from three sessions and three routes: each saved once, unique tickets, exact rotation", async (t) => {
    await signInAll();
    const desks = [h, backend(), backend()];
    const services = ["medical_consultation", "family_planning", "prenatal", "dental_healthcare", "maternity", "nutrition"];
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const harness = desks[i % 3];
      const serviceType = services[i % services.length];
      const name = `Burst ${i + 1}`;
      if (i % 3 === 0) return harness.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: name, service_type: serviceType } });
      if (i % 3 === 1) return harness.request("POST", "/queue/website", { body: { fullName: name, serviceType } });
      return harness.request("POST", "/patient-records/visits", { token: tokens.frontdesk, body: {
        firstName: name, lastName: "Concurrent", sex: "Female", birthdate: "1990-01-01", residency: "Barangay 1", serviceType } });
    });
    const responses = await Promise.all(jobs);
    assert.deepEqual(responses.map((r) => r.status), Array(24).fill(200), JSON.stringify(responses.map((r) => r.body?.message)));
    const rows = (await db.query(`SELECT id::int AS id, queue_number, service_type, counter_id, status FROM public.patients ORDER BY id`)).rows;
    assert.equal(rows.length, 24, "every valid registration saved exactly once");
    assert.equal(new Set(rows.map((row) => row.queue_number)).size, 24, "every ticket number is unique");
    // Format and numbering per service code: CODE-NNN, 001.. with no gap, in commit order.
    const code = { prenatal: "OB", maternity: "OB", family_planning: "FP" };
    for (const prefix of ["GP", "OB", "FP"]) {
      const numbers = rows.filter((row) => (code[row.service_type] || "GP") === prefix).map((row) => row.queue_number);
      assert.deepEqual(numbers, numbers.map((_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`), prefix);
    }
    // Each response shows the ticket that was saved for that patient.
    const saved = new Set(rows.map((row) => row.queue_number));
    assert.ok(responses.every((r) => saved.has(r.body.queue_number)));
    // Rotation: in commit order the doctors cycle exactly, and the pointer is the last assignment.
    assert.deepEqual(rows.map((row) => row.counter_id), Array.from({ length: 24 }, (_, i) => DOCTORS[i % 3]));
    const log = await history();
    assert.deepEqual(log.map((row) => [row.patient_id, row.new_doctor]), rows.map((row) => [row.id, row.counter_id]));
    const pointer = await rotation();
    assert.equal(pointer.last_doctor, "Doctor 3");
    assert.equal(Number(pointer.last_patient_id), rows.at(-1).id);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.patient_records")).rows[0].n), 8, "one record per new patient");
    t.diagnostic(`24 simultaneous registrations: ${rows.length} saved, ${new Set(rows.map((r) => r.queue_number)).size} unique tickets; ` +
      `per doctor ${DOCTORS.map((d) => `${d}=${rows.filter((r) => r.counter_id === d).length}`).join(", ")}; tickets ${rows.map((r) => r.queue_number).join(" ")}`);
    await assertConsistent();
  });

  // ---- Integration --------------------------------------------------------------------------------
  test("new and returning patients through Patient Management are assigned in turn; records are not duplicated or edited", async () => {
    await signInAll();
    const created = await h.request("POST", "/patient-records/visits", { token: tokens.frontdesk, body: {
      firstName: "Ana", lastName: "Reyes", sex: "Female", birthdate: "1990-05-01", residency: "Barangay 2",
      serviceType: "maternal_healthcare", vulnerabilityFlags: ["pregnant"] } });
    assert.equal(created.status, 200, created.body.message);
    assert.equal(created.body.assigned_doctor, "Doctor 1");
    assert.equal(created.body.patient_record_created, true);
    const recordId = created.body.patient_record.id;
    const recordBefore = (await db.query("SELECT row_to_json(r) AS v FROM public.patient_records r WHERE id = $1", [recordId])).rows[0].v;
    const visit = (await db.query("SELECT * FROM public.patients WHERE queue_number = $1", [created.body.queue_number])).rows[0];
    assert.equal(visit.service_type, "maternal_healthcare");
    assert.equal(visit.priority_score, 3);
    assert.deepEqual(visit.vulnerability_flags, ["pregnant"]);
    assert.equal(Number(visit.patient_record_id), Number(recordId));
    // Finish that visit, then the same person returns.
    for (const step of [call, start, complete]) assert.equal((await step("Doctor 1", Number(visit.id))).status, 200);
    assert.equal((await register("Walk In")).body.assigned_doctor, "Doctor 2");
    const returning = await h.request("POST", "/patient-records/visits", { token: tokens.frontdesk,
      body: { patientRecordId: recordId, serviceType: "family_planning" } });
    assert.equal(returning.status, 200, returning.body.message);
    assert.equal(returning.body.assigned_doctor, "Doctor 3");
    assert.equal(returning.body.patient_record_created, false);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.patient_records")).rows[0].n), 1);
    assert.deepEqual((await db.query("SELECT row_to_json(r) AS v FROM public.patient_records r WHERE id = $1", [recordId])).rows[0].v, recordBefore);
  });

  test("priority is unchanged: each doctor serves its own list by WPS, not by registration order", async () => {
    await signIn("Doctor 1");
    const regular = await register("Regular First");
    const pwd = await register("PWD Second", { flags: ["pwd"] });
    assert.deepEqual([regular.body.assigned_doctor, pwd.body.assigned_doctor], ["Doctor 1", "Doctor 1"]);
    assert.deepEqual([regular.body.priority_score, pwd.body.priority_score], [1, 3]);
    const refused = await call("Doctor 1", regular.id);
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /next patient assigned to Doctor 1/);
    assert.equal((await patient(regular.id)).status, "waiting");
    // The database enforces the same rule even when the backend's check is bypassed.
    await assert.rejects(db.query(`SELECT public.call_patient_visit_rr($1, 'Doctor 1', 'admin1', $2,
        now() - interval '1 day', now() + interval '1 day', now(), false)`, [regular.id, (await patient(regular.id)).visit_state_revision]),
      /next patient assigned to Doctor 1/);
    assert.equal((await call("Doctor 1", pwd.id)).status, 200);
    assert.deepEqual([(await patient(regular.id)).priority_score, (await patient(pwd.id)).priority_score], [1, 3]);
    assert.equal((await start("Doctor 1", pwd.id)).status, 200);
    assert.equal((await complete("Doctor 1", pwd.id)).status, 200);
    assert.equal((await call("Doctor 1", regular.id)).status, 200, "then the regular patient");
  });

  test("every offered service is accepted and rotated; the service never chooses the doctor", async () => {
    await signInAll();
    const doctors = [];
    for (const service of OFFERED) {
      const response = await register(`Service ${service}`, { service });
      assert.equal(response.status, 200, `${service}: ${response.body.message}`);
      assert.equal((await patient(response.id)).service_type, service);
      doctors.push(response.body.assigned_doctor);
    }
    assert.deepEqual(doctors, OFFERED.map((_, i) => DOCTORS[i % 3]));
    const unknown = await register("Unknown", { service: "laboratory" });
    assert.equal(unknown.status, 400);
    const { rows: [row] } = await db.query("SELECT public.qms_rr_approved_services() AS list");
    assert.deepEqual(row.list, [...h.queue.ROUND_ROBIN_SERVICES]);
    assert.deepEqual(row.list, [...OFFERED, ...FORMER]);
    const view = await overview();
    assert.deepEqual(view.approved_services, [...OFFERED, ...FORMER], "the registration dropdown enables all 13");
  });

  test("Front Desk, Super Admin and each doctor see the same assigned doctor from the saved visit", async () => {
    await signInAll();
    await registerMany(6);
    const stored = Object.fromEntries((await db.query("SELECT id, counter_id FROM public.patients")).rows.map((r) => [Number(r.id), r.counter_id]));
    for (const token of [tokens.frontdesk, tokens.superadmin]) {
      const view = await overview(token);
      assert.equal(view.dispatch_strategy, "round_robin");
      assert.equal(view.patients.length, 6);
      for (const row of view.patients) assert.equal(row.counter_id, stored[Number(row.id)]);
      assert.deepEqual(view.dispatch.doctors.map((d) => [d.doctor_name, d.eligible, Number(d.waiting_count)]),
        DOCTORS.map((d) => [d, true, 2]));
      assert.equal(view.dispatch.next_doctor, "Doctor 1");
    }
    for (const doctor of DOCTORS) {
      const view = await overview(tokens[DOCTOR_ACCOUNT[doctor]]);
      const mine = view.patients.filter((row) => row.counter_id === doctor && row.status === "waiting");
      assert.equal(mine.length, 2, doctor);
    }
  });

  // ---- Doctors going offline with assigned patients ----------------------------------------------
  test("Doctor 2 goes offline with five waiting patients: they alternate between Doctor 1 and Doctor 3 in WPS order, data kept", async () => {
    await signIn("Doctor 2");
    // Five patients for Doctor 2 with different priorities and services (WPS order: 3, 1, 5, 2, 4).
    const regs = [];
    for (const [name, service, flags] of [["P1", "medical_consultation", ["pwd"]], ["P2", "dental_healthcare", []],
      ["P3", "maternal_healthcare", ["senior"]], ["P4", "nutrition", []], ["P5", "family_planning", ["indigenous"]]]) {
      const response = await register(name, { service, flags });
      assert.equal(response.body.assigned_doctor, "Doctor 2");
      regs.push(response.id);
    }
    await signIn("Doctor 1");
    await signIn("Doctor 3");
    const before = await Promise.all(regs.map(patient));
    assert.equal((await signOut("Doctor 2")).status, 200);   // the logout route runs the dispatcher
    const after = await Promise.all(regs.map(patient));
    const byWps = [2, 0, 4, 1, 3];                              // P3 senior 4, P1 pwd 3, P5 indigenous 2, P2, P4
    assert.deepEqual(byWps.map((i) => after[i].counter_id), ["Doctor 3", "Doctor 1", "Doctor 3", "Doctor 1", "Doctor 3"],
      "rotation continues after Doctor 2 among Doctor 1 and Doctor 3, highest rank first");
    const counts = after.reduce((acc, p) => ({ ...acc, [p.counter_id]: (acc[p.counter_id] || 0) + 1 }), {});
    assert.deepEqual(counts, { "Doctor 1": 2, "Doctor 3": 3 }, "balanced: never all to one doctor");
    for (const [index, row] of after.entries()) {
      for (const key of ["created_at", "priority_score", "vulnerability_flags", "queue_number", "status", "service_type",
        "id_num", "confirmed_at", "confirmed_by", "birthdate", "called_at"]) {
        assert.deepEqual(row[key], before[index][key], key);
      }
      assert.notEqual(row.visit_state_revision, before[index].visit_state_revision, "stale actions on the old doctor fail");
    }
    const moves = (await history()).filter((row) => row.reason === "round_robin_reassignment");
    assert.equal(moves.length, 5);
    assert.ok(moves.every((row) => row.previous_doctor === "Doctor 2" && row.detail === "doctor_signed_out" && row.automatic));
    // WPS still decides each doctor's order: Doctor 3's head is P3 (senior), Doctor 1's is P1 (pwd).
    assert.notEqual((await call("Doctor 2", regs[2])).status, 200, "the signed-out doctor cannot call");
    assert.equal((await call("Doctor 3", regs[4])).status, 400, "not Doctor 3's WPS head");
    assert.equal((await call("Doctor 3", regs[2])).status, 200);
    assert.equal((await call("Doctor 1", regs[0])).status, 200);
    // Doctor 2 returns: it takes nothing back and rejoins the rotation for new registrations.
    await signIn("Doctor 2");
    await sweep();
    assert.deepEqual((await Promise.all(regs.map(doctorOf))), after.map((p) => p.counter_id));
    assert.deepEqual(await registerMany(3), ["Doctor 1", "Doctor 2", "Doctor 3"]);
    await assertNoLostOrMisassigned();
    await assertConsistent();
  });

  test("a lost heartbeat (timer sweep) and a System Settings switch-off both reassign; two doctors offline leaves one with all", async () => {
    await signInAll();
    await registerMany(6);                                      // 1, 2, 3, 1, 2, 3
    await goStale("Doctor 1");
    await sweep();                                              // what the backend's 15-second timer does
    let rows = (await db.query("SELECT counter_id FROM public.patients ORDER BY id")).rows.map((r) => r.counter_id);
    assert.deepEqual(rows, ["Doctor 2", "Doctor 2", "Doctor 3", "Doctor 3", "Doctor 2", "Doctor 3"]);
    assert.equal((await setAvailable("Doctor 3", false)).status, 200);
    rows = (await db.query("SELECT counter_id FROM public.patients ORDER BY id")).rows.map((r) => r.counter_id);
    assert.deepEqual(rows, DOCTORS.flatMap(() => ["Doctor 2", "Doctor 2"]), "only Doctor 2 is left: it holds every waiting patient");
    const details = (await history()).filter((row) => row.reason === "round_robin_reassignment").map((row) => row.detail);
    assert.deepEqual(details, ["doctor_signed_out", "doctor_signed_out", "doctor_disabled", "doctor_disabled", "doctor_disabled"]);
    assert.deepEqual(await registerMany(2), ["Doctor 2", "Doctor 2"]);
    await assertNoLostOrMisassigned();
  });

  test("all doctors unavailable: waiting patients are held as pending reassignment, then placed in rotation when a doctor returns", async () => {
    const legacy = await unassignedVisit("GP-500", { minutesAgo: 30 });
    await signIn("Doctor 1");
    await signIn("Doctor 3");
    await sweep();
    assert.equal(await doctorOf(legacy), "Doctor 1", "a never-assigned visit is assigned in rotation");
    const [a, b] = [(await register("A")).id, (await register("B")).id];   // Doctor 3, Doctor 1
    assert.equal((await signOut("Doctor 1")).status, 200);
    assert.equal((await signOut("Doctor 3")).status, 200);
    for (const id of [legacy, a, b]) assert.equal(await doctorOf(id), null, "never left with an unavailable doctor");
    const view = (await overview()).dispatch;
    assert.equal(view.all_unavailable, true);
    assert.deepEqual(view.pending_reassignment.map((row) => [row.patient_id, row.previous_doctor]).sort(),
      [[legacy, "Doctor 3"], [a, "Doctor 3"], [b, "Doctor 3"]].sort(), "listed as pending reassignment (Doctor 3 held all of them last)");
    await sweep();
    await sweep();
    assert.equal((await history()).filter((row) => row.reason === "doctor_unavailable").length, 3, "held once, not re-recorded by each sweep");
    assert.equal((await register("Refused")).status, 409);
    // Doctor 2 (never involved) signs in: it receives all three, in WPS order.
    await signIn("Doctor 2");
    for (const id of [legacy, a, b]) assert.equal(await doctorOf(id), "Doctor 2");
    const placed = (await history()).filter((row) => row.detail === "pending_reassignment");
    assert.equal(placed.length, 3);
    assert.ok(placed.every((row) => row.reason === "round_robin_reassignment" && row.new_doctor === "Doctor 2" && row.previous_doctor));
    assert.deepEqual((await overview()).dispatch.pending_reassignment, []);
    // Doctor 1 returns: it takes nothing back; new registrations rotate 1, 2 again.
    await signIn("Doctor 1");
    for (const id of [legacy, a, b]) assert.equal(await doctorOf(id), "Doctor 2");
    assert.deepEqual(await registerMany(2), ["Doctor 1", "Doctor 2"]);
    await assertNoLostOrMisassigned();
  });

  test("an active consultation is never moved automatically; staff are told once and may transfer it", async () => {
    await signIn("Doctor 1");
    const p1 = (await register("Active")).id;
    const p2 = (await register("Waiting")).id;
    assert.equal((await call("Doctor 1", p1)).status, 200);
    assert.equal((await start("Doctor 1", p1)).status, 200);
    const active = await patient(p1);
    await goStale("Doctor 1");
    await sweep();
    await sweep();
    const still = await patient(p1);
    assert.equal(still.status, "serving");
    assert.equal(still.counter_id, "Doctor 1");
    assert.equal((await history(p1)).filter((row) => row.reason === "intervention_required").length, 1, "notified once");
    assert.deepEqual((await overview()).dispatch.interventions.map((row) => [row.patient_id, row.doctor]), [[p1, "Doctor 1"]]);
    assert.equal(await doctorOf(p2), null, "the waiting patient left the offline doctor (pending: no one else is online)");

    await signIn("Doctor 2");
    assert.equal(await doctorOf(p2), "Doctor 2");
    const byDoctor = await h.request("POST", "/queue/transfer", { token: tokens.admin2, body: { patient_id: p1, doctor: "Doctor 2" } });
    assert.equal(byDoctor.status, 403);
    const toOffline = await h.request("POST", "/queue/transfer", { token: tokens.frontdesk, body: { patient_id: p1, doctor: "Doctor 3" } });
    assert.equal(toOffline.status, 400);
    const moved = await h.request("POST", "/queue/transfer", { token: tokens.frontdesk, body: { patient_id: p1, doctor: "Doctor 2" } });
    assert.equal(moved.status, 200, moved.body.message);
    const transferred = await patient(p1);
    assert.equal(transferred.counter_id, "Doctor 2");
    assert.equal(transferred.consultation_started_at, active.consultation_started_at);
    assert.equal(await doctorOf(p2), "Doctor 2", "the receiving doctor's own list is unchanged");
    assert.equal((await complete("Doctor 1", p1)).status, 403);
    assert.equal((await complete("Doctor 2", p1)).status, 200);
    await assertConsistent();
  });

  test("Undo and Re-queue return the visit to its doctor while available; otherwise it is reassigned in rotation", async () => {
    await signInAll();
    const [a, b, c] = [await register("A"), await register("B"), await register("C")];   // Doctor 1, 2, 3
    const cancel = (id) => h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: id, reason: "Synthetic" } });
    for (const visit of [b, c]) {
      const cancelled = await cancel(visit.id);
      assert.equal(cancelled.status, 200, cancelled.body.message);
    }
    const requeued = await h.request("POST", "/queue/requeue", { token: tokens.frontdesk, body: { patient_id: c.id, reason: "Came back" } });
    assert.equal(requeued.status, 200, requeued.body.message);
    assert.equal(await doctorOf(c.id), "Doctor 3", "Re-queue: back to its available doctor");
    assert.equal((await rotation()).last_doctor, "Doctor 3", "restoring is not a new turn");
    assert.equal((await signOut("Doctor 2")).status, 200);
    const undone = await h.request("POST", "/queue/undo", { token: tokens.frontdesk, body: { patient_id: b.id } });
    assert.equal(undone.status, 200, undone.body.message);
    assert.equal((await patient(b.id)).status, "waiting");
    assert.equal(await doctorOf(b.id), "Doctor 1", "Undo: its doctor is offline, so the next available doctor after Doctor 3");
    assert.deepEqual((await history(b.id)).map((row) => [row.reason, row.previous_doctor, row.new_doctor, row.detail]),
      [["round_robin_assignment", null, "Doctor 2", null], ["round_robin_reassignment", "Doctor 2", "Doctor 1", "doctor_unavailable_after_undo"]]);
    assert.deepEqual((await history(c.id)).map((row) => [row.reason, row.new_doctor]),
      [["round_robin_assignment", "Doctor 3"], ["restored_to_assigned_doctor", "Doctor 3"]]);
    assert.equal(await doctorOf(a.id), "Doctor 1");
    assert.equal((await register("D")).body.assigned_doctor, "Doctor 3");
    await assertNoLostOrMisassigned();
    await assertConsistent();
  });

  test("the previous doctor's stale Call is refused after reassignment; only the assigned doctor calls", async () => {
    await signIn("Doctor 1");
    const p1 = (await register("Stale")).id;
    for (const token of [tokens.superadmin, tokens.frontdesk]) {
      assert.equal((await h.request("POST", "/queue/call", { token, body: { patient_id: p1, counterId: "Doctor 1" } })).status, 403);
    }
    await goStale("Doctor 1");
    await signIn("Doctor 2");
    assert.equal(await doctorOf(p1), "Doctor 2");
    assert.equal((await call("Doctor 1", p1)).status, 403);
    assert.equal((await call("Doctor 2", p1)).status, 200);
    const announcements = h.settings.getVoiceAnnouncementEvents().filter((event) => Number(event.patient_id) === p1);
    assert.equal(announcements.length, 1);
    await assertConsistent();
  });

  test("simultaneous registrations, sign-outs, availability changes and sweeps from two backends lose or duplicate no patient", async (t) => {
    await signInAll();
    const other = backend();
    await registerMany(6);
    const burst = [];
    for (let i = 0; i < 6; i += 1) burst.push(register(`Burst ${i}`, { harness: i % 2 ? other : h }));
    burst.push(signOut("Doctor 2"), setAvailable("Doctor 3", false), sweep(), sweep(other));
    for (let i = 6; i < 10; i += 1) burst.push(register(`Burst ${i}`, { harness: i % 2 ? other : h }));
    burst.push(setAvailable("Doctor 3", true), sweep(other), sweep());
    const results = await Promise.allSettled(burst);
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status !== "fulfilled").map((r) => r.reason?.message)));
    await sweep();
    const registered = results.slice(0, 6).concat(results.slice(10, 14)).map((r) => r.value);
    const saved = registered.filter((r) => r.status === 200);
    t.diagnostic(`simultaneous registrations during availability changes: ${saved.length} of ${registered.length} saved`);
    assert.equal(saved.length, registered.length, JSON.stringify(registered.map((r) => r.body?.message)));
    assert.equal(await patientCount(), 16, "every registration is in the database exactly once");
    const tickets = (await db.query("SELECT queue_number FROM public.patients ORDER BY id")).rows.map((row) => row.queue_number);
    assert.deepEqual(tickets, Array.from({ length: 16 }, (_, i) => `GP-${String(i + 1).padStart(3, "0")}`), "unique, gap-free, in commit order");
    const rows = (await db.query("SELECT id, counter_id FROM public.patients ORDER BY id")).rows;
    assert.ok(rows.every((row) => ["Doctor 1", "Doctor 3"].includes(row.counter_id)), JSON.stringify(rows));
    // Every visit has one coherent assignment trail: each move starts where the previous one ended.
    for (const row of rows) {
      const trail = (await history(Number(row.id))).filter((h) => h.reason !== "intervention_required");
      assert.equal(trail[0].reason, "round_robin_assignment");
      for (let i = 1; i < trail.length; i += 1) assert.equal(trail[i].previous_doctor, trail[i - 1].new_doctor ?? trail[i].previous_doctor);
      assert.equal(trail.at(-1).new_doctor, row.counter_id);
    }
    assert.ok(!(await history()).some((row) => row.new_doctor === "Doctor 2" && row.reason !== "round_robin_assignment"), "nothing reassigned to the signed-out doctor");
    await assertNoLostOrMisassigned();
    await assertConsistent();
  });

  test("rotation, history and round-robin functions are closed to the browser roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["patient_assignment_history", "doctor_rotation_state"]) {
        assert.equal((await db.query("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, `public.${table}`])).rows[0].ok, false);
      }
      for (const fn of ["register_visit_round_robin(jsonb,timestamptz,timestamptz)", "dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)",
        "call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)",
        "transfer_active_consultation(bigint,text,text,uuid,timestamptz,timestamptz)", "get_round_robin_dispatch_status(timestamptz,timestamptz)"]) {
        assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${fn}`])).rows[0].ok, false, fn);
      }
    }
  });
});

describe("RR1 without its database functions fails closed (isolated PGlite)", { skip: unavailable }, () => {
  test("registration is refused with nothing saved; Call refuses with nothing changed", async () => {
    const db = await freshDatabase({ withRr1: false });
    try {
      await db.exec("INSERT INTO public.counters (id_num) VALUES ('Doctor 1'), ('Doctor 2'), ('Doctor 3')");
      const h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, { doctorDispatchMode: "round_robin" });
      const frontdesk = (await h.login("frontdesk", password("frontdesk"))).token;
      const doctor = (await h.login("admin1", password("admin1"))).token;
      const registered = await h.request("POST", "/queue", { token: frontdesk, body: { fullName: "No RR1", service_type: "medical_consultation" } });
      assert.equal(registered.status, 503);
      assert.match(registered.body.message, /20261109-rr1-round-robin-dispatch\.sql/);
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.patients")).rows[0].n), 0);
      const view = (await h.request("GET", "/queue", { token: frontdesk })).body;
      assert.equal(view.dispatch.available, false);
      await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id)
        VALUES ('Legacy', 'GP-001', 'medical_consultation', 'waiting', 'Doctor 1')`);
      const before = (await db.query("SELECT row_to_json(p) AS v FROM public.patients p")).rows;
      const id = Number(before[0].v.id);
      const called = await h.request("POST", "/queue/call", { token: doctor, body: { patient_id: id } });
      assert.equal(called.status, 503);
      assert.match(called.body.message, /20261109-rr1-round-robin-dispatch\.sql/);
      assert.deepEqual((await db.query("SELECT row_to_json(p) AS v FROM public.patients p")).rows, before);
    } finally {
      await db.close();
    }
  });
});

describe("RR1 installation lifecycle (isolated PGlite)", { skip: unavailable }, () => {
  test("preflight passes, install is additive and repeatable, rollback removes only RR1 and keeps the history", async () => {
    const db = await freshDatabase({ withRr1: false });
    try {
      await db.exec("RESET ROLE;");
      await db.exec(`INSERT INTO public.counters (id_num) VALUES ('Doctor 1'), ('Doctor 2'), ('Doctor 3');
        INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id) VALUES
          ('Existing A', 'GP-001', 'consultation', 'completed', 'Doctor 1'), ('Existing B', 'OB-001', 'prenatal', 'waiting', NULL);`);
      const lastRows = async (sql) => (await db.exec(sql)).filter((result) => result.fields.length).pop().rows;
      const functions = async () => (await db.query(`SELECT p.oid::regprocedure::text AS f, md5(p.prosrc) AS h FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`)).rows;
      const data = async () => (await db.query("SELECT row_to_json(p) AS v FROM public.patients p ORDER BY id")).rows
        .concat((await db.query("SELECT row_to_json(c) AS v FROM public.counters c ORDER BY id")).rows);

      const pre = await lastRows(readScript("20261109-rr1-preflight.sql"));
      assert.equal(pre.length, 20);
      assert.deepEqual(pre.filter((row) => !row.passed), []);
      const fnBefore = await functions();
      const dataBefore = await data();

      await db.exec(readScript(RR1));
      await db.exec(readScript(RR1));
      const fnAfter = await functions();
      const added = ["call_patient_visit_rr", "dispatch_round_robin", "get_round_robin_dispatch_status", "qms_rr_approved_services",
        "qms_rr_doctor_state", "qms_rr_effective_priority", "qms_rr_next_doctor", "register_visit_round_robin", "transfer_active_consultation"];
      assert.deepEqual(fnAfter.filter((row) => !added.some((name) => row.f.startsWith(`${name}(`))), fnBefore, "no existing function changed");
      assert.equal(fnAfter.length - fnBefore.length, added.length);
      assert.deepEqual(await data(), dataBefore, "no patient or counter row changed");
      assert.equal((await lastRows(readScript("20261109-rr1-preflight.sql"))).find((row) => row.position === 16).passed, false);

      await db.exec("INSERT INTO public.patient_assignment_history (patient_id, previous_status, new_status, reason, automatic) VALUES (2, 'waiting', 'waiting', 'round_robin_assignment', true)");
      await db.exec(readScript("20261109-rr1-rollback.sql"));
      await db.exec(readScript("20261109-rr1-rollback.sql"));
      assert.deepEqual(await functions(), fnBefore);
      assert.equal((await db.query("SELECT to_regclass('public.doctor_rotation_state') AS t")).rows[0].t, null);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM public.patient_assignment_history")).rows[0].n, 1, "audit history kept");
      assert.deepEqual(await data(), dataBefore);
      await db.exec(readScript(RR1));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM public.patient_assignment_history")).rows[0].n, 1);
    } finally {
      await db.close();
    }
  });
});
