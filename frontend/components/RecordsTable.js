import { useEffect, useRef, useState } from "react";
import styles from "./RecordsTable.module.css";
import { RECORD_FILTERS } from "../lib/recordsFilters";

// Presentation for the Records tables and their footer. Values are shown as
// the server returns them; indicators only add an icon and a tone, so status,
// presence and authentication stay separate, readable facts.

const TIME_KEYS = ["created_at", "called_at", "consultation_started_at", "completed_at", "last_login", "last_seen", "occurred_at"];
const NUMERIC_KEYS = ["priority_score"];
const WRAP_KEYS = ["display_name", "doctor", "patient_name", "event", "flags"];
const SERVICE_LABELS = Object.fromEntries(
  RECORD_FILTERS.patients.primary.find((field) => field.key === "service").options.map((option) => [option.value, option.label])
);
// Queue status: the same readable names the Queue status filter uses.
const QUEUE_STATUS = {
  waiting: ["amber", "far fa-clock", "Waiting"],
  serving: ["blue", "fas fa-user-md", "Being served"],
  completed: ["green", "fas fa-check-circle", "Completed"],
  cancelled: ["red", "fas fa-times-circle", "Cancelled"],
  "no-show": ["gray", "fas fa-user-slash", "No-show"]
};

const stamp = (value) => new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila" });

function indicator(tone, icon, label) {
  return (
    <span className={`${styles.indicator} ${styles[tone]}`}>
      <i className={icon} aria-hidden="true" />{label}
    </span>
  );
}

function muted(label) {
  return <span className={styles.muted}>{label}</span>;
}

// One cell's content. Missing values say so in words rather than leaving a gap.
export function recordCell(row, key) {
  const value = row[key];
  // Accounts have no stored creation date (users.created_at does not exist).
  if (key === "created_at" && !value) return muted("Not recorded");
  // Patients: a stored assignment, or the doctor the service routes to before one is stored.
  if (key === "doctor" && row.doctor_source === "service") return value ? `${value} (by service)` : muted("Not assigned");
  if (key === "doctor" && row.doctor_source === "unresolved") return `${value} (no matching counter)`;
  // D1 shared dispatch: a visit nobody has called has no treating doctor yet.
  if (key === "doctor" && row.doctor_source === "unassigned") return muted("Unassigned (not called)");
  if (TIME_KEYS.includes(key)) return value ? <time dateTime={value}>{stamp(value)}</time> : muted("Unavailable");
  if (key === "online") return value ? indicator("green", "fas fa-circle", "Online") : indicator("gray", "far fa-circle", "Offline");
  if (key === "authenticated") return value ? indicator("teal", "fas fa-key", "Active session") : indicator("neutral", "far fa-circle", "No active session");
  // Shown exactly as stored: the schema has no enabled/disabled flag to verify.
  if (key === "account_status") return value ? indicator("neutral", "far fa-id-badge", value) : muted("Unavailable");
  // Historical Backlog review flags from the server: words first, then which ones apply.
  if (key === "flags") {
    if (!Array.isArray(value) || !value.length) return muted("None");
    const blocked = value.some((flag) => flag.blocking);
    return (
      <span className={styles.flags}>
        {blocked ? indicator("red", "fas fa-ban", "Cancel blocked") : indicator("amber", "fas fa-exclamation-triangle", "Requires review")}
        <span className={styles.flagList}>{value.map((flag) => flag.label).join(" · ")}</span>
      </span>
    );
  }
  if (key === "status" && QUEUE_STATUS[value]) return indicator(...QUEUE_STATUS[value]);
  if (key === "service_type" && SERVICE_LABELS[value]) return SERVICE_LABELS[value];
  return value ?? muted("Unavailable");
}

function cellClass(key, index) {
  return [
    index === 0 ? styles.sticky : "",
    NUMERIC_KEYS.includes(key) ? styles.numeric : "",
    WRAP_KEYS.includes(key) ? styles.wrap : "",
    key === "queue_number" || key === "id" ? styles.identifier : ""
  ].filter(Boolean).join(" ");
}

// A bounded, horizontally scrollable table area. It hints at hidden columns
// only when the table is actually wider than its container.
export function TableScroll({ label, children }) {
  const scrollRef = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useRef(() => {});

  measure.current = () => {
    const element = scrollRef.current;
    if (!element) return;
    const hidden = element.scrollWidth - element.clientWidth;
    const next = { left: element.scrollLeft > 1, right: hidden - element.scrollLeft > 1 };
    setEdges((previous) => (previous.left === next.left && previous.right === next.right ? previous : next));
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const update = () => measure.current();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    window.addEventListener("resize", update);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  // New rows can change the table width without resizing the container.
  useEffect(() => { measure.current(); });

  const overflowing = edges.left || edges.right;
  return (
    <div className={`${styles.frame}${edges.right ? ` ${styles.moreRight}` : ""}`}>
      {overflowing ? (
        <p className={styles.scrollHint}>
          <i className="fas fa-arrows-alt-h" aria-hidden="true" />Scroll sideways to see all columns
        </p>
      ) : null}
      {/* Focusable only when it scrolls, so keyboard users can move it with the arrow keys. */}
      <div ref={scrollRef} className={`${styles.scroll}${edges.left ? ` ${styles.scrolled}` : ""}`}
        role="region" aria-label={label} tabIndex={overflowing ? 0 : undefined}>
        {children}
      </div>
    </div>
  );
}

// The Records table. `action` adds a final column with one real button per row; `actions`
// (with `actionsHeading`) adds several. A button's `tone: "danger"` marks a destructive step,
// and `describe(row)` gives it an accessible name that includes the row.
export function recordsTable({ label, columns, rows, emptyMessage = "No records found.", action, actions, actionsHeading }) {
  const buttons = actions || (action ? [action] : null);
  const heading = actions ? actionsHeading : action?.heading;
  const actionClass = actions ? `${styles.actionCell} ${styles.stickyEnd}` : styles.actionCell;
  return (
    <TableScroll label={label}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>{label}</caption>
        <thead>
          <tr>
            {columns.map(([key, heading], index) => (
              <th key={key} scope="col" className={cellClass(key, index)}>{heading}</th>
            ))}
            {buttons ? <th scope="col" className={actionClass}>{heading}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map(([key], index) => (
                index === 0
                  ? <th key={key} scope="row" className={cellClass(key, index)}>{recordCell(row, key)}</th>
                  : <td key={key} className={cellClass(key, index)}>{recordCell(row, key)}</td>
              ))}
              {buttons ? (
                <td className={actionClass}>
                  <span className={styles.actionGroup}>
                    {buttons.map((button) => (
                      <button key={button.label} type="button"
                        className={`${styles.rowButton}${button.tone === "danger" ? ` ${styles.dangerButton}` : ""}`}
                        aria-label={button.describe ? button.describe(row) : undefined} onClick={() => button.onClick(row)}>
                        <i className={button.icon} aria-hidden="true" />{button.label}
                      </button>
                    ))}
                  </span>
                </td>
              ) : null}
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td className={styles.empty} colSpan={columns.length + (buttons ? 1 : 0)}>{emptyMessage}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </TableScroll>
  );
}

// Footer: what is shown (left) and page navigation (right). Page counts come
// from the server's total and limit; nothing here is estimated.
export function recordsPagination({ page, total, limit, rowCount, busy, failed, onPrevious, onNext, onRefresh }) {
  const counted = !failed && !(busy && !rowCount);
  const pages = Math.max(1, Math.ceil((total || 0) / limit));
  const first = (page - 1) * limit + 1;
  const plural = (count) => `${count} record${count === 1 ? "" : "s"}`;
  const summary = failed ? "Results unavailable"
    : busy ? (rowCount ? "Refreshing records…" : "Loading records…")
    : !total ? "0 records"
    : rowCount ? `Showing ${first}–${first + rowCount - 1} of ${plural(total)}`
    : `No records on this page · ${plural(total)} in total`;
  return (
    <div className={styles.footer}>
      <div className={styles.footerInfo}>
        <p className={styles.summary} role="status" aria-live="polite">{summary}</p>
        <p className={styles.timezone}><i className="far fa-clock" aria-hidden="true" />Times shown in Manila</p>
      </div>
      <nav className={styles.pager} aria-label="Records pages">
        <button type="button" className={styles.pagerButton} disabled={busy || page <= 1} onClick={onPrevious}>
          <i className="fas fa-chevron-left" aria-hidden="true" />Previous
        </button>
        <span className={styles.pageIndicator} aria-current="page">
          Page {page}{counted ? ` of ${pages}` : ""}
        </span>
        <button type="button" className={styles.pagerButton} disabled={busy || !counted || page >= pages} onClick={onNext}>
          Next<i className="fas fa-chevron-right" aria-hidden="true" />
        </button>
        <span className={styles.pagerDivider} aria-hidden="true" />
        <button type="button" className={styles.pagerButton} disabled={busy} onClick={onRefresh}>
          <i className={`fas fa-sync-alt${busy ? ` ${styles.spin}` : ""}`} aria-hidden="true" />Refresh
        </button>
      </nav>
    </div>
  );
}

// Shared button look for other Records controls (Retry, detail paging).
export const recordsButtonClass = styles.pagerButton;
