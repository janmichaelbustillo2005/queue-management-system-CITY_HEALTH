import { useMemo, useRef, useState } from "react";
import { request } from "../lib/api";

export const DOCTORS = [
  { name: "Doctor 1", assignment: "Consultation, Check-up" },
  { name: "Doctor 2", assignment: "Prenatal, Maternity" },
  { name: "Doctor 3", assignment: "Family Planning" }
];

// D1 shared dispatch (the backend's dispatch_mode "shared", provisional): the three general
// doctors serve every configured service, a waiting visit belongs to no doctor until it is
// called, and Frontdesk selects an available doctor at Call Now.
export const SHARED_DISPATCH = "shared";
export const SHARED_ASSIGNMENT = "All services";
const SHARED_LANE = "Shared queue";
const CONFIGURED_SERVICES = ["consultation", "checkup", "prenatal", "maternity", "family_planning"];

const SERVICE_TO_DOCTOR = {
  consultation: "Doctor 1",
  checkup: "Doctor 1",
  laboratory: "Doctor 1",
  dental: "Doctor 1",
  prenatal: "Doctor 2",
  maternity: "Doctor 2",
  obgyne: "Doctor 2",
  family_planning: "Doctor 3"
};

const STATUS_RANK = { serving: 0, waiting: 1, cancelled: 2, "no-show": 2, completed: 3 };

function matchesDoctor(serviceType, doctorName) {
  if (!serviceType || !doctorName) return false;
  return SERVICE_TO_DOCTOR[serviceType] === doctorName;
}

function belongsToDoctor(row, doctorName, shared = false) {
  if (shared) return row.counter_id === doctorName;
  return row.counter_id ? row.counter_id === doctorName : matchesDoctor(row.service_type, doctorName);
}

const isUnassigned = (row) => !String(row?.counter_id ?? "").trim();

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

// The backend's shared-queue head for one doctor (getSharedQueueHead): every unassigned waiting
// visit of a configured service, plus a legacy reservation for that doctor, by priority.
function sharedHeadFor(queueRows, doctorName) {
  return (queueRows ?? []).filter((row) => row.status === "waiting" && !row.isOptimistic &&
    CONFIGURED_SERVICES.includes(row.service_type) && (isUnassigned(row) || row.counter_id === doctorName))
    .sort(compareQueue)[0] || null;
}

// Unassigned waiting visits, plus cancellations/no-shows of visits nobody called, kept for Undo
// until the next patient is called (the shared-lane equivalent of the doctor Undo window).
function buildSharedQueue(queueRows) {
  const rows = queueRows ?? [];
  const lastCall = Math.max(0, ...rows.map((row) => Date.parse(row.called_at) || 0));
  return rows.filter((row) => isUnassigned(row) && (row.status === "waiting" ||
    (["cancelled", "no-show"].includes(row.status) && (Date.parse(row.completed_at) || 0) >= lastCall)))
    .sort(compareQueue);
}

function isDoctorOnline(counters, queueSettings, doctorName) {
  const counter = (counters ?? []).find((c) => c.id_num === doctorName);
  if (counter) return counter.is_online !== false;
  if (doctorName === "Doctor 1") return queueSettings.doctor1Online !== false;
  if (doctorName === "Doctor 2") return queueSettings.doctor2Online !== false;
  if (doctorName === "Doctor 3") return queueSettings.doctor3Online !== false;
  return true;
}

const COLUMN_WIDTHS = ["10%", "21%", "13%", "15%", "9%", "11%", "21%"];

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
  dispatchMode = "service"
}) {
  const shared = dispatchMode === SHARED_DISPATCH;
  const pendingCallsRef = useRef(new Set());
  const [callingDoctors, setCallingDoctors] = useState(() => new Set());
  const [selectedDoctor, setSelectedDoctor] = useState("");

  const doctorStates = useMemo(() => {
    const states = {};
    for (const doctor of doctors) {
      const activeRows = buildActiveQueue(queueRows, doctor.name, shared);
      const serving = activeRows.find((row) => row.status === "serving");
      const counter = (counters ?? []).find((item) => item.id_num === doctor.name);
      const activePatientId = serving?.id ?? activeRows.find((row) => row.status === "waiting")?.id ?? null;
      const online = isDoctorOnline(counters, queueSettings, doctor.name);
      const callBlockedReason = !online
        ? `${doctor.name} is offline.`
        : counter?.current_patient_id != null && counter.current_patient_id !== activePatientId
          ? `${doctor.name} is assigned to ${counter.current_patient_queue_number || "another patient"}.`
          : "";
      states[doctor.name] = {
        activeRows,
        serving,
        // Only the head of each doctor's queue (serving first, else first waiting) may be acted on
        activePatientId,
        undoableIds: new Set(
          activeRows.filter((row) => ["cancelled", "no-show"].includes(row.status)).map((row) => row.id)
        ),
        online,
        callBlockedReason
      };
    }
    return states;
  }, [doctors, queueRows, counters, queueSettings, shared]);

  // Shared dispatch: one queue for every doctor. Its head may go to any doctor that is enabled,
  // has no patient and whose own backend head is the same visit (no legacy reservation first).
  const sharedQueue = useMemo(() => (shared ? buildSharedQueue(queueRows) : []), [shared, queueRows]);
  const sharedHead = sharedQueue.find((row) => row.status === "waiting" && !row.isOptimistic) || null;
  const availableDoctors = shared && sharedHead ? DOCTORS.filter(({ name }) => {
    const counter = (counters ?? []).find((item) => item.id_num === name);
    const busy = (queueRows ?? []).some((row) => row.status === "serving" && row.counter_id === name);
    return isDoctorOnline(counters, queueSettings, name) && counter?.current_patient_id == null && !busy &&
      sharedHeadFor(queueRows, name)?.id === sharedHead.id;
  }).map(({ name }) => name) : [];
  const callDoctor = availableDoctors.includes(selectedDoctor) ? selectedDoctor : availableDoctors[0] || "";

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

    const term = search.trim().toLowerCase();
    const doctorOrder = [null, ...doctors.map((d) => d.name)];
    return Array.from(byId.values())
      .filter(
        ({ row }) =>
          !term ||
          String(row.id_num || "").toLowerCase().includes(term) ||
          String(row.queue_number || "").toLowerCase().includes(term)
      )
      .sort((a, b) => {
        const rankDiff = (STATUS_RANK[a.row.status] ?? 4) - (STATUS_RANK[b.row.status] ?? 4);
        if (rankDiff !== 0) return rankDiff;
        const doctorDiff = doctorOrder.indexOf(a.doctorName) - doctorOrder.indexOf(b.doctorName);
        if (doctorDiff !== 0) return doctorDiff;
        return compareQueue(a.row, b.row);
      });
  }, [doctors, doctorStates, queueRows, statusFilter, search, shared, sharedQueue]);

  const counts = useMemo(() => {
    const rows = queueRows ?? [];
    const total = { waiting: 0, serving: 0, completed: 0, cancelled: 0 };
    if (shared) {
      const visible = (row) => isUnassigned(row) || doctors.some(({ name }) => row.counter_id === name);
      for (const status of Object.keys(total)) {
        total[status] = rows.filter((row) => row.status === status && visible(row)).length;
      }
      return total;
    }
    for (const { name } of doctors) {
      total.waiting += rows.filter((row) => row.status === "waiting" && matchesDoctor(row.service_type, name)).length;
      total.serving += rows.filter((row) => row.status === "serving" && belongsToDoctor(row, name)).length;
      total.completed += rows.filter((row) => row.status === "completed" && row.counter_id === name).length;
      total.cancelled += rows.filter((row) => row.status === "cancelled" && belongsToDoctor(row, name)).length;
    }
    return total;
  }, [doctors, queueRows, shared]);

  async function postAction(doctorName, path, body, fallbackMessage) {
    const data = await request(path, { method: "POST", body: JSON.stringify(body) });
    if (data?.error) {
      throw new Error(data.error);
    }
    onNotify("success", `${doctorName}: ${data.message || fallbackMessage}`);
    await onRefresh();
  }

  async function runAction(doctorName, path, body, fallbackMessage) {
    try {
      await postAction(doctorName, path, body, fallbackMessage);
    } catch (err) {
      onNotify("error", `${doctorName}: ${err.message || "Action failed"}`);
    }
  }

  const isHead = (row, doctorName) => row?.id != null && row.id === doctorStates[doctorName]?.activePatientId;

  async function handleSharedCall(row) {
    if (pendingCallsRef.current.has(SHARED_LANE)) return;
    if (row.id !== sharedHead?.id) {
      onNotify("error", "You can only call the first patient in the shared queue.");
      return;
    }
    const doctorName = callDoctor;
    if (!doctorName) {
      onNotify("error", "No doctor is available. Wait for a doctor to finish or ask Super Admin to enable a doctor.");
      return;
    }
    // One shared call at a time from this screen; the backend serializes calls across screens.
    pendingCallsRef.current.add(SHARED_LANE);
    setCallingDoctors(new Set(pendingCallsRef.current));
    try {
      await postAction(doctorName, "/queue/call", { patient_id: row.id, counterId: doctorName }, "Patient called successfully");
    } catch (err) {
      onNotify("error", `${doctorName}: ${err.message || "Action failed"}`);
      try { await onRefresh(); } catch (_) { /* Keep the call error visible. */ }
    } finally {
      pendingCallsRef.current.delete(SHARED_LANE);
      setCallingDoctors(new Set(pendingCallsRef.current));
    }
  }

  function handleSharedCancel(row) {
    if (pendingCallsRef.current.has(SHARED_LANE)) return;
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

  function renderSharedActions(row) {
    const calling = callingDoctors.has(SHARED_LANE);
    if (row.status === "waiting") {
      if (row.id !== sharedHead?.id) {
        return <span className="text-[11px] brand-text-muted font-semibold italic px-1">Waiting for turn</span>;
      }
      return (
        <>
          <select
            aria-label={`Doctor for ${row.queue_number}`}
            value={callDoctor}
            onChange={(event) => setSelectedDoctor(event.target.value)}
            disabled={calling || !availableDoctors.length}
            className="px-2 py-1.5 border brand-input rounded-lg text-xs bg-white"
          >
            {availableDoctors.length
              ? availableDoctors.map((name) => <option key={name} value={name}>{name}</option>)
              : <option value="">No doctor available</option>}
          </select>
          <button
            type="button"
            onClick={() => handleSharedCall(row)}
            disabled={calling || !callDoctor}
            title={callDoctor ? `Call this patient to ${callDoctor}` : "Every doctor is offline or serving a patient"}
            aria-busy={calling}
            className="px-3 py-1.5 brand-button rounded-lg text-xs font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {calling ? "Calling..." : "Call Now"}
          </button>
          <button
            type="button"
            onClick={() => handleSharedCancel(row)}
            disabled={calling}
            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors shadow-sm"
          >
            Cancel
          </button>
        </>
      );
    }
    if (["cancelled", "no-show"].includes(row.status)) {
      return (
        <>
          <button
            type="button"
            onClick={() => runAction(SHARED_LANE, "/queue/undo", { patient_id: row.id }, "Action undone successfully")}
            className="px-3 py-1.5 bg-gray-600 text-white rounded-lg text-xs font-bold hover:bg-gray-700 transition-colors shadow-sm"
          >
            Undo
          </button>
          {queueSettings.allowQueueReassignment !== false ? (
            <button
              type="button"
              onClick={() => handleRequeue(row, SHARED_LANE)}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors shadow-sm"
            >
              Re-queue
            </button>
          ) : null}
        </>
      );
    }
    return <span className="brand-text-muted text-xs">—</span>;
  }

  async function handleCall(row, doctorName) {
    if (pendingCallsRef.current.has(doctorName)) return;
    if (row.status !== "waiting") {
      onNotify("error", "Only waiting patients can be called.");
      return;
    }
    if (!isHead(row, doctorName)) {
      onNotify("error", `You can only call the first patient in ${doctorName}'s queue.`);
      return;
    }
    if (!doctorStates[doctorName].online) {
      onNotify("error", `${doctorName} is marked offline in System Settings. Ask Super Admin to enable availability.`);
      return;
    }
    const counter = (counters ?? []).find((item) => item.id_num === doctorName);
    if (counter?.current_patient_id != null && counter.current_patient_id !== row.id) {
      onNotify("error", `${doctorName} is already assigned to another patient.`);
      return;
    }

    // The ref closes the interval before React renders the disabled button.
    pendingCallsRef.current.add(doctorName);
    setCallingDoctors(new Set(pendingCallsRef.current));
    try {
      await postAction(
        doctorName,
        "/queue/call",
        { patient_id: row.id, counterId: doctorName },
        "Patient called successfully"
      );
    } catch (err) {
      onNotify("error", `${doctorName}: ${err.message || "Action failed"}`);
      // Refresh stale priority/availability information after a rejected call.
      try { await onRefresh(); } catch (_) { /* Keep the call error visible. */ }
    } finally {
      pendingCallsRef.current.delete(doctorName);
      setCallingDoctors(new Set(pendingCallsRef.current));
    }
  }

  function handleCancel(row, doctorName) {
    if (pendingCallsRef.current.has(doctorName)) return;
    if (!isHead(row, doctorName)) {
      onNotify("error", `You can only cancel the first patient in ${doctorName}'s queue.`);
      return;
    }
    onConfirm({
      title: "Cancel Patient",
      message: `Cancel ${row.id_num} (${row.queue_number}) from ${doctorName}'s queue? Please enter a reason for canceling.`,
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

  function handleUndo(row, doctorName) {
    runAction(doctorName, "/queue/undo", { patient_id: row.id }, "Action undone successfully");
  }

  function handleRequeue(row, doctorName) {
    if (queueSettings.allowQueueReassignment === false) {
      onNotify("error", "Queue reassignment is disabled in System Settings.");
      return;
    }
    onConfirm({
      title: "Re-queue Patient",
      message: `Re-queue ${row.id_num} (${row.queue_number}) at the bottom of the list?`,
      showReason: true,
      requireReason: false,
      onConfirm: (reason) =>
        postAction(doctorName, "/queue/requeue", { patient_id: row.id, reason }, "Patient re-queued")
    });
  }

  function renderActions(row, doctorName) {
    if (doctorName == null) return renderSharedActions(row);
    const calling = callingDoctors.has(doctorName);
    if (row.status === "waiting") {
      if (!isHead(row, doctorName)) {
        const serving = doctorStates[doctorName].serving;
        return <span className="text-[11px] brand-text-muted font-semibold italic px-1">
          {serving ? `Serving ${serving.queue_number}` : "Waiting for turn"}
        </span>;
      }
      return (
        <>
          <button
            type="button"
            onClick={() => handleCall(row, doctorName)}
            disabled={calling || !doctorStates[doctorName].online || (counters ?? []).some((counter) => counter.id_num === doctorName && counter.current_patient_id != null && counter.current_patient_id !== row.id)}
            title={doctorStates[doctorName].callBlockedReason || "Call this patient"}
            aria-busy={calling}
            className="px-3 py-1.5 brand-button rounded-lg text-xs font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {calling ? "Calling..." : "Call Now"}
          </button>
          <button
            type="button"
            onClick={() => handleCancel(row, doctorName)}
            disabled={calling}
            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors shadow-sm"
          >
            Cancel
          </button>
        </>
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
            disabled={calling}
            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors shadow-sm"
          >
            Cancel
          </button>
        </>
      );
    }

    if (["cancelled", "no-show"].includes(row.status) && doctorStates[doctorName].undoableIds.has(row.id)) {
      return (
        <>
          <button
            type="button"
            onClick={() => handleUndo(row, doctorName)}
            className="px-3 py-1.5 bg-gray-600 text-white rounded-lg text-xs font-bold hover:bg-gray-700 transition-colors shadow-sm"
          >
            Undo
          </button>
          {queueSettings.allowQueueReassignment !== false ? (
            <button
              type="button"
              onClick={() => handleRequeue(row, doctorName)}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors shadow-sm"
            >
              Re-queue
            </button>
          ) : null}
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
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">Waiting {counts.waiting}</span>
          <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700">Serving {counts.serving}</span>
          <span className="px-2.5 py-1 rounded-full bg-green-50 text-green-700">Completed {counts.completed}</span>
          <span className="px-2.5 py-1 rounded-full bg-gray-200 brand-text">Cancelled {counts.cancelled}</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left table-fixed min-w-[700px]">
          <colgroup>
            {COLUMN_WIDTHS.map((width, idx) => (
              <col key={idx} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr className="brand-bg-subtle">
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Queue</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Patient</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Doctor</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider">Service</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider text-center">Priority</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider text-center">Status</th>
              <th className="px-4 py-4 text-xs font-bold brand-text-muted uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan="7" className="px-4 py-10 text-center brand-text-muted">
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
                    {row.created_at && (
                      <div className="text-[10px] brand-text-muted mt-1">Registered {new Date(row.created_at).toLocaleDateString()}</div>
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
                          {new Date(row.birthdate).toLocaleDateString()}
                        </span>
                      )}
                      {row.mobile_number && (
                        <span className="text-[10px] brand-text-muted">
                          <i className="fas fa-phone-alt me-1" /> {row.mobile_number}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2 font-semibold brand-text text-sm whitespace-nowrap">
                      <i className="fas fa-user-md text-blue-600" />
                      {doctorName ?? (row.status === "waiting" ? "Next available" : "Unassigned")}
                    </div>
                    {doctorName != null && !doctorStates[doctorName].online ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider brand-text-muted">Offline</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-4">
                    <span className="px-2.5 py-1 bg-blue-50 text-blue-700 rounded-md text-xs font-bold uppercase tracking-wider">
                      {row.service_type}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    {(row.priority_score || 0) >= 3 ? (
                      <span className="inline-flex items-center gap-1 text-yellow-700 bg-yellow-100 text-xs font-bold px-2 py-0.5 rounded-full">
                        <i className="fas fa-star" /> {row.priority_score}
                      </span>
                    ) : (row.priority_score || 0) > 0 ? (
                      <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-100 text-xs font-bold px-2 py-0.5 rounded-full">
                        <i className="fas fa-star" /> {row.priority_score}
                      </span>
                    ) : (
                      <span className="brand-text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                        row.status === "serving" ? "bg-emerald-100 text-emerald-700" :
                        row.status === "waiting" ? "bg-amber-100 text-amber-700" :
                        row.status === "no-show" ? "bg-red-100 text-red-700" :
                        row.status === "cancelled" ? "bg-gray-200 brand-text" :
                        row.status === "completed" ? "bg-green-50 text-green-700" :
                        "bg-gray-100 brand-text-muted"
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
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
