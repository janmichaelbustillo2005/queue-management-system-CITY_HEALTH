// Actual SQL runs only in a fresh in-memory PGlite database. No .env, Supabase
// connection, real patient data, or live database mutation is used.
// PGlite has one connection: queued requests below do not prove independent-
// session PostgreSQL contention or lock scheduling.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test, before, beforeEach, after } = require("node:test");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");
const { basePostgresSchema } = require("./helpers/postgresSchema");

let PGlite;
let unavailable;
try {
  ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional PGlite is not installed; see docs/phase2-consultation.md for the isolated SQL harness.";
}

describe("Phase 2.1 PostgreSQL stale Requeue/Undo protection", { skip: unavailable }, () => {
  let db;
  const migration = fs.readFileSync(path.join(__dirname, "../scripts/20261012-phase21-stale-recovery.sql"), "utf8");
  const verification = fs.readFileSync(path.join(__dirname, "../scripts/20261012-phase21-verify.sql"), "utf8");
  const lifecycleMigration = fs.readFileSync(path.join(__dirname, "../scripts/20261010-phase2-consultation-lifecycle.sql"), "utf8");
  const recoverySignature = "public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)";

  before(async () => {
    db = await PGlite.create();
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(basePostgresSchema);
    await db.exec(lifecycleMigration);
    await db.exec("ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY; ALTER TABLE public.counters ENABLE ROW LEVEL SECURITY; ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;");
    await db.exec(migration);
  });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    // The truncated tables exist only inside this test's in-memory database.
    await db.exec(`
      TRUNCATE public.counters, public.patients, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
        ('admin1', 'test-only', 'admin', 'Doctor 1'),
        ('admin2', 'test-only', 'admin', 'Doctor 2'),
        ('admin3', 'test-only', 'admin', 'Doctor 3'),
        ('frontdesk', 'test-only', 'admin', NULL),
        ('superadmin', 'test-only', 'superadmin', NULL);
      INSERT INTO public.patients (id_num, first_name, last_name, mobile_number,
          queue_number, service_type, status, counter_id, created_at, called_at, completed_at, reason) VALUES
        ('isolated-legacy', 'Test', 'Legacy', '000', 'GP-001', 'consultation', 'completed', 'Doctor 1',
          '2000-01-01 00:00:00.111222+00', '2000-01-01 00:00:01.123456+00', '2000-01-01 00:00:02.654321+00', 'Legacy reason'),
        ('isolated-other-two', 'Test', 'Two', '000', 'OB-001', 'prenatal', 'serving', 'Doctor 2',
          '2000-01-01 00:00:00+00', '2000-01-01 00:00:01+00', NULL, NULL),
        ('isolated-other-three', 'Test', 'Three', '000', 'FP-001', 'family_planning', 'serving', 'Doctor 3',
          '2000-01-01 00:00:00+00', '2000-01-01 00:00:01+00', NULL, NULL);
      INSERT INTO public.counters (id_num, is_online, current_patient_id) VALUES
        ('Doctor 1', true, NULL), ('Doctor 2', true, 2), ('Doctor 3', true, 3);
    `);
  });

  // row_to_json retains all PostgreSQL timestamp digits, as Supabase does.
  // A driver Date or Date.toISOString() here would hide lossy CAS arguments.
  const patient = async (id = 1) =>
    (await db.query("SELECT row_to_json(p) AS value FROM public.patients AS p WHERE id = $1", [id])).rows[0]?.value;
  const counters = async () =>
    (await db.query("SELECT row_to_json(c) AS value FROM public.counters AS c ORDER BY id", [])).rows.map(row => row.value);
  const snapshot = async () => ({ patient: await patient(), counters: await counters() });
  const argsFor = (expected, action = "requeue", user = "frontdesk", reason = null) => ({
    p_patient_id: expected.id,
    p_action: action,
    p_user_id_num: user,
    p_expected_revision: expected.visit_state_revision,
    p_expected_status: expected.status,
    p_expected_created_at: expected.created_at,
    p_expected_called_at: expected.called_at,
    p_expected_started_at: expected.consultation_started_at,
    p_expected_completed_at: expected.completed_at,
    p_expected_counter_id: expected.counter_id,
    p_reason: reason
  });
  async function invokeNamed(name, args) {
    const entries = Object.entries(args);
    const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(", ");
    return (await db.query(`SELECT row_to_json(p) AS value FROM public.${name}(${parameters}) AS p`, entries.map(([, value]) => value))).rows[0].value;
  }
  const recover = (expected, action = "requeue", user = "frontdesk", reason = null) =>
    invokeNamed("recover_patient_visit", argsFor(expected, action, user, reason));
  const duration = async () =>
    (await db.query("SELECT EXTRACT(EPOCH FROM completed_at - consultation_started_at)::text AS seconds FROM public.patients WHERE id = 1")).rows[0].seconds;
  const conflict = (error) => error.code === "40001";

  async function finishNewConsultation() {
    await recover(await patient());
    // Prepare the called-state fixture for the existing real Start/Complete
    // RPCs. This helper does not claim to execute Call's separate SQL writes.
    await db.exec(`UPDATE public.patients SET status = 'serving', counter_id = 'Doctor 1',
      called_at = clock_timestamp() - interval '1 second' WHERE id = 1;
      UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1';`);
    const acceptedAt = (await db.query("SELECT clock_timestamp()::text AS time")).rows[0].time;
    await invokeNamed("start_patient_consultation", {
      p_patient_id: 1, p_doctor_name: "Doctor 1", p_user_id_num: "admin1", p_accepted_at: acceptedAt
    });
    const started = await patient();
    await db.exec("SELECT pg_sleep(0.005)");
    await invokeNamed("complete_patient_consultation", {
      p_patient_id: 1, p_doctor_name: "Doctor 1", p_user_id_num: "admin1",
      p_expected_started_at: started.consultation_started_at, p_reason: "Actual completed consultation"
    });
  }

  async function serviceHarness(beforeRpc) {
    const database = createDatabase();
    async function refreshReads() {
      for (const table of ["patients", "counters", "users"]) {
        database[table] = (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} AS r`)).rows.map(row => row.value);
      }
    }
    await refreshReads();
    const h = createHarness({
      database,
      clock: { now: Date.now() },
      rpc: async (name, args) => {
        database.calls.push({ action: "rpc", function: name, args: clone(args) });
        assert.ok(["recover_patient_visit", "undo_patient_visit_waiting"].includes(name));
        assert.ok(Object.keys(args).every(key => Object.hasOwn(argsFor(database.patients[0]), key)));
        if (beforeRpc) await beforeRpc(name, args);
        try {
          // Use exactly the backend's named payload, never supply missing args
          // on its behalf. SQL resolves the real deployed function contract.
          const data = await invokeNamed(name, args);
          await refreshReads();
          return { data, error: null };
        } catch (error) {
          return { data: null, error: { code: error.code, message: error.message } };
        }
      }
    });
    return { ...h, refreshReads };
  }

  test("repeatable metadata migration preserves history, revisions, counter data and RLS", async () => {
    const before = await snapshot();
    const rlsBefore = (await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE oid IN ('public.patients'::regclass, 'public.counters'::regclass, 'public.users'::regclass) ORDER BY relname")).rows;
    await db.exec(migration);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE oid IN ('public.patients'::regclass, 'public.counters'::regclass, 'public.users'::regclass) ORDER BY relname")).rows, rlsBefore);
    assert.ok(rlsBefore.every(row => row.relrowsecurity));
    const column = (await db.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'visit_state_revision'")).rows[0];
    assert.deepEqual(column, { data_type: "uuid", is_nullable: "NO" });
  });

  test("first migration application adds only revision metadata to existing completed history", async () => {
    const upgrade = await PGlite.create();
    try {
      await upgrade.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      await upgrade.exec(basePostgresSchema);
      await upgrade.exec(lifecycleMigration);
      await upgrade.exec(`INSERT INTO public.patients (id_num, first_name, last_name, mobile_number,
        queue_number, service_type, status, counter_id, created_at, called_at, consultation_started_at, completed_at) VALUES
        ('isolated-existing-legacy', 'Existing', 'Legacy', '000', 'GP-001', 'consultation', 'completed', 'Doctor 1',
          '2000-01-01 00:00:00.111222+00', '2000-01-01 00:00:01.123456+00', NULL, '2000-01-01 00:00:05.654321+00'),
        ('isolated-existing-completed', 'Existing', 'Completed', '000', 'GP-002', 'consultation', 'completed', 'Doctor 1',
          '2000-01-01 00:00:00.111222+00', '2000-01-01 00:00:01.123456+00', '2000-01-01 00:00:02.223456+00', '2000-01-01 00:00:05.654321+00');`);
      const before = (await upgrade.query("SELECT row_to_json(p) AS value FROM public.patients p ORDER BY id")).rows.map(row => row.value);
      await upgrade.exec(migration);
      const after = (await upgrade.query("SELECT row_to_json(p) AS value FROM public.patients p ORDER BY id")).rows.map(row => row.value);
      assert.deepEqual(after.map(({ visit_state_revision, ...record }) => record), before);
      assert.ok(after.every(row => /^[0-9a-f-]{36}$/.test(row.visit_state_revision)));
      assert.notEqual(after[0].visit_state_revision, after[1].visit_state_revision);
      assert.equal((await upgrade.query("SELECT EXTRACT(EPOCH FROM completed_at - consultation_started_at)::text AS seconds FROM public.patients WHERE id = 2")).rows[0].seconds, "3.430865");
    } finally {
      await upgrade.close();
    }
  });

  test("read-only installation verification reports eight failures when Phase 2.1 is missing", async () => {
    const uninstalled = await PGlite.create();
    try {
      await uninstalled.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      await uninstalled.exec(basePostgresSchema);
      await uninstalled.exec(lifecycleMigration);
      const results = await uninstalled.exec(verification);
      const checks = results.find(result => result.rows.some(row => Object.hasOwn(row, "check_name")))?.rows;
      assert.equal(checks?.length, 8);
      assert.ok(checks.every(row => row.result === "FAIL" && row.all_pass === false));
      assert.equal((await uninstalled.query("SELECT to_regprocedure($1) AS installed", [recoverySignature])).rows[0].installed, null);
    } finally {
      await uninstalled.close();
    }
  });

  test("read-only installation verification reports eight passes without changing installed data", async () => {
    const before = await snapshot();
    const results = await db.exec(verification);
    const checks = results.find(result => result.rows.some(row => Object.hasOwn(row, "check_name")))?.rows;
    assert.equal(checks?.length, 8);
    assert.ok(checks.every(row => row.result === "PASS" && row.all_pass === true));
    assert.deepEqual(await snapshot(), before);
  });

  test("incompatible existing revision metadata fails migration cleanly and retains all patient history", async () => {
    const incompatible = await PGlite.create();
    try {
      await incompatible.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      await incompatible.exec(basePostgresSchema);
      await incompatible.exec(lifecycleMigration);
      await incompatible.exec(`INSERT INTO public.patients (id_num, first_name, last_name, mobile_number,
        queue_number, service_type, status, consultation_started_at, completed_at) VALUES
        ('isolated-incompatible', 'Existing', 'History', '000', 'GP-001', 'consultation', 'completed',
          '2000-01-01 00:00:02.223456+00', '2000-01-01 00:00:05.654321+00');`);
      for (const definition of [
        "TEXT NOT NULL DEFAULT 'existing-metadata'",
        "UUID DEFAULT pg_catalog.gen_random_uuid()",
        "UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid"
      ]) {
        await incompatible.exec(`ALTER TABLE public.patients ADD COLUMN visit_state_revision ${definition}`);
        const before = (await incompatible.query("SELECT row_to_json(p) AS value FROM public.patients p ORDER BY id")).rows;
        const metadataBefore = (await incompatible.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'visit_state_revision'")).rows;
        await assert.rejects(incompatible.exec(migration), /Existing visit_state_revision must be a non-null UUID with gen_random_uuid\(\) default/);
        // The migration is deliberately transactional. Clear its failed
        // transaction before proving no installation/history changes survived.
        await incompatible.exec("ROLLBACK");
        assert.deepEqual((await incompatible.query("SELECT row_to_json(p) AS value FROM public.patients p ORDER BY id")).rows, before);
        assert.deepEqual((await incompatible.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'visit_state_revision'")).rows, metadataBefore);
        assert.equal((await incompatible.query("SELECT to_regprocedure($1) AS installed", [recoverySignature])).rows[0].installed, null);
        assert.equal((await incompatible.query("SELECT count(*) AS count FROM pg_trigger WHERE tgrelid = 'public.patients'::regclass AND tgname = 'patients_rotate_visit_revision'")).rows[0].count, 0);
        await incompatible.exec("ALTER TABLE public.patients DROP COLUMN visit_state_revision");
      }
    } finally {
      await incompatible.close();
    }
  });

  test("revision rotates for every actual write, including same-value and unrelated-field writes", async () => {
    let previous = (await patient()).visit_state_revision;
    for (const assignment of ["status = status", "reason = 'Changed reason'", "consultation_started_at = consultation_started_at", "visit_state_revision = visit_state_revision"]) {
      await db.exec(`UPDATE public.patients SET ${assignment} WHERE id = 1`);
      const next = (await patient()).visit_state_revision;
      assert.notEqual(next, previous, assignment);
      previous = next;
    }
    assert.equal((await patient()).consultation_started_at, null);
  });

  for (const action of ["requeue", "undo"]) {
    test(`${action} rejects a same-status, identical-timestamp ABA visit using the database revision`, async () => {
      await db.exec("UPDATE public.patients SET status = 'cancelled' WHERE id = 1");
      const stale = await patient();
      await db.exec("UPDATE public.patients SET status = 'waiting' WHERE id = 1; UPDATE public.patients SET status = 'cancelled' WHERE id = 1;");
      const current = await patient();
      assert.deepEqual({ ...current, visit_state_revision: stale.visit_state_revision }, stale);
      const before = await snapshot();
      await assert.rejects(recover(stale, action), conflict);
      assert.deepEqual(await snapshot(), before);
    });

    test(`delayed ${action} cannot erase a later completed consultation or its exact duration`, async () => {
      const stale = await patient();
      await finishNewConsultation();
      const before = await snapshot();
      const savedDuration = await duration();
      assert.equal(before.patient.status, "completed");
      assert.ok(Number(savedDuration) > 0);
      await assert.rejects(recover(stale, action), conflict);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await duration(), savedDuration);
      assert.equal(before.counters[0].current_patient_id, null);
      assert.equal(before.counters[1].current_patient_id, 2);
      assert.equal(before.counters[2].current_patient_id, 3);
    });

    test(`fresh ${action} cannot reset actual completed consultation timestamps`, async () => {
      await finishNewConsultation();
      const before = await snapshot();
      await assert.rejects(recover(before.patient, action), /history must be preserved|completed consultation/i);
      assert.deepEqual(await snapshot(), before);
    });

    test(`backend ${action} sends trusted named payload and respects the installed migration version`, async () => {
      const before = await patient();
      const stateBefore = await snapshot();
      const h = await serviceHarness();
      const response = await h.request("POST", `/queue/${action}`, { patient_id: 1, reason: "Recovery note",
        p_expected_revision: "00000000-0000-0000-0000-000000000000", p_expected_started_at: "1990-01-01T00:00:00Z" });
      assert.equal(response.status, action === "undo" ? 503 : 200, response.body.message);
      const rpc = h.database.calls.find(entry => entry.function === (action === "undo" ? "undo_patient_visit_waiting" : "recover_patient_visit"));
      const expectedArgs = argsFor(before, action, "frontdesk", action === "requeue" ? "Recovery note" : null);
      // The optional reason may be omitted by Undo; every required attestation
      // must be the trusted server-read value, including full timestamp digits.
      for (const [key, value] of Object.entries(expectedArgs)) {
        if (key === "p_reason" && action === "undo" && !Object.hasOwn(rpc.args, key)) continue;
        assert.equal(rpc.args[key], value, key);
      }
      if (action === "undo") {
        // This suite deliberately installs only Phase 2.1. New backend Undo
        // must fail before writing until its Phase 2.2 entry point exists.
        assert.match(response.body.message, /Phase 2\.2 database migration/);
        assert.deepEqual(await snapshot(), stateBefore);
        return;
      }
      assert.equal((await patient()).status, "waiting");
      assert.equal((await patient()).consultation_started_at, null);
      assert.equal((await counters())[0].current_patient_id, null);
    });

    test(`HTTP ${action} paused before SQL preserves newer completion with the installed migration version`, { timeout: 10000 }, async () => {
      let signalEntered;
      let resume;
      const entered = new Promise(resolve => { signalEntered = resolve; });
      const paused = new Promise(resolve => { resume = resolve; });
      const h = await serviceHarness(async () => { signalEntered(); await paused; });
      const pending = h.request("POST", `/queue/${action}`, { patient_id: 1 });
      await entered;
      let before;
      let savedDuration;
      try {
        await finishNewConsultation();
        before = await snapshot();
        savedDuration = await duration();
      } finally {
        resume();
      }
      const response = await pending;
      assert.equal(response.status, action === "undo" ? 503 : 409, response.body.message);
      assert.equal(response.body.success, false);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await duration(), savedDuration);
    });
  }

  for (const [parameter, field] of [
    ["p_expected_created_at", "created_at"], ["p_expected_called_at", "called_at"],
    ["p_expected_started_at", "consultation_started_at"], ["p_expected_completed_at", "completed_at"]
  ]) {
    test(`CAS ${field} compares PostgreSQL microseconds even with the current revision`, async () => {
      if (field === "consultation_started_at") {
        await db.exec("UPDATE public.patients SET status = 'cancelled', consultation_started_at = '2000-01-01 00:00:01.123456+00' WHERE id = 1");
      }
      const expected = await patient();
      const args = argsFor(expected);
      args[parameter] = (await db.query("SELECT ($1::timestamptz + interval '1 microsecond')::text AS time", [expected[field]])).rows[0].time;
      const before = await snapshot();
      await assert.rejects(invokeNamed("recover_patient_visit", args), conflict);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await recover(expected)).status, "waiting");
    });

    test(`CAS ${field} does not treat NULL as a wildcard`, async () => {
      if (field === "consultation_started_at") {
        await db.exec("UPDATE public.patients SET status = 'cancelled', consultation_started_at = '2000-01-01 00:00:01.123456+00' WHERE id = 1");
      }
      const args = argsFor(await patient());
      args[parameter] = null;
      const before = await snapshot();
      await assert.rejects(invokeNamed("recover_patient_visit", args),
        field === "created_at" ? error => error.code === "22023" : conflict);
      assert.deepEqual(await snapshot(), before);
    });
  }

  test("CAS exact counter/status/revision cannot be substituted with equivalent aliases or NULL", async () => {
    const expected = await patient();
    for (const changed of [
      { p_expected_counter_id: "1" }, { p_expected_counter_id: "doctor1" }, { p_expected_counter_id: null },
      { p_expected_status: "cancelled" }, { p_expected_revision: "00000000-0000-0000-0000-000000000000" }
    ]) {
      const before = await snapshot();
      await assert.rejects(invokeNamed("recover_patient_visit", { ...argsFor(expected), ...changed }), conflict);
      assert.deepEqual(await snapshot(), before);
    }
  });

  test("NULL counter and nullable timestamps match only their actual NULL snapshot", async () => {
    await db.exec("UPDATE public.patients SET counter_id = NULL, called_at = NULL, completed_at = NULL, status = 'cancelled' WHERE id = 1");
    const expected = await patient();
    const before = await snapshot();
    for (const changed of [{ p_expected_counter_id: "" }, { p_expected_called_at: "2000-01-01T00:00:00Z" }, { p_expected_completed_at: "2000-01-01T00:00:00Z" }, { p_expected_started_at: "2000-01-01T00:00:00Z" }]) {
      await assert.rejects(invokeNamed("recover_patient_visit", { ...argsFor(expected), ...changed }), conflict);
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal((await recover(expected)).status, "waiting");
  });

  test("normal legacy Requeue resets timing and places the patient after its original priority-tier position", async () => {
    const before = await patient();
    const countersBefore = await counters();
    const result = await recover(before, "requeue", "frontdesk", "Returned to queue");
    assert.equal(result.status, "waiting");
    for (const field of ["called_at", "completed_at", "consultation_started_at", "counter_id"]) assert.equal(result[field], null, field);
    assert.ok(Date.parse(result.created_at) > Date.parse(before.created_at));
    assert.equal(result.reason, "Returned to queue");
    assert.equal(result.priority_score, before.priority_score);
    assert.equal(result.service_type, before.service_type);
    assert.notEqual(result.visit_state_revision, before.visit_state_revision);
    assert.deepEqual(await counters(), countersBefore);
  });

  for (const status of ["completed", "cancelled", "no-show"]) {
    test(`normal ${status} Undo preserves existing fields and first-free-online counter reservation`, async () => {
      await db.query("UPDATE public.patients SET status = $1::public.queue_status WHERE id = 1", [status]);
      if (status !== "completed") await db.exec("UPDATE public.patients SET consultation_started_at = '2000-01-01 00:00:01.223456+00' WHERE id = 1");
      const before = await patient();
      const result = await recover(before, "undo");
      assert.deepEqual({ ...result, status: before.status, completed_at: before.completed_at,
        consultation_started_at: before.consultation_started_at, visit_state_revision: before.visit_state_revision }, before);
      const savedCounters = await counters();
      assert.equal(savedCounters[0].current_patient_id, 1);
      assert.equal(savedCounters[1].current_patient_id, 2);
      assert.equal(savedCounters[2].current_patient_id, 3);
    });

    if (status !== "completed") {
      test(`normal ${status} Requeue remains permitted even after a cancelled consultation started`, async () => {
        await db.query("UPDATE public.patients SET status = $1::public.queue_status, consultation_started_at = '2000-01-01 00:00:01.223456+00' WHERE id = 1", [status]);
        const result = await recover(await patient());
        assert.equal(result.status, "waiting");
        assert.equal(result.consultation_started_at, null);
        assert.equal(result.completed_at, null);
      });
    }
  }

  test("Undo with no online free counter still succeeds without changing occupied counters", async () => {
    await db.exec("UPDATE public.counters SET is_online = false WHERE id_num = 'Doctor 1'");
    const before = await counters();
    assert.equal((await recover(await patient(), "undo")).status, "waiting");
    assert.deepEqual(await counters(), before);
  });

  test("Undo retains the existing first-free counter choice without implementing Phase 2.2 doctor remapping", async () => {
    await db.exec("UPDATE public.patients SET counter_id = 'Doctor 2', service_type = 'prenatal' WHERE id = 1");
    const before = await patient();
    const result = await recover(before, "undo");
    assert.equal(result.counter_id, "Doctor 2");
    assert.equal((await counters())[0].current_patient_id, 1);
    assert.equal((await counters())[1].current_patient_id, 2);
  });

  test("queued duplicate Requeues cannot both overwrite one expected state", async () => {
    const expected = await patient();
    const results = await Promise.allSettled([recover(expected), recover(expected)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "40001");
    assert.deepEqual(await patient(), results.find(result => result.status === "fulfilled").value);
    assert.equal((await counters())[0].current_patient_id, null);
  });

  test("queued competing Undo/Requeue requests have one winner and no losing counter side effect", async () => {
    const expected = await patient();
    const results = await Promise.allSettled([recover(expected, "undo"), recover(expected, "requeue")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "40001");
    assert.deepEqual(await patient(), results.find(result => result.status === "fulfilled").value);
    const savedCounters = await counters();
    assert.equal(savedCounters[0].current_patient_id, results[0].status === "fulfilled" ? 1 : null);
    assert.equal(savedCounters[1].current_patient_id, 2);
    assert.equal(savedCounters[2].current_patient_id, 3);
  });

  for (const mode of ["raise", "suppress"]) {
    test(`Undo counter reservation ${mode} failure rolls back both patient and revision`, async () => {
      const before = await snapshot();
      await db.exec(`CREATE FUNCTION public.phase21_test_counter_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.current_patient_id = 1 THEN ${mode === "raise" ? "RAISE EXCEPTION 'Injected reservation failure';" : "RETURN NULL;"} END IF; RETURN NEW; END $$;
        CREATE TRIGGER phase21_test_counter_failure BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.phase21_test_counter_failure();`);
      try {
        await assert.rejects(recover(before.patient, "undo"), mode === "raise" ? /Injected reservation failure/ : /counter|reserve|assign/i);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await db.exec("DROP TRIGGER phase21_test_counter_failure ON public.counters; DROP FUNCTION public.phase21_test_counter_failure();");
      }
    });
  }

  for (const action of ["requeue", "undo"]) {
    test(`silently suppressed ${action} patient update cannot report success or reserve a counter`, async () => {
      const before = await snapshot();
      await db.exec(`CREATE FUNCTION public.phase21_test_patient_suppressed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status::text = 'waiting' THEN RETURN NULL; END IF; RETURN NEW; END $$;
        CREATE TRIGGER phase21_test_patient_suppressed BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.phase21_test_patient_suppressed();`);
      try {
        await assert.rejects(recover(before.patient, action), /Unable|changed|recover|update/i);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await db.exec("DROP TRIGGER phase21_test_patient_suppressed ON public.patients; DROP FUNCTION public.phase21_test_patient_suppressed();");
      }
    });
  }

  test("recovery rechecks the current database staff identity without restricting existing staff management", async () => {
    const expected = await patient();
    const before = await snapshot();
    await assert.rejects(recover(expected, "requeue", "missing-staff"), error => error.code === "42501");
    assert.deepEqual(await snapshot(), before);
    await db.exec("DELETE FROM public.users WHERE id_num = 'frontdesk'");
    await assert.rejects(recover(expected), error => error.code === "42501");
    assert.deepEqual(await snapshot(), before);
    assert.equal((await recover(expected, "requeue", "superadmin")).status, "waiting");
  });

  test("recovery rejects missing required attestations, invalid actions and missing patients without side effects", async () => {
    const expected = await patient();
    const before = await snapshot();
    for (const changed of [
      { p_patient_id: 0 }, { p_action: "complete" }, { p_expected_revision: null },
      { p_expected_status: null }, { p_expected_created_at: null }
    ]) {
      await assert.rejects(invokeNamed("recover_patient_visit", { ...argsFor(expected), ...changed }), error => error.code === "22023");
      assert.deepEqual(await snapshot(), before);
    }
    await assert.rejects(invokeNamed("recover_patient_visit", { ...argsFor(expected), p_patient_id: 999 }), error => error.code === "P0002");
    assert.deepEqual(await snapshot(), before);
  });

  test("Undo does not change the documented allowed status set", async () => {
    for (const status of ["waiting", "serving"]) {
      await db.query("UPDATE public.patients SET status = $1::public.queue_status WHERE id = 1", [status]);
      const before = await snapshot();
      await assert.rejects(recover(before.patient, "undo"), /Only completed, cancelled, or no-show patients/);
      assert.deepEqual(await snapshot(), before);
    }
  });

  test("RPC security denies browser roles, grants backend-only execution and uses a safe search path", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, recoverySignature])).rows[0].allowed, role === "service_role");
    }
    const security = (await db.query("SELECT prosecdef, proconfig, EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute FROM pg_proc WHERE oid = $1::regprocedure", [recoverySignature])).rows[0];
    assert.equal(security.prosecdef, true);
    assert.ok(security.proconfig.includes('search_path=""'));
    assert.equal(security.public_execute, false);
    const expected = await patient();
    const before = await snapshot();
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try { await assert.rejects(recover(expected), /permission denied/); }
      finally { await db.exec("RESET ROLE"); }
      assert.deepEqual(await snapshot(), before);
    }
    await db.exec("SET ROLE service_role");
    try { assert.equal((await recover(expected)).status, "waiting"); }
    finally { await db.exec("RESET ROLE"); }
  });
});
