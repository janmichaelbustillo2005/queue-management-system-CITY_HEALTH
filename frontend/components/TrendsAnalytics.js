// Superadmin › Analytics › Trends: patient queue activity, patient registrations, service volume,
// outcomes, doctor workload and waiting times over Today, the last 7 or 30 days, the last 12 months
// or a custom range (Asia/Manila). Hour, day or month intervals, chosen by the backend.
// Data: GET /analytics/trends (backend/src/services/rangeAnalyticsService.js).
// Layout (approved design): Patient Queue Activity Trend (wide) beside Patient Volume by Service,
// then Consultation Outcome, Doctor Workload Trend and Average Waiting Time Trend in three columns.
import { useMemo, useState } from "react";
import {
  ACTIVITY_SERIES, DOCTOR_BORDERS, DOCTOR_COLORS, bucketTitle, buildActivityChart, buildAreaLine,
  buildHorizontalBars, buildStatusDoughnut, buildWorkloadChart, comparison, defaultDraft, doctorLabel, finite, formatMinutes,
  formatNumber, formatPercent, isTrendsData, patientLinksText, makeRangeQuery, plural, rangeName, statusMeta, visibleBuckets, windowText
} from "../lib/rangeAnalytics";
import { OFFERED_SERVICES } from "../lib/services";
import {
  Card, ChartCanvas, ChartState, DataTable, ErrorBanner, FilterButtons, KpiCard, Legend, Notes, PageHeader, RangeBar,
  RangeFields, styles, useAnalyticsResource
} from "./AnalyticsDashboard";

const SERVICE_LIMIT = 7;
const INTERVAL = { hour: "hour", day: "day", month: "month" };
const intervalWord = (period) => INTERVAL[period?.granularity] || "day";
const PER_INTERVAL = { hour: "Hourly", day: "Daily", month: "Monthly" };

function minutesValue(metric) {
  return finite(metric?.value) === null ? "No data available" : <>{formatNumber(metric.value, 1)}<span className={styles.kpiUnit}>min</span></>;
}

function Kpis({ data, loading }) {
  const label = data?.comparison_period?.label || "";
  const kpis = data?.kpis;
  const cards = [
    { key: "total_visits", label: "Total Patient Visits", icon: "fas fa-users", tone: "toneGreen", value: formatNumber(kpis?.total_visits?.value) },
    { key: "completed", label: "Completed Consultations", icon: "fas fa-check-circle", tone: "toneGreen", value: formatNumber(kpis?.completed?.value) },
    { key: "new_patient_records", label: "New Patient Records", icon: "fas fa-id-card", tone: "toneBlue", value: formatNumber(kpis?.new_patient_records?.value),
      empty: "Patient records could not be read" },
    { key: "avg_wait_minutes", label: "Average Waiting Time", icon: "far fa-clock", tone: "toneAmber", value: minutesValue(kpis?.avg_wait_minutes),
      empty: "No patient was called in this period" },
    { key: "avg_service_minutes", label: "Average Service Time", icon: "fas fa-stethoscope", tone: "toneBlue", value: minutesValue(kpis?.avg_service_minutes),
      empty: "No consultation was completed in this period" }
  ];
  return (
    <div className={`${styles.kpiGrid} ${styles.kpiGridStatus}`} aria-label="Trend summary">
      {cards.map((card) => {
        const metric = kpis?.[card.key];
        const missing = finite(metric?.value) === null;
        const change = comparison(metric, label);
        return <KpiCard key={card.key} label={card.label} icon={card.icon} tone={card.tone} loading={loading} missing={missing}
          value={card.value} detail={missing && card.empty ? card.empty : change.text} direction={missing ? null : change.direction} />;
      })}
    </div>
  );
}

function ActivityCard({ data, rows, window, loading, hourMode, setHourMode }) {
  const config = useMemo(() => rows.length ? buildActivityChart(rows, data?.period) : null, [rows, data]);
  const hasData = rows.some((row) => ACTIVITY_SERIES.some((series) => (finite(row[series.field]) ?? 0) > 0));
  const hourly = data?.period?.granularity === "hour" && !data?.period?.time_window;
  return (
    <Card icon="fas fa-chart-line" title="Patient Queue Activity Trend" description="Registered, completed, waiting, and cancelled visits over time."
      className={styles.cardFill}
      action={hourly ? (
        <div className={styles.toggle} role="group" aria-label="Hours shown">
          <button type="button" aria-pressed={hourMode === "clinic"} onClick={() => setHourMode("clinic")}>Clinic hours</button>
          <button type="button" aria-pressed={hourMode === "all"} onClick={() => setHourMode("all")}>All 24 hours</button>
        </div>
      ) : null}>
      {loading || !hasData ? <ChartState loading={loading} message="No data available — no visits, completions or cancellations in this period." /> : <>
        <ChartCanvas title="Patient Queue Activity Trend" config={config} height={260} />
        <Legend below items={ACTIVITY_SERIES.map((series) => ({ label: series.label, color: series.color, dashed: series.dashed }))} />
      </>}
      {!loading && hasData && window.trimmed ? <p className={styles.cardNote}>
        Showing {windowText(window)}{window.first < 8 || window.last > 17 ? " (widened to include activity outside 8 AM–5 PM)" : ""}; hidden hours had no activity.
      </p> : null}
    </Card>
  );
}

// Every service with visits in the period, then (when showing all) the offered services with none,
// so the complete list of 13 is one click away.
function allServices(services) {
  const seen = new Set((services || []).map((row) => row.service));
  return [...(services || []), ...OFFERED_SERVICES.filter((service) => !seen.has(service.value)).map((service) => ({ service: service.value, count: 0 }))];
}

function ServiceVolumeCard({ services, loading }) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => showAll ? allServices(services) : services || [], [services, showAll]);
  const limit = showAll ? rows.length : SERVICE_LIMIT;
  const config = useMemo(() => rows.length ? buildHorizontalBars(rows, { label: "Patient visits", limit }) : null, [rows, limit]);
  const hidden = (services || []).slice(SERVICE_LIMIT);
  const hiddenVisits = hidden.reduce((sum, row) => sum + row.count, 0);
  const shownCount = Math.min(limit, rows.length);
  return (
    <Card icon="fas fa-hand-holding-medical" title="Patient Volume by Service" description="Total patient visits per service for the selected period."
      action={!loading && services?.length ? (
        <button type="button" className={styles.linkButton} aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? `Top ${SERVICE_LIMIT}` : "All services"}
        </button>
      ) : null}>
      {loading || !services?.length ? <ChartState loading={loading} message="No data available — no visits registered in this period." />
        : <ChartCanvas title="Patient Volume by Service" config={config} height={Math.max(200, shownCount * (showAll ? 30 : 36) + 48)} />}
      {!loading && !showAll && hidden.length ? <p className={styles.cardNote}>Top {SERVICE_LIMIT} shown; {plural(hidden.length, "other service")} had {plural(hiddenVisits, "visit")}.</p> : null}
    </Card>
  );
}

function OutcomeCard({ outcome, loading }) {
  const config = useMemo(() => outcome?.total ? buildStatusDoughnut(outcome.statuses) : null, [outcome]);
  const completed = outcome?.statuses?.find((row) => row.status === "completed")?.count ?? 0;
  return (
    <Card icon="fas fa-clipboard-check" title="Consultation Outcome" description="Overall result of patient visits.">
      {loading || !outcome?.total ? <ChartState loading={loading} message="No data available — no visits registered in this period." /> : (
        <div className={styles.doughnutLayout}>
          <div className={styles.doughnutBox}>
            <ChartCanvas title="Consultation Outcome" config={config} height="100%" />
            <div className={styles.doughnutCentre} aria-hidden="true"><strong>{formatNumber(completed * 100 / outcome.total, 1)}%</strong><span>Completed</span></div>
          </div>
          <ul className={styles.statusList} aria-label="Visit outcomes">
            {outcome.statuses.map((row) => (
              <li key={row.status}>
                <span className={styles.legendDot} style={{ backgroundColor: statusMeta(row.status).color }} />
                <span>{statusMeta(row.status).label}</span><strong>{formatNumber(row.count)}</strong><small>{formatPercent(row.percentage)}</small>
              </li>
            ))}
            <li className={styles.statusTotal}>
              <span /><span>Total</span><strong>{formatNumber(outcome.total)}</strong><small>100%</small>
            </li>
          </ul>
        </div>
      )}
    </Card>
  );
}

function WorkloadCard({ data, window, loading, names }) {
  const groups = useMemo(() => {
    const all = data?.workload?.groups || [];
    if (!window.trimmed) return all;
    return all.filter((group) => group.hour == null || (group.hour >= window.first && group.hour < window.last));
  }, [data, window]);
  const config = useMemo(() => groups.length ? buildWorkloadChart(data.workload, groups, data.period, names) : null, [groups, data, names]);
  const any = groups.some((group) => Object.values(group.counts || {}).some((value) => (finite(value) ?? 0) > 0));
  const days = data?.workload?.group_days;
  const unattributed = data?.workload?.unattributed;
  return (
    <Card icon="fas fa-user-doctor" title="Doctor Workload Trend" description="Completed consultations per doctor.">
      {loading || !any ? <ChartState loading={loading} message="No data available — no consultation was completed in this period." /> : <>
        <ChartCanvas title="Doctor Workload Trend" config={config} height={210} />
        <Legend below items={(data?.workload?.doctors || []).map((doctor, index) => ({
          label: doctorLabel(doctor, names), color: DOCTOR_COLORS[index % DOCTOR_COLORS.length], border: DOCTOR_BORDERS[index % DOCTOR_BORDERS.length]
        }))} />
      </>}
      {!loading && any ? <p className={styles.cardNote}>
        By completion {data?.period?.granularity === "day" && days > 1 ? `date, in ${days}-day groups` : intervalWord(data?.period)}.
        {unattributed ? ` ${plural(unattributed, "consultation")} with no stored doctor ${unattributed === 1 ? "is" : "are"} not shown.` : ""}
      </p> : null}
    </Card>
  );
}

function WaitTrendCard({ data, rows, loading }) {
  const config = useMemo(() => rows.length ? buildAreaLine(rows, data?.period, { field: "avg_wait_minutes", label: "Average waiting time", unit: "minutes", samplesField: "wait_samples" }) : null, [rows, data]);
  const any = rows.some((row) => finite(row.avg_wait_minutes) !== null);
  return (
    <Card icon="far fa-clock" title="Average Waiting Time Trend"
      description={`${PER_INTERVAL[data?.period?.granularity] || "Daily"} average waiting time in minutes.`}>
      {loading || !any ? <ChartState loading={loading} message="No data available — no patient was called in this period." />
        : <ChartCanvas title="Average Waiting Time Trend" config={config} height={236} />}
      {!loading && any ? <p className={styles.cardNote}>Registration to call, by call time. Gaps had no call.</p> : null}
    </Card>
  );
}

const minutesCell = (value) => finite(value) === null ? <span className={styles.muted}>—</span> : formatMinutes(value);

const countCell = (value) => finite(value) === null ? <span className={styles.muted}>—</span> : formatNumber(value);

function recordColumns(period) {
  const unit = { hour: "Hour", month: "Month" }[period?.granularity] || "Date";
  return [
    { key: "start_at", label: unit, text: (row) => bucketTitle(row, period), sort: (row) => row.start_at },
    { key: "arrivals", label: "Patient Arrivals", numeric: true, text: (row) => formatNumber(row.arrivals) },
    { key: "new_patient_records", label: "New Patient Records", numeric: true, render: (row) => countCell(row.new_patient_records),
      text: (row) => finite(row.new_patient_records) === null ? "" : formatNumber(row.new_patient_records) },
    { key: "completed", label: "Completed", numeric: true, text: (row) => formatNumber(row.completed) },
    { key: "cancelled", label: "Cancelled", numeric: true, text: (row) => formatNumber(row.cancelled) },
    { key: "avg_wait_minutes", label: "Avg Waiting Time", numeric: true, render: (row) => minutesCell(row.avg_wait_minutes),
      csv: (row) => finite(row.avg_wait_minutes) === null ? "" : row.avg_wait_minutes.toFixed(1) },
    { key: "avg_service_minutes", label: "Avg Service Time", numeric: true, render: (row) => minutesCell(row.avg_service_minutes),
      csv: (row) => finite(row.avg_service_minutes) === null ? "" : row.avg_service_minutes.toFixed(1) }
  ];
}

export default function TrendsAnalytics({ enabled = true }) {
  const [draft, setDraft] = useState(() => defaultDraft());
  const [query, setQuery] = useState({ range: "today" });
  const [filterError, setFilterError] = useState("");
  const [hourMode, setHourMode] = useState("clinic");
  const resource = useAnalyticsResource({ enabled, path: "/analytics/trends", params: query, validate: (data) => isTrendsData(data, query) });
  const { data, extra, loading, refreshing, error } = resource;
  const names = extra?.doctor_display_names || {};
  const period = data?.period;
  const window = useMemo(() => visibleBuckets(data?.buckets, period, hourMode), [data, period, hourMode]);
  const rows = window.rows;
  // The table lists every interval that has started (future hours of today are left out).
  const records = useMemo(() => (data?.buckets || []).filter((row) => !row.future).map((row) => ({ ...row, key: row.start_at })), [data]);
  const columns = useMemo(() => recordColumns(period), [period]);
  const empty = data && data.kpis.total_visits.value === 0 && !data.kpis.completed.value && !data.kpis.new_patient_records?.value &&
    !records.some((row) => row.cancelled);

  function apply() {
    try {
      setQuery(makeRangeQuery(draft));
      setFilterError("");
    } catch (problem) {
      setFilterError(problem.message);
    }
  }

  return (
    <section className={styles.dashboard} aria-labelledby="trends-analytics-heading">
      <PageHeader id="trends-analytics-heading" title="Trends Analytics" onSubmit={apply} error={filterError}
        description="Monitor patient queue activity, service performance, and overall trends over time."
        hint={draft.range === "custom" && draft.startDate === draft.endDate ? "Optional hours: an end time before the start continues into the next day." : null}>
        <RangeFields draft={draft} setDraft={setDraft} onChange={() => setFilterError("")} />
        <FilterButtons applyLabel="Apply Range" onRefresh={resource.refresh} refreshing={refreshing} disabled={!enabled || loading || refreshing} />
      </PageHeader>
      <RangeBar period={period} observedAt={data?.observed_at} loading={loading} refreshing={refreshing} rangeLabel={rangeName(query)} />
      <ErrorBanner error={error} stale={Boolean(data)} onRetry={resource.refresh} busy={refreshing} />
      {empty ? <div className={styles.infoBanner}><i className="far fa-calendar" aria-hidden="true" /><span>No queue visits or patient records were recorded in this period. Choose another date range.</span></div> : null}

      <Kpis data={data} loading={loading} />
      {!loading && (data?.comparison_period || patientLinksText(data?.patients)) ? <p className={styles.cardNote} style={{ margin: "-6px 0 0" }}>
        {data?.comparison_period ? `Changes compare with ${data.comparison_period.label.replace(/^vs /, "the ")} (${data.comparison_period.start_date === data.comparison_period.end_date
          ? data.comparison_period.start_date : `${data.comparison_period.start_date} to ${data.comparison_period.end_date}`}); arrows show direction only. ` : ""}
        {data?.samples ? `Waiting time from ${plural(data.samples.wait, "called patient")}; service time from ${plural(data.samples.service, "completed consultation")}. ` : ""}
        {patientLinksText(data?.patients)}
      </p> : null}

      <div className={styles.rowMain}>
        <ActivityCard data={data} rows={rows} window={window} loading={loading} hourMode={hourMode} setHourMode={setHourMode} />
        <ServiceVolumeCard services={data?.services} loading={loading} />
      </div>

      <div className={styles.rowThree}>
        <OutcomeCard outcome={data?.outcome} loading={loading} />
        <WorkloadCard data={data} window={window} loading={loading} names={names} />
        <WaitTrendCard data={data} rows={rows} loading={loading} />
      </div>

      <DataTable title="Trend Records" columns={columns} rows={records} loading={loading} pageSize={period?.granularity === "hour" ? 12 : period?.granularity === "month" ? 12 : 10}
        heading={{ icon: "fas fa-table-list", description: { hour: "Hourly summary of patient queue activity for the selected day.", month: "Monthly summary of patient queue activity for the selected period." }[period?.granularity]
          || "Daily summary of patient queue activity for the selected period." }}
        initialSort={{ key: "start_at", direction: "desc" }} searchLabel={{ hour: "Search hours", month: "Search months" }[period?.granularity] || "Search dates"}
        searchPlaceholder={{ hour: "Search hours...", month: "Search months..." }[period?.granularity] || "Search dates..."}
        emptyMessage="No data available for this period."
        exportName={period ? `trend-records_${period.start_date}_${period.end_date}.csv` : undefined} />

      <Notes notes={data?.notes} />
    </section>
  );
}
