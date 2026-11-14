// OC1 one confirmed or active patient per doctor (backend/scripts/20261113-oc1-one-confirmation-per-doctor.sql).
// A doctor has at most one ACTIVE visit: one it is serving (any day), an Undo reservation on its
// counter, or a CONFIRMED visit of the doctor still waiting in today's queue. While it has one, the
// Front Desk cannot confirm another patient for it. Otherwise only the doctor's next patient may be
// confirmed: the head of its pending (unconfirmed), PRESENT waiting visits in the existing WPS /
// WPS-A order (lib/wpsPriority.js, unchanged). A visit marked Not Present keeps its ticket,
// priority, registration time and doctor; it is only skipped until marked present again.
//
// This module mirrors the SQL (confirm_next_patient_visit and the patients_one_confirmation_per_doctor
// trigger), which enforces the rule under the counter and patient locks. Here it decides which row
// shows Confirm Patient and serves the development-memory store.
//   Doctor of a PENDING visit, by dispatch mode:
//     round_robin: the stored assignment (counter_id); none while pending reassignment.
//     service:     the stored assignment, else the service's doctor (routeOf).
//     shared:      none before the Call, so the next-patient rule does not apply (Not Present still does).
//   Doctor of an ACTIVE visit (every mode): serving -> counter_id, else (legacy) its service's
//   doctor; confirmed waiting -> counter_id, else confirmed_for (the doctor it was confirmed for).
const { compareWps } = require("./wpsPriority");

const BLOCKED_DOCTOR_BUSY = "doctor_has_active_patient";
const BLOCKED_NOT_NEXT = "not_next_for_doctor";
const BLOCKED_UNASSIGNED = "awaiting_doctor_assignment";
const BLOCKED_NOT_PRESENT = "patient_not_present";

const trimmed = (value) => String(value ?? "").trim();
const isPending = (p) => p?.status === "waiting" && p.completed_at == null && p.confirmed_at == null;
const isNotPresent = (p) => p?.not_present_at != null;

function visitDoctor(patient, mode, routeOf) {
  const assigned = trimmed(patient?.counter_id);
  if (mode === "round_robin") return assigned || null;
  if (mode === "service") return assigned || routeOf(patient?.service_type) || null;
  return null;
}

// The doctor `patient` keeps busy, or null when it is not active (qms_oc1_active_doctor).
function activeDoctor(patient, { inQueueWindow, routeOf }) {
  if (patient?.status === "serving") return trimmed(patient.counter_id) || routeOf(patient.service_type) || null;
  if (patient?.status === "waiting" && patient.confirmed_at != null && patient.completed_at == null && inQueueWindow(patient)) {
    return trimmed(patient.counter_id) || trimmed(patient.confirmed_for) || null;
  }
  return null;
}

// Another active visit of `doctor` than `excludeId`: { id, queue_number } or null (qms_oc1_active_visit).
function findActiveVisit({ patients, counters, doctor, excludeId, inQueueWindow, routeOf }) {
  const byId = new Map((patients || []).map((p) => [Number(p.id), p]));
  for (const counter of counters || []) {
    if (counter?.id_num !== doctor || counter.current_patient_id == null) continue;
    const id = Number(counter.current_patient_id);
    if (id !== Number(excludeId)) return { id, queue_number: byId.get(id)?.queue_number ?? null };
  }
  const candidates = (patients || []).filter((p) => Number(p.id) !== Number(excludeId) &&
    activeDoctor(p, { inQueueWindow, routeOf }) === doctor);
  candidates.sort((a, b) => (b.status === "serving") - (a.status === "serving") || Number(a.id) - Number(b.id));
  return candidates[0] ? { id: Number(candidates[0].id), queue_number: candidates[0].queue_number } : null;
}

// The same sentences the SQL raises.
function blockedMessage(reason, doctor, queueNumber) {
  if (reason === BLOCKED_DOCTOR_BUSY) {
    return `${doctor} already has an active patient (${queueNumber || "unknown"}). The next patient can be confirmed after that visit is completed, cancelled or marked no-show.`;
  }
  if (reason === BLOCKED_NOT_NEXT) {
    return `Only the next patient in ${doctor}'s queue (${queueNumber}) can be confirmed now.`;
  }
  if (reason === BLOCKED_NOT_PRESENT) {
    return "This patient is marked Not Present. Mark the patient present before confirming.";
  }
  return "This patient is waiting for a doctor assignment. It can be confirmed once a doctor is assigned.";
}

// The trigger's refusal when Undo or a transfer would give a doctor a second active visit.
function activeConflictMessage(doctor, queueNumber) {
  return `${doctor} already has an active patient (${queueNumber || "unknown"}). A doctor can have only one confirmed or active patient at a time.`;
}

// patients: today's visits plus every serving visit (any day); counters: id_num, current_patient_id.
// Returns Map(patient id -> { confirmable, reason, doctor, queue_number, message }) for every
// pending visit in today's queue window.
function buildConfirmationGate({ patients, counters, mode, rankedAt, aging, inQueueWindow, routeOf }) {
  const gate = new Map();
  const entry = (reason, doctor, queueNumber) => ({
    confirmable: reason == null, reason, doctor, queue_number: queueNumber,
    message: reason == null ? null : blockedMessage(reason, doctor, queueNumber)
  });
  const pending = (patients || []).filter((p) => isPending(p) && inQueueWindow(p));
  if (mode !== "service" && mode !== "round_robin") {
    for (const p of pending) gate.set(Number(p.id), entry(isNotPresent(p) ? BLOCKED_NOT_PRESENT : null, null, null));
    return gate;
  }

  // The head of each doctor's present, pending visits.
  const heads = new Map();
  for (const p of pending.filter((row) => !isNotPresent(row)).sort((a, b) => compareWps(a, b, rankedAt, aging))) {
    const doctor = visitDoctor(p, mode, routeOf);
    if (doctor && !heads.has(doctor)) heads.set(doctor, p);
  }

  for (const p of pending) {
    const id = Number(p.id);
    const doctor = visitDoctor(p, mode, routeOf);
    if (isNotPresent(p)) {
      gate.set(id, entry(BLOCKED_NOT_PRESENT, doctor, null));
      continue;
    }
    if (!doctor) {
      gate.set(id, entry(BLOCKED_UNASSIGNED, null, null));
      continue;
    }
    const blocking = findActiveVisit({ patients, counters, doctor, excludeId: id, inQueueWindow, routeOf });
    if (blocking) gate.set(id, entry(BLOCKED_DOCTOR_BUSY, doctor, blocking.queue_number));
    else if (Number(heads.get(doctor)?.id) !== id) gate.set(id, entry(BLOCKED_NOT_NEXT, doctor, heads.get(doctor)?.queue_number ?? null));
    else gate.set(id, entry(null, doctor, null));
  }
  return gate;
}

// Doctor queue notifications (GET /queue my_queue): the doctor a WAITING visit is assigned to.
// Confirmed: its assignment, else the doctor it was confirmed for (OC1 confirmed_for, after an
// Undo in round robin). Pending: the same rule as visitDoctor (service mode falls back to the
// service's doctor; round robin and shared leave an unassigned visit with no doctor).
function waitingVisitDoctor(patient, mode, routeOf) {
  const assigned = trimmed(patient?.counter_id);
  if (assigned) return assigned;
  if (patient?.confirmed_at != null && trimmed(patient.confirmed_for)) return trimmed(patient.confirmed_for);
  return visitDoctor(patient, mode, routeOf);
}

// Every waiting visit of `doctor` in today's queue window, counted once per visit id: the records
// Front Desk Patient Management counts as Waiting, confirmed or not. Read-only; nothing here
// assigns, confirms or ranks. visit_ids lets the doctor's screen tell a newly assigned visit from
// one it already saw; it carries no name, ticket or service.
//   ready: confirmed by the Front Desk (callable); awaiting_confirmation: pending and present;
//   not_present: pending, set aside by the Front Desk (keeps its place).
function buildDoctorWaitingSummary({ patients, doctor, mode, inQueueWindow, routeOf, normalizeDoctor = trimmed }) {
  const visits = new Map();
  for (const p of patients || []) {
    if (p?.status !== "waiting" || p.completed_at != null || !inQueueWindow(p)) continue;
    const id = Number(p.id);
    if (!Number.isSafeInteger(id) || id <= 0 || visits.has(id)) continue;
    const owner = waitingVisitDoctor(p, mode, routeOf);
    if (!owner || normalizeDoctor(owner) !== doctor) continue;
    visits.set(id, p);
  }
  let ready = 0, notPresent = 0;
  for (const p of visits.values()) {
    if (p.confirmed_at != null) ready++;
    else if (isNotPresent(p)) notPresent++;
  }
  return {
    doctor,
    waiting: visits.size,
    ready,
    awaiting_confirmation: visits.size - ready - notPresent,
    not_present: notPresent,
    visit_ids: [...visits.keys()].sort((a, b) => a - b)
  };
}

module.exports = {
  BLOCKED_DOCTOR_BUSY, BLOCKED_NOT_NEXT, BLOCKED_UNASSIGNED, BLOCKED_NOT_PRESENT,
  visitDoctor, activeDoctor, findActiveVisit, blockedMessage, activeConflictMessage, buildConfirmationGate,
  waitingVisitDoctor, buildDoctorWaitingSummary
};
