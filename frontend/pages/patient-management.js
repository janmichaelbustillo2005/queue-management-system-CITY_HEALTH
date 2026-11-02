import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import SiteFrame from "../components/SiteFrame";
import PatientQueueTable, { DOCTORS, SHARED_ASSIGNMENT, SHARED_DISPATCH } from "../components/PatientQueueTable";
import QueueTicketDialog from "../components/QueueTicketDialog";
import { defaultQueueSettings } from "../components/SettingsModal";
import { useAuth } from "../context/AuthContext";
import { request } from "../lib/api";
import { createQueueTicket, fetchExistingQueueTicket } from "../lib/queueTicket";
import { fetchQueueSettings, loadLocalQueueSettings, mergeQueueSettings } from "../lib/queueSettings";

const STATUS_OPTIONS = [
  { value: "active", label: "Active Queue" },
  { value: "all", label: "All registered patients" },
  { value: "waiting", label: "Waiting" },
  { value: "serving", label: "Serving" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no-show", label: "No-show" }
];

const DOCTOR_ACCOUNTS = ["admin1", "admin2", "admin3"];

const closedModal = {
  isOpen: false,
  title: "",
  message: "",
  showReason: false,
  requireReason: false,
  reason: "",
  submitting: false,
  error: ""
};

export default function PatientManagementPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [queueRows, setQueueRows] = useState([]);
  const [counters, setCounters] = useState([]);
  // D1: "service" (fixed service doctors) or "shared" (one queue, doctor chosen at Call).
  const [dispatchMode, setDispatchMode] = useState("service");
  const [queueSettings, setQueueSettings] = useState(defaultQueueSettings);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState({ type: "", text: "" });
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(closedModal);
  const [queueTicket, setQueueTicket] = useState(null);
  const [ticketLoadingId, setTicketLoadingId] = useState(null);
  const ticketLoadingRef = useRef(null);
  const ticketPatientIdRef = useRef(null);
  const ticketRequestRef = useRef(0);
  const queueReadRef = useRef(0);
  const queueSettledRef = useRef(0);
  const modalReasonRef = useRef("");
  const modalConfirmRef = useRef(null);
  const noticeTimerRef = useRef(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/login");
    } else if (DOCTOR_ACCOUNTS.includes(user.id_num)) {
      router.replace(`/${user.id_num}`);
    }
  }, [user, authLoading, router]);

  const canView = !!user && !DOCTOR_ACCOUNTS.includes(user.id_num);
  const canIssueTicket = user?.id_num === "frontdesk" || user?.role === "superadmin";
  const canIssueTicketRef = useRef(canIssueTicket);
  canIssueTicketRef.current = canIssueTicket;

  useEffect(() => {
    if (!canIssueTicket) {
      ticketRequestRef.current += 1;
      ticketPatientIdRef.current = null;
      ticketLoadingRef.current = null;
      setQueueTicket(null);
      setTicketLoadingId(null);
    }
    return () => { ticketRequestRef.current += 1; };
  }, [canIssueTicket]);

  const refreshAll = useCallback(async () => {
    const queueReadVersion = ++queueReadRef.current;
    const ticketReadVersion = ticketRequestRef.current;
    setLoading(true);
    try {
      const data = await request("/queue");
      // Polling and manual refreshes can overlap. A delayed older response
      // cannot replace a newer completed read. Accept earlier completions
      // while a newer read is pending, so slow polling still updates the UI.
      if (queueReadVersion < queueSettledRef.current) return;
      queueSettledRef.current = queueReadVersion;
      if (data.error) {
        throw new Error(data.error);
      }
      const patients = data.patients ?? [];
      setQueueRows(patients);
      setCounters(data.counters ?? []);
      setDispatchMode(data.dispatch_mode === SHARED_DISPATCH ? SHARED_DISPATCH : "service");
      if (data.queue_settings) {
        setQueueSettings(mergeQueueSettings(data.queue_settings));
      }
      // Refresh only a pass opened before this read began. An older polling
      // response must not replace a ticket just retrieved from its saved record.
      if (ticketReadVersion === ticketRequestRef.current && ticketPatientIdRef.current != null) {
        const patient = patients.find((row) => String(row.id) === String(ticketPatientIdRef.current));
        if (patient) {
          setQueueTicket(createQueueTicket(patient, { dispatchMode: data.dispatch_mode }));
        } else {
          ticketPatientIdRef.current = null;
          setQueueTicket(null);
          setNotice({ type: "error", text: "This ticket is no longer available in the current queue. Refresh Patient Management before reopening it." });
        }
      }
    } catch (error) {
      if (queueReadVersion < queueSettledRef.current) return;
      queueSettledRef.current = queueReadVersion;
      if (ticketReadVersion === ticketRequestRef.current && ticketPatientIdRef.current != null) {
        ticketPatientIdRef.current = null;
        setQueueTicket(null);
      }
      setNotice({ type: "error", text: error.message || "Unable to refresh the queue. Reopen the ticket after the connection is restored." });
    } finally {
      if (queueReadVersion === queueReadRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    setQueueSettings(loadLocalQueueSettings());
    fetchQueueSettings().then(setQueueSettings).catch(() => {});
    refreshAll();
  }, [canView, refreshAll]);

  useEffect(() => {
    if (!canView) return undefined;
    const intervalSec = Number(queueSettings.refreshInterval) || 5;
    const timer = setInterval(refreshAll, Math.max(2, intervalSec) * 1000);
    return () => clearInterval(timer);
  }, [canView, queueSettings.refreshInterval, refreshAll]);

  useEffect(() => () => clearTimeout(noticeTimerRef.current), []);

  function notify(type, text) {
    clearTimeout(noticeTimerRef.current);
    setNotice({ type, text });
    noticeTimerRef.current = setTimeout(() => setNotice({ type: "", text: "" }), type === "error" ? 5000 : 4000);
  }

  async function handleViewTicket(row) {
    if (!canIssueTicketRef.current || row?.id == null || ticketLoadingRef.current != null) return;
    const requestVersion = ++ticketRequestRef.current;
    ticketLoadingRef.current = row.id;
    setTicketLoadingId(row.id);
    setNotice({ type: "", text: "" });
    try {
      // Recovery is an authenticated read of the existing registration. It
      // never submits registration, queue-number allocation, or queue actions.
      const ticket = await fetchExistingQueueTicket(row.id);
      if (requestVersion !== ticketRequestRef.current || !canIssueTicketRef.current) return;
      ticketPatientIdRef.current = ticket.patientId;
      setQueueTicket(ticket);
    } catch (error) {
      if (requestVersion === ticketRequestRef.current) {
        notify("error", error.message || "Unable to retrieve this ticket. Please refresh and try again.");
      }
    } finally {
      if (requestVersion === ticketRequestRef.current) {
        ticketLoadingRef.current = null;
        setTicketLoadingId(null);
      }
    }
  }

  function updateCurrentTicket(updated) {
    if (!canIssueTicketRef.current || ticketPatientIdRef.current == null ||
        String(updated?.patientId) !== String(ticketPatientIdRef.current)) return;
    // Delivery verifies the record again. Reads started before that verified
    // result cannot replace it with an older status when they arrive later.
    ticketRequestRef.current += 1;
    setQueueTicket(updated);
  }

  function closeTicket() {
    ticketRequestRef.current += 1;
    ticketPatientIdRef.current = null;
    ticketLoadingRef.current = null;
    setTicketLoadingId(null);
    setQueueTicket(null);
  }

  function showConfirmModal({ title, message, showReason = false, requireReason = false, onConfirm }) {
    modalReasonRef.current = "";
    modalConfirmRef.current = onConfirm;
    setModal({ ...closedModal, isOpen: true, title, message, showReason, requireReason });
  }

  function closeModal() {
    setModal(closedModal);
    modalReasonRef.current = "";
    modalConfirmRef.current = null;
  }

  async function handleModalConfirm() {
    if (modal.submitting) return;
    const reason = String(modalReasonRef.current || "").trim();
    if (modal.requireReason && !reason) {
      setModal((prev) => ({ ...prev, error: "Please provide a reason for canceling the patient." }));
      return;
    }
    setModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      await modalConfirmRef.current?.(reason);
      closeModal();
    } catch (err) {
      setModal((prev) => ({ ...prev, submitting: false, error: err.message || "Action failed" }));
    }
  }

  const visibleDoctors = doctorFilter === "all" ? DOCTORS : DOCTORS.filter((d) => d.name === doctorFilter);
  const hasFilters = doctorFilter !== "all" || statusFilter !== "active" || search.trim() !== "";

  if (!canView) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return (
    <SiteFrame
      title="Patient Management"
      icon="fas fa-hospital-user"
      contentClassName="frontdesk-page"
    >
      <div className="w-full max-w-7xl mx-auto px-3 md:px-6 py-4">
        {notice.text ? (
          <div
            role={notice.type === "error" ? "alert" : "status"}
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              notice.type === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {notice.text}
          </div>
        ) : null}

        <div className="bg-white rounded-2xl shadow-sm border brand-border p-4 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <i className="fas fa-tasks brand-text-primary" />
              <div>
                <h2 className="font-bold brand-text text-lg m-0">Patient Management</h2>
                <p className="text-xs brand-text-muted m-0">Manage all doctors' patients in one table. Changes sync with the doctor accounts.</p>
                {canIssueTicket ? <p className="text-xs brand-text-muted mt-1 mb-0">Lost ticket? Choose All registered patients to search today's registrations, then select View Ticket to photograph, download, or reprint the same queue number.</p> : null}
              </div>
            </div>
            <div className="flex gap-2">
              <a
                href="/queue-display"
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 no-underline"
              >
                <i className="fas fa-external-link-alt" />
                Live View
              </a>
              <button
                type="button"
                onClick={refreshAll}
                className="px-3 py-1.5 brand-button rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
              >
                <i className={`fas fa-sync-alt ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <label className="text-xs font-semibold brand-text-muted">
              Doctor
              <select
                className="mt-1 w-full px-3 py-2 border brand-input rounded-lg text-sm bg-white"
                value={doctorFilter}
                onChange={(e) => setDoctorFilter(e.target.value)}
              >
                <option value="all">All Doctors</option>
                {DOCTORS.map((d) => (
                  <option key={d.name} value={d.name}>{d.name} ({dispatchMode === SHARED_DISPATCH ? SHARED_ASSIGNMENT : d.assignment})</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold brand-text-muted">
              Status
              <select
                className="mt-1 w-full px-3 py-2 border brand-input rounded-lg text-sm bg-white"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold brand-text-muted">
              Search
              <input
                type="text"
                className="mt-1 w-full px-3 py-2 border brand-input rounded-lg text-sm"
                placeholder="Patient name or queue number"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setDoctorFilter("all");
                setStatusFilter("active");
                setSearch("");
              }}
              disabled={!hasFilters}
              className="px-3 py-2 border brand-border rounded-lg text-sm font-semibold brand-text brand-hover-subtle disabled:opacity-50"
            >
              <i className="fas fa-undo me-1" />
              Reset Filters
            </button>
          </div>
        </div>

        <PatientQueueTable
          doctors={visibleDoctors}
          queueRows={queueRows}
          counters={counters}
          queueSettings={queueSettings}
          statusFilter={statusFilter}
          search={search}
          onRefresh={refreshAll}
          onNotify={notify}
          onConfirm={showConfirmModal}
          onViewTicket={canIssueTicket ? handleViewTicket : undefined}
          ticketLoadingId={ticketLoadingId}
          dispatchMode={dispatchMode}
        />
      </div>

      {queueTicket && canIssueTicket ? (
        <QueueTicketDialog ticket={queueTicket} onClose={closeTicket} onTicketUpdate={updateCurrentTicket} />
      ) : null}

      {modal.isOpen && (
        <div className="fixed inset-0 bg-black/50 z-[10000] flex items-center justify-center px-3">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
            <h3 className="text-xl font-bold brand-text mb-3">{modal.title}</h3>
            <p className="brand-text-muted mb-4">{modal.message}</p>
            {modal.error ? (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {modal.error}
              </div>
            ) : null}
            {modal.showReason && (
              <div className="mb-5">
                <label className="block mb-2 text-sm font-medium brand-text">
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
                  className="w-full px-3 py-2 border brand-input rounded-lg text-sm resize-y min-h-[100px]"
                />
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => !modal.submitting && closeModal()}
                disabled={modal.submitting}
                className="px-5 py-2 border brand-border rounded-lg bg-white brand-text font-medium disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleModalConfirm}
                disabled={modal.submitting}
                className="px-5 py-2 rounded-lg brand-button font-medium disabled:opacity-60"
              >
                {modal.submitting ? "Confirming..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </SiteFrame>
  );
}
