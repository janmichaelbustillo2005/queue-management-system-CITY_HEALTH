const supabase = require("../lib/supabase");
const env = require("../config/env");
const { randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { getBusinessDate, getBusinessDayRange, getDateFilterRange } = require("../lib/businessDay");
const { compareWps, effectivePriority } = require("../lib/wpsPriority");
const {
  sendQueueCreatedNotification,
  sendQueueCalledNotification
} = require("./notificationService");
const {
  getQueueSettings,
  getRecallCount,
  incrementRecallCount,
  clearRecallCount,
  isAwaitingAccept,
  getAcceptedAt,
  getVoiceAnnouncementEvents,
  markAwaitingAccept
} = require("./settingsService");

// Local in-memory fallback data for development when Supabase is unreachable
const localData = {
  displaySettings: {
    id: 1,
    company_name: "City Health Service Center",
    department_name: "CHO & Family Planning Center Cabadbaran City",
    welcome_message: "Welcome to City Health Queuing System",
    refresh_interval: 10
  },
  counters: [
    { id: 1, id_num: "Doctor 1", service_types: ["consultation", "checkup"], is_online: true, current_patient_id: null },
    { id: 2, id_num: "Doctor 2", service_types: ["prenatal", "maternity"], is_online: true, current_patient_id: null },
    { id: 3, id_num: "Doctor 3", service_types: ["family_planning"], is_online: true, current_patient_id: null }
  ],
  patients: [],
  users: [
    { id_num: "superadmin", password: "superadmin123", role: "superadmin", doctor_name: null },
    { id_num: "admin1", password: "admin001", role: "admin", doctor_name: "Doctor 1" },
    { id_num: "admin2", password: "admin002", role: "admin", doctor_name: "Doctor 2" },
    { id_num: "admin3", password: "admin003", role: "admin", doctor_name: "Doctor 3" },
    { id_num: "frontdesk", password: "frontdesk123", role: "admin", doctor_name: null }
  ],
  cancellationRequests: [],
  nextCancellationId: 1,
  nextPatientId: 1,
  countersMap: { "Doctor 1": 1, "Doctor 2": 2, "Doctor 3": 3 },
  // Queue numbers are per service code, not per doctor.
  sequenceMap: {
    GP: 0,
    OB: 0,
    FP: 0
  }
};

// Helper to check if Supabase is connected
let useLocalFallback = false;

const supabaseConfigured = Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);

function enableLocalFallback(error) {
  // A configured database remains the source of truth during an outage. Empty
  // development memory would hide its patients and allow conflicting writes.
  if (supabaseConfigured) {
    if (error?.statusCode === 503) throw error;
    console.warn("Queue database unavailable:", error?.message || "Unknown database failure");
    const unavailable = new Error("The queue database is unavailable. Please retry after the backend connection is restored.");
    unavailable.statusCode = 503;
    unavailable.cause = error;
    throw unavailable;
  }
  console.warn("Supabase is not configured; using temporary development memory.");
  useLocalFallback = true;
}

function getQueueStorageMode() {
  return useLocalFallback ? "local_fallback" : "supabase";
}

function isMissingCancellationTableError(error) {
  if (!error) return false;
  const message = String(error.message || "");
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /does not exist|relation|schema cache/i.test(message)
  );
}

function getTodayRange() {
  return getBusinessDayRange(getBusinessDate(new Date()));
}

function formatError(error, fallback) {
  return new Error(error?.message || fallback);
}

async function getDisplaySettings() {
  if (useLocalFallback) {
    return localData.displaySettings;
  }
  
  try {
    const { data, error } = await supabase
      .from("display_settings")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      enableLocalFallback(error);
      return localData.displaySettings;
    }

    return data || localData.displaySettings;
  } catch (err) {
    enableLocalFallback(err);
    return localData.displaySettings;
  }
}

async function getCounters() {
  if (useLocalFallback) {
    return localData.counters.map(c => ({
      ...c,
      name: c.id_num,
      ID_Num: c.id_num,
      current_patient_name: localData.patients.find(p => p.id === c.current_patient_id)?.id_num || null,
      current_patient_queue_number: localData.patients.find(p => p.id === c.current_patient_id)?.queue_number || null
    }));
  }
  
  try {
    const { data, error } = await supabase
      .from("counters")
      .select("id, id_num, service_types, is_online, current_patient_id")
      .in("id_num", ["Doctor 1", "Doctor 2", "Doctor 3"])
      .order("id", { ascending: true })
      .limit(3);

    if (error) {
      enableLocalFallback(error);
      return getCounters();
    }

    const patientIds = [...new Set((data || []).map((counter) => counter.current_patient_id).filter(Boolean))];
    let patientMap = {};

    if (patientIds.length) {
      const { data: patients, error: patientsError } = await supabase
        .from("patients")
        .select("id, id_num, queue_number")
        .in("id", patientIds);

      if (!patientsError && patients) {
        patientMap = Object.fromEntries(patients.map((patient) => [patient.id, patient]));
      }
    }

    return (data || []).map((counter) => ({
      id: counter.id,
      name: counter.id_num,
      id_num: counter.id_num,
      ID_Num: counter.id_num,
      service_types: counter.service_types || [],
      is_online: counter.is_online,
      current_patient_id: counter.current_patient_id,
      current_patient_name: patientMap[counter.current_patient_id]?.id_num || null,
      current_patient_queue_number: patientMap[counter.current_patient_id]?.queue_number || null
    }));
  } catch (err) {
    enableLocalFallback(err);
    return getCounters();
  }
}

function extractCancelMeta(flags) {
  if (!Array.isArray(flags)) return null;
  return flags.find((flag) => flag && typeof flag === "object" && flag.type === "cancel_meta") || null;
}

function withCancelMeta(flags, reason, cancelledBy) {
  const base = Array.isArray(flags)
    ? flags.filter((flag) => !(flag && typeof flag === "object" && flag.type === "cancel_meta"))
    : [];
  return [
    ...base,
    {
      type: "cancel_meta",
      reason: reason || null,
      cancelled_by: cancelledBy || null
    }
  ];
}

function parsePatientPriority(patient) {
  if (!patient) return patient;
  const flags = patient.vulnerability_flags || [];
  const cancelMeta = extractCancelMeta(flags);
  const displayFlags = flags.filter((flag) => typeof flag === "string");
  return {
    ...patient,
    consultation_started_at: patient.consultation_started_at || null,
    service_duration_seconds: getServiceDurationSeconds(patient),
    priority_score: patient.priority_score || 0,
    vulnerability_flags: displayFlags,
    reason: patient.reason != null && String(patient.reason).trim() !== ""
      ? patient.reason
      : (cancelMeta?.reason || null)
  };
}

function timestampMicroseconds(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  // PostgreSQL timestamps can contain six fractional digits. Keep their
  // sub-millisecond precision when deriving a duration in JavaScript.
  const fraction = value.match(/[T ]\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] || "";
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}

function getServiceDurationSeconds(patient) {
  if (patient?.status !== "completed") return null;
  const started = timestampMicroseconds(patient.consultation_started_at);
  const ended = timestampMicroseconds(patient.completed_at);
  if (started == null || ended == null || ended <= started) return null;
  return Number(ended - started) / 1000000;
}

function isCreatedInRange(patient, { start, end }) {
  const timestamp = Date.parse(patient.created_at);
  return Number.isFinite(timestamp) && (!start || timestamp >= Date.parse(start)) && (!end || timestamp < Date.parse(end));
}

function comparePatientCreation(a, b) {
  const first = timestampMicroseconds(a.created_at);
  const second = timestampMicroseconds(b.created_at);
  return (first != null && second != null && first !== second ? (first < second ? -1 : 1) : 0)
    || Number(a.id) - Number(b.id);
}

async function fetchPatientPages(createQuery, message) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await createQuery()
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw formatError(error, message);
    if (!data?.length) return rows;
    rows.push(...data);
    // A project may cap responses below 1000. Advance by what actually arrived
    // and read until an empty page instead of treating a short page as the end.
    offset += data.length;
  }
}

async function getTodayPatients(range = getTodayRange()) {
  if (useLocalFallback) {
    return localData.patients
      .filter((patient) => patient.status === "serving" || isCreatedInRange(patient, range))
      .sort(comparePatientCreation).map(parsePatientPriority);
  }
  
  try {
    const { start, end } = range;
    const [today, serving] = await Promise.all([
      fetchPatientPages(() => supabase.from("patients").select("*")
        .gte("created_at", start).lt("created_at", end), "Failed to load today's patients"),
      fetchPatientPages(() => supabase.from("patients").select("*").eq("status", "serving"),
        "Failed to load active consultations")
    ]);
    const patients = new Map([...today, ...serving].map((patient) => [patient.id, patient]));
    return [...patients.values()].sort(comparePatientCreation).map(parsePatientPriority);
  } catch (err) {
    enableLocalFallback(err);
    return getTodayPatients(range);
  }
}

async function getQueueStats() {
  const range = getTodayRange();
  const patients = await getTodayPatients(range);
  const today = patients.filter((patient) => isCreatedInRange(patient, range));

  return {
    waiting: patients.filter((patient) => patient.status === "waiting").length,
    serving: patients.filter((patient) => patient.status === "serving").length,
    completed: today.filter((patient) => patient.status === "completed").length,
    today_total_patients: today.length
  };
}

function summarizeDashboardDay(patients, start, end, observedAt) {
  const summary = { total_tokens: 0, served_tokens: 0, average_wait_minutes: null, wait_samples: 0, walk_ins: 0 };
  let totalWaitMinutes = 0;
  const withinDay = (timestamp) => Number.isFinite(timestamp) && timestamp >= start && timestamp < end && timestamp <= observedAt;

  for (const patient of patients) {
    if (withinDay(Date.parse(patient.created_at))) {
      summary.total_tokens += 1;
      // The staff registration route stores "admin"; website and untracked
      // legacy sources cannot establish a front-desk walk-in registration.
      if (patient.source === "admin") summary.walk_ins += 1;
    }
    if (patient.status === "completed" && withinDay(Date.parse(patient.completed_at))) {
      summary.served_tokens += 1;
    }
    if (!["serving", "completed"].includes(patient.status) || !withinDay(Date.parse(patient.called_at))) continue;
    const created = timestampMicroseconds(patient.created_at);
    const called = timestampMicroseconds(patient.called_at);
    if (created == null || called == null || called < created) continue;
    totalWaitMinutes += Number(called - created) / 60000000;
    summary.wait_samples += 1;
  }
  if (summary.wait_samples) summary.average_wait_minutes = totalWaitMinutes / summary.wait_samples;
  return summary;
}

async function getDashboardStats() {
  const observedAt = new Date();
  const observedMilliseconds = observedAt.getTime();
  const manilaOffset = 8 * 60 * 60 * 1000;
  const dayMilliseconds = 24 * 60 * 60 * 1000;
  // Manila business days use UTC+08:00, independently of the backend host's
  // timezone. Keep the legacy queue/analytics date behavior unchanged.
  const todayDate = new Date(observedMilliseconds + manilaOffset).toISOString().slice(0, 10);
  const todayStart = Date.parse(`${todayDate}T00:00:00+08:00`);
  const yesterdayStart = todayStart - dayMilliseconds;
  const yesterdayDate = new Date(yesterdayStart + manilaOffset).toISOString().slice(0, 10);
  let patients = localData.patients;

  if (!useLocalFallback) {
    try {
      // Read each event date so calls/completions of an overnight visit are
      // counted on the day they happen. Pages avoid PostgREST's row cap.
      const pageSize = 500;
      const groups = await Promise.all(["created_at", "called_at", "completed_at"].map(async (column) => {
        const rows = [];
        for (let offset = 0; ; offset += pageSize) {
          const { data, error } = await supabase.from("patients")
            .select("id, source, status, created_at, called_at, completed_at")
            .gte(column, new Date(yesterdayStart).toISOString())
            .lte(column, observedAt.toISOString())
            .order("id", { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (error) throw error;
          rows.push(...(data || []));
          if (!data || data.length < pageSize) return rows;
        }
      }));
      patients = [...new Map(groups.flat().map((patient) => [patient.id, patient])).values()];
    } catch (error) {
      // A configured database fails closed rather than showing empty memory.
      enableLocalFallback(error);
      patients = localData.patients;
    }
  }

  // Requeue intentionally resets created_at in the existing workflow. These
  // totals follow the persisted visit date; no issuance history is invented.
  return {
    observed_at: observedAt.toISOString(),
    time_zone: "Asia/Manila",
    today_date: todayDate,
    yesterday_date: yesterdayDate,
    today: summarizeDashboardDay(patients, todayStart, todayStart + dayMilliseconds, observedMilliseconds),
    yesterday: summarizeDashboardDay(patients, yesterdayStart, todayStart, observedMilliseconds)
  };
}

async function getQueueOverview() {
  const [todayPatients, counters] = await Promise.all([getTodayPatients(), getCounters()]);
  const patientsById = new Map(todayPatients.map((patient) => [patient.id, patient]));
  if (!useLocalFallback) {
    // A previous day's unfinished visit still owns its doctor slot.
    try {
      const { data, error } = await supabase.from("patients").select("*").eq("status", "serving");
      if (error) throw error;
      for (const patient of data || []) {
        patientsById.set(patient.id, parsePatientPriority(patient));
      }
    } catch (error) {
      enableLocalFallback(error);
    }
  }
  const patients = Array.from(patientsById.values());
  const settings = getQueueSettings();
  const rankedAt = Date.now();

  return {
    storage_mode: getQueueStorageMode(),
    dispatch_mode: getDispatchMode(),
    // effective_priority is the WPS rank key at read time (equal to priority_score without aging).
    wps: { aging: wpsAging() },
    patients: patients.map((p) => ({
      ...p,
      effective_priority: p.status === "waiting" ? effectivePriority(p, rankedAt, wpsAging()) : p.priority_score,
      recall_count: getRecallCount(p.id),
      accepted_at: getAcceptedAt(p.id),
      awaiting_accept: p.status === "serving" && (isAwaitingAccept(p.id) ||
        (!p.consultation_started_at && !getAcceptedAt(p.id)))
    })),
    counters,
    queue_settings: settings
  };
}

const SERVICE_CODE_MAP = {
  consultation: "GP",
  checkup: "GP",
  prenatal: "OB",
  maternity: "OB",
  family_planning: "FP"
};

// Every service the three general doctors may serve (D1: the administrator's stated scope).
const CONFIGURED_SERVICES = Object.keys(SERVICE_CODE_MAP);
const DOCTOR_NAMES = ["Doctor 1", "Doctor 2", "Doctor 3"];
const DISPATCH_SHARED = "shared";
const UNASSIGNED_DOCTOR = "Unassigned";

// D1: "service" (default) routes a waiting visit to its service's doctor, as before. "shared"
// (Model A, provisional) keeps one Weighted-Priority queue; the doctor is chosen at Call and
// stored on the visit, so a visit that was never called belongs to no doctor.
function getDispatchMode() {
  return env.doctorDispatchMode === DISPATCH_SHARED ? DISPATCH_SHARED : "service";
}

function isSharedDispatch() {
  return getDispatchMode() === DISPATCH_SHARED;
}

// The legacy service-to-doctor routing. Shared dispatch uses it for nothing but a legacy serving
// row without an assignment, which still blocks the doctor its service used to route to.
function getDoctorForService(serviceType) {
  if (["consultation", "checkup"].includes(serviceType)) {
    return "Doctor 1";
  }
  if (["prenatal", "maternity"].includes(serviceType)) {
    return "Doctor 2";
  }
  if (serviceType === "family_planning") {
    return "Doctor 3";
  }
  return "Doctor 1";
}

// The doctor a visit without a stored assignment is routed to: its service's doctor, or none
// in shared dispatch.
function getRoutedDoctor(serviceType) {
  return isSharedDispatch() ? null : getDoctorForService(serviceType);
}

function getDoctorOfflineMessage(doctorName) {
  return `${doctorName} is currently offline and unavailable. Please select another available doctor.`;
}

async function ensureDoctorAvailableForService(serviceType) {
  if (isSharedDispatch()) {
    // Registration assigns no doctor: any enabled doctor may take the visit when it is called.
    if (!CONFIGURED_SERVICES.includes(serviceType)) throw registrationError("Select one of the offered services.");
    const counters = await getCounters();
    if (!counters.some((c) => DOCTOR_NAMES.includes(c.id_num) && c.is_online !== false)) {
      throw registrationError("No doctor is currently available. Ask Super Admin to enable a doctor counter before registering patients.");
    }
    return null;
  }
  const doctorName = getDoctorForService(serviceType);
  const counters = await getCounters();
  const counter = counters.find((c) => c.id_num === doctorName || c.name === doctorName);

  if (counter && counter.is_online === false) {
    const error = new Error(getDoctorOfflineMessage(doctorName));
    error.statusCode = 400;
    throw error;
  }

  return doctorName;
}

async function getNextQueueNumber(serviceType, offset = 0) {
  const doctorCode = SERVICE_CODE_MAP[serviceType] || "GP";

  if (useLocalFallback) {
    // Keep local sequence at least one past any already-used number in memory
    const existing = localData.patients
      .map((p) => String(p.queue_number || ""))
      .filter((qNum) => qNum.startsWith(`${doctorCode}-`) && qNum.split("-").length === 2)
      .map((qNum) => Number(qNum.split("-")[1]) || 0);
    const maxExisting = existing.length ? Math.max(...existing) : 0;
    const base = Math.max(localData.sequenceMap[doctorCode] || 0, maxExisting);
    const next = base + 1 + offset;
    if (offset === 0) {
      localData.sequenceMap[doctorCode] = next;
    }
    return `${doctorCode}-${String(next).padStart(3, "0")}`;
  }

  // IMPORTANT: queue_number is unique across ALL patients (not just today).
  // Old tickets like GP-001 from previous days still block reuse.
  const { data: patients, error } = await supabase
    .from("patients")
    .select("queue_number")
    .like("queue_number", `${doctorCode}-%`);

  if (error) {
    throw formatError(error, "Failed to resolve next queue number");
  }

  const sequence = (patients || [])
    .map((patient) => {
      const qNum = String(patient.queue_number || "");
      const parts = qNum.split("-");
      // Only count standard codes like GP-001 (ignore legacy GP-1-001)
      if (parts.length !== 2 || parts[0] !== doctorCode) {
        return 0;
      }
      return Number(parts[1]) || 0;
    })
    .filter((n) => n > 0);

  const maxExisting = sequence.length ? Math.max(...sequence) : 0;
  const nextNum = (maxExisting + 1 + offset).toString().padStart(3, "0");
  return `${doctorCode}-${nextNum}`;
}

async function getWebsiteQueueNumber(serviceType) {
  return getNextQueueNumber(serviceType);
}

const VULNERABILITY_WEIGHTS = {
  senior: 4,
  pwd: 3,
  pregnant: 3,
  indigenous: 2,
  solo_parent: 1
};

function computePriorityScore(vulnerabilityFlags = []) {
  const score = (vulnerabilityFlags || []).reduce(
    (score, flag) => score + (VULNERABILITY_WEIGHTS[flag] || 0), 0
  );
  return score === 0 ? 1 : score; // Base weight 1 for Regular
}

const SENIOR_AGE = 60;

function registrationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// Registration is public, so priority input is validated before anything is stored: each known
// category counts once, and a Senior Citizen flag must agree with the birthdate (60 or older on
// the Manila business date, as the registration form computes it); below 60 it is refused rather
// than silently dropped. The form ticks Senior itself; the backend does not add it. Without a
// birthdate a staff-entered Senior flag is kept.
function normalizeRegistrationPriority(vulnerabilityFlags, birthdate, now = new Date()) {
  const flags = vulnerabilityFlags == null ? [] : vulnerabilityFlags;
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string" || !Object.hasOwn(VULNERABILITY_WEIGHTS, flag))) {
    throw registrationError("Unknown priority category. Use Senior Citizen, PWD, Pregnant, Indigenous Person or Solo Parent.");
  }
  const unique = flags.filter((flag, index) => flags.indexOf(flag) === index);
  if (birthdate == null || birthdate === "") return { flags: unique, birthdate: null };

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthdate));
  const today = getBusinessDate(now);
  const valid = match && new Date(`${birthdate}T00:00:00Z`).toISOString().slice(0, 10) === birthdate;
  if (!valid || birthdate > today || Number(match[1]) < 1900) {
    throw registrationError("Enter a valid birthdate (YYYY-MM-DD) that is not in the future.");
  }
  const [year, month, day] = today.split("-").map(Number);
  const age = year - Number(match[1]) - ((month * 100 + day) < (Number(match[2]) * 100 + Number(match[3])) ? 1 : 0);
  if (age < SENIOR_AGE && unique.includes("senior")) {
    throw registrationError("Senior Citizen priority requires age 60 or older on the birthdate entered. Check the birthdate or remove Senior Citizen.");
  }
  return { flags: unique, birthdate };
}

async function createQueueEntry({ idNum, serviceType, mobileNumber, residency, philhealthId, birthdate: rawBirthdate, sex, source = "admin", vulnerabilityFlags: rawFlags = [] }) {
  const { flags: vulnerabilityFlags, birthdate } = normalizeRegistrationPriority(rawFlags, rawBirthdate);
  await ensureDoctorAvailableForService(serviceType);

  let attempts = 0;
  const maxAttempts = 8;
  let lastError = null;

  while (attempts < maxAttempts) {
    try {
      // Re-query max on each attempt so concurrent inserts / collisions advance correctly
      const queueNumber = await getNextQueueNumber(serviceType, attempts);
      const priorityScore = computePriorityScore(vulnerabilityFlags);
      
      if (useLocalFallback) {
        const patient = {
          id: localData.nextPatientId++,
          visit_state_revision: randomUUID(),
          queue_number: queueNumber,
          id_num: idNum,
          service_type: serviceType,
          mobile_number: mobileNumber || null,
          residency: residency || null,
          philhealth_id: philhealthId || null,
          birthdate: birthdate || null,
          sex: sex || null,
          priority_score: priorityScore,
          vulnerability_flags: vulnerabilityFlags,
          source: source,
          status: "waiting",
          created_at: new Date().toISOString(),
          called_at: null,
          consultation_started_at: null,
          completed_at: null,
          counter_id: null,
          reason: null
        };
        localData.patients.push(patient);
        return patient;
      }
      
      const payload = {
        queue_number: queueNumber,
        id_num: idNum,
        service_type: serviceType,
        mobile_number: mobileNumber || null,
        residency: residency || null,
        philhealth_id: philhealthId || null,
        birthdate: birthdate || null,
        sex: sex || null,
        priority_score: priorityScore,
        vulnerability_flags: vulnerabilityFlags,
        source: source,
        status: "waiting"
      };

      const { data, error } = await supabase
        .from("patients")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        // Unique constraint violation on queue_number — retry with a higher sequence
        if (error.code === "23505") {
          console.warn(`Queue number collision for ${queueNumber}. Retrying... (Attempt ${attempts + 1})`);
          attempts++;
          lastError = error;
          continue;
        }
        throw formatError(error, "Failed to create queue entry");
      }

      // The registration is already committed. A failed statistics read must
      // not cause an apparent registration failure or a second local insert.
      try {
        const stats = await getQueueStats();
        sendQueueCreatedNotification(mobileNumber, queueNumber, serviceType, Math.max(0, stats.waiting - 1));
      } catch (notificationError) {
        console.warn("Queue entry saved; creation notification could not be prepared:", notificationError.message);
      }

      return { ...data, priority_score: priorityScore, vulnerability_flags: vulnerabilityFlags };
    } catch (err) {
      if (err.message?.includes("Supabase") || err.message?.includes("fetch failed")) {
        enableLocalFallback(err);
        return createQueueEntry({ idNum, serviceType, mobileNumber, residency, philhealthId, birthdate, sex, source, vulnerabilityFlags });
      }
      
      lastError = err;
      if (err.code === "23505") {
        attempts++;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Failed to generate a unique queue number after multiple attempts.");
}

async function getPatientById(id) {
  if (useLocalFallback) {
    return localData.patients.find(p => p.id === id) || null;
  }
  
  try {
    const { data, error } = await supabase
      .from("patients")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      enableLocalFallback(error);
      return getPatientById(id);
    }

    return data;
  } catch (err) {
    enableLocalFallback(err);
    return getPatientById(id);
  }
}

async function clearCounterAssignment(patientId) {
  if (useLocalFallback) {
    for (const counter of localData.counters) {
      if (counter.current_patient_id === patientId) {
        counter.current_patient_id = null;
        break;
      }
    }
    return true;
  }
  
  try {
    const { data, error } = await supabase
      .from("counters")
      .update({ current_patient_id: null })
      .eq("current_patient_id", patientId)
      .select("*")
      .maybeSingle();

    if (error) {
      throw formatError(error, "Failed to clear counter assignment");
    }

    return data;
  } catch (err) {
    enableLocalFallback(err);
    return clearCounterAssignment(patientId);
  }
}

// Reject overlapping calls in this process. Across processes the database decides: the C1
// call_patient_visit RPC re-validates and writes patient and counter in one transaction, and
// the opt-in fallback for a database without it guards both writes with conditions.
const callsInProgress = new Set();

// WPS order at `rankedAt`; with WPS_AGING off this is priority_score DESC, created_at, id.
const wpsAging = () => env.wpsAging === true;
const compareWaitingPriority = (rankedAt) => (a, b) => compareWps(a, b, rankedAt, wpsAging());
const WPS_A_REQUIRED = "WPS with Aging is enabled but its database function is not installed (backend/scripts/20261029-wps-a-call-aging.sql). Turn WPS_AGING off or install the function. Nothing was changed.";

// D1 shared queue: the waiting visits `doctorName` may take. Every configured service is
// eligible; a legacy Phase 2.1 reservation keeps its visit for the reserved doctor only.
// Mirrors the candidate filter of call_patient_visit_shared.
function isSharedCandidate(patient, doctorName) {
  const reserved = String(patient.counter_id ?? "").trim();
  return CONFIGURED_SERVICES.includes(patient.service_type) && (!reserved || patient.counter_id === doctorName);
}

// The visit the shared queue gives `doctorName` at `rankedAt`: WPS, or WPS-A when aging is on.
function getSharedQueueHead(waitingPatients, doctorName, rankedAt = Date.now()) {
  return waitingPatients.filter((p) => isSharedCandidate(p, doctorName)).sort(compareWaitingPriority(rankedAt))[0] || null;
}

const UNCONFIRMED_CALL_MESSAGE = "Could not confirm the call. Refresh the queue before retrying.";
const SHARED_CALL_MIGRATION_REQUIRED = "Shared doctor dispatch needs the D1 database migration (backend/scripts/20261029-d1-shared-call.sql). Nothing was changed.";
const SHARED_WPS_A_REQUIRED = "Shared doctor dispatch with WPS Aging needs its database function (backend/scripts/20261029-d1a-shared-wps-a-call.sql). Turn WPS_AGING off or install the function. Nothing was changed.";
const C1_CALL_REQUIRED = "Call needs the atomic C1 database function (backend/scripts/20261025-c1-atomic-call.sql), and it could not be used. Nothing was changed. Refresh and retry; if this continues, ask the administrator to check the function.";

// The atomic Call for the configured dispatch and aging. Each re-ranks under the same locks as
// the backend ranked. Without its function every Call refuses (I2 Finding 8); only C1 (service
// dispatch, no aging) may use the older two-statement Call, and only when
// ALLOW_LEGACY_TWO_STEP_CALL opts in for a database that never had C1.
const CALL_RPCS = {
  service: { plain: "call_patient_visit", aging: "call_patient_visit_wps_a" },
  shared: { plain: "call_patient_visit_shared", aging: "call_patient_visit_shared_wps_a" }
};
const CALL_RPC_REQUIRED = {
  call_patient_visit: C1_CALL_REQUIRED,
  call_patient_visit_wps_a: WPS_A_REQUIRED,
  call_patient_visit_shared: SHARED_CALL_MIGRATION_REQUIRED,
  call_patient_visit_shared_wps_a: SHARED_WPS_A_REQUIRED
};

function getCallRpcName(shared, aging) {
  return CALL_RPCS[shared ? "shared" : "service"][aging ? "aging" : "plain"];
}

// D1: the doctor Frontdesk or Superadmin selected (or the calling doctor itself). Any doctor
// may take any configured service; the choice is stored on the visit by the Call.
function resolveSharedCallDoctor(patient, counterId, counters) {
  if (!CONFIGURED_SERVICES.includes(patient.service_type)) {
    throw consultationError("This visit's service is not configured for doctor assignment", 400);
  }
  if (!String(counterId ?? "").trim()) {
    throw consultationError("Select an available doctor to call this patient.", 400);
  }
  const selected = resolveDoctorCounter(counterId, counters);
  if (!selected || !DOCTOR_NAMES.includes(selected.id_num)) {
    throw consultationError("The selected doctor is not a valid doctor counter", 400);
  }
  if (String(patient.counter_id ?? "").trim() && patient.counter_id !== selected.id_num) {
    throw new Error("This waiting patient has a conflicting doctor assignment");
  }
  return selected.id_num;
}

// D1: Frontdesk may assign a visit only to a doctor whose authenticated session is live
// (Phase A presence, 75-second window). Counter availability is checked separately.
async function assertDoctorSignedIn(doctorName) {
  let result;
  try {
    result = await supabase.rpc("get_staff_doctor_presence");
  } catch {
    throw consultationError("Doctor presence could not be verified. Please retry.", 503);
  }
  const doctors = result?.data?.doctors;
  if (result?.error || !Array.isArray(doctors)) {
    throw consultationError("Doctor presence could not be verified. Please retry.", 503);
  }
  if (doctors.find((doctor) => doctor.doctor_name === doctorName)?.online !== true) {
    throw consultationError(`${doctorName} is not signed in. Select a doctor who is online.`, 409);
  }
}

// C1, WPS-A, D1 or D1-A (getCallRpcName): returns the called row, or null when the migration is
// not installed. Any rejection leaves patient and counter unchanged. A lost response may hide a
// committed call, so it is never treated as success: no pending acceptance is created for an
// unconfirmed call (the assigned doctor can still accept a serving visit that has no acceptance state).
// The aging functions rank at `rankedAt`, the instant the backend ranked.
async function callPatientVisitRpc(patient, doctorName, actor, { start, end }, rankedAt, rpcName = "call_patient_visit") {
  const aging = rpcName.endsWith("_wps_a");
  let result;
  try {
    result = await supabase.rpc(rpcName, {
      p_patient_id: patient.id, p_doctor_name: doctorName, p_user_id_num: actor?.id_num ?? null,
      p_expected_revision: patient.visit_state_revision, p_queue_start: start, p_queue_end: end,
      ...(aging ? { p_ranked_at: new Date(rankedAt).toISOString() } : {})
    });
  } catch {
    throw consultationError(UNCONFIRMED_CALL_MESSAGE, 503);
  }
  const { data, error } = result || {};
  if (error) {
    if (CALL_MISSING_RPC_CODES.includes(error.code)) return null;
    if (!error.code) throw consultationError(UNCONFIRMED_CALL_MESSAGE, 503);
    const status = error.code === "40001" ? 409 : error.code === "42501" ? 403 : error.code === "P0002" ? 404 :
      ["P0001", "22023"].includes(error.code) ? 400 : 503;
    throw consultationError(error.message || "Failed to call patient", status);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || Number(row.id) !== patient.id || row.status !== "serving" || row.counter_id !== doctorName ||
      !row.called_at || row.completed_at != null || !row.visit_state_revision ||
      row.visit_state_revision === patient.visit_state_revision) {
    throw consultationError(UNCONFIRMED_CALL_MESSAGE, 503);
  }
  return row;
}

// `actor` is the verified request identity; omit it only for trusted in-process callers.
// The installed C1 RPC re-checks the persisted account itself and requires an actor.
async function callPatient(patientId, counterId = null, actor = undefined) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new Error("A valid patient ID is required");
  }

  // Never silently switch to development data during a queue mutation.
  const { patient, counters: accountCounters, user, local: localCall } = await loadCancellationContext(patientId, actor);
  // R2: identify the caller from the persisted account; token and body claims are never authority.
  const who = resolveCancelActor(actor, user, accountCounters);
  if (who.kind === "doctor") {
    if (counterId != null && resolveDoctorCounter(counterId, accountCounters)?.id !== who.counter.id) {
      throw consultationError("You can only call patients assigned to your doctor.", 403);
    }
    counterId = who.counter.id_num;
  }
  if (!patient) throw new Error("Patient not found");
  if (patient.status !== "waiting" || patient.completed_at != null) {
    throw new Error("Only a waiting patient without a completion timestamp can be called");
  }
  const shared = isSharedDispatch();
  let doctorName;
  if (shared) {
    doctorName = resolveSharedCallDoctor(patient, counterId, accountCounters);
  } else {
    doctorName = getDoctorForService(patient.service_type);
    // Undo can retain the patient's previous doctor association while waiting.
    if (patient.counter_id != null && patient.counter_id !== doctorName) {
      throw new Error("This waiting patient has a conflicting doctor assignment");
    }
    if (counterId != null && counterId !== doctorName) {
      throw new Error(`This patient is assigned to ${doctorName}`);
    }
  }
  // In shared dispatch two doctors can be selected for the same visit; both keys are held.
  const visitKey = `visit:${patientId}`;
  if (callsInProgress.has(doctorName)) {
    throw new Error(`A call for ${doctorName} is already processing`);
  }
  if (callsInProgress.has(visitKey)) {
    throw new Error("A call for this patient is already processing");
  }
  callsInProgress.add(doctorName);
  callsInProgress.add(visitKey);

  try {
    // A doctor calling for itself is proven present by its own validated session.
    if (shared && !localCall && who.kind !== "doctor") await assertDoctorSignedIn(doctorName);
    let counters;
    let waitingPatients;
    let servingPatients;
    // The RPC re-ranks over the same window under its locks.
    const queueRange = getTodayRange();
    if (localCall) {
      counters = localData.counters;
      waitingPatients = localData.patients.filter((p) => p.status === "waiting" && isCreatedInRange(p, queueRange));
      servingPatients = localData.patients.filter((p) => p.status === "serving" &&
        (p.counter_id === doctorName || (p.counter_id == null && getDoctorForService(p.service_type) === doctorName)));
    } else {
      const { start, end } = queueRange;
      const [counterResult, waiting, serving] = await Promise.all([
        supabase.from("counters").select("id, id_num, is_online, current_patient_id"),
        fetchPatientPages(() => supabase.from("patients").select("*").eq("status", "waiting")
          .gte("created_at", start).lt("created_at", end), "Failed to check queue priority"),
        fetchPatientPages(() => supabase.from("patients").select("*").eq("status", "serving"),
          "Failed to check doctor's current patient")
      ]);
      if (counterResult.error) throw formatError(counterResult.error, "Failed to check doctor availability");
      counters = counterResult.data || [];
      waitingPatients = waiting;
      // Legacy Superadmin calls could leave serving rows without a counter.
      // Block their service's doctor until an explicit existing recovery action.
      servingPatients = serving.filter((p) =>
        p.counter_id === doctorName || (p.counter_id == null && getDoctorForService(p.service_type) === doctorName));
    }
    if (localCall !== useLocalFallback) {
      throw new Error("Queue storage changed while calling. Refresh the queue and try again.");
    }

    const counter = counters.find((c) => c.id_num === doctorName);
    if (!counter) throw new Error(`${doctorName} counter was not found`);
    if (counter.is_online !== true) {
      throw new Error(`${doctorName} is marked offline in System Settings. Enable availability before calling patients.`);
    }
    const reservedForPatient = patient.counter_id === doctorName && Number(counter.current_patient_id) === patientId;
    if ((counter.current_patient_id != null && !reservedForPatient) || servingPatients.length) {
      throw new Error(`${doctorName} is already serving a patient`);
    }
    if (counters.some((c) => c.id_num !== doctorName && Number(c.current_patient_id) === patientId)) {
      throw new Error("This patient is already assigned to another doctor");
    }
    // One ranking instant for Node and the database, so aging is computed the same way in both.
    const rankedAt = Date.now();
    const nextPatient = shared
      ? getSharedQueueHead(waitingPatients, doctorName, rankedAt)
      : waitingPatients.filter((p) => getDoctorForService(p.service_type) === doctorName).sort(compareWaitingPriority(rankedAt))[0];
    if (!nextPatient || Number(nextPatient.id) !== patientId) {
      throw new Error(shared
        ? "Call the next patient in the shared queue according to priority"
        : `Call the next eligible patient for ${doctorName} according to queue priority`);
    }

    const calledAt = new Date().toISOString();
    // Phase 2.1+ rows carry a revision; the RPC needs it to detect any change since this read.
    const rpcName = getCallRpcName(shared, wpsAging());
    const atomicCall = !localCall && patient.visit_state_revision
      ? await callPatientVisitRpc(patient, doctorName, actor, queueRange, rankedAt, rpcName)
      : null;
    // Shared dispatch and aging rank only in the database; neither falls back to the two-step Call.
    // C1 does only with the explicit opt-in (a database that never had C1).
    if (!localCall && !atomicCall && (rpcName !== "call_patient_visit" || env.allowLegacyTwoStepCall !== true)) {
      throw consultationError(CALL_RPC_REQUIRED[rpcName], 503);
    }
    if (!localCall && !atomicCall && !legacyCallWarned) {
      legacyCallWarned = true;
      console.warn("ALLOW_LEGACY_TWO_STEP_CALL is on: Call is using the non-atomic two-statement fallback because call_patient_visit is not available.");
    }
    if (localCall) {
      // No await between the final checks and both in-memory updates.
      patient.status = "serving";
      patient.counter_id = doctorName;
      patient.called_at = calledAt;
      patient.visit_state_revision = randomUUID();
      counter.current_patient_id = patientId;
    } else if (!atomicCall) {
      // Opt-in fallback for a database without C1: two conditional statements. The patient
      // compare-and-set includes the revision, so a Cancel + Requeue or Undo committed between
      // them (status back to waiting, new revision) can no longer be called by this request.
      // Claim an empty online doctor slot, or validate this patient's existing
      // Undo reservation. Only newly claimed slots may be released on failure.
      let claimQuery = supabase.from("counters")
        .update({ current_patient_id: patientId }).eq("id", counter.id)
        .eq("is_online", true);
      claimQuery = reservedForPatient
        ? claimQuery.eq("current_patient_id", patientId)
        : claimQuery.is("current_patient_id", null);
      const { data: claimedCounter, error: claimError } = await claimQuery.select("id").maybeSingle();
      if (claimError) throw formatError(claimError, "Failed to reserve doctor");
      if (!claimedCounter) throw new Error(`${doctorName} became unavailable or occupied. Refresh the queue.`);

      let uncertainOwnUpdate = false;
      try {
        if (localCall !== useLocalFallback) {
          throw new Error("Queue storage changed while calling. Refresh the queue and try again.");
        }
        let patientQuery = supabase.from("patients")
          .update({ status: "serving", counter_id: doctorName, called_at: calledAt })
          .eq("id", patientId).eq("status", "waiting").eq("service_type", patient.service_type).is("completed_at", null);
        patientQuery = patient.counter_id == null
          ? patientQuery.is("counter_id", null)
          : patientQuery.eq("counter_id", doctorName);
        if (patient.visit_state_revision) patientQuery = patientQuery.eq("visit_state_revision", patient.visit_state_revision);
        const { data: calledPatient, error: updateError } = await patientQuery.select("id").maybeSingle();
        if (updateError) {
          uncertainOwnUpdate = !reservedForPatient && !updateError.code &&
            /fetch failed|failed to fetch|network|ECONNRESET|ETIMEDOUT|timeout/i.test(updateError.message || "");
          throw formatError(updateError, "Failed to call patient");
        }
        if (!calledPatient) throw new Error("This patient is no longer eligible to be called. Refresh the queue.");
      } catch (error) {
        // A transport failure can occur after the patient update commits, or a
        // competing caller can win the patient CAS using an Undo reservation.
        const { data: latestPatient, error: stateError } = await supabase.from("patients")
          .select("status, counter_id, called_at").eq("id", patientId).maybeSingle();
        if (stateError) {
          throw new Error(`${error.message}. Could not confirm the patient state; the doctor reservation was kept. Refresh the queue.`);
        }
        const isServingHere = latestPatient?.status === "serving" && latestPatient.counter_id === doctorName;
        if (!reservedForPatient && !isServingHere) {
          // Never clear a pre-existing reservation or a slot with a serving
          // patient, and only release a slot still pointing to this patient.
          const { error: releaseError } = await supabase.from("counters")
            .update({ current_patient_id: null }).eq("id", counter.id).eq("current_patient_id", patientId);
          if (releaseError) {
            throw new Error(`${error.message}. Failed to release the reserved doctor: ${releaseError.message}`);
          }
        }
        if (!uncertainOwnUpdate || !isServingHere || latestPatient.called_at !== calledAt) throw error;
        // Only an uncertain transport error on our newly claimed slot can be
        // recovered. A zero-row CAS is always a conflict, even with an identical
        // timestamp, and must never reset a competing winner's acceptance state.
      }
    }

    // Acceptance, not calling, continues to drive the public voice announcement.
    markAwaitingAccept(patientId);
    if (patient.mobile_number) {
      try {
        await sendQueueCalledNotification(patient.mobile_number, patient.queue_number, doctorName);
      } catch (err) {
        console.error("Failed to send call notification:", err.message);
      }
    }
    return { success: true, doctor: doctorName };
  } finally {
    callsInProgress.delete(doctorName);
    callsInProgress.delete(visitKey);
  }
}

function consultationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireConsultationDoctor(actor) {
  if (actor?.role !== "admin" || !String(actor.id_num || "").trim() || !String(actor.doctor_name || "").trim()) {
    throw consultationError("Only the authenticated assigned doctor can manage a consultation.", 403);
  }
}

function resolveDoctorCounter(value, counters) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const number = raw.match(/^(?:doctor\s*)?(\d+)$/)?.[1];
  return counters.find((counter) => String(counter.id_num).trim().toLowerCase() === raw ||
    String(counter.id) === raw || (number && String(counter.id_num).toLowerCase() === `doctor ${Number(number)}`)) || null;
}

async function loadConsultationContext(patientId, actor) {
  requireConsultationDoctor(actor);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required");
  const local = useLocalFallback;
  let patient, counters, user;
  if (local) {
    patient = localData.patients.find((row) => row.id === patientId);
    counters = localData.counters;
    user = localData.users.find((row) => row.id_num === actor.id_num);
  } else {
    // Mutation validation never silently switches to another storage system.
    let results;
    try {
      results = await Promise.all([
        supabase.from("patients").select("*").eq("id", patientId).maybeSingle(),
        supabase.from("counters").select("id, id_num, current_patient_id"),
        supabase.from("users").select("id_num, role, doctor_name").eq("id_num", actor.id_num).maybeSingle()
      ]);
    } catch (error) {
      throw consultationError(error.message || "Consultation database validation is unavailable", 503);
    }
    for (const result of results) {
      if (result.error) throw consultationError(result.error.message || "Failed to validate consultation", 503);
    }
    patient = results[0].data;
    counters = results[1].data || [];
    user = results[2].data;
  }
  if (local !== useLocalFallback) throw consultationError("Queue storage changed. Refresh and try again.", 409);
  const counter = resolveDoctorCounter(actor.doctor_name, counters);
  const currentDoctor = resolveDoctorCounter(user?.doctor_name, counters);
  if (!user || user.role !== "admin" || !counter || currentDoctor?.id !== counter.id) {
    throw consultationError("Your current account is not assigned to this doctor. Sign in again.", 403);
  }
  if (!patient) throw consultationError("Patient not found", 404);
  if (patient.status !== "serving" || !patient.called_at || patient.completed_at != null) {
    throw consultationError("Only the doctor's current serving patient with a valid call can be managed");
  }
  if (resolveDoctorCounter(patient.counter_id, counters)?.id !== counter.id) {
    throw consultationError("You can only manage your assigned patient's consultation.", 403);
  }
  if (Number(counter.current_patient_id) !== patientId) {
    throw consultationError("Only the doctor's current serving patient with a valid call can be managed");
  }
  if (counters.some((other) => other.id !== counter.id && Number(other.current_patient_id) === patientId)) {
    throw consultationError("This patient has conflicting doctor assignments");
  }
  return { patient, counter, local };
}

async function getServingPatientForDoctor(patientId, actor) {
  return (await loadConsultationContext(patientId, actor)).patient;
}

const consultationActionsInProgress = new Set();

async function runConsultationAction(patientId, actor, action) {
  requireConsultationDoctor(actor);
  if (consultationActionsInProgress.has(patientId)) throw consultationError("A consultation action for this patient is already processing", 409);
  consultationActionsInProgress.add(patientId);
  try {
    return await action(await loadConsultationContext(patientId, actor));
  } finally {
    consultationActionsInProgress.delete(patientId);
  }
}

async function consultationRpc(name, params) {
  let result;
  try {
    result = await supabase.rpc(name, params);
  } catch (error) {
    throw consultationError(error.message || "Consultation database operation is unavailable", 503);
  }
  const { data, error } = result;
  if (error) {
    if (["PGRST202", "PGRST204", "42883", "42703"].includes(error.code)) {
      throw consultationError("Phase 2 database migration is required before starting or completing consultations.", 503);
    }
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 :
      ["P0001", "22023"].includes(error.code) ? 400 : 503;
    throw consultationError(error.message || "Consultation database operation failed", status);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw consultationError("Could not confirm the consultation update. Refresh the queue before retrying.", 503);
  return parsePatientPriority(row);
}

async function startConsultation(patientId, actor) {
  return runConsultationAction(patientId, actor, async ({ patient, counter, local }) => {
    const acceptedAt = getAcceptedAt(patientId);
    if (isAwaitingAccept(patientId) || !acceptedAt || !Number.isFinite(Date.parse(acceptedAt))) {
      throw consultationError("Accept this patient before starting the consultation.");
    }
    if (!Number.isFinite(Date.parse(patient.called_at)) || Date.parse(acceptedAt) < Date.parse(patient.called_at)) {
      throw consultationError("Accept the current call before starting consultation.");
    }
    if (patient.consultation_started_at != null) throw consultationError("Consultation has already started", 409);
    if (!local) return consultationRpc("start_patient_consultation", {
      p_patient_id: patientId, p_doctor_name: counter.id_num, p_user_id_num: actor.id_num, p_accepted_at: acceptedAt
    });
    if (patient.status !== "serving" || Number(counter.current_patient_id) !== patientId || patient.completed_at != null) {
      throw consultationError("The patient is no longer the doctor's current serving patient", 409);
    }
    // Development fallback: no await between the final checks and timestamp write.
    patient.consultation_started_at = new Date().toISOString();
    return parsePatientPriority(patient);
  });
}

async function completePatient(patientId, reason = null, counterId = null, actor) {
  const row = await runConsultationAction(patientId, actor, async ({ patient, counter, local }) => {
    if (counterId != null && resolveDoctorCounter(counterId, [counter])?.id !== counter.id) {
      throw consultationError("The requested doctor does not own this patient", 403);
    }
    if (isAwaitingAccept(patientId)) throw consultationError("Accept this patient before completing the consultation.");
    if (!patient.consultation_started_at || !Number.isFinite(Date.parse(patient.consultation_started_at))) {
      throw consultationError("Start Consultation is required before completing this patient.");
    }
    const trimmedReason = reason == null ? null : String(reason).trim() || null;
    if (!local) return consultationRpc("complete_patient_consultation", {
      p_patient_id: patientId, p_doctor_name: counter.id_num, p_user_id_num: actor.id_num,
      p_expected_started_at: patient.consultation_started_at, p_reason: trimmedReason
    });
    const completedAt = new Date().toISOString();
    if (patient.status !== "serving" || patient.completed_at != null || Number(counter.current_patient_id) !== patientId) {
      throw consultationError("The patient is no longer the doctor's current serving patient", 409);
    }
    if (timestampMicroseconds(completedAt) <= timestampMicroseconds(patient.consultation_started_at)) {
      throw consultationError("Completion must occur after the consultation start");
    }
    // The patient and counter development-memory writes have no intervening await.
    patient.status = "completed";
    patient.completed_at = completedAt;
    patient.reason = trimmedReason;
    counter.current_patient_id = null;
    return parsePatientPriority(patient);
  });
  clearRecallCount(patientId);
  return row;
}

// ---------------------------------------------------------------------------
// Cancel: authorization and canonical ownership (R2)
//
// Ownership is always derived from persisted records (the stored patient row,
// the counters and the persisted staff account), never from request fields.
// Policy: a Superadmin and a Frontdesk account (role "admin" with no doctor
// assignment) may cancel any active patient, as the staff queue screens already
// allow. A doctor account may cancel only patients that belong to its own
// doctor: its serving patient, or a patient routed to it by the service-to-doctor
// mapping that has not been called yet.
// ---------------------------------------------------------------------------
const FRONTDESK_ASSIGNMENT_LABELS = ["front desk", "frontdesk"];

function isFrontdeskAssignment(value) {
  const label = String(value ?? "").trim().toLowerCase();
  return !label || FRONTDESK_ASSIGNMENT_LABELS.includes(label);
}

async function loadCancellationContext(patientId, actor) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required");
  const local = useLocalFallback;
  let patient, counters, user = null;
  if (local) {
    patient = localData.patients.find((row) => row.id === patientId);
    counters = localData.counters;
    if (actor) user = localData.users.find((row) => row.id_num === actor.id_num) || null;
  } else {
    // Mutation validation never silently switches to another storage system.
    let results;
    try {
      results = await Promise.all([
        supabase.from("patients").select("*").eq("id", patientId).maybeSingle(),
        supabase.from("counters").select("id, id_num, current_patient_id"),
        actor
          ? supabase.from("users").select("id_num, role, doctor_name").eq("id_num", actor.id_num).maybeSingle()
          : Promise.resolve({ data: null, error: null })
      ]);
    } catch (error) {
      throw consultationError(error.message || "Cancellation database validation is unavailable", 503);
    }
    for (const result of results) {
      if (result.error) throw consultationError(result.error.message || "Failed to validate cancellation", 503);
    }
    patient = results[0].data;
    counters = results[1].data || [];
    user = results[2].data;
  }
  if (local !== useLocalFallback) throw consultationError("Queue storage changed. Refresh and try again.", 409);
  return { patient: patient || null, counters, user, local };
}

// Resolves who the caller is from the verified token claims and the persisted
// account. Returns { kind: "system" | "superadmin" | "frontdesk" | "doctor", counter? }.
function resolveCancelActor(actor, user, counters) {
  if (actor == null) return { kind: "system" }; // trusted in-process caller, never an HTTP request
  if (!["admin", "superadmin"].includes(actor.role) || !String(actor.id_num || "").trim()) {
    throw consultationError("An authenticated staff account is required for this patient action.", 403);
  }
  if (!user || user.role !== actor.role) {
    throw consultationError("Your account no longer matches your session. Sign in again.", 403);
  }
  if (actor.role === "superadmin") return { kind: "superadmin" };
  const ownDoctor = resolveDoctorCounter(user.doctor_name, counters);
  if (isFrontdeskAssignment(user.doctor_name)) {
    // A token that claims a doctor the persisted account does not have is stale or forged.
    if (!isFrontdeskAssignment(actor.doctor_name)) {
      throw consultationError("Your current account is not assigned to this doctor. Sign in again.", 403);
    }
    return { kind: "frontdesk" };
  }
  const claimed = resolveDoctorCounter(actor.doctor_name, counters);
  if (!ownDoctor || claimed?.id !== ownDoctor.id) {
    throw consultationError("Your current account is not assigned to this doctor. Sign in again.", 403);
  }
  return { kind: "doctor", counter: ownDoctor };
}

// The doctor a patient belongs to, from persisted data only: the stored
// assignment first; a patient never called follows the service mapping (in shared
// dispatch it belongs to no doctor until it is called). A serving patient with no
// resolvable assignment is an orphan and has no owner.
function resolveCancelOwner(patient, counters) {
  if (String(patient.counter_id ?? "").trim()) return resolveDoctorCounter(patient.counter_id, counters);
  if (patient.status === "serving") return null;
  const routed = getRoutedDoctor(patient.service_type);
  return routed ? resolveDoctorCounter(routed, counters) : null;
}

// Shared by Cancel, No-show, Recall, Re-Call, Requeue and Undo (R2/R2.1). Loads the
// stored patient, counters and persisted account, identifies the caller, and rejects:
//   - an unauthenticated or mismatched account (403),
//   - a doctor account acting on a patient that is not its own (403),
//   - a client-supplied doctor/counter that contradicts the stored assignment (409/400).
// Frontdesk and Superadmin keep their existing cross-doctor operational permissions.
// `actor` undefined means a trusted in-process caller (never an HTTP request).
// A terminal visit must not be pointed at by any counter. A repeat Cancel/No-show returns without
// touching the patient row, but if an earlier attempt committed the patient and failed before
// releasing the counter (two separate writes today), the repeat releases that stale pointer so a
// retry repairs the doctor's counter. Only counters whose pointer is this patient are cleared.
async function releaseStaleCounterPointer(patientId, counters, local) {
  if (!counters.some((counter) => Number(counter.current_patient_id) === patientId)) return;
  if (local) {
    for (const counter of localData.counters) {
      if (counter.current_patient_id === patientId) counter.current_patient_id = null;
    }
    return;
  }
  await clearCounterAssignment(patientId);
}

async function authorizeVisitAction(patientId, actor, counterId = null, { denyMessage } = {}) {
  const { patient: found, counters, user, local } = await loadCancellationContext(patientId, actor);
  // Identify the caller first so an unauthorized account learns nothing about a patient.
  const who = resolveCancelActor(actor, user, counters);
  if (!found) throw consultationError("Patient not found", 404);
  const existing = { ...found };
  const owner = resolveCancelOwner(existing, counters);
  if (who.kind === "doctor" && (!owner || owner.id !== who.counter.id)) {
    throw consultationError(denyMessage || "You can only manage patients assigned to your doctor.", 403);
  }
  // A client-supplied assignment must agree with the persisted one.
  const supplied = String(counterId ?? "").trim() ? counterId : null;
  const requested = supplied ? resolveDoctorCounter(supplied, counters) : null;
  if (supplied) {
    if (!requested) throw consultationError("The requested doctor is not a valid counter", 400);
    if (owner && requested.id !== owner.id) {
      throw consultationError("The requested doctor does not match this patient's assigned doctor", 409);
    }
  }
  return { existing, who, owner, requested, counters, local };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCEL_MIGRATION_REQUIRED = "Cancelling a patient who is being served (or still holds a doctor counter) needs the W1 database migration (backend/scripts/20261025-w1-atomic-cancel.sql). Nothing was changed.";
const UNCONFIRMED_CANCEL_MESSAGE = "Could not confirm the cancellation. Refresh the queue before retrying.";
const NO_SESSION_CANCEL_MESSAGE = "An authenticated staff session is required to cancel this patient.";
const BACKLOG_W1_REQUIRED = "Historical backlog cancellation needs the W1 database function (backend/scripts/20261025-w1-atomic-cancel.sql). Nothing was changed.";
// 28000: the session or account no longer matches the token (sign in again, as the middleware
// answers); 42501: a valid account without permission. QM codes are the function's business rules.
const CANCEL_RPC_STATUS = {
  "22023": 400, "28000": 401, "42501": 403, P0002: 404, "40001": 409,
  QM001: 400, QM002: 409, QM003: 409
};

// W1: returns the row from cancel_patient_visit, or null when the migration is not installed.
// Any error means nothing was committed, except a lost response, which is never reported as success.
async function cancelPatientVisitRpc(existing, actor, reason, counterId) {
  if (!UUID_PATTERN.test(existing.visit_state_revision || "")) return null;
  if (typeof actor?.jti !== "string" || !UUID_PATTERN.test(actor.jti)) {
    throw consultationError("Your authentication session is invalid. Please sign in again.", 401);
  }
  let result;
  try {
    result = await supabase.rpc("cancel_patient_visit", {
      p_patient_id: existing.id, p_session_id: actor.jti, p_user_id_num: actor.id_num, p_role: actor.role,
      p_doctor_name: actor.doctor_name || null, p_expected_revision: existing.visit_state_revision,
      p_expected_status: existing.status, p_reason: reason,
      p_requested_counter: String(counterId ?? "").trim() ? String(counterId) : null
    });
  } catch {
    throw consultationError(UNCONFIRMED_CANCEL_MESSAGE, 503);
  }
  const { data, error } = result || {};
  if (error) {
    if (MISSING_RPC_CODES.includes(error.code)) return null;
    if (!error.code) throw consultationError(UNCONFIRMED_CANCEL_MESSAGE, 503);
    const status = CANCEL_RPC_STATUS[error.code];
    if (!status) {
      // Deadlock, lock or statement timeout, invariant failure, unavailable database: rolled back.
      throw consultationError("The cancellation could not be completed and nothing was changed. Please retry.", 503);
    }
    throw consultationError(error.message || "Failed to cancel patient", status);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const repeat = existing.status === "cancelled";
  if (!row || Number(row.id) !== existing.id || row.status !== "cancelled" || !row.visit_state_revision ||
      (row.visit_state_revision === existing.visit_state_revision) !== repeat) {
    throw consultationError(UNCONFIRMED_CANCEL_MESSAGE, 503);
  }
  return parsePatientPriority(row);
}

// Returns the patient after cancelling. A repeated cancel of an already
// cancelled patient is explicitly idempotent: it returns { already_cancelled: true }
// and writes nothing. `counterId` is only an optional consistency check against
// the stored assignment and is never written over it. `actor` is the verified
// request identity; omit it only for trusted in-process callers.
async function cancelPatient(patientId, reason = null, counterId = null, actor = undefined) {
  // No in-process lock: a Cancel may legitimately race a Start/Complete served by
  // another backend instance, so correctness rests on the database (the W1 RPC, or the
  // waiting-only compare-and-set on status + visit_state_revision), not on this process's memory.
  return performCancellation(patientId, reason, counterId, actor);
}

// `backlog` (Historical Backlog only) holds the snapshot the Superadmin reviewed. The visit must
// still be that exact earlier-day waiting revision; the W1 RPC then re-checks the same revision
// under its locks, so nothing reviewed can change between this check and the commit.
async function performCancellation(patientId, reason, counterId, actor, backlog = null) {
  const { existing, owner, requested, counters, local } = await authorizeVisitAction(patientId, actor, counterId, {
    denyMessage: "You can only cancel patients assigned to your doctor."
  });

  if (backlog) {
    // A duplicate or concurrent backlog cancel writes nothing, not even a stale-pointer release.
    if (existing.status === "cancelled") return { ...parsePatientPriority(existing), already_cancelled: true };
    assertBacklogCancellable(existing, counters, backlog);
  }

  if (existing.status === "completed") throw consultationError("A completed consultation cannot be cancelled");
  if (existing.status === "no-show") {
    throw consultationError("This patient was marked no-show. Undo the no-show before cancelling.", 409);
  }
  const pointed = counters.some((counter) => Number(counter.current_patient_id) === patientId);
  if (existing.status === "cancelled") {
    // Terminal and unchanged: original reason, completion time, assignment and history stay as recorded.
    if (local) {
      await releaseStaleCounterPointer(patientId, counters, local);
    } else if (pointed) {
      // W1: a stale pointer is released only under the RPC's locks. A separate release could
      // clear the counter of a later Requeue/Undo + Call of this same visit.
      const row = actor == null ? null : await cancelPatientVisitRpc(existing, actor, reason, owner ? counterId : null);
      if (!row) throw consultationError(actor == null ? NO_SESSION_CANCEL_MESSAGE : CANCEL_MIGRATION_REQUIRED, 503);
      return { ...row, already_cancelled: true };
    }
    return { ...parsePatientPriority(existing), already_cancelled: true };
  }

  const trimmedReason = reason == null ? null : String(reason).trim() || null;
  const completedAt = new Date().toISOString();
  // Keep the stored assignment. Only a patient with none (never called) takes the
  // validated doctor, which equals the mapped owner and never another doctor.
  const stampCounter = !String(existing.counter_id ?? "").trim() && owner && requested?.id === owner.id ? owner.id_num : null;
  const attributedTo = String(existing.counter_id ?? "").trim() ? existing.counter_id : stampCounter;

  if (local) {
    // No await between the final validation and the writes in temporary memory.
    const current = localData.patients.find((row) => row.id === patientId);
    if (!current || current.status !== existing.status || (current.visit_state_revision ?? null) !== (existing.visit_state_revision ?? null) ||
        (current.counter_id ?? null) !== (existing.counter_id ?? null)) {
      throw consultationError("Patient visit changed; refresh before retrying cancellation", 409);
    }
    current.status = "cancelled";
    current.completed_at = completedAt;
    current.reason = trimmedReason;
    if (stampCounter) current.counter_id = stampCounter;
    current.visit_state_revision = randomUUID();
    for (const counter of localData.counters) {
      if (counter.current_patient_id === patientId) counter.current_patient_id = null;
    }
    clearRecallCount(patientId);
    return parsePatientPriority(current);
  }

  // W1: the RPC cancels the visit and releases its counter(s) in one transaction. Trusted
  // in-process callers have no session to re-validate and take the path below. A visit with no
  // owner (a shared-dispatch visit never called) gets no doctor from the request: W1 would
  // otherwise check or stamp the legacy service doctor.
  const atomic = actor == null ? null : await cancelPatientVisitRpc(existing, actor, trimmedReason, owner ? counterId : null);
  if (atomic) {
    clearRecallCount(patientId);
    return atomic;
  }
  // The Historical Backlog cancels only through W1, never through the compare-and-set below.
  if (backlog) throw consultationError(BACKLOG_W1_REQUIRED, 503);
  // Not installed. The only transition that stays safe is one with no counter release: a
  // waiting visit that no counter points at, cancelled by a single compare-and-set below. A
  // serving visit (or any pointer) would need the two-step release W1 showed to be unsafe.
  if (existing.status !== "waiting" || pointed) {
    throw consultationError(actor == null ? NO_SESSION_CANCEL_MESSAGE : CANCEL_MIGRATION_REQUIRED, 503);
  }

  const updatePayload = { status: "cancelled", completed_at: completedAt, reason: trimmedReason };
  if (stampCounter) updatePayload.counter_id = stampCounter;

  // Conditional on the row still being the one that was authorized: a changed
  // status or revision (Undo, Requeue, Call, Start, Complete, another Cancel) matches no row.
  const conditionalUpdate = (payload) => {
    let query = supabase.from("patients").update(payload).eq("id", patientId).eq("status", existing.status);
    if (existing.visit_state_revision) query = query.eq("visit_state_revision", existing.visit_state_revision);
    return query.select("*").maybeSingle();
  };

  let { data, error } = await conditionalUpdate(updatePayload);

  // Fallback when patients.reason column has not been migrated yet
  if (error && /reason/i.test(String(error.message || ""))) {
    const fallbackPayload = {
      status: "cancelled",
      completed_at: completedAt,
      vulnerability_flags: withCancelMeta(existing.vulnerability_flags, trimmedReason, attributedTo)
    };
    if (stampCounter) fallbackPayload.counter_id = stampCounter;
    ({ data, error } = await conditionalUpdate(fallbackPayload));
  }

  if (error) {
    throw formatError(error, "Failed to cancel patient");
  }
  if (!data) {
    throw consultationError("Patient visit changed; refresh before retrying cancellation", 409);
  }

  clearRecallCount(patientId);
  return parsePatientPriority(data);
}

// Historical Waiting Backlog (H1 Stage 1, Superadmin only). A historical visit is stored as
// waiting and was registered before today's Manila business date by the server clock. It may
// be a valid carry-over, so reading the backlog never writes; a cancel is one visit at a time
// through performCancellation (W1). Only the fields the review needs are read: no mobile
// number, birth date, residency or PhilHealth data.
const BACKLOG_COLUMNS = "id, id_num, queue_number, service_type, status, counter_id, priority_score, vulnerability_flags, created_at, called_at, consultation_started_at, completed_at, reason, visit_state_revision";
// The backlog is filtered in this process (doctor ownership needs the counters). Beyond this
// many rows the response says it is truncated rather than silently dropping visits.
const BACKLOG_FETCH_LIMIT = 500;
const BACKLOG_SERVICES = ["consultation", "checkup", "prenatal", "maternity", "family_planning"];
const BACKLOG_UNAVAILABLE = "Historical backlog storage is unavailable. Please retry.";

function historicalCutoff(now = new Date()) {
  const businessDate = getBusinessDate(now);
  return { businessDate, before: getBusinessDayRange(businessDate).start };
}

const isHistoricalWaiting = (patient, before) =>
  patient?.status === "waiting" && Date.parse(patient.created_at) < Date.parse(before);

// A clean waiting visit has no call, assignment, consultation or completion recorded (registration
// stores none, and Requeue/Undo clear them). Anything else is shown for manual review and never
// repaired here. Only a counter that still points at the visit blocks cancellation: W1 would
// release that counter, and Stage 1 never changes a doctor counter as a side effect.
function backlogFlags(patient, counters) {
  const flags = [];
  const pointing = counters.filter((counter) => Number(counter.current_patient_id) === Number(patient.id));
  if (pointing.length) {
    flags.push({ code: "counter_conflict", blocking: true, label: "Doctor counter points at this visit",
      detail: `${pointing.map((counter) => counter.id_num).join(", ")} still lists this waiting visit as its current patient. Cancelling would release that counter, so cancellation is blocked until the counter state is reviewed.` });
  }
  if (!UUID_PATTERN.test(patient.visit_state_revision || "")) {
    flags.push({ code: "no_revision", blocking: true, label: "No visit revision",
      detail: "This visit has no stored revision, so a safe cancellation cannot be confirmed." });
  }
  if (patient.called_at) {
    flags.push({ code: "previously_called", label: "Call recorded",
      detail: "A call timestamp is stored although the visit is waiting. It may have been called and returned to the queue." });
  }
  const stored = String(patient.counter_id ?? "").trim();
  if (stored) {
    flags.push({ code: "stored_assignment", label: "Doctor assignment stored",
      detail: resolveDoctorCounter(stored, counters)
        ? `The visit still stores the assignment "${stored}" from an earlier call.`
        : `The stored assignment "${stored}" matches no doctor counter.` });
  }
  if (patient.consultation_started_at) {
    flags.push({ code: "consultation_started", label: "Consultation start recorded",
      detail: "A consultation start is stored although the visit is waiting." });
  }
  if (patient.completed_at) {
    flags.push({ code: "completion_recorded", label: "Completion time recorded",
      detail: "A completion or cancellation time is stored although the visit is waiting." });
  }
  return flags;
}

function backlogView(patient, counters) {
  const parsed = parsePatientPriority(patient);
  const stored = String(patient.counter_id ?? "").trim();
  const owner = resolveCancelOwner(patient, counters);
  const flags = backlogFlags(patient, counters);
  return {
    id: Number(patient.id),
    queue_number: patient.queue_number,
    patient_name: patient.id_num ?? null,
    service_type: patient.service_type,
    status: patient.status,
    // Same reading as Records: a stored assignment, or the doctor the service routes to
    // (none in shared dispatch, where an uncalled visit is unassigned).
    doctor: stored ? (owner?.id_num || stored) : (owner?.id_num || getRoutedDoctor(patient.service_type)),
    doctor_source: stored ? (owner ? "stored" : "unresolved") : getRoutedDoctor(patient.service_type) ? "service" : "unassigned",
    priority_score: parsed.priority_score,
    priority_categories: parsed.vulnerability_flags,
    created_at: patient.created_at,
    called_at: patient.called_at ?? null,
    consultation_started_at: patient.consultation_started_at ?? null,
    completed_at: patient.completed_at ?? null,
    reason: parsed.reason,
    visit_state_revision: patient.visit_state_revision ?? null,
    flags,
    requires_review: flags.length > 0,
    cancel_blocked: flags.find((flag) => flag.blocking)?.detail || null
  };
}

async function loadBacklogCounters() {
  if (useLocalFallback) return localData.counters;
  const { data, error } = await supabase.from("counters").select("id, id_num, current_patient_id");
  if (error) throw consultationError(BACKLOG_UNAVAILABLE, 503);
  return data || [];
}

async function loadBacklogSource(before) {
  if (useLocalFallback) {
    const patients = localData.patients.filter((row) => isHistoricalWaiting(row, before))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    return { patients: patients.slice(0, BACKLOG_FETCH_LIMIT), counters: localData.counters, truncated: patients.length > BACKLOG_FETCH_LIMIT };
  }
  let patients, counters;
  try {
    const { data, error } = await supabase.from("patients").select(BACKLOG_COLUMNS)
      .eq("status", "waiting").lt("created_at", before)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(0, BACKLOG_FETCH_LIMIT);
    if (error) throw consultationError(BACKLOG_UNAVAILABLE, 503);
    patients = data || [];
    counters = await loadBacklogCounters();
  } catch (error) {
    throw error?.statusCode ? error : consultationError(BACKLOG_UNAVAILABLE, 503);
  }
  return { patients: patients.slice(0, BACKLOG_FETCH_LIMIT), counters, truncated: patients.length > BACKLOG_FETCH_LIMIT };
}

function readBacklogFilters({ search = "", date = "", service = "", doctor = "", page = 1, limit = 20 } = {}) {
  const text = (value) => {
    if (typeof value !== "string" || value.length > 100) throw consultationError("Invalid filter", 400);
    return value.trim();
  };
  const filters = { search: text(search), date: text(date), service: text(service), doctor: text(doctor), page: Number(page), limit: Number(limit) };
  if (!Number.isInteger(filters.page) || filters.page < 1 || filters.page > 100000 ||
      !Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 100) {
    throw consultationError("Invalid pagination", 400);
  }
  if (filters.service && !BACKLOG_SERVICES.includes(filters.service)) throw consultationError("Invalid filter", 400);
  return filters;
}

// The earlier-day waiting visits, oldest first, with review flags. `now` is the server clock.
async function getHistoricalBacklog(query = {}, now = new Date()) {
  const filters = readBacklogFilters(query);
  const dateRange = filters.date ? getBusinessDayRange(filters.date) : null;
  const { businessDate, before } = historicalCutoff(now);
  const { patients, counters, truncated } = await loadBacklogSource(before);
  const doctor = filters.doctor ? resolveDoctorCounter(filters.doctor, counters) : null;
  if (filters.doctor && !doctor) throw consultationError("Invalid filter", 400);
  const all = patients.map((patient) => backlogView(patient, counters));
  const search = filters.search.toLowerCase();
  const rows = all.filter((row) =>
    (!search || String(row.queue_number ?? "").toLowerCase().includes(search)) &&
    (!dateRange || (Date.parse(row.created_at) >= Date.parse(dateRange.start) && Date.parse(row.created_at) < Date.parse(dateRange.end))) &&
    (!filters.service || row.service_type === filters.service) &&
    (!doctor || resolveDoctorCounter(row.doctor, counters)?.id === doctor.id));
  const offset = (filters.page - 1) * filters.limit;
  return {
    business_date: businessDate,
    registered_before: before,
    observed_at: new Date(now).toISOString(),
    total_backlog: all.length,
    requires_review: all.filter((row) => row.requires_review).length,
    truncated,
    total: rows.length,
    page: filters.page,
    limit: filters.limit,
    rows: rows.slice(offset, offset + filters.limit)
  };
}

// The current stored state of one visit for the review panel, and whether it is still eligible.
async function getHistoricalBacklogVisit(patientId, now = new Date()) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required", 400);
  const { before } = historicalCutoff(now);
  let patient, counters;
  if (useLocalFallback) {
    patient = localData.patients.find((row) => row.id === patientId) || null;
    counters = localData.counters;
  } else {
    try {
      const { data, error } = await supabase.from("patients").select(BACKLOG_COLUMNS).eq("id", patientId).maybeSingle();
      if (error) throw consultationError(BACKLOG_UNAVAILABLE, 503);
      patient = data;
      counters = await loadBacklogCounters();
    } catch (error) {
      throw error?.statusCode ? error : consultationError(BACKLOG_UNAVAILABLE, 503);
    }
  }
  if (!patient) throw consultationError("Patient not found", 404);
  const eligible = isHistoricalWaiting(patient, before);
  return {
    ...backlogView(patient, counters),
    registered_before: before,
    eligible,
    ineligible_reason: eligible ? null
      : patient.status !== "waiting" ? `This visit is no longer waiting (current status: ${patient.status}).`
      : "This visit was registered today, so it is part of today's queue, not the historical backlog."
  };
}

function assertBacklogCancellable(existing, counters, { expectedRevision, before, acknowledged }) {
  if (existing.status !== "waiting") {
    throw consultationError(`This visit is no longer waiting (current status: ${existing.status}). Nothing was changed.`, 409);
  }
  if ((existing.visit_state_revision ?? null) !== expectedRevision) {
    throw consultationError("This visit changed after it was reviewed. Review it again before cancelling. Nothing was changed.", 409);
  }
  if (!isHistoricalWaiting(existing, before)) {
    throw consultationError("This visit was registered today and is not part of the historical backlog. Nothing was changed.", 409);
  }
  const flags = backlogFlags(existing, counters);
  const blocking = flags.find((flag) => flag.blocking);
  if (blocking) throw consultationError(`${blocking.detail} Nothing was changed.`, 409);
  if (flags.length && acknowledged !== true) {
    throw consultationError("This visit requires review. Confirm that you reviewed its history before cancelling. Nothing was changed.", 409);
  }
}

// Superadmin cancels one reviewed historical visit. Reuses performCancellation, so the W1 RPC
// re-validates the session, locks counters then the patient, and commits only that revision.
async function cancelHistoricalWaitingVisit(patientId, { reason, expectedRevision, acknowledged = false } = {}, actor, now = new Date()) {
  if (actor?.role !== "superadmin") throw consultationError("Only Superadmin can manage the historical backlog.", 403);
  const trimmedReason = String(reason ?? "").trim();
  if (!trimmedReason) throw consultationError("Reason for cancel is required", 400);
  if (trimmedReason.length > 1000) throw consultationError("Reason for cancel is too long (maximum 1000 characters)", 400);
  if (typeof expectedRevision !== "string" || !UUID_PATTERN.test(expectedRevision)) {
    throw consultationError("The reviewed visit revision is required. Review the visit again before cancelling.", 400);
  }
  return performCancellation(patientId, trimmedReason, null, actor, {
    expectedRevision, before: historicalCutoff(now).before, acknowledged
  });
}

// Returns the patient after marking no-show. A repeated no-show is idempotent
// ({ already_no_show: true }) and writes nothing; a cancelled patient must be undone first.
async function noShowPatient(patientId, reason = null, actor = undefined) {
  const { existing, counters, local } = await authorizeVisitAction(patientId, actor, null, {
    denyMessage: "You can only mark no-shows for patients assigned to your doctor."
  });

  if (existing.status === "completed") {
    throw new Error("A completed consultation cannot be marked as no-show");
  }
  if (existing.status === "no-show") {
    await releaseStaleCounterPointer(patientId, counters, local);
    return { ...parsePatientPriority(existing), already_no_show: true };
  }
  if (existing.status === "cancelled") {
    throw consultationError("This patient was cancelled. Undo the cancellation before marking no-show.", 409);
  }

  if (existing.status === "serving" && existing.called_at) {
    const settings = getQueueSettings();
    const waitMs = (Number(settings.noShowWaitMinutes) || 10) * 60 * 1000;
    const elapsed = Date.now() - new Date(existing.called_at).getTime();
    if (elapsed < waitMs) {
      const remainMin = Math.ceil((waitMs - elapsed) / 60000);
      throw new Error(`No-show wait time not reached. Please wait about ${remainMin} more minute(s).`);
    }
  }

  const completedAt = new Date().toISOString();
  if (local) {
    // No await between the final validation and the writes in temporary memory.
    const current = localData.patients.find((row) => row.id === patientId);
    if (!current || current.status !== existing.status || (current.visit_state_revision ?? null) !== (existing.visit_state_revision ?? null)) {
      throw consultationError("Patient visit changed; refresh before retrying", 400);
    }
    current.status = "no-show";
    current.completed_at = completedAt;
    current.reason = reason;
    current.visit_state_revision = randomUUID();
    for (const counter of localData.counters) {
      if (counter.current_patient_id === patientId) counter.current_patient_id = null;
    }
    clearRecallCount(patientId);
    return current;
  }

  // Conditional on the authorized row still being current (status + revision). A stale
  // write keeps the endpoint's existing 400 contract and changes nothing.
  let query = supabase
    .from("patients")
    .update({ status: "no-show", completed_at: completedAt, reason })
    .eq("id", patientId)
    .eq("status", existing.status);
  if (existing.visit_state_revision) query = query.eq("visit_state_revision", existing.visit_state_revision);
  const { data, error } = await query.select("*").maybeSingle();

  if (error) {
    throw formatError(error, "Failed to mark patient as no-show");
  }
  if (!data) {
    throw consultationError("Patient visit changed; refresh before retrying", 400);
  }

  await clearCounterAssignment(patientId);
  clearRecallCount(patientId);
  return data;
}

// Legacy repeat-call endpoint (before acceptance). The stored assignment is
// authoritative: the caller's counter is only a consistency check and is never written.
async function recallPatient(patientId, counterId = null, actor = undefined) {
  const { existing: patient, owner, local } = await authorizeVisitAction(patientId, actor, counterId, {
    denyMessage: "You can only recall patients assigned to your doctor."
  });
  if (patient.status !== "serving") {
    throw new Error("Only a serving patient can be recalled");
  }
  if (patient.consultation_started_at || getAcceptedAt(patientId)) {
    throw new Error("Use Re-Call for an accepted patient; the original call time must be preserved.");
  }
  if (!owner) {
    throw consultationError("This serving patient has no assigned doctor. Cancel it or call it again from the queue.", 409);
  }
  const doctor = owner.id_num;

  const settings = getQueueSettings();
  const maxRecalls = Number(settings.recallAttempts);
  const used = getRecallCount(patientId);
  if (Number.isFinite(maxRecalls) && used >= maxRecalls) {
    throw new Error(`Recall limit reached (${maxRecalls}). Mark as no-show or cancel the patient.`);
  }

  const counters = await getCounters();
  const counter = counters.find((c) => c.id_num === doctor);
  if (counter && counter.is_online === false) {
    throw new Error(`${doctor} is marked offline in System Settings.`);
  }

  // Acceptance can arrive while the availability query above is pending.
  if (patient.consultation_started_at || getAcceptedAt(patientId)) {
    throw new Error("Use Re-Call for an accepted patient; the original call time must be preserved.");
  }
  const calledAt = new Date().toISOString();

  if (useLocalFallback || local) {
    const current = localData.patients.find((row) => row.id === patientId);
    if (!current || current.status !== "serving" || current.consultation_started_at ||
        (current.visit_state_revision ?? null) !== (patient.visit_state_revision ?? null)) {
      throw consultationError("Patient visit changed; refresh before retrying", 409);
    }
    current.called_at = calledAt;
    current.visit_state_revision = randomUUID();
    return { success: true, recall_count: incrementRecallCount(patientId), max_recalls: maxRecalls };
  }

  let query = supabase
    .from("patients")
    .update({ called_at: calledAt })
    .eq("id", patientId)
    .eq("status", "serving")
    .is("consultation_started_at", null);
  if (patient.visit_state_revision) query = query.eq("visit_state_revision", patient.visit_state_revision);
  const { data, error } = await query.select("id").maybeSingle();

  if (error) {
    throw formatError(error, "Failed to recall patient");
  }
  if (!data) {
    throw consultationError("Patient visit changed; refresh before retrying", 409);
  }
  const nextCount = incrementRecallCount(patientId);

  if (patient.mobile_number) {
    try {
      await sendQueueCalledNotification(patient.mobile_number, patient.queue_number, doctor || "Counter");
    } catch (err) {
      console.error("Failed to send recall notification:", err.message);
    }
  }

  return { success: true, recall_count: nextCount, max_recalls: maxRecalls };
}

function requireRecoveryActor(actor) {
  if (!actor || !["admin", "superadmin"].includes(actor.role) || !String(actor.id_num || "").trim()) {
    throw consultationError("An authenticated staff account is required for recovery", 403);
  }
}

function assertRecoverySnapshot(current, expected) {
  const fields = ["visit_state_revision", "status", "created_at", "called_at", "consultation_started_at", "completed_at", "counter_id"];
  if (!current || fields.some((field) => (current[field] ?? null) !== (expected[field] ?? null))) {
    throw consultationError("Patient visit changed; refresh before retrying recovery", 409);
  }
  if (current.status === "completed" && current.consultation_started_at != null) {
    throw consultationError("Completed consultation history must be preserved. Register a new visit instead.");
  }
}

const MISSING_RPC_CODES = ["PGRST202", "PGRST204", "42883", "42703"];
// For Call only "the function cannot be found" counts as missing. 42703 (undefined column) is
// also raised from inside an installed function by unrelated schema drift (I2 Finding 8).
const CALL_MISSING_RPC_CODES = MISSING_RPC_CODES.filter((code) => code !== "42703");
let legacyCallWarned = false;

// `counters` is the authorization snapshot's counter list. Requeue uses it to decide whether a
// stale pointer to this terminal visit must be released together with the recovery (F5).
async function recoverPatientVisit(existing, action, actor, reason = null, counters = []) {
  requireRecoveryActor(actor);
  if (useLocalFallback) {
    const patient = localData.patients.find((row) => row.id === existing.id);
    assertRecoverySnapshot(patient, existing);
    // No await between final validation and recovery in temporary memory.
    patient.status = "waiting";
    patient.completed_at = null;
    patient.consultation_started_at = null;
    patient.visit_state_revision = randomUUID();
    if (action === "requeue") {
      patient.created_at = new Date().toISOString();
      patient.reason = reason;
    }
    patient.called_at = null;
    patient.counter_id = null;
    // A waiting visit owns no counter; release any stale pointer in the same step.
    for (const counter of localData.counters) {
      if (counter.current_patient_id === patient.id) counter.current_patient_id = null;
    }
    // Waiting patients reserve their service's doctor through the normal Call.
    return parsePatientPriority(patient);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing.visit_state_revision || "")) {
    throw consultationError("Phase 2.1 database migration is required before Requeue or Undo.", 503);
  }
  const args = {
    p_patient_id: existing.id,
    p_action: action,
    p_user_id_num: actor.id_num,
    p_expected_revision: existing.visit_state_revision,
    p_expected_status: existing.status,
    // Pass the original PostgreSQL strings, retaining all microseconds.
    p_expected_created_at: existing.created_at,
    p_expected_called_at: existing.called_at ?? null,
    p_expected_started_at: existing.consultation_started_at ?? null,
    p_expected_completed_at: existing.completed_at ?? null,
    p_expected_counter_id: existing.counter_id ?? null,
    p_reason: reason
  };
  let result;
  try {
    if (action === "undo") {
      // Versioned Undo entry point fails before writes on a Phase 2.1-only DB.
      // The older same-shaped recovery RPC cannot attest to clean waiting ownership.
      result = await supabase.rpc("undo_patient_visit_waiting", args);
    } else {
      // F5: the versioned Requeue entry point re-checks terminal-only eligibility and releases
      // stale counter pointers in the same transaction. Until it is installed, the older RPC is
      // used only when no counter points at this visit; its snapshot comparison still rejects a
      // visit whose status changed after this eligibility check.
      result = await supabase.rpc("requeue_patient_visit", args);
      if (MISSING_RPC_CODES.includes(result?.error?.code)) {
        if (counters.some((counter) => Number(counter.current_patient_id) === existing.id)) {
          throw consultationError("A doctor counter still points at this visit. Use Undo, which releases it safely, or install the F5 Requeue database migration.", 503);
        }
        result = await supabase.rpc("recover_patient_visit", args);
      }
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw consultationError("Patient recovery storage is unavailable. Please retry.", 503);
  }
  if (result?.error) {
    const error = result.error;
    if (MISSING_RPC_CODES.includes(error.code)) {
      throw consultationError(action === "undo"
        ? "Phase 2.2 database migration is required before Undo."
        : "Phase 2.1 database migration is required before Requeue.", 503);
    }
    const status = error.code === "40001" ? 409 : error.code === "42501" ? 403 : error.code === "P0002" ? 404 :
      ["P0001", "22023"].includes(error.code) ? 400 : 503;
    throw consultationError(error.message || "Patient recovery failed", status);
  }
  const patient = Array.isArray(result?.data) ? result.data[0] : result?.data;
  if (!patient || patient.id !== existing.id || patient.status !== "waiting" ||
      !patient.visit_state_revision || patient.visit_state_revision === existing.visit_state_revision ||
      patient.consultation_started_at != null || patient.completed_at != null ||
      patient.called_at != null || patient.counter_id != null) {
    throw consultationError("Could not confirm recovery. Refresh the queue before retrying.", 503);
  }
  return parsePatientPriority(patient);
}

// "completed" here is only the legacy completed-without-start case; a completed consultation
// with a recorded start is refused before this list is consulted.
const REQUEUE_ELIGIBLE_STATUSES = ["cancelled", "no-show", "completed"];

async function requeuePatient(patientId, reason = null, actor) {
  const settings = getQueueSettings();
  if (settings.allowQueueReassignment === false) {
    throw new Error("Queue reassignment is disabled in System Settings.");
  }

  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required");
  requireRecoveryActor(actor);
  const { existing, counters } = await authorizeVisitAction(patientId, actor, null, {
    denyMessage: "You can only re-queue patients assigned to your doctor."
  });
  if (existing.status === "completed" && existing.consultation_started_at) {
    throw new Error("Completed consultation history must be preserved. Register a new visit instead.");
  }
  // F5: Requeue recovers a finished visit only. An active visit keeps its call, consultation
  // start and counter. Legacy completed visits without a consultation start keep their
  // existing recovery behavior pending a policy decision.
  if (existing.status === "serving") {
    throw consultationError("This patient is being served. Re-queue is only available after the visit is cancelled or marked no-show.", 409);
  }
  if (existing.status === "waiting") {
    throw consultationError("This patient is already waiting. Re-queue is only available for cancelled or no-show visits.", 409);
  }
  if (!REQUEUE_ELIGIBLE_STATUSES.includes(existing.status)) {
    throw consultationError("Only cancelled or no-show visits can be re-queued.", 409);
  }

  // FRD-04 remains unchanged: move to the bottom of the same priority tier.
  const data = await recoverPatientVisit(existing, "requeue", actor, reason, counters);
  clearRecallCount(patientId);
  return data;
}

async function undoPatientAction(patientId, actor) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required");
  requireRecoveryActor(actor);
  const { existing } = await authorizeVisitAction(patientId, actor, null, {
    denyMessage: "You can only undo patients assigned to your doctor."
  });
  if (existing.status === "completed" && existing.consultation_started_at) {
    throw new Error("Completed consultation history must be preserved. Register a new visit instead.");
  }

  if (existing.status !== "completed" && existing.status !== "cancelled" && existing.status !== "no-show") {
    throw new Error("Only completed, cancelled, or no-show patients can be undone");
  }

  // Waiting patients claim their service's doctor only when Call Now succeeds.
  return recoverPatientVisit(existing, "undo", actor);
}

async function clearTodaysQueues(actor = null) {
  // Safe reset: archive active patients (waiting/serving) instead of deleting history.
  const archiveReason = "System queue reset";
  const completedAt = new Date().toISOString();
  const { start, end } = getTodayRange();

  if (useLocalFallback) {
    const archivedPatientIds = [];
    localData.patients = localData.patients.map((patient) => {
      if (["waiting", "serving"].includes(patient.status) && isCreatedInRange(patient, { start, end })) {
        archivedPatientIds.push(patient.id);
        return {
          ...patient,
          status: "cancelled",
          completed_at: completedAt,
          reason: archiveReason
        };
      }
      return patient;
    });
    for (const counter of localData.counters) {
      if (archivedPatientIds.includes(counter.current_patient_id)) counter.current_patient_id = null;
    }
    return { archived: true, archivedPatientIds };
  }
  
  const candidates = await fetchPatientPages(() => supabase.from("patients").select("id, status, visit_state_revision")
    .gte("created_at", start).lt("created_at", end).in("status", ["waiting", "serving"]),
    "Failed to load today's reset candidates");
  const archivedPatientIds = [];
  // With W1 installed each visit is cancelled atomically together with releasing only a counter
  // that still points at it, so a Requeue + Call committed while the reset runs keeps its new
  // counter. A visit that changed since it was read (409) is left as it now is.
  let viaW1 = Boolean(actor);
  for (const candidate of viaW1 ? candidates : []) {
    try {
      const row = await cancelPatientVisitRpc(candidate, actor, archiveReason, null);
      if (!row) { viaW1 = false; break; }
      archivedPatientIds.push(Number(row.id));
    } catch (error) {
      if (error.statusCode !== 409) throw error;
    }
  }
  if (viaW1) return { archived: true, archivedPatientIds };
  // Without W1: the earlier two-step archive and counter release.
  // A mutation response can be capped too. Single-row conditional updates let
  // us identify every row actually archived even when the server cap is one.
  for (const candidate of candidates.filter((row) => !archivedPatientIds.includes(Number(row.id)))) {
    const archive = (withReason) => supabase.from("patients")
      .update({ status: "cancelled", completed_at: completedAt, ...(withReason ? { reason: archiveReason } : {}) })
      .eq("id", candidate.id).gte("created_at", start).lt("created_at", end)
      .in("status", ["waiting", "serving"]).select("id").maybeSingle();
    let { data, error } = await archive(true);
    // Preserve compatibility with databases lacking the existing reason field.
    if (error && /reason/i.test(String(error.message || ""))) ({ data, error } = await archive(false));
    if (error) throw formatError(error, "Failed to clear queues");
    if (data) archivedPatientIds.push(data.id);
  }
  if (archivedPatientIds.length) {
    const { error: counterError } = await supabase.from("counters")
      .update({ current_patient_id: null }).in("current_patient_id", archivedPatientIds);
    if (counterError) throw formatError(counterError, "Failed to clear archived patient counters");
  }
  return { archived: true, archivedPatientIds };
}

async function getPatientsForExport(filters = {}) {
  return getFilteredPatients(filters);
}

async function setCounterOnline(idNum, isOnline) {
  if (useLocalFallback) {
    const counter = localData.counters.find((c) => c.id_num === idNum);
    if (counter) counter.is_online = Boolean(isOnline);
    return counter || null;
  }

  const { data, error } = await supabase
    .from("counters")
    .update({ is_online: Boolean(isOnline) })
    .eq("id_num", idNum)
    .select("*")
    .maybeSingle();

  if (error) {
    throw formatError(error, "Failed to update doctor availability");
  }
  return data;
}

async function findActiveDuplicate({ idNum, mobileNumber }) {
  const patients = await getTodayPatients();
  const name = String(idNum || "").trim().toLowerCase();
  const mobile = String(mobileNumber || "").trim();

  return patients.find((patient) => {
    if (!["waiting", "serving"].includes(patient.status)) return false;
    const sameName = name && String(patient.id_num || "").trim().toLowerCase() === name;
    const sameMobile = mobile && String(patient.mobile_number || "").trim() === mobile;
    return sameName || sameMobile;
  }) || null;
}

function buildCsv(rows) {
  if (!rows.length) {
    return "";
  }

  // Ensure consistent headers, including reason
  const baseHeaders = ["id", "queue_number", "id_num", "service_type", "mobile_number", "residency", "philhealth_id", "birthdate", "sex", "priority_score", "vulnerability_flags", "source", "status", "created_at", "called_at", "consultation_started_at", "completed_at", "service_duration_seconds", "counter_id", "reason"];
  // Use all unique keys from first row as headers, but ensure reason is included
  const headers = Array.from(new Set([...Object.keys(rows[0]), ...baseHeaders]));
  
  const lines = rows.map((row) =>
    headers
      .map((header) => `"${String(row[header] ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );

  return [headers.join(","), ...lines].join("\n");
}

async function getFilteredPatients({ status = "", service = "", doctor = "", ...dateFilters } = {}) {
  const range = getDateFilterRange(dateFilters, new Date());
  let counters = [];
  let selectedDoctor;
  if (doctor) {
    counters = await getCounters();
    selectedDoctor = resolveDoctorCounter(doctor, counters);
    if (!selectedDoctor) throw consultationError("A valid doctor filter is required");
  }
  let patients;
  if (useLocalFallback) {
    patients = localData.patients.filter((patient) => (!range || isCreatedInRange(patient, range)) &&
      (!status || patient.status === status) && (!service || patient.service_type === service));
  } else {
    try {
      patients = await fetchPatientPages(() => {
        let query = supabase.from("patients").select("*");
        if (range?.start) query = query.gte("created_at", range.start);
        if (range?.end) query = query.lt("created_at", range.end);
        if (status) query = query.eq("status", status);
        if (service) query = query.eq("service_type", service);
        return query;
      }, "Failed to load filtered patient records");
    } catch (error) {
      enableLocalFallback(error);
      return getFilteredPatients({ status, service, doctor, ...dateFilters });
    }
  }
  if (selectedDoctor) patients = patients.filter((patient) => {
    // Stored ownership wins for historical visits. Older unassigned rows use
    // the established service mapping (none in shared dispatch); aliases resolve against real counters.
    const assignment = patient.counter_id != null && String(patient.counter_id).trim()
      ? resolveDoctorCounter(patient.counter_id, counters)?.id_num
      : getRoutedDoctor(patient.service_type);
    return assignment === selectedDoctor.id_num;
  });
  return patients.sort(comparePatientCreation).map(parsePatientPriority);
}

async function getTransactions({ page = 1, limit = 20, ...filters } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw consultationError("Page and limit must be positive integers");
  }
  const patients = await getFilteredPatients(filters);
  
  const from = (page - 1) * limit;
  const to = from + limit;
  const data = patients.slice(from, to);
  
  const totalPages = Math.max(1, Math.ceil(patients.length / limit));
  
  return {
    transactions: data,
    pagination: {
      currentPage: page,
      totalPages,
      totalRecords: patients.length,
      recordsPerPage: limit,
      hasNext: page < totalPages,
      hasPrev: page > 1
    },
    stats: {
      completed: patients.filter((row) => row.status === "completed").length,
      cancelled: patients.filter((row) => row.status === "cancelled").length
    }
  };
}

// ---------------------------------------------------------------------------
// Public Queue Display serialization (R1).
// GET /display is unauthenticated, so every object it returns is built
// field-by-field below. Never spread a patient, counter or event row into a
// public object: any column added to the database later (contact number,
// birthdate, residency, PhilHealth, sex, priority/vulnerability data, visit
// revision, consultation timing, free-text reason, ...) must stay private by
// default. `patients.id_num` may hold a patient's name or an identifier, so it
// is never published: the public display and announcements identify a visit by
// `queue_number` only. (`counters.id_num` is the doctor/room label such as
// "Doctor 1" and is not patient data.)
// ---------------------------------------------------------------------------
function toPublicWaitingEntry(patient) {
  return {
    id: patient.id,
    queue_number: patient.queue_number,
    service_type: patient.service_type,
    status: patient.status,
    counter_id: patient.counter_id,
    completed_at: patient.completed_at
  };
}

function toPublicServingEntry(patient, assignedCounter) {
  return {
    id: patient.id,
    queue_number: patient.queue_number,
    service_type: patient.service_type,
    status: patient.status,
    called_at: patient.called_at,
    counter_name: assignedCounter?.id_num || patient.counter_id || "TBA",
    // Keep numeric counter id for display card matching; fall back safely
    counter_id: assignedCounter?.id ?? patient.counter_id
  };
}

function toPublicRecentCalledEntry(patient, assignedCounter) {
  return {
    id: patient.id,
    queue_number: patient.queue_number,
    service_type: patient.service_type,
    status: patient.status,
    called_at: patient.called_at,
    completed_at: patient.completed_at,
    counter_id: patient.counter_id,
    counter_name: assignedCounter?.id_num || patient.counter_id || "TBA"
  };
}

// Doctor/counter cards: the doctor/room label (`id_num`/`name`), availability and
// served services only. The patient currently attached to a counter is
// intentionally omitted; serving patients are published only through
// all_serving, by queue number.
function toPublicCounter(counter) {
  return {
    id: counter.id,
    name: counter.name,
    id_num: counter.id_num,
    service_types: counter.service_types,
    is_online: counter.is_online
  };
}

function toPublicDisplaySettings(settings) {
  return {
    id: settings?.id,
    company_name: settings?.company_name,
    department_name: settings?.department_name,
    welcome_message: settings?.welcome_message,
    refresh_interval: settings?.refresh_interval
  };
}

async function getDisplayData() {
  const [settings, patients, counters] = await Promise.all([
    getDisplaySettings(),
    getTodayPatients(),
    getCounters()
  ]);

  // All patients currently being served (status = "serving")
  const servingPatients = patients
    .filter((patient) => patient.status === "serving" && patient.called_at)
    .sort((a, b) => new Date(b.called_at) - new Date(a.called_at));

  // Map each serving patient to their counter
  const allServing = servingPatients.map((patient) => {
    const assignedCounter =
      counters.find((c) => c.current_patient_id === patient.id) ||
      counters.find((c) => c.id_num === patient.counter_id);
    return toPublicServingEntry(patient, assignedCounter);
  });

  // FRD-02: Weighted-Priority order (priority score DESC, then check-in time ASC; WPS-A aging when enabled)
  const waitingQueue = patients
    .filter((patient) => patient.status === "waiting")
    .sort(compareWaitingPriority(Date.now()));
  const nextInLine = waitingQueue[0] || null;
  const waitingQueueSlice = waitingQueue.slice(0, 10);
  const recentCalled = patients
    .filter((patient) => ["completed", "serving"].includes(patient.status) && patient.called_at)
    .sort((a, b) => new Date(b.called_at) - new Date(a.called_at))
    .slice(0, 6)
    .map((patient) => {
      const assignedCounter =
        counters.find((c) => c.current_patient_id === patient.id) ||
        counters.find((c) => c.id_num === patient.counter_id);
      return toPublicRecentCalledEntry(patient, assignedCounter);
    });

  // Voice announcer source: patients the doctor has accepted, oldest acceptance first
  const recentAccepted = patients
    .map((patient) => ({ patient, acceptedAt: getAcceptedAt(patient.id) }))
    .filter((entry) => entry.acceptedAt)
    .sort((a, b) => new Date(a.acceptedAt) - new Date(b.acceptedAt))
    .slice(-20)
    .map(({ patient, acceptedAt }) => ({
      id: patient.id,
      queue_number: patient.queue_number,
      status: patient.status,
      called_at: patient.called_at,
      accepted_at: acceptedAt,
      counter_name: patient.counter_id || "TBA"
    }));

  const patientById = new Map(patients.map((patient) => [Number(patient.id), patient]));
  const voiceAnnouncements = getVoiceAnnouncementEvents()
    .map((event) => {
      const patient = patientById.get(Number(event.patient_id));
      if (!patient || patient.status !== "serving") return null;
      // Re-queue keeps the patient ID, but a later call is a new announcement
      // cycle. Do not attach a previous Accept/Re-Call to the current visit.
      const calledAt = timestampMicroseconds(patient.called_at);
      const eventCalledAt = timestampMicroseconds(event.called_at);
      const eventAt = timestampMicroseconds(event.event_at);
      if (calledAt == null || eventCalledAt !== calledAt || eventAt == null || eventAt < calledAt) return null;
      return {
        id: patient.id,
        queue_number: patient.queue_number || event.queue_number,
        status: patient.status,
        called_at: patient.called_at || event.called_at,
        accepted_at: event.event_at,
        announcement_at: event.event_at,
        announcement_key: event.event_id,
        event_type: event.event_type,
        counter_name: patient.counter_id || event.counter_name || "TBA"
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.announcement_at) - new Date(b.announcement_at))
    .slice(-20);

  if (voiceAnnouncements.length) {
    console.info("[voice][display-events]", {
      count: voiceAnnouncements.length,
      events: voiceAnnouncements.map((event) => ({
        announcement_key: event.announcement_key,
        event_type: event.event_type,
        queue_number: event.queue_number,
        doctor: event.counter_name,
        announcement_at: event.announcement_at
      }))
    });
  }

  return {
    settings: toPublicDisplaySettings(settings),
    storage_mode: getQueueStorageMode(),
    dispatch_mode: getDispatchMode(),
    queue_settings: getQueueSettings(),
    voice_announcements: voiceAnnouncements,
    recent_accepted: recentAccepted,
    all_serving: allServing,
    serving_count: allServing.length,
    now_serving: allServing[0] || null,
    next_in_line: nextInLine ? toPublicWaitingEntry(nextInLine) : null,
    waiting_count: waitingQueue.length,
    recent_called: recentCalled,
    waiting_queue: waitingQueue.map(toPublicWaitingEntry),
    counters: counters.map(toPublicCounter)
  };
}

function getDateLabel(dateValue) {
  return new Date(dateValue).toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

const ANALYTICS_SERVICE_ORDER = ["consultation", "checkup", "prenatal", "maternity", "family_planning"];
const ANALYTICS_STATUS_ORDER = ["waiting", "serving", "completed", "cancelled", "no-show"];
const ANALYTICS_PRIORITY_ORDER = ["senior", "pwd", "pregnant", "indigenous", "solo_parent", "regular"];
const ANALYTICS_AGE_GROUPS = [
  { label: "0–5", max: 5 },
  { label: "6–17", max: 17 },
  { label: "18–35", max: 35 },
  { label: "36–59", max: 59 },
  { label: "60+", max: Infinity }
];
const ANALYTICS_NOT_RECORDED = "Not recorded";
const ANALYTICS_OTHER_LOCATIONS = "Other locations";
const ANALYTICS_RESIDENCY_LIMIT = 8;
// Longer bounded ranges list only days with visits rather than years of zeros.
const ANALYTICS_MAX_FILLED_DAYS = 366;

function countBy(rows, keyOf) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

// Known categories keep a fixed order (so each keeps its colour); anything else
// follows by size, and "Not recorded" always comes last.
function orderedChart(counts, order = []) {
  const extra = [...counts.keys()]
    .filter((key) => !order.includes(key) && key !== ANALYTICS_NOT_RECORDED)
    .sort((a, b) => counts.get(b) - counts.get(a) || String(a).localeCompare(String(b)));
  const labels = [...order.filter((key) => counts.has(key)), ...extra];
  if (counts.has(ANALYTICS_NOT_RECORDED)) labels.push(ANALYTICS_NOT_RECORDED);
  return { labels, data: labels.map((key) => counts.get(key)) };
}

function normalizeSexLabel(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return ANALYTICS_NOT_RECORDED;
  if (text === "m" || text === "male") return "Male";
  if (text === "f" || text === "female") return "Female";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function getAgeAtVisit(birthdate, visitAt) {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthdate ?? ""));
  if (!birth) return null;
  let visitDate;
  try {
    visitDate = getBusinessDate(visitAt);
  } catch (_error) {
    return null;
  }
  const [visitYear, visitMonth, visitDay] = visitDate.split("-").map(Number);
  const [birthYear, birthMonth, birthDay] = birth.slice(1).map(Number);
  const beforeBirthday = visitMonth < birthMonth || (visitMonth === birthMonth && visitDay < birthDay);
  const age = visitYear - birthYear - (beforeBirthday ? 1 : 0);
  return age >= 0 && age < 130 ? age : null;
}

function getAgeGroupLabel(patient) {
  const age = getAgeAtVisit(patient.birthdate, patient.created_at);
  if (age == null) return ANALYTICS_NOT_RECORDED;
  return ANALYTICS_AGE_GROUPS.find((group) => age <= group.max).label;
}

function buildResidencyChart(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const label = String(row.residency ?? "").trim().replace(/\s+/g, " ");
    const key = label ? label.toLowerCase() : ANALYTICS_NOT_RECORDED;
    const group = groups.get(key) || { label: label || ANALYTICS_NOT_RECORDED, count: 0 };
    group.count += 1;
    groups.set(key, group);
  });
  const missing = groups.get(ANALYTICS_NOT_RECORDED);
  groups.delete(ANALYTICS_NOT_RECORDED);
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const shown = ranked.slice(0, ANALYTICS_RESIDENCY_LIMIT);
  const otherCount = ranked.slice(ANALYTICS_RESIDENCY_LIMIT).reduce((sum, group) => sum + group.count, 0);
  if (otherCount) shown.push({ label: ANALYTICS_OTHER_LOCATIONS, count: otherCount });
  if (missing) shown.push(missing);
  return { labels: shown.map((group) => group.label), data: shown.map((group) => group.count) };
}

// A visit can carry several priority categories, so these counts can exceed
// the number of visits. Visits without a category count as "regular".
function buildPriorityChart(rows) {
  const counts = new Map();
  rows.forEach((row) => {
    const flags = [...new Set((row.vulnerability_flags || []).filter((flag) => ANALYTICS_PRIORITY_ORDER.includes(flag)))];
    (flags.length ? flags : ["regular"]).forEach((flag) => counts.set(flag, (counts.get(flag) || 0) + 1));
  });
  return orderedChart(counts, ANALYTICS_PRIORITY_ORDER);
}

function addBusinessDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

// Patients per Manila calendar day. A bounded range lists every day, including
// days without visits, so gaps are visible; All Time lists only days with visits.
function buildDailyChart(rows, range) {
  const counts = countBy(rows, (row) => getBusinessDate(row.created_at));
  let days = [...counts.keys()].sort();
  if (range?.start && range?.end) {
    const first = getBusinessDate(range.start);
    const last = getBusinessDate(new Date(Date.parse(range.end) - 1));
    const filled = [];
    for (let day = first; day <= last && filled.length <= ANALYTICS_MAX_FILLED_DAYS; day = addBusinessDays(day, 1)) {
      filled.push(day);
    }
    if (filled.length <= ANALYTICS_MAX_FILLED_DAYS) days = filled;
  }
  return {
    labels: days.map((day) => getDateLabel(`${day}T12:00:00+08:00`)),
    data: days.map((day) => counts.get(day) || 0)
  };
}

// Arrivals by Manila hour, in clock order, with empty hours between the first
// and last busy hour shown as zero.
function buildHourlyChart(rows) {
  const hourOf = (row) => Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", hour: "2-digit", hourCycle: "h23"
  }).format(new Date(row.created_at)));
  const counts = countBy(rows, hourOf);
  if (!counts.size) return { labels: [], data: [] };
  const hours = [...counts.keys()];
  const labels = [];
  const data = [];
  for (let hour = Math.min(...hours); hour <= Math.max(...hours); hour += 1) {
    labels.push(`${String(hour).padStart(2, "0")}:00`);
    data.push(counts.get(hour) || 0);
  }
  return { labels, data };
}

function getWaitMinutes(row) {
  const endedWaiting = row.called_at || row.completed_at;
  return endedWaiting ? Math.round((new Date(endedWaiting) - new Date(row.created_at)) / 60000) : null;
}

function averageText(values) {
  return values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1) : "0.0";
}

function summarizeVisits(rows) {
  const count = (status) => rows.filter((row) => row.status === status).length;
  const completed = count("completed");
  const waitDurations = rows.map(getWaitMinutes).filter((minutes) => minutes != null);
  const serviceDurations = rows.map(getServiceDurationSeconds)
    .filter((duration) => duration != null)
    .map((duration) => duration / 60);
  return {
    total_patients: rows.length,
    completed,
    cancelled: count("cancelled"),
    no_show: count("no-show"),
    waiting: count("waiting"),
    serving: count("serving"),
    avg_wait_time: averageText(waitDurations),
    avg_service_time: averageText(serviceDurations),
    completion_rate: rows.length ? ((completed * 100) / rows.length).toFixed(1) : "0.0"
  };
}

// Visits stamp the doctor's name in counter_id; older rows may hold a counter
// id instead. Only then are counters read, and without enabling local fallback.
async function loadCounterAliases(rows) {
  const needsLookup = rows.some((row) => {
    const raw = row.counter_id == null ? "" : String(row.counter_id).trim();
    return raw && !/^doctor\s*\d+$/i.test(raw);
  });
  if (!needsLookup) return [];
  if (useLocalFallback) return localData.counters;
  try {
    const { data, error } = await supabase.from("counters").select("id, id_num");
    return error ? [] : data || [];
  } catch (_error) {
    return [];
  }
}

// The treating doctor stored on the visit. Without one, the service's routed doctor, or
// "Unassigned" in shared dispatch (the visit was never called by any doctor).
function getVisitDoctor(row, counterAliases) {
  const raw = row.counter_id == null ? "" : String(row.counter_id).trim();
  if (!raw) return getRoutedDoctor(row.service_type) || UNASSIGNED_DOCTOR;
  const named = raw.match(/^doctor\s*(\d+)$/i);
  if (named) return `Doctor ${Number(named[1])}`;
  return resolveDoctorCounter(raw, counterAliases)?.id_num || raw;
}

async function getAnalytics(startDate, endDate, filters = {}) {
  const selection = { ...filters, startDate, endDate };
  const rows = await getFilteredPatients(selection);
  const range = getDateFilterRange(selection, new Date());

  let totalWaitMinutes = 0;
  let totalServiceMinutes = 0;
  let waitSamples = 0;
  let serviceSamples = 0;
  rows.forEach((row) => {
    const waitMinutes = getWaitMinutes(row);
    if (waitMinutes != null) {
      totalWaitMinutes += waitMinutes;
      waitSamples += 1;
    }
    const serviceDuration = getServiceDurationSeconds(row);
    if (serviceDuration != null) {
      totalServiceMinutes += serviceDuration / 60;
      serviceSamples += 1;
    }
  });

  const groupRows = (keyOf) => rows.reduce((groups, row) => {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) || []), row]);
    return groups;
  }, new Map());

  const tableData = Array.from(groupRows((row) => row.service_type).entries())
    .map(([serviceType, serviceRows]) => ({ service_type: serviceType, ...summarizeVisits(serviceRows) }))
    .sort((a, b) => b.total_patients - a.total_patients);

  const counterAliases = await loadCounterAliases(rows);
  const doctorTable = Array.from(groupRows((row) => getVisitDoctor(row, counterAliases)).entries())
    .map(([doctor, doctorRows]) => ({ doctor, ...summarizeVisits(doctorRows) }))
    .sort((a, b) => a.doctor.localeCompare(b.doctor, undefined, { numeric: true }));

  const completionCount = rows.filter((row) => row.status === "completed").length;
  return {
    metrics: {
      totalPatients: rows.length,
      avgWaitTime: waitSamples ? Number((totalWaitMinutes / waitSamples).toFixed(1)) : 0,
      avgServiceTime: serviceSamples ? Number((totalServiceMinutes / serviceSamples).toFixed(1)) : 0,
      completionRate: rows.length ? Number(((completionCount * 100) / rows.length).toFixed(1)) : 0
    },
    charts: {
      serviceTypes: orderedChart(countBy(rows, (row) => row.service_type), ANALYTICS_SERVICE_ORDER),
      sexDistribution: orderedChart(countBy(rows, (row) => normalizeSexLabel(row.sex)), ["Male", "Female"]),
      dailyTrends: buildDailyChart(rows, range),
      hourly: buildHourlyChart(rows),
      status: orderedChart(countBy(rows, (row) => row.status), ANALYTICS_STATUS_ORDER),
      priorityCategories: buildPriorityChart(rows),
      ageGroups: orderedChart(countBy(rows, getAgeGroupLabel), ANALYTICS_AGE_GROUPS.map((group) => group.label)),
      residency: buildResidencyChart(rows)
    },
    tableData,
    totals: summarizeVisits(rows),
    doctorTable
  };
}

async function seedCounters() {
  if (useLocalFallback) {
    return { created: 0 };
  }
  
  const desiredCounters = [
    { name: "Doctor 1", services: ["consultation", "checkup"] },
    { name: "Doctor 2", services: ["prenatal", "maternity"] },
    { name: "Doctor 3", services: ["family_planning"] }
  ];

  const payload = desiredCounters.map((config) => ({
    id_num: config.name,
    service_types: config.services,
    is_online: true
  }));
  // Startup must preserve persisted doctor IDs, availability and active patient
  // pointers. ON CONFLICT DO NOTHING also makes concurrent startups harmless.
  const { data, error } = await supabase.from("counters")
    .upsert(payload, { onConflict: "id_num", ignoreDuplicates: true })
    .select("id");
  if (error) {
    throw formatError(error, "Failed to seed missing counters");
  }
  return { created: (data || []).length };
}

async function renameServiceType(oldValue, newValue) {
  // Not needed for local fallback
  if (useLocalFallback) {
    return;
  }
  
  const { error } = await supabase
    .from("patients")
    .update({ service_type: newValue })
    .eq("service_type", oldValue);

  if (error) {
    throw formatError(error, "Failed to update patient service types");
  }

  const counters = await getCounters();

  for (const counter of counters) {
    if ((counter.service_types || []).includes(oldValue)) {
      const nextTypes = counter.service_types.map((type) => (type === oldValue ? newValue : type));
      const { error: updateError } = await supabase
        .from("counters")
        .update({ service_types: nextTypes })
        .eq("id", counter.id);

      if (updateError) {
        throw formatError(updateError, "Failed to update counter service types");
      }
    }
  }
}

// Only the account's own password matches: there is no shared fallback password. Seeded
// accounts may still store plaintext (legacy); those compare in constant time until they are
// re-hashed (see docs). New and changed passwords are always stored as bcrypt hashes.
async function passwordMatches(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string" || !stored) return false;
  if (/^\$2[aby]\$/.test(stored)) return bcrypt.compare(password, stored);
  const given = createHash("sha256").update(password).digest();
  const expected = createHash("sha256").update(stored).digest();
  return timingSafeEqual(given, expected);
}

async function loginUser(id_num, password) {
  console.log("Login attempt for id_num:", id_num);
  
  if (useLocalFallback) {
    const user = localData.users.find(u => u.id_num === id_num);
    if (!user) {
      throw new Error("Invalid username or password");
    }
    
    if (!(await passwordMatches(password, user.password))) {
      throw new Error("Invalid username or password");
    }
    
    console.log("Password match (local)");
    return {
      id_num: user.id_num,
      role: user.role,
      doctor_name: user.doctor_name
    };
  }
  
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id_num", id_num)
      .maybeSingle();

    if (error) {
      enableLocalFallback(error);
      return loginUser(id_num, password);
    }
    
    if (!data) {
      console.log("User not found for id_num:", id_num);
      // Check if it's the frontdesk user, if not found, add it locally
      if (id_num === "frontdesk" && !supabaseConfigured) {
        console.log("Adding frontdesk user to local fallback");
        enableLocalFallback();
        return loginUser(id_num, password);
      }
      throw new Error("Invalid username or password");
    }

    console.log("User data retrieved from DB (excluding password):", { id_num: data.id_num, role: data.role, doctor_name: data.doctor_name });

    const isMatch = await passwordMatches(password, data.password);

    console.log("Password comparison result (isMatch):", isMatch);

    if (!isMatch) {
      throw new Error("Invalid username or password");
    }

    return {
      id_num: data.id_num,
      role: data.role,
      doctor_name: data.doctor_name,
      // Private login snapshot, checked under the session RPC's account lock.
      // Never included in the returned browser profile or signed JWT.
      auth_revision: data.auth_revision
    };
  } catch (err) {
    if (err.message?.includes("Supabase") || err.message?.includes("fetch failed")) {
      enableLocalFallback(err);
      return loginUser(id_num, password);
    }
    throw err;
  }
}

async function getUsers() {
  if (useLocalFallback) {
    return localData.users.map(u => ({
      id_num: u.id_num,
      role: u.role,
      doctor_name: u.doctor_name
    }));
  }

  // users has no creation timestamp on the installed schema; never select or invent one.
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id_num, role, doctor_name")
      .order("id_num", { ascending: true });

    if (error) {
      enableLocalFallback(error);
      return getUsers();
    }

    return data || [];
  } catch (err) {
    enableLocalFallback(err);
    return getUsers();
  }
}

const STAFF_ROLES = ["admin", "superadmin"];
const MIN_PASSWORD_LENGTH = 8;

function accountError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateAccountInput({ id_num, password, role }, { creating }) {
  if (creating && (typeof id_num !== "string" || !id_num.trim() || id_num.length > 100)) {
    throw accountError("A user ID of up to 100 characters is required.");
  }
  if ((creating || role !== undefined) && !STAFF_ROLES.includes(role)) {
    throw accountError("Role must be Doctor/Frontdesk (admin) or Superadmin.");
  }
  if ((creating || password) && (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)) {
    throw accountError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// Never leave the clinic without a Superadmin: the last one cannot be deleted or demoted.
async function assertNotLastSuperadmin(id_num) {
  const users = useLocalFallback ? localData.users : await (async () => {
    const { data, error } = await supabase.from("users").select("id_num, role").eq("role", "superadmin");
    if (error) throw formatError(error, "Failed to check Superadmin accounts");
    return data || [];
  })();
  const superadmins = users.filter((user) => user.role === "superadmin");
  if (superadmins.length <= 1 && superadmins.some((user) => user.id_num === id_num)) {
    throw accountError("This is the last Superadmin account. Create another Superadmin before removing or demoting it.");
  }
}

async function createUser({ id_num, password, role, doctor_name }) {
  validateAccountInput({ id_num, password, role }, { creating: true });
  if (useLocalFallback) {
    const existing = localData.users.find(u => u.id_num === id_num);
    if (existing) {
      throw new Error("User ID already exists");
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = { id_num, password: hashedPassword, role, doctor_name };
    localData.users.push(user);
    return { id_num, role, doctor_name };
  }
  
  // Check if user already exists
  const { data: existing } = await supabase
    .from("users")
    .select("id_num")
    .eq("id_num", id_num)
    .maybeSingle();

  if (existing) {
    throw new Error("User ID already exists");
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  
  const { data, error } = await supabase
    .from("users")
    .insert({
      id_num,
      password: hashedPassword,
      role,
      doctor_name
    })
    .select("id_num, role, doctor_name")
    .single();

  if (error) {
    throw formatError(error, "Failed to create user");
  }

  return data;
}

async function updateUser(id_num, { password, role, doctor_name }) {
  validateAccountInput({ password, role }, { creating: false });
  if (role !== undefined && role !== "superadmin") await assertNotLastSuperadmin(id_num);
  if (useLocalFallback) {
    const userIndex = localData.users.findIndex(u => u.id_num === id_num);
    if (userIndex === -1) {
      throw new Error("User not found");
    }
    if (password) {
      localData.users[userIndex].password = await bcrypt.hash(password, 10);
    }
    if (role) {
      localData.users[userIndex].role = role;
    }
    if (doctor_name !== undefined) {
      localData.users[userIndex].doctor_name = doctor_name;
    }
    return { id_num, role: localData.users[userIndex].role, doctor_name: localData.users[userIndex].doctor_name };
  }
  
  const updates = { role, doctor_name };
  if (password) {
    updates.password = await bcrypt.hash(password, 10);
  }

  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("id_num", id_num)
    .select("id_num, role, doctor_name")
    .single();

  if (error) {
    throw formatError(error, "Failed to update user");
  }

  return data;
}

async function deleteUser(id_num, actor = null) {
  if (actor?.id_num != null && actor.id_num === id_num) {
    throw accountError("You cannot delete your own account while signed in with it.");
  }
  await assertNotLastSuperadmin(id_num);
  if (useLocalFallback) {
    const index = localData.users.findIndex(u => u.id_num === id_num);
    if (index !== -1) {
      localData.users.splice(index, 1);
    }
    return { success: true };
  }
  
  const { error } = await supabase
    .from("users")
    .delete()
    .eq("id_num", id_num);

  if (error) {
    throw formatError(error, "Failed to delete user");
  }

  return { success: true };
}

function mapCancellationRequest(row) {
  return {
    id: row.id,
    doctor_id_num: row.doctor_id_num,
    doctor_name: row.doctor_name,
    doctor_role: row.doctor_role,
    reason: row.reason,
    status: row.status,
    requested_at: row.requested_at,
    processed_at: row.processed_at || null,
    processed_by: row.processed_by || null,
    admin_notes: row.admin_notes || null
  };
}

async function createAccountCancellationRequest({ doctor_id_num, doctor_name, doctor_role, reason }) {
  const trimmedReason = String(reason || "").trim();
  if (!trimmedReason) {
    throw new Error("Reason for cancel is required");
  }
  if (!doctor_id_num) {
    throw new Error("Doctor identity is required");
  }

  if (useLocalFallback) {
    const existingPending = localData.cancellationRequests.find(
      (r) => r.doctor_id_num === doctor_id_num && r.status === "pending"
    );
    if (existingPending) {
      throw new Error("You already have a pending cancellation request");
    }

    const requestRow = {
      id: localData.nextCancellationId++,
      doctor_id_num,
      doctor_name: doctor_name || null,
      doctor_role: doctor_role || "admin",
      reason: trimmedReason,
      status: "pending",
      requested_at: new Date().toISOString(),
      processed_at: null,
      processed_by: null,
      admin_notes: null
    };
    localData.cancellationRequests.unshift(requestRow);
    return mapCancellationRequest(requestRow);
  }

  const { data: existingPending, error: pendingError } = await supabase
    .from("account_cancellation_requests")
    .select("id")
    .eq("doctor_id_num", doctor_id_num)
    .eq("status", "pending")
    .maybeSingle();

  if (pendingError) {
    if (isMissingCancellationTableError(pendingError)) {
      throw new Error(
        "Cancellation requests table is missing. Run backend/scripts/add-account-cancellation-requests.sql in Supabase."
      );
    }
    throw formatError(pendingError, "Failed to check existing cancellation requests");
  }

  if (existingPending) {
    throw new Error("You already have a pending cancellation request");
  }

  const { data, error } = await supabase
    .from("account_cancellation_requests")
    .insert({
      doctor_id_num,
      doctor_name: doctor_name || null,
      doctor_role: doctor_role || "admin",
      reason: trimmedReason,
      status: "pending"
    })
    .select("*")
    .single();

  if (error) {
    if (isMissingCancellationTableError(error)) {
      throw new Error(
        "Cancellation requests table is missing. Run backend/scripts/add-account-cancellation-requests.sql in Supabase."
      );
    }
    throw formatError(error, "Failed to create cancellation request");
  }

  return mapCancellationRequest(data);
}

async function getAccountCancellationRequests({ status } = {}) {
  if (useLocalFallback) {
    let rows = [...localData.cancellationRequests];
    if (status) {
      rows = rows.filter((r) => r.status === status);
    }
    return rows.map(mapCancellationRequest);
  }

  let query = supabase
    .from("account_cancellation_requests")
    .select("*")
    .order("requested_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingCancellationTableError(error)) {
      throw new Error(
        "Cancellation requests table is missing. Run backend/scripts/add-account-cancellation-requests.sql in Supabase."
      );
    }
    throw formatError(error, "Failed to fetch cancellation requests");
  }

  return (data || []).map(mapCancellationRequest);
}

async function getMyAccountCancellationRequest(doctor_id_num) {
  if (useLocalFallback) {
    const row = localData.cancellationRequests.find(
      (r) => r.doctor_id_num === doctor_id_num && r.status === "pending"
    );
    return row ? mapCancellationRequest(row) : null;
  }

  const { data, error } = await supabase
    .from("account_cancellation_requests")
    .select("*")
    .eq("doctor_id_num", doctor_id_num)
    .eq("status", "pending")
    .maybeSingle();

  if (error) {
    if (isMissingCancellationTableError(error)) {
      throw new Error(
        "Cancellation requests table is missing. Run backend/scripts/add-account-cancellation-requests.sql in Supabase."
      );
    }
    throw formatError(error, "Failed to fetch your cancellation request");
  }

  return data ? mapCancellationRequest(data) : null;
}

async function processAccountCancellationRequest(id, { action, processed_by, admin_notes }) {
  const normalizedAction = String(action || "").toLowerCase();
  if (!["approve", "reject"].includes(normalizedAction)) {
    throw new Error("Action must be approve or reject");
  }

  const newStatus = normalizedAction === "approve" ? "approved" : "rejected";
  const processedAt = new Date().toISOString();

  if (useLocalFallback) {
    const requestIndex = localData.cancellationRequests.findIndex((r) => Number(r.id) === Number(id));
    if (requestIndex === -1) {
      throw new Error("Cancellation request not found");
    }

    const existing = localData.cancellationRequests[requestIndex];
    if (existing.status !== "pending") {
      throw new Error("Only pending cancellation requests can be processed");
    }

    existing.status = newStatus;
    existing.processed_at = processedAt;
    existing.processed_by = processed_by || null;
    existing.admin_notes = admin_notes || null;

    if (normalizedAction === "approve") {
      await deleteUser(existing.doctor_id_num);
    }

    return mapCancellationRequest(existing);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("account_cancellation_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    throw formatError(fetchError, "Failed to load cancellation request");
  }
  if (!existing) {
    throw new Error("Cancellation request not found");
  }
  if (existing.status !== "pending") {
    throw new Error("Only pending cancellation requests can be processed");
  }

  const { data, error } = await supabase
    .from("account_cancellation_requests")
    .update({
      status: newStatus,
      processed_at: processedAt,
      processed_by: processed_by || null,
      admin_notes: admin_notes || null
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw formatError(error, "Failed to process cancellation request");
  }

  if (normalizedAction === "approve") {
    await deleteUser(existing.doctor_id_num);
  }

  return mapCancellationRequest(data);
}

module.exports = {
  buildCsv,
  callPatient,
  cancelPatient,
  cancelHistoricalWaitingVisit,
  getHistoricalBacklog,
  getHistoricalBacklogVisit,
  authorizeVisitAction,
  clearTodaysQueues,
  completePatient,
  startConsultation,
  getServingPatientForDoctor,
  createQueueEntry,
  findActiveDuplicate,
  getAnalytics,
  getDashboardStats,
  getCounters,
  getDisplayData,
  getDisplaySettings,
  getPatientById,
  getPatientsForExport,
  getQueueOverview,
  getQueueStorageMode,
  getDispatchMode,
  getSharedQueueHead,
  getQueueStats,
  getTransactions,
  renameServiceType,
  seedCounters,
  setCounterOnline,
  noShowPatient,
  recallPatient,
  requeuePatient,
  undoPatientAction,
  loginUser,
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  createAccountCancellationRequest,
  getAccountCancellationRequests,
  getMyAccountCancellationRequest,
  processAccountCancellationRequest
};
