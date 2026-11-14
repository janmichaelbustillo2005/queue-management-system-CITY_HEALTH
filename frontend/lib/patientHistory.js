// PH1 Doctor Patient History: request paths, pagination and labels for pages/patient-history.js.
// The server decides whose history is returned (the signed-in doctor's own); nothing here names
// a doctor, so no request can ask for another doctor's records.

export const HISTORY_PATH = "/doctor/patient-history";
export const HISTORY_PAGE_SIZES = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
  { value: "all", label: "View All" }
];
export const DEFAULT_PAGE_SIZE = "10";
export const SEARCH_DEBOUNCE_MS = 300;
export const MAX_PAGE_BUTTONS = 3;
export const EMPTY_HISTORY_FILTERS = Object.freeze({ search: "", status: "", service: "", from: "", to: "" });
export const NOT_RECORDED = "Not recorded";

// Status filter options and badges. "Cancelled" in a doctor's history always means cancelled by
// that doctor: the server never lists a Front Desk or Superadmin cancellation here.
export const HISTORY_STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled by Doctor" },
  { value: "no-show", label: "No-show" }
];
export const HISTORY_STATUS = {
  completed: { label: "Completed", icon: "fas fa-check-circle", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  cancelled: { label: "Cancelled by Doctor", icon: "fas fa-times-circle", className: "bg-red-50 text-red-700 border-red-200" },
  "no-show": { label: "No-show", icon: "fas fa-user-slash", className: "bg-amber-50 text-amber-800 border-amber-200" }
};

export const PRIORITY_CATEGORY_LABELS = {
  senior: "Senior Citizen",
  pwd: "PWD",
  pregnant: "Pregnant",
  indigenous: "Indigenous People",
  solo_parent: "Solo Parent"
};

export function priorityLabel(categories) {
  const list = Array.isArray(categories) ? categories.filter((item) => typeof item === "string" && item) : [];
  return list.length ? list.map((item) => PRIORITY_CATEGORY_LABELS[item] || item).join(", ") : "Regular";
}

export function statusLabel(status) {
  return HISTORY_STATUS[status]?.label || String(status || NOT_RECORDED);
}

// From Date must not be later than To Date (both YYYY-MM-DD, so text order is date order).
export function dateRangeError({ from = "", to = "" } = {}) {
  return from && to && from > to ? "From Date must not be later than To Date." : "";
}

// The GET path for one page. Empty filters are left out; the search is trimmed (the server trims
// and ignores repeated spaces too).
export function historyPath(filters = EMPTY_HISTORY_FILTERS, page = 1, limit = DEFAULT_PAGE_SIZE) {
  const params = new URLSearchParams();
  const search = String(filters.search || "").trim();
  if (search) params.set("search", search);
  for (const key of ["status", "service", "from", "to"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  params.set("page", String(Math.max(1, Math.floor(Number(page) || 1))));
  params.set("limit", HISTORY_PAGE_SIZES.some((size) => size.value === String(limit)) ? String(limit) : DEFAULT_PAGE_SIZE);
  return `${HISTORY_PATH}?${params.toString()}`;
}

export function visitDetailsPath(id) {
  return `${HISTORY_PATH}/${encodeURIComponent(String(id))}`;
}

export function hasActiveFilters(filters = EMPTY_HISTORY_FILTERS) {
  return Boolean(String(filters.search || "").trim() || filters.status || filters.service || filters.from || filters.to);
}

// At most three numbered buttons, a window around the current page.
export function historyPageButtons(page, pageCount) {
  const count = Math.max(1, Math.floor(Number(pageCount) || 1));
  const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), count);
  const size = Math.min(MAX_PAGE_BUTTONS, count);
  const start = Math.min(Math.max(1, current - 1), count - size + 1);
  return Array.from({ length: size }, (_, index) => start + index);
}

// "Showing 11–18 of 18", from the server's filtered total.
export function historyRangeSummary({ page = 1, limit = DEFAULT_PAGE_SIZE, total = 0, rowCount = 0 } = {}) {
  if (!total || !rowCount) return `Showing 0 of ${total || 0}`;
  const size = limit === "all" ? total : Number(limit) || Number(DEFAULT_PAGE_SIZE);
  const first = limit === "all" ? 1 : (page - 1) * size + 1;
  return `Showing ${first}–${first + rowCount - 1} of ${total}`;
}

const MANILA = "Asia/Manila";

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

// Every time is shown in Manila, as the rest of the system records the business day.
export function formatHistoryDate(value) {
  const date = validDate(value);
  return date ? date.toLocaleDateString("en-PH", { timeZone: MANILA, year: "numeric", month: "short", day: "numeric" }) : NOT_RECORDED;
}

export function formatHistoryTime(value) {
  const date = validDate(value);
  return date ? date.toLocaleTimeString("en-PH", { timeZone: MANILA, hour: "numeric", minute: "2-digit" }) : NOT_RECORDED;
}

export function formatHistoryDateTime(value) {
  const date = validDate(value);
  return date ? `${formatHistoryDate(value)}, ${formatHistoryTime(value)}` : NOT_RECORDED;
}
