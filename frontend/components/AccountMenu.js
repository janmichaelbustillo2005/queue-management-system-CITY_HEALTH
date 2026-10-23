import { useEffect, useRef, useState } from "react";

// Header account entry, the only place for account actions in the layout:
// who is signed in, My Profile and Sign Out.
export default function AccountMenu({ account, onProfile, onLogout }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointer(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    }
    function handleKey(event) {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const run = (callback) => () => { setOpen(false); callback?.(); };

  return (
    <div className="app-account" ref={containerRef}>
      <button type="button" ref={buttonRef} className="app-account-button" aria-expanded={open}
        aria-controls="app-account-panel" aria-label={`Account: ${account.id}, ${account.roleLabel}`}
        onClick={() => setOpen((current) => !current)}>
        <span className="app-account-avatar" aria-hidden="true"><i className={account.icon} /></span>
        <span className="app-account-text" aria-hidden="true">
          <span className="app-account-id">{account.id}</span>
          <span className="app-account-role">{account.roleLabel}</span>
        </span>
        <i className={`fas fa-chevron-down app-account-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div id="app-account-panel" className="app-account-panel">
          <div className="app-account-summary">
            <span className="app-account-summary-id">{account.id}</span>
            <span className="app-account-summary-role">{account.roleLabel}</span>
            <span className="app-account-summary-assignment">{account.assignment}</span>
          </div>
          <button type="button" className="app-account-item" onClick={run(onProfile)}>
            <i className="fas fa-id-card" aria-hidden="true" />My Profile
          </button>
          <div className="app-account-divider" />
          <button type="button" className="app-account-item app-account-item--logout" onClick={run(onLogout)}>
            <i className="fas fa-sign-out-alt" aria-hidden="true" />Sign Out
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Read-only account details from the signed-in session. Nothing here is
// editable, and nothing is shown that the session does not contain. Account
// management actions the page provides (for example a doctor's cancellation
// request) are listed here; each opens that page's own confirmation flow.
export function ProfileDialog({ account, actions = [], onClose }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    function handleKey(event) {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      // Keep Tab inside the dialog while it is open.
      const focusable = dialogRef.current.querySelectorAll("button, a[href]");
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const rows = [
    ["Account ID", account.id],
    ["Role", account.roleLabel],
    ["Stored role", account.storedRole || "Not recorded"],
    ["Assignment", account.assignment]
  ];
  return (
    <div className="app-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-profile-title">
        <div className="app-dialog-header">
          <span className="app-account-avatar app-account-avatar--large" aria-hidden="true"><i className={account.icon} /></span>
          <div>
            <h2 id="app-profile-title">My Profile</h2>
            <p>{account.roleLabel}</p>
          </div>
        </div>
        <dl className="app-profile-details">
          {rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        <p className="app-dialog-note">
          These details come from your current signed-in session and are read-only. Ask the Super Administrator to change account details.
        </p>
        {actions.length ? (
          <section className="app-profile-manage" aria-labelledby="app-profile-manage-title">
            <h3 id="app-profile-manage-title">Account management</h3>
            {actions.map((action) => (
              <button key={action.label} type="button" className="app-profile-action"
                onClick={() => { onClose(); action.onClick?.(); }}>
                <i className={action.icon} aria-hidden="true" />{action.label}
              </button>
            ))}
          </section>
        ) : null}
        <div className="app-dialog-actions">
          <button type="button" ref={closeRef} className="app-dialog-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
