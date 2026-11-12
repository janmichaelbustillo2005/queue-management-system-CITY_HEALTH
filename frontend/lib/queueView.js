// Shared, read-only display rules for the two staff queue tables that read the same
// GET /queue records: Front Desk "Patient Management" (components/PatientQueueTable.js) and
// the Superadmin "Queue Management" section (pages/index.js). Only what a row shows, how the
// status counters are counted, and how rows are searched and filtered live here. Every action
// (Call, Cancel, Transfer, Undo, View Ticket) stays in its own page. This module imports nothing.

// The service-to-doctor display route (service dispatch). Any other service follows the
// backend's default route (getDoctorForService): Doctor 1.
export const SERVICE_TO_DOCTOR = {
  consultation: "Doctor 1",
  checkup: "Doctor 1",
  laboratory: "Doctor 1",
  dental: "Doctor 1",
  prenatal: "Doctor 2",
  maternity: "Doctor 2",
  obgyne: "Doctor 2",
  family_planning: "Doctor 3"
};

export const serviceDoctor = (serviceType) => SERVICE_TO_DOCTOR[serviceType] || "Doctor 1";

export const isUnassigned = (row) => !String(row?.counter_id ?? "").trim();

// FC1 Front Desk confirmation (confirmed_at on the visit, from GET /queue). A waiting visit is
// callable only once the Front Desk confirmed the patient is present; until then it keeps its
// doctor and rank but is not part of any doctor's queue. The backend enforces the same rule.
export const isAwaitingConfirmation = (row) => row?.status === "waiting" && row?.confirmed_at == null;
export const isConfirmedWaiting = (row) => row?.status === "waiting" && row?.confirmed_at != null;
export const CONFIRMATION_PENDING_LABEL = "Pending Confirmation";
export const CONFIRMATION_AWAITING_LABEL = "Awaiting Front Desk Confirmation";
export const CONFIRMATION_PENDING_CLASS = "bg-amber-100 text-amber-800";
export const CONFIRMATION_CONFIRMED_CLASS = "bg-emerald-100 text-emerald-800";

// "Confirmed 9:41 AM by frontdesk", for the confirmation badge's tooltip.
export function confirmationDetail(row) {
  if (row?.confirmed_at == null) return "Not yet confirmed by the Front Desk";
  const time = formatQueueTime(row.confirmed_at);
  return `Confirmed ${time}${row.confirmed_by ? ` by ${row.confirmed_by}` : ""}`;
}

export function matchesDoctor(serviceType, doctorName) {
  if (!serviceType || !doctorName) return false;
  return serviceDoctor(serviceType) === doctorName;
}

export function belongsToDoctor(row, doctorName, shared = false) {
  if (shared) return row.counter_id === doctorName;
  return row.counter_id ? row.counter_id === doctorName : matchesDoctor(row.service_type, doctorName);
}

// The doctor a visit is shown under: its assigned doctor, else (service dispatch) the doctor its
// service routes to. Shared dispatch leaves a waiting visit without a doctor until one calls it.
// Display only: nothing here assigns a doctor.
export function queueDoctorName(row, shared = false) {
  const assigned = String(row?.counter_id ?? "").trim();
  if (assigned) return assigned;
  return shared ? null : serviceDoctor(row?.service_type);
}

// EP1: `names` is GET /queue's doctor_display_names (counter id -> the assigned account's display
// name). Counter ids stay the values used for filtering, calls and transfers; only the text shown
// changes, and it falls back to the counter id ("Doctor 1") when no display name is set.
export const doctorDisplayName = (names, doctorName) =>
  (doctorName && typeof names?.[doctorName] === "string" && names[doctorName].trim()) || doctorName;

export const queueDoctorLabel = (doctorName, status, names) =>
  doctorDisplayName(names, doctorName) ?? (status === "waiting" ? "Next available" : "Unassigned");

// A doctor whose counter is disabled is shown as Offline next to its name.
export function isDoctorOnline(counters, queueSettings, doctorName) {
  const counter = (counters ?? []).find((c) => c.id_num === doctorName);
  if (counter) return counter.is_online !== false;
  if (doctorName === "Doctor 1") return queueSettings?.doctor1Online !== false;
  if (doctorName === "Doctor 2") return queueSettings?.doctor2Online !== false;
  if (doctorName === "Doctor 3") return queueSettings?.doctor3Online !== false;
  return true;
}

// Waiting / Serving / Completed / Cancelled, counted from the loaded queue records for the
// given doctors (the same scope on both pages, so one record counts the same everywhere).
export function countQueueStatuses(queueRows, doctorNames, shared = false) {
  const rows = queueRows ?? [];
  const total = { waiting: 0, serving: 0, completed: 0, cancelled: 0 };
  if (shared) {
    const visible = (row) => isUnassigned(row) || doctorNames.some((name) => row.counter_id === name);
    for (const status of Object.keys(total)) {
      total[status] = rows.filter((row) => row.status === status && visible(row)).length;
    }
    return total;
  }
  for (const name of doctorNames) {
    total.waiting += rows.filter((row) => row.status === "waiting" && matchesDoctor(row.service_type, name)).length;
    total.serving += rows.filter((row) => row.status === "serving" && belongsToDoctor(row, name)).length;
    total.completed += rows.filter((row) => row.status === "completed" && row.counter_id === name).length;
    total.cancelled += rows.filter((row) => row.status === "cancelled" && belongsToDoctor(row, name)).length;
  }
  return total;
}

export const QUEUE_STATUS_COUNTERS = [
  { status: "waiting", label: "Waiting", className: "bg-amber-100 text-amber-700" },
  { status: "serving", label: "Serving", className: "bg-emerald-100 text-emerald-700" },
  { status: "completed", label: "Completed", className: "bg-green-50 text-green-700" },
  { status: "cancelled", label: "Cancelled", className: "bg-gray-200 brand-text" }
];

const STATUS_BADGE_CLASSES = {
  ...Object.fromEntries(QUEUE_STATUS_COUNTERS.map(({ status, className }) => [status, className])),
  "no-show": "bg-red-100 text-red-700"
};

export const queueStatusClass = (status) => STATUS_BADGE_CLASSES[status] || "bg-gray-100 brand-text-muted";

export const QUEUE_SERVICE_BADGE_CLASS = "bg-blue-50 text-blue-700 rounded-md font-bold uppercase tracking-wider";

// A score of 3 or more is a high priority; any positive score is shown; none shows a dash.
export function queuePriorityClass(score) {
  const value = Number(score) || 0;
  if (value >= 3) return "text-yellow-700 bg-yellow-100";
  if (value > 0) return "text-blue-700 bg-blue-100";
  return null;
}

// WPS-A aging, as the backend reports it on GET /queue: `wps.aging` says whether aging is on, and
// each waiting visit's `effective_priority` is its rank key at read time. The bonus shown is the
// difference from the stored score (0 to +2); the screens never compute aging themselves.
export const isWpsAgingOn = (queueData) => queueData?.wps?.aging === true;

export function queueAgingBonus(row) {
  if (row?.status !== "waiting") return 0;
  const bonus = Number(row.effective_priority) - (Number(row.priority_score) || 0);
  return Number.isInteger(bonus) && bonus > 0 ? Math.min(2, bonus) : 0;
}

export const QUEUE_AGING_BADGE_CLASS = "bg-violet-100 text-violet-800";
export const WPS_AGING_HEADER_LABEL = "Aging on";
export const WPS_AGING_HEADER_TITLE = "WPS-A aging is on: a waiting patient gains +1 priority for every full 10 minutes since registration, at most +2.";

export function queueAgingTitle(row) {
  const bonus = queueAgingBonus(row);
  return `Aging bonus +${bonus} (waited ${bonus * 10}+ minutes). Ranked as ${Number(row.priority_score) || 0} + ${bonus} = ${Number(row.effective_priority)}.`;
}

// The status choices both pages offer after their own default view.
export const QUEUE_STATUS_FILTERS = [
  { value: "all", label: "All registered patients" },
  { value: "waiting", label: "Waiting" },
  { value: "serving", label: "Serving" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no-show", label: "No-show" }
];

export const QUEUE_SEARCH_PLACEHOLDER = "Patient name or queue number";

export function matchesQueueSearch(row, search) {
  const term = String(search ?? "").trim().toLowerCase();
  return !term ||
    String(row?.id_num || "").toLowerCase().includes(term) ||
    String(row?.queue_number || "").toLowerCase().includes(term);
}

export const matchesQueueStatus = (row, statusFilter) => statusFilter === "all" || row?.status === statusFilter;

// The doctor filter: that doctor's visits, plus (shared dispatch) the visits no doctor has
// called yet, which every doctor may take.
export function matchesQueueDoctor(row, doctorFilter, shared = false) {
  if (!doctorFilter || doctorFilter === "all") return true;
  return queueDoctorName(row, shared) === doctorFilter || (shared && isUnassigned(row));
}

// The stored registration time, in the viewer's locale and timezone as before.
export function formatQueueTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString() : "—";
}

export function formatQueueDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : "";
}
