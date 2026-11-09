// RR1 round-robin dispatch. The REAL routes, JWT middleware, presenceService, queueService and
// settingsService (pgBackendHarness) run with DOCTOR_DISPATCH_MODE=round_robin against a fresh,
// synthetic, in-memory PGlite database in the development project's known state plus B.2, C1,
// F5, W1 and RR1. Never loads .env or the Supabase client and never touches real data.
// PGlite has ONE connection: "concurrent" requests interleave at statement boundaries, so
// Scenario G checks the observable invariants, not real lock contention.
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
  "20261022-f5-requeue-terminal-recovery.sql", "20261025-w1-atomic-cancel.sql"];
const RR1 = "20261109-rr1-round-robin-dispatch.sql";
const ACCOUNTS = {
  superadmin: ["superadmin", null], frontdesk: ["admin", null],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const DOCTOR_ACCOUNT = { "Doctor 1": "admin1", "Doctor 2": "admin2", "Doctor 3": "admin3" };
const password = (idNum) => `synthetic-${idNum}-password`;

async function freshDatabase({ withRr1 = true } = {}) {
  const db = await liveKnownDatabase(PGlite);
  for (const script of [...DEVELOPMENT_STATE, ...(withRr1 ? [RR1] : [])]) await db.exec(readScript(script));
  await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  await db.exec(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  return db;
}

describe("RR1 round-robin dispatch (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  let tokens;
  const sessions = {};

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
      UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL;
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
    sessions[idNum] = session;
    return session.token;
  }
  const signOut = (doctor) => h.request("POST", "/auth/logout", { token: tokens[DOCTOR_ACCOUNT[doctor]] });
  // Heartbeat stopped: the session's last heartbeat falls outside the 75-second presence window.
  const goStale = (doctor) => db.query(`UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '90 seconds'
    WHERE user_id_num = $1`, [DOCTOR_ACCOUNT[doctor]]);
  const sweep = (harness = h) => harness.queue.requestDispatch();
  async function visit(ticket, { priority = 1, minutesAgo = 0, service = "consultation", flags = [] } = {}) {
    const { rows: [row] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score,
        vulnerability_flags, mobile_number, created_at) VALUES ($1, $2, $3, 'waiting', $4, $5, '09170000000',
        clock_timestamp() - ($6 * interval '1 minute')) RETURNING id`,
      [`Synthetic ${ticket}`, ticket, service, priority, JSON.stringify(flags), minutesAgo]);
    return Number(row.id);
  }
  const patient = async (id) => (await db.query("SELECT row_to_json(p) AS v FROM public.patients p WHERE id = $1", [id])).rows[0].v;
  const doctorOf = async (id) => (await patient(id)).counter_id;
  const history = async (id) => (await db.query(`SELECT reason, previous_doctor, new_doctor, automatic FROM public.patient_assignment_history
    WHERE ($1::bigint IS NULL OR patient_id = $1) ORDER BY id`, [id ?? null])).rows;
  const counters = async () => Object.fromEntries((await db.query("SELECT id_num, current_patient_id FROM public.counters")).rows
    .map((row) => [row.id_num, row.current_patient_id == null ? null : Number(row.current_patient_id)]));
  const call = (doctor, id) => h.request("POST", "/queue/call", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  const start = (doctor, id) => h.request("POST", "/queue/start", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  const complete = (doctor, id) => h.request("POST", "/queue/complete", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: id } });
  async function serveFully(doctor, id) {
    for (const step of [call, start, complete]) {
      const response = await step(doctor, id);
      assert.equal(response.status, 200, `${step.name} ${doctor}: ${response.body?.message}`);
    }
  }
  const overview = async (token = tokens.frontdesk) => (await h.request("GET", "/queue", { token })).body;
  // Invariants that must hold after any interleaving.
  async function assertConsistent() {
    const { rows } = await db.query(`SELECT
        (SELECT count(*) FROM (SELECT counter_id FROM public.patients WHERE status = 'waiting' AND counter_id IS NOT NULL
          GROUP BY counter_id HAVING count(*) > 1) d) AS doctors_with_two_pending,
        (SELECT count(*) FROM (SELECT counter_id FROM public.patients WHERE status = 'serving'
          GROUP BY counter_id HAVING count(*) > 1) d) AS doctors_with_two_serving,
        (SELECT count(*) FROM (SELECT current_patient_id FROM public.counters WHERE current_patient_id IS NOT NULL
          GROUP BY current_patient_id HAVING count(*) > 1) d) AS visits_on_two_counters,
        (SELECT count(*) FROM public.patients p WHERE p.status = 'serving' AND NOT EXISTS
          (SELECT 1 FROM public.counters c WHERE c.current_patient_id = p.id AND c.id_num = p.counter_id)) AS serving_without_its_counter`);
    assert.deepEqual(Object.values(rows[0]).map(Number), [0, 0, 0, 0], JSON.stringify(rows[0]));
  }

  // ---- A ----------------------------------------------------------------------------------
  test("A: with three doctors signed in, the top three WPS visits go one per doctor, in rotation", async () => {
    const regular = await visit("A-REG", { minutesAgo: 9 });
    const pwd = await visit("A-PWD", { priority: 3, minutesAgo: 1 });
    const older = await visit("A-OLD", { minutesAgo: 12 });
    const senior = await visit("A-SEN", { priority: 4, minutesAgo: 2 });
    const newest = await visit("A-NEW", { minutesAgo: 0 });
    for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) await signIn(doctor);
    await sweep();
    // WPS order: senior(4), pwd(3), then the oldest regular (FCFS). Doctors 1, 2, 3 in turn.
    assert.deepEqual([await doctorOf(senior), await doctorOf(pwd), await doctorOf(older)], ["Doctor 1", "Doctor 2", "Doctor 3"]);
    assert.equal(await doctorOf(regular), null);
    assert.equal(await doctorOf(newest), null);
    assert.equal((await db.query("SELECT last_doctor FROM public.doctor_rotation_state")).rows[0].last_doctor, "Doctor 3");
    assert.deepEqual((await history()).map((row) => row.reason), Array(3).fill("round_robin_assignment"));
    // Registration through Frontdesk: no doctor is free, so it waits unassigned and the rank is untouched.
    const registered = await h.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: "Walk In", service_type: "checkup" } });
    assert.equal(registered.status, 200, registered.body.message);
    assert.equal(registered.body.assigned_doctor, null);
    // Doctor 1 finishes; the next-ranked visit (oldest remaining regular) goes to Doctor 1.
    await serveFully("Doctor 1", senior);
    assert.equal(await doctorOf(regular), "Doctor 1");
    await assertConsistent();
  });

  test("A: a registration is assigned on the spot when a doctor is free, and the doctor's queue shows only its own visit", async () => {
    await signIn("Doctor 2");
    const response = await h.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: "New Patient", service_type: "prenatal" } });
    assert.equal(response.status, 200, response.body.message);
    assert.equal(response.body.assigned_doctor, "Doctor 2");
    const view = await overview(tokens.admin2);
    assert.equal(view.dispatch_mode, "shared");
    assert.equal(view.dispatch_strategy, "round_robin");
    const mine = view.patients.filter((row) => row.status === "waiting" && row.counter_id === "Doctor 2");
    assert.equal(mine.length, 1);
  });

  // ---- B ----------------------------------------------------------------------------------
  test("B: a doctor who is not signed in is skipped; the others share the visits", async () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await visit(`B-${i}`, { minutesAgo: 10 - i }));
    await signIn("Doctor 2");
    await signIn("Doctor 3");
    await sweep();
    assert.deepEqual([await doctorOf(ids[0]), await doctorOf(ids[1]), await doctorOf(ids[2])], ["Doctor 2", "Doctor 3", null]);
    await serveFully("Doctor 2", ids[0]);
    assert.equal(await doctorOf(ids[2]), "Doctor 2");
    await serveFully("Doctor 3", ids[1]);
    assert.equal(await doctorOf(ids[3]), "Doctor 3");
    const doctors = (await history()).filter((row) => row.new_doctor).map((row) => row.new_doctor);
    assert.ok(!doctors.includes("Doctor 1"), doctors.join());
    // A doctor disabled in System Settings is skipped the same way.
    await db.query("UPDATE public.counters SET is_online = false WHERE id_num = 'Doctor 2'");
    await sweep();
    assert.equal(await doctorOf(ids[2]), null, "a disabled doctor's pending visit returns to the shared queue");
  });

  // ---- C ----------------------------------------------------------------------------------
  test("C: logout and an expired heartbeat return pending visits to the shared queue with rank and waiting time kept", async () => {
    const p1 = await visit("C-1", { priority: 3, minutesAgo: 20 });
    const p2 = await visit("C-2", { minutesAgo: 15 });
    const p3 = await visit("C-3", { minutesAgo: 14 });
    for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) await signIn(doctor);
    await sweep();
    assert.deepEqual([await doctorOf(p1), await doctorOf(p2), await doctorOf(p3)], ["Doctor 1", "Doctor 2", "Doctor 3"]);
    const before = await patient(p1);
    const newer = await visit("C-NEWER", { priority: 3, minutesAgo: 0 });

    assert.equal((await signOut("Doctor 1")).status, 200);
    const released = await patient(p1);
    assert.equal(released.counter_id, null, "released at logout");
    assert.equal(released.created_at, before.created_at);
    assert.equal(released.priority_score, before.priority_score);
    assert.deepEqual(released.vulnerability_flags, before.vulnerability_flags);
    assert.equal(released.status, "waiting");
    assert.deepEqual((await history(p1)).map((row) => [row.reason, row.previous_doctor, row.new_doctor]),
      [["round_robin_assignment", null, "Doctor 1"], ["doctor_unavailable", "Doctor 1", null]]);

    // Doctor 2 frees up: the released visit outranks the newer one of equal priority (FCFS kept).
    await serveFully("Doctor 2", p2);
    assert.equal(await doctorOf(p1), "Doctor 2");
    assert.equal(await doctorOf(newer), null);
    assert.equal((await history(p1)).at(-1).reason, "round_robin_reassignment");
    assert.equal((await patient(p1)).created_at, before.created_at);

    // Unexpected disconnection: no logout, the heartbeat simply stops.
    await goStale("Doctor 3");
    await sweep();
    assert.equal(await doctorOf(p3), null);
    assert.equal((await history(p3)).at(-1).reason, "doctor_unavailable");
    await assertConsistent();
  });

  // ---- D ----------------------------------------------------------------------------------
  test("D: an active consultation is never moved automatically; staff are told once and may transfer it", async () => {
    const p1 = await visit("D-1", { minutesAgo: 10 });
    const p2 = await visit("D-2", { minutesAgo: 5 });
    await signIn("Doctor 1");
    await sweep();
    assert.equal((await call("Doctor 1", p1)).status, 200);
    assert.equal((await start("Doctor 1", p1)).status, 200);
    const active = await patient(p1);

    await goStale("Doctor 1");
    await sweep();
    await sweep();
    const still = await patient(p1);
    assert.equal(still.status, "serving");
    assert.equal(still.counter_id, "Doctor 1");
    assert.equal(still.consultation_started_at, active.consultation_started_at);
    assert.equal((await counters())["Doctor 1"], p1);
    assert.equal((await history(p1)).filter((row) => row.reason === "intervention_required").length, 1, "notified once");
    const view = await overview();
    assert.deepEqual(view.dispatch.interventions.map((row) => [row.patient_id, row.doctor]), [[p1, "Doctor 1"]]);

    // A doctor cannot transfer; Frontdesk can, only to a signed-in free doctor.
    await signIn("Doctor 2");
    assert.equal(await doctorOf(p2), "Doctor 2", "Doctor 2 received the waiting visit on sign-in");
    const byDoctor = await h.request("POST", "/queue/transfer", { token: tokens.admin2, body: { patient_id: p1, doctor: "Doctor 2" } });
    assert.equal(byDoctor.status, 403);
    const toOffline = await h.request("POST", "/queue/transfer", { token: tokens.frontdesk, body: { patient_id: p1, doctor: "Doctor 3" } });
    assert.equal(toOffline.status, 400);
    const moved = await h.request("POST", "/queue/transfer", { token: tokens.frontdesk, body: { patient_id: p1, doctor: "Doctor 2" } });
    assert.equal(moved.status, 200, moved.body.message);
    const transferred = await patient(p1);
    assert.equal(transferred.counter_id, "Doctor 2");
    assert.equal(transferred.consultation_started_at, active.consultation_started_at, "consultation record preserved");
    assert.equal(transferred.called_at, active.called_at);
    assert.deepEqual(await counters(), { "Doctor 1": null, "Doctor 2": p1, "Doctor 3": null });
    // Doctor 2's pending visit went back to the shared queue (it is busy now), rank kept.
    assert.equal(await doctorOf(p2), null);
    assert.deepEqual((await history(p2)).map((row) => row.reason), ["round_robin_assignment", "released_for_transfer"]);
    // The previous doctor can no longer manage it; the new one completes it.
    assert.equal((await complete("Doctor 1", p1)).status, 403);
    assert.equal((await complete("Doctor 2", p1)).status, 200);
    await assertConsistent();
  });

  test("D: a consultation is not transferred while its doctor is still signed in", async () => {
    const p1 = await visit("D2-1");
    await signIn("Doctor 1");
    await sweep();
    await call("Doctor 1", p1);
    await signIn("Doctor 2");
    const response = await h.request("POST", "/queue/transfer", { token: tokens.superadmin, body: { patient_id: p1, doctor: "Doctor 2" } });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /still signed in/);
    assert.equal(await doctorOf(p1), "Doctor 1");
  });

  // ---- E ----------------------------------------------------------------------------------
  test("E: a doctor who signs back in rejoins the rotation; rankings are unchanged", async () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await visit(`E-${i}`, { priority: i === 3 ? 3 : 1, minutesAgo: 10 - i }));
    const ranksBefore = (await db.query("SELECT id, priority_score, created_at FROM public.patients ORDER BY id")).rows;
    await signIn("Doctor 2");
    await signIn("Doctor 3");
    assert.deepEqual([await doctorOf(ids[3]), await doctorOf(ids[0])], ["Doctor 2", "Doctor 3"]);
    await signIn("Doctor 1");
    assert.equal(await doctorOf(ids[1]), "Doctor 1", "next-ranked visit goes to the returning doctor");
    assert.deepEqual((await db.query("SELECT id, priority_score, created_at FROM public.patients ORDER BY id")).rows, ranksBefore);
  });

  // ---- F ----------------------------------------------------------------------------------
  test("F: with every doctor signed out, registrations wait in the shared queue and Frontdesk is told", async () => {
    const registered = await h.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: "Waiting Patient", service_type: "consultation" } });
    assert.equal(registered.status, 200, registered.body.message);
    assert.equal(registered.body.assigned_doctor, null);
    await sweep();
    const view = await overview();
    assert.equal(view.dispatch.all_unavailable, true);
    assert.ok(view.dispatch.doctors.every((doctor) => doctor.signed_in === false));
    assert.ok(view.patients.every((row) => row.counter_id == null));
    assert.deepEqual(await history(), []);
  });

  // ---- G ----------------------------------------------------------------------------------
  test("G: simultaneous dispatches, registrations and sign-ins never double-assign", async () => {
    for (let i = 0; i < 6; i += 1) await visit(`G-${i}`, { minutesAgo: 20 - i });
    const other = backend();   // a second backend instance sharing the database
    await Promise.all([
      signIn("Doctor 1"), signIn("Doctor 2", other), signIn("Doctor 3"),
      sweep(), sweep(other), sweep(), sweep(other),
      h.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: "G Walk In", service_type: "checkup" } }),
      db.query("SELECT public.dispatch_round_robin(now() - interval '1 day', now() + interval '1 day', now(), false)")
    ]);
    await sweep();
    await assertConsistent();
    const assignments = await history();
    const perPatient = new Map();
    for (const row of assignments.filter((r) => r.new_doctor)) perPatient.set(row.new_doctor + row.reason, (perPatient.get(row.new_doctor + row.reason) || 0) + 1);
    const pending = (await db.query("SELECT counter_id FROM public.patients WHERE status = 'waiting' AND counter_id IS NOT NULL ORDER BY counter_id")).rows;
    assert.deepEqual(pending.map((row) => row.counter_id), ["Doctor 1", "Doctor 2", "Doctor 3"]);
    assert.equal(assignments.filter((row) => row.new_doctor).length, 3, "exactly one assignment per doctor");
    // Two doctors calling at once: each gets only its own visit.
    const own = Object.fromEntries((await db.query("SELECT counter_id, id FROM public.patients WHERE status = 'waiting' AND counter_id IS NOT NULL")).rows
      .map((row) => [row.counter_id, Number(row.id)]));
    const results = await Promise.all([call("Doctor 1", own["Doctor 1"]), call("Doctor 2", own["Doctor 1"]), call("Doctor 2", own["Doctor 2"])]);
    assert.deepEqual(results.map((r) => r.status), [200, 403, 200]);
    await assertConsistent();
  });

  // ---- H ----------------------------------------------------------------------------------
  test("H: fairness - WPS order, FCFS for equal priority, and reassignment never resets a visit's place", async () => {
    const oldRegular = await visit("H-OLD", { minutesAgo: 30 });
    const pwd = await visit("H-PWD", { priority: 3, minutesAgo: 1 });
    const newRegular = await visit("H-NEW", { minutesAgo: 0 });
    await signIn("Doctor 1");
    assert.equal(await doctorOf(pwd), "Doctor 1", "plain WPS: the PWD visit first");
    await signOut("Doctor 1");
    assert.equal(await doctorOf(pwd), null);
    await signIn("Doctor 2");
    assert.equal(await doctorOf(pwd), "Doctor 2", "the released PWD visit keeps its rank");
    await serveFully("Doctor 2", pwd);
    assert.equal(await doctorOf(oldRegular), "Doctor 2", "the older Regular visit is not placed behind the newer one");
    assert.equal(await doctorOf(newRegular), null);
  });

  test("H: with WPS-A aging on, an aged Regular visit gains up to +2 and a protected category still wins a tie", async () => {
    const aged = backend({ envOverrides: { wpsAging: true } });
    const oldRegular = await visit("HA-OLD", { minutesAgo: 30 });        // 1 + 2 = 3
    const solo = await visit("HA-SOLO", { priority: 2, minutesAgo: 1 }); // 2 + 0 = 2
    const pwd = await visit("HA-PWD", { priority: 3, minutesAgo: 0 });   // 3 + 0 = 3, wins the tie
    await signIn("Doctor 1", aged);
    await signIn("Doctor 2", aged);
    await signIn("Doctor 3", aged);
    await sweep(aged);
    assert.deepEqual([await doctorOf(pwd), await doctorOf(oldRegular), await doctorOf(solo)], ["Doctor 1", "Doctor 2", "Doctor 3"]);
  });

  // ---- I ----------------------------------------------------------------------------------
  test("I: a doctor who signs out while a dispatch is being requested is never assigned", async () => {
    const p1 = await visit("I-1");
    await signIn("Doctor 1");
    await signIn("Doctor 2");
    await db.exec("DELETE FROM public.patient_assignment_history; UPDATE public.patients SET counter_id = NULL;");
    // Doctor 1 would be next in rotation; its session is revoked just before the dispatcher runs.
    await db.query("UPDATE public.doctor_rotation_state SET last_doctor = 'Doctor 3'");
    const racing = backend({
      onRequest: async (request) => {
        if (request.kind === "rpc" && request.name === "dispatch_round_robin") {
          await db.query("UPDATE public.staff_auth_sessions SET revoked_at = clock_timestamp() WHERE user_id_num = 'admin1'");
        }
      }
    });
    await sweep(racing);
    assert.equal(await doctorOf(p1), "Doctor 2");
    // And a doctor whose pending visit was released before its Call cannot call it.
    await goStale("Doctor 2");
    await sweep();
    const refused = await call("Doctor 2", p1);
    assert.equal(refused.status, 403);
    assert.equal((await patient(p1)).status, "waiting");
    await assertConsistent();
  });

  // ---- J ----------------------------------------------------------------------------------
  test("J: the previous doctor's stale Call or Accept is refused after reassignment; one announcement only", async () => {
    const p1 = await visit("J-1");
    await signIn("Doctor 1");
    assert.equal(await doctorOf(p1), "Doctor 1");
    const staleRevision = (await patient(p1)).visit_state_revision;
    await goStale("Doctor 1");
    await signIn("Doctor 2");
    assert.equal(await doctorOf(p1), "Doctor 2");
    assert.notEqual((await patient(p1)).visit_state_revision, staleRevision);
    // Doctor 1's token is still a valid session (only its heartbeat stopped): it is refused anyway.
    assert.equal((await call("Doctor 1", p1)).status, 403);
    assert.equal((await h.request("POST", "/queue/accept", { token: tokens.admin1, body: { patient_id: p1 } })).status, 400);
    assert.equal((await call("Doctor 2", p1)).status, 200);
    assert.equal((await h.request("POST", "/queue/accept", { token: tokens.admin1, body: { patient_id: p1 } })).status, 403);
    const announcements = h.settings.getVoiceAnnouncementEvents().filter((event) => Number(event.patient_id) === p1);
    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].counter_name, "Doctor 2");
  });

  // ---- Roles, services, history security ---------------------------------------------------
  test("only the assigned doctor calls; Super Admin and Frontdesk are refused without any change", async () => {
    const p1 = await visit("R-1");
    await signIn("Doctor 1");
    const before = await patient(p1);
    for (const token of [tokens.superadmin, tokens.frontdesk]) {
      const response = await h.request("POST", "/queue/call", { token, body: { patient_id: p1, counterId: "Doctor 1" } });
      assert.equal(response.status, 403);
    }
    assert.deepEqual(await patient(p1), before);
  });

  test("services outside the approved shared list are refused at registration and never dispatched", async () => {
    await signIn("Doctor 1");
    const response = await h.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: "Nutrition Patient", service_type: "nutrition" } });
    assert.equal(response.status, 400);
    const direct = await visit("S-NUT", { service: "nutrition" });
    await sweep();
    assert.equal(await doctorOf(direct), null);
  });

  test("history, rotation and dispatch functions are closed to the browser roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["patient_assignment_history", "doctor_rotation_state"]) {
        assert.equal((await db.query("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, `public.${table}`])).rows[0].ok, false);
      }
      for (const fn of ["dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)", "call_patient_visit_rr(bigint,text,text,uuid)",
        "transfer_active_consultation(bigint,text,text,uuid,timestamptz,timestamptz)", "get_round_robin_dispatch_status(timestamptz,timestamptz)"]) {
        assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${fn}`])).rows[0].ok, false, fn);
      }
    }
  });
  // ---- Shared service coverage: the service never chooses the doctor -----------------------
  const APPROVED = ["consultation", "checkup", "prenatal", "maternity", "family_planning"];
  const UNAPPROVED = ["medical_consultation", "maternal_healthcare", "child_healthcare", "dental_healthcare", "nutrition",
    "diagnostic_imaging", "womens_health", "mental_healthcare", "medical_documentation", "marriage_preparation",
    "environmental_health", "food_safety", "laboratory", "dental", "obgyne"];
  async function resetQueue() {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL, is_online = true; DELETE FROM public.patients;
      DELETE FROM public.patient_assignment_history; DELETE FROM public.staff_auth_sessions WHERE user_id_num LIKE 'admin%';
      UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL;`);
  }

  test("P: the database and the backend use the same approved-service list", async () => {
    const { rows: [row] } = await db.query("SELECT public.qms_rr_approved_services() AS list");
    assert.deepEqual(row.list, [...h.queue.APPROVED_GENERAL_SERVICES]);
    assert.deepEqual(row.list, APPROVED);
  });

  test("A-D, P: every approved service can be assigned to Doctor 1, Doctor 2 and Doctor 3", async () => {
    const received = {};
    for (const service of APPROVED) {
      await resetQueue();
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push(await visit(`${service}-${i}`, { service, minutesAgo: 3 - i }));
      for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) await signIn(doctor);
      await sweep();
      received[service] = [];
      for (const id of ids) received[service].push(await doctorOf(id));
      // The visit is called by whoever received it, whatever its service.
      for (const [index, doctor] of ["Doctor 1", "Doctor 2", "Doctor 3"].entries()) {
        assert.equal((await call(doctor, ids[index])).status, 200, `${doctor} calls ${service}`);
      }
      await assertConsistent();
    }
    for (const service of APPROVED) assert.deepEqual(received[service], ["Doctor 1", "Doctor 2", "Doctor 3"], service);
  });

  for (const offline of ["Doctor 1", "Doctor 2", "Doctor 3"]) {
    test(`E-G: with ${offline} offline the other two doctors share the visits`, async () => {
      const online = ["Doctor 1", "Doctor 2", "Doctor 3"].filter((doctor) => doctor !== offline);
      const ids = [];
      for (let i = 0; i < 4; i += 1) ids.push(await visit(`OFF-${offline.slice(-1)}-${i}`, { service: APPROVED[i], minutesAgo: 10 - i }));
      for (const doctor of online) await signIn(doctor);
      await sweep();
      assert.deepEqual([await doctorOf(ids[0]), await doctorOf(ids[1])].sort(), online);
      await serveFully(await doctorOf(ids[0]), ids[0]);
      await serveFully(await doctorOf(ids[1]), ids[1]);
      const next = [await doctorOf(ids[2]), await doctorOf(ids[3])];
      assert.deepEqual([...next].sort(), online);
      assert.ok(!(await history()).some((row) => row.new_doctor === offline), `${offline} never receives a visit`);
    });
  }

  test("H: with only one doctor available, that doctor receives each next visit in turn", async () => {
    const first = await visit("ONE-1", { service: "maternity", minutesAgo: 5 });
    const second = await visit("ONE-2", { service: "checkup", minutesAgo: 4 });
    await signIn("Doctor 3");
    assert.deepEqual([await doctorOf(first), await doctorOf(second)], ["Doctor 3", null]);
    await serveFully("Doctor 3", first);
    assert.equal(await doctorOf(second), "Doctor 3");
  });

  test("Q: unapproved services are refused at registration, never dispatched and never callable", async () => {
    await signIn("Doctor 1");
    for (const service of UNAPPROVED) {
      const response = await h.request("POST", "/queue", { token: tokens.frontdesk, body: { fullName: `Q ${service}`, service_type: service } });
      assert.equal(response.status, 400, service);
    }
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.patients")).rows[0].n), 0);
    const direct = await visit("Q-DIRECT", { service: "nutrition" });
    await sweep();
    assert.equal(await doctorOf(direct), null, "the dispatcher skips it");
    await db.query("UPDATE public.patients SET counter_id = 'Doctor 1' WHERE id = $1", [direct]);
    const called = await call("Doctor 1", direct);
    assert.equal(called.status, 400);
    assert.equal((await patient(direct)).status, "waiting");
  });

  // ---- L/M: one owner at a time --------------------------------------------------------------
  test("L: two doctors calling the same patient at once: only the assigned doctor succeeds", async () => {
    const p1 = await visit("L-1");
    await signIn("Doctor 1");
    await signIn("Doctor 2");
    const owner = await doctorOf(p1);
    const other = owner === "Doctor 1" ? "Doctor 2" : "Doctor 1";
    const results = await Promise.all([call(other, p1), call(owner, p1), call(other, p1)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403, 403]);
    assert.equal((await patient(p1)).counter_id, owner);
    await assertConsistent();
  });

  test("L: two staff transfers of one consultation at once: exactly one wins", async () => {
    const p1 = await visit("LT-1");
    await signIn("Doctor 1");
    await call("Doctor 1", p1);
    await goStale("Doctor 1");
    await signIn("Doctor 2");
    await signIn("Doctor 3");
    const results = await Promise.all([
      h.request("POST", "/queue/transfer", { token: tokens.frontdesk, body: { patient_id: p1, doctor: "Doctor 2" } }),
      h.request("POST", "/queue/transfer", { token: tokens.superadmin, body: { patient_id: p1, doctor: "Doctor 3" } })
    ]);
    assert.deepEqual(results.map((r) => r.status === 200).filter(Boolean).length, 1, JSON.stringify(results.map((r) => r.body.message)));
    const winner = (await patient(p1)).counter_id;
    assert.ok(["Doctor 2", "Doctor 3"].includes(winner));
    assert.equal((await counters())[winner], p1);
    await assertConsistent();
  });

  test("M: after a transfer of a called, unstarted visit, only the new doctor may Accept, then Start", async () => {
    const p1 = await visit("M-1");
    await signIn("Doctor 1");
    await call("Doctor 1", p1);
    await goStale("Doctor 1");
    await signIn("Doctor 2");
    assert.equal((await h.request("POST", "/queue/transfer", { token: tokens.frontdesk, body: { patient_id: p1, doctor: "Doctor 2" } })).status, 200);
    const accept = (doctor) => h.request("POST", "/queue/accept", { token: tokens[DOCTOR_ACCOUNT[doctor]], body: { patient_id: p1 } });
    assert.equal((await start("Doctor 2", p1)).status, 400, "the previous doctor's acceptance does not carry over");
    assert.equal((await accept("Doctor 1")).status, 403, "the previous doctor's stale acceptance is refused");
    assert.equal((await start("Doctor 1", p1)).status, 403);
    assert.equal((await accept("Doctor 2")).status, 200);
    assert.equal((await start("Doctor 2", p1)).status, 200);
    const voice = h.settings.getVoiceAnnouncementEvents().filter((event) => Number(event.patient_id) === p1);
    assert.equal(voice.length, 1, "the transfer and the new Accept add no second announcement");
  });

  test("R: the database refuses a second counter on a visit and a second serving visit for a doctor", async () => {
    const p1 = await visit("U-1");
    const p2 = await visit("U-2");
    await signIn("Doctor 1");
    await call("Doctor 1", await doctorOf(p1) === "Doctor 1" ? p1 : p2);
    const serving = Number((await db.query("SELECT id FROM public.patients WHERE status = 'serving'")).rows[0].id);
    await assert.rejects(db.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = 'Doctor 2'", [serving]),
      (error) => error.code === "23505");
    const waitingId = serving === p1 ? p2 : p1;
    await assert.rejects(db.query("UPDATE public.patients SET status = 'serving', counter_id = 'Doctor 1', called_at = now() WHERE id = $1", [waitingId]),
      (error) => error.code === "23505");
    await assertConsistent();
  });

  test("N: with WPS-A on, a released visit keeps its aged rank and registration time", async () => {
    const aged = backend({ envOverrides: { wpsAging: true } });
    const oldRegular = await visit("NA-OLD", { minutesAgo: 30 });          // 1 + 2 = 3
    const solo = await visit("NA-SOLO", { priority: 2, minutesAgo: 0 });   // 2
    await signIn("Doctor 1", aged);
    await sweep(aged);
    assert.equal(await doctorOf(oldRegular), "Doctor 1");
    const before = await patient(oldRegular);
    await aged.request("POST", "/auth/logout", { token: tokens.admin1 });
    assert.equal(await doctorOf(oldRegular), null);
    await signIn("Doctor 2", aged);
    assert.equal(await doctorOf(oldRegular), "Doctor 2", "still ahead of the newer priority-2 visit");
    assert.equal(await doctorOf(solo), null);
    const after = await patient(oldRegular);
    for (const key of ["created_at", "priority_score", "vulnerability_flags"]) assert.deepEqual(after[key], before[key], key);
  });
});


describe("RR1 without its database functions fails closed (isolated PGlite)", { skip: unavailable }, () => {
  test("registration still queues the visit; nothing is assigned; Call refuses with nothing changed", async () => {
    const db = await freshDatabase({ withRr1: false });
    try {
      await db.exec("INSERT INTO public.counters (id_num) VALUES ('Doctor 1'), ('Doctor 2'), ('Doctor 3')");
      const h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, { doctorDispatchMode: "round_robin" });
      const frontdesk = (await h.login("frontdesk", password("frontdesk"))).token;
      const doctor = (await h.login("admin1", password("admin1"))).token;
      const registered = await h.request("POST", "/queue", { token: frontdesk, body: { fullName: "No RR1", service_type: "consultation" } });
      assert.equal(registered.status, 200, registered.body.message);
      assert.equal(registered.body.assigned_doctor, null);
      const view = (await h.request("GET", "/queue", { token: frontdesk })).body;
      assert.equal(view.dispatch.available, false);
      assert.match(view.dispatch.error, /20261109-rr1-round-robin-dispatch\.sql/);
      const [row] = view.patients;
      await db.query("UPDATE public.patients SET counter_id = 'Doctor 1' WHERE id = $1", [row.id]);
      const before = (await db.query("SELECT row_to_json(p) AS v FROM public.patients p")).rows;
      const called = await h.request("POST", "/queue/call", { token: doctor, body: { patient_id: row.id } });
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
      const added = ["call_patient_visit_rr", "dispatch_round_robin", "get_round_robin_dispatch_status", "qms_rr_approved_services", "qms_rr_doctor_state", "transfer_active_consultation"];
      assert.deepEqual(fnAfter.filter((row) => !added.some((name) => row.f.startsWith(`${name}(`))), fnBefore, "no existing function changed");
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
