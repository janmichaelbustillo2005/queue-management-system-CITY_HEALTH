// C1: Call establishes one consistent patient/doctor-counter pair or changes nothing, and never
// creates a pending acceptance, SMS or voice event for a call that did not commit.
// Synthetic data only. The mock Supabase harness models call_patient_visit's checks and
// all-or-nothing commit; PostgreSQL locking is covered by c1-atomic-call-concurrency.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const BASE_TIME = Date.parse("2026-10-25T02:00:00.000Z"); // 10:00 Manila
const SERVICE = { 1: "consultation", 2: "prenatal", 3: "family_planning" };
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });

function shared({ installed = false } = {}) {
  const database = createDatabase();
  database.callRpcInstalled = installed;
  const clock = { now: BASE_TIME };
  const files = new Map();
  return { database, first: createHarness({ database, clock, files }), second: createHarness({ database, clock, files }) };
}

async function register(h, number = 1, name = `Synthetic D${number}`, flags = []) {
  const patient = await h.service.createQueueEntry({
    idNum: name, serviceType: SERVICE[number], mobileNumber: "09170000000", vulnerabilityFlags: flags
  });
  h.advance();
  return patient;
}

const row = (h, id) => h.database.patients.find((patient) => patient.id === id);
const pointer = (h, number) => h.database.counters[number - 1].current_patient_id;
const smsCount = (...harnesses) => harnesses.flatMap((h) => h.notifications).filter((entry) => entry.type === "called").length;
const callRpcs = (h) => h.database.calls.filter((entry) => entry.action === "rpc" && entry.function === "call_patient_visit");

// No side effect of a successful call may exist for a refused one.
function assertNoCallSideEffects(h, id, label) {
  assert.equal(h.settings.isAwaitingAccept(id), false, `${label}: no pending acceptance`);
  assert.equal(h.settings.getAcceptedAt(id), null, `${label}: no acceptance`);
  assert.equal(h.settings.getVoiceAnnouncementEvents().length, 0, `${label}: no voice event`);
}

function assertPair(h, id, number) {
  const patient = row(h, id);
  assert.equal(patient.status, "serving");
  assert.equal(patient.counter_id, `Doctor ${number}`);
  assert.ok(patient.called_at);
  assert.equal(patient.completed_at, null);
  assert.equal(pointer(h, number), id);
  assert.equal(h.database.counters.filter((counter) => counter.current_patient_id === id).length, 1);
}

// Runs `during` once, right before the Call's patient serving update (the fallback's second statement).
function betweenCallStatements(h, during) {
  let fired = false;
  h.database.beforeQuery = async (query) => {
    if (!fired && query.table === "patients" && query.action === "update" && query.payload.status === "serving") {
      fired = true;
      await during();
    }
  };
  return () => fired;
}

for (const recovery of ["requeue", "undo"]) {
  // The exact F5-audit defect, through the real backend Call (migration not installed).
  test(`fallback: Cancel then ${recovery} committed between Call's two statements refuses the Call and leaves no pair half-made`, async () => {
    const { first, second } = shared();
    const patient = await register(first, 3);
    const original = clone(row(first, patient.id));
    const fired = betweenCallStatements(first, async () => {
      assert.equal(pointer(first, 3), patient.id, "Call statement 1 claimed Doctor 3");
      assert.equal((await second.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Synthetic" }, FRONTDESK)).status, 200);
      second.advance();
      const recovered = await second.request("POST", `/queue/${recovery}`, { patient_id: patient.id, reason: "Synthetic" }, FRONTDESK);
      assert.equal(recovered.status, 200, recovered.body.message);
    });
    const response = await first.request("POST", "/queue/call", { patient_id: patient.id, counterId: "Doctor 3" });
    assert.ok(fired());
    assert.equal(response.status, 400, response.body.message);
    assert.match(response.body.message, /no longer eligible/);
    const after = row(first, patient.id);
    assert.equal(after.status, "waiting");
    assert.equal(after.called_at, null);
    assert.equal(after.counter_id, null);
    assert.notEqual(after.visit_state_revision, original.visit_state_revision);
    assert.equal(pointer(first, 3), null, "no counter left on any visit");
    assertNoCallSideEffects(first, patient.id, recovery);
    assert.equal(smsCount(first, second), 0);
    // A fresh Call of the recovered visit forms one correct pair.
    first.database.beforeQuery = null;
    assert.equal((await first.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    assertPair(first, patient.id, 3);
  });
}

test("fallback: a Cancel committed between Call's two statements leaves the visit cancelled with no counter", async () => {
  const { first, second } = shared();
  const patient = await register(first, 1);
  betweenCallStatements(first, async () => {
    assert.equal((await second.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Left" }, FRONTDESK)).status, 200);
  });
  assert.equal((await first.request("POST", "/queue/call", { patient_id: patient.id })).status, 400);
  assert.equal(row(first, patient.id).status, "cancelled");
  assert.equal(row(first, patient.id).called_at, null);
  assert.equal(pointer(first, 1), null);
  assertNoCallSideEffects(first, patient.id, "cancel");
});

test("atomic RPC: a successful Call commits one pair through call_patient_visit only, then marks acceptance once", async () => {
  const { first } = shared({ installed: true });
  const patient = await register(first, 2);
  const before = clone(row(first, patient.id));
  first.database.calls.length = 0;
  const response = await first.request("POST", "/queue/call", { patient_id: patient.id, counter_id: "Doctor 2" }, FRONTDESK);
  assert.equal(response.status, 200, response.body.message);
  assertPair(first, patient.id, 2);
  const [rpc] = callRpcs(first);
  assert.deepEqual(rpc.args, {
    p_patient_id: patient.id, p_doctor_name: "Doctor 2", p_user_id_num: "frontdesk",
    p_expected_revision: before.visit_state_revision,
    p_queue_start: "2026-10-24T16:00:00.000Z", p_queue_end: "2026-10-25T16:00:00.000Z"
  });
  assert.equal(first.database.calls.filter((entry) => entry.action === "update").length, 0, "no separate patient or counter write");
  assert.equal(first.settings.isAwaitingAccept(patient.id), true);
  assert.equal(first.settings.getVoiceAnnouncementEvents().length, 0, "calling waits for doctor acceptance before announcing");
  assert.equal(smsCount(first), 1);
});

test("atomic RPC: Cancel + Requeue committed after Node's checks makes the RPC refuse the old revision (409), nothing changes", async () => {
  const { first, second } = shared({ installed: true });
  const patient = await register(first, 3);
  first.database.beforeRpc = async (name) => {
    if (name !== "call_patient_visit") return;
    first.database.beforeRpc = null;
    assert.equal((await second.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Synthetic" }, FRONTDESK)).status, 200);
    second.advance();
    assert.equal((await second.request("POST", "/queue/requeue", { patient_id: patient.id, reason: "Synthetic" }, FRONTDESK)).status, 200);
  };
  const recovered = () => clone(row(first, patient.id));
  const response = await first.request("POST", "/queue/call", { patient_id: patient.id });
  assert.equal(response.status, 409, response.body.message);
  assert.match(response.body.message, /visit changed/);
  const after = recovered();
  assert.deepEqual([after.status, after.counter_id, after.called_at], ["waiting", null, null]);
  assert.equal(pointer(first, 3), null);
  assertNoCallSideEffects(first, patient.id, "stale rpc");
  assert.equal(smsCount(first, second), 0);
});

test("atomic RPC: priority, availability and account changes after Node's checks are re-checked inside the transaction", async () => {
  const cases = {
    "a higher-priority registration": [400, /queue priority/, async (h) => {
      await h.service.createQueueEntry({ idNum: "Synthetic senior", serviceType: "consultation", vulnerabilityFlags: ["senior"] });
    }],
    "the doctor going offline": [400, /offline/, async (h) => { h.database.counters[0].is_online = false; }],
    "the doctor's counter being taken": [400, /already serving/, async (h) => { h.database.counters[0].current_patient_id = 999; }],
    "the doctor account being reassigned": [403, /assigned to your doctor/, async (h) => { h.database.users[0].doctor_name = "Doctor 2"; }]
  };
  for (const [label, [status, message, change]] of Object.entries(cases)) {
    const { first } = shared({ installed: true });
    const patient = await register(first, 1);
    const before = clone(row(first, patient.id));
    first.database.beforeRpc = async (name) => { if (name === "call_patient_visit") await change(first); };
    const response = await first.request("POST", "/queue/call", { patient_id: patient.id }, doctor(1));
    assert.equal(response.status, status, `${label}: ${response.body.message}`);
    assert.match(response.body.message, message, label);
    assert.deepEqual(row(first, patient.id), before, `${label}: patient unchanged`);
    assert.notEqual(pointer(first, 1), patient.id, `${label}: no pointer to the patient`);
    assertNoCallSideEffects(first, patient.id, label);
    assert.equal(smsCount(first), 0, label);
  }
});

test("persisted account, not the token, authorizes Call: forged roles, doctors and counters are refused before any write", async () => {
  for (const installed of [false, true]) {
    const { first } = shared({ installed });
    const patient = await register(first, 3);
    const before = clone(row(first, patient.id));
    const forged = [
      [{ id_num: "admin1", role: "admin", doctor_name: "Doctor 3" }, {}, /not assigned to this doctor/],
      [{ id_num: "admin1", role: "superadmin", doctor_name: null }, {}, /no longer matches/],
      [{ id_num: "frontdesk", role: "admin", doctor_name: "Doctor 3" }, {}, /not assigned to this doctor/],
      [{ id_num: "frontdesk", role: "superadmin", doctor_name: null }, {}, /no longer matches/],
      [{ id_num: "ghost", role: "admin", doctor_name: null }, {}, /no longer matches/],
      [{ id_num: "admin3", role: "doctor", doctor_name: "Doctor 3" }, {}, /authenticated staff account/],
      [doctor(1), { counterId: "Doctor 3" }, /assigned to your doctor/]
    ];
    for (const [user, body, message] of forged) {
      first.database.calls.length = 0;
      const response = await first.request("POST", "/queue/call", { patient_id: patient.id, ...body }, user);
      assert.equal(response.status, 403, `${installed} ${JSON.stringify(user)}: ${response.body.message}`);
      assert.match(response.body.message, message);
      assert.equal(first.database.calls.filter((entry) => entry.action === "update" || entry.action === "rpc").length, 0, "no write attempted");
    }
    assert.deepEqual(row(first, patient.id), before);
    assert.equal(pointer(first, 3), null);
    assertNoCallSideEffects(first, patient.id, "forged");
    // Existing permissions remain: the owning doctor, Frontdesk (incl. legacy label) and Superadmin.
    for (const user of [doctor(3), FRONTDESK, { ...FRONTDESK, doctor_name: "Front Desk" }, SUPERADMIN]) {
      const { first: h } = shared({ installed });
      const visit = await register(h, 3);
      const response = await h.request("POST", "/queue/call", { patient_id: visit.id }, user);
      assert.equal(response.status, 200, `${installed} ${JSON.stringify(user)}: ${response.body.message}`);
      assertPair(h, visit.id, 3);
    }
  }
});

test("atomic RPC: a lost response is never reported as success and never fabricates a pending acceptance", async () => {
  for (const committed of [false, true]) {
    const { first } = shared({ installed: true });
    const patient = await register(first, 1);
    const rpc = first.database.beforeRpc;
    first.database.beforeRpc = async (name) => {
      if (name !== "call_patient_visit") return rpc?.(name);
      if (!committed) throw new Error("fetch failed: socket hang up");
      // Commit inside the emulated database, then lose the response.
      first.database.beforeRpc = null;
      const harness = createHarness({ database: first.database, clock: first.clock });
      await harness.service.callPatient(patient.id, "Doctor 1", FRONTDESK);
      return { data: null, error: { message: "TypeError: fetch failed" } };
    };
    const response = await first.request("POST", "/queue/call", { patient_id: patient.id });
    assert.equal(response.status, 503, response.body.message);
    assert.match(response.body.message, /Could not confirm the call/);
    assert.equal(first.settings.isAwaitingAccept(patient.id), false, "no pending acceptance from this request");
    assert.equal(smsCount(first), 0, "no SMS from this request");
    if (committed) {
      // The committed pair stands; its doctor accepts it explicitly and the voice event follows acceptance.
      assertPair(first, patient.id, 1);
      const accepted = await first.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(1));
      assert.equal(accepted.status, 200, accepted.body.message);
      assert.equal(first.settings.getVoiceAnnouncementEvents().length, 1);
    } else {
      assert.equal(row(first, patient.id).status, "waiting");
      assert.equal(pointer(first, 1), null);
    }
  }
});

test("atomic RPC: an unconfirmed result row is refused without side effects", async () => {
  const { first } = shared({ installed: true });
  const patient = await register(first, 1);
  first.database.beforeRpc = (name) => name === "call_patient_visit"
    ? { data: { ...clone(row(first, patient.id)), status: "waiting" }, error: null } : null;
  const response = await first.request("POST", "/queue/call", { patient_id: patient.id });
  assert.equal(response.status, 503);
  assertNoCallSideEffects(first, patient.id, "unconfirmed");
  assert.equal(smsCount(first), 0);
});

test("atomic RPC: duplicate and competing Calls from separate backend instances form exactly one pair per doctor", async () => {
  const { database, first, second } = shared({ installed: true });
  const patient = await register(first, 1);
  const results = await Promise.all([
    first.request("POST", "/queue/call", { patient_id: patient.id }),
    second.request("POST", "/queue/call", { patient_id: patient.id }, SUPERADMIN)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assertPair(first, patient.id, 1);
  assert.equal(smsCount(first, second), 1);
  // A repeat of the same request after success is refused and changes nothing.
  const winner = clone(row(first, patient.id));
  assert.equal((await first.request("POST", "/queue/call", { patient_id: patient.id })).status, 400);
  assert.deepEqual(row(first, patient.id), winner);

  // Two different waiting patients contending for Doctor 2.
  const ob1 = await register(first, 2, "OB first");
  const ob2 = await register(first, 2, "OB second");
  database.patients.find((row) => row.id === ob2.id).priority_score = ob1.priority_score; // same tier
  const contended = await Promise.all([
    first.request("POST", "/queue/call", { patient_id: ob1.id }),
    second.request("POST", "/queue/call", { patient_id: ob2.id })
  ]);
  assert.deepEqual(contended.map((result) => result.status), [200, 400], "registration order decides the tie");
  assertPair(first, ob1.id, 2);
  assert.equal(row(first, ob2.id).status, "waiting");
});

test("atomic RPC: Weighted-Priority order is unchanged - higher priority first, then registration order", async () => {
  const { first } = shared({ installed: true });
  const regular = await register(first, 1, "Regular");
  const senior = await register(first, 1, "Senior", ["senior"]);
  const laterSenior = await register(first, 1, "Later senior", ["senior"]);
  for (const id of [regular.id, laterSenior.id]) {
    const response = await first.request("POST", "/queue/call", { patient_id: id });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /according to queue priority/);
  }
  assert.equal(callRpcs(first).length, 0, "Node's ranking refuses before the RPC");
  assert.equal((await first.request("POST", "/queue/call", { patient_id: senior.id })).status, 200);
  assertPair(first, senior.id, 1);
});

test("atomic RPC: a stale Call after acceptance cannot reset the doctor's acceptance or announce again", async () => {
  const { first, second } = shared({ installed: true });
  const patient = await register(first, 1);
  assert.equal((await first.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
  assert.equal((await first.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(1))).status, 200);
  const acceptedAt = first.settings.getAcceptedAt(patient.id);
  const response = await second.request("POST", "/queue/call", { patient_id: patient.id });
  assert.equal(response.status, 400);
  assert.equal(first.loadSettings().getAcceptedAt(patient.id), acceptedAt);
  assert.equal(first.loadSettings().isAwaitingAccept(patient.id), false);
  assert.equal(first.settings.getVoiceAnnouncementEvents().length, 1);
  assert.equal(smsCount(first, second), 1);
});

test("atomic RPC requires a staff identity: a trusted in-process Call without an actor is refused unchanged", async () => {
  const { first } = shared({ installed: true });
  const patient = await register(first, 1);
  const before = clone(row(first, patient.id));
  await assert.rejects(first.service.callPatient(patient.id, "Doctor 1"), /staff identity/);
  assert.deepEqual(row(first, patient.id), before);
  assertNoCallSideEffects(first, patient.id, "no actor");
});

test("development memory: Call rotates the visit revision so a stale Cancel is refused", async () => {
  const h = createHarness({ localFallback: true, clock: { now: BASE_TIME } });
  await h.initialize();
  const patient = await register(h, 1);
  const waiting = clone(await h.service.getPatientById(patient.id));
  assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
  const called = await h.service.getPatientById(patient.id);
  assert.equal(called.status, "serving");
  assert.notEqual(called.visit_state_revision ?? null, waiting.visit_state_revision ?? null);
  assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
});
