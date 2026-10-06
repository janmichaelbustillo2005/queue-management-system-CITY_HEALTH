import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import SiteFrame from "../components/SiteFrame";
import PatientQueueTable, { DOCTORS } from "../components/PatientQueueTable";
import { defaultQueueSettings } from "../components/SettingsModal";
import { useAuth } from "../context/AuthContext";
import { request } from "../lib/api";
import { frontdeskSidebarLinks } from "../lib/frontdeskNav";
import { fetchQueueSettings, loadLocalQueueSettings, mergeQueueSettings } from "../lib/queueSettings";

const STATUS_OPTIONS = [
  { value: "active", label: "Active Queue" },
  { value: "waiting", label: "Waiting" },
  { value: "serving", label: "Serving" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" }
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
  const [queueSettings, setQueueSettings] = useState(defaultQueueSettings);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState({ type: "", text: "" });
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(closedModal);
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

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request("/queue");
      if (data.error) {
        setNotice({ type: "error", text: data.error });
        return;
      }
      setQueueRows(data.patients ?? []);
      setCounters(data.counters ?? []);
      if (data.queue_settings) {
        setQueueSettings(mergeQueueSettings(data.queue_settings));
      }
    } finally {
      setLoading(false);
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
      welcome="Welcome"
      showSidebar={true}
      sidebarTitle="Front Desk Menu"
      sidebarLinks={frontdeskSidebarLinks("/patient-management")}
    >
      <div className="w-full max-w-7xl mx-auto px-3 md:px-6 py-4">
        {notice.text ? (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              notice.type === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {notice.text}
          </div>
        ) : null}

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <i className="fas fa-tasks text-emerald-600" />
              <div>
                <h2 className="font-bold text-gray-800 text-lg m-0">Patient Management</h2>
                <p className="text-xs text-gray-500 m-0">Manage all doctors' patients in one table. Changes sync with the doctor accounts.</p>
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
                className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors flex items-center gap-2"
              >
                <i className={`fas fa-sync-alt ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <label className="text-xs font-semibold text-gray-600">
              Doctor
              <select
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                value={doctorFilter}
                onChange={(e) => setDoctorFilter(e.target.value)}
              >
                <option value="all">All Doctors</option>
                {DOCTORS.map((d) => (
                  <option key={d.name} value={d.name}>{d.name} ({d.assignment})</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-gray-600">
              Status
              <select
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-gray-600">
              Search
              <input
                type="text"
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
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
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
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
        />
      </div>

      {modal.isOpen && (
        <div className="fixed inset-0 bg-black/50 z-[10000] flex items-center justify-center px-3">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
            <h3 className="text-xl font-bold text-gray-800 mb-3">{modal.title}</h3>
            <p className="text-gray-600 mb-4">{modal.message}</p>
            {modal.error ? (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {modal.error}
              </div>
            ) : null}
            {modal.showReason && (
              <div className="mb-5">
                <label className="block mb-2 text-sm font-medium text-gray-700">
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-y min-h-[100px]"
                />
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => !modal.submitting && closeModal()}
                disabled={modal.submitting}
                className="px-5 py-2 border border-gray-300 rounded-lg bg-white text-gray-700 font-medium disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleModalConfirm}
                disabled={modal.submitting}
                className="px-5 py-2 rounded-lg text-white font-medium disabled:opacity-60"
                style={{ backgroundColor: "#166534" }}
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
