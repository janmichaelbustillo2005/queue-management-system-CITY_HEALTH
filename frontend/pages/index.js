import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import SiteFrame from "../components/SiteFrame";
import SettingsModal, { defaultQueueSettings } from "../components/SettingsModal";
import { request } from "../lib/api";
import {
  applyCounterAvailability,
  clearActiveQueues,
  exportQueueData,
  fetchQueueSettings,
  loadLocalQueueSettings,
  saveQueueSettings as persistQueueSettings
} from "../lib/queueSettings";

const defaultSettings = defaultQueueSettings;

const serviceOptions = [
  { value: "consultation", label: "General Consultation" },
  { value: "checkup", label: "Medical Check-up" },
  { value: "prenatal", label: "Prenatal" },
  { value: "maternity", label: "Maternity" }
];

const vulnerabilityOptions = [
  { value: "senior", label: "Senior Citizen (60+)", weight: 3 },
  { value: "pwd", label: "PWD", weight: 3 },
  { value: "pregnant", label: "Pregnant", weight: 2 },
  { value: "indigenous", label: "Indigenous Person", weight: 2 },
  { value: "solo_parent", label: "Solo Parent", weight: 1 }
];

function computePreviewScore(flags) {
  const weights = { senior: 3, pwd: 3, pregnant: 2, indigenous: 2, solo_parent: 1 };
  return flags.reduce((s, f) => s + (weights[f] || 0), 0);
}

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [activeSection, setActiveSection] = useState("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [stats, setStats] = useState({ waiting: 0, serving: 0, completed: 0, today_total_patients: 0 });
  const [queueRows, setQueueRows] = useState([]);
  const [counters, setCounters] = useState([]);
  const [generatedQueue, setGeneratedQueue] = useState("");
  const [error, setError] = useState("");
  const [loadingData, setLoadingData] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [residencySuggestions, setResidencySuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [users, setUsers] = useState([]);
  const [showUserForm, setShowUserForm] = useState(false);
  const [userForm, setUserForm] = useState({ id_num: "", password: "", role: "staff", doctor_name: "" });
  const [cancellationRequests, setCancellationRequests] = useState([]);
  const [processingRequestId, setProcessingRequestId] = useState(null);
  const [form, setForm] = useState({
    fullName: "",
    service_type: "",
    mobile_number: "",
    residency: "",
    philhealth_id: "",
    birthdate: "",
    sex: "",
    vulnerabilityFlags: []
  });

  const filteredRows = useMemo(() => {
    let rows = queueRows ?? [];
    if (!settings.showCompleted) {
      rows = rows.filter((row) => !["completed", "cancelled", "no-show"].includes(row.status));
    }
    return rows
      .slice()
      .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
      .slice(0, Number(settings.maxQueues || 20));
  }, [queueRows, settings]);

  const sidebarLinks = [
    { type: "button", onClick: () => handleSectionChange("home"), icon: "fas fa-home", label: "Home", active: activeSection === "home" },
    { type: "button", onClick: () => handleSectionChange("queue"), icon: "fas fa-list", label: "Queue Management", active: activeSection === "queue" },
    { type: "button", onClick: () => handleSectionChange("staff"), icon: "fas fa-user-cog", label: "Staff Management", active: activeSection === "staff" },
    { href: "/analytics", icon: "fas fa-chart-bar", label: "Analytics", active: false },
    { href: "/records", icon: "fas fa-history", label: "Records", active: false },
  ];

  function handleSectionChange(section) {
    setActiveSection(section);
    router.push({ pathname: "/", query: { section } }, undefined, { shallow: true });
  }

  useEffect(() => {
    if (router.isReady) {
      if (router.query.section === "queue") {
        setActiveSection("queue");
      } else if (router.query.section === "home") {
        setActiveSection("home");
      } else if (router.query.section === "staff") {
        setActiveSection("staff");
      }
    }
  }, [router.isReady, router.query.section]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = loadLocalQueueSettings();
      if (!cancelled) setSettings(local);
      const remote = await fetchQueueSettings();
      if (!cancelled) setSettings(remote);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.push("/login");
      } else if (user.role !== "superadmin") {
        if (user.id_num === "admin1") router.push("/admin1");
        else if (user.id_num === "admin2") router.push("/admin2");
        else if (user.id_num === "admin3") router.push("/admin3");
        else router.push("/login");
      }
    }
}, [user, loading, router]);

  const isAuthLoading = loading || !user || user.role !== "superadmin";

  useEffect(() => {
    function handleClickOutside(event) {
      if (openMenuId && !event.target.closest(".action-menu-container")) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenuId]);

  useEffect(() => {
    if (!settings.autoRefresh) {
      return undefined;
    }

    const timer = setInterval(refreshAll, Number(settings.refreshInterval || 5) * 1000);
    return () => clearInterval(timer);
  }, [settings]);

  useEffect(() => {
    if (user && user.role === "superadmin") {
      refreshAll();
      if (activeSection === "staff") {
        fetchUsers();
        fetchCancellationRequests();
      }
    }
  }, [user, activeSection]);

  async function refreshAll() {
    try {
      const [queueData, statsData] = await Promise.all([request("/queue"), request("/stats")]);
      
      if (queueData.error) {
        setError(queueData.error);
        setQueueRows([]);
        setCounters([]);
        return;
      }
      
      setQueueRows(queueData.patients || []);
      setCounters(queueData.counters || []);
      if (queueData.queue_settings) {
        setSettings((prev) =>
          applyCounterAvailability(
            { ...prev, ...queueData.queue_settings },
            queueData.counters || []
          )
        );
      } else if (queueData.counters?.length) {
        setSettings((prev) => applyCounterAvailability(prev, queueData.counters));
      }
      setStats(statsData.data || {});
    } catch (fetchError) {
      setError(fetchError.message);
    }
  }

  async function fetchUsers() {
    try {
      const data = await request("/users");
      if (data.success) {
        setUsers(data.users);
      }
    } catch (err) {
      setError("Failed to fetch users");
    }
  }

  async function fetchCancellationRequests() {
    try {
      const data = await request("/account-cancellation-requests");
      if (data.success) {
        setCancellationRequests(data.requests || []);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError("Failed to fetch cancellation requests");
    }
  }

  async function handleProcessCancellationRequest(id, action) {
    const confirmMessage = action === "approve"
      ? "Approve this cancellation request? The doctor account will be deleted."
      : "Reject this cancellation request? The doctor account will remain active.";

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setProcessingRequestId(id);
    try {
      const data = await request(`/account-cancellation-requests/${id}/process`, {
        method: "POST",
        body: JSON.stringify({ action })
      });

      if (data.error || !data.success) {
        setError(data.error || data.message || "Failed to process cancellation request");
        return;
      }

      await Promise.all([fetchCancellationRequests(), fetchUsers()]);
    } catch (err) {
      setError(err.message || "Failed to process cancellation request");
    } finally {
      setProcessingRequestId(null);
    }
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    try {
      const data = await request("/users", {
        method: "POST",
        body: JSON.stringify(userForm)
      });
      if (data.success) {
        fetchUsers();
        setShowUserForm(false);
        setUserForm({ id_num: "", password: "", role: "staff", doctor_name: "" });
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError("Failed to create user");
    }
  }

  async function handleDeleteUser(id_num) {
    if (!confirm(`Are you sure you want to delete user ${id_num}?`)) return;
    try {
      const data = await request(`/users/${id_num}`, { method: "DELETE" });
      if (data.success) {
        fetchUsers();
      }
    } catch (err) {
      setError("Failed to delete user");
    }
  }

  const handleResidencySearch = async (query) => {
    setForm({ ...form, residency: query });
    if (query.length < 3) {
      setResidencySuggestions([]);
      setShowSuggestions(false);
      return;
    }

    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=5&countrycodes=ph`);
      const data = await response.json();
      setResidencySuggestions(data);
      setShowSuggestions(true);
    } catch (error) {
      console.error("Residency search failed:", error);
    }
  };

  const selectResidency = (item) => {
    setForm({ ...form, residency: item.display_name });
    setShowSuggestions(false);
  };

  const handleVulnerabilityToggle = (flag) => {
    const flags = form.vulnerabilityFlags.includes(flag)
      ? form.vulnerabilityFlags.filter(f => f !== flag)
      : [...form.vulnerabilityFlags, flag];
    setForm({ ...form, vulnerabilityFlags: flags });
  };

  async function handleSubmit(event) {
    event.preventDefault();
    setLoadingData(true);
    setError("");

    try {
      // Optimistic addition for admin form
      const tempId = Date.now();
      const tempEntry = {
        id: tempId,
        id_num: form.fullName,
        service_type: form.service_type,
        mobile_number: form.mobile_number,
        status: "waiting",
        priority_score: computePreviewScore(form.vulnerabilityFlags),
        vulnerability_flags: form.vulnerabilityFlags,
        created_at: new Date().toISOString(),
        isOptimistic: true
      };
      setQueueRows(prev => [...prev, tempEntry]);
      
      const data = await request("/queue", {
        method: "POST",
        body: JSON.stringify(form)
      });

      if (data.error) {
        setError(data.error);
        refreshAll();
        setLoadingData(false);
        return;
      }

      setGeneratedQueue({ number: data.queue_number, score: data.priority_score || 0 });
      setForm({ fullName: "", service_type: "", mobile_number: "", residency: "", philhealth_id: "", birthdate: "", sex: "", vulnerabilityFlags: [] });
      refreshAll();

      window.setTimeout(() => {
        setGeneratedQueue("");
      }, 5000);
    } catch (submitError) {
      setError(submitError.message);
      refreshAll();
    } finally {
      setLoadingData(false);
    }
  }

  async function queueAction(path, patientId) {
    try {
      setError("");
      
      // Optimistic update
      const action = path.split("/").pop(); // 'call', 'complete', 'cancel', 'undo'
      setQueueRows((prev) => 
        prev.map((row) => {
          if (row.id === patientId) {
            let nextStatus = row.status;
            if (action === "call") nextStatus = "serving";
            if (action === "complete") nextStatus = "completed";
            if (action === "cancel") nextStatus = "cancelled";
            if (action === "undo") nextStatus = "serving";
            
            return { 
              ...row, 
              status: nextStatus,
              // For Undo, we also want to clear completed_at so it doesn't show the three dots immediately
              completed_at: action === "undo" ? null : (action === "complete" || action === "cancel" ? new Date().toISOString() : row.completed_at)
            };
          }
          return row;
        })
      );

      await request(path, {
        method: "POST",
        body: JSON.stringify({ patient_id: patientId })
      });
      
      // Sync with server state
      refreshAll();
    } catch (actionError) {
      setError(actionError.message);
      // Revert/Sync on error
      refreshAll();
    }
  }

  async function clearAllQueues() {
    const data = await clearActiveQueues();
    await refreshAll();
    return data;
  }

  async function exportData(filters = {}) {
    await exportQueueData(filters);
  }

  async function saveSettings(nextSettings = settings) {
    const saved = await persistQueueSettings(nextSettings || settings);
    setSettings(saved);
    await refreshAll();
    return saved;
  }

  const nextWaitingId = (queueRows ?? []).find((row) => row.status === "waiting")?.id;

  const lastActionId = useMemo(() => {
    const actionRows = (queueRows ?? [])
      .filter((row) => ["completed", "cancelled"].includes(row.status) && row.completed_at)
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
    return actionRows[0]?.id;
  }, [queueRows]);

  if (isAuthLoading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return (
    <SiteFrame
      title="Superadmin Dashboard"
      icon="fas fa-user-shield"
      welcome="Welcome, Super Admin"
      showSidebar={true}
      sidebarTitle="Super Admin Menu"
      sidebarLinks={sidebarLinks}
      onSettings={() => setSettingsOpen(true)}
    >
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        onSave={saveSettings}
        onClearAll={clearAllQueues}
        onExport={exportData}
      />

      <div className={`container mx-auto max-w-6xl px-3 md:px-4 ${activeSection === "home" ? "" : "hidden"}`}>
        <div className="mb-4 md:mb-8">
            <h2 className="text-xl md:text-3xl font-bold text-gray-800 mb-4 md:mb-6 flex items-center">
            <i className="fas fa-home mr-2 md:mr-3 text-emerald-800" />
            Superadmin Dashboard
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-6">
            <div
              className="bg-white border border-gray-200 rounded-lg p-3 md:p-6 card-hover cursor-pointer shadow-sm"
              onClick={() => setActiveSection("queue")}
            >
              <div className="flex items-center justify-between gap-2 md:gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm md:text-lg font-bold text-gray-900 mb-0.5 md:mb-1 truncate">Queue Management</h3>
                  <p className="text-[10px] md:text-xs text-gray-600 truncate">Manage patient queues</p>
                </div>
                <div className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-800 shrink-0">
                  <i className="fas fa-users text-base md:text-xl" />
                </div>
              </div>
            </div>
            <Link href="/analytics" className="bg-white border border-gray-200 rounded-lg p-3 md:p-6 card-hover cursor-pointer no-underline shadow-sm">
              <div className="flex items-center justify-between gap-2 md:gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm md:text-lg font-bold text-gray-900 mb-0.5 md:mb-1 truncate">Analytics</h3>
                  <p className="text-[10px] md:text-xs text-gray-600 truncate">View statistics</p>
                </div>
                <div className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-teal-100 flex items-center justify-center text-teal-800 shrink-0">
                  <i className="fas fa-chart-bar text-base md:text-xl" />
                </div>
              </div>
            </Link>
            <Link href="/records" className="bg-white border border-gray-200 rounded-lg p-3 md:p-6 card-hover cursor-pointer no-underline shadow-sm">
              <div className="flex items-center justify-between gap-2 md:gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm md:text-lg font-bold text-gray-900 mb-0.5 md:mb-1 truncate">Records</h3>
                  <p className="text-[10px] md:text-xs text-gray-600 truncate">View history</p>
                </div>
                <div className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-[#4a6b5d]/15 flex items-center justify-center text-[#2d4a3e] shrink-0">
                  <i className="fas fa-folder text-base md:text-xl" />
                </div>
              </div>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 mb-6 md:mb-8">
          <div className="bg-white rounded-lg shadow-md p-4 md:p-6 card-hover border border-gray-100">
            <h3 className="text-base md:text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <i className="fas fa-history text-emerald-800" />
              Recent Activity
            </h3>
            <div className="space-y-3">
              {(queueRows ?? []).slice(0, 5).map((row) => (
                <div key={row.id} className="flex items-center justify-between text-xs md:text-sm border-b border-gray-50 pb-2">
                  <div className="flex flex-col">
                    <span className="font-semibold text-gray-900">{row.id_num}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] md:text-xs text-gray-500">{row.service_type}</span>
                      {row.residency && (
                        <span className="text-[9px] text-gray-400 truncate max-w-[120px]">
                          <i className="fas fa-map-marker-alt mr-1" />
                          {row.residency}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${row.status === "completed" ? "bg-green-100 text-green-700" : row.status === "serving" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                    {row.status}
                  </span>
                </div>
              ))}
              {(queueRows ?? []).length === 0 && <p className="text-gray-500 text-center py-4 italic text-sm">No recent activity</p>}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-4 md:p-6 card-hover border border-gray-100">
            <h3 className="text-base md:text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <i className="fas fa-server text-emerald-800" />
              System Status
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs md:text-sm text-gray-600">Database Connection</span>
                <span className="flex items-center text-xs font-bold text-green-600">
                  <span className="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse" />
                  ONLINE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs md:text-sm text-gray-600">Queue Backend</span>
                <span className="flex items-center text-xs font-bold text-green-600">
                  <span className="w-2 h-2 bg-green-500 rounded-full mr-2" />
                  RUNNING
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`container mx-auto max-w-6xl px-3 md:px-4 ${activeSection === "staff" ? "" : "hidden"}`}>
        <div className="mb-8 flex items-center justify-between">
          <h2 className="text-xl md:text-3xl font-bold text-gray-800 flex items-center">
            <i className="fas fa-user-cog mr-3 text-emerald-800" />
            Staff Management
          </h2>
          <button 
            onClick={() => setShowUserForm(!showUserForm)}
            className="bg-emerald-800 text-white px-4 py-2 rounded-lg hover:bg-emerald-900 transition-colors flex items-center gap-2"
          >
            <i className={`fas ${showUserForm ? 'fa-times' : 'fa-plus'}`} />
            {showUserForm ? 'Cancel' : 'Add New Staff'}
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-md border border-gray-100 overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2 m-0">
                <i className="fas fa-user-times text-red-600" />
                Doctor Cancellation Requests
              </h3>
              <p className="text-xs text-gray-500 mt-1 mb-0">
                Review doctor account cancellation requests. Approving deletes the account; rejecting keeps it active.
              </p>
            </div>
            <button
              type="button"
              onClick={fetchCancellationRequests}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              <i className="fas fa-sync-alt mr-1" />
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50 text-gray-600 text-xs font-bold uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-3">Doctor</th>
                  <th className="px-6 py-3">Reason</th>
                  <th className="px-6 py-3">Requested</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cancellationRequests.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-10 text-center text-gray-400 italic">
                      No cancellation requests yet
                    </td>
                  </tr>
                ) : (
                  cancellationRequests.map((reqItem) => (
                    <tr key={reqItem.id} className="hover:bg-gray-50 transition-colors align-top">
                      <td className="px-6 py-4">
                        <div className="font-bold text-gray-900">{reqItem.doctor_id_num}</div>
                        <div className="text-sm text-gray-600">{reqItem.doctor_name || "—"}</div>
                        <div className="text-[10px] uppercase font-bold text-gray-400 mt-1">{reqItem.doctor_role || "admin"}</div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-700 max-w-xs whitespace-pre-wrap">
                        {reqItem.reason}
                      </td>
                      <td className="px-6 py-4 text-xs text-gray-500 whitespace-nowrap">
                        {reqItem.requested_at ? new Date(reqItem.requested_at).toLocaleString() : "—"}
                        {reqItem.processed_at ? (
                          <div className="mt-1 text-[11px] text-gray-400">
                            Processed: {new Date(reqItem.processed_at).toLocaleString()}
                            {reqItem.processed_by ? ` by ${reqItem.processed_by}` : ""}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${
                          reqItem.status === "pending" ? "bg-amber-100 text-amber-700" :
                          reqItem.status === "approved" ? "bg-red-100 text-red-700" :
                          "bg-gray-100 text-gray-600"
                        }`}>
                          {reqItem.status}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {reqItem.status === "pending" ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => handleProcessCancellationRequest(reqItem.id, "approve")}
                              disabled={processingRequestId === reqItem.id}
                              className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-60"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => handleProcessCancellationRequest(reqItem.id, "reject")}
                              disabled={processingRequestId === reqItem.id}
                              className="px-3 py-1.5 rounded-lg bg-gray-700 text-white text-xs font-bold hover:bg-gray-800 disabled:opacity-60"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">No actions</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {showUserForm && (
          <div className="bg-white p-6 rounded-xl shadow-md border border-gray-100 mb-8 max-w-2xl">
            <h3 className="text-lg font-bold text-gray-800 mb-4">Create New Account</h3>
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">User ID (Username)</label>
                  <input
                    type="text"
                    required
                    className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:ring-2 focus:ring-emerald-500 outline-none"
                    value={userForm.id_num}
                    onChange={(e) => setUserForm({...userForm, id_num: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:ring-2 focus:ring-emerald-500 outline-none"
                    value={userForm.password}
                    onChange={(e) => setUserForm({...userForm, password: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Role</label>
                  <select
                    className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:ring-2 focus:ring-emerald-500 outline-none"
                    value={userForm.role}
                    onChange={(e) => setUserForm({...userForm, role: e.target.value})}
                  >
                    <option value="staff">Staff / Nurse</option>
                    <option value="doctor">Doctor</option>
                    <option value="superadmin">Superadmin</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Display Name / Doctor Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Dr. Smith"
                    className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:ring-2 focus:ring-emerald-500 outline-none"
                    value={userForm.doctor_name}
                    onChange={(e) => setUserForm({...userForm, doctor_name: e.target.value})}
                  />
                </div>
              </div>
              <button 
                type="submit"
                className="w-full bg-emerald-800 text-white py-3 rounded-lg font-bold hover:bg-emerald-900 transition-all"
              >
                Create Account
              </button>
            </form>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-md border border-gray-100 overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-gray-50 text-gray-600 text-xs font-bold uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">User ID</th>
                <th className="px-6 py-4">Display Name</th>
                <th className="px-6 py-4">Role</th>
                <th className="px-6 py-4">Created</th>
                <th className="px-6 py-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id_num} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-bold text-gray-900">{u.id_num}</td>
                  <td className="px-6 py-4 text-gray-700">{u.doctor_name || "—"}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${
                      u.role === 'superadmin' ? 'bg-purple-100 text-purple-700' : 
                      u.role === 'doctor' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-xs text-gray-500">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">
                    <button 
                      onClick={() => handleDeleteUser(u.id_num)}
                      className="text-red-500 hover:text-red-700 transition-colors"
                      disabled={u.id_num === user.id_num}
                    >
                      <i className="fas fa-trash-alt" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <div className="p-12 text-center text-gray-400 italic">No staff accounts found</div>
          )}
        </div>
      </div>

      <div className={`container mx-auto max-w-6xl px-3 md:px-4 ${activeSection === "queue" ? "" : "hidden"}`}>
        {error ? (
          <div className="fixed top-4 right-3 md:right-4 bg-red-500 text-white px-3 py-2 rounded-lg shadow-lg z-50 max-w-[90vw] text-sm">
            <div className="flex items-center">
              <i className="fas fa-exclamation-triangle mr-2" />
              <span>{error}</span>
              <button type="button" onClick={() => setError("")} className="ml-3 text-white hover:text-gray-200">
                <i className="fas fa-times" />
              </button>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3 mb-4">
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full bg-emerald-100 text-emerald-800 shrink-0">
                <i className="fas fa-clock text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold text-gray-800 leading-tight tabular-nums">{stats.waiting}</p>
                <p className="text-[11px] md:text-xs text-gray-600 leading-snug">Waiting</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full bg-teal-100 text-teal-800 shrink-0">
                <i className="fas fa-user-check text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold text-gray-800 leading-tight tabular-nums">{stats.serving}</p>
                <p className="text-[11px] md:text-xs text-gray-600 leading-snug">Serving</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full bg-green-100 text-green-600 shrink-0">
                <i className="fas fa-check-circle text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold text-gray-800 leading-tight tabular-nums">{stats.completed}</p>
                <p className="text-[11px] md:text-xs text-gray-600 leading-snug">Completed</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full bg-amber-100 text-amber-900 shrink-0">
                <i className="fas fa-calendar-day text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold text-gray-800 leading-tight tabular-nums">{stats.today_total_patients}</p>
                <p className="text-[11px] md:text-xs text-gray-600 leading-snug">Total Patients</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <div className="bg-white rounded-lg shadow-md p-3 md:p-4 card-hover">
              <div className="flex flex-wrap gap-2 justify-between items-center mb-3">
                <h2 className="text-base md:text-lg font-bold text-gray-800 flex items-center gap-2">
                  <i className="fas fa-list text-emerald-800" />
                  Queue Management
                </h2>
                <div className="flex gap-2 w-full sm:w-auto">
                  <button type="button" onClick={() => setShowAddForm(!showAddForm)} className="text-white text-sm px-3 py-1.5 rounded-md hover:opacity-90 transition flex-1 sm:flex-none flex items-center justify-center gap-2" style={{ backgroundColor: "#0f766e" }}>
                    <i className={`fas fa-${showAddForm ? "times" : "plus"}`} />
                    {showAddForm ? "Cancel" : "Add Patient"}
                  </button>
                  <button type="button" onClick={refreshAll} className="text-white text-sm px-3 py-1.5 rounded-md hover:opacity-90 transition flex-1 sm:flex-none flex items-center justify-center gap-2" style={{ backgroundColor: "#279b61" }}>
                    <i className="fas fa-sync-alt" />
                    Refresh
                  </button>
                </div>
              </div>

              {showAddForm && (
                <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-user-plus text-emerald-800" />
                    Manual Queue Entry
                  </h3>
                  <form onSubmit={(e) => {
                    handleSubmit(e);
                    setShowAddForm(false);
                  }} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        placeholder="Enter full name"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.fullName}
                        onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Service Type</label>
                      <select
                        required
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.service_type}
                        onChange={(e) => setForm({ ...form, service_type: e.target.value })}
                        suppressHydrationWarning
                      >
                        <option value="">Select Service</option>
                        {serviceOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Mobile Number</label>
                      <input
                        type="text"
                        placeholder="9123456789"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.mobile_number}
                        onChange={(e) => setForm({ ...form, mobile_number: e.target.value.replace(/[^0-9]/g, "").slice(0, 10) })}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">PhilHealth ID</label>
                      <input
                        type="text"
                        placeholder="Enter PhilHealth ID"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.philhealth_id}
                        onChange={(e) => setForm({ ...form, philhealth_id: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Birthdate</label>
                      <input
                        type="date"
                        required
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.birthdate}
                        onChange={(e) => setForm({ ...form, birthdate: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Sex</label>
                      <select
                        required
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.sex}
                        onChange={(e) => setForm({ ...form, sex: e.target.value })}
                      >
                        <option value="">Select</option>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                      </select>
                    </div>
                    <div className="sm:col-span-2 lg:col-span-2 relative">
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Residency</label>
                      <input
                        type="text"
                        required
                        placeholder="Search address..."
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        value={form.residency}
                        onChange={(e) => handleResidencySearch(e.target.value)}
                        onFocus={() => residencySuggestions.length > 0 && setShowSuggestions(true)}
                        autoComplete="off"
                      />
                      {showSuggestions && residencySuggestions.length > 0 && (
                        <div className="absolute w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-[100] max-h-48 overflow-y-auto">
                          {residencySuggestions.map((item, index) => (
                            <div
                              key={index}
                              className="px-3 py-2 text-xs hover:bg-gray-100 cursor-pointer border-b border-gray-100 last:border-0"
                              onClick={() => selectResidency(item)}
                            >
                              <i className="fas fa-map-marker-alt mr-2 text-gray-400" />
                              {item.display_name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="sm:col-span-2 lg:col-span-4">
                      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Vulnerability (Priority Score Computed Automatically)</label>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 bg-gray-50 p-2.5 rounded-md border border-gray-200">
                        {vulnerabilityOptions.map((opt) => (
                          <label key={opt.value} className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="rounded"
                              checked={form.vulnerabilityFlags.includes(opt.value)}
                              onChange={() => handleVulnerabilityToggle(opt.value)}
                              disabled={loading}
                            />
                            <span>{opt.label}</span>
                            <span className="text-gray-400">(+{opt.weight})</span>
                          </label>
                        ))}
                        {form.vulnerabilityFlags.length > 0 && (
                          <span className="text-emerald-700 font-semibold text-xs ml-auto">
                            Score: {computePreviewScore(form.vulnerabilityFlags)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
                      <button
                        type="submit"
                        disabled={loading}
                        className="bg-emerald-600 text-white px-4 py-2 rounded-md text-sm font-bold hover:bg-emerald-700 transition disabled:opacity-50"
                      >
                        {loading ? "Adding..." : "Add to Queue"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              <div className="mb-3">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Counter Status</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 md:gap-4">
                  {counters.map((counter) => (
                    <div key={counter.id} className={`border rounded-lg p-2 md:p-3 shadow-sm transition-all duration-200 ${counter.is_online ? "bg-green-50 border-green-200 hover:shadow-md" : "bg-red-50 border-red-200"}`}>
                      <div className="text-center mb-1 md:mb-2">
                        <h4 className="text-[10px] md:text-sm font-bold text-gray-800 truncate" title={counter.name}>{counter.name}</h4>
                        <span className={`inline-block mt-0.5 md:mt-1 px-1.5 py-0.5 rounded text-[8px] md:text-[10px] font-bold uppercase tracking-wider ${counter.is_online ? "bg-green-200 text-green-800" : "bg-red-200 text-red-800"}`}>
                          {counter.is_online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <div className="text-center text-[9px] md:text-[11px] text-gray-600">
                        Serving: <span className="font-semibold text-gray-900">{counter.current_patient_name || "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto rounded-md border border-gray-100 max-w-full">
                <table className="w-full min-w-[600px] md:min-w-[720px] table-auto text-left">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">Queue</th>
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide" suppressHydrationWarning>Patient Info</th>
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">Service</th>
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide text-center">Priority</th>
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">Status</th>
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">Time</th>
                      <th className="px-2 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredRows.length ? filteredRows.map((patient) => {
                      const canCall = patient.status === "waiting" && patient.id === nextWaitingId;
                      const statusClass = patient.status === "waiting"
                        ? "bg-yellow-100 text-yellow-800"
                        : patient.status === "serving"
                          ? "bg-teal-100 text-teal-900"
                          : patient.status === "completed"
                            ? "bg-green-100 text-green-800"
                            : "bg-red-100 text-red-800";

                      return (
                        <tr key={patient.id} className={`hover:bg-gray-50/80 ${canCall ? "bg-yellow-50 border-l-2 border-yellow-400" : ""}`}>
                          <td className="px-2 py-2">
                            <span className="queue-number text-sm font-bold">{patient.queue_number}</span>
                            {canCall ? <span className="ml-1 text-[10px] bg-yellow-400 text-yellow-900 px-1.5 py-0.5 rounded-full font-medium">NEXT</span> : null}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex flex-col">
                              <span className="text-sm font-semibold text-gray-900">{patient.id_num}</span>
                              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                                {patient.sex && (
                                  <span className="text-[10px] text-emerald-700 font-bold uppercase tracking-wider">
                                    {patient.sex}
                                  </span>
                                )}
                                {patient.birthdate && (
                                  <span className="text-[10px] text-gray-500">
                                    <i className="fas fa-birthday-cake mr-1" />
                                    {new Date(patient.birthdate).toLocaleDateString()}
                                  </span>
                                )}
                                {patient.mobile_number && (
                                  <span className="text-[10px] text-gray-500">
                                    <i className="fas fa-phone-alt mr-1" />
                                    {patient.mobile_number}
                                  </span>
                                )}
                                {patient.philhealth_id && (
                                  <span className="text-[10px] text-blue-600 font-medium">
                                    <i className="fas fa-id-card mr-1" />
                                    {patient.philhealth_id}
                                  </span>
                                )}
                              </div>
                              {patient.residency && (
                                <span className="text-[10px] text-gray-400 mt-0.5 max-w-[200px] truncate" title={patient.residency}>
                                  <i className="fas fa-map-marker-alt mr-1" />
                                  {patient.residency}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-900 border border-emerald-200">{patient.service_type}</span>
                          </td>
                          <td className="px-2 py-2 text-center">
                            {(patient.priority_score || 0) >= 3 ? (
                              <span className="inline-flex items-center gap-1 text-yellow-700 bg-yellow-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                                <i className="fas fa-star" /> {patient.priority_score}
                              </span>
                            ) : (patient.priority_score || 0) > 0 ? (
                              <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                                <i className="fas fa-star" /> {patient.priority_score}
                              </span>
                            ) : (
                              <span className="text-gray-400 text-[10px]">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusClass}`}>{patient.status}</span>
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap">{new Date(patient.created_at).toLocaleTimeString()}</td>
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap gap-1 items-center">
                              {canCall ? (
                                <button type="button" onClick={() => queueAction("/queue/call", patient.id)} className="text-white px-2 py-1 rounded text-xs hover:opacity-90 whitespace-nowrap" style={{ backgroundColor: "#279b61" }}>
                                  <i className="fas fa-bullhorn mr-0.5" />
                                  Call
                                </button>
                              ) : null}
                              {patient.status === "serving" ? (
                                <button type="button" onClick={() => queueAction("/queue/complete", patient.id)} className="text-white px-2 py-1 rounded text-xs hover:opacity-90 whitespace-nowrap" style={{ backgroundColor: "#1a6b45" }}>
                                  <i className="fas fa-check mr-0.5" />
                                  Complete
                                </button>
                              ) : null}
                              {!["completed", "cancelled"].includes(patient.status) ? (
                                <button type="button" onClick={() => queueAction("/queue/cancel", patient.id)} className="bg-red-500 text-white px-2 py-1 rounded text-xs hover:bg-red-600 whitespace-nowrap">
                                  <i className="fas fa-times mr-0.5" />
                                  Cancel
                                </button>
                              ) : null}

                              {patient.id === lastActionId && (
                                <div className="flex items-center gap-2 action-menu-container">
                                  <button
                                    type="button"
                                    onClick={() => setOpenMenuId(openMenuId === patient.id ? null : patient.id)}
                                    className="p-1 hover:bg-gray-100 rounded-full transition-colors flex items-center justify-center"
                                    title="More actions"
                                  >
                                    <i className="fas fa-ellipsis-h text-gray-500 px-1" />
                                  </button>
                                  {openMenuId === patient.id && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        queueAction("/queue/undo", patient.id);
                                        setOpenMenuId(null);
                                      }}
                                      className="px-3 py-1 text-xs font-semibold text-orange-600 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-md flex items-center transition-all duration-200 shadow-sm"
                                    >
                                      <i className="fas fa-undo mr-1.5" />
                                      Undo
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    }) : (
                      <tr>
                        <td colSpan="8" className="px-2 py-6 text-center text-gray-500 text-sm">
                          <i className="fas fa-inbox text-2xl mb-1 block opacity-60" />
                          No patients in queue
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SiteFrame>
  );
}
