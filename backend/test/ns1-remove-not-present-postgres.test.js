// NS1 (No-Show / Not Present removal): backend/scripts/20261118-ns1-*.sql on a fresh, synthetic,
// in-memory PGlite database with FC1 + OC1 (and RR1). Never loads .env or the Supabase client and
// never touches real data. Needs the scripts that were moved out of the repository: run with
// QMS_SCRIPTS_DIR (see helpers/liveKnownSchema.js) and PHASE2_PGLITE_MODULE.
const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { liveKnownDatabase, readScript } = require("./helpers/liveKnownSchema");

let PGlite;
let unavailable;
try { ({ PGlite } = require(process.env.PHASE2_PGLITE_MODULE || "@electric-sql/pglite")); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  unavailable = "Optional isolated PGlite is unavailable; set PHASE2_PGLITE_MODULE to the installed package.";
}

const OC1_STATE = ["20261023-phase-b2-records.sql", "20261025-c1-atomic-call.sql", "20261022-f5-requeue-terminal-recovery.sql",
  "20261025-w1-atomic-cancel.sql", "20261103-patient-records.sql", "add-account-cancellation-requests.sql",
  "20261110-ar1-staff-archive.sql", "20261109-rr1-round-robin-dispatch.sql", "20261111-fc1-front-desk-confirmation.sql",
  "20261113-oc1-one-confirmation-per-doctor.sql"];
const NS1 = "20261118-ns1-remove-not-present.sql";
const ok = (rows) => rows.every((row) => row.result.startsWith("ok") || row.result.startsWith("info"));

async function oc1Database() {
  const db = await liveKnownDatabase(PGlite);
  for (const script of OC1_STATE) await db.exec(readScript(script));
  await db.exec(`SET TIME ZONE 'UTC';
    INSERT INTO public.users (id_num, password, role, doctor_name) VALUES ('frontdesk', 'x', 'admin', NULL), ('admin1', 'x', 'admin', 'Doctor 1');`);
  return db;
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
const fnExists = async (db, name) => Number((await one(db, `SELECT count(*) AS n FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name])).n) > 0;
const queueWindow = () => ({ start: new Date(Date.now() - 12 * 3600e3).toISOString(), end: new Date(Date.now() + 12 * 3600e3).toISOString() });
async function insert(db, ticket, priority, minutesAgo) {
  return Number((await one(db, `INSERT INTO public.patients (id_num, queue_number, service_type, status, priority_score, created_at, counter_id)
    VALUES ($1, $1, 'consultation', 'waiting', $2, now() - make_interval(mins => $3), 'Doctor 1') RETURNING id`, [ticket, priority, minutesAgo])).id);
}
const confirm = (db, id) => {
  const { start, end } = queueWindow();
  return db.query(`SELECT public.confirm_next_patient_visit($1, 'frontdesk', $2, $3, now(), false, 'round_robin') AS r`, [id, start, end]);
};
const setAside = (db, id) => {
  const { start, end } = queueWindow();
  return db.query("SELECT public.set_patient_presence($1, 'frontdesk', $2, $3, false)", [id, start, end]);
};

describe("NS1 removes the Not Present database function (isolated PGlite)", { skip: unavailable }, () => {
  test("a set-aside patient is returned; only set_patient_presence is dropped; WPS order and OC1 stay intact", async () => {
    const db = await oc1Database();
    const senior = await insert(db, "T-HIGH", 4, 5);
    const regular = await insert(db, "T-LOW", 1, 10);
    await setAside(db, senior);
    const before = (await one(db, "SELECT row_to_json(p)::jsonb AS v FROM public.patients p WHERE id = $1", [senior])).v;
    assert.notEqual(before.not_present_at, null);

    const preflight = (await db.query(readScript("20261118-ns1-preflight.sql"))).rows;
    assert.ok(ok(preflight), JSON.stringify(preflight));
    assert.equal(preflight.find((row) => row.check_no === 2).result, "ok", "only a comment mentions the function elsewhere");

    await db.exec(readScript(NS1));
    assert.equal(await fnExists(db, "set_patient_presence"), false);
    for (const kept of ["confirm_next_patient_visit", "qms_oc1_guard_confirmation", "qms_guard_front_desk_confirmation",
      "call_patient_visit_rr", "qms_oc1_effective_priority", "cancel_patient_visit"]) {
      assert.equal(await fnExists(db, kept), true, kept);
    }

    // Present again; ticket, priority, registration time, doctor and status are unchanged (only
    // the revision marker moves, as on every update).
    const after = (await one(db, "SELECT row_to_json(p)::jsonb AS v FROM public.patients p WHERE id = $1", [senior])).v;
    const strip = ({ not_present_at, not_present_by, visit_state_revision, ...rest }) => rest;
    assert.equal(after.not_present_at, null);
    assert.equal(after.not_present_by, null);
    assert.deepEqual(strip(after), strip(before));
    assert.notEqual(after.visit_state_revision, before.visit_state_revision);

    // WPS-A order: the senior is the doctor's next patient again.
    await assert.rejects(confirm(db, regular), /Only the next patient/);
    assert.equal((await confirm(db, senior)).rows[0].r.already_confirmed, false);
    // No other writer can set Not Present: OC1's guard still refuses direct writes.
    await assert.rejects(db.query("UPDATE public.patients SET not_present_at = now(), not_present_by = 'x' WHERE id = $1", [regular]),
      /Only the Front Desk/);

    const verify = (await db.query(readScript("20261118-ns1-verify.sql"))).rows;
    assert.ok(ok(verify), JSON.stringify(verify));

    // Repeatable; the rollback re-creates the function as OC1 installed it; NS1 removes it again.
    await db.exec(readScript(NS1));
    await db.exec(readScript("20261118-ns1-rollback.sql"));
    assert.equal(await fnExists(db, "set_patient_presence"), true);
    await setAside(db, regular);
    await db.exec(readScript(NS1));
    assert.equal(await fnExists(db, "set_patient_presence"), false);
    assert.equal((await one(db, "SELECT not_present_at FROM public.patients WHERE id = $1", [regular])).not_present_at, null);
    assert.equal(Number((await one(db, "SELECT count(*) AS n FROM public.patients")).n), 2, "no patient row is added or removed");
    await db.close();
  });

  test("on a database without OC1, NS1 and its verify script are a safe no-op", async () => {
    const db = await liveKnownDatabase(PGlite);
    await db.exec(readScript(NS1));
    const verify = (await db.query(readScript("20261118-ns1-verify.sql"))).rows;
    assert.ok(ok(verify), JSON.stringify(verify));
    await db.close();
  });
});
