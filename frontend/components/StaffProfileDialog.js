import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api";
import { useModalDialog } from "./StaffArchives";

// EP1 Edit Profile: a Superadmin edits a staff account's display name from Staff Management.
// Only display_name is editable. User ID, role and the queue assignment (doctor_name, which
// queue calling and dispatch match against) are shown read-only; the backend rejects any other
// field and re-checks every rule, including that the account is not archived.

export const MAX_DISPLAY_NAME_LENGTH = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

// Mirrors the backend: whitespace is collapsed and trimmed, empty clears the display name.
export function normalizeDisplayName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function validateDisplayName(value) {
  if (CONTROL_CHARACTERS.test(String(value ?? "").replace(/[\t\n\r ]/g, " "))) {
    return "Display name cannot contain control characters.";
  }
  if ([...normalizeDisplayName(value)].length > MAX_DISPLAY_NAME_LENGTH) {
    return `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }
  return "";
}

function ReadOnlyField({ id, label, value, hint }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-bold brand-text mb-1">
        {label}
        <span className="ml-2 text-[10px] font-semibold uppercase brand-text-muted">
          <i className="fas fa-lock mr-1" aria-hidden="true" />Read only
        </span>
      </label>
      <input id={id} type="text" readOnly aria-readonly="true" value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="w-full px-4 py-2 rounded-lg border brand-border bg-gray-100 brand-text-muted outline-none cursor-not-allowed" />
      {hint ? <p id={`${id}-hint`} className="m-0 mt-1 text-xs brand-text-muted">{hint}</p> : null}
    </div>
  );
}

export function StaffProfileDialog({ open, account, onClose, onSaved }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadRef = useRef(0);
  const { ref, onCancel } = useModalDialog(open, onClose, busy);
  const idNum = account?.id_num;

  // Read the account fresh from the database each time the modal opens.
  useEffect(() => {
    if (!open || !idNum) return undefined;
    const ticket = ++loadRef.current;
    setProfile(null);
    setLoadError("");
    setFieldError("");
    setFormError("");
    setDisplayName("");
    setLoading(true);
    request(`/users/${encodeURIComponent(idNum)}/profile`, { cache: "no-store" })
      .catch((error) => ({ error: error.message }))
      .then((data) => {
        if (ticket !== loadRef.current) return;
        setLoading(false);
        if (data?.success && data.profile) {
          setProfile(data.profile);
          setDisplayName(data.profile.display_name || "");
        } else {
          setLoadError(data?.error || data?.message || "The profile could not be loaded.");
        }
      });
    return () => { loadRef.current += 1; };
  }, [open, idNum]);

  if (!open) return null;

  const supported = profile?.display_name_supported !== false;
  const unchanged = normalizeDisplayName(displayName) === normalizeDisplayName(profile?.display_name);
  const canSave = Boolean(profile) && supported && !busy && !loading && !unchanged;

  function handleChange(event) {
    setDisplayName(event.target.value);
    setFieldError(validateDisplayName(event.target.value));
    setFormError("");
  }

  async function handleSubmit(event) {
    event?.preventDefault?.();
    if (!profile || busy) return;
    const problem = validateDisplayName(displayName);
    setFieldError(problem);
    if (problem || !canSave) return;
    setBusy(true);
    setFormError("");
    const data = await request(`/users/${encodeURIComponent(profile.id_num)}/profile`, {
      method: "PUT",
      body: JSON.stringify({ display_name: normalizeDisplayName(displayName) })
    }).catch((error) => ({ error: error.message }));
    setBusy(false);
    if (!data?.success || !data.profile) {
      const message = data?.error || data?.message || "The profile could not be saved. Nothing was changed.";
      if (data?.details?.field === "display_name") setFieldError(message);
      else setFormError(message);
      return;
    }
    onSaved?.(data.profile);
  }

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      aria-labelledby="staff-profile-title"
      className="bg-white rounded-xl shadow-2xl w-[calc(100vw-32px)] max-w-lg max-h-[92vh] p-0 backdrop:bg-black/50"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col max-h-[92vh]">
        <div className="px-5 py-4 border-b brand-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="staff-profile-title" className="text-lg md:text-xl font-bold brand-text flex items-center gap-2 m-0">
              <i className="fas fa-user-edit brand-text-primary" aria-hidden="true" />
              Edit User Profile
            </h3>
            <p className="text-xs md:text-sm brand-text-muted m-0 mt-1 break-all">{idNum}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close Edit User Profile"
            className="w-9 h-9 shrink-0 rounded-lg border brand-border brand-text hover:bg-gray-50 flex items-center justify-center">
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {loading ? (
            <p className="m-0 py-6 text-center text-sm brand-text-muted">Loading profile…</p>
          ) : loadError ? (
            <p role="alert" className="m-0 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-start gap-2">
              <i className="fas fa-exclamation-circle mt-0.5" aria-hidden="true" />
              <span>{loadError}</span>
            </p>
          ) : profile ? (
            <>
              <ReadOnlyField id="staff-profile-id" label="User ID" value={profile.id_num} />

              <div>
                <label htmlFor="staff-profile-display-name" className="block text-sm font-bold brand-text mb-1">
                  Display Name
                </label>
                <input
                  id="staff-profile-display-name"
                  type="text"
                  value={displayName}
                  onChange={handleChange}
                  disabled={busy || !supported}
                  maxLength={MAX_DISPLAY_NAME_LENGTH + 20}
                  placeholder={profile.doctor_name || "e.g. Dr. Santos"}
                  aria-invalid={fieldError ? "true" : "false"}
                  aria-describedby={fieldError ? "staff-profile-display-name-error" : "staff-profile-display-name-hint"}
                  className={`w-full px-4 py-2 rounded-lg brand-input border outline-none ${fieldError ? "border-red-500" : ""}`}
                />
                {fieldError ? (
                  <p id="staff-profile-display-name-error" role="alert" className="m-0 mt-1 text-xs text-red-700 flex items-start gap-1">
                    <i className="fas fa-exclamation-circle mt-0.5" aria-hidden="true" />{fieldError}
                  </p>
                ) : (
                  <p id="staff-profile-display-name-hint" className="m-0 mt-1 text-xs brand-text-muted">
                    Shown in Staff Management. Up to {MAX_DISPLAY_NAME_LENGTH} characters. Leave empty to show the queue assignment.
                  </p>
                )}
              </div>

              <ReadOnlyField id="staff-profile-role" label="Role" value={String(profile.role || "").toUpperCase()}
                hint="Roles and privileges are not changed from Edit Profile." />

              <ReadOnlyField id="staff-profile-assignment" label="Queue Assignment" value={profile.doctor_name || "—"}
                hint="Used for doctor counters and queue dispatch, so it is not changed here." />

              {!supported ? (
                <p role="alert" className="m-0 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-start gap-2">
                  <i className="fas fa-info-circle mt-0.5" aria-hidden="true" />
                  <span>Display names are not installed on this database yet, so the profile cannot be saved.</span>
                </p>
              ) : null}
            </>
          ) : null}

          {formError ? (
            <p role="alert" className="m-0 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-start gap-2">
              <i className="fas fa-exclamation-circle mt-0.5" aria-hidden="true" />
              <span>{formError}</span>
            </p>
          ) : null}
        </div>

        <div className="px-5 py-4 brand-bg-subtle flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose}
            className="px-4 py-2 rounded-lg bg-gray-200 brand-text text-sm font-semibold disabled:opacity-60">
            Cancel
          </button>
          <button type="submit" disabled={!canSave || Boolean(fieldError)}
            className="px-4 py-2 rounded-lg brand-button text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
