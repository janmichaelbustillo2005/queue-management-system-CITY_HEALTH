// R2.1: doctor-ownership and caller verification for No-show, Recall, Re-Call, Requeue and Undo.
// Synthetic fixtures only. "mock Supabase" runs the real service against an isolated fake
// PostgREST client; "development memory" runs the local fallback. Neither is an
// independent-connection PostgreSQL concurrency test.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");

const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const LEGACY_FRONTDESK_LABEL = { id_num: "frontdesk", role: "admin", doctor_name: "Front Desk" };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const SERVICE = { 1: "consultation", 2: "prenatal", 3: "family_planning" };
const BASE_TIME = Date.parse("2026-10-14T01:00:00.000Z");
const NO_SHOW_WAIT = 11 * 60 * 1000;

const registration = (name, service, flags = []) => ({
  idNum: name, serviceType: service, vulnerabilityFlags: flags, mobileNumber: "09170001234",
  residency: "Sentinel Barangay Zone 9", philhealthId: "PHIL-SENTINEL-77", birthdate: "1951-02-03", sex: "X-SENTINEL"
});

async function setup(localFallback, options = {}) {
  const h = createHarness({ localFallback, clock: { now: BASE_TIME }, ...options });
  await h.initialize();
  return h;
}
async function calledPatient(h, number, name = `Patient D${number}`) {
  const patient = await h.service.createQueueEntry(registration(name, SERVICE[number]));
  h.advance();
  await h.service.callPatient(patient.id, `Doctor ${number}`);
  h.advance();
  return patient;
}
async function acceptedPatient(h, number, name) {
  const patient = await calledPatient(h, number, name);
  assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number))).status, 200);
  h.advance();
  return patient;
}
async function startedPatient(h, number, name) {
  const patient = await acceptedPatient(h, number, name);
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(number))).status, 200);
  h.advance();
  return patient;
}
async function cancelledPatient(h, number, name) {
  const patient = await startedPatient(h, number, name);
  const response = await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Synthetic cancellation" }, doctor(number));
  assert.equal(response.status, 200, response.body?.message);
  h.advance();
  return patient;
}
async function waitingPatient(h, number, name = `Waiting D${number}`) {
  const patient = await h.service.createQueueEntry(registration(name, SERVICE[number]));
  h.advance();
  return patient;
}
async function completedPatient(h, number) {
  const patient = await startedPatient(h, number);
  h.advance(5000);
  assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(number))).status, 200);
  h.advance();
  return patient;
}

async function row(h, patient) { return clone(await h.service.getPatientById(patient.id)); }
async function snapshot(h, patients, counterIds = null) {
  const rows = [];
  for (const patient of patients) rows.push(await row(h, patient));
  const counters = (await h.service.getQueueOverview()).counters
    .filter((counter) => !counterIds || counterIds.includes(counter.id))
    .map((counter) => ({ id: counter.id, current_patient_id: counter.current_patient_id ?? null }));
  return clone({ rows, counters });
}
const pointer = async (h, number) =>
  (await h.service.getQueueOverview()).counters.find((counter) => counter.id_num === `Doctor ${number}`).current_patient_id ?? null;
const voiceKeys = async (h) => (await h.request("GET", "/display", {}, null)).body.voice_announcements.map((event) => event.announcement_key);

// Each action with the patient state it applies to and its request.
const ACTIONS = {
  "no-show": {
    prepare: async (h, number) => { const patient = await calledPatient(h, number); h.advance(NO_SHOW_WAIT); return patient; },
    send: (h, patient, user, extra = {}) => h.request("POST", "/queue/no-show", { patient_id: patient.id, reason: "Synthetic no-show", ...extra }, user)
  },
  recall: {
    prepare: (h, number) => calledPatient(h, number),
    send: (h, patient, user, extra = {}) => h.request("POST", "/queue/recall", { patient_id: patient.id, ...extra }, user)
  },
  "re-call": {
    prepare: (h, number) => acceptedPatient(h, number),
    send: (h, patient, user, extra = {}) => h.request("POST", "/queue/re-call", { patient_id: patient.id, ...extra }, user)
  },
  requeue: {
    prepare: (h, number) => cancelledPatient(h, number),
    send: (h, patient, user, extra = {}) => h.request("POST", "/queue/requeue", { patient_id: patient.id, reason: "Synthetic requeue", ...extra }, user)
  },
  undo: {
    prepare: (h, number) => cancelledPatient(h, number),
    send: (h, patient, user, extra = {}) => h.request("POST", "/queue/undo", { patient_id: patient.id, ...extra }, user)
  }
};

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "mock Supabase";

  for (const [name, action] of Object.entries(ACTIONS)) {
    test(`${mode}: ${name} - each doctor may act on its own patient`, async () => {
      for (const number of [1, 2, 3]) {
        const h = await setup(localFallback);
        const patient = await action.prepare(h, number);
        const other = number === 1 ? 2 : 1;
        const bystander = await startedPatient(h, other, "Bystander");
        const bystanderBefore = await snapshot(h, [bystander], [other]);
        h.advance();
        const response = await action.send(h, patient, doctor(number));
        assert.equal(response.status, 200, `Doctor ${number}: ${response.body?.message}`);
        assert.deepEqual(await snapshot(h, [bystander], [other]), bystanderBefore, "another doctor's patient and counter are untouched");
        assert.equal((await row(h, patient)).counter_id === null || (await row(h, patient)).counter_id === `Doctor ${number}`, true,
          "the assignment is never moved to another doctor");
      }
    });

    for (const [attacker, victim] of [[2, 1], [3, 2], [1, 3]]) {
      test(`${mode}: ${name} - Doctor ${attacker} cannot act on Doctor ${victim}'s patient, even with forged counters or identity`, async () => {
        const h = await setup(localFallback);
        const owned = await action.prepare(h, victim);
        const mine = await startedPatient(h, attacker, "Attacker's own patient");
        const keysBefore = await voiceKeys(h);
        const before = await snapshot(h, [owned, mine]);
        h.advance();
        const forged = [
          {}, { counter_id: `Doctor ${attacker}` }, { counterId: `Doctor ${attacker}` }, { counter_id: `Doctor ${victim}` },
          { role: "superadmin", id_num: "superadmin", doctor_name: `Doctor ${victim}`, user: SUPERADMIN, actor: SUPERADMIN }
        ];
        for (const extra of forged) {
          const response = await action.send(h, owned, doctor(attacker), extra);
          assert.equal(response.status, 403, JSON.stringify(extra));
        }
        assert.deepEqual(await snapshot(h, [owned, mine]), before, "no patient, counter, timestamp, reason or attribution changed");
        assert.deepEqual(await voiceKeys(h), keysBefore, "no announcement event was created");
        // The rightful doctor can still perform the same action afterwards.
        h.advance();
        const rightful = await action.send(h, owned, doctor(victim));
        assert.equal(rightful.status, 200, rightful.body?.message);
      });
    }

    test(`${mode}: ${name} - Frontdesk (including the legacy label) and Superadmin keep their cross-doctor capability`, async () => {
      for (const user of [FRONTDESK, SUPERADMIN, LEGACY_FRONTDESK_LABEL]) {
        const h = await setup(localFallback);
        const patient = await action.prepare(h, 2);
        h.advance();
        const response = await action.send(h, patient, user);
        assert.equal(response.status, 200, `${user.id_num}/${user.doctor_name}: ${response.body?.message}`);
      }
    });

    test(`${mode}: ${name} - unauthorized roles and stale or mismatched sessions are rejected before any change`, async () => {
      const h = await setup(localFallback);
      const patient = await action.prepare(h, 1);
      const before = await snapshot(h, [patient]);
      const keysBefore = await voiceKeys(h);
      const rejected = [
        [null, 401],
        [{ id_num: "viewer1", role: "viewer", doctor_name: "Doctor 1" }, 403],
        [{ id_num: "admin1", role: "patient", doctor_name: "Doctor 1" }, 403],
        [{ id_num: "", role: "admin", doctor_name: "Doctor 1" }, 403],
        [{ id_num: "ghost", role: "admin", doctor_name: "Doctor 1" }, 403],
        [{ id_num: "admin1", role: "superadmin", doctor_name: null }, 403],
        [{ id_num: "admin1", role: "admin", doctor_name: "Doctor 2" }, 403],
        [{ id_num: "admin1", role: "admin", doctor_name: null }, 403],
        [{ id_num: "frontdesk", role: "admin", doctor_name: "Doctor 1" }, 403]
      ];
      for (const [user, status] of rejected) {
        const response = await action.send(h, patient, user);
        assert.equal(response.status, status, JSON.stringify(user));
      }
      assert.deepEqual(await snapshot(h, [patient]), before);
      assert.deepEqual(await voiceKeys(h), keysBefore);
    });

    test(`${mode}: ${name} - a doctor reassigned after sign-in cannot use the old token`, async () => {
      if (localFallback) return; // development memory has fixed seed accounts; covered by the mock-database run
      const h = await setup(localFallback);
      const patient = await action.prepare(h, 1);
      h.database.users.find((user) => user.id_num === "admin1").doctor_name = "Doctor 3";
      const before = await snapshot(h, [patient]);
      assert.equal((await action.send(h, patient, doctor(1))).status, 403);
      assert.deepEqual(await snapshot(h, [patient]), before);
    });

    test(`${mode}: ${name} - a missing patient is 404 for authorized staff`, async () => {
      const h = await setup(localFallback);
      const response = await action.send(h, { id: 987654 }, FRONTDESK);
      assert.equal(response.status, 404);
    });
  }

  // ---- No-show -----------------------------------------------------------
  test(`${mode}: no-show - own doctor releases only its counter; a repeat is idempotent and never rewrites history`, async () => {
    const h = await setup(localFallback);
    const mine = await calledPatient(h, 1);
    const other = await startedPatient(h, 2);
    h.advance(NO_SHOW_WAIT);
    assert.equal((await ACTIONS["no-show"].send(h, mine, doctor(1), { reason: "Did not arrive" })).status, 200);
    const stored = await row(h, mine);
    assert.equal(stored.status, "no-show");
    assert.equal(stored.reason, "Did not arrive");
    assert.equal(stored.counter_id, "Doctor 1");
    assert.equal(await pointer(h, 1), null);
    assert.equal(await pointer(h, 2), other.id, "Doctor 2 keeps its patient");
    const after = await snapshot(h, [mine, other]);
    h.advance(60000);
    for (const user of [doctor(1), FRONTDESK, SUPERADMIN]) {
      const repeat = await ACTIONS["no-show"].send(h, mine, user, { reason: "Another reason" });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.body.already_no_show, true);
    }
    assert.equal((await ACTIONS["no-show"].send(h, mine, doctor(2), { reason: "Overwrite" })).status, 403);
    assert.deepEqual(await snapshot(h, [mine, other]), after);
  });

  test(`${mode}: no-show - a completed consultation is protected and a cancelled visit must be undone first`, async () => {
    const h = await setup(localFallback);
    const done = await completedPatient(h, 3);
    const cancelled = await cancelledPatient(h, 1);
    h.advance(NO_SHOW_WAIT);
    const before = await snapshot(h, [done, cancelled]);
    for (const user of [doctor(3), FRONTDESK, SUPERADMIN]) assert.equal((await ACTIONS["no-show"].send(h, done, user)).status, 400);
    for (const user of [doctor(1), FRONTDESK]) assert.equal((await ACTIONS["no-show"].send(h, cancelled, user)).status, 409);
    assert.deepEqual(await snapshot(h, [done, cancelled]), before);
  });

  test(`${mode}: no-show - the minimum wait after a call is still enforced`, async () => {
    const h = await setup(localFallback);
    const patient = await calledPatient(h, 1);
    const before = await snapshot(h, [patient]);
    const response = await ACTIONS["no-show"].send(h, patient, doctor(1));
    assert.equal(response.status, 400);
    assert.match(response.body.message, /wait time not reached/i);
    assert.deepEqual(await snapshot(h, [patient]), before);
  });

  // ---- Recall (legacy repeat call before acceptance) -----------------------
  test(`${mode}: recall - the stored doctor is kept; a contradicting counter is rejected and never written`, async () => {
    const h = await setup(localFallback);
    const patient = await calledPatient(h, 1);
    const before = await snapshot(h, [patient]);
    for (const user of [doctor(1), FRONTDESK, SUPERADMIN]) {
      for (const extra of [{ counterId: "Doctor 2" }, { counter_id: "Doctor 3" }, { counterId: "Doctor 99" }]) {
        const response = await ACTIONS.recall.send(h, patient, user, extra);
        assert.ok([400, 409].includes(response.status), `${user.id_num} ${JSON.stringify(extra)} -> ${response.status}`);
      }
    }
    assert.deepEqual(await snapshot(h, [patient]), before);
    h.advance();
    const ok = await ACTIONS.recall.send(h, patient, FRONTDESK, { counterId: "Doctor 1" });
    assert.equal(ok.status, 200, ok.body.message);
    const after = await row(h, patient);
    assert.equal(after.counter_id, "Doctor 1");
    assert.equal(after.status, "serving");
    assert.notEqual(after.called_at, before.rows[0].called_at, "recall refreshes only the call time");
    assert.equal(await pointer(h, 1), patient.id);
    assert.equal(h.settings.getRecallCount(patient.id), 1);
  });

  test(`${mode}: recall - an accepted or started patient still cannot be recalled by anyone`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h, 2);
    const before = await snapshot(h, [patient]);
    for (const user of [doctor(2), FRONTDESK, SUPERADMIN]) assert.equal((await ACTIONS.recall.send(h, patient, user)).status, 400);
    assert.deepEqual(await snapshot(h, [patient]), before);
  });

  test(`${mode}: recall - a serving visit without a stored doctor cannot be assigned through recall`, async () => {
    const h = await setup(localFallback);
    const orphan = await h.service.createQueueEntry(registration("Legacy Orphan", "consultation"));
    h.advance();
    const stored = localFallback ? await h.service.getPatientById(orphan.id) : h.database.patients.find((item) => item.id === orphan.id);
    Object.assign(stored, { status: "serving", called_at: new Date(h.clock.now).toISOString(), counter_id: null });
    const before = await snapshot(h, [orphan]);
    for (const user of [FRONTDESK, SUPERADMIN]) assert.equal((await ACTIONS.recall.send(h, orphan, user, { counterId: "Doctor 2" })).status, 409);
    assert.equal((await ACTIONS.recall.send(h, orphan, doctor(1))).status, 403);
    assert.deepEqual(await snapshot(h, [orphan]), before);
  });

  // ---- Re-Call -------------------------------------------------------------
  test(`${mode}: re-call - events keep their identity: authorized Re-Call adds one new event, a denied one adds none`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h, 1);
    const initial = (await h.request("GET", "/display", {}, null)).body.voice_announcements;
    assert.equal(initial.length, 1);
    assert.equal(initial[0].queue_number, patient.queue_number);
    assert.equal(initial[0].counter_name, "Doctor 1");
    h.advance();
    assert.equal((await ACTIONS["re-call"].send(h, patient, doctor(2))).status, 403);
    assert.deepEqual(await voiceKeys(h), initial.map((event) => event.announcement_key));
    h.advance();
    const response = await ACTIONS["re-call"].send(h, patient, doctor(1));
    assert.equal(response.status, 200);
    const events = (await h.request("GET", "/display", {}, null)).body.voice_announcements;
    assert.equal(events.length, 2);
    assert.equal(new Set(events.map((event) => event.announcement_key)).size, 2);
    assert.ok(events.every((event) => event.queue_number === patient.queue_number && event.counter_name === "Doctor 1"));
    assert.ok(events.some((event) => event.announcement_key === initial[0].announcement_key), "the original Accept event is unchanged");
    assert.equal(response.body.announcement_key, events.find((event) => event.announcement_key !== initial[0].announcement_key).announcement_key);
  });

  test(`${mode}: re-call - a contradicting body counter is rejected without an event`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h, 3);
    const keysBefore = await voiceKeys(h);
    for (const user of [doctor(3), FRONTDESK, SUPERADMIN]) {
      const response = await ACTIONS["re-call"].send(h, patient, user, { counterId: "Doctor 1" });
      assert.ok([403, 409].includes(response.status), `${user.id_num}: ${response.status}`);
    }
    assert.deepEqual(await voiceKeys(h), keysBefore);
  });

  // ---- Requeue / Undo ------------------------------------------------------
  test(`${mode}: undo - own doctor returns a cancelled patient to clean waiting and it can be called again`, async () => {
    const h = await setup(localFallback);
    const patient = await cancelledPatient(h, 2);
    const other = await startedPatient(h, 1);
    const otherBefore = await snapshot(h, [other], [1, 3]);
    const cancelled = await row(h, patient);
    h.advance();
    assert.equal((await ACTIONS.undo.send(h, patient, doctor(2))).status, 200);
    const waiting = await row(h, patient);
    assert.equal(waiting.status, "waiting");
    for (const field of ["called_at", "consultation_started_at", "completed_at", "counter_id"]) assert.equal(waiting[field], null, field);
    assert.notEqual(waiting.visit_state_revision, cancelled.visit_state_revision);
    assert.deepEqual(await snapshot(h, [other], [1, 3]), otherBefore);
    h.advance();
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id }, FRONTDESK)).status, 200);
  });

  test(`${mode}: requeue - own doctor moves a cancelled patient to the end of its tier without touching other doctors`, async () => {
    const h = await setup(localFallback);
    const patient = await cancelledPatient(h, 3);
    const other = await startedPatient(h, 1);
    const otherBefore = await snapshot(h, [other], [1, 2]);
    h.advance();
    assert.equal((await ACTIONS.requeue.send(h, patient, doctor(3))).status, 200);
    const stored = await row(h, patient);
    assert.equal(stored.status, "waiting");
    assert.equal(stored.counter_id, null);
    assert.equal(stored.reason, "Synthetic requeue");
    assert.deepEqual(await snapshot(h, [other], [1, 2]), otherBefore);
  });

  test(`${mode}: undo and requeue - a denied cross-doctor attempt does not consume the revision or alter the visit`, async () => {
    const h = await setup(localFallback);
    const patient = await cancelledPatient(h, 1);
    const before = await row(h, patient);
    for (const attacker of [2, 3]) {
      assert.equal((await ACTIONS.undo.send(h, patient, doctor(attacker))).status, 403);
      assert.equal((await ACTIONS.requeue.send(h, patient, doctor(attacker))).status, 403);
    }
    assert.deepEqual(await row(h, patient), before, "identical row including visit_state_revision");
    assert.equal((await ACTIONS.undo.send(h, patient, doctor(1))).status, 200);
  });

  test(`${mode}: undo and requeue - a completed consultation is protected from every role`, async () => {
    const h = await setup(localFallback);
    const patient = await completedPatient(h, 2);
    const before = await snapshot(h, [patient]);
    for (const user of [doctor(2), FRONTDESK, SUPERADMIN]) {
      for (const name of ["undo", "requeue"]) {
        const response = await ACTIONS[name].send(h, patient, user);
        assert.equal(response.status, 400, `${name} by ${user.id_num}`);
        assert.match(response.body.message, /history must be preserved/i);
      }
    }
    for (const name of ["undo", "requeue"]) assert.equal((await ACTIONS[name].send(h, patient, doctor(1))).status, 403);
    assert.deepEqual(await snapshot(h, [patient]), before);
  });

  test(`${mode}: requeue - a doctor cannot re-queue a waiting patient routed to another doctor`, async () => {
    const h = await setup(localFallback);
    const waiting = await waitingPatient(h, 2);
    const before = await snapshot(h, [waiting]);
    assert.equal((await ACTIONS.requeue.send(h, waiting, doctor(1))).status, 403);
    assert.deepEqual(await snapshot(h, [waiting]), before);
  });

  test(`${mode}: requeue and undo still validate the patient id before acting`, async () => {
    const h = await setup(localFallback);
    await cancelledPatient(h, 1);
    assert.equal((await h.request("POST", "/queue/requeue", { patient_id: "abc" }, FRONTDESK)).status, 400);
    assert.equal((await h.request("POST", "/queue/undo", { patient_id: 0 }, FRONTDESK)).status, 400);
  });

  // ---- Cross-midnight serving patient -------------------------------------
  test(`${mode}: a serving visit carried past Manila midnight is protected from other doctors for every action`, async () => {
    const h = createHarness({ localFallback, clock: { now: Date.parse("2026-10-10T15:59:20.000Z") } });
    await h.initialize();
    const patient = await h.service.createQueueEntry(registration("Midnight Serving", "prenatal"));
    await h.service.callPatient(patient.id, "Doctor 2");
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(2))).status, 200);
    h.advance(60000 + NO_SHOW_WAIT);
    const before = await snapshot(h, [patient]);
    for (const intruder of [doctor(1), doctor(3)]) {
      for (const [name, action] of Object.entries(ACTIONS)) {
        const response = await action.send(h, patient, intruder);
        assert.equal(response.status, 403, `${name} by ${intruder.doctor_name}`);
      }
      assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "x" }, intruder)).status, 403);
    }
    assert.deepEqual(await snapshot(h, [patient]), before);
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Owner cancels" }, doctor(2))).status, 200);
  });

  // ---- Lifecycle and priority are unchanged --------------------------------
  test(`${mode}: Call -> Accept -> Start -> Complete and weighted-priority order are unchanged`, async () => {
    const h = await setup(localFallback);
    const regular = await waitingPatient(h, 1, "Regular One");
    const senior = await h.service.createQueueEntry(registration("Senior One", "consultation", ["senior"]));
    h.advance();
    const family = await waitingPatient(h, 3, "Family One");
    const order = (await h.request("GET", "/display", {}, null)).body.waiting_queue.map((entry) => entry.queue_number);
    assert.deepEqual(order, [senior, regular, family].map((patient) => patient.queue_number));
    assert.equal((await h.request("POST", "/queue/call", { patient_id: regular.id, counterId: "Doctor 1" }, FRONTDESK)).status, 400);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: senior.id, counterId: "Doctor 1" }, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: senior.id }, doctor(1))).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/start", { patient_id: senior.id }, doctor(1))).status, 200);
    h.advance(5000);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: senior.id }, doctor(1))).status, 200);
    assert.equal((await row(h, senior)).status, "completed");
    assert.equal(await pointer(h, 1), null);
  });
}

// ---------------------------------------------------------------------------
// Delayed or concurrent requests through the isolated fake client's hooks. These check the
// service's conditional-write and revision logic, not PostgreSQL row locking between
// independent connections.
// ---------------------------------------------------------------------------
test("mock Supabase: a Cancel committed between No-show's validation and write makes the No-show fail and keeps the cancellation", async () => {
  const h = await setup(false);
  const patient = await calledPatient(h, 1);
  h.advance(NO_SHOW_WAIT);
  h.database.beforeQuery = async (query) => {
    if (query.table !== "patients" || query.action !== "update" || query.payload.status !== "no-show") return undefined;
    h.database.beforeQuery = null;
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Cancelled first" }, doctor(1))).status, 200);
    return undefined;
  };
  const response = await ACTIONS["no-show"].send(h, patient, doctor(1));
  assert.equal(response.status, 400, response.body.message);
  const stored = await row(h, patient);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.reason, "Cancelled first");
  assert.equal(await pointer(h, 1), null);
});

test("mock Supabase: a Cancel committed between Recall's validation and write cannot be turned back into serving", async () => {
  const h = await setup(false);
  const patient = await calledPatient(h, 2);
  h.database.beforeQuery = async (query) => {
    if (query.table !== "patients" || query.action !== "update" || !("called_at" in query.payload)) return undefined;
    h.database.beforeQuery = null;
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Cancelled first" }, FRONTDESK)).status, 200);
    return undefined;
  };
  const response = await ACTIONS.recall.send(h, patient, doctor(2));
  assert.ok([400, 409].includes(response.status), String(response.status));
  assert.equal((await row(h, patient)).status, "cancelled");
  assert.equal(h.settings.getRecallCount(patient.id), 0);
});

test("mock Supabase: a stale Undo by the owner cannot overwrite a newer cancellation cycle", async () => {
  const h = await setup(false);
  const patient = await cancelledPatient(h, 1);
  let latest;
  h.database.beforeRpc = async (name) => {
    if (name !== "undo_patient_visit_waiting") return;
    h.database.beforeRpc = null;
    h.advance();
    assert.equal((await ACTIONS.undo.send(h, patient, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Second cancellation" }, FRONTDESK)).status, 200);
    latest = await row(h, patient);
  };
  const stale = await ACTIONS.undo.send(h, patient, doctor(1));
  assert.equal(stale.status, 409, stale.body?.message);
  assert.deepEqual(await row(h, patient), latest);
});

test("mock Supabase: a stale Requeue cannot overwrite a consultation completed after its snapshot", async () => {
  const h = await setup(false);
  const patient = await cancelledPatient(h, 2);
  // Another instance restores the visit and a doctor finishes a new consultation before Requeue commits.
  let completed;
  h.database.beforeRpc = async (name) => {
    if (name !== "recover_patient_visit") return;
    h.database.beforeRpc = null;
    h.advance();
    assert.equal((await ACTIONS.undo.send(h, patient, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id }, FRONTDESK)).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(2))).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(2))).status, 200);
    h.advance(3000);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(2))).status, 200);
    completed = await row(h, patient);
  };
  const stale = await ACTIONS.requeue.send(h, patient, doctor(2));
  assert.equal(stale.status, 409, stale.body?.message);
  assert.deepEqual(await row(h, patient), completed);
  assert.equal(completed.status, "completed");
  assert.ok(completed.consultation_started_at);
});

// ---------------------------------------------------------------------------
// The patient update and the counter release are two separate statements today. These tests
// pin the documented partial-failure window and show that a retry repairs the counter without
// rewriting the patient. They do NOT make Cancel atomic; that needs the proposed database function.
// ---------------------------------------------------------------------------
for (const name of ["cancel", "no-show"]) {
  test(`mock Supabase: ${name} committed the patient but failed to release the counter - the window is observable and a retry repairs only the pointer`, async () => {
    const h = await setup(false);
    const patient = name === "cancel" ? await startedPatient(h, 1) : await calledPatient(h, 1);
    const bystander = await startedPatient(h, 2, "Bystander");
    if (name === "no-show") h.advance(NO_SHOW_WAIT);
    const send = (user, extra = {}) => name === "cancel"
      ? h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Synthetic", ...extra }, user)
      : ACTIONS["no-show"].send(h, patient, user, extra);
    h.database.beforeQuery = (query) => {
      if (query.table === "counters" && query.action === "update") return { data: null, error: { message: "fetch failed (isolated counter outage)" } };
      return undefined;
    };
    const failed = await send(doctor(1));
    assert.equal(failed.status, 503, failed.body?.message);
    // The failure window: the visit is already terminal while the doctor's counter still points at it.
    const stuck = await row(h, patient);
    assert.equal(stuck.status, name === "cancel" ? "cancelled" : "no-show");
    assert.equal(await pointer(h, 1), patient.id);
    assert.equal(await pointer(h, 2), bystander.id);
    h.database.beforeQuery = null;
    h.advance(60000);
    // Another doctor cannot use the retry to touch it.
    assert.equal((await send(doctor(2))).status, 403);
    assert.equal(await pointer(h, 1), patient.id);
    // The owner's retry is idempotent for the patient and repairs only the stale pointer.
    const retry = await send(doctor(1), { reason: "A different reason" });
    assert.equal(retry.status, 200, retry.body?.message);
    assert.equal(await pointer(h, 1), null);
    assert.equal(await pointer(h, 2), bystander.id, "other doctors' counters are untouched");
    assert.deepEqual(await row(h, patient), stuck, "reason, completion time, assignment and revision are unchanged");
  });
}
