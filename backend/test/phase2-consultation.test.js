const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const doctorUser = (number = 1) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const registration = (name, serviceType = "consultation") => ({
  idNum: name, serviceType, vulnerabilityFlags: [], mobileNumber: "09123456789"
});
const baseTime = Date.parse("2026-10-10T01:00:00.000Z");

async function setup(localFallback = false, options = {}) {
  const h = createHarness({ localFallback, clock: { now: baseTime }, ...options });
  await h.initialize();
  return h;
}

async function acceptedPatient(h, number = 1, name = "Consultation patient") {
  const service = ["consultation", "prenatal", "family_planning"][number - 1];
  const patient = await h.service.createQueueEntry(registration(name, service));
  assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
  h.advance();
  const response = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser(number));
  assert.equal(response.status, 200, response.body.message);
  h.advance();
  return patient;
}

async function start(h, patient, number = 1) {
  const response = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser(number));
  assert.equal(response.status, 200, response.body.message);
  return h.service.getPatientById(patient.id);
}

async function storedPatient(h, patient, localFallback) {
  return localFallback ? h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "RPC simulation";

  test(`${mode}: call, acceptance, start and completion retain distinct timestamps and correct duration`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const before = await h.service.getPatientById(patient.id);
    const acceptedAt = h.settings.getAcceptedAt(patient.id);
    assert.equal(before.consultation_started_at, null);
    assert.equal(before.completed_at, null);
    const started = clone(await start(h, patient));
    assert.equal(started.status, "serving");
    assert.equal(started.called_at, before.called_at);
    assert.ok(Date.parse(started.called_at) < Date.parse(acceptedAt));
    assert.ok(Date.parse(acceptedAt) < Date.parse(started.consultation_started_at));
    assert.equal(started.completed_at, null);
    let overview = await h.service.getQueueOverview();
    const active = overview.patients.find((row) => row.id === patient.id);
    assert.equal(active.accepted_at, acceptedAt);
    assert.equal(active.service_duration_seconds, null);
    assert.equal(overview.counters[0].current_patient_id, patient.id);
    h.advance(12500);
    const response = await h.request("POST", "/queue/complete", {
      patient_id: patient.id, counterId: "Doctor 1", reason: "Consultation performed"
    }, doctorUser());
    assert.equal(response.status, 200, response.body.message);
    const completed = await h.service.getPatientById(patient.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.consultation_started_at, started.consultation_started_at);
    assert.equal(completed.called_at, started.called_at);
    assert.equal(completed.counter_id, "Doctor 1", "Historical doctor association is retained");
    assert.equal(completed.completed_at, new Date(h.clock.now).toISOString());
    assert.equal(completed.reason, "Consultation performed");
    overview = await h.service.getQueueOverview();
    assert.equal(overview.patients.find((row) => row.id === patient.id).service_duration_seconds, 12.5);
    assert.equal(overview.counters[0].current_patient_id, null);
    assert.equal(h.settings.getAcceptedAt(patient.id), acceptedAt);
    assert.equal((await h.service.getDisplayData()).all_serving.length, 0);
    const next = await h.service.createQueueEntry(registration("Next patient"));
    assert.equal((await h.request("POST", "/queue/call", { patient_id: next.id })).status, 200);
  });

  test(`${mode}: acceptance alone does not start consultation and cannot complete it`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const before = clone(await h.service.getPatientById(patient.id));
    const response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
    assert.equal(response.status, 400);
    assert.match(response.body.message, /start|consultation/i);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
  });

  test(`${mode}: a new call after cancellation and re-queue never replays the previous Accept or Re-Call`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    assert.equal((await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctorUser())).status, 200);
    assert.equal((await h.service.getDisplayData()).voice_announcements.length, 2);
    h.advance();
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Patient left" }, doctorUser())).status, 200);
    assert.equal((await h.service.getDisplayData()).voice_announcements.length, 0);
    h.advance();
    assert.equal((await h.request("POST", "/queue/requeue", { patient_id: patient.id }, doctorUser())).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    assert.equal((await h.service.getDisplayData()).voice_announcements.length, 0,
      "Calling alone must not expose announcements from the previous call cycle");
    h.advance();
    const accepted = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser());
    assert.equal(accepted.status, 200);
    const announcements = (await h.service.getDisplayData()).voice_announcements;
    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].announcement_key, accepted.body.announcement_key);
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 3, "Persisted audit events remain intact");
  });

  test(`${mode}: called patient must actually be accepted; a submitted acceptance or start timestamp is ignored`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Not accepted"));
    await h.service.callPatient(patient.id, "Doctor 1");
    const response = await h.request("POST", "/queue/start", {
      patient_id: patient.id, accepted_at: new Date(h.clock.now).toISOString(),
      consultation_started_at: "2000-01-01T00:00:00.000Z"
    }, doctorUser());
    assert.equal(response.status, 400);
    assert.equal((await h.service.getPatientById(patient.id)).consultation_started_at, null);
    assert.equal(h.settings.isAwaitingAccept(patient.id), true);
    assert.equal(h.database.calls.filter((entry) => entry.action === "rpc" && entry.function !== "call_patient_visit").length, 0, "No consultation RPC was attempted");
  });

  for (const status of ["waiting", "completed", "cancelled", "no-show"]) {
    test(`${mode}: start rejects a ${status} patient without changing records`, async () => {
      const h = await setup(localFallback);
      const patient = await acceptedPatient(h);
      const stored = await storedPatient(h, patient, localFallback);
      stored.status = status;
      stored.completed_at = status === "waiting" ? null : new Date(h.clock.now).toISOString();
      const before = clone(await h.service.getPatientById(patient.id));
      const response = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser());
      assert.equal(response.status, 400, response.body.message);
      assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
      assert.equal(before.consultation_started_at, null);
    });
  }

  test(`${mode}: invalid patient identifiers are rejected before mutation`, async () => {
    const h = await setup(localFallback);
    for (const patient_id of [null, 0, -1, "invalid", 1.5]) {
      const response = await h.request("POST", "/queue/start", { patient_id }, doctorUser());
      assert.equal(response.status, 400, String(patient_id));
    }
    assert.equal((await h.request("POST", "/queue/start", { patient_id: 999 }, doctorUser())).status, 404);
    assert.equal(h.database.patients.length, 0);
  });

  test(`${mode}: anonymous, frontdesk and Superadmin requests cannot start or complete consultations`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const before = clone(await h.service.getPatientById(patient.id));
    for (const [user, expectedStatus] of [
      [null, 401],
      [{ id_num: "frontdesk", role: "admin", doctor_name: null }, 403],
      [{ id_num: "superadmin", role: "superadmin", doctor_name: "Doctor 1" }, 403]
    ]) {
      for (const route of ["/queue/start", "/queue/complete"]) {
        const response = await h.request("POST", route, { patient_id: patient.id, doctor_name: "Doctor 1" }, user);
        assert.equal(response.status, expectedStatus, response.body.message);
      }
    }
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
  });

  test(`${mode}: Doctor 1 cannot start or complete another doctor's patient, even with spoofed payload identity`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h, 2);
    const spoofed = { patient_id: patient.id, counterId: "Doctor 2", doctor_name: "Doctor 2", id_num: "admin2" };
    assert.equal((await h.request("POST", "/queue/start", spoofed, doctorUser())).status, 403);
    const started = clone(await start(h, patient, 2));
    h.advance();
    assert.equal((await h.request("POST", "/queue/complete", spoofed, doctorUser())).status, 403);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), started);
    assert.equal((await h.service.getQueueOverview()).counters[1].current_patient_id, patient.id);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser(2))).status, 200);
  });

  test(`${mode}: payload counter aliases cannot change the authenticated doctor's assignment`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    await start(h, patient);
    h.advance();
    const before = clone(await h.service.getPatientById(patient.id));
    for (const payload of [
      { counterId: "Doctor 2" },
      { counter_id: "Doctor 2" },
      { counterId: "Doctor 1", counter_id: "Doctor 2" }
    ]) {
      const response = await h.request("POST", "/queue/complete", { patient_id: patient.id, ...payload }, doctorUser());
      assert.ok([400, 403].includes(response.status), response.body.message);
      assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    }
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
  });

  test(`${mode}: missing acceptance state requires explicit Accept and does not invent timestamps`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    h.settings.resetAcceptState(patient.id);
    const before = clone(await h.service.getPatientById(patient.id));
    const overview = await h.service.getQueueOverview();
    assert.equal(overview.patients.find((row) => row.id === patient.id).awaiting_accept, true);
    assert.equal(overview.patients.find((row) => row.id === patient.id).accepted_at, null);
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 400);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser())).status, 200);
    h.advance();
    assert.ok((await start(h, patient)).consultation_started_at);
  });

  test(`${mode}: a persisted consultation start survives loss of the local acceptance file`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const started = clone(await start(h, patient));
    h.settings.resetAcceptState(patient.id);
    h.advance();
    const response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
    assert.equal(response.status, 200, response.body.message);
    assert.equal((await h.service.getPatientById(patient.id)).consultation_started_at, started.consultation_started_at);
  });

  test(`${mode}: pending acceptance cannot be bypassed by an old persisted consultation timestamp`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    await start(h, patient);
    h.settings.markAwaitingAccept(patient.id);
    h.advance();
    const before = clone(await h.service.getPatientById(patient.id));
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 400);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
  });

  test(`${mode}: concurrent duplicate starts and completions each commit once and retain the winning timestamps`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const starts = await Promise.all([
      h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser()),
      h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())
    ]);
    assert.deepEqual(starts.map((response) => response.status).sort(), [200, 409]);
    const startedAt = (await h.service.getPatientById(patient.id)).consultation_started_at;
    h.advance(2500);
    const completes = await Promise.all([
      h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser()),
      h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())
    ]);
    assert.deepEqual(completes.map((response) => response.status).sort(), [200, 409]);
    const completed = clone(await h.service.getPatientById(patient.id));
    assert.equal(completed.consultation_started_at, startedAt);
    h.advance();
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 400);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 400);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), completed);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);
  });

  test(`${mode}: zero or negative elapsed consultation time cannot create a completed record`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const before = clone(await start(h, patient));
    for (const offset of [0, -1000]) {
      h.clock.now = Date.parse(before.consultation_started_at) + offset;
      const response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
      assert.equal(response.status, 400);
      assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    }
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, patient.id);
  });

  test(`${mode}: Accept and Re-Call retain voice events while Start and Complete create none`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const acceptedAt = h.settings.getAcceptedAt(patient.id);
    const acceptedEvents = clone(h.settings.getVoiceAnnouncementEvents());
    assert.equal(acceptedEvents.length, 1);
    assert.equal((await h.service.getDisplayData()).recent_accepted[0].accepted_at, acceptedAt);
    await start(h, patient);
    assert.deepEqual(clone(h.settings.getVoiceAnnouncementEvents()), acceptedEvents);
    h.advance();
    assert.equal((await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctorUser())).status, 200);
    const recalledEvents = clone(h.settings.getVoiceAnnouncementEvents());
    assert.equal(recalledEvents.length, 2);
    assert.equal(recalledEvents[1].event_type, "recall");
    assert.equal(h.settings.getAcceptedAt(patient.id), acceptedAt);
    h.advance();
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 200);
    assert.deepEqual(clone(h.settings.getVoiceAnnouncementEvents()), recalledEvents);
    assert.equal((await h.service.getDisplayData()).voice_announcements.length, 0);
  });

  test(`${mode}: the legacy recall endpoint cannot change called_at after acceptance or consultation start`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    for (const phase of ["accepted", "started"]) {
      if (phase === "started") await start(h, patient);
      h.advance();
      const before = clone(await h.service.getPatientById(patient.id));
      const response = await h.request("POST", "/queue/recall", { patient_id: patient.id, counterId: "Doctor 1" }, doctorUser());
      assert.equal(response.status, 400, `${phase}: ${response.body.message}`);
      assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
      assert.equal(h.settings.getRecallCount(patient.id), 0);
      assert.equal((await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctorUser())).status, 200);
    }
  });

  test(`${mode}: No-show cannot erase a completed consultation or its historical duration`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    await start(h, patient);
    h.advance(1000);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 200);
    const before = clone(await h.service.getPatientById(patient.id));
    const response = await h.request("POST", "/queue/no-show", { patient_id: patient.id, reason: "Stale no-show action" });
    assert.equal(response.status, 400);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    assert.equal((await h.service.getQueueOverview()).patients.find((row) => row.id === patient.id).service_duration_seconds, 1);
  });

  test(`${mode}: queue responses identify whether consultation records use Supabase or development memory`, async () => {
    const h = await setup(localFallback);
    const expected = localFallback ? "local_fallback" : "supabase";
    const patient = await acceptedPatient(h);
    assert.equal((await h.service.getQueueOverview()).storage_mode, expected);
    const started = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser());
    assert.equal(started.status, 200, started.body.message);
    assert.equal(started.body.storage_mode, expected);
    h.advance();
    const completed = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
    assert.equal(completed.status, 200, completed.body.message);
    assert.equal(completed.body.storage_mode, expected);
  });

  test(`${mode}: cancelled consultations retain start history but cannot contribute service duration`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    const started = clone(await start(h, patient));
    h.advance(5000);
    assert.equal((await h.request("POST", "/queue/cancel", {
      patient_id: patient.id, counter_id: "Doctor 1", reason: "Patient left during consultation"
    }, doctorUser())).status, 200);
    const row = (await h.service.getQueueOverview()).patients.find((item) => item.id === patient.id);
    assert.equal(row.status, "cancelled");
    assert.equal(row.consultation_started_at, started.consultation_started_at);
    assert.equal(row.service_duration_seconds, null);
    assert.equal((await h.service.getQueueOverview()).counters[0].current_patient_id, null);
  });

  test(`${mode}: re-queueing a cancelled attempt resets its old consultation start for the next call cycle`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    await start(h, patient);
    h.advance();
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Visit interrupted" }, doctorUser())).status, 200);
    assert.equal((await h.request("POST", "/queue/requeue", { patient_id: patient.id, reason: "Patient returned" })).status, 200);
    const waiting = await h.service.getPatientById(patient.id);
    assert.equal(waiting.status, "waiting");
    for (const field of ["consultation_started_at", "completed_at", "called_at", "counter_id"]) assert.equal(waiting[field], null);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 400);
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser())).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 200);
  });

  test(`${mode}: completed consultation history cannot be erased by legacy Undo or Re-queue actions`, async () => {
    const h = await setup(localFallback);
    const patient = await acceptedPatient(h);
    await start(h, patient);
    h.advance(2500);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 200);
    const completed = clone(await h.service.getPatientById(patient.id));
    for (const route of ["/queue/undo", "/queue/requeue"]) {
      assert.equal((await h.request("POST", route, { patient_id: patient.id })).status, 400);
      assert.deepEqual(clone(await h.service.getPatientById(patient.id)), completed);
    }
    assert.equal((await h.service.getQueueOverview()).patients.find((row) => row.id === patient.id).service_duration_seconds, 2.5);
  });

  test(`${mode}: legacy and invalid historical timestamps never produce a fabricated duration`, async () => {
    const h = await setup(localFallback);
    for (const [name, fields] of [
      ["Legacy completed", { status: "completed", consultation_started_at: null, completed_at: "2026-10-10T01:01:00.000Z" }],
      ["No-show", { status: "no-show", consultation_started_at: "2026-10-10T01:00:00.000Z", completed_at: "2026-10-10T01:01:00.000Z" }],
      ["Missing end", { status: "completed", consultation_started_at: "2026-10-10T01:00:00.000Z", completed_at: null }],
      ["Wrong order", { status: "completed", consultation_started_at: "2026-10-10T01:01:00.000Z", completed_at: "2026-10-10T01:00:00.000Z" }],
      ["Invalid timestamp", { status: "completed", consultation_started_at: "bad timestamp", completed_at: "2026-10-10T01:01:00.000Z" }]
    ]) {
      const patient = await h.service.createQueueEntry(registration(name));
      Object.assign(await storedPatient(h, patient, localFallback), fields);
    }
    const overview = await h.service.getQueueOverview();
    assert.equal(overview.patients.length, 5);
    assert.ok(overview.patients.every((row) => row.service_duration_seconds === null));
    assert.equal(overview.patients.find((row) => row.id_num === "Legacy completed").consultation_started_at, null);
  });

  test(`${mode}: derived durations preserve PostgreSQL microseconds and timezone offsets`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Precise timestamp record"));
    Object.assign(await storedPatient(h, patient, localFallback), {
      status: "completed", consultation_started_at: "2026-10-10T09:00:00.000100+08:00",
      completed_at: "2026-10-10T01:00:00.000900Z"
    });
    const row = (await h.service.getQueueOverview()).patients.find((item) => item.id === patient.id);
    assert.equal(row.service_duration_seconds, 0.0008);
    assert.equal(row.consultation_started_at, "2026-10-10T09:00:00.000100+08:00");
    assert.equal(row.completed_at, "2026-10-10T01:00:00.000900Z");
  });

  test(`${mode}: analytics averages actual consultation minutes and excludes invalid or unperformed records`, async () => {
    const h = await setup(localFallback);
    const validStart = "2026-10-10T01:00:00.000Z";
    for (const [name, service, fields] of [
      ["42 second consultation", "consultation", { status: "completed", consultation_started_at: validStart, completed_at: "2026-10-10T01:00:42.000Z" }],
      ["90 second consultation", "consultation", { status: "completed", consultation_started_at: "2026-10-10T01:01:00.000Z", completed_at: "2026-10-10T01:02:30.000Z" }],
      ["Legacy completed", "prenatal", { status: "completed", consultation_started_at: null, completed_at: "2026-10-10T01:10:00.000Z" }],
      ["Cancelled", "prenatal", { status: "cancelled", consultation_started_at: validStart, completed_at: "2026-10-10T01:20:00.000Z" }],
      ["No-show", "prenatal", { status: "no-show", consultation_started_at: validStart, completed_at: "2026-10-10T01:20:00.000Z" }],
      ["Still serving", "prenatal", { status: "serving", consultation_started_at: validStart, completed_at: null }],
      ["Waiting", "prenatal", { status: "waiting", consultation_started_at: validStart, completed_at: "2026-10-10T01:20:00.000Z" }],
      ["Negative duration", "prenatal", { status: "completed", consultation_started_at: "2026-10-10T01:02:00.000Z", completed_at: validStart }],
      ["Invalid start", "prenatal", { status: "completed", consultation_started_at: "invalid", completed_at: "2026-10-10T01:20:00.000Z" }],
      ["Missing end", "prenatal", { status: "completed", consultation_started_at: validStart, completed_at: null }],
      ["Zero duration", "prenatal", { status: "completed", consultation_started_at: validStart, completed_at: validStart }]
    ]) {
      const patient = await h.service.createQueueEntry(registration(name, service));
      Object.assign(await storedPatient(h, patient, localFallback), { called_at: "2026-10-10T00:45:00.000Z", ...fields });
    }
    const analytics = await h.service.getAnalytics();
    assert.equal(analytics.metrics.totalPatients, 11);
    assert.equal(analytics.metrics.avgServiceTime, 1.1, "Average 42 and 90 actual seconds before rounding the final minute value");
    assert.equal(analytics.tableData.find((row) => row.service_type === "consultation").avg_service_time, "1.1");
    assert.equal(analytics.tableData.find((row) => row.service_type === "prenatal").avg_service_time, "0.0");
  });
}

test("RPC simulation: timestamps come from the database clock and client timestamps cannot override them", async () => {
  const database = createDatabase();
  database.clock = { now: baseTime + 12000 };
  const h = await setup(false, { database });
  const patient = await acceptedPatient(h);
  const response = await h.request("POST", "/queue/start", {
    patient_id: patient.id, consultation_started_at: "1990-01-01T00:00:00.000Z", accepted_at: "1990-01-01T00:00:00.000Z"
  }, doctorUser());
  assert.equal(response.status, 200, response.body.message);
  const started = clone(await h.service.getPatientById(patient.id));
  assert.equal(started.consultation_started_at, "2026-10-10T01:00:12.000Z");
  assert.notEqual(started.consultation_started_at, new Date(h.clock.now).toISOString());
  const startRpc = database.calls.find((entry) => entry.function === "start_patient_consultation");
  assert.deepEqual(startRpc.args, {
    p_patient_id: patient.id, p_doctor_name: "Doctor 1", p_user_id_num: "admin1", p_accepted_at: h.settings.getAcceptedAt(patient.id)
  });
  database.clock.now += 10250;
  assert.equal((await h.request("POST", "/queue/complete", {
    patient_id: patient.id, completed_at: "1990-01-01T00:00:00.000Z"
  }, doctorUser())).status, 200);
  const completed = (await h.service.getQueueOverview()).patients.find((row) => row.id === patient.id);
  assert.equal(completed.completed_at, "2026-10-10T01:00:22.250Z");
  assert.equal(completed.service_duration_seconds, 10.25);
});

test("RPC simulation: completion passes the persisted microsecond start and ignores a client expected timestamp", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  await start(h, patient);
  const exactStart = "2026-10-10T09:00:02.000123+08:00";
  h.database.patients[0].consultation_started_at = exactStart;
  h.advance(1250);
  const response = await h.request("POST", "/queue/complete", {
    patient_id: patient.id,
    p_expected_started_at: "1990-01-01T00:00:00.000Z",
    consultation_started_at: "1990-01-01T00:00:00.000Z"
  }, doctorUser());
  assert.equal(response.status, 200, response.body.message);
  const completeRpc = h.database.calls.find((entry) => entry.function === "complete_patient_consultation");
  assert.equal(completeRpc.args.p_expected_started_at, exactStart, "The database-read value must retain all six fractional digits");
  assert.equal(response.body.patient.consultation_started_at, exactStart);
});

test("RPC simulation: a revoked or reassigned database user cannot rely on stale JWT doctor identity", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  const before = clone(await h.service.getPatientById(patient.id));
  const user = h.database.users.find((row) => row.id_num === "admin1");
  user.doctor_name = "Doctor 2";
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 403);
  user.doctor_name = "Doctor 1";
  await start(h, patient);
  h.advance();
  user.role = "superadmin";
  assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 403);
  assert.equal((await h.service.getPatientById(patient.id)).status, "serving");
  assert.equal(before.consultation_started_at, null);
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
});

test("RPC simulation: stale or contradictory counter pointers reject both lifecycle actions", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  h.database.counters[0].current_patient_id = null;
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 400);
  h.database.counters[0].current_patient_id = patient.id;
  await start(h, patient);
  h.advance();
  const before = clone(await h.service.getPatientById(patient.id));
  for (const counterState of ["released", "double assigned"]) {
    h.database.counters[0].current_patient_id = counterState === "released" ? null : patient.id;
    h.database.counters[1].current_patient_id = counterState === "double assigned" ? patient.id : null;
    const response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
    assert.equal(response.status, 400, response.body.message);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
  }
});

test("RPC simulation: ownership changes after service validation are rechecked at the write boundary", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  const before = clone(h.database.patients[0]);
  h.database.beforeRpc = (name) => {
    if (name === "start_patient_consultation") h.database.users.find((row) => row.id_num === "admin1").doctor_name = "Doctor 2";
  };
  const response = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser());
  assert.equal(response.status, 403, response.body.message);
  assert.deepEqual(clone(h.database.patients[0]), before);
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
});

test("RPC simulation: acceptance from an old call cannot start a newly called, unaccepted cycle", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  const oldAcceptedAt = h.settings.getAcceptedAt(patient.id);
  h.database.beforeRpc = async (name) => {
    if (name !== "start_patient_consultation") return;
    h.database.beforeRpc = null;
    h.advance();
    assert.equal((await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Visit interrupted" }, doctorUser())).status, 200);
    assert.equal((await h.request("POST", "/queue/requeue", { patient_id: patient.id })).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
  };
  const response = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser());
  assert.equal(response.status, 400, response.body.message);
  const current = await h.service.getPatientById(patient.id);
  assert.equal(current.status, "serving");
  assert.equal(current.consultation_started_at, null);
  assert.equal(current.completed_at, null);
  assert.ok(Date.parse(current.called_at) > Date.parse(oldAcceptedAt));
  assert.equal(h.settings.isAwaitingAccept(patient.id), true);
  assert.equal(h.settings.getAcceptedAt(patient.id), null);
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
});

test("RPC simulation: a delayed completion cannot complete a new attempt after cancel, requeue, call and start", async () => {
  const database = createDatabase();
  const clock = { now: baseTime };
  const files = new Map();
  const first = await setup(false, { database, clock, files });
  const patient = await acceptedPatient(first);
  const oldStart = (await start(first, patient)).consultation_started_at;
  first.advance();
  let second;
  let newStart;
  database.beforeRpc = async (name) => {
    if (name !== "complete_patient_consultation") return;
    database.beforeRpc = null;
    second = await setup(false, { database, clock, files });
    assert.equal((await second.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Interrupted attempt" }, doctorUser())).status, 200);
    assert.equal((await second.request("POST", "/queue/requeue", { patient_id: patient.id })).status, 200);
    second.advance();
    assert.equal((await second.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    second.advance();
    assert.equal((await second.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser())).status, 200);
    second.advance();
    newStart = (await start(second, patient)).consultation_started_at;
    second.advance();
  };
  const stale = await first.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
  assert.equal(stale.status, 400, stale.body.message);
  assert.match(stale.body.message, /Consultation attempt changed/);
  assert.notEqual(newStart, oldStart);
  const current = await second.service.getPatientById(patient.id);
  assert.equal(current.status, "serving");
  assert.equal(current.consultation_started_at, newStart);
  assert.equal(current.completed_at, null);
  assert.equal(database.counters[0].current_patient_id, patient.id);
  const staleRpc = database.calls.find((entry) => entry.function === "complete_patient_consultation");
  assert.equal(staleRpc.args.p_expected_started_at, oldStart);
  assert.equal((await second.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 200);
});

test("RPC simulation: a stale No-show write cannot overwrite an intervening completed consultation", async () => {
  const h = await setup();
  const patient = await h.service.createQueueEntry(registration("No-show race"));
  await h.service.callPatient(patient.id, "Doctor 1");
  h.advance(11 * 60 * 1000);
  let completed;
  h.database.beforeQuery = async (query) => {
    if (query.table !== "patients" || query.action !== "update" || query.payload.status !== "no-show") return;
    h.database.beforeQuery = null;
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctorUser())).status, 200);
    h.advance();
    await start(h, patient);
    h.advance(1500);
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 200);
    completed = clone(await h.service.getPatientById(patient.id));
  };
  const response = await h.request("POST", "/queue/no-show", { patient_id: patient.id, reason: "Old no-show attempt" });
  assert.equal(response.status, 400, response.body.message);
  assert.ok(completed, "The completion occurred before the original conditional No-show write");
  assert.deepEqual(clone(await h.service.getPatientById(patient.id)), completed);
  assert.equal(h.database.counters[0].current_patient_id, null);
  assert.equal((await h.service.getQueueOverview()).patients.find((row) => row.id === patient.id).service_duration_seconds, 1.5);
});

test("RPC simulation: a counter reassignment during completion validation cannot release another active patient", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  await start(h, patient);
  h.advance();
  const before = clone(h.database.patients[0]);
  const next = await h.service.createQueueEntry(registration("New counter owner"));
  h.database.beforeRpc = (name) => {
    if (name === "complete_patient_consultation") h.database.counters[0].current_patient_id = next.id;
  };
  const response = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
  assert.equal(response.status, 400, response.body.message);
  assert.deepEqual(clone(h.database.patients[0]), before);
  assert.equal(h.database.counters[0].current_patient_id, next.id);
  assert.equal(h.database.patients.find((row) => row.id === next.id).status, "waiting");
});

test("RPC simulation: failed start and completion do not switch to local data or partially release the counter", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  const before = clone(await h.service.getPatientById(patient.id));
  h.database.beforeRpc = () => ({ data: null, error: { code: "PGRST202", message: "Consultation migration is not installed" } });
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 503);
  assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
  h.database.beforeRpc = null;
  await start(h, patient);
  h.advance();
  const started = clone(await h.service.getPatientById(patient.id));
  h.database.beforeRpcCommit = ({ name, patients, counters }) => {
    if (name === "complete_patient_consultation") {
      assert.equal(patients[0].status, "completed");
      assert.equal(counters[0].current_patient_id, null);
      throw new Error("Transaction aborted before commit");
    }
  };
  const failed = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser());
  assert.equal(failed.status, 400);
  assert.match(failed.body.message, /Transaction aborted/i);
  assert.deepEqual(clone(await h.service.getPatientById(patient.id)), started);
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
  assert.equal((await h.service.getQueueOverview()).patients.length, 1, "The live-data read mode was preserved");
  h.database.beforeRpcCommit = null;
  assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 200);
});

test("RPC simulation: strict database read failures fail closed without falling back or calling RPC", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  const before = clone(h.database.patients[0]);
  h.database.beforeQuery = (query) => query.table === "users" && query.action === "select"
    ? { data: null, error: { message: "User database unreachable" } } : null;
  const response = await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser());
  assert.equal(response.status, 503);
  assert.deepEqual(clone(h.database.patients[0]), before);
  assert.equal(h.database.calls.filter((entry) => entry.action === "rpc" && entry.function !== "call_patient_visit").length, 0, "No consultation RPC was attempted");
  h.database.beforeQuery = null;
  assert.equal((await h.service.getQueueOverview()).patients.length, 1);
});

test("RPC simulation: thrown database or RPC transport failures return unavailable and preserve patient and counter states", async () => {
  const h = await setup();
  const patient = await acceptedPatient(h);
  const before = clone(h.database.patients[0]);
  h.database.beforeQuery = (query) => {
    if (query.table === "patients" && query.action === "select") throw new Error("fetch failed during strict validation");
  };
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 503);
  h.database.beforeQuery = null;
  h.database.beforeRpc = () => { throw new Error("fetch failed during RPC transport"); };
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())).status, 503);
  assert.deepEqual(clone(h.database.patients[0]), before);
  h.database.beforeRpc = null;
  await start(h, patient);
  h.advance();
  const started = clone(h.database.patients[0]);
  h.database.beforeRpc = () => { throw new Error("fetch failed during completion transport"); };
  assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())).status, 503);
  assert.deepEqual(clone(h.database.patients[0]), started);
  assert.equal(h.database.counters[0].current_patient_id, patient.id);
  h.database.beforeRpc = null;
  assert.equal((await h.service.getQueueOverview()).patients.length, 1);
});

test("RPC simulation: array-shaped RPC rows are supported and doctor queues complete independently", async () => {
  const database = createDatabase();
  database.rpcReturnsArray = true;
  const h = await setup(false, { database });
  const patients = [];
  for (const number of [1, 2, 3]) patients.push(await acceptedPatient(h, number, `Doctor ${number} patient`));
  const starts = await Promise.all(patients.map((patient, index) => h.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser(index + 1))));
  assert.ok(starts.every((response) => response.status === 200));
  h.advance();
  assert.equal((await h.request("POST", "/queue/complete", { patient_id: patients[0].id }, doctorUser())).status, 200);
  const overview = await h.service.getQueueOverview();
  assert.equal(overview.counters[0].current_patient_id, null);
  for (const index of [1, 2]) {
    assert.equal(overview.counters[index].current_patient_id, patients[index].id);
    assert.equal(overview.patients.find((row) => row.id === patients[index].id).status, "serving");
  }
});

test("RPC simulation: separate backend instances cannot start or complete the same consultation twice", async () => {
  const database = createDatabase();
  const clock = { now: baseTime };
  const files = new Map();
  const first = await setup(false, { database, clock, files });
  const patient = await acceptedPatient(first);
  const second = await setup(false, { database, clock, files });
  const starts = await Promise.all([
    first.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser()),
    second.request("POST", "/queue/start", { patient_id: patient.id }, doctorUser())
  ]);
  assert.deepEqual(starts.map((response) => response.status).sort(), [200, 400]);
  const startedAt = database.patients[0].consultation_started_at;
  first.advance();
  const completions = await Promise.all([
    first.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser()),
    second.request("POST", "/queue/complete", { patient_id: patient.id }, doctorUser())
  ]);
  assert.deepEqual(completions.map((response) => response.status).sort(), [200, 400]);
  assert.equal(database.patients[0].consultation_started_at, startedAt);
  assert.equal(database.patients[0].status, "completed");
  assert.equal(database.counters[0].current_patient_id, null);
});
