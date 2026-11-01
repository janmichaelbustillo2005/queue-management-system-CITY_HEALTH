import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./AlgorithmSimulation.module.css";
import {
  ALGORITHM_IDS, ALGORITHM_INFO, AGING_MAX_BONUS, AGING_STEP_MINUTES, DEFAULT_SCENARIO, DEFAULT_SEED, DEFAULT_SPEED, MODES,
  SCENARIO_LABELS, SCENARIO_OPTIONS, SLIDER_STEP, SPEEDS, advance, buildRun, classLabels, clock, comparisonRows, formatDuration,
  formatMinutes, formatPercent, nextEventTime, nextHighlight, parseSeed, recentEvents, sliderTime, snapshotAt, visibleAlgorithms
} from "../lib/algorithmSimulation";

const COLORS = { "WPS-A": "#167d3f", WRR: "#2563eb" };
const TICK_MS = 100;
const COMPACT_ROWS = 10;

// The banner opens the page; the corner badge keeps the label in view while it scrolls.
export function SimulationBanner() {
  return <>
    <div className={styles.banner} role="note">
      <i className="fas fa-flask" aria-hidden="true"/>
      <strong>Simulation Mode — Synthetic Data Only</strong>
      <span>Virtual patients and doctors from the seeded research model. Nothing here reads or changes patient records, the live queue, Call Now or the database.</span>
    </div>
    <div className={styles.cornerBadge} aria-hidden="true"><i className="fas fa-flask"/> Simulation Mode · Synthetic Data Only</div>
  </>;
}

const Dot = ({ group }) => <span className={styles.dot} data-group={group} aria-hidden="true"/>;

function DoctorPanels({ doctors }) {
  return <div className={styles.doctors}>
    {doctors.map(d => <div key={d.name} className={`${styles.doctor} ${d.serving ? styles.doctorServing : styles.doctorAvailable}`}>
      <div className={styles.doctorHead}>
        <span><i className="fas fa-user-md" aria-hidden="true"/> {d.name}</span>
        <span className={styles.status}>{d.status}</span>
      </div>
      {d.serving ? <div key={d.serving.id} className={styles.servingBody}>
        <div className={styles.servingTicket}><Dot group={d.serving.group}/>{d.serving.ticket} <span>{d.serving.category}</span></div>
        <div className={styles.progress} role="progressbar" aria-label={`${d.name} consultation progress`}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(d.progress * 100)}>
          <span style={{ width: `${Math.min(100, d.progress * 100)}%` }}/>
        </div>
        <div className={styles.small}>Consultation {clock(d.serving.start)} → {clock(d.serving.end)} ({formatMinutes(d.serving.consultation)})</div>
      </div> : <div className={styles.idle}>Ready for the next patient</div>}
      <div className={styles.doctorFoot}>
        <span>Completed <strong>{d.completed}</strong></span>
        <span>Utilization <strong>{formatPercent(d.utilization)}</strong></span>
      </div>
      {d.lastCompleted ? <div key={`done-${d.lastCompleted.id}`} className={styles.completed}>
        <i className="fas fa-check-circle" aria-hidden="true"/> Completed {d.lastCompleted.ticket} at {clock(d.lastCompleted.end)}
      </div> : null}
    </div>)}
  </div>;
}

function AgingRule({ waiting }) {
  const counts = [0, 1, 2].map(bonus => waiting.filter(p => p.bonus === bonus).length);
  return <div className={styles.rule}>
    <strong><i className="fas fa-hourglass-half" aria-hidden="true"/> {AGING_STEP_MINUTES}-minute Aging rule</strong>
    <span className={styles.ruleChip}>+0 under {AGING_STEP_MINUTES} min: {counts[0]}</span>
    <span className={styles.ruleChip} data-bonus="1">+1 after {AGING_STEP_MINUTES} min: {counts[1]}</span>
    <span className={styles.ruleChip} data-bonus="2">+{AGING_MAX_BONUS} after {AGING_STEP_MINUTES * 2} min (cap): {counts[2]}</span>
  </div>;
}

function WrrRotation({ decision, labels }) {
  const rotation = decision?.rotation;
  return <div className={styles.rule}>
    <strong><i className="fas fa-sync-alt" aria-hidden="true"/> Weighted rotation</strong>
    {rotation ? rotation.order.map(weight => <span key={weight} className={styles.ruleChip} data-current={weight === rotation.current ? "true" : undefined}>
      w{weight} · {labels[weight] || "—"}{weight === rotation.current ? ` · turn: ${rotation.credit} of ${weight} left` : ` · ${weight} per turn`}
    </span>) : <span className={styles.small}>The rotation starts at the highest class at the first call.</span>}
  </div>;
}

function DecisionExplanation({ decision, timeline }) {
  if (!decision) return <div className={styles.explanation}><h4>Why this patient?</h4><p className={styles.small}>No call yet. A doctor calls as soon as they are free and a patient has registered.</p></div>;
  const p = timeline.patients.find(x => x.id === decision.patientId);
  return <div className={styles.explanation}>
    <h4>Why this patient?</h4>
    <p className={styles.decisionHead}>
      <strong>{clock(decision.now)}</strong> — {decision.doctor} called <strong><Dot group={p.group}/>{p.ticket} {p.category}</strong>
      {decision.agingOvertake ? <span className={styles.badge} data-tone="gold">Aging changed this call</span> : null}
      {timeline.algorithm === "WRR" && decision.lowerScoreFirst ? <span className={styles.badge} data-tone="blue">Lower class&apos;s turn</span> : null}
      {decision.regularOverProtected ? <span className={styles.badge} data-tone="red">Priority-lane violation</span> : null}
    </p>
    <ul>{decision.reason.map((line, i) => <li key={i}>{line}</li>)}</ul>
  </div>;
}

function WaitingQueue({ algorithm, waiting, compact }) {
  const rows = compact ? waiting.slice(0, COMPACT_ROWS) : waiting;
  const aging = algorithm === "WPS-A";
  return <div className={styles.queue}>
    <div className={styles.queueHead}>
      <h4>Virtual waiting queue</h4>
      <span>{waiting.length} waiting{aging ? " · listed in WPS-A call order" : " · listed by WRR class, then registration"}</span>
    </div>
    <div className={`${styles.tableWrap} ${compact ? "" : styles.tableTall}`}>
      <table className={`${styles.table} ${compact ? styles.compactTable : ""}`}>
        <thead><tr>
          <th scope="col">{aging ? "Order" : "Class"}</th><th scope="col">Ticket</th><th scope="col">Registered</th><th scope="col">Category</th>
          <th scope="col">Base score</th><th scope="col">Aging bonus</th><th scope="col">Effective score</th><th scope="col">Waiting</th>
        </tr></thead>
        <tbody>
          {rows.map(p => <tr key={p.id} className={aging && p.order === 1 ? styles.nextRow : undefined}>
            <td>{aging ? `#${p.order}` : `w${p.base}`}</td>
            <td className={styles.ticket}>{p.ticket}</td>
            <td title={clock(p.arrival)}>{compact ? clock(p.arrival).slice(0, 5) : clock(p.arrival)}</td>
            <td><Dot group={p.group}/>{p.category}</td>
            <td>{p.base}</td>
            <td>{aging ? <span key={`${p.id}-${p.bonus}`} className={styles.bonus} data-bonus={p.bonus}>+{p.bonus}</span> : <span className={styles.muted} title="WRR does not use Aging">n/a</span>}</td>
            <td><strong>{p.effective}</strong></td>
            <td>{formatDuration(p.waited)}</td>
          </tr>)}
          {!waiting.length ? <tr><td colSpan={8} className={styles.empty}>Nobody is waiting.</td></tr> : null}
        </tbody>
      </table>
    </div>
    {compact && waiting.length > rows.length ? <p className={styles.small}>+ {waiting.length - rows.length} more waiting</p> : null}
  </div>;
}

function MetricCards({ algorithm, metrics }) {
  const cards = [
    ["Completed", metrics.completed], ["Waiting now", metrics.waiting],
    ["Average wait", formatMinutes(metrics.avgWait)], ["95th-percentile wait", formatMinutes(metrics.p95Wait)],
    ["Maximum wait", formatMinutes(metrics.maxWait)], ["Jain fairness", metrics.jainFairness == null ? "—" : metrics.jainFairness.toFixed(3)],
    ...Object.entries(metrics.utilization).map(([doctor, value]) => [`${doctor} utilization`, formatPercent(value)]),
    ["Priority-lane violations", metrics.regularBeforeProtected],
    algorithm === "WPS-A" ? ["Calls changed by Aging", metrics.agingOvertakes] : ["Lower-class turns", metrics.lowerScoreFirst]
  ];
  return <dl className={styles.metrics}>
    {cards.map(([label, value]) => <div key={label} className={styles.metric}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function AlgorithmPanel({ algorithm, timeline, snapshot, compact }) {
  const labels = useMemo(() => classLabels(timeline), [timeline]);
  const info = ALGORITHM_INFO[algorithm];
  return <section className={styles.panel} aria-labelledby={`sim-${algorithm}`} style={{ "--algo": COLORS[algorithm] }}>
    <div className={styles.panelHead}>
      <h3 id={`sim-${algorithm}`}>{info.title}</h3>
      <p>{info.summary}</p>
    </div>
    {algorithm === "WPS-A" ? <AgingRule waiting={snapshot.waiting}/> : <WrrRotation decision={snapshot.latest} labels={labels}/>}
    <DoctorPanels doctors={snapshot.doctors}/>
    <DecisionExplanation decision={snapshot.latest} timeline={timeline}/>
    <WaitingQueue algorithm={algorithm} waiting={snapshot.waiting} compact={compact}/>
    {compact ? null : <MetricCards algorithm={algorithm} metrics={snapshot.metrics}/>}
  </section>;
}

function EventLog({ timeline, t }) {
  const events = recentEvents(timeline, t, 10);
  const icon = { arrival: "fas fa-user-plus", call: "fas fa-bullhorn", complete: "fas fa-check" };
  return <section className={styles.panel} aria-label="Recent simulation events">
    <h4 className={styles.sectionTitle}>Recent events</h4>
    {events.length ? <ol className={styles.events}>{events.map(e => <li key={e.key} data-kind={e.kind}>
      <i className={icon[e.kind]} aria-hidden="true"/><span className={styles.ticket}>{e.clock}</span> {e.text}
    </li>)}</ol> : <p className={styles.small}>Press Start or Next Step to begin the simulated day.</p>}
  </section>;
}

// Patients waiting over the day for both algorithms; the solid part is up to the current time.
function QueueChart({ run, t }) {
  const W = 720, H = 220, L = 40, R = 12, T = 12, B = 28;
  const max = Math.max(1, ...ALGORITHM_IDS.flatMap(a => run.series[a]));
  const x = m => L + (m / run.end) * (W - L - R);
  const y = v => T + (1 - v / max) * (H - T - B);
  const path = (values, upto) => values.slice(0, Math.floor(upto) + 1).map((v, m) => `${m ? "L" : "M"}${x(m).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const hours = Array.from({ length: Math.floor(run.end / 60) + 1 }, (_, h) => h * 60);
  const yTicks = [0, Math.round(max / 2), max];
  return <figure className={styles.chart}>
    <figcaption>Patients waiting during the simulated day</figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Line chart of patients waiting over time for WPS-A and WRR">
      {yTicks.map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={styles.grid}/><text x={L - 6} y={y(v) + 4} textAnchor="end" className={styles.axis}>{v}</text></g>)}
      {hours.map(m => <text key={m} x={x(m)} y={H - 8} textAnchor="middle" className={styles.axis}>{clock(m).slice(0, 5)}</text>)}
      {ALGORITHM_IDS.map(a => <g key={a}>
        <path d={path(run.series[a], run.end)} fill="none" stroke={COLORS[a]} strokeOpacity="0.18" strokeWidth="2"/>
        <path d={path(run.series[a], t)} fill="none" stroke={COLORS[a]} strokeWidth="2.5" strokeDasharray={a === "WRR" ? "6 4" : undefined}/>
      </g>)}
      <line x1={x(t)} x2={x(t)} y1={T} y2={H - B} className={styles.cursor}/>
    </svg>
    <div className={styles.legend}>{ALGORITHM_IDS.map(a => <span key={a}><i style={{ background: COLORS[a] }}/>{a}</span>)}</div>
  </figure>;
}

// Average, 95th-percentile and maximum wait so far for both algorithms.
function WaitBars({ snapshots }) {
  const measures = [["avgWait", "Average"], ["p95Wait", "95th percentile"], ["maxWait", "Maximum"]];
  const W = 420, H = 220, L = 40, B = 40, T = 18;
  const max = Math.max(1, ...ALGORITHM_IDS.flatMap(a => measures.map(([key]) => snapshots[a].metrics[key] || 0)));
  const groupWidth = (W - L) / measures.length, bar = 34;
  return <figure className={styles.chart}>
    <figcaption>Waiting time of patients called so far (minutes)</figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart comparing average, 95th-percentile and maximum wait">
      <line x1={L} x2={W} y1={H - B} y2={H - B} className={styles.grid}/>
      {measures.map(([key, label], g) => <g key={key}>
        {ALGORITHM_IDS.map((a, i) => {
          const value = snapshots[a].metrics[key] || 0, h = (value / max) * (H - B - T);
          const bx = L + g * groupWidth + groupWidth / 2 - bar + i * bar;
          return <g key={a}>
            <rect x={bx} y={H - B - h} width={bar - 4} height={h} fill={COLORS[a]} rx="2"/>
            <text x={bx + (bar - 4) / 2} y={H - B - h - 4} textAnchor="middle" className={styles.axis}>{value.toFixed(0)}</text>
          </g>;
        })}
        <text x={L + g * groupWidth + groupWidth / 2} y={H - B + 18} textAnchor="middle" className={styles.axis}>{label}</text>
      </g>)}
    </svg>
    <div className={styles.legend}>{ALGORITHM_IDS.map(a => <span key={a}><i style={{ background: COLORS[a] }}/>{a}</span>)}</div>
  </figure>;
}

function Comparison({ run, snapshots, t }) {
  return <section className={styles.panel} aria-labelledby="sim-comparison">
    <h3 id="sim-comparison" className={styles.sectionTitle}>Comparison at {clock(t)}</h3>
    <div className={styles.compareCharts}><QueueChart run={run} t={t}/><WaitBars snapshots={snapshots}/></div>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th scope="col">Measure</th>{ALGORITHM_IDS.map(a => <th key={a} scope="col">{a}</th>)}</tr></thead>
        <tbody>{comparisonRows(snapshots).map(row => <tr key={row.label}>
          <th scope="row">{row.label}</th>
          {row.values.map((value, i) => <td key={i} className={row.better === ALGORITHM_IDS[i] ? styles.better : undefined}>{value}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <p className={styles.small}>Highlighted values are better at this moment. Waits count patients already called. Values describe one synthetic day, not clinic measurements.</p>
  </section>;
}

export default function AlgorithmSimulation() {
  const [mode, setMode] = useState("compare");
  const [scenario, setScenario] = useState(DEFAULT_SCENARIO);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [seedDraft, setSeedDraft] = useState(String(DEFAULT_SEED));
  const [seedError, setSeedError] = useState("");
  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const run = useMemo(() => buildRun(scenario, seed), [scenario, seed]);
  const algorithms = visibleAlgorithms(mode);
  const end = mode === "compare" ? run.end : run.timelines[mode].end;
  const snapshots = useMemo(() => Object.fromEntries(ALGORITHM_IDS.map(a => [a, snapshotAt(run.timelines[a], t)])), [run, t]);
  const atEnd = t >= end;

  useEffect(() => {
    if (!running) return undefined;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      setT(value => advance(value, speed, elapsed, end));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [running, speed, end]);
  useEffect(() => { if (running && t >= end) setRunning(false); }, [running, t, end]);

  const start = () => { if (atEnd) setT(0); setRunning(true); };
  const pause = () => setRunning(false);
  const step = () => {
    setRunning(false);
    const next = nextEventTime(algorithms.map(a => run.timelines[a]), t);
    if (next != null) setT(Math.min(next, end));
  };
  const reset = () => { setRunning(false); setT(0); };
  const jump = algorithm => {
    const next = nextHighlight(run.highlights[algorithm], t);
    if (next != null) { setRunning(false); setT(next); }
  };
  const loadScenario = value => { setRunning(false); setT(0); setScenario(value); };
  const applySeed = () => {
    const value = parseSeed(seedDraft);
    if (value == null) { setSeedError("Enter a whole number (up to 9 digits)."); return; }
    setSeedError(""); setRunning(false); setT(0); setSeed(value);
  };

  // Keyboard for the projector: Space start/pause, Right arrow next step, R reset.
  const keys = useRef({});
  keys.current = { running, start, pause, step, reset };
  useEffect(() => {
    const onKey = event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target?.closest?.("input, select, textarea, button, a")) return;
      const k = keys.current;
      if (event.key === " ") { event.preventDefault(); if (k.running) k.pause(); else k.start(); }
      else if (event.key === "ArrowRight") { event.preventDefault(); k.step(); }
      else if (event.key === "r" || event.key === "R") k.reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const description = SCENARIO_OPTIONS.find(s => s.value === scenario)?.description;
  return <div className={styles.simulation}>
    <SimulationBanner/>
    <section className={styles.intro}>
      <div className={styles.introText}>
        <h2>Algorithm Simulation</h2>
        <p>How WPS-A and WRR choose the next synthetic patient for three virtual general doctors sharing one queue. Both algorithms receive the same seeded patients, registration times, consultation lengths and doctors; only the choice of the next patient differs.</p>
      </div>
      <div className={styles.modes} role="group" aria-label="Simulation mode">
        {MODES.map(m => <button key={m.id} type="button" aria-pressed={mode === m.id} className={styles.modeButton} onClick={() => setMode(m.id)}>
          <i className={m.icon} aria-hidden="true"/>{m.label}
        </button>)}
      </div>
    </section>

    <section className={styles.controls} aria-label="Simulation controls">
      <div className={styles.playback}>
        <button type="button" className={styles.primary} onClick={start} disabled={running}><i className="fas fa-play" aria-hidden="true"/>Start</button>
        <button type="button" onClick={pause} disabled={!running}><i className="fas fa-pause" aria-hidden="true"/>Pause</button>
        <button type="button" onClick={step} disabled={atEnd}><i className="fas fa-step-forward" aria-hidden="true"/>Next Step</button>
        <button type="button" onClick={reset}><i className="fas fa-undo" aria-hidden="true"/>Reset</button>
        <label>Speed
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
            {SPEEDS.map(s => <option key={s} value={s}>{s} sim min / s</option>)}
          </select>
        </label>
      </div>
      <div className={styles.clockBox} aria-live="off">
        <span className={styles.clock}>{clock(t)}</span>
        <span className={styles.small}>{atEnd ? "Day complete" : running ? "Running" : "Paused"} · opens 08:00</span>
      </div>
      <input type="range" className={styles.scrubber} min={0} max={end} step={SLIDER_STEP} value={Math.min(t, end)}
        aria-label="Simulated time" aria-valuetext={clock(t)} onChange={e => { setRunning(false); setT(sliderTime(Number(e.target.value), end)); }}/>
      <div className={styles.setup}>
        <label>Scenario
          <select value={scenario} onChange={e => loadScenario(e.target.value)}>
            {SCENARIO_OPTIONS.map(s => <option key={s.value} value={s.value}>{SCENARIO_LABELS[s.value] || s.value}</option>)}
          </select>
        </label>
        <label>Seed
          <input value={seedDraft} inputMode="numeric" onChange={e => setSeedDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") applySeed(); }}
            aria-invalid={seedError ? "true" : undefined}/>
        </label>
        <button type="button" onClick={applySeed}><i className="fas fa-seedling" aria-hidden="true"/>Load seed</button>
        {algorithms.includes("WPS-A") ? <button type="button" onClick={() => jump("WPS-A")} disabled={nextHighlight(run.highlights["WPS-A"], t) == null}>
          <i className="fas fa-hourglass-half" aria-hidden="true"/>Next Aging overtake</button> : null}
        {algorithms.includes("WRR") ? <button type="button" onClick={() => jump("WRR")} disabled={nextHighlight(run.highlights.WRR, t) == null}>
          <i className="fas fa-sync-alt" aria-hidden="true"/>Next WRR lower-class turn</button> : null}
      </div>
      {seedError ? <p role="alert" className={styles.error}>{seedError}</p> : null}
      <p className={styles.small}>
        {SCENARIO_LABELS[scenario]}: {description}. Seed {seed}: {run.timelines["WPS-A"].patients.length} synthetic patients, identical for WPS-A and WRR.
        Keyboard: Space start/pause · → next step · R reset.
      </p>
    </section>

    {mode === "compare" ? <>
      <div className={styles.compareGrid}>
        {ALGORITHM_IDS.map(a => <AlgorithmPanel key={a} algorithm={a} timeline={run.timelines[a]} snapshot={snapshots[a]} compact/>)}
      </div>
      <Comparison run={run} snapshots={snapshots} t={t}/>
    </> : <div className={styles.singleGrid}>
      <AlgorithmPanel algorithm={mode} timeline={run.timelines[mode]} snapshot={snapshots[mode]}/>
      <EventLog timeline={run.timelines[mode]} t={t}/>
    </div>}

    <p className={styles.footerNote}><i className="fas fa-flask" aria-hidden="true"/> Simulation Mode — Synthetic Data Only. Generated in this browser by the research simulator (backend/simulation, shared queue with three general doctors); WRR is a research baseline that the live queue never uses. Method: docs/research/scheduling-simulation-methodology.md.</p>
  </div>;
}
