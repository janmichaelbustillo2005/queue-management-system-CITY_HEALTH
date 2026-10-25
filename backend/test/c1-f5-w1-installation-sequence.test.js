// C1 + F5 + W1: the exact development installation sequence and its rollback, on disposable
// PostgreSQL 17 (see helpers/c1f5w1Fixture.js for the safety guards and starting schema).
// Order under test: C1 atomic Call -> F5 safe Requeue -> W1 atomic Cancel. For each step the
// migration's own preflight, the migration file itself and its own verification script are run
// as the non-superuser installer, followed by privilege, invariant and "nothing persisted" checks.
// Rollback runs the prepared per-migration rollback scripts, one migration at a time.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { SEQUENCE, C1, F5, W1, CALL, REQUEUE, CANCEL, HELPER } = f;
const ALL = [C1.migration, F5.migration, W1.migration];

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

async function assertPhaseB2(db) {
  const results = await f.scriptResults(db.setup, "20261023-phase-b2-verify.sql");
  assert.deepEqual(results.at(-1).rows, [{ result: "Phase B.2 verification passed; all synthetic fixtures are rolled back" }]);
}

// Representative consistent rows the scripts must leave untouched (synthetic).
async function seedVisits(db) {
  await db.observer.query(`
    INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at,
        consultation_started_at, completed_at, reason, priority_score) VALUES
      ('Synthetic waiting', 'GP-001', 'consultation', 'waiting', NULL, NULL, NULL, NULL, NULL, 1),
      ('Synthetic serving', 'OB-001', 'prenatal', 'serving', 'Doctor 2', now() - interval '5 minutes', NULL, NULL, NULL, 1),
      ('Synthetic completed', 'FP-001', 'family_planning', 'completed', 'Doctor 3', now() - interval '1 hour',
        now() - interval '50 minutes', now() - interval '40 minutes', NULL, 1),
      ('Synthetic cancelled', 'GP-002', 'consultation', 'cancelled', 'Doctor 1', NULL, NULL, now() - interval '30 minutes', 'Synthetic', 1);
    UPDATE public.counters SET current_patient_id = (SELECT id FROM public.patients WHERE queue_number = 'OB-001')
      WHERE id_num = 'Doctor 2';`);
}

describe("C1 -> F5 -> W1 installation sequence on the development-known schema", { skip: f.unavailable }, () => {
  let db;
  before(async () => {
    db = await f.createDatabase("c1f5w1_install");
    await seedVisits(db);
  });

  test("starting state matches the development project: B.2 verified, none of C1/F5/W1, no No-show label", async () => {
    await assertPhaseB2(db);
    for (const signature of [CALL, REQUEUE, CANCEL, HELPER]) assert.equal(await f.installed(db, signature), false, signature);
    assert.equal(await f.one(db, "SELECT count(*)::int AS value FROM pg_enum WHERE enumtypid = 'public.queue_status'::regtype AND enumlabel = 'no-show'"), 0);
    await f.assertConsistent(db);
  });

  for (const [index, step] of SEQUENCE.entries()) {
    test(`${index + 1}. ${step.name}: preflight passes, migration installs, verification passes`, async () => {
      const before = await f.snapshot(db);
      const preflight = await f.runChecks(db.setup, step, "preflight");
      // Inventory: aggregate counts only. The synthetic data is consistent, so every row is 0
      // (including "no-show label present", which is 0 on the development schema).
      const inventory = preflight.find((result) => "condition" in result.rows[0]);
      assert.deepEqual(inventory.rows.filter((row) => Number(row.rows) !== 0), []);

      await db.setup.query(f.read(step.migration));
      await f.runChecks(db.setup, step, "verify");

      for (const [signature, serviceRole] of Object.entries(step.functions)) {
        assert.deepEqual(await f.functionPrivileges(db, signature),
          { anon: false, authenticated: false, service_role: serviceRole, public: false, owner: "postgres" }, signature);
      }
      // Installation and verification wrote nothing that survived (verifies roll back).
      assert.deepEqual(await f.snapshot(db), before);
      await f.assertConsistent(db);
      // Every earlier step still verifies: a later migration did not alter an earlier one.
      for (const earlier of SEQUENCE.slice(0, index)) await f.runChecks(db.setup, earlier, "verify");
    });
  }

  test("combined state: all verifications, C1/W1/F5 preflights and Phase B.2 verification pass together", async () => {
    for (const step of SEQUENCE) {
      await f.runChecks(db.setup, step, "verify");
      await f.runChecks(db.setup, step, "preflight");
    }
    await assertPhaseB2(db);
    assert.equal(await f.one(db, "SELECT count(*)::int AS value FROM pg_enum WHERE enumtypid = 'public.queue_status'::regtype AND enumlabel = 'no-show'"), 0,
      "No-show must stay inactive");
    await f.assertConsistent(db);
  });

  test("re-running any migration file is harmless (CREATE OR REPLACE; grants reapplied)", async () => {
    const before = await f.snapshot(db);
    for (const script of ALL) await db.setup.query(f.read(script));
    for (const step of SEQUENCE) await f.runChecks(db.setup, step, "verify");
    assert.deepEqual(await f.snapshot(db), before);
  });

  test("the installer's view of dependencies: no catalog dependents; only Cancel calls the helper", async () => {
    const dependents = await f.one(db, `SELECT count(*)::int AS value FROM pg_depend d
      WHERE d.refclassid = 'pg_proc'::regclass AND d.deptype IN ('n', 'a')
        AND d.refobjid IN ($1::regprocedure, $2::regprocedure, $3::regprocedure, $4::regprocedure)`, [CALL, REQUEUE, CANCEL, HELPER]);
    assert.equal(dependents, 0);
    const { rows } = await db.observer.query(`SELECT p.oid::regprocedure::text AS caller, n.name AS callee
      FROM pg_proc p CROSS JOIN (VALUES ('call_patient_visit'), ('requeue_patient_visit'), ('cancel_patient_visit'),
        ('qms_resolve_doctor_counter')) AS n(name)
      WHERE p.prosrc ~ ('\\m' || n.name || '\\M') AND p.proname <> n.name ORDER BY 1, 2`);
    assert.deepEqual(rows, [{ caller: "cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)", callee: "qms_resolve_doctor_counter" }]);
  });
});

describe("per-migration rollback (exact signatures, no CASCADE)", { skip: f.unavailable }, () => {
  let db;
  let h;
  let tokens;
  before(async () => {
    db = await f.createDatabase("c1f5w1_rollback", ALL);
    await seedVisits(db);
    h = await f.backend(db);
    tokens = await f.signInAll(h);
  });

  test("a DROP with an inexact signature fails and removes nothing", async () => {
    await assert.rejects(db.setup.query("DROP FUNCTION public.requeue_patient_visit(bigint)"), { code: "42883" });
    await assert.rejects(db.setup.query("DROP FUNCTION public.cancel_patient_visit(bigint, uuid, text)"), { code: "42883" });
    for (const signature of [CALL, REQUEUE, CANCEL, HELPER]) assert.equal(await f.installed(db, signature), true);
  });

  test("a rollback refuses, dropping nothing, when another function body calls the target", async () => {
    await db.setup.query(`CREATE FUNCTION public.zz_synthetic_caller() RETURNS void LANGUAGE plpgsql AS
      $$ BEGIN PERFORM public.call_patient_visit(NULL, NULL, NULL, NULL, NULL, NULL); END $$`);
    try {
      await assert.rejects(db.setup.query(f.read(C1.rollback)), /C1 rollback refused: dependents \[none\], callers \[zz_synthetic_caller\(\)\]/);
      await db.setup.query("ROLLBACK").catch(() => {});
      assert.equal(await f.installed(db, CALL), true);
    } finally {
      await db.setup.query("DROP FUNCTION public.zz_synthetic_caller()");
    }
  });

  // Each migration is rolled back alone from the full installation, checked, then reinstalled.
  const cases = [
    { step: W1, removed: [CANCEL, HELPER], others: [C1, F5] },
    { step: F5, removed: [REQUEUE], others: [C1, W1] },
    { step: C1, removed: [CALL], others: [F5, W1] }
  ];
  for (const { step, removed, others } of cases) {
    test(`${step.name} rolled back alone: data, sessions, other migrations and Phase B.2 are untouched`, async () => {
      const before = await f.snapshot(db);
      await db.setup.query(f.read(step.rollback));
      for (const signature of removed) assert.equal(await f.installed(db, signature), false, signature);
      // Data and sessions are unchanged; a token issued before the rollback still works.
      assert.deepEqual(await f.snapshot(db), before);
      f.expectStatus(await f.post(h, tokens.frontdesk, "/auth/heartbeat", {}), 200);
      for (const other of others) await f.runChecks(db.setup, other, "verify");
      await assertPhaseB2(db);
      // The rolled-back state is a clean pre-installation state: its preflight passes again.
      await f.runChecks(db.setup, step, "preflight");
      // A second run reports "not installed" and changes nothing.
      await db.setup.query(f.read(step.rollback));
      assert.deepEqual(await f.snapshot(db), before);
      await f.assertConsistent(db);
      // Reinstalling restores exactly the verified function.
      await f.installStep(db, step);
      for (const other of others) await f.runChecks(db.setup, other, "verify");
    });
  }
});
