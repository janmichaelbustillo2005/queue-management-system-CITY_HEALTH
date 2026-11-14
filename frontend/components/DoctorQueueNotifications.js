import Head from "next/head";
import { useEffect, useRef, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT } from "../lib/api";
import { OFFICE_IDENTITY, SYSTEM_BRANDING } from "../lib/branding";
import {
  SYSTEM_TITLE,
  TOAST_VISIBLE_MS,
  badgeText,
  claimDesktopAlert,
  clearEntries,
  clearNotificationStorage,
  desktopNotificationState,
  loadTracker,
  markEntriesRead,
  newArrivalText,
  observeDoctorQueue,
  patientsWaitingText,
  queueTabTitle,
  readDoctorQueueSummary,
  saveTracker,
  trackerKey,
  unreadCount
} from "../lib/queueNotifications";

// Browser storage may be missing or throw (private mode, blocked site data); every use tolerates it.
function browserStorage(name) {
  try { return typeof window !== "undefined" ? window[name] : null; } catch { return null; }
}
const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const formatTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
};

// The doctor dashboard's notification bell, new-patient toast, tab title count and desktop
// notification. `summary` is GET /queue's my_queue (the signed-in doctor's own waiting visits,
// chosen by the server from the validated session), refreshed by the dashboard's existing queue
// polling; `onRefresh` re-reads it at once when the tab becomes visible again or the network
// returns. Rules live in lib/queueNotifications.js. Shows nothing without a doctor summary.
export default function DoctorQueueNotifications({ summary: rawSummary, status = "ready", accountId, queueLabel, onRefresh, queueAnchorId }) {
  const summary = readDoctorQueueSummary(rawSummary);
  const key = summary && accountId ? trackerKey(accountId, summary) : null;
  const signature = key ? `${key}#${summary.visitIds.join(",")}` : null;
  const [tracker, setTracker] = useState(null);
  const trackerRef = useRef(null);
  const [toast, setToast] = useState(null);
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState("unsupported");
  const [visible, setVisible] = useState(true);
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  const notificationRef = useRef(null);
  const refreshRef = useRef(onRefresh);
  const anchorRef = useRef(queueAnchorId);

  useEffect(() => { refreshRef.current = onRefresh; anchorRef.current = queueAnchorId; });

  function commit(next) {
    trackerRef.current = next;
    setTracker(next);
    saveTracker(browserStorage("sessionStorage"), next);
  }

  function goToQueue() {
    setOpen(false);
    setToast(null);
    document.getElementById?.(anchorRef.current)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function showDesktopNotification(arrival, current) {
    if (desktopNotificationState(window) !== "granted") return;
    if (!claimDesktopAlert(browserStorage("localStorage"), arrival.id)) return;
    try {
      notificationRef.current?.close?.();
      // No patient details: the count only. The tag replaces this doctor's previous notification.
      const notification = new window.Notification("New Patient Waiting", {
        body: `${patientsWaitingText(current.waiting)}\n${OFFICE_IDENTITY.name} – ${SYSTEM_TITLE}`,
        icon: SYSTEM_BRANDING.logoSrc,
        tag: `city-health-queue-${current.doctor}`,
        renotify: true
      });
      notification.onclick = () => {
        try { window.focus(); } catch { /* the browser may refuse */ }
        notification.close();
        goToQueue();
      };
      notificationRef.current = notification;
    } catch {
      // Some browsers (e.g. Chrome on Android) only allow notifications from a service worker.
      // The toast, bell and tab title still show the arrival.
    }
  }

  // The tracker saved in this tab, so a refresh is not mistaken for new arrivals.
  useEffect(() => {
    trackerRef.current = loadTracker(browserStorage("sessionStorage"));
    setTracker(trackerRef.current);
    setDesktop(desktopNotificationState(window));
    setVisible(!pageHidden());
  }, []);

  // Each new server summary: baseline, nothing new, or one arrival entry.
  useEffect(() => {
    if (!signature) return;
    const { tracker: next, arrival } = observeDoctorQueue(trackerRef.current, summary, { key });
    if (next === trackerRef.current) return;
    commit(next);
    if (!arrival) return;
    setToast(arrival);
    if (pageHidden()) showDesktopNotification(arrival, summary);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening the panel marks its notifications read.
  useEffect(() => {
    if (open && unreadCount(trackerRef.current)) commit(markEntriesRead(trackerRef.current));
  }, [open, tracker]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back on the tab or back online: read the authoritative queue now instead of waiting for the
  // next poll (background tabs are throttled by the browser).
  useEffect(() => {
    const onVisibility = () => {
      const shown = !pageHidden();
      setVisible(shown);
      setDesktop(desktopNotificationState(window));
      if (shown) refreshRef.current?.();
    };
    const onOnline = () => refreshRef.current?.();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Sign-out (this tab or another): forget this account's notifications.
  useEffect(() => {
    const onSession = () => {
      let token = null;
      try { token = window.localStorage.getItem("city_health_token"); } catch { /* treat as signed out */ }
      if (token) return;
      clearNotificationStorage(browserStorage("sessionStorage"), browserStorage("localStorage"));
      trackerRef.current = null;
      setTracker(null);
      setToast(null);
      setOpen(false);
      notificationRef.current?.close?.();
    };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onSession);
    window.addEventListener("storage", onSession);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onSession);
      window.removeEventListener("storage", onSession);
      notificationRef.current?.close?.();
    };
  }, []);

  // The toast closes itself after a while, counted only while the page is visible.
  useEffect(() => {
    if (!toast || !visible) return undefined;
    const timer = window.setTimeout(() => setToast(null), TOAST_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [toast, visible]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A user action is required before the browser may ask for permission.
  async function enableDesktop() {
    const api = window.Notification;
    if (desktopNotificationState(window) !== "default") return;
    try {
      await new Promise((resolve) => {
        const result = api.requestPermission(resolve); // older Safari uses the callback
        if (result && typeof result.then === "function") result.then(resolve, resolve);
      });
    } catch { /* treated as not granted */ }
    setDesktop(desktopNotificationState(window));
  }

  if (!summary) return null;

  const count = summary.waiting;
  const title = queueTabTitle(count, queueLabel);
  const entries = tracker?.key === key ? tracker.entries : [];
  const unread = tracker?.key === key ? unreadCount(tracker) : 0;
  const stale = status !== "ready";
  const countLabel = count === 1 ? "patient waiting" : "patients waiting";

  return (
    <div className="queue-notify" ref={containerRef}>
      {title ? <Head><title>{title}</title></Head> : null}
      <button type="button" ref={buttonRef}
        className={`queue-notify-button${unread ? " has-unread" : ""}`}
        aria-expanded={open} aria-controls="queue-notify-panel"
        aria-label={`Queue notifications: ${count} ${countLabel}${unread ? `, ${unread} new` : ""}`}
        onClick={() => setOpen((current) => !current)}>
        <i className="fas fa-bell" aria-hidden="true" />
        {count > 0 ? <span className="queue-notify-badge" aria-hidden="true">{badgeText(count)}</span> : null}
      </button>

      {open ? (
        <div id="queue-notify-panel" className="queue-notify-panel" role="dialog" aria-label="Queue notifications">
          <div className="queue-notify-head">
            <span>Queue Notifications</span>
            {entries.length ? (
              <button type="button" className="queue-notify-clear" onClick={() => commit(clearEntries(trackerRef.current))}>
                Clear list
              </button>
            ) : null}
          </div>

          <div className="queue-notify-summary">
            <div className="queue-notify-total">
              <span className="queue-notify-count">{count}</span>
              <span className="queue-notify-count-label">{countLabel} in your queue</span>
            </div>
            <ul className="queue-notify-breakdown">
              <li><span>Ready to call</span><strong>{summary.ready}</strong></li>
              <li><span>Awaiting Front Desk confirmation</span><strong>{summary.awaitingConfirmation}</strong></li>
              {summary.notPresent ? <li><span>Set aside (Not Present)</span><strong>{summary.notPresent}</strong></li> : null}
            </ul>
            <p className={`queue-notify-updated${stale ? " is-stale" : ""}`}>
              {stale ? "Connection problem: showing the last known count. Retrying…"
                : `Updated ${formatTime(summary.observedAt) || "just now"}`}
            </p>
          </div>

          <ul className="queue-notify-list">
            {entries.length ? entries.map((entry) => (
              <li key={entry.id} className={`queue-notify-entry${entry.read ? "" : " is-unread"}`}>
                <i className="fas fa-user-plus" aria-hidden="true" />
                <div>
                  <strong>New patient waiting</strong>
                  <span>{newArrivalText(entry.newCount)} {entry.waiting} waiting at that time.</span>
                  <time dateTime={entry.at}>{formatTime(entry.at)}</time>
                </div>
              </li>
            )) : (
              <li className="queue-notify-empty">No new patients since you opened the dashboard.</li>
            )}
          </ul>

          {/* Only until the doctor has answered the browser's permission prompt (it needs a click). */}
          {desktop === "default" ? (
            <div className="queue-notify-desktop">
              <button type="button" className="queue-notify-enable" onClick={enableDesktop}>
                <i className="fas fa-desktop" aria-hidden="true" /> Enable desktop alerts
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {toast ? (
        <div className="queue-toast" role="status" aria-live="polite">
          <span className="queue-toast-icon" aria-hidden="true"><i className="fas fa-user-plus" /></span>
          <div className="queue-toast-body">
            <strong>New Patient Waiting</strong>
            <p>{newArrivalText(toast.newCount)} {patientsWaitingText(count)}</p>
            <button type="button" className="queue-toast-link" onClick={goToQueue}>View my queue</button>
          </div>
          <button type="button" className="queue-toast-close" aria-label="Dismiss notification" onClick={() => setToast(null)}>
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
