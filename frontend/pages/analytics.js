import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import Script from "next/script";
import SiteFrame from "../components/SiteFrame";
import DailyTrends from "../components/DailyTrends";
import StatusAnalytics from "../components/StatusAnalytics";
import SettingsModal, { defaultQueueSettings } from "../components/SettingsModal";
import { request } from "../lib/api";
import { getDefaultHistoryFilters } from "../lib/historyFilters";
import { TAB_CHARTS, buildAnalyticsCharts, hasChartData, serviceLabel } from "../lib/analyticsCharts";
import {
  clearActiveQueues,
  exportQueueData,
  fetchQueueSettings,
  loadLocalQueueSettings,
  saveQueueSettings as persistQueueSettings
} from "../lib/queueSettings";

// Pinned so a new Chart.js major release cannot change or break these charts.
const CHART_JS_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js";
const defaultSettings = defaultQueueSettings;
const emptyChart = { labels: [], data: [] };
const emptyAnalyticsData = {
  metrics: { totalPatients: 0, avgWaitTime: 0, avgServiceTime: 0, completionRate: 0 },
  charts: {
    serviceTypes: emptyChart, sexDistribution: emptyChart, dailyTrends: emptyChart, hourly: emptyChart,
    status: emptyChart, priorityCategories: emptyChart, ageGroups: emptyChart, residency: emptyChart
  },
  tableData: [],
  totals: null,
  doctorTable: []
};
// The top filter bar drives these tabs; Status (and the single-day section of
// Trends) use their own date selectors.
const FILTERED_TABS = ["all", "distribution"];

export default function AnalyticsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const loadSequence = useRef(0);
  const [apiError, setApiError] = useState(null);
  const [activeTab, setActiveTab] = useState("all");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!loading && (!user || user.role !== "superadmin")) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const [settings, setSettings] = useState(defaultSettings);
  const [filters, setFilters] = useState({ status: "", service: "", doctor: "", dateFilter: "range", date: "", startDate: "", endDate: "" });
  const [defaultsReady, setDefaultsReady] = useState(false);
  const [data, setData] = useState(emptyAnalyticsData);

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

  useEffect(() => {
    setFilters(getDefaultHistoryFilters());
    setDefaultsReady(true);
  }, []);

  useEffect(() => {
    if (defaultsReady && user?.role === "superadmin") loadAnalytics(filters);
    else {
      loadSequence.current += 1;
      setData(emptyAnalyticsData);
    }
  }, [user, defaultsReady]);

  // Draw only the canvases the active tab renders; a chart with no data shows
  // a placeholder instead of a canvas, so it is skipped here.
  useEffect(() => {
    const canvasIds = TAB_CHARTS[activeTab] || [];
    if (!canvasIds.length || typeof window === "undefined" || !window.Chart) return undefined;
    const theme = getComputedStyle(document.documentElement);
    const configs = buildAnalyticsCharts(data?.charts, {
      primary: theme.getPropertyValue("--brand-primary").trim(),
      forest: theme.getPropertyValue("--brand-forest").trim()
    });
    const charts = canvasIds.map((canvasId) => {
      const canvas = document.getElementById(canvasId);
      return canvas ? new window.Chart(canvas.getContext("2d"), configs[canvasId]) : null;
    });
    return () => charts.forEach((chart) => chart?.destroy());
  }, [data, activeTab]);

  async function loadAnalytics(nextFilters = filters) {
    const sequence = ++loadSequence.current;
    setData(emptyAnalyticsData);
    setApiError(null);
    try {
      const params = new URLSearchParams(nextFilters);
      const response = await request(`/analytics?${params.toString()}`);
      if (sequence !== loadSequence.current) return;
      if (response.error) throw new Error(response.error);
      setData(response);
    } catch (error) {
      if (sequence === loadSequence.current) setApiError(error.message || "Failed to load analytics");
    }
  }

  async function exportData() {
    setApiError(null);
    try {
      const response = await request(`/analytics/export?${new URLSearchParams(filters).toString()}`);
      if (response.error) throw new Error(response.error);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `analytics_${filters.startDate || filters.date || "all"}_${filters.endDate || filters.date || "dates"}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        window.URL.revokeObjectURL(url);
      }
    } catch (error) {
      setApiError(error.message || "Failed to export analytics");
    }
  }

  const charts = data?.charts || emptyAnalyticsData.charts;

  return (
    <>
      <Script src={CHART_JS_URL} strategy="beforeInteractive" />
      <SiteFrame
        title="Analytics"
        icon="fas fa-chart-bar"
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
          {apiError && <div role="alert" className="bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded mb-4">{apiError}</div>}
          <div className="bg-white rounded-lg shadow-md p-3 md:p-4 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base md:text-lg font-bold brand-text"><i className="fas fa-filter mr-2 text-sm" />Filter Options</h2>
              <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
                <select aria-label="Date filter" className="px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.dateFilter} onChange={(e) => setFilters({ ...filters, dateFilter: e.target.value, date: "", startDate: "", endDate: "" })}>
                  <option value="">All Time</option><option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="date">Specific Date</option><option value="range">Date Range</option>
                </select>
                {filters.dateFilter === "date" && <input aria-label="Specific date" type="date" className="px-2 py-1.5 text-sm border brand-input rounded-md w-full sm:w-auto" value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} />}
                {filters.dateFilter === "range" && <>
                  <input aria-label="Start date" type="date" className="px-2 py-1.5 text-sm border brand-input rounded-md w-full sm:w-auto" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
                  <input aria-label="End date" type="date" className="px-2 py-1.5 text-sm border brand-input rounded-md w-full sm:w-auto" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
                </>}
                <select aria-label="Service" className="px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.service} onChange={(e) => setFilters({ ...filters, service: e.target.value })}>
                  <option value="">All Services</option><option value="consultation">General Consultation</option><option value="checkup">Medical Check-up</option><option value="prenatal">Prenatal</option><option value="maternity">Maternity</option><option value="family_planning">Family Planning</option>
                </select>
                <select aria-label="Doctor" className="px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.doctor} onChange={(e) => setFilters({ ...filters, doctor: e.target.value })}>
                  <option value="">All Doctors</option>{[1, 2, 3].map((number) => <option key={number} value={`Doctor ${number}`}>Doctor {number}</option>)}
                </select>
                <select aria-label="Status" className="px-2 py-1.5 text-sm border brand-input rounded-md" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                  <option value="">All Status</option><option value="waiting">Waiting</option><option value="serving">Serving</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="no-show">No-show</option>
                </select>
                <button type="button" onClick={() => loadAnalytics(filters)} className="brand-button text-sm px-3 py-1.5 rounded-md transition w-full sm:w-auto"><i className="fas fa-search mr-1" />Apply</button>
                <button type="button" onClick={exportData} className="brand-button text-sm px-3 py-1.5 rounded-md transition w-full sm:w-auto"><i className="fas fa-download mr-1" />Export</button>
              </div>
            </div>
            {activeTab === "status" && (
              <p className="text-xs brand-text-muted mt-3 mb-0">
                <i className="fas fa-info-circle mr-1" />
                Status Analytics uses its own date selector below. These filters apply to Detailed Data, Distribution and the period charts in Trends.
              </p>
            )}
          </div>

          <div className="mb-4 overflow-x-auto">
            <div className="flex border-b brand-border">
              <TabButton id="all" active={activeTab} onClick={setActiveTab} label="Detailed Data" icon="fas fa-table" />
              <TabButton id="distribution" active={activeTab} onClick={setActiveTab} label="Distribution" icon="fas fa-chart-pie" />
              <TabButton id="trends" active={activeTab} onClick={setActiveTab} label="Trends" icon="fas fa-chart-line" />
              <TabButton id="status" active={activeTab} onClick={setActiveTab} label="Status" icon="fas fa-tasks" />
            </div>
          </div>

          {FILTERED_TABS.includes(activeTab) && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3 mb-4">
              <MetricCard color="blue" icon="fas fa-users" value={data?.metrics?.totalPatients ?? 0} label="Total Patients" />
              <MetricCard color="green" icon="fas fa-clock" value={`${data?.metrics?.avgWaitTime ?? 0}m`} label="Avg Wait Time" />
              <MetricCard color="purple" icon="fas fa-tachometer-alt" value={`${data?.metrics?.avgServiceTime ?? 0}m`} label="Avg Service Time" />
              <MetricCard color="orange" icon="fas fa-percentage" value={`${data?.metrics?.completionRate ?? 0}%`} label="Completion Rate" />
            </div>
          )}

          <div className="grid gap-3 md:gap-4 mb-4 grid-cols-1">
            {activeTab === "distribution" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
                <ChartCard title="Service Types" icon="fas fa-chart-pie" canvasId="serviceTypesChart" empty={!hasChartData(charts.serviceTypes)} />
                <ChartCard title="Sex Distribution" icon="fas fa-venus-mars" canvasId="sexDistributionChart" empty={!hasChartData(charts.sexDistribution)} />
                <ChartCard title="Priority Categories" icon="fas fa-star" canvasId="priorityChart" empty={!hasChartData(charts.priorityCategories)}
                  note="A visit can belong to more than one priority category, so the bars can add up to more than the total." />
                <ChartCard title="Age Groups" icon="fas fa-birthday-cake" canvasId="ageGroupChart" empty={!hasChartData(charts.ageGroups)}
                  note="Age on the day of the visit, from the recorded birthdate." />
                <div className="lg:col-span-2">
                  <ChartCard title="Residency (Top Locations)" icon="fas fa-map-marker-alt" canvasId="residencyChart" empty={!hasChartData(charts.residency)}
                    note="The eight most common recorded locations; the rest are grouped as Other locations." />
                </div>
              </div>
            )}

            {activeTab === "trends" && (
              <>
                <SectionHeading title="Selected Period" description="Uses the filters above." />
                <ChartCard title="Patients per Day" icon="fas fa-chart-line" canvasId="patientsPerDayChart" fullWidth empty={!hasChartData(charts.dailyTrends)}
                  note="Registered visits per day (Asia/Manila). Days without visits show as zero." />
                <ChartCard title="Arrivals by Hour" icon="fas fa-clock" canvasId="arrivalsByHourChart" fullWidth empty={!hasChartData(charts.hourly)}
                  note="Registrations per hour of the day across the whole selected period, in clock order." />
                <SectionHeading title="Single-Day Detail" description="Hour-by-hour activity for one day. Choose the day with the date selector in this section." />
                <DailyTrends enabled={!loading && user?.role === "superadmin"} />
              </>
            )}

            {activeTab === "status" && (
              <StatusAnalytics enabled={!loading && user?.role === "superadmin"} />
            )}

            {activeTab === "all" && (
              <>
                <SummaryTable
                  title="By Service"
                  icon="fas fa-table"
                  firstColumn="Service"
                  rows={(data?.tableData ?? []).map((row) => ({ key: row.service_type, name: serviceLabel(row.service_type), ...row }))}
                  totals={data?.totals}
                />
                <SummaryTable
                  title="By Doctor"
                  icon="fas fa-user-md"
                  firstColumn="Doctor"
                  rows={(data?.doctorTable ?? []).map((row) => ({ key: row.doctor, name: row.doctor, ...row }))}
                  totals={data?.totals}
                />
              </>
            )}
          </div>
        </div>
      </SiteFrame>
    </>
  );
}

function MetricCard({ color, icon, value, label }) {
  const palette = {
    blue: "brand-bg-subtle brand-text-primary",
    green: "bg-teal-100 text-teal-800",
    purple: "brand-accent-badge",
    orange: "bg-amber-100 text-amber-900"
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-2.5 md:p-3 card-hover">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`p-2 rounded-full shrink-0 ${palette[color]}`}>
          <i className={`${icon} text-base md:text-lg`} />
        </div>
        <div className="min-w-0">
          <p className="text-base md:text-lg font-bold brand-text leading-tight tabular-nums">{value}</p>
          <p className="text-[11px] md:text-xs brand-text-muted leading-snug">{label}</p>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ title, description }) {
  return (
    <div className="mt-1">
      <h3 className="text-sm md:text-base font-bold brand-text mb-0.5">{title}</h3>
      <p className="text-xs brand-text-muted mb-0">{description}</p>
    </div>
  );
}

function ChartCard({ title, icon, canvasId, fullWidth = false, empty = false, note = "" }) {
  return (
    <div className={`bg-white rounded-lg shadow-md p-3 md:p-4 card-hover ${fullWidth ? "w-full" : ""}`}>
      <h3 className="text-sm md:text-base font-bold brand-text mb-2 flex items-center gap-1.5">
        <i className={`${icon} brand-text-primary text-sm`} />
        <span className="leading-tight">{title}</span>
      </h3>
      <div className={`chart-container ${fullWidth ? "h-[280px] md:h-[320px]" : "h-[260px]"}`}>
        {empty ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 brand-text-muted text-sm" role="status">
            <i className="fas fa-chart-bar text-2xl opacity-40" />
            No data for the selected filters
          </div>
        ) : (
          <canvas id={canvasId} role="img" aria-label={title} />
        )}
      </div>
      {note ? <p className="text-[11px] brand-text-muted mt-2 mb-0">{note}</p> : null}
    </div>
  );
}

const SUMMARY_COLUMNS = [
  { key: "total_patients", label: "Total" },
  { key: "completed", label: "Completed", className: "text-green-700 font-bold" },
  { key: "cancelled", label: "Cancelled", className: "text-red-600 font-bold" },
  { key: "no_show", label: "No-show", className: "text-rose-700 font-bold" },
  { key: "in_queue", label: "In Queue", title: "Still waiting or being served" },
  { key: "avg_wait_time", label: "Avg Wait", suffix: "m", className: "brand-text-muted" },
  { key: "avg_service_time", label: "Avg Service", suffix: "m", className: "brand-text-muted" },
  { key: "completion_rate", label: "Completion", suffix: "%", className: "text-emerald-700 font-semibold" }
];

function summaryValue(row, column) {
  if (column.key === "in_queue") return (Number(row.waiting) || 0) + (Number(row.serving) || 0);
  const value = row[column.key] ?? 0;
  return column.suffix ? `${value}${column.suffix}` : value;
}

function SummaryTable({ title, icon, firstColumn, rows, totals }) {
  const cellClass = "px-4 md:px-6 py-3 text-sm text-center";
  const headClass = "px-4 md:px-6 py-3 text-[11px] font-bold brand-text-muted uppercase tracking-wider text-center";
  return (
    <div className="bg-white rounded-lg shadow-md p-4 md:p-6">
      <h3 className="text-base md:text-lg font-bold brand-text mb-4 flex items-center gap-2">
        <i className={`${icon} brand-text-primary`} />
        {title}
      </h3>
      <div className="overflow-x-auto rounded-xl border brand-border shadow-sm max-w-full">
        <table className="w-full min-w-[760px] table-auto border-collapse">
          <thead>
            <tr className="brand-bg-subtle border-b brand-border">
              <th className={`${headClass} text-left`}>{firstColumn}</th>
              {SUMMARY_COLUMNS.map((column) => <th key={column.key} className={headClass} title={column.title}>{column.label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length ? rows.map((row) => (
              <tr key={row.key} className="brand-hover-subtle transition-colors duration-150">
                <td className="px-4 md:px-6 py-3 text-sm brand-text font-semibold">{row.name}</td>
                {SUMMARY_COLUMNS.map((column) => <td key={column.key} className={`${cellClass} ${column.className || "brand-text"}`}>{summaryValue(row, column)}</td>)}
              </tr>
            )) : (
              <tr><td colSpan={SUMMARY_COLUMNS.length + 1} className={`${cellClass} brand-text-muted`}>No visits match the selected filters.</td></tr>
            )}
          </tbody>
          {rows.length && totals ? (
            <tfoot>
              <tr className="brand-bg-subtle border-t-2 brand-border">
                <th scope="row" className="px-4 md:px-6 py-3 text-sm brand-text font-bold text-left">All</th>
                {SUMMARY_COLUMNS.map((column) => <td key={column.key} className={`${cellClass} font-bold brand-text`}>{summaryValue(totals, column)}</td>)}
              </tr>
            </tfoot>
          ) : null}
        </table>
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
          ? "brand-tab"
          : "brand-tab-inactive"
      }`}
    >
      <i className={icon} />
      {label}
    </button>
  );
}
