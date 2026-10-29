// E2E-1 Test C (W1 Cancel -> F5 Requeue -> C1 Call -> Complete) and Test D (three independent
// doctor queues) through the REAL backend on disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js:
// loopback cluster, synthetic rows, C1 + F5 + W1 installed). Set E2E1_EVIDENCE_DIR to write the
// step-by-step evidence as JSON.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, register, expectStatus, effects, patient, pointers, assertConsistent } = f;
const evidence = {};

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(async () => {
  if (process.env.E2E1_EVIDENCE_DIR && Object.keys(evidence).length) {
    fs.mkdirSync(process.env.E2E1_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.E2E1_EVIDENCE_DIR, "test-c-d-evidence.json"), JSON.stringify(evidence, null, 2));
  }
  await f.stopCluster();
});

const pick = (row) => row && {
  queue_number: row.queue_number, status: row.status, counter_id: row.counter_id, reason: row.reason,
  created_at: row.created_at, called_at: row.called_at, consultation_started_at: row.consultation_started_at,
  completed_at: row.completed_at, revision: row.visit_state_revision
};

describe("E2E-1 Test C and Test D on the real backend", { skip: f.unavailable }, () => {
  let db; let h; let tokens;
  before(async () => {
    db = await f.createDatabase("e2e1_test_cd", [C1.migration, F5.migration, W1.migration]);
  });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await f.backend(db);
    tokens = await f.signInAll(h);
  });

  test("Test C: Waiting -> Cancelled (W1) -> Requeue (F5) -> Waiting -> Call (C1) -> Accept -> Re-Call -> Start -> Complete", async () => {
    const steps = [];
    const snap = async (step, id) => { const row = await patient(db, id); steps.push({ step, patient: pick(row), counters: await pointers(db) }); return row; };
    // A visit already serving on Doctor 2 must be untouched by everything below.
    const other = await register(h, db, tokens.frontdesk, { name: "E2E1C Bystander Prenatal", service: "prenatal" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: other }), 200);
    const bystander = await patient(db, other);

    const id = await register(h, db, tokens.frontdesk, { name: "E2E1C Requeue Test" });
    const w0 = await snap("registered", id);
    assert.equal(w0.status, "waiting");

    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "E2E1C synthetic cancel" }), 200);
    assert.ok(h.rpcs().includes("cancel_patient_visit"), "W1 performed the cancellation");
    const c1 = await snap("cancelled", id);
    assert.equal(c1.status, "cancelled");
    assert.equal(c1.reason, "E2E1C synthetic cancel");
    assert.ok(c1.completed_at, "cancellation time is recorded");
    assert.notEqual(c1.visit_state_revision, w0.visit_state_revision);
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": other, "Doctor 3": null }, "no counter released or claimed");

    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id }), 200);
    assert.ok(h.rpcs().includes("requeue_patient_visit"), "F5 performed the requeue");
    const r1 = await snap("requeued", id);
    assert.equal(r1.status, "waiting");
    assert.notEqual(r1.visit_state_revision, c1.visit_state_revision);
    assert.equal(r1.counter_id, null);
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": other, "Doctor 3": null });
    // Known F5 limitation (documented, not changed here): the same row is reused, so the
    // cancellation's time and reason are no longer visible on it after the Requeue.
    evidence.f5HistoryOverwrite = { beforeRequeue: pick(c1), afterRequeue: pick(r1) };
    assert.equal(r1.completed_at, null, "F5 clears the cancellation time on the reused row");
    assert.notEqual(r1.reason, c1.reason, "F5 replaces the cancellation reason on the reused row");
    assert.ok(Date.parse(r1.created_at) > Date.parse(c1.created_at),
      "F5 also replaces the registration time (back of its tier), so the original arrival time is lost");

    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
    const k1 = await snap("called", id);
    assert.equal(k1.status, "serving");
    assert.equal(k1.counter_id, "Doctor 1");
    assert.notEqual(k1.visit_state_revision, r1.visit_state_revision);
    expectStatus(await post(h, tokens.admin1, "/queue/accept", { patient_id: id }), 200);
    expectStatus(await post(h, tokens.admin1, "/queue/re-call", { patient_id: id }), 200);
    const voice = Array.from(h.settings.getVoiceAnnouncementEvents().filter((event) => Number(event.patient_id) === id), (event) => event.event_type);
    assert.deepEqual(voice, ["accept", "recall"], "one accept and one re-call announcement");
    expectStatus(await post(h, tokens.admin1, "/queue/start", { patient_id: id }), 200);
    await snap("started", id);
    expectStatus(await post(h, tokens.admin1, "/queue/complete", { patient_id: id }), 200);
    const done = await snap("completed", id);
    assert.equal(done.status, "completed");
    assert.equal(done.called_at, k1.called_at);
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": other, "Doctor 3": null }, "only Doctor 1 released");
    assert.deepEqual(await patient(db, other), bystander, "the Doctor 2 visit is unchanged throughout");
    // Completed history cannot be cancelled or re-queued.
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: id, reason: "late" }), 400);
    assert.equal((await post(h, tokens.frontdesk, "/queue/requeue", { patient_id: id })).status >= 400, true);
    assert.deepEqual(await patient(db, id), done);
    await assertConsistent(db);
    evidence.testC = steps;
  });

  test("Test D: three doctors serve in parallel; completing or cancelling one never changes another", async () => {
    const services = { "Doctor 1": "consultation", "Doctor 2": "prenatal", "Doctor 3": "family_planning" };
    const doctorToken = { "Doctor 1": tokens.admin1, "Doctor 2": tokens.admin2, "Doctor 3": tokens.admin3 };
    const ids = {};
    for (const [doctor, service] of Object.entries(services)) {
      ids[doctor] = [
        await register(h, db, tokens.frontdesk, { name: `E2E1D ${doctor} first`, service }),
        await register(h, db, tokens.frontdesk, { name: `E2E1D ${doctor} second`, service })
      ];
    }
    // Each doctor sees only its own services: a doctor cannot call another doctor's patient.
    expectStatus(await post(h, tokens.admin1, "/queue/call", { patient_id: ids["Doctor 2"][0] }), 400, /assigned to Doctor 2/);
    expectStatus(await post(h, tokens.admin3, "/queue/call", { patient_id: ids["Doctor 1"][0] }), 400);
    // Three calls at once from three separate backend instances (separate connection pools).
    const backends = [h, await f.backend(db), await f.backend(db)];
    const results = await Promise.all(Object.keys(services).map((doctor, i) =>
      post(backends[i], doctorToken[doctor], "/queue/call", { patient_id: ids[doctor][0] })));
    results.forEach((response) => expectStatus(response, 200));
    assert.deepEqual(await pointers(db), { "Doctor 1": ids["Doctor 1"][0], "Doctor 2": ids["Doctor 2"][0], "Doctor 3": ids["Doctor 3"][0] });
    for (const doctor of Object.keys(services)) {
      expectStatus(await post(h, doctorToken[doctor], "/queue/accept", { patient_id: ids[doctor][0] }), 200);
      expectStatus(await post(h, doctorToken[doctor], "/queue/start", { patient_id: ids[doctor][0] }), 200);
    }
    const before = { d2: await patient(db, ids["Doctor 2"][0]), d3: await patient(db, ids["Doctor 3"][0]) };

    // Doctor 1 completes and Doctor 3 cancels at the same time; Doctor 2 is untouched.
    const [complete, cancel] = await Promise.all([
      post(backends[0], tokens.admin1, "/queue/complete", { patient_id: ids["Doctor 1"][0] }),
      post(backends[2], tokens.admin3, "/queue/cancel", { patient_id: ids["Doctor 3"][0], reason: "E2E1D referred" })
    ]);
    expectStatus(complete, 200);
    expectStatus(cancel, 200);
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": ids["Doctor 2"][0], "Doctor 3": null });
    assert.deepEqual(await patient(db, ids["Doctor 2"][0]), before.d2, "Doctor 2's consultation is unchanged");
    assert.equal((await patient(db, ids["Doctor 3"][0])).consultation_started_at, before.d3.consultation_started_at, "cancel keeps history");
    for (const doctor of ["Doctor 1", "Doctor 2", "Doctor 3"]) assert.equal((await patient(db, ids[doctor][1])).status, "waiting");

    // Doctors 1 and 3 call their next patients in parallel while Doctor 2 is still busy.
    const next = await Promise.all([
      post(backends[0], tokens.admin1, "/queue/call", { patient_id: ids["Doctor 1"][1] }),
      post(backends[1], tokens.admin2, "/queue/call", { patient_id: ids["Doctor 2"][1] }),
      post(backends[2], tokens.admin3, "/queue/call", { patient_id: ids["Doctor 3"][1] })
    ]);
    expectStatus(next[0], 200);
    expectStatus(next[1], 400, /already serving/);
    expectStatus(next[2], 200);
    assert.deepEqual(await pointers(db), { "Doctor 1": ids["Doctor 1"][1], "Doctor 2": ids["Doctor 2"][0], "Doctor 3": ids["Doctor 3"][1] });
    for (const [doctor, id] of [["Doctor 1", ids["Doctor 1"][1]], ["Doctor 3", ids["Doctor 3"][1]]]) {
      assert.equal((await patient(db, id)).counter_id, doctor);
    }
    assert.deepEqual(effects(h, ids["Doctor 2"][1]), { sms: 0, awaiting: false, voice: 0 }, "the refused call had no side effects");
    await assertConsistent(db);
    evidence.testD = { ids, finalCounters: await pointers(db) };
  });
});
