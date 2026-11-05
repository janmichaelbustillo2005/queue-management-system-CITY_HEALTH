// Additional Detailed Analytics: customer experience, staff efficiency, traffic and predictive
// sections. Pure functions over visits the caller has already filtered (date range, service,
// doctor, status), doctor sign-in sessions and the live queue; nothing here reads or writes the
// database. Times are Asia/Manila. A section without enough recorded data says so instead of
// estimating from defaults.
const MINUTE_MS = 60 * 1000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MAX_CALENDAR_DAYS = 366;
// Staffing plans keep each doctor busy at most 85% of an hour, leaving slack for calls, records
// and uneven arrivals. The page states this assumption next to the recommendation.
const TARGET_UTILIZATION = 0.85;
const MIN_STAFFING_DAYS = 7;
const MIN_STAFFING_SAMPLES = 20;
const MIN_FORECAST_SAMPLES = 5;
const MIN_HISTORICAL_WAIT_SAMPLES = 5;
const DEFAULT_SLA_TARGET_MINUTES = 30;
const STAFFING_SLOT_LIMIT = 12;
const REASON_LIMIT = 5;
// Trend charts group by day up to two months, by week up to a year, and by month beyond.
const TREND_DAY_LIMIT = 62;
const TREND_WEEK_LIMIT = 366;
const MAX_TREND_DAYS = 5 * 366;
// Arrival forecasts average each weekday over at most the last eight weeks before today and need
// two full weeks of history so every weekday is seen at least twice.
const FORECAST_HISTORY_DAYS = 56;
const MIN_FORECAST_HISTORY_DAYS = 14;
const FORECAST_DAYS = 7;

const toTime = (value) => {
  if (value == null || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const round1 = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10);
const percent = (part, whole) => (whole ? round1((part * 100) / whole) : null);
const minutesBetween = (from, to) => {
  const start = toTime(from);
  const end = toTime(to);
  return start == null || end == null || end < start ? null : (end - start) / MINUTE_MS;
};

function manilaParts(time) {
  const shifted = new Date(time + MANILA_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), weekday: (shifted.getUTCDay() + 6) % 7 };
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
const weekdayOf = (date) => manilaParts(Date.parse(`${date}T12:00:00+08:00`)).weekday;
const average = (values) => (values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const samples = sorted.length;
  if (!samples) return { samples: 0, avg: null, median: null, p90: null, max: null };
  const middle = Math.floor(samples / 2);
  return {
    samples,
    avg: round1(sorted.reduce((sum, value) => sum + value, 0) / samples),
    median: round1(samples % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    // Nearest rank: nine in ten measured visits took this long or less.
    p90: round1(sorted[Math.ceil(samples * 0.9) - 1]),
    max: round1(sorted[samples - 1])
  };
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyOf(row);
    if (key == null) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

const byDoctorName = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
function byServiceOrder(order) {
  return (a, b) => {
    const left = order.indexOf(a);
    const right = order.indexOf(b);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right) || String(a).localeCompare(String(b));
  };
}

const arrivalParts = (row) => {
  const time = toTime(row.created_at);
  return time == null ? null : manilaParts(time);
};
const isCalled = (row) => row.called_at != null || row.consultation_started_at != null || ["serving", "completed"].includes(row.status);
const isStarted = (row) => row.consultation_started_at != null || row.status === "completed";
const sameBusinessDay = (from, to) => {
  const start = toTime(from);
  const end = toTime(to);
  return start != null && end != null && manilaParts(start).date === manilaParts(end).date;
};
// Doctor time per patient: from the call until the visit was completed, on the same business day.
// A visit closed on a later day was left open (then completed or recovered afterwards), so its
// span is not time the doctor spent with the patient.
const doctorMinutes = (row) => (row.status === "completed" && sameBusinessDay(row.called_at, row.completed_at)
  ? minutesBetween(row.called_at, row.completed_at) : null);

// 1. Wait time (the Avg Wait card's definition) broken down four ways.
function buildWaitBreakdown(rows, ctx) {
  const breakdown = (keyOf, sort) => [...groupBy(rows, keyOf).entries()]
    .sort(([a], [b]) => sort(a, b))
    .map(([key, group]) => ({ key, visits: group.length, ...stats(group.map(ctx.waitMinutes).filter((value) => value != null)) }));
  const byHour = breakdown((row) => arrivalParts(row)?.hour, (a, b) => a - b);
  const hours = byHour.map((row) => row.key);
  const services = [...groupBy(rows, (row) => row.service_type).entries()].sort(([a], [b]) => byServiceOrder(ctx.serviceOrder)(a, b));
  return {
    by_service: breakdown((row) => row.service_type, byServiceOrder(ctx.serviceOrder)),
    by_doctor: breakdown(ctx.doctorOf, byDoctorName),
    by_date: breakdown((row) => arrivalParts(row)?.date, (a, b) => a.localeCompare(b)),
    by_hour: byHour,
    // Average wait per arrival hour for each service, for comparing services across the day.
    by_hour_service: {
      hours,
      services: services.map(([service, group]) => {
        const waits = groupBy(group, (row) => arrivalParts(row)?.hour);
        const cells = hours.map((hour) => (waits.get(hour) || []).map(ctx.waitMinutes).filter((value) => value != null));
        return { service, values: cells.map(average), samples: cells.map((cell) => cell.length) };
      })
    }
  };
}

// Calendar days of the selected period up to today; with no range, from the first arrival to
// today. Days without visits are included so the trend lines show them as zero.
function periodDays(rows, range, today) {
  const dates = rows.map((row) => arrivalParts(row)?.date).filter(Boolean).sort();
  const first = toTime(range?.start);
  const last = toTime(range?.end);
  let start = first != null ? manilaParts(first).date : dates[0];
  const end = last != null ? [manilaParts(last - 1).date, today].sort()[0] : today;
  if (!start || start > end) return [];
  if (dates.length && start < addDays(end, -MAX_TREND_DAYS)) start = [dates[0], end].sort()[0];
  const days = [];
  for (let day = start; day <= end && days.length < MAX_TREND_DAYS; day = addDays(day, 1)) days.push(day);
  return days;
}

// Arrivals and average wait per day, week (starting Monday) or month of the selected period.
function buildTrends(rows, range, ctx) {
  const days = periodDays(rows, range, ctx.today);
  const grouping = days.length <= TREND_DAY_LIMIT ? "day" : days.length <= TREND_WEEK_LIMIT ? "week" : "month";
  const keyOf = (date) => (grouping === "day" ? date : grouping === "week" ? addDays(date, -weekdayOf(date)) : date.slice(0, 7));
  const periods = [...new Set(days.map(keyOf))];
  const index = new Map(periods.map((period, position) => [period, position]));
  const services = [...new Set(rows.map((row) => row.service_type))].sort(byServiceOrder(ctx.serviceOrder));
  const arrivals = periods.map(() => 0);
  const serviceArrivals = new Map(services.map((service) => [service, periods.map(() => 0)]));
  const waits = periods.map(() => []);
  const serviceWaits = new Map(services.map((service) => [service, periods.map(() => [])]));
  rows.forEach((row) => {
    const date = arrivalParts(row)?.date;
    const position = date == null ? undefined : index.get(keyOf(date));
    if (position == null) return;
    arrivals[position] += 1;
    serviceArrivals.get(row.service_type)[position] += 1;
    const wait = ctx.waitMinutes(row);
    if (wait == null) return;
    waits[position].push(wait);
    serviceWaits.get(row.service_type)[position].push(wait);
  });
  return {
    grouping,
    periods,
    arrivals: { total: arrivals, by_service: services.map((service) => ({ service, counts: serviceArrivals.get(service) })) },
    wait: {
      overall: waits.map(average),
      samples: waits.map((cell) => cell.length),
      by_service: services.map((service) => ({
        service, values: serviceWaits.get(service).map(average), samples: serviceWaits.get(service).map((cell) => cell.length)
      }))
    }
  };
}

// Arrival forecast for the next seven days: each day is the average of the same weekday over
// the full days before today in the selected period (at most the last eight weeks).
function buildArrivalForecast(rows, range, ctx) {
  const yesterday = addDays(ctx.today, -1);
  const history = periodDays(rows, range, ctx.today).filter((day) => day < ctx.today).slice(-FORECAST_HISTORY_DAYS);
  const counts = new Map();
  rows.forEach((row) => {
    const date = arrivalParts(row)?.date;
    if (date) counts.set(date, (counts.get(date) || 0) + 1);
  });
  const actual = history.map((date) => ({ date, count: counts.get(date) || 0 }));
  const basis = { history_days: history.length, min_days: MIN_FORECAST_HISTORY_DAYS, forecast_days: FORECAST_DAYS };
  const lastDay = history[history.length - 1];
  if (history.length < MIN_FORECAST_HISTORY_DAYS || lastDay !== yesterday) {
    return {
      sufficient: false,
      basis,
      message: `Insufficient historical data for reliable forecasting: arrival forecasts need at least ${MIN_FORECAST_HISTORY_DAYS} full days of history ending yesterday. The selected period has ${history.length} full day${history.length === 1 ? "" : "s"}${lastDay && lastDay !== yesterday ? ` ending ${lastDay}` : ""}; choose a range of at least two weeks that runs up to today.`,
      actual
    };
  }
  const byWeekday = groupBy(actual, (row) => weekdayOf(row.date));
  const predicted = Array.from({ length: FORECAST_DAYS }, (_, offset) => {
    const date = addDays(ctx.today, offset + 1);
    const same = (byWeekday.get(weekdayOf(date)) || []).map((row) => row.count);
    return { date, weekday: WEEKDAYS[weekdayOf(date)], count: average(same), samples: same.length, min: Math.min(...same), max: Math.max(...same) };
  });
  return { sufficient: true, basis, actual, today: { date: ctx.today, count_so_far: counts.get(ctx.today) || 0 }, predicted };
}

// 2. Consultation time (start to completion) per doctor, per service, and per doctor and service.
function buildServiceTime(rows, ctx) {
  const measured = rows.map((row) => ({ row, minutes: ctx.serviceMinutes(row) })).filter((item) => item.minutes != null);
  const summarize = (keyOf, sort) => [...groupBy(measured, (item) => keyOf(item.row)).entries()]
    .sort(([a], [b]) => sort(a, b))
    .map(([key, items]) => ({ key, ...stats(items.map((item) => item.minutes)) }));
  const cells = [...groupBy(measured, (item) => `${ctx.doctorOf(item.row)}\u0000${item.row.service_type}`).entries()]
    .map(([key, items]) => {
      const [doctor, service] = key.split("\u0000");
      return { doctor, service, ...stats(items.map((item) => item.minutes)) };
    })
    .sort((a, b) => byDoctorName(a.doctor, b.doctor) || byServiceOrder(ctx.serviceOrder)(a.service, b.service));
  return {
    samples: measured.length,
    by_doctor: summarize(ctx.doctorOf, byDoctorName),
    by_service: summarize((row) => row.service_type, byServiceOrder(ctx.serviceOrder)),
    cells
  };
}

// 3. Customer journey: how far each visit got, where the others left, and the time between stages.
function buildJourney(rows, ctx) {
  const registered = rows.length;
  const called = rows.filter(isCalled).length;
  const started = rows.filter(isStarted).length;
  const completed = rows.filter((row) => row.status === "completed").length;
  const stage = (key, label, count) => ({ key, label, count, share: percent(count, registered) });
  return {
    stages: [
      stage("registered", "Registered (queue ticket created)", registered),
      stage("called", "Called by a doctor", called),
      stage("started", "Consultation started", started),
      stage("completed", "Completed", completed)
    ],
    exits: {
      cancelled_before_call: rows.filter((row) => row.status === "cancelled" && !isCalled(row)).length,
      cancelled_after_call: rows.filter((row) => row.status === "cancelled" && isCalled(row)).length,
      no_show: rows.filter((row) => row.status === "no-show").length,
      still_waiting: rows.filter((row) => row.status === "waiting").length,
      still_serving: rows.filter((row) => row.status === "serving").length
    },
    durations: {
      registered_to_called: stats(rows.map((row) => minutesBetween(row.created_at, row.called_at)).filter((value) => value != null)),
      called_to_started: stats(rows.map((row) => minutesBetween(row.called_at, row.consultation_started_at)).filter((value) => value != null)),
      started_to_completed: stats(rows.map(ctx.serviceMinutes).filter((value) => value != null)),
      registered_to_completed: stats(rows.filter((row) => row.status === "completed")
        .map((row) => minutesBetween(row.created_at, row.completed_at)).filter((value) => value != null))
    }
  };
}

// 4. Abandonment over finished visits (completed, cancelled, no-show); visits still in the queue
// have no outcome yet and are reported separately.
function buildAbandonment(rows, ctx) {
  const count = (predicate) => rows.filter(predicate).length;
  const completed = count((row) => row.status === "completed");
  const cancelledBeforeCall = count((row) => row.status === "cancelled" && !isCalled(row));
  const cancelledAfterCall = count((row) => row.status === "cancelled" && isCalled(row));
  const noShow = count((row) => row.status === "no-show");
  const cancelled = cancelledBeforeCall + cancelledAfterCall;
  const resolved = completed + cancelled + noShow;
  const reasons = [...groupBy(rows.filter((row) => ["cancelled", "no-show"].includes(row.status)), (row) => {
    const reason = String(row.reason ?? "").trim().replace(/\s+/g, " ");
    return reason ? reason.toLowerCase() : null;
  }).values()]
    .map((group) => ({
      reason: String(group[0].reason).trim().replace(/\s+/g, " "),
      cancelled: group.filter((row) => row.status === "cancelled").length,
      no_show: group.filter((row) => row.status === "no-show").length,
      total: group.length
    }))
    .sort((a, b) => b.total - a.total || a.reason.localeCompare(b.reason))
    .slice(0, REASON_LIMIT);
  return {
    resolved,
    completed,
    cancelled,
    cancelled_before_call: cancelledBeforeCall,
    cancelled_after_call: cancelledAfterCall,
    no_show: noShow,
    abandoned: cancelled + noShow,
    abandonment_rate: percent(cancelled + noShow, resolved),
    cancellation_rate: percent(cancelled, resolved),
    no_show_rate: percent(noShow, resolved),
    in_progress: count((row) => row.status === "waiting" || row.status === "serving"),
    // Waiting visits registered on an earlier day are the Historical Backlog, not live demand.
    waiting_from_earlier_days: count((row) => row.status === "waiting" && arrivalParts(row) && arrivalParts(row).date < ctx.today),
    top_reasons: reasons
  };
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged = [];
  sorted.forEach(([start, end]) => {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged;
}
const totalLength = (intervals) => intervals.reduce((sum, [start, end]) => sum + end - start, 0);
function overlapLength(first, second) {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < first.length && j < second.length) {
    const start = Math.max(first[i][0], second[j][0]);
    const end = Math.min(first[i][1], second[j][1]);
    if (end > start) total += end - start;
    if (first[i][1] < second[j][1]) i += 1;
    else j += 1;
  }
  return total;
}

// 5. Doctor utilization. Signed-in time comes from staff sessions (sign-in until the last
// heartbeat, sign-out or expiry); busy time from each visit's call until it ended. A visit that
// stayed open past the day it was called is not busy time and is counted separately. Breaks are
// not recorded by the system, so time signed in but not serving is reported as idle.
function buildUtilization({ doctors, visits, sessions, sessionError, range, now, ctx }) {
  if (!Array.isArray(sessions)) {
    return {
      available: false,
      message: sessionError
        ? `Doctor sign-in sessions could not be read (${sessionError}), so active and idle time are unavailable.`
        : "Doctor sign-in sessions are not available while the backend is using local fallback data.",
      doctors: []
    };
  }
  const windowEnd = Math.min(toTime(range?.end) ?? now, now);
  const windowStart = toTime(range?.start) ?? -Infinity;
  const clip = ([start, end]) => [Math.max(start, windowStart), Math.min(end, windowEnd)];
  const minutes = (ms) => round1(ms / MINUTE_MS);
  return {
    available: true,
    breaks_recorded: false,
    doctors: doctors.map((doctor) => {
      const signedIn = mergeIntervals(sessions.filter((session) => session.doctor_name === doctor).map((session) => {
        const start = toTime(session.created_at);
        const end = Math.min(...[session.last_seen_at, session.revoked_at, session.expires_at].map(toTime).filter((value) => value != null));
        return start == null || !Number.isFinite(end) ? [0, 0] : clip([start, end]);
      }));
      const called = visits.filter((visit) => ctx.doctorOf(visit) === doctor && toTime(visit.called_at) != null)
        .map((visit) => ({ start: toTime(visit.called_at), end: visit.status === "serving" ? now : toTime(visit.completed_at) }))
        .filter((visit) => visit.end != null);
      const sameDay = called.filter((visit) => manilaParts(visit.start).date === manilaParts(visit.end).date);
      const busy = mergeIntervals(sameDay.map((visit) => clip([visit.start, visit.end])));
      const signedInMs = totalLength(signedIn);
      const busyMs = totalLength(busy);
      const busySignedInMs = overlapLength(signedIn, busy);
      return {
        doctor,
        sessions: signedIn.length,
        signed_in_minutes: minutes(signedInMs),
        busy_minutes: minutes(busySignedInMs),
        idle_minutes: minutes(signedInMs - busySignedInMs),
        busy_outside_session_minutes: minutes(busyMs - busySignedInMs),
        open_past_day_visits: called.length - sameDay.length,
        utilization: percent(busySignedInMs, signedInMs)
      };
    })
  };
}

// 6. Transaction volume per doctor, with throughput where signed-in time is known.
function buildVolumes(rows, ctx, utilization) {
  const completedTotal = rows.filter((row) => row.status === "completed").length;
  const signedIn = new Map((utilization.doctors || []).map((row) => [row.doctor, row.signed_in_minutes]));
  return [...groupBy(rows, ctx.doctorOf).entries()].sort(([a], [b]) => byDoctorName(a, b)).map(([doctor, group]) => {
    const completed = group.filter((row) => row.status === "completed");
    const activeDays = new Set(completed.map((row) => arrivalParts(row)?.date).filter(Boolean)).size;
    const minutes = signedIn.get(doctor);
    return {
      doctor,
      total: group.length,
      completed: completed.length,
      cancelled: group.filter((row) => row.status === "cancelled").length,
      no_show: group.filter((row) => row.status === "no-show").length,
      in_queue: group.filter((row) => row.status === "waiting" || row.status === "serving").length,
      completed_share: percent(completed.length, completedTotal),
      active_days: activeDays,
      completed_per_active_day: activeDays ? round1(completed.length / activeDays) : null,
      completed_per_signed_in_hour: minutes ? round1(completed.length / (minutes / 60)) : null
    };
  });
}

// 7. SLA: a called visit is on time when the call came within the target after registration.
function buildSla(rows, ctx, targetMinutes, now) {
  const target = Number.isFinite(targetMinutes) && targetMinutes > 0 ? targetMinutes : DEFAULT_SLA_TARGET_MINUTES;
  const measured = rows.map((row) => ({ row, wait: minutesBetween(row.created_at, row.called_at) })).filter((item) => item.wait != null);
  const summarize = (items) => {
    const compliant = items.filter((item) => item.wait <= target).length;
    return { measured: items.length, compliant, non_compliant: items.length - compliant, rate: percent(compliant, items.length) };
  };
  const breakdown = (keyOf, sort) => [...groupBy(measured, (item) => keyOf(item.row)).entries()]
    .sort(([a], [b]) => sort(a, b)).map(([key, items]) => ({ key, ...summarize(items) }));
  return {
    target_minutes: target,
    ...summarize(measured),
    left_after_target: rows.filter((row) => ["cancelled", "no-show"].includes(row.status) && !isCalled(row) &&
      (minutesBetween(row.created_at, row.completed_at) ?? 0) > target).length,
    waiting_over_target_now: rows.filter((row) => row.status === "waiting" && arrivalParts(row)?.date === ctx.today &&
      (now - toTime(row.created_at)) / MINUTE_MS > target).length,
    by_service: breakdown((row) => row.service_type, byServiceOrder(ctx.serviceOrder)),
    by_doctor: breakdown(ctx.doctorOf, byDoctorName)
  };
}

// Days each weekday occurred in the selected period up to today, or, for All Time and very long
// ranges, the days that had visits. Averages divide by these so quiet days still count.
function observedDays(rows, range, today) {
  const counts = Array(7).fill(0);
  const first = toTime(range?.start);
  const last = toTime(range?.end);
  if (first != null && last != null) {
    const start = manilaParts(first).date;
    const end = [manilaParts(last - 1).date, today].sort()[0];
    const days = [];
    for (let day = start; day <= end && days.length <= MAX_CALENDAR_DAYS; day = addDays(day, 1)) days.push(day);
    if (days.length <= MAX_CALENDAR_DAYS) {
      days.forEach((day) => { counts[manilaParts(Date.parse(`${day}T12:00:00+08:00`)).weekday] += 1; });
      return { counts, total: days.length, basis: "calendar" };
    }
  }
  const dates = [...new Set(rows.map((row) => arrivalParts(row)?.date).filter(Boolean))];
  dates.forEach((day) => { counts[manilaParts(Date.parse(`${day}T12:00:00+08:00`)).weekday] += 1; });
  return { counts, total: dates.length, basis: "visit_days" };
}

// 8. Peak days and hours from arrival (registration) times.
function buildPeakTraffic(rows, range, ctx) {
  const matrix = WEEKDAYS.map(() => Array(24).fill(0));
  const services = WEEKDAYS.map(() => Array.from({ length: 24 }, () => new Map()));
  const dates = new Map();
  rows.forEach((row) => {
    const parts = arrivalParts(row);
    if (!parts) return;
    matrix[parts.weekday][parts.hour] += 1;
    const slot = services[parts.weekday][parts.hour];
    slot.set(row.service_type, (slot.get(row.service_type) || 0) + 1);
    dates.set(parts.date, (dates.get(parts.date) || 0) + 1);
  });
  const observed = observedDays(rows, range, ctx.today);
  const weekdays = WEEKDAYS.map((weekday, index) => {
    const total = matrix[index].reduce((sum, value) => sum + value, 0);
    return { weekday, total, days_observed: observed.counts[index], avg_per_day: observed.counts[index] ? round1(total / observed.counts[index]) : null };
  });
  const hourTotals = Array.from({ length: 24 }, (_, hour) => matrix.reduce((sum, day) => sum + day[hour], 0));
  const busyHours = hourTotals.map((total, hour) => (total ? hour : null)).filter((hour) => hour != null);
  const hours = busyHours.length
    ? Array.from({ length: busyHours[busyHours.length - 1] - busyHours[0] + 1 }, (_, index) => busyHours[0] + index)
    : [];
  const ranked = weekdays.filter((day) => day.avg_per_day != null && day.total > 0);
  const top = (items, value) => items.reduce((best, item) => (best == null || value(item) > value(best) ? item : best), null);
  const busiestDate = [...dates.entries()].reduce((best, [date, count]) => (!best || count > best.count ? { date, count } : best), null);
  const busiestWeekday = top(ranked, (day) => day.avg_per_day);
  const quietestWeekday = top(ranked, (day) => -day.avg_per_day);
  return {
    total_arrivals: rows.length,
    days_observed: observed.total,
    days_basis: observed.basis,
    weekdays,
    hours: hours.map((hour) => ({ hour, total: hourTotals[hour], avg_per_day: observed.total ? round1(hourTotals[hour] / observed.total) : null })),
    matrix: hours.length ? weekdays.map((day, index) => ({ weekday: day.weekday, counts: hours.map((hour) => matrix[index][hour]) })) : [],
    busiest_weekday: busiestWeekday,
    // Only when it is actually quieter than the busiest day.
    quietest_weekday: quietestWeekday && quietestWeekday.avg_per_day < busiestWeekday.avg_per_day ? quietestWeekday : null,
    busiest_hour: busyHours.length ? { hour: top(busyHours, (hour) => hourTotals[hour]), total: Math.max(...hourTotals) } : null,
    busiest_date: busiestDate,
    // Internal: per-slot counts reused by the staffing recommendation.
    slots: { matrix, services, observed }
  };
}

// 9. Service demand, including offered services nobody requested in the period.
function buildServiceDemand(rows, ctx) {
  const counts = new Map((ctx.serviceFilter ? [ctx.serviceFilter] : ctx.configuredServices).map((service) => [service, 0]));
  rows.forEach((row) => counts.set(row.service_type, (counts.get(row.service_type) || 0) + 1));
  const total = rows.length;
  const services = [...counts.entries()]
    .map(([service, count]) => ({ service, count, share: percent(count, total) }))
    .sort((a, b) => b.count - a.count || byServiceOrder(ctx.serviceOrder)(a.service, b.service));
  const counted = services.map((item) => item.count);
  const max = counted.length ? Math.max(...counted) : 0;
  const min = counted.length ? Math.min(...counted) : 0;
  return {
    total,
    services,
    most_requested: total && services.length > 1 ? services.filter((item) => item.count === max) : [],
    least_requested: total && services.length > 1 && min < max ? services.filter((item) => item.count === min) : []
  };
}

// 10. Staffing: average arrivals in each weekday hour times the average doctor time per patient
// gives the doctor-minutes that hour needs; dividing by 85% of an hour gives doctors needed.
function buildStaffing(rows, peak, ctx, enabledDoctors) {
  const samples = rows.map(doctorMinutes).filter((value) => value != null);
  const days = peak.slots.observed.total;
  const basis = {
    days_observed: days,
    samples: samples.length,
    avg_doctor_minutes: samples.length ? round1(samples.reduce((sum, value) => sum + value, 0) / samples.length) : null,
    target_utilization: Math.round(TARGET_UTILIZATION * 100),
    enabled_doctors: enabledDoctors,
    min_days: MIN_STAFFING_DAYS,
    min_samples: MIN_STAFFING_SAMPLES
  };
  if (days < MIN_STAFFING_DAYS || samples.length < MIN_STAFFING_SAMPLES) {
    return {
      sufficient: false,
      basis,
      message: `Staffing recommendations need at least ${MIN_STAFFING_DAYS} days of arrivals and ${MIN_STAFFING_SAMPLES} completed visits called and completed on the same day in the selected period. Found ${days} day${days === 1 ? "" : "s"} and ${samples.length} visit${samples.length === 1 ? "" : "s"}; widen the date range.`,
      slots: []
    };
  }
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const slots = [];
  peak.slots.matrix.forEach((hours, weekday) => {
    const occurrences = peak.slots.observed.counts[weekday];
    if (!occurrences) return;
    hours.forEach((count, hour) => {
      if (!count) return;
      const avgArrivals = count / occurrences;
      const workload = avgArrivals * average;
      const services = [...peak.slots.services[weekday][hour].entries()].sort((a, b) => b[1] - a[1]);
      slots.push({
        weekday: WEEKDAYS[weekday],
        hour,
        avg_arrivals: round1(avgArrivals),
        workload_minutes: round1(workload),
        doctors_needed: Math.max(1, Math.ceil(workload / (60 * TARGET_UTILIZATION))),
        top_service: services[0]?.[0] || null
      });
    });
  });
  // For each hour of the day, the weekday that needs the most doctors at that hour.
  const hourly = [...groupBy(slots, (slot) => slot.hour).entries()].sort(([a], [b]) => a - b).map(([hour, group]) => {
    const busiest = group.reduce((best, slot) => (slot.doctors_needed > best.doctors_needed ||
      (slot.doctors_needed === best.doctors_needed && slot.workload_minutes > best.workload_minutes) ? slot : best));
    return { hour, doctors_needed: busiest.doctors_needed, weekday: busiest.weekday, avg_arrivals: busiest.avg_arrivals, workload_minutes: busiest.workload_minutes };
  });
  slots.sort((a, b) => b.doctors_needed - a.doctors_needed || b.workload_minutes - a.workload_minutes);
  const peakNeed = slots.length ? slots[0].doctors_needed : 0;
  return {
    sufficient: true,
    basis,
    peak_need: peakNeed,
    over_capacity: enabledDoctors == null ? null : slots.filter((slot) => slot.doctors_needed > enabledDoctors).length,
    hourly,
    slots: slots.slice(0, STAFFING_SLOT_LIMIT)
  };
}

// 11. Wait forecast for a new arrival now: the live queue ahead times the average doctor time per
// patient from the selected period, divided by the doctors who can take it. A second, purely
// historical figure shows what arrivals at this weekday and hour actually waited.
function buildForecast({ rows, live, liveError, now, ctx }) {
  const nowParts = manilaParts(now);
  const sameSlot = rows.filter((row) => {
    const parts = arrivalParts(row);
    return parts && parts.weekday === nowParts.weekday && parts.hour === nowParts.hour;
  }).map((row) => minutesBetween(row.created_at, row.called_at)).filter((value) => value != null);
  const slotStats = stats(sameSlot);
  // Recorded waits (registration to call) of patients who arrived in the current hour of the day,
  // shown beside each estimate so the forecast can be compared with what actually happened.
  const actualAt = (doctor) => {
    const recorded = stats(rows.filter((row) => arrivalParts(row)?.hour === nowParts.hour && (doctor == null || ctx.doctorOf(row) === doctor))
      .map((row) => minutesBetween(row.created_at, row.called_at)).filter((value) => value != null));
    return { avg: recorded.avg, median: recorded.median, samples: recorded.samples, sufficient: recorded.samples >= MIN_HISTORICAL_WAIT_SAMPLES };
  };
  const historical = {
    weekday: WEEKDAYS[nowParts.weekday],
    hour: nowParts.hour,
    ...slotStats,
    sufficient: slotStats.samples >= MIN_HISTORICAL_WAIT_SAMPLES,
    min_samples: MIN_HISTORICAL_WAIT_SAMPLES
  };
  if (!live) {
    return {
      available: false,
      message: `The live queue could not be read${liveError ? ` (${liveError})` : ""}, so no forecast is shown.`,
      historical
    };
  }
  const minutesByDoctor = groupBy(rows.filter((row) => doctorMinutes(row) != null), ctx.doctorOf);
  const overall = stats(rows.map(doctorMinutes).filter((value) => value != null));
  const averageFor = (doctor) => {
    const own = stats((minutesByDoctor.get(doctor) || []).map(doctorMinutes));
    if (own.samples >= MIN_FORECAST_SAMPLES) return { minutes: own.avg, samples: own.samples, basis: "doctor" };
    if (overall.samples >= MIN_FORECAST_SAMPLES) return { minutes: overall.avg, samples: overall.samples, basis: "all_doctors" };
    return { minutes: null, samples: own.samples, basis: null };
  };
  const waiting = live.patients.filter((row) => row.status === "waiting" && arrivalParts(row)?.date === ctx.today);
  const serving = live.patients.filter((row) => row.status === "serving");
  const remaining = (visit, minutes) => Math.max(0, minutes - (now - (toTime(visit.called_at) ?? now)) / MINUTE_MS);
  const counters = live.counters
    .filter((counter) => ctx.doctorNames.includes(counter.id_num))
    .filter((counter) => !ctx.doctorFilter || counter.id_num === ctx.doctorFilter)
    .filter((counter) => ctx.shared || !ctx.serviceFilter || ctx.serviceDoctor(ctx.serviceFilter) === counter.id_num)
    .sort((a, b) => byDoctorName(a.id_num, b.id_num));
  let estimates;
  if (ctx.shared) {
    const online = counters.filter((counter) => counter.is_online !== false);
    const average = averageFor(null);
    const busy = serving.filter((visit) => online.some((counter) => counter.id_num === ctx.doctorOf(visit)));
    const estimate = average.minutes == null || !online.length ? null
      : round1((busy.reduce((sum, visit) => sum + remaining(visit, average.minutes), 0) + waiting.length * average.minutes) / online.length);
    estimates = [{
      doctor: "All doctors (shared queue)",
      online: online.length,
      waiting: waiting.length,
      serving: busy.length,
      avg_minutes: average.minutes,
      samples: average.samples,
      basis: average.basis,
      estimate_minutes: estimate,
      actual_same_hour: actualAt(null),
      note: !online.length ? "No doctor is enabled." : average.minutes == null ? "Not enough completed visits in the selected period." : null
    }];
  } else {
    estimates = counters.map((counter) => {
      const doctor = counter.id_num;
      const online = counter.is_online !== false;
      const queue = waiting.filter((visit) => ctx.serviceDoctor(visit.service_type) === doctor).length;
      const current = serving.filter((visit) => ctx.doctorOf(visit) === doctor);
      const average = averageFor(doctor);
      const estimate = !online || average.minutes == null ? null
        : round1(current.reduce((sum, visit) => sum + remaining(visit, average.minutes), 0) + queue * average.minutes);
      return {
        doctor,
        online: online ? 1 : 0,
        waiting: queue,
        serving: current.length,
        avg_minutes: average.minutes,
        samples: average.samples,
        basis: average.basis,
        estimate_minutes: estimate,
        actual_same_hour: actualAt(doctor),
        note: !online ? "Doctor is offline." : average.minutes == null ? "Not enough completed visits in the selected period." : null
      };
    });
  }
  return {
    available: true,
    generated_at: new Date(now).toISOString(),
    mode: ctx.shared ? "shared" : "service",
    min_samples: MIN_FORECAST_SAMPLES,
    sufficient: estimates.some((row) => row.estimate_minutes != null),
    hour: nowParts.hour,
    estimates,
    historical
  };
}

function buildAnalyticsInsights(input) {
  const { rows, visits, sessions, sessionError, live, liveError, range, now, slaTargetMinutes, ctx } = input;
  const context = { ...ctx, today: manilaParts(now).date };
  const doctors = context.doctorFilter ? [context.doctorFilter] : context.doctorNames;
  const utilization = buildUtilization({ doctors, visits, sessions, sessionError, range, now, ctx: context });
  const peak = buildPeakTraffic(rows, range, context);
  const enabledDoctors = live ? live.counters.filter((counter) => context.doctorNames.includes(counter.id_num) && counter.is_online !== false).length : null;
  const { slots, ...peakPublic } = peak;
  return {
    generated_at: new Date(now).toISOString(),
    filters: { status: context.statusFilter || "", service: context.serviceFilter || "", doctor: context.doctorFilter || "" },
    wait: buildWaitBreakdown(rows, context),
    service_time: buildServiceTime(rows, context),
    journey: buildJourney(rows, context),
    abandonment: buildAbandonment(rows, context),
    utilization,
    volumes: buildVolumes(rows, context, utilization),
    sla: buildSla(rows, context, slaTargetMinutes, now),
    peak: peakPublic,
    trends: buildTrends(rows, range, context),
    demand: buildServiceDemand(rows, context),
    arrival_forecast: buildArrivalForecast(rows, range, context),
    staffing: buildStaffing(rows, peak, context, enabledDoctors),
    forecast: buildForecast({ rows, live, liveError, now, ctx: context }),
    // Single facility: there is no branch field, so no cross-branch comparison. Satisfaction
    // surveys (CSAT/NPS) are not collected by the system.
    branches: { supported: false },
    satisfaction: { available: false }
  };
}

// The same sections as CSV blocks, appended to the analytics export after the By Service table.
// Each block is a title row, a header row and its rows; a section without enough data exports its
// explanation instead of numbers. Values are exactly the ones the page shows.
function buildInsightsCsv(insights) {
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const blocks = [];
  const block = (title, headers, rows) => blocks.push([[title], headers, ...rows].map((row) => row.map(cell).join(",")).join("\n"));
  const note = (title, message) => block(title, ["Note"], [[message]]);
  if (!insights) return "";
  if (insights.error) {
    note("Additional analytics", insights.error);
    return blocks.join("\n\n");
  }
  const statColumns = ["Visits", "Measured", "Average (min)", "Median (min)", "90th percentile (min)", "Longest (min)"];
  [["by_service", "Service"], ["by_doctor", "Doctor"], ["by_date", "Date"], ["by_hour", "Arrival hour"]].forEach(([key, label]) => {
    block(`Average wait time by ${label.toLowerCase()}`, [label, ...statColumns],
      (insights.wait?.[key] || []).map((row) => [row.key, row.visits, row.samples, row.avg, row.median, row.p90, row.max]));
  });
  const byHourService = insights.wait?.by_hour_service;
  if (byHourService?.hours?.length) {
    block("Average wait (min) by arrival hour and service", ["Arrival hour", ...byHourService.services.map((row) => row.service)],
      byHourService.hours.map((hour, index) => [hour, ...byHourService.services.map((row) => row.values[index])]));
  }
  const trends = insights.trends;
  if (trends?.periods?.length) {
    const period = { day: "Day", week: "Week starting", month: "Month" }[trends.grouping];
    block(`Average wait (min) per ${trends.grouping}`, [period, "All services", "Patients measured", ...trends.wait.by_service.map((row) => row.service)],
      trends.periods.map((key, index) => [key, trends.wait.overall[index], trends.wait.samples[index], ...trends.wait.by_service.map((row) => row.values[index])]));
    block(`Patient arrivals per ${trends.grouping}`, [period, "All patients", ...trends.arrivals.by_service.map((row) => row.service)],
      trends.periods.map((key, index) => [key, trends.arrivals.total[index], ...trends.arrivals.by_service.map((row) => row.counts[index])]));
  }
  [["by_doctor", "Doctor"], ["by_service", "Service"]].forEach(([key, label]) => {
    block(`Average service time by ${label.toLowerCase()}`, [label, ...statColumns.slice(1)],
      (insights.service_time?.[key] || []).map((row) => [row.key, row.samples, row.avg, row.median, row.p90, row.max]));
  });
  const journey = insights.journey || {};
  block("Patient journey", ["Stage", "Visits", "Share of registered (%)"], [
    ...(journey.stages || []).map((stage) => [stage.label, stage.count, stage.share]),
    ...Object.entries(journey.exits || {}).map(([key, count]) => [key.replace(/_/g, " "), count, ""])
  ]);
  const abandonment = insights.abandonment || {};
  block("Patient outcomes", ["Outcome", "Patients"], [
    ["Completed", abandonment.completed], ["Cancelled", abandonment.cancelled], ["No-show", abandonment.no_show],
    ["Currently waiting", journey.exits?.still_waiting], ["Being served", journey.exits?.still_serving]
  ]);
  block("Abandonment", ["Measure", "Value"], [
    ["Finished visits", abandonment.resolved], ["Completed", abandonment.completed],
    ["Cancelled before being called", abandonment.cancelled_before_call], ["Cancelled after being called", abandonment.cancelled_after_call],
    ["No-show", abandonment.no_show], ["Abandonment rate (%)", abandonment.abandonment_rate],
    ["Cancellation rate (%)", abandonment.cancellation_rate], ["No-show rate (%)", abandonment.no_show_rate],
    ["Still in the queue", abandonment.in_progress]
  ]);
  if (insights.utilization?.available) {
    block("Doctor utilization (breaks are not recorded)", ["Doctor", "Signed in (min)", "Busy (min)", "Idle (min)", "Utilization (%)", "Busy outside sign-in (min)"],
      insights.utilization.doctors.map((row) => [row.doctor, row.signed_in_minutes, row.busy_minutes, row.idle_minutes, row.utilization, row.busy_outside_session_minutes]));
  } else note("Doctor utilization", insights.utilization?.message);
  block("Transaction volume by doctor", ["Doctor", "Total", "Completed", "Cancelled", "No-show", "In queue", "Share of completed (%)", "Completed per active day", "Completed per signed-in hour"],
    (insights.volumes || []).map((row) => [row.doctor, row.total, row.completed, row.cancelled, row.no_show, row.in_queue,
      row.completed_share, row.completed_per_active_day, row.completed_per_signed_in_hour]));
  const sla = insights.sla || {};
  const slaHeaders = ["Measured", "On time", "Late", "Compliance (%)"];
  block(`SLA compliance (called within ${sla.target_minutes} minutes)`, ["Scope", ...slaHeaders], [
    ["All", sla.measured, sla.compliant, sla.non_compliant, sla.rate],
    ...(sla.by_service || []).map((row) => [`Service: ${row.key}`, row.measured, row.compliant, row.non_compliant, row.rate]),
    ...(sla.by_doctor || []).map((row) => [`Doctor: ${row.key}`, row.measured, row.compliant, row.non_compliant, row.rate])
  ]);
  const peak = insights.peak || {};
  block("Arrivals by weekday", ["Weekday", "Arrivals", "Days observed", "Average per day"],
    (peak.weekdays || []).map((day) => [day.weekday, day.total, day.days_observed, day.avg_per_day]));
  block("Arrivals by hour", ["Hour", "Arrivals", "Average per day"], (peak.hours || []).map((row) => [row.hour, row.total, row.avg_per_day]));
  block("Service demand", ["Service", "Visits", "Share (%)"], (insights.demand?.services || []).map((row) => [row.service, row.count, row.share]));
  const staffing = insights.staffing || {};
  if (staffing.sufficient) {
    block("Staffing recommendations (estimate)", ["Weekday", "Hour", "Average arrivals", "Doctor time needed (min)", "Doctors needed", "Main service"],
      staffing.slots.map((row) => [row.weekday, row.hour, row.avg_arrivals, row.workload_minutes, row.doctors_needed, row.top_service]));
    block("Recommended doctors by hour (estimate)", ["Hour", "Doctors needed", "Busiest weekday", "Doctors enabled now"],
      (staffing.hourly || []).map((row) => [row.hour, row.doctors_needed, row.weekday, staffing.basis.enabled_doctors]));
  } else note("Staffing recommendations", staffing.message);
  const arrivalForecast = insights.arrival_forecast || {};
  if (arrivalForecast.sufficient) {
    block("Patient arrivals: actual and predicted", ["Date", "Type", "Patients", "Same weekdays averaged", "Lowest", "Highest"], [
      ...arrivalForecast.actual.map((row) => [row.date, "Actual (recorded)", row.count, "", "", ""]),
      ...arrivalForecast.predicted.map((row) => [row.date, "Predicted (estimate)", row.count, row.samples, row.min, row.max])
    ]);
  } else note("Patient arrival forecast", arrivalForecast.message);
  const forecast = insights.forecast || {};
  if (forecast.available) {
    block(`Wait-time forecast (estimate as of ${forecast.generated_at})`, ["Doctor", "Enabled", "Waiting now", "Being served", "Average time per patient (min)",
      "Estimated wait (min)", `Actual average wait for arrivals at ${forecast.hour}:00 (min)`, "Actual patients measured", "Note"],
      forecast.estimates.map((row) => [row.doctor, row.online, row.waiting, row.serving, row.avg_minutes, row.estimate_minutes,
        row.actual_same_hour?.sufficient ? row.actual_same_hour.avg : "", row.actual_same_hour?.samples, row.note]));
  } else note("Wait-time forecast", forecast.message);
  note("Patient satisfaction", "Not collected: the system has no CSAT or NPS survey.");
  note("Cross-branch comparison", "Not applicable: the system serves a single facility.");
  return blocks.join("\n\n");
}

module.exports = {
  DEFAULT_SLA_TARGET_MINUTES,
  TARGET_UTILIZATION,
  buildAnalyticsInsights,
  buildInsightsCsv,
  stats,
  mergeIntervals,
  overlapLength
};
