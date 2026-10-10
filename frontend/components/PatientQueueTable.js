import { useMemo } from "react";
import { request } from "../lib/api";

export const DOCTORS = [
  { name: "Doctor 1", assignment: "Consultation, Check-up" },
  { name: "Doctor 2", assignment: "Prenatal, Maternity" },
  { name: "Doctor 3", assignment: "Family Planning" }
];

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

function belongsToDoctor(row, doctorName) {
  return row.counter_id ? row.counter_id === doctorName : matchesDoctor(row.service_type, doctorName);
}

function compareQueue(a, b) {
  const rankDiff = (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4);
  if (rankDiff !== 0) return rankDiff;
  // FRD-02: Sort by priority score DESC, then by check-in time ASC
  if ((b.priority_score || 0) !== (a.priority_score || 0)) {
    return (b.priority_score || 0) - (a.priority_score || 0);
  }
  return new Date(a.created_at) - new Date(b.created_at);
}

// Same rules as the Doctor "My Queue Management" list: waiting/serving patients plus
// cancellations still inside the Undo window (hidden once the doctor calls the next patient).
function buildActiveQueue(queueRows, doctorName) {
  const queue = (queueRows ?? []).filter((row) => {
    if (row.status === "completed") return false;
    if (row.counter_id === doctorName) return true;
    if (row.status === "waiting" && matchesDoctor(row.service_type, doctorName)) return true;
    if (row.status === "cancelled" && matchesDoctor(row.service_type, doctorName)) return true;
    return false;
  });

  const hasActiveServing = queue.some((row) => row.status === "serving" && row.counter_id === doctorName);

  const rows = queue.filter((row) => {
    if (row.status === "cancelled") return !hasActiveServing;
    return true;
  });

  return rows.slice().sort(compareQueue).slice(0, 20);
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
  onConfirm
}) {
  const doctorStates = useMemo(() => {
    const states = {};
    for (const doctor of doctors) {
      const activeRows = buildActiveQueue(queueRows, doctor.name);
      const serving = activeRows.find((row) => row.status === "serving");
      states[doctor.name] = {
        activeRows,
        // Only the head of each doctor's queue (serving first, else first waiting) may be acted on
        activePatientId: serving?.id ?? activeRows.find((row) => row.status === "waiting")?.id ?? null,
        undoableIds: new Set(
          activeRows.filter((row) => ["cancelled", "no-show"].includes(row.status)).map((row) => row.id)
        ),
        online: isDoctorOnline(counters, queueSettings, doctor.name)
      };
    }
    return states;
  }, [doctors, queueRows, counters, queueSettings]);

  const visibleRows = useMemo(() => {
    const byId = new Map();
    for (const doctor of doctors) {
      const source =
        statusFilter === "active"
          ? doctorStates[doctor.name].activeRows
          : (queueRows ?? []).filter((row) => row.status === statusFilter && belongsToDoctor(row, doctor.name));

      for (const row of source) {
        const existing = byId.get(row.id);
        // A row can match two doctors (service vs. counter); the counter assignment wins
        if (!existing || (existing.doctorName !== row.counter_id && row.counter_id === doctor.name)) {
          byId.set(row.id, { row, doctorName: doctor.name });
        }
      }
    }

    const term = search.trim().toLowerCase();
    const doctorOrder = doctors.map((d) => d.name);
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
  }, [doctors, doctorStates, queueRows, statusFilter, search]);

  const counts = useMemo(() => {
    const rows = queueRows ?? [];
    const total = { waiting: 0, serving: 0, completed: 0, cancelled: 0 };
    for (const { name } of doctors) {
      total.waiting += rows.filter((row) => row.status === "waiting" && matchesDoctor(row.service_type, name)).length;
      total.serving += rows.filter((row) => row.status === "serving" && row.counter_id === name).length;
      total.completed += rows.filter((row) => row.status === "completed" && row.counter_id === name).length;
      total.cancelled += rows.filter((row) => row.status === "cancelled" && belongsToDoctor(row, name)).length;
    }
    return total;
  }, [doctors, queueRows]);

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

  function handleCall(row, doctorName) {
    if (!isHead(row, doctorName)) {
      onNotify("error", `You can only call the first patient in ${doctorName}'s queue.`);
      return;
    }
    if (!doctorStates[doctorName].online) {
      onNotify("error", `${doctorName} is marked offline in System Settings. Ask Super Admin to enable availability.`);
      return;
    }
    postAction(doctorName, "/queue/call", { patient_id: row.id, counterId: doctorName }, "Patient called successfully")
      .catch((err) => {
        onNotify("error", `${doctorName}: ${err.message || "Action failed"}`);
      });
  }

  function handleComplete(row, doctorName) {
    if (!isHead(row, doctorName)) {
      onNotify("error", `You can only complete the patient ${doctorName} is currently serving.`);
      return;
    }
    runAction(doctorName, "/queue/complete", { patient_id: row.id }, "Patient completed successfully");
  }

  function handleCancel(row, doctorName) {
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
    if (row.status === "waiting") {
      if (!isHead(row, doctorName)) {
        return <span className="text-[11px] brand-text-muted font-semibold italic px-1">Waiting for turn</span>;
      }
      return (
        <>
          <button
            type="button"
            onClick={() => handleCall(row, doctorName)}
            className="px-3 py-1.5 brand-button rounded-lg text-xs font-bold transition-colors"
          >
            Call Now
          </button>
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

    if (row.status === "serving" && isHead(row, doctorName)) {
      return (
        <>
          <button
            type="button"
            onClick={() => handleComplete(row, doctorName)}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-colors"
          >
            Complete
          </button>
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
                      {doctorName}
                    </div>
                    {!doctorStates[doctorName].online ? (
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
                    <div className="flex justify-end gap-2 flex-wrap">{renderActions(row, doctorName)}</div>
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
