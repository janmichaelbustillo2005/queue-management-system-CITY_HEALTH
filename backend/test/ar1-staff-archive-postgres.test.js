// AR1 staff archiving. The REAL routes, JWT middleware, presenceService and queueService
// (pgBackendHarness) against a fresh, synthetic, in-memory PGlite database in the development
// project's known state plus B.2, the cancellation-request table and AR1. Never loads .env or the
// Supabase client and never touches real data.
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

const PREFLIGHT = "20261110-ar1-preflight.sql";
const AR1 = "20261110-ar1-staff-archive.sql";
const ROLLBACK = "20261110-ar1-rollback.sql";
const ACCOUNTS = {
  superadmin: ["superadmin", null], frontdesk: ["admin", null],
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"]
};
const password = (idNum) => `synthetic-${idNum}-password`;

async function freshDatabase({ withAr1 = true } = {}) {
  const db = await liveKnownDatabase(PGlite);
  for (const script of ["20261023-phase-b2-records.sql", "add-account-cancellation-requests.sql"]) await db.exec(readScript(script));
  const users = Object.entries(ACCOUNTS).map(([idNum, [role, doctor]]) =>
    `('${idNum}', '${bcrypt.hashSync(password(idNum), 4)}', '${role}', ${doctor ? `'${doctor}'` : "NULL"})`);
  await db.exec(`INSERT INTO public.counters (id_num, service_types) VALUES ('Doctor 1', '["consultation","checkup"]'),
      ('Doctor 2', '["prenatal","maternity"]'), ('Doctor 3', '["family_planning"]');
    INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ${users.join(", ")};`);
  if (withAr1) await db.exec(readScript(AR1));
  return db;
}

async function checks(db, script) {
  const results = await db.exec(readScript(script));
  return results.filter((result) => result.rows?.length && "passed" in result.rows[0]).at(-1).rows;
}

describe("AR1 staff archiving (isolated PGlite, real backend)", { skip: unavailable }, () => {
  let db;
  let h;
  let tokens;

  before(async () => {
    db = await freshDatabase({ withAr1: false });
    const preflight = await checks(db, PREFLIGHT);
    assert.equal(preflight.length, 8);
    assert.deepEqual(preflight.filter((row) => !row.passed).map((row) => row.check_name), []);
    await db.exec(readScript(AR1));
    await db.exec("ALTER ROLE service_role BYPASSRLS; SET TIME ZONE 'UTC'; SET ROLE service_role;");
  });
  after(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db.exec(`RESET ROLE;
      DELETE FROM public.account_cancellation_requests; DELETE FROM public.staff_auth_sessions;
      DELETE FROM public.users WHERE id_num NOT IN ('superadmin','frontdesk','admin1','admin2','admin3');
      UPDATE public.users SET archived_at = NULL, archived_by = NULL;
      SET ROLE service_role;`);
    for (const [idNum, [role, doctor]] of Object.entries(ACCOUNTS)) {
      await db.query(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ($1, $2, $3, $4)
        ON CONFLICT (id_num) DO NOTHING`, [idNum, bcrypt.hashSync(password(idNum), 4), role, doctor]);
    }
    const pool = { query: (sql, values) => db.query(sql, values) };
    h = createPgBackendHarness(pool);
    tokens = {};
    for (const idNum of Object.keys(ACCOUNTS)) tokens[idNum] = (await h.login(idNum, password(idNum))).token;
  });

  const call = (method, route, { token = tokens.superadmin, id, body } = {}) =>
    h.request(method, route, { token, body, params: id ? { id_num: id, id } : {} });
  const row = async (idNum) => (await db.query("SELECT * FROM public.users WHERE id_num = $1", [idNum])).rows[0];
  const activeIds = async () => (await call("GET", "/users")).body.users.map((u) => u.id_num);
  const archivedIds = async () => (await call("GET", "/users/archived")).body.users.map((u) => u.id_num);
  const ok = (response) => { assert.equal(response.status, 200, response.body?.message); return response.body; };

  test("archive keeps the account, moves it from the active list to Archives, and revokes its sessions", async () => {
    const before = await row("admin2");
    const body = ok(await call("POST", "/users/:id_num/archive", { id: "admin2" }));
    assert.equal(body.user.id_num, "admin2");
    assert.equal(body.user.archived_by, "superadmin");
    assert.ok(body.user.archived_at);

    assert.ok(!(await activeIds()).includes("admin2"));
    const archived = (await call("GET", "/users/archived")).body.users;
    assert.deepEqual(archived.map((u) => [u.id_num, u.role, u.doctor_name, u.archived_by]), [["admin2", "admin", "Doctor 2", "superadmin"]]);

    const after = await row("admin2");
    assert.equal(after.password, before.password, "credentials are preserved");
    assert.equal(after.role, before.role);
    assert.equal(after.doctor_name, before.doctor_name);
    assert.notEqual(after.auth_revision, before.auth_revision, "auth revision rotated");

    // Existing session is rejected on any protected endpoint, and login is refused.
    assert.equal((await h.request("GET", "/queue", { token: tokens.admin2 })).status, 401);
    const login = await h.request("POST", "/auth/login", { body: { id_num: "admin2", password: password("admin2") } });
    assert.equal(login.status, 403);
    assert.match(login.body.message, /archived/);
    // A wrong password does not reveal the archive state.
    const wrong = await h.request("POST", "/auth/login", { body: { id_num: "admin2", password: "not-the-password" } });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.message, /Invalid username or password/);
    // Other accounts are untouched.
    assert.equal((await h.request("GET", "/queue", { token: tokens.admin1 })).status, 200);
  });

  test("a login verified before the archive committed cannot create a session afterwards", async () => {
    const verified = await h.queue.loginUser("admin3", password("admin3"));
    ok(await call("POST", "/users/:id_num/archive", { id: "admin3" }));
    await assert.rejects(h.presence.createAuthSession(verified, "11111111-1111-4111-8111-111111111111"),
      (error) => error.statusCode === 401);
  });

  test("restore returns the same account to the active list; it may sign in again and nothing is duplicated", async () => {
    const before = await row("admin1");
    const count = Number((await db.query("SELECT count(*) AS n FROM public.users")).rows[0].n);
    ok(await call("POST", "/users/:id_num/archive", { id: "admin1" }));
    ok(await call("POST", "/users/:id_num/restore", { id: "admin1" }));
    assert.ok((await activeIds()).includes("admin1"));
    assert.ok(!(await archivedIds()).includes("admin1"));
    const after = await row("admin1");
    assert.equal(after.password, before.password);
    assert.equal(after.doctor_name, "Doctor 1");
    assert.equal(after.archived_at, null);
    assert.equal(after.archived_by, null);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.users")).rows[0].n), count);
    // The old session stays revoked; a fresh login works.
    assert.equal((await h.request("GET", "/queue", { token: tokens.admin1 })).status, 401);
    assert.equal((await h.request("POST", "/auth/login", { body: { id_num: "admin1", password: password("admin1") } })).status, 200);
    // Restoring an active account is refused.
    assert.equal((await call("POST", "/users/:id_num/restore", { id: "admin1" })).status, 409);
  });

  test("permanent deletion works only from Archives and keeps login history", async () => {
    const active = await call("DELETE", "/users/:id_num", { id: "admin2" });
    assert.equal(active.status, 409);
    assert.match(active.body.message, /Archive the account first/);
    assert.ok(await row("admin2"));

    ok(await call("POST", "/users/:id_num/archive", { id: "admin2" }));
    const activity = Number((await db.query("SELECT count(*) AS n FROM public.staff_auth_activity WHERE user_id_num = 'admin2'")).rows[0].n);
    assert.ok(activity > 0);
    ok(await call("DELETE", "/users/:id_num", { id: "admin2" }));
    assert.equal(await row("admin2"), undefined);
    assert.ok(!(await archivedIds()).includes("admin2"));
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.staff_auth_activity WHERE user_id_num = 'admin2'")).rows[0].n), activity,
      "login/logout history is preserved");
    // A second (duplicate) delete request finds nothing to delete.
    assert.equal((await call("DELETE", "/users/:id_num", { id: "admin2" })).status, 404);
    assert.deepEqual((await activeIds()).sort(), ["admin1", "admin3", "frontdesk", "superadmin"]);
  });

  test("authorization: only an active Superadmin; never self; never the last active Superadmin; no duplicates", async () => {
    for (const [method, route] of [["GET", "/users/archived"], ["POST", "/users/:id_num/archive"],
      ["POST", "/users/:id_num/restore"], ["DELETE", "/users/:id_num"]]) {
      assert.equal((await call(method, route, { id: "admin3", token: tokens.admin1 })).status, 403, `${method} ${route} doctor`);
      assert.equal((await h.request(method, route, { params: { id_num: "admin3" } })).status, 401, `${method} ${route} anonymous`);
    }
    const self = await call("POST", "/users/:id_num/archive", { id: "superadmin" });
    assert.equal(self.status, 409);
    assert.match(self.body.message, /your own account/);
    assert.equal((await call("POST", "/users/:id_num/archive", { id: "nobody" })).status, 404);

    ok(await call("POST", "/users/:id_num/archive", { id: "frontdesk" }));
    const again = await call("POST", "/users/:id_num/archive", { id: "frontdesk" });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already archived/);

    // A second Superadmin can be archived; an archived Superadmin can no longer act, even directly.
    ok(await call("POST", "/users", { body: { id_num: "synthetic-sa2", password: "synthetic-sa2-pass", role: "superadmin" } }));
    ok(await call("POST", "/users/:id_num/archive", { id: "synthetic-sa2" }));
    const direct = await db.query("SELECT public.archive_staff_account('admin3', 'synthetic-sa2') AS r").catch((error) => error);
    assert.equal(direct.code, "42501");
    // The last ACTIVE Superadmin cannot be demoted even though an archived Superadmin exists.
    const demote = await call("PUT", "/users/:id_num", { id: "superadmin", body: { role: "admin" } });
    assert.equal(demote.status, 400);
    assert.match(demote.body.message, /last Superadmin/);
    // The database itself refuses to archive the last active Superadmin.
    const last = await db.query("SELECT public.archive_staff_account('superadmin', 'superadmin') AS r").catch((error) => error);
    assert.equal(last.code, "P0001");
  });

  test("approving a doctor cancellation request archives (never deletes) the account, once", async () => {
    ok(await call("POST", "/account-cancellation-requests", { token: tokens.admin3, body: { reason: "Leaving the clinic" } }));
    const [request] = (await call("GET", "/account-cancellation-requests")).body.requests;
    const approved = ok(await call("POST", "/account-cancellation-requests/:id/process", { id: String(request.id), body: { action: "approve" } }));
    assert.equal(approved.request.status, "approved");
    assert.equal(approved.request.processed_by, "superadmin");
    assert.equal(approved.request.account_outcome, "archived");
    assert.match(approved.message, /archived/);

    const account = await row("admin3");
    assert.ok(account, "the account row still exists");
    assert.ok(account.archived_at);
    assert.equal(account.archived_by, "superadmin");
    assert.ok((await archivedIds()).includes("admin3"));
    assert.equal((await h.request("GET", "/queue", { token: tokens.admin3 })).status, 401);

    // The request record and its outcome are kept; processing it again is refused.
    const again = await call("POST", "/account-cancellation-requests/:id/process", { id: String(request.id), body: { action: "approve" } });
    assert.equal(again.status, 409);
    const stored = (await db.query("SELECT status, processed_by FROM public.account_cancellation_requests WHERE id = $1", [request.id])).rows[0];
    assert.deepEqual(stored, { status: "approved", processed_by: "superadmin" });
  });

  test("rejecting a cancellation request keeps the account active; a pending request blocks permanent deletion", async () => {
    ok(await call("POST", "/account-cancellation-requests", { token: tokens.admin1, body: { reason: "Testing reject" } }));
    let [request] = (await call("GET", "/account-cancellation-requests")).body.requests;
    ok(await call("POST", "/account-cancellation-requests/:id/process", { id: String(request.id), body: { action: "reject" } }));
    assert.ok((await activeIds()).includes("admin1"));
    assert.equal((await row("admin1")).archived_at, null);
    assert.equal((await h.request("GET", "/queue", { token: tokens.admin1 })).status, 200);

    ok(await call("POST", "/account-cancellation-requests", { token: tokens.admin1, body: { reason: "Pending one" } }));
    ok(await call("POST", "/users/:id_num/archive", { id: "admin1" }));
    const blocked = await call("DELETE", "/users/:id_num", { id: "admin1" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /pending cancellation request/);
    assert.ok(await row("admin1"));
    // Approving that request now leaves the already-archived account as it is.
    [request] = (await call("GET", "/account-cancellation-requests", {})).body.requests.filter((r) => r.status === "pending");
    const approved = ok(await call("POST", "/account-cancellation-requests/:id/process", { id: String(request.id), body: { action: "approve" } }));
    assert.equal(approved.request.account_outcome, "already_archived");
    ok(await call("DELETE", "/users/:id_num", { id: "admin1" }));
  });

  test("API roles cannot call the AR1 functions directly; internal helpers are not callable by service_role", async () => {
    const { rows } = await db.query(`SELECT p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname LIKE 'qms_ar1_%' OR p.proname IN
        ('archive_staff_account','restore_staff_account','delete_archived_staff_account','approve_account_cancellation_request'))
      ORDER BY p.proname`);
    assert.equal(rows.length, 7);
    for (const r of rows) {
      assert.equal(r.anon, false, r.proname);
      assert.equal(r.authenticated, false, r.proname);
      assert.equal(r.service_role, !r.proname.startsWith("qms_ar1_"), r.proname);
    }
  });
});

describe("AR1 rollback", { skip: unavailable }, () => {
  test("refuses while an account is archived, then removes every AR1 object", async () => {
    const db = await freshDatabase();
    try {
      await db.exec("SELECT public.archive_staff_account('admin2', 'superadmin')");
      await assert.rejects(db.exec(readScript(ROLLBACK)), /still archived/);
      await db.exec("ROLLBACK").catch(() => {});
      assert.ok((await db.query("SELECT archived_at FROM public.users WHERE id_num = 'admin2'")).rows[0].archived_at);
      await db.exec("SELECT public.restore_staff_account('admin2', 'superadmin')");
      await db.exec(readScript(ROLLBACK));
      const { rows: [state] } = await db.query(`SELECT
          (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'
            AND column_name IN ('archived_at', 'archived_by'))::int AS columns,
          (SELECT count(*) FROM pg_proc WHERE proname LIKE 'qms_ar1_%' OR proname IN ('archive_staff_account',
            'restore_staff_account', 'delete_archived_staff_account', 'approve_account_cancellation_request'))::int AS functions,
          (SELECT count(*) FROM public.users)::int AS users`);
      assert.deepEqual(state, { columns: 0, functions: 0, users: 5 });
      // Running it again is harmless, and the migration can be reinstalled.
      await db.exec(readScript(ROLLBACK));
      await db.exec(readScript(AR1));
    } finally {
      await db.close();
    }
  });
});
