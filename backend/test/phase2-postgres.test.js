// Optional real PostgreSQL tests, isolated in an in-memory PGlite database.
// See docs/phase2-consultation.md. No Supabase credentials or live data are used.
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
  unavailable = "Optional PGlite is not installed; see docs/phase2-consultation.md to run the SQL integration suite.";
}

describe("Phase 2 PostgreSQL migration and consultation RPCs", { skip: unavailable }, () => {
  let db;
  const migration = fs.readFileSync(path.join(__dirname, "../scripts/20261010-phase2-consultation-lifecycle.sql"), "utf8");

  before(async () => {
    db = await PGlite.create();
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(basePostgresSchema);
    await db.exec(migration);
  });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    // These tables exist only inside this newly created in-memory database.
    await db.exec(`
      TRUNCATE public.counters, public.patients, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
        ('admin1', 'test-only', 'admin', 'Doctor 1'),
        ('admin2', 'test-only', 'admin', 'Doctor 2'),
        ('admin3', 'test-only', 'admin', 'Doctor 3'),
        ('superadmin', 'test-only', 'superadmin', NULL),
        ('frontdesk', 'test-only', 'admin', NULL);
      INSERT INTO public.patients (id_num, first_name, last_name, mobile_number,
          queue_number, service_type, status, counter_id, called_at) VALUES
        ('test-patient-1', 'Test', 'One', '000', 'GP-001', 'consultation', 'serving', 'Doctor 1', now() - interval '5 minutes'),
        ('test-patient-2', 'Test', 'Two', '000', 'OB-001', 'prenatal', 'serving', 'Doctor 2', now() - interval '5 minutes'),
        ('test-patient-3', 'Test', 'Three', '000', 'FP-001', 'family_planning', 'serving', 'Doctor 3', now() - interval '5 minutes');
      INSERT INTO public.counters (id_num, current_patient_id) VALUES
        ('Doctor 1', 1), ('Doctor 2', 2), ('Doctor 3', 3);
    `);
  });

  const start = (id = 1, doctor = "Doctor 1", user = "admin1", accepted = new Date().toISOString()) =>
    db.query("SELECT * FROM public.start_patient_consultation($1, $2, $3, $4)", [id, doctor, user, accepted]);
  const persistedStart = async (id = 1) =>
    (await db.query("SELECT consultation_started_at::text AS started_at FROM public.patients WHERE id = $1", [id])).rows[0]?.started_at || null;
  const complete = async (id = 1, doctor = "Doctor 1", user = "admin1", reason = null, expectedStartedAt) => {
    if (expectedStartedAt === undefined) expectedStartedAt = await persistedStart(id);
    return db.query("SELECT * FROM public.complete_patient_consultation($1, $2, $3, $4, $5)", [id, doctor, user, expectedStartedAt, reason]);
  };
  const patient = async (id = 1) => (await db.query("SELECT * FROM public.patients WHERE id = $1", [id])).rows[0];
  const counter = async (doctor = "Doctor 1") =>
    (await db.query("SELECT * FROM public.counters WHERE id_num = $1", [doctor])).rows[0];

  async function serviceHarness() {
    const database = createDatabase();
    async function refreshReads() {
      for (const table of ["patients", "counters", "users"]) {
        // JSON serialization retains PostgreSQL microseconds as Supabase does.
        const records = (await db.query(`SELECT row_to_json(record) AS value FROM public.${table} AS record`)).rows;
        database[table] = records.map((row) => row.value);
      }
    }
    await refreshReads();
    return createHarness({
      database,
      clock: { now: Date.now() },
      rpc: async (name, args) => {
        database.calls.push({ action: "rpc", function: name, args: clone(args) });
        assert.ok(["start_patient_consultation", "complete_patient_consultation"].includes(name));
        const entries = Object.entries(args);
        const permitted = ["p_patient_id", "p_doctor_name", "p_user_id_num", "p_accepted_at", "p_expected_started_at", "p_reason"];
        assert.ok(entries.every(([key]) => permitted.includes(key)));
        // Invoke using the backend's actual named payload. A missing required
        // argument must fail SQL function resolution instead of being supplied
        // by a test helper, which previously hid a production contract mismatch.
        const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(", ");
        try {
          const result = await db.query(`SELECT row_to_json(patient) AS value FROM public.${name}(${parameters}) AS patient`, entries.map(([, value]) => value));
          await refreshReads();
          return { data: result.rows[0].value, error: null };
        } catch (error) {
          return { data: null, error: { code: error.code, message: error.message } };
        }
      }
    });
  }

  test("additive migration is repeatable, nullable TIMESTAMPTZ and preserves historical records", async () => {
    await db.exec("UPDATE public.patients SET status = 'completed', completed_at = now() WHERE id = 1;");
    const before = await patient();
    await db.exec(migration);
    assert.deepEqual(await patient(), before);
    const columns = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'consultation_started_at'`);
    assert.deepEqual(columns.rows, [{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);
    assert.equal((await patient()).consultation_started_at, null);
  });

  test("start uses PostgreSQL clock and changes only the actual consultation timestamp", async () => {
    const before = await patient();
    const clockBefore = (await db.query("SELECT clock_timestamp() AS time")).rows[0].time;
    const result = (await start()).rows[0];
    const clockAfter = (await db.query("SELECT clock_timestamp() AS time")).rows[0].time;
    assert.equal(result.status, "serving");
    assert.ok(result.consultation_started_at >= clockBefore && result.consultation_started_at <= clockAfter);
    assert.notEqual(+result.consultation_started_at, +result.called_at);
    assert.equal(result.completed_at, null);
    assert.deepEqual({ ...result, consultation_started_at: null }, before);
    assert.equal((await counter()).current_patient_id, 1);
  });

  test("start requires acceptance attested by the trusted backend", async () => {
    await assert.rejects(start(1, "Doctor 1", "admin1", null), /Accept this patient/);
    await assert.rejects(start(1, "Doctor 1", "admin1", "infinity"), /Accept this patient/);
    assert.equal((await patient()).consultation_started_at, null);
  });

  test("a previous call's acceptance cannot start a newly called patient cycle", async () => {
    const oldAccepted = (await db.query("SELECT called_at + interval '1 minute' AS accepted_at FROM public.patients WHERE id = 1")).rows[0].accepted_at;
    await db.exec("UPDATE public.patients SET called_at = clock_timestamp() WHERE id = 1");
    await assert.rejects(start(1, "Doctor 1", "admin1", oldAccepted.toISOString()), /Accept the current call/);
    assert.equal((await patient()).consultation_started_at, null);
    assert.equal((await counter()).current_patient_id, 1);
  });

  for (const status of ["waiting", "completed", "cancelled"]) {
    test(`start rejects ${status} patients without changing timestamps`, async () => {
      await db.query("UPDATE public.patients SET status = $1 WHERE id = 1", [status]);
      await assert.rejects(start(), /Only a called, serving patient/);
      assert.equal((await patient()).consultation_started_at, null);
    });
  }

  test("start rejects missing call timestamp or an existing end timestamp", async () => {
    await db.exec("UPDATE public.patients SET called_at = NULL WHERE id = 1");
    await assert.rejects(start(), /Only a called, serving patient/);
    await db.exec("UPDATE public.patients SET called_at = now(), completed_at = now() WHERE id = 1");
    await assert.rejects(start(), /Only a called, serving patient/);
  });

  test("fresh database user assignment isolates each doctor and rejects non-doctors", async () => {
    await assert.rejects(start(1, "Doctor 1", "admin2"), /Only the assigned doctor/);
    await assert.rejects(start(1, "Doctor 1", "superadmin"), /Only the assigned doctor/);
    await assert.rejects(start(1, "Doctor 1", "frontdesk"), /Only the assigned doctor/);
    await assert.rejects(start(1, "Doctor 1", "missing-user"), /Only the assigned doctor/);
    await assert.rejects(start(2, "Doctor 1", "admin1"), /not currently assigned/);
    await db.exec("UPDATE public.users SET doctor_name = 'Doctor 2' WHERE id_num = 'admin1'");
    await assert.rejects(start(), /Only the assigned doctor/);
  });

  test("existing doctor aliases resolve to the canonical counter", async () => {
    await db.exec("UPDATE public.users SET doctor_name = 'doctor1' WHERE id_num = 'admin1'");
    await db.exec("UPDATE public.patients SET counter_id = '1' WHERE id = 1");
    assert.ok((await start()).rows[0].consultation_started_at);
  });

  test("start rejects stale counter pointers and conflicting assignments", async () => {
    await db.exec("UPDATE public.counters SET current_patient_id = NULL WHERE id_num = 'Doctor 1'");
    await assert.rejects(start(), /not currently assigned/);
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num IN ('Doctor 1', 'Doctor 2')");
    await assert.rejects(start(), /conflicting doctor assignments/);
  });

  test("queued duplicate starts produce one timestamp and reject the other request", async () => {
    // PGlite has one connection: this verifies queued duplicates, not multi-session locking.
    const results = await Promise.allSettled([start(), start()]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(results.find(result => result.status === "rejected").reason.message, /already started/);
    assert.deepEqual((await patient()).consultation_started_at, results.find(result => result.status === "fulfilled").value.rows[0].consultation_started_at);
  });

  test("completion cannot substitute called_at for an unstarted consultation", async () => {
    await assert.rejects(complete(), /Start consultation/);
    assert.equal((await patient()).status, "serving");
    assert.equal((await patient()).completed_at, null);
    assert.equal((await counter()).current_patient_id, 1);
  });

  test("completion saves the server end time and atomically releases only the assigned counter", async () => {
    await start();
    const started = (await patient()).consultation_started_at;
    await db.exec("SELECT pg_sleep(0.005)");
    const completed = (await complete(1, "Doctor 1", "admin1", "  Consultation performed  ")).rows[0];
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.consultation_started_at, started);
    assert.ok(completed.completed_at > started);
    assert.equal(completed.counter_id, "Doctor 1");
    assert.equal(completed.reason, "Consultation performed");
    assert.equal((await counter()).current_patient_id, null);
    assert.equal((await counter("Doctor 2")).current_patient_id, 2);
    assert.equal((await counter("Doctor 3")).current_patient_id, 3);
    const duration = (await db.query("SELECT EXTRACT(EPOCH FROM completed_at - consultation_started_at) AS seconds FROM public.patients WHERE id = 1")).rows[0].seconds;
    assert.ok(Number(duration) > 0);
    assert.ok(Math.abs(Number(duration) - (completed.completed_at - started) / 1000) < 0.002);
  });

  test("doctor HTTP lifecycle sends its actual backend RPC payload to the migrated PostgreSQL functions", async () => {
    const h = await serviceHarness();
    const doctor = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };
    const accepted = await h.request("POST", "/queue/accept", { patient_id: 1 }, doctor);
    assert.equal(accepted.status, 200, accepted.body.message);
    const started = await h.request("POST", "/queue/start", {
      patient_id: 1, consultation_started_at: "1990-01-01T00:00:00.000Z"
    }, doctor);
    assert.equal(started.status, 200, started.body.message);
    const exactStart = started.body.patient.consultation_started_at;
    assert.equal(typeof exactStart, "string");
    await db.exec("SELECT pg_sleep(0.005)");
    const completed = await h.request("POST", "/queue/complete", {
      patient_id: 1,
      p_expected_started_at: "1990-01-01T00:00:00.000Z",
      completed_at: "1990-01-01T00:00:00.000Z"
    }, doctor);
    assert.equal(completed.status, 200, completed.body.message);
    const completeRpc = h.database.calls.find((entry) => entry.function === "complete_patient_consultation");
    assert.equal(completeRpc.args.p_expected_started_at, exactStart);
    assert.equal(completed.body.patient.consultation_started_at, exactStart);
    assert.equal(completed.body.patient.status, "completed");
    assert.ok(completed.body.patient.service_duration_seconds > 0);
    assert.equal((await counter()).current_patient_id, null);
    assert.equal((await counter("Doctor 2")).current_patient_id, 2);
    const sqlDuration = (await db.query("SELECT EXTRACT(EPOCH FROM completed_at - consultation_started_at) AS seconds FROM public.patients WHERE id = 1")).rows[0].seconds;
    assert.ok(Math.abs(Number(sqlDuration) - completed.body.patient.service_duration_seconds) < 0.000001);
  });

  test("completion rechecks current doctor identity and ownership", async () => {
    await start();
    await assert.rejects(complete(1, "Doctor 1", "admin2"), /Only the assigned doctor/);
    await assert.rejects(complete(1, "Doctor 2", "admin2"), /not currently assigned/);
    assert.equal((await patient()).status, "serving");
    assert.equal((await counter()).current_patient_id, 1);
  });

  test("queued duplicate completion requests cannot rewrite a completed record", async () => {
    await start();
    const results = await Promise.allSettled([complete(), complete()]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const saved = await patient();
    await assert.rejects(complete());
    assert.deepEqual(await patient(), saved);
    assert.equal((await counter()).current_patient_id, null);
  });

  test("a delayed completion cannot finish a later consultation attempt using the same patient ID", async () => {
    await start();
    const oldExpectedStart = await persistedStart();
    await db.exec(`UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp() WHERE id = 1;
      UPDATE public.counters SET current_patient_id = NULL WHERE id_num = 'Doctor 1';
      UPDATE public.patients SET status = 'waiting', counter_id = NULL, called_at = NULL,
        consultation_started_at = NULL, completed_at = NULL WHERE id = 1;
      UPDATE public.patients SET status = 'serving', counter_id = 'Doctor 1',
        called_at = clock_timestamp() - interval '1 second' WHERE id = 1;
      UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1';`);
    await start();
    const newExpectedStart = await persistedStart();
    assert.notEqual(newExpectedStart, oldExpectedStart);
    await assert.rejects(complete(1, "Doctor 1", "admin1", null, oldExpectedStart), /Consultation attempt changed/);
    assert.equal((await patient()).status, "serving");
    assert.equal((await patient()).completed_at, null);
    assert.equal(await persistedStart(), newExpectedStart);
    assert.equal((await counter()).current_patient_id, 1);
  });

  test("completion requires the exact server-read start timestamp with PostgreSQL precision", async () => {
    await start();
    await assert.rejects(complete(1, "Doctor 1", "admin1", null, null), /expected consultation start/);
    await assert.rejects(complete(1, "Doctor 1", "admin1", null, "infinity"), /expected consultation start/);
    const exact = await persistedStart();
    const shifted = (await db.query("SELECT ($1::timestamptz + interval '1 microsecond')::text AS started_at", [exact])).rows[0].started_at;
    await assert.rejects(complete(1, "Doctor 1", "admin1", null, shifted), /Consultation attempt changed/);
    assert.equal((await patient()).completed_at, null);
    assert.equal((await counter()).current_patient_id, 1);
    assert.equal((await complete(1, "Doctor 1", "admin1", null, exact)).rows[0].status, "completed");
  });

  test("completion rejects an invalid future start time without releasing the doctor", async () => {
    await db.exec("UPDATE public.patients SET consultation_started_at = clock_timestamp() + interval '1 minute' WHERE id = 1");
    await assert.rejects(complete(), /Completion must occur after/);
    assert.equal((await patient()).completed_at, null);
    assert.equal((await counter()).current_patient_id, 1);
  });

  test("counter release failure rolls back patient completion and preserves the start", async () => {
    await start();
    const before = await patient();
    await db.exec(`CREATE FUNCTION public.test_release_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.current_patient_id IS NULL THEN RAISE EXCEPTION 'Injected release failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_release_failure BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.test_release_failure();`);
    try {
      await assert.rejects(complete(), /Injected release failure/);
      assert.deepEqual(await patient(), before);
      assert.equal((await counter()).current_patient_id, 1);
    } finally {
      await db.exec("DROP TRIGGER test_release_failure ON public.counters; DROP FUNCTION public.test_release_failure();");
    }
  });

  test("suppressed patient start update fails without changing the patient or counter", async () => {
    const before = await patient();
    await db.exec(`CREATE FUNCTION public.test_suppressed_start() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.consultation_started_at IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_suppressed_start BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.test_suppressed_start();`);
    try {
      await assert.rejects(start(), /Unable to record the consultation start/);
      assert.deepEqual(await patient(), before);
      assert.equal((await counter()).current_patient_id, 1);
    } finally {
      await db.exec("DROP TRIGGER test_suppressed_start ON public.patients; DROP FUNCTION public.test_suppressed_start();");
    }
  });

  test("suppressed patient completion update cannot release a still-serving patient's doctor", async () => {
    await start();
    const before = await patient();
    await db.exec(`CREATE FUNCTION public.test_suppressed_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status::text = 'completed' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_suppressed_completion BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.test_suppressed_completion();`);
    try {
      await assert.rejects(complete(), /Unable to record the consultation completion/);
      assert.deepEqual(await patient(), before);
      assert.equal((await counter()).current_patient_id, 1);
    } finally {
      await db.exec("DROP TRIGGER test_suppressed_completion ON public.patients; DROP FUNCTION public.test_suppressed_completion();");
    }
  });

  test("silently suppressed counter release also rolls back patient completion", async () => {
    await start();
    const before = await patient();
    await db.exec(`CREATE FUNCTION public.test_suppressed_release() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.current_patient_id IS NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_suppressed_release BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.test_suppressed_release();`);
    try {
      await assert.rejects(complete(), /Unable to release/);
      assert.deepEqual(await patient(), before);
      assert.equal((await counter()).current_patient_id, 1);
    } finally {
      await db.exec("DROP TRIGGER test_suppressed_release ON public.counters; DROP FUNCTION public.test_suppressed_release();");
    }
  });

  test("RPC privileges deny browser roles and permit the backend service role", async () => {
    for (const signature of ["public.start_patient_consultation(bigint,text,text,timestamptz)", "public.complete_patient_consultation(bigint,text,text,timestamptz,text)"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const permitted = (await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS permitted", [role, signature])).rows[0].permitted;
        assert.equal(permitted, role === "service_role");
      }
    }
    await db.exec("SET ROLE anon");
    try { await assert.rejects(start(), /permission denied/); }
    finally { await db.exec("RESET ROLE"); }
    await db.exec("SET ROLE service_role");
    try { assert.ok((await start()).rows[0].consultation_started_at); }
    finally { await db.exec("RESET ROLE"); }
  });
});
