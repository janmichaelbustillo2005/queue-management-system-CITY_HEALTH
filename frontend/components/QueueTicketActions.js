import { useEffect, useRef, useState } from "react";
import { downloadQueueTicket, fetchExistingQueueTicket, openThermalTicketWindow, printQueueTicket } from "../lib/queueTicket";

// primaryAction picks the emphasized button, which is listed first.
export default function QueueTicketActions({ ticket, onView, onTicketUpdate, onVerificationStart, disabled = false, primaryAction = onView ? "view" : null }) {
  const lock = useRef(false);
  const aliveRef = useRef(true);
  const popupRef = useRef(null);
  const verificationCleanupRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      popupRef.current = null;
      verificationCleanupRef.current?.();
      verificationCleanupRef.current = null;
    };
  }, []);

  async function deliver(action) {
    if (!ticket || disabled || lock.current || !aliveRef.current) return;
    lock.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    let popup;
    let finishVerification;
    try {
      // Opening synchronously preserves the existing browser-print behavior.
      if (action === "print") {
        popup = openThermalTicketWindow();
        popupRef.current = popup;
      }
      // Dialogs pause their status polling until this read and delivery finish.
      // Release on unmount too, so entering Photo Mode cannot leave it paused.
      const releaseVerification = onVerificationStart?.();
      if (typeof releaseVerification === "function") {
        let released = false;
        finishVerification = () => {
          if (released) return;
          released = true;
          releaseVerification();
        };
        verificationCleanupRef.current = finishVerification;
      }
      const freshTicket = await fetchExistingQueueTicket(ticket.patientId);
      if (!aliveRef.current) {
        if (popup && !popup.closed) popup.close();
        return;
      }
      onTicketUpdate?.(freshTicket);
      if (action === "view") {
        onView?.(freshTicket);
      } else if (action === "download") {
        const downloaded = await downloadQueueTicket(freshTicket, { isCancelled: () => !aliveRef.current });
        if (aliveRef.current && downloaded !== false) setNotice("Ticket image downloaded. The image is a saved snapshot.");
      } else {
        printQueueTicket(freshTicket, popup);
        popupRef.current = null;
        // Opening the print window does not prove a ticket came out of the printer.
        setNotice("Print window opened. Check that the ticket printed before handing it to the patient.");
      }
    } catch (failure) {
      if (popup && !popup.closed) popup.close();
      if (aliveRef.current) setError(failure.message || "The ticket could not be delivered. Please retry.");
    } finally {
      finishVerification?.();
      if (verificationCleanupRef.current === finishVerification) verificationCleanupRef.current = null;
      lock.current = false;
      popupRef.current = null;
      if (aliveRef.current) setBusy("");
    }
  }

  const actions = [
    onView && { action: "view", icon: "bi-ticket-perforated", label: "View Digital Pass", busyLabel: "Opening pass…" },
    { action: "download", icon: "bi-download", label: "Download Image", busyLabel: "Preparing image…" },
    { action: "print", icon: "bi-printer", label: "Print Thermal Ticket", busyLabel: "Preparing ticket…" }
  ].filter(Boolean);
  const ordered = [
    ...actions.filter((item) => item.action === primaryAction),
    ...actions.filter((item) => item.action !== primaryAction)
  ];

  return (
    <div className="queue-ticket-actions">
      <div className="queue-ticket-actions__buttons" aria-label="Ticket delivery options">
        {ordered.map(({ action, icon, label, busyLabel }) => (
          <button key={action} type="button" className={`queue-ticket-button${action === primaryAction ? " queue-ticket-button--primary" : ""}`}
            disabled={!ticket || disabled || !!busy} aria-busy={busy === action} onClick={() => deliver(action)}>
            <i className={`bi ${icon}`} aria-hidden="true" />{busy === action ? busyLabel : label}
          </button>
        ))}
      </div>
      {error && <p className="queue-ticket-error" role="alert">{error}</p>}
      {notice && <p className="queue-ticket-notice" role="status">{notice}</p>}
    </div>
  );
}
