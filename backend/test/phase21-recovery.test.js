const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const baseTime = Date.parse("2026-10-10T01:00:00.000Z");
const doctor = (number = 1) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const registration = (name, serviceType = "consultation") => ({
  idNum: name, serviceType, vulnerabilityFlags: [], mobileNumber: "09123456789"
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function setup() {
  const database = createDatabase();
  const clock = { now: baseTime };
  const files = new Map();
  return {
    first: createHarness({ database, clock, files }),
    second: createHarness({ database, clock, files }),
    database
  };
}

async function legacyPatient(h, status = "completed") {
  const registered = await h.service.createQueueEntry(registration(`Legacy ${status}`));
  const stored = h.database.patients.find((row) => row.id === registered.id);
  Object.assign(stored, {
    status,
    created_at: "2026-10-10T00:58:00.000100Z",
    called_at: "2026-10-10T00:58:10.000200Z",
    consultation_started_at: null,
    completed_at: "2026-10-10T00:59:00.000300Z",
    counter_id: "Doctor 1",
    reason: "Legacy terminal state"
  });
  return clone(stored);
}

// The hook runs after the service has read its snapshot and immediately before
// the write boundary. Supporting the old UPDATE lets the same test demonstrate
// the original ABA failure as well as the new transactional recovery boundary.
function pauseRecovery(database, action, patientId) {
  const reached = deferred();
  const resume = deferred();
  let paused = false;
  const pause = async () => {
    if (paused) return;
    paused = true;
    reached.resolve();
    await resume.promise;
  };
  database.beforeRpc = async (name, args) => {
    if (["recover_patient_visit", "undo_patient_visit_waiting"].includes(name) && args.p_action === action && args.p_patient_id === patientId) await pause();
  };
  database.beforeQuery = async (query) => {
    if (query.table === "patients" && query.action === "update" && query.payload.status === "waiting") await pause();
  };
  return { reached: reached.promise, resume: resume.resolve };
}

async function callAcceptStart(h, patientId) {
  assert.equal((await h.request("POST", "/queue/call", { patient_id: patientId })).status, 200);
  h.advance();
  const accepted = await h.request("POST", "/queue/accept", { patient_id: patientId }, doctor());
  assert.equal(accepted.status, 200, accepted.body.message);
  h.advance();
  const started = await h.request("POST", "/queue/start", { patient_id: patientId }, doctor());
  assert.equal(started.status, 200, started.body.message);
}

async function finishNewConsultation(h, patientId) {
  h.advance();
  const requeued = await h.request("POST", "/queue/requeue", { patient_id: patientId, reason: "New visit" });
  assert.equal(requeued.status, 200, requeued.body.message);
  await callAcceptStart(h, patientId);
  h.advance(12500);
  const completed = await h.request("POST", "/queue/complete", { patient_id: patientId, reason: "New consultation complete" }, doctor());
  assert.equal(completed.status, 200, completed.body.message);
}

async function assertUnchanged(h, patientId, patientBefore, countersBefore) {
  assert.deepEqual(clone(await h.service.getPatientById(patientId)), patientBefore);
  assert.deepEqual(clone(h.database.counters), countersBefore);
}

for (const action of ["requeue", "undo"]) {
  test(`Phase 2.1: stale ${action} cannot erase a newly completed consultation after completed-status ABA`, { timeout: 10000 }, async () => {
    const { first, second, database } = setup();
    const original = await legacyPatient(first);
    const barrier = pauseRecovery(database, action, original.id);
    const stale = first.request("POST", `/queue/${action}`, { patient_id: original.id, reason: "Outdated recovery" });
    let newer;
    let counters;
    let duration;
    let acceptedAt;
    try {
      await barrier.reached;
      await finishNewConsultation(second, original.id);
      newer = clone(await second.service.getPatientById(original.id));
      assert.equal(newer.status, original.status, "The status returned to the same value observed by the stale request");
      assert.ok(newer.consultation_started_at);
      assert.ok(newer.completed_at);
      assert.notEqual(newer.created_at, original.created_at);
      duration = (await second.service.getQueueOverview()).patients.find((row) => row.id === original.id).service_duration_seconds;
      assert.equal(duration, 12.5);
      acceptedAt = second.loadSettings().getAcceptedAt(original.id);
      const successor = await second.service.createQueueEntry(registration("Doctor 1 successor"));
      assert.equal((await second.request("POST", "/queue/call", { patient_id: successor.id })).status, 200);
      const other = await second.service.createQueueEntry(registration("Doctor 2 active patient", "prenatal"));
      assert.equal((await second.request("POST", "/queue/call", { patient_id: other.id })).status, 200);
      counters = clone(database.counters);
    } finally {
      barrier.resume();
    }
    const response = await stale;
    assert.equal(response.status, 409, response.body.message);
    assert.equal(response.body.success, false);
    await assertUnchanged(second, original.id, newer, counters);
    const preserved = (await second.service.getQueueOverview()).patients.find((row) => row.id === original.id);
    assert.equal(preserved.consultation_started_at, newer.consultation_started_at);
    assert.equal(preserved.completed_at, newer.completed_at);
    assert.equal(preserved.service_duration_seconds, duration);
    assert.ok(preserved.service_duration_seconds > 0);
    assert.equal(second.loadSettings().getAcceptedAt(original.id), acceptedAt, "Rejected recovery must not reset newer acceptance state");
  });

  test(`Phase 2.1: current completed consultation blocks ${action} and retains exact stored history`, async () => {
    const { first } = setup();
    const patient = await legacyPatient(first);
    Object.assign(first.database.patients[0], {
      consultation_started_at: "2026-10-10T08:58:10.000100+08:00",
      completed_at: "2026-10-10T00:58:10.000900Z"
    });
    const before = clone(first.database.patients[0]);
    const counters = clone(first.database.counters);
    const response = await first.request("POST", `/queue/${action}`, { patient_id: patient.id });
    assert.equal(response.status, 400, response.body.message);
    assert.match(response.body.message, /history|new visit/i);
    await assertUnchanged(first, patient.id, before, counters);
    assert.equal((await first.service.getQueueOverview()).patients.find((row) => row.id === patient.id).service_duration_seconds, 0.0008);
  });

  test(`Phase 2.1: stale ${action} rejects a newer cancelled attempt that already started consultation`, { timeout: 10000 }, async () => {
    const { first, second, database } = setup();
    const original = await legacyPatient(first, "cancelled");
    const barrier = pauseRecovery(database, action, original.id);
    const stale = first.request("POST", `/queue/${action}`, { patient_id: original.id });
    let newer;
    let counters;
    try {
      await barrier.reached;
      second.advance();
      assert.equal((await second.request("POST", "/queue/requeue", { patient_id: original.id })).status, 200);
      await callAcceptStart(second, original.id);
      second.advance(5000);
      const cancelled = await second.request("POST", "/queue/cancel", { patient_id: original.id, reason: "New attempt cancelled" });
      assert.equal(cancelled.status, 200, cancelled.body.message);
      newer = clone(await second.service.getPatientById(original.id));
      assert.equal(newer.status, original.status);
      assert.ok(newer.consultation_started_at);
      counters = clone(database.counters);
    } finally {
      barrier.resume();
    }
    const response = await stale;
    assert.equal(response.status, 409, response.body.message);
    await assertUnchanged(second, original.id, newer, counters);
  });
}

test("Phase 2.1: unchanged legacy Requeue recovers at the end of its priority tier", async () => {
  const { first } = setup();
  const original = await legacyPatient(first);
  const counters = clone(first.database.counters);
  first.advance(2500);
  const response = await first.request("POST", "/queue/requeue", { patient_id: original.id, reason: "Safe legacy recovery" });
  assert.equal(response.status, 200, response.body.message);
  const recovered = await first.service.getPatientById(original.id);
  assert.equal(recovered.status, "waiting");
  assert.equal(recovered.created_at, new Date(first.clock.now).toISOString());
  assert.equal(recovered.reason, "Safe legacy recovery");
  for (const field of ["called_at", "completed_at", "consultation_started_at", "counter_id"]) assert.equal(recovered[field], null);
  assert.deepEqual(clone(first.database.counters), counters);
});

test("Phase 2.1: unchanged legacy Undo preserves its queue position with Phase 2.2 clean waiting ownership", async () => {
  const { first } = setup();
  const original = await legacyPatient(first);
  const response = await first.request("POST", "/queue/undo", { patient_id: original.id });
  assert.equal(response.status, 200, response.body.message);
  const recovered = await first.service.getPatientById(original.id);
  assert.equal(recovered.status, "waiting");
  assert.equal(recovered.created_at, original.created_at);
  assert.equal(recovered.called_at, null);
  assert.equal(recovered.reason, original.reason);
  assert.equal(recovered.counter_id, null);
  assert.equal(recovered.completed_at, null);
  assert.equal(recovered.consultation_started_at, null);
  assert.equal(first.database.counters[0].current_patient_id, null);
});

for (const actions of [["requeue", "requeue"], ["undo", "undo"], ["requeue", "undo"]]) {
  test(`Phase 2.1: concurrent ${actions.join(" / ")} requests cannot both consume one expected terminal state`, { timeout: 10000 }, async () => {
    const { first, second, database } = setup();
    const original = await legacyPatient(first);
    const arrived = deferred();
    const resume = deferred();
    let waiting = 0;
    const pause = async () => {
      waiting += 1;
      if (waiting === 2) arrived.resolve();
      await resume.promise;
    };
    database.beforeRpc = async (name) => {
      if (["recover_patient_visit", "undo_patient_visit_waiting"].includes(name)) await pause();
    };
    database.beforeQuery = async (query) => {
      if (query.table === "patients" && query.action === "update" && query.payload.status === "waiting") await pause();
    };
    const requests = [first, second].map((h, index) => h.request("POST", `/queue/${actions[index]}`, {
      patient_id: original.id, reason: `Recovery ${index + 1}`
    }));
    try {
      await arrived.promise;
    } finally {
      resume.resolve();
    }
    const results = await Promise.all(requests);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    const winner = results.findIndex((response) => response.status === 200);
    assert.equal(database.patients[0].status, "waiting");
    if (actions[winner] === "undo") {
      assert.equal(database.counters.filter((counter) => counter.current_patient_id === original.id).length, 0);
      assert.equal(database.patients[0].created_at, original.created_at);
    } else {
      assert.equal(database.counters.filter((counter) => counter.current_patient_id === original.id).length, 0);
      assert.equal(database.patients[0].reason, `Recovery ${winner + 1}`);
    }
  });
}

for (const action of ["requeue", "undo"]) {
  test(`Phase 2.1: revision rejects stale ${action} after same-millisecond Undo and cancellation restore every sampled field`, { timeout: 10000 }, async () => {
    const { first, second, database } = setup();
    const patient = await first.service.createQueueEntry(registration("Same millisecond recovery"));
    assert.equal((await first.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    const cancellation = { patient_id: patient.id, reason: "Repeated cancellation" };
    assert.equal((await first.request("POST", "/queue/cancel", cancellation)).status, 200);
    const original = clone(await first.service.getPatientById(patient.id));
    const barrier = pauseRecovery(database, action, patient.id);
    const stale = first.request("POST", `/queue/${action}`, { patient_id: patient.id });
    let current;
    let counters;
    try {
      await barrier.reached;
      assert.equal((await second.request("POST", "/queue/undo", { patient_id: patient.id })).status, 200);
      // Phase 2.2 Undo clears call ownership; a same-millisecond normal Call
      // restores those sampled fields before the second cancellation.
      assert.equal((await second.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
      assert.equal((await second.request("POST", "/queue/cancel", cancellation)).status, 200);
      current = clone(await second.service.getPatientById(patient.id));
      const { visit_state_revision: originalRevision, ...originalFields } = original;
      const { visit_state_revision: currentRevision, ...currentFields } = current;
      assert.deepEqual(currentFields, originalFields, "Status and all timestamps alone cannot distinguish these attempts");
      assert.notEqual(currentRevision, originalRevision, "Every patient update must invalidate the old database revision");
      counters = clone(database.counters);
    } finally {
      barrier.resume();
    }
    const response = await stale;
    assert.equal(response.status, 409, response.body.message);
    await assertUnchanged(second, patient.id, current, counters);
  });

  test(`Phase 2.1: ${action} forwards raw microsecond timestamps and the authenticated actor instead of submitted expectations`, async () => {
    const { first } = setup();
    const original = await legacyPatient(first, "cancelled");
    const startedAt = "2026-10-10T08:58:10.000123+08:00";
    first.database.patients[0].consultation_started_at = startedAt;
    first.database.rpcReturnsArray = true;
    const response = await first.request("POST", `/queue/${action}`, {
      patient_id: original.id,
      reason: "Approved recovery",
      p_user_id_num: "superadmin",
      p_expected_revision: "00000000-0000-0000-0000-000000000000",
      p_expected_created_at: "1990-01-01T00:00:00.000Z",
      p_expected_started_at: null
    });
    assert.equal(response.status, 200, response.body.message);
    const recovery = first.database.calls.find((entry) => entry.function === (action === "undo" ? "undo_patient_visit_waiting" : "recover_patient_visit"));
    assert.ok(recovery);
    assert.deepEqual(recovery.args, {
      p_patient_id: original.id,
      p_action: action,
      p_user_id_num: "frontdesk",
      p_expected_revision: original.visit_state_revision,
      p_expected_status: original.status,
      p_expected_created_at: original.created_at,
      p_expected_called_at: original.called_at,
      p_expected_started_at: startedAt,
      p_expected_completed_at: original.completed_at,
      p_expected_counter_id: original.counter_id,
      p_reason: action === "requeue" ? "Approved recovery" : null
    });
  });

  test(`Phase 2.1: ${action} rechecks revoked operator identity at the transaction boundary`, async () => {
    const { first } = setup();
    const original = await legacyPatient(first);
    const counters = clone(first.database.counters);
    first.database.beforeRpc = (name) => {
      if (["recover_patient_visit", "undo_patient_visit_waiting"].includes(name)) first.database.users.find((row) => row.id_num === "frontdesk").role = "revoked";
    };
    const response = await first.request("POST", `/queue/${action}`, { patient_id: original.id });
    assert.equal(response.status, 403, response.body.message);
    await assertUnchanged(first, original.id, original, counters);
  });
}

test("Phase 2.1: failed Undo commit rolls back both patient recovery and stale counter release", async () => {
  const { first } = setup();
  const original = await legacyPatient(first);
  first.database.counters[0].current_patient_id = original.id;
  const counters = clone(first.database.counters);
  first.database.beforeRpcCommit = ({ name, patients, counters: pendingCounters }) => {
    if (name !== "undo_patient_visit_waiting") return;
    assert.equal(patients[0].status, "waiting");
    assert.equal(pendingCounters[0].current_patient_id, null);
    throw new Error("Injected counter commit failure");
  };
  const response = await first.request("POST", "/queue/undo", { patient_id: original.id });
  assert.equal(response.status, 400, response.body.message);
  assert.match(response.body.message, /commit failure/i);
  await assertUnchanged(first, original.id, original, counters);
});

for (const action of ["requeue", "undo"]) {
  test(`Phase 2.1: ${action} fails closed on missing migration, missing RPC, empty result and storage failures`, async () => {
    const failures = [
      { label: "missing revision column", noRpc: true, apply: (h) => { delete h.database.patients[0].visit_state_revision; } },
      { label: "missing recovery function", apply: (h) => { h.database.beforeRpc = () => ({ data: null, error: { code: "PGRST202", message: "Function unavailable" } }); } },
      { label: "empty recovery result", apply: (h) => { h.database.beforeRpc = () => ({ data: null, error: null }); } },
      { label: "empty recovery result array", apply: (h) => { h.database.beforeRpc = () => ({ data: [], error: null }); } },
      { label: "returned transport error", apply: (h) => { h.database.beforeRpc = () => ({ data: null, error: { message: "Injected network failure" } }); } },
      { label: "thrown transport error", apply: (h) => { h.database.beforeRpc = () => { throw new Error("Injected network failure"); }; } },
      { label: "snapshot read error", noRpc: true, apply: (h) => { h.database.beforeQuery = (query) => query.table === "patients" && query.action === "select"
        ? { data: null, error: { message: "Injected snapshot read failure" } } : undefined; } }
    ];
    for (const failure of failures) {
      const { first } = setup();
      const patient = await legacyPatient(first);
      failure.apply(first);
      const before = clone(first.database.patients[0]);
      const counters = clone(first.database.counters);
      const response = await first.request("POST", `/queue/${action}`, { patient_id: patient.id });
      assert.equal(response.status, 503, `${failure.label}: ${response.body.message}`);
      assert.equal(response.body.success, false);
      assert.equal(first.service.getQueueStorageMode(), "supabase", failure.label);
      if (failure.noRpc) assert.equal(first.database.calls.filter((entry) => entry.action === "rpc").length, 0, failure.label);
      first.database.beforeQuery = null;
      await assertUnchanged(first, patient.id, before, counters);
    }
  });

  test(`Phase 2.1: ${action} independently checks every raw timestamp below JavaScript millisecond precision`, { timeout: 10000 }, async () => {
    for (const field of ["created_at", "called_at", "consultation_started_at", "completed_at"]) {
      const { first, second, database } = setup();
      const patient = await legacyPatient(first, "cancelled");
      database.patients[0].consultation_started_at = "2026-10-10T00:58:10.000400Z";
      const barrier = pauseRecovery(database, action, patient.id);
      const stale = first.request("POST", `/queue/${action}`, { patient_id: patient.id });
      let changed;
      let counters;
      try {
        await barrier.reached;
        const previous = database.patients[0][field];
        database.patients[0][field] = previous.replace(/0Z$/, "1Z");
        assert.equal(Date.parse(database.patients[0][field]), Date.parse(previous), field);
        assert.notEqual(database.patients[0][field], previous, field);
        // Deliberately leave the revision unchanged to isolate the additional
        // exact timestamp guard. Real PostgreSQL UPDATE also rotates revision.
        assert.equal(database.patients[0].visit_state_revision, patient.visit_state_revision);
        changed = clone(await second.service.getPatientById(patient.id));
        counters = clone(database.counters);
      } finally {
        barrier.resume();
      }
      const response = await stale;
      assert.equal(response.status, 409, `${field}: ${response.body.message}`);
      await assertUnchanged(second, patient.id, changed, counters);
    }
  });
}

for (const action of ["requeue", "undo"]) {
  test(`Phase 2.1: development memory preserves normal legacy ${action} semantics and completed history`, async () => {
    const h = createHarness({ localFallback: true, clock: { now: baseTime } });
    await h.initialize();
    const patient = await h.service.createQueueEntry(registration("Development recovery"));
    const stored = await h.service.getPatientById(patient.id);
    Object.assign(stored, {
      status: "cancelled", counter_id: "Doctor 2", created_at: "2026-10-10T00:58:00.000123Z",
      called_at: "2026-10-10T00:58:10.000234Z", completed_at: "2026-10-10T00:59:00.000345Z", reason: "Development cancellation"
    });
    const before = clone(stored);
    const counters = clone((await h.service.getQueueOverview()).counters);
    h.advance();
    const response = await h.request("POST", `/queue/${action}`, { patient_id: patient.id, reason: "Development recovery" });
    assert.equal(response.status, 200, response.body.message);
    const recovered = await h.service.getPatientById(patient.id);
    assert.equal(recovered.status, "waiting");
    assert.equal(recovered.completed_at, null);
    assert.equal(recovered.consultation_started_at, null);
    assert.notEqual(recovered.visit_state_revision, before.visit_state_revision);
    assert.deepEqual(clone((await h.service.getQueueOverview()).counters), counters, "Recovery does not reserve a counter");
    if (action === "undo") {
      assert.equal(recovered.created_at, before.created_at);
      assert.equal(recovered.called_at, null);
      assert.equal(recovered.counter_id, null);
      assert.equal(recovered.reason, before.reason);
    } else {
      assert.equal(recovered.created_at, new Date(h.clock.now).toISOString());
      assert.equal(recovered.called_at, null);
      assert.equal(recovered.counter_id, null);
      assert.equal(recovered.reason, "Development recovery");
    }
    Object.assign(recovered, {
      status: "completed", consultation_started_at: "2026-10-10T00:58:10.000123Z", completed_at: "2026-10-10T00:59:00.000456Z"
    });
    const completed = clone(recovered);
    const rejected = await h.request("POST", `/queue/${action}`, { patient_id: patient.id });
    assert.equal(rejected.status, 400, rejected.body.message);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), completed);
    assert.deepEqual(clone((await h.service.getQueueOverview()).counters), counters);
  });
}
