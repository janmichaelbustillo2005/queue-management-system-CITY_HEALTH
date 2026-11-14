import { useEffect, useMemo, useRef, useState } from "react";
import {
  SERVICE_OUTCOMES, minutesValue, outcomeBarChart, outcomeDonutChart, percentText, serviceAnalytics, waitLineChart
} from "../lib/serviceAnalytics";

// Analytics → Detailed Data → By Service: four cards in a 2 × 2 grid (one column on small screens).
// All four read the same model (lib/serviceAnalytics.js) built from the page's `tableData`, `totals`
// and `insights.wait`, so they always change together with the top filters.

const CHART_RETRY_MS = 500;
const CHART_WAIT_MS = 10000;
const EMPTY_TEXT = "No visits match the selected filters.";

// One Chart.js canvas (Chart.js is loaded by the page from the CDN). The canvas is absolutely
// positioned inside its box, so the box sets the size and the chart follows it when it grows or shrinks.
function ServiceChart({ label, config, empty, className = "", style }) {
  const canvas = useRef(null);
  const [failed, setFailed] = useState(false);
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
    return () => {
      clearTimeout(timer);
      instance?.destroy();
    };
  }, [config]);
  if (!config || failed) return <Placeholder className={className} text={failed ? "The chart library could not be loaded." : empty} />;
  return (
    <div className={`svc-chart ${className}`} style={style}>
      <canvas ref={canvas} role="img" aria-label={label} />
    </div>
  );
}

function Placeholder({ text, className = "", icon = "fas fa-chart-bar" }) {
  return (
    <div className={`svc-placeholder ${className}`} role="status">
      <i className={`${icon} text-2xl opacity-40`} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function Card({ id, title, icon, note, children }) {
  return (
    <article className="svc-card" aria-labelledby={id}>
      <h4 id={id} className="svc-card-title">
        <i className={`${icon} brand-text-primary`} aria-hidden="true" />
        <span>{title}</span>
      </h4>
      {children}
      {note ? <p className="svc-note">{note}</p> : null}
    </article>
  );
}

function Swatch({ color }) {
  return <span className="svc-swatch" style={{ backgroundColor: color }} aria-hidden="true" />;
}

function OutcomeLegend({ outcomes }) {
  return (
    <ul className="svc-legend" aria-label="Outcome colours">
      {outcomes.map((outcome) => (
        <li key={outcome.key}><Swatch color={outcome.color} />{outcome.label}</li>
      ))}
    </ul>
  );
}

// Card 1 ----------------------------------------------------------------------------------------
function OutcomesByService({ model, state }) {
  const config = useMemo(() => outcomeBarChart(model), [model]);
  return (
    <Card id="svc-outcomes-title" title="Patients by Service and Outcome" icon="fas fa-chart-bar"
      note="Each bar is one service; the number above it is its total. Hover a bar for the exact counts.">
      {state ? state : (
        <>
          <div className="svc-chart-scroll">
            <ServiceChart className="svc-chart--fill" config={config} empty={EMPTY_TEXT}
              style={{ minWidth: Math.max(model.rows.length * 40, 280) }}
              label={`Stacked bar chart of patients by service and outcome, ${model.total} patients in total. Exact figures are in the By Service (Summary) table.`} />
          </div>
          {config ? <OutcomeLegend outcomes={model.outcomes} /> : null}
        </>
      )}
    </Card>
  );
}

// Card 2 ----------------------------------------------------------------------------------------
function OutcomeDistribution({ model, state }) {
  const config = useMemo(() => outcomeDonutChart(model), [model]);
  return (
    <Card id="svc-distribution-title" title="Overall Outcome Distribution" icon="fas fa-chart-pie"
      note="Shares of all patients in the selected period; the four outcomes add up to the total.">
      {state ? state : !config ? <Placeholder icon="fas fa-chart-pie" text={EMPTY_TEXT} /> : (
        <div className="svc-donut-layout">
          <div className="svc-donut">
            <ServiceChart config={config} empty={EMPTY_TEXT} className="svc-chart--square"
              label={`Donut chart of patient outcomes: ${model.outcomes.map((row) => `${row.label} ${row.count}`).join(", ")}.`} />
            <div className="svc-donut-center" aria-hidden="true">
              <span className="svc-donut-total">{model.total}</span>
              <span className="svc-donut-caption">Total Patients</span>
            </div>
          </div>
          <table className="svc-legend-table">
            <caption className="sr-only">Patients and share per outcome</caption>
            <thead>
              <tr><th scope="col">Outcome</th><th scope="col">Patients</th><th scope="col">Percentage</th></tr>
            </thead>
            <tbody>
              {model.outcomes.map((outcome) => (
                <tr key={outcome.key}>
                  <th scope="row"><Swatch color={outcome.color} />{outcome.label}</th>
                  <td>{outcome.count}</td>
                  <td>{percentText(outcome.percent)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th scope="row">Total</th><td>{model.total}</td><td>{percentText(100)}</td></tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

// Card 3 ----------------------------------------------------------------------------------------
function WaitByService({ model, state }) {
  const config = useMemo(() => waitLineChart(model), [model]);
  const unmeasured = model.unmeasured;
  return (
    <Card id="svc-wait-title" title="Average Wait Time by Service" icon="fas fa-clock"
      note="Minutes from registration until the call (the Avg Wait rule). Services are categories, not a timeline; the line only links them for comparison.">
      {state ? state : (
        <>
          <div className="svc-chart-scroll">
            <ServiceChart className="svc-chart--fill" config={config} style={{ minWidth: Math.max(model.rows.length * 40, 280) }}
              empty={model.total ? "No patient has been called yet, so there is no waiting time to show." : EMPTY_TEXT}
              label="Line chart of average waiting time in minutes per service. Exact figures are in the Avg Wait column of the By Service (Summary) table." />
          </div>
          {config && unmeasured.length ? (
            <p className="svc-gap-note" role="note">
              <i className="fas fa-info-circle" aria-hidden="true" />
              <span>No patient called yet, so no average (shown as a gap): {unmeasured.join(", ")}.</span>
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

// Card 4 ----------------------------------------------------------------------------------------
const OUTCOME = Object.fromEntries(SERVICE_OUTCOMES.map((outcome) => [outcome.key, outcome]));
const COLUMNS = [
  { key: "total", label: "Total", value: (row) => row.total, strong: true },
  ...SERVICE_OUTCOMES.map((outcome) => ({
    key: outcome.key, label: outcome.label, title: outcome.title, color: outcome.color, ink: outcome.ink, value: (row) => row[outcome.key]
  })),
  { key: "avg_wait", label: "Avg Wait", title: "Average minutes from registration until the call",
    value: (row) => (row.avgWait == null ? "—" : `${minutesValue(row.avgWait)}m`),
    hint: (row) => (row.avgWait == null ? "No patient called yet" : undefined) },
  { key: "avg_service", label: "Avg Service", title: "Average consultation minutes", value: (row) => `${row.avgService}m` },
  { key: "completion", label: "Completion", title: "Completed patients as a share of the total", ink: OUTCOME.completed.ink, strong: true,
    value: (row) => `${row.completion}%` }
];

// The backend totals row in the same shape as a service row, for the footer.
function footerRow(totals) {
  const count = (value) => Number(value) || 0;
  return {
    total: count(totals.total_patients), completed: count(totals.completed), cancelled: count(totals.cancelled),
    no_show: count(totals.no_show), in_queue: count(totals.waiting) + count(totals.serving),
    avgWait: totals.avgWait, avgService: totals.avg_service_time ?? "0.0", completion: totals.completion_rate ?? "0.0"
  };
}

function SummaryCard({ model, state }) {
  const other = model.outcomes.find((outcome) => outcome.key === "other");
  return (
    <Card id="svc-summary-title" title="By Service (Summary)" icon="fas fa-table"
      note={other ? `${other.count} visit${other.count === 1 ? " has" : "s have"} a status outside these columns; ${other.count === 1 ? "it is" : "they are"} counted in Total.` : null}>
      {state ? state : (
        <div className="svc-table-wrap">
          <table className="svc-table">
            <caption className="sr-only">Patients, outcomes, average times and completion rate per service</caption>
            <thead>
              <tr>
                <th scope="col" className="svc-col-service">Service</th>
                {COLUMNS.map((column) => (
                  // An outcome column is keyed to its chart colour by a line under its name.
                  <th key={column.key} scope="col" title={column.title}
                    style={column.color ? { boxShadow: `inset 0 -3px 0 ${column.color}` } : undefined}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.rows.length ? model.rows.map((row) => (
                <tr key={row.service ?? "not-recorded"}>
                  <th scope="row" className="svc-col-service">{row.label}</th>
                  {COLUMNS.map((column) => (
                    <td key={column.key} title={column.hint?.(row)} className={column.strong ? "svc-strong" : undefined}
                      style={column.ink ? { color: column.ink } : undefined}>{column.value(row)}</td>
                  ))}
                </tr>
              )) : (
                <tr><td colSpan={COLUMNS.length + 1} className="svc-empty-row">{EMPTY_TEXT}</td></tr>
              )}
            </tbody>
            {model.rows.length && model.totals ? (
              <tfoot>
                <tr>
                  <th scope="row" className="svc-col-service">All</th>
                  {COLUMNS.map((column) => {
                    const row = footerRow(model.totals);
                    return <td key={column.key} title={column.hint?.(row)}>{column.value(row)}</td>;
                  })}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </Card>
  );
}

export default function ServiceAnalytics({ tableData, totals, wait, status = "ready" }) {
  const model = useMemo(() => serviceAnalytics(tableData, totals, wait), [tableData, totals, wait]);
  const state = status === "loading" ? <Placeholder icon="fas fa-spinner fa-spin" text="Loading analytics…" />
    : status === "error" ? <Placeholder icon="fas fa-exclamation-triangle" text="Analytics could not be loaded. Use Apply to try again." />
      : null;
  return (
    <section className="svc-analytics" aria-labelledby="svc-analytics-title">
      <div>
        <h3 id="svc-analytics-title" className="text-base md:text-lg font-bold brand-text mb-0.5 flex items-center gap-2">
          <i className="fas fa-layer-group brand-text-primary" aria-hidden="true" />By Service
        </h3>
        <p className="text-xs brand-text-muted mb-0">
          Visits in the selected period under the filters above. All four cards use the same figures.
        </p>
      </div>
      <div className="svc-analytics-grid">
        <OutcomesByService model={model} state={state} />
        <OutcomeDistribution model={model} state={state} />
        <WaitByService model={model} state={state} />
        <SummaryCard model={model} state={state} />
      </div>
    </section>
  );
}
