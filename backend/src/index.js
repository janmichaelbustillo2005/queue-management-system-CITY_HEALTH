const express = require("express");
const cors = require("cors");
const env = require("./config/env");
const routes = require("./routes");
const { seedCounters } = require("./services/queueService");

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const allowed = [env.frontendUrl, "http://localhost:3000"];
      if (allowed.includes(origin)) {
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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use("/api", routes);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message: error.message || "Internal server error"
  });
});

app.listen(env.port, "0.0.0.0", async () => {
  console.log(`Queue backend listening on http://0.0.0.0:${env.port}`);
  try {
    await seedCounters();
    console.log("Counters seeded successfully");
  } catch (error) {
    console.error("Error seeding counters:", error.message);
  }
});
