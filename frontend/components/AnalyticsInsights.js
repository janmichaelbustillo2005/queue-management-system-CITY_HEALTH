import { useEffect, useMemo, useRef, useState } from "react";
import { serviceColor, serviceLabel, statusLabel } from "../lib/analyticsCharts";
import {
  HEAT_COLORS, arrivalTrendChart, demandChart, doctorPerformanceChart, heatColor, waitTrendChart, weeklyHeatmap
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
// to draw, in which case `empty` is shown instead of a chart.
function InsightChart({ title, data, build, empty = "No data for the selected filters.", height = "h-[280px]", style }) {
  const canvas = useRef(null);
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
      instance = new window.Chart(canvas.current.getContext("2d"), config);
    };
    draw();
    return () => { clearTimeout(timer); instance?.destroy(); };
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

function ChartPanel({ title, icon, note, className = "", ...chart }) {
  return (
    <Card title={title} icon={icon} note={note} className={className}>
      <InsightChart title={title} {...chart} />
    </Card>
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

function PerformanceSections({ insights }) {
  return (
    <>
      <Section title="Customer Experience" description="How long patients wait to be called.">
        <ChartPanel title="Average Wait Time Trend" icon="fas fa-chart-line" data={insights.trends} build={waitTrendChart}
          note={`Average minutes from registration until the call (the Avg Wait card's rule), for all services and for each service. ${TREND_NOTE[insights.trends?.grouping] || ""} Gaps are periods without patients.`} />
      </Section>
      <Section title="Staff and Operational Efficiency" description="Patients handled by each doctor.">
        <ChartPanel title="Doctor Performance Comparison" icon="fas fa-user-check" data={insights.volumes} build={doctorPerformanceChart}
          note="Patients handled by each doctor, split by outcome. Hover a bar for the exact counts and total." />
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

function FlowSections({ insights }) {
  return (
    <section className="grid gap-3 md:gap-4">
      <TrafficOverview insights={insights} />
      <ChartPanel title="Patient Arrival Trend" icon="fas fa-chart-area" data={insights.trends} build={arrivalTrendChart}
        note={`Patients registered in the selected period, in total and per service. ${TREND_NOTE[insights.trends?.grouping] || ""}`} />
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
