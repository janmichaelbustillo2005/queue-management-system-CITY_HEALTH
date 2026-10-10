const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../pages/queue-display.js"), "utf8");

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
  sourceSection("  function seedKnownCalls(", "  function unlockAudioFromUserGesture("),
  sourceSection("  function enqueueNewCalls(", "  function delay("),
  sourceSection("  function sendPyttsx3Announcement(", "  const matchesDoctor ="),
  sourceSection("  async function loadDisplay(", "  const formatTime =")
].join("\n");

function createDisplayHarness({ enabled = true, settings = {}, speak = null } = {}) {
  const speech = [];
  let response = {};
  const refs = {
    voiceEnabledRef: { current: enabled },
    seededRef: { current: false },
    announcedKeysRef: { current: new Set() },
    queuedKeysRef: { current: new Set() },
    announcementQueueRef: { current: [] },
    isProcessingRef: { current: false },
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
    async playNotificationBell() {},
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
    async delay() {},
    console: { error() {}, info() {} }
  });
  vm.runInContext(`${displayFunctions}\nthis.displayApi = {
    seedKnownCalls, loadDisplay, collectCallCandidates, getAnnouncementKey
  };`, context, { filename: "queue-display-voice-functions.js" });

  return {
    speech,
    refs,
    api: context.displayApi,
    seed(data = {}) { context.displayApi.seedKnownCalls(data); },
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
