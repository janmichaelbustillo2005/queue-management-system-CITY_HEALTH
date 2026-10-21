export const ANNOUNCEMENT_RECOVERY_WINDOW_MS = 120000;
export const ANNOUNCEMENT_RECOVERY_STORAGE_KEY = "cityHealth.queueDisplay.announcementRecovery.v1";

function isTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function recoveryNow(nowMs) {
  return isTimestamp(nowMs) ? nowMs : Date.now();
}

function clampRecoverySince(sinceMs, nowMs) {
  return Math.max(nowMs - ANNOUNCEMENT_RECOVERY_WINDOW_MS, Math.min(sinceMs, nowMs));
}

// A short same-tab reload or return can resume from this inclusive time boundary.
// Persist timestamps only; patient records and announcement keys stay in memory.
export function readAnnouncementRecovery(storage, nowMs = Date.now()) {
  const now = recoveryNow(nowMs);
  try {
    const saved = JSON.parse(storage.getItem(ANNOUNCEMENT_RECOVERY_STORAGE_KEY));
    if (
      !saved ||
      Array.isArray(saved) ||
      saved.version !== 1 ||
      !isTimestamp(saved.sinceMs) ||
      !isTimestamp(saved.updatedAtMs) ||
      saved.updatedAtMs > now ||
      saved.updatedAtMs < now - ANNOUNCEMENT_RECOVERY_WINDOW_MS ||
      saved.sinceMs > saved.updatedAtMs
    ) {
      return now;
    }
    return clampRecoverySince(saved.sinceMs, now);
  } catch (_error) {
    return now;
  }
}

export function writeAnnouncementRecovery(storage, sinceMs, nowMs = Date.now()) {
  const now = recoveryNow(nowMs);
  if (!isTimestamp(sinceMs)) return false;
  try {
    storage.setItem(ANNOUNCEMENT_RECOVERY_STORAGE_KEY, JSON.stringify({
      sinceMs: clampRecoverySince(sinceMs, now),
      updatedAtMs: now,
      version: 1
    }));
    return true;
  } catch (_error) {
    return false;
  }
}

export function clearAnnouncementRecovery(storage) {
  try {
    storage.removeItem(ANNOUNCEMENT_RECOVERY_STORAGE_KEY);
    return true;
  } catch (_error) {
    return false;
  }
}
