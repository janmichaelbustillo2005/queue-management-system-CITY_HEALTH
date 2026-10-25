// R1: the unauthenticated GET /display response must expose only an explicit,
// minimal set of fields. All data below is synthetic; no database is contacted
// (fake Supabase client or development memory only).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness, clone } = require("./helpers/queueHarness");

const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });

// Unmistakable synthetic values, so a leak is detectable by value as well as by key.
const SENTINEL = {
  mobile: "09170001234",
  residency: "Sentinel Barangay Zone 9",
  philhealth: "PHIL-SENTINEL-77",
  birthdate: "1951-02-03",
  sex: "X-SENTINEL"
};
// Recognizable fake identifiers that a clinic might type into the ID/name field.
const FAKE_IDS = ["CIT-1234-5678-SENTINEL", "PHILHEALTH-12-345678901-2-SENTINEL", "SSS-33-4455667-8-SENTINEL"];
const registration = (name, service = "consultation", flags = []) => ({
  idNum: name, serviceType: service, vulnerabilityFlags: flags,
  mobileNumber: SENTINEL.mobile, residency: SENTINEL.residency, philhealthId: SENTINEL.philhealth,
  birthdate: SENTINEL.birthdate, sex: SENTINEL.sex
});

// Contract: the exact keys each public collection may contain.
const TOP_KEYS = ["all_serving", "counters", "next_in_line", "now_serving", "queue_settings", "recent_accepted",
  "recent_called", "serving_count", "settings", "storage_mode", "voice_announcements", "waiting_count", "waiting_queue"];
const WAITING_KEYS = ["completed_at", "counter_id", "id", "queue_number", "service_type", "status"];
const WAITING_REQUIRED = ["id", "queue_number", "service_type", "status"];
const SERVING_KEYS = ["called_at", "counter_id", "counter_name", "id", "queue_number", "service_type", "status"];
const RECENT_CALLED_KEYS = ["called_at", "completed_at", "counter_id", "counter_name", "id", "queue_number", "service_type", "status"];
// counters.id_num is the doctor/room label ("Doctor 1"), never patient data.
const COUNTER_KEYS = ["id", "id_num", "is_online", "name", "service_types"];
const SETTINGS_KEYS = ["company_name", "department_name", "id", "refresh_interval", "welcome_message"];
const ACCEPTED_KEYS = ["accepted_at", "called_at", "counter_name", "id", "queue_number", "status"];
const VOICE_KEYS = ["accepted_at", "announcement_at", "announcement_key", "called_at", "counter_name", "event_type", "id",
  "queue_number", "status"];

// Keys that must never appear anywhere in the anonymous response.
const PROTECTED_KEYS = ["mobile_number", "residency", "philhealth_id", "birthdate", "sex", "priority_score", "vulnerability_flags",
  "source", "visit_state_revision", "reason", "created_at", "consultation_started_at", "service_duration_seconds",
  "current_patient_id", "current_patient_name", "current_patient_queue_number", "password", "auth_revision",
  "hospital_chart_number", "internal_note"];

const DOCTOR_FOR_SERVICE = { consultation: 1, checkup: 1, prenatal: 2, maternity: 2, family_planning: 3 };

function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, found));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { found.add(key); allKeys(child, found); }
  }
  return found;
}

// id_num may appear only on counter cards (doctor/room labels); ID_Num nowhere.
function assertNoPatientIdNum(body) {
  const walk = (value, inCounters) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, inCounters));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assert.notEqual(key, "ID_Num", "ID_Num must not be published");
        if (key === "id_num") {
          assert.ok(inCounters, "id_num is published outside counters[]");
          assert.match(child, /^Doctor [123]$/, "counter id_num must be the doctor/room label");
        }
        walk(child, inCounters);
      }
    }
  };
  for (const [key, child] of Object.entries(body)) walk(child, key === "counters");
}

function assertKeysWithin(object, allowed, label, required = []) {
  const keys = Object.keys(object);
  const extra = keys.filter((key) => !allowed.includes(key));
  assert.deepEqual(extra, [], `${label} exposes non-allowlisted fields: ${extra.join(", ")}`);
  for (const key of required) assert.ok(keys.includes(key), `${label} is missing required field ${key}`);
}

async function stored(h, patient, localFallback) {
  return localFallback ? h.service.getPatientById(patient.id) : h.database.patients.find((row) => row.id === patient.id);
}

async function accept(h, patient, number) {
  const response = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number));
  assert.equal(response.status, 200, response.body?.message);
  return response.body;
}

// Doctors 1-3 each serve one accepted patient, Doctor 3 has a completed visit,
// and five patients wait with mixed priorities. Serving patients are registered
// and called first so each is the head of its doctor's queue.
async function populate(h) {
  const made = {};
  const create = async (key, name, service, flags) => {
    made[key] = await h.service.createQueueEntry(registration(name, service, flags));
    h.advance(1000);
    return made[key];
  };
  await create("alice", "Alice Serving", "consultation");
  await h.service.callPatient(made.alice.id, "Doctor 1"); h.advance(1000); await accept(h, made.alice, 1); h.advance(1000);
  await create("cora", "Cora Serving", "prenatal");
  await h.service.callPatient(made.cora.id, "Doctor 2"); h.advance(1000); await accept(h, made.cora, 2); h.advance(1000);
  await create("dina", "Dina Done", "family_planning");
  await h.service.callPatient(made.dina.id, "Doctor 3"); h.advance(1000); await accept(h, made.dina, 3); h.advance(1000);
  await h.service.startConsultation(made.dina.id, doctor(3)); h.advance(5000);
  await h.service.completePatient(made.dina.id, null, "Doctor 3", doctor(3)); h.advance(1000);
  await create("wes", "Wes Regular", "consultation");
  await create("sam", "Sam Senior", "checkup", ["senior"]);
  await create("pam", "Pam Pwd", "prenatal", ["pwd"]);
  await create("fran", "Fran Regular", "family_planning");
  await create("wendy", "Wendy Regular", "consultation");
  return made;
}

async function storedRevisions(h, made) {
  const revisions = [];
  for (const patient of Object.values(made)) {
    const row = await h.service.getPatientById(patient.id);
    if (row?.visit_state_revision) revisions.push(row.visit_state_revision);
  }
  return revisions;
}

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "mock Supabase";
  const setup = async (options = {}) => {
    const h = createHarness({ localFallback, ...options });
    await h.initialize();
    return h;
  };

  test(`${mode}: anonymous GET /display is public, allowlist-only and free of protected data`, async () => {
    const h = await setup();
    const made = await populate(h);
    // Not vacuous: the stored rows really do hold the protected synthetic values.
    const row = await h.service.getPatientById(made.wes.id);
    assert.equal(row.mobile_number, SENTINEL.mobile);
    assert.equal(row.residency, SENTINEL.residency);
    assert.equal(row.philhealth_id, SENTINEL.philhealth);
    assert.equal(row.birthdate, SENTINEL.birthdate);
    assert.ok(row.visit_state_revision);

    const response = await h.request("GET", "/display", {}, null);
    assert.equal(response.status, 200, "Queue Display must stay publicly readable");
    const body = response.body;
    assertKeysWithin(body, TOP_KEYS, "display response", TOP_KEYS.filter((key) => key !== "queue_settings"));

    const keys = allKeys(body);
    for (const key of PROTECTED_KEYS) assert.ok(!keys.has(key), `anonymous response contains protected key ${key}`);
    const serialized = JSON.stringify(body);
    for (const value of Object.values(SENTINEL)) assert.ok(!serialized.includes(value), `anonymous response contains protected value ${value}`);
    for (const revision of await storedRevisions(h, made)) assert.ok(!serialized.includes(revision), "visit revision leaked");
    // Whatever was typed into patients.id_num (a name or an identifier) is never published.
    for (const patient of Object.values(made)) assert.ok(!serialized.includes(patient.id_num), `id_num value ${patient.id_num} leaked`);
    assertNoPatientIdNum(body);
  });

  test(`${mode}: waiting and next-in-line carry only queue-card fields and no patient name`, async () => {
    const h = await setup();
    const made = await populate(h);
    const body = (await h.request("GET", "/display", {}, null)).body;
    assert.equal(body.waiting_queue.length, 5);
    assert.equal(body.waiting_count, 5);
    for (const entry of body.waiting_queue) {
      assertKeysWithin(entry, WAITING_KEYS, "waiting entry", WAITING_REQUIRED);
      assert.ok(!("id_num" in entry), "waiting entries must not carry the patient name");
      assert.equal(entry.status, "waiting");
    }
    assertKeysWithin(body.next_in_line, WAITING_KEYS, "next_in_line", WAITING_REQUIRED);
    assert.deepEqual(body.next_in_line, body.waiting_queue[0]);
    assert.equal(body.next_in_line.queue_number, made.sam.queue_number);
    for (const entry of body.waiting_queue) {
      const source = Object.values(made).find((patient) => patient.id === entry.id);
      assert.equal(entry.queue_number, source.queue_number);
      assert.equal(entry.service_type, source.service_type);
    }
  });

  test(`${mode}: next-in-line is null when nobody waits`, async () => {
    const h = await setup();
    const body = (await h.request("GET", "/display", {}, null)).body;
    assert.equal(body.next_in_line, null);
    assert.deepEqual(body.waiting_queue, []);
    assert.equal(body.waiting_count, 0);
    assert.equal(body.now_serving, null);
  });

  test(`${mode}: serving entries expose only the card fields and identify the visit by queue number`, async () => {
    const h = await setup();
    const made = await populate(h);
    const body = (await h.request("GET", "/display", {}, null)).body;
    assert.equal(body.serving_count, 2);
    assert.equal(body.all_serving.length, 2);
    for (const entry of body.all_serving) {
      assertKeysWithin(entry, SERVING_KEYS, "serving entry", ["id", "queue_number", "service_type", "status", "called_at", "counter_name", "counter_id"]);
      assert.equal(entry.status, "serving");
    }
    assert.deepEqual(body.now_serving, body.all_serving[0]);
    const alice = body.all_serving.find((entry) => entry.id === made.alice.id);
    assert.ok(!("id_num" in alice) && !("ID_Num" in alice), "serving entries carry no patient name or identifier");
    assert.equal(alice.counter_name, "Doctor 1");
    assert.equal(alice.counter_id, 1, "numeric counter id is kept for card matching");
    assert.equal(alice.queue_number, made.alice.queue_number);
    assert.equal(alice.service_type, "consultation");
    assert.equal(body.all_serving.find((entry) => entry.id === made.cora.id).counter_name, "Doctor 2");
  });

  test(`${mode}: recent_called is allowlisted and carries no patient name`, async () => {
    const h = await setup();
    const made = await populate(h);
    const body = (await h.request("GET", "/display", {}, null)).body;
    assert.equal(body.recent_called.length, 3);
    for (const entry of body.recent_called) {
      assertKeysWithin(entry, RECENT_CALLED_KEYS, "recent_called entry", ["id", "queue_number", "service_type", "status", "called_at", "counter_name"]);
      assert.ok(!("id_num" in entry));
    }
    assert.equal(body.recent_called.find((entry) => entry.id === made.dina.id).status, "completed");
  });

  test(`${mode}: counter cards keep doctor and availability data but not the attached patient`, async () => {
    const h = await setup();
    await populate(h);
    const body = (await h.request("GET", "/display", {}, null)).body;
    assert.deepEqual(body.counters.map((counter) => counter.id_num), ["Doctor 1", "Doctor 2", "Doctor 3"]);
    for (const counter of body.counters) {
      assertKeysWithin(counter, COUNTER_KEYS, "counter", ["id", "id_num", "service_types", "is_online"]);
      assert.ok(!("ID_Num" in counter));
      assert.ok(!JSON.stringify(counter).includes("Serving"), "no attached patient on the counter card");
      assert.equal(counter.name, counter.id_num);
      assert.equal(typeof counter.is_online, "boolean");
      assert.ok(Array.isArray(counter.service_types) && counter.service_types.length > 0);
    }
    // Authenticated staff views are unchanged and still receive the full records.
    const overview = (await h.request("GET", "/queue", {}, { id_num: "frontdesk", role: "admin", doctor_name: null })).body;
    assert.equal(overview.counters.find((counter) => counter.id_num === "Doctor 1").current_patient_name, "Alice Serving");
    assert.equal(overview.patients.find((patient) => patient.queue_number).mobile_number, SENTINEL.mobile);
  });

  test(`${mode}: announcement collections are allowlisted, stable across polls, withdrawn on cancel and renewed by Re-Call`, async () => {
    const h = await setup();
    const made = await populate(h);
    const first = (await h.request("GET", "/display", {}, null)).body;
    assert.equal(first.voice_announcements.length, 2);
    for (const event of first.voice_announcements) {
      assertKeysWithin(event, VOICE_KEYS, "voice announcement", ["id", "queue_number", "announcement_key", "announcement_at", "event_type", "counter_name"]);
      assert.equal(event.status, "serving");
    }
    for (const entry of first.recent_accepted) assertKeysWithin(entry, ACCEPTED_KEYS, "recent_accepted entry", ["id", "queue_number", "accepted_at", "counter_name"]);
    assert.equal(first.recent_accepted.length, 3);

    // Recovery depends on stable keys/timestamps across repeated anonymous polls.
    assert.deepEqual((await h.request("GET", "/display", {}, null)).body.voice_announcements, first.voice_announcements);

    // A new call cycle (Re-Call) publishes a new announcement.
    h.advance(1000);
    assert.equal((await h.request("POST", "/queue/re-call", { patient_id: made.cora.id }, doctor(2))).status, 200);
    const afterRecall = (await h.request("GET", "/display", {}, null)).body.voice_announcements;
    assert.equal(afterRecall.length, 3);
    assert.equal(new Set(afterRecall.map((event) => event.announcement_key)).size, 3);
    for (const event of afterRecall) assertKeysWithin(event, VOICE_KEYS, "voice announcement after Re-Call");

    // Withdrawal: cancelling Alice removes her serving entry and every announcement for her.
    h.advance(1000);
    const cancelled = await h.request("POST", "/queue/cancel", { patient_id: made.alice.id, reason: "Synthetic withdrawal" }, { id_num: "frontdesk", role: "admin", doctor_name: null });
    assert.equal(cancelled.status, 200, cancelled.body.message);
    const withdrawn = (await h.request("GET", "/display", {}, null)).body;
    assert.ok(!withdrawn.all_serving.some((entry) => entry.id === made.alice.id));
    assert.ok(!withdrawn.voice_announcements.some((event) => event.id === made.alice.id));
    assert.ok(withdrawn.voice_announcements.some((event) => event.id === made.cora.id));
    assert.ok(!JSON.stringify(withdrawn).includes(SENTINEL.mobile));
  });

  test(`${mode}: columns added to the database later stay private (allowlist, not blocklist)`, async () => {
    const h = await setup();
    const made = await populate(h);
    for (const patient of Object.values(made)) {
      Object.assign(await stored(h, patient, localFallback), { hospital_chart_number: "CHART-SENTINEL-1", internal_note: "NOTE-SENTINEL-2" });
    }
    if (!localFallback) {
      Object.assign(h.database.counters[0], { internal_note: "NOTE-SENTINEL-2", hospital_chart_number: "CHART-SENTINEL-1" });
      Object.assign(h.database.display_settings[0], { internal_note: "NOTE-SENTINEL-2", hospital_chart_number: "CHART-SENTINEL-1" });
    }
    const response = await h.request("GET", "/display", {}, null);
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes("SENTINEL-1") && !serialized.includes("SENTINEL-2"));
    assertKeysWithin(response.body.settings, SETTINGS_KEYS, "settings");
  });

  test(`${mode}: building the public response does not alter stored patient records`, async () => {
    const h = await setup();
    const made = await populate(h);
    const before = clone(await h.service.getPatientById(made.wes.id));
    const tableBefore = localFallback ? null : clone(h.database.patients);
    await h.request("GET", "/display", {}, null);
    await h.request("GET", "/display", {}, null);
    assert.deepEqual(clone(await h.service.getPatientById(made.wes.id)), before);
    if (!localFallback) assert.deepEqual(clone(h.database.patients), tableBefore, "no patient row may change");
    assert.equal(before.mobile_number, SENTINEL.mobile);
  });

  test(`${mode}: weighted-priority order is unchanged, per doctor and overall`, async () => {
    const h = await setup();
    const made = await populate(h);
    const body = (await h.request("GET", "/display", {}, null)).body;
    // Priority DESC (senior 4 > pwd 3 > regular 1), then registration time ASC.
    assert.deepEqual(body.waiting_queue.map((entry) => entry.queue_number),
      [made.sam, made.pam, made.wes, made.fran, made.wendy].map((patient) => patient.queue_number));
    const perDoctor = {};
    for (const entry of body.waiting_queue) (perDoctor[DOCTOR_FOR_SERVICE[entry.service_type]] ||= []).push(entry.queue_number);
    assert.deepEqual(perDoctor[1], [made.sam, made.wes, made.wendy].map((patient) => patient.queue_number));
    assert.deepEqual(perDoctor[2], [made.pam.queue_number]);
    assert.deepEqual(perDoctor[3], [made.fran.queue_number]);
  });

  test(`${mode}: call eligibility and tie-breaking still follow weighted priority`, async () => {
    const h = await setup();
    const first = await h.service.createQueueEntry(registration("Tie First"));
    h.advance(1000);
    const second = await h.service.createQueueEntry(registration("Tie Second"));
    h.advance(1000);
    const senior = await h.service.createQueueEntry(registration("Later Senior", "consultation", ["senior"]));
    const order = (await h.request("GET", "/display", {}, null)).body.waiting_queue.map((entry) => entry.id);
    assert.deepEqual(order, [senior.id, first.id, second.id]);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: first.id, counterId: "Doctor 1" })).status, 400, "lower priority cannot jump the senior");
    assert.equal((await h.request("POST", "/queue/call", { patient_id: senior.id, counterId: "Doctor 1" })).status, 200);
    h.advance(1000);
    assert.equal((await h.request("POST", "/queue/call", { patient_id: second.id, counterId: "Doctor 2" })).status, 400, "equal-priority later arrival cannot jump the earlier one");
  });

  test(`${mode}: identifier-like id_num values (citizen, PhilHealth, SSS style) never reach the anonymous response`, async () => {
    const h = await setup();
    const serving = await h.service.createQueueEntry(registration(FAKE_IDS[0], "consultation"));
    h.advance(1000);
    await h.service.callPatient(serving.id, "Doctor 1"); h.advance(1000);
    await accept(h, serving, 1); h.advance(1000);
    const waitingA = await h.service.createQueueEntry(registration(FAKE_IDS[1], "prenatal", ["pregnant"]));
    h.advance(1000);
    const waitingB = await h.service.createQueueEntry(registration(FAKE_IDS[2], "family_planning"));
    h.advance(1000);
    const cancelled = await h.service.createQueueEntry(registration("Cancelled Person", "checkup"));
    await h.service.cancelPatient(cancelled.id);
    // Not vacuous: the identifier-like values really are stored.
    assert.equal((await h.service.getPatientById(waitingA.id)).id_num, FAKE_IDS[1]);
    const body = (await h.request("GET", "/display", {}, null)).body;
    const serialized = JSON.stringify(body);
    for (const value of [...FAKE_IDS, "Cancelled Person", ...Object.values(SENTINEL)]) assert.ok(!serialized.includes(value), `${value} leaked`);
    assertNoPatientIdNum(body);
    assert.equal(body.all_serving[0].queue_number, serving.queue_number);
    assert.deepEqual(body.waiting_queue.map((entry) => entry.queue_number), [waitingA.queue_number, waitingB.queue_number]);
    // Staff views keep the stored value, so the fix is a presentation change only.
    const overview = (await h.request("GET", "/queue", {}, { id_num: "frontdesk", role: "admin", doctor_name: null })).body;
    assert.equal(overview.patients.find((patient) => patient.id === waitingA.id).id_num, FAKE_IDS[1]);
  });

  test(`${mode}: voice and accepted events are minimized to queue number, doctor/room and event identity`, async () => {
    const h = await setup();
    const made = await populate(h);
    const body = (await h.request("GET", "/display", {}, null)).body;
    for (const key of ["voice_announcements", "recent_accepted"]) {
      assert.ok(body[key].length > 0);
      for (const event of body[key]) {
        const source = Object.values(made).find((patient) => patient.id === event.id);
        assert.equal(event.queue_number, source.queue_number, "announcement must carry the correct queue number");
        assert.match(event.counter_name, /^Doctor [123]$/);
        assert.ok(!("id_num" in event) && !("patient_name" in event) && !("ID_Num" in event));
        assert.ok(!JSON.stringify(event).includes(source.id_num));
      }
    }
    for (const event of body.voice_announcements) {
      assert.match(event.announcement_key, /\S/);
      assert.ok(event.announcement_at);
      assert.equal(event.status, "serving");
      assert.equal(event.counter_name, `Doctor ${DOCTOR_FOR_SERVICE[Object.values(made).find((patient) => patient.id === event.id).service_type]}`);
    }
    // Serving cards and counters still give queue number + doctor/room.
    const alice = body.all_serving.find((entry) => entry.id === made.alice.id);
    assert.deepEqual([alice.queue_number, alice.counter_name], [made.alice.queue_number, "Doctor 1"]);
  });
}

test("cross-midnight serving visit remains visible, with allowlisted fields only", async () => {
  for (const localFallback of [false, true]) {
    const h = createHarness({ localFallback, clock: { now: Date.parse("2026-10-10T15:59:20.000Z") } });
    await h.initialize();
    const patient = await h.service.createQueueEntry(registration("Midnight Serving", "prenatal"));
    await h.service.callPatient(patient.id, "Doctor 2");
    await accept(h, patient, 2);
    h.advance(1000);
    await h.service.startConsultation(patient.id, doctor(2));
    const yesterdayWaiting = await h.service.createQueueEntry(registration("Yesterday Waiting", "family_planning"));
    h.advance(60000); // now after Manila midnight
    const todayWaiting = await h.service.createQueueEntry(registration("Today Waiting", "family_planning"));
    const body = (await h.request("GET", "/display", {}, null)).body;
    assert.deepEqual(body.all_serving.map((entry) => entry.id), [patient.id]);
    assertKeysWithin(body.all_serving[0], SERVING_KEYS, "carried serving entry");
    assert.ok(!JSON.stringify(body).includes("Midnight Serving"));
    assert.equal(body.all_serving[0].queue_number, patient.queue_number);
    assertNoPatientIdNum(body);
    assert.equal(body.all_serving[0].counter_name, "Doctor 2");
    assert.deepEqual(body.waiting_queue.map((entry) => entry.id), [todayWaiting.id], `previous-day waiting ${yesterdayWaiting.id} stays out`);
    assert.equal(body.voice_announcements.length, 1);
    assert.ok(!JSON.stringify(body).includes(SENTINEL.mobile));
    for (const key of PROTECTED_KEYS) assert.ok(!allKeys(body).has(key), key);
  }
});

test("Queue Display and registration pages read only fields that /display still publishes", () => {
  const page = fs.readFileSync(path.resolve(__dirname, "../../frontend/pages/queue-display.js"), "utf8");
  const readFields = (pattern, source = page) => new Set([...source.matchAll(pattern)].map((match) => match[1]));
  const group = page.slice(page.indexOf("function groupWaitingQueues"), page.indexOf("function getWaitingPage"));
  assert.ok(group.length > 100, "groupWaitingQueues was not found");
  const waitingReads = readFields(/\brow\.(\w+)/g, group);
  for (const field of waitingReads) assert.ok(SERVING_KEYS.includes(field) || WAITING_KEYS.includes(field), `waiting grouping reads ${field}`);
  for (const field of ["id", "status", "completed_at", "counter_id", "service_type"]) assert.ok(WAITING_KEYS.includes(field));
  for (const field of readFields(/\bservingPatient\.(\w+)/g)) assert.ok(SERVING_KEYS.includes(field), `serving card reads ${field}`);
  for (const field of readFields(/\b(?:nextForCounter\??|p)\.(queue_number|service_type)/g)) assert.ok(WAITING_KEYS.includes(field));
  for (const field of readFields(/\bcounter\.(\w+)/g)) assert.ok(["id", "id_num", "name", "service_types", "is_online"].includes(field), `counter card reads ${field}`);
  // Patients are identified by queue number only: id_num is read from counters (doctor labels) never from patients.
  assert.deepEqual([...page.matchAll(/\b(?:patient|row|servingPatient|entry|s|p|event|call)\??\.(?:id_num|ID_Num|patient_name)\b/g)], [],
    "the public display must not read a patient name or identifier");
  assert.ok(!/patient_name|patientName/.test(page), "the voice request and logs must not carry a patient name");
  const protectedReads = [...page.matchAll(/\b(?:patient|row|servingPatient|entry)\??\.(mobile_number|residency|philhealth_id|birthdate|sex|priority_score|visit_state_revision|vulnerability_flags)/g)];
  assert.deepEqual(protectedReads, [], "the public display must not read protected fields");
  const registration = fs.readFileSync(path.resolve(__dirname, "../../frontend/pages/fill-up_form.js"), "utf8");
  const section = registration.slice(registration.indexOf("async function fetchDoctorAvailability"), registration.indexOf("async function fetchDoctorAvailability") + 700);
  assert.match(section, /counter\.is_online/);
  assert.match(section, /item\.id_num === doctorName \|\| item\.name === doctorName/);
});
