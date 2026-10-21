const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../pages/queue-display.js"), "utf8").replace(/\r\n/g, "\n");

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
  sourceSection("function getStoredAnnounceGapMs()", "async function fetchJsonWithTimeout("),
  sourceSection("  function seedKnownCalls(", "  async function unlockAudioFromUserGesture("),
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
  const refs = {
    ttsMonitorActiveRef: { current: true },
    ttsHealthCheckPendingRef: { current: false },
    ttsReadyRef: { current: null },
    voiceEnabledRef: { current: true },
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
    async fetchJsonWithTimeout(url, options, timeoutMs) {
      requests.push({ url, options, timeoutMs });
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response() : response;
    }
  });
  vm.runInContext(sourceSection("  async function checkPyttsx3Service(", "  async function enableVoiceAnnouncer(") +
    "\nthis.healthApi = { checkPyttsx3Service, verifyTtsService };", context);
  return { api: context.healthApi, refs, settings, requests, readiness, statuses,
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
  vm.runInContext(sourceSection("  useEffect(() => {\n    setMounted(true);", "  useEffect(() => {\n    loadDisplay();"), context);
  assert.equal(active.current, true);
  assert.equal(checks, 1);
  timers.get(5000)();
  assert.equal(checks, 2);
  cleanup();
  assert.equal(active.current, false);
  assert.deepEqual(cleared.sort((a, b) => a - b), [1000, 5000]);
});

function bellUnlockHarness({ blocked = false, speaking = false } = {}) {
  const audioCtxRef = { current: null };
  let ready = false, previews = 0, resumes = 0;
  class BrowserAudio {
    constructor() { this.state = "suspended"; }
    async resume() {
      resumes += 1;
      if (blocked) throw new Error("Browser audio is blocked");
      this.state = "running";
    }
  }
  const context = vm.createContext({
    window: { AudioContext: BrowserAudio }, audioCtxRef, isSpeaking: speaking,
    setBellReady(value) { ready = value; },
    async playCabinChime(ctx) { assert.equal(ctx.state, "running"); previews += 1; }
  });
  vm.runInContext(sourceSection("  async function unlockAudioFromUserGesture(", "  async function checkPyttsx3Service(") +
    "\nthis.audioApi = { enableBell, unlockAudioFromUserGesture };", context);
  return { api: context.audioApi, audioCtxRef, get ready() { return ready; },
    get previews() { return previews; }, get resumes() { return resumes; } };
}

test("Enable Bell resumes browser audio and previews the bell without requesting speech", async () => {
  const h = bellUnlockHarness();
  await h.api.enableBell();
  assert.equal(h.ready, true);
  assert.equal(h.resumes, 1);
  assert.equal(h.previews, 1);
});

test("a rejected browser audio unlock keeps the bell unavailable without failing voice controls", async () => {
  const h = bellUnlockHarness({ blocked: true });
  await h.api.enableBell();
  assert.equal(h.ready, false);
  assert.equal(h.previews, 0);
});

test("unlocking browser audio during speech does not preview a bell over the announcement", async () => {
  const h = bellUnlockHarness({ speaking: true });
  await h.api.enableBell();
  assert.equal(h.ready, true);
  assert.equal(h.previews, 0);
});

function createDisplayHarness({ enabled = true, settings = {}, speak = null, bell = null, delay = null } = {}) {
  const speech = [];
  let response = {};
  const refs = {
    voiceEnabledRef: { current: enabled },
    seededRef: { current: false },
    announcedKeysRef: { current: new Set() },
    queuedKeysRef: { current: new Set() },
    announcementQueueRef: { current: [] },
    isProcessingRef: { current: false },
    activeAnnouncementKeyRef: { current: null },
    playbackGenerationRef: { current: 0 },
    displayRef: { current: {} },
    displayStartedAtRef: { current: Date.parse("2026-10-10T01:00:30.000Z") }
  };
  const runtimeQueueSettings = { voiceAnnouncements: true, announceDoctorRoom: true, ...settings };
  const context = vm.createContext({
    ...refs,
    runtimeQueueSettings,
    ANNOUNCE_GAP_MS_DEFAULT: 3000,
    PYTTSX3_TTS_BASE_URL: "http://isolated-tts.test",
    PYTTSX3_SPEAK_TIMEOUT_MS: 45000,
    PYTTSX3_RETRY_MS: 5000,
    TTS_DEBUG: false,
    setDisplay() {},
    setApiError() {},
    setVoiceEnabled() {},
    setVoiceStatus() {},
    setIsSpeaking() {},
    applyRuntimeSettings(raw) { Object.assign(runtimeQueueSettings, raw); },
    async request(url) {
      assert.equal(url, "/display");
      return response;
    },
    async playNotificationBell() {
      if (bell) await bell();
    },
    async checkPyttsx3Service() {},
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
  vm.runInContext(`${displayFunctions}\nthis.displayApi = {
    seedKnownCalls, loadDisplay, collectCallCandidates, getAnnouncementKey, disableVoiceAnnouncer
  };`, context, { filename: "queue-display-voice-functions.js" });

  return {
    speech,
    refs,
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
    id_num: "Test Patient",
    status: "serving",
    called_at: "2026-10-10T01:00:00.000Z",
    counter_name: "Doctor 1",
    ...overrides
  };
}

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

test("existing announcement wording preserves queue number, patient name, doctor and room", async () => {
  const harness = createDisplayHarness();
  harness.seed();
  await harness.poll({ recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" })] });
  assert.equal(
    harness.speech[0].text,
    "Now calling queue number G P 0 0 1, Test Patient, please proceed to Doctor 1, Room 1."
  );
  assert.equal(harness.speech[0].wait, true);
  assert.equal(harness.speech[0].timeout_seconds, 45);
  assert.equal(harness.speech[0].gap_ms, 3000);
});

test("pyttsx3 speech waits until the notification chime finishes", async () => {
  let finishBell;
  let notifyBellStarted;
  let speakRequests = 0;
  const bellFinished = new Promise((resolve) => { finishBell = resolve; });
  const bellStarted = new Promise((resolve) => { notifyBellStarted = resolve; });
  const harness = createDisplayHarness({
    bell() {
      notifyBellStarted();
      return bellFinished;
    },
    speak() { speakRequests += 1; }
  });
  harness.seed();
  const polling = harness.poll({
    recent_accepted: [calledPatient({ accepted_at: "2026-10-10T01:01:00.000Z" })]
  });

  await bellStarted;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(speakRequests, 0, "The voice request must wait for the chime to finish");
    assert.equal(harness.speech.length, 0);
  } finally {
    finishBell();
  }
  await polling;
  assert.equal(speakRequests, 1);
  assert.equal(harness.speech.length, 1);
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

test("pausing during the bell does not consume an unspoken announcement", async () => {
  let releaseBell;
  let bellStarted;
  let calls = 0;
  const bellReady = new Promise((resolve) => { bellStarted = resolve; });
  const bellFinished = new Promise((resolve) => { releaseBell = resolve; });
  const harness = createDisplayHarness({ bell() {
    calls += 1;
    if (calls === 1) {
      bellStarted();
      return bellFinished;
    }
  } });
  harness.seed();
  const data = { voice_announcements: [calledPatient({
    accepted_at: "2026-10-10T01:01:00.000Z", announcement_key: "pause-during-bell"
  })] };
  await harness.load(data);
  await bellReady;
  harness.api.disableVoiceAnnouncer();
  assert.equal(harness.refs.isProcessingRef.current, true);
  releaseBell();
  await harness.poll(data);
  assert.equal(harness.speech.length, 0);
  assert.equal(harness.refs.announcedKeysRef.current.has("pause-during-bell"), false);
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

test("the slower descending ding-dong rings both notes before speech can begin", async () => {
  const oscillators = [];
  const gains = [];
  let timer;
  let timerMs;
  const context = vm.createContext({
    clearTimeout() {},
    setTimeout(callback, ms) { timer = callback; timerMs = ms; return 1; }
  });
  vm.runInContext(sourceSection("function playCabinChime(", "function formatQueueForSpeech("), context);
  const ctx = {
    state: "running", currentTime: 10, destination: {},
    createOscillator() {
      const osc = {
        frequencyEvents: [], stops: [],
        frequency: { setValueAtTime(value, at) { osc.frequencyEvents.push([value, at]); } },
        connect(gain) { return gain; },
        start(at) { osc.started = at; },
        stop(at) { osc.stops.push(at); },
        disconnect() {}
      };
      oscillators.push(osc);
      return osc;
    },
    createGain() {
      const gain = {
        events: [],
        gain: {
          setValueAtTime(value, at) { gain.events.push(["set", value, at]); },
          linearRampToValueAtTime(value, at) { gain.events.push(["ramp", value, at]); },
          exponentialRampToValueAtTime(value, at) { gain.events.push(["decay", value, at]); }
        },
        connect() {}, disconnect() {}
      };
      gains.push(gain);
      return gain;
    }
  };
  let finished = false;
  const playback = context.playCabinChime(ctx).then(() => { finished = true; });
  assert.equal(Math.round(timerMs), 2320);
  assert.equal(finished, false);
  const milliseconds = (at) => Math.round((at - ctx.currentTime) * 1000);
  assert.deepEqual(oscillators.map(osc => osc.frequencyEvents.map(([frequency, at]) => [frequency, milliseconds(at)])),
    [[[880, 20]], [[660, 820]]]);
  assert.deepEqual(oscillators.map(osc => milliseconds(osc.stops[0])), [1220, 2020]);
  assert.deepEqual(gains.map(gain => gain.events.map(([kind, value, at]) => [kind, Number(value.toFixed(6)), milliseconds(at)])), [
    [["set", 0, 20], ["ramp", 0.30, 35], ["decay", 0.00015, 1200], ["ramp", 0, 1220]],
    [["set", 0, 820], ["ramp", 0.34, 835], ["decay", 0.00017, 2000], ["ramp", 0, 2020]]
  ]);
  oscillators[1].onended();
  await playback;
  assert.equal(finished, true);
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
