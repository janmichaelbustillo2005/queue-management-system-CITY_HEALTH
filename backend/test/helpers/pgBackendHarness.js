// The REAL Express routes, JWT middleware, presenceService, queueService and settingsService,
// wired to a real PostgreSQL database through pgRestClient (service_role, autocommit, PostgREST
// error codes). Only three things are substituted: Express itself (handlers are invoked
// directly), SMS delivery (recorded, never sent) and the settings/acceptance/voice JSON files
// (an in-memory file system). Sessions, accounts, queue rows and every RPC are real SQL.
// Never loads .env, dotenv or the Supabase client.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { createPgRestClient } = require("./pgRestClient");

const backendDir = path.resolve(__dirname, "../..");
const SECRET = "isolated-pg-backend-harness-secret";
const silentConsole = { log() {}, info() {}, warn() {}, error() {} };
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function load(relative, imports, DateImpl = Date) {
  const filename = path.join(backendDir, "src", relative);
  const module = { exports: {} };
  const context = vm.createContext({ console: silentConsole, Date: DateImpl, Intl, setTimeout, clearTimeout, process: { env: {} } });
  const wrapper = new vm.Script(`(function(require, module, exports, __dirname, __filename) {\n${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  wrapper.runInContext(context)((name) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name} in ${relative}`);
    return imports[name];
  }, module, module.exports, path.dirname(filename), filename);
  return module.exports;
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    existsSync: (file) => files.has(file),
    mkdirSync: (file) => files.set(file, ""),
    readFileSync: (file) => { if (!files.has(file)) throw new Error(`Missing virtual file ${file}`); return files.get(file); },
    writeFileSync: (file, contents) => files.set(file, contents)
  };
}

// A Date whose clock runs `offsetMs` from the real one, as on a backend host whose clock is
// not synchronized with the database server.
function skewedDate(offsetMs) {
  if (!offsetMs) return Date;
  return class SkewedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(Date.now() + offsetMs); }
    static now() { return Date.now() + offsetMs; }
  };
}

// `pool` must already connect as the API role (see pgRestClient). `onRequest` may pause or
// observe any database request the backend makes (used to force interleavings).
// `clockOffsetMs` shifts the backend's clock relative to PostgreSQL's; `envOverrides` adds
// backend configuration (e.g. { wpsAging: true }).
function createPgBackendHarness(pool, { onRequest, clockOffsetMs = 0, envOverrides = {} } = {}) {
  const DateImpl = skewedDate(clockOffsetMs);
  const supabase = createPgRestClient(pool, { onRequest: (request) => (onRequest ? onRequest(request) : undefined) });
  const env = { jwtSecret: SECRET, supabaseUrl: "https://isolated-pg-harness.invalid", supabaseServiceRoleKey: "isolated", ...envOverrides };
  const virtualFs = memoryFs();
  const sms = [];
  const settings = load("services/settingsService.js", { fs: virtualFs, path, crypto }, DateImpl);
  const presence = load("services/presenceService.js", { "../lib/supabase": supabase }, DateImpl);
  const queue = load("services/queueService.js", {
    "../lib/supabase": supabase, "../config/env": env, bcryptjs: bcrypt,
    "../lib/businessDay": require("../../src/lib/businessDay"), "../lib/wpsPriority": require("../../src/lib/wpsPriority"), "node:crypto": crypto,
    "./notificationService": {
      sendQueueCreatedNotification: (...args) => sms.push({ type: "created", args }),
      sendQueueCalledNotification: async (...args) => sms.push({ type: "called", args })
    },
    "./settingsService": settings
  }, DateImpl);
  const auth = load("middleware/auth.js", { jsonwebtoken: jwt, "../config/env": env, "../services/presenceService": presence }, DateImpl);
  const handlers = new Map();
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (route, ...chain) => handlers.set(`${method.toUpperCase()} ${route}`, chain);
  }
  load("routes/index.js", {
    express: { Router: () => router }, jsonwebtoken: jwt, "node:crypto": crypto, "../config/env": env,
    "../lib/businessDay": require("../../src/lib/businessDay"), "../lib/wpsPriority": require("../../src/lib/wpsPriority"), "../middleware/auth": auth,
    "../services/presenceService": presence, "../services/queueService": queue, "../services/settingsService": settings
  }, DateImpl);

  // `route` is the registered pattern (e.g. "/queue/backlog/:id"); `params` fills it.
  async function request(method, route, { token, body = {}, query = {}, params = {} } = {}) {
    const chain = handlers.get(`${method.toUpperCase()} ${route}`);
    if (!chain) throw new Error(`Missing route ${method} ${route}`);
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body, query, params };
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
    return { status: res.statusCode, body: res.body };
  }

  // Real POST /auth/login: bcrypt check, create_staff_auth_session, signed JWT.
  async function login(idNum, password) {
    const response = await request("POST", "/auth/login", { body: { id_num: idNum, password } });
    if (response.status !== 200) throw new Error(`login ${idNum}: ${response.status} ${response.body?.message}`);
    return { token: response.body.token, jti: jwt.decode(response.body.token).jti };
  }

  return { request, login, queue, settings, presence, sms, virtualFs, supabase, SECRET };
}

module.exports = { createPgBackendHarness };
