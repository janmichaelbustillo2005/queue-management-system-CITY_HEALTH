// PH1 Doctor Patient History: GET /doctor/patient-history and /doctor/patient-history/:id, and the
// cancelled / no-show attribution written after Cancel and No-show commit
// (backend/scripts/20261114-ph1-patient-history.sql). Routes and queueService run over the isolated
// in-memory database (helpers/queueHarness.js); the SQL itself is checked in the last tests.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness, createDatabase } = require("./helpers/queueHarness");

const DOCTOR = {
  1: { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" },
  2: { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" },
  3: { id_num: "admin3", role: "admin", doctor_name: "Doctor 3" }
};
const FRONTDESK = { id_num: "frontdesk", role: "admin", doctor_name: null };
const SUPERADMIN = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const HISTORY = "/doctor/patient-history";
const VISIT = "/doctor/patient-history/:id";

const BASE = Date.parse("2026-11-14T02:00:00.000Z"); // 10:00 Manila
const at = (minutes) => new Date(BASE + minutes * 60000).toISOString();
const day = (date, hour = 2) => `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;

let nextId = 1;
function visit(overrides = {}) {
  const id = nextId++;
  return {
    id, id_num: `Synthetic Patient ${id}`, queue_number: `MC-${String(id).padStart(3, "0")}`,
    service_type: "medical_consultation", status: "waiting", priority_score: 1, vulnerability_flags: [],
    created_at: at(-120), counter_id: null, called_at: null, consultation_started_at: null, completed_at: null,
    reason: null, confirmed_at: at(-118), confirmed_by: "frontdesk", visit_state_revision: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    mobile_number: "09170000000", birthdate: "1950-01-01", residency: "Poblacion 1", philhealth_id: "PH-SECRET",
    ...overrides
  };
}
const completed = (doctor, overrides = {}) => visit({
  status: "completed", counter_id: doctor, called_at: at(-100), consultation_started_at: at(-95), completed_at: at(-80), ...overrides
});

function setup({ attributionTable = true, patients = [] } = {}) {
  const database = createDatabase();
  if (attributionTable) database.patient_outcome_attribution = [];
  database.patients.push(...patients);
  const harness = createHarness({ database, clock: { now: BASE } });
  const get = (user, query = {}) => harness.request("GET", HISTORY, {}, user, query);
  const detail = (user, id) => harness.request("GET", VISIT, {}, user, {}, { id: String(id) });
  return { harness, database, get, detail };
}

test("each doctor sees only the visits it completed; other doctors' and active visits never appear", async () => {
  const mine = [completed("Doctor 1"), completed("Doctor 1", { created_at: at(-60), completed_at: at(-10) })];
  const others = [completed("Doctor 2"), completed("Doctor 3"), completed("Doctor 3")];
  const active = [visit({ counter_id: "Doctor 1" }), visit({ status: "serving", counter_id: "Doctor 1", called_at: at(-5) })];
  const { get } = setup({ patients: [...mine, ...others, ...active] });

  const one = await get(DOCTOR[1]);
  assert.equal(one.status, 200);
  assert.equal(one.headers["Cache-Control"], "no-store");
  assert.deepEqual(one.body.rows.map((row) => row.id), [mine[1].id, mine[0].id], "newest first, own visits only");
  assert.deepEqual(one.body.summary, { total_handled: 2, completed: 2, cancelled: 0, no_show: 0 });
  assert.equal(one.body.doctor, "Doctor 1");

  const two = await get(DOCTOR[2]);
  const three = await get(DOCTOR[3]);
  assert.deepEqual(two.body.rows.map((row) => row.id), [others[0].id]);
  assert.deepEqual(three.body.rows.map((row) => row.id).sort(), [others[1].id, others[2].id].sort());
  const seen = [one, two, three].flatMap((response) => response.body.rows.map((row) => row.id));
  assert.equal(new Set(seen).size, seen.length, "no visit appears in two doctors' history");
});

test("rows carry only the history fields: no mobile number, birthdate, residency or PhilHealth ID", async () => {
  const row = completed("Doctor 1", { vulnerability_flags: ["senior", "pwd"], priority_score: 7 });
  const { get } = setup({ patients: [row] });
  const [shown] = (await get(DOCTOR[1])).body.rows;
  assert.deepEqual(Object.keys(shown).sort(), ["called_at", "completed_at", "consultation_started_at", "created_at", "id",
    "outcome_at", "patient_name", "priority_categories", "priority_score", "queue_number", "service_type", "status", "visit_date"]);
  assert.deepEqual(shown.priority_categories, ["senior", "pwd"]);
  assert.equal(shown.queue_number, row.queue_number);
  assert.equal(shown.visit_date, "2026-11-14");
  const text = JSON.stringify(shown);
  for (const secret of ["09170000000", "1950-01-01", "Poblacion 1", "PH-SECRET"]) assert.ok(!text.includes(secret), secret);
});

test("a doctor's own Cancel and No-show are attributed to it; Front Desk and Superadmin cancellations never are", async () => {
  const byDoctor = visit({ counter_id: "Doctor 1" });
  const byFrontDesk = visit({ counter_id: "Doctor 1" });
  const bySuperadmin = visit({ counter_id: "Doctor 1" });
  const noShow = visit({ counter_id: "Doctor 1" });
  const { harness, database, get } = setup({ patients: [byDoctor, byFrontDesk, bySuperadmin, noShow] });

  assert.equal((await harness.request("POST", "/queue/cancel", { patient_id: byDoctor.id, reason: "Patient left" }, DOCTOR[1])).status, 200);
  harness.advance(1000);
  assert.equal((await harness.request("POST", "/queue/cancel", { patient_id: byFrontDesk.id, reason: "Duplicate" }, FRONTDESK)).status, 200);
  harness.advance(1000);
  assert.equal((await harness.request("POST", "/queue/cancel", { patient_id: bySuperadmin.id, reason: "Reset" }, SUPERADMIN)).status, 200);
  harness.advance(1000);
  assert.equal((await harness.request("POST", "/queue/no-show", { patient_id: noShow.id, reason: "Did not answer" }, DOCTOR[1])).status, 200);

  assert.deepEqual(database.patient_outcome_attribution.map((row) => [row.patient_id, row.outcome, row.actor_role, row.actor_id_num, row.actor_doctor]), [
    [byDoctor.id, "cancelled", "doctor", "admin1", "Doctor 1"],
    [byFrontDesk.id, "cancelled", "frontdesk", "frontdesk", null],
    [bySuperadmin.id, "cancelled", "superadmin", "superadmin", null],
    [noShow.id, "no-show", "doctor", "admin1", "Doctor 1"]
  ]);
  const stored = database.patients.find((row) => row.id === byDoctor.id);
  assert.equal(database.patient_outcome_attribution[0].outcome_at, stored.completed_at, "keyed to that exact outcome");

  const history = (await get(DOCTOR[1])).body;
  assert.deepEqual(history.rows.map((row) => [row.id, row.status]), [[noShow.id, "no-show"], [byDoctor.id, "cancelled"]]);
  assert.deepEqual(history.summary, { total_handled: 2, completed: 0, cancelled: 1, no_show: 1 });
  assert.equal(history.attribution_available, true);
  assert.deepEqual((await get(DOCTOR[2])).body.summary, { total_handled: 0, completed: 0, cancelled: 0, no_show: 0 });
});

test("Undo returns a visit to the queue and drops it from history; a later Front Desk cancel is not the doctor's", async () => {
  const row = visit({ counter_id: "Doctor 1" });
  const { harness, database, get } = setup({ patients: [row] });
  await harness.request("POST", "/queue/cancel", { patient_id: row.id, reason: "Patient left" }, DOCTOR[1]);
  assert.equal((await get(DOCTOR[1])).body.summary.cancelled, 1);

  harness.advance(60000);
  const undo = await harness.request("POST", "/queue/undo", { patient_id: row.id }, FRONTDESK);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(database.patients.find((p) => p.id === row.id).status, "waiting");
  assert.equal((await get(DOCTOR[1])).body.summary.total_handled, 0, "a temporary state is not a final outcome");

  harness.advance(60000);
  database.patients.find((p) => p.id === row.id).counter_id = "Doctor 1";
  assert.equal((await harness.request("POST", "/queue/cancel", { patient_id: row.id, reason: "Left again" }, FRONTDESK)).status, 200);
  assert.equal(database.patient_outcome_attribution.length, 2, "the old attribution is kept, not rewritten");
  assert.deepEqual((await get(DOCTOR[1])).body.summary, { total_handled: 0, completed: 0, cancelled: 0, no_show: 0 },
    "the doctor's earlier cancellation does not apply to the newer Front Desk cancellation");
});

test("only doctor accounts may read history, and only their own", async () => {
  const row = completed("Doctor 2");
  const { harness, get, detail } = setup({ patients: [row] });
  for (const user of [FRONTDESK, SUPERADMIN, { id_num: "staff", role: "admin", doctor_name: "Front Desk" }]) {
    const response = await get(user);
    assert.equal(response.status, 403);
    assert.equal(response.body.message, "Patient History is available to doctor accounts only.");
    assert.equal((await detail(user, row.id)).status, 403);
  }
  for (const query of [{ doctor: "Doctor 2" }, { doctor_id: "admin2" }, { counter_id: "2" }, { doctor_name: "doctor2" }, { account: "admin3" }]) {
    const response = await get(DOCTOR[1], query);
    assert.equal(response.status, 403, JSON.stringify(query));
    assert.equal(response.body.message, "You can only view your own patient history.");
  }
  assert.equal((await get(DOCTOR[1], { doctor: "Doctor 1", doctor_id: "admin1" })).status, 200, "naming oneself is harmless");
  // A token whose doctor claim disagrees with the persisted account is refused.
  const forged = await get({ ...DOCTOR[1], doctor_name: "Doctor 2" });
  assert.equal(forged.status, 403);
  assert.match(forged.body.message, /not assigned to this doctor/);
  assert.equal((await harness.request("GET", HISTORY, {}, null)).status, 401);
});

test("View Details returns one handled visit read-only; any other visit is the same 404", async () => {
  const mine = completed("Doctor 1", { created_at: at(-120), confirmed_at: at(-115), called_at: at(-100),
    consultation_started_at: at(-95), completed_at: at(-80), reason: "clinical note" });
  const theirs = completed("Doctor 2");
  const frontDeskCancel = visit({ counter_id: "Doctor 1" });
  const { harness, detail } = setup({ patients: [mine, theirs, frontDeskCancel] });
  await harness.request("POST", "/queue/cancel", { patient_id: frontDeskCancel.id, reason: "Duplicate" }, FRONTDESK);

  const response = await detail(DOCTOR[1], mine.id);
  assert.equal(response.status, 200);
  const shown = response.body.visit;
  assert.equal(shown.queue_number, mine.queue_number);
  assert.equal(shown.assigned_doctor, "Doctor 1");
  assert.equal(shown.confirmed_at, mine.confirmed_at);
  assert.equal(shown.reason, null, "a completion note is not part of history");
  assert.deepEqual(shown.timeline.map((event) => [event.type, event.at]), [
    ["registered", mine.created_at], ["confirmed", mine.confirmed_at], ["called", mine.called_at],
    ["consultation_started", mine.consultation_started_at], ["completed", mine.completed_at]
  ]);

  const notFound = [await detail(DOCTOR[1], theirs.id), await detail(DOCTOR[1], frontDeskCancel.id), await detail(DOCTOR[1], 999999)];
  for (const result of notFound) {
    assert.equal(result.status, 404);
    assert.equal(result.body.message, "This visit is not in your patient history.");
  }
  assert.equal((await detail(DOCTOR[1], "abc")).status, 400);
});

test("a doctor's cancellation detail names the doctor, the reason and only recorded events", async () => {
  const row = visit({ counter_id: "Doctor 1", confirmed_at: null, confirmed_by: null });
  const { harness, detail } = setup({ patients: [row] });
  await harness.request("POST", "/queue/cancel", { patient_id: row.id, reason: "Patient went home" }, DOCTOR[1]);
  const shown = (await detail(DOCTOR[1], row.id)).body.visit;
  assert.equal(shown.status, "cancelled");
  assert.equal(shown.reason, "Patient went home");
  assert.equal(shown.outcome_by.account, "admin1");
  assert.equal(shown.outcome_by.doctor, "Doctor 1");
  assert.equal(shown.called_at, null);
  assert.deepEqual(shown.timeline.map((event) => event.type), ["registered", "cancelled"],
    "no confirmation or call was recorded, so none is shown");
});

test("search, status, service and date filters combine; totals and pages come from the filtered rows", async () => {
  const rows = [
    completed("Doctor 1", { id_num: "Maria  Santos", service_type: "family_planning", created_at: day("2026-11-03") }),
    completed("Doctor 1", { id_num: "MARIA CLARA", service_type: "family_planning", created_at: day("2026-11-14") }),
    completed("Doctor 1", { id_num: "Maria Lopez", service_type: "dental_healthcare", created_at: day("2026-11-05") }),
    completed("Doctor 1", { id_num: "Juan Dela Cruz", service_type: "family_planning", created_at: day("2026-11-06"), queue_number: "FP-042" }),
    completed("Doctor 1", { id_num: "Maria Late", service_type: "family_planning", created_at: day("2026-11-15") }),
    completed("Doctor 2", { id_num: "Maria Other Doctor", service_type: "family_planning", created_at: day("2026-11-04") })
  ];
  const { get } = setup({ patients: rows });
  const ids = async (query) => (await get(DOCTOR[1], query)).body.rows.map((row) => row.id);

  assert.deepEqual((await ids({ search: "  maria " })).length, 4, "case-insensitive, trimmed, own visits only");
  assert.deepEqual(await ids({ search: "santos" }), [rows[0].id], "last name");
  assert.deepEqual(await ids({ search: "maria santos" }), [rows[0].id], "full name, repeated spaces ignored");
  assert.deepEqual(await ids({ search: "fp-042" }), [rows[3].id], "ticket number");
  assert.deepEqual(await ids({ search: "fp042" }), [rows[3].id], "ticket number without the dash");
  assert.deepEqual(await ids({ search: "maria", status: "completed", service: "family_planning", from: "2026-11-01", to: "2026-11-14" }),
    [rows[1].id, rows[0].id], "both boundary dates included; Doctor 2's Maria never appears");
  const none = (await get(DOCTOR[1], { search: "nobody" })).body;
  assert.deepEqual([none.total, none.rows.length, none.summary.total_handled], [0, 0, 5], "cards keep the whole history");

  for (const [query, message] of [
    [{ from: "2026-11-10", to: "2026-11-01" }, "From Date must not be later than To Date."],
    [{ status: "waiting" }, "Invalid status filter"], [{ service: "surgery" }, "Invalid service filter"],
    [{ from: "2026-13-01" }, "A valid calendar date is required"], [{ limit: "7" }, "Invalid page size"], [{ page: "0" }, "Invalid page"],
    [{ search: "x".repeat(101) }, "Invalid search parameter"]
  ]) {
    const response = await get(DOCTOR[1], query);
    assert.equal(response.status, 400, JSON.stringify(query));
    assert.match(response.body.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("pagination: 10, 20, 50 and View All; a page past the end shows the last page", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => completed("Doctor 1", { created_at: at(-1000 + index) }));
  const { get } = setup({ patients: rows });
  const page = async (query) => (await get(DOCTOR[1], query)).body;

  const first = await page({});
  assert.deepEqual([first.limit, first.page, first.page_count, first.total, first.rows.length], [10, 1, 3, 25, 10]);
  assert.equal(first.rows[0].id, rows[24].id, "most recent first");
  const third = await page({ page: "3" });
  assert.deepEqual([third.page, third.rows.length, third.rows.at(-1).id], [3, 5, rows[0].id]);
  assert.deepEqual([(await page({ limit: "20", page: "2" })).rows.length, (await page({ limit: "50" })).page_count], [5, 1]);
  const all = await page({ limit: "all", page: "4" });
  assert.deepEqual([all.limit, all.page, all.page_count, all.rows.length], ["all", 1, 1, 25]);
  const past = await page({ page: "9" });
  assert.deepEqual([past.page, past.rows.length], [3, 5]);
  const filtered = await page({ search: "Synthetic Patient", limit: "10", page: "2" });
  assert.equal(filtered.total, 25);
});

test("a doctor display name change keeps the same history and only changes the label", async () => {
  const rows = [completed("Doctor 1"), completed("Doctor 1")];
  const { database, get } = setup({ patients: rows });
  const before = (await get(DOCTOR[1])).body;
  database.users.find((user) => user.id_num === "admin1").display_name = "Dr. Reyes";
  const after = (await get(DOCTOR[1])).body;
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.summary, before.summary);
  assert.equal(after.doctor_display_name, "Dr. Reyes");
});

test("without the PH1 table: Cancel still works and history lists completed visits only", async () => {
  const done = completed("Doctor 1");
  const row = visit({ counter_id: "Doctor 1" });
  const { harness, database, get } = setup({ attributionTable: false, patients: [done, row] });
  const cancel = await harness.request("POST", "/queue/cancel", { patient_id: row.id, reason: "Patient left" }, DOCTOR[1]);
  assert.equal(cancel.status, 200);
  assert.equal(database.patients.find((p) => p.id === row.id).status, "cancelled");
  database.beforeQuery = (query) => query.table === "patient_outcome_attribution"
    ? { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.patient_outcome_attribution'" } } : null;
  const history = (await get(DOCTOR[1])).body;
  assert.equal(history.attribution_available, false);
  assert.deepEqual(history.summary, { total_handled: 1, completed: 1, cancelled: 0, no_show: 0 });
});

test("development memory: the doctor's own completion and cancellation appear in its history", async () => {
  const harness = createHarness({ localFallback: true, clock: { now: BASE } });
  await harness.initialize();
  const created = [];
  for (let i = 0; i < 2; i++) {
    const response = await harness.request("POST", "/queue", { residency: "Purok 1, Brgy. Poblacion 1, Cabadbaran City, Agusan del Norte", fullName: `Memory Patient ${i}`, service_type: "consultation" }, FRONTDESK);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { patients } = await harness.service.getQueueOverview();
    created.push(patients.find((row) => row.queue_number === response.body.queue_number)?.id);
  }
  const [first, second] = created;
  assert.ok(first && second, "visits were registered");
  assert.equal((await harness.request("POST", "/queue/cancel", { patient_id: second, reason: "Left" }, DOCTOR[1])).status, 200);
  harness.advance(1000);
  assert.equal((await harness.request("POST", "/queue/call", { patient_id: first, counterId: "Doctor 1" }, DOCTOR[1])).status, 200);
  harness.advance(1000);
  assert.equal((await harness.request("POST", "/queue/start", { patient_id: first }, DOCTOR[1])).status, 200);
  harness.advance(60000);
  assert.equal((await harness.request("POST", "/queue/complete", { patient_id: first }, DOCTOR[1])).status, 200);

  const history = (await harness.request("GET", HISTORY, {}, DOCTOR[1])).body;
  assert.deepEqual(history.summary, { total_handled: 2, completed: 1, cancelled: 1, no_show: 0 });
  assert.deepEqual((await harness.request("GET", HISTORY, {}, DOCTOR[2])).body.summary.total_handled, 0);
});

test("the PH1 migration is additive: one append-only table, no trigger, no change to patients or functions", () => {
  const dir = path.join(__dirname, "..", "scripts");
  const sql = fs.readFileSync(path.join(dir, "20261114-ph1-patient-history.sql"), "utf8").replace(/--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.patient_outcome_attribution/);
  assert.match(sql, /UNIQUE \(patient_id, outcome, outcome_at\)/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.patient_outcome_attribution TO service_role/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  for (const forbidden of [/ALTER TABLE public\.patients/i, /CREATE (OR REPLACE )?FUNCTION/i, /CREATE TRIGGER/i, /UPDATE public\./i, /DELETE FROM/i]) {
    assert.doesNotMatch(sql, forbidden);
  }
  for (const file of ["20261114-ph1-preflight.sql", "20261114-ph1-verify.sql", "20261114-ph1-rollback.sql"]) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  assert.match(fs.readFileSync(path.join(dir, "20261114-ph1-preflight.sql"), "utf8"), /BEGIN TRANSACTION READ ONLY/);
  assert.match(fs.readFileSync(path.join(dir, "20261114-ph1-verify.sql"), "utf8"), /BEGIN TRANSACTION READ ONLY/);
});
