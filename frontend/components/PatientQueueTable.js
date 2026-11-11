import { useMemo } from "react";
import { request } from "../lib/api";
import { serviceName } from "../lib/services";
import {
  QUEUE_SERVICE_BADGE_CLASS,
  QUEUE_STATUS_COUNTERS,
  belongsToDoctor,
  countQueueStatuses,
  doctorDisplayName,
  formatQueueDate,
  formatQueueTime,
  isDoctorOnline,
  isUnassigned,
  matchesQueueSearch,
  queueDoctorLabel,
  queuePriorityClass,
  queueStatusClass
} from "../lib/queueView";

export const DOCTORS = [
  { name: "Doctor 1", assignment: "Consultation, Check-up" },
  { name: "Doctor 2", assignment: "Prenatal, Maternity" },
  { name: "Doctor 3", assignment: "Family Planning" }
];

// D1 shared dispatch (the backend's dispatch_mode "shared", provisional): the three general
// doctors serve every configured service and a waiting visit belongs to no doctor until one
// of them calls it.
export const SHARED_DISPATCH = "shared";
export const SHARED_ASSIGNMENT = "All services";
const SHARED_LANE = "Shared queue";

const STATUS_RANK = { serving: 0, waiting: 1, cancelled: 2, "no-show": 2, completed: 3 };

// Service-to-doctor routing, counters, badges, search and time formatting are shared with the
// Superadmin Queue Management table (lib/queueView.js); the actions below are this page's own.

// The backend's WPS rank key (effective_priority includes WPS-A aging when enabled).
const wpsRank = (row) => row.effective_priority ?? row.priority_score ?? 0;

function compareQueue(a, b) {
  const rankDiff = (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4);
  if (rankDiff !== 0) return rankDiff;
  // FRD-02: WPS rank DESC (a higher base priority wins a tie), then check-in time ASC
  return wpsRank(b) - wpsRank(a) || (b.priority_score || 0) - (a.priority_score || 0) ||
    new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id);
}

// Same rules as the Doctor "My Queue Management" list: waiting/serving patients plus
// cancellations still inside the Undo window (hidden once the doctor calls the next patient).
function buildActiveQueue(queueRows, doctorName, shared = false) {
  const queue = (queueRows ?? []).filter((row) => {
    return ["waiting", "serving", "cancelled", "no-show"].includes(row.status) && belongsToDoctor(row, doctorName, shared);
  });

  const hasActiveServing = queue.some((row) => row.status === "serving");

  const rows = queue.filter((row) => {
    if (row.status === "cancelled") return !hasActiveServing;
    return true;
  });

  return rows.slice().sort(compareQueue);
}

// Unassigned waiting visits, plus cancellations/no-shows of visits nobody called, kept in view
// until the next patient is called (the shared-lane equivalent of the doctor's active list).
function buildSharedQueue(queueRows) {
  const rows = queueRows ?? [];
  const lastCall = Math.max(0, ...rows.map((row) => Date.parse(row.called_at) || 0));
  return rows.filter((row) => isUnassigned(row) && (row.status === "waiting" ||
    (["cancelled", "no-show"].includes(row.status) && (Date.parse(row.completed_at) || 0) >= lastCall)))
    .sort(compareQueue);
}

const COLUMN_WIDTHS = ["9%", "20%", "12%", "14%", "8%", "10%", "9%", "18%"];

export default function PatientQueueTable({
  doctors,
  queueRows,
  counters,
  queueSettings,
  statusFilter = "active",
  search = "",
  onRefresh,
  onNotify,
  onConfirm,
  onViewTicket,
  ticketLoadingId = null,
  dispatchMode = "service",
  doctorNames = {}
}) {
  const shared = dispatchMode === SHARED_DISPATCH;

  const doctorStates = useMemo(() => {
    const states = {};
    for (const doctor of doctors) {
      const activeRows = buildActiveQueue(queueRows, doctor.name, shared);
      const serving = activeRows.find((row) => row.status === "serving");
      states[doctor.name] = {
        activeRows,
        serving,
        // Only the head of each doctor's queue (serving first, else first waiting) may be acted on
        activePatientId: serving?.id ?? activeRows.find((row) => row.status === "waiting")?.id ?? null,
        online: isDoctorOnline(counters, queueSettings, doctor.name)
      };
    }
    return states;
  }, [doctors, queueRows, counters, queueSettings, shared]);

  // Shared dispatch: one queue for every doctor.
  const sharedQueue = useMemo(() => (shared ? buildSharedQueue(queueRows) : []), [shared, queueRows]);
  const sharedHead = sharedQueue.find((row) => row.status === "waiting" && !row.isOptimistic) || null;

  const visibleRows = useMemo(() => {
    const byId = new Map();
    if (shared) {
      const source = statusFilter === "active" ? sharedQueue
        : (queueRows ?? []).filter((row) => isUnassigned(row) && (statusFilter === "all" || row.status === statusFilter));
      for (const row of source) byId.set(row.id, { row, doctorName: null });
    }
    for (const doctor of doctors) {
      const source =
        statusFilter === "active"
          ? doctorStates[doctor.name].activeRows
          : (queueRows ?? []).filter((row) => (statusFilter === "all" || row.status === statusFilter) && belongsToDoctor(row, doctor.name, shared));

      for (const row of source) {
        const existing = byId.get(row.id);
        // A row can match two doctors (service vs. counter); the counter assignment wins
        if (!existing || (existing.doctorName !== row.counter_id && row.counter_id === doctor.name)) {
          byId.set(row.id, { row, doctorName: doctor.name });
        }
      }
    }

    const doctorOrder = [null, ...doctors.map((d) => d.name)];
    return Array.from(byId.values())
      .filter(({ row }) => matchesQueueSearch(row, search))
      .sort((a, b) => {
        const rankDiff = (STATUS_RANK[a.row.status] ?? 4) - (STATUS_RANK[b.row.status] ?? 4);
        if (rankDiff !== 0) return rankDiff;
        const doctorDiff = doctorOrder.indexOf(a.doctorName) - doctorOrder.indexOf(b.doctorName);
        if (doctorDiff !== 0) return doctorDiff;
        return compareQueue(a.row, b.row);
      });
  }, [doctors, doctorStates, queueRows, statusFilter, search, shared, sharedQueue]);

  const counts = useMemo(
    () => countQueueStatuses(queueRows, doctors.map(({ name }) => name), shared),
    [doctors, queueRows, shared]
  );

  async function postAction(doctorName, path, body, fallbackMessage) {
    const data = await request(path, { method: "POST", body: JSON.stringify(body) });
    if (data?.error) {
      throw new Error(data.error);
    }
    onNotify("success", `${doctorDisplayName(doctorNames, doctorName)}: ${data.message || fallbackMessage}`);
    await onRefresh();
  }

  const isHead = (row, doctorName) => row?.id != null && row.id === doctorStates[doctorName]?.activePatientId;

  function handleSharedCancel(row) {
    if (row.id !== sharedHead?.id) {
      onNotify("error", "You can only cancel the first patient in the shared queue.");
      return;
    }
    onConfirm({
      title: "Cancel Patient",
      message: `Cancel ${row.id_num} (${row.queue_number}) from the shared queue? Please enter a reason for canceling.`,
      showReason: true,
      requireReason: true,
      onConfirm: (reason) => postAction(SHARED_LANE, "/queue/cancel", { patient_id: row.id, reason }, "Patient cancelled successfully")
    });
  }

  // Calling belongs to the doctor's own queue; here a row can only be cancelled.
  function renderSharedActions(row) {
    if (row.status !== "waiting") return <span className="brand-text-muted text-xs">—</span>;
    if (row.id !== sharedHead?.id) {
      return <span className="text-[11px] brand-text-muted font-semibold italic px-1">Waiting for turn</span>;
    }
    return (
      <button
        type="button"
        onClick={() => handleSharedCancel(row)}
        className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors shadow-sm"
      >
        Cancel
      </button>
    );
  }

  function handleCancel(row, doctorName) {
    if (!isHead(row, doctorName)) {
      onNotify("error", `You can only cancel the first patient in ${doctorDisplayName(doctorNames, doctorName)}'s queue.`);
      return;
    }
    onConfirm({
      title: "Cancel Patient",
      message: `Cancel ${row.id_num} (${row.queue_number}) from ${doctorDisplayName(doctorNames, doctorName)}'s queue? Please enter a reason for canceling.`,
      showReason: true,
      requireReason: true,
      onConfirm: (reason) =>
        postAction(
          doctorName,
          "/queue/cancel",
          { patient_id: row.id, reason, counter_id: doctorName },
          "Patient cancelled successfully"
        )
    });
  }

  function renderActions(row, doctorName) {
    if (doctorName == null) return renderSharedActions(row);
    if (row.status === "waiting") {
      if (!isHead(row, doctorName)) {
        const serving = doctorStates[doctorName].serving;
        return <span className="text-[11px] brand-text-muted font-semibold italic px-1">
          {serving ? `Serving ${serving.queue_number}` : "Waiting for turn"}
        </span>;
      }
      return (
        <button
          type="button"
          onClick={() => handleCancel(row, doctorName)}
          className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors shadow-sm"
        >
          Cancel
        </button>
      );
    }

    if (row.status === "serving" && isHead(row, doctorName)) {
      return (
        <>
          <span className="text-[11px] brand-text-muted font-semibold px-1">
            {row.consultation_started_at ? "Consultation in progress" : row.awaiting_accept ? "Awaiting doctor acceptance" : "Ready for consultation"}
          </span>
          <button
            type="button"
            onClick={() => handleCancel(row, doctorName)}
            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors shadow-sm"
          >
            Cancel
          </button>
        </>
      );
    }

    return <span className="brand-text-muted text-xs">—</span>;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border brand-border overflow-hidden mb-6">
      <div className="p-4 border-b brand-border brand-bg-subtle flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-2">
          <i className="fas fa-users brand-text-primary" />
          <h2 className="font-bold brand-text text-base m-0">All Patients</h2>
          <span className="text-xs brand-text-muted">({visibleRows.length} shown)</span>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold" data-queue-counters>
          {QUEUE_STATUS_COUNTERS.map(({ status, label, className }) => (
            <span key={status} data-counter={status} className={`px-2.5 py-1 rounded-full ${className}`}>{label} {counts[status]}</span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left table-fixed min-w-[820px]">
          <colgroup>
            {COLUMN_WIDTHS.map((width, idx) => (
              <col key={idx} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr className="brand-bg-subtle">
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Queue</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Patient Info</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Doctor</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Service</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider text-center">Priority</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider text-center">Status</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Time</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan="8" className="px-4 py-10 text-center brand-text-muted">
                  <i className="fas fa-inbox text-3xl mb-2 block" />
                  No patients match this view
                </td>
              </tr>
            ) : (
              visibleRows.map(({ row, doctorName }) => (
                <tr key={row.id} className="brand-hover-subtle transition-colors">
                  <td className="px-4 py-4">
                    <span className="font-mono font-bold brand-text-primary text-lg whitespace-nowrap">{row.queue_number}</span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="font-semibold brand-text truncate" title={row.id_num}>{row.id_num}</div>
                    {formatQueueDate(row.created_at) && (
                      <div className="text-[10px] brand-text-muted mt-1">Registered {formatQueueDate(row.created_at)}</div>
                    )}
                    <div className="flex flex-wrap gap-2 mt-1">
                      {row.sex && (
                        <span className="text-[10px] brand-bg-subtle brand-text-primary px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                          {row.sex}
                        </span>
                      )}
                      {row.birthdate && (
                        <span className="text-[10px] brand-text-muted">
                          <i className="fas fa-birthday-cake me-1" />
                          {formatQueueDate(row.birthdate)}
                        </span>
                      )}
                      {row.mobile_number && (
                        <span className="text-[10px] brand-text-muted">
                          <i className="fas fa-phone-alt me-1" /> {row.mobile_number}
                        </span>
                      )}
                      {row.philhealth_id && (
                        <span className="text-[10px] text-blue-600 font-medium">
                          <i className="fas fa-id-card me-1" /> {row.philhealth_id}
                        </span>
                      )}
                    </div>
                    {row.residency && (
                      <div className="text-[10px] brand-text-muted mt-1 truncate" title={row.residency}>
                        <i className="fas fa-map-marker-alt me-1" />
                        {row.residency}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2 font-semibold brand-text text-sm whitespace-nowrap">
                      <i className="fas fa-user-md text-blue-600" />
                      {queueDoctorLabel(doctorName, row.status, doctorNames)}
                    </div>
                    {doctorName != null && !doctorStates[doctorName].online ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider brand-text-muted">Offline</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-4">
                    <span className={`px-2.5 py-1 text-xs ${QUEUE_SERVICE_BADGE_CLASS}`} title={row.service_type}>
                      {serviceName(row.service_type)}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    {queuePriorityClass(row.priority_score) ? (
                      <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${queuePriorityClass(row.priority_score)}`}>
                        <i className="fas fa-star" /> {row.priority_score}
                      </span>
                    ) : (
                      <span className="brand-text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${queueStatusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-xs brand-text-muted whitespace-nowrap">{formatQueueTime(row.created_at)}</td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex justify-end gap-2 flex-wrap">
                      {onViewTicket ? (
                        <button
                          type="button"
                          onClick={() => onViewTicket(row)}
                          disabled={ticketLoadingId != null}
                          aria-busy={String(ticketLoadingId) === String(row.id)}
                          aria-label={`View ticket ${row.queue_number}`}
                          className="px-3 py-1.5 border brand-border brand-text rounded-lg text-xs font-bold brand-hover-subtle transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <i className="fas fa-ticket-alt me-1" aria-hidden="true" />
                          {String(ticketLoadingId) === String(row.id) ? "Opening ticket..." : "View Ticket"}
                        </button>
                      ) : null}
                      {renderActions(row, doctorName)}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
