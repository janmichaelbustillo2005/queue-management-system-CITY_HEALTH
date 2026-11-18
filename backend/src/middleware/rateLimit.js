const { rateLimit } = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { canRegisterPatients } = require("../services/queueService");

// Keys avoid the client IP on purpose: a whole office shares one public address, and the host's
// proxies make the address unreliable. Counts live in this process, so a restart clears them.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const REGISTRATION_WINDOW_MS = 60 * 1000;
const REGISTRATION_MAX_PER_ACCOUNT = 60;

function limitResponse(message) {
  return (_req, res, _next, options) => {
    res.status(options.statusCode).json({ success: false, message });
  };
}

// Limits password guessing per account. Successful logins do not count.
const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_MAX_FAILURES,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => String(req.body?.id_num ?? "").trim().toLowerCase(),
  handler: limitResponse("Too many failed sign-in attempts for this account. Wait 15 minutes and try again.")
});

// Patient registration (POST /api/queue and /api/queue/website) is staff-only: the routes answer 401
// without a valid session and 403 for an account that may not register. The limit is therefore kept
// per signed-in registering account, so no account (and no anonymous caller) can use up another
// account's allowance, and there is no office-wide bottleneck. Only a token with a valid signature
// whose account may register is counted; everything else is skipped here and refused by the route
// before anything is saved.
function registeringAccount(req) {
  const token = String(req.headers?.authorization ?? "").match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return null;
  let claims;
  try {
    claims = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
  } catch (_error) {
    return null;
  }
  const account = typeof claims?.id_num === "string" ? claims.id_num.trim() : "";
  return account && canRegisterPatients(claims) ? account : null;
}

const registrationLimiter = rateLimit({
  windowMs: REGISTRATION_WINDOW_MS,
  limit: REGISTRATION_MAX_PER_ACCOUNT,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: (req) => registeringAccount(req) == null,
  keyGenerator: (req) => `registration:${registeringAccount(req)}`,
  handler: limitResponse("Too many registrations from this account in the last minute. Please wait a moment and try again.")
});

// RES2: Google Places searches are billed, so the whole office shares one ceiling. The form waits
// for a pause in typing before searching, so normal use stays far below it.
const ADDRESS_SEARCH_WINDOW_MS = 60 * 1000;
const ADDRESS_SEARCH_MAX = 120;
const addressSearchLimiter = rateLimit({
  windowMs: ADDRESS_SEARCH_WINDOW_MS,
  limit: ADDRESS_SEARCH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: () => "address-search",
  handler: limitResponse("Map search is busy right now. Choose the barangay from the list, or enter the address manually.")
});

module.exports = { loginLimiter, registrationLimiter, registeringAccount, addressSearchLimiter };
