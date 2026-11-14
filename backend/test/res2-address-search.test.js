// RES2: Google Places address search for the Residency bar, and the structured residency columns
// of patient_records. Google is replaced by a fake fetch; no request leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");
const search = require("../src/services/addressSearchService");

const SECRET = "res2-test-secret-not-a-real-one-0123456789";
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY = "test-places-key";

const component = (longText, types, shortText = longText) => ({ longText, shortText, types, languageCode: "en" });
const cabadbaranPlace = (extra = [], id = "ChIJcabadbaranPlace01") => ({
  id,
  formattedAddress: "Rizal St, Cabadbaran City, Agusan del Norte, Philippines",
  types: ["route"],
  addressComponents: [
    ...extra,
    component("Cabadbaran City", ["locality", "political"]),
    component("Agusan del Norte", ["administrative_area_level_2", "political"]),
    component("Caraga", ["administrative_area_level_1", "political"]),
    component("Philippines", ["country", "political"], "PH")
  ]
});

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, json = {} } = (await handler(url, init)) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetchImpl, calls };
}

test("autocomplete sends one restricted request with the key in a header and keeps only Cabadbaran suggestions", async () => {
  const google = fakeFetch(() => ({ json: { suggestions: [
    { placePrediction: { placeId: "ChIJcalibunan0001", text: { text: "Calibunan, Cabadbaran City, Agusan del Norte, Philippines" },
      structuredFormat: { mainText: { text: "Calibunan" }, secondaryText: { text: "Cabadbaran City, Agusan del Norte, Philippines" } } } },
    { placePrediction: { placeId: "ChIJbutuan0000001", text: { text: "Libertad, Butuan City, Agusan del Norte, Philippines" },
      structuredFormat: { mainText: { text: "Libertad" }, secondaryText: { text: "Butuan City" } } } },
    { queryPrediction: { text: { text: "calibunan cabadbaran" } } },
    { placePrediction: { placeId: "bad id with spaces", text: { text: "Mabini, Cabadbaran City" } } }
  ] } }));
  const suggestions = await search.autocompleteAddresses({ query: "  calibunan  ", sessionToken: SESSION, apiKey: KEY, fetchImpl: google.fetchImpl });
  assert.deepEqual(suggestions, [{
    placeId: "ChIJcalibunan0001", mainText: "Calibunan", secondaryText: "Cabadbaran City, Agusan del Norte, Philippines",
    text: "Calibunan, Cabadbaran City, Agusan del Norte, Philippines"
  }]);
  assert.equal(google.calls.length, 1);
  const [call] = google.calls;
  assert.equal(call.url, "https://places.googleapis.com/v1/places:autocomplete");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["X-Goog-Api-Key"], KEY);
  assert.doesNotMatch(call.url, /key=/, "the key is never put in a URL");
  assert.deepEqual(call.body, {
    input: "calibunan", sessionToken: SESSION, includedRegionCodes: ["ph"], languageCode: "en",
    locationRestriction: { circle: { center: { latitude: 9.1232854, longitude: 125.5322317 }, radius: 20000 } }
  });
});

test("autocomplete refuses short, long or session-less searches before calling Google", async () => {
  const google = fakeFetch(() => ({ json: {} }));
  for (const [query, session, message] of [["ab", SESSION, /at least 3/], ["x".repeat(101), SESSION, /at most 100/],
    ["Calibunan", "", /session/], ["Calibunan", "has spaces in it", /session/], ["Calibunan", "x".repeat(37), /session/]]) {
    await assert.rejects(search.autocompleteAddresses({ query, sessionToken: session, apiKey: KEY, fetchImpl: google.fetchImpl }),
      (error) => error.statusCode === 400 && message.test(error.message));
  }
  assert.equal(google.calls.length, 0);
});

test("a Google outage or network failure is reported as unavailable, and the query is never logged", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  for (const fetchImpl of [fakeFetch(() => ({ status: 503, json: { error: { message: "secret query purok 9 echoed" } } })).fetchImpl,
    async () => { throw new TypeError("fetch failed"); }]) {
    await assert.rejects(search.autocompleteAddresses({ query: "Purok 9 Calibunan", sessionToken: SESSION, apiKey: KEY, fetchImpl }),
      (error) => error.statusCode === 502 && /Map search is unavailable/.test(error.message));
  }
  assert.ok(warnings.every((line) => !/purok|calibunan|secret/i.test(line)), warnings.join("\n"));
});

test("a chosen place is accepted only inside Cabadbaran City, Agusan del Norte, Philippines", () => {
  const read = (components) => search.readPlaceAddress({ id: "ChIJsomePlace0001", formattedAddress: "x", addressComponents: components });
  const city = component("Cabadbaran City", ["locality"]);
  const province = component("Agusan del Norte", ["administrative_area_level_2"]);
  const country = component("Philippines", ["country"], "PH");
  assert.ok(read([city, province, country]));
  assert.ok(read([component("Cabadbaran", ["locality"]), province, country]), "Google may omit 'City'");
  assert.equal(read([component("Butuan City", ["locality"]), province, country]), null, "another city in the same province");
  assert.equal(read([city, component("Agusan del Sur", ["administrative_area_level_2"]), country]), null);
  assert.equal(read([city, province]), null, "no country");
  assert.equal(read([province, country]), null, "no city");
  assert.equal(read([component("Cabadbaran City", ["route"]), province, country]), null, "a road named after the city is not the city");
  assert.equal(search.readPlaceAddress(null), null);
});

test("the barangay comes only from Google's components and only when it is an official barangay; the detail only from street parts", () => {
  const place = (extra) => search.readPlaceAddress(cabadbaranPlace(extra));
  assert.deepEqual(place([component("12", ["street_number"]), component("Rizal St", ["route"]), component("Poblacion 3", ["sublocality_level_1", "sublocality"])]),
    { placeId: "ChIJcabadbaranPlace01", barangay: "Poblacion 3", detail: "12 Rizal St", formattedAddress: "Rizal St, Cabadbaran City, Agusan del Norte, Philippines" });
  assert.equal(place([component("La Union", ["neighborhood"])]).barangay, "La Union");
  assert.equal(place([component("Sumile", ["sublocality_level_1"])]).barangay, null, "not an official barangay: the Front Desk chooses");
  assert.equal(place([component("Mabini", ["route"])]).barangay, null, "a street named Mabini is not barangay Mabini");
  assert.equal(place([]).detail, "");
  assert.equal(place([component("Cabadbaran-Butuan Rd", ["route"])]).detail, "Cabadbaran-Butuan Rd");
  assert.equal(place([component("x".repeat(46), ["route"])]).detail, "", "a detail too long to save is left to the Front Desk");
  assert.equal(place([component("Butuan City", ["route"])]).detail, "", "a detail naming another city is not used");
});

test("Place Details asks only for Essentials fields with the session token, and signs what it accepted", async () => {
  const google = fakeFetch(() => ({ json: cabadbaranPlace([component("Rizal St", ["route"]), component("Bayabas", ["sublocality_level_1"])]) }));
  const address = await search.resolvePlaceAddress({ placeId: "ChIJcabadbaranPlace01", sessionToken: SESSION, apiKey: KEY, secret: SECRET, fetchImpl: google.fetchImpl });
  const [call] = google.calls;
  assert.equal(call.url, `https://places.googleapis.com/v1/places/ChIJcabadbaranPlace01?sessionToken=${SESSION}&languageCode=en`);
  assert.equal(call.init.headers["X-Goog-FieldMask"], "id,formattedAddress,addressComponents,types");
  assert.equal(call.init.headers["X-Goog-Api-Key"], KEY);
  assert.equal(address.barangay, "Bayabas");
  assert.equal(address.detail, "Rizal St");
  assert.deepEqual(search.verifyPlaceToken(address.token, SECRET), { placeId: "ChIJcabadbaranPlace01", barangay: "Bayabas", detail: "Rizal St" });
});

test("a place outside the city, a missing place or a malformed ID is refused", async () => {
  const butuan = fakeFetch(() => ({ json: { id: "ChIJbutuan0000001", addressComponents: [component("Butuan City", ["locality"]),
    component("Agusan del Norte", ["administrative_area_level_2"]), component("Philippines", ["country"], "PH")] } }));
  await assert.rejects(search.resolvePlaceAddress({ placeId: "ChIJbutuan0000001", sessionToken: SESSION, apiKey: KEY, secret: SECRET, fetchImpl: butuan.fetchImpl }),
    (error) => error.statusCode === 422 && /not in Cabadbaran City/.test(error.message));
  const missing = fakeFetch(() => ({ status: 404, json: {} }));
  await assert.rejects(search.resolvePlaceAddress({ placeId: "ChIJgone00000001", sessionToken: SESSION, apiKey: KEY, secret: SECRET, fetchImpl: missing.fetchImpl }),
    (error) => error.statusCode === 404);
  await assert.rejects(search.resolvePlaceAddress({ placeId: "../../etc", sessionToken: SESSION, apiKey: KEY, secret: SECRET, fetchImpl: missing.fetchImpl }),
    (error) => error.statusCode === 400);
});

test("a place token is accepted only as this server signed it, unexpired and for addresses", () => {
  const good = search.signPlace({ placeId: "ChIJcabadbaranPlace01", barangay: "Tolosa", detail: "Purok 2" }, SECRET);
  assert.deepEqual(search.verifyPlaceToken(good, SECRET), { placeId: "ChIJcabadbaranPlace01", barangay: "Tolosa", detail: "Purok 2" });
  assert.equal(search.verifyPlaceToken(good, "another-secret-entirely-0123456789"), null);
  assert.equal(search.verifyPlaceToken(`${good.slice(0, -2)}xx`, SECRET), null);
  assert.equal(search.verifyPlaceToken(jwt.sign({ pid: "ChIJcabadbaranPlace01", b: "Tolosa", d: "" }, SECRET, { audience: "login" }), SECRET), null);
  assert.equal(search.verifyPlaceToken(jwt.sign({ pid: "ChIJcabadbaranPlace01", b: "Tolosa", d: "", exp: 1 }, SECRET, { audience: "residency-place" }), SECRET), null);
  assert.equal(search.verifyPlaceToken(jwt.sign({ pid: "ChIJcabadbaranPlace01", b: "Libertad", d: "" }, SECRET, { audience: "residency-place" }), SECRET), null);
  for (const value of [undefined, null, "", 42, {}]) assert.equal(search.verifyPlaceToken(value, SECRET), null);
});

// Routes and registration, through the queue harness.
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const DOCTOR = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };

function withRecords(env = {}) {
  const database = createDatabase();
  database.patient_records = [];
  return createHarness({ database, env: { jwtSecret: SECRET, ...env } });
}

test("without GOOGLE_MAPS_API_KEY the search reports itself unavailable and never calls Google", async (t) => {
  const fetchSpy = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not be called"); });
  const h = withRecords();
  const response = await h.request("GET", "/address-search", {}, FRONTDESK, { q: "Calibunan", session: SESSION });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, available: false, suggestions: [] });
  assert.equal(response.headers["Cache-Control"], "no-store");
  const place = await h.request("GET", "/address-search/place", {}, FRONTDESK, { id: "ChIJcabadbaranPlace01", session: SESSION });
  assert.equal(place.status, 503);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test("only Front Desk and Super Admin may search the map, which is billed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ suggestions: [] }) }));
  const h = withRecords({ googleMapsApiKey: KEY });
  assert.equal((await h.request("GET", "/address-search", {}, DOCTOR, { q: "Calibunan", session: SESSION })).status, 403);
  assert.equal((await h.request("GET", "/address-search", {}, null, { q: "Calibunan", session: SESSION })).status, 401);
  const allowed = await h.request("GET", "/address-search", {}, FRONTDESK, { q: "Calibunan", session: SESSION });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.available, true);
  assert.equal((await h.request("GET", "/address-search", {}, { id_num: "superadmin", role: "superadmin", doctor_name: null }, { q: "Calibunan", session: SESSION })).status, 200);
});

const newPatient = (extra = {}) => ({
  firstName: "Rosa", lastName: "Synthetic", sex: "Female", birthdate: "1985-06-07", serviceType: "checkup", vulnerabilityFlags: [], ...extra
});
const token = (barangay, detail, placeId = "ChIJcabadbaranPlace01") => search.signPlace({ placeId, barangay, detail }, SECRET);

test("a new record keeps its structured address; 'map' only when Google gave both the barangay and the detail saved", async () => {
  const cases = [
    ["typed or chosen from the barangay list", { residency: "Purok 3, Brgy. Tolosa, Cabadbaran City, Agusan del Norte" },
      { residency_barangay: "Tolosa", residency_detail: "Purok 3", residency_source: "manual", residency_place_id: null }],
    ["map: barangay and detail from Google", { residency: "Rizal St, Brgy. Tolosa, Cabadbaran City, Agusan del Norte", residencyPlaceToken: token("Tolosa", "Rizal St") },
      { residency_barangay: "Tolosa", residency_detail: "Rizal St", residency_source: "map", residency_place_id: "ChIJcabadbaranPlace01" }],
    ["map: barangay only", { residency: "Brgy. Tolosa, Cabadbaran City, Agusan del Norte", residencyPlaceToken: token("Tolosa", "") },
      { residency_barangay: "Tolosa", residency_detail: null, residency_source: "map", residency_place_id: "ChIJcabadbaranPlace01" }],
    ["map place, Front Desk added the purok", { residency: "Purok 5, Brgy. Tolosa, Cabadbaran City, Agusan del Norte", residencyPlaceToken: token("Tolosa", "") },
      { residency_barangay: "Tolosa", residency_detail: "Purok 5", residency_source: "manual", residency_place_id: "ChIJcabadbaranPlace01" }],
    ["map place without a barangay, Front Desk chose it", { residency: "Rizal St, Brgy. Sanghan, Cabadbaran City, Agusan del Norte", residencyPlaceToken: token(null, "Rizal St") },
      { residency_barangay: "Sanghan", residency_detail: "Rizal St", residency_source: "manual", residency_place_id: "ChIJcabadbaranPlace01" }],
    ["barangay changed away from the map's", { residency: "Rizal St, Brgy. Sanghan, Cabadbaran City, Agusan del Norte", residencyPlaceToken: token("Tolosa", "Rizal St") },
      { residency_barangay: "Sanghan", residency_detail: "Rizal St", residency_source: "manual", residency_place_id: null }],
    ["forged token", { residency: "Rizal St, Brgy. Tolosa, Cabadbaran City, Agusan del Norte",
      residencyPlaceToken: search.signPlace({ placeId: "ChIJforged000001", barangay: "Tolosa", detail: "Rizal St" }, "attacker-secret-0123456789abcdef") },
      { residency_barangay: "Tolosa", residency_detail: "Rizal St", residency_source: "manual", residency_place_id: null }]
  ];
  for (const [label, address, expected] of cases) {
    const h = withRecords();
    const response = await h.request("POST", "/patient-records/visits", newPatient(address), FRONTDESK);
    assert.equal(response.status, 200, `${label}: ${response.body.message}`);
    const [record] = h.database.patient_records;
    const stored = Object.fromEntries(Object.keys(expected).map((key) => [key, record[key]]));
    assert.deepEqual(stored, expected, label);
    assert.equal(record.residency, h.database.patients[0].residency, `${label}: the visit keeps the same readable address`);
    assert.equal(Object.keys(h.database.patients[0]).some((key) => /^residency_/.test(key)), false, `${label}: visits get no new columns`);
  }
});

test("a token never makes an out-of-area address acceptable", async () => {
  const h = withRecords();
  const response = await h.request("POST", "/patient-records/visits",
    newPatient({ residency: "Rizal St, Brgy. Libertad, Butuan City, Agusan del Norte", residencyPlaceToken: token("Tolosa", "Rizal St") }), FRONTDESK);
  assert.equal(response.status, 400);
  assert.match(response.body.message, /valid address within Cabadbaran City/);
  assert.equal(h.database.patient_records.length, 0);
});

// (The warning naming the migration goes to the service's console, which the harness silences.)
test("before the RES2 columns are installed, the record is still saved and linked, without them", async () => {
  const h = withRecords();
  h.database.beforeQuery = (query) => (query.table === "patient_records" && query.action === "insert" && Object.hasOwn(query.payload, "residency_barangay")
    ? { data: null, error: { code: "PGRST204", message: "Could not find the 'residency_barangay' column of 'patient_records' in the schema cache" } }
    : null);
  const response = await h.request("POST", "/patient-records/visits",
    newPatient({ residency: "Purok 1, Brgy. Mahaba, Cabadbaran City, Agusan del Norte" }), FRONTDESK);
  assert.equal(response.status, 200, response.body.message);
  assert.equal(response.body.patient_record_created, true);
  const [record] = h.database.patient_records;
  assert.equal(record.residency, "Purok 1, Brgy. Mahaba, Cabadbaran City, Agusan del Norte");
  assert.equal(Object.hasOwn(record, "residency_barangay"), false);
  assert.equal(h.database.patients[0].patient_record_id, record.id, "the visit is still linked to its record");
});

test("a returning patient's record and address are never rewritten by a token", async () => {
  const database = createDatabase();
  const saved = { id: 3, patient_code: "PAT-0003", first_name: "Ana", middle_initial: null, last_name: "Kept", full_name: "Ana Kept",
    search_name: "ana kept", birthdate: "1970-01-01", sex: "Female", mobile_number: null, residency: "Old free text address", philhealth_id: null,
    created_by: "frontdesk", created_at: "2026-10-01T00:00:00.000Z" };
  database.patient_records = [clone(saved)];
  const h = createHarness({ database, env: { jwtSecret: SECRET } });
  const response = await h.request("POST", "/patient-records/visits",
    { patientRecordId: 3, serviceType: "checkup", vulnerabilityFlags: [], residencyPlaceToken: token("Tolosa", "Rizal St") }, FRONTDESK);
  assert.equal(response.status, 200, response.body.message);
  assert.deepEqual(clone(h.database.patient_records), [saved]);
  assert.equal(h.database.patients[0].residency, "Old free text address");
});
