// Actual PostgreSQL migration/RPC tests in an isolated in-memory PGlite DB.
// Never reads credentials, connects to Supabase, or alters live patient records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { describe, test, before, beforeEach, after } = require("node:test");
const { basePostgresSchema } = require("./helpers/postgresSchema");

let PGlite;
let unavailable;
try {
  ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional PGlite is not installed; use the temporary package instructions in docs/phase2-consultation.md.";
}

describe("Phase A persisted sessions and doctor presence PostgreSQL", { skip: unavailable }, () => {
  let db;
  let service;
  const migration = fs.readFileSync(path.join(__dirname, "../scripts/20261012-phase-a-auth-presence.sql"), "utf8");
  const users = {
    admin1: { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" },
    admin2: { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" },
    admin3: { id_num: "admin3", role: "admin", doctor_name: "Doctor 3" },
    frontdesk: { id_num: "frontdesk", role: "admin", doctor_name: null },
    superadmin: { id_num: "superadmin", role: "superadmin", doctor_name: null }
  };
  const payload = (user = "admin1", jti = randomUUID()) => ({ ...users[user], jti });
  const args = (claims) => [claims.jti, claims.id_num, claims.role, claims.doctor_name];
  const call = async (name, claims) => (await db.query(`SELECT row_to_json(s) AS value
    FROM public.${name}($1, $2, $3, $4) AS s`, args(claims))).rows[0].value;
  const revision = async (user = "admin1") => (await db.query("SELECT auth_revision FROM users WHERE id_num = $1", [user])).rows[0]?.auth_revision;
  const create = async (claims) => (await db.query(`SELECT row_to_json(s) AS value
    FROM public.create_staff_auth_session($1, $2, $3, $4, $5) AS s`,
  [...args(claims), claims.auth_revision || await revision(claims.id_num)])).rows[0].value;
  const validate = (claims) => call("validate_staff_auth_session", claims);
  const heartbeat = (claims) => call("heartbeat_staff_auth_session", claims);
  const revoke = (claims) => db.query("SELECT public.revoke_staff_auth_session($1, $2)", args(claims).slice(0, 2));
  const presence = async () => (await db.query("SELECT public.get_staff_doctor_presence() AS value")).rows[0].value;
  const doctor = async (name = "Doctor 1") => (await presence()).doctors.find((row) => row.doctor_name === name);
  const session = async (claims) => (await db.query("SELECT row_to_json(s) AS value FROM public.staff_auth_sessions AS s WHERE session_id = $1", [claims.jti])).rows[0]?.value;
  const backdate = (claims, seconds) => db.query("UPDATE public.staff_auth_sessions SET last_seen_at = clock_timestamp() - ($2 * interval '1 second') WHERE session_id = $1", [claims.jti, seconds]);

  before(async () => {
    db = await PGlite.create();
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(basePostgresSchema);
    await db.exec(migration);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/services/presenceService.js"), "utf8"), {
      module, exports: module.exports,
      require: (name) => {
        assert.equal(name, "../lib/supabase");
        return { rpc: async (name, parameters = {}) => {
          assert.ok(/^(create|validate|heartbeat|revoke)_staff_(auth_session|user_sessions)$|^get_staff_doctor_presence$/.test(name));
          const entries = Object.entries(parameters);
          const named = entries.map(([key], index) => `${key} => $${index + 1}`).join(", ");
          try {
            // Exact named service payload reaches SQL, with no test-supplied defaults.
            const result = await db.query(`SELECT to_jsonb(public.${name}(${named})) AS value`, entries.map(([, value]) => value));
            return { data: result.rows[0].value, error: null };
          } catch (error) {
            return { data: null, error: { code: error.code, message: error.message } };
          }
        } };
      }
    });
    service = module.exports;
  });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.staff_auth_sessions, public.counters, public.patients, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
        ('admin1', 'test-only', 'admin', 'Doctor 1'), ('admin2', 'test-only', 'admin', 'Doctor 2'),
        ('admin3', 'test-only', 'admin', 'Doctor 3'), ('frontdesk', 'test-only', 'admin', NULL),
        ('superadmin', 'test-only', 'superadmin', NULL);
      INSERT INTO public.counters (id_num, service_types, is_online) VALUES
        ('Doctor 1', '["consultation"]', true), ('Doctor 2', '["prenatal"]', false), ('Doctor 3', '["family_planning"]', true);
      INSERT INTO public.patients (id_num, first_name, last_name, mobile_number, queue_number, service_type,
          status, counter_id, called_at) VALUES ('isolated-patient', 'Test', 'Patient', '000', 'GP-001',
          'consultation', 'serving', 'Doctor 1', clock_timestamp());
      UPDATE public.counters SET current_patient_id = 1 WHERE id_num = 'Doctor 1';
    `);
  });

  test("migration is repeatable, preserves patient/counter data and session activity, and stores no secrets", async () => {
    const claims = payload();
    await create(claims);
    const before = await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM patients p) AS patients, (SELECT jsonb_agg(to_jsonb(c)) FROM counters c) AS counters");
    const stored = await session(claims);
    const accountRevision = await revision();
    await db.exec(migration);
    assert.equal(await revision(), accountRevision);
    assert.deepEqual(await session(claims), stored);
    assert.deepEqual(await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM patients p) AS patients, (SELECT jsonb_agg(to_jsonb(c)) FROM counters c) AS counters"), before);
    const columns = (await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'staff_auth_sessions'")).rows;
    assert.deepEqual(columns.map((column) => column.column_name), ["session_id", "user_id_num", "role", "doctor_name", "created_at", "last_seen_at", "expires_at", "revoked_at"]);
    assert.ok(columns.filter((column) => column.column_name.endsWith("_at")).every((column) => column.data_type === "timestamp with time zone"));
  });

  test("doctor login is online immediately using database timestamps and eight hour expiry", async () => {
    const claims = payload();
    const before = Number((await db.query("SELECT clock_timestamp() AS time")).rows[0].time);
    const row = await create(claims);
    const after = Number((await db.query("SELECT clock_timestamp() AS time")).rows[0].time);
    assert.ok(Date.parse(row.created_at) >= before && Date.parse(row.created_at) <= after);
    assert.equal(row.created_at, row.last_seen_at);
    assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 8 * 60 * 60 * 1000);
    assert.equal((await doctor()).online, true);
    assert.equal((await doctor("Doctor 2")).online, false);
    assert.equal((await doctor("Doctor 3")).online, false);
  });

  test("presence does not use counter enabled or patient occupancy flags", async () => {
    const claims = payload("admin2");
    await create(claims);
    assert.equal((await doctor("Doctor 2")).online, true); // disabled, empty counter
    assert.equal((await doctor("Doctor 1")).online, false); // enabled, serving patient
    await db.exec("UPDATE counters SET current_patient_id = NULL, is_online = false WHERE id_num = 'Doctor 1'");
    const doctor1 = payload();
    await create(doctor1);
    assert.equal((await doctor()).online, true);
  });

  test("logout is immediately offline, idempotent, and preserves last seen", async () => {
    const claims = payload();
    const row = await create(claims);
    await revoke(claims);
    const first = await session(claims);
    await revoke(claims);
    assert.deepEqual(await session(claims), first);
    assert.ok(first.revoked_at);
    assert.equal((await doctor()).online, false);
    assert.equal((await doctor()).last_seen_at, row.last_seen_at);
    await assert.rejects(validate(claims), /expired or revoked/);
  });

  test("browser closure or network loss becomes offline at timeout while authentication remains valid", async () => {
    const claims = payload();
    await create(claims);
    await backdate(claims, 74);
    assert.equal((await doctor()).online, true);
    await backdate(claims, 76);
    assert.equal((await doctor()).online, false);
    assert.ok((await validate(claims)).session_id);
    assert.equal((await doctor()).online, false); // reads do not heartbeat
  });

  test("network restoration revives a stale valid session using only DB clock", async () => {
    const claims = payload();
    await create(claims);
    await backdate(claims, 90);
    const row = await heartbeat(claims);
    assert.equal((await doctor()).online, true);
    assert.equal((await doctor()).last_seen_at, row.last_seen_at);
  });

  test("independent login sessions aggregate and logout revokes only its own session", async () => {
    const first = payload();
    const second = payload();
    await create(first);
    await create(second);
    await revoke(first);
    assert.equal((await doctor()).online, true);
    await backdate(second, 76);
    assert.equal((await doctor()).online, false);
    await heartbeat(second);
    assert.equal((await doctor()).online, true);
    assert.equal((await session(first)).revoked_at != null, true);
  });

  test("shared-tab heartbeats are centrally throttled to one timestamp write per twenty seconds", async () => {
    const claims = payload();
    const first = await create(claims);
    const replies = await Promise.all([heartbeat(claims), heartbeat(claims), heartbeat(claims)]);
    assert.ok(replies.every((row) => row.last_seen_at === first.last_seen_at));
    await backdate(claims, 21);
    const stale = await session(claims);
    const updated = await heartbeat(claims);
    const again = await heartbeat(claims);
    assert.equal(again.last_seen_at, updated.last_seen_at);
    assert.notEqual(updated.last_seen_at, stale.last_seen_at);
  });

  test("revoked sessions cannot be revived by a delayed heartbeat", async () => {
    const claims = payload();
    await create(claims);
    await backdate(claims, 90);
    await revoke(claims);
    const row = await session(claims);
    await assert.rejects(heartbeat(claims), /expired or revoked/);
    assert.deepEqual(await session(claims), row);
    assert.equal((await doctor()).online, false);
  });

  test("expired sessions cannot validate or heartbeat even with recent last seen", async () => {
    const claims = payload();
    await create(claims);
    await db.query("UPDATE staff_auth_sessions SET created_at = clock_timestamp() - interval '9 hours', expires_at = clock_timestamp() - interval '1 second' WHERE session_id = $1", [claims.jti]);
    const row = await session(claims);
    assert.equal((await doctor()).online, false);
    await assert.rejects(validate(claims), /expired or revoked/);
    await assert.rejects(heartbeat(claims), /expired or revoked/);
    assert.deepEqual(await session(claims), row);
  });

  test("session ownership, role and doctor assignment cannot be forged", async () => {
    const claims = payload();
    await create(claims);
    for (const changed of [payload("admin2", claims.jti), { ...claims, role: "superadmin" }, { ...claims, doctor_name: "Doctor 2" }]) {
      await assert.rejects(validate(changed), /sign in again/);
      await assert.rejects(heartbeat(changed), /sign in again/);
    }
    await revoke({ ...claims, id_num: "admin2" });
    assert.equal((await session(claims)).revoked_at, null);
    assert.equal((await doctor()).online, true);
    await assert.rejects(create({ ...claims, jti: randomUUID(), doctor_name: "Doctor 2" }), /account changed/);
  });

  for (const [column, value] of [["password", "changed-test-password"], ["role", "superadmin"], ["doctor_name", "Doctor 2"]]) {
    test(`${column} change revokes all existing sessions and change-back never revives them`, async () => {
      const claims = payload();
      const second = payload();
      await create(claims);
      await create(second);
      await db.query(`UPDATE users SET ${column} = $1 WHERE id_num = 'admin1'`, [value]);
      assert.ok((await session(claims)).revoked_at);
      assert.ok((await session(second)).revoked_at);
      const original = column === "password" ? "test-only" : users.admin1[column];
      await db.query(`UPDATE users SET ${column} = $1 WHERE id_num = 'admin1'`, [original]);
      await assert.rejects(validate(claims), /expired or revoked/);
      await assert.rejects(heartbeat(claims), /expired or revoked/);
      assert.equal((await doctor()).online, false);
      const fresh = payload();
      await create(fresh);
      assert.equal((await doctor()).online, true);
    });
  }

  test("unchanged account writes do not invalidate a valid session", async () => {
    const claims = payload();
    await create(claims);
    await db.exec("UPDATE users SET password = password, role = role, doctor_name = doctor_name WHERE id_num = 'admin1'");
    assert.equal((await validate(claims)).revoked_at, null);
  });

  test("deleted and recreated account cannot reuse its former session", async () => {
    const claims = payload();
    await create(claims);
    await db.exec("DELETE FROM users WHERE id_num = 'admin1'; INSERT INTO users (id_num, password, role, doctor_name) VALUES ('admin1', 'test-only', 'admin', 'Doctor 1')");
    assert.equal(await session(claims), undefined);
    await assert.rejects(validate(claims), /expired or revoked/);
    assert.equal((await doctor()).online, false);
  });

  for (const mutation of ["password reset", "password changed back", "delete and recreate"]) {
    test(`${mutation} rejects a delayed login verified against the previous account revision`, async () => {
      // Captures the same private revision the real login reads alongside its
      // password hash, before bcrypt verification and session creation.
      const staleLogin = { ...payload(), auth_revision: await revision() };
      if (mutation === "delete and recreate") {
        await db.exec("DELETE FROM users WHERE id_num = 'admin1'; INSERT INTO users (id_num, password, role, doctor_name) VALUES ('admin1', 'test-only', 'admin', 'Doctor 1')");
      } else {
        await db.exec("UPDATE users SET password = 'reset-password' WHERE id_num = 'admin1'");
        if (mutation === "password changed back") await db.exec("UPDATE users SET password = 'test-only' WHERE id_num = 'admin1'");
      }
      assert.notEqual(await revision(), staleLogin.auth_revision);
      await assert.rejects(create(staleLogin), /account changed/);
      assert.equal(await session(staleLogin), undefined);
      assert.equal((await doctor()).online, false);
      await create({ ...staleLogin, jti: randomUUID(), auth_revision: await revision() });
      assert.equal((await doctor()).online, true);
    });
  }

  test("create requires a verified revision and obsolete unguarded signature is absent", async () => {
    const claims = payload();
    await assert.rejects(db.query("SELECT create_staff_auth_session($1, $2, $3, $4, NULL)", args(claims)), /account changed/);
    assert.equal((await db.query("SELECT to_regprocedure('public.create_staff_auth_session(uuid,text,text,text)') AS old")).rows[0].old, null);
  });

  test("non-doctor staff sessions are validated but never counted as doctor presence", async () => {
    for (const staff of ["frontdesk", "superadmin"]) {
      const claims = payload(staff);
      await create(claims);
      assert.equal((await validate(claims)).user_id_num, staff);
      assert.ok((await heartbeat(claims)).last_seen_at);
    }
    assert.ok((await presence()).doctors.every((row) => !row.online && row.last_seen_at === null));
  });

  test("doctor assignment aliases map to the existing counter", async () => {
    for (const alias of ["doctor1", "1", "doctor 1"]) {
      await db.query("UPDATE users SET doctor_name = $1 WHERE id_num = 'admin1'", [alias]);
      await create({ ...payload(), doctor_name: alias });
      assert.equal((await doctor()).online, true);
      assert.equal((await doctor("Doctor 2")).online, false);
    }
  });

  test("doctor-number aliases map correctly after counter identity IDs advance", async () => {
    await db.exec(`DELETE FROM counters;
      INSERT INTO counters (id, id_num) OVERRIDING SYSTEM VALUE VALUES
      (41, 'Doctor 1'), (42, 'Doctor 2'), (43, 'Doctor 3');`);
    for (const alias of ["1", "Doctor01", "Doctor   1"]) {
      await db.query("UPDATE users SET doctor_name = $1 WHERE id_num = 'admin1'", [alias]);
      await create({ ...payload(), doctor_name: alias });
      assert.equal((await doctor()).online, true);
      assert.equal((await doctor("Doctor 2")).online, false);
      assert.equal((await doctor("Doctor 3")).online, false);
    }
  });

  test("ambiguous numeric alias resolves one counter in ID order", async () => {
    // Raw '2' is both Doctor 2's number and Doctor 1's database ID. Existing
    // resolution chooses the first matching counter, never both.
    await db.exec(`DELETE FROM counters;
      INSERT INTO counters (id, id_num) OVERRIDING SYSTEM VALUE VALUES
      (2, 'Doctor 1'), (42, 'Doctor 2'), (43, 'Doctor 3');
      UPDATE users SET doctor_name = '2' WHERE id_num = 'admin1';`);
    await create({ ...payload(), doctor_name: "2" });
    assert.equal((await doctor()).online, true);
    assert.equal((await doctor("Doctor 2")).online, false);
    assert.equal((await doctor("Doctor 3")).online, false);
  });

  test("logout while serving preserves patient record and occupied counter exactly", async () => {
    const claims = payload();
    await create(claims);
    const snapshot = async () => (await db.query("SELECT (SELECT to_jsonb(p) FROM patients p WHERE id=1) AS patient, (SELECT to_jsonb(c) FROM counters c WHERE id_num='Doctor 1') AS counter")).rows;
    const before = await snapshot();
    await heartbeat(claims);
    await revoke(claims);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await doctor()).online, false);
  });

  test("user-wide revocation is idempotent and isolates other doctors", async () => {
    const one = payload(); const two = payload("admin2");
    await create(one); await create(payload()); await create(two);
    assert.equal((await db.query("SELECT revoke_staff_user_sessions('admin1') AS count")).rows[0].count, 2);
    assert.equal((await db.query("SELECT revoke_staff_user_sessions('admin1') AS count")).rows[0].count, 0);
    assert.equal((await doctor()).online, false);
    assert.equal((await doctor("Doctor 2")).online, true);
  });

  test("RPC and table privileges deny public/anon/authenticated and permit service_role only", async () => {
    const functions = [
      "create_staff_auth_session(uuid,text,text,text,uuid)", "validate_staff_auth_session(uuid,text,text,text)",
      "heartbeat_staff_auth_session(uuid,text,text,text)", "revoke_staff_auth_session(uuid,text)",
      "revoke_staff_user_sessions(text)", "get_staff_doctor_presence()"
    ];
    for (const name of functions) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, `public.${name}`])).rows[0].allowed, role === "service_role");
      }
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1, 'public.staff_auth_sessions', 'SELECT') AS allowed", [role])).rows[0].allowed, role === "service_role");
    }
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.staff_auth_sessions'::regclass")).rows[0].relrowsecurity, true);
    await db.exec("SET ROLE anon");
    try {
      await assert.rejects(db.query("SELECT get_staff_doctor_presence()"), /permission denied/);
      await assert.rejects(db.query("SELECT * FROM staff_auth_sessions"), /permission denied/);
    } finally { await db.exec("RESET ROLE"); }
    await db.exec("SET ROLE service_role");
    try {
      assert.equal((await db.query("SELECT count(*) AS count FROM staff_auth_sessions")).rows[0].count, 0);
      assert.equal((await presence()).timeout_seconds, 75);
    } finally { await db.exec("RESET ROLE"); }
  });

  test("installation verification script runs read-only and inspects baseline and presence RLS", async () => {
    const claims = payload();
    await create(claims);
    const before = await session(claims);
    const verification = fs.readFileSync(path.join(__dirname, "../scripts/20261012-phase-a-verify.sql"), "utf8");
    const results = await db.exec(verification);
    const rls = results.find((result) => result.rows.some((row) => row.table_name === "staff_auth_sessions"));
    assert.deepEqual(rls.rows.map((row) => row.table_name), ["counters", "patients", "staff_auth_sessions", "users"]);
    assert.equal(rls.rows.find((row) => row.table_name === "staff_auth_sessions").rls_enabled, true);
    const grants = results.find((result) => result.rows.some((row) => Object.hasOwn(row, "check_passed")));
    assert.equal(grants.rows.length, 18);
    assert.ok(grants.rows.every((row) => row.check_passed));
    const functions = results.find((result) => result.rows.some((row) => Object.hasOwn(row, "public_execute_revoked")));
    assert.equal(functions.rows.length, 7);
    assert.ok(functions.rows.every((row) => row.public_execute_revoked && row.security_definer));
    assert.deepEqual(await session(claims), before);
  });

  test("actual backend named service arguments execute all migrated RPCs", async () => {
    const claims = payload();
    const created = await service.createAuthSession({ ...users.admin1, auth_revision: await revision() }, claims.jti);
    assert.equal(created.id_num, claims.id_num);
    assert.equal(created.session_id, claims.jti);
    assert.equal((await service.validateAuthSession(claims)).session_id, claims.jti);
    assert.equal((await service.heartbeatAuthSession(claims)).session_id, claims.jti);
    const status = await service.getDoctorPresence([{ id_num: "Doctor 1" }, { id_num: "Doctor 2" }, { id_num: "Doctor 3" }]);
    assert.equal(status.doctors[0].online, true);
    assert.equal(status.timeout_seconds, 75);
    assert.ok(status.observed_at);
    assert.equal((await service.revokeAuthSession(claims)).revoked, true);
    await assert.rejects(service.heartbeatAuthSession(claims), (error) => error.statusCode === 401);
    assert.equal((await service.revokeUserSessions("admin1")).revoked_count, 0);
  });
});
