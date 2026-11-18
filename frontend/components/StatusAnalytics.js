// Superadmin › Analytics › Status: where the visits registered in the selected period stand, by
// doctor and service, completions over time and average times, with the visit records behind them.
// Data: GET /analytics/status/overview and /analytics/status/records (rangeAnalyticsService.js).
// Layout (approved design): Queue Status Distribution, Visits by Doctor and Visits by Service (Top 5)
// in three columns; Completion Trend beside Average Times; then the full-width Queue Status Records.
// The records carry the queue ticket and the patient's name as registered (the endpoint is
// superadmin-only, like Patient Records); no other patient detail is requested.
import { useMemo, useRef, useState } from "react";
import {
  STATUS_META, buildAreaLine, buildDoctorBars, buildHorizontalBars, buildStatusDoughnut, defaultDraft, doctorLabel, finite,
  formatNumber, formatPercent, isStatusOverviewData, makeRangeQuery, patientLinksText, plural, rangeName, readableDateTime, readableTime,
  samePeriod, statusMeta, visibleBuckets, windowText
} from "../lib/rangeAnalytics";
import { SERVICE_FILTER_OPTIONS, serviceName } from "../lib/services";
import {
  Card, ChartCanvas, ChartState, DataTable, ErrorBanner, FilterButtons, KpiCard, Notes, PageHeader, RangeBar, RangeFields,
  styles, useAnalyticsResource
} from "./AnalyticsDashboard";

const DEFAULT_DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const STATUS_ORDER = ["completed", "waiting", "serving", "cancelled"];
const BADGES = { completed: "badgeCompleted", waiting: "badgeWaiting", serving: "badgeServing", cancelled: "badgeCancelled" };

const CARDS = [
  { key: "total", label: "Total Visits", icon: "fas fa-users", tone: "toneBlue" },
  { key: "waiting", label: "Waiting", icon: "fas fa-hourglass-half", tone: "toneAmber" },
  { key: "serving", label: "Serving", icon: "fas fa-user-md", tone: "toneBlue" },
  { key: "completed", label: "Completed", icon: "fas fa-check-circle", tone: "toneGreen" },
  { key: "cancelled", label: "Cancelled", icon: "fas fa-times-circle", tone: "toneRed" }
];

function StatusCards({ cohort, loading }) {
  const total = finite(cohort?.total);
  const count = (status) => cohort?.statuses?.find((row) => row.status === status)?.count ?? 0;
  const extra = (cohort?.statuses || []).filter((row) => !STATUS_ORDER.includes(row.status) && row.count > 0);
  return (
    <>
      <div className={`${styles.kpiGrid} ${styles.kpiGridStatus}`} aria-label="Queue status summary">
        {CARDS.map((card) => {
          const value = card.key === "total" ? total : count(card.key);
          const detail = card.key === "total" ? "Registered in this period"
            : total ? `${formatPercent(value * 100 / total)} of total visits` : "No visits in this period";
          return <KpiCard key={card.key} label={card.label} icon={card.icon} tone={card.tone} loading={loading}
            value={formatNumber(value)} missing={value === null} detail={detail} />;
        })}
      </div>
      {!loading && extra.length ? <p className={styles.cardNote}>Also included in Total Visits: {extra.map((row) => `${plural(row.count, "visit")} with status “${statusMeta(row.status).label}”`).join(", ")}.</p> : null}
    </>
  );
}

function DistributionCard({ cohort, loading }) {
  const config = useMemo(() => cohort?.total ? buildStatusDoughnut(cohort.statuses) : null, [cohort]);
  return (
    <Card icon="fas fa-chart-pie" title="Queue Status Distribution">
      {loading || !cohort?.total ? <ChartState loading={loading} message="No data available — no visits match these filters." /> : (
        <div className={styles.doughnutLayout}>
          <div className={styles.doughnutBox}>
            <ChartCanvas title="Queue Status Distribution" config={config} height="100%" />
            <div className={styles.doughnutCentre} aria-hidden="true"><strong>{formatNumber(cohort.total)}</strong><span>Total Visits</span></div>
          </div>
          <ul className={styles.statusList} aria-label="Visit statuses">
            {cohort.statuses.map((row) => (
              <li key={row.status}>
                <span className={styles.legendDot} style={{ backgroundColor: statusMeta(row.status).color }} />
                <span>{statusMeta(row.status).label}</span><strong>{formatNumber(row.count)}</strong><small>{formatPercent(row.percentage)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function DoctorCard({ byDoctor, loading, names }) {
  const doctors = byDoctor?.doctors || [];
  const config = useMemo(() => doctors.length ? buildDoctorBars(doctors, names) : null, [doctors, names]);
  const any = doctors.some((row) => row.total > 0);
  return (
    <Card icon="fas fa-user-doctor" title="Visits by Doctor">
      {loading || !any ? <ChartState loading={loading} message="No data available — no visits assigned to a doctor." />
        : <ChartCanvas title="Visits by Doctor" config={config} height={196} />}
      {!loading ? <p className={styles.cardNote}>
        Assigned visits, any status.{byDoctor?.unassigned ? ` ${plural(byDoctor.unassigned, "unassigned visit")} not shown.` : ""}
      </p> : null}
    </Card>
  );
}

function ServiceCard({ services, loading }) {
  const config = useMemo(() => services?.length ? buildHorizontalBars(services, { label: "Visits", limit: 5 }) : null, [services]);
  const others = (services || []).slice(5);
  return (
    <Card icon="fas fa-hand-holding-medical" title="Visits by Service (Top 5)">
      {loading || !services?.length ? <ChartState loading={loading} message="No data available — no visits match these filters." />
        : <ChartCanvas title="Visits by Service (Top 5)" config={config} height={Math.max(160, Math.min(5, services.length) * 34 + 46)} />}
      {!loading && others.length ? <p className={styles.cardNote}>{plural(others.length, "other service")}: {plural(others.reduce((sum, row) => sum + row.count, 0), "visit")}.</p> : null}
    </Card>
  );
}

function CompletionCard({ data, loading }) {
  const window = useMemo(() => visibleBuckets(data?.completion_trend, data?.period, "clinic"), [data]);
  const rows = window.rows;
  const config = useMemo(() => rows.length ? buildAreaLine(rows, data?.period, { field: "completed", label: "Completed", labels: rows.length <= 31 }) : null, [rows, data]);
  const any = rows.some((row) => (finite(row.completed) ?? 0) > 0);
  const total = rows.reduce((sum, row) => sum + (finite(row.completed) ?? 0), 0);
  return (
    <Card icon="fas fa-chart-line" title="Completion Trend">
      {loading || !any ? <ChartState loading={loading} message={data?.filters?.status && data.filters.status !== "completed"
        ? "No data available — the status filter excludes completed visits." : "No data available — no consultation was completed in this period."} />
        : <ChartCanvas title="Completion Trend" config={config} height={200} />}
      {!loading && any ? <p className={styles.cardNote}>
        {plural(total, "consultation")} completed, by completion time{window.trimmed ? `; ${windowText(window)}` : ""}.
      </p> : null}
    </Card>
  );
}

function TimePanel({ icon, title, value, samples, sampleWord, description }) {
  const known = finite(value) !== null;
  return (
    <div className={styles.timePanel}>
      <span className={styles.timeIcon}><i className={icon} aria-hidden="true" /></span>
      <div className={styles.timeText}>
        <h4>{title}</h4>
        {known ? <p className={styles.timeValue}>{formatNumber(value, 1)}<small>mins</small></p> : <p className={styles.timeMissing}>No data available</p>}
        <p>{description}</p>
        {known ? <p className={styles.timeSamples}>Based on {plural(samples, sampleWord)}</p> : null}
      </div>
    </div>
  );
}

function TimesCard({ times, loading }) {
  return (
    <Card icon="far fa-clock" title="Average Times">
      {loading ? <ChartState loading /> : (
        <div className={styles.timePanels}>
          <TimePanel icon="fas fa-hourglass-half" title="Average Waiting Time" value={times?.avg_wait_minutes} samples={times?.wait_samples} sampleWord="called patient"
            description="From registration to call" />
          <TimePanel icon="fas fa-stethoscope" title="Average Service Time" value={times?.avg_service_minutes} samples={times?.service_samples} sampleWord="completed consultation"
            description="From consultation start to completion" />
        </div>
      )}
    </Card>
  );
}

function recordColumns(names, singleDay) {
  // One day: clock times only (as in the approved design). Longer ranges keep the date.
  const format = singleDay ? readableTime : readableDateTime;
  const time = (value) => value ? format(value) : null;
  const cell = (value) => value ? format(value) : <span className={styles.muted}>—</span>;
  return [
    { key: "ticket", label: "Queue Ticket", text: (row) => row.ticket || "—", render: (row) => <strong>{row.ticket || "—"}</strong> },
    { key: "patient_name", label: "Patient Name", text: (row) => row.patient_name || "",
      render: (row) => row.patient_name || <span className={styles.muted}>Not recorded</span> },
    { key: "service", label: "Service", text: (row) => row.service === "not_recorded" ? "Not recorded" : serviceName(row.service) },
    { key: "doctor", label: "Doctor", text: (row) => row.doctor ? doctorLabel(row.doctor, names) : "Unassigned",
      render: (row) => row.doctor ? doctorLabel(row.doctor, names) : <span className={styles.muted}>Unassigned</span> },
    { key: "registered_at", label: "Registration Time", text: (row) => time(row.registered_at) || "", render: (row) => cell(row.registered_at), sort: (row) => row.registered_at },
    { key: "called_at", label: "Call Time", text: (row) => time(row.called_at) || "", render: (row) => cell(row.called_at), sort: (row) => row.called_at },
    { key: "completed_at", label: "Completion Time", text: (row) => time(row.completed_at) || "",
      csv: (row) => time(row.completed_at) || "",
      render: (row) => row.completed_at ? format(row.completed_at)
        : row.cancelled_at ? <span className={styles.muted}>Cancelled {readableTime(row.cancelled_at)}</span> : <span className={styles.muted}>—</span>,
      sort: (row) => row.completed_at },
    { key: "status", label: "Status", text: (row) => statusMeta(row.status).label,
      render: (row) => (
        <span className={`${styles.badge} ${styles[BADGES[row.status] || "badgeOther"]}`}>
          <i className={statusMeta(row.status).icon} aria-hidden="true" />{statusMeta(row.status).label}
        </span>
      ) }
  ];
}

export default function StatusAnalytics({ enabled = true }) {
  const [draft, setDraft] = useState(() => ({ ...defaultDraft(), service: "", doctor: "", status: "" }));
  const [query, setQuery] = useState({ range: "today" });
  const [filterError, setFilterError] = useState("");
  const filters = { service: query.service || "", doctor: query.doctor || "", status: query.status || "" };
  const overview = useAnalyticsResource({ enabled, path: "/analytics/status/overview", params: query,
    validate: (data) => isStatusOverviewData(data, query, filters) });
  const records = useAnalyticsResource({ enabled, path: "/analytics/status/records", params: query,
    validate: (data) => samePeriod(data?.period, query) && Array.isArray(data?.records) && (data.filters?.status || "") === filters.status });
  const { data, extra, loading, refreshing, error } = overview;
  const names = extra?.doctor_display_names || {};
  const knownDoctors = useRef(DEFAULT_DOCTORS);
  if (data?.by_doctor?.doctors?.length) knownDoctors.current = data.by_doctor.doctors.map((row) => row.doctor);
  const singleDay = records.data?.period?.days === 1;
  const columns = useMemo(() => recordColumns(names, singleDay), [names, singleDay]);
  const carry = data?.cohort?.carry_in;
  const chips = [
    filters.service && `Service: ${serviceName(filters.service)}`,
    filters.doctor && `Doctor: ${filters.doctor === "unassigned" ? "Unassigned" : doctorLabel(filters.doctor, names)}`,
    filters.status && `Status: ${statusMeta(filters.status).label}`
  ].filter(Boolean);

  function apply() {
    try {
      const range = makeRangeQuery(draft);
      setQuery({ ...range, ...(draft.service ? { service: draft.service } : {}), ...(draft.doctor ? { doctor: draft.doctor } : {}), ...(draft.status ? { status: draft.status } : {}) });
      setFilterError("");
    } catch (problem) {
      setFilterError(problem.message);
    }
  }
  function refresh() {
    overview.refresh();
    records.refresh();
  }

  return (
    <section className={styles.dashboard} aria-labelledby="status-analytics-heading">
      <PageHeader id="status-analytics-heading" title="Status Analytics" onSubmit={apply} error={filterError}
        description="Overview of patient queue statuses, service performance, and doctor workload for the selected period."
        hint={draft.range === "custom" && draft.startDate === draft.endDate ? "Optional hours: an end time before the start continues into the next day." : null}>
        <RangeFields draft={draft} setDraft={setDraft} onChange={() => setFilterError("")} />
        <label className={`${styles.field} ${styles.serviceField}`}>Service
          <select aria-label="Service" value={draft.service} onChange={(event) => setDraft({ ...draft, service: event.target.value })}>
            <option value="">All Services</option>
            {SERVICE_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={`${styles.field} ${styles.doctorField}`}>Doctor
          <select aria-label="Doctor" value={draft.doctor} onChange={(event) => setDraft({ ...draft, doctor: event.target.value })}>
            <option value="">All Doctors</option>
            {knownDoctors.current.map((doctor) => <option key={doctor} value={doctor}>{doctorLabel(doctor, names)}</option>)}
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
        <label className={styles.field}>Status
          <select aria-label="Status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="">All Statuses</option>
            {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}
          </select>
        </label>
        <FilterButtons onRefresh={refresh} refreshing={refreshing || records.refreshing} disabled={!enabled || loading || refreshing} />
      </PageHeader>
      <RangeBar period={data?.period} observedAt={data?.observed_at} loading={loading} refreshing={refreshing} rangeLabel={rangeName(query)} chips={chips} />
      <ErrorBanner error={error} stale={Boolean(data)} onRetry={refresh} busy={refreshing} />
      {data && data.cohort.total === 0 ? <div className={styles.infoBanner}><i className="far fa-calendar" aria-hidden="true" /><span>No visits {chips.length ? "match these filters" : "were registered"} in this period. Choose another date range{chips.length ? " or clear a filter" : ""}.</span></div> : null}

      <StatusCards cohort={data?.cohort} loading={loading} />
      {!loading && patientLinksText(data?.patients) ? <p className={styles.cardNote} style={{ margin: "-6px 0 0" }}>{patientLinksText(data.patients)}</p> : null}
      {!loading && carry && (carry.waiting || carry.serving) ? (
        <div className={styles.infoBanner}>
          <i className="fas fa-info-circle" aria-hidden="true" />
          <span>Not counted above: {[carry.waiting && `${plural(carry.waiting, "patient")} still waiting`, carry.serving && `${plural(carry.serving, "patient")} being served`].filter(Boolean).join(" and ")} who registered before this period.</span>
        </div>
      ) : null}

      <div className={styles.rowThree}>
        <DistributionCard cohort={data?.cohort} loading={loading} />
        <DoctorCard byDoctor={data?.by_doctor} loading={loading} names={names} />
        <ServiceCard services={data?.by_service} loading={loading} />
      </div>

      <div className={styles.rowTwo}>
        <CompletionCard data={data} loading={loading} />
        <TimesCard times={data?.times} loading={loading} />
      </div>

      {records.error ? <ErrorBanner error={records.error} stale={Boolean(records.data)} onRetry={records.refresh} busy={records.refreshing} /> : null}
      <DataTable title="Queue Status Records" columns={columns} rows={records.data?.records || []} loading={records.loading} numbered
        heading={{ icon: "fas fa-list-ul" }}
        initialSort={{ key: "registered_at", direction: "desc" }} searchLabel="Search patient, ticket, or service"
        searchPlaceholder="Search patient, ticket, or service..."
        emptyMessage="No visits match these filters in this period."
        exportName={records.data?.period ? `queue-status-records_${records.data.period.start_date}_${records.data.period.end_date}.csv` : undefined} />

      <Notes notes={data?.notes} />
    </section>
  );
}
