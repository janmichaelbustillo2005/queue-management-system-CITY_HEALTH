// I2: the documented install order and full rollback of the draft migrations, on disposable
// PostgreSQL 17 starting from the development project's state (baseline + C1, F5, W1 installed):
// D1 -> D1-R -> WPS-A -> D1-A, each preflight -> migration -> verify, then each migration re-run
// (idempotent), then rollback in reverse order (each rollback re-run), checking that no row
// changes and that C1/F5/W1 and the other existing functions keep their exact bodies.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1 } = f;
const D1 = { name: "D1", preflight: "20261029-d1-preflight.sql", migration: "20261029-d1-shared-call.sql",
  verify: "20261029-d1-verify.sql", rollback: "20261029-d1-rollback.sql", preflightRows: 21, verifyRows: 15 };
const D1R = { name: "D1-R", preflight: "20261029-d1r-preflight.sql", migration: "20261029-d1r-records-shared.sql",
  verify: "20261029-d1r-verify.sql", rollback: "20261029-d1r-rollback.sql", preflightRows: 7, verifyRows: null };
const D1A = { name: "D1-A", preflight: "20261029-d1a-preflight.sql", migration: "20261029-d1a-shared-wps-a-call.sql",
  verify: "20261029-d1a-verify.sql", rollback: "20261029-d1a-rollback.sql", preflightRows: 10, verifyRows: 15 };
const WPS_A = { migration: "20261029-wps-a-call-aging.sql", rollback: "20261029-wps-a-rollback.sql" };
const NEW = {
  D1: "public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)",
  "WPS-A": "public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)",
  "D1-A": "public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)"
};

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

describe("I2: draft migration lifecycle from the development project's state", { skip: f.unavailable }, () => {
  test("install order D1 -> D1-R -> WPS-A -> D1-A, idempotent re-runs, full reverse rollback; nothing else changes", async () => {
    const db = await f.createDatabase("i2_migrations", [C1.migration, F5.migration, W1.migration]);
    // Some synthetic rows so "no row changes" means something.
    const h = await f.backend(db);
    const tokens = await f.signInAll(h);
    for (const service of ["consultation", "prenatal", "family_planning"]) await f.register(h, db, tokens.frontdesk, { name: `Synthetic ${service}`, service });
    const catalog = async () => Object.fromEntries((await db.observer.query(`SELECT p.oid::regprocedure::text AS sig,
        md5(replace(p.prosrc, E'\\r\\n', E'\\n')) AS body, p.proacl::text AS acl, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`)).rows
      .map((row) => [row.sig, `${row.body} ${row.acl} ${row.owner}`]));
    const startCatalog = await catalog();
    const startRows = await f.snapshot(db);
    for (const sig of Object.values(NEW)) assert.equal(await f.installed(db, sig), false, `${sig} absent at start`);

    await f.installStep(db, D1);
    await f.installStep(db, D1R);
    await db.setup.query("SET ROLE postgres");
    await db.setup.query(f.read(WPS_A.migration));
    await db.setup.query("RESET ROLE");
    await f.installStep(db, D1A);
    for (const sig of Object.values(NEW)) {
      assert.equal(await f.installed(db, sig), true, sig);
      const privileges = await f.functionPrivileges(db, sig);
      assert.deepEqual([privileges.anon, privileges.authenticated, privileges.service_role, privileges.public], [false, false, true, false], sig);
    }
    const installedCatalog = await catalog();
    // Re-running every migration is harmless and changes no function.
    for (const step of [D1, D1R, WPS_A, D1A]) {
      await db.setup.query("SET ROLE postgres");
      await db.setup.query(f.read(step.migration));
      await db.setup.query("RESET ROLE");
    }
    assert.deepEqual(await catalog(), installedCatalog, "re-running the migrations is idempotent");
    await f.runChecks(db.setup, D1, "verify");
    await f.runChecks(db.setup, D1A, "verify");

    // Only the new functions and get_central_records differ from the start.
    const changed = Object.keys(installedCatalog).filter((sig) => startCatalog[sig] !== installedCatalog[sig]).sort();
    const canonical = async (sig) => f.one(db, "SELECT $1::regprocedure::text AS value", [sig]);
    const expectedChanged = [];
    for (const sig of [...Object.values(NEW), "public.get_central_records(text,jsonb,integer,integer)"]) expectedChanged.push(await canonical(sig));
    assert.deepEqual(changed, expectedChanged.sort());
    assert.deepEqual(await f.snapshot(db), startRows, "installation and verification changed no row");

    // Reverse rollback, each twice.
    for (const step of [D1A, WPS_A, D1R, D1]) {
      await db.setup.query("SET ROLE postgres");
      await db.setup.query(f.read(step.rollback));
      await db.setup.query(f.read(step.rollback));
      await db.setup.query("RESET ROLE");
    }
    assert.deepEqual(await catalog(), startCatalog, "full rollback restores the starting catalog exactly");
    assert.deepEqual(await f.snapshot(db), startRows, "rollback changed no row");
    await db.setup.query(f.read("20261023-phase-b2-verify.sql"));
    await f.runChecks(db.setup, C1, "verify");
    await f.runChecks(db.setup, F5, "verify");
  });
});
