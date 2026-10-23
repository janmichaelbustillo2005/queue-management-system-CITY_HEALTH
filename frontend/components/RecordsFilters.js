import { useState } from "react";
import styles from "./RecordsFilters.module.css";
import { RECORD_FILTERS, cleanRecordFilters, recordFilterChips, sameRecordFilters } from "../lib/recordsFilters";

// Filter toolbar for one Records category. The page owns the draft (what the
// controls show) and the applied filters (what the table shows); nothing here
// filters rows on the client.
export default function RecordsFilters({ category, draft, applied, onChange, onApply, onReset, onRemove }) {
  const config = RECORD_FILTERS[category];
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const pendingDraft = cleanRecordFilters(category, draft);
  const advancedCount = config.advanced.filter(({ key }) => key in pendingDraft).length;
  const chips = recordFilterChips(category, applied);
  const unapplied = !sameRecordFilters(category, draft, applied);
  const advancedId = `records-more-filters-${category}`;

  function control({ key, label, type, placeholder, hint, options, allLabel }) {
    const id = `records-filter-${category}-${key}`;
    const value = draft[key] || "";
    const change = (event) => onChange(key, event.target.value);
    return (
      <div key={key} className={`${styles.field} ${type === "search" ? styles.searchField : ""}`}>
        <label htmlFor={id} className={styles.label}>
          {label}{hint ? <span className={styles.hint}>{hint}</span> : null}
        </label>
        {type === "search" ? (
          <span className={styles.searchBox}>
            <i className="fas fa-search" aria-hidden="true" />
            <input id={id} type="search" className={styles.input} value={value} placeholder={placeholder}
              maxLength={100} autoComplete="off" onChange={change} />
          </span>
        ) : type === "date" ? (
          <input id={id} type="date" className={styles.input} value={value} onChange={change} />
        ) : (
          <select id={id} className={styles.input} value={value} onChange={change}>
            <option value="">{allLabel}</option>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
      </div>
    );
  }

  return (
    <section className={styles.toolbar} aria-label="Record filters">
      <form role="search" aria-label="Filter records" onSubmit={(event) => { event.preventDefault(); onApply(); }}>
        <div className={styles.primary} style={{ "--filter-columns": config.primary.length - 1 }}>
          {config.primary.map(control)}
        </div>
        {config.advanced.length ? (
          // Collapsed filters stay mounted so their values survive; inert keeps them out of the tab order.
          <div id={advancedId} className={`${styles.advanced} ${advancedOpen ? styles.advancedOpen : ""}`}
            inert={!advancedOpen}>
            <div className={styles.advancedInner}>
              <div className={styles.advancedGrid}>{config.advanced.map(control)}</div>
            </div>
          </div>
        ) : null}
        <div className={styles.actions}>
          {config.advanced.length ? (
            <button type="button" className={styles.moreButton} aria-expanded={advancedOpen} aria-controls={advancedId}
              onClick={() => setAdvancedOpen((open) => !open)}>
              <i className="fas fa-sliders-h" aria-hidden="true" />
              More filters
              {advancedCount ? <span className={styles.count} aria-label={`${advancedCount} set`}>{advancedCount}</span> : null}
              <i className={`fas fa-chevron-down ${styles.chevron}`} aria-hidden="true" />
            </button>
          ) : null}
          <span className={styles.pendingNote} role="status">{unapplied ? "Changes not applied yet" : ""}</span>
          <div className={styles.buttons}>
            <button type="button" className={styles.resetButton} onClick={onReset}>
              <i className="fas fa-undo" aria-hidden="true" />Reset
            </button>
            <button type="submit" className={styles.applyButton}>
              <i className="fas fa-search" aria-hidden="true" />Apply filters
            </button>
          </div>
        </div>
      </form>
      {chips.length ? (
        <div className={styles.chips} role="group" aria-label="Applied filters">
          <span className={styles.chipsLabel}>Applied</span>
          {chips.map((chip) => (
            <button key={chip.key} type="button" className={styles.chip} onClick={() => onRemove(chip.key)}
              aria-label={`Remove filter ${chip.label}: ${chip.value}`}>
              <span><span className={styles.chipKey}>{chip.label}:</span> {chip.value}</span>
              <i className="fas fa-times" aria-hidden="true" />
            </button>
          ))}
          <button type="button" className={styles.clearAll} onClick={onReset}>Clear all</button>
        </div>
      ) : null}
    </section>
  );
}
