const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../pages/queue-display.js"), "utf8");
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
    id_num: "Test Patient",
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
