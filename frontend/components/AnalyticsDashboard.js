// Building blocks shared by the Trends Analytics and Status Analytics tabs: the data loader, the
// date-range fields, cards, chart canvases and the searchable, sortable, exportable records table.
import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "../lib/api";
import {
  RANGE_OPTIONS, REFRESH_INTERVAL_MS, REQUEST_TIMEOUT_MS, queryString, readableDateTime, describePeriod,
  searchRows, sortRows, pageRows, toCsv
} from "../lib/rangeAnalytics";
import styles from "./AnalyticsDashboard.module.css";

export { styles };

// Loads one analytics endpoint for the applied filters. A live period (one that includes now) is
// refreshed every 15 seconds; a finished period is read once, since it can no longer change. Each
// request is aborted after 10 seconds, a slow request never overlaps the next one, and a result
// for an earlier filter is discarded.
export function useAnalyticsResource({ enabled, path, params, validate }) {
  const key = queryString(params);
  const [result, setResult] = useState({ key: null, data: null, extra: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const latest = useRef({ key: null, validate });
  latest.current.validate = validate;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setRefreshing(false);
      return undefined;
    }
    let disposed = false, pollTimer, requestTimer, controller;
    let hasResult = latest.current.key === key;
    setLoading(!hasResult);
    setError("");
    async function load() {
      if (disposed) return;
      controller = new AbortController();
      let timedOut = false, live = true;
      setRefreshing(hasResult);
      requestTimer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
      try {
        const response = await request(`${path}?${key}`, { signal: controller.signal, cache: "no-store" });
        if (disposed) return;
        if (timedOut) throw new Error("The request timed out.");
        if (response?.error || response?.success !== true || !response?.data) {
          throw new Error(response?.error || response?.message || "Unable to load analytics.");
        }
        if (!latest.current.validate(response.data)) throw new Error("The server returned an invalid or mismatched result.");
        const { data, success: _success, ...extra } = response;
        hasResult = true;
        latest.current.key = key;
        live = data?.period?.live === true;
        setResult({ key, data, extra });
        setError("");
      } catch (problem) {
        if (!disposed) setError(timedOut ? "The request timed out." : problem?.message || "Unable to load analytics.");
      } finally {
        clearTimeout(requestTimer);
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
          // After an error the next attempt still runs, so a dropped connection recovers by itself.
          if (live) pollTimer = setTimeout(load, REFRESH_INTERVAL_MS);
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
  }, [enabled, path, key, nonce]);

  const current = enabled && result.key === key;
  return {
    data: current ? result.data : null, extra: current ? result.extra : null,
    loading: enabled && (loading || (!current && !error)), refreshing, error,
    refresh: () => setNonce((value) => value + 1)
  };
}

export function ChartCanvas({ title, config, height = 260 }) {
  const canvas = useRef(null);
  const [ready, setReady] = useState(false);
  const [chartError, setChartError] = useState("");
  useEffect(() => {
    setReady(false);
    setChartError("");
    if (!config) return undefined;
    let disposed = false, instance = null, retryTimer;
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
        setChartError("Unable to display this chart. Retrying…");
        retryTimer = setTimeout(draw, 3000);
      }
    };
    draw();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      instance?.destroy();
    };
  }, [config]);
  return (
    <div className={styles.canvasBox} style={{ height }}>
      <canvas ref={canvas} role="img" aria-label={title} />
      {!ready && <div className={styles.canvasNotice} role="status">{chartError || "Preparing chart…"}</div>}
    </div>
  );
}

// A chart area while loading or when there is nothing to plot: a short notice, not an empty grid.
export function ChartState({ loading, message = "No data available." }) {
  return (
    <div className={styles.chartState} role="status">
      <i aria-hidden="true" className={loading ? "fas fa-circle-notch fa-spin" : "far fa-chart-bar"} />
      <span>{loading ? "Loading…" : message}</span>
    </div>
  );
}

function CardTitle({ icon, title, description }) {
  return (
    <div className={styles.cardTitleRow}>
      {icon ? <span className={styles.cardIcon}><i className={icon} aria-hidden="true" /></span> : null}
      <div className={styles.cardTitles}>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
}

export function Card({ title, description, icon = null, children, className = "", action = null, as: Tag = "article" }) {
  return (
    <Tag className={`${styles.card} ${className}`}>
      <div className={styles.cardHead}>
        <CardTitle icon={icon} title={title} description={description} />
        {action}
      </div>
      {children}
    </Tag>
  );
}

export function KpiCard({ label, value, icon, tone, detail, direction = null, loading, missing = false }) {
  return (
    <article className={`${styles.kpi} ${styles[tone] || ""}`} aria-busy={loading}>
      <span className={styles.kpiIcon}><i className={icon} aria-hidden="true" /></span>
      <div className={styles.kpiText}>
        <h3>{label}</h3>
        <p className={`${styles.kpiValue} ${missing && !loading ? styles.kpiMissing : ""}`}>{loading ? "—" : value}</p>
        <p className={styles.kpiDetail}>
          {direction && !loading ? <i aria-hidden="true" className={direction === "up" ? "fas fa-arrow-up" : direction === "down" ? "fas fa-arrow-down" : "fas fa-minus"} /> : null}
          <span>{loading ? "Loading…" : detail}</span>
        </p>
      </div>
    </article>
  );
}

// Chart legend. `below` centres it under the chart with round colour dots (the approved layout).
export function Legend({ items, below = false }) {
  return (
    <ul className={`${styles.legend} ${below ? styles.legendBelow : ""}`} aria-label="Chart legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className={item.dashed ? styles.legendDash : below ? styles.legendDot : styles.legendSwatch}
            style={item.dashed ? { borderColor: item.color } : { backgroundColor: item.color, borderColor: item.border || item.color }} />
          <span>{item.label}</span>
          {item.value != null ? <strong>{item.value}</strong> : null}
        </li>
      ))}
    </ul>
  );
}

export function RangeFields({ draft, setDraft, onChange }) {
  const update = (patch) => { setDraft({ ...draft, ...patch }); onChange?.(); };
  const singleDay = draft.range === "custom" && draft.startDate && draft.startDate === draft.endDate;
  return (
    <>
      <label className={`${styles.field} ${styles.rangeField}`}>Date Range
        <select aria-label="Date range" value={draft.range} onChange={(event) => update({ range: event.target.value })}>
          {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {draft.range === "custom" && <>
        <label className={`${styles.field} ${styles.dateField}`}>From
          <input aria-label="Start date" type="date" value={draft.startDate} required onChange={(event) => update({ startDate: event.target.value })} />
        </label>
        <label className={`${styles.field} ${styles.dateField}`}>To
          <input aria-label="End date" type="date" value={draft.endDate} required onChange={(event) => update({ endDate: event.target.value })} />
        </label>
        {singleDay && <>
          <label className={`${styles.field} ${styles.timeField}`}>Hours from
            <input aria-label="Start time" type="time" value={draft.startTime} onChange={(event) => update({ startTime: event.target.value })} />
          </label>
          <label className={`${styles.field} ${styles.timeField}`}>Hours to
            <input aria-label="End time" type="time" value={draft.endTime} onChange={(event) => update({ endTime: event.target.value })} />
          </label>
        </>}
      </>}
    </>
  );
}

export function PageHeader({ id, title, description, onSubmit, children, error, hint, formLabelledBy, className = "" }) {
  return (
    <header className={`${styles.pageHeader} ${className}`}>
      <div className={styles.pageTitle}>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
      <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); onSubmit(); }} aria-label={`${title} filters`} aria-labelledby={formLabelledBy}>
        {children}
      </form>
      {hint ? <span className={styles.filterHint}>{hint}</span> : null}
      {error ? <span className={styles.filterError} role="alert">{error}</span> : null}
    </header>
  );
}

export function FilterButtons({ onRefresh, refreshing, disabled, applyLabel = "Apply" }) {
  return (
    <div className={styles.filterButtons}>
      <button type="submit" className={styles.primaryButton}><i className="fas fa-filter" aria-hidden="true" />{applyLabel}</button>
      <button type="button" className={styles.secondaryButton} onClick={onRefresh} disabled={disabled} aria-label="Refresh">
        <i className={`fas fa-sync-alt ${refreshing ? "fa-spin" : ""}`} aria-hidden="true" />Refresh
      </button>
    </div>
  );
}

export function RangeBar({ period, observedAt, loading, refreshing, rangeLabel, chips = [] }) {
  const live = period?.live === true;
  return (
    <div className={styles.rangeBar}>
      <span className={styles.rangeText}>
        <i className="far fa-calendar-alt" aria-hidden="true" />
        <strong>{rangeLabel}</strong>
        {period ? <span>{describePeriod(period)}</span> : null}
        <span className={styles.zone}>Asia/Manila</span>
        {chips.map((chip) => <span key={chip} className={styles.chip}>{chip}</span>)}
      </span>
      <span className={styles.updated} role="status">
        <span className={loading || refreshing ? styles.dotBusy : live ? styles.dotLive : styles.dotIdle} />
        {loading ? "Loading…" : refreshing ? "Refreshing…" : observedAt
          ? `Updated ${readableDateTime(observedAt)}${live ? " · refreshes every 15 seconds" : " · finished period"}` : ""}
      </span>
    </div>
  );
}

export function ErrorBanner({ error, stale, onRetry, busy }) {
  if (!error) return null;
  return (
    <div className={styles.errorBanner} role="alert">
      <i className="fas fa-exclamation-circle" aria-hidden="true" />
      <span>{error} {stale ? "Showing the last successful result." : "No figures are shown until the data loads."}</span>
      <button type="button" onClick={onRetry} disabled={busy}>Retry</button>
    </div>
  );
}

export function Notes({ notes, title = "How these numbers are calculated" }) {
  if (!notes?.length) return null;
  return (
    <details className={styles.notes}>
      <summary><i className="fas fa-info-circle" aria-hidden="true" />{title}</summary>
      <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </details>
  );
}

function downloadCsv(filename, csv) {
  if (typeof window === "undefined" || !window.URL?.createObjectURL) return;
  const url = window.URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.URL.revokeObjectURL(url);
  }
}

// Page numbers around the current page: 1 … 4 5 6 … 12 (at most seven entries).
export function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_value, index) => index + 1);
  const start = Math.max(2, Math.min(page - 1, pages - 4)), end = Math.min(pages - 1, Math.max(page + 1, 5));
  const middle = Array.from({ length: end - start + 1 }, (_value, index) => start + index);
  return [1, ...(start > 2 ? ["gap-start"] : []), ...middle, ...(end < pages - 1 ? ["gap-end"] : []), pages];
}

// Search, sort, paginate and export one set of rows. Export writes every row that matches the
// search (all pages), in the order shown, so the file matches the table. With `heading` the table
// is its own card: title on the left, search and Export on the right. `numbered` adds a "#"
// column counting the rows in the order shown.
export function DataTable({ title, columns, rows, loading, emptyMessage, pageSize = 10, exportName, initialSort, searchLabel, searchPlaceholder,
  toolbar = null, footnote = null, heading = null, numbered = false }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(initialSort || { key: columns[0].key, direction: "asc" });
  const [page, setPage] = useState(1);
  const sortColumn = columns.find((column) => column.key === sort.key);
  const matching = useMemo(() => sortRows(searchRows(rows || [], search, columns), sortColumn, sort.direction), [rows, search, sortColumn, sort.direction, columns]);
  const shown = pageRows(matching, page, pageSize);
  const first = (shown.page - 1) * pageSize;
  const span = columns.length + (numbered ? 1 : 0);
  const toggle = (key) => { setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" })); setPage(1); };
  const tools = (
    <div className={styles.tableTools}>
      <label className={styles.search}>
        <i className="fas fa-search" aria-hidden="true" />
        <input type="search" aria-label={searchLabel || `Search ${title}`} placeholder={searchPlaceholder || searchLabel || "Search"} value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
      </label>
      {toolbar}
      {exportName ? (
        <button type="button" className={styles.secondaryButton} disabled={loading || !matching.length} aria-label={`Export ${title} as CSV`}
          onClick={() => downloadCsv(exportName, toCsv(columns, matching))}>
          <i className="fas fa-download" aria-hidden="true" />Export
        </button>
      ) : null}
    </div>
  );
  const body = (
    <div className={styles.tableBlock}>
      {heading ? <div className={styles.cardHead}><CardTitle {...heading} title={title} />{tools}</div> : tools}
      <div className={styles.tableScroll} role="region" aria-label={title} tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>{numbered ? <th scope="col" className={styles.indexCell}><span>#</span></th> : null}{columns.map((column) => {
              const active = sort.key === column.key;
              return (
                <th key={column.key} scope="col" className={column.numeric ? styles.numeric : ""}
                  aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggle(column.key)}>
                    {column.label}
                    <i aria-hidden="true" className={active ? (sort.direction === "asc" ? "fas fa-sort-up" : "fas fa-sort-down") : "fas fa-sort"} />
                  </button>
                </th>
              );
            })}</tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={span} className={styles.tableEmpty}>Loading…</td></tr>
              : !shown.rows.length ? <tr><td colSpan={span} className={styles.tableEmpty}>{search ? "No records match your search." : emptyMessage}</td></tr>
                : shown.rows.map((row, index) => (
                  <tr key={row.id ?? row.key ?? index}>
                    {numbered ? <td className={styles.indexCell}>{first + index + 1}</td> : null}
                    {columns.map((column) => <td key={column.key} className={column.numeric ? styles.numeric : ""}>{column.render ? column.render(row) : column.text ? column.text(row) : row[column.key]}</td>)}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <div className={styles.pager}>
        <span>{loading ? "" : matching.length
          ? `Showing ${(first + 1).toLocaleString("en-PH")} to ${(first + shown.rows.length).toLocaleString("en-PH")} of ${matching.length.toLocaleString("en-PH")} ${search ? "matching " : ""}${matching.length === 1 ? "record" : "records"}${footnote ? ` · ${footnote}` : ""}`
          : `0 records${footnote ? ` · ${footnote}` : ""}`}</span>
        {shown.pages > 1 && (
          <nav className={styles.pagerButtons} aria-label={`${title} pages`}>
            <button type="button" aria-label="Previous page" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)}><i className="fas fa-chevron-left" aria-hidden="true" /></button>
            {pageList(shown.page, shown.pages).map((entry) => typeof entry === "number"
              ? <button key={entry} type="button" aria-label={`Page ${entry}`} aria-current={entry === shown.page ? "page" : undefined}
                className={entry === shown.page ? styles.pageActive : ""} onClick={() => setPage(entry)}>{entry}</button>
              : <span key={entry} className={styles.pageGap} aria-hidden="true">…</span>)}
            <button type="button" aria-label="Next page" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.page + 1)}><i className="fas fa-chevron-right" aria-hidden="true" /></button>
          </nav>
        )}
      </div>
    </div>
  );
  return heading ? <article className={styles.card}>{body}</article> : body;
}
