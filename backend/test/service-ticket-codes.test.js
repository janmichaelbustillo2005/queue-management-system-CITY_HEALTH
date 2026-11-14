// Service-based ticket codes (2026-11-14): every service has its own ticket prefix and its own
// number sequence. Runs the real queueService on the isolated in-memory harness (service routing,
// both the fake Supabase client and the local fallback); round-robin registration, where the
// database assigns the number, is covered in rr1-round-robin-dispatch-postgres.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness } = require("./helpers/queueHarness");
const queueService = require("../src/services/queueService");

// City Health's table, verbatim. Mental Healthcare is MT.
const REQUIRED_PREFIXES = {
  medical_consultation: "MC", maternal_healthcare: "MH", family_planning: "FP", child_healthcare: "CH",
  dental_healthcare: "DH", nutrition: "NT", diagnostic_imaging: "DI", womens_health: "WH",
  mental_healthcare: "MT", medical_documentation: "MD", marriage_preparation: "MP",
  environmental_health: "EH", food_safety: "FS"
};

const register = (h, name, serviceType) => h.service.createQueueEntry({ idNum: name, serviceType, vulnerabilityFlags: [] });

test("the 13 offered services carry exactly the required prefixes; former services keep theirs", () => {
  const { SERVICE_CODE_MAP, OFFERED_SERVICES, FORMER_SERVICES } = queueService;
  assert.deepEqual(Object.fromEntries(OFFERED_SERVICES.map((s) => [s, SERVICE_CODE_MAP[s]])), REQUIRED_PREFIXES);
  assert.equal(new Set(OFFERED_SERVICES.map((s) => SERVICE_CODE_MAP[s])).size, 13, "no two offered services share a prefix");
  assert.deepEqual(Object.fromEntries(FORMER_SERVICES.map((s) => [s, SERVICE_CODE_MAP[s]])),
    { consultation: "GP", checkup: "GP", prenatal: "OB", maternity: "OB" });
  assert.deepEqual(Object.keys(SERVICE_CODE_MAP).sort(), [...OFFERED_SERVICES, ...FORMER_SERVICES].sort(), "no other service is ticketed");
  assert.ok(Object.isFrozen(SERVICE_CODE_MAP));
});

test("the backend's services are the ones registration offers (frontend/lib/services.js)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "lib", "services.js"), "utf8");
  const offered = source.slice(source.indexOf("export const OFFERED_SERVICES"), source.indexOf("];", source.indexOf("export const OFFERED_SERVICES")));
  assert.deepEqual([...offered.matchAll(/value: "([a-z_]+)"/g)].map((m) => m[1]), queueService.OFFERED_SERVICES);
});

for (const localFallback of [false, true]) {
  const mode = localFallback ? "local fallback" : "database";
  test(`${mode}: every offered service starts its own sequence at PREFIX-001`, async () => {
    const h = createHarness({ localFallback });
    await h.initialize();
    for (const [service, prefix] of Object.entries(REQUIRED_PREFIXES)) {
      const visit = await register(h, `Patient ${service}`, service);
      assert.equal(visit.queue_number, `${prefix}-001`, service);
      assert.equal(visit.service_type, service);
    }
  });

  test(`${mode}: sequences are independent per service (City Health's worked example)`, async () => {
    const h = createHarness({ localFallback });
    await h.initialize();
    const steps = [["medical_consultation", "MC-001"], ["family_planning", "FP-001"], ["medical_consultation", "MC-002"],
      ["dental_healthcare", "DH-001"], ["family_planning", "FP-002"], ["mental_healthcare", "MT-001"], ["medical_consultation", "MC-003"]];
    for (const [i, [service, expected]] of steps.entries()) {
      assert.equal((await register(h, `Patient ${i + 1}`, service)).queue_number, expected, `patient ${i + 1}`);
    }
  });
}

test("numbers keep at least three digits and are never truncated after 999", async () => {
  const h = createHarness();
  h.database.patients.push({ id: 900, id_num: "Earlier", queue_number: "MC-999", service_type: "medical_consultation",
    status: "completed", priority_score: 1, vulnerability_flags: [], created_at: "2026-11-01T01:00:00.000Z" });
  assert.equal((await register(h, "One thousand", "medical_consultation")).queue_number, "MC-1000");
  assert.equal((await register(h, "One thousand and one", "medical_consultation")).queue_number, "MC-1001");
  assert.equal((await register(h, "Nutrition", "nutrition")).queue_number, "NT-001", "another service is not advanced");
});

test("historical tickets stay as issued; new codes continue after them and never reuse one", async () => {
  const h = createHarness();
  const history = [
    // Visits of new services that the old map issued under GP, and earlier FP / OB tickets.
    ["GP-106", "marriage_preparation"], ["GP-105", "medical_consultation"], ["FP-023", "family_planning"],
    ["OB-043", "maternity"], ["GP-1-001", "checkup"]
  ].map(([queue_number, service_type], i) => ({ id: 500 + i, id_num: `Historical ${i}`, queue_number, service_type,
    status: "completed", priority_score: 1, vulnerability_flags: [], created_at: "2026-11-01T01:00:00.000Z" }));
  h.database.patients.push(...structuredClone(history));
  assert.equal((await register(h, "New MC", "medical_consultation")).queue_number, "MC-001");
  assert.equal((await register(h, "New MP", "marriage_preparation")).queue_number, "MP-001");
  assert.equal((await register(h, "New FP", "family_planning")).queue_number, "FP-024", "Family Planning keeps its FP sequence");
  assert.equal((await register(h, "Former key", "prenatal")).queue_number, "OB-044", "former keys keep their prefix");
  assert.deepEqual(h.database.patients.filter((row) => row.id_num.startsWith("Historical")), history, "no historical row was renamed");
});

test("a service without a prefix gets no ticket and no visit, through every registration route", async () => {
  const h = createHarness();
  const invalid = ["vaccination", "pharmacy", "laboratory", "MC", "GP", "__proto__", "toString", "hasOwnProperty", "Medical consultation"];
  for (const serviceType of invalid) {
    await assert.rejects(register(h, "Invalid", serviceType), (error) => error.statusCode === 400 && /offered services/.test(error.message), serviceType);
    for (const [route, body] of [["/queue", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: "Invalid", service_type: serviceType }],
      ["/queue/website", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: "Invalid", serviceType }]]) {
      const response = await h.request("POST", route, body);
      assert.equal(response.status, 400, `${route} ${serviceType}`);
      assert.equal(response.body.success, false);
    }
  }
  assert.equal(h.database.patients.length, 0, "nothing was saved");
  assert.equal((await register(h, "Valid", "food_safety")).queue_number, "FS-001", "no number was consumed by a refused registration");
});

test("the registration response, the stored visit, the queue lists and a reprint all show the same ticket", async () => {
  const h = createHarness();
  const response = await h.request("POST", "/queue", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: "Marriage prep", service_type: "marriage_preparation" });
  assert.equal(response.status, 200, response.body?.message);
  assert.equal(response.body.queue_number, "MP-001");
  const stored = h.database.patients.find((row) => row.id_num === "Marriage prep");
  assert.equal(stored.queue_number, "MP-001");
  const overview = await h.request("GET", "/queue");
  assert.equal(overview.body.patients.find((row) => row.id === stored.id).queue_number, "MP-001");
  // Reading the queue again (a page refresh or a reprint) issues nothing new.
  await h.request("GET", "/queue");
  assert.equal(h.database.patients.length, 1);
  assert.equal(h.notifications.filter((n) => n.type === "created").length, 1);
  assert.equal(h.notifications.find((n) => n.type === "created").args[1], "MP-001", "the SMS carries the saved ticket");
});

test("the ticket survives Call, No-show, Re-queue, Start and Complete unchanged", async () => {
  const h = createHarness();
  const doctor = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };
  const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
  const visit = await register(h, "Lifecycle", "mental_healthcare");
  assert.equal(visit.queue_number, "MT-001");
  const ticketOf = async () => (await h.service.getPatientById(visit.id)).queue_number;
  const step = async (route, body, user) => {
    const response = await h.request("POST", route, { patient_id: visit.id, ...body }, user);
    assert.equal(response.status, 200, `${route}: ${response.body?.message}`);
    assert.equal(await ticketOf(), "MT-001", route);
  };
  await step("/queue/call", { counterId: "Doctor 1" }, superadmin);
  h.advance(11 * 60 * 1000);   // past the no-show wait
  await step("/queue/no-show", { counter_id: "Doctor 1" }, doctor);
  await step("/queue/requeue", {}, superadmin);
  await step("/queue/call", { counterId: "Doctor 1" }, superadmin);
  await step("/queue/accept", {}, doctor);
  await step("/queue/start", {}, doctor);
  h.advance();
  await step("/queue/complete", { counter_id: "Doctor 1" }, doctor);
  assert.equal(h.database.patients.filter((row) => row.service_type === "mental_healthcare").length, 1, "no second visit or ticket");
  assert.equal((await register(h, "Next", "mental_healthcare")).queue_number, "MT-002");
});
