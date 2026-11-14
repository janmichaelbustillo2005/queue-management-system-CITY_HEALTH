// RES1: a patient's residency is limited to an address in a barangay of Cabadbaran City,
// Agusan del Norte, entered through one Residency search bar. Checks the shared rules, every
// registration route, returning patients with addresses saved before RES1, the residency chart,
// and that the frontend applies exactly the backend's rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");
const residency = require("../src/lib/residency");

const VALID = "Purok 3, Rizal St., Brgy. Bayabas, Cabadbaran City, Agusan del Norte";
const INVALID = "Please select a valid address within Cabadbaran City, Agusan del Norte.";
const OUTSIDE = [
  "Purok 1, Brgy. Libertad, Butuan City, Agusan del Norte",
  "Purok 1, Brgy. Bayabas, Cabadbaran City, Agusan del Sur",
  "Purok 1, Brgy. Sumile, Cabadbaran City, Agusan del Norte",
  "Purok 1, Brgy. Bayabas, Cabadbaran City, Agusan del Norte, Extra",
  "Purok 3 Calibunan",
  "Cabadbaran"
];
// Each repeats or contradicts the barangay, city or province.
const REPEATED = [
  "Purok 1, Bayabas, Brgy. Calibunan, Cabadbaran City, Agusan del Norte",
  "Purok 1, Brgy. Bayabas, Brgy. Calibunan, Cabadbaran City, Agusan del Norte",
  "Purok 1, Butuan City, Brgy. Calibunan, Cabadbaran City, Agusan del Norte",
  "Purok 1, Cabadbaran, Brgy. Calibunan, Cabadbaran City, Agusan del Norte",
  "Purok 1, Agusan del Sur Province, Brgy. Calibunan, Cabadbaran City, Agusan del Norte"
];

// frontend/lib/residency.js, run as plain JavaScript: it imports nothing.
function loadFrontendRules() {
  const source = fs.readFileSync(path.join(__dirname, "../../frontend/lib/residency.js"), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(`${source.replace(/^export /gm, "")}
module.exports = { CABADBARAN_BARANGAYS, RESIDENCY_STREET_MAX, formatResidency, parseResidency, residencyProblem, normalizeResidency, suggestResidencies };`,
  { module });
  return module.exports;
}

test("the barangay list is the 31 official barangays of Cabadbaran City, with no duplicates", () => {
  const list = residency.CABADBARAN_BARANGAYS;
  assert.equal(list.length, 31);
  assert.equal(new Set(list.map((name) => name.toLowerCase())).size, 31);
  for (const name of ["Antonio Luna", "Bay-ang", "Bayabas", "Caasinan", "Cabinet", "Calamba", "Calibunan", "Comagascas",
    "Concepcion", "Del Pilar", "Katugasan", "Kauswagan", "La Union", "Mabini", "Mahaba", "Puting Bato", "Sanghan", "Soriano", "Tolosa"]) {
    assert.ok(list.includes(name), name);
  }
  for (let n = 1; n <= 12; n += 1) assert.ok(list.includes(`Poblacion ${n}`), `Poblacion ${n}`);
  assert.ok(Object.isFrozen(list));
});

test("a valid address is stored in one canonical form; a barangay alone is a complete address", () => {
  assert.equal(residency.readResidency(VALID), VALID);
  assert.equal(residency.readResidency("  Purok 3 ,  rizal st. , brgy  bayabas ,cabadbaran city,  agusan DEL norte "),
    "Purok 3, rizal st., Brgy. Bayabas, Cabadbaran City, Agusan del Norte");
  assert.equal(residency.readResidency("Barangay Calibunan, Cabadbaran City, Agusan del Norte"), "Brgy. Calibunan, Cabadbaran City, Agusan del Norte");
  // Addresses written before the "Brgy." prefix (earlier RES1 builds) still read as the same address.
  assert.equal(residency.readResidency("Purok 3, Bayabas, Cabadbaran City, Agusan del Norte"), "Purok 3, Brgy. Bayabas, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(residency.parseResidency(VALID), { street: "Purok 3, Rizal St.", barangay: "Bayabas" });
  // Street names that share a barangay's name, and "City Proper", are ordinary details.
  for (const value of ["Mabini St., Brgy. Calibunan, Cabadbaran City, Agusan del Norte", "City Proper, Brgy. Poblacion 4, Cabadbaran City, Agusan del Norte"]) {
    assert.equal(residency.readResidency(value), value);
  }
  // The longest valid address fits patients.residency varchar(100).
  const longest = residency.CABADBARAN_BARANGAYS.reduce((a, b) => (b.length > a.length ? b : a));
  assert.ok(residency.formatResidency({ street: "x".repeat(residency.RESIDENCY_STREET_MAX), barangay: longest }).length <= 100);
});

test("an empty, out-of-area, unselected or repeated address is refused with a message for the bar", () => {
  for (const value of [...OUTSIDE, 42, ["Bayabas"], { barangay: "Bayabas" }]) {
    assert.throws(() => residency.readResidency(value), (error) => error.statusCode === 400 && error.message === INVALID, String(value));
  }
  for (const value of OUTSIDE) assert.equal(residency.parseResidency(value), null, value);
  for (const value of REPEATED) assert.throws(() => residency.readResidency(value), /cannot name a barangay, city or province again/, value);
  assert.throws(() => residency.readResidency(`${"x".repeat(46)}, Brgy. Bayabas, Cabadbaran City, Agusan del Norte`), /at most 45/);
  assert.throws(() => residency.readResidency("  "), /Residency is required/);
  assert.throws(() => residency.readResidency(undefined), /Residency is required/);
});

test("the frontend applies exactly the backend's barangays, messages and address rules", () => {
  const frontend = loadFrontendRules();
  assert.deepEqual([...frontend.CABADBARAN_BARANGAYS], [...residency.CABADBARAN_BARANGAYS]);
  assert.equal(frontend.RESIDENCY_STREET_MAX, residency.RESIDENCY_STREET_MAX);
  const samples = [VALID, ...OUTSIDE, ...REPEATED, "", "  ", "Brgy. Calibunan, Cabadbaran City, Agusan del Norte",
    "purok 3, bayabas, cabadbaran city, agusan del norte", `${"x".repeat(46)}, Brgy. Bayabas, Cabadbaran City, Agusan del Norte`,
    ...residency.CABADBARAN_BARANGAYS.map((name) => `Purok 2, ${name}, Cabadbaran City, Agusan del Norte`)];
  for (const value of samples) {
    assert.equal(frontend.residencyProblem(value), residency.residencyProblem(value), value);
    const sent = frontend.normalizeResidency(value);
    if (sent) assert.equal(residency.readResidency(sent), sent, `the backend accepts what the form sends: ${value}`);
  }
  // Every address the search bar suggests is one the backend accepts unchanged.
  for (const query of ["", "Calibunan", "Purok 3, Cali", "pob 1", "Mabini St. Calibunan", "#12 Rizal St., Purok 3, Brgy. Tolosa"]) {
    for (const item of frontend.suggestResidencies(query, { limit: 31 })) assert.equal(residency.readResidency(item.label), item.label, item.label);
  }
});

for (const [route, body] of [
  ["/queue", { fullName: "Synthetic Manual", service_type: "checkup" }],
  ["/queue/website", { fullName: "Synthetic Website", serviceType: "checkup" }]
]) {
  test(`${route} requires a Cabadbaran City address and stores it canonically`, async () => {
    const h = createHarness();
    for (const value of [...OUTSIDE, ...REPEATED, { city: "Butuan City" }, "", undefined]) {
      const response = await h.request("POST", route, { ...body, residency: value });
      assert.equal(response.status, 400, JSON.stringify(value));
      assert.match(response.body.message, /valid address within Cabadbaran City|Residency is required|cannot name a barangay/);
    }
    assert.equal(h.database.patients.length, 0, "nothing is saved for a refused address");

    const valid = await h.request("POST", route, { ...body, residency: "purok 3, Rizal St., bayabas, Cabadbaran City, Agusan del Norte" });
    assert.equal(valid.status, 200, valid.body.message);
    assert.equal(h.database.patients[0].residency, "purok 3, Rizal St., Brgy. Bayabas, Cabadbaran City, Agusan del Norte");
  });
}

test("a returning patient whose saved address predates RES1 is still queued, and the address is kept unchanged", async () => {
  const database = createDatabase();
  const legacy = {
    id: 7, patient_code: "PAT-0007", first_name: "Maria", middle_initial: null, last_name: "Legacy", full_name: "Maria Legacy",
    search_name: "maria legacy", birthdate: "1980-02-03", sex: "Female", mobile_number: null,
    residency: "Libertad, Butuan City, Agusan del Norte, Caraga, 8600, Philippines", philhealth_id: null,
    created_by: "frontdesk", created_at: "2026-10-01T00:00:00.000Z"
  };
  database.patient_records = [clone(legacy)];
  const h = createHarness({ database });

  const read = await h.request("GET", "/patient-records/:id", {}, undefined, {}, { id: "7" });
  assert.equal(read.status, 200);
  assert.equal(read.body.patient.residency, legacy.residency, "the stored address is returned as saved");

  const response = await h.request("POST", "/patient-records/visits", {
    patientRecordId: 7, serviceType: "checkup", vulnerabilityFlags: [], residency: "Purok 1, Brgy. Bayabas, Cabadbaran City, Agusan del Norte"
  });
  assert.equal(response.status, 200, response.body.message);
  assert.deepEqual(clone(h.database.patient_records), [legacy], "the record is not rewritten");
  assert.equal(h.database.patients[0].residency, legacy.residency, "the visit carries the saved address");
  assert.equal(h.database.patients[0].status, "waiting");
});

test("the residency chart groups RES1 addresses by barangay and keeps older addresses as written", async () => {
  const h = createHarness({ clock: { now: Date.parse("2026-11-14T04:00:00.000Z") } });
  for (const value of [
    "Purok 1, Brgy. Bayabas, Cabadbaran City, Agusan del Norte",
    "Purok 9, Bayabas, Cabadbaran City, Agusan del Norte",
    "Brgy. La Union, Cabadbaran City, Agusan del Norte",
    "Sumile",
    null
  ]) {
    const visit = await h.service.createQueueEntry({ idNum: "Synthetic", serviceType: "checkup", vulnerabilityFlags: [] });
    h.database.patients.find((row) => row.id === visit.id).residency = value;
  }
  const { charts } = await h.service.getAnalytics("2026-11-14", "2026-11-14");
  assert.deepEqual(clone(charts.residency), { labels: ["Bayabas", "La Union", "Sumile", "Not recorded"], data: [2, 1, 1, 1] });
});
