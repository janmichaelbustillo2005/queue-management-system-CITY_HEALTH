import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import SiteFrame from "../components/SiteFrame";
import PatientVisitDetailsDialog from "../components/PatientVisitDetailsDialog";
import { request } from "../lib/api";
import { resolveAccount } from "../lib/navigation";
import { OFFERED_SERVICES, serviceName } from "../lib/services";
import {
  DEFAULT_PAGE_SIZE, EMPTY_HISTORY_FILTERS, HISTORY_PAGE_SIZES, HISTORY_STATUS, HISTORY_STATUS_OPTIONS, NOT_RECORDED,
  SEARCH_DEBOUNCE_MS, dateRangeError, formatHistoryDate, formatHistoryTime, hasActiveFilters, historyPageButtons,
  historyPath, historyRangeSummary, priorityLabel, statusLabel
} from "../lib/patientHistory";

const EMPTY_RESULT = { rows: [], total: 0, page: 1, page_count: 1, summary: null, attribution_available: true };
const PAGE_BUTTON = "h-8 min-w-[2rem] px-2.5 rounded-lg border text-xs font-semibold transition-colors " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 " +
  "disabled:opacity-50 disabled:cursor-not-allowed";
const PAGE_IDLE = "brand-border bg-white brand-text brand-hover-subtle";
const PAGE_CURRENT = "brand-button border-transparent";
const CONTROL = "h-10 w-full rounded-lg border brand-border bg-white px-3 text-sm brand-text " +
  "focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600";
const HEADER_CELL = "px-4 py-3 text-xs font-bold brand-text-muted uppercase tracking-wider whitespace-nowrap";

const CARDS = [
  { key: "total_handled", label: "Total Handled", icon: "fas fa-clipboard-list", tone: "bg-blue-50 text-blue-600" },
  { key: "completed", label: "Completed", icon: "fas fa-check-circle", tone: "bg-emerald-50 text-emerald-600" },
  { key: "cancelled", label: "Cancelled", icon: "fas fa-times-circle", tone: "bg-red-50 text-red-600" },
  { key: "no_show", label: "No-show", icon: "fas fa-user-slash", tone: "bg-amber-50 text-amber-600" }
];

function Missing({ children = NOT_RECORDED, title }) {
  return <span className="brand-text-muted italic" title={title}>{children}</span>;
}

function StatusBadge({ status }) {
  const meta = HISTORY_STATUS[status];
  if (!meta) return <span className="text-xs font-semibold brand-text">{statusLabel(status)}</span>;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-semibold whitespace-nowrap ${meta.className}`}>
      <i className={meta.icon} aria-hidden="true" />{meta.label}
    </span>
  );
}

// PH1 Patient History: the signed-in doctor's own completed consultations, cancellations and
// no-shows. Read-only. The server picks the doctor from the session and refuses any other, so this
// page never sends a doctor; it only filters, searches and pages that doctor's own records.
export default function PatientHistoryPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const account = resolveAccount(user);
  const isDoctor = account?.kind === "doctor";

  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState(EMPTY_HISTORY_FILTERS);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
  const [data, setData] = useState(EMPTY_RESULT);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [detailsId, setDetailsId] = useState(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!loading && !isDoctor) router.replace(account?.homeHref || "/login");
  }, [loading, isDoctor, account?.homeHref, router]);

  // Search as the doctor types, after a short pause; a new search starts again at page 1.
  useEffect(() => {
    const search = searchInput.trim();
    if (search === filters.search) return undefined;
    const timer = setTimeout(() => {
      setFilters((current) => ({ ...current, search }));
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, filters.search]);

  const rangeError = dateRangeError(filters);
  const path = historyPath(filters, page, limit);

  useEffect(() => {
    if (!isDoctor || rangeError) { setBusy(false); return undefined; }
    const ticket = ++requestRef.current;
    setBusy(true); setError("");
    request(path).then((result) => {
      if (ticket !== requestRef.current) return;
      if (result?.error || !Array.isArray(result?.rows)) {
        setError(result?.error || "The server returned an unexpected patient history response.");
        setData(EMPTY_RESULT);
        return;
      }
      setData(result);
      // The server shows the last page when the requested one no longer exists.
      if (Number(result.page) && Number(result.page) !== page) setPage(Number(result.page));
    }).catch((failure) => {
      if (ticket === requestRef.current) { setError(failure?.message || "Request failed"); setData(EMPTY_RESULT); }
    }).finally(() => {
      if (ticket === requestRef.current) setBusy(false);
    });
    return undefined;
  }, [isDoctor, path, rangeError, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  function changeFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function clearFilters() {
    setSearchInput("");
    setFilters(EMPTY_HISTORY_FILTERS);
    setPage(1);
  }

  function changeLimit(value) {
    setLimit(value);
    setPage(1);
  }

  if (loading || !isDoctor) return <div className="flex items-center justify-center min-h-screen">Loading...</div>;

  const summary = data.summary;
  const filtered = hasActiveFilters({ ...filters, search: searchInput });
  const pageCount = Math.max(1, Number(data.page_count) || 1);
  const shownPage = Math.min(page, pageCount);
  const noHistory = !busy && !error && summary && summary.total_handled === 0 && !filtered;
  const emptyMessage = noHistory ? "No patient history available yet." : "No matching patient history found.";

  return (
    <SiteFrame title="Patient History" icon="fas fa-clipboard-list">
      <div className="admin-content p-4 md:p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-end gap-3">
          <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={busy}
            className="px-3 py-1.5 brand-button rounded-lg text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-60">
            <i className={`fas fa-sync-alt ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </button>
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex flex-wrap items-center gap-3">
            <i className="fas fa-exclamation-triangle" aria-hidden="true" />
            <span className="flex-1 min-w-0">{error}</span>
            <button type="button" className="underline font-semibold" onClick={() => setRefresh((value) => value + 1)}>Retry</button>
          </div>
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" aria-live="polite">
          {CARDS.map((card) => (
            <div key={card.key} data-history-card={card.key}
              className="stat-card bg-white p-4 rounded-xl shadow-sm border brand-border flex items-center gap-4">
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-xl ${card.tone}`}>
                <i className={card.icon} aria-hidden="true" />
              </div>
              <div>
                <div className="text-2xl font-bold brand-text">{summary ? summary[card.key] ?? 0 : "—"}</div>
                <div className="text-xs brand-text-muted uppercase tracking-wider font-semibold">{card.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border brand-border overflow-hidden">
          <div className="p-4 border-b brand-border bg-gray-50/50 space-y-3">
            <div className="flex items-center gap-2">
              <i className="fas fa-history brand-text-primary" aria-hidden="true" />
              <h3 className="font-bold brand-text m-0 text-base">My Patient Visits</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3 items-end">
              <label className="block xl:col-span-2">
                <span className="block text-xs font-semibold brand-text-muted mb-1">Search</span>
                <span className="relative block">
                  <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 brand-text-muted text-sm" aria-hidden="true" />
                  <input type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Search patient name or queue number..." maxLength={100}
                    className={`${CONTROL} pl-9`} aria-label="Search patient name or queue number" />
                </span>
              </label>
              <label className="block">
                <span className="block text-xs font-semibold brand-text-muted mb-1">Status</span>
                <select value={filters.status} onChange={(event) => changeFilter("status", event.target.value)} className={CONTROL}>
                  {HISTORY_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-semibold brand-text-muted mb-1">Service</span>
                <select value={filters.service} onChange={(event) => changeFilter("service", event.target.value)} className={CONTROL}>
                  <option value="">All Services</option>
                  {OFFERED_SERVICES.map((service) => <option key={service.value} value={service.value}>{service.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-semibold brand-text-muted mb-1">From Date</span>
                <input type="date" value={filters.from} max={filters.to || undefined}
                  onChange={(event) => changeFilter("from", event.target.value)} className={CONTROL}
                  aria-invalid={Boolean(rangeError)} />
              </label>
              <label className="block">
                <span className="block text-xs font-semibold brand-text-muted mb-1">To Date</span>
                <input type="date" value={filters.to} min={filters.from || undefined}
                  onChange={(event) => changeFilter("to", event.target.value)} className={CONTROL}
                  aria-invalid={Boolean(rangeError)} />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-sm m-0 ${rangeError ? "text-red-700 font-semibold" : "brand-text-muted"}`} role={rangeError ? "alert" : undefined}>
                {rangeError || "Dates are visit dates in Manila time and include both selected days."}
              </p>
              <button type="button" onClick={clearFilters} disabled={!filtered}
                className={`${PAGE_BUTTON} ${PAGE_IDLE} h-9 px-3 text-sm`}>
                <i className="fas fa-times me-1" aria-hidden="true" />Clear filters
              </button>
            </div>
          </div>

          <div className="overflow-x-auto" aria-busy={busy}>
            <table className="w-full text-left min-w-[980px]">
              <caption className="sr-only">Your patient history</caption>
              <thead>
                <tr className="bg-gray-50/50">
                  <th scope="col" className={HEADER_CELL}>Queue Number</th>
                  <th scope="col" className={HEADER_CELL}>Patient Name</th>
                  <th scope="col" className={HEADER_CELL}>Service</th>
                  <th scope="col" className={HEADER_CELL}>Priority</th>
                  <th scope="col" className={HEADER_CELL}>Date</th>
                  <th scope="col" className={HEADER_CELL}>Called At</th>
                  <th scope="col" className={HEADER_CELL}>Completed At</th>
                  <th scope="col" className={HEADER_CELL}>Status</th>
                  <th scope="col" className={`${HEADER_CELL} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--brand-border)]">
                {busy && !data.rows.length ? (
                  <tr><td colSpan={9} className="px-6 py-12 text-center brand-text-muted" role="status">
                    <i className="fas fa-spinner animate-spin text-3xl mb-3 block" aria-hidden="true" />Loading patient history…
                  </td></tr>
                ) : rangeError ? (
                  <tr><td colSpan={9} className="px-6 py-12 text-center text-red-700">{rangeError}</td></tr>
                ) : !data.rows.length ? (
                  <tr><td colSpan={9} className="px-6 py-12 text-center brand-text-muted" data-history-empty>
                    <i className={`fas ${noHistory ? "fa-clipboard" : "fa-search"} text-3xl mb-3 block`} aria-hidden="true" />{emptyMessage}
                  </td></tr>
                ) : data.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50/60 transition-colors" data-history-row={row.id}>
                    <th scope="row" className="px-4 py-3 font-bold brand-text whitespace-nowrap">{row.queue_number || <Missing />}</th>
                    <td className="px-4 py-3 brand-text">{row.patient_name || <Missing />}</td>
                    <td className="px-4 py-3 text-sm brand-text">{serviceName(row.service_type) || <Missing />}</td>
                    <td className="px-4 py-3 text-sm brand-text">{priorityLabel(row.priority_categories)}</td>
                    <td className="px-4 py-3 text-sm brand-text whitespace-nowrap">{formatHistoryDate(row.created_at)}</td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">{row.called_at ? formatHistoryTime(row.called_at) : <Missing />}</td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      {row.status !== "completed" ? <Missing title="Not applicable: this visit was not completed">—</Missing>
                        : row.completed_at ? formatHistoryTime(row.completed_at) : <Missing />}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => setDetailsId(row.id)}
                        aria-label={`View details of visit ${row.queue_number || row.id}`}
                        className="px-3 py-1.5 rounded-lg border brand-border bg-white brand-text text-xs font-semibold brand-hover-subtle transition-colors inline-flex items-center gap-1.5 whitespace-nowrap">
                        <i className="fas fa-eye" aria-hidden="true" />View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t brand-border" data-history-pagination>
            <p className="text-xs font-semibold brand-text-muted m-0" role="status" aria-live="polite">
              {historyRangeSummary({ page: shownPage, limit, total: data.total, rowCount: data.rows.length })}
            </p>
            <label className="flex items-center gap-2 text-xs font-semibold brand-text-muted">
              Records per page:
              <select value={limit} onChange={(event) => changeLimit(event.target.value)}
                className="h-8 rounded-lg border brand-border bg-white px-2 text-xs brand-text">
                {HISTORY_PAGE_SIZES.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
              </select>
            </label>
            <nav aria-label="Patient history pages" className="flex flex-wrap items-center gap-1">
              <button type="button" data-page-nav="previous" onClick={() => setPage(shownPage - 1)}
                disabled={busy || shownPage <= 1} className={`${PAGE_BUTTON} ${PAGE_IDLE}`}>
                <i className="fas fa-chevron-left me-1" aria-hidden="true" />Previous
              </button>
              {historyPageButtons(shownPage, pageCount).map((number) => (
                <button key={number} type="button" data-page={number} onClick={() => setPage(number)} disabled={busy && number !== shownPage}
                  aria-label={`Page ${number}`} aria-current={number === shownPage ? "page" : undefined}
                  className={`${PAGE_BUTTON} ${number === shownPage ? PAGE_CURRENT : PAGE_IDLE}`}>
                  {number}
                </button>
              ))}
              <button type="button" data-page-nav="next" onClick={() => setPage(shownPage + 1)}
                disabled={busy || shownPage >= pageCount} className={`${PAGE_BUTTON} ${PAGE_IDLE}`}>
                Next<i className="fas fa-chevron-right ms-1" aria-hidden="true" />
              </button>
            </nav>
          </div>
        </div>

        <p className="text-xs brand-text-muted m-0">
          <i className="fas fa-info-circle me-1" aria-hidden="true" />
          Only visits you handled are listed: consultations you completed, and visits you cancelled or marked no-show.
          Cancellations by the Front Desk are not included. Cancellations and no-shows from before the system began
          recording who made them are not attributed to any doctor. Times are shown in Manila.
        </p>
      </div>

      {detailsId != null ? <PatientVisitDetailsDialog key={detailsId} visitId={detailsId} onClose={() => setDetailsId(null)} /> : null}
    </SiteFrame>
  );
}
