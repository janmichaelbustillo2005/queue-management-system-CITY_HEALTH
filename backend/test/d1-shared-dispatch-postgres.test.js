// D1 flexible doctor assignment (Model A shared queue, provisional) through the REAL backend on
// disposable PostgreSQL 17 (helpers/c1f5w1Fixture.js: loopback cluster, synthetic rows only,
// C1 + F5 + W1 installed, then D1). The backend runs with DOCTOR_DISPATCH_MODE=shared unless a
// test says otherwise. Skips unless PHASE25_PG_URL and PHASE25_PG_MODULE are set. Set
// D1_EVIDENCE_DIR to write the evidence as JSON.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");

const { C1, F5, W1, post, register, expectStatus, effects, patient, pointers, assertConsistent, one } = f;
const SHARED = "public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)";
const D1 = { name: "D1", preflight: "20261029-d1-preflight.sql", migration: "20261029-d1-shared-call.sql",
  verify: "20261029-d1-verify.sql", rollback: "20261029-d1-rollback.sql", preflightRows: 21, verifyRows: 15 };
const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const SERVICES = ["consultation", "prenatal", "family_planning"];
const evidence = {};

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(async () => {
  if (process.env.D1_EVIDENCE_DIR && Object.keys(evidence).length) {
    fs.mkdirSync(process.env.D1_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.D1_EVIDENCE_DIR, "d1-shared-dispatch-evidence.json"), JSON.stringify(evidence, null, 2));
  }
  await f.stopCluster();
});

const docToken = (tokens, doctor) => tokens[`admin${doctor.slice(-1)}`];
const shared = (db, options = {}) => f.backend(db, { doctorDispatchMode: "shared", ...options });
const call = (h, token, id, doctor) => post(h, token, "/queue/call", doctor ? { patient_id: id, counterId: doctor } : { patient_id: id });
const queueHead = async (h, token) => {
  const overview = await h.request("GET", "/queue", { token });
  return overview.body.patients.filter((row) => row.status === "waiting").sort((a, b) =>
    (b.priority_score || 0) - (a.priority_score || 0) || new Date(a.created_at) - new Date(b.created_at) || a.id - b.id)[0];
};

describe("D1 installation on the C1 + F5 + W1 development state", { skip: f.unavailable }, () => {
  test("preflight, install, verify, rollback and reinstall leave C1, W1, F5 and every row untouched", async () => {
    const db = await f.createDatabase("d1_install", [C1.migration, F5.migration, W1.migration]);
    const before = await f.snapshot(db);
    await f.installStep(db, D1);
    assert.equal(await f.installed(db, SHARED), true);
    assert.deepEqual(await f.functionPrivileges(db, SHARED),
      { anon: false, authenticated: false, service_role: true, public: false, owner: "postgres" });
    assert.deepEqual(await f.snapshot(db), before, "installation changed no patient, counter, account or session");
    for (const signature of [f.CALL, f.CANCEL, f.REQUEUE]) assert.equal(await f.installed(db, signature), true);

    await db.setup.query(f.read(D1.rollback));
    await db.setup.query(f.read(D1.rollback)); // idempotent
    assert.equal(await f.installed(db, SHARED), false);
    for (const signature of [f.CALL, f.CANCEL, f.REQUEUE]) assert.equal(await f.installed(db, signature), true, `${signature} kept`);
    await f.installStep(db, D1);
    assert.deepEqual(await f.snapshot(db), before);
  });
});

describe("D1-R Records draft on the Phase B.2 development state", { skip: f.unavailable }, () => {
  const RECORDS = "public.get_central_records(text,jsonb,integer,integer)";
  const D1R = { name: "D1-R", preflight: "20261029-d1r-preflight.sql", migration: "20261029-d1r-records-shared.sql",
    verify: "20261029-d1r-verify.sql", rollback: "20261029-d1r-rollback.sql", preflightRows: 7, verifyRows: null };
  const bodyMd5 = async (db) => one(db, "SELECT md5(replace(prosrc, E'\r\n', E'\n')) AS value FROM pg_proc WHERE oid = $1::regprocedure", [RECORDS]);

  test("installs over Phase B.2 without changing its behavior, and rollback restores the exact B.2 body", async () => {
    const db = await f.createDatabase("d1r_records", [C1.migration, F5.migration, W1.migration, D1.migration]);
    const b2Body = await bodyMd5(db);
    const before = await f.snapshot(db);
    await f.installStep(db, D1R);
    assert.equal(await bodyMd5(db), "b92dbefe03b63d0b4ef92997af0649cd");
    await db.setup.query(f.read("20261023-phase-b2-verify.sql")); // B.2's own behavioral checks still pass
    assert.deepEqual(await f.functionPrivileges(db, RECORDS),
      { anon: false, authenticated: false, service_role: true, public: false, owner: "postgres" });
    assert.deepEqual(await f.snapshot(db), before, "install and both verifications left every row as it was");
    await db.setup.query(f.read(D1R.rollback));
    assert.equal(await bodyMd5(db), b2Body, "rollback restores Phase B.2 exactly");
    await db.setup.query(f.read("20261023-phase-b2-verify.sql"));
    await assert.rejects(db.setup.query(f.read(D1R.verify)), /not the reviewed D1-R body/);
    await db.setup.query("ROLLBACK").catch(() => {});
  });
});

describe("D1 shared queue through the real backend", { skip: f.unavailable }, () => {
  let db; let h; let tokens;
  before(async () => {
    db = await f.createDatabase("d1_shared", [C1.migration, F5.migration, W1.migration, D1.migration]);
    // The public Queue Display also reads display_settings, which the development-state
    // fixture does not include; a synthetic row lets /display run against this database.
    await db.setup.query(`CREATE TABLE public.display_settings (id BIGSERIAL PRIMARY KEY, company_name TEXT,
      department_name TEXT, welcome_message TEXT, refresh_interval INTEGER);
      INSERT INTO public.display_settings (company_name, department_name, welcome_message, refresh_interval)
      VALUES ('D1 synthetic display', 'D1 test', 'Welcome', 5);`);
  });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await shared(db);
    tokens = await f.signInAll(h);
  });

  test("every doctor completes every service: the selected doctor is stored, announced and released", async () => {
    const matrix = [];
    for (const service of SERVICES) {
      for (const doctor of DOCTORS) {
        const id = await register(h, db, tokens.frontdesk, { name: `D1 ${service} by ${doctor}`, service, mobile: "09170000000" });
        const registered = await patient(db, id);
        assert.equal(registered.counter_id, null, "registration assigns no doctor");
        h.log.length = 0;
        const called = await call(h, tokens.frontdesk, id, doctor);
        expectStatus(called, 200);
        assert.equal(called.body.doctor, doctor);
        assert.ok(h.rpcs().includes("call_patient_visit_shared") && !h.rpcs().includes("call_patient_visit"), "D1 performed the Call");
        assert.equal((await patient(db, id)).counter_id, doctor);
        assert.equal((await pointers(db))[doctor], id);
        // Only the actual doctor may accept; the doctor of the old service mapping may not.
        const other = DOCTORS.find((name) => name !== doctor);
        expectStatus(await post(h, docToken(tokens, other), "/queue/accept", { patient_id: id }), 403);
        expectStatus(await post(h, docToken(tokens, doctor), "/queue/accept", { patient_id: id }), 200);
        expectStatus(await post(h, docToken(tokens, doctor), "/queue/re-call", { patient_id: id }), 200);
        expectStatus(await post(h, docToken(tokens, doctor), "/queue/start", { patient_id: id }), 200);
        const display = (await h.request("GET", "/display")).body;
        assert.equal(display.dispatch_mode, "shared");
        assert.equal(display.all_serving.find((row) => row.id === id).counter_name, doctor);
        const spoken = display.voice_announcements.filter((event) => event.id === id);
        assert.deepEqual(spoken.map((event) => [event.event_type, event.counter_name]), [["accept", doctor], ["recall", doctor]]);
        expectStatus(await post(h, docToken(tokens, doctor), "/queue/complete", { patient_id: id }), 200);
        const done = await patient(db, id);
        assert.equal(done.status, "completed");
        assert.equal(done.counter_id, doctor);
        assert.ok(done.consultation_started_at && done.completed_at > done.consultation_started_at);
        assert.deepEqual(await pointers(db), { "Doctor 1": null, "Doctor 2": null, "Doctor 3": null });
        assert.deepEqual(h.sms.filter((entry) => entry.type === "called").at(-1).args.slice(1), [registered.queue_number, doctor]);
        matrix.push({ service, doctor, queue_number: done.queue_number, counter_id: done.counter_id, status: done.status });
        await assertConsistent(db);
      }
    }
    assert.equal(matrix.length, 9);
    evidence.serviceDoctorMatrix = matrix;
  });

  test("Weighted-Priority over the shared queue: a Senior registered after a Regular is called first, by any doctor", async () => {
    const regular = await register(h, db, tokens.frontdesk, { name: "D1 Regular consultation", service: "consultation" });
    const senior = await register(h, db, tokens.frontdesk, { name: "D1 Senior family planning", service: "family_planning", flags: ["senior"] });
    const pregnant = await register(h, db, tokens.frontdesk, { name: "D1 Pregnant prenatal", service: "prenatal", flags: ["pregnant"] });
    expectStatus(await call(h, tokens.frontdesk, regular, "Doctor 1"), 400, /next patient in the shared queue/);
    expectStatus(await call(h, tokens.frontdesk, pregnant, "Doctor 2"), 400, /next patient in the shared queue/);
    assert.equal((await queueHead(h, tokens.frontdesk)).id, senior);
    expectStatus(await call(h, tokens.frontdesk, senior, "Doctor 1"), 200); // the consultation doctor takes family planning
    expectStatus(await call(h, tokens.frontdesk, pregnant, "Doctor 3"), 200);
    expectStatus(await call(h, tokens.frontdesk, regular, "Doctor 2"), 200);
    const order = [senior, pregnant, regular].map(async (id) => [(await patient(db, id)).counter_id, (await patient(db, id)).called_at]);
    const rows = await Promise.all(order);
    assert.deepEqual(rows.map(([doctor]) => doctor), ["Doctor 1", "Doctor 3", "Doctor 2"]);
    assert.ok(rows[0][1] < rows[1][1] && rows[1][1] < rows[2][1], "called in priority order");
    evidence.priority = { senior: rows[0], pregnant: rows[1], regular: rows[2] };
    await assertConsistent(db);
  });

  test("two doctors calling the same next patient at once: exactly one assignment, no duplicate", async () => {
    for (let round = 0; round < 5; round += 1) {
      await f.resetQueue(db);
      const first = await register(h, db, tokens.frontdesk, { name: `D1 race ${round} first` });
      const second = await register(h, db, tokens.frontdesk, { name: `D1 race ${round} second`, service: "prenatal" });
      const backends = [h, await shared(db)];
      const [a, b] = await Promise.all([
        call(backends[0], tokens.admin1, first),           // doctor-initiated pickup
        call(backends[1], tokens.frontdesk, first, "Doctor 2") // Frontdesk selects Doctor 2 for the same visit
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, `${a.body?.message} / ${b.body?.message}`);
      assert.ok(statuses[1] >= 400, "the second call is refused");
      const row = await patient(db, first);
      const winner = a.status === 200 ? "Doctor 1" : "Doctor 2";
      assert.equal(row.counter_id, winner);
      const ptr = await pointers(db);
      assert.equal(Object.values(ptr).filter((id) => id === first).length, 1, "one counter points at the visit");
      assert.equal((await patient(db, second)).status, "waiting", "the loser did not take another patient");
      await assertConsistent(db);
    }
  });

  test("three doctors pick up concurrently and serve three different patients; one completes while two stay busy", async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await register(h, db, tokens.frontdesk, { name: `D1 trio ${i}`, service: SERVICES[i % 3] }));
    const backends = [h, await shared(db), await shared(db)];
    // Each doctor reads the head and calls it, retrying on a lost race, as a pickup button would.
    const pickup = async (backend, doctor) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const head = await queueHead(backend, docToken(tokens, doctor));
        const response = await call(backend, docToken(tokens, doctor), head.id);
        if (response.status === 200) return head.id;
      }
      throw new Error(`${doctor} could not pick up a patient`);
    };
    const picked = await Promise.all(DOCTORS.map((doctor, i) => pickup(backends[i], doctor)));
    assert.deepEqual([...picked].sort((a, b) => a - b), ids.slice(0, 3), "the three highest-ranked visits, each once");
    const ptr = await pointers(db);
    assert.deepEqual(DOCTORS.map((doctor) => ptr[doctor]), picked);
    for (const [i, doctor] of DOCTORS.entries()) assert.equal((await patient(db, picked[i])).counter_id, doctor);
    // A busy doctor cannot take a fourth patient.
    expectStatus(await call(h, tokens.frontdesk, ids[3], "Doctor 1"), 400, /already serving/);
    for (const [i, doctor] of DOCTORS.entries()) {
      expectStatus(await post(h, docToken(tokens, doctor), "/queue/accept", { patient_id: picked[i] }), 200);
      expectStatus(await post(h, docToken(tokens, doctor), "/queue/start", { patient_id: picked[i] }), 200);
    }
    const busy = { d1: await patient(db, picked[0]), d3: await patient(db, picked[2]) };
    expectStatus(await post(h, tokens.admin2, "/queue/complete", { patient_id: picked[1] }), 200);
    assert.deepEqual(await pointers(db), { "Doctor 1": picked[0], "Doctor 2": null, "Doctor 3": picked[2] });
    assert.deepEqual(await patient(db, picked[0]), busy.d1, "Doctor 1's consultation is unchanged");
    assert.deepEqual(await patient(db, picked[2]), busy.d3, "Doctor 3's consultation is unchanged");
    expectStatus(await call(h, tokens.frontdesk, ids[3], "Doctor 2"), 200);
    assert.equal((await patient(db, ids[3])).counter_id, "Doctor 2");
    await assertConsistent(db);
    evidence.threeDoctors = { picked, afterComplete: await pointers(db) };
  });

  test("W1 Cancel and F5 Requeue after flexible assignment release only the actual doctor's counter", async () => {
    const a = await register(h, db, tokens.frontdesk, { name: "D1 cancel A consultation" });
    const b = await register(h, db, tokens.frontdesk, { name: "D1 cancel B prenatal", service: "prenatal" });
    const c = await register(h, db, tokens.frontdesk, { name: "D1 cancel C family planning", service: "family_planning" });
    const w = await register(h, db, tokens.frontdesk, { name: "D1 cancel W waiting consultation" });
    expectStatus(await call(h, tokens.frontdesk, a, "Doctor 3"), 200); // consultation on Doctor 3
    expectStatus(await call(h, tokens.frontdesk, b, "Doctor 1"), 200); // prenatal on Doctor 1
    expectStatus(await call(h, tokens.frontdesk, c, "Doctor 2"), 200); // family planning on Doctor 2
    const bystanders = { b: await patient(db, b), c: await patient(db, c) };

    // The old service doctor of consultation (Doctor 1) does not own a consultation served by Doctor 3.
    expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: a, reason: "D1 wrong doctor" }), 403);
    // A doctor account never owns an uncalled shared-queue visit, even its old service doctor.
    expectStatus(await post(h, tokens.admin1, "/queue/cancel", { patient_id: w, reason: "D1 not yours" }), 403);
    // The doctor named in the request must match the stored doctor.
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: a, reason: "D1 mismatch", counter_id: "Doctor 1" }), 409);

    h.log.length = 0;
    expectStatus(await post(h, tokens.admin3, "/queue/cancel", { patient_id: a, reason: "D1 referred", counter_id: "Doctor 3" }), 200);
    assert.ok(h.rpcs().includes("cancel_patient_visit"), "W1 performed the cancellation");
    assert.deepEqual(await pointers(db), { "Doctor 1": b, "Doctor 2": c, "Doctor 3": null }, "only Doctor 3 was released");
    assert.deepEqual(await patient(db, b), bystanders.b);
    assert.deepEqual(await patient(db, c), bystanders.c);
    const cancelled = await patient(db, a);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.counter_id, "Doctor 3", "the treating doctor stays on the history");

    // Frontdesk cancels the uncalled visit while naming a doctor: nothing is stamped on it.
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: w, reason: "D1 left", counter_id: "Doctor 1" }), 200);
    assert.equal((await patient(db, w)).counter_id, null, "no doctor attributed to a visit nobody called");
    assert.deepEqual(await pointers(db), { "Doctor 1": b, "Doctor 2": c, "Doctor 3": null });

    // Requeue: back to the shared queue with no doctor, then callable by any free doctor.
    expectStatus(await post(h, tokens.admin1, "/queue/requeue", { patient_id: w }), 403, /re-queue/);
    expectStatus(await post(h, tokens.admin3, "/queue/requeue", { patient_id: a }), 200);
    const requeued = await patient(db, a);
    assert.deepEqual([requeued.status, requeued.counter_id, requeued.called_at], ["waiting", null, null]);
    assert.deepEqual(await pointers(db), { "Doctor 1": b, "Doctor 2": c, "Doctor 3": null });
    expectStatus(await call(h, tokens.frontdesk, a, "Doctor 3"), 200);
    expectStatus(await post(h, tokens.admin2, "/queue/complete", { patient_id: c }), 400, /Accept/);
    await assertConsistent(db);
    evidence.cancelRequeue = { cancelled: { status: cancelled.status, counter_id: cancelled.counter_id }, pointers: await pointers(db) };
  });

  test("offline, signed-out and unselected doctors are refused with nothing changed", async () => {
    const id = await register(h, db, tokens.frontdesk, { name: "D1 availability", service: "prenatal" });
    const before = await f.snapshot(db);
    expectStatus(await call(h, tokens.frontdesk, id), 400, /Select an available doctor/);
    expectStatus(await call(h, tokens.frontdesk, id, "Doctor 9"), 400, /not a valid doctor/);
    expectStatus(await call(h, tokens.admin1, id, "Doctor 2"), 403, /assigned to your doctor/);
    await db.observer.query("UPDATE public.counters SET is_online = false WHERE id_num = 'Doctor 2'");
    expectStatus(await call(h, tokens.frontdesk, id, "Doctor 2"), 400, /offline/);
    await db.observer.query("UPDATE public.counters SET is_online = true WHERE id_num = 'Doctor 2'");
    // Doctor 3 signs out; earlier tests' sessions for the same synthetic account are revoked too.
    expectStatus(await post(h, tokens.admin3, "/auth/logout", {}), 200);
    await db.observer.query("UPDATE public.staff_auth_sessions SET revoked_at = clock_timestamp() WHERE user_id_num = 'admin3' AND revoked_at IS NULL");
    expectStatus(await call(h, tokens.frontdesk, id, "Doctor 3"), 409, /not signed in/);
    const after = await f.snapshot(db);
    assert.deepEqual(after.patients, before.patients);
    assert.deepEqual(after.counters, before.counters);
    assert.deepEqual(effects(h, id), { sms: 0, awaiting: false, voice: 0 });

    // Registration needs one enabled doctor, not the old service doctor.
    await db.observer.query("UPDATE public.counters SET is_online = false WHERE id_num IN ('Doctor 2', 'Doctor 3')");
    await register(h, db, tokens.frontdesk, { name: "D1 prenatal while Doctor 2 offline", service: "prenatal" });
    await db.observer.query("UPDATE public.counters SET is_online = false");
    expectStatus(await post(h, tokens.frontdesk, "/queue", { fullName: "D1 nobody on duty", service_type: "consultation" }), 400, /No doctor is currently available/);
    expectStatus(await post(h, tokens.frontdesk, "/queue", { fullName: "D1 unknown service", service_type: "dental" }), 400, /offered services/);
    await db.observer.query("UPDATE public.counters SET is_online = true");
    expectStatus(await call(h, tokens.frontdesk, id, "Doctor 1"), 200);
    await assertConsistent(db);
  });

  test("the backend ranking matches call_patient_visit_shared on randomized queues with legacy reservations", async () => {
    const backend = h.queue;
    let seed = 20261029;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let round = 0; round < 12; round += 1) {
      await f.resetQueue(db);
      const ids = [];
      for (let i = 0; i < 7; i += 1) {
        const flags = random() < 0.4 ? [["senior", "pwd", "pregnant", "solo_parent"][Math.floor(random() * 4)]] : [];
        ids.push(await register(h, db, tokens.frontdesk, { name: `D1 parity ${round}.${i}`, service: SERVICES[Math.floor(random() * 3)], flags }));
      }
      // A legacy Phase 2.1 reservation: the visit waits with a doctor and that doctor's pointer.
      const reserved = ids[Math.floor(random() * ids.length)];
      const holder = DOCTORS[Math.floor(random() * 3)];
      await db.observer.query("UPDATE public.patients SET counter_id = $2 WHERE id = $1", [reserved, holder]);
      await db.observer.query("UPDATE public.counters SET current_patient_id = $1 WHERE id_num = $2", [reserved, holder]);
      const { rows } = await db.observer.query("SELECT * FROM public.patients WHERE status = 'waiting'");
      const waiting = rows.map((row) => ({ ...row, id: Number(row.id), created_at: new Date(row.created_at).toISOString() }));
      // Each attempt runs inside a transaction that is rolled back, so the queue never changes.
      const attempt = async (id, doctor) => {
        const row = await patient(db, id);
        await db.setup.query("BEGIN");
        try {
          await db.setup.query("SELECT (public.call_patient_visit_shared($1, $2, 'frontdesk', $3, $4, $5)).id",
            [id, doctor, row.visit_state_revision, new Date(Date.now() - 86400000), new Date(Date.now() + 86400000)]);
          return "called";
        } catch (error) {
          return error.message;
        } finally {
          await db.setup.query("ROLLBACK");
        }
      };
      for (const doctor of DOCTORS) {
        const expected = backend.getSharedQueueHead(waiting, doctor).id;
        if (expected === reserved) assert.equal(doctor, holder, "a reserved visit is only ever the reserving doctor's head");
        else assert.notEqual(expected, reserved);
        // The database accepts the backend's head (when the doctor's counter is free)...
        if (doctor !== holder || expected === reserved) assert.equal(await attempt(expected, doctor), "called", `round ${round}: ${doctor} -> ${expected}`);
        // ...and refuses every other waiting visit itself.
        for (const id of ids.filter((other) => other !== expected)) {
          assert.notEqual(await attempt(id, doctor), "called", `round ${round}: ${doctor} must not call ${id} before ${expected}`);
        }
      }
    }
  });

  test("records, analytics and the historical backlog keep service type and treating doctor apart", async () => {
    // Earlier-day history written as it would have been under the fixed mapping, plus a backlog row.
    await db.observer.query(`INSERT INTO public.patients (queue_number, id_num, service_type, status, counter_id, created_at, called_at, consultation_started_at, completed_at, priority_score)
      VALUES ('GP-901', 'D1 history consultation', 'consultation', 'completed', 'Doctor 1', now() - interval '3 days', now() - interval '3 days' + interval '5 minutes', now() - interval '3 days' + interval '6 minutes', now() - interval '3 days' + interval '20 minutes', 1),
             ('OB-902', 'D1 history backlog prenatal', 'prenatal', 'waiting', NULL, now() - interval '2 days', NULL, NULL, NULL, 1)`);
    const historyBefore = (await db.observer.query("SELECT * FROM public.patients WHERE queue_number IN ('GP-901', 'OB-902') ORDER BY id")).rows;

    const served = await register(h, db, tokens.frontdesk, { name: "D1 analytics prenatal on Doctor 3", service: "prenatal" });
    expectStatus(await call(h, tokens.frontdesk, served, "Doctor 3"), 200);
    expectStatus(await post(h, tokens.admin3, "/queue/accept", { patient_id: served }), 200);
    expectStatus(await post(h, tokens.admin3, "/queue/start", { patient_id: served }), 200);
    expectStatus(await post(h, tokens.admin3, "/queue/complete", { patient_id: served }), 200);
    const uncalled = await register(h, db, tokens.frontdesk, { name: "D1 analytics uncalled family planning", service: "family_planning" });
    expectStatus(await post(h, tokens.frontdesk, "/queue/cancel", { patient_id: uncalled, reason: "D1 left before call" }), 200);

    const analytics = (await h.request("GET", "/analytics", { token: tokens.superadmin, query: { dateFilter: "all" } })).body;
    const byDoctor = Object.fromEntries(analytics.doctorTable.map((row) => [row.doctor, row]));
    assert.equal(byDoctor["Doctor 3"].completed, 1, "the prenatal visit counts for Doctor 3, who treated it");
    assert.equal(byDoctor["Doctor 2"], undefined, "the old prenatal doctor gets no credit");
    assert.equal(byDoctor["Doctor 1"].completed, 1, "stored history keeps its doctor");
    assert.equal(byDoctor.Unassigned.total_patients, 2, "never-called visits have no treating doctor");
    const services = Object.fromEntries(analytics.tableData.map((row) => [row.service_type, row.total_patients]));
    assert.deepEqual(services, { consultation: 1, prenatal: 2, family_planning: 1 });

    const transactions = async (doctor) => (await h.request("GET", "/transactions", { token: tokens.superadmin, query: { doctor, dateFilter: "all" } })).body.transactions;
    assert.deepEqual((await transactions("Doctor 3")).map((row) => Number(row.id)), [served]);
    assert.deepEqual(await transactions("Doctor 2"), [], "prenatal visits are not attributed to Doctor 2 by service");

    const backlog = (await h.request("GET", "/queue/backlog", { token: tokens.superadmin })).body;
    assert.deepEqual(backlog.rows.map((row) => [row.queue_number, row.service_type, row.doctor, row.doctor_source]),
      [["OB-902", "prenatal", null, "unassigned"]]);
    // The shared queue never reaches into the backlog: today's window only.
    const today = await register(h, db, tokens.frontdesk, { name: "D1 today after backlog", service: "consultation" });
    expectStatus(await call(h, tokens.frontdesk, today, "Doctor 2"), 200);
    assert.deepEqual((await db.observer.query("SELECT * FROM public.patients WHERE queue_number IN ('GP-901', 'OB-902') ORDER BY id")).rows,
      historyBefore, "historical rows are unchanged");
    evidence.recordsAnalytics = { doctorTable: analytics.doctorTable.map(({ doctor, total_patients, completed }) => ({ doctor, total_patients, completed })), backlog: backlog.rows };
  });

  test("service mode is unchanged with D1 installed, and shared mode refuses to run without D1", async () => {
    const service = await f.backend(db);
    const id = await register(service, db, tokens.frontdesk, { name: "D1 service-mode prenatal", service: "prenatal" });
    expectStatus(await call(service, tokens.frontdesk, id, "Doctor 1"), 400, /assigned to Doctor 2/);
    service.log.length = 0;
    expectStatus(await call(service, tokens.frontdesk, id, "Doctor 2"), 200);
    assert.ok(service.rpcs().includes("call_patient_visit") && !service.rpcs().includes("call_patient_visit_shared"));
    assert.equal((await service.request("GET", "/queue", { token: tokens.frontdesk })).body.dispatch_mode, "service");

    const bare = await f.createDatabase("d1_missing", [C1.migration, F5.migration, W1.migration]);
    const hb = await shared(bare);
    const tb = await f.signInAll(hb);
    const waiting = await register(hb, bare, tb.frontdesk, { name: "D1 without migration" });
    const before = await f.snapshot(bare);
    expectStatus(await call(hb, tb.frontdesk, waiting, "Doctor 1"), 503, /D1 database migration/);
    const after = await f.snapshot(bare);
    assert.deepEqual(after.patients, before.patients);
    assert.deepEqual(after.counters, before.counters);
    assert.equal(await one(bare, "SELECT count(*)::int AS value FROM public.patients WHERE status = 'serving'"), 0);
  });
});
