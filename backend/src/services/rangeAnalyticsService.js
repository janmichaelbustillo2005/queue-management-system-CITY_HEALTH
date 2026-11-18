// Superadmin Trends Analytics and Status Analytics over a date range (Today, Last 7/30 Days, Last
// 12 Months or a custom range, Asia/Manila). Read-only: it reads the retained `patients` visit rows,
// the `patient_records` registrations (id and created_at only) and the `counters` (doctor) rows,
// and never writes. These are the same rows the Patient Records page lists.
//
// Counting definitions (also returned in `notes`, so the screens can state them):
// - A visit is one `patients` row; every total, status and event count is a count of visits.
//   Unique patients are reported beside them (see Patient registrations below), never in place of them.
// - Registration cohort: visits whose registration time (created_at) falls in the period. Totals,
//   status breakdowns, service and doctor counts use this cohort and its CURRENT stored status.
// - Events: arrivals by registration time, completions by completed_at of completed visits,
//   cancellations by completed_at of cancelled visits (the cancel workflow stamps completed_at).
// - Waiting time: called_at − created_at for serving/completed visits whose call is recorded in
//   order, grouped by call time. Service time: completed_at − consultation_started_at for completed
//   visits, grouped by completion time. Missing or out-of-order timestamps are left out, never zero.
// - Waiting count: a snapshot at each interval's end reconstructed from retained timestamps, or the
//   stored status for the interval in progress; unknown where history cannot establish it.
// - Patient registrations: patient records (profiles) created in the period, by created_at. Distinct
//   registered patients: the visits' patient_record_id, each record counted once. Visits without a
//   linked record are reported apart; no identity is inferred from names or numbers.
// - Intervals: one day is hour by hour, up to 62 days day by day, longer ranges by calendar month.
const supabase = require("../lib/supabase");
const env = require("../config/env");
const { buildRange, timestampMicroseconds } = require("./dailyTrendsService");
const { visitTimes, historicalState, metric } = require("./statusAnalyticsService");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MANILA_OFFSET = 8 * HOUR;
const MINUTE_MICROS = 60000000;
const PAGE_SIZE = 500;
const MAX_DAYS = 366;
const WORKLOAD_GROUPS = 8;
const BASE_PATIENT_COLUMNS = "id,status,created_at,called_at,consultation_started_at,completed_at,counter_id,service_type,queue_number";
const PATIENT_COLUMNS = `${BASE_PATIENT_COLUMNS},patient_record_id`;
const DAILY_MAX_DAYS = 62;
const MISSING_RELATION = new Set(["42P01", "PGRST205"]);
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);
const STATUS_ORDER = ["completed", "waiting", "serving", "cancelled"];
const STATUS_LABELS = { completed: "Completed", waiting: "Waiting", serving: "Serving", cancelled: "Cancelled" };
const PRESET_DAYS = { today: 1, "7d": 7, "30d": 30 };
const UNASSIGNED = "unassigned";
const NOT_RECORDED_SERVICE = "not_recorded";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const localDate = (milliseconds) => new Date(milliseconds + MANILA_OFFSET).toISOString().slice(0, 10);
const midnight = (date) => Date.parse(`${date}T00:00:00+08:00`);
const addDays = (date, days) => localDate(midnight(date) + days * DAY);
// The first day of the month `months` away from `date`'s month ("2026-11-18", -11 -> "2025-12-01").
const monthStart = (date, months = 0) => {
  const [year, month] = date.split("-").map(Number), index = year * 12 + month - 1 + months;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}-01`;
};
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(midnight(value)) && localDate(midnight(value)) === value;
const statusLabel = (status) => STATUS_LABELS[status] || status.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const average = (total, samples) => samples ? Number(total) / MINUTE_MICROS / samples : null;

// The selected period. One day is reported hour by hour (optionally a custom time window, which may
// run past midnight); up to 62 days day by day; longer ranges (and Last 12 Months: this month and the
// eleven before it) by calendar month.
function buildPeriod({ range = "today", startDate, endDate, startTime, endTime } = {}, observedAt = new Date()) {
  const now = new Date(observedAt).getTime();
  if (!Number.isFinite(now)) throw fail("A valid observation time is required.");
  const today = localDate(now);
  let first, last;
  if (Object.hasOwn(PRESET_DAYS, range)) {
    last = today;
    first = addDays(today, 1 - PRESET_DAYS[range]);
  } else if (range === "12m") {
    last = today;
    first = monthStart(today, -11);
  } else if (range === "custom") {
    if (!validDate(startDate) || !validDate(endDate)) throw fail("Choose a valid start and end date.");
    if (startDate > endDate) throw fail("The start date must be on or before the end date.");
    first = startDate;
    last = endDate;
  } else {
    throw fail("Choose Today, Last 7 Days, Last 30 Days, Last 12 Months or a custom date range.");
  }
  const days = Math.round((midnight(last) - midnight(first)) / DAY) + 1;
  if (days > MAX_DAYS) throw fail(`Choose a range of at most ${MAX_DAYS} days.`);
  const window = Boolean(startTime || endTime);
  if (window && (range !== "custom" || days !== 1)) throw fail("A time window can only be set for a single-day custom range.");
  let start, end, start_time = "00:00", end_time = "24:00";
  if (days === 1) {
    const day = buildRange(window ? { date: first, view: "shift", startTime, endTime } : { date: first, view: "day" }, observedAt);
    start = Date.parse(day.start_at);
    end = Date.parse(day.end_at);
    ({ start_time, end_time } = day);
  } else {
    start = midnight(first);
    end = midnight(last) + DAY;
  }
  return {
    range, start_date: first, end_date: last, days, granularity: days === 1 ? "hour" : days <= DAILY_MAX_DAYS ? "day" : "month",
    time_window: window, start_time, end_time,
    start_at: iso(start), end_at: iso(end), effective_end_at: iso(Math.max(start, Math.min(end, now))),
    live: start <= now && now < end
  };
}

// The equivalent previous period: the same number of days immediately before (for one day, the
// same clock window the day before; for Last 12 Months, the same dates a year earlier), cut to the
// time that has passed so far in a live period.
function comparisonPeriod(period) {
  const yearly = period.range === "12m";
  const shiftDays = yearly ? Math.round((midnight(period.start_date) - midnight(monthStart(period.start_date, -12))) / DAY) : period.days;
  const shift = shiftDays * DAY;
  const start = Date.parse(period.start_at), elapsed = Date.parse(period.effective_end_at) - start;
  const label = yearly ? `vs same period a year earlier${period.live ? " (same elapsed time)" : ""}`
    : period.days === 1
      ? (period.live ? "vs same time yesterday" : period.time_window ? "vs same hours the day before" : "vs the day before")
      : `vs previous ${period.days} days${period.live ? " (same elapsed time)" : ""}`;
  return {
    start_date: addDays(period.start_date, -shiftDays), end_date: addDays(period.end_date, -shiftDays),
    start_at: iso(start - shift), end_at: iso(Date.parse(period.end_at) - shift),
    effective_end_at: iso(start - shift + elapsed), label
  };
}

function windowFor(range, observed) {
  const start = timestampMicroseconds(range.start_at), end = timestampMicroseconds(range.end_at);
  const effective = timestampMicroseconds(range.effective_end_at);
  const cutoff = [end, observed, effective].reduce((a, b) => a < b ? a : b);
  const inRange = (time) => time != null && time >= start && time < end && time <= cutoff;
  return { start, end, cutoff, elapsed: cutoff > start, inRange };
}

function makeBuckets(period, observed) {
  const start = Date.parse(period.start_at), end = Date.parse(period.end_at);
  const buckets = [];
  for (let cursor = start; cursor < end;) {
    const next = period.granularity === "hour"
      ? (Math.floor((cursor + MANILA_OFFSET) / HOUR) + 1) * HOUR - MANILA_OFFSET
      : period.granularity === "month" ? midnight(monthStart(localDate(cursor), 1))
        : midnight(addDays(localDate(cursor), 1));
    const bucketEnd = Math.min(end, next);
    buckets.push({
      start: timestampMicroseconds(iso(cursor)), end: timestampMicroseconds(iso(bucketEnd)),
      start_at: iso(cursor), end_at: iso(bucketEnd), date: localDate(cursor), end_date: localDate(bucketEnd - 1),
      hour: period.granularity === "hour" ? new Date(cursor + MANILA_OFFSET).getUTCHours() : null,
      future: timestampMicroseconds(iso(cursor)) > observed
    });
    cursor = bucketEnd;
  }
  return buckets;
}

function bucketFinder(buckets) {
  return (time) => {
    if (time == null) return -1;
    let low = 0, high = buckets.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, bucket = buckets[middle];
      if (time < bucket.start) high = middle - 1;
      else if (time >= bucket.end) low = middle + 1;
      else return middle;
    }
    return -1;
  };
}

function uniqueRows(rows) {
  return [...new Map((rows || []).filter((row) => row?.id != null).map((row) => [String(row.id), row])).values()];
}

// The doctor stored on the visit (counter_id), as the counter's id_num (e.g. "Doctor 1"); older rows
// may hold a counter id. Visits with no stored doctor are unassigned: no doctor is inferred.
function doctorResolver(counters) {
  const aliases = new Map();
  for (const counter of counters) if (counter.id != null && counter.id_num) aliases.set(String(counter.id).toLowerCase(), counter.id_num);
  for (const counter of counters) if (counter.id_num) aliases.set(String(counter.id_num).trim().toLowerCase(), counter.id_num);
  return (value) => {
    const raw = value == null ? "" : String(value).trim();
    if (!raw) return null;
    const known = aliases.get(raw.toLowerCase());
    if (known) return known;
    const numbered = raw.match(/^doctor\s*(\d+)$/i);
    return numbered ? `Doctor ${Number(numbered[1])}` : raw;
  };
}

function doctorList(counters, extra = []) {
  const names = new Set(counters.map((counter) => counter.id_num).filter(Boolean));
  extra.forEach((name) => name && names.add(name));
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const serviceKey = (row) => typeof row.service_type === "string" && row.service_type.trim() ? row.service_type.trim() : NOT_RECORDED_SERVICE;
const statusKey = (row) => typeof row.status === "string" && row.status.trim() ? row.status.trim() : "unknown";

function prepare(patients, counters, observedAt) {
  const observed_at = new Date(observedAt).toISOString(), observed = timestampMicroseconds(observed_at);
  const counterRows = uniqueRows(counters);
  const resolveDoctor = doctorResolver(counterRows);
  const visits = uniqueRows(patients).map((row) => ({ row, times: visitTimes(row, observed), doctor: resolveDoctor(row.counter_id) }));
  return { observed_at, observed, counterRows, visits, missingIdentity: (patients || []).some((row) => row?.id == null) };
}

// A visit's waiting time (ended by its recorded call) and service time (a completed consultation).
function durations(row, times) {
  return {
    call: ["serving", "completed"].includes(row.status) && times.orderedCall ? times.called : null,
    wait: ["serving", "completed"].includes(row.status) && times.orderedCall ? times.called - times.created : null,
    completion: times.completedService ? times.ended : null,
    service: times.completedService ? times.ended - times.started : null
  };
}

function statusBreakdown(rows) {
  const counts = new Map(STATUS_ORDER.map((status) => [status, 0]));
  rows.forEach((row) => counts.set(statusKey(row), (counts.get(statusKey(row)) || 0) + 1));
  const total = rows.length;
  return {
    total,
    statuses: [...counts].map(([status, count]) => ({ status, label: statusLabel(status), count, percentage: total ? count * 100 / total : null }))
  };
}

function serviceBreakdown(rows) {
  const counts = new Map();
  rows.forEach((row) => counts.set(serviceKey(row), (counts.get(serviceKey(row)) || 0) + 1));
  return [...counts].map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count || a.service.localeCompare(b.service));
}

const recordKey = (row) => row.patient_record_id == null || row.patient_record_id === "" ? null : String(row.patient_record_id);

// Who the visits belong to: each linked patient record once, however many visits it had. Null when
// the visits were read without the patient_record_id column (the patient records migration is absent).
function patientLinks(rows, linksKnown) {
  if (!linksKnown) return null;
  const records = new Set();
  let linked = 0;
  rows.forEach((row) => {
    const key = recordKey(row);
    if (key == null) return;
    linked += 1;
    records.add(key);
  });
  return { visits: rows.length, distinct_patients: records.size, linked_visits: linked, unlinked_visits: rows.length - linked };
}

// Patient records (profiles) created in a window; null when the table cannot be read.
function profileTimes(profiles) {
  if (!Array.isArray(profiles)) return null;
  return uniqueRows(profiles).map((row) => timestampMicroseconds(row.created_at)).filter((time) => time != null);
}
function countProfiles(times, range, observed) {
  if (times == null) return null;
  const window = windowFor(range, observed);
  return window.elapsed ? times.filter((time) => window.inRange(time)).length : null;
}

// The KPI figures for one window (the selected period or its comparison period).
function periodKpis(visits, range, observed) {
  const window = windowFor(range, observed);
  if (!window.elapsed) return { total_visits: null, completed: null, cancelled: null, avg_wait_minutes: null, avg_service_minutes: null, wait_samples: 0, service_samples: 0 };
  let total = 0, completed = 0, cancelled = 0, waitTotal = 0n, waitSamples = 0, serviceTotal = 0n, serviceSamples = 0;
  for (const { row, times } of visits) {
    if (times.created == null) continue;
    if (window.inRange(times.created)) total += 1;
    if (times.valid(times.ended) && window.inRange(times.ended)) {
      if (row.status === "completed") completed += 1;
      if (row.status === "cancelled") cancelled += 1;
    }
    const spans = durations(row, times);
    if (spans.wait != null && window.inRange(spans.call)) { waitTotal += spans.wait; waitSamples += 1; }
    if (spans.service != null && window.inRange(spans.completion)) { serviceTotal += spans.service; serviceSamples += 1; }
  }
  return {
    total_visits: total, completed, cancelled,
    avg_wait_minutes: average(waitTotal, waitSamples), avg_service_minutes: average(serviceTotal, serviceSamples),
    wait_samples: waitSamples, service_samples: serviceSamples
  };
}

// `profiles` are the patient_records rows ({id, created_at}); null when unavailable. `linksKnown`
// says whether the visits carry patient_record_id.
function aggregateTrendsAnalytics(patients, counters, period, observedAt = new Date(), { profiles = null, linksKnown = true } = {}) {
  const { observed_at, observed, counterRows, visits, missingIdentity } = prepare(patients, counters, observedAt);
  const registrations = profileTimes(profiles);
  const comparison = comparisonPeriod(period);
  const window = windowFor(period, observed);
  const current = periodKpis(visits, period, observed), previous = periodKpis(visits, comparison, observed);
  const buckets = makeBuckets(period, observed);
  const find = bucketFinder(buckets);
  const doctors = doctorList(counterRows, visits.filter((visit) => visit.row.status === "completed" && visit.doctor).map((visit) => visit.doctor));
  const rows = buckets.map((bucket) => ({
    arrivals: bucket.future ? null : 0, completed: bucket.future ? null : 0, cancelled: bucket.future ? null : 0,
    new_patient_records: bucket.future || registrations == null ? null : 0,
    waiting: bucket.future ? null : 0, waitTotal: 0n, wait_samples: bucket.future ? null : 0,
    serviceTotal: 0n, service_samples: bucket.future ? null : 0,
    completed_by_doctor: Object.fromEntries(doctors.map((doctor) => [doctor, bucket.future ? null : 0])), completed_unattributed: 0
  }));
  const cohort = [];
  let unknownWaiting = false;
  for (const visit of visits) {
    const { row, times, doctor } = visit;
    if (times.created == null || times.created > observed) continue;
    if (window.inRange(times.created)) {
      cohort.push(row);
      rows[find(times.created)].arrivals += 1;
    }
    if (times.valid(times.ended) && window.inRange(times.ended)) {
      const index = find(times.ended);
      if (row.status === "completed") {
        rows[index].completed += 1;
        if (doctor && Object.hasOwn(rows[index].completed_by_doctor, doctor)) rows[index].completed_by_doctor[doctor] += 1;
        else rows[index].completed_unattributed += 1;
      }
      if (row.status === "cancelled") rows[index].cancelled += 1;
    }
    const spans = durations(row, times);
    if (spans.wait != null && window.inRange(spans.call)) {
      const index = find(spans.call);
      rows[index].waitTotal += spans.wait;
      rows[index].wait_samples += 1;
    }
    if (spans.service != null && window.inRange(spans.completion)) {
      const index = find(spans.completion);
      rows[index].serviceTotal += spans.service;
      rows[index].service_samples += 1;
    }
    // Waiting snapshot at each interval's end (the interval in progress uses the stored status).
    buckets.forEach((bucket, index) => {
      const target = rows[index];
      if (bucket.future || target.waiting == null) return;
      const present = bucket.end > observed;
      const sample = present ? observed : bucket.end - 1n;
      if (times.created > sample) return;
      const state = present ? { waiting: row.status === "waiting" ? 1 : 0 } : historicalState(row, times, sample);
      if (state.waiting == null) { target.waiting = null; unknownWaiting = true; } else target.waiting += state.waiting;
    });
  }
  for (const time of registrations || []) {
    if (!window.inRange(time)) continue;
    const index = find(time);
    if (index >= 0 && rows[index].new_patient_records != null) rows[index].new_patient_records += 1;
  }
  const series = buckets.map((bucket, index) => {
    const { waitTotal, serviceTotal, ...counts } = rows[index];
    return {
      start_at: bucket.start_at, end_at: bucket.end_at, date: bucket.date, end_date: bucket.end_date, hour: bucket.hour, future: bucket.future, ...counts,
      avg_wait_minutes: average(waitTotal, counts.wait_samples), avg_service_minutes: average(serviceTotal, counts.service_samples)
    };
  });
  const groupSize = period.granularity === "day" && period.days > 7 ? Math.ceil(period.days / WORKLOAD_GROUPS) : 1;
  const workload = [];
  for (let index = 0; index < series.length; index += groupSize) {
    const members = series.slice(index, index + groupSize);
    const last = members[members.length - 1];
    workload.push({
      start_at: members[0].start_at, end_at: last.end_at, start_date: members[0].date, end_date: last.end_date,
      hour: members[0].hour, future: members.every((member) => member.future),
      counts: Object.fromEntries(doctors.map((doctor) => [doctor, members.every((member) => member.future) ? null
        : members.reduce((sum, member) => sum + (member.completed_by_doctor[doctor] ?? 0), 0)])),
      unattributed: members.reduce((sum, member) => sum + member.completed_unattributed, 0)
    });
  }
  const notes = [
    "All times are Philippine time (Asia/Manila). Each count is a queue visit, not a unique patient.",
    "Patient arrivals use registration time; completed and cancelled use the time the visit was completed or cancelled. A visit registered on one day and completed on the next counts as an arrival on the first day and a completion on the second.",
    "Waiting is a snapshot of patients still waiting at the end of each interval (or now, for the interval in progress); it is not a number of arrivals.",
    "Average waiting time runs from registration until the recorded call, for patients who were called, grouped by call time. Average service time runs from consultation start to completion, grouped by completion time. Missing or out-of-order times are left out, never counted as zero.",
    "Consultation Outcome and Patient Volume by Service use the visits registered in the period and their status now.",
    "New Patient Records counts patient records created in the period (the Patient Records profiles); a returning patient's new visit adds a visit, not a record. Registered patients counts each linked patient record once, however many visits it had; visits registered without a patient record are counted as visits only and never matched to a patient by name.",
    "One day is shown hour by hour, up to 62 days day by day, and longer ranges by calendar month (the first and last month can be partial).",
    "Doctor workload counts completed consultations by the doctor stored on the visit; consultations with no stored doctor are not attributed.",
    "The system keeps the latest timestamps of each visit, not a full history. Recall can replace a call time and Requeue replaces the registration time, so earlier values cannot be reconstructed."
  ];
  if (registrations == null) notes.push("New patient records are unavailable: the patient records table could not be read.");
  if (!linksKnown) notes.push("Registered patients are unavailable: the visits carry no patient record link (the patient records migration is not installed).");
  if (unknownWaiting) notes.push("Some waiting snapshots are unavailable because the retained timestamps cannot establish when a visit left the queue.");
  if (missingIdentity) notes.push("Records without a unique visit identifier were excluded to avoid double counting.");
  const unattributed = workload.reduce((sum, group) => sum + group.unattributed, 0);
  return {
    time_zone: "Asia/Manila", observed_at, period, comparison_period: comparison,
    kpis: {
      ...Object.fromEntries(["total_visits", "completed", "avg_wait_minutes", "avg_service_minutes"]
        .map((key) => [key, metric(current[key], previous[key])])),
      new_patient_records: metric(countProfiles(registrations, period, observed), countProfiles(registrations, comparison, observed))
    },
    patients: patientLinks(cohort, linksKnown),
    samples: { wait: current.wait_samples, service: current.service_samples },
    buckets: series, outcome: statusBreakdown(cohort), services: serviceBreakdown(cohort),
    workload: { doctors, granularity: period.granularity, group_days: period.granularity === "day" ? groupSize : null, groups: workload, unattributed },
    notes
  };
}

function readStatusFilters({ service = "", doctor = "", status = "" } = {}, counters = []) {
  const clean = (value) => typeof value === "string" ? value.trim() : "";
  const filters = { service: clean(service), doctor: clean(doctor), status: clean(status) };
  if (filters.service && !/^[a-z][a-z0-9_]{0,63}$/.test(filters.service)) throw fail("Choose a valid service.");
  if (filters.status && !STATUS_ORDER.includes(filters.status)) throw fail("Choose a valid status.");
  if (filters.doctor && filters.doctor !== UNASSIGNED) {
    const resolved = doctorResolver(counters)(filters.doctor);
    if (!counters.some((counter) => counter.id_num === resolved)) throw fail("Choose a valid doctor.");
    filters.doctor = resolved;
  }
  return filters;
}

function matcher(filters) {
  return ({ row, doctor }) => (!filters.service || serviceKey(row) === filters.service) &&
    (!filters.status || row.status === filters.status) &&
    (!filters.doctor || (filters.doctor === UNASSIGNED ? doctor == null : doctor === filters.doctor));
}

// `linksKnown` says whether the visits carry patient_record_id (see aggregateTrendsAnalytics).
function aggregateStatusOverview(patients, counters, period, filters = {}, observedAt = new Date(), { linksKnown = true } = {}) {
  const { observed_at, observed, counterRows, visits, missingIdentity } = prepare(patients, counters, observedAt);
  const selected = readStatusFilters(filters, counterRows);
  const matches = matcher(selected);
  const window = windowFor(period, observed);
  const buckets = makeBuckets(period, observed);
  const find = bucketFinder(buckets);
  const completions = buckets.map((bucket) => (bucket.future ? null : 0));
  const cohort = [], carryIn = { waiting: 0, serving: 0 };
  let waitTotal = 0n, waitSamples = 0, serviceTotal = 0n, serviceSamples = 0;
  for (const visit of visits) {
    const { row, times } = visit;
    if (times.created == null || times.created > observed || !matches(visit)) continue;
    if (window.inRange(times.created)) cohort.push(visit);
    else if (period.live && times.created < window.start && (row.status === "waiting" || row.status === "serving")) carryIn[row.status] += 1;
    if (row.status === "completed" && times.valid(times.ended) && window.inRange(times.ended)) completions[find(times.ended)] += 1;
    const spans = durations(row, times);
    if (spans.wait != null && window.inRange(spans.call)) { waitTotal += spans.wait; waitSamples += 1; }
    if (spans.service != null && window.inRange(spans.completion)) { serviceTotal += spans.service; serviceSamples += 1; }
  }
  const doctors = doctorList(counterRows, cohort.map((visit) => visit.doctor));
  const byDoctor = new Map(doctors.map((doctor) => [doctor, { doctor, total: 0, ...Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) }]));
  let unassigned = 0;
  for (const { row, doctor } of cohort) {
    if (!doctor) { unassigned += 1; continue; }
    const entry = byDoctor.get(doctor);
    entry.total += 1;
    if (Object.hasOwn(entry, statusKey(row))) entry[statusKey(row)] += 1;
  }
  const notes = [
    "All times are Philippine time (Asia/Manila). Each count is a queue visit, not a unique patient.",
    "Total Visits and the status cards count the visits registered in the selected period, by their status now, so the statuses always add up to the total.",
    "Visits by Doctor counts the visits assigned to each doctor (the doctor stored on the visit), whatever their status. Visits with no stored doctor are shown as unassigned and are never placed under a doctor.",
    "Completion Trend counts consultations completed in each interval, by completion time, including patients who registered before the period.",
    "Average waiting time runs from registration until the recorded call; average service time from consultation start to completion. Visits with missing or out-of-order times are left out.",
    "Filters combine: service, doctor and status narrow every card, chart and table on this tab.",
    "Registered patients counts each linked patient record once among the visits counted, however many visits it had; visits registered without a patient record are counted as visits only and never matched to a patient by name."
  ];
  if (!linksKnown) notes.push("Registered patients are unavailable: the visits carry no patient record link (the patient records migration is not installed).");
  if (missingIdentity) notes.push("Records without a unique visit identifier were excluded to avoid double counting.");
  return {
    time_zone: "Asia/Manila", observed_at, period, filters: selected,
    cohort: { ...statusBreakdown(cohort.map((visit) => visit.row)), carry_in: period.live ? carryIn : null },
    patients: patientLinks(cohort.map((visit) => visit.row), linksKnown),
    by_doctor: { doctors: [...byDoctor.values()], unassigned },
    by_service: serviceBreakdown(cohort.map((visit) => visit.row)),
    completion_trend: buckets.map((bucket, index) => ({
      start_at: bucket.start_at, end_at: bucket.end_at, date: bucket.date, end_date: bucket.end_date, hour: bucket.hour, future: bucket.future, completed: completions[index]
    })),
    times: {
      avg_wait_minutes: average(waitTotal, waitSamples), wait_samples: waitSamples,
      avg_service_minutes: average(serviceTotal, serviceSamples), service_samples: serviceSamples
    },
    notes
  };
}

// The rows behind the Queue Status Records table: queue ticket, the patient's name as registered
// (patients.id_num; this endpoint is superadmin-only, as is Patient Records) and the visit's times.
// No other patient detail is read.
function statusRecords(patients, counters, period, filters = {}, observedAt = new Date()) {
  const { observed_at, observed, counterRows, visits } = prepare(patients, counters, observedAt);
  const selected = readStatusFilters(filters, counterRows);
  const matches = matcher(selected);
  const window = windowFor(period, observed);
  const records = visits.filter((visit) => visit.times.created != null && window.inRange(visit.times.created) && matches(visit))
    .sort((a, b) => (a.times.created < b.times.created ? 1 : a.times.created > b.times.created ? -1 : Number(b.row.id) - Number(a.row.id)))
    .map(({ row, doctor }) => ({
      id: row.id, ticket: row.queue_number == null ? null : String(row.queue_number),
      patient_name: typeof row.id_num === "string" && row.id_num.trim() ? row.id_num.trim() : null, service: serviceKey(row), doctor,
      status: statusKey(row), registered_at: row.created_at || null, called_at: row.called_at || null,
      completed_at: row.status === "completed" ? row.completed_at || null : null,
      cancelled_at: row.status === "cancelled" ? row.completed_at || null : null
    }));
  return { time_zone: "Asia/Manila", observed_at, period, filters: selected, total: records.length, records };
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

const unavailable = (error) => {
  const problem = fail("Analytics could not read the queue database. Please retry after the connection is restored.", 503);
  problem.cause = error;
  return problem;
};
const missingColumn = (error) => MISSING_COLUMN.has(error?.code) && /patient_record_id/.test(`${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`);

// Visits that can affect the window: registered or with any recorded activity since `since`, or
// still open (a carry-in can still be waiting or being served). Where the visits table has no
// patient_record_id (the patient records migration is absent) they are read without it.
async function loadRows(period, since, { cohortOnly = false, names = false } = {}) {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) throw fail("No database records are available until the queue database is configured.", 503);
  const visits = (columns) => readPages("patients", names ? `${columns},id_num` : columns, (query) => cohortOnly
    ? query.gte("created_at", period.start_at).lte("created_at", period.effective_end_at)
    : query.lte("created_at", period.effective_end_at)
      .or(`created_at.gte.${since},called_at.gte.${since},consultation_started_at.gte.${since},completed_at.gte.${since},status.in.(waiting,serving),completed_at.is.null`));
  try {
    const [patients, counters] = await Promise.all([
      visits(PATIENT_COLUMNS).then((rows) => ({ rows, linksKnown: true }), (error) => {
        if (!missingColumn(error)) throw error;
        return visits(BASE_PATIENT_COLUMNS).then((rows) => ({ rows, linksKnown: false }));
      }),
      readPages("counters", "id,id_num")
    ]);
    return { patients: patients.rows, counters, linksKnown: patients.linksKnown };
  } catch (error) {
    throw unavailable(error);
  }
}

// Patient records created from `since` to the period's end (id and created_at only, never names).
// Null when the patient_records table is not installed.
async function loadProfiles(period, since) {
  try {
    return await readPages("patient_records", "id,created_at",
      (query) => query.gte("created_at", since).lte("created_at", period.effective_end_at));
  } catch (error) {
    if (MISSING_RELATION.has(error?.code)) return null;
    throw unavailable(error);
  }
}

async function getTrendsAnalytics(query = {}) {
  const observedAt = new Date(), period = buildPeriod(query, observedAt);
  const since = comparisonPeriod(period).start_at;
  const [{ patients, counters, linksKnown }, profiles] = await Promise.all([loadRows(period, since), loadProfiles(period, since)]);
  return aggregateTrendsAnalytics(patients, counters, period, observedAt, { profiles, linksKnown });
}

async function getStatusOverview(query = {}) {
  const observedAt = new Date(), period = buildPeriod(query, observedAt);
  const { patients, counters, linksKnown } = await loadRows(period, period.start_at);
  return aggregateStatusOverview(patients, counters, period, query, observedAt, { linksKnown });
}

async function getStatusRecords(query = {}) {
  const observedAt = new Date(), period = buildPeriod(query, observedAt);
  const { patients, counters } = await loadRows(period, period.start_at, { cohortOnly: true, names: true });
  return statusRecords(patients, counters, period, query, observedAt);
}

module.exports = {
  getTrendsAnalytics, getStatusOverview, getStatusRecords,
  aggregateTrendsAnalytics, aggregateStatusOverview, statusRecords, buildPeriod, comparisonPeriod,
  UNASSIGNED, NOT_RECORDED_SERVICE
};
