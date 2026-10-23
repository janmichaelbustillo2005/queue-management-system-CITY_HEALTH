// F5 versioned Requeue function (20261022-f5-requeue-terminal-recovery.sql), executed only in a
// fresh in-memory PGlite database with synthetic rows. No .env, Supabase or real patients.
// PGlite has one connection: "concurrent" cases below are interleaved commits, not proof of
// independent-connection lock contention.
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

const script = (name) => fs.readFileSync(path.join(__dirname, "../scripts", name), "utf8");
const SIGNATURE = "public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)";
const RECOVER = SIGNATURE.replace("requeue_patient_visit", "recover_patient_visit");
const UNDO = SIGNATURE.replace("requeue_patient_visit", "undo_patient_visit_waiting");

describe("F5 requeue_patient_visit (isolated PGlite)", { skip: unavailable }, () => {
  let db;
  const f5 = script("20261022-f5-requeue-terminal-recovery.sql");

  before(async () => {
    db = await PGlite.create();
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
    await db.exec(script("20261010-phase2-consultation-lifecycle.sql"));
    await db.exec(script("20261012-phase21-stale-recovery.sql"));
    await db.exec(script("20261014-phase22-undo-waiting.sql"));
    await db.exec(f5);
  });
  after(async () => { if (db) await db.close(); });

  // 1 cancelled after a started attempt (Doctor 1), 2 serving not started (Doctor 2),
  // 3 serving started (Doctor 3), 4 no-show (Doctor 1), 5 waiting regular GP,
  // 6 completed consultation with start, 7 legacy completed without start, 8 waiting senior GP.
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.counters, public.patients, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.users (id_num, role, doctor_name) VALUES
        ('admin1', 'admin', 'Doctor 1'), ('admin2', 'admin', 'Doctor 2'), ('admin3', 'admin', 'Doctor 3'),
        ('frontdesk', 'admin', NULL), ('superadmin', 'superadmin', NULL);
      INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, created_at,
        called_at, consultation_started_at, completed_at, priority_score, vulnerability_flags, reason) VALUES
        ('Synthetic cancelled', 'GP-001', 'consultation', 'cancelled', 'Doctor 1', '2000-01-01 08:00:00.111222+00',
          '2000-01-01 08:01:00.123456+00', '2000-01-01 08:02:00.234567+00', '2000-01-01 08:03:00.345678+00', 4, '["senior"]', 'Interrupted'),
        ('Synthetic serving', 'OB-001', 'prenatal', 'serving', 'Doctor 2', '2000-01-01 08:00:00+00',
          '2000-01-01 08:01:00+00', NULL, NULL, 1, '[]', NULL),
        ('Synthetic in consultation', 'FP-001', 'family_planning', 'serving', 'Doctor 3', '2000-01-01 08:00:00+00',
          '2000-01-01 08:01:00+00', '2000-01-01 08:02:00+00', NULL, 1, '[]', NULL),
        ('Synthetic no-show', 'GP-002', 'consultation', 'no-show', 'Doctor 1', '2000-01-01 08:00:01+00',
          '2000-01-01 08:01:00+00', NULL, '2000-01-01 08:20:00+00', 1, '[]', 'No-show'),
        ('Synthetic waiting', 'GP-003', 'consultation', 'waiting', NULL, '2000-01-01 08:30:00+00',
          NULL, NULL, NULL, 1, '[]', NULL),
        ('Synthetic completed', 'GP-004', 'consultation', 'completed', 'Doctor 1', '2000-01-01 07:00:00+00',
          '2000-01-01 07:01:00+00', '2000-01-01 07:02:00+00', '2000-01-01 07:10:00+00', 1, '[]', 'Done'),
        ('Synthetic legacy completed', 'GP-005', 'consultation', 'completed', 'Doctor 1', '2000-01-01 07:00:00+00',
          '2000-01-01 07:01:00+00', NULL, '2000-01-01 07:10:00+00', 1, '[]', NULL),
        ('Synthetic waiting senior', 'GP-006', 'consultation', 'waiting', NULL, '2000-01-01 08:40:00+00',
          NULL, NULL, NULL, 4, '["senior"]', NULL);
      INSERT INTO public.counters (id_num, is_online, current_patient_id) VALUES
        ('Doctor 1', true, NULL), ('Doctor 2', true, 2), ('Doctor 3', true, 3);
    `);
  });

  const patient = async (id) => (await db.query("SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id])).rows[0].value;
  const rows = async (table) => (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} r ORDER BY id`)).rows.map((row) => row.value);
  const snapshot = async () => ({ patients: await rows("patients"), counters: await rows("counters") });
  const argsFor = (expected, { action = "requeue", user = "frontdesk", reason = "Synthetic requeue", status } = {}) => ({
    p_patient_id: expected.id, p_action: action, p_user_id_num: user,
    p_expected_revision: expected.visit_state_revision, p_expected_status: status ?? expected.status,
    p_expected_created_at: expected.created_at, p_expected_called_at: expected.called_at,
    p_expected_started_at: expected.consultation_started_at, p_expected_completed_at: expected.completed_at,
    p_expected_counter_id: expected.counter_id, p_reason: reason
  });
  async function invoke(name, args) {
    const entries = Object.entries(args);
    return (await db.query(`SELECT row_to_json(p) AS value FROM public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(", ")}) p`,
      entries.map(([, value]) => value))).rows[0].value;
  }
  const requeue = (expected, options) => invoke("requeue_patient_visit", argsFor(expected, options));
  const code = (expected) => (error) => error.code === expected;
  async function rejectsUnchanged(action, predicate) {
    const before = await snapshot();
    await assert.rejects(action(), predicate);
    assert.deepEqual(await snapshot(), before);
  }
  const definition = async (signature) => (await db.query("SELECT md5(pg_get_functiondef($1::regprocedure)) AS hash", [signature])).rows[0].hash;

  test("installation is repeatable, adds one function and leaves pinned recovery functions, rows, triggers and RLS unchanged", async () => {
    const before = await snapshot();
    const protections = async () => (await db.query(`SELECT
      (SELECT array_agg(tgname ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.patients'::regclass AND NOT tgisinternal) AS triggers,
      (SELECT array_agg(relrowsecurity ORDER BY relname) FROM pg_class WHERE oid IN ('public.patients'::regclass, 'public.counters'::regclass, 'public.users'::regclass)) AS rls`)).rows[0];
    const hashes = [await definition(RECOVER), await definition(UNDO)];
    const protectedBefore = await protections();
    await db.exec(f5);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual([await definition(RECOVER), await definition(UNDO)], hashes);
    assert.deepEqual(await protections(), protectedBefore);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'requeue_patient_visit'")).rows[0].n, 1, "no overloads");
  });

  test("cancelled visit with stale pointers is re-queued and only its pointers are released, atomically", async () => {
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'; INSERT INTO public.counters (id_num, current_patient_id) VALUES ('Legacy Counter', 1)");
    const before = await snapshot();
    const original = before.patients[0];
    const result = await requeue(original);
    assert.equal(result.status, "waiting");
    for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(result[field], null, field);
    assert.ok(Date.parse(result.created_at) > Date.parse(original.created_at), "moved to the end of its priority tier");
    assert.equal(result.priority_score, 4);
    assert.deepEqual(result.vulnerability_flags, ["senior"]);
    assert.equal(result.service_type, "consultation");
    assert.equal(result.reason, "Synthetic requeue");
    assert.notEqual(result.visit_state_revision, original.visit_state_revision);
    const after = await snapshot();
    assert.deepEqual(after.counters.map((c) => [c.id_num, c.current_patient_id]),
      [["Doctor 1", null], ["Doctor 2", 2], ["Doctor 3", 3], ["Legacy Counter", null]], "active patients keep their counters");
    assert.deepEqual(after.patients.slice(1), before.patients.slice(1), "no other visit changes");
  });

  test("no-show and legacy completed-without-start visits are recoverable (existing policy)", async () => {
    for (const id of [4, 7]) {
      const result = await requeue(await patient(id));
      assert.equal(result.status, "waiting");
      assert.equal(result.consultation_started_at, null);
    }
  });

  test("serving visits are refused, with or without a consultation start, and keep every field and counter", async () => {
    for (const id of [2, 3]) {
      const serving = await patient(id);
      await rejectsUnchanged(() => requeue(serving), /Only cancelled or no-show visits can be re-queued/);
      // A caller that misstates the status is refused by the locked snapshot comparison.
      await rejectsUnchanged(() => requeue(serving, { status: "cancelled" }), code("40001"));
    }
    assert.equal((await patient(3)).consultation_started_at !== null, true);
  });

  test("waiting visits are refused and keep their registration time", async () => {
    await rejectsUnchanged(async () => requeue(await patient(5)), /Only cancelled or no-show/);
    await rejectsUnchanged(async () => requeue(await patient(5), { status: "no-show" }), code("40001"));
  });

  test("a completed consultation with a recorded start keeps its history", async () => {
    await rejectsUnchanged(async () => requeue(await patient(6)), /Completed consultation history must be preserved/);
  });

  test("stale revisions, duplicates, wrong actions and unknown staff are rejected without changes", async () => {
    const original = await patient(1);
    await db.exec("UPDATE public.patients SET reason = reason WHERE id = 1"); // rotates the revision only
    await rejectsUnchanged(() => requeue(original), code("40001"));
    const current = await patient(1);
    await requeue(current);
    await rejectsUnchanged(() => requeue(current), code("40001")); // duplicate with the same snapshot
    const noShow = await patient(4);
    await rejectsUnchanged(() => requeue(noShow, { action: "undo" }), code("22023"));
    await rejectsUnchanged(() => requeue(noShow, { user: "unknown" }), code("42501"));
  });

  for (const mode of ["raise", "suppress", "retain"]) {
    test(`counter release ${mode} fault rolls back the patient, revision and every pointer`, async () => {
      await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'; INSERT INTO public.counters (id_num, current_patient_id) VALUES ('Legacy Counter', 1)");
      const before = await snapshot();
      const fault = mode === "raise" ? "RAISE EXCEPTION 'Injected counter release failure';" : mode === "suppress" ? "RETURN NULL;" : "RETURN OLD;";
      await db.exec(`CREATE FUNCTION public.f5_counter_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.id_num = 'Legacy Counter' AND NEW.current_patient_id IS NULL THEN ${fault} END IF; RETURN NEW; END $$;
        CREATE TRIGGER f5_counter_fault BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.f5_counter_fault()`);
      try {
        await assert.rejects(requeue(before.patients[0]), mode === "raise" ? /Injected counter release failure/ : /Unable to re-queue/);
        assert.deepEqual(await snapshot(), before);
      } finally { await db.exec("DROP TRIGGER f5_counter_fault ON public.counters; DROP FUNCTION public.f5_counter_fault()"); }
    });
  }

  test("Requeue and Undo from one cancelled snapshot: whichever commits first wins, the other conflicts", async () => {
    const snap = await patient(1);
    const undone = await invoke("undo_patient_visit_waiting", argsFor(snap, { action: "undo", reason: null }));
    await rejectsUnchanged(() => requeue(snap), code("40001"));
    assert.equal((await patient(1)).created_at, undone.created_at, "Undo keeps the original position");

    await db.exec("UPDATE public.patients SET status = 'cancelled', completed_at = clock_timestamp() WHERE id = 1");
    const second = await patient(1);
    const requeued = await requeue(second);
    await rejectsUnchanged(() => invoke("undo_patient_visit_waiting", argsFor(second, { action: "undo", reason: null })), code("40001"));
    assert.equal((await patient(1)).created_at, requeued.created_at);
  });

  test("a stale Requeue cannot erase a consultation completed after Undo, Call, Start and Complete", async () => {
    const snap = await patient(1);
    await invoke("undo_patient_visit_waiting", argsFor(snap, { action: "undo", reason: null }));
    await db.query("UPDATE public.patients SET status = 'serving', counter_id = 'Doctor 1', called_at = clock_timestamp() - interval '2 seconds' WHERE id = 1");
    await db.query("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
    const accepted = (await db.query("SELECT clock_timestamp()::text AS t")).rows[0].t;
    const started = await invoke("start_patient_consultation", { p_patient_id: 1, p_doctor_name: "Doctor 1", p_user_id_num: "admin1", p_accepted_at: accepted });
    await db.exec("SELECT pg_sleep(0.005)");
    await invoke("complete_patient_consultation", { p_patient_id: 1, p_doctor_name: "Doctor 1", p_user_id_num: "admin1",
      p_expected_started_at: started.consultation_started_at, p_reason: "Synthetic completion" });
    await rejectsUnchanged(() => requeue(snap), code("40001"));
    const completed = await patient(1);
    assert.equal(completed.status, "completed");
    assert.equal(completed.consultation_started_at, started.consultation_started_at);
  });

  test("WPS order after recovery: priority first, then the recovery time within the tier", async () => {
    await db.exec("UPDATE public.patients SET priority_score = 1, vulnerability_flags = '[]' WHERE id = 1");
    await requeue(await patient(1));
    await requeue(await patient(4));
    const order = (await db.query(`SELECT id FROM public.patients WHERE status = 'waiting' AND service_type = 'consultation'
      ORDER BY priority_score DESC, created_at, id`)).rows.map((r) => Number(r.id));
    assert.deepEqual(order, [8, 5, 1, 4], "senior first; recovered regulars after the regular already waiting, in recovery order");
  });

  test("only service_role may execute; SECURITY DEFINER with an empty search path", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, SIGNATURE])).rows[0].allowed, role === "service_role", role);
    }
    const security = (await db.query("SELECT prosecdef, proconfig, EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute FROM pg_proc WHERE oid = $1::regprocedure", [SIGNATURE])).rows[0];
    assert.equal(security.prosecdef, true);
    assert.ok(security.proconfig.includes('search_path=""'));
    assert.equal(security.public_execute, false);
    const snap = await patient(4);
    for (const role of ["anon", "authenticated"]) {
      const before = await snapshot();
      await db.exec(`SET ROLE ${role}`);
      try { await assert.rejects(requeue(snap), /permission denied/); }
      finally { await db.exec("RESET ROLE"); }
      assert.deepEqual(await snapshot(), before);
    }
    await db.exec("SET ROLE service_role");
    try { assert.equal((await requeue(snap)).status, "waiting"); }
    finally { await db.exec("RESET ROLE"); }
  });

  // Node service over the real SQL functions (reads from a synthetic copy, RPCs into PGlite).
  async function service({ withoutF5 = false } = {}) {
    const database = createDatabase();
    for (const [table, key] of [["patients", "id"], ["counters", "id"], ["users", "id_num"]]) {
      database[table] = (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} r ORDER BY ${key}`)).rows.map((row) => row.value);
    }
    return createHarness({ database, rpc: async (name, args) => {
      database.calls.push({ action: "rpc", function: name, args: clone(args) });
      if (withoutF5 && name === "requeue_patient_visit") return { data: null, error: { code: "PGRST202", message: "Function unavailable" } };
      try { return { data: await invoke(name, args), error: null }; }
      catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    } });
  }

  test("backend + SQL: serving visits are refused before any database write; a cancelled visit with a pointer is repaired", async () => {
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
    const before = await snapshot();
    const h = await service();
    for (const id of [2, 3, 5]) {
      const response = await h.request("POST", "/queue/requeue", { patient_id: id, reason: "Synthetic" });
      assert.equal(response.status, 409, response.body.message);
    }
    assert.equal(h.database.calls.filter((call) => call.action === "rpc").length, 0);
    assert.deepEqual(await snapshot(), before);
    const repaired = await h.request("POST", "/queue/requeue", { patient_id: 1, reason: "Synthetic" });
    assert.equal(repaired.status, 200, repaired.body.message);
    assert.deepEqual((await rows("counters")).map((c) => c.current_patient_id), [null, 2, 3]);
  });

  test("backend + SQL without the F5 function: pointer-free visits fall back to the existing RPC; a pointer is refused unchanged", async () => {
    const h = await service({ withoutF5: true });
    assert.equal((await h.request("POST", "/queue/requeue", { patient_id: 4, reason: "Synthetic" })).status, 200);
    assert.equal((await patient(4)).status, "waiting");
    await db.exec("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
    const before = await snapshot();
    const refused = await (await service({ withoutF5: true })).request("POST", "/queue/requeue", { patient_id: 1, reason: "Synthetic" });
    assert.equal(refused.status, 503);
    assert.deepEqual(await snapshot(), before);
  });
});
