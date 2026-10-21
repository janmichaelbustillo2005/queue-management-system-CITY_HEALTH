// Disposable synthetic PostgreSQL only: no .env, network, project or seed SQL.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { basePostgresSchema } = require("./helpers/postgresSchema");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to its installed package.";
}

const root = path.resolve(__dirname, "../..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const lifecycle = read("backend/scripts/20261010-phase2-consultation-lifecycle.sql");
const phase21 = read("backend/scripts/20261012-phase21-stale-recovery.sql");
const migration = read("backend/scripts/20261014-phase22-undo-waiting.sql");
const verify = read("backend/scripts/20261015-phase22-verify.sql");
const preflight = read("backend/scripts/20261016-phase22-preflight.sql");
function migrationBody(sql) {
  const normalized = sql.replace(/\r\n/g, "\n");
  assert.equal((normalized.match(/^BEGIN;$/gm) || []).length, 1, "one outer BEGIN per source migration");
  assert.equal((normalized.match(/^COMMIT;$/gm) || []).length, 1, "one outer COMMIT per source migration");
  return normalized.replace(/^BEGIN;\n/m, "").replace(/^COMMIT;\n?$/m, "").trim();
}
const composedBundle = `BEGIN;\n\n${migrationBody(phase21)}\n\n${migrationBody(migration)}\n\nCOMMIT;\n`;
const preparedBundlePath = path.join(root, "output/phase22-development-verification/phase21-phase22-development-install.sql");
const hasPreparedBundle = fs.existsSync(preparedBundlePath);
const installBundle = hasPreparedBundle ? fs.readFileSync(preparedBundlePath, "utf8") : composedBundle;
const signature = name => `public.${name}(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)`;
const failed = rows => rows.filter(row => row.result === "FAIL").map(row => row.check_name);

function bodyHash(sql, name) {
  const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`));
  assert.ok(match, `${name} approved function body exists`);
  return crypto.createHash("md5").update(match[1].replace(/\r\n/g, "\n")).digest("hex");
}

async function run(db, sql, expectedCount) {
  const results = await db.exec(sql);
  const rows = results.find(result => result.rows.some(row => Object.hasOwn(row, "check_name")))?.rows;
  const inventory = results.find(result => result.fields?.some(field => field.name === "rls_enabled"))?.rows;
  assert.ok(rows, "verification emits checks without a PostgreSQL exception");
  const tabularResults = results.filter(result => result.fields?.length);
  assert.ok(tabularResults.at(-1)?.fields.some(field => field.name === "check_name"),
    "SQL Editor shows the check table as the final tabular result");
  assert.equal(rows.length, expectedCount);
  assert.ok(rows.every(row => Number(row.expected_check_count) === expectedCount
    && Number(row.check_count) === expectedCount
    && Number(row.failed_count) === failed(rows).length
    && row.all_pass === (failed(rows).length === 0)));
  assert.ok(inventory, "verification emits a separate RLS inventory");
  assert.equal((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off",
    "the verification commits its read-only transaction");
  return { rows, inventory };
}

async function fixture(db) {
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  await db.exec(basePostgresSchema);
  // The shared workflow fixture uses text. The deployed schema contract uses
  // varchar, so adapt this disposable fixture only; do not change the checker.
  await db.exec("ALTER TABLE public.patients ALTER COLUMN counter_id TYPE varchar(255)");
  await db.exec(lifecycle);
}

async function seed(db) {
  await db.exec(`
    INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
      ('synthetic-admin', 'test-only', 'admin', 'Doctor 1');
    INSERT INTO public.patients (id_num, queue_number, service_type, status,
      created_at, called_at, consultation_started_at, completed_at, counter_id, reason) VALUES
      ('synthetic-completed', 'GP-001', 'consultation', 'completed',
       '2000-01-01 00:00:00.111222+00', '2000-01-01 00:01:00.222333+00',
       '2000-01-01 00:02:00.333444+00', '2000-01-01 00:03:00.444555+00', 'Doctor 1', 'Preserve history'),
      ('synthetic-cancelled', 'GP-002', 'consultation', 'cancelled',
       '2000-01-01 00:00:00+00', '2000-01-01 00:01:00+00', NULL,
       '2000-01-01 00:03:00+00', 'Doctor 2', 'Preserve cancellation');
    INSERT INTO public.counters (id_num, is_online, current_patient_id) VALUES
      ('Doctor 1', true, NULL), ('Doctor 2', false, 2), ('Doctor 3', true, NULL);
    CREATE POLICY synthetic_patient_policy ON public.patients FOR SELECT TO authenticated USING (false);
    CREATE POLICY synthetic_counter_policy ON public.counters FOR SELECT TO anon USING (false);
  `);
}

async function snapshot(db) {
  const snapshot = {};
  for (const table of ["patients", "counters", "users"]) {
    snapshot[table] = (await db.query(`SELECT row_to_json(r) AS value FROM public.${table} AS r ORDER BY id`)).rows;
  }
  snapshot.rls = (await db.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)).rows;
  snapshot.policies = (await db.query("SELECT * FROM pg_catalog.pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname")).rows;
  snapshot.triggers = (await db.query(`SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.patients'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
  return snapshot;
}

test("Phase 2.2 rollout fingerprints match the approved migration body bytes", () => {
  const expected = {
    recover_patient_visit: bodyHash(migration, "recover_patient_visit"),
    undo_patient_visit_waiting: bodyHash(migration, "undo_patient_visit_waiting")
  };
  const rotation = bodyHash(phase21, "rotate_patient_visit_revision");
  for (const sql of [preflight, verify]) {
    for (const [name, hash] of Object.entries(expected)) assert.ok(sql.includes(`('${name}', '${hash}')`), name);
    assert.ok(sql.includes(`= '${rotation}'`), "revision function fingerprint");
    assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/m);
    assert.match(sql, /COMMIT;\s*$/);
  }
});

test("missing schema, functions and roles fail cleanly with 44/56 explicit FAIL rows", { skip: unavailable }, async () => {
  const db = await PGlite.create();
  try {
    for (const [sql, count] of [[preflight, 44], [verify, 56]]) {
      const result = await run(db, sql, count);
      assert.equal(failed(result.rows).length, count);
      assert.deepEqual(result.inventory, []);
    }
  } finally { await db.close(); }
});

test("Phase 2.1 preflight and Phase 2.2 post-install checks are repeatable and preserve data/RLS", { skip: unavailable }, async () => {
  const db = await PGlite.create();
  try {
    await fixture(db);
    const missing21 = await run(db, preflight, 44);
    assert.equal(failed(missing21.rows).length, 13);
    assert.ok(failed(missing21.rows).includes("patients.visit_state_revision"));
    assert.ok(failed(missing21.rows).includes("revision update trigger"));
    assert.ok(failed(missing21.rows).includes("revision rotation function"));
    assert.equal(failed((await run(db, verify, 56)).rows).length, 25);

    await db.exec(phase21);
    await seed(db);
    const before = await snapshot(db);
    const ready = await run(db, preflight, 44);
    assert.deepEqual(failed(ready.rows), []);
    assert.deepEqual(await run(db, preflight, 44), ready);
    assert.deepEqual(await snapshot(db), before, "preflight never changes rows, triggers, policies or RLS");
    const old = await run(db, verify, 56);
    assert.equal(failed(old.rows).length, 12);
    assert.ok(failed(old.rows).includes("recover_patient_visit approved Phase 2.2 source"));

    await db.exec(migration);
    assert.deepEqual(await snapshot(db), before, "Phase 2.2 installation changes no application rows or RLS");
    const installed = await run(db, verify, 56);
    assert.deepEqual(failed(installed.rows), []);
    assert.deepEqual(installed.inventory, ready.inventory);
    assert.deepEqual(await run(db, verify, 56), installed);
    assert.deepEqual(await snapshot(db), before, "post-install verification is read-only and repeatable");
    await db.exec(migration);
    assert.deepEqual(await snapshot(db), before, "reinstall also preserves application state");
    assert.deepEqual(await run(db, verify, 56), installed, "reinstall keeps all 56 checks passing");
  } finally { await db.close(); }
});

test("post-install verifier detects old recovery, missing grants and a disabled trigger independently", { skip: unavailable }, async () => {
  const db = await PGlite.create();
  try {
    await fixture(db);
    await db.exec(phase21);
    await seed(db);
    await db.exec(migration);
    const before = await snapshot(db);

    await db.exec(phase21);
    assert.deepEqual(failed((await run(db, verify, 56)).rows), ["recover_patient_visit approved Phase 2.2 source"]);
    await db.exec(migration);
    for (const name of ["recover_patient_visit", "undo_patient_visit_waiting"]) {
      await db.exec(`REVOKE EXECUTE ON FUNCTION ${signature(name)} FROM service_role`);
      assert.deepEqual(failed((await run(db, verify, 56)).rows), [`${name} / service_role EXECUTE`]);
      await db.exec(`GRANT EXECUTE ON FUNCTION ${signature(name)} TO service_role`);
    }
    await db.exec("ALTER TABLE public.patients DISABLE TRIGGER patients_rotate_visit_revision");
    assert.deepEqual(failed((await run(db, verify, 56)).rows), ["revision update trigger"]);
    assert.deepEqual(failed((await run(db, preflight, 44)).rows), ["revision update trigger"]);
    await db.exec("ALTER TABLE public.patients ENABLE TRIGGER patients_rotate_visit_revision");
    assert.deepEqual(failed((await run(db, verify, 56)).rows), []);
    assert.deepEqual(await snapshot(db), before, "defect probes and verifier leave all fixture data and RLS intact");
  } finally { await db.close(); }
});

test("review-only combined bundle installs from Phase 2 with all 56 checks and preserves clinical fields", { skip: unavailable }, async () => {
  const db = await PGlite.create();
  try {
    // A clean checkout composes the checked-in migrations. If the local review
    // artifact is present, execute it too and ensure its source bodies are exact.
    for (const source of [phase21, migration]) {
      assert.ok(installBundle.replace(/\r\n/g, "\n").includes(migrationBody(source)), "bundle preserves approved migration body bytes");
    }
    const planPath = path.join(root, "output/phase22-development-verification/approved-rollout-plan.json");
    if (fs.existsSync(planPath)) {
      const rolloutPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      for (const source of rolloutPlan.source_migrations) {
        assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, source.file))).digest("hex"), source.sha256);
        if (hasPreparedBundle) assert.ok(installBundle.includes(`-- SHA256: ${source.sha256}`));
      }
    }
    await fixture(db);
    await seed(db);
    const before = await snapshot(db);
    await db.exec(installBundle);
    const after = await snapshot(db);
    const existingPatients = after.patients.map(({ value }) => {
      assert.match(value.visit_state_revision, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      const { visit_state_revision, ...existing } = value;
      return { value: existing };
    });
    assert.deepEqual(existingPatients, before.patients, "every preexisting patient field, including real timestamps, is preserved");
    for (const key of ["counters", "users", "rls", "policies"]) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.triggers.map(row => row.tgname), ["patients_rotate_visit_revision"]);
    assert.deepEqual(failed((await run(db, verify, 56)).rows), []);
    await db.exec(composedBundle);
    assert.deepEqual(await snapshot(db), after, "source-composed reinstall preserves the added UUIDs and application state");
    assert.deepEqual(failed((await run(db, verify, 56)).rows), []);
  } finally { await db.close(); }
});

test("a later failure in the combined bundle rolls back Phase 2.1 metadata and all application state", { skip: unavailable }, async () => {
  const db = await PGlite.create();
  try {
    await fixture(db);
    await seed(db);
    const before = await snapshot(db);
    // Fail after both migrations' DDL/grants but before the shared transaction
    // commits. This is a local fault-injection copy; the review bundle is intact.
    const brokenBundle = installBundle.replace(/COMMIT;\s*$/, "SELECT 1 / 0;\nCOMMIT;\n");
    assert.notEqual(brokenBundle, installBundle);
    await assert.rejects(db.exec(brokenBundle), error => error.code === "22012");
    await db.exec("ROLLBACK");
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'visit_state_revision'`)).rows[0].count, 0);
    const functions = (await db.query(`SELECT to_regprocedure('public.rotate_patient_visit_revision()') AS rotation,
      to_regprocedure('${signature("recover_patient_visit")}') AS recovery,
      to_regprocedure('${signature("undo_patient_visit_waiting")}') AS undo`)).rows[0];
    assert.deepEqual(functions, { rotation: null, recovery: null, undo: null });
    assert.equal(failed((await run(db, preflight, 44)).rows).length, 13);
    assert.equal(failed((await run(db, verify, 56)).rows).length, 25);
  } finally { await db.close(); }
});
