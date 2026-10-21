const supabase = require("../lib/supabase");
const env = require("../config/env");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MANILA_OFFSET = 8 * HOUR;
const PAGE_SIZE = 500;
const PATIENT_COLUMNS = "id,status,created_at,called_at,consultation_started_at,completed_at,counter_id";
const STATUS_LABELS = {
  waiting: "Waiting", serving: "Serving", completed: "Completed", cancelled: "Cancelled", "no-show": "No-show"
};

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Keep PostgreSQL microseconds rather than rounding short consultations to zero.
function timestampMicroseconds(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = value.match(/[T ]\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] || "";
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}

const micros = (milliseconds) => BigInt(milliseconds) * 1000n;
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const localDate = (milliseconds) => new Date(milliseconds + MANILA_OFFSET).toISOString().slice(0, 10);
const localTime = (milliseconds) => new Date(milliseconds + MANILA_OFFSET).toISOString().slice(11, 16);

function buildRange({ date, view = "day", startTime, endTime } = {}, observedAt = new Date()) {
  const now = new Date(observedAt).getTime();
  if (!Number.isFinite(now)) throw fail("A valid observation time is required.");
  const selectedDate = date == null ? localDate(now) : date;
  if (typeof selectedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    throw fail("Choose a valid date in YYYY-MM-DD format.");
  }
  const midnight = Date.parse(`${selectedDate}T00:00:00+08:00`);
  if (!Number.isFinite(midnight) || localDate(midnight) !== selectedDate) throw fail("Choose a valid calendar date.");
  if (view !== "day" && view !== "shift") throw fail("Choose the day or custom shift view.");
  let start = midnight, end = midnight + DAY;
  if (view === "shift") {
    const validTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(startTime) || !validTime(endTime)) throw fail("A custom shift requires valid start and end times (HH:mm).");
    if (startTime === endTime) throw fail("The custom shift start and end times must differ.");
    const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    start += minutes(startTime) * 60000;
    end = midnight + minutes(endTime) * 60000;
    if (end < start) end += DAY;
  }
  return {
    date: selectedDate, view, start_time: view === "day" ? "00:00" : startTime,
    end_time: view === "day" ? "24:00" : endTime,
    start_at: iso(start), end_at: iso(end), effective_end_at: iso(Math.min(end, now))
  };
}

function makeBuckets(range, observedAt) {
  const start = Date.parse(range.start_at), end = Date.parse(range.end_at), now = Date.parse(observedAt);
  const buckets = [];
  for (let cursor = start; cursor < end;) {
    const nextHour = (Math.floor((cursor + MANILA_OFFSET) / HOUR) + 1) * HOUR - MANILA_OFFSET;
    const bucketEnd = Math.min(end, nextHour);
    const nextDay = localDate(cursor) !== range.date ? " (+1 day)" : "";
    const endLabel = localDate(bucketEnd) !== localDate(cursor) && localTime(bucketEnd) === "00:00" ? "24:00" : localTime(bucketEnd);
    const future = cursor > now;
    buckets.push({
      start_at: iso(cursor), end_at: iso(bucketEnd), label: `${localTime(cursor)}–${endLabel}${nextDay}`,
      arrivals: future ? null : 0, served: future ? null : 0, waiting: future ? null : 0,
      cancelled_no_show: future ? null : 0, avg_wait_minutes: null, wait_samples: future ? null : 0,
      avg_service_minutes: null, service_samples: future ? null : 0
    });
    cursor = bucketEnd;
  }
  return buckets;
}

// The database retains the latest visit timestamps, not a transition log.
// In particular Undo can leave a past called_at on a currently waiting row.
function waitingInterval(row, created, called, started, ended, observed) {
  const valid = (time) => time != null && time >= created && time <= observed;
  if (row.status === "waiting") {
    if (row.called_at != null || row.consultation_started_at != null || row.completed_at != null) {
      return { start: created, end: observed + 1n, uncertain: true, currentlyWaiting: true };
    }
    return { start: created, end: observed + 1n, uncertain: false, currentlyWaiting: true };
  }
  if (valid(called) && (!valid(started) || started >= called) && (!valid(ended) || ended >= called)) {
    return { start: created, end: called, uncertain: false };
  }
  if (["cancelled", "no-show"].includes(row.status) && row.called_at == null && row.consultation_started_at == null && valid(ended)) {
    return { start: created, end: ended, uncertain: false };
  }
  // A known consultation/terminal time bounds uncertainty without inventing a call.
  const bounds = [started, ended].filter(valid);
  const upper = bounds.length ? bounds.reduce(min) : observed + 1n;
  return { start: created, end: upper, uncertain: true, currentlyWaiting: false };
}

function mergedMinutes(intervals) {
  if (!intervals.length) return null;
  intervals.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  let total = 0n, [start, end] = intervals[0];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) end = max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return Number(total + end - start) / 60000000;
}

function aggregateDailyTrends(patients, counters, range, observedAt = new Date()) {
  const observed_at = new Date(observedAt).toISOString();
  const observed = timestampMicroseconds(observed_at);
  const start = timestampMicroseconds(range.start_at), end = timestampMicroseconds(range.end_at);
  const effectiveEnd = min(end, observed);
  const hourly = makeBuckets(range, observed_at);
  const internal = hourly.map((bucket) => ({
    start: timestampMicroseconds(bucket.start_at), end: timestampMicroseconds(bucket.end_at), waitTotal: 0, serviceTotal: 0
  }));
  const rows = new Map();
  let missingIdentity = false;
  for (const row of patients || []) {
    if (row?.id == null) { missingIdentity = true; continue; }
    rows.set(String(row.id), row);
  }
  const relevant = [];
  let unknownWaiting = false, invalidChronology = false;
  const serviceIntervals = new Map();
  const eventInRange = (time) => time != null && time >= start && time < end && time <= observed;
  const eventBucket = (time) => eventInRange(time) ? internal.findIndex((bucket) => time >= bucket.start && time < bucket.end) : -1;
  for (const row of rows.values()) {
    const created = timestampMicroseconds(row.created_at), called = timestampMicroseconds(row.called_at);
    const started = timestampMicroseconds(row.consultation_started_at), ended = timestampMicroseconds(row.completed_at);
    if (created == null || created > observed || created >= end || effectiveEnd < start) {
      if (created == null) invalidChronology = true;
      continue;
    }
    const wait = waitingInterval(row, created, called, started, ended, observed);
    const validEndedService = ["completed", "cancelled", "no-show"].includes(row.status) && started != null && ended != null &&
      started >= created && ended > started && ended <= observed && (called == null || started >= called);
    const validCompletedService = row.status === "completed" && validEndedService;
    const validActiveService = row.status === "serving" && started != null && started >= created && started <= observed &&
      row.completed_at == null && (called == null || started >= called);
    const serviceEnd = validEndedService ? ended : validActiveService ? observed : null;
    const serviceOverlaps = serviceEnd != null && started < effectiveEnd && serviceEnd > start;
    const waitingOverlaps = wait.start <= effectiveEnd && wait.end > start;
    // A patient called yesterday can still occupy a doctor slot today before
    // Start Consultation. Include that carry-in without inventing service time.
    const calledPhaseEnd = row.status === "serving" && row.completed_at == null ? observed : ended;
    const calledPhaseOverlaps = called != null && called >= created && called <= observed && calledPhaseEnd != null &&
      calledPhaseEnd >= called && called < effectiveEnd && calledPhaseEnd > start;
    if (!eventInRange(created) && !eventInRange(called) && !eventInRange(ended) && !waitingOverlaps && !serviceOverlaps && !calledPhaseOverlaps) continue;
    relevant.push(row);
    const arrivalIndex = eventBucket(created);
    if (arrivalIndex >= 0) hourly[arrivalIndex].arrivals += 1;
    const terminalIndex = eventBucket(ended);
    if (terminalIndex >= 0 && ended >= created) {
      if (row.status === "completed") hourly[terminalIndex].served += 1;
      if (["cancelled", "no-show"].includes(row.status)) hourly[terminalIndex].cancelled_no_show += 1;
    }
    const callIndex = eventBucket(called);
    if (callIndex >= 0 && ["serving", "completed"].includes(row.status) && called >= created &&
        (started == null || started >= called) && (ended == null || ended >= called)) {
      hourly[callIndex].wait_samples += 1;
      internal[callIndex].waitTotal += Number(called - created) / 60000000;
    }
    if (terminalIndex >= 0 && validCompletedService) {
      hourly[terminalIndex].service_samples += 1;
      internal[terminalIndex].serviceTotal += Number(ended - started) / 60000000;
    }
    if (serviceOverlaps && row.counter_id != null) {
      const key = String(row.counter_id);
      if (!serviceIntervals.has(key)) serviceIntervals.set(key, []);
      serviceIntervals.get(key).push([max(start, started), min(effectiveEnd, serviceEnd)]);
    }
    for (let index = 0; index < hourly.length; index += 1) {
      const bucket = hourly[index], bounds = internal[index];
      if (bucket.arrivals == null) continue;
      const sample = bounds.end <= observed ? bounds.end - 1n : observed;
      if (sample < created || sample >= wait.end) continue;
      // The present queue status is reliable even where Undo erased history.
      if (sample === observed) {
        if (row.status === "waiting" && bucket.waiting != null) bucket.waiting += 1;
      } else if (wait.uncertain) {
        bucket.waiting = null;
        unknownWaiting = true;
      } else if (bucket.waiting != null) bucket.waiting += 1;
    }
    if ((called != null && called < created) || (started != null && started < created) || (ended != null && ended < created)) {
      invalidChronology = true;
    }
  }
  hourly.forEach((bucket, index) => {
    if (bucket.wait_samples) bucket.avg_wait_minutes = internal[index].waitTotal / bucket.wait_samples;
    if (bucket.service_samples) bucket.avg_service_minutes = internal[index].serviceTotal / bucket.service_samples;
  });
  const statusCounts = new Map();
  for (const row of relevant) {
    const status = typeof row.status === "string" && row.status.trim() ? row.status : "unknown";
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
  }
  const statuses = [...statusCounts].map(([status, count]) => ({
    status, label: STATUS_LABELS[status] || status.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    count, percentage: count * 100 / relevant.length
  }));
  const counterRows = [...new Map((counters || []).filter((counter) => counter?.id != null).map((counter) => [String(counter.id), counter])).values()];
  const notes = [
    "All times use Asia/Manila. Counts use unique queue records; arrivals use the retained registration time, served and cancelled/no-show events use their terminal time.",
    "Waiting is a queue snapshot immediately before each completed interval ends, or at the current observation time for an ongoing interval. It is not the number of arrivals.",
    "The system retains the latest visit timestamps, not a full transition history. Recall can replace a call time; Requeue replaces registration time; Undo can erase a terminal event. Earlier events cannot be reconstructed.",
    "Waiting-time samples use the retained call time minus registration for serving/completed visits. Service-time samples use completed consultations with valid actual start/end timestamps, grouped by completion hour.",
    "Status distribution shows the current stored statuses of queue records with registration, queue waiting, or recorded activity in this range; it is not a historical status snapshot.",
    "Counter utilization is unavailable: the system does not record counter operating schedules or historical enabled time. Login sessions are not operating-time records. Recorded service minutes alone cannot establish a utilization percentage."
  ];
  notes.push("Recorded counter service minutes use actual consultation start until its terminal event, or observation time for an ongoing consultation, clipped to this range. Overlapping intervals for one counter are merged.");
  if (unknownWaiting) notes.push("Some historical waiting snapshots are unavailable because retained timestamps cannot establish when every visit left or re-entered waiting.");
  if (invalidChronology) notes.push("Invalid or out-of-order timestamps were excluded from duration calculations and cannot establish missing waiting history.");
  if (missingIdentity) notes.push("Records without a unique queue-record identifier were excluded to prevent double counting.");
  return {
    time_zone: "Asia/Manila", observed_at, range, hourly, statuses,
    counters: counterRows.map((counter) => ({
      id: counter.id, name: counter.id_num || counter.name || `Counter ${counter.id}`,
      utilization_percent: null,
      active_service_minutes: mergedMinutes([
        ...(serviceIntervals.get(String(counter.id_num || counter.name)) || []),
        ...(String(counter.id) !== String(counter.id_num || counter.name) ? serviceIntervals.get(String(counter.id)) || [] : [])
      ]),
      available_minutes: null, reason: "No recorded counter operating time is available."
    })),
    peak_hours: hourly.filter((bucket) => bucket.arrivals > 0).map(({ label, arrivals, start_at, end_at }) => ({ label, arrivals, start_at, end_at }))
      .sort((a, b) => b.arrivals - a.arrivals || a.start_at.localeCompare(b.start_at)),
    record_count: relevant.length, has_activity: relevant.length > 0, notes
  };
}

async function readPages(table, columns, configure = (query) => query) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await configure(supabase.from(table).select(columns))
      .order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("The database returned an invalid analytics result.");
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function getDailyTrends(options = {}) {
  const observedAt = new Date();
  const range = buildRange(options, observedAt);
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) throw fail("No database records are available until the queue database is configured.", 503);
  try {
    const [patients, counters] = await Promise.all([
      readPages("patients", PATIENT_COLUMNS, (query) => query
        .lte("created_at", range.effective_end_at)
        .or(`created_at.gte.${range.start_at},called_at.gte.${range.start_at},consultation_started_at.gte.${range.start_at},completed_at.gte.${range.start_at},status.in.(waiting,serving),completed_at.is.null`)),
      readPages("counters", "id,id_num")
    ]);
    return aggregateDailyTrends(patients, counters, range, observedAt);
  } catch (error) {
    const unavailable = fail("Daily Trends could not read the queue database. Please retry after the connection is restored.", 503);
    unavailable.cause = error;
    throw unavailable;
  }
}

module.exports = { getDailyTrends, aggregateDailyTrends, buildRange, timestampMicroseconds };
