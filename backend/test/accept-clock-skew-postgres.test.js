// Acceptance vs. call time across two clocks, through the REAL backend on disposable PostgreSQL 17
// (helpers/c1f5w1Fixture.js). With C1 installed, called_at comes from PostgreSQL's clock while the
// acceptance time is recorded by the Node backend. The backend host (the clinic computer) and the
// hosted database are different machines, so their clocks may differ by seconds. Start
// Consultation requires acceptance at or after the call; an acceptance recorded for the current
// call must satisfy that whatever the skew, while an acceptance from an earlier call cycle must
// still never start a later one.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, register, expectStatus, patient, pointers, assertConsistent } = f;

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

describe("Accept then Start when the backend clock differs from the database clock", { skip: f.unavailable }, () => {
  let db;
  before(async () => {
    db = await f.createDatabase("accept_clock_skew", [C1.migration, F5.migration, W1.migration]);
  });
  beforeEach(() => f.resetQueue(db));

  for (const [label, clockOffsetMs] of [["30 s behind", -30000], ["2 s behind", -2000], ["in step", 0], ["30 s ahead", 30000]]) {
    test(`backend clock ${label}: Call -> Accept -> Start -> Complete succeeds immediately`, async () => {
      const h = await f.backend(db, { clockOffsetMs });
      const tokens = await f.signInAll(h);
      const id = await register(h, db, tokens.frontdesk, { name: "Synthetic skew" });
      expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
      const called = await patient(db, id);
      const accept = await post(h, tokens.admin1, "/queue/accept", { patient_id: id });
      expectStatus(accept, 200);
      assert.ok(Date.parse(accept.body.accepted_at) >= Date.parse(called.called_at), "recorded acceptance is not before the call");
      expectStatus(await post(h, tokens.admin1, "/queue/start", { patient_id: id }), 200);
      expectStatus(await post(h, tokens.admin1, "/queue/complete", { patient_id: id }), 200);
      assert.equal((await patient(db, id)).status, "completed");
      assert.equal((await pointers(db))["Doctor 1"], null);
      await assertConsistent(db);
    });
  }

  test("backend clock 30 s behind: an acceptance from an earlier call cycle cannot start the next call", async () => {
    const h = await f.backend(db, { clockOffsetMs: -30000 });
    const tokens = await f.signInAll(h);
    const id = await register(h, db, tokens.frontdesk, { name: "Synthetic recycled" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/accept", { patient_id: id }), 200);
    // Cancel (W1), Requeue (F5) and Call again (C1): a new call cycle.
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "Synthetic" }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id }), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    const start = await post(h, tokens.admin1, "/queue/start", { patient_id: id });
    assert.equal(start.status, 400);
    assert.match(start.body.message, /Accept/);
    assert.equal((await patient(db, id)).consultation_started_at, null);
    // Accepting the new call then allows the start.
    expectStatus(await post(h, tokens.admin1, "/queue/accept", { patient_id: id }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/start", { patient_id: id }), 200);
    await assertConsistent(db);
  });
});
