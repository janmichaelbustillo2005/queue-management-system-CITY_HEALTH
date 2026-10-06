import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import SiteFrame from "../components/SiteFrame";
import { request } from "../lib/api";
import { defaultQueueSettings } from "./SettingsModal";
import { fetchQueueSettings, loadLocalQueueSettings, mergeQueueSettings } from "../lib/queueSettings";

const iconButtonClass =
  "inline-flex items-center justify-center w-8 h-8 text-white rounded-lg text-sm transition-colors shadow-sm";

export default function DoctorAdminPage({ doctorId, doctorName }) {
  const { user } = useAuth();
  const [queueRows, setQueueRows] = useState([]);
  const [counters, setCounters] = useState([]);
  const [queueSettings, setQueueSettings] = useState(defaultQueueSettings);
  const [stats, setStats] = useState({ waiting: 0, serving: 0, completed: 0, total_patients: 0 });
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [loading, setLoading] = useState(false);
  // Modal state
  const [modal, setModal] = useState({
    isOpen: false,
    title: "",
    message: "",
    showReason: false,
    requireReason: false,
    reason: "",
    submitting: false,
    error: ""
  });
  const modalReasonRef = useRef("");
  const modalConfirmRef = useRef(null);
  const [cancelAccountModal, setCancelAccountModal] = useState({
    isOpen: false,
    reason: "",
    submitting: false,
    error: "",
    success: ""
  });
  const [pendingCancelRequest, setPendingCancelRequest] = useState(null);

  async function handleUndo(patientId) {
    try {
      const data = await request("/queue/undo", { 
        method: "POST", 
        body: JSON.stringify({ patient_id: patientId }) 
      });
      if (data?.error) {
        throw new Error(data.error);
      }
      refreshAll();
    } catch (err) {
      alert(err.message);
    }
  }

  // Helper to show confirmation modal (reason via ref so Confirm never reads a stale empty value)
  const showConfirmModal = ({ title, message, showReason = false, requireReason = false, onConfirm }) => {
    modalReasonRef.current = "";
    modalConfirmRef.current = onConfirm;
    setModal({
      isOpen: true,
      title,
      message,
      showReason,
      requireReason,
      reason: "",
      submitting: false,
      error: ""
    });
  };

  async function handleModalConfirm() {
    if (modal.submitting) return;

    const reason = String(modalReasonRef.current || "").trim();
    if (modal.requireReason && !reason) {
      setModal((prev) => ({
        ...prev,
        error: "Please provide a reason for canceling the patient."
      }));
      return;
    }

    setModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      await modalConfirmRef.current?.(reason);
      setModal({
        isOpen: false,
        title: "",
        message: "",
        showReason: false,
        requireReason: false,
        reason: "",
        submitting: false,
        error: ""
      });
      modalReasonRef.current = "";
      modalConfirmRef.current = null;
    } catch (err) {
      setModal((prev) => ({
        ...prev,
        submitting: false,
        error: err.message || "Action failed"
      }));
    }
  }

  function handleModalCancel() {
    if (modal.submitting) return;
    setModal({
      isOpen: false,
      title: "",
      message: "",
      showReason: false,
      requireReason: false,
      reason: "",
      submitting: false,
      error: ""
    });
    modalReasonRef.current = "";
    modalConfirmRef.current = null;
  }

  const sidebarLinks = useMemo(() => {
    if (user?.role === "superadmin") {
      return [
        { href: "/", icon: "fas fa-tachometer-alt", label: "Dashboard" },
        { href: "/analytics", icon: "fas fa-chart-bar", label: "Analytics" },
        { href: "/records", icon: "fas fa-history", label: "Records" }
      ];
    }

    return [
      {
        type: "button",
        icon: "fas fa-user-times",
        label: pendingCancelRequest ? "Cancel Request Pending" : "Cancel Account",
        active: false,
        onClick: () => {
          setCancelAccountModal({
            isOpen: true,
            reason: "",
            submitting: false,
            error: "",
            success: pendingCancelRequest
              ? "You already have a pending cancellation request awaiting Super Admin review."
              : ""
          });
        }
      }
    ];
  }, [user, pendingCancelRequest]);

  async function fetchMyCancellationRequest() {
    if (!user || user.role === "superadmin") {
      setPendingCancelRequest(null);
      return;
    }
    try {
      const data = await request("/account-cancellation-requests/mine");
      if (data.success) {
        setPendingCancelRequest(data.request || null);
      }
    } catch (err) {
      console.error("Failed to load cancellation request:", err);
    }
  }

  async function submitAccountCancellation() {
    const reason = String(cancelAccountModal.reason || "").trim();
    if (!reason) {
      setCancelAccountModal((prev) => ({
        ...prev,
        error: "Please provide a reason for cancel before submitting."
      }));
      return;
    }

    setCancelAccountModal((prev) => ({ ...prev, submitting: true, error: "", success: "" }));
    try {
      const data = await request("/account-cancellation-requests", {
        method: "POST",
        body: JSON.stringify({ reason })
      });

      if (data.error || !data.success) {
        setCancelAccountModal((prev) => ({
          ...prev,
          submitting: false,
          error: data.error || data.message || "Failed to submit cancellation request"
        }));
        return;
      }

      setPendingCancelRequest(data.request || null);
      setCancelAccountModal({
        isOpen: true,
        reason: "",
        submitting: false,
        error: "",
        success: data.message || "Cancellation request submitted to Super Admin."
      });
    } catch (err) {
      setCancelAccountModal((prev) => ({
        ...prev,
        submitting: false,
        error: err.message || "Failed to submit cancellation request"
      }));
    }
  }

  const currentCounter = useMemo(() => 
    (counters ?? []).find(c => c.name === doctorName), 
  [counters, doctorName]);

  // Helper to match services to doctors based on categories
  const matchesDoctor = (serviceType, doctorNameParam) => {
    if (!serviceType || !doctorNameParam) return false;

    // Direct mapping: which doctor handles which services
    const serviceToDoctor = {
      consultation: "Doctor 1",
      checkup: "Doctor 1",
      laboratory: "Doctor 1",
      dental: "Doctor 1",
      prenatal: "Doctor 2",
      maternity: "Doctor 2",
      obgyne: "Doctor 2",
      family_planning: "Doctor 3"
    };

    return serviceToDoctor[serviceType] === doctorNameParam;
  };

  const doctorQueue = useMemo(() => {
    if (!Array.isArray(queueRows)) return [];
    
    return queueRows.filter(row => {
      // Patients only reach the doctor once Front Desk Patient Management calls them
      if (row.status === "waiting" || !row.called_at) return false;

      // Show if the patient is already being served by THIS doctor
      if (row.counter_id === doctorName) return true;

      // Show recent cancellations for this doctor's services (Undo window)
      if (row.status === "cancelled" && matchesDoctor(row.service_type, doctorName)) return true;
      
      return false;
    });
  }, [queueRows, doctorName]);

  const filteredRows = useMemo(() => {
    const queue = doctorQueue ?? [];
    // After the doctor Calls the next patient, hide prior cancellations from the active list.
    // Status/reason stay in the DB for Super Admin records.
    const hasActiveServing = queue.some(
      (row) => row.status === "serving" && row.counter_id === doctorName
    );

    const rows = queue.filter((row) => {
      if (row.status === "completed") return false;
      if (row.status === "cancelled") {
        return !hasActiveServing;
      }
      return true;
    });

    return rows
      .slice()
      .sort((a, b) => {
        // Keep cancelled (Undo) below the active waiting/serving patients
        const rank = (status) => {
          if (status === "serving") return 0;
          if (status === "waiting") return 1;
          if (status === "cancelled") return 2;
          return 3;
        };
        const rankDiff = rank(a.status) - rank(b.status);
        if (rankDiff !== 0) return rankDiff;

        // FRD-02: Sort by priority score DESC, then by check-in time ASC
        if ((b.priority_score || 0) !== (a.priority_score || 0)) {
          return (b.priority_score || 0) - (a.priority_score || 0);
        }
        return new Date(a.created_at) - new Date(b.created_at);
      })
      .slice(0, 20);
  }, [doctorQueue, doctorName]);

  // Only the head of the unfinished queue (serving first, else first waiting) may be acted on
  const activePatientId = useMemo(() => {
    const serving = filteredRows.find((row) => row.status === "serving");
    if (serving) return serving.id;
    const nextWaiting = filteredRows.find((row) => row.status === "waiting");
    return nextWaiting?.id ?? null;
  }, [filteredRows]);

  const canProcessPatient = (row) => row?.id != null && row.id === activePatientId;

  const doctorIsOnline = useMemo(() => {
    const counter = counters.find((c) => c.id_num === doctorName);
    if (counter) return counter.is_online !== false;
    if (doctorName === "Doctor 1") return queueSettings.doctor1Online !== false;
    if (doctorName === "Doctor 2") return queueSettings.doctor2Online !== false;
    if (doctorName === "Doctor 3") return queueSettings.doctor3Online !== false;
    return true;
  }, [counters, doctorName, queueSettings]);

  useEffect(() => {
    setQueueSettings(loadLocalQueueSettings());
    fetchQueueSettings().then(setQueueSettings).catch(() => {});
    refreshAll();
  }, []);
  useEffect(() => { fetchMyCancellationRequest(); }, [user]);

  useEffect(() => {
    const intervalSec = Number(queueSettings.refreshInterval) || 5;
    const timer = setInterval(refreshAll, Math.max(2, intervalSec) * 1000);
    return () => clearInterval(timer);
  }, [queueSettings.refreshInterval]);

  async function refreshAll() {
    try {
      setLoading(true);
      const data = await request("/queue");
      
      if (data.error) {
        setError(data.error);
        setQueueRows([]);
        setCounters([]);
        setStats({ waiting: 0, serving: 0, completed: 0, total_patients: 0 });
        setLoading(false);
        return;
      }
      
      setQueueRows(data.patients ?? []);
      setCounters(data.counters ?? []);
      if (data.queue_settings) {
        setQueueSettings(mergeQueueSettings(data.queue_settings));
      }
      
      // Calculate specific stats for this doctor
    const patients = data.patients ?? [];
    
    const myServed = patients.filter(q => q.counter_id === doctorName);
    const matchingWaiting = patients.filter(q => 
      q.status === "waiting" && matchesDoctor(q.service_type, doctorName)
    );

      setStats({
        waiting: matchingWaiting.length,
        serving: myServed.filter(q => q.status === "serving").length,
        completed: myServed.filter(q => q.status === "completed").length,
        total_patients: myServed.length
      });
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAccept(patientId) {
    if (Number(patientId) !== Number(activePatientId)) {
      setError("You can only accept the patient currently being processed.");
      window.setTimeout(() => setError(""), 4000);
      return;
    }
    try {
      setError("");
      const data = await request("/queue/accept", {
        method: "POST",
        body: JSON.stringify({ patient_id: patientId })
      });
      if (data?.error) {
        throw new Error(data.error);
      }
      setSuccessMessage(data.message || "Patient accepted");
      window.setTimeout(() => setSuccessMessage(""), 4000);
      await refreshAll();
    } catch (err) {
      setError(err.message || "Failed to accept patient");
      window.setTimeout(() => setError(""), 5000);
    }
  }

  async function handleComplete(patientId) {
    if (Number(patientId) !== Number(activePatientId)) {
      setError("You can only complete the patient currently being processed.");
      window.setTimeout(() => setError(""), 4000);
      return;
    }
    try {
      setError("");
      const data = await request("/queue/complete", { 
        method: "POST", 
        body: JSON.stringify({ patient_id: patientId }) 
      });
      if (data?.error) {
        throw new Error(data.error);
      }
      setSuccessMessage(data.message || "Patient completed successfully");
      window.setTimeout(() => setSuccessMessage(""), 4000);
      await refreshAll();
    } catch (err) {
      setError(err.message || "Failed to complete patient");
      window.setTimeout(() => setError(""), 5000);
    }
  }

  async function handleCancel(patientId) {
    if (Number(patientId) !== Number(activePatientId)) {
      setError("You can only cancel the first patient in your queue.");
      window.setTimeout(() => setError(""), 4000);
      return;
    }
    showConfirmModal({
      title: "Cancel Patient",
      message: "Cancel this patient from the queue? Please enter a reason for canceling.",
      showReason: true,
      requireReason: true,
      onConfirm: async (reason) => {
        const data = await request("/queue/cancel", {
          method: "POST",
          body: JSON.stringify({
            patient_id: patientId,
            reason,
            counter_id: doctorName
          })
        });
        if (data?.error) {
          throw new Error(data.error);
        }
        setSuccessMessage(data.message || "Patient cancelled successfully");
        window.setTimeout(() => setSuccessMessage(""), 4000);
        await refreshAll();
      }
    });
  }

  async function handleRequeue(patientId) {
    if (queueSettings.allowQueueReassignment === false) {
      setError("Queue reassignment is disabled in System Settings.");
      window.setTimeout(() => setError(""), 4000);
      return;
    }
    showConfirmModal({
      title: "Re-queue Patient",
      message: "Re-queue this patient at the bottom of the list?",
      showReason: true,
      requireReason: false,
      onConfirm: async (reason) => {
        const data = await request("/queue/requeue", {
          method: "POST",
          body: JSON.stringify({ patient_id: patientId, reason })
        });
        if (data?.error) {
          throw new Error(data.error);
        }
        setSuccessMessage(data.message || "Patient re-queued");
        window.setTimeout(() => setSuccessMessage(""), 4000);
        await refreshAll();
      }
    });
  }

  return (
    <SiteFrame
      title={doctorName}
      icon="fas fa-user-md"
      showSidebar={true}
      sidebarLinks={sidebarLinks}
    >
      <div className="admin-content p-4 md:p-6">
        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}
        {successMessage ? (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {successMessage}
          </div>
        ) : null}
        {!doctorIsOnline ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This doctor counter is offline in System Settings. Calls are blocked until Super Admin enables availability.
          </div>
        ) : null}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          <div className="stat-card bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600 text-xl">
              <i className="fas fa-user-md" />
            </div>
            <div>
              <div className="text-sm font-bold text-gray-800">
                {doctorName === "Doctor 1" ? "Consultation, Check-up" : 
                 doctorName === "Doctor 2" ? "Prenatal, Maternity" : 
                 doctorName === "Doctor 3" ? "Family Planning" : "No assignments"}
              </div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">My Assignments</div>
            </div>
          </div>
          <div className="stat-card bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600 text-xl">
              <i className="fas fa-clock" />
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-800">{stats.waiting}</div>
              <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Matching Waiting</div>
            </div>
          </div>
          <div className="stat-card bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
            <div className="w-12 h-12 bg-emerald-50 rounded-lg flex items-center justify-center text-emerald-600 text-xl">
              <i className="fas fa-user-check" />
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-800">{stats.serving}</div>
              <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold">My Serving</div>
            </div>
          </div>
          <div className="stat-card bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
            <div className="w-12 h-12 bg-green-50 rounded-lg flex items-center justify-center text-green-600 text-xl">
              <i className="fas fa-check-circle" />
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-800">{stats.completed}</div>
              <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold">My Completed</div>
            </div>
          </div>
          <div className="stat-card bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
            <div className="w-12 h-12 bg-amber-50 rounded-lg flex items-center justify-center text-amber-600 text-xl">
              <i className="fas fa-calendar-day" />
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-800">{stats.total_patients}</div>
              <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Total Patients</div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="p-4 border-b border-gray-50 bg-gray-50/50 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <i className="fas fa-tasks text-emerald-600" />
              <h2 className="font-bold text-gray-800">My Queue Management</h2>
            </div>
            <div className="flex gap-2">
              <a 
                href="/queue-display" 
                target="_blank"
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 no-underline"
              >
                <i className="fas fa-external-link-alt" />
                Live View
              </a>
              <button 
                onClick={refreshAll}
                className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors flex items-center gap-2"
              >
                <i className={`fas fa-sync-alt ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-gray-50/50">
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Queue</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Patient</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Service</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center">Priority</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center">Status</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="px-6 py-12 text-center text-gray-400">
                      <i className="fas fa-inbox text-4xl mb-3 block" />
                      No patients in your queue
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <span className="font-mono font-bold text-emerald-600 text-lg">{row.queue_number}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-800">{row.id_num}</div>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {row.sex && (
                            <span className="text-[10px] bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                              {row.sex}
                            </span>
                          )}
                          {row.birthdate && (
                            <span className="text-[10px] text-gray-500">
                              <i className="fas fa-birthday-cake me-1" />
                              {new Date(row.birthdate).toLocaleDateString()}
                            </span>
                          )}
                          <div className="text-[10px] text-gray-500">
                            <i className="fas fa-phone-alt me-1" /> {row.mobile_number}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="px-2.5 py-1 bg-blue-50 text-blue-700 rounded-md text-xs font-bold uppercase tracking-wider">
                          {row.service_type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {(row.priority_score || 0) >= 3 ? (
                          <span className="inline-flex items-center gap-1 text-yellow-700 bg-yellow-100 text-xs font-bold px-2 py-0.5 rounded-full">
                            <i className="fas fa-star" /> {row.priority_score}
                          </span>
                        ) : (row.priority_score || 0) > 0 ? (
                          <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-100 text-xs font-bold px-2 py-0.5 rounded-full">
                            <i className="fas fa-star" /> {row.priority_score}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                          row.status === "serving" ? "bg-emerald-100 text-emerald-700" :
                          row.status === "waiting" ? "bg-amber-100 text-amber-700" :
                          row.status === "no-show" ? "bg-red-100 text-red-700" :
                          row.status === "cancelled" ? "bg-gray-200 text-gray-700" :
                          "bg-gray-100 text-gray-600"
                        }`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          {row.status === "serving" && canProcessPatient(row) && row.awaiting_accept && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleAccept(row.id)}
                                title="Accept patient"
                                aria-label="Accept patient"
                                className={`${iconButtonClass} bg-emerald-600 hover:bg-emerald-700 ring-2 ring-emerald-300 animate-pulse`}
                              >
                                <i className="fas fa-user-check" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCancel(row.id)}
                                title="Cancel"
                                aria-label="Cancel"
                                className={`${iconButtonClass} bg-red-600 hover:bg-red-700`}
                              >
                                <i className="fas fa-times" />
                              </button>
                            </>
                          )}
                          {row.status === "serving" && canProcessPatient(row) && !row.awaiting_accept && (
                            <>
                              <button 
                                type="button"
                                onClick={() => handleComplete(row.id)}
                                title="Complete"
                                aria-label="Complete"
                                className={`${iconButtonClass} bg-blue-600 hover:bg-blue-700`}
                              >
                                <i className="fas fa-check" />
                              </button>
                              <button 
                                type="button"
                                onClick={() => handleCancel(row.id)}
                                title="Cancel"
                                aria-label="Cancel"
                                className={`${iconButtonClass} bg-red-600 hover:bg-red-700`}
                              >
                                <i className="fas fa-times" />
                              </button>
                            </>
                          )}
                          {(row.status === "no-show" || row.status === "cancelled") && (
                            <>
                              <button 
                                type="button"
                                onClick={() => handleUndo(row.id)}
                                title="Undo"
                                aria-label="Undo"
                                className={`${iconButtonClass} bg-gray-600 hover:bg-gray-700`}
                              >
                                <i className="fas fa-undo" />
                              </button>
                              {queueSettings.allowQueueReassignment !== false ? (
                                <button
                                  type="button"
                                  onClick={() => handleRequeue(row.id)}
                                  title="Re-queue"
                                  aria-label="Re-queue"
                                  className={`${iconButtonClass} bg-indigo-600 hover:bg-indigo-700`}
                                >
                                  <i className="fas fa-redo" />
                                </button>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      
      {/* Custom Modal */}
      {modal.isOpen && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 9999
        }}>
          <div style={{
            backgroundColor: "white",
            padding: "2rem",
            borderRadius: "1rem",
            boxShadow: "0 10px 25px rgba(0, 0, 0, 0.2)",
            maxWidth: "500px",
            width: "90%"
          }}>
            <h3 style={{
              fontSize: "1.25rem",
              fontWeight: "bold",
              marginBottom: "1rem",
              color: "#1f2937"
            }}>
              {modal.title}
            </h3>
            <p style={{
              color: "#4b5563",
              marginBottom: "1rem"
            }}>
              {modal.message}
            </p>
            {modal.error ? (
              <div style={{
                marginBottom: "1rem",
                padding: "0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid #fecaca",
                backgroundColor: "#fef2f2",
                color: "#b91c1c",
                fontSize: "0.875rem"
              }}>
                {modal.error}
              </div>
            ) : null}
            {modal.showReason && (
              <div style={{ marginBottom: "1.5rem" }}>
                <label style={{
                  display: "block",
                  marginBottom: "0.5rem",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  color: "#374151"
                }}>
                  {modal.requireReason ? "Reason for Cancel" : "Reason (optional)"}
                </label>
                <textarea
                  value={modal.reason}
                  disabled={modal.submitting}
                  onChange={(e) => {
                    modalReasonRef.current = e.target.value;
                    setModal((prev) => ({ ...prev, reason: e.target.value, error: "" }));
                  }}
                  placeholder="Enter reason..."
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    border: "1px solid #d1d5db",
                    borderRadius: "0.5rem",
                    resize: "vertical",
                    minHeight: "100px",
                    fontSize: "0.875rem"
                  }}
                />
              </div>
            )}
            <div style={{
              display: "flex",
              gap: "1rem",
              justifyContent: "flex-end"
            }}>
              <button
                type="button"
                onClick={handleModalCancel}
                disabled={modal.submitting}
                style={{
                  padding: "0.5rem 1.5rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "0.5rem",
                  backgroundColor: "white",
                  color: "#374151",
                  cursor: modal.submitting ? "not-allowed" : "pointer",
                  fontWeight: 500,
                  opacity: modal.submitting ? 0.6 : 1
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleModalConfirm}
                disabled={modal.submitting}
                style={{
                  padding: "0.5rem 1.5rem",
                  border: "none",
                  borderRadius: "0.5rem",
                  backgroundColor: "#166534",
                  color: "white",
                  cursor: modal.submitting ? "not-allowed" : "pointer",
                  fontWeight: 500,
                  opacity: modal.submitting ? 0.6 : 1
                }}
              >
                {modal.submitting ? "Confirming..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Doctor Account Cancellation Request Modal */}
      {cancelAccountModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 z-[10000] flex items-center justify-center px-3">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="csu-gradient-bar text-white px-5 py-4">
              <h3 className="text-lg font-bold flex items-center gap-2 m-0">
                <i className="fas fa-user-times" />
                Cancel Account Request
              </h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600 m-0">
                Submit a cancellation request for your doctor account. Your account will stay active until a Super Admin reviews and approves this request.
              </p>

              {pendingCancelRequest && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <strong>Pending request:</strong> submitted{" "}
                  {new Date(pendingCancelRequest.requested_at).toLocaleString()}
                </div>
              )}

              {cancelAccountModal.error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {cancelAccountModal.error}
                </div>
              ) : null}

              {cancelAccountModal.success ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  {cancelAccountModal.success}
                </div>
              ) : null}

              {!pendingCancelRequest && !cancelAccountModal.success ? (
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Reason for Cancel <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={cancelAccountModal.reason}
                    onChange={(e) =>
                      setCancelAccountModal((prev) => ({
                        ...prev,
                        reason: e.target.value,
                        error: ""
                      }))
                    }
                    placeholder="Explain why you want to cancel this doctor account..."
                    rows={5}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none resize-y"
                    disabled={cancelAccountModal.submitting}
                  />
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    setCancelAccountModal({
                      isOpen: false,
                      reason: "",
                      submitting: false,
                      error: "",
                      success: ""
                    })
                  }
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50"
                  disabled={cancelAccountModal.submitting}
                >
                  Close
                </button>
                {!pendingCancelRequest && !cancelAccountModal.success ? (
                  <button
                    type="button"
                    onClick={submitAccountCancellation}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700 disabled:opacity-60"
                    disabled={cancelAccountModal.submitting}
                  >
                    {cancelAccountModal.submitting ? "Submitting..." : "Submit"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </SiteFrame>
  );
}
