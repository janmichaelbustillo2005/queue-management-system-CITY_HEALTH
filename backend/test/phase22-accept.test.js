const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, clone } = require("./helpers/queueHarness");

const baseTime = Date.parse("2026-10-14T01:00:00.000Z");
const services = ["consultation", "prenatal", "family_planning"];
const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });

async function setup(localFallback) {
  const h = createHarness({ localFallback, clock: { now: baseTime } });
  await h.initialize();
  return h;
}

async function call(h, number) {
  const patient = await h.service.createQueueEntry({
    idNum: `Accept patient ${number}`, serviceType: services[number - 1], mobileNumber: "000", vulnerabilityFlags: []
  });
  const response = await h.request("POST", "/queue/call", { patient_id: patient.id });
  assert.equal(response.status, 200, response.body.message);
  return patient;
}

async function snapshot(h) {
  const overview = clone(await h.service.getQueueOverview());
  const persisted = h.loadSettings();
  return {
    overview,
    acceptance: overview.patients.map(({ id }) => ({
      id, awaiting: h.settings.isAwaitingAccept(id), acceptedAt: h.settings.getAcceptedAt(id),
      persistedAwaiting: persisted.isAwaitingAccept(id), persistedAcceptedAt: persisted.getAcceptedAt(id)
    })),
    voiceEvents: clone(h.settings.getVoiceAnnouncementEvents()),
    persistedVoiceEvents: clone(persisted.getVoiceAnnouncementEvents()),
    files: [...h.virtualFs.files.entries()],
    notifications: clone(h.notifications)
  };
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "development memory" : "isolated Supabase model";

  for (const number of [1, 2, 3]) {
    test(`Phase 2.2 ${mode}: assigned Doctor ${number} can accept only the current call without starting consultation`, async () => {
      const h = await setup(localFallback);
      const patient = await call(h, number);
      const before = clone(await h.service.getQueueOverview());
      const storedBefore = clone(await h.service.getPatientById(patient.id));
      assert.equal(h.settings.isAwaitingAccept(patient.id), true);
      h.advance();

      const response = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number));
      assert.equal(response.status, 200, response.body.message);
      assert.equal(response.body.success, true);
      assert.equal(response.body.accepted_at, new Date(h.clock.now).toISOString());
      assert.equal(h.settings.isAwaitingAccept(patient.id), false);
      assert.equal(h.settings.getAcceptedAt(patient.id), response.body.accepted_at);
      assert.equal(h.loadSettings().getAcceptedAt(patient.id), response.body.accepted_at);

      const after = clone(await h.service.getQueueOverview());
      assert.deepEqual(after.counters, before.counters, "Accept retains the assigned counter pointer");
      assert.deepEqual(clone(await h.service.getPatientById(patient.id)), storedBefore,
        "Accept preserves serving state and all stored visit fields");
      assert.equal(after.patients[0].status, "serving");
      assert.equal(after.patients[0].consultation_started_at, null);
      assert.equal(after.patients[0].completed_at, null);
      assert.equal(after.counters.find(counter => counter.id_num === `Doctor ${number}`).current_patient_id, patient.id);

      const events = clone(h.settings.getVoiceAnnouncementEvents());
      assert.equal(events.length, 1);
      assert.equal(events[0].event_id, response.body.announcement_key);
      assert.equal(events[0].patient_id, patient.id);
      assert.equal(events[0].counter_name, `Doctor ${number}`);
      assert.equal(events[0].event_type, "accept");
      assert.equal(events[0].event_at, response.body.accepted_at);
      assert.deepEqual(clone(h.loadSettings().getVoiceAnnouncementEvents()), events);
    });

    const otherNumber = number % 3 + 1;
    const rejectedActors = [
      ["another assigned doctor", doctor(otherNumber)],
      ["frontdesk admin with null assignment", { id_num: "frontdesk", role: "admin", doctor_name: null }],
      ["superadmin with forged doctor assignment", { id_num: "superadmin", role: "superadmin", doctor_name: `Doctor ${number}` }],
      ["non-admin with forged doctor assignment", { id_num: `admin${number}`, role: "patient", doctor_name: `Doctor ${number}` }]
    ];

    for (const [label, actor] of rejectedActors) {
      test(`Phase 2.2 ${mode}: Doctor ${number} acceptance rejects ${label} despite forged body identity`, async () => {
        const h = await setup(localFallback);
        const patient = await call(h, number);
        // Retain a real existing acceptance and voice event, as well as this
        // patient's pending acceptance, when a different account is rejected.
        const acceptedPatient = await call(h, otherNumber);
        h.advance();
        assert.equal((await h.request("POST", "/queue/accept", { patient_id: acceptedPatient.id }, doctor(otherNumber))).status, 200);
        const before = await snapshot(h);
        assert.equal(before.voiceEvents.length, 1);
        assert.equal(h.settings.isAwaitingAccept(patient.id), true);
        assert.equal(h.settings.getAcceptedAt(patient.id), null);
        h.advance();

        const response = await h.request("POST", "/queue/accept", {
          patient_id: patient.id,
          counterId: `Doctor ${number}`, counter_id: `Doctor ${number}`, doctor_name: `Doctor ${number}`,
          id_num: `admin${number}`, role: "admin", user: doctor(number), actor: doctor(number)
        }, actor);
        assert.equal(response.status, 403, response.body.message);
        assert.equal(response.body.success, false);
        assert.deepEqual(await snapshot(h), before,
          "Rejected Accept preserves visit state, every counter pointer, pending/existing acceptance, persisted voice events, and notifications");
      });
    }
  }
}
