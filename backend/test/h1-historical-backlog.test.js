// H1 Stage 1: Historical Waiting Backlog. The REAL routes, JWT middleware, presenceService,
// queueService and settingsService (pgBackendHarness) run against a fresh, synthetic, in-memory
// PGlite database in the development project's known state plus B.2, C1, F5 and W1.
// Never loads .env, dotenv or the Supabase client, and never touches real patient data.
// PGlite has ONE connection: "concurrent" requests here interleave at request boundaries only.
// Real lock contention is covered by h1-historical-backlog-concurrency.test.js (PostgreSQL 17).
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const bcrypt = require("bcryptjs");
const { liveKnownDatabase, readScript } = require("./helpers/liveKnownSchema");
const { createPgBackendHarness } = require("./helpers/pgBackendHarness");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to the installed package.";
}

const DEVELOPMENT_STATE = ["20261023-phase-b2-records.sql", "20261025-c1-atomic-call.sql",
  "20261022-f5-requeue-terminal-recovery.sql", "20261025-w1-atomic-cancel.sql"];
// Synthetic accounts that exist only in the disposable database.
const ACCOUNTS = {
  superadmin: ["superadmin", null], superadmin2: ["superadmin", null],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], frontdesk: ["admin", null]
};
const password = (idNum) => `synthetic-${idNum}-password`;
const DAY = 86400000;
const REASON = "Development test concluded — visit not served.";

// Synthetic visits, relative to the real server clock. `days` back from now.
const VISITS = [
  // ticket, service, status, days back, counter_id, called, started, completed
  ["HB-CLEAN", "consultation", "waiting", 3],
  ["HB-089", "prenatal", "waiting", 2, "Doctor 2", true],
  ["HB-STARTED", "family_planning", "waiting", 2, null, false, true],
  ["HB-POINTED", "checkup", "waiting", 4],
  ["HB-DONEAT", "maternity", "waiting", 6, null, false, false, true],
  ["TODAY-001", "consultation", "waiting", 0],
  ["OLD-CANCEL", "consultation", "cancelled", 3, "Doctor 1", false, false, true],
  ["OLD-SERVE", "family_planning", "serving", 3, "Doctor 3", true],
  ["OLD-DONE", "consultation", "completed", 3, "Doctor 1", true, true, true]
];

describe("H1 historical waiting backlog (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  let tokens;
  let ids;

  before(async () => {
    db = await liveKnownDatabase(PGlite);
    for (const script of DEVELOPMENT_STATE) await db.exec(readScript(script));
    // Supabase's service_role bypasses RLS; the tables have RLS enabled and no policies.
    await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
    const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
      `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
    await db.exec(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
      INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
        ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');`);
    const now = Date.now();
    ids = {};
    for (const [ticket, service, status, days, counter = null, called, started, completed] of VISITS) {
      const created = new Date(now - days * DAY);
      const at = (minutes) => new Date(created.getTime() + minutes * 60000).toISOString();
      const { rows: [row] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id,
          priority_score, vulnerability_flags, mobile_number, created_at, called_at, consultation_started_at, completed_at, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, '09170000000', $8, $9, $10, $11, $12) RETURNING id`,
        [`Synthetic ${ticket}`, ticket, service, status, counter, ticket === "HB-089" ? 3 : 1,
          JSON.stringify(ticket === "HB-089" ? ["pregnant"] : []), created.toISOString(),
          called ? at(5) : null, started ? at(6) : null, completed ? at(20) : null, completed && status !== "waiting" ? "Earlier reason" : null]);
      ids[ticket] = Number(row.id);
    }
    await db.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = 'Doctor 1'", [ids["HB-POINTED"]]);
    await db.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = 'Doctor 3'", [ids["OLD-SERVE"]]);
    h = backend();
    tokens = {};
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
    h.log.length = 0;
  });

  // A backend instance whose every database request is logged; `fail` may reject one.
  function backend({ fail } = {}) {
    const log = [];
    const pool = { query: (sql, values) => db.query(sql, values) };
    const harness = createPgBackendHarness(pool, {
      onRequest: async (request) => { log.push(request); if (fail?.(request)) throw new Error("synthetic transport failure"); }
    });
    harness.log = log;
    return harness;
  }
  const rows = async (table) => (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} r ORDER BY id`)).rows.map((row) => row.value);
  const snapshot = async () => ({ patients: await rows("patients"), counters: await rows("counters") });
  const patient = async (id) => (await db.query("SELECT row_to_json(p) AS value FROM public.patients p WHERE id = $1", [id])).rows[0].value;
  const list = (token, query = {}, harness = h) => harness.request("GET", "/queue/backlog", { token, query });
  const review = (token, id, harness = h) => harness.request("GET", "/queue/backlog/:id", { token, params: { id: String(id) } });
  const cancel = (token, id, body, harness = h) => harness.request("POST", "/queue/backlog/:id/cancel", { token, params: { id: String(id) }, body });
  const tickets = (response) => response.body.rows.map((row) => row.queue_number);
  const writes = (harness = h) => harness.log.filter((entry) => (entry.kind === "table" && entry.action !== "select") ||
    (entry.kind === "rpc" && entry.name !== "validate_staff_auth_session"));
  async function reviewed(id) {
    const response = await review(tokens.superadmin, id);
    assert.equal(response.status, 200, response.body?.message);
    return response.body.visit;
  }

  test("Superadmin sees only earlier-day Waiting visits, oldest first, with a database count", async () => {
    const response = await list(tokens.superadmin);
    assert.equal(response.status, 200, response.body?.message);
    // Registration time, then visit id (HB-089 and HB-STARTED share a registration time).
    assert.deepEqual(tickets(response), ["HB-DONEAT", "HB-POINTED", "HB-CLEAN", "HB-089", "HB-STARTED"]);
    assert.equal(response.body.total_backlog, 5);
    assert.equal(response.body.total, 5);
    assert.equal(response.body.requires_review, 4);
    assert.equal(response.body.truncated, false);
    assert.match(response.body.business_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(response.body.registered_before, new Date(Date.parse(`${response.body.business_date}T00:00:00+08:00`)).toISOString());
    // Only review fields leave the server: no mobile number or other personal data.
    for (const row of response.body.rows) {
      assert.equal(row.mobile_number, undefined);
      assert.equal(row.status, "waiting");
    }
  });

  test("Doctor, Frontdesk, unauthenticated and invalid tokens are refused on every backlog route", async () => {
    const id = ids["HB-CLEAN"];
    const { visit_state_revision: revision } = await patient(id);
    const before = await snapshot();
    for (const token of [tokens.admin1, tokens.admin2, tokens.frontdesk]) {
      assert.equal((await list(token)).status, 403);
      assert.equal((await review(token, id)).status, 403);
      const response = await cancel(token, id, { reason: REASON, expected_revision: revision });
      assert.equal(response.status, 403);
      assert.equal(response.body.message, "Unauthorized access");
    }
    assert.equal((await list(undefined)).status, 401);
    assert.equal((await cancel(undefined, id, { reason: REASON, expected_revision: revision })).status, 401);
    assert.equal((await list("not-a-token")).status, 403);
    assert.deepEqual(await snapshot(), before);
  });

  test("a role claim cannot be forged: a token re-signed as superadmin fails the persisted session check", async () => {
    const jwt = require("jsonwebtoken");
    const claims = jwt.decode(tokens.frontdesk);
    const forged = jwt.sign({ ...claims, role: "superadmin" }, h.SECRET, { algorithm: "HS256" });
    const response = await list(forged);
    assert.equal(response.status, 401);
  });

  test("the Manila calendar date decides eligibility, independent of the server timezone", async () => {
    const late = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, created_at)
      VALUES ('Synthetic boundary 1', 'EDGE-LATE', 'consultation', '2026-10-26T15:59:59.999Z'),
             ('Synthetic boundary 2', 'EDGE-MIDNIGHT', 'consultation', '2026-10-26T16:00:00.000Z') RETURNING id`);
    assert.equal(late.rows.length, 2);
    // 00:30 on 27 Oct in Manila (16:30 UTC on the 26th): 23:59:59.999 Manila is the previous day.
    let result = await h.queue.getHistoricalBacklog({ search: "EDGE" }, new Date("2026-10-26T16:30:00Z"));
    assert.equal(result.business_date, "2026-10-27");
    assert.equal(result.registered_before, "2026-10-26T16:00:00.000Z");
    assert.deepEqual(result.rows.map((row) => row.queue_number), ["EDGE-LATE"]);
    // 23:30 on 26 Oct in Manila: both are still today's (or future) registrations.
    result = await h.queue.getHistoricalBacklog({ search: "EDGE" }, new Date("2026-10-26T15:30:00Z"));
    assert.equal(result.business_date, "2026-10-26");
    assert.deepEqual(result.rows, []);
    // The next Manila day: both are historical.
    result = await h.queue.getHistoricalBacklog({ search: "EDGE" }, new Date("2026-10-27T16:00:00Z"));
    assert.deepEqual(result.rows.map((row) => row.queue_number), ["EDGE-LATE", "EDGE-MIDNIGHT"]);
  });

  test("search, registration date, service and doctor filters narrow the backlog server-side", async () => {
    assert.deepEqual(tickets(await list(tokens.superadmin, { search: "hb-08" })), ["HB-089"]);
    assert.deepEqual(tickets(await list(tokens.superadmin, { search: "today" })), []);
    const created = (await patient(ids["HB-CLEAN"])).created_at;
    const manilaDate = new Date(Date.parse(created) + 8 * 3600000).toISOString().slice(0, 10);
    assert.ok(tickets(await list(tokens.superadmin, { date: manilaDate })).includes("HB-CLEAN"));
    assert.ok(!tickets(await list(tokens.superadmin, { date: manilaDate })).includes("HB-POINTED"));
    assert.deepEqual(tickets(await list(tokens.superadmin, { service: "family_planning" })), ["HB-STARTED"]);
    // Doctor: the stored assignment, else the service routing (checkup and consultation -> Doctor 1).
    assert.deepEqual(new Set(tickets(await list(tokens.superadmin, { doctor: "Doctor 1" }))), new Set(["HB-CLEAN", "HB-POINTED"]));
    assert.deepEqual(new Set(tickets(await list(tokens.superadmin, { doctor: "Doctor 2" }))), new Set(["HB-089", "HB-DONEAT"]));
    const filtered = await list(tokens.superadmin, { doctor: "Doctor 2", service: "prenatal" });
    assert.deepEqual(tickets(filtered), ["HB-089"]);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.total_backlog, 5, "the header count is the whole backlog, not the filtered page");
    for (const query of [{ service: "dentistry" }, { doctor: "Doctor 9" }, { date: "2026-02-30" }, { page: "0" }, { limit: "101" }, { search: ["a", "b"] }]) {
      assert.equal((await list(tokens.superadmin, query)).status, 400, JSON.stringify(query));
    }
  });

  test("pagination returns stable pages with the server's total", async () => {
    const base = Date.now() - 5 * DAY;
    for (let index = 0; index < 23; index += 1) {
      await db.query("INSERT INTO public.patients (id_num, queue_number, service_type, created_at) VALUES ($1, $2, 'maternity', $3)",
        [`Synthetic page ${index}`, `PG-${String(index).padStart(3, "0")}`, new Date(base + index * 60000).toISOString()]);
    }
    const first = await list(tokens.superadmin, { search: "PG-", limit: "20", page: "1" });
    const second = await list(tokens.superadmin, { search: "PG-", limit: "20", page: "2" });
    assert.equal(first.body.total, 23);
    assert.equal(first.body.rows.length, 20);
    assert.deepEqual(tickets(second), ["PG-020", "PG-021", "PG-022"]);
    assert.equal(first.body.total_backlog, 28);
    assert.deepEqual((await list(tokens.superadmin, { search: "PG-", page: "9" })).body.rows, []);
  });

  test("the review panel reads the current stored visit with its history and flags", async () => {
    const visit = await reviewed(ids["HB-089"]);
    const stored = await patient(ids["HB-089"]);
    assert.equal(visit.queue_number, "HB-089");
    assert.equal(visit.service_type, "prenatal");
    assert.equal(visit.doctor, "Doctor 2");
    assert.equal(visit.doctor_source, "stored");
    assert.equal(visit.priority_score, 3);
    assert.deepEqual(visit.priority_categories, ["pregnant"]);
    assert.equal(Date.parse(visit.created_at), Date.parse(stored.created_at));
    assert.equal(Date.parse(visit.called_at), Date.parse(stored.called_at));
    assert.equal(visit.consultation_started_at, null);
    assert.equal(visit.completed_at, null);
    assert.equal(visit.visit_state_revision, stored.visit_state_revision);
    assert.equal(visit.eligible, true);
    assert.equal(visit.ineligible_reason, null);
    assert.equal(visit.mobile_number, undefined);

    const today = await reviewed(ids["TODAY-001"]);
    assert.equal(today.eligible, false);
    assert.match(today.ineligible_reason, /registered today/);
    const cancelled = await reviewed(ids["OLD-CANCEL"]);
    assert.equal(cancelled.eligible, false);
    assert.match(cancelled.ineligible_reason, /no longer waiting \(current status: cancelled\)/);
    assert.equal(cancelled.reason, "Earlier reason");
    assert.equal((await review(tokens.superadmin, 999999)).status, 404);
    assert.equal((await review(tokens.superadmin, "abc")).status, 400);
  });

  test("unusual historical states are flagged for review; a counter pointing at the visit blocks cancellation", async () => {
    const byTicket = Object.fromEntries((await list(tokens.superadmin)).body.rows.map((row) => [row.queue_number, row]));
    const codes = (ticket) => byTicket[ticket].flags.map((flag) => flag.code);
    assert.deepEqual(codes("HB-CLEAN"), []);
    assert.equal(byTicket["HB-CLEAN"].requires_review, false);
    assert.deepEqual(codes("HB-089"), ["previously_called", "stored_assignment"]);
    assert.equal(byTicket["HB-089"].requires_review, true);
    assert.equal(byTicket["HB-089"].cancel_blocked, null);
    assert.deepEqual(codes("HB-STARTED"), ["consultation_started"]);
    assert.deepEqual(codes("HB-DONEAT"), ["completion_recorded"]);
    assert.deepEqual(codes("HB-POINTED"), ["counter_conflict"]);
    assert.match(byTicket["HB-POINTED"].cancel_blocked, /Doctor 1 still lists this waiting visit/);
    // An assignment that names no counter is called out.
    await db.query("UPDATE public.patients SET counter_id = 'Retired Doctor' WHERE id = $1", [ids["HB-CLEAN"]]);
    const visit = await reviewed(ids["HB-CLEAN"]);
    assert.equal(visit.doctor_source, "unresolved");
    assert.match(visit.flags[0].detail, /matches no doctor counter/);
  });

  test("viewing and reviewing the backlog (Keep Waiting) changes nothing in the database", async () => {
    const before = await snapshot();
    await list(tokens.superadmin);
    await list(tokens.superadmin, { doctor: "Doctor 2", page: "1" });
    for (const id of Object.values(ids)) await review(tokens.superadmin, id);
    assert.deepEqual(writes(), []);
    assert.deepEqual(await snapshot(), before);
  });

  test("a reviewed visit is cancelled once through W1, keeping its history, priority, service and counters", async () => {
    const id = ids["HB-CLEAN"];
    const before = await patient(id);
    const counters = await rows("counters");
    const visit = await reviewed(id);
    const response = await cancel(tokens.superadmin, id, { reason: `  ${REASON}  `, expected_revision: visit.visit_state_revision });
    assert.equal(response.status, 200, response.body?.message);
    assert.equal(response.body.already_cancelled, undefined);
    assert.ok(h.log.some((entry) => entry.kind === "rpc" && entry.name === "cancel_patient_visit"), "cancelled through the W1 RPC");
    const after = await patient(id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.reason, REASON);
    assert.ok(after.completed_at);
    assert.notEqual(after.visit_state_revision, before.visit_state_revision);
    for (const key of ["id", "id_num", "queue_number", "service_type", "created_at", "called_at", "consultation_started_at",
      "counter_id", "priority_score", "vulnerability_flags", "mobile_number"]) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.deepEqual(await rows("counters"), counters, "no doctor counter changed");
    const remaining = await list(tokens.superadmin);
    assert.equal(remaining.body.total_backlog, 4);
    assert.ok(!tickets(remaining).includes("HB-CLEAN"));
    // Patient Records still show the visit and its full history.
    const { data, error } = await h.supabase.rpc("get_central_records",
      { p_category: "patients", p_filters: { visit: String(id) }, p_page: 1, p_limit: 20 });
    assert.equal(error, null);
    assert.equal(data.total, 1);
    assert.equal(data.rows[0].status, "cancelled");
    assert.equal(data.rows[0].queue_number, "HB-CLEAN");
    assert.equal(Date.parse(data.rows[0].created_at), Date.parse(before.created_at));
  });

  test("cancellation never adds to today's registrations", async () => {
    const todayBefore = (await db.query(`SELECT count(*)::int AS n FROM public.patients
      WHERE created_at >= $1`, [(await list(tokens.superadmin)).body.registered_before])).rows[0].n;
    const visit = await reviewed(ids["HB-CLEAN"]);
    await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision });
    const registeredBefore = (await list(tokens.superadmin)).body.registered_before;
    const todayAfter = (await db.query("SELECT count(*)::int AS n FROM public.patients WHERE created_at >= $1", [registeredBefore])).rows[0].n;
    assert.equal(todayAfter, todayBefore);
    assert.ok(Date.parse((await patient(visit.id)).created_at) < Date.parse(registeredBefore), "registration time is never moved to today");
  });

  test("a reason is required and limited, and a reviewed revision is required, before anything is written", async () => {
    const id = ids["HB-CLEAN"];
    const visit = await reviewed(id);
    const before = await snapshot();
    for (const [body, pattern] of [
      [{ expected_revision: visit.visit_state_revision }, /Reason for cancel is required/],
      [{ reason: "   ", expected_revision: visit.visit_state_revision }, /Reason for cancel is required/],
      [{ reason: "x".repeat(1001), expected_revision: visit.visit_state_revision }, /too long/],
      [{ reason: REASON }, /reviewed visit revision is required/],
      [{ reason: REASON, expected_revision: "not-a-uuid" }, /reviewed visit revision is required/]
    ]) {
      const response = await cancel(tokens.superadmin, id, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(response.body.message, pattern);
    }
    assert.deepEqual(writes(), []);
    assert.deepEqual(await snapshot(), before);
  });

  test("flagged visits need an explicit review acknowledgement; a counter conflict stays blocked", async () => {
    const flagged = await reviewed(ids["HB-089"]);
    const before = await snapshot();
    let response = await cancel(tokens.superadmin, flagged.id, { reason: REASON, expected_revision: flagged.visit_state_revision });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /requires review/);
    response = await cancel(tokens.superadmin, flagged.id, { reason: REASON, expected_revision: flagged.visit_state_revision, acknowledge_review: "yes" });
    assert.equal(response.status, 409, "only a literal true acknowledges");
    assert.deepEqual(await snapshot(), before);

    const pointed = await reviewed(ids["HB-POINTED"]);
    response = await cancel(tokens.superadmin, pointed.id, { reason: REASON, expected_revision: pointed.visit_state_revision, acknowledge_review: true });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Doctor 1 still lists this waiting visit.*Nothing was changed/);
    assert.deepEqual(await snapshot(), before);
    assert.ok(!h.log.some((entry) => entry.kind === "rpc" && entry.name === "cancel_patient_visit"));

    response = await cancel(tokens.superadmin, flagged.id, { reason: REASON, expected_revision: flagged.visit_state_revision, acknowledge_review: true });
    assert.equal(response.status, 200, response.body?.message);
    const after = await patient(flagged.id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.counter_id, "Doctor 2", "historical assignment kept");
    assert.equal(Date.parse(after.called_at), Date.parse(before.patients.find((row) => row.id === flagged.id).called_at));
    assert.deepEqual(await rows("counters"), before.counters);
  });

  test("a duplicate cancel is reported as already cancelled and writes nothing", async () => {
    const visit = await reviewed(ids["HB-CLEAN"]);
    const body = { reason: REASON, expected_revision: visit.visit_state_revision };
    assert.equal((await cancel(tokens.superadmin, visit.id, body)).status, 200);
    const once = await snapshot();
    h.log.length = 0;
    const repeat = await cancel(tokens.superadmin, visit.id, { ...body, reason: "A different reason" });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.already_cancelled, true);
    assert.deepEqual(writes(), []);
    assert.deepEqual(await snapshot(), once);
    assert.equal((await patient(visit.id)).reason, REASON);
  });

  test("two Superadmins cancelling the same reviewed visit: exactly one cancellation commits", async () => {
    const visit = await reviewed(ids["HB-CLEAN"]);
    const other = backend();
    const results = await Promise.all([
      cancel(tokens.superadmin, visit.id, { reason: "First Superadmin", expected_revision: visit.visit_state_revision }),
      cancel(tokens.superadmin2, visit.id, { reason: "Second Superadmin", expected_revision: visit.visit_state_revision }, other)
    ]);
    assert.ok(results.every((result) => result.status === 200 || result.status === 409), JSON.stringify(results));
    const committed = results.filter((result) => result.status === 200 && !result.body.already_cancelled);
    assert.equal(committed.length, 1);
    const after = await patient(visit.id);
    assert.equal(after.status, "cancelled");
    assert.ok(["First Superadmin", "Second Superadmin"].includes(after.reason));
  });

  test("a visit that changed after review is refused with nothing written", async () => {
    const visit = await reviewed(ids["HB-CLEAN"]);
    // Another action rotated the revision (any state change does).
    await db.query("UPDATE public.patients SET visit_state_revision = gen_random_uuid() WHERE id = $1", [visit.id]);
    let before = await snapshot();
    let response = await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /changed after it was reviewed/);
    assert.deepEqual(await snapshot(), before);
    response = await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: randomUUID() });
    assert.equal(response.status, 409);

    // The visit was completed (or called) elsewhere after review.
    const second = await reviewed(ids["HB-STARTED"]);
    await db.query("UPDATE public.patients SET status = 'completed', completed_at = now() WHERE id = $1", [second.id]);
    before = await snapshot();
    response = await cancel(tokens.superadmin, second.id, { reason: REASON, expected_revision: second.visit_state_revision, acknowledge_review: true });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /no longer waiting \(current status: completed\)/);
    assert.deepEqual(await snapshot(), before);

    // A today's visit is never cancellable from the backlog, even with its current revision.
    const today = await patient(ids["TODAY-001"]);
    response = await cancel(tokens.superadmin, today.id, { reason: REASON, expected_revision: today.visit_state_revision });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /registered today/);
    assert.equal((await patient(today.id)).status, "waiting");
  });

  test("the W1 RPC itself rejects a revision that changes between the backend's read and its commit", async () => {
    const visit = await reviewed(ids["HB-CLEAN"]);
    // Pause the backend just before the RPC and change the visit underneath it.
    const racing = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) }, {
      onRequest: async (request) => {
        if (request.kind === "rpc" && request.name === "cancel_patient_visit") {
          await db.query("UPDATE public.patients SET visit_state_revision = gen_random_uuid() WHERE id = $1", [visit.id]);
        }
      }
    });
    const response = await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision }, racing);
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Patient visit changed/);
    assert.equal((await patient(visit.id)).status, "waiting");
  });

  test("backend and database failures report an error and never claim or create a cancellation", async () => {
    const failingRead = backend({ fail: (request) => request.kind === "table" && request.table === "patients" });
    const read = await list(tokens.superadmin, {}, failingRead);
    assert.equal(read.status, 503);
    assert.match(read.body.message, /Historical backlog storage is unavailable/);

    const visit = await reviewed(ids["HB-CLEAN"]);
    const before = await snapshot();
    const lost = backend({ fail: (request) => request.kind === "rpc" && request.name === "cancel_patient_visit" });
    const response = await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision }, lost);
    assert.equal(response.status, 503);
    assert.match(response.body.message, /Could not confirm the cancellation/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(lost.settings.isAwaitingAccept(visit.id), false);
  });

  test("a revoked session or changed account is refused before any change", async () => {
    const visit = await reviewed(ids["HB-CLEAN"]);
    assert.equal((await h.request("POST", "/auth/logout", { token: tokens.superadmin })).status, 200);
    const before = await snapshot();
    assert.equal((await list(tokens.superadmin)).status, 401);
    const response = await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision });
    assert.equal(response.status, 401);
    // The second Superadmin is demoted: its token's role no longer matches the account.
    await db.query("UPDATE public.users SET role = 'admin' WHERE id_num = 'superadmin2'");
    assert.equal((await cancel(tokens.superadmin2, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision })).status, 401);
    await db.query("UPDATE public.users SET role = 'superadmin' WHERE id_num = 'superadmin2'");
    assert.deepEqual((await snapshot()).patients, before.patients);
    assert.deepEqual((await snapshot()).counters, before.counters);
  });

  test("without the W1 function a backlog cancel is refused and never falls back to a direct patient update", async () => {
    const bare = await liveKnownDatabase(PGlite);
    try {
      for (const script of DEVELOPMENT_STATE.filter((name) => !name.includes("w1-"))) await bare.exec(readScript(script));
      await bare.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
      await bare.exec(`INSERT INTO public.users (id_num, password, role) VALUES ('superadmin', '${bcrypt.hashSync(password("superadmin"), 4)}', 'superadmin');
        INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation"]');
        INSERT INTO public.patients (id_num, queue_number, service_type, created_at) VALUES ('Synthetic bare', 'HB-BARE', 'consultation', now() - interval '3 days');`);
      const log = [];
      const harness = createPgBackendHarness({ query: (sql, values) => bare.query(sql, values) }, { onRequest: (request) => { log.push(request); } });
      const token = (await harness.login("superadmin", password("superadmin"))).token;
      const id = Number((await bare.query("SELECT id FROM public.patients")).rows[0].id);
      const visit = (await review(token, id, harness)).body.visit;
      const response = await cancel(token, id, { reason: REASON, expected_revision: visit.visit_state_revision }, harness);
      assert.equal(response.status, 503);
      assert.match(response.body.message, /needs the W1 database function.*Nothing was changed/);
      assert.equal(log.filter((entry) => entry.kind === "table" && entry.table === "patients" && entry.action !== "select").length, 0);
      assert.equal((await bare.query("SELECT status::text FROM public.patients WHERE id = $1", [id])).rows[0].status, "waiting");
    } finally {
      await bare.close();
    }
  });

  test("a backlog cancel sends no SMS, queues no announcement and creates no acceptance state", async () => {
    // Another patient's acceptance state must be untouched.
    h.settings.markAwaitingAccept(ids["OLD-SERVE"]);
    const events = h.settings.getVoiceAnnouncementEvents().length;
    const visit = await reviewed(ids["HB-CLEAN"]);
    assert.equal((await cancel(tokens.superadmin, visit.id, { reason: REASON, expected_revision: visit.visit_state_revision })).status, 200);
    assert.deepEqual(h.sms, []);
    assert.equal(h.settings.getVoiceAnnouncementEvents().length, events);
    assert.equal(h.settings.isAwaitingAccept(visit.id), false);
    assert.equal(h.settings.isAwaitingAccept(ids["OLD-SERVE"]), true);
    assert.equal((await patient(ids["OLD-SERVE"])).status, "serving");
    assert.equal((await rows("counters")).find((row) => row.id_num === "Doctor 3").current_patient_id, ids["OLD-SERVE"]);
  });
});
