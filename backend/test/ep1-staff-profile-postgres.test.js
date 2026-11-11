// EP1 Superadmin Edit Profile. The REAL routes, JWT middleware, presenceService and queueService
// (pgBackendHarness) against a fresh, synthetic, in-memory PGlite database in the development
// project's known state plus B.2, the cancellation-request table, AR1 and EP1. Never loads .env
// or the Supabase client and never touches real data.
const assert = require("node:assert/strict");
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

const AR1 = "20261110-ar1-staff-archive.sql";
const PREFLIGHT = "20261111-ep1-preflight.sql";
const EP1 = "20261111-ep1-staff-display-name.sql";
const ROLLBACK = "20261111-ep1-rollback.sql";
const ACCOUNTS = {
  superadmin: ["superadmin", null], superadmin2: ["superadmin", null], frontdesk: ["admin", "Front Desk"],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const password = (idNum) => `synthetic-${idNum}-password`;
const PROFILE = "/users/:id_num/profile";

async function freshDatabase({ withEp1 = true } = {}) {
  const db = await liveKnownDatabase(PGlite);
  for (const script of ["20261023-phase-b2-records.sql", "add-account-cancellation-requests.sql"]) await db.exec(readScript(script));
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  await db.exec(`INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
      ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');
    INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  await db.exec(readScript(AR1));
  if (withEp1) await db.exec(readScript(EP1));
  return db;
}

async function checks(db, script) {
  const results = await db.exec(readScript(script));
  return results.filter((result) => result.rows?.length && "passed" in result.rows[0]).at(-1).rows;
}

async function harness(db) {
  await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
  const h = createPgBackendHarness({ query: (sql, values) => db.query(sql, values) });
  const tokens = {};
  for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  const call = (method, route, { token = tokens.superadmin, id, body } = {}) =>
    h.request(method, route, { token, body, params: id ? { id_num: id, id } : {} });
  return { h, tokens, call };
}

const PROTECTED = "id_num, password, role, doctor_name, auth_revision, archived_at, archived_by";

describe("EP1 Edit Profile (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  let tokens;
  let call;

  before(async () => {
    db = await freshDatabase({ withEp1: false });
    const preflight = await checks(db, PREFLIGHT);
    assert.equal(preflight.length, 4);
    assert.deepEqual(preflight.filter((row) => !row.passed).map((row) => row.check_name), []);
    await db.exec(readScript(EP1));
    await db.exec(readScript(EP1)); // idempotent
  });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db.exec(`RESET ROLE; DELETE FROM public.staff_auth_sessions;
      UPDATE public.users SET archived_at = NULL, archived_by = NULL, display_name = NULL;`);
    ({ h, tokens, call } = await harness(db));
  });

  const snapshot = async () => (await db.query(`SELECT ${PROTECTED} FROM public.users ORDER BY id_num`)).rows;
  const row = async (idNum) => (await db.query("SELECT * FROM public.users WHERE id_num = $1", [idNum])).rows[0];
  const ok = (response) => { assert.equal(response.status, 200, response.body?.message); return response.body; };

  test("the active list and the profile read return the saved display name next to the unchanged assignment", async () => {
    const list = ok(await call("GET", "/users")).users;
    assert.deepEqual(list.find((u) => u.id_num === "admin1"), { id_num: "admin1", role: "admin", doctor_name: "Doctor 1", display_name: null });
    const profile = ok(await call("GET", PROFILE, { id: "admin1" })).profile;
    assert.deepEqual(profile, { id_num: "admin1", role: "admin", doctor_name: "Doctor 1", display_name: null, display_name_supported: true });
  });

  test("save changes only display_name, persists, keeps sessions and logins, and creates no account", async () => {
    const before = await snapshot();
    const count = before.length;
    const body = ok(await call("PUT", PROFILE, { id: "admin1", body: { display_name: "  Dr.   Maria  Santos " } }));
    assert.equal(body.message, "Profile Updated Successfully");
    assert.deepEqual(body.profile, { id_num: "admin1", role: "admin", doctor_name: "Doctor 1", display_name: "Dr. Maria Santos", display_name_supported: true });

    assert.equal((await row("admin1")).display_name, "Dr. Maria Santos", "stored in the database");
    assert.deepEqual(await snapshot(), before, "id, password hash, role, assignment, auth revision and archive state unchanged");
    assert.equal((await db.query("SELECT pg_catalog.count(*)::INT AS n FROM public.users")).rows[0].n, count, "no duplicate account");

    // A fresh read (as after a page refresh) shows it.
    assert.equal(ok(await call("GET", "/users")).users.find((u) => u.id_num === "admin1").display_name, "Dr. Maria Santos");
    // The edited doctor stays signed in and keeps queue access (no Phase A revocation).
    assert.equal((await h.request("GET", "/queue", { token: tokens.admin1 })).status, 200);
    // After logging out and back in, the Superadmin still sees the change; the doctor can log in.
    ok(await h.request("POST", "/auth/logout", { token: tokens.superadmin }));
    const again = (await h.login("superadmin", password("superadmin"))).token;
    assert.equal(ok(await call("GET", PROFILE, { token: again, id: "admin1" })).profile.display_name, "Dr. Maria Santos");
    await h.login("admin1", password("admin1"));
  });

  test("an empty value clears the display name", async () => {
    ok(await call("PUT", PROFILE, { id: "admin2", body: { display_name: "Dr. Reyes" } }));
    const body = ok(await call("PUT", PROFILE, { id: "admin2", body: { display_name: "   " } }));
    assert.equal(body.profile.display_name, null);
    assert.equal((await row("admin2")).display_name, null);
  });

  test("protected fields cannot be changed through Edit Profile", async () => {
    const before = await snapshot();
    for (const extra of [{ role: "superadmin" }, { password: "a-new-password-123" }, { doctor_name: "Doctor 3" },
      { id_num: "renamed" }, { archived_at: null }, { auth_revision: "00000000-0000-4000-8000-000000000000" }]) {
      const response = await call("PUT", PROFILE, { id: "frontdesk", body: { display_name: "Desk A", ...extra } });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.match(response.body.message, /only change the display name/);
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal((await row("frontdesk")).display_name, null, "a refused request writes nothing");
  });

  test("validation: length, control characters and a missing value are refused with the field named", async () => {
    for (const [value, pattern] of [["x".repeat(101), /100 characters or fewer/], ["Dr.\u0000Null", /control characters/],
      ["Bell\u0007", /control characters/], [42, /must be text/]]) {
      const response = await call("PUT", PROFILE, { id: "admin3", body: { display_name: value } });
      assert.equal(response.status, 400);
      assert.equal(response.body.field, "display_name");
      assert.match(response.body.message, pattern);
    }
    const missing = await call("PUT", PROFILE, { id: "admin3", body: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, "display_name");
    // 100 characters (code points, e.g. accented names) is accepted.
    ok(await call("PUT", PROFILE, { id: "admin3", body: { display_name: "é".repeat(100) } }));
    assert.equal((await row("admin3")).display_name, "é".repeat(100));
  });

  test("the database CHECK also refuses untrimmed, empty, over-long and control-character values", async () => {
    for (const value of [" padded", "", "x".repeat(101), "tab\there"]) {
      await assert.rejects(db.query("UPDATE public.users SET display_name = $1 WHERE id_num = 'admin1'", [value]), /users_display_name_check|value too long/);
    }
  });

  test("only a Superadmin may read or edit profiles", async () => {
    for (const idNum of ["admin1", "frontdesk"]) {
      assert.equal((await call("GET", PROFILE, { token: tokens[idNum], id: "admin2" })).status, 403);
      assert.equal((await call("PUT", PROFILE, { token: tokens[idNum], id: "admin2", body: { display_name: "Hacked" } })).status, 403);
      assert.equal((await call("PUT", PROFILE, { token: tokens[idNum], id: idNum, body: { display_name: "Self" } })).status, 403);
    }
    assert.equal((await call("PUT", PROFILE, { token: null, id: "admin2", body: { display_name: "Anon" } })).status, 401);
    assert.equal((await row("admin2")).display_name, null);
    assert.equal((await row("admin1")).display_name, null);
  });

  test("a Superadmin may edit their own and another Superadmin's display name without losing the session", async () => {
    ok(await call("PUT", PROFILE, { id: "superadmin", body: { display_name: "Clinic Head" } }));
    ok(await call("PUT", PROFILE, { id: "superadmin2", body: { display_name: "Deputy Head" } }));
    assert.equal((await call("GET", "/users")).status, 200, "own session still valid");
    assert.equal((await row("superadmin")).role, "superadmin");
  });

  test("archived accounts cannot be read or edited from Staff Management; unknown accounts are 404", async () => {
    ok(await call("POST", "/users/:id_num/archive", { id: "admin2" }));
    const before = await row("admin2");
    const read = await call("GET", PROFILE, { id: "admin2" });
    assert.equal(read.status, 409);
    assert.match(read.body.message, /archived/);
    const write = await call("PUT", PROFILE, { id: "admin2", body: { display_name: "Ghost" } });
    assert.equal(write.status, 409);
    assert.deepEqual(await row("admin2"), before, "the archived row is untouched");
    // Archive, restore and Archives listing still work, and carry the display name.
    ok(await call("POST", "/users/:id_num/restore", { id: "admin2" }));
    ok(await call("PUT", PROFILE, { id: "admin2", body: { display_name: "Dr. Cruz" } }));
    ok(await call("POST", "/users/:id_num/archive", { id: "admin2" }));
    assert.equal(ok(await call("GET", "/users/archived")).users.find((u) => u.id_num === "admin2").display_name, "Dr. Cruz");

    assert.equal((await call("GET", PROFILE, { id: "nobody" })).status, 404);
    assert.equal((await call("PUT", PROFILE, { id: "nobody", body: { display_name: "X" } })).status, 404);
    assert.equal((await row("nobody")), undefined, "no account is created");
  });

  test("GET /queue labels each doctor counter with the assigned account's latest display name", async () => {
    const names = async (token = tokens.superadmin) => ok(await call("GET", "/queue", { token })).doctor_display_names;
    assert.deepEqual(await names(), {}, "nothing set: screens keep Doctor N");
    const countersBefore = (await db.query("SELECT id, id_num, is_online, current_patient_id FROM public.counters ORDER BY id")).rows;

    ok(await call("PUT", PROFILE, { id: "admin1", body: { display_name: "Dr. Juan Dela Cruz" } }));
    ok(await call("PUT", PROFILE, { id: "frontdesk", body: { display_name: "Front Desk A" } }));
    ok(await call("PUT", PROFILE, { id: "superadmin", body: { display_name: "Clinic Head" } }));
    // Every staff screen reads it on its next poll (doctor, front desk, superadmin); no restart.
    for (const idNum of ["admin1", "admin2", "frontdesk", "superadmin"]) {
      assert.deepEqual(await names(tokens[idNum]), { "Doctor 1": "Dr. Juan Dela Cruz" }, idNum);
    }
    ok(await call("PUT", PROFILE, { id: "admin1", body: { display_name: "Dr. Maria Santos" } }));
    assert.deepEqual(await names(), { "Doctor 1": "Dr. Maria Santos" }, "the latest saved name");
    // (The public GET /display labels are covered in phase23-display-privacy.test.js; this
    // minimal schema lacks tables the display reads.)

    // Archived or ambiguous assignments get no label (the counter id is shown instead).
    ok(await call("PUT", PROFILE, { id: "admin2", body: { display_name: "Dr. Reyes" } }));
    ok(await call("POST", "/users/:id_num/archive", { id: "admin2" }));
    await db.exec("RESET ROLE; INSERT INTO public.users (id_num, password, role, doctor_name, display_name) VALUES ('admin1b', 'x', 'admin', 'Doctor 1', 'Dr. Duplicate'); SET ROLE service_role;");
    assert.deepEqual(await names(), {});
    await db.exec("RESET ROLE; DELETE FROM public.users WHERE id_num = 'admin1b'; SET ROLE service_role;");

    assert.deepEqual((await db.query("SELECT id, id_num, is_online, current_patient_id FROM public.counters ORDER BY id")).rows,
      countersBefore, "counters (and their ids) are untouched");
    assert.equal((await row("admin1")).doctor_name, "Doctor 1");
  });

  test("the edited doctor still serves their counter: the assignment is untouched", async () => {
    ok(await call("PUT", PROFILE, { id: "admin1", body: { display_name: "Dr. Maria Santos" } }));
    const presence = ok(await call("GET", "/doctors/presence"));
    assert.ok(JSON.stringify(presence).includes("Doctor 1"));
    assert.equal((await row("admin1")).doctor_name, "Doctor 1");
  });
});

describe("EP1 not installed, then rolled back", { skip: unavailable }, () => {
  test("without the column the lists still work, the modal reports it, and saving is refused (503)", async () => {
    const db = await freshDatabase({ withEp1: false });
    try {
      const { call } = await harness(db);
      const list = (await call("GET", "/users")).body.users;
      assert.equal(list.find((u) => u.id_num === "admin1").display_name, null);
      assert.equal(list.find((u) => u.id_num === "admin1").doctor_name, "Doctor 1");
      const profile = (await call("GET", PROFILE, { id: "admin1" })).body.profile;
      assert.equal(profile.display_name_supported, false);
      const write = await call("PUT", PROFILE, { id: "admin1", body: { display_name: "Dr. Santos" } });
      assert.equal(write.status, 503);
      assert.match(write.body.message, /20261111-ep1-staff-display-name\.sql/);
      assert.equal((await call("GET", "/users/archived")).status, 200);
      const queue = await call("GET", "/queue");
      assert.equal(queue.status, 200, "the queue never fails because display names are missing");
      assert.deepEqual(queue.body.doctor_display_names, {});
    } finally { await db.close(); }
  });

  test("rollback drops the column and constraint; the backend keeps working; safe to re-run", async () => {
    const db = await freshDatabase();
    try {
      await db.exec(`UPDATE public.users SET display_name = 'Dr. Santos' WHERE id_num = 'admin1'`);
      const before = (await db.query(`SELECT ${PROTECTED} FROM public.users ORDER BY id_num`)).rows;
      await db.exec(readScript(ROLLBACK));
      await db.exec(readScript(ROLLBACK));
      const columns = (await db.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'display_name'`)).rows;
      assert.deepEqual(columns, []);
      assert.deepEqual((await db.query(`SELECT ${PROTECTED} FROM public.users ORDER BY id_num`)).rows, before);
      const { call } = await harness(db);
      assert.equal((await call("GET", "/users")).status, 200);
      const preflight = await checks(db, PREFLIGHT);
      assert.deepEqual(preflight.filter((r) => !r.passed).map((r) => r.check_name), [], "preflight passes again after rollback");
    } finally { await db.close(); }
  });
});
