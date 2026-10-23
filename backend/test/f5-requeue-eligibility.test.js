// F5: Requeue recovers only a finished visit (cancelled, no-show, or a legacy completed visit
// without a consultation start). It never erases an active call, consultation start or counter.
// Synthetic data only: the mock Supabase harness models the recovery RPCs; SQL behavior of the
// versioned requeue_patient_visit function is covered by f5-requeue-postgres.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const BASE_TIME = Date.parse("2026-10-22T02:00:00.000Z"); // 10:00 Manila
const SERVICE = { 1: "consultation", 2: "prenatal", 3: "family_planning" };
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function setup(localFallback = false, options = {}) {
  const h = createHarness({ localFallback, clock: { now: BASE_TIME }, ...options });
  await h.initialize();
  return h;
}

function shared() {
  const database = createDatabase();
  const clock = { now: BASE_TIME };
  const files = new Map();
  return { database, first: createHarness({ database, clock, files }), second: createHarness({ database, clock, files }) };
}

async function register(h, number = 1, name = `Synthetic D${number}`, flags = []) {
  const patient = await h.service.createQueueEntry({ idNum: name, serviceType: SERVICE[number], vulnerabilityFlags: flags });
  h.advance();
  return patient;
}
async function ok(h, route, body, user = FRONTDESK) {
  const response = await h.request("POST", route, body, user);
  assert.equal(response.status, 200, `${route}: ${response.body?.message}`);
  h.advance();
  return response;
}
async function called(h, number = 1) {
  const patient = await register(h, number);
  await ok(h, "/queue/call", { patient_id: patient.id });
  return patient;
}
async function accepted(h, number = 1) {
  const patient = await called(h, number);
  await ok(h, "/queue/accept", { patient_id: patient.id }, doctor(number));
  return patient;
}
async function started(h, number = 1) {
  const patient = await accepted(h, number);
  await ok(h, "/queue/start", { patient_id: patient.id }, doctor(number));
  return patient;
}
async function cancelled(h, number = 1) {
  const patient = await accepted(h, number);
  await ok(h, "/queue/cancel", { patient_id: patient.id, reason: "Synthetic cancellation" }, doctor(number));
  return patient;
}

const requeue = (h, patient, user = FRONTDESK, extra = {}) =>
  h.request("POST", "/queue/requeue", { patient_id: patient.id, reason: "Synthetic requeue", ...extra }, user);
const row = async (h, patient) => clone(await h.service.getPatientById(patient.id));
const pointer = async (h, number) =>
  (await h.service.getQueueOverview()).counters.find((counter) => counter.id_num === `Doctor ${number}`).current_patient_id ?? null;
async function state(h) {
  const overview = await h.service.getQueueOverview();
  return clone({ patients: overview.patients, counters: overview.counters.map((c) => [c.id_num, c.current_patient_id ?? null]) });
}
const recoveryCalls = (h) => h.database.calls.filter((call) => call.action === "rpc" && /requeue|recover/.test(call.function));

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "mock Supabase";

  for (const [label, make] of [["called", called], ["accepted", accepted], ["consultation started", started]]) {
    test(`${mode}: a serving (${label}) visit cannot be re-queued by any role and keeps its call, start and counter`, async () => {
      const h = await setup(localFallback);
      const patient = await make(h, 1);
      const before = await state(h);
      const acceptedAt = h.settings.getAcceptedAt(patient.id);
      for (const user of [FRONTDESK, SUPERADMIN, doctor(1)]) {
        const response = await requeue(h, patient, user);
        assert.equal(response.status, 409, `${user.id_num}: ${response.body.message}`);
        assert.match(response.body.message, /being served/);
      }
      assert.deepEqual(await state(h), before);
      assert.equal(h.settings.getAcceptedAt(patient.id), acceptedAt, "acceptance state is not reset");
      if (!localFallback) assert.equal(recoveryCalls(h).length, 0, "no recovery RPC is attempted");
      if (label === "consultation started") {
        h.advance(4000);
        await ok(h, "/queue/complete", { patient_id: patient.id }, doctor(1));
        const done = await row(h, patient);
        assert.equal(done.status, "completed");
        assert.ok(done.consultation_started_at && done.completed_at, "the consultation completes with its original start");
        assert.equal(await pointer(h, 1), null);
      }
    });
  }

  test(`${mode}: a waiting visit cannot be re-queued and keeps its registration time`, async () => {
    const h = await setup(localFallback);
    const patient = await register(h, 2);
    const before = await state(h);
    for (const user of [FRONTDESK, SUPERADMIN, doctor(2)]) {
      const response = await requeue(h, patient, user);
      assert.equal(response.status, 409);
      assert.match(response.body.message, /already waiting/);
    }
    assert.deepEqual(await state(h), before);
  });

  for (const number of [1, 2, 3]) {
    test(`${mode}: Doctor ${number}, Frontdesk and Superadmin re-queue a cancelled Doctor ${number} visit; other doctors cannot`, async () => {
      for (const user of [doctor(number), FRONTDESK, SUPERADMIN]) {
        const h = await setup(localFallback);
        const patient = await cancelled(h, number);
        for (const other of [1, 2, 3].filter((n) => n !== number)) {
          const denied = await requeue(h, patient, doctor(other), { counter_id: `Doctor ${number}`, counterId: `Doctor ${number}`,
            role: "superadmin", doctor_name: `Doctor ${number}`, id_num: "superadmin" });
          assert.equal(denied.status, 403, "forged body identity or counter values are ignored");
        }
        const before = await row(h, patient);
        const response = await requeue(h, patient, user);
        assert.equal(response.status, 200, `${user.id_num}: ${response.body.message}`);
        const after = await row(h, patient);
        assert.equal(after.status, "waiting");
        for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(after[field], null, field);
        assert.ok(Date.parse(after.created_at) > Date.parse(before.created_at), "moves to the end of its priority tier");
        assert.equal(after.priority_score, before.priority_score);
        assert.equal(after.service_type, SERVICE[number], "service-to-doctor routing is unchanged");
        assert.equal(after.reason, "Synthetic requeue");
        assert.notEqual(after.visit_state_revision ?? null, before.visit_state_revision ?? "unchanged");
        assert.equal(await pointer(h, number), null);
        // The recovered visit is called again through the normal Call, for its own doctor.
        await ok(h, "/queue/call", { patient_id: patient.id });
        assert.equal((await row(h, patient)).counter_id, `Doctor ${number}`);
      }
    });
  }

  test(`${mode}: a no-show visit is re-queued after the configured wait`, async () => {
    const h = await setup(localFallback);
    const patient = await called(h, 3);
    h.advance(11 * 60000);
    await ok(h, "/queue/no-show", { patient_id: patient.id, reason: "Synthetic no-show" }, doctor(3));
    assert.equal((await row(h, patient)).status, "no-show");
    assert.equal((await requeue(h, patient, doctor(3))).status, 200);
    assert.equal((await row(h, patient)).status, "waiting");
    assert.equal(await pointer(h, 3), null);
  });

  test(`${mode}: a completed consultation keeps its history against Requeue from every role`, async () => {
    const h = await setup(localFallback);
    const patient = await started(h, 1);
    h.advance(5000);
    await ok(h, "/queue/complete", { patient_id: patient.id }, doctor(1));
    const before = await state(h);
    for (const user of [FRONTDESK, SUPERADMIN, doctor(1)]) {
      const response = await requeue(h, patient, user);
      assert.equal(response.status, 400);
      assert.match(response.body.message, /Completed consultation history/);
    }
    assert.deepEqual(await state(h), before);
  });

  test(`${mode}: a duplicate Requeue is refused once the visit is waiting`, async () => {
    const h = await setup(localFallback);
    const patient = await cancelled(h, 2);
    assert.equal((await requeue(h, patient)).status, 200);
    const after = await state(h);
    const repeat = await requeue(h, patient);
    assert.equal(repeat.status, 409);
    assert.deepEqual(await state(h), after);
  });
}

test("mock Supabase: legacy completed visit without a consultation start keeps its existing Requeue behavior (policy pending)", async () => {
  const h = await setup(false);
  const patient = await accepted(h, 1);
  const stored = h.database.patients.find((item) => item.id === patient.id);
  Object.assign(stored, { status: "completed", completed_at: new Date(h.clock.now).toISOString(), consultation_started_at: null });
  h.database.counters[0].current_patient_id = null;
  const response = await requeue(h, patient);
  assert.equal(response.status, 200, response.body.message);
  assert.equal((await row(h, patient)).status, "waiting");
});

test("mock Supabase: a stale counter pointer to a cancelled visit is never left behind by Requeue", async () => {
  // Not installed (the current project): refuse instead of re-queueing over the pointer.
  const h = await setup(false);
  const other = await accepted(h, 2);
  const patient = await cancelled(h, 1);
  h.database.counters[0].current_patient_id = patient.id; // W1 leftover
  const before = await state(h);
  const refused = await requeue(h, patient);
  assert.equal(refused.status, 503);
  assert.match(refused.body.message, /Use Undo/);
  assert.deepEqual(await state(h), before);
  assert.deepEqual(recoveryCalls(h).map((call) => call.function), ["requeue_patient_visit"], "no non-atomic fallback");
  // Undo still repairs it atomically.
  assert.equal((await h.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK)).status, 200);
  assert.equal(await pointer(h, 1), null);
  assert.equal(await pointer(h, 2), other.id, "another doctor's active patient keeps its counter");

  // Installed: the versioned function re-queues and releases the pointer in one step.
  const installed = await setup(false);
  installed.database.requeueRpcInstalled = true;
  const active = await accepted(installed, 2);
  const visit = await cancelled(installed, 1);
  installed.database.counters[0].current_patient_id = visit.id;
  const response = await requeue(installed, visit);
  assert.equal(response.status, 200, response.body.message);
  assert.equal((await row(installed, visit)).status, "waiting");
  assert.equal(await pointer(installed, 1), null);
  assert.equal(await pointer(installed, 2), active.id);
  assert.deepEqual(recoveryCalls(installed).map((call) => call.function), ["requeue_patient_visit"]);
});

test("mock Supabase: without the versioned function, a visit with no pointer uses the existing recovery RPC", async () => {
  const h = await setup(false);
  const patient = await cancelled(h, 3);
  assert.equal((await requeue(h, patient)).status, 200);
  assert.deepEqual(recoveryCalls(h).map((call) => call.function), ["requeue_patient_visit", "recover_patient_visit"]);
  assert.equal(recoveryCalls(h)[1].args.p_expected_status, "cancelled", "only a terminal snapshot reaches the database");
});

for (const installed of [false, true]) {
  const variant = installed ? "versioned function installed" : "existing recovery RPC";

  test(`mock Supabase (${variant}): Undo committed while Requeue is in flight makes the stale Requeue fail`, { timeout: 10000 }, async () => {
    const { database, first, second } = shared();
    database.requeueRpcInstalled = installed;
    const patient = await cancelled(first, 1);
    const reached = deferred();
    const resume = deferred();
    database.beforeRpc = async (name, args) => {
      if (!["requeue_patient_visit", "recover_patient_visit"].includes(name) || args.p_action !== "requeue") return undefined;
      if (name === "requeue_patient_visit" && !installed) return undefined;
      database.beforeRpc = null;
      reached.resolve();
      await resume.promise;
      return undefined;
    };
    const stale = requeue(first, patient);
    await reached.promise;
    try {
      assert.equal((await second.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK)).status, 200);
    } finally { resume.resolve(); }
    const undone = clone(database.patients.find((item) => item.id === patient.id));
    const response = await stale;
    assert.equal(response.status, 409, response.body.message);
    assert.deepEqual(clone(database.patients.find((item) => item.id === patient.id)), undone, "the Undo result stands");
  });

  test(`mock Supabase (${variant}): Requeue committed while Undo is in flight makes the stale Undo fail`, { timeout: 10000 }, async () => {
    const { database, first, second } = shared();
    database.requeueRpcInstalled = installed;
    const patient = await cancelled(first, 2);
    const reached = deferred();
    const resume = deferred();
    database.beforeRpc = async (name) => {
      if (name !== "undo_patient_visit_waiting") return undefined;
      database.beforeRpc = null;
      reached.resolve();
      await resume.promise;
      return undefined;
    };
    const stale = first.request("POST", "/queue/undo", { patient_id: patient.id }, FRONTDESK);
    await reached.promise;
    try {
      assert.equal((await requeue(second, patient)).status, 200);
    } finally { resume.resolve(); }
    const requeued = clone(database.patients.find((item) => item.id === patient.id));
    assert.equal((await stale).status, 409);
    assert.deepEqual(clone(database.patients.find((item) => item.id === patient.id)), requeued);
  });

  test(`mock Supabase (${variant}): a stale Requeue cannot erase a consultation completed after Undo, Call, Accept and Start`, { timeout: 10000 }, async () => {
    const { database, first, second } = shared();
    database.requeueRpcInstalled = installed;
    const patient = await cancelled(first, 3);
    const reached = deferred();
    const resume = deferred();
    database.beforeRpc = async (name, args) => {
      if (!["requeue_patient_visit", "recover_patient_visit"].includes(name) || args.p_action !== "requeue") return undefined;
      if (name === "requeue_patient_visit" && !installed) return undefined;
      database.beforeRpc = null;
      reached.resolve();
      await resume.promise;
      return undefined;
    };
    const stale = requeue(first, patient);
    await reached.promise;
    let completed;
    try {
      await ok(second, "/queue/undo", { patient_id: patient.id });
      await ok(second, "/queue/call", { patient_id: patient.id });
      await ok(second, "/queue/accept", { patient_id: patient.id }, doctor(3));
      await ok(second, "/queue/start", { patient_id: patient.id }, doctor(3));
      second.advance(3000);
      await ok(second, "/queue/complete", { patient_id: patient.id }, doctor(3));
      completed = clone(database.patients.find((item) => item.id === patient.id));
    } finally { resume.resolve(); }
    const response = await stale;
    assert.ok([400, 409].includes(response.status), response.body.message);
    assert.deepEqual(clone(database.patients.find((item) => item.id === patient.id)), completed);
    assert.equal(completed.status, "completed");
    assert.ok(completed.consultation_started_at);
  });

  test(`mock Supabase (${variant}): concurrent duplicate Requeue requests recover the visit once`, { timeout: 10000 }, async () => {
    const { database, first, second } = shared();
    database.requeueRpcInstalled = installed;
    const patient = await cancelled(first, 1);
    const both = deferred();
    const resume = deferred();
    let entered = 0;
    database.beforeRpc = async (name, args) => {
      if (args?.p_action !== "requeue" || (name === "requeue_patient_visit" && !installed)) return undefined;
      if (++entered === 2) both.resolve();
      await resume.promise;
      return undefined;
    };
    const requests = [requeue(first, patient), requeue(second, patient)];
    try { await both.promise; } finally { resume.resolve(); }
    const statuses = (await Promise.all(requests)).map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(database.patients.find((item) => item.id === patient.id).status, "waiting");
  });
}

test("mock Supabase: a consultation called before midnight cannot be re-queued after midnight", async () => {
  const h = await setup(false, { clock: { now: Date.parse("2026-10-21T15:50:00.000Z") } }); // 23:50 Manila
  const patient = await started(h, 1);
  h.clock.now = Date.parse("2026-10-21T16:10:00.000Z"); // 00:10 Manila, next business day
  const before = await state(h);
  assert.ok(before.patients.some((item) => item.id === patient.id), "the overnight consultation is still listed");
  const response = await requeue(h, patient);
  assert.equal(response.status, 409);
  assert.deepEqual(await state(h), before);
  h.advance(2000);
  await ok(h, "/queue/complete", { patient_id: patient.id }, doctor(1));
  assert.equal((await row(h, patient)).status, "completed");
});

test("mock Supabase: WPS order after recovery puts the visit at the end of its own priority tier", async () => {
  const h = await setup(false);
  const regularFirst = await register(h, 1, "Regular first");
  const senior = await register(h, 1, "Senior", ["senior"]);
  const regularSecond = await register(h, 1, "Regular second");
  await ok(h, "/queue/call", { patient_id: senior.id });
  await ok(h, "/queue/accept", { patient_id: senior.id }, doctor(1));
  await ok(h, "/queue/cancel", { patient_id: senior.id, reason: "Stepped out" }, doctor(1));
  const recoveredRegular = await register(h, 1, "Regular recovered");
  await ok(h, "/queue/call", { patient_id: (await h.service.getDisplayData()).next_in_line.id });
  // Regular first is now serving; cancel it and requeue: it moves behind Regular second.
  await ok(h, "/queue/cancel", { patient_id: regularFirst.id, reason: "Stepped out" });
  await ok(h, "/queue/requeue", { patient_id: senior.id, reason: "Returned" });
  await ok(h, "/queue/requeue", { patient_id: regularFirst.id, reason: "Returned" });
  const order = clone((await h.service.getDisplayData()).waiting_queue.map((entry) => entry.id));
  assert.deepEqual(order, [senior.id, regularSecond.id, recoveredRegular.id, regularFirst.id],
    "priority score first, then registration (recovery) time; weights unchanged");
  assert.equal((await h.request("POST", "/queue/call", { patient_id: regularSecond.id })).status, 400, "Call still enforces WPS order");
  assert.equal((await h.request("POST", "/queue/call", { patient_id: senior.id })).status, 200);
});

test("mock Supabase: Requeue stays disabled when queue reassignment is turned off", async () => {
  const h = await setup(false);
  const patient = await cancelled(h, 1);
  h.settings.saveQueueSettings({ ...h.settings.getQueueSettings(), allowQueueReassignment: false });
  const before = await state(h);
  assert.equal((await requeue(h, patient)).status, 400);
  assert.deepEqual(await state(h), before);
});
