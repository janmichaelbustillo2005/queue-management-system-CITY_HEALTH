// I2 audit: the legacy two-statement Call fallback in service mode (aging off). It is used whenever
// call_patient_visit answers with a "missing function" code (PGRST202/PGRST204/42883/42703). On a
// database where C1 IS installed that still happens when the API cannot resolve the function for a
// moment (e.g. a stale PostgREST schema cache after a migration). This test pins today's behavior:
// the Call silently succeeds through the non-atomic path. It documents the finding; it does not
// assert that this is desired.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, register, expectStatus, patient, pointers, assertConsistent } = f;

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

describe("I2 audit: legacy C1 fallback with C1 installed", { skip: f.unavailable }, () => {
  test("service mode: when call_patient_visit cannot be resolved, Call falls back to the two-step writes and succeeds", async () => {
    const db = await f.createDatabase("i2_c1_fallback", [C1.migration, F5.migration, W1.migration]);
    const h = await f.backend(db);
    const tokens = await f.signInAll(h);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic fallback" });
    // Make the function unresolvable for one request, as a stale API schema cache would.
    await db.setup.query("ALTER FUNCTION public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz) RENAME TO call_patient_visit_hidden");
    try {
      h.log.length = 0;
      expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    } finally {
      await db.setup.query("ALTER FUNCTION public.call_patient_visit_hidden(bigint,text,text,uuid,timestamptz,timestamptz) RENAME TO call_patient_visit");
    }
    assert.ok(h.rpcs().includes("call_patient_visit"), "C1 was attempted first");
    assert.ok(h.tableWrites("counters").length >= 1 && h.tableWrites("patients").length >= 1,
      "FINDING: the call was then written by the non-atomic two-statement path, with no error or warning to the caller");
    assert.equal((await patient(db, id)).status, "serving");
    assert.equal((await pointers(db))["Doctor 1"], id);
    await assertConsistent(db);
  });

  test("shared mode and aging never fall back: the same situation refuses with 503 and changes nothing", async () => {
    const db = await f.createDatabase("i2_c1_fallback_shared", [C1.migration, F5.migration, W1.migration, "20261029-d1-shared-call.sql"]);
    const h = await f.backend(db, { doctorDispatchMode: "shared" });
    const tokens = await f.signInAll(h);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic shared fallback" });
    const before = await f.snapshot(db);
    await db.setup.query("ALTER FUNCTION public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz) RENAME TO call_patient_visit_shared_hidden");
    try {
      const response = await post(h, tokens.frontdesk, "/queue/call", { patient_id: id, counterId: "Doctor 2" });
      assert.equal(response.status, 503);
    } finally {
      await db.setup.query("ALTER FUNCTION public.call_patient_visit_shared_hidden(bigint,text,text,uuid,timestamptz,timestamptz) RENAME TO call_patient_visit_shared");
    }
    const after = await f.snapshot(db);
    assert.deepEqual(after.patients, before.patients);
    assert.deepEqual(after.counters, before.counters);
  });
});
