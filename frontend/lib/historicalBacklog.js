// Historical Waiting Backlog (Superadmin, H1 Stage 1): request paths, the cancel form's rules
// and how each server answer is explained. The server decides eligibility, the Manila date
// boundary and the review flags; nothing here filters rows or decides a visit is safe.
import { cleanRecordFilters } from "./recordsFilters";

export const BACKLOG_PAGE_SIZE = 20;
export const MAX_REASON_LENGTH = 1000;
// Offered for development test data only; it is placed in the field for review, never submitted by itself.
export const SUGGESTED_REASON = "Development test concluded — visit not served.";

export function backlogPath(applied, page, limit = BACKLOG_PAGE_SIZE) {
  const query = new URLSearchParams({ ...cleanRecordFilters("backlog", applied), page: String(page), limit: String(limit) });
  return `/queue/backlog?${query}`;
}

export const visitPath = (id) => `/queue/backlog/${encodeURIComponent(id)}`;

// A failed request is never shown as an empty backlog; this names what failed.
export function describeBacklogError(message, status) {
  if (/cannot reach the api|failed to fetch|networkerror|load failed/i.test(message)) {
    return { title: "Backlog API unreachable", advice: "The browser could not connect to the backend server. Check that it is running, then retry." };
  }
  if (status === 401) return { title: "Session ended", advice: "Sign in again to continue." };
  if (status === 403) return { title: "Not authorized", advice: "Only Superadmin can manage the historical backlog." };
  if (status === 503 || /unavailable/i.test(message)) {
    return { title: "Backlog storage unavailable", advice: "The backend answered, but the queue database could not be read." };
  }
  return { title: "Backlog could not be loaded", advice: "No visits are shown because the request failed." };
}

// Whether the confirm step may submit, and if not, the one thing still missing.
export function cancelReadiness(visit, { reason = "", acknowledged = false } = {}) {
  if (!visit) return { ready: false, message: "Loading the current visit…" };
  if (!visit.eligible) return { ready: false, message: visit.ineligible_reason || "This visit is no longer in the historical backlog." };
  if (visit.cancel_blocked) return { ready: false, message: visit.cancel_blocked };
  const trimmed = String(reason).trim();
  if (!trimmed) return { ready: false, message: "Enter the reason for cancelling this visit." };
  if (trimmed.length > MAX_REASON_LENGTH) return { ready: false, message: `The reason is too long (maximum ${MAX_REASON_LENGTH} characters).` };
  if (visit.requires_review && !acknowledged) return { ready: false, message: "Confirm that you reviewed this visit's flagged history." };
  return { ready: true, message: "" };
}

// The request for the existing W1 cancellation, pinned to the revision that was reviewed.
export function cancelRequest(visit, { reason, acknowledged }) {
  return {
    path: `${visitPath(visit.id)}/cancel`,
    body: {
      reason: String(reason).trim(),
      expected_revision: visit.visit_state_revision,
      acknowledge_review: Boolean(visit.requires_review && acknowledged)
    }
  };
}

// What the dialog says after the server answers. Only a 2xx answer is ever shown as done.
export function cancelOutcome(result) {
  if (result && !result.error) {
    return result.already_cancelled
      ? { kind: "already", tone: "info", message: "This visit had already been cancelled. Nothing was changed." }
      : { kind: "cancelled", tone: "success", message: "Visit cancelled. Its registration history was kept." };
  }
  const message = result?.error || "The cancellation request failed.";
  switch (result?.status) {
    case 409: return { kind: "conflict", tone: "warning", message, reload: true };
    case 401: return { kind: "session", tone: "error", message: "Your session ended or was revoked. Sign in again. Nothing was changed." };
    case 403: return { kind: "denied", tone: "error", message: "Your account is not allowed to cancel backlog visits. Nothing was changed." };
    case 400: return { kind: "invalid", tone: "error", message };
    default:
      // 503, a lost response or an unreachable backend: the outcome is unknown until re-read.
      return { kind: "unconfirmed", tone: "error", reload: true,
        message: `${message} Reload the visit to see its current status before trying again.` };
  }
}
