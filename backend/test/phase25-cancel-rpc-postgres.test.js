// R2.1 revision 2: isolated validation of the DRAFT cancel_patient_visit RPC.
// Executes the exact SQL block from docs/phase25-cancel-atomicity-proposal-rev2.md in a
// fresh, synthetic, in-memory PGlite database after the repository's Phase 2, A, 2.1, B
// and 2.2 migrations. Never loads .env, the Supabase client or the original schema/seed
// script, and never touches real patient data.
// PGlite has ONE connection. The "interleaving" tests run competing operations one after
// another with stale snapshots: they prove the snapshot, authorization and atomicity
// rules, NOT lock contention, deadlock freedom or lock timeouts between real sessions.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const {
  CANCEL, HELPER, MIGRATIONS, proposalSql, nodeFunction, read,
  BASE_SCHEMA, SUPABASE_DEFAULT_PRIVILEGES, ACCOUNTS, SEED
} = require("./helpers/phase25CancelFixture");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to the installed package.";
}

const resolveDoctorCounter = nodeFunction("resolveDoctorCounter");
const getDoctorForService = nodeFunction("getDoctorForService");

async function createDatabase() {
  const db = await PGlite.create();
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
  await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  await db.exec(BASE_SCHEMA);
  for (const script of MIGRATIONS) await db.exec(read(script));
  await db.exec(proposalSql());
  return db;
}

describe("R2.1 revision 2 cancel_patient_visit (isolated PGlite, single connection)", { skip: unavailable }, () => {
  let db;
  const actors = {};
  const accounts = ACCOUNTS;

  before(async () => { db = await createDatabase(); });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db.exec(SEED);
    for (const [idNum, [role, doctor]] of Object.entries(accounts)) actors[idNum] = await login(idNum, role, doctor);
  });

  async function login(idNum, role, doctor) {
    const session = randomUUID();
    const revision = (await db.query("SELECT auth_revision FROM public.users WHERE id_num = $1", [idNum])).rows[0].auth_revision;
    await db.query("SELECT public.create_staff_auth_session($1, $2, $3, $4, $5)", [session, idNum, role, doctor, revision]);
    return { session, idNum, role, doctor };
  }
  const patient = async (id) => (await db.query("SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id])).rows[0]?.value;
  const rows = async (table) => (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} r ORDER BY id`)).rows.map((row) => row.value);
  const state = async () => ({ patients: await rows("patients"), counters: await rows("counters") });
  const pointer = async (doctor) => (await db.query("SELECT current_patient_id FROM public.counters WHERE id_num = $1", [doctor])).rows[0].current_patient_id;
  const asRole = (role, sql, params = []) => db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE ${role}`);
    return tx.query(sql, params);
  });

  async function cancel(patientId, actorName, { reason = "Synthetic reason", requested = null, snapshot, overrides = {}, role = "service_role" } = {}) {
    const current = snapshot || await patient(patientId);
    const actor = actors[actorName];
    const args = {
      p_patient_id: patientId, p_session_id: actor.session, p_user_id_num: actor.idNum, p_role: actor.role,
      p_doctor_name: actor.doctor, p_expected_revision: current?.visit_state_revision ?? randomUUID(),
      p_expected_status: current?.status ?? "waiting", p_reason: reason, p_requested_counter: requested, ...overrides
    };
    const entries = Object.entries(args);
    const result = await asRole(role, `SELECT row_to_json(p) AS value FROM public.cancel_patient_visit(${
      entries.map(([key], index) => `${key} => $${index + 1}`).join(", ")}) p`, entries.map(([, value]) => value));
    return result.rows[0].value;
  }
  async function rejects(action, code) {
    await assert.rejects(action, (error) => { assert.equal(error.code, code, `${error.code}: ${error.message}`); return true; });
  }
  async function rejectsUnchanged(action, code) {
    const before = await state();
    await rejects(action, code);
    assert.deepEqual(await state(), before, "a rejected call must not commit anything");
  }
  // Every field except status, completed_at, reason, revision and (only under the B2 rule) counter_id is preserved.
  function assertCancelledFrom(after, before, { reason = "Synthetic reason", counterId = before.counter_id } = {}) {
    assert.equal(after.status, "cancelled");
    assert.equal(after.reason, reason);
    assert.ok(after.completed_at, "completed_at recorded");
    assert.notEqual(after.visit_state_revision, before.visit_state_revision);
    assert.equal(after.counter_id, counterId);
    assert.deepEqual({ ...after, status: before.status, reason: before.reason, completed_at: before.completed_at,
      visit_state_revision: before.visit_state_revision, counter_id: before.counter_id }, before);
  }

  // Node's existing two-step statements, issued as PostgREST would issue them.
  const call = {
    claim: (patientId, doctor) => db.query(`UPDATE public.counters SET current_patient_id = $1
      WHERE id_num = $2 AND is_online AND current_patient_id IS NULL RETURNING id`, [patientId, doctor]),
    serve: (patientId, doctor, serviceType) => db.query(`UPDATE public.patients SET status = 'serving', counter_id = $2,
      called_at = clock_timestamp() WHERE id = $1 AND status = 'waiting' AND service_type = $3
      AND completed_at IS NULL AND counter_id IS NULL RETURNING id`, [patientId, doctor, serviceType]),
    compensate: (patientId, doctor) => db.query(`UPDATE public.counters SET current_patient_id = NULL
      WHERE id_num = $2 AND current_patient_id = $1 RETURNING id`, [patientId, doctor])
  };
  const noShowCas = (snapshot) => db.query(`UPDATE public.patients SET status = 'no-show', completed_at = clock_timestamp(),
    reason = 'Synthetic no-show' WHERE id = $1 AND status = $2 AND visit_state_revision = $3 RETURNING id`,
  [snapshot.id, snapshot.status, snapshot.visit_state_revision]);
  const recallCas = (snapshot) => db.query(`UPDATE public.patients SET called_at = clock_timestamp()
    WHERE id = $1 AND status = 'serving' AND consultation_started_at IS NULL AND visit_state_revision = $2 RETURNING id`,
  [snapshot.id, snapshot.visit_state_revision]);
  const recover = async (fn, action, snapshot) => (await asRole("service_role", `SELECT row_to_json(p) AS value FROM public.${fn}(
    $1, $2, 'frontdesk', $3, $4, $5, $6, $7, $8, $9, $10) p`, [snapshot.id, action, snapshot.visit_state_revision, snapshot.status,
    snapshot.created_at, snapshot.called_at, snapshot.consultation_started_at, snapshot.completed_at, snapshot.counter_id,
    action === "requeue" ? "Synthetic requeue" : null])).rows[0].value;

  // ---------------------------------------------------------------------------
  describe("installation, ownership and grants", () => {
    test("installs from the document after Phase 2, A, 2.1, B and 2.2 and is repeatable", async () => {
      const before = await state();
      await db.exec(proposalSql());
      assert.deepEqual(await state(), before);
      const count = (await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('cancel_patient_visit', 'qms_resolve_doctor_counter')`)).rows[0].n;
      assert.equal(count, 2, "no extra overloads");
    });

    test("SECURITY DEFINER only on the RPC, empty search_path and 5s lock_timeout, owned by postgres", async () => {
      const { rows } = await db.query(`SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig,
        pg_get_userbyid(p.proowner) AS owner, p.provolatile FROM pg_proc p
        WHERE p.oid IN (to_regprocedure($1), to_regprocedure($2)) ORDER BY 1`, [CANCEL, HELPER]);
      assert.equal(rows.length, 2);
      const [rpc, helper] = rows[0].signature.startsWith("cancel") ? rows : [rows[1], rows[0]];
      assert.equal(rpc.prosecdef, true);
      assert.deepEqual(rpc.proconfig, ['search_path=""', "lock_timeout=5s"]);
      assert.equal(rpc.owner, "postgres");
      assert.equal(helper.prosecdef, false);
      assert.deepEqual(helper.proconfig, ['search_path=""']);
      assert.equal(helper.provolatile, "s");
      assert.equal(helper.owner, "postgres");
    });

    test("only service_role may execute the RPC; no API role may execute the helper, despite Supabase-style default grants", async () => {
      const privilege = async (role, signature) => (await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, signature])).rows[0].ok;
      for (const role of ["anon", "authenticated"]) {
        assert.equal(await privilege(role, CANCEL), false, `${role} on RPC`);
        assert.equal(await privilege(role, HELPER), false, `${role} on helper`);
      }
      assert.equal(await privilege("service_role", CANCEL), true);
      assert.equal(await privilege("service_role", HELPER), false);
      const acl = (await db.query("SELECT proacl::text[] AS acl FROM pg_proc WHERE oid = to_regprocedure($1)", [CANCEL])).rows[0].acl;
      assert.ok(!acl.some((entry) => entry.startsWith("=")), "no PUBLIC grant");
    });

    test("anon and authenticated cannot call the RPC or the helper; service_role cannot call the helper", async () => {
      for (const role of ["anon", "authenticated"]) {
        await rejectsUnchanged(() => cancel(1, "frontdesk", { role }), "42501");
        await rejects(() => asRole(role, "SELECT public.qms_resolve_doctor_counter('Doctor 1')"), "42501");
      }
      await rejects(() => asRole("service_role", "SELECT public.qms_resolve_doctor_counter('Doctor 1')"), "42501");
    });

    test("caller search_path and shadowing objects cannot redirect the RPC", async () => {
      await db.exec(`
        CREATE SCHEMA evil;
        CREATE TABLE evil.counters (id bigint, id_num text, current_patient_id bigint);
        CREATE FUNCTION evil.qms_resolve_doctor_counter(text) RETURNS bigint LANGUAGE sql AS 'SELECT 999::bigint';
        CREATE FUNCTION evil.btrim(text, text) RETURNS text LANGUAGE sql AS 'SELECT ''Doctor 2''';
        GRANT USAGE ON SCHEMA evil TO service_role;
      `);
      try {
        const before = await patient(2);
        const after = await db.transaction(async (tx) => {
          await tx.query("SET LOCAL search_path = evil, public, pg_catalog");
          await tx.query("SET LOCAL ROLE service_role");
          const a = actors.admin1;
          return (await tx.query(`SELECT row_to_json(p) AS value FROM public.cancel_patient_visit($1, $2, $3, $4, $5, $6, $7, $8) p`,
            [2, a.session, a.idNum, a.role, a.doctor, before.visit_state_revision, before.status, "Synthetic reason"])).rows[0].value;
        });
        assertCancelledFrom(after, before);
        assert.equal(await pointer("Doctor 1"), null);
      } finally {
        await db.exec("DROP SCHEMA evil CASCADE");
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("persisted session and account validation (B4)", () => {
    test("revoked (logout) and expired sessions are refused without writes", async () => {
      await db.query("SELECT public.revoke_staff_auth_session($1, $2)", [actors.admin1.session, "admin1"]);
      await rejectsUnchanged(() => cancel(2, "admin1"), "42501");
      await db.query(`UPDATE public.staff_auth_sessions SET created_at = clock_timestamp() - interval '9 hours',
        expires_at = clock_timestamp() - interval '1 second' WHERE session_id = $1`, [actors.frontdesk.session]);
      await rejectsUnchanged(() => cancel(1, "frontdesk"), "42501");
    });

    test("password change, auth_revision rotation and account deletion revoke the session", async () => {
      await db.query("UPDATE public.users SET password = 'changed-synthetic' WHERE id_num = 'admin1'");
      await rejectsUnchanged(() => cancel(2, "admin1"), "42501");
      await db.query("UPDATE public.users SET auth_revision = gen_random_uuid() WHERE id_num = 'frontdesk'");
      await rejectsUnchanged(() => cancel(1, "frontdesk"), "42501");
      await db.query("DELETE FROM public.users WHERE id_num = 'admin3'");
      await rejectsUnchanged(() => cancel(8, "admin3"), "42501");
    });

    test("a doctor reassignment refuses the old token even if the session row were not revoked", async () => {
      await db.query("UPDATE public.users SET doctor_name = 'Doctor 2' WHERE id_num = 'admin1'");
      await rejectsUnchanged(() => cancel(2, "admin1"), "42501");
      // Simulate a missing revocation: reinstate the session row with the old claims.
      await db.query("UPDATE public.staff_auth_sessions SET revoked_at = NULL WHERE session_id = $1", [actors.admin1.session]);
      await rejectsUnchanged(() => cancel(2, "admin1"), "42501");
      await rejectsUnchanged(() => cancel(3, "admin1"), "42501");
    });

    test("client-controlled identity parameters cannot impersonate another actor", async () => {
      const a = actors.admin2;
      await rejectsUnchanged(() => cancel(2, "admin2", { overrides: { p_user_id_num: "admin1", p_doctor_name: "Doctor 1" } }), "42501");
      await rejectsUnchanged(() => cancel(2, "admin1", { overrides: { p_session_id: a.session } }), "42501");
      await rejectsUnchanged(() => cancel(2, "admin1", { overrides: { p_session_id: randomUUID() } }), "42501");
      await rejectsUnchanged(() => cancel(3, "admin1", { overrides: { p_role: "superadmin" } }), "42501");
      await rejectsUnchanged(() => cancel(3, "admin1", { overrides: { p_doctor_name: "Doctor 2" } }), "42501");
      await rejectsUnchanged(() => cancel(3, "admin1", { overrides: { p_doctor_name: null } }), "42501");
      await rejectsUnchanged(() => cancel(3, "frontdesk2", { overrides: { p_doctor_name: null } }), "42501");
      await rejectsUnchanged(() => cancel(3, "frontdesk", { overrides: { p_user_id_num: "nobody" } }), "42501");
    });
  });

  // ---------------------------------------------------------------------------
  describe("canonical doctor/counter ownership (B1, B2)", () => {
    const inputs = ["Doctor 1", "doctor 1", "DOCTOR 2", " Doctor 3 ", "\tDoctor 1\n", "Doctor1", "doctor01", "doctor 01",
      "doctor  2", "doctor\t3", "1", "01", "2", "3", "4", "0", "Doctor 4", "Doctor 1x", "Front Desk", "", "   ", null];
    const layouts = {
      seeded: ["Doctor 1", "Doctor 2", "Doctor 3"],
      misaligned: ["Doctor 3", "Doctor 1", "Doctor 2"],
      colliding: ["Doctor 2", "doctor 1", "Doctor 1", " Doctor 3"]
    };
    for (const [layout, names] of Object.entries(layouts)) {
      test(`helper matches Node resolveDoctorCounter for every input (${layout} counter ids)`, async () => {
        await db.exec("TRUNCATE public.counters RESTART IDENTITY");
        for (const name of names) await db.query("INSERT INTO public.counters (id_num) VALUES ($1)", [name]);
        const counters = (await db.query("SELECT id::int AS id, id_num FROM public.counters ORDER BY id")).rows;
        for (const input of inputs) {
          const sql = (await db.query("SELECT public.qms_resolve_doctor_counter($1)::int AS id", [input])).rows[0].id;
          assert.equal(sql, resolveDoctorCounter(input, counters)?.id ?? null, `input ${JSON.stringify(input)}`);
        }
      });
    }

    test("owner mapping matches getDoctorForService for every service type and an unknown one", async () => {
      for (const serviceType of ["consultation", "checkup", "prenatal", "maternity", "family_planning", "dental", "unknown"]) {
        for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) {
          const id = (await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type)
            VALUES ('Synthetic mapping', 'MAP-1', $1) RETURNING id`, [serviceType])).rows[0].id;
          const actor = `admin${doctor.slice(-1)}`;
          if (getDoctorForService(serviceType) === doctor) assert.equal((await cancel(id, actor)).status, "cancelled");
          else await rejectsUnchanged(() => cancel(id, actor), "42501");
        }
      }
    });

    test("doctors cancel only their own visits; orphan serving visits are Frontdesk/Superadmin only", async () => {
      await rejectsUnchanged(() => cancel(2, "admin2"), "42501");
      await rejectsUnchanged(() => cancel(1, "admin3"), "42501");
      await rejectsUnchanged(() => cancel(7, "admin1"), "42501");
      const before = await patient(2);
      assertCancelledFrom(await cancel(2, "admin1"), before);
      assert.equal(await pointer("Doctor 1"), null);
      assert.equal(await pointer("Doctor 2"), 3, "another patient's counter is untouched");
      const orphan = await patient(7);
      assertCancelledFrom(await cancel(7, "frontdesk"), orphan);
    });

    test("a stored counter_id alias resolves for its doctor and an unresolvable one fails closed for doctors only", async () => {
      await db.query("UPDATE public.patients SET counter_id = 'doctor 02' WHERE id = 3");
      const aliased = await patient(3);
      assertCancelledFrom(await cancel(3, "admin2"), aliased);
      assert.equal(await pointer("Doctor 2"), null);
      await db.query("UPDATE public.patients SET counter_id = 'Doctor 9' WHERE id = 1");
      await rejectsUnchanged(() => cancel(1, "admin1"), "42501");
      assert.equal((await cancel(1, "superadmin")).status, "cancelled");
    });

    test("requested doctor is a consistency check; B2 stamps only an owned, blank assignment", async () => {
      await rejectsUnchanged(() => cancel(1, "frontdesk", { requested: "Doctor 2" }), "QM003");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { requested: "Doctor 9" }), "22023");
      await rejectsUnchanged(() => cancel(2, "admin1", { requested: "Doctor 3" }), "QM003");
      const waiting = await patient(1);
      assertCancelledFrom(await cancel(1, "frontdesk", { requested: "doctor 01" }), waiting, { counterId: "Doctor 1" });
      const unrequested = await patient(8);
      assertCancelledFrom(await cancel(8, "frontdesk"), unrequested, { counterId: null });
      const orphan = await patient(7);
      assertCancelledFrom(await cancel(7, "frontdesk", { requested: "Doctor 2" }), orphan, { counterId: null });
      const assigned = await patient(3);
      assertCancelledFrom(await cancel(3, "superadmin", { requested: "2" }), assigned, { counterId: "Doctor 2" });
    });

    test("ambiguous aliases follow the same lowest-id rule as Node, for authorization too", async () => {
      // Counter ids no longer line up with names: id 1 = "Doctor 2", id 2 = "Doctor 1".
      await db.exec(`UPDATE public.counters SET id_num = 'tmp' WHERE id = 1;
        UPDATE public.counters SET id_num = 'Doctor 1' WHERE id = 2; UPDATE public.counters SET id_num = 'Doctor 2' WHERE id = 1;`);
      await db.query("UPDATE public.users SET doctor_name = '1' WHERE id_num = 'admin3'");
      const claims = await login("admin3", "admin", "1");
      actors.admin3 = claims;
      const counters = (await db.query("SELECT id::int AS id, id_num FROM public.counters ORDER BY id")).rows;
      assert.equal(resolveDoctorCounter("1", counters).id_num, "Doctor 2", "Node: numeric id wins over the alias");
      // admin3 ("1") therefore owns Doctor 2's visits, in Node and in SQL.
      const ob = await patient(3);
      assertCancelledFrom(await cancel(3, "admin3"), ob);
      await rejectsUnchanged(() => cancel(1, "admin3"), "42501");
    });
  });

  // ---------------------------------------------------------------------------
  describe("arguments, terminal states and SQLSTATEs", () => {
    test("argument and reason validation (22023)", async () => {
      await rejectsUnchanged(() => cancel(0, "frontdesk", { snapshot: { visit_state_revision: randomUUID(), status: "waiting" } }), "22023");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { overrides: { p_session_id: null } }), "22023");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { overrides: { p_user_id_num: " \t" } }), "22023");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { overrides: { p_role: null } }), "22023");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { overrides: { p_expected_revision: null } }), "22023");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { overrides: { p_expected_status: null } }), "22023");
      for (const reason of [null, "", "   ", "\t\n"]) await rejectsUnchanged(() => cancel(1, "frontdesk", { reason }), "22023");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { reason: "x".repeat(1001) }), "22023");
      const before = await patient(1);
      assertCancelledFrom(await cancel(1, "frontdesk", { reason: `  ${"y".repeat(1000)}\t` }), before, { reason: "y".repeat(1000) });
    });

    test("unknown patient is 404 only after the caller is identified (P0002 vs 42501)", async () => {
      await rejectsUnchanged(() => cancel(999, "frontdesk"), "P0002");
      await rejectsUnchanged(() => cancel(999, "frontdesk", { overrides: { p_session_id: randomUUID() } }), "42501");
    });

    test("completed (QM001) and no-show (QM002) are refused with history intact", async () => {
      await rejectsUnchanged(() => cancel(4, "admin1"), "QM001");
      await rejectsUnchanged(() => cancel(4, "superadmin"), "QM001");
      await rejectsUnchanged(() => cancel(5, "admin3"), "QM002");
      await rejectsUnchanged(() => cancel(5, "frontdesk"), "QM002");
    });

    test("stale revision and stale status are 40001", async () => {
      const stale = await patient(3);
      await recallCas(stale);
      await rejectsUnchanged(() => cancel(3, "admin2", { snapshot: stale }), "40001");
      const current = await patient(3);
      await rejectsUnchanged(() => cancel(3, "admin2", { snapshot: { ...current, status: "waiting" } }), "40001");
    });

    test("idempotent repeat writes no patient row and keeps the original reason and revision", async () => {
      const before = await patient(6);
      const repeat = await cancel(6, "frontdesk", { reason: "A different reason" });
      assert.deepEqual(repeat, before);
      assert.deepEqual(await patient(6), before);
      await rejectsUnchanged(() => cancel(6, "admin2"), "42501");
    });

    test("idempotent repeat releases stale pointers (W1) including duplicates (W2), only for that visit", async () => {
      await db.query("UPDATE public.counters SET current_patient_id = 6 WHERE id_num IN ('Doctor 1', 'Doctor 3')");
      await rejectsUnchanged(() => cancel(6, "admin2"), "42501");
      const before = await patient(6);
      assert.deepEqual(await cancel(6, "admin1"), before);
      assert.equal(await pointer("Doctor 1"), null);
      assert.equal(await pointer("Doctor 3"), null);
      assert.equal(await pointer("Doctor 2"), 3);
    });

    test("a fresh cancel releases every counter pointing at the visit and no other", async () => {
      await db.query("UPDATE public.counters SET current_patient_id = 2 WHERE id_num = 'Doctor 3'");
      const before = await patient(2);
      assertCancelledFrom(await cancel(2, "frontdesk2"), before);
      assert.deepEqual((await rows("counters")).map((c) => c.current_patient_id), [null, 3, null]);
    });
  });

  // ---------------------------------------------------------------------------
  describe("transaction rollback (no partial commit)", () => {
    async function withTrigger(sql, drop, action) {
      await db.exec(sql);
      try { await action(); } finally { await db.exec(drop); }
    }

    test("a failing counter release rolls back the patient cancellation", async () => {
      await withTrigger(`
        CREATE FUNCTION public.test_fail_release() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.current_patient_id IS NULL THEN RAISE EXCEPTION 'synthetic release failure' USING ERRCODE = 'XX001'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_fail_release BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.test_fail_release();`,
      "DROP TRIGGER test_fail_release ON public.counters; DROP FUNCTION public.test_fail_release();",
      () => rejectsUnchanged(() => cancel(2, "admin1"), "XX001"));
    });

    test("a suppressed counter release is QM500 and rolls back", async () => {
      await withTrigger(`
        CREATE FUNCTION public.test_skip_release() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.current_patient_id IS NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_skip_release BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.test_skip_release();`,
      "DROP TRIGGER test_skip_release ON public.counters; DROP FUNCTION public.test_skip_release();",
      async () => {
        await rejectsUnchanged(() => cancel(2, "admin1"), "QM500");
        await db.query("UPDATE public.counters SET current_patient_id = 6 WHERE id_num = 'Doctor 3'");
        await rejectsUnchanged(() => cancel(6, "frontdesk"), "QM500");
      });
    });

    test("a suppressed patient update is QM500 and leaves the counter claimed", async () => {
      await withTrigger(`
        CREATE FUNCTION public.test_skip_patient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER zz_test_skip_patient BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.test_skip_patient();`,
      "DROP TRIGGER zz_test_skip_patient ON public.patients; DROP FUNCTION public.test_skip_patient();",
      () => rejectsUnchanged(() => cancel(2, "admin1"), "QM500"));
    });

    test("a patient update that keeps the old revision (trigger missing) is QM500", async () => {
      await withTrigger("ALTER TABLE public.patients DISABLE TRIGGER patients_rotate_visit_revision;",
        "ALTER TABLE public.patients ENABLE TRIGGER patients_rotate_visit_revision;",
        () => rejectsUnchanged(() => cancel(1, "frontdesk"), "QM500"));
    });
  });

  // ---------------------------------------------------------------------------
  describe("sequential interleavings with stale snapshots (single connection; not lock-contention proof)", () => {
    test("1. Cancel vs Cancel: exactly one transition; the loser is 40001; a fresh retry is an idempotent repeat", async () => {
      const snapshot = await patient(3);
      const first = await cancel(3, "frontdesk", { snapshot, reason: "First" });
      await rejectsUnchanged(() => cancel(3, "superadmin", { snapshot, reason: "Second" }), "40001");
      assert.deepEqual(await cancel(3, "superadmin", { reason: "Second" }), first);
      assert.equal((await patient(3)).reason, "First");
    });

    test("2. Cancel vs Complete: completed history is never overwritten; a completed visit is never cancelled", async () => {
      const snapshot = await patient(2);
      const completed = (await asRole("service_role", `SELECT row_to_json(p) AS value FROM public.complete_patient_consultation(
        2, 'Doctor 1', 'admin1', $1, 'Synthetic completion') p`, [snapshot.consultation_started_at])).rows[0].value;
      await rejectsUnchanged(() => cancel(2, "admin1", { snapshot }), "40001");
      await rejectsUnchanged(() => cancel(2, "admin1"), "QM001");
      assert.deepEqual(await patient(2), completed);
      // Reverse order: Cancel first, then the delayed Complete fails and changes nothing.
      const ob = await patient(3);
      await db.query("UPDATE public.patients SET consultation_started_at = clock_timestamp() - interval '1 minute' WHERE id = 3");
      const started = await patient(3);
      await cancel(3, "admin2");
      await rejectsUnchanged(() => asRole("service_role", `SELECT public.complete_patient_consultation(3, 'Doctor 2', 'admin2', $1, NULL)`,
        [started.consultation_started_at]), "42501");
      assert.equal((await patient(3)).status, "cancelled");
      assert.equal((await patient(3)).consultation_started_at, started.consultation_started_at);
      assert.equal(ob.called_at, (await patient(3)).called_at);
    });

    test("3. Cancel vs No-show (Node's two-step CAS): exactly one terminal transition", async () => {
      const snapshot = await patient(3);
      assert.equal((await noShowCas(snapshot)).rows.length, 1);
      await rejectsUnchanged(() => cancel(3, "admin2", { snapshot }), "40001");
      await rejectsUnchanged(() => cancel(3, "admin2"), "QM002");
      const other = await patient(2);
      await cancel(2, "admin1");
      assert.equal((await noShowCas(other)).rows.length, 0, "a delayed No-show matches no row");
      assert.equal((await patient(2)).status, "cancelled");
    });

    test("4. Cancel vs Recall: a recall rotates the revision; a delayed recall after Cancel changes nothing", async () => {
      const snapshot = await patient(3);
      assert.equal((await recallCas(snapshot)).rows.length, 1);
      await rejectsUnchanged(() => cancel(3, "admin2", { snapshot }), "40001");
      const recalled = await patient(3);
      await cancel(3, "admin2");
      assert.equal((await recallCas(recalled)).rows.length, 0);
      assert.equal((await patient(3)).called_at, recalled.called_at);
    });

    test("5. Cancel vs Requeue: stale either way; existing Requeue of a serving visit leaves its counter pointer", async () => {
      const noShow = await patient(5);
      await recover("recover_patient_visit", "requeue", noShow);
      await rejectsUnchanged(() => cancel(5, "admin3", { snapshot: noShow }), "40001");
      const serving = await patient(3);
      await cancel(3, "frontdesk");
      await rejectsUnchanged(() => recover("recover_patient_visit", "requeue", serving), "40001");
      // Existing behavior (review item 12): Requeue from serving keeps the doctor's pointer.
      const inConsultation = await patient(2);
      const requeued = await recover("recover_patient_visit", "requeue", inConsultation);
      assert.equal(requeued.consultation_started_at, null, "existing Requeue erases the in-progress start");
      assert.equal(await pointer("Doctor 1"), 2, "existing Requeue leaves the stale pointer");
      assertCancelledFrom(await cancel(2, "frontdesk"), requeued);
      assert.equal(await pointer("Doctor 1"), null, "the atomic Cancel releases it");
    });

    test("6. Cancel vs Undo: a delayed repeat Cancel after Undo is 40001, never 'already cancelled'", async () => {
      const serving = await patient(3);
      const cancelled = await cancel(3, "admin2");
      const restored = await recover("undo_patient_visit_waiting", "undo", cancelled);
      assert.equal(restored.status, "waiting");
      await rejectsUnchanged(() => cancel(3, "admin2", { snapshot: cancelled }), "40001");
      await rejectsUnchanged(() => cancel(3, "admin2", { snapshot: serving }), "40001");
      await rejectsUnchanged(() => recover("undo_patient_visit_waiting", "undo", cancelled), "40001");
    });

    test("7a. Cancel between Call's counter claim and patient update releases the claim; Call then fails cleanly", async () => {
      const snapshot = await patient(8);
      assert.equal((await call.claim(8, "Doctor 3")).rows.length, 1);
      assertCancelledFrom(await cancel(8, "admin3", { snapshot }), snapshot);
      assert.equal(await pointer("Doctor 3"), null);
      assert.equal((await call.serve(8, "Doctor 3", "family_planning")).rows.length, 0);
      assert.equal((await call.compensate(8, "Doctor 3")).rows.length, 0);
      assert.equal((await patient(8)).status, "cancelled");
    });

    test("7b. Call claiming after a committed Cancel points a counter at a cancelled visit (known gap C1); a repeat Cancel repairs it", async () => {
      await cancel(8, "frontdesk");
      assert.equal((await call.claim(8, "Doctor 3")).rows.length, 1, "C1: the claim is not prevented by the database");
      assert.equal((await call.serve(8, "Doctor 3", "family_planning")).rows.length, 0);
      // Simulate a crash before compensation, then the documented repair.
      assert.equal(await pointer("Doctor 3"), 8);
      const cancelled = await patient(8);
      assert.deepEqual(await cancel(8, "admin3"), cancelled);
      assert.equal(await pointer("Doctor 3"), null);
    });

    test("7c. A completed Call makes the waiting snapshot stale; a fresh Cancel releases the doctor", async () => {
      const waiting = await patient(8);
      await call.claim(8, "Doctor 3");
      await call.serve(8, "Doctor 3", "family_planning");
      await rejectsUnchanged(() => cancel(8, "admin3", { snapshot: waiting }), "40001");
      const serving = await patient(8);
      assertCancelledFrom(await cancel(8, "admin3"), serving);
      assert.equal(await pointer("Doctor 3"), null);
    });

    test("8. Logout or session revocation between Node's check and the RPC refuses the cancel", async () => {
      const snapshot = await patient(2);
      await db.query("SELECT public.revoke_staff_user_sessions('admin1')");
      await rejectsUnchanged(() => cancel(2, "admin1", { snapshot }), "42501");
    });

    test("9. Counter reassignment or rename during cancellation never releases another patient's counter", async () => {
      const snapshot = await patient(2);
      // The pointer moves to another visit after the snapshot: Cancel must not release it.
      await db.query("UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1'");
      assertCancelledFrom(await cancel(2, "admin1", { snapshot }), snapshot);
      assert.equal(await pointer("Doctor 1"), 1);
      // Renamed counter: the stored assignment no longer resolves, so doctors fail closed.
      await db.query("UPDATE public.counters SET id_num = 'Doctor 2 relief' WHERE id_num = 'Doctor 2'");
      await rejectsUnchanged(() => cancel(3, "admin2"), "42501");
      const ob = await patient(3);
      assertCancelledFrom(await cancel(3, "frontdesk"), ob);
      assert.equal(await pointer("Doctor 2 relief"), null);
    });

    test("10. ABA: an old revision is refused even when the status matches again", async () => {
      const original = await patient(1);
      const cancelled = await cancel(1, "frontdesk");
      await recover("undo_patient_visit_waiting", "undo", cancelled);
      assert.equal((await patient(1)).status, "waiting");
      await rejectsUnchanged(() => cancel(1, "frontdesk", { snapshot: original }), "40001");
    });
  });
});

// ---------------------------------------------------------------------------
// Supabase's postgres role is not a superuser. Run the RPC with a non-superuser,
// non-BYPASSRLS owner that owns the tables, as the preflight requires.
describe("R2.1 revision 2 with a non-superuser function and table owner (isolated PGlite)", { skip: unavailable }, () => {
  let db;
  before(async () => {
    db = await createDatabase();
    await db.exec(`
      CREATE ROLE app_owner NOSUPERUSER NOBYPASSRLS NOLOGIN;
      ALTER TABLE public.users OWNER TO app_owner; ALTER TABLE public.patients OWNER TO app_owner;
      ALTER TABLE public.counters OWNER TO app_owner; ALTER TABLE public.staff_auth_sessions OWNER TO app_owner;
      ALTER FUNCTION ${HELPER} OWNER TO app_owner; ALTER FUNCTION ${CANCEL} OWNER TO app_owner;
      INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ('frontdesk', 'synthetic', 'admin', NULL);
      INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at)
        VALUES ('Synthetic owner test', 'GP-001', 'consultation', 'serving', 'Doctor 1', clock_timestamp());
      INSERT INTO public.counters (id_num, current_patient_id) VALUES ('Doctor 1', 1), ('Doctor 2', NULL), ('Doctor 3', NULL);
    `);
  });
  after(async () => { if (db) await db.close(); });

  async function cancelAsService() {
    const session = randomUUID();
    const revision = (await db.query("SELECT auth_revision FROM public.users WHERE id_num = 'frontdesk'")).rows[0].auth_revision;
    await db.query("SELECT public.create_staff_auth_session($1, 'frontdesk', 'admin', NULL, $2)", [session, revision]);
    const current = (await db.query("SELECT visit_state_revision, status::text FROM public.patients WHERE id = 1")).rows[0];
    return db.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE service_role");
      return (await tx.query("SELECT (public.cancel_patient_visit(1, $1, 'frontdesk', 'admin', NULL, $2, $3, 'Synthetic reason')).status::text AS status",
        [session, current.visit_state_revision, current.status])).rows[0].status;
    });
  }

  test("FORCE ROW LEVEL SECURITY on patients makes the owner fail closed (preflight must check it)", async () => {
    await db.exec("ALTER TABLE public.patients FORCE ROW LEVEL SECURITY");
    await assert.rejects(cancelAsService, (error) => error.code === "P0002");
    assert.equal((await db.query("SELECT status::text FROM public.patients WHERE id = 1")).rows[0].status, "serving");
    await db.exec("ALTER TABLE public.patients NO FORCE ROW LEVEL SECURITY");
  });

  test("RLS-enabled tables owned by the definer: cancels and releases as service_role", async () => {
    assert.equal(await cancelAsService(), "cancelled");
    assert.equal((await db.query("SELECT current_patient_id FROM public.counters WHERE id_num = 'Doctor 1'")).rows[0].current_patient_id, null);
  });
});
