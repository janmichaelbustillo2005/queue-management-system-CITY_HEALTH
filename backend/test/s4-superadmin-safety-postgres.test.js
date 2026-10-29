// S4: Staff account management cannot lock the clinic out of administration, through the REAL
// /users routes on disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js). A Superadmin cannot
// delete the account it is signed in with, and no request may delete or demote the last
// Superadmin. Invalid roles and short passwords are refused with 400 before anything is stored.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

describe("S4: Superadmin account safety", { skip: f.unavailable }, () => {
  let db; let h; let tokens;
  before(async () => { db = await f.createDatabase("s4_superadmin_safety", []); });
  beforeEach(async () => {
    await db.observer.query("DELETE FROM public.users WHERE id_num NOT IN ('admin1','admin2','admin3','frontdesk','superadmin')");
    await db.observer.query("UPDATE public.users SET role = 'superadmin' WHERE id_num = 'superadmin'");
    h = await f.backend(db);
    tokens = await f.signInAll(h);
  });

  const call = (method, route, { token = tokens.superadmin, body, id } = {}) =>
    h.request(method, route, { token, body, params: id ? { id_num: id } : {} });
  const superadmins = async () => Number(await f.one(db, "SELECT count(*) AS value FROM public.users WHERE role = 'superadmin'"));

  test("the only Superadmin can neither delete itself nor be demoted", async () => {
    const self = await call("DELETE", "/users/:id_num", { id: "superadmin" });
    assert.equal(self.status, 400);
    assert.match(self.body.message, /own account/);
    const demote = await call("PUT", "/users/:id_num", { id: "superadmin", body: { role: "admin" } });
    assert.equal(demote.status, 400);
    assert.match(demote.body.message, /last Superadmin/);
    assert.equal(await superadmins(), 1);
  });

  test("with a second Superadmin, the other one may be deleted or demoted, but never the last", async () => {
    expectOk(await call("POST", "/users", { body: { id_num: "synthetic-sa2", password: "synthetic-sa2-pass", role: "superadmin" } }));
    expectOk(await call("PUT", "/users/:id_num", { id: "synthetic-sa2", body: { role: "admin", doctor_name: null } }));
    expectOk(await call("PUT", "/users/:id_num", { id: "synthetic-sa2", body: { role: "superadmin", doctor_name: null } }));
    expectOk(await call("DELETE", "/users/:id_num", { id: "synthetic-sa2" }));
    assert.equal(await superadmins(), 1);
    const last = await call("PUT", "/users/:id_num", { id: "superadmin", body: { role: "admin" } });
    assert.equal(last.status, 400);
  });

  test("invalid roles and short or missing passwords are refused with 400 and store nothing", async () => {
    for (const body of [
      { id_num: "synthetic-x", password: "long-enough-1", role: "staff" },
      { id_num: "synthetic-x", password: "long-enough-1", role: "root" },
      { id_num: "synthetic-x", password: "short", role: "admin" },
      { id_num: "synthetic-x", role: "admin" },
      { id_num: "", password: "long-enough-1", role: "admin" }
    ]) {
      const response = await call("POST", "/users", { body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(Number(await f.one(db, "SELECT count(*) AS value FROM public.users WHERE id_num = 'synthetic-x'")), 0);
    const badRole = await call("PUT", "/users/:id_num", { id: "admin1", body: { role: "owner" } });
    assert.equal(badRole.status, 400);
    const shortPassword = await call("PUT", "/users/:id_num", { id: "admin1", body: { password: "short", role: "admin", doctor_name: "Doctor 1" } });
    assert.equal(shortPassword.status, 400);
  });

  test("ordinary account management still works and doctors cannot use it", async () => {
    expectOk(await call("POST", "/users", { body: { id_num: "synthetic-doc", password: "synthetic-doc-pass", role: "admin", doctor_name: "Doctor 2" } }));
    expectOk(await call("PUT", "/users/:id_num", { id: "synthetic-doc", body: { password: "synthetic-doc-new", role: "admin", doctor_name: "Doctor 2" } }));
    assert.equal((await h.request("POST", "/auth/login", { body: { id_num: "synthetic-doc", password: "synthetic-doc-new" } })).status, 200);
    assert.equal((await call("DELETE", "/users/:id_num", { id: "synthetic-doc", token: tokens.admin1 })).status, 403);
    expectOk(await call("DELETE", "/users/:id_num", { id: "synthetic-doc" }));
  });

  function expectOk(response) { assert.equal(response.status, 200, response.body?.message); }
});
