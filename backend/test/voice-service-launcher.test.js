const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createVoiceServiceLauncher, probeHealth, EXIT_PORT_IN_USE } = require("../src/services/voiceServiceLauncher");

// These tests run the real pyttsx3 service in --dry-run mode on spare ports, so
// they exercise process supervision without playing audio or touching port 8765.
const PYTHON = process.platform === "win32"
  ? path.resolve(__dirname, "../../.venv-voice/Scripts/python.exe")
  : path.resolve(__dirname, "../../.venv-voice/bin/python");
const SCRIPT = path.resolve(__dirname, "../voice/pyttsx3_tts_service.py");
const skip = fs.existsSync(PYTHON) ? false : "project .venv-voice is not installed";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function quietLogger() {
  const lines = [];
  const push = (line) => lines.push(line);
  return { lines, log: push, warn: push, error: push };
}

async function waitFor(condition, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

function launcherFor(port, logger, overrides = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-launcher-test-"));
  return createVoiceServiceLauncher({
    port, python: PYTHON, script: SCRIPT, extraArgs: ["--dry-run"], logDir, logger,
    monitorIntervalMs: 200, restartDelaysMs: [200], ...overrides
  });
}

test("starts one ready voice service, and a second supervisor reuses it instead of starting a duplicate", { skip, timeout: 60000 }, async () => {
  const port = await freePort();
  const firstLogger = quietLogger();
  const secondLogger = quietLogger();
  const first = launcherFor(port, firstLogger);
  const second = launcherFor(port, secondLogger);
  try {
    await first.start();
    await waitFor(() => first.status().readyPid);
    const { health } = await probeHealth("127.0.0.1", port);
    assert.equal(health.engine, "pyttsx3");
    assert.equal(health.ready, true);
    assert.equal(health.process_id, first.status().readyPid);

    await second.start();
    // Under heavy test load the first health check can be slow; the monitor
    // re-checks every 200 ms, so wait for the reuse rather than a fixed delay.
    await waitFor(() => secondLogger.lines.some((line) => /Reusing the voice service/.test(line)));
    assert.equal(second.status().spawnCount, 0);
    assert.equal(first.status().spawnCount, 1);
  } finally {
    await second.stop();
    await first.stop();
  }
  assert.equal((await probeHealth("127.0.0.1", port)).state, "absent", "stop() must shut the service down");
});

test("a voice service started directly on an occupied port exits instead of sharing the speakers", { skip, timeout: 60000 }, async () => {
  const port = await freePort();
  const launcher = launcherFor(port, quietLogger());
  try {
    await launcher.start();
    await waitFor(() => launcher.status().readyPid);
    const duplicate = spawn(PYTHON, [SCRIPT, "--port", String(port), "--dry-run"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    duplicate.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => duplicate.once("exit", resolve));
    assert.equal(code, EXIT_PORT_IN_USE);
    assert.match(stderr, /no second instance was started/);
    const { health } = await probeHealth("127.0.0.1", port);
    assert.equal(health.process_id, launcher.status().readyPid);
  } finally {
    await launcher.stop();
  }
});

test("restarts the voice service after it stops unexpectedly", { skip, timeout: 60000 }, async () => {
  const port = await freePort();
  const logger = quietLogger();
  const launcher = launcherFor(port, logger);
  try {
    await launcher.start();
    const firstPid = await waitFor(() => launcher.status().readyPid);
    process.kill(firstPid);
    const secondPid = await waitFor(() => {
      const pid = launcher.status().readyPid;
      return pid && pid !== firstPid ? pid : null;
    });
    assert.notEqual(secondPid, firstPid);
    assert.equal(launcher.status().spawnCount, 2);
    assert.ok(logger.lines.some((line) => /stopped unexpectedly.*Restarting/.test(line)));
  } finally {
    await launcher.stop();
  }
});

test("never starts a voice service on a port owned by another application", { skip, timeout: 30000 }, async () => {
  const foreign = http.createServer((_req, res) => { res.end("not a voice service"); });
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const logger = quietLogger();
  const launcher = launcherFor(foreign.address().port, logger);
  try {
    await launcher.start();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(launcher.status().spawnCount, 0);
    assert.equal(logger.lines.filter((line) => /in use by another application/.test(line)).length, 1,
      "the conflict is reported once, not on every monitor tick");
  } finally {
    await launcher.stop();
    await new Promise((resolve) => foreign.close(resolve));
  }
});

test("reports setup instructions when the voice Python environment is missing", { timeout: 30000 }, async () => {
  const logger = quietLogger();
  const launcher = launcherFor(await freePort(), logger, { python: path.join(os.tmpdir(), "missing-voice-venv", "python.exe") });
  try {
    await launcher.start();
    assert.equal(launcher.status().spawnCount, 0);
    assert.match(logger.lines.join("\n"), /Python environment not found.*pip install -r backend\\voice\\requirements\.txt/);
  } finally {
    await launcher.stop();
  }
});
