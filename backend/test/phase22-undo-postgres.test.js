// Execute the migrations only in a fresh, synthetic in-memory PostgreSQL.
// No .env, live connection, original schema/seeding script or real patient data.
// PGlite serializes one connection; queued races below are CAS regressions,
// not proof of independently connected PostgreSQL lock contention.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test, before, beforeEach, after } = require("node:test");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to the installed package.";
}

describe("Phase 2.2 PostgreSQL Undo waiting ownership and Phase 2.1 history protection", { skip: unavailable }, () => {
  let db;
  const migration = fs.readFileSync(path.join(__dirname, "../scripts/20261014-phase22-undo-waiting.sql"), "utf8");
  const phase21 = fs.readFileSync(path.join(__dirname, "../scripts/20261012-phase21-stale-recovery.sql"), "utf8");
  const lifecycle = fs.readFileSync(path.join(__dirname, "../scripts/20261010-phase2-consultation-lifecycle.sql"), "utf8");
  const signature = "public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)";
  before(async () => {
    db = await PGlite.create();
    // Minimal synthetic schema, deliberately independent of the destructive
    // original install/seed script. These are temporary fixture records only.
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TYPE public.queue_status AS ENUM ('waiting', 'serving', 'completed', 'cancelled', 'no-show');
      CREATE TYPE public.user_role AS ENUM ('admin', 'superadmin');
      CREATE TABLE public.users (id_num text PRIMARY KEY, role public.user_role NOT NULL, doctor_name text);
      CREATE TABLE public.patients (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id_num text NOT NULL, queue_number text NOT NULL, service_type text NOT NULL,
        status public.queue_status NOT NULL DEFAULT 'waiting',
        created_at timestamptz NOT NULL DEFAULT now(), called_at timestamptz,
        consultation_started_at timestamptz, completed_at timestamptz,
        counter_id text, priority_score integer DEFAULT 1,
        vulnerability_flags jsonb DEFAULT '[]'::jsonb, mobile_number text, reason text
      );
      CREATE TABLE public.counters (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id_num text NOT NULL UNIQUE,
        service_types jsonb DEFAULT '[]'::jsonb, is_online boolean NOT NULL DEFAULT true,
        current_patient_id bigint REFERENCES public.patients(id), created_at timestamptz DEFAULT now()
      );
      ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.counters ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
    `);
    await db.exec(lifecycle);
    await db.exec(phase21);
    await db.exec(migration);
  });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.counters, public.patients, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.users (id_num, role, doctor_name) VALUES
        ('admin1', 'admin', 'Doctor 1'), ('admin2', 'admin', 'Doctor 2'), ('admin3', 'admin', 'Doctor 3'),
        ('frontdesk', 'admin', NULL), ('superadmin', 'superadmin', NULL);
      INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id,
        created_at, called_at, completed_at, priority_score, vulnerability_flags, reason) VALUES
        ('Synthetic recoverable', 'GP-001', 'consultation', 'cancelled', 'Doctor 1',
          '2000-01-01 00:00:00.111222+00', '2000-01-01 00:00:01.123456+00',
          '2000-01-01 00:00:02.654321+00', 5, '["senior"]', 'Cancellation note'),
        ('Synthetic active two', 'OB-001', 'prenatal', 'serving', 'Doctor 2',
          '2000-01-01 00:00:00+00', '2000-01-01 00:00:01+00', NULL, 1, '[]', NULL),
        ('Synthetic active three', 'FP-001', 'family_planning', 'serving', 'Doctor 3',
          '2000-01-01 00:00:00+00', '2000-01-01 00:00:01+00', NULL, 1, '[]', NULL);
      INSERT INTO public.counters (id_num, is_online, current_patient_id) VALUES
        ('Doctor 1', true, NULL), ('Doctor 2', true, 2), ('Doctor 3', true, 3);
    `);
  });
  const patient = async (id = 1) => (await db.query("SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id])).rows[0].value;
  const rows = async table => (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} r ORDER BY id`)).rows.map(row => row.value);
  const snapshot = async () => ({ patients: await rows("patients"), counters: await rows("counters") });
  const argsFor = (expected, action = "undo", user = "frontdesk", reason = null) => ({
    p_patient_id: expected.id, p_action: action, p_user_id_num: user,
    p_expected_revision: expected.visit_state_revision, p_expected_status: expected.status,
    p_expected_created_at: expected.created_at, p_expected_called_at: expected.called_at,
    p_expected_started_at: expected.consultation_started_at, p_expected_completed_at: expected.completed_at,
    p_expected_counter_id: expected.counter_id, p_reason: reason
  });
  async function invoke(name, args) {
    const entries = Object.entries(args);
    return (await db.query(`SELECT row_to_json(p) AS value FROM public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(", ")}) p`,
      entries.map(([, value]) => value))).rows[0].value;
  }
  const recover = (expected, action = "undo", user = "frontdesk", reason = null) => invoke("recover_patient_visit", argsFor(expected, action, user, reason));
  const conflict = error => error.code === "40001";
  function cleanWaiting(after, before) {
    assert.equal(after.status, "waiting");
    for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(after[field], null, field);
    assert.notEqual(after.visit_state_revision, before.visit_state_revision);
    // Undo changes only status, the four call/consultation fields and revision.
    assert.deepEqual({ ...after, status: before.status, called_at: before.called_at,
      consultation_started_at: before.consultation_started_at, completed_at: before.completed_at,
      counter_id: before.counter_id, visit_state_revision: before.visit_state_revision }, before);
  }
  async function prepareCalled(number = 1) {
    // Synthetic called-state fixture; real Call's separate conditional writes
    // are exercised by phase22-undo.test.js rather than replaced by this helper.
    await db.query(`UPDATE public.patients SET status = 'serving', counter_id = $1,
      service_type = $2, called_at = clock_timestamp() - interval '1 second',
      consultation_started_at = NULL, completed_at = NULL WHERE id = 1`,
    [`Doctor ${number}`, ["consultation", "prenatal", "family_planning"][number - 1]]);
    await db.query("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = $1", [`Doctor ${number}`]);
  }
  async function start(number = 1) {
    const acceptedAt = (await db.query("SELECT clock_timestamp()::text AS time")).rows[0].time;
    return invoke("start_patient_consultation", {
      p_patient_id: 1, p_doctor_name: `Doctor ${number}`, p_user_id_num: `admin${number}`, p_accepted_at: acceptedAt
    });
  }
  async function finishNewConsultation() {
    await recover(await patient(), "requeue");
    await prepareCalled();
    const started = await start();
    await db.exec("SELECT pg_sleep(0.005)");
    return invoke("complete_patient_consultation", {
      p_patient_id: 1, p_doctor_name: "Doctor 1", p_user_id_num: "admin1",
      p_expected_started_at: started.consultation_started_at, p_reason: "Synthetic actual completion"
    });
  }
  async function serviceHarness(beforeRpc) {
    const database = createDatabase();
    for (const table of ["patients", "counters", "users"]) {
      database[table] = (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} r`)).rows.map(row => row.value);
    }
    return createHarness({ database, rpc: async (name, args) => {
      database.calls.push({ action: "rpc", function: name, args: clone(args) });
      if (beforeRpc) await beforeRpc(name, args);
      try { return { data: await invoke(name, args), error: null }; }
      catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    } });
  }

  test("replacement is repeatable and preserves all rows, revision trigger, lifecycle RPCs and RLS", async () => {
    const before = await snapshot();
    const protections = async () => (await db.query(`SELECT
      (SELECT array_agg(oid ORDER BY oid) FROM pg_trigger WHERE tgrelid = 'public.patients'::regclass AND NOT tgisinternal) AS triggers,
      'public.start_patient_consultation(bigint,text,text,timestamptz)'::regprocedure::oid AS start_rpc,
      'public.complete_patient_consultation(bigint,text,text,timestamptz,text)'::regprocedure::oid AS complete_rpc,
      (SELECT array_agg(relrowsecurity ORDER BY relname) FROM pg_class WHERE oid IN ('public.patients'::regclass, 'public.counters'::regclass, 'public.users'::regclass)) AS rls`)).rows[0];
    const protectedBefore = await protections();
    await db.exec(migration);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await protections(), protectedBefore);
    assert.ok(protectedBefore.rls.every(Boolean));
    await db.exec("UPDATE public.patients SET reason = reason WHERE id = 1");
    assert.notEqual((await patient()).visit_state_revision, before.patients[0].visit_state_revision);
  });

  for (const number of [1, 2, 3]) {
    test(`Doctor ${number} cancelled started consultation restores clean waiting, then its own doctor can start a new call`, async () => {
      await db.exec("UPDATE public.counters SET current_patient_id = NULL");
      await prepareCalled(number);
      const started = await start(number);
      await db.exec("UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp() WHERE id = 1; UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = 1");
      const before = await patient();
      const allBefore = await snapshot();
      const restored = await recover(before);
      cleanWaiting(restored, before);
      assert.equal(restored.service_type, ["consultation", "prenatal", "family_planning"][number - 1]);
      assert.deepEqual((await snapshot()).patients.slice(1), allBefore.patients.slice(1));
      assert.deepEqual(await rows("counters"), allBefore.counters);
      await prepareCalled(number);
      assert.equal((await patient()).counter_id, `Doctor ${number}`);
      assert.equal((await rows("counters"))[number - 1].current_patient_id, 1);
      assert.notEqual((await start(number)).consultation_started_at, started.consultation_started_at);
    });
  }

  test("Undo clears every matching stale pointer, including a noncanonical/offline counter, and leaves other ownership/flags unchanged", async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = 1, is_online = false WHERE id_num = 'Doctor 1';
      INSERT INTO public.counters (id_num, is_online, current_patient_id) VALUES ('Legacy Counter', false, 1)`);
    const before = await snapshot();
    cleanWaiting(await recover(before.patients[0]), before.patients[0]);
    assert.deepEqual(await rows("counters"), before.counters.map(counter => ({ ...counter,
      current_patient_id: counter.current_patient_id === 1 ? null : counter.current_patient_id })));
    assert.deepEqual((await snapshot()).patients.slice(1), before.patients.slice(1));
  });

  test("Undo neither needs an online/free counter nor overwrites a busy correct doctor", async () => {
    await db.exec("UPDATE public.patients SET counter_id = 'Doctor 2', service_type = 'prenatal' WHERE id = 1; UPDATE public.counters SET is_online = false");
    const before = await snapshot();
    cleanWaiting(await recover(before.patients[0]), before.patients[0]);
    assert.deepEqual(await rows("counters"), before.counters);
  });

  for (const status of ["completed", "cancelled", "no-show"]) {
    test(`legacy ${status} Undo retains queue position/priority/service/reason and does not reserve a slot`, async () => {
      await db.query("UPDATE public.patients SET status = $1::public.queue_status WHERE id = 1", [status]);
      const before = await snapshot();
      cleanWaiting(await recover(before.patients[0]), before.patients[0]);
      assert.deepEqual(await rows("counters"), before.counters);
      const restored = await snapshot();
      await assert.rejects(recover(before.patients[0]), conflict);
      await assert.rejects(recover(restored.patients[0]), /Only completed, cancelled, or no-show patients/);
      assert.deepEqual(await snapshot(), restored);
    });
  }

  test("Requeue preserves its existing timestamp reset, reason replacement and counter semantics", async () => {
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
    const before = await snapshot();
    const after = await recover(before.patients[0], "requeue", "frontdesk", "New reason");
    assert.equal(after.status, "waiting");
    assert.ok(Date.parse(after.created_at) > Date.parse(before.patients[0].created_at));
    assert.equal(after.reason, "New reason");
    assert.equal(after.service_type, before.patients[0].service_type);
    assert.equal(after.priority_score, before.patients[0].priority_score);
    for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(after[field], null);
    assert.deepEqual(await rows("counters"), before.counters);
  });

  for (const action of ["requeue", "undo"]) {
    test(`stale ${action} cannot erase a newer real completed consultation or exact duration`, async () => {
      const stale = await patient();
      const completed = await finishNewConsultation();
      const before = await snapshot();
      const duration = async () => (await db.query("SELECT EXTRACT(EPOCH FROM completed_at - consultation_started_at)::text AS seconds FROM public.patients WHERE id = 1")).rows[0].seconds;
      const saved = await duration();
      assert.ok(Number(saved) > 0);
      await assert.rejects(recover(stale, action), conflict);
      await assert.rejects(recover(completed, action), /history must be preserved/i);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await duration(), saved);
    });

    test(`${action} revision guards same-field ABA even if all status/counter/timestamp values are restored`, async () => {
      const stale = await patient();
      await recover(stale, "undo");
      await db.query(`UPDATE public.patients SET status = $1::public.queue_status, created_at = $2,
        called_at = $3, consultation_started_at = $4, completed_at = $5, counter_id = $6 WHERE id = 1`,
      [stale.status, stale.created_at, stale.called_at, stale.consultation_started_at, stale.completed_at, stale.counter_id]);
      const before = await snapshot();
      assert.deepEqual({ ...before.patients[0], visit_state_revision: stale.visit_state_revision }, stale);
      await assert.rejects(recover(stale, action), conflict);
      assert.deepEqual(await snapshot(), before);
    });

    test(`silently suppressed ${action} patient update rolls back without clearing any counter`, async () => {
      await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
      const before = await snapshot();
      await db.exec(`CREATE FUNCTION public.phase22_patient_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status::text = 'waiting' THEN RETURN NULL; END IF; RETURN NEW; END $$;
        CREATE TRIGGER phase22_patient_suppression BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.phase22_patient_suppression()`);
      try {
        await assert.rejects(recover(before.patients[0], action), /Unable to recover/);
        assert.deepEqual(await snapshot(), before);
      } finally { await db.exec("DROP TRIGGER phase22_patient_suppression ON public.patients; DROP FUNCTION public.phase22_patient_suppression()"); }
    });
  }

  for (const mode of ["raise", "suppress", "retain"]) {
    test(`counter release ${mode} fault rolls back patient, revision and all pointers`, async () => {
      await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'; INSERT INTO public.counters (id_num, current_patient_id) VALUES ('Legacy Counter', 1)");
      const before = await snapshot();
      const fault = mode === "raise" ? "RAISE EXCEPTION 'Injected counter release failure';" : mode === "suppress" ? "RETURN NULL;" : "RETURN OLD;";
      await db.exec(`CREATE FUNCTION public.phase22_counter_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.id_num = 'Legacy Counter' AND OLD.current_patient_id = 1 AND NEW.current_patient_id IS NULL THEN ${fault} END IF; RETURN NEW; END $$;
        CREATE TRIGGER phase22_counter_fault BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.phase22_counter_fault()`);
      try {
        await assert.rejects(recover(before.patients[0]), mode === "raise" ? /Injected counter release failure/ : /Unable to release/);
        assert.deepEqual(await snapshot(), before);
      } finally { await db.exec("DROP TRIGGER phase22_counter_fault ON public.counters; DROP FUNCTION public.phase22_counter_fault()"); }
    });
  }

  for (const [parameter, field] of [["p_expected_created_at", "created_at"], ["p_expected_called_at", "called_at"],
    ["p_expected_started_at", "consultation_started_at"], ["p_expected_completed_at", "completed_at"]]) {
    test(`exact ${field} microseconds and NULL comparison remain protected at write time`, async () => {
      await db.exec("UPDATE public.patients SET consultation_started_at = '2000-01-01 00:00:01.223456+00' WHERE id = 1; UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
      const before = await snapshot();
      const args = argsFor(before.patients[0]);
      const wrong = (await db.query("SELECT ($1::timestamptz + interval '1 microsecond')::text AS time", [before.patients[0][field]])).rows[0].time;
      await assert.rejects(invoke("recover_patient_visit", { ...args, [parameter]: wrong }), conflict);
      await assert.rejects(invoke("recover_patient_visit", { ...args, [parameter]: null }), field === "created_at" ? error => error.code === "22023" : conflict);
      assert.deepEqual(await snapshot(), before);
      cleanWaiting(await recover(before.patients[0]), before.patients[0]);
    });
  }

  test("exact revision/status/counter and required arguments reject before counter mutation", async () => {
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
    const before = await snapshot();
    const args = argsFor(before.patients[0]);
    for (const changed of [{ p_expected_revision: "00000000-0000-0000-0000-000000000000" },
      { p_expected_status: "completed" }, { p_expected_counter_id: "1" }, { p_expected_counter_id: null }]) {
      await assert.rejects(invoke("recover_patient_visit", { ...args, ...changed }), conflict);
      assert.deepEqual(await snapshot(), before);
    }
    for (const changed of [{ p_patient_id: 0 }, { p_action: "complete" }, { p_expected_revision: null },
      { p_expected_status: null }, { p_expected_created_at: null }]) {
      await assert.rejects(invoke("recover_patient_visit", { ...args, ...changed }), error => error.code === "22023");
      assert.deepEqual(await snapshot(), before);
    }
    await assert.rejects(invoke("recover_patient_visit", { ...args, p_patient_id: 999 }), error => error.code === "P0002");
    assert.deepEqual(await snapshot(), before);
  });

  test("queued duplicate Undo and competing Undo/Requeue have one CAS winner and no new reservation", async () => {
    for (const actions of [["undo", "undo"], ["undo", "requeue"]]) {
      const expected = await patient();
      const countersBefore = await rows("counters");
      const responses = await Promise.allSettled(actions.map(action => recover(expected, action)));
      assert.equal(responses.filter(response => response.status === "fulfilled").length, 1);
      assert.equal(responses.find(response => response.status === "rejected").reason.code, "40001");
      assert.deepEqual(await rows("counters"), countersBefore);
      await db.exec("UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp() WHERE id = 1");
    }
  });

  test("actual HTTP Undo forwards trusted complete snapshot to the replacement SQL function", async () => {
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
    const before = await snapshot();
    const h = await serviceHarness();
    const response = await h.request("POST", "/queue/undo", { patient_id: 1,
      p_expected_revision: "00000000-0000-0000-0000-000000000000", p_expected_called_at: "1990-01-01T00:00:00Z" });
    assert.equal(response.status, 200, response.body.message);
    assert.deepEqual(h.database.calls.find(call => call.function === "undo_patient_visit_waiting").args, argsFor(before.patients[0]));
    cleanWaiting(await patient(), before.patients[0]);
    assert.equal((await rows("counters"))[0].current_patient_id, null);
  });

  test("delayed HTTP Undo rejects after a newer real completion and leaves exact patient/counters intact", { timeout: 10000 }, async () => {
    let entered, resume;
    const reached = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { resume = resolve; });
    const h = await serviceHarness(async () => { entered(); await paused; });
    const pending = h.request("POST", "/queue/undo", { patient_id: 1 });
    await reached;
    let before;
    try { await finishNewConsultation(); before = await snapshot(); }
    finally { resume(); }
    const response = await pending;
    assert.equal(response.status, 409, response.body.message);
    assert.deepEqual(await snapshot(), before);
  });

  test("new backend on a Phase 2.1-only database fails Undo closed without any old counter reservation", async () => {
    const gateSignature = signature.replace("recover_patient_visit", "undo_patient_visit_waiting");
    await db.exec(`DROP FUNCTION ${gateSignature}`);
    await db.exec(phase21);
    const before = await snapshot();
    try {
      const h = await serviceHarness();
      const response = await h.request("POST", "/queue/undo", { patient_id: 1 });
      assert.equal(response.status, 503, response.body.message);
      assert.match(response.body.message, /Phase 2\.2 database migration/);
      assert.deepEqual(await snapshot(), before);
      assert.equal(h.database.calls.filter(call => call.function === "recover_patient_visit").length, 0);
    } finally { await db.exec(migration); }
  });

  test("versioned Undo gate rolls back if the older first-free recovery body is accidentally reinstalled", async () => {
    await db.exec(phase21);
    const before = await snapshot();
    try {
      const h = await serviceHarness();
      const response = await h.request("POST", "/queue/undo", { patient_id: 1 });
      assert.equal(response.status, 503, response.body.message);
      assert.match(response.body.message, /Phase 2\.2 waiting recovery/);
      assert.deepEqual(await snapshot(), before);
    } finally { await db.exec(migration); }
  });

  test("versioned Undo gate cannot be used to invoke Requeue", async () => {
    const before = await snapshot();
    await assert.rejects(invoke("undo_patient_visit_waiting", argsFor(before.patients[0], "requeue")), error => error.code === "22023");
    assert.deepEqual(await snapshot(), before);
  });

  test("replacement preserves staff authorization, backend-only grants and safe search path", async () => {
    const before = await snapshot();
    await assert.rejects(recover(before.patients[0], "undo", "unknown"), error => error.code === "42501");
    await db.exec("DELETE FROM public.users WHERE id_num = 'frontdesk'");
    await assert.rejects(recover(before.patients[0]), error => error.code === "42501");
    assert.deepEqual(await snapshot(), before);
    for (const rpcSignature of [signature, signature.replace("recover_patient_visit", "undo_patient_visit_waiting")]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, rpcSignature])).rows[0].allowed, role === "service_role");
      }
      const security = (await db.query("SELECT prosecdef, proconfig, EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute FROM pg_proc WHERE oid = $1::regprocedure", [rpcSignature])).rows[0];
      assert.equal(security.prosecdef, true);
      assert.ok(security.proconfig.includes('search_path=""'));
      assert.equal(security.public_execute, false);
    }
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(recover(before.patients[0], "undo", "superadmin"), /permission denied/);
        await assert.rejects(invoke("undo_patient_visit_waiting", argsFor(before.patients[0], "undo", "superadmin")), /permission denied/);
      }
      finally { await db.exec("RESET ROLE"); }
      assert.deepEqual(await snapshot(), before);
    }
    await db.exec("SET ROLE service_role");
    try { cleanWaiting(await invoke("undo_patient_visit_waiting", argsFor(before.patients[0], "undo", "superadmin")), before.patients[0]); }
    finally { await db.exec("RESET ROLE"); }
  });
});
