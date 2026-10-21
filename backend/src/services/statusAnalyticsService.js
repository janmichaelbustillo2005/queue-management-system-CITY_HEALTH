const supabase = require("../lib/supabase");
const env = require("../config/env");
const { buildRange, aggregateDailyTrends, timestampMicroseconds } = require("./dailyTrendsService");

const DAY = 86400000;
const HOUR_MICROS = 3600000000;
const MINUTE_MICROS = 60000000;
const PAGE_SIZE = 500;
const PATIENT_COLUMNS = "id,status,created_at,called_at,consultation_started_at,completed_at,counter_id";
const TERMINAL = new Set(["completed", "cancelled", "no-show"]);
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const iso = (value) => new Date(value).toISOString();
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function uniqueRows(rows) {
  return [...new Map((rows || []).filter(row => row?.id != null).map(row => [String(row.id), row])).values()];
}

function comparisonRange(range) {
  const start = Date.parse(range.start_at), end = Date.parse(range.end_at);
  const elapsed = Math.max(0, Math.min(end, Date.parse(range.effective_end_at)) - start);
  return {
    ...range,
    date: new Date(Date.parse(`${range.date}T00:00:00+08:00`) - DAY + 8 * 3600000).toISOString().slice(0, 10),
    start_at: iso(start - DAY), end_at: iso(end - DAY),
    effective_end_at: iso(start - DAY + elapsed)
  };
}

function boundsFor(range, observed) {
  const start = timestampMicroseconds(range.start_at), end = timestampMicroseconds(range.end_at);
  const cutoff = min(end, min(observed, timestampMicroseconds(range.effective_end_at)));
  return { start, end, cutoff, elapsed: cutoff > start ? Number(cutoff - start) / HOUR_MICROS : 0 };
}

function visitTimes(row, observed) {
  const created = timestampMicroseconds(row.created_at), called = timestampMicroseconds(row.called_at);
  const started = timestampMicroseconds(row.consultation_started_at), ended = timestampMicroseconds(row.completed_at);
  const valid = time => created != null && time != null && time >= created && time <= observed;
  const orderedCall = valid(called) && (row.consultation_started_at == null || (valid(started) && started >= called)) &&
    (row.completed_at == null || (valid(ended) && ended >= called));
  const completedService = row.status === "completed" && valid(started) && valid(ended) && ended > started &&
    (row.called_at == null || (valid(called) && called <= started));
  return { created, called, started, ended, valid, orderedCall, completedService };
}

// These are retained visit intervals, not fabricated registration counts or a
// transition log. Undo and incomplete records make the intersecting history unknown.
function retainedWaitingInterval(row, times, observed) {
  const { created, called, started, ended, valid, orderedCall } = times;
  if (row.status === "waiting") {
    return { start: created, end: observed, uncertain: row.called_at != null || row.consultation_started_at != null || row.completed_at != null };
  }
  if (orderedCall) return { start: created, end: called, uncertain: false };
  if (["cancelled", "no-show"].includes(row.status) && row.called_at == null && row.consultation_started_at == null && valid(ended)) {
    return { start: created, end: ended, uncertain: false };
  }
  const knownUpperBounds = [started, TERMINAL.has(row.status) ? ended : null].filter(valid);
  return { start: created, end: knownUpperBounds.length ? knownUpperBounds.reduce(min) : observed, uncertain: true };
}

function historicalState(row, times, sample) {
  const { created, called, started, ended, valid, orderedCall } = times;
  if (created > sample) return { waiting: 0, serving: 0 };
  if (row.status === "waiting") {
    return row.called_at == null && row.consultation_started_at == null && row.completed_at == null
      ? { waiting: 1, serving: 0 } : { waiting: null, serving: null };
  }
  if (TERMINAL.has(row.status) && valid(ended) && ended <= sample) return { waiting: 0, serving: 0 };
  if (orderedCall) {
    if (sample < called) return { waiting: 1, serving: 0 };
    if (row.status === "serving" && row.completed_at == null) return { waiting: 0, serving: 1 };
    if (TERMINAL.has(row.status) && valid(ended)) return { waiting: 0, serving: 1 };
    return { waiting: 0, serving: null };
  }
  if (["cancelled", "no-show"].includes(row.status) && row.called_at == null && row.consultation_started_at == null && valid(ended)) {
    return { waiting: 1, serving: 0 };
  }
  // An actual consultation start establishes serving after that instant even
  // when the call that preceded it was not recorded.
  if (valid(started) && sample >= started) {
    if ((row.status === "serving" && row.completed_at == null) || (TERMINAL.has(row.status) && valid(ended) && ended > started)) {
      return { waiting: 0, serving: 1 };
    }
  }
  return { waiting: null, serving: null };
}

function durationEvents(row, times, inRange) {
  return {
    wait: ["serving", "completed"].includes(row.status) && times.orderedCall && inRange(times.called)
      ? times.called - times.created : null,
    service: times.completedService && inRange(times.ended) ? times.ended - times.started : null
  };
}

function periodSummary(visits, range, observed) {
  const bounds = boundsFor(range, observed);
  if (!bounds.elapsed) return { total_patients: null, waiting_patients: null, currently_serving: null,
    completed_patients: null, avg_wait_minutes: null, avg_service_minutes: null, arrival_completions: null, elapsed_hours: 0 };
  const inRange = time => time != null && time >= bounds.start && time < bounds.end && time <= bounds.cutoff;
  const sample = bounds.cutoff === bounds.end ? bounds.cutoff - 1n : bounds.cutoff;
  const present = bounds.cutoff === observed && bounds.cutoff < bounds.end;
  let total = 0, completed = 0, waiting = 0, serving = 0, arrivalCompletions = 0;
  let waitTotal = 0n, serviceTotal = 0n, waitSamples = 0, serviceSamples = 0;
  for (const { row, times } of visits) {
    const { created, ended, valid } = times;
    if (created == null || created > sample) continue;
    if (inRange(created)) {
      total += 1;
      if (row.status === "completed" && valid(ended) && ended <= sample) arrivalCompletions += 1;
    }
    if (row.status === "completed" && valid(ended) && inRange(ended)) completed += 1;
    const durations = durationEvents(row, times, inRange);
    if (durations.wait != null) {
      waitTotal += durations.wait;
      waitSamples += 1;
    }
    if (durations.service != null) {
      serviceTotal += durations.service;
      serviceSamples += 1;
    }
    const state = present
      ? { waiting: row.status === "waiting" ? 1 : 0, serving: row.status === "serving" ? 1 : 0 }
      : historicalState(row, times, sample);
    waiting = waiting == null || state.waiting == null ? null : waiting + state.waiting;
    serving = serving == null || state.serving == null ? null : serving + state.serving;
  }
  return {
    total_patients: total, waiting_patients: waiting, currently_serving: serving, completed_patients: completed,
    avg_wait_minutes: waitSamples ? Number(waitTotal) / MINUTE_MICROS / waitSamples : null,
    avg_service_minutes: serviceSamples ? Number(serviceTotal) / MINUTE_MICROS / serviceSamples : null,
    arrival_completions: arrivalCompletions, elapsed_hours: bounds.elapsed
  };
}

function metric(value, previous) {
  return { value, previous, change_percent: value == null || previous == null ? null : previous === 0
    ? value === 0 ? 0 : null : (value - previous) * 100 / previous };
}

function aggregateStatusAnalytics(patients, counters, range, observedAt = new Date()) {
  const observed_at = new Date(observedAt).toISOString(), observed = timestampMicroseconds(observed_at);
  const rows = uniqueRows(patients), counterRows = uniqueRows(counters);
  const visits = rows.map(row => ({ row, times: visitTimes(row, observed) }));
  const comparison_range = comparisonRange(range);
  const current = periodSummary(visits, range, observed), previous = periodSummary(visits, comparison_range, observed);
  const base = aggregateDailyTrends(rows, counterRows, range, observedAt);
  const bounds = boundsFor(range, observed);
  const inRange = time => bounds.elapsed > 0 && time != null && time >= bounds.start && time < bounds.end && time <= bounds.cutoff;
  let uncertainQueue = false;
  const hourly = base.hourly.map(bucket => {
    const start = timestampMicroseconds(bucket.start_at), bucketEnd = timestampMicroseconds(bucket.end_at);
    const end = min(bucketEnd, bounds.cutoff);
    const observedBucket = bounds.elapsed > 0 && start <= bounds.cutoff;
    let waitTotal = 0n, serviceTotal = 0n, waitSamples = 0, serviceSamples = 0;
    let personTime = 0n, uncertain = false;
    const inBucket = time => observedBucket && inRange(time) && time >= start && time < bucketEnd;
    for (const { row, times } of visits) {
      if (times.created == null || times.created > observed) continue;
      const durations = durationEvents(row, times, inBucket);
      if (durations.wait != null) { waitTotal += durations.wait; waitSamples += 1; }
      if (durations.service != null) { serviceTotal += durations.service; serviceSamples += 1; }
      if (end <= start) continue;
      const interval = retainedWaitingInterval(row, times, observed);
      const overlap = min(end, interval.end) - max(start, interval.start);
      if (overlap <= 0n) continue;
      if (interval.uncertain) uncertain = true;
      else personTime += overlap;
    }
    uncertainQueue ||= uncertain;
    return {
      ...bucket,
      wait_samples: observedBucket ? waitSamples : null,
      avg_wait_minutes: waitSamples ? Number(waitTotal) / MINUTE_MICROS / waitSamples : null,
      service_samples: observedBucket ? serviceSamples : null,
      avg_service_minutes: serviceSamples ? Number(serviceTotal) / MINUTE_MICROS / serviceSamples : null,
      avg_queue_length: end <= start || uncertain ? null : Number(personTime) / Number(end - start)
    };
  });
  const counterAliases = new Map();
  // Names are the workflow's stored counter_id; prefer them over numeric aliases.
  for (const counter of counterRows) counterAliases.set(String(counter.id), counter);
  for (const counter of counterRows) if (counter.id_num != null) counterAliases.set(String(counter.id_num), counter);
  const performance = new Map(counterRows.map(counter => [String(counter.id), { total: 0, micros: 0n, samples: 0 }]));
  for (const { row, times } of visits) {
    if (times.created == null || row.status !== "completed" || !times.valid(times.ended) || !inRange(times.ended)) continue;
    const counter = counterAliases.get(String(row.counter_id));
    if (!counter) continue;
    const result = performance.get(String(counter.id));
    result.total += 1;
    if (times.completedService) { result.micros += times.ended - times.started; result.samples += 1; }
  }
  const notes = [
    "All times use Asia/Manila. Unique queue records are counted once. Arrivals use retained registration time; completions use completed status and the recorded terminal time.",
    "Comparisons use the same clock window on the preceding date, clipped to the selected period's elapsed duration. Percentage change is unavailable when a nonzero value has a zero previous baseline.",
    "Waiting and serving cards are snapshots at the selected period's observed end, including carry-in patients. Present snapshots use stored statuses; historical snapshots are unavailable wherever retained timestamps cannot establish state.",
    "Average waiting time uses valid retained call time minus registration for serving/completed records, grouped by call hour. Average service time uses valid completed consultation start/end times, grouped by completion hour. Overall means are weighted by patient samples.",
    "Average queue length integrates recorded waiting intervals over each observed hour, including carry-ins and partial hours. Incomplete or undone intervals make only their intersecting hours unavailable.",
    "The database retains the latest visit timestamps, not a full transition log. Recall can replace a call time, Requeue replaces registration time, and Undo can erase terminal events. Earlier overwritten events cannot be reconstructed; interval calculations describe retained timestamps.",
    "Status distribution contains actual current stored statuses of records with arrivals, waiting or recorded activity in the selected range; it is not a historical status distribution.",
    "Arrival and observed service rates divide arrivals and completed services by the same elapsed wall-clock hours. The observed service rate is throughput, not theoretical service capacity. Completion percentage is the selected arrival cohort completed by cutoff divided by that cohort's arrivals, excluding carry-in completions.",
    "Counter utilization is unavailable because no reliable operating schedules or historical enabled-time records exist. Login sessions and the current enabled setting are not operating-time records.",
    "Counter total service time sums valid full completed consultations grouped by completion time. Recorded active service time instead merges overlapping actual service intervals clipped to the selected range, including ongoing and interrupted consultations. Counter status shows the current enabled setting, not historical presence."
  ];
  if (uncertainQueue) notes.push("Some hourly queue averages are unavailable because a visit has incomplete or ambiguous waiting history.");
  if ((patients || []).some(row => row?.id == null)) notes.push("Records without a unique queue-record identifier were excluded.");
  const metrics = Object.fromEntries(["total_patients", "waiting_patients", "currently_serving", "completed_patients", "avg_wait_minutes", "avg_service_minutes"]
    .map(name => [name, metric(current[name], previous[name])]));
  return {
    time_zone: "Asia/Manila", observed_at, range, comparison_range, metrics, hourly, statuses: base.statuses,
    counters: counterRows.map(counter => {
      const result = performance.get(String(counter.id));
      const recorded = base.counters.find(item => String(item.id) === String(counter.id));
      return {
        id: counter.id, name: counter.id_num || counter.name || `Counter ${counter.id}`,
        total_served: bounds.elapsed ? result.total : null,
        avg_service_minutes: result.samples ? Number(result.micros) / MINUTE_MICROS / result.samples : null,
        total_service_minutes: result.samples ? Number(result.micros) / MINUTE_MICROS : null,
        active_service_minutes: recorded?.active_service_minutes ?? null,
        available_minutes: null, utilization_percent: null,
        status: counter.is_online === true ? "Enabled" : counter.is_online === false ? "Disabled" : "No data available"
      };
    }),
    rates: {
      elapsed_hours: current.elapsed_hours,
      arrival_rate_per_hour: current.elapsed_hours ? current.total_patients / current.elapsed_hours : null,
      service_rate_per_hour: current.elapsed_hours ? current.completed_patients / current.elapsed_hours : null,
      completion_rate_percent: current.total_patients > 0 ? current.arrival_completions * 100 / current.total_patients : null,
      completion_numerator: current.arrival_completions, completion_denominator: current.total_patients,
      operational_status: "Insufficient Data",
      description: "Observed rates describe recorded throughput. Operating-time history, reliable capacity and stationarity evidence are unavailable, so queue stability cannot be established."
    },
    record_count: base.record_count, notes
  };
}

async function readPages(table, columns, configure = query => query) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await configure(supabase.from(table).select(columns)).order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("The database returned invalid Status Analytics records.");
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function getStatusAnalytics(options = {}) {
  const observedAt = new Date(), range = buildRange(options, observedAt), comparison = comparisonRange(range);
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) throw fail("No database records are available until the queue database is configured.", 503);
  try {
    const [patients, counters] = await Promise.all([
      readPages("patients", PATIENT_COLUMNS, query => query.lte("created_at", range.effective_end_at)
        .or(`created_at.gte.${comparison.start_at},called_at.gte.${comparison.start_at},consultation_started_at.gte.${comparison.start_at},completed_at.gte.${comparison.start_at},status.in.(waiting,serving),completed_at.is.null`)),
      readPages("counters", "id,id_num,is_online")
    ]);
    return aggregateStatusAnalytics(patients, counters, range, observedAt);
  } catch (error) {
    const unavailable = fail("Status Analytics could not read the queue database. Please retry after the connection is restored.", 503);
    unavailable.cause = error;
    throw unavailable;
  }
}

module.exports = { getStatusAnalytics, aggregateStatusAnalytics };
