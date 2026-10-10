const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase } = require("./helpers/queueHarness");

const doctorUser = (name) => ({ id_num: "admin", role: "admin", doctor_name: name });
const registration = (name, service = "consultation", flags = []) => ({
  idNum: name, serviceType: service, vulnerabilityFlags: flags,
  mobileNumber: "09123456789", residency: "Cabadbaran", philhealthId: "YAKAP-123",
  birthdate: "1990-04-12", sex: "Female"
});

async function setup(localFallback = false) {
  const harness = createHarness({ localFallback });
  await harness.initialize();
  return harness;
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "mock Supabase";

  test(`${mode}: registration preserves service mapping, prefixes, weights, null fields and YAKAP data`, async () => {
    const h = await setup(localFallback);
    for (const [service, prefix] of [["consultation", "GP"], ["checkup", "GP"], ["prenatal", "OB"], ["maternity", "OB"], ["family_planning", "FP"]]) {
      const patient = await h.service.createQueueEntry(registration(service, service, ["senior", "pwd"]));
      assert.match(patient.queue_number, new RegExp(`^${prefix}-\\d{3}$`));
      assert.equal(patient.priority_score, 7);
      assert.equal(patient.status, "waiting");
      for (const field of ["counter_id", "called_at", "completed_at"]) assert.equal(patient[field], null);
      assert.equal(patient.philhealth_id, "YAKAP-123");
      assert.equal(patient.residency, "Cabadbaran");
      assert.equal(patient.birthdate, "1990-04-12");
      assert.equal(patient.sex, "Female");
    }
    const patients = (await h.service.getQueueOverview()).patients;
    assert.equal(new Set(patients.map((p) => p.queue_number)).size, 5);
    assert.equal((await h.service.createQueueEntry(registration("Regular"))).priority_score, 1);
  });

  test(`${mode}: frontdesk call -> doctor acceptance -> persistent display event, without completion`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    const called = await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: "Doctor 1" });
    assert.equal(called.status, 200, called.body.message);
    let current = await h.service.getPatientById(patient.id);
    assert.equal(current.status, "serving");
    assert.equal(current.counter_id, "Doctor 1");
    assert.ok(current.called_at);
    assert.equal(current.completed_at, null);
    assert.equal(h.settings.isAwaitingAccept(patient.id), true);
    const overview = await h.service.getQueueOverview();
    assert.equal(overview.patients.find((p) => p.id === patient.id).awaiting_accept, true);
    const counter = overview.counters.find((c) => c.id_num === "Doctor 1");
    assert.equal(counter.current_patient_id, patient.id);
    assert.equal(counter.name, "Doctor 1", "Counter cards retain doctor names in both storage modes");
    assert.equal(counter.ID_Num, "Doctor 1");
    assert.equal(counter.current_patient_name, "Alice");
    assert.equal(counter.current_patient_queue_number, patient.queue_number);
    let display = await h.service.getDisplayData();
    assert.equal(display.all_serving[0].queue_number, patient.queue_number);
    assert.equal(display.all_serving[0].counter_id, 1);
    assert.equal(display.all_serving[0].counter_name, "Doctor 1");
    assert.equal(display.recent_accepted.length, 0, "Frontdesk call must not create a voice event");
    assert.equal(display.voice_announcements.length, 0);

    const wrongDoctor = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser("Doctor 2"));
    assert.equal(wrongDoctor.status, 403);
    assert.equal(h.settings.isAwaitingAccept(patient.id), true);
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 0, "Wrong doctor cannot create a voice event");
    h.advance();
    const accepted = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser("Doctor 1"));
    assert.equal(accepted.status, 200, accepted.body.message);
    assert.equal(h.settings.isAwaitingAccept(patient.id), false);
    const acceptedAt = h.settings.getAcceptedAt(patient.id);
    assert.ok(acceptedAt);
    assert.equal(h.loadSettings().getAcceptedAt(patient.id), acceptedAt, "Accept event survives settings-module restart in virtual storage");
    current = await h.service.getPatientById(patient.id);
    assert.equal(current.status, "serving");
    assert.equal(current.counter_id, "Doctor 1");
    assert.equal(current.completed_at, null);
    display = await h.service.getDisplayData();
    assert.equal(display.recent_accepted.length, 1);
    assert.equal(display.recent_accepted[0].accepted_at, acceptedAt);
    assert.equal(display.recent_accepted[0].counter_name, "Doctor 1");
    assert.equal(display.voice_announcements.length, 1);
    assert.equal(display.voice_announcements[0].announcement_key, accepted.body.announcement_key);
    assert.equal(display.voice_announcements[0].announcement_at, acceptedAt);
    assert.equal(display.voice_announcements[0].event_type, "accept");
    assert.equal(display.voice_announcements[0].counter_name, "Doctor 1");
    assert.equal(JSON.stringify(h.loadSettings().getVoiceAnnouncementEvents()), JSON.stringify(h.settings.getVoiceAnnouncementEvents()), "Voice event survives settings-module restart in virtual storage");
    const duplicateAccept = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser("Doctor 1"));
    assert.equal(duplicateAccept.status, 400);
    assert.equal((await h.service.getDisplayData()).recent_accepted[0].accepted_at, acceptedAt);
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 1, "Duplicate accept creates no additional event");
  });

  test(`${mode}: backend rejects lower priority and newer tied patients`, async () => {
    const h = await setup(localFallback);
    const low = await h.service.createQueueEntry(registration("Regular"));
    h.advance();
    const senior = await h.service.createQueueEntry(registration("Older senior", "consultation", ["senior"]));
    h.advance();
    const newerSenior = await h.service.createQueueEntry(registration("Newer senior", "checkup", ["senior"]));
    for (const patient of [low, newerSenior]) {
      const response = await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: "Doctor 1" });
      assert.equal(response.status, 400);
      assert.equal((await h.service.getPatientById(patient.id)).status, "waiting");
    }
    assert.equal((await h.request("POST", "/queue/call", { patient_id: senior.id })).status, 200);
    assert.equal((await h.service.getPatientById(senior.id)).counter_id, "Doctor 1", "Omitted counter is safely derived from service");
    assert.equal((await h.service.getPatientById(low.id)).completed_at, null);
  });

  test(`${mode}: existing laboratory/dental fallback still uses Doctor 1 and queue priority`, async () => {
    const h = await setup(localFallback);
    const dental = await h.service.createQueueEntry(registration("Dental regular", "dental"));
    h.advance();
    const laboratory = await h.service.createQueueEntry(registration("Laboratory senior", "laboratory", ["senior"]));
    assert.match(dental.queue_number, /^GP-\d{3}$/);
    assert.match(laboratory.queue_number, /^GP-\d{3}$/);
    await assert.rejects(h.service.callPatient(dental.id, "Doctor 1"), /priority|next eligible/i);
    await h.service.callPatient(laboratory.id);
    assert.equal((await h.service.getPatientById(laboratory.id)).counter_id, "Doctor 1");
    assert.equal((await h.service.getPatientById(laboratory.id)).status, "serving");
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: laboratory.id }, doctorUser("Doctor 1"))).status, 200);
    await h.service.completePatient(laboratory.id);
    await h.service.callPatient(dental.id);
    assert.equal((await h.service.getPatientById(dental.id)).counter_id, "Doctor 1");
    assert.equal((await h.service.getPatientById(dental.id)).status, "serving");
    assert.equal((await h.service.getPatientById(dental.id)).completed_at, null);
  });

  test(`${mode}: offline, busy, missing, assigned and terminal patients fail safely`, async () => {
    const h = await setup(localFallback);
    const first = await h.service.createQueueEntry(registration("First"));
    const second = await h.service.createQueueEntry(registration("Second"));
    await h.service.setCounterOnline("Doctor 1", false);
    await assert.rejects(h.service.callPatient(first.id, "Doctor 1"), /offline|unavailable/i);
    assert.equal((await h.service.getPatientById(first.id)).status, "waiting");
    await h.service.setCounterOnline("Doctor 1", true);
    await assert.rejects(h.service.callPatient(first.id, "Doctor 2"), /assign|doctor|service/i);
    await assert.rejects(h.service.callPatient(first.id, "Doctor 99"), /doctor|counter|not found|assign/i);
    await assert.rejects(h.service.callPatient(999, "Doctor 1"), /not found/i);
    for (const id of [0, -1, NaN]) await assert.rejects(h.service.callPatient(id, "Doctor 1"));
    await h.service.callPatient(first.id, "Doctor 1");
    await assert.rejects(h.service.callPatient(first.id, "Doctor 1"), /waiting|serving|progress|call/i);
    await assert.rejects(h.service.callPatient(second.id, "Doctor 1"), /busy|occupied|patient|available/i);
    assert.equal((await h.service.getPatientById(second.id)).status, "waiting");
    assert.equal(h.settings.isAwaitingAccept(second.id), false);
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: first.id }, doctorUser("Doctor 1"))).status, 200);
    await h.service.completePatient(first.id);
    await assert.rejects(h.service.callPatient(first.id, "Doctor 1"), /waiting/i);
    assert.ok((await h.service.getPatientById(first.id)).completed_at);
  });

  test(`${mode}: duplicate concurrent calls have one success and one serving patient`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Concurrent"));
    const results = await Promise.allSettled([
      h.service.callPatient(patient.id, "Doctor 1"),
      h.service.callPatient(patient.id, "Doctor 1")
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal((await h.service.getQueueOverview()).patients.filter((p) => p.status === "serving").length, 1);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
  });

  test(`${mode}: all doctors call independently with snake-case payload support`, async () => {
    const h = await setup(localFallback);
    const patients = await Promise.all([
      h.service.createQueueEntry(registration("GP")),
      h.service.createQueueEntry(registration("OB", "prenatal")),
      h.service.createQueueEntry(registration("FP", "family_planning"))
    ]);
    const results = await Promise.all(patients.map((patient, index) => h.request("POST", "/queue/call", { patient_id: patient.id, counter_id: `Doctor ${index + 1}` })));
    results.forEach((response) => assert.equal(response.status, 200, response.body.message));
    const counters = (await h.service.getQueueOverview()).counters;
    for (const [index, patient] of patients.entries()) {
      const row = await h.service.getPatientById(patient.id);
      assert.equal(row.counter_id, `Doctor ${index + 1}`);
      assert.equal(row.status, "serving");
      assert.equal(row.completed_at, null);
      assert.equal(counters[index].current_patient_id, patient.id);
    }
    assert.equal((await h.service.getDisplayData()).all_serving.length, 3);
  });

  test(`${mode}: Superadmin cannot complete a waiting patient or bypass doctor acceptance`, async () => {
    const h = await setup(localFallback);
    const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
    const patient = await h.service.createQueueEntry(registration("Awaiting doctor acceptance"));
    let response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, superadmin);
    assert.equal(response.status, 400);
    assert.equal((await h.service.getPatientById(patient.id)).status, "waiting");
    assert.equal((await h.service.getPatientById(patient.id)).completed_at, null);

    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: "Doctor 1" }, superadmin)).status, 200);
    const calledAt = (await h.service.getPatientById(patient.id)).called_at;
    response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, superadmin);
    assert.equal(response.status, 400);
    assert.match(response.body.message, /Accept this patient/i);
    const current = await h.service.getPatientById(patient.id);
    assert.equal(current.status, "serving");
    assert.equal(current.called_at, calledAt);
    assert.equal(current.counter_id, "Doctor 1");
    assert.equal(current.completed_at, null);
    assert.equal(h.settings.isAwaitingAccept(patient.id), true);
    assert.equal(h.settings.getAcceptedAt(patient.id), null);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
    assert.equal((await h.service.getDisplayData()).recent_accepted.length, 0);
  });

  test(`${mode}: Superadmin completion follows acceptance and rejects duplicate completion without changing records`, async () => {
    const h = await setup(localFallback);
    const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
    const patient = await h.service.createQueueEntry(registration("Accepted completion"));
    await h.service.callPatient(patient.id, "Doctor 1");
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser("Doctor 1"))).status, 200);
    const acceptedAt = h.settings.getAcceptedAt(patient.id);
    h.advance();
    const first = await h.request("POST", "/queue/complete", { patient_id: patient.id, reason: "Consultation finished" }, superadmin);
    assert.equal(first.status, 200);
    const completed = JSON.parse(JSON.stringify(await h.service.getPatientById(patient.id)));
    assert.equal(completed.status, "completed");
    assert.ok(completed.completed_at);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);
    h.advance();
    const duplicate = await h.request("POST", "/queue/complete", { patient_id: patient.id, reason: "Duplicate attempt" }, superadmin);
    assert.equal(duplicate.status, 400);
    assert.deepEqual(JSON.parse(JSON.stringify(await h.service.getPatientById(patient.id))), completed);
    assert.equal(h.settings.getAcceptedAt(patient.id), acceptedAt, "Existing accepted announcement event is preserved");
  });

  test(`${mode}: completion rejects orphan serving rows without a call time or assigned doctor`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Orphan serving record"));
    const stored = localFallback ? await h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
    Object.assign(stored, { status: "serving", called_at: new Date(h.clock.now).toISOString(), counter_id: "Doctor 1" });
    const calledAt = stored.called_at;
    for (const incomplete of [{ counter_id: null, called_at: calledAt }, { counter_id: "Doctor 1", called_at: null }]) {
      Object.assign(stored, incomplete);
      const before = JSON.parse(JSON.stringify(stored));
      const response = await h.request("POST", "/queue/complete", { patient_id: patient.id, counterId: "Doctor 1" }, { id_num: "superadmin", role: "superadmin", doctor_name: null });
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(JSON.stringify(await h.service.getPatientById(patient.id))), before);
      assert.equal(stored.completed_at, null);
      assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);
    }
  });

  test(`${mode}: orphan serving GP rows block Doctor 1 until explicit cancellation and leave Doctor 2 independent`, async () => {
    const h = await setup(localFallback);
    const orphan = await h.service.createQueueEntry(registration("Legacy unassigned serving"));
    const stored = localFallback ? await h.service.getPatientById(orphan.id) : h.database.patients.find((row) => row.id === orphan.id);
    Object.assign(stored, { status: "serving", called_at: new Date(h.clock.now).toISOString(), counter_id: null });
    const before = JSON.parse(JSON.stringify(stored));
    const waitingGP = await h.service.createQueueEntry(registration("Waiting GP"));
    const waitingOB = await h.service.createQueueEntry(registration("Waiting OB", "prenatal"));

    const blockedGP = await h.request("POST", "/queue/call", { patient_id: waitingGP.id, counterId: "Doctor 1" });
    assert.equal(blockedGP.status, 400);
    assert.match(blockedGP.body.message, /already serving/i);
    assert.equal((await h.service.getPatientById(waitingGP.id)).status, "waiting");
    assert.deepEqual(JSON.parse(JSON.stringify(await h.service.getPatientById(orphan.id))), before, "Detecting the legacy record does not change it");
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);

    assert.equal((await h.request("POST", "/queue/call", { patient_id: waitingOB.id, counterId: "Doctor 2" })).status, 200);
    assert.equal((await h.service.getPatientById(waitingOB.id)).counter_id, "Doctor 2");
    const cancelled = await h.request("POST", "/queue/cancel", { patient_id: orphan.id, reason: "Recover legacy unassigned call" });
    assert.equal(cancelled.status, 200);
    assert.equal((await h.service.getPatientById(orphan.id)).status, "cancelled");
    assert.equal((await h.service.getPatientById(orphan.id)).counter_id, null);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: waitingGP.id, counterId: "Doctor 1" })).status, 200);
    const counters = (await h.service.getQueueOverview()).counters;
    assert.equal(counters[0].current_patient_id, waitingGP.id);
    assert.equal(counters[1].current_patient_id, waitingOB.id);
  });

  test(`${mode}: valid legacy accepted serving rows can complete without an acceptedAt entry`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Legacy accepted patient"));
    await h.service.callPatient(patient.id, "Doctor 1");
    h.settings.resetAcceptState(patient.id);
    assert.equal(h.settings.isAwaitingAccept(patient.id), false);
    assert.equal(h.settings.getAcceptedAt(patient.id), null);
    const response = await h.request("POST", "/queue/complete", { patient_id: patient.id });
    assert.equal(response.status, 200);
    assert.equal((await h.service.getPatientById(patient.id)).status, "completed");
    assert.ok((await h.service.getPatientById(patient.id)).completed_at);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);
  });

  test(`${mode}: existing Re-Call, Complete, Cancel and No-show preserve counter state`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Re-call"));
    await h.request("POST", "/queue/call", { patient_id: patient.id });
    const prematureRecall = await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctorUser("Doctor 1"));
    assert.equal(prematureRecall.status, 400);
    await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser("Doctor 1"));
    const acceptedAt = h.settings.getAcceptedAt(patient.id);
    h.advance();
    const wrongRecall = await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctorUser("Doctor 2"));
    assert.equal(wrongRecall.status, 403);
    const recalled = await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctorUser("Doctor 1"));
    assert.equal(recalled.status, 200);
    assert.ok(recalled.body.announcement_key);
    assert.equal(recalled.body.announcement_at, new Date(h.clock.now).toISOString());
    assert.equal(h.settings.getAcceptedAt(patient.id), acceptedAt, "Re-Call preserves the original doctor acceptance time");
    const events = (await h.service.getDisplayData()).voice_announcements;
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, "accept");
    assert.equal(events[1].event_type, "recall");
    assert.equal(events[1].announcement_key, recalled.body.announcement_key);
    assert.notEqual(events[0].announcement_key, events[1].announcement_key);
    assert.equal(JSON.stringify(h.loadSettings().getVoiceAnnouncementEvents()), JSON.stringify(h.settings.getVoiceAnnouncementEvents()), "Acceptance and Re-Call events survive reload");
    assert.equal((await h.service.getPatientById(patient.id)).status, "serving");
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
    const complete = await h.request("POST", "/queue/complete", { patient_id: patient.id, counterId: "Doctor 1" });
    assert.equal(complete.status, 200);
    assert.equal((await h.service.getPatientById(patient.id)).status, "completed");
    assert.ok((await h.service.getPatientById(patient.id)).completed_at);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);

    assert.equal((await h.service.getDisplayData()).voice_announcements.length, 0, "Completed patients do not replay persisted events");

    const cancelled = await h.service.createQueueEntry(registration("Cancel"));
    await h.request("POST", "/queue/call", { patient_id: cancelled.id });
    const cancel = await h.request("POST", "/queue/cancel", { patient_id: cancelled.id, reason: "Patient left", counter_id: "Doctor 1" });
    assert.equal(cancel.status, 200);
    assert.equal((await h.service.getPatientById(cancelled.id)).status, "cancelled");
    assert.equal((await h.service.getPatientById(cancelled.id)).reason, "Patient left");
    assert.equal(h.settings.isAwaitingAccept(cancelled.id), false);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);

    const absent = await h.service.createQueueEntry(registration("Absent"));
    await h.request("POST", "/queue/call", { patient_id: absent.id });
    const tooSoon = await h.request("POST", "/queue/no-show", { patient_id: absent.id, reason: "Absent" });
    assert.equal(tooSoon.status, 400);
    assert.equal((await h.service.getPatientById(absent.id)).status, "serving");
    const recallOne = await h.request("POST", "/queue/recall", { patient_id: absent.id, counterId: "Doctor 1" });
    const recallTwo = await h.request("POST", "/queue/recall", { patient_id: absent.id, counterId: "Doctor 1" });
    assert.equal(recallOne.body.recall_count, 1);
    assert.equal(recallTwo.body.recall_count, 2);
    assert.equal((await h.request("POST", "/queue/recall", { patient_id: absent.id })).status, 400);
    h.advance(11 * 60 * 1000);
    const noShow = await h.request("POST", "/queue/no-show", { patient_id: absent.id, reason: "Absent" });
    assert.equal(noShow.status, 200);
    assert.equal((await h.service.getPatientById(absent.id)).status, "no-show");
    assert.ok((await h.service.getPatientById(absent.id)).completed_at);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);
    assert.equal(h.settings.getRecallCount(absent.id), 0);
  });
}

test("mock Supabase: independent backend instances contend safely for the same doctor", async () => {
  const database = createDatabase();
  const first = createHarness({ database });
  const second = createHarness({ database });
  const patient = await first.service.createQueueEntry(registration("Across instances"));
  const results = await Promise.allSettled([first.service.callPatient(patient.id, "Doctor 1"), second.service.callPatient(patient.id, "Doctor 1")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(database.counters[0].current_patient_id, patient.id);
  assert.equal(database.patients[0].status, "serving");
  assert.equal([...first.notifications, ...second.notifications].filter((entry) => entry.type === "called").length, 1);
});

test("mock Supabase: transient new doctor claim cannot be reused as a legacy Undo reservation", async () => {
  const database = createDatabase();
  const clock = { now: Date.now() };
  const first = createHarness({ database, clock });
  const second = createHarness({ database, clock });
  const patient = await first.service.createQueueEntry(registration("Transient reservation"));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reachedUpdate;
  const updateReached = new Promise((resolve) => { reachedUpdate = resolve; });
  let held = false;
  database.beforeQuery = async (query) => {
    if (!held && query.table === "patients" && query.action === "update" && query.payload.status === "serving") {
      held = true;
      reachedUpdate();
      await blocked;
    }
  };
  const firstCall = first.service.callPatient(patient.id, "Doctor 1");
  await updateReached;
  let secondOutcome;
  try {
    await second.service.callPatient(patient.id, "Doctor 1");
    secondOutcome = "fulfilled";
  } catch {
    secondOutcome = "rejected";
  } finally {
    release();
  }
  const firstOutcome = await firstCall.then(() => "fulfilled", () => "rejected");
  assert.equal(secondOutcome, "rejected", "An in-flight new reservation belongs to the first caller");
  assert.equal(firstOutcome, "fulfilled");
  assert.equal(database.counters[0].current_patient_id, patient.id);
  assert.equal(database.patients[0].status, "serving");
  assert.equal([...first.notifications, ...second.notifications].filter((entry) => entry.type === "called").length, 1);
});

test("mock Supabase: failed patient compare-and-set releases only its own counter claim", async () => {
  const h = await setup();
  const patient = await h.service.createQueueEntry(registration("CAS conflict"));
  h.database.beforeQuery = (query) => {
    if (query.table === "patients" && query.action === "update" && query.payload.status === "serving") {
      return { data: null, error: null };
    }
  };
  await assert.rejects(h.service.callPatient(patient.id, "Doctor 1"));
  assert.equal(h.database.patients[0].status, "waiting");
  assert.equal(h.database.patients[0].called_at, null);
  assert.equal(h.database.patients[0].completed_at, null);
  assert.equal(h.database.counters[0].current_patient_id, null);
  assert.equal(h.settings.isAwaitingAccept(patient.id), false);
});

test("mock Supabase: concurrent existing Undo reservations cannot acknowledge the same call twice", async () => {
  const database = createDatabase();
  const clock = { now: Date.now() };
  const first = createHarness({ database, clock });
  const second = createHarness({ database, clock });
  const patient = await first.service.createQueueEntry(registration("Undo reservation race"));
  database.patients[0].counter_id = "Doctor 1";
  database.counters[0].current_patient_id = patient.id;
  const results = await Promise.allSettled([first.service.callPatient(patient.id, "Doctor 1"), second.service.callPatient(patient.id, "Doctor 1")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(database.counters[0].current_patient_id, patient.id);
  assert.equal(database.patients[0].status, "serving");
});

test("mock Supabase: same-timestamp CAS loser cannot reset winner acceptance or send duplicate SMS", async () => {
  const database = createDatabase();
  const clock = { now: Date.now() };
  const files = new Map();
  const first = createHarness({ database, clock, files });
  const second = createHarness({ database, clock, files });
  const patient = await first.service.createQueueEntry(registration("Accepted race winner"));
  database.patients[0].counter_id = "Doctor 1";
  database.counters[0].current_patient_id = patient.id;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reachedLoser;
  const loserReached = new Promise((resolve) => { reachedLoser = resolve; });
  let attemptedUpdates = 0;
  database.beforeQuery = async (query) => {
    if (query.table === "patients" && query.action === "update" && query.payload.status === "serving") {
      attemptedUpdates += 1;
      if (attemptedUpdates === 2) {
        reachedLoser();
        await blocked;
      }
    }
  };
  const firstCall = first.service.callPatient(patient.id, "Doctor 1");
  const secondCall = second.service.callPatient(patient.id, "Doctor 1");
  await loserReached;
  await firstCall;
  const accepted = await first.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser("Doctor 1"));
  assert.equal(accepted.status, 200);
  const acceptedAt = first.settings.getAcceptedAt(patient.id);
  release();
  await assert.rejects(secondCall);
  assert.equal(first.loadSettings().getAcceptedAt(patient.id), acceptedAt);
  assert.equal(first.loadSettings().isAwaitingAccept(patient.id), false);
  assert.equal([...first.notifications, ...second.notifications].filter((entry) => entry.type === "called").length, 1);
  assert.equal(database.counters[0].current_patient_id, patient.id);
});

test("mock Supabase: failed write releases own slot while lost committed transport response recovers", async () => {
  const h = await setup();
  const patient = await h.service.createQueueEntry(registration("Write failure"));
  let failOnce = true;
  h.database.beforeQuery = (query) => {
    if (failOnce && query.table === "patients" && query.action === "update" && query.payload.status === "serving") {
      failOnce = false;
      return { data: null, error: { code: "PGRST999", message: "Test update failure" } };
    }
  };
  await assert.rejects(h.service.callPatient(patient.id, "Doctor 1"), /Test update failure/);
  assert.equal(h.database.counters[0].current_patient_id, null);
  assert.equal(h.database.patients[0].status, "waiting");
  assert.equal(h.settings.isAwaitingAccept(patient.id), false);
  h.database.beforeQuery = (query) => {
    if (query.table === "patients" && query.action === "update" && query.payload.status === "serving") {
      Object.assign(h.database.patients[0], query.payload);
      return { data: null, error: { message: "fetch failed: response lost" } };
    }
  };
  await h.service.callPatient(patient.id, "Doctor 1");
  assert.equal(h.database.patients[0].status, "serving");
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
  assert.equal(h.settings.isAwaitingAccept(patient.id), true);
  assert.equal(h.notifications.filter((entry) => entry.type === "called").length, 1);
});

test("mock Supabase: conflicting payload aliases and doctor account ownership reject without mutation", async () => {
  const h = await setup();
  const patient = await h.service.createQueueEntry(registration("Payload ownership"));
  const conflicting = await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: "Doctor 1", counter_id: "Doctor 2" });
  assert.equal(conflicting.status, 400);
  const wrongDoctor = await h.request("POST", "/queue/call", { patient_id: patient.id, counterId: "Doctor 1" }, doctorUser("Doctor 2"));
  assert.equal(wrongDoctor.status, 403);
  const omittedCounter = await h.request("POST", "/queue/call", { patient_id: patient.id }, doctorUser("Doctor 2"));
  assert.equal(omittedCounter.status, 400);
  assert.equal(h.database.patients[0].status, "waiting");
  assert.equal(h.database.patients[0].called_at, null);
  assert.equal(h.database.counters[0].current_patient_id, null);
});

test("mock Supabase: counter becoming offline before claim prevents patient update", async () => {
  const h = await setup();
  const patient = await h.service.createQueueEntry(registration("Offline race"));
  h.database.beforeQuery = (query) => {
    if (query.table === "counters" && query.action === "update" && query.payload.current_patient_id === patient.id) h.database.counters[0].is_online = false;
  };
  await assert.rejects(h.service.callPatient(patient.id, "Doctor 1"));
  assert.equal(h.database.patients[0].status, "waiting");
  assert.equal(h.database.counters[0].current_patient_id, null);
});

test("mock Supabase: occupied serving doctor stays blocked even with a stale null counter pointer", async () => {
  const h = await setup();
  const patient = await h.service.createQueueEntry(registration("Serving"));
  await h.service.callPatient(patient.id, "Doctor 1");
  h.database.counters[0].current_patient_id = null;
  const waiting = await h.service.createQueueEntry(registration("Next"));
  await assert.rejects(h.service.callPatient(waiting.id, "Doctor 1"), /busy|occupied|patient|serving/i);
  assert.equal(h.database.patients.find((p) => p.id === waiting.id).status, "waiting");
});
