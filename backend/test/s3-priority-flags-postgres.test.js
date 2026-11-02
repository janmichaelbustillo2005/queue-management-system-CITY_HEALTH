// S3: Weighted-Priority input integrity at registration, through the REAL backend on disposable
// PostgreSQL 17 (helpers/c1f5w1Fixture.js). /queue/website is public (the registration page
// also serves patients without a staff login), so the priority score must not be inflatable
// by repeating or inventing flags, and Senior Citizen follows the birthdate (FRS-01: 60 or older
// on the Manila business date), as the registration form already computes it.
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const f = require("./helpers/c1f5w1Fixture");
const { getBusinessDate } = require("../src/lib/businessDay");

before(async () => { if (!f.unavailable) await f.startCluster(); });
after(f.stopCluster);

// Birthdate exactly `years` before today's Manila date, shifted by `days`.
function birthdateYearsAgo(years, days = 0) {
  const [y, m, d] = getBusinessDate().split("-").map(Number);
  const date = new Date(Date.UTC(y - years, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

describe("S3: registration priority flags", { skip: f.unavailable }, () => {
  let db; let h; let tokens;
  before(async () => { db = await f.createDatabase("s3_priority_flags", [f.C1.migration]); });
  beforeEach(async () => {
    await f.resetQueue(db);
    h = await f.backend(db);
    tokens = await f.signInAll(h);
  });

  const register = (body, { route = "/queue/website", token } = {}) => h.request("POST", route, { token, body: {
    fullName: "Synthetic S3", serviceType: "consultation", service_type: "consultation", ...body } });
  const stored = async (response) => (await f.one(db, "SELECT row_to_json(p) AS value FROM public.patients p WHERE queue_number = $1",
    [response.body.queue_number]));

  test("repeated flags count once (public and staff routes)", async () => {
    for (const options of [{}, { route: "/queue", token: tokens.frontdesk }]) {
      const response = await register({ vulnerabilityFlags: ["pwd", "pwd", "pwd", "solo_parent", "solo_parent"] }, options);
      assert.equal(response.status, 200, response.body?.message);
      assert.equal(response.body.priority_score, 4);
      const row = await stored(response);
      assert.equal(row.priority_score, 4);
      assert.deepEqual(row.vulnerability_flags, ["pwd", "solo_parent"]);
    }
  });

  test("unknown flags, non-array flags and non-string entries are refused before anything is stored", async () => {
    for (const vulnerabilityFlags of [["vip"], ["senior", "emergency"], "senior", { senior: true }, [4], [null]]) {
      const response = await register({ vulnerabilityFlags });
      assert.equal(response.status, 400, JSON.stringify(vulnerabilityFlags));
      assert.match(response.body.message, /priority categor/i);
    }
    assert.equal(Number(await f.one(db, "SELECT count(*) AS value FROM public.patients")), 0);
  });

  test("Senior must agree with the birthdate: kept at 60 or older, refused when younger, never added", async () => {
    for (const [birthdate, flags] of [[birthdateYearsAgo(60, 1), ["senior"]], [birthdateYearsAgo(31), ["senior", "pwd"]]]) {
      const refused = await register({ birthdate, vulnerabilityFlags: flags });   // first: turns 60 tomorrow
      assert.equal(refused.status, 400, birthdate);
      assert.match(refused.body.message, /Senior Citizen priority requires age 60/);
    }
    assert.equal(Number(await f.one(db, "SELECT count(*) AS value FROM public.patients")), 0);
    const cases = [
      [birthdateYearsAgo(60), ["senior"], 4, ["senior"]],   // 60th birthday today
      [birthdateYearsAgo(71), ["senior", "pwd"], 7, ["senior", "pwd"]],
      [birthdateYearsAgo(31), ["pwd"], 3, ["pwd"]],
      [birthdateYearsAgo(65), ["pwd"], 3, ["pwd"]]          // the form ticks Senior; the backend does not add it
    ];
    for (const [birthdate, flags, score, storedFlags] of cases) {
      const response = await register({ birthdate, vulnerabilityFlags: flags });
      assert.equal(response.status, 200, response.body?.message);
      assert.equal(response.body.priority_score, score, `${birthdate} ${flags}`);
      const row = await stored(response);
      assert.equal(row.priority_score, score);
      assert.deepEqual([...row.vulnerability_flags].sort(), [...storedFlags].sort());
    }
  });

  test("without a birthdate the staff-entered Senior flag is kept; malformed or future birthdates are refused", async () => {
    const kept = await register({ vulnerabilityFlags: ["senior"] }, { route: "/queue", token: tokens.frontdesk });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.priority_score, 4);
    for (const birthdate of ["1955-02-30", "10/03/1955", "tomorrow", birthdateYearsAgo(0, 1)]) {
      const response = await register({ birthdate });
      assert.equal(response.status, 400, birthdate);
      assert.match(response.body.message, /birthdate/i);
    }
  });

  test("the maximum score is the sum of each distinct category once", async () => {
    const response = await register({ birthdate: birthdateYearsAgo(70),
      vulnerabilityFlags: ["senior", "pwd", "pregnant", "indigenous", "solo_parent", "pwd", "senior"] });
    assert.equal(response.status, 200);
    assert.equal(response.body.priority_score, 13);
  });
});
