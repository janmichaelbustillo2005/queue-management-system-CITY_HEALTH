import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import Script from "next/script";
import SiteFrame from "../components/SiteFrame";
import TrendsAnalytics from "../components/TrendsAnalytics";
import StatusAnalytics from "../components/StatusAnalytics";
import { DetailedInsights } from "../components/AnalyticsInsights";
import ServiceAnalytics from "../components/ServiceAnalytics";
import { PageHeader, styles } from "../components/AnalyticsDashboard";
import SettingsModal, { defaultQueueSettings } from "../components/SettingsModal";
import { request } from "../lib/api";
import { SERVICE_FILTER_OPTIONS } from "../lib/services";
import { getDefaultHistoryFilters } from "../lib/historyFilters";
import { TAB_CHARTS, buildAnalyticsCharts, hasChartData } from "../lib/analyticsCharts";
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
// The page filters drive these tabs; Trends and Status keep their own date-range state.
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
  // The filters the shown figures were loaded with (the form above may hold unapplied edits).
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [defaultsReady, setDefaultsReady] = useState(false);
  const [data, setData] = useState(emptyAnalyticsData);
  // "loading" | "ready" | "error", for the By Service cards' loading and error states.
  const [loadState, setLoadState] = useState("loading");

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
    setAppliedFilters(nextFilters);
    setData(emptyAnalyticsData);
    setLoadState("loading");
    setApiError(null);
    try {
      const params = new URLSearchParams(nextFilters);
      const response = await request(`/analytics?${params.toString()}`);
      if (sequence !== loadSequence.current) return;
      if (response.error) throw new Error(response.error);
      setData(response);
      setLoadState("ready");
    } catch (error) {
      if (sequence === loadSequence.current) {
        setApiError(error.message || "Failed to load analytics");
        setLoadState("error");
      }
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
        <div className="container mx-auto max-w-screen-2xl px-3 md:px-4">
          {apiError && <div role="alert" className="bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded mb-4">{apiError}</div>}
          <div className="mb-4 overflow-x-auto">
            <div className="flex border-b brand-border">
              <TabButton id="all" active={activeTab} onClick={setActiveTab} label="Detailed Data" icon="fas fa-table" />
              <TabButton id="distribution" active={activeTab} onClick={setActiveTab} label="Distribution" icon="fas fa-chart-pie" />
              <TabButton id="trends" active={activeTab} onClick={setActiveTab} label="Trends" icon="fas fa-chart-line" />
              <TabButton id="status" active={activeTab} onClick={setActiveTab} label="Status" icon="fas fa-tasks" />
            </div>
          </div>

          {FILTERED_TABS.includes(activeTab) && (
            <>
              {analyticsFilters({
                panel: activeTab === "distribution", filters, setFilters,
                onApply: () => loadAnalytics(filters), onExport: exportData,
                onReset: () => { const defaults = getDefaultHistoryFilters(); setFilters(defaults); loadAnalytics(defaults); },
                busy: loadState === "loading", error: activeTab === "distribution" ? apiError : ""
              })}
              <p className={styles.filterSummary} role="status">
                {loadState === "loading" ? "Loading…" : <>Showing: <strong className="brand-text">{describeFilters(appliedFilters)}</strong>.</>}
              </p>
            </>
          )}
        </div>
        <div className={`container mx-auto ${FILTERED_TABS.includes(activeTab) ? "max-w-6xl" : "max-w-screen-2xl"} px-3 md:px-4`}>
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
                <ChartCard title="Percentage of Patients per Service" icon="fas fa-chart-pie" canvasId="serviceTypesChart" empty={!hasChartData(charts.serviceTypes)} />
                <ChartCard title="Sex Distribution" icon="fas fa-venus-mars" canvasId="sexDistributionChart" empty={!hasChartData(charts.sexDistribution)} />
                <ChartCard title="Registered Patients per Categories" icon="fas fa-star" canvasId="priorityChart" empty={!hasChartData(charts.priorityCategories)}
                  note="A visit can belong to more than one priority category, so the bars can add up to more than the total." />
                <ChartCard title="Patient Age Groups" icon="fas fa-birthday-cake" canvasId="ageGroupChart" empty={!hasChartData(charts.ageGroups)}
                  note="Patient age groups calculated from birthdate as of the visit date. Visits without a valid birthdate are shown as Not recorded." />
                <div className="lg:col-span-2">
                  <ChartCard title="Patient Residency Distribution" icon="fas fa-map-marker-alt" canvasId="residencyChart" empty={!hasChartData(charts.residency)}
                    note="The eight most common recorded locations; the rest are grouped as Other locations." />
                </div>
                <div className="lg:col-span-2">
                  <ChartCard title="Patients per Day" icon="fas fa-chart-line" canvasId="patientsPerDayChart" fullWidth empty={!hasChartData(charts.dailyTrends)}
                    note="Registered visits per day (Asia/Manila). Days without visits show as zero." />
                </div>
                <div className="lg:col-span-2">
                  <ChartCard title="Patient Arrival by Hour" icon="fas fa-clock" canvasId="arrivalsByHourChart" fullWidth empty={!hasChartData(charts.hourly)}
                    note="Registrations per hour of the day across the whole selected period, in clock order." />
                </div>
              </div>
            )}

            {activeTab === "trends" && (
              <TrendsAnalytics enabled={!loading && user?.role === "superadmin"} />
            )}

            {activeTab === "status" && (
              <StatusAnalytics enabled={!loading && user?.role === "superadmin"} />
            )}

            {activeTab === "all" && (
              <>
                <ServiceAnalytics tableData={data?.tableData} totals={data?.totals} wait={data?.insights?.wait} status={loadState} />
                <SummaryTable
                  title="By Doctor"
                  icon="fas fa-user-md"
                  firstColumn="Doctor"
                  rows={(data?.doctorTable ?? []).map((row) => ({ key: row.doctor, name: row.doctor, ...row }))}
                  totals={data?.totals}
                />
                <DetailedInsights insights={data?.insights} />
              </>
            )}
          </div>
        </div>
      </SiteFrame>
    </>
  );
}

const DATE_FILTER_OPTIONS = [
  { value: "", label: "All Time" }, { value: "today", label: "Today" }, { value: "week", label: "This Week" },
  { value: "month", label: "This Month" }, { value: "date", label: "Specific Date" }, { value: "range", label: "Date Range" }
];
const STATUS_FILTER_OPTIONS = [
  { value: "waiting", label: "Waiting" }, { value: "serving", label: "Serving" },
  { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }
];
const DOCTOR_FILTER_OPTIONS = ["Doctor 1", "Doctor 2", "Doctor 3"];

function formatFilterDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

// One line naming the period and filters the figures were loaded with.
function describeFilters(filters = {}) {
  let period = DATE_FILTER_OPTIONS.find((option) => option.value === (filters.dateFilter || ""))?.label || "All Time";
  if (filters.dateFilter === "date") period = formatFilterDate(filters.date) || "Specific Date";
  if (filters.dateFilter === "range") {
    const start = formatFilterDate(filters.startDate);
    const end = formatFilterDate(filters.endDate);
    period = start && end ? (start === end ? start : `${start} – ${end}`) : start ? `From ${start}` : end ? `Until ${end}` : "All Time";
  }
  const service = SERVICE_FILTER_OPTIONS.find((option) => option.value === filters.service)?.label;
  const status = STATUS_FILTER_OPTIONS.find((option) => option.value === filters.status)?.label;
  return [period, service || "All Services", filters.doctor || "All Doctors", status || "All Status"].join(" · ");
}

// Both tabs share the header layout and the page's existing filter state and actions.
// A plain render function (no hooks), so its controls stay in the page's element tree.
function analyticsFilters({ filters, setFilters, onApply, onExport, onReset, panel = false, busy = false, error = "" }) {
  const field = (label, input, width = "") => <label className={`${styles.field} ${width}`}>{label}{input}</label>;
  const id = panel ? "distribution-filters-heading" : "detailed-filters-heading";
  const fields = (
    <>
      {field("Date", <select aria-label="Date filter" value={filters.dateFilter} onChange={(e) => setFilters({ ...filters, dateFilter: e.target.value, date: "", startDate: "", endDate: "" })}>
        {DATE_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>, styles.presetField)}
      {filters.dateFilter === "date" && field("Specific date", <input aria-label="Specific date" type="date" value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} />, styles.dateField)}
      {filters.dateFilter === "range" && <>
        {field("Start date", <input aria-label="Start date" type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />, styles.dateField)}
        {field("End date", <input aria-label="End date" type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />, styles.dateField)}
      </>}
      {field("Service", <select aria-label="Service" value={filters.service} onChange={(e) => setFilters({ ...filters, service: e.target.value })}>
        <option value="">All Services</option>{SERVICE_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>, styles.serviceField)}
    </>
  );
  const remainingFields = (
    <>
      {field("Doctor", <select aria-label="Doctor" value={filters.doctor} onChange={(e) => setFilters({ ...filters, doctor: e.target.value })}>
        <option value="">All Doctors</option>{DOCTOR_FILTER_OPTIONS.map((doctor) => <option key={doctor} value={doctor}>{doctor}</option>)}
      </select>, styles.doctorField)}
      {field("Status", <select aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
        <option value="">All Status</option>{STATUS_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>)}
    </>
  );

  const actions = (
    <div className={styles.filterButtons}>
      <button type={panel ? "submit" : "button"} onClick={panel ? undefined : onApply} disabled={panel && busy} className={styles.primaryButton}><i className="fas fa-search" aria-hidden="true" />Apply</button>
      {panel ? <button type="button" disabled={busy} onClick={onReset} className={styles.secondaryButton}><i className="fas fa-undo" aria-hidden="true" />Reset</button> : null}
      <button type="button" onClick={onExport} className={styles.primaryButton}><i className="fas fa-download" aria-hidden="true" />Export</button>
    </div>
  );
  return (
    <PageHeader id={id} formLabelledBy={id} title={panel ? "Distribution Analytics" : "Detailed Data"} onSubmit={onApply} error={error}
      description={panel ? "View patient distributions by service, sex, priority category, age, residency, and arrival period." : "Review patient visits and service performance by service and doctor for the selected period."}>
      {fields}
      {remainingFields}
      {actions}
    </PageHeader>
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
