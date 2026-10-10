const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SETTINGS_PATH = path.join(__dirname, "../../data/queue-settings.json");
const AWAITING_ACCEPT_PATH = path.join(__dirname, "../../data/awaiting-accept.json");
const VOICE_ANNOUNCEMENTS_PATH = path.join(__dirname, "../../data/voice-announcements.json");
const MAX_VOICE_ANNOUNCEMENTS = 100;

const DEFAULT_QUEUE_SETTINGS = {
  autoRefresh: true,
  refreshInterval: 5,
  showCompleted: true,
  maxQueues: 20,
  soundNotifications: true,
  voiceAnnouncements: true,
  announceDoctorRoom: true,
  announceGapSeconds: 3,
  noShowWaitMinutes: 10,
  recallAttempts: 2,
  allowQueueReassignment: true,
  preventDuplicateRegistration: true,
  doctor1Online: true,
  doctor2Online: true,
  doctor3Online: true,
  autoBackupReminder: true,
  exportStatus: "",
  exportService: "",
  exportDateFilter: "today",
  exportFormat: "csv",
  lastExportAt: null
};

/** In-memory recall counters keyed by patient id (resets when process restarts). */
const recallCounts = new Map();

let cachedSettings = null;

function ensureDataDir() {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function mergeSettings(raw = {}) {
  return { ...DEFAULT_QUEUE_SETTINGS, ...raw };
}

function readSettingsFromDisk() {
  try {
    ensureDataDir();
    if (!fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_QUEUE_SETTINGS };
    }
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    if (!raw.trim()) return { ...DEFAULT_QUEUE_SETTINGS };
    return mergeSettings(JSON.parse(raw));
  } catch (err) {
    console.warn("Failed to read queue settings file:", err.message);
    return { ...DEFAULT_QUEUE_SETTINGS };
  }
}

function writeSettingsToDisk(settings) {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

function getQueueSettings() {
  if (!cachedSettings) {
    cachedSettings = readSettingsFromDisk();
  }
  return { ...cachedSettings };
}

function saveQueueSettings(nextSettings = {}) {
  const merged = mergeSettings({ ...getQueueSettings(), ...nextSettings });
  // Normalize numeric fields
  merged.refreshInterval = Number(merged.refreshInterval) || 5;
  merged.maxQueues = Number(merged.maxQueues) || 20;
  merged.announceGapSeconds = Number(merged.announceGapSeconds);
  if (!Number.isFinite(merged.announceGapSeconds)) merged.announceGapSeconds = 3;
  merged.noShowWaitMinutes = Number(merged.noShowWaitMinutes) || 10;
  merged.recallAttempts = Number(merged.recallAttempts);
  if (!Number.isFinite(merged.recallAttempts)) merged.recallAttempts = 2;

  cachedSettings = merged;
  writeSettingsToDisk(merged);
  return { ...merged };
}

function getRecallCount(patientId) {
  return recallCounts.get(Number(patientId)) || 0;
}

function incrementRecallCount(patientId) {
  const id = Number(patientId);
  const next = getRecallCount(id) + 1;
  recallCounts.set(id, next);
  return next;
}

function clearRecallCount(patientId) {
  recallCounts.delete(Number(patientId));
}

/**
 * Per-patient Accept state: called patients wait for the doctor to Accept, and the
 * Accept time drives the Public Display voice announcement.
 * Shape: { [patientId]: { awaiting: boolean, acceptedAt: ISO string | null } }
 */
let acceptState = null;
let voiceAnnouncementEvents = null;

function loadAcceptState() {
  if (acceptState) return acceptState;
  acceptState = new Map();
  try {
    ensureDataDir();
    const raw = fs.existsSync(AWAITING_ACCEPT_PATH) ? fs.readFileSync(AWAITING_ACCEPT_PATH, "utf8") : "";
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (Array.isArray(parsed)) {
      parsed.forEach((id) => acceptState.set(Number(id), { awaiting: true, acceptedAt: null }));
    } else {
      Object.entries(parsed).forEach(([id, entry]) => {
        acceptState.set(Number(id), {
          awaiting: Boolean(entry?.awaiting),
          acceptedAt: entry?.acceptedAt || null
        });
      });
    }
  } catch (err) {
    console.warn("Failed to read awaiting-accept file:", err.message);
  }
  return acceptState;
}

function persistAcceptState() {
  try {
    ensureDataDir();
    fs.writeFileSync(AWAITING_ACCEPT_PATH, JSON.stringify(Object.fromEntries(loadAcceptState())), "utf8");
  } catch (err) {
    console.warn("Failed to write awaiting-accept file:", err.message);
  }
}

function isAwaitingAccept(patientId) {
  return Boolean(loadAcceptState().get(Number(patientId))?.awaiting);
}

function getAcceptedAt(patientId) {
  return loadAcceptState().get(Number(patientId))?.acceptedAt || null;
}

/** Each call starts a fresh Accept cycle, so a re-called patient is announced again once accepted. */
function markAwaitingAccept(patientId) {
  loadAcceptState().set(Number(patientId), { awaiting: true, acceptedAt: null });
  persistAcceptState();
}

function markAccepted(patientId) {
  const acceptedAt = new Date().toISOString();
  loadAcceptState().set(Number(patientId), { awaiting: false, acceptedAt });
  persistAcceptState();
  return acceptedAt;
}

/** Ends the Accept wait but keeps acceptedAt so a pending announcement still plays. */
function clearAwaitingAccept(patientId) {
  const entry = loadAcceptState().get(Number(patientId));
  if (!entry) return;
  if (entry.acceptedAt) {
    entry.awaiting = false;
  } else {
    loadAcceptState().delete(Number(patientId));
  }
  persistAcceptState();
}

function resetAcceptState(patientId) {
  if (loadAcceptState().delete(Number(patientId))) {
    persistAcceptState();
  }
}

function clearAllAwaitingAccept() {
  loadAcceptState().clear();
  persistAcceptState();
}

function loadVoiceAnnouncementEvents() {
  if (voiceAnnouncementEvents) return voiceAnnouncementEvents;
  voiceAnnouncementEvents = [];
  try {
    ensureDataDir();
    const raw = fs.existsSync(VOICE_ANNOUNCEMENTS_PATH) ? fs.readFileSync(VOICE_ANNOUNCEMENTS_PATH, "utf8") : "";
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    voiceAnnouncementEvents = Array.isArray(parsed)
      ? parsed.filter((entry) => entry && typeof entry === "object" && entry.event_id)
      : [];
  } catch (err) {
    console.warn("Failed to read voice announcements file:", err.message);
  }
  return voiceAnnouncementEvents;
}

function persistVoiceAnnouncementEvents() {
  try {
    ensureDataDir();
    fs.writeFileSync(VOICE_ANNOUNCEMENTS_PATH, JSON.stringify(loadVoiceAnnouncementEvents(), null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to write voice announcements file:", err.message);
  }
}

function recordVoiceAnnouncementEvent({ patient, eventType = "accept", eventAt = new Date().toISOString() }) {
  if (!patient?.id) return null;

  const event = {
    event_id: `${patient.id}:${eventType}:${eventAt}:${crypto.randomUUID()}`,
    event_type: eventType,
    event_at: eventAt,
    patient_id: patient.id,
    queue_number: patient.queue_number,
    id_num: patient.id_num,
    status: patient.status,
    called_at: patient.called_at,
    counter_name: patient.counter_id || "TBA"
  };

  const events = loadVoiceAnnouncementEvents();
  events.push(event);
  events.sort((a, b) => new Date(a.event_at) - new Date(b.event_at));
  if (events.length > MAX_VOICE_ANNOUNCEMENTS) {
    events.splice(0, events.length - MAX_VOICE_ANNOUNCEMENTS);
  }
  persistVoiceAnnouncementEvents();
  console.info("[voice][event-recorded]", {
    event_id: event.event_id,
    event_type: event.event_type,
    patient_id: event.patient_id,
    queue_number: event.queue_number,
    patient_name: event.id_num,
    doctor: event.counter_name,
    event_at: event.event_at
  });
  return event;
}

function getVoiceAnnouncementEvents() {
  return loadVoiceAnnouncementEvents()
    .slice()
    .sort((a, b) => new Date(a.event_at) - new Date(b.event_at));
}

function clearAllVoiceAnnouncementEvents() {
  voiceAnnouncementEvents = [];
  persistVoiceAnnouncementEvents();
}

module.exports = {
  DEFAULT_QUEUE_SETTINGS,
  getQueueSettings,
  saveQueueSettings,
  getRecallCount,
  incrementRecallCount,
  clearRecallCount,
  isAwaitingAccept,
  getAcceptedAt,
  markAwaitingAccept,
  markAccepted,
  clearAwaitingAccept,
  resetAcceptState,
  clearAllAwaitingAccept,
  recordVoiceAnnouncementEvent,
  getVoiceAnnouncementEvents,
  clearAllVoiceAnnouncementEvents
};
