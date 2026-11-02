const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

// Starts and supervises the local pyttsx3 voice announcer (backend/voice) so the
// Queue Display does not depend on someone running start-voice.cmd by hand.
// Only one instance may own the speakers: an already running, healthy service
// is reused, and a port held by another application is never taken over.

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const VOICE_DIR = path.join(PROJECT_ROOT, "backend", "voice");
const SERVICE_SCRIPT = path.join(VOICE_DIR, "pyttsx3_tts_service.py");
// Matches EXIT_PORT_IN_USE in pyttsx3_tts_service.py.
const EXIT_PORT_IN_USE = 3;
const HEALTH_TIMEOUT_MS = 3000;
const WARM_UP_TIMEOUT_MS = 15000;
const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 500;
const MONITOR_INTERVAL_MS = 10000;
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const STABLE_RUN_MS = 60000;
const STOP_PORT_RELEASE_MS = 5000; // after the process exits, how long stop() waits for the port to free
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_PREFIX = "[voice]";

function defaultPythonPath() {
  return process.platform === "win32"
    ? path.join(PROJECT_ROOT, ".venv-voice", "Scripts", "python.exe")
    : path.join(PROJECT_ROOT, ".venv-voice", "bin", "python");
}

function probeHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

// Classifies whatever answers on the voice port:
//   absent       - nothing is listening, so a service may be started
//   voice        - a pyttsx3 voice service answered /health
//   foreign      - another application owns the port
//   unresponsive - something accepted the connection but did not answer
function probeHealth(host, port, { init = false, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: probeHost(host),
      port,
      path: init ? "/health?init=1" : "/health",
      timeout: timeoutMs
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const health = JSON.parse(body);
          if (health?.engine === "pyttsx3") return resolve({ state: "voice", health });
        } catch (_error) {
          // Non-JSON answers belong to another application.
        }
        resolve({ state: "foreign", detail: `HTTP ${response.statusCode} from a non-voice application` });
      });
    });
    request.on("timeout", () => request.destroy(new Error("health check timed out")));
    request.on("error", (error) => {
      if (error.code === "ECONNREFUSED") return resolve({ state: "absent" });
      resolve({ state: "unresponsive", detail: error.message || error.code });
    });
  });
}

function openLog(filename) {
  try {
    if (fs.statSync(filename).size > MAX_LOG_BYTES) fs.renameSync(filename, `${filename}.1`);
  } catch (_error) {
    // A missing log is created below.
  }
  return fs.openSync(filename, "a");
}

function createVoiceServiceLauncher({
  host = "127.0.0.1",
  port = 8765,
  python = "",
  script = SERVICE_SCRIPT,
  extraArgs = [],
  logDir = VOICE_DIR,
  monitorIntervalMs = MONITOR_INTERVAL_MS,
  restartDelaysMs = RESTART_DELAYS_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  logger = console
} = {}) {
  const pythonPath = python || defaultPythonPath();
  const serviceUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const outLogPath = path.join(logDir, "voice-service.log");
  const errLogPath = path.join(logDir, "voice-service-error.log");
  let child = null;
  let childStartedAt = 0;
  let readyPid = null;
  let restartTimer = null;
  let monitorTimer = null;
  let restartAttempt = 0;
  let checking = null;
  let running = false;
  let lastReport = null;
  let spawnCount = 0;

  // Repeated monitor ticks report the same condition only once.
  function report(level, message) {
    if (message === lastReport) return;
    lastReport = message;
    logger[level](`${LOG_PREFIX} ${message}`);
  }

  function scheduleCheck(delayMs) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      ensureRunning();
    }, delayMs);
    restartTimer.unref?.();
  }

  function killChild() {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  function onChildExit(exited, code, signal) {
    if (child !== exited) return;
    const ranForMs = Date.now() - childStartedAt;
    child = null;
    readyPid = null;
    if (!running) return;
    if (code === EXIT_PORT_IN_USE) {
      // Another instance won the port. The next check reuses it if it is a
      // voice service, or reports the conflicting application.
      report("warn", `Another process already listens on ${serviceUrl}; not starting a second voice service.`);
      scheduleCheck(restartDelaysMs[0]);
      return;
    }
    if (ranForMs >= STABLE_RUN_MS) restartAttempt = 0;
    const delayMs = restartDelaysMs[Math.min(restartAttempt, restartDelaysMs.length - 1)];
    restartAttempt += 1;
    report("error", `Voice service stopped unexpectedly (${signal || `exit code ${code}`}). ` +
      `Restarting in ${Math.round(delayMs / 1000)}s. Details: ${errLogPath}`);
    scheduleCheck(delayMs);
  }

  async function waitUntilReady(started) {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = "the service did not answer";
    while (running && child === started && Date.now() < deadline) {
      const probe = await probeHealth(host, port, { init: true, timeoutMs: WARM_UP_TIMEOUT_MS });
      if (!running || child !== started) return;
      if (probe.state === "voice") {
        if (probe.health.ready === true && !probe.health.last_error) {
          readyPid = probe.health.process_id;
          report("log", `Voice service ready at ${serviceUrl} (PID ${readyPid}${probe.health.dry_run ? ", dry run: silent" : ""}).`);
          return;
        }
        lastError = probe.health.last_error || "pyttsx3 is not ready";
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    if (running && child === started) {
      report("error", `Voice service started but is not ready: ${lastError}. Details: ${errLogPath}`);
    }
  }

  function spawnService() {
    let out;
    let err;
    try {
      out = openLog(outLogPath);
      err = openLog(errLogPath);
      child = spawn(pythonPath, ["-u", script, "--host", host, "--port", String(port), ...extraArgs], {
        cwd: path.dirname(script),
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", out, err],
        windowsHide: true
      });
    } catch (error) {
      child = null;
      report("error", `Could not start the voice service: ${error.message}`);
      scheduleCheck(restartDelaysMs[restartDelaysMs.length - 1]);
      return;
    } finally {
      if (out !== undefined) fs.closeSync(out);
      if (err !== undefined) fs.closeSync(err);
    }
    const started = child;
    spawnCount += 1;
    childStartedAt = Date.now();
    started.once("error", (error) => {
      report("error", `Could not start the voice service with ${pythonPath}: ${error.message}`);
    });
    started.once("exit", (code, signal) => onChildExit(started, code, signal));
    report("log", `Starting voice service at ${serviceUrl} (logs: ${outLogPath}).`);
    waitUntilReady(started);
  }

  async function check() {
    const probe = await probeHealth(host, port);
    if (!running) return probe;
    if (probe.state === "voice") {
      if (!child) {
        report("log", `Reusing the voice service already running at ${serviceUrl} (PID ${probe.health.process_id}).`);
      }
      return probe;
    }
    if (probe.state === "foreign" || probe.state === "unresponsive") {
      report("error", `Port ${port} is in use by another application (${probe.detail}), so the voice service ` +
        `cannot start. Free the port or set PYTTSX3_TTS_PORT and NEXT_PUBLIC_PYTTSX3_TTS_URL to another port.`);
      return probe;
    }
    if (child) {
      // A live child that never begins listening is restarted by its exit handler.
      if (Date.now() - childStartedAt > readyTimeoutMs) {
        report("error", `Voice service did not open ${serviceUrl} within ${Math.round(readyTimeoutMs / 1000)}s; restarting it.`);
        killChild();
      }
      return probe;
    }
    if (restartTimer) return probe;
    if (!fs.existsSync(pythonPath)) {
      report("error", `Voice service Python environment not found at ${pythonPath}. Run once from the project root: ` +
        "py -3.13 -m venv .venv-voice && .venv-voice\\Scripts\\python.exe -m pip install -r backend\\voice\\requirements.txt");
      return probe;
    }
    spawnService();
    return probe;
  }

  function ensureRunning() {
    if (!running) return Promise.resolve(null);
    if (!checking) checking = check().finally(() => { checking = null; });
    return checking;
  }

  function start() {
    if (running) return ensureRunning();
    running = true;
    process.once("exit", killChild);
    monitorTimer = setInterval(ensureRunning, monitorIntervalMs);
    monitorTimer.unref?.();
    return ensureRunning();
  }

  function stop() {
    running = false;
    clearInterval(monitorTimer);
    clearTimeout(restartTimer);
    monitorTimer = null;
    restartTimer = null;
    process.removeListener("exit", killChild);
    const stopping = child;
    killChild();
    if (!stopping || stopping.exitCode !== null || stopping.signalCode !== null) return Promise.resolve();
    // On Windows a venv's python.exe is a launcher whose interpreter child may still hold the port
    // briefly after the launcher exits; wait (bounded) until the port is actually free, so a quick
    // restart does not mistake our own exiting service for another application.
    return new Promise((resolve) => stopping.once("exit", () => resolve())).then(async () => {
      const deadline = Date.now() + STOP_PORT_RELEASE_MS;
      while (Date.now() < deadline && (await probeHealth(host, port, { timeoutMs: 300 })).state !== "absent") {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  }

  return {
    start,
    stop,
    ensureRunning,
    status() {
      return { running, url: serviceUrl, childPid: child?.pid ?? null, readyPid, spawnCount };
    }
  };
}

function startVoiceService(config, logger = console) {
  if (!config?.autostart) {
    logger.log(`${LOG_PREFIX} Automatic voice service start is off (VOICE_SERVICE_AUTOSTART). ` +
      "Run start-voice.cmd on the Queue Display computer.");
    return null;
  }
  const launcher = createVoiceServiceLauncher({ ...config, logger });
  launcher.start().catch((error) => {
    logger.error(`${LOG_PREFIX} Voice service supervisor failed: ${error.message}`);
  });
  return launcher;
}

module.exports = { createVoiceServiceLauncher, startVoiceService, probeHealth, EXIT_PORT_IN_USE };
