// Doctor queue notifications (components/DoctorQueueNotifications.js): the rules, with no React
// and no browser globals, so they can be tested directly. This module imports nothing.
//
// The count comes from GET /queue's my_queue: the signed-in doctor's waiting visits (confirmed or
// pending Front Desk confirmation) from the same records Front Desk Patient Management counts. The
// server picks the doctor from the validated session; this module never chooses a doctor.
//
// Two different things are tracked:
//   - the CURRENT waiting count (badge, tab title), always the latest server value;
//   - NEW ARRIVALS: visit ids that entered this doctor's waiting list since the last observed state.
// The first observation is a baseline (page load, refresh, new account, new business day) and is
// never an arrival. A visit already seen today that leaves and comes back (Call then Undo,
// Re-queue, a status change) is not a new arrival either. Front Desk confirmation does not change
// the set, so it never alerts. Dismissing a notification never changes the count.

export const NOTIFICATION_STORAGE_KEY = "city_health_queue_notifications";
export const DESKTOP_ALERT_KEY = "city_health_queue_desktop_alert";
export const NOTIFICATION_HISTORY_LIMIT = 20;
export const SEEN_VISIT_LIMIT = 1000;
export const TOAST_VISIBLE_MS = 15000;
export const SYSTEM_TITLE = "Smart Queue System";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNT_KEYS = ["waiting", "ready", "awaiting_confirmation", "not_present"];
const isVisitId = (id) => Number.isSafeInteger(id) && id > 0;

// GET /queue my_queue, checked; null for anything else (no doctor account, an older backend, a
// malformed answer). Nothing is shown from a summary that does not add up.
export function readDoctorQueueSummary(value) {
  if (!value || typeof value !== "object") return null;
  const doctor = typeof value.doctor === "string" ? value.doctor.trim() : "";
  if (!doctor || !DATE.test(value.business_date || "")) return null;
  if (!COUNT_KEYS.every((key) => Number.isInteger(value[key]) && value[key] >= 0)) return null;
  if (!Array.isArray(value.visit_ids) || !value.visit_ids.every(isVisitId)) return null;
  const visitIds = [...new Set(value.visit_ids)].sort((a, b) => a - b);
  if (visitIds.length !== value.waiting ||
      value.ready + value.awaiting_confirmation + value.not_present !== value.waiting) return null;
  return {
    doctor,
    businessDate: value.business_date,
    waiting: value.waiting,
    ready: value.ready,
    awaitingConfirmation: value.awaiting_confirmation,
    notPresent: value.not_present,
    visitIds,
    observedAt: Number.isFinite(Date.parse(value.observed_at)) ? value.observed_at : null
  };
}

// One tracker per signed-in account, doctor and business day. Any change of these starts over.
export const trackerKey = (accountId, summary) => `${accountId}|${summary.doctor}|${summary.businessDate}`;

function isEntry(entry) {
  return entry && typeof entry.id === "string" && Number.isFinite(Date.parse(entry.at)) &&
    Number.isInteger(entry.newCount) && entry.newCount > 0 && Number.isInteger(entry.waiting) && entry.waiting >= 0 &&
    typeof entry.read === "boolean";
}

export function isTracker(value) {
  return Boolean(value) && value.version === 1 && typeof value.key === "string" && value.baselined === true &&
    Array.isArray(value.seen) && value.seen.every(isVisitId) && Array.isArray(value.entries) && value.entries.every(isEntry);
}

// Applies one server summary. Returns the next tracker and, when visits newly entered this
// doctor's waiting list, the arrival entry (one per observation, however many visits arrived).
export function observeDoctorQueue(tracker, summary, { key, now = Date.now() }) {
  if (!isTracker(tracker) || tracker.key !== key) {
    return {
      tracker: { version: 1, key, baselined: true, seen: summary.visitIds.slice(-SEEN_VISIT_LIMIT), entries: [] },
      arrival: null
    };
  }
  const seen = new Set(tracker.seen);
  const fresh = summary.visitIds.filter((id) => !seen.has(id));
  if (!fresh.length) return { tracker, arrival: null };
  const arrival = {
    id: `${key}|${fresh.join(",")}`,
    at: new Date(now).toISOString(),
    newCount: fresh.length,
    waiting: summary.waiting,
    read: false
  };
  return {
    tracker: {
      ...tracker,
      seen: [...tracker.seen, ...fresh].slice(-SEEN_VISIT_LIMIT),
      entries: [arrival, ...tracker.entries].slice(0, NOTIFICATION_HISTORY_LIMIT)
    },
    arrival
  };
}

export const markEntriesRead = (tracker) => (isTracker(tracker) && tracker.entries.some((entry) => !entry.read)
  ? { ...tracker, entries: tracker.entries.map((entry) => (entry.read ? entry : { ...entry, read: true })) }
  : tracker);

// Clearing the list removes notifications only; the visits and the count are untouched.
export const clearEntries = (tracker) => (isTracker(tracker) ? { ...tracker, entries: [] } : tracker);

export const unreadCount = (tracker) => (isTracker(tracker) ? tracker.entries.filter((entry) => !entry.read).length : 0);

// Per-tab storage (sessionStorage): survives a refresh, so a refresh is not an arrival; another
// account in this tab gets a new key. Every access may throw (private mode, blocked storage).
export function loadTracker(storage) {
  try {
    const value = JSON.parse(storage?.getItem(NOTIFICATION_STORAGE_KEY) || "null");
    return isTracker(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveTracker(storage, tracker) {
  try { storage?.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(tracker)); } catch { /* best effort */ }
}

export function clearNotificationStorage(sessionStore, localStore) {
  try { sessionStore?.removeItem(NOTIFICATION_STORAGE_KEY); } catch { /* best effort */ }
  try { localStore?.removeItem(DESKTOP_ALERT_KEY); } catch { /* best effort */ }
}

// Several tabs of the same doctor each see the same arrival; only the first shows a desktop
// notification (shared localStorage). Without storage every tab may notify (the tag still
// replaces the earlier notification instead of stacking).
export function claimDesktopAlert(storage, arrivalId) {
  try {
    if (storage.getItem(DESKTOP_ALERT_KEY) === arrivalId) return false;
    storage.setItem(DESKTOP_ALERT_KEY, arrivalId);
  } catch { /* best effort */ }
  return true;
}

// "unsupported" (no Web Notifications API, or not a secure context), else the permission.
export function desktopNotificationState(win) {
  const api = win?.Notification;
  if (typeof api !== "function" || win.isSecureContext === false) return "unsupported";
  return ["granted", "denied"].includes(api.permission) ? api.permission : "default";
}

const plural = (count, one, many) => (count === 1 ? one : many);

export const patientsWaitingText = (count) =>
  `${count} ${plural(count, "patient is", "patients are")} currently waiting in your queue.`;

export const newArrivalText = (count) =>
  `${count} new ${plural(count, "patient was", "patients were")} assigned to your queue.`;

// "(3) Doctor 2 Queue | Smart Queue System" while patients wait; null (the page's own title) at 0.
export function queueTabTitle(count, queueLabel) {
  if (!Number.isInteger(count) || count <= 0) return null;
  const label = String(queueLabel || "").trim() || "My Queue";
  return `(${count}) ${label} | ${SYSTEM_TITLE}`;
}

export const badgeText = (count) => (count > 99 ? "99+" : String(count));
