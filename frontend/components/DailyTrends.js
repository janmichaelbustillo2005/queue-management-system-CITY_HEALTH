import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "../lib/api";
import {
  buildActivityChart, buildDurationChart, buildStatusChart,
  finiteMetric, getManilaToday, isDailyTrendsData, makeFilters, statusColor
} from "../lib/dailyTrendsCharts";
import styles from "./DailyTrends.module.css";

export const REFRESH_INTERVAL_MS = 15000;
export const REQUEST_TIMEOUT_MS = 10000;

const number = (value, decimals = 1) => finiteMetric(value) === null ? "No data available" :
  value.toLocaleString(undefined, { maximumFractionDigits: decimals });

function readableDateTime(value, options = {}) {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...options
  }).format(new Date(value));
}

function ChartSurface({ title, config, loading, empty, compact = false }) {
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
        if (Date.now() - started >= REQUEST_TIMEOUT_MS) {
          setChartError("The chart library is unavailable. Waiting to reconnect…");
        }
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
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      instance?.destroy();
    };
  }, [config, loading, empty]);

  return (
    <div className={`${styles.chartSurface} ${compact ? styles.compactChart : ""}`} aria-busy={loading}>
      {!loading && !empty && <canvas ref={canvas} role="img" aria-label={title} />}
      {(loading || empty || !ready) && (
        <div className={styles.chartPlaceholder} role="status">
          <i aria-hidden="true" className={loading ? "fas fa-circle-notch fa-spin" : "fas fa-chart-line"} />
          <span>{loading ? "Loading queue analytics…" : empty ? "No data available" : chartError || "Preparing chart…"}</span>
        </div>
      )}
    </div>
  );
}

function PanelHeading({ title, description, color, icon }) {
  return (
    <div className={styles.panelHeading}>
      <div className={styles.panelTitleRow}>
        <span className={styles.panelIcon} style={{ color, backgroundColor: `${color}12` }}><i className={icon} aria-hidden="true" /></span>
        <h3>{title}</h3>
      </div>
      <p>{description}</p>
    </div>
  );
}

function Legend({ items }) {
  return (
    <ul className={styles.legend} aria-label="Chart legend">
      {items.map(({ label, color, line }) => (
        <li key={label}><span className={line ? styles.legendLine : styles.legendDot} style={{ backgroundColor: color }} />{label}</li>
      ))}
    </ul>
  );
}

function CounterUtilization({ counters, loading }) {
  if (loading) return <div className={styles.listPlaceholder} role="status">Loading counters…</div>;
  if (!counters.length) return <div className={styles.listPlaceholder}>No data available</div>;
  return (
    <ul className={styles.counterList}>
      {counters.map((counter) => {
        const utilization = finiteMetric(counter.utilization_percent);
        const hasValue = utilization !== null;
        const description = hasValue ? `${number(counter.active_service_minutes)} active min / ${number(counter.available_minutes)} available min` :
          counter.reason || "Recorded operating time is unavailable.";
        return (
          <li key={counter.id}>
            <div className={styles.counterLabel}><span>{counter.name}</span><strong className={!hasValue ? styles.unknownValue : ""}>{hasValue ? `${number(utilization)}%` : "No data available"}</strong></div>
            <div className={styles.progressTrack} role={hasValue ? "progressbar" : undefined} aria-label={`${counter.name} utilization`} aria-valuemin={hasValue ? 0 : undefined} aria-valuemax={hasValue ? 100 : undefined} aria-valuenow={hasValue ? utilization : undefined}>
              {hasValue && <span style={{ width: `${Math.min(utilization, 100)}%` }} />}
            </div>
            <p className={styles.counterReason}>{description}</p>
          </li>
        );
      })}
    </ul>
  );
}

function PeakHours({ rows, loading }) {
  if (loading) return <div className={styles.listPlaceholder} role="status">Loading peak hours…</div>;
  const peaks = rows.filter((row) => finiteMetric(row.arrivals) !== null && row.arrivals > 0);
  if (!peaks.length) return <div className={styles.listPlaceholder}>No data available</div>;
  const largest = Math.max(...peaks.map((row) => row.arrivals));
  return (
    <ol className={styles.peakList}>
      {peaks.map((row, index) => (
        <li key={row.start_at || `${row.label}-${index}`}>
          <span className={`${styles.rank} ${index === 0 ? styles.topRank : ""}`}>{index + 1}</span>
          <div className={styles.peakDetails}><div className={styles.peakLabel}><span>{row.label}</span><strong>{number(row.arrivals, 0)} <small>{row.arrivals === 1 ? "arrival" : "arrivals"}</small></strong></div>
            <div className={styles.peakTrack}><span style={{ width: `${row.arrivals / largest * 100}%` }} /></div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function DailyTrends({ enabled = true }) {
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
    if (!enabled) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let pollTimer;
    let controller;
    let requestTimer;
    let hasResult = false;
    setResult(null);
    setError("");
    setLoading(true);
    async function load() {
      if (disposed) return;
      controller = new AbortController();
      let timedOut = false;
      setRefreshing(hasResult);
      requestTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        const response = await request(`/analytics/daily-trends?${filterKey}`, { signal: controller.signal, cache: "no-store" });
        if (disposed) return;
        if (timedOut) throw new Error("The request timed out. Retrying automatically.");
        if (response?.error || response?.success !== true || !response?.data) {
          throw new Error(response?.error || response?.message || "Unable to load daily trends.");
        }
        if (!isDailyTrendsData(response.data, filters)) {
          throw new Error("The server returned an invalid or mismatched daily trends result.");
        }
        if (!controller.signal.aborted) {
          hasResult = true;
          setResult({ key: filterKey, data: response.data });
          setError("");
        }
      } catch (problem) {
        if (!disposed) setError(timedOut ? "The request timed out. Retrying automatically." : problem?.message || "Unable to load daily trends.");
      } finally {
        clearTimeout(requestTimer);
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
          // Schedule after settlement, so a slow request cannot overlap the next refresh.
          pollTimer = setTimeout(load, REFRESH_INTERVAL_MS);
        }
      }
    }
    load();
    return () => {
      disposed = true;
      clearTimeout(pollTimer);
      clearTimeout(requestTimer);
      controller?.abort();
    };
  }, [enabled, filterKey, retry]);

  const charts = useMemo(() => ({
    activity: buildActivityChart(data), wait: buildDurationChart(data, "wait"),
    service: buildDurationChart(data, "service"), status: buildStatusChart(data)
  }), [data]);
  const hourly = data?.hourly || [];
  const statuses = data?.statuses || [];
  const statusTotal = statuses.reduce((sum, row) => sum + (finiteMetric(row.count) ?? 0), 0);
  const hasActivity = hourly.some((row) => [row.arrivals, row.served, row.waiting, row.cancelled_no_show].some((value) => finiteMetric(value) !== null && value > 0));
  const hasWaitingTime = hourly.some((row) => finiteMetric(row.avg_wait_minutes) !== null);
  const hasServiceTime = hourly.some((row) => finiteMetric(row.avg_service_minutes) !== null);
  const pending = loading || (enabled && !data && !error);

  function applyRange(event) {
    event.preventDefault();
    try {
      setFilters(makeFilters(draft.date, draft.view, draft.startTime, draft.endTime));
      setFilterError("");
    } catch (problem) {
      setFilterError(problem.message);
    }
  }

  return (
    <section className={styles.dailyTrends} aria-labelledby="daily-trends-heading">
      <div className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.eyebrow}><span />PATIENT QUEUE INSIGHTS</div>
          <h2 id="daily-trends-heading">Daily Trends</h2>
          <p>Follow patient flow, waiting times, and service activity throughout the day.</p>
        </div>
        <form onSubmit={applyRange} className={styles.filters} aria-label="Daily Trends filters">
          <label>Date<input aria-label="Date" type="date" value={draft.date} required onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
          <label>View<select aria-label="View" value={draft.view} onChange={(event) => { setDraft({ ...draft, view: event.target.value }); setFilterError(""); }}><option value="day">Full day</option><option value="shift">Custom shift</option></select></label>
          {draft.view === "shift" && <>
            <label>Shift starts<input aria-label="Shift starts" type="time" value={draft.startTime} required onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} /></label>
            <label>Shift ends<input aria-label="Shift ends" type="time" value={draft.endTime} required onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /></label>
          </>}
          <button type="submit" className={styles.applyButton}><i className="fas fa-filter" aria-hidden="true" />Apply range</button>
          {draft.view === "shift" && <span className={styles.shiftHint}>An end time before the start continues into the next day.</span>}
          {filterError && <span className={styles.filterError} role="alert">{filterError}</span>}
        </form>
      </div>

      <div className={styles.rangeBar}>
        <span><i className="far fa-calendar-alt" aria-hidden="true" />{data?.range?.start_at && data?.range?.end_at ? `${readableDateTime(data.range.start_at)} – ${readableDateTime(data.range.end_at)}` : `${filters.date}${filters.view === "shift" ? ` · ${filters.startTime}–${filters.endTime}` : " · Full day"}`}<span className={styles.timeZone}>Asia/Manila</span></span>
        <span className={styles.refreshStatus} role="status"><span className={refreshing || pending ? styles.refreshingDot : styles.liveDot} />{pending ? "Loading…" : refreshing ? "Refreshing…" : data?.observed_at ? `Updated ${readableDateTime(data.observed_at, { month: undefined, day: undefined, second: "2-digit" })} · Every 15 seconds` : "Refreshes every 15 seconds"}</span>
      </div>
      {error && <div className={styles.errorBanner} role="alert"><i className="fas fa-exclamation-circle" aria-hidden="true" /><span>{error} {data ? "Showing the last successful result. " : ""}Updates will retry automatically.</span><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry now</button></div>}
      {data && data.record_count === 0 && !hasActivity && <div className={styles.emptyBanner}><i className="far fa-calendar" aria-hidden="true" />No queue visits recorded in this range. Select another date or time range to explore activity.</div>}

      <div className={styles.panel}>
        <div className={styles.activityHeading}>
          <PanelHeading title="Patient Queue Activity" description="Hourly arrivals, completed visits, waiting patients, and cancellations / no-shows." color="#3b82f6" icon="fas fa-chart-bar" />
          <span className={styles.hourlyBadge}>HOURLY ACTIVITY</span>
        </div>
        <Legend items={[{ label: "Patient arrivals", color: "#3b82f6" }, { label: "Patients served", color: "#10b981" }, { label: "Waiting patients", color: "#f59e0b", line: true }, { label: "Cancelled / no-show", color: "#ef4444" }]} />
        <ChartSurface title="Patient Queue Activity" config={charts.activity} loading={pending} empty={!hasActivity} />
        <p className={styles.methodNote}><i className="far fa-clock" aria-hidden="true" />Waiting at each interval end, reconstructed from retained visit timestamps. Gaps indicate unavailable or future data.</p>
      </div>

      <div className={styles.durationGrid}>
        <div className={styles.panel}>
          <PanelHeading title="Average Waiting Time" description="Registration to saved call time, grouped by call hour." color="#8b5cf6" icon="far fa-clock" />
          <Legend items={[{ label: "Average waiting time (minutes)", color: "#8b5cf6", line: true }]} />
          <ChartSurface title="Average Waiting Time" config={charts.wait} loading={pending} empty={!hasWaitingTime} compact />
          <p className={styles.methodNote}>Only visits with valid registration and saved call timestamps are included.</p>
        </div>
        <div className={styles.panel}>
          <PanelHeading title="Average Service Time" description="Minutes spent serving completed visits, grouped by completion hour." color="#10b981" icon="fas fa-user-check" />
          <Legend items={[{ label: "Average service time (minutes)", color: "#10b981", line: true }]} />
          <ChartSurface title="Average Service Time" config={charts.service} loading={pending} empty={!hasServiceTime} compact />
          <p className={styles.methodNote}>Only completed visits with valid consultation-start and consultation-end timestamps are included.</p>
        </div>
      </div>

      <div className={styles.bottomGrid}>
        <div className={styles.panel}>
          <PanelHeading title="Queue Status Distribution" description="Current recorded status of visits in this range." color="#6366f1" icon="fas fa-chart-pie" />
          <div className={styles.doughnutWrap}>
            <ChartSurface title="Queue Status Distribution" config={charts.status} loading={pending} empty={statusTotal === 0} compact />
            {!pending && statusTotal > 0 && <div className={styles.doughnutTotal} aria-hidden="true"><strong>{number(statusTotal, 0)}</strong><span>queue visits</span></div>}
          </div>
          {!pending && statuses.length > 0 && <ul className={styles.statusLegend} aria-label="Queue statuses">{statuses.map((row, index) => <li key={row.status}><span className={styles.statusName}><span className={styles.legendDot} style={{ backgroundColor: statusColor(row.status, index) }} />{row.label}</span><span><strong>{number(row.count, 0)}</strong><small>{number(row.percentage)}%</small></span></li>)}</ul>}
        </div>
        <div className={styles.panel}>
          <PanelHeading title="Counter Utilization" description="Recorded active service time divided by available operating time." color="#0ea5e9" icon="fas fa-desktop" />
          <CounterUtilization counters={data?.counters || []} loading={pending} />
          <p className={styles.methodNote}>A percentage is shown only when recorded operating time is available.</p>
        </div>
        <div className={styles.panel}>
          <PanelHeading title="Peak Hours" description="Busiest hourly intervals, ranked by unique patient arrivals." color="#f59e0b" icon="fas fa-chart-line" />
          <PeakHours rows={data?.peak_hours || []} loading={pending} />
        </div>
      </div>

      {!!data?.notes?.length && <details className={styles.dataNotes}><summary><i className="fas fa-info-circle" aria-hidden="true" />How these statistics are calculated</summary><ul>{data.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
    </section>
  );
}
