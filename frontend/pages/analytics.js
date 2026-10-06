import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import Script from "next/script";
import SiteFrame from "../components/SiteFrame";
import SettingsModal, { defaultQueueSettings } from "../components/SettingsModal";
import { API_BASE_URL, request } from "../lib/api";
import Link from "next/link";
import {
  clearActiveQueues,
  exportQueueData,
  fetchQueueSettings,
  loadLocalQueueSettings,
  saveQueueSettings as persistQueueSettings
} from "../lib/queueSettings";

const defaultSettings = defaultQueueSettings;

function drawChart(canvasId, type, labels, data, colors) {
  if (typeof window === "undefined" || !window.Chart) {
    return null;
  }

  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    return null;
  }

  return new window.Chart(canvas.getContext("2d"), {
    type,
    data: {
      labels,
      datasets: [{
        label: "Patients",
        data,
        backgroundColor: colors,
        borderColor: Array.isArray(colors) ? colors[0] : colors,
        tension: 0.4,
        fill: type === "line"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: 4, right: 4, bottom: 4, left: 4 }
      },
      plugins: {
        legend: {
          position: "bottom",
          display: type !== "line" && type !== "bar",
          labels: {
            boxWidth: 10,
            padding: 6,
            font: { size: 11 }
          }
        }
      },
      scales: type === "line" || type === "bar" ? {
        x: {
          ticks: { font: { size: 10 }, maxRotation: 45 }
        },
        y: {
          beginAtZero: true,
          ticks: { font: { size: 10 } }
        }
      } : undefined
    }
  });
}

export default function AnalyticsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("all");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!loading && (!user || user.role !== "superadmin")) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const [settings, setSettings] = useState(defaultSettings);
  const [filters, setFilters] = useState({ startDate: "", endDate: "" });
  const [data, setData] = useState({
    metrics: { totalPatients: 0, avgWaitTime: 0, avgServiceTime: 0, completionRate: 0 },
    charts: {
      serviceTypes: { labels: [], data: [] },
      sexDistribution: { labels: [], data: [] },
      dailyTrends: { labels: [], data: [] },
      hourly: { labels: [], data: [] },
      status: { labels: [], data: [] }
    },
    tableData: []
  });

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
    await loadAnalytics(filters);
    return data;
  }

  async function exportQueueFromSettings(filters = {}) {
    await exportQueueData(filters);
  }

  const sidebarLinks = [
    { href: "/?section=home", icon: "fas fa-home", label: "Home", active: false },
    { href: "/?section=queue", icon: "fas fa-list", label: "Queue Management", active: false },
    { href: "/analytics", icon: "fas fa-chart-bar", label: "Analytics", active: true },
    { href: "/records", icon: "fas fa-history", label: "Records", active: false }
  ];

  useEffect(() => {
    const today = new Date();
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const nextFilters = {
      startDate: lastWeek.toISOString().split("T")[0],
      endDate: today.toISOString().split("T")[0]
    };
    setFilters(nextFilters);
    loadAnalytics(nextFilters);
  }, []);

  useEffect(() => {
    if (!data?.charts?.serviceTypes?.labels?.length && !data?.charts?.dailyTrends?.labels?.length) {
      return;
    }

    const charts = [];
    
    if (activeTab === "all" || activeTab === "distribution") {
      charts.push(drawChart("serviceTypesChart", "doughnut", data?.charts?.serviceTypes?.labels ?? [], data?.charts?.serviceTypes?.data ?? [], ["#279b61", "#4a6b5d", "#34d399", "#059669", "#6ee7b7", "#065f46"]));
      charts.push(drawChart("sexDistributionChart", "pie", data?.charts?.sexDistribution?.labels ?? [], data?.charts?.sexDistribution?.data ?? [], ["#3b82f6", "#ec4899"]));
      charts.push(drawChart("statusChart", "pie", data?.charts?.status?.labels ?? [], data?.charts?.status?.data ?? [], ["#279b61", "#f59e0b", "#ef4444", "#6b7280"]));
    }
    if (activeTab === "all" || activeTab === "trends") {
      charts.push(drawChart("dailyTrendsChart", "line", data?.charts?.dailyTrends?.labels ?? [], data?.charts?.dailyTrends?.data ?? [], "rgba(39, 155, 97, 0.45)"));
    }
    if (activeTab === "all" || activeTab === "hourly") {
      charts.push(drawChart("hourlyChart", "bar", data?.charts?.hourly?.labels ?? [], data?.charts?.hourly?.data ?? [], "#4a6b5d"));
    }
    if (activeTab === "all" || activeTab === "status") {
      charts.push(drawChart("statusChart", "pie", data?.charts?.status?.labels ?? [], data?.charts?.status?.data ?? [], ["#279b61", "#f59e0b", "#ef4444", "#6b7280"]));
    }

    return () => charts.forEach((chart) => chart?.destroy());
  }, [data, activeTab]);

  async function loadAnalytics(nextFilters = filters) {
    const params = new URLSearchParams(nextFilters);
    const response = await request(`/analytics?${params.toString()}`);
    setData(response);
  }

  function exportData() {
    window.open(`${API_BASE_URL}/analytics/export?startDate=${filters.startDate}&endDate=${filters.endDate}`, "_blank");
  }

  return (
    <>
      <Script src="https://cdn.jsdelivr.net/npm/chart.js" strategy="beforeInteractive" />
      <SiteFrame
        title="Analytics Dashboard"
        icon="fas fa-chart-bar"
        showSidebar={true}
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
          onExport={exportQueueFromSettings}
        />
        <div className="container mx-auto max-w-6xl px-3 md:px-4">
          <div className="bg-white rounded-lg shadow-md p-3 md:p-4 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base md:text-lg font-bold text-gray-800"><i className="fas fa-filter mr-2 text-sm" />Filter Options</h2>
              <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
                <input type="date" className="px-2 py-1.5 text-sm border border-gray-300 rounded-md w-full sm:w-auto" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
                <input type="date" className="px-2 py-1.5 text-sm border border-gray-300 rounded-md w-full sm:w-auto" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
                <button type="button" onClick={() => loadAnalytics(filters)} className="text-white text-sm px-3 py-1.5 rounded-md hover:opacity-90 transition w-full sm:w-auto" style={{ backgroundColor: "#279b61" }}><i className="fas fa-search mr-1" />Apply</button>
                <button type="button" onClick={exportData} className="text-white text-sm px-3 py-1.5 rounded-md hover:opacity-90 transition w-full sm:w-auto" style={{ backgroundColor: "#1a6b45" }}><i className="fas fa-download mr-1" />Export</button>
              </div>
            </div>
          </div>

          <div className="mb-4 overflow-x-auto">
            <div className="flex border-b border-gray-200">
              <TabButton id="all" active={activeTab} onClick={setActiveTab} label="Detailed Data" icon="fas fa-table" />
              <TabButton id="distribution" active={activeTab} onClick={setActiveTab} label="Distribution" icon="fas fa-chart-pie" />
              <TabButton id="trends" active={activeTab} onClick={setActiveTab} label="Trends" icon="fas fa-chart-line" />
              <TabButton id="hourly" active={activeTab} onClick={setActiveTab} label="Hourly" icon="fas fa-clock" />
              <TabButton id="status" active={activeTab} onClick={setActiveTab} label="Status" icon="fas fa-tasks" />
            </div>
          </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3 mb-4">
            <MetricCard color="blue" icon="fas fa-users" value={data?.metrics?.totalPatients ?? 0} label="Total Patients" />
            <MetricCard color="green" icon="fas fa-clock" value={`${data?.metrics?.avgWaitTime ?? 0}m`} label="Avg Wait Time" />
            <MetricCard color="purple" icon="fas fa-tachometer-alt" value={`${data?.metrics?.avgServiceTime ?? 0}m`} label="Avg Service Time" />
            <MetricCard color="orange" icon="fas fa-percentage" value={`${data?.metrics?.completionRate ?? 0}%`} label="Completion Rate" />
          </div>

          <div className="grid gap-3 md:gap-4 mb-4 grid-cols-1">
            {activeTab === "distribution" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
                <ChartCard title="Service Types Distribution" icon="fas fa-chart-pie" canvasId="serviceTypesChart" />
                <ChartCard title="Sex Distribution" icon="fas fa-venus-mars" canvasId="sexDistributionChart" />
                <ChartCard title="Patient Status" icon="fas fa-tasks" canvasId="statusChart" />
              </div>
            )}
            {activeTab === "trends" && (
              <ChartCard title="Daily Trends" icon="fas fa-chart-line" canvasId="dailyTrendsChart" fullWidth={true} />
            )}
            {activeTab === "hourly" && (
              <ChartCard title="Hourly Distribution" icon="fas fa-chart-bar" canvasId="hourlyChart" fullWidth={true} />
            )}
            {activeTab === "status" && (
              <ChartCard title="Patient Status" icon="fas fa-tasks" canvasId="statusChart" fullWidth={true} />
            )}

            {activeTab === "all" && (
              <div className="bg-white rounded-lg shadow-md p-4 md:p-6 mb-6">
                <h3 className="text-base md:text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                  <i className="fas fa-table text-emerald-800" />
                  Detailed Analytics
                </h3>
                <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm max-w-full">
                  <table className="w-full min-w-[600px] md:min-w-[800px] table-auto border-collapse">
                    <thead>
                      <tr className="bg-gray-50/80 border-b border-gray-200">
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-left">Type</th>
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-center">Total</th>
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-center">Done</th>
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-center">Cancel</th>
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-center">Wait</th>
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-center">Avg Svc</th>
                        <th className="px-6 py-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider text-center">Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(data?.tableData ?? []).map((row) => (
                        <tr key={row.service_type} className="hover:bg-emerald-50/30 transition-colors duration-150">
                          <td className="px-6 py-4 text-sm text-gray-900 font-semibold capitalize">{row.service_type}</td>
                          <td className="px-6 py-4 text-sm text-gray-700 text-center font-medium">{row.total_patients}</td>
                          <td className="px-6 py-4 text-sm text-green-600 text-center font-bold">{row.completed}</td>
                          <td className="px-6 py-4 text-sm text-red-500 text-center font-bold">{row.cancelled}</td>
                          <td className="px-6 py-4 text-sm text-gray-600 text-center">{row.avg_wait_time}m</td>
                          <td className="px-6 py-4 text-sm text-gray-600 text-center">{row.avg_service_time}m</td>
                          <td className="px-6 py-4 text-sm text-emerald-700 text-center font-semibold bg-emerald-50/20">{row.completion_rate}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </SiteFrame>
    </>
  );
}

function MetricCard({ color, icon, value, label }) {
  const palette = {
    blue: "bg-emerald-100 text-emerald-800",
    green: "bg-teal-100 text-teal-800",
    purple: "bg-[#4a6b5d]/20 text-[#1a3d2e]",
    orange: "bg-amber-100 text-amber-900"
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`p-2 rounded-full shrink-0 ${palette[color]}`}>
          <i className={`${icon} text-base md:text-lg`} />
        </div>
        <div className="min-w-0">
          <p className="text-base md:text-lg font-bold text-gray-800 leading-tight tabular-nums">{value}</p>
          <p className="text-[11px] md:text-xs text-gray-600 leading-snug">{label}</p>
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, icon, canvasId, fullWidth = false }) {
  return (
    <div className={`bg-white rounded-lg shadow-md p-3 md:p-4 card-hover ${fullWidth ? "w-full" : ""}`}>
      <h3 className="text-sm md:text-base font-bold text-gray-800 mb-2 flex items-center gap-1.5">
        <i className={`${icon} text-emerald-800 text-sm`} />
        <span className="leading-tight">{title}</span>
      </h3>
      <div className={`chart-container ${fullWidth ? "h-[300px] md:h-[400px]" : "h-[250px]"}`}>
        <canvas id={canvasId} />
      </div>
    </div>
  );
}

function TabButton({ id, active, onClick, label, icon }) {
  const isActive = active === id;
  return (
    <button
      onClick={() => onClick(id)}
      className={`px-4 py-2 text-sm font-medium flex items-center gap-2 border-b-2 transition-colors whitespace-nowrap ${
        isActive
          ? "border-emerald-600 text-emerald-600 bg-emerald-50/50"
          : "border-transparent text-gray-500 hover:text-emerald-600 hover:border-emerald-300"
      }`}
    >
      <i className={icon} />
      {label}
    </button>
  );
}
