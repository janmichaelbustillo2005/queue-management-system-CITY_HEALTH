import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api";
import { defaultQueueSettings } from "../components/SettingsModal";
import { mergeQueueSettings, persistLocalQueueSettings } from "../lib/queueSettings";
import { readAnnouncementRecovery, writeAnnouncementRecovery, clearAnnouncementRecovery } from "../lib/announcementRecovery";
import SystemLogo from "../components/SystemLogo";

const ANNOUNCE_GAP_MS_DEFAULT = 3000;
const DISPLAY_POLL_MS = 1500;
const DISPLAY_FLIP_MS = 10000;
const DISPLAY_FADE_MS = 400;
const PYTTSX3_TTS_BASE_URL = (process.env.NEXT_PUBLIC_PYTTSX3_TTS_URL || "http://127.0.0.1:8765").replace(/\/+$/, "");
const PYTTSX3_HEALTH_TIMEOUT_MS = 6500;
const PYTTSX3_SPEAK_TIMEOUT_MS = 45000;
const PYTTSX3_RETRY_MS = 5000;
const TTS_DEBUG = process.env.NEXT_PUBLIC_TTS_DEBUG !== "0";
const TTS_LOG_PREFIX = "[QueueDisplay TTS]";

function groupWaitingQueues(displayData, counters, matchService) {
  const groups = counters.map((counter) => ({ counter, rows: [] }));
  const servingIds = new Set((displayData?.all_serving || []).map((row) => String(row.id)));
  const seen = new Set();
  for (const row of displayData?.waiting_queue || []) {
    const id = String(row.id);
    if (row.status !== "waiting" || row.completed_at || servingIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const assignment = row.counter_id ?? row.counter_name;
    let group = assignment == null ? null : groups.find(({ counter }) =>
      String(counter.id) === String(assignment) || counter.id_num === assignment || counter.name === assignment);
    if (!group) group = groups.find(({ counter }) => matchService(row.service_type, counter.service_types || []));
    if (!group) {
      const doctor = ["prenatal", "maternity"].includes(row.service_type) ? "Doctor 2"
        : row.service_type === "family_planning" ? "Doctor 3" : "Doctor 1";
      group = groups.find(({ counter }) => counter.id_num === doctor);
    }
    if (group) group.rows.push(row);
  }
  return groups;
}

function getWaitingPage(rows, previous, pageSize, advance = false) {
  const ids = rows.map((row) => String(row.id));
  const positions = new Map(ids.map((id, index) => [id, index]));
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const oldStart = previous?.start || 0;
  const candidates = (previous?.ids || []).slice(oldStart + (advance ? previous.count : 0));
  const nextId = candidates.find((id) => positions.has(id));
  const start = nextId == null ? 0 : positions.get(nextId);
  const pageRows = rows.slice(start, start + size);
  return { rows: pageRows, ids, start, count: pageRows.length };
}

function measureWaitingLayout(cardHeight, headerHeight = 64, footerHeight = 44) {
  const height = cardHeight > 0 ? cardHeight : 408;
  return { cardHeight: height, headerHeight, footerHeight,
    pageSize: Math.max(1, Math.floor((height - 2 - headerHeight - footerHeight - 48 - 36) / 48)) };
}

function startQueueDisplayFlipping(onFade, onSwap, timers = globalThis) {
  let waiting = false;
  let transitionTimer = null;
  const interval = timers.setInterval(() => {
    onFade(true);
    transitionTimer = timers.setTimeout(() => {
      waiting = !waiting;
      onSwap(waiting);
      onFade(false);
      transitionTimer = null;
    }, DISPLAY_FADE_MS / 2);
  }, DISPLAY_FLIP_MS);
  return () => {
    timers.clearInterval(interval);
    if (transitionTimer !== null) timers.clearTimeout(transitionTimer);
  };
}

let runtimeQueueSettings = { ...defaultQueueSettings };

function applyRuntimeSettings(raw) {
  runtimeQueueSettings = mergeQueueSettings(raw || {});
  try {
    persistLocalQueueSettings(runtimeQueueSettings);
  } catch (_e) {
    // ignore
  }
  return runtimeQueueSettings;
}

function getAnnouncementStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch (_error) {
    return null;
  }
}

function getStoredAnnounceGapMs() {
  const gapSec = Number(runtimeQueueSettings?.announceGapSeconds);
  if (!Number.isFinite(gapSec) || gapSec < 0) return ANNOUNCE_GAP_MS_DEFAULT;
  return Math.round(gapSec * 1000);
}

function voiceAnnouncementsAllowed() {
  return runtimeQueueSettings?.voiceAnnouncements !== false;
}

function soundNotificationsAllowed() {
  return runtimeQueueSettings?.soundNotifications !== false;
}

function formatQueueForSpeech(queueNumber) {
  return String(queueNumber || "")
    .replace(/-/g, "")
    .replace(/\s+/g, "")
    .split("")
    .join(" ");
}

const DOCTOR_INFO_MAP = {
  "Doctor 1": { specialty: "General Practitioner", badge: "GP", room: "Room 1" },
  "Doctor 2": { specialty: "Prenatal & Maternity", badge: "OB", room: "Room 2" },
  "Doctor 3": { specialty: "Family Planning", badge: "FP", room: "Room 3" }
};

function getAnnouncementKey(patient) {
  if (patient?.announcement_key) return patient.announcement_key;
  const eventAt = patient?.announcement_at || patient?.accepted_at;
  if (!patient?.id || !eventAt) return null;
  return `${patient.id}:${eventAt}`;
}

function resolveDoctorName(patient) {
  const raw = patient?.counter_name || patient?.counter_id || "";
  if (typeof raw === "string" && DOCTOR_INFO_MAP[raw]) return raw;
  if (typeof raw === "string" && raw.startsWith("Doctor")) return raw;
  return typeof raw === "string" && raw && Number.isNaN(Number(raw)) ? raw : "Doctor";
}

function resolveRoom(doctorName) {
  return DOCTOR_INFO_MAP[doctorName]?.room || "";
}

function collectCallCandidates(displayData) {
  const byKey = new Map();
  const source = Array.isArray(displayData?.voice_announcements)
    ? displayData.voice_announcements
    : displayData?.recent_accepted || [];

  for (const patient of source) {
    if (patient?.status && patient.status !== "serving") continue;
    const key = getAnnouncementKey(patient);
    if (key && !byKey.has(key)) byKey.set(key, patient);
  }

  return Array.from(byKey.values());
}

function logTts(stage, details = {}) {
  if (!TTS_DEBUG || typeof console === "undefined") return;
  console.info(TTS_LOG_PREFIX, stage, {
    at: new Date().toISOString(),
    ...details
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.error || data?.message || `Request failed with status ${response.status}`);
    }
    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("pyttsx3 service timed out");
    }
    if (err instanceof TypeError) {
      throw new Error(`Cannot reach the voice service at ${PYTTSX3_TTS_BASE_URL}. Start the local Python voice service on the display computer`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export default function QueueDisplayPage() {
  const [time, setTime] = useState(new Date());
  const [mounted, setMounted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [ttsReady, setTtsReady] = useState(null);
  const [voiceStatus, setVoiceStatus] = useState("Checking local voice service...");
  const [display, setDisplay] = useState({
    settings: {
      department_name: "CHO & Family Planning Center Cabadbaran City",
      welcome_message: "Welcome to City Health Queuing System"
    },
    all_serving: [],
    counters: [],
    now_serving: null,
    next_in_line: null,
    waiting_count: 0,
    recent_called: [],
    waiting_queue: []
  });

  const [apiError, setApiError] = useState(null);
  const [showWaiting, setShowWaiting] = useState(false);
  const [viewFading, setViewFading] = useState(false);
  const [waitingVisit, setWaitingVisit] = useState(0);

  const announcementQueueRef = useRef([]);
  const announcedKeysRef = useRef(new Set());
  const queuedKeysRef = useRef(new Set());
  const eligibleAnnouncementKeysRef = useRef(new Set());
  const isProcessingRef = useRef(false);
  const activeAnnouncementKeyRef = useRef(null);
  const playbackGenerationRef = useRef(0);
  const voiceEnableAttemptRef = useRef(0);
  const voiceEnabledRef = useRef(true);
  const seededRef = useRef(false);
  const displayStartedAtRef = useRef(Date.now());
  const ttsMonitorActiveRef = useRef(false);
  const ttsHealthCheckPendingRef = useRef(false);
  const ttsHealthRequestSequenceRef = useRef(0);
  const ttsReadyRef = useRef(null);
  const servingGridRef = useRef(null);
  const displayActiveRef = useRef(true);
  const displayRecoveryInitializedRef = useRef(false);
  const lastAppliedPollStartedAtRef = useRef(null);
  // Only a successful, sequence-ordered server response may replace this
  // snapshot. A passive effect from an older render must never copy over it.
  const displayRef = useRef(display);
  const displayRequestSequenceRef = useRef(0);
  const appliedDisplaySequenceRef = useRef(0);

  useEffect(() => {
    setMounted(true);
    ttsMonitorActiveRef.current = true;
    logTts("mounted", { ttsUrl: PYTTSX3_TTS_BASE_URL });
    verifyTtsService();
    const timer = setInterval(() => setTime(new Date()), 1000);
    const healthTimer = setInterval(verifyTtsService, PYTTSX3_RETRY_MS);
    return () => {
      ttsMonitorActiveRef.current = false;
      clearInterval(timer);
      clearInterval(healthTimer);
    };
  }, []);

  useEffect(() => {
    startDisplayListener();
    loadDisplay();
    const interval = setInterval(loadDisplay, DISPLAY_POLL_MS);
    return () => {
      clearInterval(interval);
      stopDisplayListener();
    };
  }, []);

  useEffect(() => startQueueDisplayFlipping(setViewFading, (waiting) => {
    setShowWaiting(waiting);
    if (waiting) setWaitingVisit((visit) => visit + 1);
  }), []);

  // Bell and speech come from the local Python service without a browser
  // audio-unlock gesture. Action handlers own the live voice ref; React state
  // renders it but must not overwrite a newer action from a passive effect.

  function startDisplayListener() {
    displayActiveRef.current = true;
    voiceEnabledRef.current = voiceEnabled;
    if (displayRecoveryInitializedRef.current) return;
    const startedAt = Date.now();
    const since = readAnnouncementRecovery(getAnnouncementStorage(), startedAt);
    displayStartedAtRef.current = since;
    displayRecoveryInitializedRef.current = true;
    rememberAnnouncementRecovery();
    logTts("display-session-start", { recoveringRecentEvents: since < startedAt });
  }

  function stopDisplayListener() {
    // Preserve unconsumed work before dropping the in-memory queue. An already
    // posted request finishes in Python; its key still deduplicates on reload.
    rememberAnnouncementRecovery();
    displayActiveRef.current = false;
    voiceEnabledRef.current = false;
    pauseAnnouncementQueue();
    appliedDisplaySequenceRef.current = ++displayRequestSequenceRef.current;
  }

  function rememberAnnouncementRecovery() {
    if (!displayActiveRef.current) return;
    const storage = getAnnouncementStorage();
    if (!voiceEnabledRef.current || !voiceAnnouncementsAllowed()) {
      clearAnnouncementRecovery(storage);
      return;
    }
    // Request start is a safe lower bound: a call may arrive after the server's
    // snapshot but before the response reaches this display. Never checkpoint
    // the response time or move past queued/active/retrying announcements.
    let since = lastAppliedPollStartedAtRef.current ?? displayStartedAtRef.current;
    for (const patient of collectCallCandidates(displayRef.current)) {
      const key = getAnnouncementKey(patient);
      const eventAt = Date.parse(patient.announcement_at || patient.accepted_at);
      if (key && !announcedKeysRef.current.has(key) && Number.isFinite(eventAt) &&
          eventAt >= displayStartedAtRef.current) {
        since = Math.min(since, eventAt);
      }
    }
    writeAnnouncementRecovery(storage, since);
  }

  function seedKnownCalls(displayData, seedBeforeMs = displayStartedAtRef.current) {
    const candidates = collectCallCandidates(displayData);
    const seededKeys = [];
    candidates.forEach((patient) => {
      const key = getAnnouncementKey(patient);
      const eventAtMs = new Date(patient?.announcement_at || patient?.accepted_at || 0).getTime();
      if (key && (!Number.isFinite(eventAtMs) || eventAtMs < seedBeforeMs)) {
        announcedKeysRef.current.add(key);
        seededKeys.push(key);
      }
    });
    seededRef.current = true;
    logTts("seed-known-calls", {
      candidates: candidates.length,
      seededKeys,
      seedBefore: new Date(seedBeforeMs).toISOString()
    });
  }

  async function checkPyttsx3Service({ initialize = false } = {}) {
    const requestSequence = ++ttsHealthRequestSequenceRef.current;
    const generation = playbackGenerationRef.current;
    const enableAttempt = voiceEnableAttemptRef.current;
    const canApplyReadiness = () => ttsMonitorActiveRef.current && displayActiveRef.current &&
      requestSequence === ttsHealthRequestSequenceRef.current &&
      generation === playbackGenerationRef.current && enableAttempt === voiceEnableAttemptRef.current;
    const suffix = initialize ? "?init=1" : "";
    const url = `${PYTTSX3_TTS_BASE_URL}/health${suffix}`;
    logTts("health-check-start", { url, initialize });
    try {
      const data = await fetchJsonWithTimeout(url, { method: "GET" }, PYTTSX3_HEALTH_TIMEOUT_MS);
      logTts("health-check-ok", {
        url,
        ready: data.ready,
        dryRun: data.dry_run,
        chimeSupported: data.chime_supported,
        lastChimeError: data.last_chime_error,
        audioThread: data.audio_thread,
        queueLength: data.queue_length,
        speaking: data.speaking,
        lastError: data.last_error
      });
      if (data.engine !== "pyttsx3" || data.ready !== true) {
        throw new Error(data.last_error || "pyttsx3 service is not ready");
      }
      if (data.dry_run === true) {
        throw new Error("Voice service is in silent test mode. Restart it without --dry-run to hear announcements.");
      }
      if (canApplyReadiness()) {
        ttsReadyRef.current = true;
        setTtsReady(true);
      }
      return data;
    } catch (err) {
      if (canApplyReadiness()) {
        ttsReadyRef.current = false;
        setTtsReady(false);
      }
      throw err;
    }
  }

  function canRefreshTtsServiceStatus() {
    return ttsMonitorActiveRef.current && voiceEnabledRef.current && voiceAnnouncementsAllowed() &&
      !isProcessingRef.current && announcementQueueRef.current.length === 0;
  }

  async function verifyTtsService() {
    if (!canRefreshTtsServiceStatus() || ttsHealthCheckPendingRef.current) return;
    ttsHealthCheckPendingRef.current = true;
    const generation = playbackGenerationRef.current;
    const enableAttempt = voiceEnableAttemptRef.current;
    const healthRequest = checkPyttsx3Service({ initialize: ttsReadyRef.current !== true });
    const requestSequence = ttsHealthRequestSequenceRef.current;
    const canApplyStatus = () => canRefreshTtsServiceStatus() &&
      requestSequence === ttsHealthRequestSequenceRef.current &&
      generation === playbackGenerationRef.current && enableAttempt === voiceEnableAttemptRef.current;
    try {
      const health = await healthRequest;
      if (canApplyStatus()) {
        setVoiceStatus("Voice service ready. Listening for doctor calls...");
      }
      logTts("idle-health-ready", health);
    } catch (err) {
      if (canApplyStatus()) {
        setVoiceStatus(`Voice service offline: ${err.message || "not reachable"}. Retrying automatically...`);
      }
      logTts("idle-health-failed", { error: err.message || String(err) });
    } finally {
      ttsHealthCheckPendingRef.current = false;
    }
  }

  async function enableVoiceAnnouncer() {
    if (!displayActiveRef.current) return;
    const attempt = ++voiceEnableAttemptRef.current;
    const generation = playbackGenerationRef.current;
    const isCurrentAttempt = () => displayActiveRef.current &&
      attempt === voiceEnableAttemptRef.current && generation === playbackGenerationRef.current;
    if (!voiceAnnouncementsAllowed()) {
      setVoiceStatus("Voice announcements are disabled in System Settings.");
      return;
    }
    setVoiceStatus("Checking local pyttsx3 service...");
    try {
      await checkPyttsx3Service({ initialize: true });
    } catch (err) {
      if (!isCurrentAttempt()) return;
      voiceEnabledRef.current = false;
      pauseAnnouncementQueue();
      setVoiceEnabled(false);
      setIsSpeaking(false);
      rememberAnnouncementRecovery();
      setVoiceStatus(`pyttsx3 unavailable: ${err.message || "start the local TTS service"}`);
      return;
    }
    if (!isCurrentAttempt()) return;
    if (!voiceAnnouncementsAllowed()) {
      setVoiceStatus("Voice announcements are disabled in System Settings.");
      return;
    }
    if (!seededRef.current) {
      seedKnownCalls(displayRef.current);
    }
    voiceEnabledRef.current = true;
    setVoiceEnabled(true);
    setVoiceStatus("Listening for doctor calls via pyttsx3...");
    setIsSpeaking(false);
  }

  function disableVoiceAnnouncer() {
    voiceEnabledRef.current = false;
    pauseAnnouncementQueue();
    setVoiceEnabled(false);
    setVoiceStatus("Voice announcements paused on this display.");
    setIsSpeaking(false);
    rememberAnnouncementRecovery();
  }

  function pauseAnnouncementQueue() {
    playbackGenerationRef.current += 1;
    voiceEnableAttemptRef.current += 1;
    announcementQueueRef.current = [];
    // The in-flight processor still owns its key until its await finishes.
    // Retain that ownership so a quick re-enable cannot start another worker.
    queuedKeysRef.current = new Set(
      activeAnnouncementKeyRef.current ? [activeAnnouncementKeyRef.current] : []
    );
  }

  function isAnnouncementEligible(key) {
    return eligibleAnnouncementKeysRef.current.has(key);
  }

  function reconcileAnnouncementQueue(candidatePatients) {
    eligibleAnnouncementKeysRef.current = new Set(candidatePatients.map(getAnnouncementKey));
    announcementQueueRef.current = announcementQueueRef.current.filter((item) => isAnnouncementEligible(item.key));
    // Keep ownership of the current worker's key until its await finishes. A
    // removed event is checked before playback, while a posted request finishes.
    queuedKeysRef.current = new Set(announcementQueueRef.current.map((item) => item.key));
    if (activeAnnouncementKeyRef.current) queuedKeysRef.current.add(activeAnnouncementKeyRef.current);
  }

  function enqueueNewCalls(candidatePatients) {
    if (!voiceEnabledRef.current || !seededRef.current) {
      logTts("enqueue-skipped-disabled-or-unseeded", {
        voiceEnabled: voiceEnabledRef.current,
        seeded: seededRef.current,
        candidates: candidatePatients?.length || 0
      });
      return;
    }

    const newcomers = [];
    for (const patient of candidatePatients || []) {
      const key = getAnnouncementKey(patient);
      if (!key) continue;
      const eventAtMs = new Date(patient.announcement_at || patient.accepted_at).getTime();
      if (eventAtMs < displayStartedAtRef.current) {
        announcedKeysRef.current.add(key);
        continue;
      }
      if (announcedKeysRef.current.has(key)) {
        logTts("candidate-skipped-already-announced", { key, queueNumber: patient.queue_number });
        continue;
      }
      if (queuedKeysRef.current.has(key)) {
        logTts("candidate-skipped-already-queued", { key, queueNumber: patient.queue_number });
        continue;
      }

      queuedKeysRef.current.add(key);
      const doctorName = resolveDoctorName(patient);
      newcomers.push({
        key,
        patient: {
          id: patient.id,
          queue_number: patient.queue_number,
          id_num: patient.id_num,
          counter_name: doctorName,
          room: resolveRoom(doctorName),
          called_at: patient.called_at,
          accepted_at: patient.accepted_at,
          announcement_at: patient.announcement_at || patient.accepted_at,
          announcement_key: key
        },
        calledAtMs: new Date(patient.announcement_at || patient.accepted_at).getTime()
      });
      logTts("candidate-queued", {
        key,
        eventType: patient.event_type,
        queueNumber: patient.queue_number,
        patientName: patient.id_num,
        doctorName,
        room: resolveRoom(doctorName),
        announcementAt: patient.announcement_at || patient.accepted_at
      });
    }

    if (!newcomers.length) {
      processAnnouncementQueue();
      return;
    }

    newcomers.sort((a, b) => a.calledAtMs - b.calledAtMs);
    announcementQueueRef.current.push(...newcomers);
    announcementQueueRef.current.sort((a, b) => a.calledAtMs - b.calledAtMs);
    setVoiceStatus(`Queued: ${announcementQueueRef.current.length} announcement(s)`);
    logTts("queue-ready", {
      queueLength: announcementQueueRef.current.length,
      keys: announcementQueueRef.current.map((item) => item.key)
    });
    processAnnouncementQueue();
  }

  async function processAnnouncementQueue() {
    if (!displayActiveRef.current) return;
    if (isProcessingRef.current) return;
    if (!voiceEnabledRef.current) return;
    if (announcementQueueRef.current.length === 0) return;

    isProcessingRef.current = true;
    logTts("process-start", { queueLength: announcementQueueRef.current.length });

    while (displayActiveRef.current && voiceEnabledRef.current && announcementQueueRef.current.length > 0) {
      const next = announcementQueueRef.current.shift();
      if (!next?.patient) continue;
      if (!isAnnouncementEligible(next.key)) {
        queuedKeysRef.current.delete(next.key);
        continue;
      }
      activeAnnouncementKeyRef.current = next.key;

      try {
        logTts("process-next", {
          key: next.key,
          queueNumber: next.patient.queue_number,
          doctorName: next.patient.counter_name,
          room: next.patient.room
        });
        const spoken = await speakPatientAnnouncement(next.patient);
        if (spoken) announcedKeysRef.current.add(next.key);
        queuedKeysRef.current.delete(next.key);
        logTts(spoken ? "process-spoken" : "process-paused", { key: next.key, queueNumber: next.patient.queue_number });
      } catch (err) {
        // Service outages are handled below with a status message and retry.
        // Logging a caught Error with console.error opens the Next.js dev overlay.
        logTts("process-error", {
          key: next.key,
          queueNumber: next.patient?.queue_number,
          error: err.message || String(err)
        });
        if (!displayActiveRef.current || !voiceEnabledRef.current) {
          queuedKeysRef.current.delete(next.key);
          break;
        }
        if (!isAnnouncementEligible(next.key)) {
          queuedKeysRef.current.delete(next.key);
          continue;
        }
        if (!announcedKeysRef.current.has(next.key)) {
          announcementQueueRef.current.unshift(next);
        } else {
          queuedKeysRef.current.delete(next.key);
        }
        setVoiceStatus(`pyttsx3 unavailable: ${err.message || "playback failed"}; retrying...`);
        await delay(PYTTSX3_RETRY_MS);
        continue;
      } finally {
        activeAnnouncementKeyRef.current = null;
        if (!announcementQueueRef.current.some((item) => item.key === next.key)) {
          queuedKeysRef.current.delete(next.key);
        }
        rememberAnnouncementRecovery();
      }

      if (voiceEnabledRef.current && announcementQueueRef.current.length > 0) {
        await delay(getStoredAnnounceGapMs());
      }
    }

    isProcessingRef.current = false;
    logTts("process-finished", { remaining: announcementQueueRef.current.length });
    if (displayActiveRef.current && voiceEnabledRef.current) {
      setVoiceStatus(
        announcementQueueRef.current.length
          ? `Queued: ${announcementQueueRef.current.length} announcement(s)`
          : "Listening for doctor calls via pyttsx3..."
      );
    }

    if (displayActiveRef.current && voiceEnabledRef.current && announcementQueueRef.current.length > 0) {
      processAnnouncementQueue();
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendPyttsx3Announcement(payload) {
    const requestBody = {
      ...payload,
      play_chime: soundNotificationsAllowed(),
      wait: true,
      timeout_seconds: Math.ceil(PYTTSX3_SPEAK_TIMEOUT_MS / 1000),
      gap_ms: getStoredAnnounceGapMs()
    };
    logTts("speak-request-start", {
      url: `${PYTTSX3_TTS_BASE_URL}/speak`,
      key: requestBody.key,
      queueNumber: requestBody.queue_number,
      patientName: requestBody.patient_name,
      doctorName: requestBody.doctor_name,
      room: requestBody.room,
      text: requestBody.text
    });
    return fetchJsonWithTimeout(
      `${PYTTSX3_TTS_BASE_URL}/speak`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      },
      PYTTSX3_SPEAK_TIMEOUT_MS
    ).then((result) => {
      logTts("speak-request-ok", {
        key: requestBody.key,
        success: result?.success,
        duplicate: result?.duplicate,
        serviceKey: result?.key
      });
      return result;
    });
  }

  async function speakPatientAnnouncement(patient) {
    const generation = playbackGenerationRef.current;
    const key = getAnnouncementKey(patient);
    if (!displayActiveRef.current || !isAnnouncementEligible(key)) return false;
    setIsSpeaking(true);
    setVoiceStatus(`Announcing ${patient.queue_number || "patient"}…`);

    try {
      await checkPyttsx3Service({ initialize: true });
      if (!displayActiveRef.current || !voiceEnabledRef.current || generation !== playbackGenerationRef.current || !isAnnouncementEligible(key)) {
        setIsSpeaking(false);
        return false;
      }
    } catch (_e) {
      setIsSpeaking(false);
      throw _e;
    }

    if (!displayActiveRef.current || !voiceEnabledRef.current || generation !== playbackGenerationRef.current || !isAnnouncementEligible(key)) {
      setIsSpeaking(false);
      return false;
    }

    const queueNumber = patient.queue_number || "";
    const name = patient.id_num || "Patient";
    const doctorName = patient.counter_name || "Doctor";
    const room = patient.room || resolveRoom(doctorName);
    const includeRoom = runtimeQueueSettings?.announceDoctorRoom !== false;
    const destination = includeRoom && room ? `${doctorName}, ${room}` : doctorName;
    const spokenQueue = formatQueueForSpeech(queueNumber);
    const text = `Now calling queue number ${spokenQueue}, ${name}, please proceed to ${destination}.`;
    logTts("announcement-built", {
      key: patient.announcement_key,
      queueNumber,
      patientName: name,
      doctorName,
      room,
      text
    });

    try {
      const result = await sendPyttsx3Announcement({
        key: patient.announcement_key,
        text,
        queue_number: queueNumber,
        patient_name: name,
        doctor_name: doctorName,
        room,
        accepted_at: patient.accepted_at,
        announcement_at: patient.announcement_at
      });
      if (result?.duplicate) {
        setVoiceStatus(`${queueNumber || "Patient"} is already queued in pyttsx3`);
      }
      return true;
    } finally {
      setIsSpeaking(false);
    }
  }

  const matchesDoctor = (serviceType, assignedServices) => {
    if (!serviceType || !assignedServices) return false;
    if (assignedServices.includes(serviceType)) return true;

    const serviceToCategory = {
      consultation: "GP", checkup: "GP", laboratory: "GP", dental: "GP",
      prenatal: "OB", maternity: "OB", obgyne: "OB",
      family_planning: "FP"
    };

    const patientCategory = serviceToCategory[serviceType];
    const doctorCategories = assignedServices.map(s => serviceToCategory[s]).filter(Boolean);

    return patientCategory && doctorCategories.includes(patientCategory);
  };

  async function loadDisplay() {
    if (!displayActiveRef.current) return;
    const pollStartedAt = Date.now();
    // Refresh the recovery heartbeat even when this poll fails, retaining the
    // last safe frontier rather than silently consuming unseen events.
    rememberAnnouncementRecovery();
    const requestSequence = ++displayRequestSequenceRef.current;
    try {
      const data = await request("/display");
      if (!displayActiveRef.current || requestSequence < appliedDisplaySequenceRef.current) return;

      if (!data || data.error || data.success === false) {
        setApiError(data?.error || data?.message || "Cannot load queue display");
        return;
      }

      const candidates = collectCallCandidates(data);
      appliedDisplaySequenceRef.current = requestSequence;
      lastAppliedPollStartedAtRef.current = pollStartedAt;
      reconcileAnnouncementQueue(candidates);
      setApiError(null);
      setDisplay(data);
      displayRef.current = data;
      if (candidates.length) {
        logTts("display-events-received", {
          count: candidates.length,
          events: candidates.map((patient) => ({
            key: getAnnouncementKey(patient),
            eventType: patient.event_type,
            queueNumber: patient.queue_number,
            patientName: patient.id_num,
            doctorName: resolveDoctorName(patient),
            room: resolveRoom(resolveDoctorName(patient)),
            announcementAt: patient.announcement_at || patient.accepted_at
          }))
        });
      }

      if (data.queue_settings) {
        applyRuntimeSettings(data.queue_settings);
        if (!voiceAnnouncementsAllowed()) {
          // Global disable is authoritative even while an Enable check is
          // pending and the current voice ref is already false.
          voiceEnableAttemptRef.current += 1;
          if (voiceEnabledRef.current) {
            voiceEnabledRef.current = false;
            pauseAnnouncementQueue();
            setVoiceEnabled(false);
            setIsSpeaking(false);
            setVoiceStatus("Voice announcements disabled in System Settings");
          }
        }
      }

      if (!seededRef.current) {
        seedKnownCalls(data);
      }

      if (voiceEnabledRef.current && voiceAnnouncementsAllowed()) {
        enqueueNewCalls(candidates);
      }
      rememberAnnouncementRecovery();
    } catch (_error) {
      if (!displayActiveRef.current || requestSequence < appliedDisplaySequenceRef.current) return;
      setApiError("Cannot connect to server");
      logTts("display-load-error", { error: _error.message || String(_error) });
    }
  }

  const formatTime = (date) => {
    return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  };

  const formatDate = (date) => {
    return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  };

  const doctorInfoMap = DOCTOR_INFO_MAP;
  const allServing = display?.all_serving || [];
  const countersFromApi = display?.counters || [];
  const allCounters = countersFromApi.length > 0 ? countersFromApi.slice(0, 3) : [
    { id: 1, id_num: "Doctor 1" },
    { id: 2, id_num: "Doctor 2" },
    { id: 3, id_num: "Doctor 3" }
  ];

  return (
    <div className="layout-shell display-page queue-display-screen min-h-screen flex flex-col font-sans">
      <header className="queue-display-header px-6 py-4 flex items-center justify-between border-b border-[var(--display-border)] bg-[var(--display-card-header)]">
        <div className="queue-display-brand flex items-center gap-4">
          <SystemLogo variant="display" />
          <div className="queue-display-title">
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight">
              {display?.settings?.department_name || "CHO & Family Planning Center"} Smart Queuing System
            </h1>
            <p className="text-xs md:text-sm text-white/70 font-bold uppercase tracking-widest">
              CHO CABADBARAN CITY
            </p>
          </div>
        </div>

        <div className="queue-display-controls flex items-center">
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={() => {
                if (voiceEnabled) disableVoiceAnnouncer();
                else enableVoiceAnnouncer();
              }}
              aria-pressed={voiceEnabled}
              title={voiceEnabled ? "Pause voice announcements on this display." : "Enable voice announcements on this display."}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${
                voiceEnabled
                  ? ttsReady === true
                    ? "brand-button text-white shadow-md"
                    : "bg-amber-500/20 text-amber-200 border border-amber-400/40"
                  : "bg-white/5 text-white/70 border border-white/10 hover:bg-white/10"
              }`}
            >
              <i className={`fas ${voiceEnabled ? "fa-volume-up" : "fa-volume-mute"}`} />
              {voiceEnabled ? (isSpeaking ? "Announcing…" : "Voice Enabled") : "Voice Disabled"}
              {voiceEnabled && !isSpeaking ? (
                <span className="text-[9px] opacity-90">
                  ({ttsReady === true ? "Ready" : ttsReady === false ? "Offline" : "Checking"})
                </span>
              ) : null}
            </button>
            {voiceStatus ? (
              <span
                role="status"
                title={voiceStatus}
                className="text-[10px] text-white/70 font-semibold max-w-[300px] text-right whitespace-normal break-words"
              >
                {voiceStatus}
              </span>
            ) : null}
          </div>
          <div className="text-right min-w-[140px]">
            {mounted ? (
              <>
                <div className="text-2xl md:text-3xl font-mono font-bold text-white leading-none">
                  {formatTime(time)}
                </div>
                <div className="text-[10px] md:text-xs text-white/60 uppercase tracking-tighter mt-1 font-bold">
                  {formatDate(time)}
                </div>
              </>
            ) : (
              <div className="h-10" />
            )}
          </div>
        </div>
      </header>

      <main className="queue-display-main flex-1 container mx-auto px-4 py-6 max-w-7xl">
        {apiError && (
          <div className="queue-display-error mb-4 text-center text-red-400 font-bold bg-black/40 py-2 rounded-lg border border-red-400/50">
            ⚠️ {apiError}
          </div>
        )}

        <div className="queue-display-stage" style={{ position: "relative", opacity: viewFading ? 0 : 1, transition: `opacity ${DISPLAY_FADE_MS / 2}ms ease-in-out` }}>
          <div className="queue-serving-view" aria-hidden={showWaiting} style={{ visibility: showWaiting ? "hidden" : "visible" }}>
        <div ref={servingGridRef} className="queue-serving-grid grid grid-cols-1 lg:grid-cols-3 gap-6">
          {allCounters.map((counter) => {
            const servingPatient = allServing.find((s) =>
              s.counter_id === counter.id ||
              s.counter_id === counter.id_num ||
              s.counter_name === counter.id_num
            );
            const info = doctorInfoMap[counter.id_num] || { specialty: "Medical Professional", badge: "MD", room: "TBA" };
            const isAvailable = !servingPatient;
            const counterServices = counter.service_types || [];
            const waitingForCounter = display?.waiting_queue?.filter((p) =>
              matchesDoctor(p.service_type, counterServices)
            ).length || 0;
            const nextForCounter = display?.waiting_queue?.find((p) =>
              matchesDoctor(p.service_type, counterServices)
            );

            return (
              <div key={counter.id} className="queue-serving-card display-card overflow-hidden border border-[var(--display-border)] flex flex-col shadow-2xl">
                <div className="queue-serving-card-header bg-[var(--display-card-header)] px-5 py-4 flex items-center justify-between border-b border-[var(--display-border)]">
                  <div>
                    <h3 className="text-lg font-bold text-white">{counter.id_num}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="bg-[var(--brand-primary)] text-white text-[10px] font-black px-2 py-0.5 rounded shadow-sm">
                      {info.badge}
                    </span>
                    <span className="text-[10px] text-white/60 font-black uppercase">{info.room}</span>
                  </div>
                </div>

                <div className="queue-serving-body flex-1 flex flex-col items-center justify-center p-8 bg-[var(--display-inner-bg)]">
                  <p className="queue-serving-label text-[10px] text-white/60 uppercase font-black tracking-[0.3em] mb-4">Now Serving</p>
                  <div className="queue-serving-number w-full bg-[var(--display-card-header)] rounded-2xl py-8 mb-6 border border-[var(--display-border)] flex items-center justify-center min-h-[140px] shadow-inner">
                    {servingPatient ? (
                      <div className="text-5xl md:text-7xl font-black queue-number text-[var(--brand-gold-bright)] tracking-tighter flip-in">
                        {servingPatient.queue_number}
                      </div>
                    ) : (
                      <div className="text-5xl md:text-7xl font-black text-white/5 tracking-widest">—</div>
                    )}
                  </div>
                  <div className="queue-serving-patient text-center h-12">
                    {servingPatient ? (
                      <>
                        <h4 className="text-lg font-bold text-white leading-tight truncate max-w-[240px]">
                          {servingPatient.id_num}
                        </h4>
                        <p className="text-[10px] text-white/60 uppercase font-black tracking-widest mt-1">
                          {servingPatient.service_type}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-white/60 font-black uppercase tracking-widest">No patient being served</p>
                    )}
                  </div>
                </div>

                <div className="queue-serving-status px-5 pb-6 flex justify-center bg-[var(--display-inner-bg)]">
                  <div className={`
                    flex items-center gap-2 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-widest border
                    ${isAvailable
                      ? "bg-[var(--display-card-bg)] text-[var(--display-positive)] border-[var(--display-border)]"
                      : "bg-[var(--brand-primary)] text-white border-transparent shadow-lg"}
                  `}>
                    <div className={`w-2 h-2 rounded-full ${isAvailable ? "bg-[var(--display-positive)]" : "bg-white"} animate-pulse`} />
                    {isAvailable ? "Available" : "Serving"}
                  </div>
                </div>

                <div className="queue-serving-card-footer bg-[var(--display-card-header)] px-5 py-3 flex items-center justify-between text-[10px] font-bold border-t border-[var(--display-border)]">
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 uppercase tracking-wider">Next</span>
                    <span className="text-[var(--display-positive)] font-black">{nextForCounter?.queue_number || "TBA"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 uppercase tracking-wider">Waiting</span>
                    <span className="text-white font-black">{waitingForCounter}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

          </div>
          <WaitingQueueView displayData={display} counters={allCounters} matchService={matchesDoctor} visible={showWaiting} visit={waitingVisit} sourceGridRef={servingGridRef} />
        </div>
      </main>

      <footer className="px-6 py-6 border-t border-[var(--display-border)] bg-[var(--display-card-header)] text-center">
        <p className="text-[10px] text-white/60 font-bold uppercase tracking-[0.2em] mb-2">
          © {new Date().getFullYear()} CHO CABADBARAN CITY Smart Queuing System. All rights reserved.
        </p>
        <p className="text-[9px] text-white/60 font-bold uppercase tracking-[0.4em]">
          Please listen for your name and queue number to be called.
        </p>
      </footer>
      <style jsx>{`
        .queue-display-screen { position: fixed; inset: 0; width: 100%; height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; }
        .queue-display-screen > header, .queue-display-screen > footer { flex-shrink: 0; }
        .queue-display-main { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; padding-top: clamp(8px, 2vh, 24px); padding-bottom: clamp(8px, 2vh, 24px); }
        .queue-display-error { flex-shrink: 0; }
        .queue-display-stage { flex: 1; min-height: 0; overflow: hidden; }
        .queue-serving-view { height: 100%; min-height: 0; }
        .queue-serving-grid { height: 100%; min-height: 0; margin-bottom: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); container-name: queue-counters; container-type: size; }
        .queue-serving-card { min-width: 0; min-height: 0; }
        .queue-serving-card-header, .queue-serving-card-footer, .queue-serving-status { flex-shrink: 0; }
        .queue-serving-body { min-height: 0; overflow: hidden; }
        .queue-serving-label, .queue-serving-patient { flex-shrink: 0; }
        @container queue-counters (max-height: 480px) {
          .queue-serving-body { padding: 16px; }
          .queue-serving-label { margin-bottom: 12px; }
          .queue-serving-number { min-height: 100px; padding-top: 16px; padding-bottom: 16px; margin-bottom: 16px; }
          .queue-serving-patient { height: 40px; }
          .queue-serving-status { padding-bottom: 12px; }
        }
        @container queue-counters (max-height: 380px) {
          .queue-serving-card-header { padding: 8px 16px; }
          .queue-serving-card-header h3 { font-size: 16px; line-height: 24px; margin-bottom: 0; }
          .queue-serving-card-footer { padding: 8px 16px; }
          .queue-serving-body { padding: 8px; }
          .queue-serving-label { margin-bottom: 8px; font-size: 9px; line-height: 12px; }
          .queue-serving-number { min-height: 64px; padding-top: 4px; padding-bottom: 4px; margin-bottom: 8px; }
          .queue-serving-number > div { font-size: 48px; line-height: 1; }
          .queue-serving-patient { height: 32px; }
          .queue-serving-patient h4 { font-size: 14px; line-height: 16px; }
          .queue-serving-patient p { font-size: 9px; line-height: 12px; margin-top: 2px; }
          .queue-serving-status { padding-bottom: 8px; }
          .queue-serving-status > div { padding: 6px 12px; font-size: 9px; line-height: 12px; }
        }
        @media (max-height: 720px) {
          .queue-display-screen > footer { padding-top: 8px; padding-bottom: 8px; }
          .queue-display-screen > footer p { margin-bottom: 4px; }
        }
      `}</style>
    </div>
  );
}

function WaitingQueueView({ displayData, counters, matchService, visible, visit, sourceGridRef }) {
  const paginationRef = useRef({ visit: 0, pages: {} });
  const [layout, setLayout] = useState({ cards: {} });
  const counterKey = counters.map((counter) => `${counter.id}:${counter.id_num}`).join("|");
  const groups = groupWaitingQueues(displayData, counters, matchService);
  const previous = paginationRef.current;
  const advance = visible && visit > 1 && visit !== previous.visit;
  const pages = groups.map(({ counter, rows }) => {
    const cardLayout = layout.cards[counter.id_num] || measureWaitingLayout(408);
    return { counter, total: rows.length, layout: cardLayout,
      ...getWaitingPage(rows, previous.pages[counter.id_num], cardLayout.pageSize, advance) };
  });

  useEffect(() => {
    // Hidden polls must not mark rows as seen before their next visible turn.
    if (visible) paginationRef.current = { visit, pages: Object.fromEntries(pages.map((page) => [page.counter.id_num, page])) };
  });

  useEffect(() => {
    const sourceGrid = sourceGridRef?.current;
    if (!sourceGrid) return;
    const measure = () => {
      const gridStyle = window.getComputedStyle(sourceGrid);
      const cards = {};
      counters.forEach((counter, index) => {
        const card = sourceGrid.children[index];
        if (card) cards[counter.id_num] = measureWaitingLayout(card.getBoundingClientRect().height,
          card.firstElementChild?.getBoundingClientRect().height,
          card.lastElementChild?.getBoundingClientRect().height);
      });
      const next = { cards, gridTemplateColumns: gridStyle.gridTemplateColumns,
        columnGap: gridStyle.columnGap, rowGap: gridStyle.rowGap };
      setLayout((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(sourceGrid);
    Array.from(sourceGrid.children).forEach((card) => {
      observer?.observe(card);
      if (card.firstElementChild) observer?.observe(card.firstElementChild);
      if (card.lastElementChild) observer?.observe(card.lastElementChild);
    });
    return () => { window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [sourceGridRef, counterKey]);

  return (
    <section hidden={!visible} aria-label="Waiting Queue" className="queue-waiting-view">
      <div className="queue-waiting-grid" style={{ gridTemplateColumns: layout.gridTemplateColumns, columnGap: layout.columnGap, rowGap: layout.rowGap }}>
        {pages.map((page) => {
          const info = DOCTOR_INFO_MAP[page.counter.id_num] || { badge: "MD", room: "TBA" };
          return (
            <section key={page.counter.id} className="display-card queue-waiting-card shadow-2xl" style={{ height: page.layout.cardHeight }} aria-label={`${page.counter.id_num} waiting queue`}>
              <div className="queue-waiting-card-header" style={{ height: page.layout.headerHeight }}>
                <h3 className="text-lg font-bold text-white">{page.counter.id_num}</h3>
                <div className="flex items-center gap-2">
                  <span className="bg-[var(--brand-primary)] text-white text-[10px] font-black px-2 py-0.5 rounded shadow-sm">{info.badge}</span>
                  <span className="text-[10px] text-white/60 font-black uppercase">{info.room}</span>
                </div>
              </div>
              <div className="queue-waiting-table-wrap">
                <p className="queue-waiting-label">Waiting Queue</p>
                <table aria-label={`${page.counter.id_num} waiting numbers`}>
                  <thead><tr><th scope="col">Position</th><th scope="col">Queue Number</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {page.rows.map((row, index) => (
                      <tr key={row.id}><td>{page.start + index + 1}</td><td className="queue-waiting-number">{row.queue_number}</td><td className="queue-waiting-status">Waiting</td></tr>
                    ))}
                  </tbody>
                </table>
                {page.total === 0 ? <p className="queue-waiting-empty">No Waiting Queue</p> : null}
              </div>
              <div className="queue-waiting-card-footer" style={{ height: page.layout.footerHeight }}>
                <span>{page.total ? `${page.start + 1}\u2013${page.start + page.count} of ${page.total}` : "0 waiting"}</span>
                {page.total > page.layout.pageSize ? <span>Continues automatically</span> : null}
              </div>
            </section>
          );
        })}
      </div>
      <style jsx>{`
        .queue-waiting-view { position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: hidden; }
        .queue-waiting-grid { display: grid; height: 100%; min-height: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
        .queue-waiting-card { display: flex; flex-direction: column; min-width: 0; overflow: hidden; border: 1px solid var(--display-border); }
        .queue-waiting-card-header { height: 64px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 1rem 1.25rem; background: var(--display-card-header); border-bottom: 1px solid var(--display-border); }
        h3 { margin: 0; }
        .queue-waiting-table-wrap { flex: 1; min-height: 0; overflow: hidden; background: var(--display-inner-bg); }
        .queue-waiting-label { height: 48px; display: flex; align-items: center; justify-content: center; margin: 0; color: rgba(255,255,255,0.6); font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.3em; }
        table { width: 100%; border-collapse: collapse; color: white; }
        th { height: 36px; padding: 0 12px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(255,255,255,0.6); }
        td { height: 48px; padding: 0 12px; border-top: 1px solid var(--display-border); font-size: 12px; font-weight: 700; }
        th:first-child, td:first-child { text-align: center; }
        th:last-child, td:last-child { text-align: right; }
        .queue-waiting-number { color: var(--brand-gold-bright); font-size: 22px; font-weight: 900; white-space: nowrap; }
        .queue-waiting-status { color: var(--display-positive); font-size: 10px; }
        .queue-waiting-empty { margin: 0; padding: 48px 16px; text-align: center; color: rgba(255,255,255,0.6); font-size: 12px; font-weight: 700; }
        .queue-waiting-card-footer { height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 1.25rem; background: var(--display-card-header); border-top: 1px solid var(--display-border); color: rgba(255,255,255,0.6); font-size: 10px; font-weight: 700; }
        @media (max-width: 1023px) { .queue-waiting-grid { grid-template-columns: 1fr; } }
        @media (max-width: 380px) { th, td { padding-left: 8px; padding-right: 8px; } .queue-waiting-number { font-size: 18px; } }
      `}</style>
    </section>
  );
}
