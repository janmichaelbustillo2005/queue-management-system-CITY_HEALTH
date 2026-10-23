const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../pages/queue-display.js"), "utf8").replace(/\r\n/g, "\n");
const recoveryFunctions = fs.readFileSync(path.join(__dirname, "../lib/announcementRecovery.js"), "utf8")
  .replace(/\bexport (?=const|function)/g, "");

// Execute the existing non-JSX functions directly. The local pyttsx3 HTTP service
// and React state setters are test doubles; this verifies event handling and
// request payloads, not audible playback or Python service availability.
function sourceSection(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing display source section: ${start}`);
  return source.slice(startIndex, endIndex);
}

const displayFunctions = [
  sourceSection("function getAnnouncementStorage()", "function getStoredAnnounceGapMs()"),
  sourceSection("function getStoredAnnounceGapMs()", "async function fetchJsonWithTimeout("),
  sourceSection("  function startDisplayListener()", "  function seedKnownCalls("),
  sourceSection("  function seedKnownCalls(", "  async function checkPyttsx3Service("),
  sourceSection("  async function enableVoiceAnnouncer()", "  function disableVoiceAnnouncer("),
  sourceSection("  function disableVoiceAnnouncer(", "  function enqueueNewCalls("),
  sourceSection("  function enqueueNewCalls(", "  function delay("),
  sourceSection("  function sendPyttsx3Announcement(", "  const matchesDoctor ="),
  sourceSection("  async function loadDisplay(", "  const formatTime =")
].join("\n");

function voiceHealthHarness(initialResponse = { engine: "pyttsx3", ready: true, dry_run: false }) {
  let response = initialResponse;
  const requests = [];
  const readiness = [];
  const statuses = [];
  const voiceStates = [];
  const refs = {
    displayActiveRef: { current: true },
    playbackGenerationRef: { current: 0 },
    voiceEnableAttemptRef: { current: 0 },
    ttsMonitorActiveRef: { current: true },
    ttsHealthCheckPendingRef: { current: false },
    ttsHealthRequestSequenceRef: { current: 0 },
    ttsReadyRef: { current: null },
    voiceEnabledRef: { current: true },
    seededRef: { current: true },
    activeAnnouncementKeyRef: { current: null },
    queuedKeysRef: { current: new Set() },
    isProcessingRef: { current: false },
    announcementQueueRef: { current: [] }
  };
  const settings = { voiceAllowed: true };
  const context = vm.createContext({
    ...refs,
    PYTTSX3_TTS_BASE_URL: "http://isolated-tts.test",
    PYTTSX3_HEALTH_TIMEOUT_MS: 6500,
    voiceAnnouncementsAllowed() { return settings.voiceAllowed; },
    logTts() {},
    setTtsReady(value) { readiness.push(value); },
    setVoiceStatus(value) { statuses.push(value); },
    setVoiceEnabled(value) { voiceStates.push(value); },
    setIsSpeaking() {}, rememberAnnouncementRecovery() {},
    async fetchJsonWithTimeout(url, options, timeoutMs) {
      requests.push({ url, options, timeoutMs });
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response() : response;
    }
  });
  vm.runInContext(sourceSection("  async function checkPyttsx3Service(", "  function isAnnouncementEligible(") +
    "\nthis.healthApi = { checkPyttsx3Service, verifyTtsService, enableVoiceAnnouncer, disableVoiceAnnouncer };", context);
  return { api: context.healthApi, refs, settings, requests, readiness, statuses, voiceStates,
    respond(value) { response = value; } };
}

test("idle health monitoring recovers an offline service and avoids warming an already healthy engine", async () => {
  const h = voiceHealthHarness(new Error("Cannot reach local voice service"));
  await h.api.verifyTtsService();
  assert.equal(h.refs.ttsReadyRef.current, false);
  assert.match(h.statuses.at(-1), /offline: Cannot reach local voice service.*Retrying automatically/);

  h.respond({ engine: "pyttsx3", ready: true, dry_run: false });
  await h.api.verifyTtsService();
  assert.equal(h.refs.ttsReadyRef.current, true);
  assert.match(h.statuses.at(-1), /Voice service ready/);
  await h.api.verifyTtsService();
  assert.deepEqual(h.requests.map(({ url }) => url), [
    "http://isolated-tts.test/health?init=1",
    "http://isolated-tts.test/health?init=1",
    "http://isolated-tts.test/health"
  ]);
  assert.deepEqual(h.readiness, [false, true, true]);
});

test("silent test mode and missing readiness cannot be reported as an audible voice service", async () => {
  const h = voiceHealthHarness({ engine: "pyttsx3", ready: true, dry_run: true });
  await assert.rejects(h.api.checkPyttsx3Service(), /silent test mode.*without --dry-run/);
  assert.equal(h.refs.ttsReadyRef.current, false);
  h.respond({ engine: "pyttsx3" });
  await assert.rejects(h.api.checkPyttsx3Service(), /service is not ready/);
});

test("real health handling keeps newer Enable success ready after the older Enable fails", async () => {
  const pending = [];
  const h = voiceHealthHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  h.refs.voiceEnabledRef.current = false;
  const older = h.api.enableVoiceAnnouncer();
  const newer = h.api.enableVoiceAnnouncer();
  pending[1].resolve({ engine: "pyttsx3", ready: true, dry_run: false });
  await newer;
  const status = h.statuses.at(-1);
  pending[0].reject(new Error("stale Enable failure"));
  await older;
  assert.equal(h.refs.voiceEnabledRef.current, true);
  assert.equal(h.refs.ttsReadyRef.current, true);
  assert.deepEqual(h.readiness, [true]);
  assert.deepEqual(h.voiceStates, [true]);
  assert.equal(h.statuses.at(-1), status);
});

test("an older successful health response cannot overwrite a newer failure", async () => {
  const pending = [];
  const h = voiceHealthHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const older = h.api.checkPyttsx3Service();
  const newer = h.api.checkPyttsx3Service();
  const failed = assert.rejects(newer, /current failure/);
  pending[1].reject(new Error("current failure"));
  await failed;
  pending[0].resolve({ engine: "pyttsx3", ready: true, dry_run: false });
  await older;
  assert.equal(h.refs.ttsReadyRef.current, false);
  assert.deepEqual(h.readiness, [false]);
});

test("an older idle health failure cannot overwrite a newer Enable readiness or status", async () => {
  const pending = [];
  const h = voiceHealthHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const idle = h.api.verifyTtsService();
  const enabled = h.api.enableVoiceAnnouncer();
  pending[1].resolve({ engine: "pyttsx3", ready: true, dry_run: false });
  await enabled;
  const statuses = [...h.statuses];
  pending[0].reject(new Error("stale idle failure"));
  await idle;
  assert.equal(h.refs.ttsReadyRef.current, true);
  assert.equal(h.refs.voiceEnabledRef.current, true);
  assert.deepEqual(h.readiness, [true]);
  assert.deepEqual(h.statuses, statuses);
  assert.equal(h.refs.ttsHealthCheckPendingRef.current, false);
});

test("Pause invalidates readiness as well as Voice changes from a pending real Enable check", async () => {
  let resolve;
  const h = voiceHealthHarness(() => new Promise(done => { resolve = done; }));
  const enabled = h.api.enableVoiceAnnouncer();
  h.api.disableVoiceAnnouncer();
  const statuses = [...h.statuses];
  resolve({ engine: "pyttsx3", ready: true, dry_run: false });
  await enabled;
  assert.equal(h.refs.voiceEnabledRef.current, false);
  assert.equal(h.refs.ttsReadyRef.current, null);
  assert.deepEqual(h.readiness, []);
  assert.deepEqual(h.voiceStates, [false]);
  assert.deepEqual(h.statuses, statuses);
});

test("unmounted displays ignore both success and failure from real health checks", async () => {
  for (const fail of [false, true]) {
    let finish;
    const h = voiceHealthHarness(() => new Promise((resolve, reject) => { finish = fail ? reject : resolve; }));
    const check = h.api.verifyTtsService();
    h.refs.ttsMonitorActiveRef.current = false;
    h.refs.displayActiveRef.current = false;
    finish(fail ? new Error("late failure") : { engine: "pyttsx3", ready: true, dry_run: false });
    await check;
    assert.deepEqual(h.readiness, []);
    assert.deepEqual(h.statuses, []);
    assert.equal(h.refs.ttsReadyRef.current, null);
  }
});

test("idle health monitoring leaves paused, globally disabled, busy and unmounted displays alone", async () => {
  const block = [
    h => { h.refs.voiceEnabledRef.current = false; },
    h => { h.settings.voiceAllowed = false; },
    h => { h.refs.isProcessingRef.current = true; },
    h => { h.refs.announcementQueueRef.current.push({ key: "queued" }); },
    h => { h.refs.ttsMonitorActiveRef.current = false; }
  ];
  for (const disableMonitoring of block) {
    const idle = voiceHealthHarness();
    disableMonitoring(idle);
    await idle.api.verifyTtsService();
    assert.equal(idle.requests.length, 0);
    assert.equal(idle.statuses.length, 0);

    let finishHealth;
    const pending = voiceHealthHarness(() => new Promise(resolve => { finishHealth = resolve; }));
    const firstCheck = pending.api.verifyTtsService();
    await pending.api.verifyTtsService();
    assert.equal(pending.requests.length, 1, "Only one idle health request may run at a time");
    disableMonitoring(pending);
    finishHealth({ engine: "pyttsx3", ready: true, dry_run: false });
    await firstCheck;
    assert.equal(pending.statuses.length, 0, "A late health response must not overwrite the display status");
    assert.equal(pending.refs.ttsHealthCheckPendingRef.current, false);
  }
});

test("unmounting the display stops its clock and periodic voice health checks", () => {
  const timers = new Map();
  const cleared = [];
  let cleanup;
  let checks = 0;
  const active = { current: false };
  const context = vm.createContext({
    PYTTSX3_TTS_BASE_URL: "http://isolated-tts.test",
    PYTTSX3_RETRY_MS: 5000,
    ttsMonitorActiveRef: active,
    useEffect(effect) { cleanup = effect(); },
    setMounted() {}, setTime() {}, logTts() {},
    verifyTtsService() { checks += 1; },
    setInterval(callback, ms) { timers.set(ms, callback); return ms; },
    clearInterval(id) { cleared.push(id); }
  });
  vm.runInContext(sourceSection("  useEffect(() => {\n    setMounted(true);", "  useEffect(() => {\n    startDisplayListener();"), context);
  assert.equal(active.current, true);
  assert.equal(checks, 1);
  timers.get(5000)();
  assert.equal(checks, 2);
  cleanup();
  assert.equal(active.current, false);
  assert.deepEqual(cleared.sort((a, b) => a - b), [1000, 5000]);
});

function createDisplayHarness({ enabled = true, settings = {}, speak = null, delay = null, health = null, displayRequest = null,
  storage = null, startedAt = Date.parse("2026-10-10T01:00:30.000Z") } = {}) {
  const speech = [];
  const apiErrors = [];
  const voiceStateChanges = [];
  let response = {};
  let clockMs = startedAt;
  class HarnessDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockMs])); }
    static now() { return clockMs; }
  }
  const refs = {
    voiceEnabledRef: { current: enabled },
    seededRef: { current: false },
    announcedKeysRef: { current: new Set() },
    queuedKeysRef: { current: new Set() },
    eligibleAnnouncementKeysRef: { current: new Set() },
    announcementQueueRef: { current: [] },
    isProcessingRef: { current: false },
    activeAnnouncementKeyRef: { current: null },
    playbackGenerationRef: { current: 0 },
    voiceEnableAttemptRef: { current: 0 },
    displayRef: { current: {} },
    displayRequestSequenceRef: { current: 0 },
    appliedDisplaySequenceRef: { current: 0 },
    displayStartedAtRef: { current: startedAt },
    displayActiveRef: { current: true },
    displayRecoveryInitializedRef: { current: false },
    lastAppliedPollStartedAtRef: { current: null }
  };
  const runtimeQueueSettings = { voiceAnnouncements: true, announceDoctorRoom: true, ...settings };
  const context = vm.createContext({
    ...refs,
    Date: HarnessDate,
    voiceEnabled: enabled,
    runtimeQueueSettings,
    ANNOUNCE_GAP_MS_DEFAULT: 3000,
    PYTTSX3_TTS_BASE_URL: "http://isolated-tts.test",
    PYTTSX3_SPEAK_TIMEOUT_MS: 45000,
    PYTTSX3_RETRY_MS: 5000,
    TTS_DEBUG: false,
    // The desktop service owns playback. Any browser audio dependency would
    // fail here even though HTTP announcements are ready to play.
    window: new Proxy({}, { get(_target, name) {
      if (name === "AudioContext" || name === "webkitAudioContext") {
        throw new Error("Browser audio permission is unavailable");
      }
      if (name === "sessionStorage") return storage;
      return undefined;
    } }),
    setDisplay() {},
    setApiError(value) { apiErrors.push(value); },
    setVoiceEnabled(value) { voiceStateChanges.push(value); },
    setVoiceStatus() {},
    setIsSpeaking() {},
    applyRuntimeSettings(raw) { Object.assign(runtimeQueueSettings, raw); },
    async request(url) {
      assert.equal(url, "/display");
      if (displayRequest) return displayRequest();
      if (response instanceof Error) throw response;
      return response;
    },
    async checkPyttsx3Service() { if (health) await health(); },
    async fetchJsonWithTimeout(url, options, timeoutMs) {
      assert.equal(url, "http://isolated-tts.test/speak");
      assert.equal(options.method, "POST");
      assert.equal(timeoutMs, 45000);
      const payload = JSON.parse(options.body);
      if (speak) await speak(payload);
      speech.push(payload);
      return { success: true, key: payload.key };
    },
    async delay(ms) { if (delay) await delay(ms); },
    console: { error() {}, info() {} }
  });
  vm.runInContext(`${recoveryFunctions}\n${displayFunctions}\nthis.displayApi = {
    seedKnownCalls, loadDisplay, collectCallCandidates, getAnnouncementKey, disableVoiceAnnouncer, enableVoiceAnnouncer,
    startDisplayListener, stopDisplayListener, rememberAnnouncementRecovery
  };`, context, { filename: "queue-display-voice-functions.js" });
  context.displayApi.startDisplayListener();

  return {
    speech,
    apiErrors,
    voiceStateChanges,
    refs,
    advanceTo(value) { clockMs = typeof value === "string" ? Date.parse(value) : value; },
    api: context.displayApi,
    seed(data = {}) { context.displayApi.seedKnownCalls(data); },
    async load(data) {
      response = data;
      await context.displayApi.loadDisplay();
    },
    async poll(data) {
      response = data;
      await context.displayApi.loadDisplay();
      // loadDisplay starts the real async announcement processor without awaiting
      // it. Let the mocked audio promises settle before checking the speech sink.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!refs.isProcessingRef.current) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(refs.isProcessingRef.current, false, "Announcement processor did not finish");
    }
  };
}

function calledPatient(overrides = {}) {
  return {
    id: 101,
    queue_number: "GP-001",
    status: "serving",
    called_at: "2026-10-10T01:00:00.000Z",
    counter_name: "Doctor 1",
    ...overrides
  };
}

function createSessionStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    contents() { return Array.from(values.values()); }
  };
}

test("a Doctor 3 Accept between polling and refresh recovers with bell and Room 3", async () => {
  const storage = createSessionStorage();
  const before = createDisplayHarness({ storage });
  before.advanceTo("2026-10-10T01:00:40.000Z");
  await before.poll({ voice_announcements: [] });
  before.advanceTo("2026-10-10T01:00:45.000Z");
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:00:50.000Z") });
  const accepted = calledPatient({ id: 103, queue_number: "FP-017", counter_name: "Doctor 3",
    accepted_at: "2026-10-10T01:00:42.000Z", announcement_key: "doctor3-accept-during-refresh" });
  await after.poll({ voice_announcements: [accepted] });
  assert.equal(after.speech.length, 1);
  assert.equal(after.speech[0].key, accepted.announcement_key);
  assert.equal(after.speech[0].play_chime, true);
  assert.match(after.speech[0].text, /Doctor 3, Room 3\.$/);
});

test("recovery checkpoints the request start rather than a later response completion", async () => {
  const storage = createSessionStorage();
  let releaseSnapshot;
  const snapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  const before = createDisplayHarness({ storage, displayRequest: () => snapshot });
  before.advanceTo("2026-10-10T01:00:40.000Z");
  const poll = before.load();
  before.advanceTo("2026-10-10T01:00:50.000Z");
  releaseSnapshot({ voice_announcements: [] });
  await poll;
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:00:55.000Z") });
  assert.equal(after.refs.displayStartedAtRef.current, Date.parse("2026-10-10T01:00:40.000Z"));
  await after.poll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "accepted-after-snapshot" })] });
  assert.equal(after.speech.length, 1);
});

test("refresh while health readiness is pending recovers the event and stops the old listener", async () => {
  const storage = createSessionStorage();
  let releaseHealth;
  const health = new Promise((resolve) => { releaseHealth = resolve; });
  const before = createDisplayHarness({ storage, health: () => health });
  before.advanceTo("2026-10-10T01:00:50.000Z");
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z", announcement_key: "health-refresh" });
  await before.load({ voice_announcements: [accepted] });
  assert.equal(before.refs.isProcessingRef.current, true);
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll({ voice_announcements: [accepted] });
  releaseHealth();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(before.speech.length, 0, "An unmounted listener must not post after its health check");
  assert.equal(after.speech.length, 1);
  assert.equal(JSON.parse(storage.contents()[0]).sinceMs, Date.parse("2026-10-10T01:01:00.000Z"));
});

test("a completed announcement is checkpointed before refreshing without relying on Python dedupe", async () => {
  const storage = createSessionStorage();
  const before = createDisplayHarness({ storage });
  before.advanceTo("2026-10-10T01:00:50.000Z");
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z", announcement_key: "already-finished" });
  await before.poll({ voice_announcements: [accepted] });
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll({ voice_announcements: [accepted] });
  assert.equal(before.speech.length, 1);
  assert.equal(after.speech.length, 0);
});

test("refresh preserves queued and active event boundaries and reposts the same in-flight key", async () => {
  const storage = createSessionStorage();
  let releaseSpeech;
  const pending = new Promise((resolve) => { releaseSpeech = resolve; });
  const posted = [];
  const before = createDisplayHarness({ storage, speak: (payload) => { posted.push(payload); return pending; } });
  before.advanceTo("2026-10-10T01:00:55.000Z");
  const first = calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z", announcement_key: "posted-before-refresh" });
  const second = calledPatient({ id: 103, counter_name: "Doctor 3", accepted_at: "2026-10-10T01:00:48.000Z",
    announcement_key: "queued-before-refresh" });
  const data = { voice_announcements: [first, second] };
  await before.load(data);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 1);
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll(data);
  assert.deepEqual(after.speech.map((payload) => payload.key), [first.announcement_key, second.announcement_key]);
  assert.equal(after.speech[0].key, posted[0].key, "Python must receive the original dedupe key after a reload");
  assert.equal(after.speech[0].wait, true, "A pending duplicate must await its original playback result");
  releaseSpeech();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 1, "The unmounted listener must not continue its old backlog");
});

test("withdrawn events are not recovered from the cursor or a legacy acceptance fallback", async () => {
  const storage = createSessionStorage();
  const before = createDisplayHarness({ storage });
  before.advanceTo("2026-10-10T01:00:40.000Z");
  await before.poll({ voice_announcements: [] });
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll({ voice_announcements: [], recent_accepted: [calledPatient({
    accepted_at: "2026-10-10T01:00:45.000Z", announcement_key: "withdrawn-during-reload" })] });
  assert.equal(after.speech.length, 0);
});

test("failed polls keep the safe frontier for an unseen acceptance before refresh", async () => {
  const storage = createSessionStorage();
  const before = createDisplayHarness({ storage });
  before.advanceTo("2026-10-10T01:00:40.000Z");
  await before.poll({ voice_announcements: [] });
  before.advanceTo("2026-10-10T01:00:50.000Z");
  await before.poll(new Error("Synthetic polling interruption"));
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "accepted-during-poll-error" })] });
  assert.equal(after.speech.length, 1);
});

test("pausing clears automatic recovery so paused calls do not replay on reopening", async () => {
  const storage = createSessionStorage();
  const before = createDisplayHarness({ storage });
  await before.poll({ voice_announcements: [] });
  before.api.disableVoiceAnnouncer();
  assert.equal(storage.contents().length, 0);
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "accepted-while-paused" })] });
  assert.equal(after.speech.length, 0);
});

test("a late poll from an unmounted display cannot consume a later acceptance", async () => {
  const storage = createSessionStorage();
  let releasePoll;
  const pending = new Promise((resolve) => { releasePoll = resolve; });
  const before = createDisplayHarness({ storage, displayRequest: () => pending });
  before.advanceTo("2026-10-10T01:00:40.000Z");
  const oldPoll = before.load();
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:00:50.000Z") });
  await after.poll({ voice_announcements: [] });
  const checkpoint = storage.contents()[0];
  releasePoll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "late-unmounted-poll" })] });
  await oldPoll;
  assert.equal(before.speech.length, 0);
  assert.equal(storage.contents()[0], checkpoint);
});

test("StrictMode stop and restart on the same listener keeps one announcement processor", async () => {
  let releaseHealth;
  const health = new Promise((resolve) => { releaseHealth = resolve; });
  const harness = createDisplayHarness({ storage: createSessionStorage(), health: () => health });
  const data = { voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "strict-mode-accept" })] };
  harness.advanceTo("2026-10-10T01:00:50.000Z");
  await harness.load(data);
  harness.api.stopDisplayListener();
  harness.api.startDisplayListener();
  await harness.load(data);
  releaseHealth();
  await new Promise((resolve) => setImmediate(resolve));
  await harness.poll(data);
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.refs.queuedKeysRef.current.size, 0);
});

test("a deferred Enable result cannot revive an unmounted listener and retry its failed POST", async () => {
  let releaseEnable;
  let rejectPost;
  let markPosted;
  let healthCalls = 0;
  let postCalls = 0;
  const enabling = new Promise((resolve) => { releaseEnable = resolve; });
  const originalPost = new Promise((_resolve, reject) => { rejectPost = reject; });
  const posted = new Promise((resolve) => { markPosted = resolve; });
  const harness = createDisplayHarness({
    health() { if (++healthCalls === 2) return enabling; },
    speak() { postCalls += 1; markPosted(); if (postCalls === 1) return originalPost; }
  });
  await harness.load({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "unmounted-enable" })] });
  await posted;
  harness.api.disableVoiceAnnouncer();
  const enable = harness.api.enableVoiceAnnouncer();
  harness.api.stopDisplayListener();
  releaseEnable();
  await enable;
  rejectPost(new Error("Synthetic disconnected POST"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.refs.displayActiveRef.current, false);
  assert.equal(harness.refs.voiceEnabledRef.current, false);
  assert.equal(postCalls, 1, "The old listener must not retry after unmount");
});

test("refresh during a retry preserves its event even after a later successful poll", async () => {
  const storage = createSessionStorage();
  let releaseRetry;
  let markRetry;
  let attempts = 0;
  const retry = new Promise((resolve) => { releaseRetry = resolve; });
  const retryReady = new Promise((resolve) => { markRetry = resolve; });
  const before = createDisplayHarness({ storage,
    speak() { attempts += 1; throw new Error("Synthetic voice outage"); },
    delay() { markRetry(); return retry; }
  });
  before.advanceTo("2026-10-10T01:00:50.000Z");
  const data = { voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "retry-across-refresh" })] };
  await before.load(data);
  await retryReady;
  before.advanceTo("2026-10-10T01:00:55.000Z");
  await before.load(data);
  before.api.stopDisplayListener();
  const after = createDisplayHarness({ storage, startedAt: Date.parse("2026-10-10T01:01:00.000Z") });
  await after.poll(data);
  releaseRetry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(after.speech.length, 1);
});

test("a deferred Enable respects settings changed while the service health check was pending", async () => {
  let releaseHealth;
  const health = new Promise((resolve) => { releaseHealth = resolve; });
  const harness = createDisplayHarness({ enabled: false, health: () => health });
  const enabling = harness.api.enableVoiceAnnouncer();
  await harness.load({ voice_announcements: [], queue_settings: { voiceAnnouncements: false } });
  releaseHealth();
  await enabling;
  assert.equal(harness.refs.voiceEnabledRef.current, false);
  assert.equal(harness.speech.length, 0);
});

test("an older failed Enable cannot override a newer successful Enable or silence the next acceptance", async () => {
  let rejectOlder;
  let checks = 0;
  const olderHealth = new Promise((_resolve, reject) => { rejectOlder = reject; });
  const harness = createDisplayHarness({ enabled: false,
    health() { return ++checks === 1 ? olderHealth : undefined; }
  });
  const olderEnable = harness.api.enableVoiceAnnouncer();
  await harness.api.enableVoiceAnnouncer();
  assert.equal(checks, 2);
  assert.equal(harness.refs.voiceEnabledRef.current, true);
  rejectOlder(new Error("Synthetic stale health failure"));
  await olderEnable;
  assert.equal(harness.refs.voiceEnabledRef.current, true);
  assert.deepEqual(harness.voiceStateChanges, [true]);
  await harness.poll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "accept-after-newer-enable" })] });
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.speech[0].play_chime, true);
});

test("an older successful Enable cannot override the newer failed Enable", async () => {
  let releaseOlder;
  let checks = 0;
  const olderHealth = new Promise(resolve => { releaseOlder = resolve; });
  const harness = createDisplayHarness({ enabled: false, health() {
    if (++checks === 1) return olderHealth;
    throw new Error("Synthetic current health failure");
  } });
  const olderEnable = harness.api.enableVoiceAnnouncer();
  await harness.api.enableVoiceAnnouncer();
  releaseOlder();
  await olderEnable;
  assert.equal(harness.refs.voiceEnabledRef.current, false);
  assert.deepEqual(harness.voiceStateChanges, [false]);
});

test("explicit Pause invalidates an outstanding Enable success", async () => {
  let releaseHealth;
  const health = new Promise(resolve => { releaseHealth = resolve; });
  const harness = createDisplayHarness({ enabled: false, health: () => health });
  const enabling = harness.api.enableVoiceAnnouncer();
  harness.api.disableVoiceAnnouncer();
  releaseHealth();
  await enabling;
  assert.equal(harness.refs.voiceEnabledRef.current, false);
  assert.deepEqual(harness.voiceStateChanges, [false]);
  await harness.poll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:00:45.000Z",
    announcement_key: "paused-outstanding-enable" })] });
  assert.equal(harness.speech.length, 0);
});

for (const fails of [false, true]) {
  test(`an unmounted display ignores the outstanding Enable ${fails ? "failure" : "success"} without updating Voice state`, async () => {
    let resolveHealth, rejectHealth;
    const health = new Promise((resolve, reject) => { resolveHealth = resolve; rejectHealth = reject; });
    const harness = createDisplayHarness({ enabled: false, health: () => health });
    const enabling = harness.api.enableVoiceAnnouncer();
    harness.api.stopDisplayListener();
    if (fails) rejectHealth(new Error("Synthetic late health failure"));
    else resolveHealth();
    await enabling;
    assert.equal(harness.refs.voiceEnabledRef.current, false);
    assert.deepEqual(harness.voiceStateChanges, []);
  });
}

test("global disable invalidates pending Enable even if settings are restored before its result", async () => {
  let releaseHealth;
  const health = new Promise(resolve => { releaseHealth = resolve; });
  const harness = createDisplayHarness({ enabled: false, health: () => health });
  const enabling = harness.api.enableVoiceAnnouncer();
  await harness.load({ voice_announcements: [], queue_settings: { voiceAnnouncements: false } });
  await harness.load({ voice_announcements: [], queue_settings: { voiceAnnouncements: true } });
  releaseHealth();
  await enabling;
  assert.equal(harness.refs.voiceEnabledRef.current, false);
  assert.deepEqual(harness.voiceStateChanges, []);
});

test("Frontdesk Call alone produces no voice event", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const called = calledPatient();
  await harness.poll({ all_serving: [called], recent_called: [called], recent_accepted: [] });
  assert.equal(harness.speech.length, 0);
  assert.equal(harness.api.getAnnouncementKey(called), null);
});

test("a new doctor acceptance is announced once across duplicate events and repeated polls", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" });
  await harness.poll({ recent_accepted: [accepted, accepted] });
  await harness.poll({ recent_accepted: [accepted] });
  await harness.poll({ recent_accepted: [accepted] });
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.refs.announcedKeysRef.current.size, 1);
});

test("Re-Call's distinct announcement event produces one additional request for the same accepted patient", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" });
  accepted.announcement_key = "101:accept:event-1";
  await harness.poll({ voice_announcements: [accepted] });
  const recalled = {
    ...accepted,
    announcement_key: "101:recall:event-2",
    announcement_at: "2026-10-10T01:02:00.000Z",
    event_type: "recall"
  };
  await harness.poll({ voice_announcements: [accepted, recalled], recent_accepted: [accepted] });
  await harness.poll({ voice_announcements: [accepted, recalled], recent_accepted: [accepted] });
  assert.equal(harness.speech.length, 2);
  assert.equal(harness.refs.announcedKeysRef.current.size, 2);
});

test("disabled voice and pre-startup acceptance events produce no announcement", async () => {
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" });
  const disabled = createDisplayHarness({ enabled: false });
  disabled.seed();
  await disabled.poll({ recent_accepted: [accepted] });
  assert.equal(disabled.speech.length, 0);
  const unseeded = createDisplayHarness();
  await unseeded.poll({ recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:00:00.000Z" })] });
  assert.equal(unseeded.speech.length, 0);
});

test("System Settings can disable an active display voice announcer", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  await harness.poll({
    queue_settings: { voiceAnnouncements: false },
    recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" })]
  });
  assert.equal(harness.refs.voiceEnabledRef.current, false);
  assert.equal(harness.speech.length, 0);
});

test("enabling voice seeds old acceptances without replaying them", async () => {
  const harness = createDisplayHarness();
  const oldAccepted = calledPatient({ accepted_at: "2026-10-10T01:00:00.000Z" });
  harness.seed({ recent_accepted: [oldAccepted] });
  await harness.poll({ recent_accepted: [oldAccepted] });
  assert.equal(harness.speech.length, 0);
  await harness.poll({ recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:02:00.000Z" })] });
  assert.equal(harness.speech.length, 1);
});

test("announcement wording preserves queue number, doctor and room and never includes a patient name or identifier", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  // Even if a stale or non-conforming payload still carried id_num, it is never spoken or forwarded.
  await harness.poll({ recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", id_num: "Test Patient" })] });
  assert.equal(
    harness.speech[0].text,
    "Now calling queue number G P 0 0 1, please proceed to Doctor 1, Room 1."
  );
  assert.ok(!("patient_name" in harness.speech[0]), "voice request must not carry patient_name");
  assert.ok(!JSON.stringify(harness.speech).includes("Test Patient"), "patient name must not reach the voice service");
  assert.equal(harness.speech[0].wait, true);
  assert.equal(harness.speech[0].timeout_seconds, 45);
  assert.equal(harness.speech[0].gap_ms, 3000);
  assert.equal(harness.speech[0].play_chime, true);
});

test("announcement waits for service readiness and delegates the chime with its speech request", async () => {
  let finishHealth;
  let notifyHealthStarted;
  let speakRequests = 0;
  const healthFinished = new Promise((resolve) => { finishHealth = resolve; });
  const healthStarted = new Promise((resolve) => { notifyHealthStarted = resolve; });
  const harness = createDisplayHarness({
    health() {
      notifyHealthStarted();
      return healthFinished;
    },
    speak() { speakRequests += 1; }
  });
  harness.seed();
  const polling = harness.poll({
    recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" })]
  });

  await healthStarted;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(speakRequests, 0, "An unavailable service must not receive speech");
    assert.equal(harness.speech.length, 0);
  } finally {
    finishHealth();
  }
  await polling;
  assert.equal(speakRequests, 1);
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.speech[0].play_chime, true);
});

test("successive patient acceptances request bell and voice without browser audio activation", async () => {
  const h = createDisplayHarness();
  h.seed();
  await h.poll({ voice_announcements: [] });
  const first = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "first-patient" });
  await h.poll({ voice_announcements: [first] });
  // A new registration changes display data but creates no acceptance event.
  await h.poll({ voice_announcements: [first], waiting: [calledPatient({ id: 102, status: "waiting", called_at: null })] });
  const second = calledPatient({ id: 102, queue_number: "GP-002", accepted_at: "2026-10-10T01:02:00.000Z", announcement_key: "second-patient" });
  await h.poll({ voice_announcements: [first, second] });
  assert.deepEqual(h.speech.map(({ key, play_chime }) => [key, play_chime]), [
    ["first-patient", true], ["second-patient", true]
  ]);
  assert.equal(h.refs.voiceEnabledRef.current, true);
  assert.doesNotMatch(source, /Enable Bell|AudioContext|webkitAudioContext/);
});

test("muting sound notifications preserves voice and changing the setting restores the next chime", async () => {
  const h = createDisplayHarness();
  h.seed();
  const first = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "voice-without-chime" });
  await h.poll({ queue_settings: { soundNotifications: false }, voice_announcements: [first] });
  assert.equal(h.speech[0].play_chime, false);
  assert.match(h.speech[0].text, /Now calling queue number/);
  assert.equal(h.refs.voiceEnabledRef.current, true);
  const next = { ...first, announcement_key: "voice-with-chime", announcement_at: "2026-10-10T01:02:00.000Z" };
  await h.poll({ queue_settings: { soundNotifications: true }, voice_announcements: [first, next] });
  assert.equal(h.speech[1].play_chime, true);
});

test("minimized public events (queue number, doctor/room, event identity only) announce the correct queue number", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const acceptedAt = "2026-10-10T01:01:00.000Z";
  const event = {
    id: 201, queue_number: "PN-007", status: "serving", called_at: "2026-10-10T01:00:00.000Z", accepted_at: acceptedAt,
    announcement_at: acceptedAt, announcement_key: "201:accepted:2026-10-10T01:01:00.000Z:key-1", event_type: "accepted", counter_name: "Doctor 2"
  };
  assert.ok(!("id_num" in event) && !("patient_name" in event));
  await harness.poll({ voice_announcements: [event], recent_accepted: [] });
  await harness.poll({ voice_announcements: [event], recent_accepted: [] }); // repeated poll: still once
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.speech[0].text, "Now calling queue number P N 0 0 7, please proceed to Doctor 2, Room 2.");
  assert.deepEqual(Object.keys(harness.speech[0]).filter((key) => /id_num|patient/i.test(key)), [],
    "the voice request must not carry any patient field (doctor_name is the doctor label)");
});

test("identifier-like values in a stale payload (citizen, PhilHealth) are never spoken, logged or forwarded", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const stale = calledPatient({ id: 301, queue_number: "GP-009", accepted_at: "2026-10-10T01:01:00.000Z",
    id_num: "CIT-1234-5678-SENTINEL", patient_name: "PHILHEALTH-12-345678901-2-SENTINEL" });
  await harness.poll({ recent_accepted: [stale] });
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.speech[0].text, "Now calling queue number G P 0 0 9, please proceed to Doctor 1, Room 1.");
  assert.ok(!JSON.stringify(harness.speech).includes("SENTINEL"));
});

test("Queue Display source never reads, renders, logs or speaks a patient name or identifier", () => {
  const readsOfPatient = [...source.matchAll(/\b(?:patient|row|servingPatient|entry|s|p|event|call)\??\.(?:id_num|ID_Num|patient_name)\b/g)];
  assert.deepEqual(readsOfPatient, []);
  assert.ok(!/patient_name|patientName/.test(source));
  // The only id_num reads left belong to counters (doctor/room labels).
  for (const match of source.matchAll(/(\w+(?:\.\w+)?)\.id_num/g)) assert.match(match[1], /^(?:counter|page\.counter)$/);
  assert.match(source, /Now calling queue number \$\{spokenQueue\}, please proceed to \$\{destination\}\./);
});

test("each accepted patient's announcement keeps its assigned doctor's room", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const acceptedAt = "2026-10-10T01:01:00.000Z";
  await harness.poll({ recent_accepted: [
    calledPatient({ id: 102, queue_number: "OB-001", counter_name: "Doctor 2", accepted_at: acceptedAt }),
    calledPatient({ id: 103, queue_number: "FP-001", counter_name: "Doctor 3", accepted_at: acceptedAt })
  ] });
  assert.equal(harness.speech.length, 2);
  assert.match(harness.speech[0].text, /Doctor 2, Room 2\.$/);
  assert.match(harness.speech[1].text, /Doctor 3, Room 3\.$/);
});

test("the first poll skips historical events but announces an acceptance after display startup", async () => {
  const harness = createDisplayHarness();
  const historical = calledPatient({ accepted_at: "2026-10-10T01:00:00.000Z", announcement_key: "old-accept" });
  const current = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "new-accept" });
  await harness.poll({ voice_announcements: [historical, current] });
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.speech[0].key, "new-accept");
});

test("distinct persisted event keys announce independently even at the same timestamp", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "accept-uuid", event_type: "accept" });
  const recalled = { ...accepted, announcement_key: "recall-uuid", event_type: "recall" };
  await harness.poll({ voice_announcements: [accepted, recalled, recalled], recent_accepted: [accepted] });
  await harness.poll({ voice_announcements: [accepted, recalled], recent_accepted: [accepted] });
  assert.deepEqual(harness.speech.map((payload) => payload.key), ["accept-uuid", "recall-uuid"]);
});

test("persisted voice events take precedence over legacy recent_accepted to avoid duplicate acceptance", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" });
  await harness.poll({ voice_announcements: [{ ...accepted, announcement_key: "persisted-accept" }], recent_accepted: [accepted] });
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.speech[0].key, "persisted-accept");
});

test("an authoritative empty voice event list does not replay a completed patient's legacy acceptance", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" });
  await harness.poll({ voice_announcements: [{ ...accepted, announcement_key: "accept-before-complete" }], recent_accepted: [accepted] });
  assert.equal(harness.speech.length, 1);
  await harness.poll({ voice_announcements: [], recent_accepted: [{ ...accepted, status: "completed" }] });
  await harness.poll({ voice_announcements: [], recent_accepted: [{ ...accepted, status: "completed" }] });
  assert.equal(harness.speech.length, 1, "Completion must not switch to the legacy key and speak again");
  assert.equal(harness.api.collectCallCandidates({ voice_announcements: [], recent_accepted: [accepted] }).length, 0);
});

test("a failed pyttsx3 request retries the same event and marks it announced only after success", async () => {
  let attempts = 0;
  const harness = createDisplayHarness({ speak() {
    attempts += 1;
    if (attempts === 1) throw new Error("Isolated TTS unavailable");
  } });
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "retry-event" });
  await harness.poll({ voice_announcements: [accepted] });
  await harness.poll({ voice_announcements: [accepted] });
  assert.equal(attempts, 2);
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.refs.announcedKeysRef.current.has("retry-event"), true);
  assert.equal(harness.refs.queuedKeysRef.current.size, 0);
});

test("polling an event while its pyttsx3 request is pending does not queue it twice", async () => {
  let harness;
  let nestedPoll = false;
  harness = createDisplayHarness({ async speak() {
    if (!nestedPoll) {
      nestedPoll = true;
      await harness.api.loadDisplay();
    }
  } });
  harness.seed();
  await harness.poll({ voice_announcements: [calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "pending-event" })] });
  assert.equal(harness.speech.length, 1);
  assert.equal(harness.refs.queuedKeysRef.current.size, 0);
});

test("pausing during service readiness does not consume an unposted announcement", async () => {
  let releaseHealth;
  let healthStarted;
  let calls = 0;
  const healthReady = new Promise((resolve) => { healthStarted = resolve; });
  const healthFinished = new Promise((resolve) => { releaseHealth = resolve; });
  const harness = createDisplayHarness({ health() {
    calls += 1;
    if (calls === 1) {
      healthStarted();
      return healthFinished;
    }
  } });
  harness.seed();
  const data = { voice_announcements: [calledPatient({
    accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "pause-during-health"
  })] };
  await harness.load(data);
  await healthReady;
  harness.api.disableVoiceAnnouncer();
  assert.equal(harness.refs.isProcessingRef.current, true);
  releaseHealth();
  await harness.poll(data);
  assert.equal(harness.speech.length, 0);
  assert.equal(harness.refs.announcedKeysRef.current.has("pause-during-health"), false);
  harness.refs.voiceEnabledRef.current = true;
  await harness.poll(data);
  assert.equal(harness.speech.length, 1);
});

test("quick pause and resume keep one processor until its pending speech finishes", async () => {
  let releaseSpeech;
  let speechStarted;
  let inFlight = 0;
  let maxInFlight = 0;
  let attempts = 0;
  const firstStarted = new Promise((resolve) => { speechStarted = resolve; });
  const firstFinished = new Promise((resolve) => { releaseSpeech = resolve; });
  const harness = createDisplayHarness({ async speak() {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    attempts += 1;
    if (attempts === 1) {
      speechStarted();
      await firstFinished;
    }
    inFlight -= 1;
  } });
  harness.seed();
  const accepted = calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "active-speech" });
  await harness.load({ voice_announcements: [accepted] });
  await firstStarted;
  harness.api.disableVoiceAnnouncer();
  harness.refs.voiceEnabledRef.current = true;
  const recalled = { ...accepted, announcement_key: "next-speech", announcement_at: "2026-10-10T01:02:00.000Z" };
  await harness.load({ voice_announcements: [accepted, recalled] });
  assert.equal(attempts, 1, "Resuming must not start a second processor");
  releaseSpeech();
  await harness.poll({ voice_announcements: [accepted, recalled] });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(harness.speech.map((payload) => payload.key), ["active-speech", "next-speech"]);
});

test("historical events that appear after the first poll are not replayed", async () => {
  const harness = createDisplayHarness();
  await harness.poll({ voice_announcements: [] });
  await harness.poll({ voice_announcements: [calledPatient({
    accepted_at: "2026-10-10T01:00:00.000Z", announcement_key: "late-history"
  })] });
  assert.equal(harness.speech.length, 0);
});

test("pausing during a retry delay releases the abandoned queue key", async () => {
  let releaseRetry;
  let retryStarted;
  let attempts = 0;
  const retryReady = new Promise((resolve) => { retryStarted = resolve; });
  const retryFinished = new Promise((resolve) => { releaseRetry = resolve; });
  const harness = createDisplayHarness({
    speak() {
      attempts += 1;
      if (attempts === 1) throw new Error("Synthetic TTS failure");
    },
    delay() { retryStarted(); return retryFinished; }
  });
  harness.seed();
  const data = { voice_announcements: [calledPatient({
    accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "paused-retry"
  })] };
  await harness.load(data);
  await retryReady;
  harness.api.disableVoiceAnnouncer();
  harness.refs.voiceEnabledRef.current = true;
  releaseRetry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.refs.queuedKeysRef.current.has("paused-retry"), false);
  await harness.poll(data);
  assert.equal(attempts, 2);
  assert.equal(harness.speech.length, 1);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settleDisplay = async (h) => {
  for (let i = 0; i < 30 && h.refs.isProcessingRef.current; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(h.refs.isProcessingRef.current, false);
};
const event = (key, overrides = {}) => calledPatient({ announcement_key: key,
  accepted_at: "2026-10-10T01:01:00.000Z", ...overrides });

for (const status of ["cancelled", "completed"]) {
  test(`withdrawn ${status} backlog is pruned while posted speech finishes and a valid next event plays`, async () => {
    const firstStarted = deferred(), firstFinished = deferred();
    const h = createDisplayHarness({
      speak(payload) { if (payload.key === "first") { firstStarted.resolve(); return firstFinished.promise; } }
    });
    h.seed();
    const first = event("first"), withdrawn = event("withdrawn", { id: 102 }), valid = event("valid", { id: 103 });
    await h.load({ voice_announcements: [first, withdrawn] });
    await firstStarted.promise;
    assert.deepEqual(Array.from(h.refs.announcementQueueRef.current, item => item.key), ["withdrawn"]);
    await h.load({ voice_announcements: [valid, { ...withdrawn, status }], all_serving: [valid] });
    assert.deepEqual(Array.from(h.refs.announcementQueueRef.current, item => item.key), ["valid"]);
    firstFinished.resolve();
    await settleDisplay(h);
    assert.deepEqual(h.speech.map(item => item.key), ["first", "valid"]);
    assert.equal(h.speech.every(item => item.play_chime === true), true);
    await h.poll({ voice_announcements: [valid] });
    assert.equal(h.speech.length, 2);
  });
}

test("withdrawal during health check prevents the combined bell and speech request", async () => {
  const started = deferred(), finished = deferred();
  const h = createDisplayHarness({ health() { started.resolve(); return finished.promise; } });
  h.seed();
  await h.load({ voice_announcements: [event("withdraw-before-bell")] });
  await started.promise;
  await h.load({ voice_announcements: [], all_serving: [] });
  finished.resolve();
  await settleDisplay(h);
  assert.equal(h.speech.length, 0);
  assert.equal(h.refs.queuedKeysRef.current.size, 0);
});

test("withdrawn failed speech is not retried while a valid next event succeeds", async () => {
  const started = deferred(), failed = deferred();
  const attempts = [];
  const h = createDisplayHarness({ speak(payload) {
    attempts.push(payload.key);
    if (payload.key === "failed-withdrawn") { started.resolve(); return failed.promise; }
  } });
  h.seed();
  await h.load({ voice_announcements: [event("failed-withdrawn"), event("next-valid", { id: 102 })] });
  await started.promise;
  await h.load({ voice_announcements: [event("next-valid", { id: 102 })] });
  failed.reject(new Error("Synthetic speech failure"));
  await settleDisplay(h);
  assert.deepEqual(attempts, ["failed-withdrawn", "next-valid"]);
  assert.deepEqual(h.speech.map(item => item.key), ["next-valid"]);
});

test("failed display polls preserve the latest valid eligibility and do not fabricate events", async () => {
  const started = deferred(), finished = deferred();
  const h = createDisplayHarness({ health() { started.resolve(); return finished.promise; } });
  h.seed();
  await h.load({ voice_announcements: [event("eligible")] });
  await started.promise;
  for (const failure of [new Error("Offline"), { error: "Unavailable" }, { success: false, message: "Failed" }]) {
    await h.load(failure);
    assert.equal(h.refs.eligibleAnnouncementKeysRef.current.has("eligible"), true);
  }
  finished.resolve();
  await settleDisplay(h);
  assert.deepEqual(h.speech.map(item => item.key), ["eligible"]);
});

test("late older poll cannot restore an event removed by a newer successful snapshot", async () => {
  const older = deferred();
  let reads = 0;
  const h = createDisplayHarness({ displayRequest() { return ++reads === 1 ? older.promise : { voice_announcements: [] }; } });
  h.seed();
  const pending = h.load();
  await h.load();
  older.resolve({ voice_announcements: [event("obsolete")] });
  await pending;
  await settleDisplay(h);
  assert.equal(h.speech.length, 0);
  assert.equal(h.refs.eligibleAnnouncementKeysRef.current.size, 0);
  assert.equal(h.refs.appliedDisplaySequenceRef.current, 2);
});

test("a failed newer poll does not invalidate an earlier successful response", async () => {
  const older = deferred();
  let reads = 0;
  const h = createDisplayHarness({ displayRequest() { return ++reads === 1 ? older.promise : { error: "Offline" }; } });
  h.seed();
  const pending = h.load();
  await h.load();
  older.resolve({ voice_announcements: [event("valid-earlier-response")] });
  await pending;
  await settleDisplay(h);
  assert.deepEqual(h.speech.map(item => item.key), ["valid-earlier-response"]);
});

// Exercise the display's pure waiting-view logic without a browser, network,
// backend mutations, or changes to the existing voice fixtures above.
const waitingContext = vm.createContext({});
vm.runInContext([
  source.match(/^const DISPLAY_FLIP_MS = .*;$/m)?.[0],
  source.match(/^const DISPLAY_FADE_MS = .*;$/m)?.[0],
  sourceSection("function groupWaitingQueues(", "let runtimeQueueSettings"),
  "this.waitingApi = { groupWaitingQueues, getWaitingPage, measureWaitingLayout, startQueueDisplayFlipping };"
].join("\n"), waitingContext);
const waitingApi = waitingContext.waitingApi;
const waitingCounters = [
  { id: 1, id_num: "Doctor 1", service_types: ["consultation", "checkup"] },
  { id: 2, id_num: "Doctor 2", service_types: ["prenatal", "maternity"] },
  { id: 3, id_num: "Doctor 3", service_types: ["family_planning"] }
];
const matchWaitingService = (service, assigned) => assigned.includes(service);
const waitingPatient = (id, overrides = {}) => ({
  id, queue_number: `GP-${String(id).padStart(3, "0")}`,
  status: "waiting", service_type: "consultation", ...overrides
});
const waitingRowIds = page => Array.from(page.rows, row => row.id);
const waitingGroupIds = groups => Array.from(groups, waitingRowIds);

test("waiting sections respect explicit counter assignment, service routing and API priority order", () => {
  const waiting = [
    waitingPatient(15),
    waitingPatient(2, { service_type: "prenatal", counter_name: "Doctor 1" }),
    waitingPatient(3, { counter_id: "2" }),
    waitingPatient(4, { service_type: "prenatal", counter_name: "Doctor 3" }),
    waitingPatient(10, { service_type: "maternity" }),
    waitingPatient(11, { service_type: "family_planning" }),
    waitingPatient(20)
  ];
  const snapshot = JSON.stringify(waiting);
  const grouped = waitingApi.groupWaitingQueues({ waiting_queue: waiting }, waitingCounters, matchWaitingService);
  assert.deepEqual(waitingGroupIds(grouped), [[15, 2, 20], [3, 10], [4, 11]]);
  assert.equal(grouped[0].counter, waitingCounters[0]);
  assert.equal(JSON.stringify(waiting), snapshot, "Grouping must not sort or mutate the API snapshot");

  const fallback = waitingApi.groupWaitingQueues({ waiting_queue: [
    waitingPatient(21, { service_type: "legacy_service" }),
    waitingPatient(22, { service_type: "prenatal" }),
    waitingPatient(23, { service_type: "family_planning" })
  ] }, waitingCounters.map(counter => ({ ...counter, service_types: [] })), matchWaitingService);
  assert.deepEqual(waitingGroupIds(fallback), [[21], [22], [23]]);
});

test("waiting sections exclude serving, completed, cancelled and skipped records and duplicate IDs", () => {
  const grouped = waitingApi.groupWaitingQueues({
    all_serving: [waitingPatient("7", { status: "serving" })],
    waiting_queue: [
      waitingPatient(1), waitingPatient("1"), waitingPatient(2, { status: "serving" }),
      waitingPatient(3, { status: "completed" }), waitingPatient(4, { status: "cancelled" }),
      waitingPatient(5, { status: "skipped" }), waitingPatient(9, { status: "no-show" }),
      waitingPatient(6, { completed_at: "2026-10-15T01:00:00.000Z" }),
      waitingPatient(7), waitingPatient(8)
    ]
  }, waitingCounters, matchWaitingService);
  assert.deepEqual(waitingGroupIds(grouped), [[1, 8], [], []]);
  assert.deepEqual(waitingGroupIds(waitingApi.groupWaitingQueues({}, waitingCounters, matchWaitingService)), [[], [], []]);
});

test("one polling snapshot reconciles simultaneous changes across all three waiting sections", () => {
  const original = [
    waitingPatient(1), waitingPatient(2, { service_type: "prenatal" }),
    waitingPatient(3, { service_type: "family_planning" }), waitingPatient(4)
  ];
  assert.deepEqual(waitingGroupIds(waitingApi.groupWaitingQueues({ waiting_queue: original }, waitingCounters, matchWaitingService)), [[1, 4], [2], [3]]);
  const updated = {
    all_serving: [{ ...original[0], status: "serving", counter_id: 1 }],
    waiting_queue: [
      { ...original[0], status: "serving" }, { ...original[1], status: "cancelled" },
      { ...original[2], status: "completed" }, { ...original[3], counter_id: 2 },
      waitingPatient(5), waitingPatient(6, { service_type: "family_planning" })
    ]
  };
  assert.deepEqual(waitingGroupIds(waitingApi.groupWaitingQueues(updated, waitingCounters, matchWaitingService)), [[5], [4], [6]]);
});

test("automatic pagination exposes every long-queue record in order before wrapping", () => {
  const rows = Array.from({ length: 31 }, (_, index) => waitingPatient(index + 1));
  let page = waitingApi.getWaitingPage(rows, null, 7);
  const visited = [];
  for (let index = 0; index < 5; index += 1) {
    visited.push(...waitingRowIds(page));
    assert.ok(page.rows.length <= 7);
    page = waitingApi.getWaitingPage(rows, page, 7, true);
  }
  assert.deepEqual(visited, rows.map(row => row.id));
  assert.deepEqual(waitingRowIds(page), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(page.start, 0);
});

test("polling preserves a waiting page anchor and continues past removed records without losing the queue tail", () => {
  const rows = Array.from({ length: 24 }, (_, index) => waitingPatient(index + 1));
  let page = waitingApi.getWaitingPage(rows, null, 7);
  page = waitingApi.getWaitingPage(rows, page, 7, true);
  assert.deepEqual(waitingRowIds(page), [8, 9, 10, 11, 12, 13, 14]);
  const inserted = [waitingPatient(99), ...rows];
  page = waitingApi.getWaitingPage(inserted, page, 7);
  assert.deepEqual(waitingRowIds(page), [8, 9, 10, 11, 12, 13, 14]);
  page = waitingApi.getWaitingPage(inserted.filter(row => row.id !== 8), page, 7);
  assert.deepEqual(waitingRowIds(page), [9, 10, 11, 12, 13, 14, 15]);
  const remaining = inserted.filter(row => row.id < 8 || row.id > 15);
  page = waitingApi.getWaitingPage(remaining, page, 7);
  assert.deepEqual(waitingRowIds(page), [16, 17, 18, 19, 20, 21, 22]);
  page = waitingApi.getWaitingPage(remaining, page, 7, true);
  assert.deepEqual(waitingRowIds(page), [23, 24]);
  page = waitingApi.getWaitingPage(remaining, page, 7, true);
  assert.deepEqual(waitingRowIds(page), [99, 1, 2, 3, 4, 5, 6]);
});

test("empty lists and changing page capacity recover without stale waiting rows", () => {
  const rows = Array.from({ length: 12 }, (_, index) => waitingPatient(index + 1));
  let page = waitingApi.getWaitingPage(rows, null, 4);
  page = waitingApi.getWaitingPage(rows, page, 4, true);
  page = waitingApi.getWaitingPage(rows, page, 2);
  assert.deepEqual(waitingRowIds(page), [5, 6]);
  const empty = waitingApi.getWaitingPage([], page, 2);
  assert.equal(empty.count, 0);
  assert.equal(empty.start, 0);
  assert.deepEqual(waitingRowIds(empty), []);
  assert.deepEqual(waitingRowIds(waitingApi.getWaitingPage(rows, empty, 2)), [1, 2]);
});

function createWaitingTimers() {
  let now = 0;
  let sequence = 0;
  const scheduled = new Map();
  const add = (callback, delay, repeat) => {
    const id = ++sequence;
    scheduled.set(id, { callback, at: now + delay, repeat });
    return id;
  };
  return {
    get now() { return now; },
    get pending() { return scheduled.size; },
    setInterval(callback, ms) { return add(callback, ms, ms); },
    clearInterval(id) { scheduled.delete(id); },
    setTimeout(callback, ms) { return add(callback, ms, 0); },
    clearTimeout(id) { scheduled.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...scheduled].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat;
        else scheduled.delete(id);
        timer.callback();
      }
      now = end;
    }
  };
}

test("a single flip controller emits a shared view every ten seconds across repeated fade cycles", () => {
  const timers = createWaitingTimers();
  const events = [];
  const stop = waitingApi.startQueueDisplayFlipping(
    fading => events.push([timers.now, "fade", fading]),
    waiting => events.push([timers.now, "view", waiting]), timers
  );
  assert.equal(timers.pending, 1, "Only one recurring flip timer is required for all counter sections");
  timers.advance(9999);
  assert.deepEqual(events, []);
  timers.advance(1);
  assert.deepEqual(events, [[10000, "fade", true]]);
  timers.advance(199);
  assert.equal(events.length, 1, "Content must switch only after fading out");
  timers.advance(20001);
  assert.deepEqual(events, [
    [10000, "fade", true], [10200, "view", true], [10200, "fade", false],
    [20000, "fade", true], [20200, "view", false], [20200, "fade", false],
    [30000, "fade", true], [30200, "view", true], [30200, "fade", false]
  ]);
  assert.equal(timers.pending, 1);
  stop();
  assert.equal(timers.pending, 0);
});

test("cleanup cancels an in-progress fade and remount starts one fresh flip sequence", () => {
  const timers = createWaitingTimers();
  const swaps = [];
  const stop = waitingApi.startQueueDisplayFlipping(() => {}, value => swaps.push([timers.now, value]), timers);
  timers.advance(10000);
  assert.equal(timers.pending, 2);
  stop();
  assert.equal(timers.pending, 0);
  const stopRemount = waitingApi.startQueueDisplayFlipping(() => {}, value => swaps.push([timers.now, value]), timers);
  timers.advance(9999);
  assert.deepEqual(swaps, [], "The old fade callback must not update a remounted display");
  timers.advance(201);
  assert.deepEqual(swaps, [[20200, true]]);
  assert.equal(timers.pending, 1);
  stopRemount();
  timers.advance(30000);
  assert.deepEqual(swaps, [[20200, true]]);
  assert.equal(timers.pending, 0);
});

test("waiting row capacity fits the original card dimensions without changing their measured height", () => {
  const layouts = [408, 622.5, 768.75].map(height => waitingApi.measureWaitingLayout(height, 96, 60));
  assert.ok(layouts[0].pageSize < layouts[1].pageSize);
  assert.ok(layouts[1].pageSize < layouts[2].pageSize);
  for (const [index, layout] of layouts.entries()) {
    assert.equal(layout.cardHeight, [408, 622.5, 768.75][index], "Fractional source heights must be preserved exactly");
    assert.equal(layout.headerHeight, 96);
    assert.equal(layout.footerHeight, 60);
    assert.ok(Number.isInteger(layout.pageSize) && layout.pageSize >= 1);
    assert.ok(layout.pageSize * 48 + 96 + 60 + 48 + 36 + 2 <= layout.cardHeight,
      "Visible rows must fit with the measured header/footer, internal caption, table heading and borders");
  }
  const defaults = waitingApi.measureWaitingLayout(408);
  assert.equal(defaults.headerHeight, 64);
  assert.equal(defaults.footerHeight, 44);
  assert.equal(defaults.pageSize, 4);
  assert.equal(waitingApi.measureWaitingLayout(433.99).pageSize, 4, "A fifth row would clip against the outer borders");
  assert.equal(waitingApi.measureWaitingLayout(434).pageSize, 5);
  for (const height of [undefined, 0, -10, NaN]) {
    assert.equal(waitingApi.measureWaitingLayout(height).cardHeight, 408);
  }
  assert.equal(waitingApi.measureWaitingLayout(100).pageSize, 1, "Very short cards still retain a valid pagination capacity");
});

async function waitingViewHarness(globals = {}) {
  const swc = require("next/dist/build/swc");
  await swc.loadBindings();
  const childSource = [
    'import { useEffect, useRef, useState } from "react";',
    sourceSection("function groupWaitingQueues(", "let runtimeQueueSettings"),
    sourceSection("const DOCTOR_INFO_MAP =", "function getAnnouncementKey("),
    source.slice(source.indexOf("function WaitingQueueView(")),
    "export default WaitingQueueView;"
  ].join("\n");
  const compiled = await swc.transform(childSource, {
    filename: "queue-display-waiting-view.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  });
  const hooks = [], dependencies = [], effects = [], cleanups = new Map();
  let cursor = 0;
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = dependencies[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        dependencies[index] = deps;
        effects.push(() => {
          cleanups.get(index)?.();
          const cleanup = callback();
          if (typeof cleanup === "function") cleanups.set(index, cleanup);
          else cleanups.delete(index);
        });
      }
    }
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  vm.runInNewContext(compiled.code, {
    ...globals,
    module, exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      throw new Error(`Unexpected waiting-view dependency: ${name}`);
    }
  });
  const render = props => {
    cursor = 0;
    const tree = module.exports.default({ counters: waitingCounters, matchService: matchWaitingService, ...props });
    effects.splice(0).forEach(effect => effect());
    return tree;
  };
  render.unmount = () => {
    cleanups.forEach(cleanup => cleanup());
    cleanups.clear();
  };
  return render;
}

function waitingNodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(node => waitingNodes(node, predicate, found));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) found.push(tree);
    waitingNodes(tree.props?.children, predicate, found);
  }
  return found;
}

async function displayPageHarness() {
  const swc = require("next/dist/build/swc");
  await swc.loadBindings();
  const compiled = await swc.transform(source, {
    filename: "queue-display-page.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  });
  const hooks = [], effects = [];
  const timers = createWaitingTimers();
  let cursor = 0;
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useEffect(effect) { effects.push(effect); }
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  vm.runInNewContext(compiled.code, {
    module, exports: module.exports, process: { env: {} },
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../lib/api") return { request() { throw new Error("Page render must not request backend data"); } };
      if (name === "../components/SettingsModal") return { defaultQueueSettings: {} };
      if (name === "../lib/queueSettings") return { mergeQueueSettings: raw => raw, persistLocalQueueSettings() {} };
      if (name === "../lib/announcementRecovery") return {
        readAnnouncementRecovery(_storage, now) { return now; }, writeAnnouncementRecovery() {}, clearAnnouncementRecovery() {}
      };
      if (name === "../components/SystemLogo") return { default: function SystemLogo() {} };
      throw new Error(`Unexpected display dependency: ${name}`);
    }
  });
  const render = () => {
    cursor = 0;
    return module.exports.default();
  };
  render();
  const flipEffect = effects.find(effect => effect.toString().includes("startQueueDisplayFlipping"));
  assert.ok(flipEffect, "The page must mount its existing shared flip controller");
  const cleanup = flipEffect();
  return { render, timers, unmount: cleanup };
}

test("both display views omit summary/history panels and retain the footer outside the fading stage", async () => {
  const h = await displayPageHarness();
  const verify = (waiting, opacity) => {
    const tree = h.render();
    const stage = waitingNodes(tree, node => node.props?.className === "queue-display-stage")[0];
    const footer = waitingNodes(tree, node => node.type === "footer");
    assert.ok(stage);
    assert.equal(stage.props.style.opacity, opacity);
    assert.equal(footer.length, 1, "Exactly one shared footer must remain mounted");
    assert.ok(tree.props.children.includes(footer[0]), "The footer must remain a direct page child");
    assert.equal(waitingNodes(stage, node => node.type === "footer").length, 0, "The flip must not fade or hide the footer");
    assert.match(JSON.stringify(footer[0]), /Please listen for your name and queue number to be called/);
    assert.doesNotMatch(JSON.stringify(tree), /Total Waiting|Currently Serving|Recently Called|No recent activity/);
    const waitingView = waitingNodes(stage, node => typeof node.type === "function" && node.type.name === "WaitingQueueView")[0];
    assert.ok(waitingView);
    assert.equal(waitingView.props.visible, waiting);
    assert.equal(waitingNodes(stage, node => node.props?.["aria-hidden"] === waiting).length, 1);
    return tree;
  };
  const initial = verify(false, 1);
  const scopedStyle = waitingNodes(initial, node => node.type === "style")[0];
  assert.equal(scopedStyle.props.jsx, true, "Viewport containment must be scoped to the display page");
  assert.equal(scopedStyle.props.global, undefined);
  const css = scopedStyle.props.children;
  const rule = selector => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `Missing display layout rule: ${selector}`);
    const declarations = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
    return Object.fromEntries(declarations.split(";").filter(value => value.trim()).map(value => value.trim().split(/:\s*/)));
  };
  const screen = rule(".queue-display-screen");
  assert.equal(screen.position, "fixed");
  assert.equal(screen.inset, "0");
  assert.equal(screen.height, "100dvh");
  for (const selector of [".queue-display-screen", ".queue-display-main", ".queue-display-stage"]) {
    const declarations = rule(selector);
    assert.equal(declarations["min-height"], "0", `${selector} must shrink within the viewport`);
    assert.equal(declarations.overflow, "hidden", `${selector} must not introduce page scrolling`);
  }
  assert.doesNotMatch(css, /:global/, "Other application pages must keep their own scrolling behavior");
  h.timers.advance(10000);
  verify(false, 0);
  h.timers.advance(200);
  verify(true, 1);
  h.timers.advance(10000);
  verify(false, 1);
  h.unmount();
  assert.equal(h.timers.pending, 0);
});

function renderedWaitingNumbers(tree) {
  return waitingCounters.map(counter => {
    const section = waitingNodes(tree, node => node.props?.["aria-label"] === `${counter.id_num} waiting queue`)[0];
    assert.ok(section, `${counter.id_num} must retain its own waiting section`);
    return waitingNodes(section, node => node.type === "td" && node.props.className === "queue-waiting-number")
      .map(node => node.props.children);
  });
}

test("the mounted waiting view advances all counters together without consuming rows during hidden polls", async () => {
  const render = await waitingViewHarness();
  const rows = waitingCounters.flatMap((counter, counterIndex) => Array.from({ length: 12 }, (_, index) =>
    waitingPatient(counterIndex * 100 + index + 1, {
      service_type: counter.service_types[0], queue_number: `${["GP", "OB", "FP"][counterIndex]}-${index + 1}`
    })));
  let tree = render({ displayData: { waiting_queue: rows }, visible: true, visit: 1 });
  assert.equal(tree.props.hidden, false);
  assert.deepEqual(renderedWaitingNumbers(tree), [
    ["GP-1", "GP-2", "GP-3", "GP-4"], ["OB-1", "OB-2", "OB-3", "OB-4"], ["FP-1", "FP-2", "FP-3", "FP-4"]
  ]);
  const remaining = rows.filter(row => row.id % 100 !== 1);
  tree = render({ displayData: { waiting_queue: remaining }, visible: false, visit: 1 });
  assert.equal(tree.props.hidden, true);
  render({ displayData: { waiting_queue: remaining }, visible: false, visit: 1 });
  tree = render({ displayData: { waiting_queue: remaining }, visible: true, visit: 2 });
  assert.deepEqual(renderedWaitingNumbers(tree), [
    ["GP-5", "GP-6", "GP-7", "GP-8"], ["OB-5", "OB-6", "OB-7", "OB-8"], ["FP-5", "FP-6", "FP-7", "FP-8"]
  ]);
  const statusChanges = remaining.map(row => row.id % 100 === 5 ? { ...row, status: "completed" } : row);
  tree = render({ displayData: { waiting_queue: statusChanges }, visible: true, visit: 2 });
  assert.deepEqual(renderedWaitingNumbers(tree), [
    ["GP-6", "GP-7", "GP-8", "GP-9"], ["OB-6", "OB-7", "OB-8", "OB-9"], ["FP-6", "FP-7", "FP-8", "FP-9"]
  ]);
  tree = render({ displayData: { waiting_queue: [] }, visible: true, visit: 2 });
  assert.deepEqual(renderedWaitingNumbers(tree), [[], [], []]);
  assert.equal(waitingNodes(tree, node => node.type === "p" && node.props.children === "No Waiting Queue").length, 3);
});

test("waiting cards copy the original grid geometry and track hidden-view desktop and stacked resizes", async () => {
  const rectNode = height => ({ height, getBoundingClientRect() { return { height: this.height }; } });
  const cards = [622.5, 622.5, 622.5].map(height => ({
    ...rectNode(height), firstElementChild: rectNode(96.5), lastElementChild: rectNode(60.5)
  }));
  const sourceGrid = { children: cards };
  const sourceGridRef = { current: sourceGrid };
  const gridStyle = { gridTemplateColumns: "492.25px 492.25px 492.25px", columnGap: "30px", rowGap: "30px" };
  const resizeListeners = new Set();
  const observers = [];
  const render = await waitingViewHarness({
    window: {
      getComputedStyle(element) { assert.equal(element, sourceGrid); return gridStyle; },
      addEventListener(event, callback) { assert.equal(event, "resize"); resizeListeners.add(callback); },
      removeEventListener(event, callback) { assert.equal(event, "resize"); resizeListeners.delete(callback); }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.observed = new Set(); this.disconnected = false; observers.push(this); }
      observe(element) { this.observed.add(element); }
      disconnect() { this.disconnected = true; }
    }
  });
  const rows = waitingCounters.flatMap((counter, counterIndex) => Array.from({ length: 30 }, (_, index) =>
    waitingPatient(counterIndex * 100 + index + 1, { service_type: counter.service_types[0] })));
  const props = { displayData: { waiting_queue: rows }, visible: true, visit: 1, sourceGridRef };
  const assertGeometry = tree => {
    const grid = waitingNodes(tree, node => node.props?.className === "queue-waiting-grid")[0];
    for (const property of ["gridTemplateColumns", "columnGap", "rowGap"]) {
      assert.equal(grid.props.style[property], gridStyle[property], `Waiting grid must preserve source ${property}`);
    }
    const waitingCards = waitingNodes(tree, node => node.props?.className?.split(" ").includes("queue-waiting-card"));
    assert.equal(waitingCards.length, cards.length);
    waitingCards.forEach((card, index) => {
      assert.equal(card.props.style.height, cards[index].height, "Waiting card height must equal the original fractional border-box height");
      const header = waitingNodes(card, node => node.props?.className === "queue-waiting-card-header")[0];
      const footer = waitingNodes(card, node => node.props?.className === "queue-waiting-card-footer")[0];
      assert.equal(header.props.style.height, cards[index].firstElementChild.height);
      assert.equal(footer.props.style.height, cards[index].lastElementChild.height);
      const expected = waitingApi.measureWaitingLayout(cards[index].height, cards[index].firstElementChild.height, cards[index].lastElementChild.height);
      assert.equal(waitingNodes(card, node => node.type === "tbody")[0].props.children.length, expected.pageSize,
        "Each counter must paginate using its own available interior height");
    });
    assert.equal(waitingNodes(tree, node => node.type === "h2").length, 0, "A separate view heading must not push the cards down");
  };

  render(props);
  assertGeometry(render(props));
  assert.equal(resizeListeners.size, 1);
  assert.equal(observers.length, 1);
  for (const element of [sourceGrid, ...cards.flatMap(card => [card, card.firstElementChild, card.lastElementChild])]) {
    assert.equal(observers[0].observed.has(element), true, "Source card, header, footer and grid changes must be observed");
  }

  const hiddenProps = { ...props, visible: false };
  render(hiddenProps);
  [408.25, 456.75, 505.5].forEach((height, index) => {
    cards[index].height = height;
    cards[index].firstElementChild.height = 64 + index * 4;
    cards[index].lastElementChild.height = 44 + index * 2;
  });
  Object.assign(gridStyle, { gridTemplateColumns: "690.5px", columnGap: "24px", rowGap: "32px" });
  observers[0].callback();
  const stacked = render(hiddenProps);
  assert.equal(stacked.props.hidden, true);
  assertGeometry(stacked);
  assert.equal(observers.length, 1, "Flipping must retain the same geometry observer");

  cards.forEach(card => { card.height += 48; });
  resizeListeners.forEach(callback => callback());
  assertGeometry(render(hiddenProps));
  render.unmount();
  assert.equal(resizeListeners.size, 0, "Unmount must remove the geometry resize listener");
  assert.equal(observers[0].disconnected, true, "Unmount must disconnect source geometry observation");
});
