const { rateLimit } = require("express-rate-limit");

// Keys avoid the client IP on purpose: a whole office shares one public address, and the host's
// proxies make the address unreliable. Counts live in this process, so a restart clears them.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const PUBLIC_REGISTRATION_WINDOW_MS = 60 * 1000;
const PUBLIC_REGISTRATION_MAX = 60;

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

// One shared limit for the unauthenticated registration form.
const publicRegistrationLimiter = rateLimit({
  windowMs: PUBLIC_REGISTRATION_WINDOW_MS,
  limit: PUBLIC_REGISTRATION_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: () => "public-registration",
  handler: limitResponse("Registration is busy right now. Please try again in a minute.")
});

module.exports = { loginLimiter, publicRegistrationLimiter };
