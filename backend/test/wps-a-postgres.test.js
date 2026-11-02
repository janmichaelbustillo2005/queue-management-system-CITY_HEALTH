// WPS-A on disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js): the proposed
// call_patient_visit_wps_a (backend/scripts/20261029-wps-a-call-aging.sql) and the backend with
// WPS_AGING on rank waiting visits identically, including at the 10- and 20-minute step edges,
// and the real backend calls through it. With aging on and the function missing, Calls are
// refused (503) and nothing changes. Synthetic rows only; never Supabase.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");
const { compareWps } = require("../src/lib/wpsPriority");

const { C1, F5, W1, post, expectStatus, patient, pointers, assertConsistent } = f;
const WPS_A = "20261029-wps-a-call-aging.sql";
const WPS_A_ROLLBACK = "20261029-wps-a-rollback.sql";
const MIN = 60 * 1000;
const WINDOW = ["1999-12-31T16:00:00.000Z", "2100-01-01T00:00:00.000Z"];

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

// Deterministic pseudo-random sequence (no external seed state).
function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

describe("WPS-A: backend and database rank waiting visits the same way", { skip: f.unavailable }, () => {
  let db; let h; let tokens; let serial = 0;
  before(async () => {
    db = await f.createDatabase("wps_a", [C1.migration, F5.migration, W1.migration]);
    await db.setup.query("SET ROLE postgres");
    await db.setup.query(f.read(WPS_A));
    await db.setup.query("RESET ROLE");
  });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await f.backend(db, { envOverrides: { wpsAging: true } });
    tokens = await f.signInAll(h);
  });

  const insert = async (base, createdAt, service = "consultation") => Number(await f.one(db, `INSERT INTO public.patients
      (id_num, queue_number, service_type, status, created_at, priority_score)
      VALUES ('Synthetic WPS-A', $1, $2, 'waiting', $3, $4) RETURNING id AS value`,
    [`WA-${++serial}`, service, createdAt, base]));

  test("installed function: SECURITY DEFINER, empty search_path, only service_role executes it", async () => {
    const signature = "public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)";
    const row = (await db.observer.query(`SELECT p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
      FROM pg_proc p WHERE p.oid = $1::regprocedure`, [signature])).rows[0];
    assert.equal(row.prosecdef, true);
    assert.ok(row.proconfig.includes('search_path=""'));
    assert.deepEqual([row.anon, row.authed, row.service], [false, false, true]);
    assert.equal(await f.installed(db, "public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)"), true, "C1 is untouched");
  });

  test("real backend with aging: a 25-minute Regular is called before a new Indigenous Person; C1 order would differ", async () => {
    const now = Date.now();
    const regular = await insert(1, new Date(now - 25 * MIN).toISOString());
    const indigenous = await insert(2, new Date(now - 1 * MIN).toISOString());
    const overview = await h.request("GET", "/queue", { token: tokens.frontdesk });
    assert.equal(overview.body.wps.aging, true);
    const effective = Object.fromEntries(overview.body.patients.map((row) => [row.id, row.effective_priority]));
    assert.deepEqual([effective[regular], effective[indigenous]], [3, 2]);

    h.log.length = 0;
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: indigenous }), 400, /according to queue priority/);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: regular }), 200);
    // The backend refuses the Indigenous call itself; the successful call goes through WPS-A, never C1.
    assert.deepEqual(h.rpcs().filter((name) => name.startsWith("call_patient_visit")), ["call_patient_visit_wps_a"]);
    assert.equal((await pointers(db))["Doctor 1"], regular);
    assert.equal((await patient(db, indigenous)).status, "waiting");
    await assertConsistent(db);
  });

  test("a Regular never passes a Senior, and loses a tie with a new PWD", async () => {
    const now = Date.now();
    const regular = await insert(1, new Date(now - 90 * MIN).toISOString());   // 1 + 2 = 3
    const pwd = await insert(3, new Date(now - 1000).toISOString());         // 3, higher base
    const overview = (await h.request("GET", "/queue", { token: tokens.frontdesk })).body;
    assert.equal(overview.patients.find((row) => row.id === regular).effective_priority, 3);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: regular }), 400, /according to queue priority/);
    expectStatus(await post(h, tokens.frontdesk, "/queue/call", { patient_id: pwd }), 200);
  });

  test("randomized agreement at step edges: the database accepts exactly the backend's head", async () => {
    const random = rng(20261029);
    const ages = [0, 1, 5 * MIN, 10 * MIN - 1, 10 * MIN, 10 * MIN + 1, 15 * MIN, 20 * MIN - 1, 20 * MIN, 20 * MIN + 1, 45 * MIN, 240 * MIN];
    const bases = [1, 1, 1, 2, 3, 3, 4, 5, 7];
    const direct = await db.connect("wps-a-direct");
    await direct.query("SET ROLE service_role");
    let compared = 0; let differsFromWps = 0;
    try {
      for (let round = 0; round < 120; round += 1) {
        await f.resetQueue(db);
        const rankedAt = Date.now();
        const rows = [];
        const count = 2 + Math.floor(random() * 5);
        for (let i = 0; i < count; i += 1) {
          const createdAt = new Date(rankedAt - ages[Math.floor(random() * ages.length)]).toISOString();
          const base = bases[Math.floor(random() * bases.length)];
          rows.push({ id: await insert(base, createdAt), priority_score: base, created_at: createdAt });
        }
        const ranked = rows.slice().sort((a, b) => compareWps(a, b, rankedAt, true));
        const original = rows.slice().sort((a, b) => compareWps(a, b, rankedAt, false));
        if (ranked[0].id !== original[0].id) differsFromWps += 1;
        const attempt = async (row) => {
          const revision = (await patient(db, row.id)).visit_state_revision;
          await direct.query("BEGIN");
          try {
            await direct.query(`SELECT id FROM public.call_patient_visit_wps_a($1, 'Doctor 1', 'frontdesk', $2, $3, $4, $5)`,
              [row.id, revision, ...WINDOW, new Date(rankedAt).toISOString()]);
            return "called";
          } catch (error) {
            return /according to queue priority/.test(error.message) ? "refused" : `error: ${error.message}`;
          } finally {
            await direct.query("ROLLBACK");
          }
        };
        assert.equal(await attempt(ranked[0]), "called", `round ${round}: head ${ranked[0].id}`);
        for (const other of ranked.slice(1)) assert.equal(await attempt(other), "refused", `round ${round}: non-head ${other.id}`);
        compared += ranked.length;
      }
    } finally {
      await direct.end();
    }
    assert.ok(compared > 300);
    assert.ok(differsFromWps > 0, "the workload exercised cases where aging changes the head");
  });

  test("the ranking time must be close to the database clock", async () => {
    const id = await insert(1, new Date().toISOString());
    const revision = (await patient(db, id)).visit_state_revision;
    const direct = await db.connect("wps-a-clock");
    try {
      await direct.query("SET ROLE service_role");
      for (const rankedAt of [new Date(Date.now() - 11 * MIN).toISOString(), new Date(Date.now() + 11 * MIN).toISOString(), null]) {
        await assert.rejects(direct.query(`SELECT public.call_patient_visit_wps_a($1, 'Doctor 1', 'frontdesk', $2, $3, $4, $5)`,
          [id, revision, ...WINDOW, rankedAt]), (error) => error.code === "22023");
      }
    } finally { await direct.end(); }
    assert.equal((await patient(db, id)).status, "waiting");
  });
});

describe("WPS-A enabled without its database function", { skip: f.unavailable }, () => {
  let db;
  before(async () => { db = await f.createDatabase("wps_a_missing", [C1.migration, F5.migration, W1.migration]); });

  test("Call is refused with 503 and nothing changes; with aging off C1 still calls", async () => {
    await f.resetQueue(db);
    const aged = await f.backend(db, { envOverrides: { wpsAging: true } });
    const tokens = await f.signInAll(aged);
    const id = await f.register(aged, db, tokens.frontdesk, { name: "Synthetic WPS-A missing" });
    const before = await f.snapshot(db);
    const refused = await post(aged, tokens.frontdesk, "/queue/call", { patient_id: id });
    assert.equal(refused.status, 503);
    assert.match(refused.body.message, /WPS with Aging is enabled/);
    const after = await f.snapshot(db);
    assert.deepEqual(after.patients, before.patients);
    assert.deepEqual(after.counters, before.counters);
    const plain = await f.backend(db);
    expectStatus(await post(plain, tokens.frontdesk, "/queue/call", { patient_id: id }), 200);
  });

  test("rollback script removes only the WPS-A function", async () => {
    await db.setup.query("SET ROLE postgres");
    await db.setup.query(f.read(WPS_A));
    assert.equal(await f.installed(db, "public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)"), true);
    await db.setup.query(f.read(WPS_A_ROLLBACK));
    await db.setup.query("RESET ROLE");
    assert.equal(await f.installed(db, "public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)"), false);
    assert.equal(await f.installed(db, "public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)"), true);
  });
});
