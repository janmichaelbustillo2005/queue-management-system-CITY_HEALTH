const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const doctor = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };
const superadmin = { id_num: "superadmin", role: "superadmin", doctor_name: null };
const secret = "isolated-phase-a-route-test-secret";
function load(relative, imports) {
  const filename = path.resolve(__dirname, "../src", relative);
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { console, Date });
  wrapper((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

function harness() {
  const handlers = new Map(), sessions = new Map(), calls = [];
  const patients = [{ id: 41, status: "serving", counter_id: "Doctor 1", consultation_started_at: "2026-10-11T03:00:00Z", completed_at: null }];
  const counters = [{ id_num: "Doctor 1", is_online: true, current_patient_id: 41 }];
  let unavailable = false;
  const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const presence = {
    async createAuthSession(user, sessionId) {
      calls.push("create");
      if (unavailable) throw fail(503, "Authentication session storage is temporarily unavailable");
      const session = { ...user, session_id: sessionId, expires_at: new Date(Date.now() + 8 * 3600000).toISOString(), last_seen_at: new Date().toISOString() };
      sessions.set(sessionId, session);
      return session;
    },
    async validateAuthSession(claims) {
      calls.push("validate");
      if (unavailable) throw fail(503, "Authentication session storage is temporarily unavailable");
      const row = sessions.get(claims.jti);
      if (!row || row.revoked || row.id_num !== claims.id_num || row.role !== claims.role || row.doctor_name !== claims.doctor_name) {
        throw fail(401, "Authentication session expired or revoked");
      }
      return row;
    },
    async heartbeatAuthSession(claims) {
      calls.push(["heartbeat", claims]);
      return presence.validateAuthSession(claims);
    },
    async revokeAuthSession(claims) {
      calls.push(["revoke", claims]);
      sessions.get(claims.jti).revoked = true;
      return { revoked: true };
    },
    async getDoctorPresence() {
      calls.push("monitor");
      return { doctors: [{ doctor_name: "Doctor 1", online: [...sessions.values()].some((s) => s.id_num === "admin1" && !s.revoked), last_seen_at: null }], observed_at: new Date().toISOString(), timeout_seconds: 75 };
    }
  };
  const auth = load("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": { jwtSecret: secret }, "../services/presenceService": presence });
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (route, ...chain) => handlers.set(`${method.toUpperCase()} ${route}`, chain);
  }
  load("routes/index.js", {
    express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto,
    "../config/env": { jwtSecret: secret }, "../middleware/auth": auth,
    "../lib/businessDay": require("../src/lib/businessDay"), "../lib/wpsPriority": require("../src/lib/wpsPriority"),
    "../services/presenceService": presence,
    "../services/queueService": {
      loginUser: async (id, password) => {
        if (password !== "test-password") throw fail(401, "Invalid credentials");
        return { ...(id === "superadmin" ? superadmin : doctor), auth_revision: "private-account-revision" };
      },
      getCounters: async () => counters,
      getQueueOverview: async () => ({ patients, counters })
    },
    "../services/settingsService": {}
  });
  async function request(method, route, token, body = {}) {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body };
    const res = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; }, setHeader(name, value) { this.headers[name] = value; } };
    const chain = handlers.get(`${method} ${route}`);
    async function run(index) {
      if (chain[index]) await chain[index](req, res, () => run(index + 1));
    }
    await run(0);
    return res;
  }
  const login = async (id = "admin1") => request("POST", "/auth/login", null, { id_num: id, password: "test-password" });
  return { request, login, sessions, calls, patients, counters, setUnavailable: () => { unavailable = true; } };
}

test("verified custom login creates distinct server sessions and JWTs with database expiry", async () => {
  const h = harness();
  const a = await h.login(), b = await h.login();
  assert.equal(a.statusCode, 200);
  const claims = jwt.verify(a.body.token, secret);
  assert.equal(claims.id_num, doctor.id_num);
  assert.notEqual(claims.jti, jwt.verify(b.body.token, secret).jti);
  assert.equal(claims.exp, Math.floor(Date.parse(h.sessions.get(claims.jti).expires_at) / 1000));
  assert.equal(a.body.user.password, undefined);
  assert.equal(a.body.user.auth_revision, undefined);
  assert.equal(claims.auth_revision, undefined);
  assert.equal(a.headers["Cache-Control"], "no-store");
});

test("heartbeat and logout derive identity from the JWT and preserve a started consultation", async () => {
  const h = harness(), login = await h.login();
  const before = JSON.stringify([h.patients, h.counters]);
  const heartbeat = await h.request("POST", "/auth/heartbeat", login.body.token, { id_num: "admin3", doctor_name: "Doctor 3", last_seen_at: "2099-01-01" });
  assert.equal(heartbeat.statusCode, 200);
  assert.equal(h.calls.find((c) => Array.isArray(c) && c[0] === "heartbeat")[1].id_num, "admin1");
  assert.equal((await h.request("POST", "/auth/logout", login.body.token, { id_num: "admin3" })).statusCode, 200);
  assert.equal(JSON.stringify([h.patients, h.counters]), before);
  assert.equal((await h.request("POST", "/auth/heartbeat", login.body.token)).statusCode, 401);
  assert.equal((await h.request("GET", "/queue", login.body.token)).statusCode, 401);
});

test("monitoring permits only verified superadmin and logout retains another independent session", async () => {
  const h = harness(), a = await h.login(), b = await h.login(), admin = await h.login("superadmin");
  assert.equal((await h.request("GET", "/doctors/presence")).statusCode, 401);
  assert.equal((await h.request("GET", "/doctors/presence", a.body.token)).statusCode, 403);
  await h.request("POST", "/auth/logout", a.body.token);
  assert.equal((await h.request("POST", "/auth/heartbeat", b.body.token)).statusCode, 200);
  const monitoring = await h.request("GET", "/doctors/presence", admin.body.token);
  assert.equal(monitoring.statusCode, 200);
  assert.equal(monitoring.body.doctors[0].online, true);
  assert.equal(monitoring.headers["Cache-Control"], "no-store");
  await h.request("POST", "/auth/logout", b.body.token);
  assert.equal((await h.request("GET", "/doctors/presence", admin.body.token)).body.doctors[0].online, false);
});

test("invalid signatures and expired JWTs cannot reach session storage; legacy JWT requires re-login", async () => {
  const h = harness();
  for (const token of [jwt.sign(doctor, "wrong-test-secret"), jwt.sign({ ...doctor, exp: 1 }, secret), jwt.sign(doctor, secret, { algorithm: "HS384" })]) {
    assert.equal((await h.request("POST", "/auth/heartbeat", token)).statusCode, 403);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request("POST", "/auth/heartbeat", jwt.sign(doctor, secret))).statusCode, 401);
});

test("session lookup outages fail closed without clearing queue records or fabricating presence", async () => {
  const h = harness(), login = await h.login();
  h.setUnavailable();
  assert.equal((await h.request("GET", "/queue", login.body.token)).statusCode, 503);
  assert.equal((await h.login()).statusCode, 503);
  assert.equal(h.patients[0].status, "serving");
  assert.equal(h.counters[0].current_patient_id, 41);
});
