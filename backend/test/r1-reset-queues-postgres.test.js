// R1: Reset Queues (POST /queue/clear) through the REAL backend on disposable PostgreSQL 17
// (helpers/c1f5w1Fixture.js, C1 + F5 + W1 installed). Reset archived each active visit and then
// released every counter that pointed at any archived id in a separate statement: the same
// two-step shape as the pre-W1 Cancel. A Requeue + Call of an archived visit committed between
// the two steps had its new, valid counter pointer cleared, leaving a serving visit without its
// doctor counter. Reset now cancels each visit through W1 (atomic per visit, releasing only a
// pointer that still names it) when W1 is installed.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, register, expectStatus, patient, pointers, assertConsistent } = f;

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

describe("R1: Reset Queues never clears a later valid call's counter", { skip: f.unavailable }, () => {
  let db;
  before(async () => { db = await f.createDatabase("r1_reset_queues", [C1.migration, F5.migration, W1.migration]); });
  beforeEach(() => f.resetQueue(db));

  test("Requeue + Call of an archived visit, committed while Reset is still running, keeps its counter", async () => {
    const plain = await f.backend(db);
    const tokens = await f.signInAll(plain);
    const x = await register(plain, db, tokens.frontdesk, { name: "Synthetic R1 serving" });
    expectStatus(await post(plain, tokens.frontdesk, "/queue/call", { patient_id: x }), 200);
    const y = await register(plain, db, tokens.frontdesk, { name: "Synthetic R1 waiting", service: "prenatal" });

    let interleaved = false;
    const other = await f.backend(db);
    const resetting = await f.backend(db, {
      pause: async () => {
        if (interleaved || (await patient(db, x)).status !== "cancelled") return;
        interleaved = true;
        // Another Frontdesk tab, between Reset's steps: Requeue and Call the archived visit.
        expectStatus(await post(other, tokens.frontdesk, "/queue/requeue", { patient_id: x }), 200);
        expectStatus(await post(other, tokens.frontdesk, "/queue/call", { patient_id: x }), 200);
      }
    });
    expectStatus(await post(resetting, tokens.superadmin, "/queue/clear", {}), 200);
    assert.ok(interleaved, "the Requeue + Call ran inside the Reset");

    const row = await patient(db, x);
    assert.equal(row.status, "serving");
    assert.equal(row.counter_id, "Doctor 1");
    assert.equal((await pointers(db))["Doctor 1"], x, "the new call keeps its doctor counter");
    assert.equal((await patient(db, y)).status, "cancelled");
    await assertConsistent(db);
  });

  test("Reset archives every active visit of today, releases their counters and keeps history", async () => {
    const h = await f.backend(db);
    const tokens = await f.signInAll(h);
    const waiting = await register(h, db, tokens.frontdesk, { name: "Synthetic R1 a" });
    const serving = await register(h, db, tokens.frontdesk, { name: "Synthetic R1 b", service: "family_planning" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: serving }), 200);
    expectStatus(await post(h, tokens.admin3, "/queue/accept", { patient_id: serving }), 200);
    expectStatus(await post(h, tokens.admin3, "/queue/start", { patient_id: serving }), 200);
    const done = await register(h, db, tokens.frontdesk, { name: "Synthetic R1 done", service: "prenatal" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: done }), 200);
    expectStatus(await post(h, tokens.admin2, "/queue/accept", { patient_id: done }), 200);
    expectStatus(await post(h, tokens.admin2, "/queue/start", { patient_id: done }), 200);
    expectStatus(await post(h, tokens.admin2, "/queue/complete", { patient_id: done }), 200);
    const before = { serving: await patient(db, serving), done: await patient(db, done) };

    expectStatus(await post(h, tokens.frontdesk, "/queue/clear", {}), 403);
    expectStatus(await post(h, tokens.superadmin, "/queue/clear", {}), 200);
    for (const id of [waiting, serving]) {
      const row = await patient(db, id);
      assert.equal(row.status, "cancelled");
      assert.equal(row.reason, "System queue reset");
      assert.ok(row.completed_at);
    }
    assert.equal((await patient(db, serving)).consultation_started_at, before.serving.consultation_started_at);
    assert.deepEqual(await patient(db, done), before.done, "completed history is untouched");
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    await assertConsistent(db);
  });
});
