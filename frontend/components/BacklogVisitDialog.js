import { useEffect, useRef, useState } from "react";
import styles from "./BacklogVisitDialog.module.css";
import { recordCell } from "./RecordsTable";
import { request } from "../lib/api";
import {
  MAX_REASON_LENGTH, SUGGESTED_REASON, cancelOutcome, cancelReadiness, cancelRequest, visitPath
} from "../lib/historicalBacklog";

const DETAILS = [
  ["queue_number", "Ticket number"], ["patient_name", "Patient"], ["created_at", "Registered"],
  ["service_type", "Service"], ["doctor", "Assigned doctor"], ["priority_score", "Base priority score"],
  ["status", "Current status"], ["called_at", "Called"], ["consultation_started_at", "Consultation started"],
  ["completed_at", "Completed / cancelled"]
];

// Review one historical visit, then (optionally) cancel it. Every open re-reads the visit's
// current stored state; the cancel is pinned to that revision, so anything that changes the
// visit afterwards makes the server refuse rather than cancel something that was not reviewed.
// `mode` "cancel" opens straight on the confirmation step.
export default function BacklogVisitDialog({ visitId, mode = "review", onClose, onChanged }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const loadRef = useRef(0);
  const [visit, setVisit] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(mode);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null);
  closeRef.current = onClose;

  async function load() {
    const ticket = ++loadRef.current;
    setVisit(null); setLoadError(""); setAcknowledged(false);
    const result = await request(visitPath(visitId));
    if (ticket !== loadRef.current) return;
    if (result?.error || !result?.visit) setLoadError(result?.error || "The visit could not be loaded.");
    else setVisit(result.visit);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal?.();
    load();
    return () => {
      loadRef.current += 1;
      if (dialog?.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [visitId]);

  // Escape closes, except while a cancellation is being submitted.
  function onCancelEvent(event) {
    event.preventDefault();
    if (!submitting) closeRef.current();
  }

  async function submit(event) {
    event.preventDefault();
    if (!cancelReadiness(visit, { reason, acknowledged }).ready || submitting) return;
    setSubmitting(true); setOutcome(null);
    const { path, body } = cancelRequest(visit, { reason, acknowledged });
    let result;
    try {
      result = await request(path, { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      result = { error: error.message };
    }
    const next = cancelOutcome(result);
    setSubmitting(false);
    if (next.kind === "cancelled" || next.kind === "already") {
      onChanged(next.message);
      return;
    }
    setOutcome(next);
  }

  function reload() {
    setOutcome(null); setStep("review");
    load();
  }

  const readiness = cancelReadiness(visit, { reason, acknowledged });
  const blocked = visit && (!visit.eligible || visit.cancel_blocked);
  const titleId = `backlog-visit-title-${visitId}`;

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId} onCancel={onCancelEvent}>
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          <i className={step === "cancel" ? "fas fa-ban" : "fas fa-clipboard-check"} aria-hidden="true" />
          {step === "cancel" ? "Cancel historical visit" : "Review historical visit"}
        </h2>
        <button type="button" className={styles.iconButton} aria-label="Close" disabled={submitting} onClick={() => onClose()}>
          <i className="fas fa-times" aria-hidden="true" />
        </button>
      </div>

      {loadError ? (
        <div className={styles.body}>
          <div role="alert" className={`${styles.notice} ${styles.error}`}>
            <i className="fas fa-exclamation-triangle" aria-hidden="true" />
            <span>{loadError} Nothing was changed.</span>
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.secondary} onClick={() => onClose()}>Close</button>
            <button type="button" className={styles.secondary} onClick={reload}><i className="fas fa-redo" aria-hidden="true" />Retry</button>
          </div>
        </div>
      ) : !visit ? (
        <p role="status" className={styles.body}>Loading the current visit…</p>
      ) : (
        <div className={styles.body}>
          <dl className={styles.details}>
            {DETAILS.map(([key, label]) => (
              <div key={key} className={styles.detail}>
                <dt>{label}</dt>
                <dd>{recordCell(visit, key)}</dd>
              </div>
            ))}
            <div className={styles.detail}>
              <dt>Priority categories</dt>
              <dd>{visit.priority_categories?.length ? visit.priority_categories.join(", ") : <span className={styles.muted}>None</span>}</dd>
            </div>
            <div className={`${styles.detail} ${styles.wide}`}>
              <dt>Stored reason / history note</dt>
              <dd>{visit.reason || <span className={styles.muted}>None</span>}</dd>
            </div>
          </dl>
          <p className={styles.timezone}><i className="far fa-clock" aria-hidden="true" />Times shown in Manila (Asia/Manila)</p>

          {!visit.eligible ? (
            <div role="alert" className={`${styles.notice} ${styles.info}`}>
              <i className="fas fa-info-circle" aria-hidden="true" /><span>{visit.ineligible_reason}</span>
            </div>
          ) : null}
          {visit.flags?.length ? (
            <section className={`${styles.notice} ${visit.cancel_blocked ? styles.error : styles.warning}`} aria-label="Historical warnings">
              <i className={visit.cancel_blocked ? "fas fa-ban" : "fas fa-exclamation-triangle"} aria-hidden="true" />
              <div>
                <p className={styles.noticeTitle}>{visit.cancel_blocked ? "Cancellation blocked" : "Requires review"}</p>
                <ul className={styles.flagList}>
                  {visit.flags.map((flag) => <li key={flag.code}><strong>{flag.label}.</strong> {flag.detail}</li>)}
                </ul>
                <p className={styles.noticeNote}>Nothing here is repaired automatically. Timestamps, assignments and counters are kept as stored.</p>
              </div>
            </section>
          ) : visit.eligible ? (
            <p className={styles.clean}><i className="fas fa-check-circle" aria-hidden="true" />No unusual history: this visit was never called, started or completed.</p>
          ) : null}

          {outcome ? (
            <div role="alert" className={`${styles.notice} ${styles[outcome.tone] || styles.error}`}>
              <i className="fas fa-exclamation-circle" aria-hidden="true" />
              <span>{outcome.message}</span>
              {outcome.reload ? <button type="button" className={styles.secondary} onClick={reload}><i className="fas fa-sync-alt" aria-hidden="true" />Reload visit</button> : null}
            </div>
          ) : null}

          {step === "cancel" && !blocked ? (
            <form className={styles.form} onSubmit={submit} aria-describedby={`${titleId}-effect`}>
              <p id={`${titleId}-effect`} className={styles.effect}>
                Cancelling sets this one visit to <strong>Cancelled</strong>. Its registration, timestamps, priority, service and
                doctor assignment are kept, it stays in Patient Records, and no announcement or SMS is sent.
              </p>
              <label htmlFor={`${titleId}-reason`} className={styles.label}>Reason for cancelling <span aria-hidden="true">*</span></label>
              <textarea id={`${titleId}-reason`} className={styles.textarea} value={reason} required maxLength={MAX_REASON_LENGTH}
                rows={3} disabled={submitting} onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this visit being cancelled?" />
              <div className={styles.reasonMeta}>
                <button type="button" className={styles.link} disabled={submitting} onClick={() => setReason(SUGGESTED_REASON)}>
                  Use suggested test reason
                </button>
                <span>{reason.trim().length}/{MAX_REASON_LENGTH}</span>
              </div>
              {visit.requires_review ? (
                <label className={styles.checkbox}>
                  <input type="checkbox" checked={acknowledged} disabled={submitting} onChange={(event) => setAcknowledged(event.target.checked)} />
                  <span>I reviewed the warnings above and still want to cancel this visit.</span>
                </label>
              ) : null}
              <p className={styles.hint} role="status">{readiness.ready ? "" : readiness.message}</p>
              <div className={styles.footer}>
                <button type="button" className={styles.secondary} disabled={submitting} onClick={() => setStep("review")}>
                  <i className="fas fa-arrow-left" aria-hidden="true" />Back to review
                </button>
                <button type="submit" className={styles.danger} disabled={!readiness.ready || submitting}>
                  <i className={submitting ? "fas fa-spinner fa-spin" : "fas fa-ban"} aria-hidden="true" />
                  {submitting ? "Cancelling…" : "Confirm cancellation"}
                </button>
              </div>
            </form>
          ) : (
            <div className={styles.footer}>
              <button type="button" className={styles.secondary} onClick={() => onClose()}>
                <i className="far fa-clock" aria-hidden="true" />Keep waiting
              </button>
              <button type="button" className={styles.danger} disabled={Boolean(blocked)} onClick={() => { setOutcome(null); setStep("cancel"); }}>
                <i className="fas fa-ban" aria-hidden="true" />Cancel visit…
              </button>
            </div>
          )}
          {step === "cancel" && blocked ? <p className={styles.hint}>{readiness.message}</p> : null}
        </div>
      )}
    </dialog>
  );
}
