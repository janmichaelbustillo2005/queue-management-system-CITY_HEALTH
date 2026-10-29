const path = require("path");
const dotenv = require("dotenv");

// The backend may be started from the repository root or the backend folder.
// Always load this service's configuration instead of the caller's directory.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// A7: JWT_SECRET signs every staff token, so there is no built-in fallback. These checks
// reject missing, sample and obviously weak values; they cannot prove randomness, so the
// value must come from a cryptographic generator (see README, "JWT signing secret").
// Error messages never include the value.
const JWT_SECRET_MIN_LENGTH = 43; // 32 random bytes in base64url
const JWT_SECRET_PLACEHOLDERS = ["changeme", "defaultsecret", "replaceme", "yoursecret", "yourjwtsecret", "placeholder"];
const JWT_SECRET_SAMPLES = ["secret", "jwtsecret", "mysecret", "supersecret", "example", "password", "test", "testsecret"];

function readJwtSecret(value) {
  const reject = (reason) => {
    const error = new Error(`Invalid JWT_SECRET in backend/.env: ${reason} Generate a new random secret as described in README.md ("JWT signing secret") and restart the backend. The configured value is not shown.`);
    error.code = "INVALID_JWT_SECRET";
    throw error;
  };
  if (typeof value !== "string" || !value.trim()) reject("it is missing or empty.");
  if (/\s/u.test(value)) reject("it contains whitespace; paste the generated value exactly.");
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (JWT_SECRET_SAMPLES.includes(normalized) || JWT_SECRET_PLACEHOLDERS.some((word) => normalized.includes(word))) {
    reject("it is a sample or placeholder value.");
  }
  if (value.length < JWT_SECRET_MIN_LENGTH) reject(`it must be at least ${JWT_SECRET_MIN_LENGTH} characters of generated random data.`);
  if (new Set(value).size < 10) reject("it is too repetitive to be a generated random value.");
  return value;
}

// D1: how a waiting visit reaches a doctor. "service" (the default, unchanged behavior) routes
// each service to its fixed doctor. "shared" (Model A, provisional, pending administrator and
// adviser approval) keeps one Weighted-Priority queue and stores the doctor chosen at Call; it
// needs backend/scripts/20261029-d1-shared-call.sql. Any other value stops the backend.
const DOCTOR_DISPATCH_MODES = ["service", "shared"];

function readDoctorDispatchMode(value) {
  const mode = String(value ?? "").trim().toLowerCase() || "service";
  if (!DOCTOR_DISPATCH_MODES.includes(mode)) {
    const error = new Error(`Invalid DOCTOR_DISPATCH_MODE in backend/.env: use ${DOCTOR_DISPATCH_MODES.join(" or ")}.`);
    error.code = "INVALID_DOCTOR_DISPATCH_MODE";
    throw error;
  }
  return mode;
}

const env = {
  port: Number(process.env.PORT || 4000),
  doctorDispatchMode: readDoctorDispatchMode(process.env.DOCTOR_DISPATCH_MODE),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  smsSenderName: process.env.SMS_SENDER_NAME || "Smart Queuing System",
  smsGatewayAddress: process.env.SMS_GATEWAY_ADDRESS || "",
  gatewayApiToken: (process.env.GATEWAY_API_TOKEN || "").trim(),
  jwtSecret: readJwtSecret(process.env.JWT_SECRET),
  // WPS-A (Weighted-Priority Scheduling with 10-minute Aging), proposed and off by default. It needs
  // the call_patient_visit_wps_a database function (backend/scripts/20261029-wps-a-call-aging.sql)
  // and policy approval; without the function, Calls are refused rather than ranked two ways.
  wpsAging: ["1", "true", "yes", "on"].includes(String(process.env.WPS_AGING || "").trim().toLowerCase()),
  // I2 Finding 8: when the C1 call_patient_visit function cannot be used, Call refuses (503,
  // nothing changed). Only a database that never had C1 (e.g. a local copy before
  // backend/scripts/20261025-c1-atomic-call.sql) may opt back into the older, non-atomic
  // two-statement Call. Never set this on a Supabase project where C1 is installed.
  allowLegacyTwoStepCall: ["1", "true", "yes", "on"].includes(String(process.env.ALLOW_LEGACY_TWO_STEP_CALL || "").trim().toLowerCase()),
  // The pyttsx3 voice announcer speaks on the computer that runs it. By default
  // the backend starts and supervises it on Windows; set VOICE_SERVICE_AUTOSTART=0
  // when the Queue Display speakers belong to a different computer.
  voiceService: {
    autostart: process.env.VOICE_SERVICE_AUTOSTART
      ? ["1", "true", "yes", "on"].includes(process.env.VOICE_SERVICE_AUTOSTART.trim().toLowerCase())
      : process.platform === "win32",
    host: process.env.PYTTSX3_TTS_HOST || "127.0.0.1",
    port: Number(process.env.PYTTSX3_TTS_PORT || 8765),
    python: process.env.VOICE_SERVICE_PYTHON || ""
  }
};

module.exports = env;
