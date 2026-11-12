// WPS-A (10-minute Aging) with RR1 round-robin dispatch and FC1 Front Desk confirmation. The REAL
// routes, JWT middleware, presenceService, queueService and settingsService (pgBackendHarness)
// run with DOCTOR_DISPATCH_MODE=round_robin and WPS_AGING on (or off, for comparison) against a
// fresh, synthetic, in-memory PGlite database: the development project's known state plus RR1 and
// FC1. Never loads .env or the Supabase client and never touches real data.
// The SQL scripts moved out of the repository in commit ffd845c; supply them with QMS_SCRIPTS_DIR
// (for example: git show <commit>^:backend/scripts/<name> for each, plus the current scripts).
const assert = require("node:assert/strict");
const { describe, test, before, beforeEach, after } = require("node:test");
const bcrypt = require("bcryptjs");
const { liveKnownDatabase, readScript } = require("./helpers/liveKnownSchema");
const { createPgBackendHarness } = require("./helpers/pgBackendHarness");
const { effectivePriority } = require("../src/lib/wpsPriority");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to the installed package.";
}

const SCRIPTS = ["20261109-rr1-round-robin-dispatch.sql", "20261111-fc1-front-desk-confirmation.sql"];
const ACCOUNTS = {
  superadmin: ["superadmin", null], frontdesk: ["admin", null],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const DOCTOR_ACCOUNT = { "Doctor 1": "admin1", "Doctor 2": "admin2", "Doctor 3": "admin3" };
const password = (idNum) => `synthetic-${idNum}-password`;

// Visits are backdated up to 30 minutes. Right after Manila midnight that would fall outside
// today's queue window, so those tests skip in the first 40 minutes of the Manila day.
const minutesIntoManilaDay = () => {
  const manila = new Date(Date.now() + 8 * 3600 * 1000);
  return manila.getUTCHours() * 60 + manila.getUTCMinutes();
};
const tooEarly = () => (minutesIntoManilaDay() < 40 ? "within 40 minutes of Manila midnight" : false);

async function freshDatabase() {
  const db = await liveKnownDatabase(PGlite);
  for (const script of SCRIPTS) await db.exec(readScript(script));
  await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  await db.exec(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  return db;
}

describe("WPS-A aging with round-robin dispatch (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let tokens;

  before(async () => { db = await freshDatabase(); });
  after(async () => { if (db) await db.close(); });

  const backend = (wpsAging) => createPgBackendHarness({ query: (sql, values) => db.query(sql, values) },
    { doctorDispatchMode: "round_robin", envOverrides: { wpsAging } });

  beforeEach(async () => {
    await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients; DELETE FROM public.counters;
      DELETE FROM public.staff_auth_sessions; DELETE FROM public.patient_assignment_history;
      UPDATE public.doctor_rotation_state SET last_doctor = NULL, last_patient_id = NULL, rotation_date = NULL;
      INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
        ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');`);
    tokens = {};
  });

  async function signIn(h, idNum) {
    tokens[idNum] = (await h.login(idNum, password(idNum))).token;
    return tokens[idNum];
  }
  // A synthetic waiting visit of today, assigned to `doctor`, registered `minutesAgo` minutes ago.
  async function visit(ticket, score, minutesAgo, { doctor = "Doctor 1", confirmed = true } = {}) {
    const { rows: [row] } = await db.query(`INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score,
        vulnerability_flags, counter_id, created_at, confirmed_at, confirmed_by)
      VALUES ($1, $2, 'medical_consultation', 'waiting', $3, '[]', $4, clock_timestamp() - ($5 * interval '1 minute'),
        CASE WHEN $6 THEN clock_timestamp() END, CASE WHEN $6 THEN 'frontdesk' END) RETURNING id`,
      [`Synthetic ${ticket}`, ticket, score, doctor, minutesAgo, confirmed]);
    return Number(row.id);
  }
  const ticketOf = async (id) => (await db.query("SELECT queue_number FROM public.patients WHERE id = $1", [id])).rows[0].queue_number;
  const as = (h, idNum) => ({
    call: (id) => h.request("POST", "/queue/call", { token: tokens[idNum], body: { patient_id: id } }),
    start: (id) => h.request("POST", "/queue/start", { token: tokens[idNum], body: { patient_id: id } }),
    complete: (id) => h.request("POST", "/queue/complete", { token: tokens[idNum], body: { patient_id: id } })
  });
  // The doctor serves its whole list: each time, only the head can be called (every other
  // candidate is refused first), then Start and Complete free the doctor for the next one.
  async function serveInOrder(h, ids) {
    const doctor = as(h, "admin1");
    const served = [];
    let remaining = ids.slice();
    while (remaining.length) {
      let head = null;
      for (const id of remaining) {
        const response = await doctor.call(id);
        if (response.status === 200) { head = id; break; }
        assert.match(response.body.message, /according to queue priority/, response.body.message);
      }
      assert.ok(head != null, "one waiting visit is callable");
      assert.equal((await doctor.start(head)).status, 200);
      assert.equal((await doctor.complete(head)).status, 200);
      served.push(await ticketOf(head));
      remaining = remaining.filter((id) => id !== head);
    }
    return served;
  }
  // Senior+PWD 0 min (7), Pregnant 20 min (3+2), Senior 2 min (4), PWD 0 min (3), Indigenous
  // 12 min (2+1), Regular 30 min (1+2), Regular 25 min (1+2), Regular 10.5 min (1+1), Solo Parent 5 min (1).
  async function mixedList() {
    return [
      await visit("GP-201", 1, 25), await visit("GP-202", 4, 2), await visit("GP-203", 3, 0),
      await visit("GP-204", 2, 12), await visit("GP-205", 1, 5), await visit("GP-206", 1, 10.5),
      await visit("GP-207", 3, 20), await visit("GP-208", 7, 0), await visit("GP-209", 1, 30)
    ];
  }

  test("the database formula: +1 per full 10 minutes, at most +2, nothing when off or not yet registered", async () => {
    await db.exec("RESET ROLE");   // qms_rr_effective_priority is closed to the API roles
    const cases = [
      [1, "10:00:00", "10:00:00", true, 1], [1, "10:00:00", "10:09:59.999", true, 1],
      [1, "10:00:00", "10:10:00", true, 2], [1, "10:00:00", "10:19:59.999", true, 2],
      [1, "10:00:00", "10:20:00", true, 3], [1, "10:00:00", "13:00:00", true, 3],
      [4, "10:00:00", "10:35:00", true, 6], [7, "10:00:00", "10:15:00", true, 8],
      [1, "10:00:00", "13:00:00", false, 1], [3, "10:05:00", "10:00:00", true, 3],
      // Both instants are cut to whole milliseconds first (date_trunc in SQL, Date.parse in Node):
      // .000900 -> .000 and .000100 -> .000 is exactly 10 minutes (+1); .001900 -> .001 and
      // .000900 -> .000 is 9:59.999 (+0), so both sides agree at the boundary.
      [2, "10:00:00.000900", "10:10:00.000100", true, 3], [2, "10:00:00.001900", "10:10:00.000900", true, 2]
    ];
    try {
      for (const [score, created, ranked, aging, expected] of cases) {
        const createdAt = `2026-11-13T${created}+08:00`;
        const rankedAt = `2026-11-13T${ranked}+08:00`;
        const { rows: [row] } = await db.query("SELECT public.qms_rr_effective_priority($1, $2::timestamptz, $3::timestamptz, $4) AS v",
          [score, createdAt, rankedAt, aging]);
        assert.equal(row.v, expected, `SQL ${score} registered ${created}, ranked ${ranked}, aging ${aging}`);
        assert.equal(effectivePriority({ priority_score: score, created_at: createdAt }, Date.parse(rankedAt), aging), expected,
          `backend ${score} registered ${created}, ranked ${ranked}, aging ${aging}`);
      }
    } finally {
      await db.exec("SET ROLE service_role");
    }
  });

  test("aging on: the doctor can only call its WPS-A head, and serves the list in WPS-A order", { skip: tooEarly() }, async () => {
    const h = backend(true);
    for (const idNum of ["frontdesk", "admin1", "admin2", "admin3"]) await signIn(h, idNum);
    const ids = await mixedList();
    // FIFO among equal aged score and base: GP-209 (30 min) before GP-201 (25 min).
    assert.deepEqual(await serveInOrder(h, ids),
      ["GP-208", "GP-207", "GP-202", "GP-203", "GP-204", "GP-209", "GP-201", "GP-206", "GP-205"]);
  });

  test("aging off: the same list is served in plain WPS order", { skip: tooEarly() }, async () => {
    const h = backend(false);
    for (const idNum of ["frontdesk", "admin1", "admin2", "admin3"]) await signIn(h, idNum);
    const ids = await mixedList();
    assert.deepEqual(await serveInOrder(h, ids),
      ["GP-208", "GP-202", "GP-207", "GP-203", "GP-204", "GP-209", "GP-201", "GP-206", "GP-205"]);
  });

  test("GET /queue reports aging and each waiting visit's aged rank; stored scores never change", { skip: tooEarly() }, async () => {
    const h = backend(true);
    await signIn(h, "frontdesk");
    await signIn(h, "admin1");
    const regular = await visit("GP-301", 1, 25);
    const indigenous = await visit("GP-302", 2, 12);
    const fresh = await visit("GP-303", 3, 0);
    const body = (await h.request("GET", "/queue", { token: tokens.frontdesk })).body;
    assert.deepEqual(body.wps, { aging: true });
    const rank = (id) => body.patients.find((row) => Number(row.id) === id);
    assert.deepEqual([regular, indigenous, fresh].map((id) => [rank(id).priority_score, rank(id).effective_priority]),
      [[1, 3], [2, 3], [3, 3]]);
    const { rows } = await db.query("SELECT priority_score FROM public.patients ORDER BY id");
    assert.deepEqual(rows.map((row) => row.priority_score), [1, 2, 3], "aging is computed at read time, never stored");
    const off = (await backend(false).request("GET", "/queue", { token: tokens.frontdesk })).body;
    assert.deepEqual(off.wps, { aging: false });
    assert.equal(off.patients.find((row) => Number(row.id) === regular).effective_priority, 1);
  });

  test("FC1 still gates the Call: an unconfirmed visit with the highest aged rank is skipped until confirmed", { skip: tooEarly() }, async () => {
    const h = backend(true);
    for (const idNum of ["frontdesk", "admin1"]) await signIn(h, idNum);
    const waitingLong = await visit("GP-401", 3, 25, { confirmed: false });   // aged 5, not confirmed
    const senior = await visit("GP-402", 4, 1);                                // 4, confirmed
    const doctor = as(h, "admin1");
    const refused = await doctor.call(waitingLong);
    assert.equal(refused.status, 409, refused.body.message);
    assert.match(refused.body.message, /not been confirmed by the Front Desk/);
    const confirm = await h.request("POST", "/queue/confirm", { token: tokens.frontdesk, body: { patient_id: waitingLong } });
    assert.equal(confirm.status, 200, confirm.body.message);
    // Confirmed now: its aging counted from registration, so it is the head immediately.
    const notHead = await doctor.call(senior);
    assert.match(notHead.body.message, /according to queue priority/);
    assert.equal((await doctor.call(waitingLong)).status, 200);
  });

  test("the dispatcher moves an unavailable doctor's waiting visits in WPS-A order", { skip: tooEarly() }, async () => {
    for (const [aging, expected] of [[true, ["GP-501", "GP-502"]], [false, ["GP-502", "GP-501"]]]) {
      await db.exec(`UPDATE public.counters SET current_patient_id = NULL; DELETE FROM public.patients;
        DELETE FROM public.staff_auth_sessions; DELETE FROM public.patient_assignment_history;`);
      const h = backend(aging);
      for (const idNum of ["admin1", "admin2", "admin3"]) await signIn(h, idNum);
      const regular = await visit("GP-501", 1, 25);    // aged 3
      const indigenous = await visit("GP-502", 2, 0);  // 2
      await db.query(`UPDATE public.doctor_rotation_state SET last_doctor = 'Doctor 1',
        rotation_date = (now() AT TIME ZONE 'Asia/Manila')::date`);
      // Doctor 1's heartbeat stops: its waiting visits go to Doctor 2, then Doctor 3, highest rank first.
      await db.query(`UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - interval '90 seconds'
        WHERE user_id_num = 'admin1'`);
      await h.queue.requestDispatch();
      const { rows } = await db.query(`SELECT p.queue_number, h.new_doctor FROM public.patient_assignment_history h
        JOIN public.patients p ON p.id = h.patient_id WHERE h.reason = 'round_robin_reassignment' ORDER BY h.id`);
      assert.deepEqual(rows.map((row) => row.queue_number), expected, `aging ${aging}`);
      assert.deepEqual(rows.map((row) => row.new_doctor), ["Doctor 2", "Doctor 3"], `aging ${aging}`);
      assert.ok([regular, indigenous].every(Number.isInteger));
    }
  });

  test("a double-clicked Call with aging on serves the head once", { skip: tooEarly() }, async () => {
    const h = backend(true);
    await signIn(h, "admin1");
    const head = await visit("GP-601", 1, 21);   // aged 3
    await visit("GP-602", 2, 0);
    const doctor = as(h, "admin1");
    const responses = await Promise.all([doctor.call(head), doctor.call(head)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    const { rows } = await db.query(`SELECT
      (SELECT count(*) FROM public.patients WHERE status = 'serving')::int AS serving,
      (SELECT count(*) FROM public.counters WHERE current_patient_id IS NOT NULL)::int AS held`);
    assert.deepEqual(rows[0], { serving: 1, held: 1 });
  });
});
