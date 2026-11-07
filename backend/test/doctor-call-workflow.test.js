// Registration puts a visit straight into its doctor's queue: Frontdesk only monitors and cancels,
// the assigned doctor calls, and that Call is the visit's voice announcement.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");

const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const registration = (name, serviceType = "checkup", vulnerabilityFlags = []) => ({ idNum: name, serviceType, vulnerabilityFlags });
const call = (h, patient, user) => h.request("POST", "/queue/call", { patient_id: patient.id }, user);

async function setup(localFallback) {
  const h = createHarness({ localFallback });
  await h.initialize();
  return h;
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "mock Supabase";

  test(`${mode}: a registered visit is waiting, uncalled and unassigned until its doctor calls it`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    const [row] = (await h.service.getQueueOverview()).patients;
    assert.equal(row.id, patient.id);
    assert.equal(row.status, "waiting");
    assert.equal(row.called_at, null);
    assert.equal(row.counter_id ?? null, null);
  });

  test(`${mode}: Frontdesk is refused and changes nothing; the assigned doctor's Call announces the visit`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    const before = clone(await h.service.getPatientById(patient.id));

    const refused = await call(h, patient, FRONTDESK);
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /assigned doctor/);
    assert.deepEqual(clone(await h.service.getPatientById(patient.id)), before);
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 0);

    const called = await call(h, patient, doctor(1));
    assert.equal(called.status, 200, called.body.message);
    assert.equal(called.body.doctor, "Doctor 1");
    const [announcement, ...others] = clone((await h.service.getDisplayData()).voice_announcements);
    assert.deepEqual(others, []);
    assert.equal(announcement.event_type, "call");
    assert.equal(announcement.queue_number, patient.queue_number);
    assert.equal(announcement.counter_name, "Doctor 1");
    assert.equal(h.settings.isAwaitingAccept(patient.id), false, "the doctor's own Call needs no Accept");
    assert.ok(h.settings.getAcceptedAt(patient.id));
  });

  test(`${mode}: another doctor cannot call the visit, and a refused call announces nothing`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice", "prenatal"));
    assert.equal((await call(h, patient, doctor(1))).status, 400);
    assert.equal((await h.service.getPatientById(patient.id)).status, "waiting");
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 0);
    assert.equal((await call(h, patient, doctor(2))).status, 200);
  });

  test(`${mode}: the doctor's Call keeps the priority order and a repeat Call cannot duplicate the visit`, async () => {
    const h = await setup(localFallback);
    const regular = await h.service.createQueueEntry(registration("Regular"));
    const senior = await h.service.createQueueEntry(registration("Senior", "checkup", ["senior"]));

    const outOfOrder = await call(h, regular, doctor(1));
    assert.equal(outOfOrder.status, 400);
    assert.match(outOfOrder.body.message, /according to queue priority/);

    assert.equal((await call(h, senior, doctor(1))).status, 200);
    assert.equal((await call(h, senior, doctor(1))).status, 400, "already called");
    assert.equal((await call(h, regular, doctor(1))).status, 400, "the doctor already has a patient");
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 1);
    assert.equal((await h.service.getQueueOverview()).patients.filter((row) => row.status === "serving").length, 1);
  });

  test(`${mode}: after the doctor's Call the consultation can start straight away and Re-Call announces again`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    await call(h, patient, doctor(1));
    const overview = await h.service.getQueueOverview();
    assert.equal(overview.patients[0].awaiting_accept, false);
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(1))).status, 400, "nothing is left to accept");
    h.advance();
    assert.equal((await h.request("POST", "/queue/re-call", { patient_id: patient.id }, doctor(1))).status, 200);
    assert.deepEqual(clone((await h.service.getDisplayData()).voice_announcements.map((event) => event.event_type)), ["call", "recall"]);
    h.advance();
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(1))).status, 200);
    h.advance();
    assert.equal((await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(1))).status, 200);
    assert.equal((await h.service.getPatientById(patient.id)).status, "completed");
  });

  test(`${mode}: a doctor can cancel its waiting patient, who then leaves the queue with no announcement`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    const cancelled = await h.request("POST", "/queue/cancel", { patient_id: patient.id, reason: "Left", counter_id: "Doctor 1" }, doctor(1));
    assert.equal(cancelled.status, 200, cancelled.body.message);
    assert.equal((await h.service.getPatientById(patient.id)).status, "cancelled");
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 0);
  });

  test(`${mode}: a call made on the doctor's behalf still waits for the doctor's Accept`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    assert.equal((await h.request("POST", "/queue/call", { patient_id: patient.id })).status, 200);
    assert.equal(h.settings.isAwaitingAccept(patient.id), true);
    assert.equal((await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(1))).status, 200);
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, 1, "Accept does not repeat the announcement of its call");
  });

  test(`${mode}: a call with no announcement is still announced by Accept, so no visit goes unannounced`, async () => {
    const h = await setup(localFallback);
    const patient = await h.service.createQueueEntry(registration("Alice"));
    await h.request("POST", "/queue/call", { patient_id: patient.id });
    h.settings.clearAllVoiceAnnouncementEvents();
    h.advance();
    const accepted = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(1));
    assert.ok(accepted.body.announcement_key);
    assert.deepEqual(clone((await h.service.getDisplayData()).voice_announcements.map((event) => event.event_type)), ["accept"]);
  });
}

test("the Call announcement is dated after called_at, so a backend clock behind the database cannot hide it", async () => {
  const h = await setup(true);
  const calledAt = new Date(h.clock.now + 60000).toISOString();
  const event = h.settings.recordCallAnnouncement({ id: 7, queue_number: "GP-007", id_num: "Alice", status: "serving", called_at: calledAt, counter_id: "Doctor 1" });
  assert.equal(event.event_at, new Date(Date.parse(calledAt) + 1).toISOString());
  assert.equal(h.settings.hasCallAnnouncement({ id: 7, called_at: calledAt }), true);
  assert.equal(h.settings.hasCallAnnouncement({ id: 7, called_at: new Date(h.clock.now).toISOString() }), false, "a later call cycle is a new announcement");
});
