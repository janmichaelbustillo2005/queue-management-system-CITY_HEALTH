// FC1 Front Desk confirmation before a doctor may call. The REAL routes, JWT middleware,
// presenceService, queueService and settingsService (pgBackendHarness) against a fresh, synthetic,
// in-memory PGlite database in the development project's known state plus FC1 (and RR1 where
// stated). Never loads .env or the Supabase client and never touches real data.
// PGlite has ONE connection: "concurrent" requests interleave at statement boundaries, so the
// concurrency tests check the observable invariants (one confirmation, original kept).
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
const OTHER_CALL_SCRIPTS = ["20261029-wps-a-call-aging.sql", "20261029-d1-shared-call.sql", "20261029-d1a-shared-wps-a-call.sql"];
const RR1 = "20261109-rr1-round-robin-dispatch.sql";
const FC1 = "20261111-fc1-front-desk-confirmation.sql";
const ACCOUNTS = {
  superadmin: ["superadmin", null], frontdesk: ["admin", null], frontdesk2: ["admin", "Front Desk"],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const DOCTOR_ACCOUNT = { "Doctor 1": "admin1", "Doctor 2": "admin2", "Doctor 3": "admin3" };
const AWAITING = /not been confirmed by the Front Desk/;
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

// Shared per-suite helpers over one database and one backend harness.
function suite(getDb, getH, tokens) {
  const db = () => getDb();
  const h = () => getH();
  const row = async (id) => (await db().query("SELECT row_to_json(p) AS v FROM public.patients p WHERE id = $1", [id])).rows[0].v;
  const counters = async () => (await db().query("SELECT id_num, current_patient_id FROM public.counters ORDER BY id")).rows;
  const idOf = async (queueNumber) =>
    Number((await db().query("SELECT id FROM public.patients WHERE queue_number = $1", [queueNumber])).rows[0].id);
  async function register(name, { service = "medical_consultation", flags = [] } = {}) {
    const response = await h().request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: name, service_type: service, vulnerabilityFlags: flags } });
    assert.equal(response.status, 200, response.body.message);
    return { ...response.body, id: await idOf(response.body.queue_number) };
  }
  const confirm = (id, token = tokens.frontdesk) => h().request("POST", "/queue/confirm", { token, body: { patient_id: id } });
  const call = (doctor, id, body = {}) => h().request("POST", "/queue/call", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id, ...body } });
  const finish = async (doctor, id) => {
    const token = tokens[DOCTOR_ACCOUNT[doctor]];
    assert.equal((await h().request("POST", "/queue/start", { token, body: { patient_id: id } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await h().request("POST", "/queue/complete", { token, body: { patient_id: id } })).status, 200);
  };
  return { row, counters, register, confirm, call, finish };
}

describe("FC1 Front Desk confirmation, service dispatch with C1 (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  const tokens = {};
  const s = suite(() => db, () => h, tokens);

  before(async () => { db = await freshDatabase([...DEVELOPMENT_STATE, FC1]); });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
      DELETE FROM public.staff_auth_sessions; RESET ROLE; DELETE FROM public.patient_records; SET ROLE service_role;
      INSERT INTO public.counters (id_num, service_types, is_online) VALUES ('Doctor 1', '["consultation","checkup"]', true),
        ('Doctor 2', '["prenatal","maternity"]', true), ('Doctor 3', '["family_planning"]', true);`);
    h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) });
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  });

  test("A: a registered visit is Pending; its doctor cannot call it, even by a direct API request, and nothing changes", async () => {
    const visit = await s.register("Pending Patient");
    const before = await s.row(visit.id);
    assert.equal(before.status, "waiting");
    assert.equal(before.confirmed_at, null);
    assert.equal(before.confirmed_by, null);
    const countersBefore = await s.counters();

    const byDoctor = await s.call("Doctor 1", visit.id);
    assert.equal(byDoctor.status, 409);
    assert.match(byDoctor.body.message, AWAITING);
    const bySuperadmin = await h.request("POST", "/queue/call", { token: tokens.superadmin, body: { patient_id: visit.id, counterId: "Doctor 1" } });
    assert.equal(bySuperadmin.status, 409);
    assert.match(bySuperadmin.body.message, AWAITING);
    assert.deepEqual(await s.row(visit.id), before, "the visit is unchanged");
    assert.deepEqual(await s.counters(), countersBefore, "no doctor counter is claimed");

    const queue = (await h.request("GET", "/queue", { token: tokens.admin1 })).body;
    const listed = queue.patients.find((p) => Number(p.id) === visit.id);
    assert.equal(listed.confirmed_at, null, "the queue carries the pending state to every dashboard");
  });

  test("B: the Front Desk confirmation is saved with the database time and account, changes nothing else, and lets the doctor call", async () => {
    const visit = await s.register("Present Patient");
    const before = await s.row(visit.id);
    const t0 = Date.now();
    const confirmed = await s.confirm(visit.id);
    assert.equal(confirmed.status, 200, confirmed.body.message);
    assert.equal(confirmed.body.already_confirmed, false);
    const after = await s.row(visit.id);
    assert.equal(after.confirmed_by, "frontdesk");
    assert.ok(Date.parse(after.confirmed_at) >= t0 - 1000 && Date.parse(after.confirmed_at) <= Date.now() + 1000);
    for (const key of ["status", "counter_id", "queue_number", "priority_score", "created_at", "called_at", "service_type", "vulnerability_flags"]) {
      assert.deepEqual(after[key], before[key], `${key} is unchanged`);
    }
    assert.notEqual(after.visit_state_revision, before.visit_state_revision, "a Call prepared from the older read is stale");

    // Persisted: a fresh read (page refresh) still shows it.
    const queue = (await h.request("GET", "/queue", { token: tokens.frontdesk })).body;
    assert.equal(queue.patients.find((p) => Number(p.id) === visit.id).confirmed_by, "frontdesk");

    const called = await s.call("Doctor 1", visit.id);
    assert.equal(called.status, 200, called.body.message);
    const served = await s.row(visit.id);
    assert.equal(served.status, "serving");
    assert.equal(served.confirmed_at, after.confirmed_at, "the confirmation stays with the visit");
    await s.finish("Doctor 1", visit.id);
    assert.equal((await s.row(visit.id)).status, "completed");
    assert.equal((await s.call("Doctor 1", visit.id)).status, 400, "a completed visit cannot be called");
  });

  test("E: concurrent and repeated confirmations keep the first confirmation", async () => {
    const visit = await s.register("Double Confirm");
    const results = await Promise.all([s.confirm(visit.id), s.confirm(visit.id, tokens.frontdesk2), s.confirm(visit.id)]);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(results.filter((r) => r.body.already_confirmed === false).length, 1, "exactly one confirmation is written");
    const first = await s.row(visit.id);
    const winner = results.find((r) => !r.body.already_confirmed).body.patient;
    assert.equal(first.confirmed_by, winner.confirmed_by);
    const repeat = await s.confirm(visit.id, tokens.frontdesk2);
    assert.equal(repeat.body.already_confirmed, true);
    const after = await s.row(visit.id);
    assert.equal(after.confirmed_at, first.confirmed_at);
    assert.equal(after.confirmed_by, first.confirmed_by);
    assert.equal(after.visit_state_revision, first.visit_state_revision, "a repeat writes nothing");
  });

  test("only a Frontdesk account may confirm: doctors and Superadmin are refused by the API and by the database", async () => {
    const visit = await s.register("Authority Check");
    const before = await s.row(visit.id);
    for (const idNum of ["admin1", "admin2", "superadmin"]) {
      const response = await s.confirm(visit.id, tokens[idNum]);
      assert.equal(response.status, 403, idNum);
    }
    assert.equal((await h.request("POST", "/queue/confirm", { body: { patient_id: visit.id } })).status, 401);
    await assert.rejects(db.query("SELECT public.confirm_patient_visit($1, 'admin1', now() - interval '1 day', now() + interval '1 day')", [visit.id]),
      (error) => error.code === "42501");
    assert.deepEqual(await s.row(visit.id), before);
    assert.equal((await s.confirm(999999)).status, 404);
  });

  test("C: a visit cancelled before confirmation can be neither confirmed nor called", async () => {
    const visit = await s.register("Left Early");
    const cancelled = await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: visit.id, reason: "Left before confirmation" } });
    assert.equal(cancelled.status, 200, cancelled.body.message);
    const before = await s.row(visit.id);
    const confirmed = await s.confirm(visit.id);
    assert.equal(confirmed.status, 409);
    assert.match(confirmed.body.message, /Only a waiting patient can be confirmed/);
    assert.equal((await s.call("Doctor 1", visit.id)).status, 400);
    assert.deepEqual(await s.row(visit.id), before);
  });

  test("unconfirmed visits keep their doctor and rank; the doctor's next patient is its highest-priority CONFIRMED visit", async () => {
    const senior = await s.register("Senior Not Yet Here", { flags: ["senior"] });
    const regular = await s.register("Regular Present");
    const later = await s.register("Regular Later");
    assert.ok(senior.priority_score > regular.priority_score);
    assert.equal((await s.confirm(regular.id)).status, 200);
    assert.equal((await s.confirm(later.id)).status, 200);

    // Priority among confirmed visits is unchanged: the later regular visit is not next.
    const outOfOrder = await s.call("Doctor 1", later.id);
    assert.equal(outOfOrder.status, 400);
    assert.match(outOfOrder.body.message, /next eligible patient for Doctor 1/);
    assert.equal((await s.call("Doctor 1", senior.id)).status, 409);
    assert.equal((await s.call("Doctor 1", regular.id)).status, 200, "the pending senior does not block the doctor");
    const pending = await s.row(senior.id);
    assert.equal(pending.status, "waiting");
    assert.equal(pending.priority_score, senior.priority_score);
    await s.finish("Doctor 1", regular.id);

    // Once confirmed, the senior is the head again, ahead of the earlier-confirmed regular visit.
    assert.equal((await s.confirm(senior.id)).status, 200);
    assert.equal((await s.call("Doctor 1", later.id)).status, 400);
    assert.equal((await s.call("Doctor 1", senior.id)).status, 200);
  });

  test("D: direct database writes cannot call an unconfirmed visit or rewrite a confirmation", async () => {
    const visit = await s.register("Bypass Attempt");
    const before = await s.row(visit.id);
    // The older two-statement Call, or any other writer, is refused by the trigger.
    await assert.rejects(db.query("UPDATE public.patients SET status = 'serving', counter_id = 'Doctor 1', called_at = now() WHERE id = $1", [visit.id]),
      (error) => error.code === "P0001" && /not been confirmed/.test(error.message));
    // The atomic Call function itself refuses it, with the same hint the backend maps to 409.
    await assert.rejects(db.query(`SELECT public.call_patient_visit($1, 'Doctor 1', 'admin1', $2, now() - interval '1 day', now() + interval '1 day')`,
      [visit.id, before.visit_state_revision]), (error) => error.code === "P0001" && /not been confirmed/.test(error.message));
    assert.deepEqual(await s.row(visit.id), before);

    assert.equal((await s.confirm(visit.id)).status, 200);
    for (const sql of ["UPDATE public.patients SET confirmed_by = 'frontdesk2' WHERE id = $1",
      "UPDATE public.patients SET confirmed_at = NULL, confirmed_by = NULL WHERE id = $1",
      "UPDATE public.patients SET confirmed_at = now() - interval '1 hour' WHERE id = $1"]) {
      await assert.rejects(db.query(sql, [visit.id]), /cannot be changed/);
    }
    const other = await s.register("Cancelled Row");
    await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: other.id, reason: "test" } });
    await assert.rejects(db.query("UPDATE public.patients SET confirmed_at = now(), confirmed_by = 'frontdesk' WHERE id = $1", [other.id]),
      /Only a waiting patient can be confirmed/);
    await assert.rejects(db.query("UPDATE public.patients SET confirmed_at = now() WHERE id = $1", [other.id]),
      (error) => error.code === "23514" || /Only a waiting patient/.test(error.message));
  });

  test("F: every visit has its own confirmation; a returning patient's new visit starts Pending", async () => {
    const record = { firstName: "Repeat", lastName: "Visitor", sex: "Female", birthdate: "1990-01-01", residency: "Synthetic Street", serviceType: "medical_consultation" };
    const first = await h.request("POST", "/patient-records/visits", { token: tokens.frontdesk, body: { ...record, confirmNewRecord: true } });
    assert.equal(first.status, 200, first.body.message);
    const firstId = Number((await db.query("SELECT id FROM public.patients WHERE queue_number = $1", [first.body.queue_number])).rows[0].id);
    assert.equal((await s.confirm(firstId)).status, 200);
    assert.equal((await s.call("Doctor 1", firstId)).status, 200);
    await s.finish("Doctor 1", firstId);

    const second = await h.request("POST", "/patient-records/visits", { token: tokens.frontdesk,
      body: { patientRecordId: first.body.patient_record.id, serviceType: "medical_consultation" } });
    assert.equal(second.status, 200, second.body.message);
    const secondId = Number((await db.query("SELECT id FROM public.patients WHERE queue_number = $1", [second.body.queue_number])).rows[0].id);
    assert.notEqual(secondId, firstId);
    const visit = await s.row(secondId);
    assert.equal(visit.patient_record_id, (await s.row(firstId)).patient_record_id, "same patient record");
    assert.equal(visit.confirmed_at, null, "the previous visit's confirmation does not carry over");
    assert.equal((await s.call("Doctor 1", secondId)).status, 409);
    assert.notEqual((await s.row(firstId)).confirmed_at, null, "the first visit keeps its own history");
  });

  test("Re-queue starts a new turn that needs a new confirmation; Undo keeps the confirmation", async () => {
    const requeued = await s.register("Requeued Patient");
    assert.equal((await s.confirm(requeued.id)).status, 200);
    await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: requeued.id, reason: "Stepped out" } });
    const back = await h.request("POST", "/queue/requeue", { token: tokens.frontdesk, body: { patient_id: requeued.id } });
    assert.equal(back.status, 200, back.body.message);
    const afterRequeue = await s.row(requeued.id);
    assert.equal(afterRequeue.status, "waiting");
    assert.equal(afterRequeue.confirmed_at, null);
    assert.equal(afterRequeue.confirmed_by, null);
    assert.equal((await s.call("Doctor 1", requeued.id)).status, 409);

    const undone = await s.register("Undone Patient");
    assert.equal((await s.confirm(undone.id)).status, 200);
    const confirmed = await s.row(undone.id);
    await h.request("POST", "/queue/cancel", { token: tokens.frontdesk, body: { patient_id: undone.id, reason: "Mistake" } });
    const restored = await h.request("POST", "/queue/undo", { token: tokens.frontdesk, body: { patient_id: undone.id } });
    assert.equal(restored.status, 200, restored.body.message);
    const afterUndo = await s.row(undone.id);
    assert.equal(afterUndo.status, "waiting");
    assert.equal(afterUndo.created_at, confirmed.created_at);
    assert.equal(afterUndo.confirmed_at, confirmed.confirmed_at);
    assert.equal(afterUndo.confirmed_by, confirmed.confirmed_by);
  });

  test("only visits in today's queue can be confirmed", async () => {
    const { rows: [old] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, created_at)
      VALUES ('Yesterday', 'GP-OLD', 'medical_consultation', 'waiting', now() - interval '2 days') RETURNING id`);
    const response = await s.confirm(Number(old.id));
    assert.equal(response.status, 409);
    assert.match(response.body.message, /today's queue/);
  });
});

describe("FC1 with round-robin dispatch (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  const tokens = {};
  const s = suite(() => db, () => h, tokens);
  const rotation = async () => (await db.query("SELECT last_doctor, last_patient_id, rotation_date FROM public.doctor_rotation_state")).rows[0];
  const history = async () => (await db.query("SELECT patient_id, previous_doctor, new_doctor, reason FROM public.patient_assignment_history ORDER BY id")).rows;

  before(async () => { db = await freshDatabase([...DEVELOPMENT_STATE, RR1, FC1]); });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
      DELETE FROM public.staff_auth_sessions; DELETE FROM public.patient_assignment_history;
      UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL, rotation_date = NULL;
      INSERT INTO public.counters (id_num, is_online) VALUES ('Doctor 1', true), ('Doctor 2', true), ('Doctor 3', true);`);
    h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, { doctorDispatchMode: "round_robin" });
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  });

  test("confirmation never assigns, reassigns or advances the rotation; each doctor calls only its confirmed visits", async () => {
    const visits = [];
    for (const name of ["Patient 1", "Patient 2", "Patient 3"]) visits.push(await s.register(name));
    assert.deepEqual(visits.map((v) => v.assigned_doctor), ["Doctor 1", "Doctor 2", "Doctor 3"]);
    for (const v of visits) assert.equal((await s.row(v.id)).confirmed_at, null);
    const pointer = await rotation();
    assert.equal(pointer.last_doctor, "Doctor 3");
    const assignments = await history();

    assert.equal((await s.confirm(visits[0].id)).status, 200);
    await h.queue.requestDispatch();
    assert.deepEqual(await rotation(), pointer, "the pointer does not move");
    assert.deepEqual(await history(), assignments, "no assignment is added or changed");
    for (const [i, doctor] of ["Doctor 1", "Doctor 2", "Doctor 3"].entries()) {
      assert.equal((await s.row(visits[i].id)).counter_id, doctor, "every visit keeps its doctor");
    }

    assert.equal((await s.call("Doctor 2", visits[1].id)).status, 409, "Patient 2 is not confirmed");
    assert.equal((await s.call("Doctor 3", visits[2].id)).status, 409, "Patient 3 is not confirmed");
    const called = await s.call("Doctor 1", visits[0].id);
    assert.equal(called.status, 200, called.body.message);
    assert.equal((await s.row(visits[0].id)).counter_id, "Doctor 1", "the Call keeps the assigned doctor");

    // The rotation continues from where it was: the next registration goes to Doctor 1.
    const next = await s.register("Patient 4");
    assert.equal(next.assigned_doctor, "Doctor 1");
    assert.equal((await rotation()).last_doctor, "Doctor 1");
  });
});

describe("FC1 installation lifecycle (isolated PGlite)", { skip: unavailable }, () => {
  const lastRows = async (db, sql) => (await db.exec(sql)).filter((result) => result.fields.length).pop().rows;
  // Line endings normalized, as the C1/D1/D1-A verify scripts pin sources (some scripts are CRLF).
  const callFunctions = async (db) => (await db.query(`SELECT p.oid::regprocedure::text AS f,
      md5(replace(p.prosrc, E'\\r\\n', E'\\n')) AS h FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'call_patient_visit%' ORDER BY 1`)).rows;

  test("preflight passes; install keeps every row, leaves waiting visits Pending, is repeatable; verify passes; rollback restores every Call function", async () => {
    const db = await liveKnownDatabase(PGlite);
    try {
      for (const script of [...DEVELOPMENT_STATE, ...OTHER_CALL_SCRIPTS, RR1]) await db.exec(readScript(script));
      await db.exec(`INSERT INTO public.counters (id_num) VALUES ('Doctor 1'), ('Doctor 2'), ('Doctor 3');
        INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id) VALUES
          ('Existing waiting', 'GP-001', 'consultation', 'waiting', NULL), ('Existing done', 'GP-002', 'consultation', 'completed', 'Doctor 1');`);
      const data = async () => (await db.query(`SELECT id, status, counter_id, queue_number, priority_score, created_at, visit_state_revision
        FROM public.patients ORDER BY id`)).rows;

      const pre = await lastRows(db, readScript("20261111-fc1-preflight.sql"));
      assert.equal(pre.length, 7);
      assert.deepEqual(pre.filter((row) => !row.passed), []);
      assert.match(pre[6].actual, /call_patient_visit, .*call_patient_visit_rr/);
      const original = await callFunctions(db);
      assert.equal(original.length, 5);
      const dataBefore = await data();

      await db.exec(readScript(FC1));
      await db.exec(readScript(FC1));
      assert.deepEqual(await data(), dataBefore, "no patient row is updated by the installation");
      const confirmations = (await db.query("SELECT confirmed_at, confirmed_by FROM public.patients")).rows;
      assert.deepEqual(confirmations, [{ confirmed_at: null, confirmed_by: null }, { confirmed_at: null, confirmed_by: null }],
        "existing visits are not silently treated as confirmed");
      const installed = await callFunctions(db);
      assert.deepEqual(installed.map((row) => row.f), original.map((row) => row.f), "no Call function is added or removed");
      assert.ok(installed.every((row, i) => row.h !== original[i].h), "every installed Call function is the FC1 version");

      const verify = await lastRows(db, readScript("20261111-fc1-verify.sql"));
      assert.equal(verify.length, 7);
      assert.deepEqual(verify.filter((row) => !row.passed), []);
      assert.equal(verify[5].actual, "5 of 5 installed");
      assert.equal((await lastRows(db, readScript("20261111-fc1-preflight.sql"))).every((row) => row.passed), true, "re-run preflight");

      await db.exec(readScript("20261111-fc1-rollback.sql"));
      await db.exec(readScript("20261111-fc1-rollback.sql"));
      assert.deepEqual(await callFunctions(db), original, "every Call function is restored exactly");
      const leftovers = (await db.query(`SELECT
          to_regprocedure('public.confirm_patient_visit(bigint,text,timestamptz,timestamptz)') IS NULL AS confirm_gone,
          to_regprocedure('public.qms_guard_front_desk_confirmation()') IS NULL AS guard_gone,
          NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'patients_front_desk_confirmation') AS trigger_gone,
          (SELECT count(*) FROM information_schema.columns WHERE table_name = 'patients' AND column_name IN ('confirmed_at', 'confirmed_by')) AS kept`)).rows[0];
      assert.deepEqual(leftovers, { confirm_gone: true, guard_gone: true, trigger_gone: true, kept: 2 });
      assert.deepEqual(await data(), dataBefore);

      await db.exec(readScript(FC1));
      assert.deepEqual((await lastRows(db, readScript("20261111-fc1-verify.sql"))).filter((row) => !row.passed), [], "reinstall");
    } finally {
      await db.close();
    }
  });

  test("a database with only C1 gets only the FC1 C1; no other Call function is installed", async () => {
    const db = await liveKnownDatabase(PGlite);
    try {
      for (const script of DEVELOPMENT_STATE) await db.exec(readScript(script));
      await db.exec(readScript(FC1));
      assert.deepEqual((await callFunctions(db)).map((row) => row.f), ["call_patient_visit(bigint,text,text,uuid,timestamp with time zone,timestamp with time zone)"]);
      const verify = await lastRows(db, readScript("20261111-fc1-verify.sql"));
      assert.deepEqual(verify.filter((row) => !row.passed), []);
      assert.equal(verify[5].actual, "1 of 1 installed");
    } finally {
      await db.close();
    }
  });
});
