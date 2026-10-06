const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "../../data/queue-settings.json");
const AWAITING_ACCEPT_PATH = path.join(__dirname, "../../data/awaiting-accept.json");

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
  clearAllAwaitingAccept
};
