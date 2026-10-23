// Isolated route harness with the REAL JWT middleware, the REAL presenceService and the
// REAL queueService. Only the database is synthetic: queue tables come from the in-memory
// fake used by queueHarness, and validate_staff_auth_session is emulated over persisted
// synthetic accounts and sessions with the same checks as the Phase A SQL function.
// Never loads .env, dotenv or a Supabase client.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createHarness, clone } = require("./queueHarness");

const SECRET = "isolated-setup-route-test-secret";
const silentConsole = { log() {}, info() {}, warn() {}, error() {} };

function load(relative, imports) {
  const filename = path.resolve(__dirname, "../../src", relative);
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { console: silentConsole, Date });
  wrapper((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name} in ${relative}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

// `options.env` is the configuration object the middleware and routes receive (for A7,
// the real config/env.js output); by default a fixed isolated test secret is used.
function createRealAuthHarness(options = {}) {
  const h = createHarness(options);
  const { database } = h;
  const config = options.env || { jwtSecret: SECRET };
  const secret = config.jwtSecret;
  database.users.push({ id_num: "frontdesk2", role: "admin", doctor_name: "Front Desk" });
  // Synthetic credentials and account revisions so the real /auth/login path can run.
  // They are not the demo accounts' passwords and never leave this in-memory database.
  for (const user of database.users) {
    user.password = `synthetic-${user.id_num}-password`;
    user.auth_revision = crypto.randomUUID();
  }
  const sessions = new Map();
  const blank = (value) => (value == null || value === "" ? null : value);
  const denied = (message) => ({ data: null, error: { code: "42501", message } });

  // Mirrors the Phase A session functions (20261012-phase-a-auth-presence.sql).
  const supabase = {
    async rpc(name, args) {
      if (name === "create_staff_auth_session") {
        const user = database.users.find((row) => row.id_num === args.p_user_id_num);
        if (!user || user.auth_revision !== args.p_auth_revision || user.role !== args.p_role ||
            blank(user.doctor_name) !== blank(args.p_doctor_name)) {
          return denied("Authenticated account changed; sign in again");
        }
        const now = Date.now();
        const session = {
          session_id: args.p_session_id, user_id_num: user.id_num, role: user.role, doctor_name: blank(user.doctor_name),
          created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
          expires_at: new Date(now + 8 * 3600000).toISOString(), revoked_at: null
        };
        sessions.set(session.session_id, session);
        return { data: clone(session), error: null };
      }
      if (name === "revoke_staff_auth_session") {
        const session = sessions.get(args.p_session_id);
        if (session && session.user_id_num === args.p_user_id_num && !session.revoked_at) session.revoked_at = new Date().toISOString();
        return { data: true, error: null };
      }
      if (name !== "validate_staff_auth_session") return { data: null, error: { code: "PGRST202", message: `${name} is not part of this harness` } };
      const user = database.users.find((row) => row.id_num === args.p_user_id_num);
      if (!user || user.role !== args.p_role || blank(user.doctor_name) !== blank(args.p_doctor_name)) {
        return denied("Authenticated account changed; sign in again");
      }
      const session = sessions.get(args.p_session_id);
      if (!session || session.user_id_num !== args.p_user_id_num || session.role !== args.p_role ||
          session.doctor_name !== blank(args.p_doctor_name) || session.revoked_at ||
          Date.parse(session.expires_at) <= Date.now()) {
        return denied("Authentication session expired or revoked; sign in again");
      }
      return { data: clone(session), error: null };
    }
  };
  const presence = load("services/presenceService.js", { "../lib/supabase": supabase });
  const auth = load("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": config, "../services/presenceService": presence });

  const handlers = new Map();
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (route, ...chain) => handlers.set(`${method.toUpperCase()} ${route}`, chain);
  }
  load("routes/index.js", {
    express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto,
    "../config/env": config, "../lib/businessDay": require("../../src/lib/businessDay"),
    "../middleware/auth": auth, "../services/presenceService": presence,
    "../services/queueService": h.service, "../services/settingsService": h.settings
  });

  // Persists a session row for an existing synthetic account and signs its JWT,
  // exactly as POST /auth/login does (claims, jti and exp from the stored session).
  function signIn(idNum, { lifetimeMs = 8 * 3600000 } = {}) {
    const user = database.users.find((row) => row.id_num === idNum);
    if (!user) throw new Error(`Unknown synthetic account ${idNum}`);
    const now = Date.now();
    const session = {
      session_id: crypto.randomUUID(), user_id_num: user.id_num, role: user.role, doctor_name: blank(user.doctor_name),
      created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
      expires_at: new Date(now + lifetimeMs).toISOString(), revoked_at: null
    };
    sessions.set(session.session_id, session);
    const token = jwt.sign({
      id_num: user.id_num, role: user.role, doctor_name: user.doctor_name, jti: session.session_id,
      exp: Math.floor(Date.parse(session.expires_at) / 1000)
    }, secret, { algorithm: "HS256" });
    return { token, session };
  }

  function sign(claims, signingSecret = secret) {
    return jwt.sign({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, signingSecret, { algorithm: "HS256" });
  }

  async function request(method, route, { token, authorization, body = {} } = {}) {
    const chain = handlers.get(`${method.toUpperCase()} ${route}`);
    if (!chain) throw new Error(`Missing route ${method} ${route}`);
    const headers = {};
    if (authorization != null) headers.authorization = authorization;
    else if (token) headers.authorization = `Bearer ${token}`;
    const req = { headers, body, query: {}, params: {} };
    const res = {
      statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      json(data) { this.body = clone(data); return this; }, send(data) { this.body = data; return this; },
      setHeader(name, value) { this.headers[name] = value; return this; }
    };
    const run = async (index) => {
      const handler = chain[index];
      if (!handler) return;
      let nextResult;
      await handler(req, res, () => { nextResult = run(index + 1); return nextResult; });
      if (nextResult) await nextResult;
    };
    await run(0);
    return { status: res.statusCode, body: res.body, user: req.user || null };
  }

  return { ...h, sessions, signIn, sign, request, SECRET: secret };
}

module.exports = { createRealAuthHarness };
