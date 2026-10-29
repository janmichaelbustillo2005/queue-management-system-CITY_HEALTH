// S2: login accepts only each account's own password, through the REAL POST /auth/login on
// disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js). The legacy shared "admin123" password
// used to log in to every account whose id starts with "admin" (all doctor accounts) whatever its
// stored password was. Stored plaintext passwords (seeded accounts) keep working for their own
// password only, so no existing account is locked out.
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { describe, test, before, after } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

describe("S2: no shared fallback password at login", { skip: f.unavailable }, () => {
  let db; let h;
  before(async () => {
    db = await f.createDatabase("s2_login_backdoor", []);
    await db.observer.query(`INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
      ('admin7', $1, 'admin', 'Doctor 1'), ('admin8', 'synthetic-plain-8', 'admin', 'Doctor 2'),
      ('administrator', 'synthetic-plain-root', 'superadmin', NULL)`, [await bcrypt.hash("synthetic-hashed-7", 10)]);
    h = await f.backend(db);
  });

  const login = (id_num, password) => h.request("POST", "/auth/login", { body: { id_num, password } });

  test("the shared admin123 password no longer opens doctor or admin-prefixed accounts", async () => {
    for (const id of ["admin1", "admin2", "admin3", "admin7", "admin8", "administrator"]) {
      const response = await login(id, "admin123");
      assert.equal(response.status, 401, `${id} must refuse admin123`);
      assert.equal(response.body.token, undefined);
    }
    const sessions = Number(await f.one(db, "SELECT count(*) AS value FROM public.staff_auth_sessions"));
    assert.equal(sessions, 0, "no session was created by a refused login");
  });

  test("each account still signs in with its own password (bcrypt and legacy plaintext)", async () => {
    for (const [id, password] of [["admin1", "synthetic-admin1-password"], ["admin7", "synthetic-hashed-7"],
      ["admin8", "synthetic-plain-8"], ["administrator", "synthetic-plain-root"]]) {
      const response = await login(id, password);
      assert.equal(response.status, 200, `${id}: ${response.body?.message}`);
      assert.ok(response.body.token);
    }
  });

  test("wrong, empty and near-miss passwords are refused for plaintext accounts", async () => {
    for (const password of ["", "synthetic-plain", "synthetic-plain-88", "SYNTHETIC-PLAIN-8", "synthetic-plain-8 "]) {
      assert.equal((await login("admin8", password)).status, 401, JSON.stringify(password));
    }
  });
});
