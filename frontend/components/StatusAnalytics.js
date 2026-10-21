import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "../lib/api";
import {
  finiteMetric, getManilaToday, makeFilters, statusColor, buildStatusChart,
  isStatusAnalyticsData, metricComparison, buildTimeComparisonChart,
  buildArrivalsServedChart, buildQueueLengthChart
} from "../lib/statusAnalyticsCharts";
import styles from "./StatusAnalytics.module.css";

export const REFRESH_INTERVAL_MS = 15000;
export const REQUEST_TIMEOUT_MS = 10000;

const number = (value, decimals = 1) => finiteMetric(value) === null ? "No data available" : value.toLocaleString(undefined, { maximumFractionDigits: decimals });
const minutes = (value) => finiteMetric(value) === null ? "No data available" : `${number(value)} min`;
const percent = (value) => finiteMetric(value) === null ? "No data available" : `${number(value)}%`;

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
    {(loading || empty || !ready) && <div className={styles.placeholder} role="status"><i aria-hidden="true" className={loading ? "fas fa-circle-notch fa-spin" : "fas fa-chart-line"} /><span>{loading ? "Loading queue analytics…" : empty ? "No data available" : chartError || "Preparing chart…"}</span></div>}
  </div>;
}

function PanelHeading({ title, description, icon, color }) {
  return <div className={styles.panelHeading}><div className={styles.panelTitle}><span style={{ color, backgroundColor: `${color}12` }}><i className={icon} aria-hidden="true" /></span><h3>{title}</h3></div><p>{description}</p></div>;
}

function Legend({ items }) {
  return <ul className={styles.legend} aria-label="Chart legend">{items.map(({ label, color, line }) => <li key={label}><span className={line ? styles.legendLine : styles.legendDot} style={{ backgroundColor: color }} />{label}</li>)}</ul>;
}

const cards = [
  { key: "total_patients", title: "Total Patients", tone: "blue", icon: "fas fa-users" },
  { key: "waiting_patients", title: "Waiting Patients", tone: "orange", icon: "far fa-clock" },
  { key: "currently_serving", title: "Currently Serving", tone: "sky", icon: "fas fa-user-md" },
  { key: "completed_patients", title: "Completed Patients", tone: "green", icon: "fas fa-check-circle" },
  { key: "avg_wait_minutes", title: "Average Waiting Time", tone: "purple", icon: "fas fa-hourglass-half", duration: true },
  { key: "avg_service_minutes", title: "Average Service Time", tone: "gray", icon: "fas fa-stopwatch", duration: true }
];

function MetricCards({ metrics, loading }) {
  return <div className={styles.metricsGrid} aria-label="Status summary">{cards.map((card) => {
    const metric = metrics?.[card.key];
    const value = finiteMetric(metric?.value);
    return <article key={card.key} className={`${styles.metricCard} ${styles[card.tone]}`} aria-busy={loading}>
      <div className={styles.metricTop}><h3>{card.title}</h3><span className={styles.metricIcon}><i className={card.icon} aria-hidden="true" /></span></div>
      <div className={`${styles.metricValue} ${!loading && value === null ? styles.missingMetric : ""}`}>{loading ? "—" : value === null ? "No data available" : <>{number(value, card.duration ? 1 : 0)}{card.duration && <small>min</small>}</>}</div>
      <p className={styles.comparison}>{loading ? "Loading…" : metricComparison(metric)}</p>
    </article>;
  })}</div>;
}

function CounterUtilization({ counters, loading }) {
  if (loading || !counters.length) return <div className={styles.listPlaceholder} role="status">{loading ? "Loading counters…" : "No data available"}</div>;
  return <ul className={styles.counterList}>{counters.map((counter) => {
    const value = finiteMetric(counter.utilization_percent);
    return <li key={counter.id}><div className={styles.counterLabel}><span>{counter.name}</span><strong className={value === null ? styles.unknownValue : ""}>{percent(value)}</strong></div>
      <div className={styles.progressTrack} role={value === null ? undefined : "progressbar"} aria-label={`${counter.name} utilization`} aria-valuemin={value === null ? undefined : 0} aria-valuemax={value === null ? undefined : 100} aria-valuenow={value ?? undefined}>{value !== null && <span style={{ width: `${Math.min(100, value)}%` }} />}</div>
      <p className={styles.counterReason}>{value === null ? "Recorded operating time is unavailable." : `${minutes(counter.active_service_minutes)} active / ${minutes(counter.available_minutes)} available`}</p>
    </li>;
  })}</ul>;
}

function RatePanel({ rates, loading }) {
  return <div className={styles.ratePanel} aria-busy={loading}>
    <div className={styles.rateRow}><span><i className="fas fa-arrow-down" aria-hidden="true" />Patient arrival rate (λ)</span><strong>{loading ? "—" : number(rates?.arrival_rate_per_hour, 2)}{!loading && finiteMetric(rates?.arrival_rate_per_hour) !== null && <small>patients/hour</small>}</strong></div>
    <div className={styles.rateRow}><span><i className="fas fa-check" aria-hidden="true" />Observed service rate (μ)</span><strong>{loading ? "—" : number(rates?.service_rate_per_hour, 2)}{!loading && finiteMetric(rates?.service_rate_per_hour) !== null && <small>patients/hour</small>}</strong></div>
    <div className={styles.completionRow}><span>Completion rate</span><strong>{loading ? "—" : percent(rates?.completion_rate_percent)}</strong></div>
    {!loading && finiteMetric(rates?.completion_numerator) !== null && finiteMetric(rates?.completion_denominator) !== null && <p className={styles.completionNote}>{number(rates.completion_numerator, 0)} of {number(rates.completion_denominator, 0)} period arrivals completed by the cutoff.</p>}
    <div className={styles.operationalIndicator}><span /><strong>{loading ? "Loading…" : rates?.operational_status || "Insufficient Data"}</strong></div>
    <p className={styles.rateDescription}>{loading ? "Calculating observed rates…" : rates?.description || "Operating schedules and service capacity are not recorded, so operational stability cannot be assessed."}</p>
    <p className={styles.methodNote}>Both rates use recorded counts divided by elapsed hours. The observed service rate does not measure service capacity.</p>
  </div>;
}

function CounterTable({ counters, loading }) {
  return <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Counter performance table"><table className={styles.counterTable}>
    <caption>Service totals use full valid completed consultation durations. Counter status reflects its current enabled setting; utilization requires recorded available operating time.</caption>
    <thead><tr><th scope="col">Counter</th><th scope="col">Total Served</th><th scope="col">Average Service Time</th><th scope="col">Total Service Time</th><th scope="col">Utilization Rate</th><th scope="col">Status</th></tr></thead>
    <tbody>{loading || !counters.length ? <tr><td colSpan={6} className={styles.tableEmpty}>{loading ? "Loading counter performance…" : "No data available"}</td></tr> : counters.map((counter) => <tr key={counter.id}><th scope="row"><i className="fas fa-desktop" aria-hidden="true" />{counter.name}</th><td>{number(counter.total_served, 0)}</td><td>{minutes(counter.avg_service_minutes)}</td><td>{minutes(counter.total_service_minutes)}</td><td>{percent(counter.utilization_percent)}</td><td><span className={`${styles.counterStatus} ${counter.status === "Enabled" ? styles.enabledStatus : counter.status === "Disabled" ? styles.disabledStatus : styles.unknownStatus}`}><span />{counter.status || "No data available"}</span></td></tr>)}</tbody>
  </table></div>;
}

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

  const charts = useMemo(() => ({ status: buildStatusChart(data), time: buildTimeComparisonChart(data), arrivals: buildArrivalsServedChart(data), queue: buildQueueLengthChart(data) }), [data]);
  const hourly = data?.hourly || [];
  const statuses = data?.statuses || [];
  const statusTotal = statuses.reduce((sum, row) => sum + (finiteMetric(row.count) ?? 0), 0);
  const hasTime = hourly.some((row) => finiteMetric(row.avg_wait_minutes) !== null || finiteMetric(row.avg_service_minutes) !== null);
  const hasArrivals = hourly.some((row) => (finiteMetric(row.arrivals) ?? 0) > 0 || (finiteMetric(row.served) ?? 0) > 0);
  const hasQueue = hourly.some((row) => finiteMetric(row.avg_queue_length) !== null);
  const pending = loading || (enabled && !data && !error);

  function applyRange(event) {
    event.preventDefault();
    try { setFilters(makeFilters(draft.date, draft.view, draft.startTime, draft.endTime)); setFilterError(""); } catch (problem) { setFilterError(problem.message); }
  }

  return <section className={styles.statusAnalytics} aria-labelledby="status-analytics-heading">
    <div className={styles.header}><div className={styles.heading}><div className={styles.eyebrow}><span />QUEUE PERFORMANCE</div><h2 id="status-analytics-heading">Status Analytics</h2><p>Overall queue performance and operational efficiency</p></div>
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
    {data && data.record_count === 0 && !hasArrivals && <div className={styles.emptyBanner}><i className="far fa-calendar" aria-hidden="true" />No queue visits recorded in this range. Choose another date or time range.</div>}
    <MetricCards metrics={data?.metrics} loading={pending} />
    <p className={styles.summaryNote}>Counts represent unique queue visits. Waiting and serving show the selected cutoff; comparisons use yesterday’s equivalent elapsed period.{data?.comparison_range?.start_at && data?.comparison_range?.effective_end_at && <> Comparison: {readableDateTime(data.comparison_range.start_at)} – {readableDateTime(data.comparison_range.effective_end_at)} (Asia/Manila).</>}</p>
    <div className={styles.panelGrid}>
      <article className={styles.panel}><PanelHeading title="Patient Status Distribution" description="Current recorded statuses of visits with queue activity in this range." color="#6366f1" icon="fas fa-chart-pie" />
        <div className={styles.doughnutWrap}><ChartSurface title="Patient Status Distribution" config={charts.status} loading={pending} empty={statusTotal === 0} doughnut />{!pending && statusTotal > 0 && <div className={styles.doughnutTotal} aria-hidden="true"><strong>{number(statusTotal, 0)}</strong><span>queue visits</span></div>}</div>
        {!pending && statuses.length > 0 && <ul className={styles.statusLegend} aria-label="Queue statuses">{statuses.map((row, index) => <li key={row.status}><span><span className={styles.legendDot} style={{ backgroundColor: statusColor(row.status, index) }} />{row.label}</span><span><strong>{number(row.count, 0)}</strong><small>{percent(row.percentage)}</small></span></li>)}</ul>}
      </article>
      <article className={styles.panel}><PanelHeading title="Waiting vs. Service Time" description="Valid recorded durations, grouped by call / completion hour." color="#8b5cf6" icon="far fa-clock" /><Legend items={[{ label: "Waiting time", color: "#8b5cf6", line: true }, { label: "Service time", color: "#10b981", line: true }]} /><ChartSurface title="Waiting vs. Service Time" config={charts.time} loading={pending} empty={!hasTime} /><p className={styles.methodNote}>Minutes per visit; missing or invalid timestamps are excluded.</p></article>
      <article className={styles.panel}><PanelHeading title="Patient Arrival and Service Rate" description="Observed patient flow during the elapsed selected period." color="#0ea5e9" icon="fas fa-exchange-alt" /><RatePanel rates={data?.rates} loading={pending} /></article>
      <article className={styles.panel}><PanelHeading title="Patient Arrivals vs. Served" description="Unique arrivals and completed visits per hourly interval." color="#3b82f6" icon="fas fa-chart-bar" /><Legend items={[{ label: "Patient arrivals", color: "#3b82f6" }, { label: "Patients served", color: "#10b981" }]} /><ChartSurface title="Patient Arrivals vs. Served" config={charts.arrivals} loading={pending} empty={!hasArrivals} /><p className={styles.methodNote}>Completion-hour totals can include patients who arrived before this range.</p></article>
      <article className={styles.panel}><PanelHeading title="Counter Utilization" description="Active service minutes / recorded available operating minutes." color="#10b981" icon="fas fa-desktop" /><CounterUtilization counters={data?.counters || []} loading={pending} /><p className={styles.methodNote}>No percentage is inferred from a counter’s enabled setting or a full calendar day.</p></article>
      <article className={styles.panel}><PanelHeading title="Average Queue Length" description="Time-weighted average waiting patients within each hourly interval." color="#ef4444" icon="fas fa-chart-area" /><Legend items={[{ label: "Average queue length", color: "#ef4444", line: true }]} /><ChartSurface title="Average Queue Length" config={charts.queue} loading={pending} empty={!hasQueue} /><p className={styles.methodNote}>Reconstructed from retained waiting intervals. Gaps indicate unavailable or future data.</p></article>
    </div>
    <article className={`${styles.panel} ${styles.tablePanel}`}><PanelHeading title="Counter Performance Summary" description="Recorded completed service for each existing counter in the selected range." color="#64748b" icon="fas fa-list-alt" /><CounterTable counters={data?.counters || []} loading={pending} /></article>
    {!!data?.notes?.length && <details className={styles.dataNotes}><summary><i className="fas fa-info-circle" aria-hidden="true" />How these statistics are calculated</summary><ul>{data.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
  </section>;
}
