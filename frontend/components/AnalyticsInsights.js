import { useEffect, useMemo, useRef, useState } from "react";
import { serviceColor, serviceLabel, statusLabel } from "../lib/analyticsCharts";
import {
  DOCTOR_OUTCOMES, HEAT_COLORS, WAIT_ALL, arrivalBreakdown, arrivalTrendChart, demandChart, doctorPerformance, doctorPerformanceChart,
  heatColor, waitBreakdown, waitTrendChart, weeklyHeatmap
} from "../lib/insightsCharts";

// The additional charts of the Detailed Data tab in Analytics. Every figure comes from the backend's
// `insights` (stored visits under the top filters); a chart without data shows a message instead.

const dash = "—";
const pct = (value) => (value == null ? dash : `${value}%`);

function Section({ title, description, children }) {
  return (
    <section className="grid gap-3 md:gap-4">
      <div className="mt-1">
        <h3 className="text-sm md:text-base font-bold brand-text mb-0.5">{title}</h3>
        {description ? <p className="text-xs brand-text-muted mb-0">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Card({ title, icon, note, children, className = "" }) {
  return (
    <div className={`bg-white rounded-lg shadow-md p-3 md:p-4 min-w-0 ${className}`}>
      <h4 className="text-sm md:text-base font-bold brand-text mb-3 flex items-center gap-1.5">
        <i className={`${icon} brand-text-primary text-sm`} aria-hidden="true" />
        <span className="leading-tight">{title}</span>
      </h4>
      {children}
      {note ? <p className="text-[11px] brand-text-muted mt-3 mb-0">{note}</p> : null}
    </div>
  );
}

const CHART_RETRY_MS = 500;
const CHART_WAIT_MS = 10000;
function readBrand() {
  const fallback = { primary: "#167d3f", forest: "#0b3d2e" };
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const theme = getComputedStyle(document.documentElement);
  return {
    primary: theme.getPropertyValue("--brand-primary").trim() || fallback.primary,
    forest: theme.getPropertyValue("--brand-forest").trim() || fallback.forest
  };
}

// One Chart.js canvas. `build(data, brand)` returns a configuration, or null when there is nothing
// to draw, in which case `empty` is shown instead of a chart. Optional: `onChart(instance | null)`
// hands the live chart to its panel, and `onHoverIndex(index | null)` reports the hovered point.
function InsightChart({ title, data, build, empty = "No data for the selected filters.", height = "h-[280px]", style, onChart, onHoverIndex }) {
  const canvas = useRef(null);
  const listeners = useRef(null);
  listeners.current = { onChart, onHoverIndex };
  const [failed, setFailed] = useState(false);
  const config = useMemo(() => build(data, readBrand()), [build, data]);
  useEffect(() => {
    if (!config) return undefined;
    let instance = null;
    let timer;
    const started = Date.now();
    const draw = () => {
      if (!window.Chart || !canvas.current) {
        if (Date.now() - started < CHART_WAIT_MS) timer = setTimeout(draw, CHART_RETRY_MS);
        else setFailed(true);
        return;
      }
      const options = listeners.current.onHoverIndex
        ? { ...config.options, onHover: (event, active) => listeners.current.onHoverIndex?.(active.length ? active[0].index : null) }
        : config.options;
      instance = new window.Chart(canvas.current.getContext("2d"), { ...config, options });
      listeners.current.onChart?.(instance);
    };
    draw();
    return () => {
      clearTimeout(timer);
      if (instance) listeners.current.onChart?.(null);
      instance?.destroy();
    };
  }, [config]);
  return (
    <div className={`chart-container relative ${height}`} style={style}>
      {config && !failed ? <canvas ref={canvas} role="img" aria-label={title} /> : (
        <div className="h-full flex flex-col items-center justify-center gap-2 brand-text-muted text-sm text-center px-4" role="status">
          <i className="fas fa-chart-bar text-2xl opacity-40" aria-hidden="true" />
          {failed ? "The chart library could not be loaded." : empty}
        </div>
      )}
    </div>
  );
}

function Notice({ children, tone = "muted" }) {
  const toneClass = tone === "warning" ? "bg-amber-50 border-amber-200 text-amber-900" : "brand-bg-subtle brand-border brand-text-muted";
  return (
    <p role="status" className={`text-xs border rounded-md px-3 py-2 mb-0 flex items-start gap-2 ${toneClass}`}>
      <i className="fas fa-info-circle mt-0.5" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function FilterNotes({ filters }) {
  if (!filters?.status) return null;
  return (
    <Notice tone="warning">
      The Status filter is set to {statusLabel(filters.status)}, so the charts below cover only those visits.
    </Notice>
  );
}

function Unavailable({ insights }) {
  if (insights?.error) return <Notice tone="warning">{insights.error}</Notice>;
  return <Notice>The additional analytics appear here once the selected period has loaded.</Notice>;
}

const TREND_NOTE = {
  day: "One point per day.",
  week: "One point per week (Monday to Sunday) because the selected period is longer than two months.",
  month: "One point per month because the selected period is longer than a year."
};

const minutes = (value) => (value == null ? dash : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`);
const patients = (count) => `${count} patient${count === 1 ? "" : "s"}`;
const TOGGLE_BUTTON = "px-2 py-1 rounded-md border brand-border brand-text hover:bg-gray-50 disabled:opacity-40 disabled:cursor-default";

// Average Wait Time Trend: the chart, then the services as a responsive, toggleable grid instead
// of the canvas legend. The grid shows each service's average for the selected period, or for the
// hovered point. Hiding lines (All services included) rescales the minutes axis to what is shown.
function WaitTrendPanel({ trends, waitStats }) {
  const [chart, setChart] = useState(null);
  const [period, setPeriod] = useState(null);
  const [hidden, setHidden] = useState(NO_SERVICES_HIDDEN);
  const [focus, setFocus] = useState(null);
  const breakdown = useMemo(() => waitBreakdown(trends, waitStats, period), [trends, waitStats, period]);

  useEffect(() => { setPeriod(null); }, [trends]);

  useEffect(() => {
    if (!chart?.canvas) return;
    chart.data.datasets.forEach((dataset, index) => {
      chart.setDatasetVisibility(index, !hidden.includes(dataset.key));
      if (!dataset.service) return;
      const lit = !focus || dataset.service === focus;
      dataset.borderColor = lit ? dataset.hue : `${dataset.hue}2e`;
      dataset.borderWidth = dataset.service === focus ? 3 : SERVICE_LINE_WIDTH;
    });
    chart.update("none");
  }, [chart, hidden, focus]);

  const toggle = (key) => setHidden((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]));
  const services = breakdown.rows.map((row) => row.service);
  const allOff = hidden.includes(WAIT_ALL);
  const word = PERIOD_WORD[trends?.grouping] || "day";
  const forest = readBrand().forest;

  return (
    <Card title="Average Wait Time Trend" icon="fas fa-chart-line"
      note={`Average minutes from registration until the call (the Avg Wait card's rule). All services is the average over every patient called, not an average of the service averages. ${TREND_NOTE[trends?.grouping] || ""} Gaps are periods with no patient called.`}>
      <div onMouseLeave={() => setPeriod(null)}>
        <InsightChart title="Average Wait Time Trend" data={trends} build={waitTrendChart} height="" style={{ height: "clamp(260px, 42vw, 340px)" }}
          onChart={setChart} onHoverIndex={setPeriod} />
      </div>
      {breakdown.samples > 0 || breakdown.period != null ? (
        <div className="mt-3 border-t brand-border pt-3" aria-label="Average wait by service">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-2.5">
            <button type="button" aria-pressed={!allOff} title={`${allOff ? "Show" : "Hide"} the All services line`}
              className={`flex items-center gap-2 min-w-0 text-left rounded-md px-1 -mx-1 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-700 ${allOff ? "opacity-60" : ""}`}
              onClick={() => toggle(WAIT_ALL)}>
              <LineSwatch hue={forest} width={3.5} />
              <span className="text-sm brand-text leading-tight">
                <span className={`font-bold ${allOff ? "line-through" : ""}`}>All services</span>
                <span className="brand-text-muted"> · {breakdown.title}</span>
                {breakdown.period != null ? (
                  <><span className="brand-text-muted"> · </span><span className="font-semibold tabular-nums">{breakdown.minutes == null ? "no patients called" : minutes(breakdown.minutes)}</span></>
                ) : null}
                <span className="block text-[11px] brand-text-muted mt-0.5">
                  {patients(breakdown.samples)} called
                  {breakdown.period == null ? ` · hover or tap the chart to see one ${word}` : ""}
                </span>
              </span>
            </button>
            {breakdown.toggleable ? (
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <button type="button" className={TOGGLE_BUTTON} disabled={!hidden.length} onClick={() => setHidden(NO_SERVICES_HIDDEN)}>Show all</button>
                <button type="button" className={TOGGLE_BUTTON} disabled={services.every((key) => hidden.includes(key))}
                  onClick={() => setHidden((list) => [...list.filter((key) => key === WAIT_ALL), ...services])}>Hide all services</button>
              </div>
            ) : null}
          </div>
          {breakdown.toggleable ? (
            <>
              <ul className="m-0 p-0 list-none grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10.5rem, 1fr))" }}>
                {breakdown.rows.map((row) => {
                  const off = hidden.includes(row.service);
                  return (
                    <li key={row.service} className="min-w-0">
                      <button type="button" aria-pressed={!off} title={`${off ? "Show" : "Hide"} the ${row.label} line`}
                        className={`w-full h-full flex items-center gap-2 rounded-md border brand-border px-2 py-1.5 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-700 ${off ? "opacity-60" : ""}`}
                        onClick={() => toggle(row.service)} onMouseEnter={() => setFocus(off ? null : row.service)} onMouseLeave={() => setFocus(null)}
                        onFocus={() => setFocus(off ? null : row.service)} onBlur={() => setFocus(null)}>
                        <LineSwatch hue={row.hue} dash={row.dash} />
                        <span className="flex-1 min-w-0">
                          <span className={`block text-xs leading-tight break-words ${off ? "line-through brand-text-muted" : "brand-text"}`}>{row.label}</span>
                          <span className="block text-[11px] leading-tight mt-0.5 tabular-nums">
                            <span className={row.minutes == null ? "brand-text-muted" : "font-semibold brand-text"}>{minutes(row.minutes)}</span>
                            <span className="brand-text-muted"> · {patients(row.samples)}</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] brand-text-muted mt-2 mb-0">
                Select a line to show or hide it; point at a service to highlight it. The minutes axis rescales to the lines shown, so hiding services with long waits makes shorter waits easier to read.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// The Unassigned group: visits with no doctor recorded, shown beside the doctor bars with the same
// outcome colours. Its counts are the payload's; nothing is reassigned or hidden.
function UnassignedSummary({ row }) {
  return (
    <div className="mt-3 rounded-md border border-dashed brand-border px-3 py-2.5" aria-label="Unassigned visits">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-bold brand-text mb-0 flex items-center gap-1.5">
          <i className="fas fa-user-slash brand-text-muted text-xs" aria-hidden="true" />Unassigned
        </p>
        <p className="text-sm brand-text mb-0"><span className="font-semibold tabular-nums">{row.total}</span> patient{row.total === 1 ? "" : "s"}</p>
      </div>
      <p className="text-[11px] brand-text-muted mt-0.5 mb-2">
        Visits with no doctor recorded on them, so they are not attributed to an individual doctor and are kept out of the bars above. They are still counted in every total.
      </p>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100 gap-0.5" aria-hidden="true">
        {DOCTOR_OUTCOMES.filter((outcome) => row[outcome.key] > 0).map((outcome) => (
          <span key={outcome.key} style={{ flex: `${row[outcome.key]} 1 0`, minWidth: 3, backgroundColor: outcome.color }} />
        ))}
      </div>
      <ul className="m-0 mt-2 p-0 list-none grid gap-x-3 gap-y-1 text-xs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(8.5rem, 1fr))" }}>
        {DOCTOR_OUTCOMES.map((outcome) => (
          <li key={outcome.key} className="flex items-center gap-1.5 min-w-0">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: outcome.color }} aria-hidden="true" />
            <span className="brand-text truncate">{outcome.label}</span>
            <span className={`ml-auto tabular-nums ${row[outcome.key] ? "font-semibold brand-text" : "brand-text-muted"}`}>{row[outcome.key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Doctor Performance Comparison: horizontal stacked bars for the doctors with a total at each bar's
// end, an outcome legend that toggles each outcome (with its count across the doctors), and the
// Unassigned group in its own section of the same card.
function DoctorPerformancePanel({ volumes }) {
  const [chart, setChart] = useState(null);
  const [hidden, setHidden] = useState(NO_SERVICES_HIDDEN);
  const summary = useMemo(() => doctorPerformance(volumes), [volumes]);

  useEffect(() => {
    if (!chart?.canvas) return;
    chart.data.datasets.forEach((dataset, index) => chart.setDatasetVisibility(index, !hidden.includes(dataset.outcome)));
    chart.update("none");
  }, [chart, hidden]);

  const toggle = (key) => setHidden((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]));
  const hasDoctors = summary.doctors.length > 0;

  return (
    <Card title="Doctor Performance Comparison" icon="fas fa-user-check"
      note="Patients attributed to each doctor, split by outcome; the number at the end of a bar is its total. Hover or tap a bar for the exact counts.">
      <InsightChart title="Doctor Performance Comparison" data={volumes} build={doctorPerformanceChart} height=""
        style={{ height: hasDoctors ? summary.height : 200 }} onChart={setChart}
        empty={summary.unassigned ? "No visits in the selected period are attributed to a doctor." : undefined} />
      {hasDoctors ? (
        <div className="mt-3 border-t brand-border pt-3">
          <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5" aria-label="Outcomes across the doctors">
            {summary.outcomeTotals.map((outcome) => {
              const off = hidden.includes(outcome.key);
              return (
                <li key={outcome.key}>
                  <button type="button" aria-pressed={!off} title={`${off ? "Show" : "Hide"} ${outcome.label} in the bars`}
                    className={`flex items-center gap-2 rounded-md border brand-border px-2 py-1 text-xs hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-700 ${off ? "opacity-60" : ""}`}
                    onClick={() => toggle(outcome.key)}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: outcome.color }} aria-hidden="true" />
                    <span className={off ? "line-through brand-text-muted" : "brand-text"}>{outcome.label}</span>
                    <span className={`tabular-nums ${outcome.count ? "font-semibold brand-text" : "brand-text-muted"}`}>{outcome.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] brand-text-muted mt-2 mb-0">
            {patients(summary.doctorTotal)} across {summary.doctors.length} doctor{summary.doctors.length === 1 ? "" : "s"}. Select an outcome to show or hide it in the bars.
          </p>
        </div>
      ) : null}
      {summary.unassigned ? <UnassignedSummary row={summary.unassigned} /> : null}
      {summary.unassigned && hasDoctors ? (
        <p className="text-xs brand-text mt-2 mb-0">
          All records: <span className="font-semibold tabular-nums">{summary.total}</span>
          <span className="brand-text-muted"> = {summary.doctorTotal} attributed to doctors + {summary.unassigned.total} unassigned</span>
        </p>
      ) : null}
    </Card>
  );
}

function PerformanceSections({ insights }) {
  return (
    <>
      <Section title="Customer Experience" description="How long patients wait to be called.">
        <WaitTrendPanel trends={insights.trends} waitStats={insights.wait} />
      </Section>
      <Section title="Staff and Operational Efficiency" description="Patients handled by each doctor.">
        <DoctorPerformancePanel volumes={insights.volumes} />
      </Section>
    </>
  );
}

function WeeklyHeatmap({ peak }) {
  const heat = weeklyHeatmap(peak);
  if (!heat.total && !heat.outside) return <p className="text-sm brand-text-muted mb-0">No arrivals in the selected period.</p>;
  const last = heat.columns.length - 1;
  return (
    <div>
      <div className="grid gap-1 text-[11px]" style={{ gridTemplateColumns: `2.25rem repeat(${heat.columns.length}, minmax(0, 1fr))` }}
        role="table" aria-label="Weekly queue heatmap: patients registered by day and time">
        {/* A real (empty) grid slot, so each weekday label lines up at the start of its row. */}
        <span role="columnheader" aria-label="Day" />
        {heat.columns.map((column) => (
          <span key={column.label} role="columnheader" className="text-center font-semibold brand-text-muted leading-tight">{column.label}</span>
        ))}
        {heat.rows.map((row) => [
          <span key={`${row.weekday}-label`} role="rowheader" className="flex items-center font-semibold brand-text">{row.weekday.slice(0, 3)}</span>,
          ...row.cells.map((count, index) => {
            const column = heat.columns[index];
            const description = `${row.weekday}, ${column.range}: ${count} patient${count === 1 ? "" : "s"}`;
            const anchor = index === 0 ? "left-0" : index === last ? "right-0" : "left-1/2 -translate-x-1/2";
            return (
              <span key={`${row.weekday}-${column.label}`} role="cell" tabIndex={0} aria-label={description}
                className="group relative h-7 rounded-md border brand-border outline-none focus:ring-2 focus:ring-green-700"
                style={{ backgroundColor: heatColor(count, heat.max) || "#f8faf8" }}>
                <span className={`pointer-events-none absolute bottom-full mb-1.5 ${anchor} z-20 hidden group-hover:block group-focus:block whitespace-nowrap rounded-md px-2 py-1 text-[11px] text-white shadow-lg`}
                  style={{ backgroundColor: "#172033" }}>
                  <strong>{row.weekday}</strong>, {column.range}<br />{count} patient{count === 1 ? "" : "s"}
                </span>
              </span>
            );
          })
        ])}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-3 text-[11px] brand-text-muted">
        <span>Fewer</span>
        {HEAT_COLORS.map((color) => <span key={color} className="h-2.5 w-5 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />)}
        <span>More</span>
        <span className="ml-auto">Busiest interval: {heat.max} patient{heat.max === 1 ? "" : "s"}</span>
      </div>
      {heat.outside ? (
        <p className="text-[11px] brand-text-muted mt-1 mb-0">
          {heat.outside} patient{heat.outside === 1 ? "" : "s"} registered outside 8 AM – 6 PM {heat.outside === 1 ? "is" : "are"} not shown here but {heat.outside === 1 ? "is" : "are"} counted in every other figure.
        </p>
      ) : null}
    </div>
  );
}

function DemandDonut({ demand }) {
  if (!demand?.total) return <p className="text-sm brand-text-muted mb-0">No visits match the selected filters.</p>;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-5">
      <div className="relative shrink-0" style={{ width: 180, height: 180 }}>
        <InsightChart title="Service demand distribution" data={demand} build={demandChart} height="" style={{ width: 180, height: 180, margin: 0 }} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold brand-text tabular-nums leading-none">{demand.total}</span>
          <span className="text-xs brand-text-muted mt-1">Total</span>
        </div>
      </div>
      <ul className="m-0 p-0 list-none grid gap-2.5 min-w-0 w-full sm:w-auto">
        {demand.services.map((row) => (
          <li key={row.service} className="flex items-start gap-2">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: serviceColor(row.service) }} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm brand-text leading-tight">{serviceLabel(row.service)}</span>
              <span className="block text-sm font-semibold brand-text tabular-nums">{pct(row.share)}
                <span className="text-xs font-normal brand-text-muted"> · {row.count} patient{row.count === 1 ? "" : "s"}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The Traffic & Flow overview: weekly heatmap on the left, service demand on the right; they stack
// on small screens. Both count the same filtered visits, so both add up to Total Patients.
function TrafficOverview({ insights }) {
  return (
    <section className="bg-white rounded-lg shadow-md p-3 md:p-4 min-w-0" aria-labelledby="traffic-flow-title">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 id="traffic-flow-title" className="text-base md:text-lg font-bold brand-text mb-0 flex items-center gap-2">
          <i className="fas fa-chart-line brand-text-primary" aria-hidden="true" />Traffic &amp; Flow
        </h3>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4 lg:gap-0">
        <div className="min-w-0 lg:pr-5">
          <h4 className="text-sm font-bold brand-text mb-2">Weekly Queue Heatmap</h4>
          <WeeklyHeatmap peak={insights.peak} />
        </div>
        <div className="min-w-0 border-t lg:border-t-0 lg:border-l brand-border pt-4 lg:pt-0 lg:pl-5">
          <h4 className="text-sm font-bold brand-text mb-2">Service Demand</h4>
          <DemandDonut demand={insights.demand} />
        </div>
      </div>
      <p className="text-[11px] brand-text-muted mt-3 mb-0">
        Patients registered in the selected period (Asia/Manila), under the filters above. Hover a cell or a donut segment for exact figures.
      </p>
    </section>
  );
}

// The line's look in the legend: the same hue and dash pattern as on the chart.
function LineSwatch({ hue, dash = [], width = 2.5 }) {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" className="shrink-0" aria-hidden="true">
      <line x1="2" y1="5" x2="20" y2="5" stroke={hue} strokeWidth={width} strokeLinecap="round" strokeDasharray={dash.join(" ") || undefined} />
    </svg>
  );
}

const NO_SERVICES_HIDDEN = [];
const PERIOD_WORD = { day: "day", week: "week", month: "month" };
const SERVICE_LINE_WIDTH = 1.75;

// Patient Arrival Trend: the chart, then the service breakdown as a responsive grid instead of the
// canvas legend. The grid shows the selected period's totals, or the hovered point's counts; each
// service toggles its line, and hovering or focusing one highlights its line.
function ArrivalTrendPanel({ trends }) {
  const [chart, setChart] = useState(null);
  const [period, setPeriod] = useState(null);
  const [hidden, setHidden] = useState(NO_SERVICES_HIDDEN);
  const [focus, setFocus] = useState(null);
  const breakdown = useMemo(() => arrivalBreakdown(trends, period), [trends, period]);
  const hasData = breakdown.total > 0 || breakdown.period != null;

  // New filters bring a new period list, so a hovered index no longer applies.
  useEffect(() => { setPeriod(null); }, [trends]);

  useEffect(() => {
    if (!chart?.canvas) return; // a destroyed chart has no canvas
    chart.data.datasets.forEach((dataset, index) => {
      if (!dataset.service) return;
      chart.setDatasetVisibility(index, !hidden.includes(dataset.service));
      const lit = !focus || dataset.service === focus;
      dataset.borderColor = lit ? dataset.hue : `${dataset.hue}2e`;
      dataset.borderWidth = dataset.service === focus ? 3 : SERVICE_LINE_WIDTH;
    });
    chart.update("none");
  }, [chart, hidden, focus]);

  const toggle = (service) => setHidden((list) => (list.includes(service) ? list.filter((key) => key !== service) : [...list, service]));
  const allShown = !hidden.length;
  const word = PERIOD_WORD[trends?.grouping] || "day";

  return (
    <Card title="Patient Arrival Trend" icon="fas fa-chart-area"
      note={`Patients registered in the selected period, in total and per service. ${TREND_NOTE[trends?.grouping] || ""}`}>
      <div onMouseLeave={() => setPeriod(null)}>
        <InsightChart title="Patient Arrival Trend" data={trends} build={arrivalTrendChart} height="h-[280px] sm:h-[320px] lg:h-[340px]"
          onChart={setChart} onHoverIndex={setPeriod} />
      </div>
      {hasData && breakdown.rows.length ? (
        <div className="mt-3 border-t brand-border pt-3" aria-label="Patient arrivals by service">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <LineSwatch hue={readBrand().forest} width={3.5} />
              <p className="text-sm brand-text mb-0 leading-tight">
                <span className="font-bold">{breakdown.title}</span>
                <span className="brand-text-muted"> · </span>
                <span className="font-semibold tabular-nums">{breakdown.total}</span> patient{breakdown.total === 1 ? "" : "s"}
                <span className="block text-[11px] brand-text-muted mt-0.5">
                  {breakdown.withArrivals} of {breakdown.rows.length} service{breakdown.rows.length === 1 ? "" : "s"} with arrivals
                  {breakdown.period == null ? ` · hover or tap the chart to see one ${word}` : ""}
                </span>
              </p>
            </div>
            {breakdown.toggleable ? (
              <div className="flex items-center gap-1 text-xs">
                <button type="button" className="px-2 py-1 rounded-md border brand-border brand-text hover:bg-gray-50 disabled:opacity-40 disabled:cursor-default"
                  disabled={allShown} onClick={() => setHidden(NO_SERVICES_HIDDEN)}>Show all</button>
                <button type="button" className="px-2 py-1 rounded-md border brand-border brand-text hover:bg-gray-50 disabled:opacity-40 disabled:cursor-default"
                  disabled={hidden.length === breakdown.rows.length} onClick={() => setHidden(breakdown.rows.map((row) => row.service))}>Hide all</button>
              </div>
            ) : null}
          </div>
          <ul className="m-0 p-0 list-none grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(9.5rem, 1fr))" }}>
            {breakdown.rows.map((row) => {
              const off = hidden.includes(row.service);
              const content = (
                <>
                  <LineSwatch hue={row.hue} dash={row.dash} />
                  <span className={`flex-1 min-w-0 text-xs leading-tight break-words ${off ? "line-through brand-text-muted" : "brand-text"}`}>{row.label}</span>
                  <span className={`text-xs tabular-nums ${row.count ? "font-semibold brand-text" : "brand-text-muted"}`}>{row.count}</span>
                </>
              );
              const box = `w-full h-full flex items-center gap-2 rounded-md border brand-border px-2 py-1.5 text-left ${off ? "opacity-60" : ""}`;
              return (
                <li key={row.service} className="min-w-0">
                  {breakdown.toggleable ? (
                    <button type="button" aria-pressed={!off} title={`${off ? "Show" : "Hide"} the ${row.label} line`}
                      className={`${box} hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-700`}
                      onClick={() => toggle(row.service)} onMouseEnter={() => setFocus(off ? null : row.service)} onMouseLeave={() => setFocus(null)}
                      onFocus={() => setFocus(off ? null : row.service)} onBlur={() => setFocus(null)}>
                      {content}
                    </button>
                  ) : <div className={box}>{content}</div>}
                </li>
              );
            })}
          </ul>
          {breakdown.toggleable ? (
            <p className="text-[11px] brand-text-muted mt-2 mb-0">Select a service to show or hide its line; point at one to highlight it.</p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function FlowSections({ insights }) {
  return (
    <section className="grid gap-3 md:gap-4">
      <TrafficOverview insights={insights} />
      <ArrivalTrendPanel trends={insights.trends} />
      <p className="text-xs brand-text-muted mb-0">The system serves a single facility, so there is no cross-branch comparison.</p>
    </section>
  );
}

export function DetailedInsights({ insights }) {
  if (!insights || insights.error) return <Unavailable insights={insights} />;
  return (
    <>
      <FilterNotes filters={insights.filters} />
      <PerformanceSections insights={insights} />
      <FlowSections insights={insights} />
    </>
  );
}
