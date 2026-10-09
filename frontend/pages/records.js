import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import SiteFrame from "../components/SiteFrame";
import SettingsModal, { defaultQueueSettings } from "../components/SettingsModal";
import { request } from "../lib/api";
import {
  clearActiveQueues,
  exportQueueData,
  fetchQueueSettings,
  loadLocalQueueSettings,
  saveQueueSettings as persistQueueSettings
} from "../lib/queueSettings";

const serviceOptions = [
  { value: "", label: "All Services" },
  { value: "consultation", label: "General Consultation" },
  { value: "checkup", label: "Medical Check-up" },
  { value: "prenatal", label: "Prenatal" },
  { value: "maternity", label: "Maternity" }
];

const defaultSettings = defaultQueueSettings;

export default function RecordsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [filters, setFilters] = useState({ status: "", service: "", dateFilter: "" });
  const [page, setPage] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [data, setData] = useState({
    transactions: [],
    pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, recordsPerPage: 20, hasNext: false, hasPrev: false },
    stats: { completed: 0, cancelled: 0 }
  });

  const [apiError, setApiError] = useState(null);
  // Removed early return to satisfy React Hook rules; hooks must run on every render

  useEffect(() => {
    if (!loading && (!user || user.role !== "superadmin")) {
      router.push("/login");
    }
  }, [user, loading, router]);

  // Load initial transactions once user is authenticated as superadmin
  useEffect(() => {
    if (user && user.role === "superadmin") {
      loadTransactions(1, filters);
    }
  }, [user, filters]);

  // Removed duplicate data load effect; main effect will handle when user becomes available

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

  async function saveSettings(nextSettings = settings) {
    const saved = await persistQueueSettings(nextSettings || settings);
    setSettings(saved);
    return saved;
  }

  async function clearAllQueues() {
    const data = await clearActiveQueues();
    await loadTransactions(1, filters);
    return data;
  }

  async function exportData(filters = {}) {
    await exportQueueData(filters);
  }

  const sidebarLinks = [
    { href: "/?section=home", icon: "fas fa-home", label: "Home", active: false },
    { href: "/?section=queue", icon: "fas fa-list", label: "Queue Management", active: false },
    { href: "/analytics", icon: "fas fa-chart-bar", label: "Analytics", active: false },
    { href: "/records", icon: "fas fa-history", label: "Records", active: true }
  ];

  // Removed duplicate data load effect; main effect will handle when user becomes available

  async function loadTransactions(nextPage = page, nextFilters = filters) {
    const MAX_RETRIES = 3;
    let attempt = 0;
    // Reset API error when making a new request
    setApiError(null);
    const params = new URLSearchParams({
      page: String(nextPage),
      limit: String(settings.maxQueues || 20),
      status: nextFilters.status,
      service: nextFilters.service,
      dateFilter: nextFilters.dateFilter
    });

    const run = async () => {
      attempt++;
      try {
        const response = await request(`/transactions?${params.toString()}`);
        if (response && response.error) {
          setApiError(response.error);
          return;
        }
        setData(response);
        setPage(nextPage);
      } catch (err) {
        console.error(err);
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await run();
        } else {
          setApiError(err?.message || "API request failed after retries");
        }
      }
    };
    await run();
  }

  return (
    <SiteFrame
      title="Transaction History"
      icon="fas fa-history"
      showSidebar={true}
      sidebarLinks={sidebarLinks}
      onSettings={() => setSettingsOpen(true)}
    >
      {apiError && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded mb-4" role="alert">
          <strong className="mr-2">Error:</strong> {apiError}
        </div>
      )}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        onSave={saveSettings}
        onClearAll={clearAllQueues}
        onExport={exportData}
      />
      <div className="container mx-auto max-w-6xl px-3 md:px-4">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 md:gap-3 mb-4">
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full brand-bg-subtle brand-text-primary shrink-0">
                <i className="fas fa-list text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold brand-text leading-tight tabular-nums">{data?.pagination?.totalRecords ?? 0}</p>
                <p className="text-[11px] md:text-xs brand-text-muted leading-snug">Total Transactions</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full bg-green-100 text-green-800 shrink-0">
                <i className="fas fa-check-circle text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold brand-text leading-tight tabular-nums">{data?.stats?.completed ?? 0}</p>
                <p className="text-[11px] md:text-xs brand-text-muted leading-snug">Completed</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover col-span-2 lg:col-span-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-full bg-amber-100 text-amber-900 shrink-0">
                <i className="fas fa-times-circle text-base md:text-lg" />
              </div>
              <div className="min-w-0">
                <p className="text-base md:text-lg font-bold brand-text leading-tight tabular-nums">{data?.stats?.cancelled ?? 0}</p>
                <p className="text-[11px] md:text-xs brand-text-muted leading-snug">Cancelled</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-3 md:p-4 mb-4 card-hover">
          <div className="flex flex-wrap gap-2 md:gap-3 items-end">
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-medium brand-text-muted mb-1">Status</label>
              <select className="w-full px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="">All Status</option>
                <option value="waiting">Waiting</option>
                <option value="serving">Serving</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-medium brand-text-muted mb-1">Service</label>
              <select className="w-full px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.service} onChange={(e) => setFilters({ ...filters, service: e.target.value })} suppressHydrationWarning>
                {serviceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-medium brand-text-muted mb-1">Date range</label>
              <select className="w-full px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.dateFilter} onChange={(e) => setFilters({ ...filters, dateFilter: e.target.value })}>
                <option value="">All Time</option>
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
              </select>
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <button type="button" onClick={() => loadTransactions(1, filters)} className="brand-button text-sm px-3 py-1.5 rounded-md transition flex-1 sm:flex-none"><i className="fas fa-filter mr-1" />Apply</button>
              <button type="button" onClick={() => { const nextFilters = { status: "", service: "", dateFilter: "" }; setFilters(nextFilters); loadTransactions(1, nextFilters); }} className="bg-gray-600 text-white text-sm px-3 py-1.5 rounded-md hover:bg-gray-700 transition flex-1 sm:flex-none"><i className="fas fa-undo mr-1" />Reset</button>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-3 md:p-4 card-hover">
          <div className="flex flex-wrap gap-2 justify-between items-center mb-3">
            <h2 className="text-base md:text-lg font-bold brand-text"><i className="fas fa-history mr-2 brand-text-primary" />Patient Records</h2>
            <button type="button" onClick={() => loadTransactions(page, filters)} className="brand-button text-sm px-3 py-1.5 rounded-md transition w-full sm:w-auto"><i className="fas fa-sync-alt mr-1" />Refresh</button>
          </div>
          <div className="overflow-x-auto rounded-md border brand-border max-w-full">
            <table className="w-full min-w-[600px] md:min-w-[880px] table-auto text-left">
              <thead>
                <tr className="brand-bg-subtle border-b brand-border">
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Queue</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide" suppressHydrationWarning>Patient Name</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Service</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide text-center">Priority</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Mobile</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Status</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Doctor</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Reason</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Created</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Called</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Completed / Cancelled</th>
                  <th className="px-2 py-2 text-xs font-semibold brand-text-muted uppercase tracking-wide">Wait</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.transactions ?? []).length ? data.transactions.map((transaction) => {
                  const waitTime = transaction.called_at
                    ? `${Math.max(0, Math.round((new Date(transaction.called_at) - new Date(transaction.created_at)) / 60000))}m`
                    : "-";

                  const statusClass = transaction.status === "waiting"
                    ? "bg-yellow-100 text-yellow-800"
                    : transaction.status === "serving"
                      ? "bg-teal-100 text-teal-900"
                      : transaction.status === "completed"
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800";

                  return (
                    <tr key={transaction.id} className="brand-hover-subtle">
                      <td className="px-2 py-2"><span className="queue-number text-sm font-bold">{transaction.queue_number}</span></td>
                      <td className="px-2 py-2 text-xs brand-text">{transaction.id_num}</td>
                      <td className="px-2 py-2"><span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium brand-bg-subtle brand-text-primary border brand-border">{transaction.service_type}</span></td>
                      <td className="px-2 py-2 text-center">
                        {(transaction.priority_score || 0) >= 3 ? (
                          <span className="inline-flex items-center gap-1 text-yellow-700 bg-yellow-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                            <i className="fas fa-star" /> {transaction.priority_score}
                          </span>
                        ) : (transaction.priority_score || 0) > 0 ? (
                          <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                            <i className="fas fa-star" /> {transaction.priority_score}
                          </span>
                        ) : (
                          <span className="brand-text-muted text-[10px]">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs brand-text">{transaction.mobile_number || "—"}</td>
                      <td className="px-2 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusClass}`}>{transaction.status}</span></td>
                      <td className="px-2 py-2 text-xs brand-text whitespace-nowrap">
                        {transaction.counter_id || "—"}
                      </td>
                      <td className="px-2 py-2 text-xs brand-text max-w-[200px] truncate" title={transaction.reason || ""}>
                        {transaction.reason || "—"}
                      </td>
                      <td className="px-2 py-2 text-xs brand-text-muted whitespace-nowrap">{new Date(transaction.created_at).toLocaleString()}</td>
                      <td className="px-2 py-2 text-xs brand-text-muted whitespace-nowrap">{transaction.called_at ? new Date(transaction.called_at).toLocaleString() : "-"}</td>
                      <td className="px-2 py-2 text-xs brand-text-muted whitespace-nowrap">{transaction.completed_at ? new Date(transaction.completed_at).toLocaleString() : "-"}</td>
                      <td className="px-2 py-2 text-xs brand-text-muted">{waitTime}</td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td colSpan="12" className="px-2 py-6 text-center brand-text-muted text-sm">
                      <i className="fas fa-inbox text-2xl mb-1 block opacity-60" />
                      No transactions found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 justify-between sm:items-center mt-3 pt-3 border-t brand-border">
            <div className="text-xs brand-text-muted">
              Showing {data?.pagination?.totalRecords ? `${(data.pagination.currentPage - 1) * data.pagination.recordsPerPage + 1}-${Math.min(data.pagination.currentPage * data.pagination.recordsPerPage, data.pagination.totalRecords)}` : "0"} of {data?.pagination?.totalRecords ?? 0} transactions
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={!data?.pagination?.hasPrev} onClick={() => loadTransactions(page - 1, filters)} className={data?.pagination?.hasPrev ? "brand-button px-2.5 py-1 rounded text-xs" : "bg-gray-300 brand-text-muted px-2.5 py-1 rounded text-xs cursor-not-allowed"}><i className="fas fa-chevron-left" /> Prev</button>
              <span className="px-2 py-1 text-xs brand-text">Page {data?.pagination?.currentPage ?? 1}</span>
              <button type="button" disabled={!data?.pagination?.hasNext} onClick={() => loadTransactions(page + 1, filters)} className={data?.pagination?.hasNext ? "brand-button px-2.5 py-1 rounded text-xs" : "bg-gray-300 brand-text-muted px-2.5 py-1 rounded text-xs cursor-not-allowed"}>Next <i className="fas fa-chevron-right" /></button>
            </div>
          </div>
        </div>
      </div>
    </SiteFrame>
  );
}
