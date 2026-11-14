import { useEffect, useRef, useState } from "react";
import styles from "./BacklogVisitDialog.module.css";
import timelineStyles from "./PatientVisitDetailsDialog.module.css";
import { request } from "../lib/api";
import { serviceName } from "../lib/services";
import {
  HISTORY_STATUS, NOT_RECORDED, formatHistoryDateTime, priorityLabel, statusLabel, visitDetailsPath
} from "../lib/patientHistory";

function Recorded({ value }) {
  return value ? formatHistoryDateTime(value) : <span className={styles.muted}>{NOT_RECORDED}</span>;
}

// Patient Visit Details: one visit of the signed-in doctor's history, READ-ONLY. It has no edit,
// delete, status, reassign or cancel action; the only control is Close. Every value comes from the
// server as recorded; a missing event is shown as "Not recorded" or left out of the timeline.
export default function PatientVisitDetailsDialog({ visitId, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const loadRef = useRef(0);
  const [visit, setVisit] = useState(null);
  const [loadError, setLoadError] = useState("");
  closeRef.current = onClose;

  async function load() {
    const ticket = ++loadRef.current;
    setVisit(null); setLoadError("");
    let result;
    try {
      result = await request(visitDetailsPath(visitId));
    } catch (error) {
      result = { error: error.message };
    }
    if (ticket !== loadRef.current) return;
    if (result?.error || !result?.visit) setLoadError(result?.error || "The visit details could not be loaded.");
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

  const titleId = `patient-visit-details-${visitId}`;
  const status = visit ? HISTORY_STATUS[visit.status] : null;
  const details = visit ? [
    ["Queue Number", visit.queue_number || NOT_RECORDED],
    ["Patient Name", visit.patient_name || NOT_RECORDED],
    ["Service Requested", serviceName(visit.service_type) || NOT_RECORDED],
    ["Priority Classification", priorityLabel(visit.priority_categories)],
    ["Assigned Doctor", visit.assigned_doctor_label || visit.assigned_doctor || NOT_RECORDED],
    ["Registration Date and Time", <Recorded key="r" value={visit.created_at} />],
    ["Front Desk Confirmation", <Recorded key="f" value={visit.confirmed_at} />],
    ["Called Date and Time", <Recorded key="c" value={visit.called_at} />],
    ...(visit.status === "completed" ? [
      ["Consultation Started", <Recorded key="s" value={visit.consultation_started_at} />],
      ["Consultation Completed", <Recorded key="d" value={visit.completed_at} />]
    ] : []),
    ["Final Queue Status", status ? (
      <span key="st" className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${status.className}`}>
        <i className={status.icon} aria-hidden="true" />{status.label}
      </span>
    ) : statusLabel(visit.status)],
    ...(visit.status === "cancelled" ? [
      ["Cancelled At", <Recorded key="ca" value={visit.outcome_at} />],
      ["Cancelled By", visit.outcome_by ? `${visit.outcome_by.doctor_label} · account ${visit.outcome_by.account}` : NOT_RECORDED],
      ["Cancellation Reason", visit.reason || NOT_RECORDED]
    ] : []),
    ...(visit.status === "no-show" ? [
      ["Marked No-show At", <Recorded key="na" value={visit.outcome_at} />],
      ["Marked No-show By", visit.outcome_by ? `${visit.outcome_by.doctor_label} · account ${visit.outcome_by.account}` : NOT_RECORDED],
      ["No-show Note", visit.reason || NOT_RECORDED]
    ] : [])
  ] : [];

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); closeRef.current(); }}>
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          <i className="fas fa-file-medical" aria-hidden="true" />
          Patient Visit Details
        </h2>
        <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => onClose()}>
          <i className="fas fa-times" aria-hidden="true" />
        </button>
      </div>

      {loadError ? (
        <div className={styles.body}>
          <div role="alert" className={`${styles.notice} ${styles.error}`}>
            <i className="fas fa-exclamation-triangle" aria-hidden="true" />
            <span>{loadError}</span>
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.secondary} onClick={() => onClose()}>Close</button>
            <button type="button" className={styles.secondary} onClick={load}><i className="fas fa-redo" aria-hidden="true" />Retry</button>
          </div>
        </div>
      ) : !visit ? (
        <p role="status" className={styles.body}>Loading visit details…</p>
      ) : (
        <div className={styles.body} data-visit-details={visit.id}>
          <dl className={styles.details}>
            {details.map(([label, value]) => (
              <div key={label} className={`${styles.detail}${label.endsWith("Reason") || label.endsWith("Note") ? ` ${styles.wide}` : ""}`}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby={`${titleId}-timeline`}>
            <h3 id={`${titleId}-timeline`} className={timelineStyles.heading}>Activity Timeline</h3>
            {visit.timeline?.length ? (
              <ol className={timelineStyles.timeline}>
                {visit.timeline.map((event, index) => (
                  <li key={`${event.type}-${index}`} className={`${timelineStyles.event} ${timelineStyles[event.type] || ""}`}>
                    <span className={timelineStyles.label}>{event.label}</span>
                    <time className={timelineStyles.time} dateTime={event.at}>{formatHistoryDateTime(event.at)}</time>
                  </li>
                ))}
              </ol>
            ) : <p className={styles.muted}>No events were recorded for this visit.</p>}
            <p className={styles.timezone}>
              <i className="far fa-clock" aria-hidden="true" />
              Times in Manila. Only events the system recorded are listed. A Re-queue replaces the registration time.
            </p>
          </section>

          <div className={styles.footer}>
            <button type="button" className={styles.secondary} onClick={() => onClose()}>Close</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
