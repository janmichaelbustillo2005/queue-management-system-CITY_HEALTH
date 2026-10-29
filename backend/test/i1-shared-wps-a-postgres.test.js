// I1 integration: D1 shared dispatch x WPS-A 10-minute aging through the REAL backend on
// disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js: loopback cluster, synthetic rows only).
// Databases carry C1, F5, W1, D1, D1-R, WPS-A and D1-A (call_patient_visit_shared_wps_a). The
// backend runs with DOCTOR_DISPATCH_MODE=shared and WPS_AGING on unless a test says otherwise.
// Skips unless PHASE25_PG_URL and PHASE25_PG_MODULE are set. Set I1_EVIDENCE_DIR for JSON evidence.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");
const { compareWps } = require("../src/lib/wpsPriority");

const { C1, F5, W1, post, register, expectStatus, effects, patient, pointers, assertConsistent, one } = f;
const D1 = "20261029-d1-shared-call.sql";
const D1R = "20261029-d1r-records-shared.sql";
const WPS_A = "20261029-wps-a-call-aging.sql";
const D1A = { name: "D1-A", preflight: "20261029-d1a-preflight.sql", migration: "20261029-d1a-shared-wps-a-call.sql",
  verify: "20261029-d1a-verify.sql", rollback: "20261029-d1a-rollback.sql", preflightRows: 10, verifyRows: 15 };
const D1A_FN = "public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)";
const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const SERVICES = ["consultation", "checkup", "prenatal", "maternity", "family_planning"];
const MIN = 60 * 1000;
const WINDOW = ["1999-12-31T16:00:00.000Z", "2100-01-01T00:00:00.000Z"];
const evidence = {};

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(async () => {
  if (process.env.I1_EVIDENCE_DIR && Object.keys(evidence).length) {
    fs.mkdirSync(process.env.I1_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.I1_EVIDENCE_DIR, "i1-shared-wps-a-evidence.json"), JSON.stringify(evidence, null, 2));
  }
  await f.stopCluster();
});

function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

const docToken = (tokens, doctor) => tokens[`admin${doctor.slice(-1)}`];
const sharedAging = (db, options = {}) => f.backend(db, { doctorDispatchMode: "shared", envOverrides: { wpsAging: true }, ...options });
const call = (h, token, id, doctor) => post(h, token, "/queue/call", doctor ? { patient_id: id, counterId: doctor } : { patient_id: id });
const callRpcs = (h) => h.rpcs().filter((name) => name.startsWith("call_patient_visit"));

async function allFunctionsDatabase(prefix, extra = [D1A.migration]) {
  const db = await f.createDatabase(prefix, [C1.migration, F5.migration, W1.migration, D1, D1R, WPS_A, ...extra]);
  await db.setup.query(`CREATE TABLE public.display_settings (id BIGSERIAL PRIMARY KEY, company_name TEXT,
    department_name TEXT, welcome_message TEXT, refresh_interval INTEGER);
    INSERT INTO public.display_settings (company_name, department_name, welcome_message, refresh_interval)
    VALUES ('I1 synthetic display', 'I1 test', 'Welcome', 5);`);
  return db;
}

describe("D1-A installation alongside C1, F5, W1, D1, D1-R and WPS-A", { skip: f.unavailable }, () => {
  test("preflight, install, verify, rollback and reinstall change no row and no other function", async () => {
    const db = await allFunctionsDatabase("i1_install", []);
    const before = await f.snapshot(db);
    await f.installStep(db, D1A);
    assert.deepEqual(await f.functionPrivileges(db, D1A_FN),
      { anon: false, authenticated: false, service_role: true, public: false, owner: "postgres" });
    assert.deepEqual(await f.snapshot(db), before);
    await db.setup.query(f.read(D1A.rollback));
    await db.setup.query(f.read(D1A.rollback));
    assert.equal(await f.installed(db, D1A_FN), false);
    for (const signature of [f.CALL, f.CANCEL, f.REQUEUE, "public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)",
      "public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)"]) {
      assert.equal(await f.installed(db, signature), true, `${signature} kept`);
    }
    await f.installStep(db, D1A);
    assert.deepEqual(await f.snapshot(db), before);
  });
});

describe("Shared WPS-A through the real backend", { skip: f.unavailable }, () => {
  let db; let h; let tokens; let serial = 0; let direct;
  before(async () => {
    db = await allFunctionsDatabase("i1_shared_aging");
    direct = await db.connect("i1-direct");
    await direct.query("SET ROLE service_role");
  });
  after(async () => { await direct?.end(); });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await sharedAging(db);
    tokens = await f.signInAll(h);
  });

  // A synthetic waiting visit registered `ageMs` ago.
  const insert = async (base, ageMs, service = "consultation", counterId = null) => Number(await one(db, `INSERT INTO public.patients
      (id_num, queue_number, service_type, status, created_at, priority_score, counter_id)
      VALUES ('Synthetic I1', $1, $2, 'waiting', $3, $4, $5) RETURNING id AS value`,
    [`I1-${++serial}`, service, new Date(Date.now() - ageMs).toISOString(), base, counterId]));
  // Whether D1-A itself would call `id` for `doctor` at `rankedAt` (rolled back either way).
  const dbAccepts = async (id, doctor, rankedAt) => {
    const revision = (await patient(db, id)).visit_state_revision;
    await direct.query("BEGIN");
    try {
      await direct.query("SELECT id FROM public.call_patient_visit_shared_wps_a($1, $2, 'frontdesk', $3, $4, $5, $6)",
        [id, doctor, revision, ...WINDOW, new Date(rankedAt).toISOString()]);
      return "called";
    } catch (error) {
      return /next patient in the shared queue/.test(error.message) ? "refused" : `error: ${error.message}`;
    } finally {
      await direct.query("ROLLBACK");
    }
  };
  const overview = async () => (await h.request("GET", "/queue", { token: tokens.frontdesk })).body;

  test("aging at 0, 9, 10, 20 and 30 minutes: +0, +0, +1, +2, +2, the same in Node, the API and PostgreSQL", async () => {
    const ages = { 0: 0, 9: 9 * MIN, "9:59": 10 * MIN - 1000, 10: 10 * MIN, 20: 20 * MIN, 30: 30 * MIN };
    const ids = {};
    for (const [label, age] of Object.entries(ages)) ids[label] = await insert(1, age);
    const body = await overview();
    assert.equal(body.dispatch_mode, "shared");
    assert.equal(body.wps.aging, true);
    const effective = Object.fromEntries(Object.entries(ids).map(([label, id]) => [label, body.patients.find((row) => row.id === id).effective_priority]));
    assert.deepEqual(effective, { 0: 1, 9: 1, "9:59": 1, 10: 2, 20: 3, 30: 3 });
    const rankedAt = Date.now();
    assert.equal(await dbAccepts(ids[30], "Doctor 2", rankedAt), "called", "the longest-waiting capped visit is the head");
    for (const label of ["0", "9", "9:59", "10", "20"]) assert.equal(await dbAccepts(ids[label], "Doctor 2", rankedAt), "refused", label);
    // Three doctors take the three highest effective priorities, any service.
    expectStatus(await call(h, tokens.frontdesk, ids[30], "Doctor 3"), 200);
    expectStatus(await call(h, tokens.frontdesk, ids[20], "Doctor 1"), 200);
    expectStatus(await call(h, tokens.frontdesk, ids[10], "Doctor 2"), 200);
    assert.deepEqual(callRpcs(h), Array(3).fill("call_patient_visit_shared_wps_a"));
    assert.deepEqual(await pointers(db), { "Doctor 1": ids[20], "Doctor 2": ids[10], "Doctor 3": ids[30] });
    evidence.agingSteps = effective;
    await assertConsistent(db);
  });

  test("clinical priority protections: aged Regular visits never pass Seniors and lose every tie to a protected category", async () => {
    const cases = [
      { name: "Regular 25 min (1+2) vs new Pregnant (3)", rows: [[1, 25 * MIN], [3, 0, "prenatal"]], winner: 1 },
      { name: "Regular 90 min (1+2) vs new Senior (4)", rows: [[1, 90 * MIN], [4, 0, "family_planning"]], winner: 1 },
      { name: "Solo Parent 20 min (1+2) vs new PWD (3)", rows: [[1, 20 * MIN, "checkup"], [3, 0]], winner: 1 },
      { name: "Indigenous 10 min (2+1) vs Regular 30 min (1+2)", rows: [[2, 10 * MIN, "maternity"], [1, 30 * MIN]], winner: 0 },
      { name: "Regular 25 min (1+2) vs new Indigenous (2): aging lets the Regular through", rows: [[1, 25 * MIN], [2, 0, "prenatal"]], winner: 0 },
      { name: "Senior 0 min (4) vs Senior 30 min (4+2): equal category, longer wait first", rows: [[4, 0], [4, 30 * MIN, "family_planning"]], winner: 1 },
      { name: "Indigenous 20 min (2+2) vs new Senior (4): the Senior wins the tie", rows: [[2, 20 * MIN], [4, 0, "prenatal"]], winner: 1 },
      // Provisional-formula consequence for the adviser (policy decision 4): an aged Indigenous visit
      // (2+2 = 4) precedes a newly arrived PWD or Pregnant patient (3). Pinned so a change is deliberate.
      { name: "Indigenous 20 min (2+2) vs new PWD (3): the aged Indigenous visit first (provisional cap)", rows: [[2, 20 * MIN], [3, 0, "checkup"]], winner: 0 }
    ];
    const results = [];
    for (const item of cases) {
      await f.resetQueue(db);
      const ids = [];
      for (const [base, age, service] of item.rows) ids.push(await insert(base, age, service));
      const winner = ids[item.winner];
      const loser = ids[1 - item.winner];
      const rankedAt = Date.now();
      assert.deepEqual([await dbAccepts(winner, "Doctor 1", rankedAt), await dbAccepts(loser, "Doctor 1", rankedAt)], ["called", "refused"], item.name);
      expectStatus(await call(h, tokens.frontdesk, loser, "Doctor 2"), 400, /next patient in the shared queue/);
      expectStatus(await call(h, tokens.frontdesk, winner, "Doctor 2"), 200);
      results.push({ case: item.name, called_first: (await patient(db, winner)).priority_score });
      await assertConsistent(db);
    }
    evidence.protections = results;
  });

  test("Regular and Senior registered in reverse-priority order: the Senior is called first", async () => {
    const regular = await register(h, db, tokens.frontdesk, { name: "I1 Regular first", service: "consultation" });
    const senior = await register(h, db, tokens.frontdesk, { name: "I1 Senior second", service: "prenatal", flags: ["senior"] });
    expectStatus(await call(h, tokens.frontdesk, regular, "Doctor 1"), 400, /next patient in the shared queue/);
    expectStatus(await call(h, tokens.frontdesk, senior, "Doctor 1"), 200);
    expectStatus(await call(h, tokens.frontdesk, regular, "Doctor 2"), 200);
    assert.ok((await patient(db, senior)).called_at < (await patient(db, regular)).called_at);
  });

  test("three doctors pick up at once, and two doctors racing for one visit, never assign a visit twice", async () => {
    const random = rng(29102026);
    for (let i = 0; i < 6; i += 1) {
      await insert([1, 1, 2, 3, 4][Math.floor(random() * 5)], Math.floor(random() * 35) * MIN, SERVICES[i % SERVICES.length]);
    }
    const rankedAt = Date.now();
    const { rows } = await db.observer.query("SELECT id, priority_score, created_at FROM public.patients WHERE status = 'waiting'");
    const expected = rows.map((row) => ({ ...row, id: Number(row.id), created_at: row.created_at.toISOString() }))
      .sort((a, b) => compareWps(a, b, rankedAt, true)).slice(0, 3).map((row) => row.id).sort((a, b) => a - b);
    const backends = [h, await sharedAging(db), await sharedAging(db)];
    const pickup = async (backend, doctor) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const head = (await backend.request("GET", "/queue", { token: docToken(tokens, doctor) })).body.patients
          .filter((row) => row.status === "waiting")
          .sort((a, b) => b.effective_priority - a.effective_priority || b.priority_score - a.priority_score ||
            Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)[0];
        if ((await call(backend, docToken(tokens, doctor), head.id)).status === 200) return head.id;
      }
      throw new Error(`${doctor} could not pick up`);
    };
    const picked = await Promise.all(DOCTORS.map((doctor, i) => pickup(backends[i], doctor)));
    assert.deepEqual([...picked].sort((a, b) => a - b), expected, "the three highest WPS-A ranks, each once");
    const ptr = await pointers(db);
    assert.deepEqual(DOCTORS.map((doctor) => ptr[doctor]), picked);
    await assertConsistent(db);

    for (let round = 0; round < 5; round += 1) {
      await f.resetQueue(db);
      const target = await insert(1, 15 * MIN);
      await insert(1, 0, "prenatal");
      const [a, b] = await Promise.all([
        call(backends[1], tokens.admin2, target),
        call(backends[2], tokens.frontdesk, target, "Doctor 3")
      ]);
      assert.deepEqual([a.status, b.status].filter((status) => status === 200).length, 1, `${a.body.message} / ${b.body.message}`);
      assert.equal(Object.values(await pointers(db)).filter((id) => id === target).length, 1);
      await assertConsistent(db);
    }
    evidence.concurrency = { picked, expected };
  });

  test("every configured service is completed by every doctor under aging, with voice naming the treating doctor", async () => {
    const matrix = [];
    for (const service of SERVICES) {
      for (const doctor of DOCTORS) {
        const id = await insert(1, 12 * MIN, service);
        expectStatus(await call(h, tokens.frontdesk, id, doctor), 200);
        const token = docToken(tokens, doctor);
        expectStatus(await post(h, DOCTORS.filter((name) => name !== doctor).map((name) => docToken(tokens, name))[0], "/queue/accept", { patient_id: id }), 403);
        expectStatus(await post(h, token, "/queue/accept", { patient_id: id }), 200);
        expectStatus(await post(h, token, "/queue/start", { patient_id: id }), 200);
        const display = (await h.request("GET", "/display")).body;
        assert.equal(display.all_serving.find((row) => row.id === id).counter_name, doctor);
        assert.deepEqual(display.voice_announcements.filter((event) => event.id === id).map((event) => event.counter_name), [doctor]);
        expectStatus(await post(h, token, "/queue/complete", { patient_id: id }), 200);
        const done = await patient(db, id);
        assert.deepEqual([done.status, done.counter_id, done.service_type], ["completed", doctor, service]);
        matrix.push(`${service}:${doctor}`);
      }
    }
    assert.equal(matrix.length, 15);
    assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
    await assertConsistent(db);
  });

  test("Cancel while the other doctors serve, then concurrent Cancel/Requeue requests, keep every counter correct", async () => {
    const ids = [await insert(3, 20 * MIN), await insert(2, 15 * MIN, "prenatal"), await insert(1, 5 * MIN, "family_planning")];
    const extra = await insert(1, 0, "checkup");
    for (const [i, doctor] of DOCTORS.entries()) expectStatus(await call(h, tokens.frontdesk, ids[i], doctor), 200);
    const before = { d1: await patient(db, ids[0]), d3: await patient(db, ids[2]) };
    expectStatus(await post(h, tokens.admin2, "/queue/cancel", { patient_id: ids[1], reason: "I1 referred", counter_id: "Doctor 2" }), 200);
    assert.deepEqual(await pointers(db), { "Doctor 1": ids[0], "Doctor 2": null, "Doctor 3": ids[2] });
    assert.deepEqual(await patient(db, ids[0]), before.d1);
    assert.deepEqual(await patient(db, ids[2]), before.d3);

    const backends = [await sharedAging(db), await sharedAging(db)];
    // A repeated Cancel and a Requeue of the cancelled visit at the same time.
    const [cancel, requeue] = await Promise.all([
      post(backends[0], tokens.frontdesk, "/queue/cancel", { patient_id: ids[1], reason: "I1 duplicate" }),
      post(backends[1], tokens.frontdesk, "/queue/requeue", { patient_id: ids[1] })
    ]);
    assert.ok([cancel.status, requeue.status].includes(200), `${cancel.body.message} / ${requeue.body.message}`);
    // Two Requeues of the same visit at the same time recover it at most once.
    const [r1, r2] = await Promise.all([
      post(backends[0], tokens.frontdesk, "/queue/requeue", { patient_id: ids[1] }),
      post(backends[1], tokens.frontdesk, "/queue/requeue", { patient_id: ids[1] })
    ]);
    assert.ok([r1, r2].filter((r) => r.status === 200).length <= 1);
    const row = await patient(db, ids[1]);
    assert.ok(["waiting", "cancelled"].includes(row.status));
    if (row.status === "waiting") assert.deepEqual([row.counter_id, row.called_at], [null, null]);
    assert.deepEqual(await pointers(db), { "Doctor 1": ids[0], "Doctor 2": null, "Doctor 3": ids[2] });
    assert.equal(Number(await one(db, "SELECT count(*) AS value FROM public.patients")), 4, "no visit lost or duplicated");
    // Doctor 2 takes the shared head next (the requeued visit competes again from the back of its tier).
    const head = h.queue.getSharedQueueHead(
      (await db.observer.query("SELECT * FROM public.patients WHERE status = 'waiting'")).rows
        .map((r) => ({ ...r, id: Number(r.id), created_at: r.created_at.toISOString() })), "Doctor 2", Date.now());
    expectStatus(await call(h, tokens.frontdesk, head.id, "Doctor 2"), 200);
    assert.ok([ids[1], extra].includes(head.id));
    await assertConsistent(db);
  });

  test("signed-out and disabled doctors cannot receive patients; nothing changes", async () => {
    const id = await insert(1, 0);
    const before = await f.snapshot(db);
    expectStatus(await post(h, tokens.admin2, "/auth/logout", {}), 200);
    await db.observer.query("UPDATE public.staff_auth_sessions SET revoked_at = clock_timestamp() WHERE user_id_num = 'admin2' AND revoked_at IS NULL");
    expectStatus(await call(h, tokens.frontdesk, id, "Doctor 2"), 409, /not signed in/);
    await db.observer.query("UPDATE public.counters SET is_online = false WHERE id_num = 'Doctor 3'");
    expectStatus(await call(h, tokens.frontdesk, id, "Doctor 3"), 400, /offline/);
    expectStatus(await call(h, tokens.frontdesk, id), 400, /Select an available doctor/);
    const after = await f.snapshot(db);
    assert.deepEqual([after.patients, after.counters.map((c) => c.current_patient_id)], [before.patients, before.counters.map((c) => c.current_patient_id)]);
    assert.deepEqual(effects(h, id), { sms: 0, awaiting: false, voice: 0 });
    await db.observer.query("UPDATE public.counters SET is_online = true");
  });

  test("Records (D1-R), Analytics and history keep the treating doctor and leave earlier days untouched", async () => {
    await db.observer.query(`INSERT INTO public.patients (queue_number, id_num, service_type, status, counter_id, created_at, called_at, consultation_started_at, completed_at, priority_score)
      VALUES ('I1-H1', 'I1 history', 'consultation', 'completed', 'Doctor 1', now() - interval '3 days', now() - interval '3 days' + interval '5 minutes', now() - interval '3 days' + interval '6 minutes', now() - interval '3 days' + interval '20 minutes', 1),
             ('I1-H2', 'I1 history backlog', 'prenatal', 'waiting', NULL, now() - interval '2 days', NULL, NULL, NULL, 4)`);
    const history = (await db.observer.query("SELECT * FROM public.patients WHERE queue_number LIKE 'I1-H%' ORDER BY id")).rows;
    const treated = await insert(1, 25 * MIN, "prenatal");
    const uncalled = await insert(1, 0, "prenatal");
    expectStatus(await call(h, tokens.frontdesk, treated, "Doctor 3"), 200);
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: uncalled, reason: "I1 left" }), 200);
    const records = async (filters) => (await db.observer.query("SELECT public.get_central_records('patients', $1::jsonb, 1, 50) AS r", [JSON.stringify(filters)])).rows[0].r;
    const shared = await records({ search: "Synthetic I1", dispatch: "shared" });
    const byId = Object.fromEntries(shared.rows.map((row) => [row.id, row]));
    assert.deepEqual([byId[treated].doctor, byId[treated].doctor_source], ["Doctor 3", "assigned"]);
    assert.deepEqual([byId[uncalled].doctor, byId[uncalled].doctor_source], [null, "unassigned"]);
    assert.deepEqual((await records({ search: "Synthetic I1", dispatch: "shared", doctor: "Doctor 2" })).total, 0);
    assert.deepEqual((await records({ search: "Synthetic I1", dispatch: "shared", doctor: "Doctor 3" })).rows.map((row) => row.id), [treated]);
    const analytics = (await h.request("GET", "/analytics", { token: tokens.superadmin, query: { dateFilter: "all" } })).body;
    const byDoctor = Object.fromEntries(analytics.doctorTable.map((row) => [row.doctor, row.total_patients]));
    assert.equal(byDoctor["Doctor 3"], 1);
    assert.equal(byDoctor["Doctor 2"], undefined);
    // The earlier-day waiting visit is outside today's shared queue even with the highest priority.
    expectStatus(await call(h, tokens.frontdesk, history[1].id, "Doctor 1"), 400);
    assert.deepEqual((await db.observer.query("SELECT * FROM public.patients WHERE queue_number LIKE 'I1-H%' ORDER BY id")).rows, history);
    await assertConsistent(db);
  });

  test("randomized SQL-versus-backend ranking with aging, every service and legacy reservations: zero disagreements", async () => {
    const random = rng(1029);
    const ages = [0, 1, 9 * MIN, 10 * MIN - 1, 10 * MIN, 10 * MIN + 1, 19 * MIN, 20 * MIN, 20 * MIN + 1, 30 * MIN, 120 * MIN];
    const bases = [1, 1, 1, 2, 3, 3, 4];
    let compared = 0; let agingChangedHead = 0; let disagreements = 0;
    for (let round = 0; round < 40; round += 1) {
      await f.resetQueue(db);
      const count = 3 + Math.floor(random() * 4);
      for (let i = 0; i < count; i += 1) {
        await insert(bases[Math.floor(random() * bases.length)], ages[Math.floor(random() * ages.length)], SERVICES[Math.floor(random() * SERVICES.length)]);
      }
      let holder = null;
      if (random() < 0.3) {
        const { rows: [r] } = await db.observer.query("SELECT id FROM public.patients WHERE status = 'waiting' ORDER BY random() LIMIT 1");
        holder = DOCTORS[Math.floor(random() * 3)];
        await db.observer.query("UPDATE public.patients SET counter_id = $2 WHERE id = $1", [r.id, holder]);
        await db.observer.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = $2", [r.id, holder]);
      }
      const rankedAt = Date.now();
      const waiting = (await db.observer.query("SELECT * FROM public.patients WHERE status = 'waiting'")).rows
        .map((row) => ({ ...row, id: Number(row.id), created_at: row.created_at.toISOString() }));
      for (const doctor of DOCTORS) {
        const head = h.queue.getSharedQueueHead(waiting, doctor, rankedAt);
        const plainHead = waiting.filter((row) => !row.counter_id || row.counter_id === doctor)
          .sort((a, b) => compareWps(a, b, rankedAt, false))[0];
        if (plainHead && head && plainHead.id !== head.id) agingChangedHead += 1;
        const free = doctor !== holder || head?.counter_id === holder;
        for (const row of waiting) {
          const outcome = await dbAccepts(row.id, doctor, rankedAt);
          const expected = row.id === head?.id && free ? "called" : "refused";
          // A reserved visit or an occupied counter is refused for another reason; only priority is compared.
          const comparable = outcome === "called" || outcome === "refused";
          if (comparable && outcome !== expected) disagreements += 1;
          if (row.id === head?.id && free) assert.equal(outcome, "called", `round ${round}: ${doctor} head ${row.id}`);
          compared += 1;
        }
      }
    }
    assert.equal(disagreements, 0);
    assert.ok(compared > 300, `compared ${compared}`);
    assert.ok(agingChangedHead > 0, "aging changed the head in some rounds");
    evidence.randomizedParity = { compared, agingChangedHead, disagreements };
  });

  test("the four Call paths: service/shared x aging off/on use C1, WPS-A, D1 and D1-A", async () => {
    const paths = [];
    for (const [mode, aging, rpc] of [["service", false, "call_patient_visit"], ["service", true, "call_patient_visit_wps_a"],
      ["shared", false, "call_patient_visit_shared"], ["shared", true, "call_patient_visit_shared_wps_a"]]) {
      await f.resetQueue(db);
      const backend = await f.backend(db, { doctorDispatchMode: mode, envOverrides: { wpsAging: aging } });
      const t = await f.signInAll(backend);
      const id = await insert(1, 11 * MIN, "maternity");
      backend.log.length = 0;
      expectStatus(await call(backend, t.frontdesk, id, mode === "shared" ? "Doctor 1" : null), 200);
      assert.deepEqual(callRpcs(backend), [rpc], `${mode} aging=${aging}`);
      assert.equal((await patient(db, id)).counter_id, mode === "shared" ? "Doctor 1" : "Doctor 2");
      paths.push({ mode, aging, rpc });
    }
    evidence.callPaths = paths;
  });
});

describe("Shared dispatch with aging but without D1-A", { skip: f.unavailable }, () => {
  test("Call is refused with 503 and nothing changes; shared without aging still calls through D1", async () => {
    const db = await allFunctionsDatabase("i1_missing", []);
    const aged = await sharedAging(db);
    const tokens = await f.signInAll(aged);
    const id = await register(aged, db, tokens.frontdesk, { name: "I1 missing D1-A" });
    const before = await f.snapshot(db);
    const refused = await call(aged, tokens.frontdesk, id, "Doctor 1");
    assert.equal(refused.status, 503);
    assert.match(refused.body.message, /20261029-d1a-shared-wps-a-call\.sql/);
    const after = await f.snapshot(db);
    assert.deepEqual([after.patients, after.counters], [before.patients, before.counters]);
    const plain = await f.backend(db, { doctorDispatchMode: "shared" });
    expectStatus(await call(plain, tokens.frontdesk, id, "Doctor 1"), 200);
  });
});
