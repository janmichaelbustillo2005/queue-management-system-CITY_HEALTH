import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { request } from "../lib/api";
import {
  finiteMetric, getManilaToday, makeFilters, statusColor, isStatusAnalyticsData,
  metricComparison, comparisonLabel, comparisonTone, buildOutcomeChart
} from "../lib/statusAnalyticsCharts";
import styles from "./StatusAnalytics.module.css";

export const REFRESH_INTERVAL_MS = 15000;
export const REQUEST_TIMEOUT_MS = 10000;

const number = (value, decimals = 1) => finiteMetric(value) === null ? "No data available" : value.toLocaleString(undefined, { maximumFractionDigits: decimals });
const minutes = (value) => finiteMetric(value) === null ? "No data available" : `${number(value)} min`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function readableDateTime(value, options = {}) {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...options }).format(new Date(value));
}

function ChartSurface({ title, config, loading, empty, doughnut = false }) {
  const canvas = useRef(null);
  const [ready, setReady] = useState(false);
  const [chartError, setChartError] = useState("");
  useEffect(() => {
    setReady(false);
    setChartError("");
    if (loading || empty || !config) return;
    let disposed = false;
    let instance = null;
    let retryTimer;
    const started = Date.now();
    const draw = () => {
      if (disposed) return;
      if (typeof window === "undefined" || !window.Chart || !canvas.current) {
        if (Date.now() - started >= REQUEST_TIMEOUT_MS) setChartError("The chart library is unavailable. Waiting to reconnect…");
        retryTimer = setTimeout(draw, 500);
        return;
      }
      try {
        instance = new window.Chart(canvas.current.getContext("2d"), config);
        setChartError("");
        setReady(true);
      } catch {
        instance?.destroy();
        instance = null;
        setChartError("Unable to display this chart. Retrying automatically…");
        retryTimer = setTimeout(draw, 3000);
      }
    };
    draw();
    return () => { disposed = true; clearTimeout(retryTimer); instance?.destroy(); };
  }, [config, loading, empty]);
  return <div className={`${styles.chartSurface} ${doughnut ? styles.doughnutSurface : ""}`} aria-busy={loading}>
    {!loading && !empty && <canvas ref={canvas} role="img" aria-label={title} />}
    {(loading || empty || !ready) && <div className={styles.placeholder} role="status"><i aria-hidden="true" className={loading ? "fas fa-circle-notch fa-spin" : "fas fa-chart-pie"} /><span>{loading ? "Loading queue analytics…" : empty ? "No data available" : chartError || "Preparing chart…"}</span></div>}
  </div>;
}

function PanelHeading({ title, description, icon, color }) {
  return <div className={styles.panelHeading}><div className={styles.panelTitle}><span style={{ color, backgroundColor: `${color}12` }}><i className={icon} aria-hidden="true" /></span><h3>{title}</h3></div><p>{description}</p></div>;
}

// Total first, then each status. The status counts add up to Total Patients.
const cards = [
  { key: "total", title: "Total Patients", tone: "blue", icon: "fas fa-users" },
  { status: "completed", title: "Completed", tone: "green", icon: "fas fa-check-circle" },
  { status: "waiting", title: "Waiting", tone: "orange", icon: "far fa-clock" },
  { status: "serving", title: "Being Served", tone: "sky", icon: "fas fa-user-md" },
  { status: "cancelled", title: "Cancelled", tone: "red", icon: "fas fa-times-circle" },
  { status: "no-show", title: "No-show", tone: "rose", icon: "fas fa-user-slash" }
];

function StatusCards({ data, loading }) {
  const outcomes = data?.outcomes;
  const total = finiteMetric(outcomes?.total);
  return <div className={styles.metricsGrid} aria-label="Patient status summary">{cards.map((card) => {
    const row = outcomes?.statuses?.find((item) => item.status === card.status);
    const value = card.key === "total" ? total : finiteMetric(row?.count) ?? (total === null ? null : 0);
    const detail = card.key === "total"
      ? metricComparison(data?.metrics?.total_patients, comparisonLabel(data))
      : total ? `${number(value * 100 / total)}% of patients` : "—";
    return <article key={card.title} className={`${styles.metricCard} ${styles[card.tone]}`} aria-busy={loading}>
      <div className={styles.metricTop}><h3>{card.title}</h3><span className={styles.metricIcon}><i className={card.icon} aria-hidden="true" /></span></div>
      <div className={`${styles.metricValue} ${!loading && value === null ? styles.missingMetric : ""}`}>{loading ? "—" : value === null ? "No data available" : number(value, 0)}</div>
      <p className={styles.comparison}>{loading ? "Loading…" : detail}</p>
    </article>;
  })}</div>;
}

function CarryInNote({ carryIn }) {
  const waiting = finiteMetric(carryIn?.waiting) ?? 0, serving = finiteMetric(carryIn?.serving) ?? 0;
  if (!waiting && !serving) return null;
  const parts = [waiting && `${plural(waiting, "patient")} still waiting`, serving && `${plural(serving, "patient")} being served`].filter(Boolean);
  // Earlier-day waiting visits are resolved in the Superadmin Historical Backlog; the note's
  // count stays this period's carry-in, and the backlog page shows its own live count.
  return <p className={styles.carryInNote}><i className="fas fa-info-circle" aria-hidden="true" /><span>Not counted above: {parts.join(" and ")} who registered on an earlier day.</span>
    {waiting ? <Link href="/queue-backlog" className={styles.carryInLink}>View Historical Backlog<i className="fas fa-arrow-right" aria-hidden="true" /></Link> : null}</p>;
}

function StatusBreakdown({ outcomes, loading }) {
  const config = useMemo(() => buildOutcomeChart(outcomes), [outcomes]);
  const total = finiteMetric(outcomes?.total) ?? 0;
  const completed = outcomes?.statuses?.find((row) => row.status === "completed")?.count ?? 0;
  return <>
    <div className={styles.doughnutWrap}>
      <ChartSurface title="Status Breakdown" config={config} loading={loading} empty={total === 0} doughnut />
      {!loading && total > 0 && <div className={styles.doughnutTotal} aria-hidden="true"><strong>{number(completed * 100 / total, 0)}%</strong><span>completed</span></div>}
    </div>
    {!loading && total > 0 && <ul className={styles.statusLegend} aria-label="Patient statuses">{outcomes.statuses.map((row, index) =>
      <li key={row.status}><span><span className={styles.legendDot} style={{ backgroundColor: statusColor(row.status, index) }} />{row.label}</span><span><strong>{number(row.count, 0)}</strong><small>{number(row.percentage)}%</small></span></li>)}</ul>}
  </>;
}

function TimeRow({ title, description, metric, samples, sampleWord, better, label, loading }) {
  const value = finiteMetric(metric?.value);
  const tone = comparisonTone(metric, better);
  return <div className={styles.timeRow}>
    <div className={styles.timeHeading}><h4>{title}</h4><strong className={value === null ? styles.unknownValue : ""}>{loading ? "—" : minutes(value)}</strong></div>
    <p className={styles.timeDescription}>{description}{!loading && finiteMetric(samples) !== null && samples > 0 ? ` · based on ${plural(samples, sampleWord)}` : ""}</p>
    {!loading && <p className={`${styles.timeComparison} ${styles[tone]}`}>{metricComparison(metric, label)}</p>}
  </div>;
}

function DoctorTable({ counters, loading }) {
  return <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Doctor performance table"><table className={styles.counterTable}>
    <caption>Counts consultations finished during this period, including patients who registered earlier, so the total can differ from the Completed card.</caption>
    <thead><tr><th scope="col">Doctor</th><th scope="col">Patients Completed</th><th scope="col">Average Service Time</th><th scope="col">Total Service Time</th></tr></thead>
    <tbody>{loading || !counters.length ? <tr><td colSpan={4} className={styles.tableEmpty}>{loading ? "Loading doctor performance…" : "No data available"}</td></tr> : counters.map((counter) => <tr key={counter.id}><th scope="row"><i className="fas fa-user-md" aria-hidden="true" />{counter.name}</th><td>{number(counter.total_served, 0)}</td><td>{minutes(counter.avg_service_minutes)}</td><td>{minutes(counter.total_service_minutes)}</td></tr>)}</tbody>
  </table></div>;
}

const HOW_TO_READ = [
  "Total Patients counts everyone registered in the selected period. The status cards show where each of those patients stands now, so they always add up to the total.",
  "Average waiting time runs from registration until the patient is called, for patients who have been called. Average service time runs from the start to the end of the consultation, for completed consultations.",
  "Comparisons use the same hours on the previous day. While the selected period is still in progress, only the time that has passed so far is compared.",
  "Doctor Performance counts consultations finished during this period, including patients who registered earlier.",
  "Recall, Requeue and Undo replace earlier timestamps, so times are calculated from the latest recorded ones.",
  "All times are Philippine time (Asia/Manila)."
];

export default function StatusAnalytics({ enabled = true }) {
  const [filters, setFilters] = useState(() => makeFilters(getManilaToday()));
  const [draft, setDraft] = useState(() => ({ ...filters, startTime: "", endTime: "" }));
  const [filterError, setFilterError] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const filterKey = new URLSearchParams(filters).toString();
  const data = enabled && result?.key === filterKey ? result.data : null;

  useEffect(() => {
    if (!enabled) { setLoading(false); setRefreshing(false); return; }
    let disposed = false;
    let pollTimer;
    let requestTimer;
    let controller;
    let hasResult = result?.key === filterKey;
    if (!hasResult) setResult(null);
    setLoading(!hasResult);
    setError("");
    async function load() {
      if (disposed) return;
      controller = new AbortController();
      let timedOut = false;
      setRefreshing(hasResult);
      try {
        const timeout = new Promise((_, reject) => {
          requestTimer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("The request timed out. Retrying automatically.")); }, REQUEST_TIMEOUT_MS);
        });
        const response = await Promise.race([request(`/analytics/status?${filterKey}`, { signal: controller.signal, cache: "no-store" }), timeout]);
        if (disposed) return;
        if (timedOut) throw new Error("The request timed out. Retrying automatically.");
        if (response?.error || response?.success !== true || !response?.data) throw new Error(response?.error || response?.message || "Unable to load status analytics.");
        if (!isStatusAnalyticsData(response.data, filters)) throw new Error("The server returned an invalid or mismatched status analytics result.");
        if (!controller.signal.aborted) { hasResult = true; setResult({ key: filterKey, data: response.data }); setError(""); }
      } catch (problem) {
        if (!disposed) setError(timedOut ? "The request timed out. Retrying automatically." : problem?.message || "Unable to load status analytics.");
      } finally {
        clearTimeout(requestTimer);
        if (!disposed) { setLoading(false); setRefreshing(false); pollTimer = setTimeout(load, REFRESH_INTERVAL_MS); }
      }
    }
    load();
    return () => { disposed = true; clearTimeout(pollTimer); clearTimeout(requestTimer); controller?.abort(); };
  }, [enabled, filterKey, retry]);

  const pending = loading || (enabled && !data && !error);
  const live = data?.outcomes?.live === true;
  const label = comparisonLabel(data);

  function applyRange(event) {
    event.preventDefault();
    try { setFilters(makeFilters(draft.date, draft.view, draft.startTime, draft.endTime)); setFilterError(""); } catch (problem) { setFilterError(problem.message); }
  }

  return <section className={styles.statusAnalytics} aria-labelledby="status-analytics-heading">
    <div className={styles.header}><div className={styles.heading}><div className={styles.eyebrow}><span />QUEUE STATUS</div><h2 id="status-analytics-heading">Status Analytics</h2><p>Where every patient registered in the selected period stands, and how long patients waited and were served.</p></div>
      <form onSubmit={applyRange} className={styles.filters} aria-label="Status Analytics filters">
        <label>Date<input aria-label="Date" type="date" value={draft.date} required onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
        <label>View<select aria-label="View" value={draft.view} onChange={(event) => { setDraft({ ...draft, view: event.target.value }); setFilterError(""); }}><option value="day">Full day</option><option value="shift">Custom shift</option></select></label>
        {draft.view === "shift" && <><label>Shift starts<input aria-label="Shift starts" type="time" value={draft.startTime} required onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} /></label><label>Shift ends<input aria-label="Shift ends" type="time" value={draft.endTime} required onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /></label></>}
        <button type="submit" className={styles.applyButton}><i className="fas fa-filter" aria-hidden="true" />Apply range</button>
        <button type="button" className={styles.refreshButton} disabled={!enabled || pending || refreshing} onClick={() => setRetry((value) => value + 1)}><i className={`fas fa-sync-alt ${refreshing ? "fa-spin" : ""}`} aria-hidden="true" />Refresh</button>
        {draft.view === "shift" && <span className={styles.shiftHint}>An end time before the start continues into the next day.</span>}{filterError && <span className={styles.filterError} role="alert">{filterError}</span>}
      </form>
    </div>
    <div className={styles.rangeBar}><span><i className="far fa-calendar-alt" aria-hidden="true" />{data?.range?.start_at && data?.range?.end_at ? `${readableDateTime(data.range.start_at)} – ${readableDateTime(data.range.end_at)}` : `${filters.date}${filters.view === "shift" ? ` · ${filters.startTime}–${filters.endTime}` : " · Full day"}`}<span className={styles.timeZone}>Asia/Manila</span></span><span role="status"><span className={pending || refreshing ? styles.refreshingDot : styles.liveDot} />{pending ? "Loading…" : refreshing ? "Refreshing…" : data?.observed_at ? `Updated ${readableDateTime(data.observed_at, { month: undefined, day: undefined, second: "2-digit" })} · Every 15 seconds` : "Refreshes every 15 seconds"}</span></div>
    {error && <div className={styles.errorBanner} role="alert"><i className="fas fa-exclamation-circle" aria-hidden="true" /><span>{error} {data ? "Showing the last successful result. " : ""}Updates will retry automatically.</span><button type="button" disabled={refreshing} onClick={() => setRetry((value) => value + 1)}>Retry now</button></div>}
    {data && data.outcomes?.total === 0 && <div className={styles.emptyBanner}><i className="far fa-calendar" aria-hidden="true" />No patients registered in this range. Choose another date or time range.</div>}
    <p className={styles.sectionNote}>{live ? "Patients registered so far in this period, by their status right now." : "Patients registered in this period, by their current status."}</p>
    <StatusCards data={data} loading={pending} />
    {!pending && <CarryInNote carryIn={data?.outcomes?.carry_in} />}
    <div className={styles.panelGrid}>
      <article className={styles.panel}><PanelHeading title="Status Breakdown" description="Share of the patients above in each status." color="#6366f1" icon="fas fa-chart-pie" />
        <StatusBreakdown outcomes={data?.outcomes} loading={pending} />
      </article>
      <article className={styles.panel}><PanelHeading title="Waiting & Service Times" description={`Averages for this period, compared ${label.replace(/^vs /, "with ")}.`} color="#8b5cf6" icon="far fa-clock" />
        <TimeRow title="Average waiting time" description="From registration until the patient is called" metric={data?.metrics?.avg_wait_minutes}
          samples={data?.duration_samples?.wait} sampleWord="patient" better="lower" label={label} loading={pending} />
        <TimeRow title="Average service time" description="From the start to the end of the consultation" metric={data?.metrics?.avg_service_minutes}
          samples={data?.duration_samples?.service} sampleWord="consultation" better="neutral" label={label} loading={pending} />
      </article>
    </div>
    <article className={`${styles.panel} ${styles.tablePanel}`}><PanelHeading title="Doctor Performance" description="Consultations each doctor finished in the selected period." color="#64748b" icon="fas fa-user-md" /><DoctorTable counters={data?.counters || []} loading={pending} /></article>
    <details className={styles.dataNotes}><summary><i className="fas fa-info-circle" aria-hidden="true" />How to read these numbers</summary><ul>{HOW_TO_READ.map((note) => <li key={note}>{note}</li>)}</ul></details>
  </section>;
}
