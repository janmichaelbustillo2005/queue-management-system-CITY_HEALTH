const express = require("express");
const cors = require("cors");
const env = require("./config/env");
const routes = require("./routes");
const { seedCounters, requestDispatch, isRoundRobin } = require("./services/queueService");
const { startVoiceService } = require("./services/voiceServiceLauncher");
const { redactQueryValues } = require("./lib/requestLog");
const { loginLimiter, publicRegistrationLimiter } = require("./middleware/rateLimit");

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (env.frontendUrls.includes(origin)) {
        return callback(null, true);
      }

      // A hosted backend accepts only the configured frontend sites.
      if (env.isProduction) {
        return callback(new Error("Not allowed by CORS"));
      }

      if (origin === "http://localhost:3000") {
        return callback(null, true);
      }

      if (/^http:\/\/localhost:\d+$/u.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) {
        return callback(null, true);
      }

      // Allow local network URLs during development (e.g. http://192.168.x.x:3000)
      if (
        /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/u.test(origin) ||
        /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/u.test(origin) ||
        /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}:\d+$/u.test(origin)
      ) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${redactQueryValues(req.url)}`);
  next();
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/queue/website", publicRegistrationLimiter);

app.use("/api/records", require("./routes/records"));
app.use("/api", routes);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message: error.message || "Internal server error"
  });
});

app.listen(env.port, "0.0.0.0", async (error) => {
  if (error) {
    console.error(`Queue backend could not listen on port ${env.port}: ${error.code || error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Queue backend listening on http://0.0.0.0:${env.port}`);
  // Bring up the local voice announcer (or reuse a running one) without
  // delaying the API; the Queue Display retries until it reports ready.
  startVoiceService(env.voiceService);
  try {
    await seedCounters();
    console.log("Counters seeded successfully");
  } catch (error) {
    console.error("Error seeding counters:", error.message);
  }
  // RR1: the backend is the authority on presence. A doctor whose heartbeat stopped (closed tab,
  // lost network) is signed out by the 75-second presence window; this sweep then reassigns its
  // waiting patients to the doctors still available (or holds them as pending reassignment),
  // even when no one is using the screens.
  if (isRoundRobin()) {
    console.log(`Round-robin dispatch active; sweeping every ${env.dispatchSweepSeconds}s`);
    requestDispatch();
    setInterval(() => { requestDispatch(); }, env.dispatchSweepSeconds * 1000).unref();
  }
});
