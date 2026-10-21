// Philippine business dates use Asia/Manila (UTC+08:00, with no DST).
// Work in UTC after shifting the clock so server/browser timezone cannot move
// a patient's calendar-day boundary.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function getBusinessDate(now = new Date()) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw dateError("A valid business date is required");
  return new Date(timestamp + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function getBusinessDayRange(date) {
  const value = String(date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw dateError("Dates must use YYYY-MM-DD");
  const midnight = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== value) {
    throw dateError("A valid calendar date is required");
  }
  return {
    start: new Date(midnight - MANILA_OFFSET_MS).toISOString(),
    // Exclusive next midnight includes PostgreSQL's last microsecond of a day.
    end: new Date(midnight - MANILA_OFFSET_MS + DAY_MS).toISOString()
  };
}

function getDateFilterRange({ dateFilter = "", date = "", startDate = "", endDate = "" } = {}, now = new Date()) {
  if (!["", "all", "today", "week", "month", "date", "range"].includes(dateFilter)) {
    throw dateError("Unsupported date filter");
  }
  if (date && (startDate || endDate)) throw dateError("Select a specific date or a date range");
  if (dateFilter === "date" && !date) throw dateError("A specific date is required");
  if (dateFilter === "range" && (!startDate || !endDate)) throw dateError("A start and end date are required");
  if (date) return getBusinessDayRange(date);
  if (startDate || endDate) {
    const range = {};
    if (startDate) range.start = getBusinessDayRange(startDate).start;
    if (endDate) range.end = getBusinessDayRange(endDate).end;
    if (range.start && range.end && range.start >= range.end) throw dateError("Start date must not follow end date");
    return range;
  }
  if (!dateFilter || dateFilter === "all") return null;
  const today = getBusinessDate(now);
  if (dateFilter === "today") return getBusinessDayRange(today);
  const calendar = new Date(`${today}T00:00:00.000Z`);
  if (dateFilter === "week") {
    // The UI's "This Week" means this Manila calendar week, Monday to Sunday.
    calendar.setUTCDate(calendar.getUTCDate() - (calendar.getUTCDay() + 6) % 7);
    const start = getBusinessDayRange(calendar.toISOString().slice(0, 10)).start;
    calendar.setUTCDate(calendar.getUTCDate() + 6);
    return { start, end: getBusinessDayRange(calendar.toISOString().slice(0, 10)).end };
  }
  calendar.setUTCDate(1);
  const start = getBusinessDayRange(calendar.toISOString().slice(0, 10)).start;
  calendar.setUTCMonth(calendar.getUTCMonth() + 1);
  return { start, end: getBusinessDayRange(calendar.toISOString().slice(0, 10)).start };
}

module.exports = { getBusinessDate, getBusinessDayRange, getDateFilterRange };
