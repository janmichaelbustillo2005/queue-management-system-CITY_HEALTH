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
  const history = async (id) => (await db.query(`SELECT reason, previous_doctor, new_doctor, automatic FROM public.patient_assignment_history
    WHERE ($1::bigint IS NULL OR patient_id = $1) ORDER BY id`, [id ?? null])).rows;
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

  test("an archived doctor is excluded and cannot sign back in", async () => {
    await signInAll();
    // The service call behind POST /users/:id_num/archive (the harness has no route for it), then
    // the dispatch pass that route triggers.
    await h.queue.archiveUser("admin2", { id_num: "superadmin" });
    await sweep();
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

  test("no online and available doctor: registration is refused, nothing is saved and the rotation does not move", async () => {
    await signInAll();
    await registerMany(1);
    // Each sign-out hands the waiting patient to the next signed-in doctor; after the last one it
    // waits unassigned. The snapshot is taken after that.
    for (const doctor of DOCTORS) await signOut(doctor);
    assert.deepEqual((await history()).map((row) => row.reason), ["round_robin_assignment", "doctor_unavailable",
      "round_robin_reassignment", "doctor_unavailable", "round_robin_reassignment", "doctor_unavailable"]);
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
  test("a failed registration transaction does not move the rotation (duplicate ticket, retried with the next number)", async () => {
    await signInAll();
    await registerMany(1);
    // Direct: a duplicate queue number fails and leaves pointer and history as they were.
    const before = await rotation();
    const window = (await db.query(`SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila') AS s`)).rows[0].s;
    await assert.rejects(db.query(`SELECT public.register_visit_round_robin($1::jsonb, $2::timestamptz, $2::timestamptz + interval '1 day')`,
      [JSON.stringify({ queue_number: "GP-001", id_num: "Dup", service_type: "medical_consultation" }), window]),
    (error) => error.code === "23505");
    assert.deepEqual(await rotation(), before);
    assert.equal((await history()).length, 1);
    // Through the backend: another desk takes the ticket number first; the retry gets the next one
    // and the rotation moves exactly one step.
    let raced = false;
    const racing = backend({
      onRequest: async (request) => {
        if (!raced && request.kind === "rpc" && request.name === "register_visit_round_robin") {
          raced = true;
          await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, priority_score)
            VALUES ('Other Desk', $1, 'medical_consultation', 'completed', 'Doctor 1', 1)`, [request.args.p_visit.queue_number]);
        }
      }
    });
    const response = await register("Retried", { harness: racing });
    assert.equal(response.status, 200, response.body.message);
    // The existing retry (next maximum + attempt offset) picks a fresh number; numbering is unchanged.
    assert.match(response.body.queue_number, /^GP-00[34]$/);
    assert.equal(response.body.assigned_doctor, "Doctor 2");
    assert.equal((await history()).length, 2);
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
  test("a doctor who signs out loses its not-yet-called patients; they are reassigned in turn with rank and waiting time kept", async () => {
    await signInAll();
    await registerMany(6);                // D1 has patients 1 and 4
    const d1 = (await db.query("SELECT id FROM public.patients WHERE counter_id = 'Doctor 1' ORDER BY id")).rows.map((r) => Number(r.id));
    const before = await Promise.all(d1.map(patient));
    assert.equal((await signOut("Doctor 1")).status, 200);
    const after = await Promise.all(d1.map(patient));
    assert.deepEqual(after.map((p) => p.counter_id), ["Doctor 2", "Doctor 3"], "rotation continues after Doctor 3, skipping Doctor 1");
    for (const [index, row] of after.entries()) {
      for (const key of ["created_at", "priority_score", "vulnerability_flags", "queue_number", "status"]) assert.deepEqual(row[key], before[index][key], key);
    }
    assert.deepEqual((await history(d1[0])).map((r) => r.reason), ["round_robin_assignment", "doctor_unavailable", "round_robin_reassignment"]);
    // The next registration continues the rotation.
    assert.equal((await register("Next")).body.assigned_doctor, "Doctor 2");
  });

  test("with every doctor offline, released and legacy unassigned visits wait, then are assigned when a doctor signs in", async () => {
    const legacy = await unassignedVisit("GP-500", { minutesAgo: 5 });
    await sweep();
    assert.equal(await doctorOf(legacy), null);
    assert.equal((await overview()).dispatch.all_unavailable, true);
    await signIn("Doctor 2");
    assert.equal(await doctorOf(legacy), "Doctor 2");
    assert.equal((await register("Then")).body.assigned_doctor, "Doctor 2");
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
    assert.equal(await doctorOf(p2), null, "the waiting patient left the offline doctor");

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
      assert.equal(pre.length, 19);
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
