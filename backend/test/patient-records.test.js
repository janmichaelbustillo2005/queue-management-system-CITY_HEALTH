// Permanent patient records and Front Desk returning-patient registration
// (backend/scripts/20261103-patient-records.sql), through the real routes and queueService
// on the isolated Supabase double. PostgreSQL itself is not exercised here.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const DOCTOR = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };

const juan = {
  firstName: "Juan", middleInitial: "d", lastName: "Dela Cruz", sex: "Male", birthdate: "1990-04-12",
  residency: "Purok 2, Rizal St., Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", mobileNumber: "9123456789", philhealthId: "12-345678901-2",
  serviceType: "checkup", vulnerabilityFlags: []
};

function withRecords(options = {}) {
  const database = createDatabase();
  database.patient_records = [];
  return createHarness({ ...options, database });
}

const register = (h, body, user = FRONTDESK) => h.request("POST", "/patient-records/visits", body, user);
const search = (h, text, user = FRONTDESK) => h.request("GET", "/patient-records", {}, user, { search: text });
const retrieve = (h, id, user = FRONTDESK) => h.request("GET", "/patient-records/:id", {}, user, {}, { id: String(id) });

test("a new patient gets one permanent record and a first visit linked to it", async () => {
  const h = withRecords();
  const response = await register(h, juan);
  assert.equal(response.status, 200, response.body.message);
  assert.equal(response.body.queue_number, "GP-001");
  assert.equal(response.body.patient_record_created, true);
  assert.equal(response.body.patient_record.patient_code, "PAT-0001");

  assert.equal(h.database.patient_records.length, 1);
  const record = h.database.patient_records[0];
  assert.equal(record.full_name, "Juan D. Dela Cruz");
  assert.equal(record.search_name, "juan d dela cruz");
  assert.equal(record.created_by, "frontdesk");
  assert.equal(h.database.patients.length, 1);
  const visit = h.database.patients[0];
  assert.equal(visit.patient_record_id, record.id);
  assert.equal(visit.id_num, "Juan D. Dela Cruz");
  assert.equal(visit.source, "website", "Frontdesk registrations keep their existing source");
  assert.equal(visit.status, "waiting");
});

test("search is case-insensitive, matches partial and full names, and shows only identifying fields", async () => {
  const h = withRecords();
  assert.equal((await register(h, juan)).status, 200);
  assert.equal((await register(h, { ...juan, firstName: "Maria", middleInitial: "", lastName: "Santos", sex: "Female", birthdate: "1985-01-30" })).status, 200);

  for (const text of ["Juan", "juan", "JUAN", "jua", "dela cruz", "Juan Dela Cruz", "juan d. dela cruz", "cruz juan", "  JuAn   DeLa "]) {
    const response = await search(h, text);
    assert.equal(response.status, 200, text);
    assert.deepEqual(response.body.patients.map((row) => row.patient_code), ["PAT-0001"], text);
  }
  const maria = await search(h, "SANT");
  assert.deepEqual(maria.body.patients.map((row) => row.full_name), ["Maria Santos"]);
  assert.deepEqual(Object.keys(maria.body.patients[0]).sort(), ["birthdate", "full_name", "id", "patient_code", "sex"]);

  const none = await search(h, "Pedro");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.patients, []);
  assert.equal((await search(h, "j")).status, 400, "at least two characters");
  assert.equal((await search(h, "%_")).status, 400, "wildcards are not a name");
  assert.equal((await search(h, "%")).status, 400);
});

test("patients with the same name stay separate and are told apart by Patient ID, birthdate and sex", async () => {
  const h = withRecords();
  assert.equal((await register(h, juan)).status, 200);
  const other = await register(h, { ...juan, middleInitial: "", birthdate: "1972-09-03", serviceType: "consultation" });
  assert.equal(other.status, 200, other.body.message);
  assert.equal(other.body.patient_record.patient_code, "PAT-0002");

  const results = (await search(h, "juan dela cruz")).body.patients;
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((row) => row.patient_code).sort(), ["PAT-0001", "PAT-0002"]);
  assert.deepEqual(results.map((row) => row.birthdate).sort(), ["1972-09-03", "1990-04-12"]);
});

test("selecting a patient retrieves the full saved record without changing it", async () => {
  const h = withRecords();
  const id = (await register(h, juan)).body.patient_record.id;
  const before = clone(h.database.patient_records);
  const response = await retrieve(h, id);
  assert.equal(response.status, 200);
  assert.equal(response.body.patient.patient_code, "PAT-0001");
  assert.equal(response.body.patient.first_name, "Juan");
  assert.equal(response.body.patient.middle_initial, "D");
  assert.equal(response.body.patient.residency, juan.residency);
  assert.equal(response.body.patient.mobile_number, juan.mobileNumber);
  assert.equal(response.body.patient.search_name, undefined);
  assert.equal(response.body.patient.created_by, undefined);
  assert.deepEqual(clone(h.database.patient_records), before);
  assert.equal(h.database.patients.length, 1, "retrieving never creates a visit");

  assert.equal((await retrieve(h, 999)).status, 404);
  assert.equal((await retrieve(h, "1 OR 1=1")).status, 400);
  assert.equal((await retrieve(h, "-1")).status, 400);
});

test("a returning patient gets a new visit under the same record, using the stored details", async () => {
  const h = withRecords();
  const first = await register(h, juan);
  const recordId = first.body.patient_record.id;
  const firstVisit = h.database.patients[0];
  await h.request("POST", "/queue/cancel", { patient_id: firstVisit.id, reason: "Left early" });
  const historyBefore = clone(h.database.patients[0]);
  const recordBefore = clone(h.database.patient_records);

  // Demographics sent by the browser are ignored; only the visit fields are used.
  const response = await register(h, {
    patientRecordId: recordId, serviceType: "consultation", vulnerabilityFlags: ["pwd"],
    firstName: "Someone", lastName: "Else", mobileNumber: "9000000000", residency: "Elsewhere"
  });
  assert.equal(response.status, 200, response.body.message);
  assert.equal(response.body.queue_number, "GP-002", "the existing queue numbering continues");
  assert.equal(response.body.patient_record_created, false);
  assert.equal(response.body.patient_record.patient_code, "PAT-0001");

  assert.equal(h.database.patient_records.length, 1, "no duplicate record");
  assert.deepEqual(clone(h.database.patient_records), recordBefore, "the record is not overwritten");
  assert.equal(h.database.patients.length, 2);
  const { visit_state_revision: _r1, ...historyKept } = historyBefore;
  const { visit_state_revision: _r2, ...historyNow } = clone(h.database.patients[0]);
  assert.deepEqual(historyNow, historyKept, "the earlier visit is preserved");
  const visit = h.database.patients[1];
  assert.equal(visit.patient_record_id, recordId);
  assert.equal(visit.id_num, "Juan D. Dela Cruz");
  assert.equal(visit.mobile_number, juan.mobileNumber);
  assert.equal(visit.residency, juan.residency);
  assert.equal(visit.birthdate, juan.birthdate);
  assert.equal(visit.service_type, "consultation");
  assert.deepEqual(visit.vulnerability_flags, ["pwd"]);
  assert.equal(visit.status, "waiting");
});

test("a returning patient with an active visit today is not queued twice, even by simultaneous requests", async () => {
  const h = withRecords();
  const recordId = (await register(h, juan)).body.patient_record.id;
  const again = await register(h, { patientRecordId: recordId, serviceType: "checkup" });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already has an active queue visit today \(GP-001\)/);
  assert.equal(h.database.patients.length, 1);

  await h.request("POST", "/queue/cancel", { patient_id: h.database.patients[0].id, reason: "Wrong service" });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => register(h, { patientRecordId: recordId, serviceType: "prenatal" })));
  assert.deepEqual([a.status, b.status, c.status].sort(), [200, 409, 409]);
  assert.equal(h.database.patients.filter((row) => row.status === "waiting").length, 1);
  assert.equal(h.database.patient_records.length, 1);
});

test("an unknown or malformed record id is refused without creating anything", async () => {
  const h = withRecords();
  assert.equal((await register(h, { patientRecordId: 42, serviceType: "checkup" })).status, 404);
  assert.equal((await register(h, { patientRecordId: "abc", serviceType: "checkup" })).status, 400);
  assert.equal((await register(h, { patientRecordId: 1.5, serviceType: "checkup" })).status, 400);
  assert.equal(h.database.patients.length, 0);
  assert.equal(h.database.patient_records.length, 0);
});

test("records survive queue completion and Reset Queues", async () => {
  const h = withRecords();
  const recordId = (await register(h, juan)).body.patient_record.id;
  assert.equal((await register(h, { ...juan, firstName: "Ana", birthdate: "2001-02-02", sex: "Female", serviceType: "prenatal" })).status, 200);
  Object.assign(h.database.patients[0], { status: "completed", completed_at: new Date(h.clock.now).toISOString() });
  const records = clone(h.database.patient_records);

  const reset = await h.request("POST", "/queue/clear", {}, SUPERADMIN);
  assert.equal(reset.status, 200, reset.body?.message);
  assert.equal(h.database.patients[1].status, "cancelled");
  assert.deepEqual(clone(h.database.patient_records), records);
  assert.equal(h.database.patients.length, 2, "visit history is kept");

  const found = await search(h, "juan dela cruz");
  assert.deepEqual(found.body.patients.map((row) => row.id), [recordId]);
  const back = await register(h, { patientRecordId: recordId, serviceType: "checkup" });
  assert.equal(back.status, 200, back.body.message);
  assert.equal(back.body.queue_number, "GP-002");
  assert.equal(h.database.patient_records.length, 2);
});

test("registering a new patient who matches an existing record asks before creating a second one", async () => {
  const h = withRecords();
  assert.equal((await register(h, juan)).status, 200);
  await h.request("POST", "/queue/cancel", { patient_id: h.database.patients[0].id, reason: "Done" });

  const duplicate = await register(h, { ...juan, firstName: "JUAN", middleInitial: "", mobileNumber: "" });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body.possible_duplicates.map((row) => row.patient_code), ["PAT-0001"]);
  assert.equal(duplicate.body.possible_duplicates[0].residency, undefined);
  assert.equal(h.database.patient_records.length, 1);
  assert.equal(h.database.patients.length, 1);

  const confirmed = await register(h, { ...juan, confirmNewRecord: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.patient_record.patient_code, "PAT-0002");
  const codes = h.database.patient_records.map((row) => row.patient_code);
  assert.equal(new Set(codes).size, codes.length, "Patient IDs are unique");

  // Simultaneous repeated submissions of the same new patient create one record.
  const h2 = withRecords();
  const results = await Promise.all([1, 2].map(() => register(h2, juan)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(h2.database.patient_records.length, 1);
  assert.equal(h2.database.patients.length, 1);
});

test("new-patient validation runs before anything is saved", async () => {
  const h = withRecords();
  for (const [change, pattern] of [
    [{ firstName: "  " }, /First Name/], [{ lastName: "" }, /Last Name/], [{ sex: "" }, /sex/],
    [{ birthdate: "" }, /Birthdate/], [{ birthdate: "2999-01-01" }, /birthdate/], [{ residency: "" }, /Residency/],
    [{ serviceType: "" }, /service/], [{ mobileNumber: "09-12" }, /digits/], [{ vulnerabilityFlags: ["senior"] }, /Senior Citizen/],
    [{ vulnerabilityFlags: ["vip"] }, /Unknown priority/],
    // RES1: only an address in a Cabadbaran City barangay, Agusan del Norte, naming each part once.
    [{ residency: "Purok 1, Libertad, Butuan City, Agusan del Norte" }, /valid address within Cabadbaran City/],
    [{ residency: "Purok 1, Bayabas, Cabadbaran City, Agusan del Sur" }, /valid address within Cabadbaran City/],
    [{ residency: "Purok 1, Sumile, Cabadbaran City, Agusan del Norte" }, /valid address within Cabadbaran City/],
    [{ residency: "Poblacion 1, Cabadbaran City" }, /valid address within Cabadbaran City/],
    [{ residency: { barangay: "Bayabas" } }, /valid address within Cabadbaran City/],
    [{ residency: "Purok 1, Bayabas, Brgy. Calibunan, Cabadbaran City, Agusan del Norte" }, /cannot name a barangay, city or province again/],
    [{ residency: `${"x".repeat(46)}, Brgy. Bayabas, Cabadbaran City, Agusan del Norte` }, /at most 45/]
  ]) {
    const response = await register(h, { ...juan, ...change });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.match(response.body.message, pattern);
  }
  h.database.counters[0].is_online = false;
  assert.equal((await register(h, juan)).status, 400, "offline doctor");
  assert.equal(h.database.patient_records.length, 0);
  assert.equal(h.database.patients.length, 0);
});

test("only Front Desk and Super Admin accounts can search, read or register patient records", async () => {
  const h = withRecords();
  const recordId = (await register(h, juan, SUPERADMIN)).body.patient_record.id;
  assert.equal((await search(h, "juan", SUPERADMIN)).body.patients.length, 1);
  for (const user of [DOCTOR, { id_num: "staff9", role: "admin", doctor_name: "Doctor 2" }, { id_num: "x", role: "viewer" }]) {
    assert.equal((await search(h, "juan", user)).status, 403);
    assert.equal((await retrieve(h, recordId, user)).status, 403);
    assert.equal((await register(h, { patientRecordId: recordId, serviceType: "checkup" }, user)).status, 403);
    assert.equal((await register(h, { ...juan, confirmNewRecord: true }, user)).status, 403);
  }
  assert.equal((await search(h, "juan", null)).status, 401);
  assert.equal(h.database.patient_records.length, 1);
  assert.equal(h.database.patients.length, 1);
});

test("before the migration, search reports unavailable and new registrations still work unlinked", async () => {
  const h = createHarness();
  h.database.beforeQuery = (query) => query.table === "patient_records"
    ? { data: null, error: { code: "42P01", message: 'relation "public.patient_records" does not exist' } } : undefined;
  const found = await search(h, "juan");
  assert.equal(found.status, 503);
  assert.match(found.body.message, /20261103-patient-records\.sql/);

  const response = await register(h, juan);
  assert.equal(response.status, 200, response.body.message);
  assert.equal(response.body.queue_number, "GP-001");
  assert.equal(response.body.patient_record, null);
  assert.equal(response.body.patient_record_created, false);
  const insert = h.database.calls.find((call) => call.table === "patients" && call.action === "insert");
  assert.equal(Object.hasOwn(insert.payload, "patient_record_id"), false, "the visit insert is unchanged");
  assert.equal(h.database.patients[0].id_num, "Juan D. Dela Cruz");

  assert.equal((await register(h, { patientRecordId: 1, serviceType: "checkup" })).status, 503);
});

test("a saved record is returned when its first visit fails, so a retry reuses it", async () => {
  const h = withRecords();
  h.database.beforeQuery = (query) => query.table === "patients" && query.action === "insert"
    ? { data: null, error: { code: "XX000", message: "Isolated visit insert failure" } } : undefined;
  const failed = await register(h, juan);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.patient_record.patient_code, "PAT-0001");
  h.database.beforeQuery = null;
  const retry = await register(h, { patientRecordId: failed.body.patient_record.id, serviceType: juan.serviceType });
  assert.equal(retry.status, 200);
  assert.equal(h.database.patient_records.length, 1);
  assert.equal(h.database.patients[0].patient_record_id, failed.body.patient_record.id);
});

test("local development memory supports the same returning-patient workflow", async () => {
  const h = createHarness({ localFallback: true });
  await h.initialize();
  const first = await register(h, juan);
  assert.equal(first.status, 200, first.body.message);
  assert.equal(first.body.patient_record.patient_code, "PAT-0001");
  const found = await search(h, "DELA");
  assert.deepEqual(found.body.patients.map((row) => row.patient_code), ["PAT-0001"]);
  assert.equal((await retrieve(h, first.body.patient_record.id)).body.patient.full_name, "Juan D. Dela Cruz");
  assert.equal((await register(h, { patientRecordId: first.body.patient_record.id, serviceType: "checkup" })).status, 409);
  const overview = await h.service.getQueueOverview();
  assert.equal(overview.patients.length, 1);
  assert.equal(overview.patients[0].patient_record_id, first.body.patient_record.id);
});

test("the public website registration route is unchanged and creates no record", async () => {
  const h = withRecords();
  const response = await h.request("POST", "/queue/website", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: "Walk In", serviceType: "checkup" }, null);
  assert.equal(response.status, 200);
  assert.equal(h.database.patient_records.length, 0);
  assert.equal(Object.hasOwn(h.database.patients[0], "patient_record_id"), false);
});
