// I2 Finding 8 on PostgreSQL 17, C1/F5/W1 installed (the development project's state): when the
// API cannot resolve call_patient_visit for a moment (e.g. a stale PostgREST schema cache after a
// migration), Call refuses with 503 and changes nothing; it no longer slips into the non-atomic
// two-statement Call. Only ALLOW_LEGACY_TWO_STEP_CALL restores that path.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, register, expectStatus, patient, pointers, assertConsistent } = f;
const SIGNATURE = "(bigint,text,text,uuid,timestamptz,timestamptz)";

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

async function whileHidden(db, run) {
  await db.setup.query(`ALTER FUNCTION public.call_patient_visit${SIGNATURE} RENAME TO call_patient_visit_hidden`);
  try { return await run(); } finally {
    await db.setup.query(`ALTER FUNCTION public.call_patient_visit_hidden${SIGNATURE} RENAME TO call_patient_visit`);
  }
}

describe("I2 Finding 8: Call fails closed when C1 cannot be used", { skip: f.unavailable }, () => {
  test("service mode, function unresolvable: 503 with the C1 message, no write, no side effect; the next Call succeeds atomically", async () => {
    const db = await f.createDatabase("i2_fail_closed", [C1.migration, F5.migration, W1.migration]);
    const h = await f.backend(db);
    const tokens = await f.signInAll(h);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic fail closed", mobile: "09170000008" });
    const before = await f.snapshot(db);
    h.log.length = 0;
    const refused = await whileHidden(db, () => post(h, tokens.frontdesk, "/queue/call", { patient_id: id }));
    expectStatus(refused, 503, /atomic C1 database function/);
    assert.ok(h.rpcs().includes("call_patient_visit"), "C1 was attempted");
    assert.equal(h.tableWrites("counters").length + h.tableWrites("patients").length, 0, "the two-statement path did not run");
    assert.deepEqual(await f.snapshot(db), before, "nothing changed");
    assert.equal(h.sms.filter((entry) => entry.type === "called").length, 0);
    assert.equal(h.settings.isAwaitingAccept(id), false);

    // Once the function resolves again the same request is called through C1.
    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    assert.equal(h.tableWrites("counters").length + h.tableWrites("patients").length, 0, "called by C1 alone");
    assert.equal((await patient(db, id)).status, "serving");
    assert.equal((await pointers(db))["Doctor 1"], id);
    await assertConsistent(db);
  });

  test("with ALLOW_LEGACY_TWO_STEP_CALL the same situation uses the two-statement Call (the documented opt-in)", async () => {
    const db = await f.createDatabase("i2_fail_closed_optin", [C1.migration, F5.migration, W1.migration]);
    const h = await f.backend(db, { envOverrides: { allowLegacyTwoStepCall: true } });
    const tokens = await f.signInAll(h);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic opt-in" });
    h.log.length = 0;
    expectStatus(await whileHidden(db, () => post(h, tokens.frontdesk, "/queue/call", { patient_id: id })), 200);
    assert.ok(h.tableWrites("counters").length >= 1 && h.tableWrites("patients").length >= 1, "two-statement path");
    assert.equal((await patient(db, id)).status, "serving");
    assert.equal((await pointers(db))["Doctor 1"], id);
    await assertConsistent(db);
  });

  test("42703 raised inside an installed C1 is reported (503) and never falls back, even with the opt-in", async () => {
    const db = await f.createDatabase("i2_fail_closed_42703", [C1.migration, F5.migration, W1.migration]);
    // Simulate schema drift inside the function body: the installed C1 raises undefined_column.
    await db.setup.query(`ALTER FUNCTION public.call_patient_visit${SIGNATURE} RENAME TO call_patient_visit_real`);
    await db.setup.query(`CREATE FUNCTION public.call_patient_visit(p_patient_id bigint, p_doctor_name text, p_user_id_num text,
        p_expected_revision uuid, p_queue_start timestamptz, p_queue_end timestamptz)
      RETURNS SETOF public.patients LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = 'column "drifted" does not exist'; END $$`);
    await db.setup.query(`GRANT EXECUTE ON FUNCTION public.call_patient_visit${SIGNATURE} TO service_role`);
    try {
      for (const envOverrides of [{}, { allowLegacyTwoStepCall: true }]) {
        const h = await f.backend(db, { envOverrides });
        const tokens = await f.signInAll(h);
        const id = await register(h, db, tokens.frontdesk, { name: `Synthetic drift ${Object.keys(envOverrides).length}` });
        const before = await f.snapshot(db);
        h.log.length = 0;
        const response = await post(h, tokens.frontdesk, "/queue/call", { patient_id: id });
        assert.equal(response.status, 503, response.body?.message);
        assert.equal(h.tableWrites("counters").length + h.tableWrites("patients").length, 0, "no fallback");
        assert.deepEqual(await f.snapshot(db), before);
        await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "Synthetic cleanup" });
      }
    } finally {
      await db.setup.query(`DROP FUNCTION public.call_patient_visit${SIGNATURE}`);
      await db.setup.query(`ALTER FUNCTION public.call_patient_visit_real${SIGNATURE} RENAME TO call_patient_visit`);
    }
    await assertConsistent(db);
  });
});
