import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api";

// Staff archiving (AR1). Archive is a soft delete: the account leaves the active Staff
// Management list, cannot sign in, and is listed here until it is restored or permanently
// deleted. The backend enforces every rule; these dialogs only ask for confirmation.

// Native modal <dialog>: the page behind it is inert, Escape closes it (unless busy), and focus
// returns to the control that opened it.
export function useModalDialog(open, onDismiss, busy) {
  const ref = useRef(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return undefined;
    const previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal?.();
    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, [open]);
  const onCancel = (event) => {
    // Escape on a confirmation inside the Archives modal closes only the confirmation.
    event.preventDefault();
    event.stopPropagation();
    if (!busy) dismissRef.current();
  };
  return { ref, onCancel };
}

const TONES = {
  archive: { icon: "fas fa-archive", iconClass: "bg-amber-100 text-amber-700", button: "bg-amber-600 hover:bg-amber-700" },
  restore: { icon: "fas fa-undo-alt", iconClass: "brand-bg-subtle brand-text-primary", button: "brand-button" },
  danger: { icon: "fas fa-exclamation-triangle", iconClass: "bg-red-100 text-red-700", button: "bg-red-600 hover:bg-red-700" }
};

export function StaffConfirmDialog({ open, tone = "archive", title, children, confirmLabel, busyLabel, busy = false, error = "", onConfirm, onCancel }) {
  const { ref, onCancel: onCancelEvent } = useModalDialog(open, onCancel, busy);
  if (!open) return null;
  const style = TONES[tone] || TONES.archive;
  return (
    <dialog
      ref={ref}
      onCancel={onCancelEvent}
      aria-labelledby="staff-confirm-title"
      className="bg-white rounded-xl shadow-2xl w-[calc(100vw-32px)] max-w-md p-0 backdrop:bg-black/50"
    >
      <div className="px-5 py-4 border-b brand-border flex items-center gap-3">
        <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${style.iconClass}`}>
          <i className={style.icon} aria-hidden="true" />
        </span>
        <h4 id="staff-confirm-title" className="m-0 text-lg font-bold brand-text">{title}</h4>
      </div>
      <div className="px-5 py-4 text-sm brand-text-muted space-y-2">
        {children}
        {error ? (
          <p role="alert" className="m-0 mt-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 flex items-start gap-2">
            <i className="fas fa-exclamation-circle mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
      <div className="px-5 py-4 brand-bg-subtle flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-gray-200 brand-text text-sm font-semibold disabled:opacity-60">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={onConfirm}
          className={`px-4 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-60 ${style.button}`}>
          {busy ? busyLabel || "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

function formatArchivedAt(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

export function matchesArchiveSearch(account, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [account.id_num, account.display_name, account.doctor_name].some((value) => String(value || "").toLowerCase().includes(needle));
}

const ACTIONS = {
  restore: {
    tone: "restore", title: "Restore Staff Account?", confirmLabel: "Restore Account", busyLabel: "Restoring…",
    path: (id) => `/users/${encodeURIComponent(id)}/restore`, method: "POST"
  },
  delete: {
    tone: "danger", title: "Permanently Delete Staff Account?", confirmLabel: "Permanently Delete", busyLabel: "Deleting…",
    path: (id) => `/users/${encodeURIComponent(id)}`, method: "DELETE"
  }
};

// Floating Staff Archives modal over Staff Management. `onChanged` runs after a restore or
// permanent delete so the page can refresh its active staff list.
export function StaffArchivesModal({ open, onClose, onChanged, refreshKey = 0 }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(null); // { kind, account }
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const loadRef = useRef(0);
  const { ref, onCancel } = useModalDialog(open, onClose, busy);

  async function load() {
    const ticket = ++loadRef.current;
    setLoading(true);
    setLoadError("");
    const data = await request("/users/archived", { cache: "no-store" }).catch((error) => ({ error: error.message }));
    if (ticket !== loadRef.current) return;
    setLoading(false);
    if (data?.success) setAccounts(data.users || []);
    else setLoadError(data?.error || data?.message || "Archived accounts could not be loaded.");
  }

  useEffect(() => {
    if (!open) return undefined;
    setSearch("");
    setNotice("");
    load();
    return () => { loadRef.current += 1; };
  }, [open, refreshKey]);

  async function confirmAction() {
    if (!pending || busy) return;
    const action = ACTIONS[pending.kind];
    setBusy(true);
    setActionError("");
    const data = await request(action.path(pending.account.id_num), { method: action.method })
      .catch((error) => ({ error: error.message }));
    setBusy(false);
    if (!data?.success) {
      setActionError(data?.error || data?.message || "The request failed. Nothing was changed.");
      return;
    }
    const id = pending.account.id_num;
    setAccounts((current) => current.filter((account) => account.id_num !== id));
    setNotice(pending.kind === "restore" ? `${id} was restored to the active staff list.` : `${id} was permanently deleted.`);
    setPending(null);
    onChanged?.();
  }

  if (!open) return null;
  const visible = accounts.filter((account) => matchesArchiveSearch(account, search));
  const action = pending ? ACTIONS[pending.kind] : null;

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      aria-labelledby="staff-archives-title"
      className="bg-white rounded-xl shadow-2xl w-[calc(100vw-24px)] max-w-4xl max-h-[92vh] p-0 backdrop:bg-black/50"
    >
      <div className="flex flex-col max-h-[92vh]">
        <div className="px-5 py-4 border-b brand-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="staff-archives-title" className="text-lg md:text-xl font-bold brand-text flex items-center gap-2 m-0">
              <i className="fas fa-archive brand-text-primary" aria-hidden="true" />
              Staff Archives
            </h3>
            <p className="text-xs md:text-sm brand-text-muted m-0 mt-1">
              Archived staff accounts. They cannot sign in until restored.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close Staff Archives"
            className="w-9 h-9 shrink-0 rounded-lg border brand-border brand-text hover:bg-gray-50 flex items-center justify-center">
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 pt-4 pb-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 brand-text-muted text-sm" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search archived staff by user ID or display name…"
              aria-label="Search archived staff"
              className="w-full pl-9 pr-3 py-2 rounded-lg brand-input border outline-none text-sm"
            />
          </div>
          <button type="button" onClick={load} disabled={loading}
            className="text-sm px-3 py-2 rounded-lg border brand-border brand-text hover:bg-gray-50 disabled:opacity-60 whitespace-nowrap">
            <i className="fas fa-sync-alt mr-1" aria-hidden="true" />
            Refresh
          </button>
        </div>

        {notice ? (
          <p role="status" className="mx-5 mb-3 mt-0 px-3 py-2 rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm flex items-center gap-2">
            <i className="fas fa-check-circle" aria-hidden="true" />{notice}
          </p>
        ) : null}

        <div className="flex-1 min-h-0 overflow-auto border-t brand-border">
          <table className="w-full text-left min-w-[640px]">
            <thead className="bg-gray-50 brand-text-muted text-xs font-bold uppercase tracking-wider sticky top-0">
              <tr>
                <th className="px-5 py-3">User ID</th>
                <th className="px-5 py-3">Display Name</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Archived</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--brand-border)]">
              {loading && accounts.length === 0 ? (
                <tr><td colSpan="5" className="px-5 py-10 text-center brand-text-muted">Loading archived accounts…</td></tr>
              ) : loadError ? (
                <tr><td colSpan="5" className="px-5 py-10 text-center text-red-700" role="alert">{loadError}</td></tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan="5" className="px-5 py-10 text-center brand-text-muted italic">
                    {accounts.length === 0 ? "No archived staff accounts" : "No archived accounts match your search"}
                  </td>
                </tr>
              ) : visible.map((account) => (
                <tr key={account.id_num} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-bold brand-text break-all">{account.id_num}</td>
                  <td className="px-5 py-3 brand-text">{account.display_name || account.doctor_name || "—"}</td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${
                      account.role === "superadmin" ? "bg-purple-100 text-purple-700" : "bg-green-100 text-green-700"
                    }`}>
                      {account.role}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-xs brand-text-muted">
                    <div>{formatArchivedAt(account.archived_at)}</div>
                    {account.archived_by ? <div className="text-[11px]">by {account.archived_by}</div> : null}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <button type="button" title="Restore account" aria-label={`Restore ${account.id_num}`}
                        onClick={() => { setActionError(""); setPending({ kind: "restore", account }); }}
                        className="w-9 h-9 rounded-lg brand-text-primary hover:bg-gray-100 transition-colors">
                        <i className="fas fa-undo-alt" aria-hidden="true" />
                      </button>
                      <button type="button" title="Permanently delete account" aria-label={`Permanently delete ${account.id_num}`}
                        onClick={() => { setActionError(""); setPending({ kind: "delete", account }); }}
                        className="w-9 h-9 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors">
                        <i className="fas fa-trash-alt" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 border-t brand-border flex items-center justify-between gap-3">
          <span className="text-xs brand-text-muted">
            {accounts.length} archived account{accounts.length === 1 ? "" : "s"}
          </span>
          <button type="button" onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg bg-gray-200 brand-text text-sm font-semibold disabled:opacity-60">
            Close
          </button>
        </div>
      </div>

      <StaffConfirmDialog
        open={Boolean(pending)}
        tone={action?.tone}
        title={action?.title}
        confirmLabel={action?.confirmLabel}
        busyLabel={action?.busyLabel}
        busy={busy}
        error={actionError}
        onConfirm={confirmAction}
        onCancel={() => { if (!busy) setPending(null); }}
      >
        {pending?.kind === "restore" ? (
          <>
            <p className="m-0">Are you sure you want to restore <strong className="brand-text">{pending.account.id_num}</strong>?</p>
            <p className="m-0">The same account returns to the active staff list with its user ID, role and assignment. It must sign in again.</p>
          </>
        ) : pending ? (
          <>
            <p className="m-0">This action will permanently delete the archived account <strong className="brand-text">{pending.account.id_num}</strong>.</p>
            <p className="m-0 font-semibold text-red-700">This action cannot be undone.</p>
            <p className="m-0">Patient records, queue history and login history are kept.</p>
          </>
        ) : null}
      </StaffConfirmDialog>
    </dialog>
  );
}
