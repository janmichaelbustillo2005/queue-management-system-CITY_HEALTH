const supabase = require("../lib/supabase");
const env = require("../config/env");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { getBusinessDate, getBusinessDayRange, getDateFilterRange } = require("../lib/businessDay");
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
  sequenceMap: {
    "Doctor 1": 0,
    "Doctor 2": 0,
    "Doctor 3": 0
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

  return {
    storage_mode: getQueueStorageMode(),
    patients: patients.map((p) => ({
      ...p,
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

function getDoctorOfflineMessage(doctorName) {
  return `${doctorName} is currently offline and unavailable. Please select another available doctor.`;
}

async function ensureDoctorAvailableForService(serviceType) {
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
  const doctorName = getDoctorForService(serviceType);
  
  if (useLocalFallback) {
    // Keep local sequence at least one past any already-used number in memory
    const existing = localData.patients
      .map((p) => String(p.queue_number || ""))
      .filter((qNum) => qNum.startsWith(`${doctorCode}-`) && qNum.split("-").length === 2)
      .map((qNum) => Number(qNum.split("-")[1]) || 0);
    const maxExisting = existing.length ? Math.max(...existing) : 0;
    const base = Math.max(localData.sequenceMap[doctorName] || 0, maxExisting);
    const next = base + 1 + offset;
    if (offset === 0) {
      localData.sequenceMap[doctorName] = next;
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

async function createQueueEntry({ idNum, serviceType, mobileNumber, residency, philhealthId, birthdate, sex, source = "admin", vulnerabilityFlags = [] }) {
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

// Reject overlapping calls in this process; conditional database writes also
// protect the doctor slot and patient when requests come from another process.
const callsInProgress = new Set();

function compareWaitingPriority(a, b) {
  return (b.priority_score || 0) - (a.priority_score || 0) ||
    new Date(a.created_at) - new Date(b.created_at) ||
    Number(a.id) - Number(b.id);
}

async function callPatient(patientId, counterId = null) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new Error("A valid patient ID is required");
  }

  // Never silently switch to development data during a queue mutation.
  const localCall = useLocalFallback;
  let patient;
  if (localCall) {
    patient = localData.patients.find((p) => p.id === patientId);
  } else {
    const { data, error } = await supabase.from("patients").select("*").eq("id", patientId).maybeSingle();
    if (error) throw formatError(error, "Failed to load patient for calling");
    patient = data;
  }
  if (!patient) throw new Error("Patient not found");
  if (patient.status !== "waiting" || patient.completed_at != null) {
    throw new Error("Only a waiting patient without a completion timestamp can be called");
  }
  const doctorName = getDoctorForService(patient.service_type);
  // Undo can retain the patient's previous doctor association while waiting.
  if (patient.counter_id != null && patient.counter_id !== doctorName) {
    throw new Error("This waiting patient has a conflicting doctor assignment");
  }
  if (counterId != null && counterId !== doctorName) {
    throw new Error(`This patient is assigned to ${doctorName}`);
  }
  if (callsInProgress.has(doctorName)) {
    throw new Error(`A call for ${doctorName} is already processing`);
  }
  callsInProgress.add(doctorName);

  try {
    let counters;
    let waitingPatients;
    let servingPatients;
    if (localCall) {
      counters = localData.counters;
      waitingPatients = localData.patients.filter((p) => p.status === "waiting" && isCreatedInRange(p, getTodayRange()));
      servingPatients = localData.patients.filter((p) => p.status === "serving" &&
        (p.counter_id === doctorName || (p.counter_id == null && getDoctorForService(p.service_type) === doctorName)));
    } else {
      const { start, end } = getTodayRange();
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
    const nextPatient = waitingPatients
      .filter((p) => getDoctorForService(p.service_type) === doctorName)
      .sort(compareWaitingPriority)[0];
    if (!nextPatient || Number(nextPatient.id) !== patientId) {
      throw new Error(`Call the next eligible patient for ${doctorName} according to queue priority`);
    }

    const calledAt = new Date().toISOString();
    if (localCall) {
      // No await between the final checks and both in-memory updates.
      patient.status = "serving";
      patient.counter_id = doctorName;
      patient.called_at = calledAt;
      counter.current_patient_id = patientId;
    } else {
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
    return { success: true };
  } finally {
    callsInProgress.delete(doctorName);
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

async function cancelPatient(patientId, reason = null, counterId = null) {
  const existing = await getPatientById(patientId);

  if (!existing) {
    throw new Error("Patient not found");
  }
  if (existing.status === "completed") throw new Error("A completed consultation cannot be cancelled");

  const trimmedReason = reason == null ? null : String(reason).trim() || null;
  const assignedDoctor = counterId || existing.counter_id || null;
  const completedAt = new Date().toISOString();

  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex(p => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].status = "cancelled";
      localData.patients[patientIndex].completed_at = completedAt;
      localData.patients[patientIndex].reason = trimmedReason;
      if (assignedDoctor) {
        localData.patients[patientIndex].counter_id = assignedDoctor;
      }
    }
    await clearCounterAssignment(patientId);
    return localData.patients[patientIndex];
  }
  
  const updatePayload = {
    status: "cancelled",
    completed_at: completedAt,
    reason: trimmedReason
  };
  if (assignedDoctor) {
    updatePayload.counter_id = assignedDoctor;
  }

  let { data, error } = await supabase
    .from("patients")
    .update(updatePayload)
    .eq("id", patientId)
    .eq("status", existing.status)
    .select("*")
    .single();

  // Fallback when patients.reason column has not been migrated yet
  if (error && /reason/i.test(String(error.message || ""))) {
    const fallbackPayload = {
      status: "cancelled",
      completed_at: completedAt,
      vulnerability_flags: withCancelMeta(existing.vulnerability_flags, trimmedReason, assignedDoctor)
    };
    if (assignedDoctor) {
      fallbackPayload.counter_id = assignedDoctor;
    }

    ({ data, error } = await supabase
      .from("patients")
      .update(fallbackPayload)
      .eq("id", patientId)
      .eq("status", existing.status)
      .select("*")
      .single());
  }

  if (error) {
    throw formatError(error, "Failed to cancel patient");
  }

  await clearCounterAssignment(patientId);
  clearRecallCount(patientId);
  return parsePatientPriority(data);
}

async function noShowPatient(patientId, reason = null) {
  const existing = await getPatientById(patientId);

  if (!existing) {
    throw new Error("Patient not found");
  }
  if (existing.status === "completed") {
    throw new Error("A completed consultation cannot be marked as no-show");
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

  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex(p => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].status = "no-show";
      localData.patients[patientIndex].completed_at = new Date().toISOString();
      localData.patients[patientIndex].reason = reason;
    }
    await clearCounterAssignment(patientId);
    clearRecallCount(patientId);
    return localData.patients[patientIndex];
  }
  
  const { data, error } = await supabase
    .from("patients")
    .update({ status: "no-show", completed_at: new Date().toISOString(), reason })
    .eq("id", patientId)
    .eq("status", existing.status)
    .select("*")
    .single();

  if (error || !data) {
    throw formatError(error, "Failed to mark patient as no-show");
  }

  await clearCounterAssignment(patientId);
  clearRecallCount(patientId);
  return data;
}

async function recallPatient(patientId, counterId = null) {
  const patient = await getPatientById(patientId);
  if (!patient) {
    throw new Error("Patient not found");
  }
  if (patient.status !== "serving") {
    throw new Error("Only a serving patient can be recalled");
  }
  if (patient.consultation_started_at || getAcceptedAt(patientId)) {
    throw new Error("Use Re-Call for an accepted patient; the original call time must be preserved.");
  }

  const settings = getQueueSettings();
  const maxRecalls = Number(settings.recallAttempts);
  const used = getRecallCount(patientId);
  if (Number.isFinite(maxRecalls) && used >= maxRecalls) {
    throw new Error(`Recall limit reached (${maxRecalls}). Mark as no-show or cancel the patient.`);
  }

  const doctor = counterId || patient.counter_id;
  if (doctor) {
    const counters = await getCounters();
    const counter = counters.find((c) => c.id_num === doctor);
    if (counter && counter.is_online === false) {
      throw new Error(`${doctor} is marked offline in System Settings.`);
    }
  }

  // Acceptance can arrive while the availability query above is pending.
  if (patient.consultation_started_at || getAcceptedAt(patientId)) {
    throw new Error("Use Re-Call for an accepted patient; the original call time must be preserved.");
  }
  const calledAt = new Date().toISOString();

  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex((p) => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].called_at = calledAt;
      localData.patients[patientIndex].status = "serving";
      if (doctor) localData.patients[patientIndex].counter_id = doctor;
    }
    return { success: true, recall_count: incrementRecallCount(patientId), max_recalls: maxRecalls };
  }

  const { data, error } = await supabase
    .from("patients")
    .update({ called_at: calledAt, status: "serving", counter_id: doctor || patient.counter_id })
    .eq("id", patientId)
    .eq("status", "serving")
    .is("consultation_started_at", null)
    .select("id")
    .single();

  if (error || !data) {
    throw formatError(error, "Failed to recall patient");
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

async function recoverPatientVisit(existing, action, actor, reason = null) {
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
      patient.called_at = null;
      patient.counter_id = null;
      patient.reason = reason;
    } else {
      patient.called_at = null;
      patient.counter_id = null;
      for (const counter of localData.counters) {
        if (counter.current_patient_id === patient.id) counter.current_patient_id = null;
      }
    }
    // Waiting patients reserve their service's doctor through the normal Call.
    return parsePatientPriority(patient);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing.visit_state_revision || "")) {
    throw consultationError("Phase 2.1 database migration is required before Requeue or Undo.", 503);
  }
  let result;
  try {
    // Versioned Undo entry point fails before writes on a Phase 2.1-only DB.
    // The older same-shaped recovery RPC cannot attest to clean waiting ownership.
    result = await supabase.rpc(action === "undo" ? "undo_patient_visit_waiting" : "recover_patient_visit", {
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
    });
  } catch (_error) {
    throw consultationError("Patient recovery storage is unavailable. Please retry.", 503);
  }
  if (result?.error) {
    const error = result.error;
    if (["PGRST202", "PGRST204", "42883", "42703"].includes(error.code)) {
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
      (action === "undo" && (patient.called_at != null || patient.counter_id != null))) {
    throw consultationError("Could not confirm recovery. Refresh the queue before retrying.", 503);
  }
  return parsePatientPriority(patient);
}

async function requeuePatient(patientId, reason = null, actor) {
  const settings = getQueueSettings();
  if (settings.allowQueueReassignment === false) {
    throw new Error("Queue reassignment is disabled in System Settings.");
  }

  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required");
  const found = await getPatientById(patientId);
  const existing = found && { ...found };

  if (!existing) {
    throw new Error("Patient not found");
  }
  if (existing.status === "completed" && existing.consultation_started_at) {
    throw new Error("Completed consultation history must be preserved. Register a new visit instead.");
  }

  // FRD-04 remains unchanged: move to the bottom of the same priority tier.
  const data = await recoverPatientVisit(existing, "requeue", actor, reason);
  clearRecallCount(patientId);
  return data;
}

async function undoPatientAction(patientId, actor) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw consultationError("A valid patient ID is required");
  const found = await getPatientById(patientId);
  const existing = found && { ...found };

  if (!existing) {
    throw new Error("Patient not found");
  }
  if (existing.status === "completed" && existing.consultation_started_at) {
    throw new Error("Completed consultation history must be preserved. Register a new visit instead.");
  }

  if (existing.status !== "completed" && existing.status !== "cancelled" && existing.status !== "no-show") {
    throw new Error("Only completed, cancelled, or no-show patients can be undone");
  }

  // Waiting patients claim their service's doctor only when Call Now succeeds.
  return recoverPatientVisit(existing, "undo", actor);
}

async function clearTodaysQueues() {
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
  
  const candidates = await fetchPatientPages(() => supabase.from("patients").select("id")
    .gte("created_at", start).lt("created_at", end).in("status", ["waiting", "serving"]),
    "Failed to load today's reset candidates");
  const archivedPatientIds = [];
  // A mutation response can be capped too. Single-row conditional updates let
  // us identify every row actually archived even when the server cap is one.
  for (const candidate of candidates) {
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
    // the established service mapping; aliases resolve against real counters.
    const assignment = patient.counter_id != null && String(patient.counter_id).trim()
      ? resolveDoctorCounter(patient.counter_id, counters)?.id_num
      : getDoctorForService(patient.service_type);
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
    return {
      ...patient,
      counter_name: assignedCounter?.id_num || patient.counter_id || "TBA",
      // Keep numeric counter id for display card matching; fall back safely
      counter_id: assignedCounter?.id ?? patient.counter_id
    };
  });

  const waitingQueue = patients
    .filter((patient) => patient.status === "waiting")
    .sort((a, b) => {
      // FRD-02: Sort by priority score DESC, then by check-in time ASC
      if ((b.priority_score || 0) !== (a.priority_score || 0)) {
        return (b.priority_score || 0) - (a.priority_score || 0);
      }
      return new Date(a.created_at) - new Date(b.created_at);
    });
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
      return {
        ...patient,
        counter_name: assignedCounter?.id_num || patient.counter_id || "TBA"
      };
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
      id_num: patient.id_num,
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
        id_num: patient.id_num || event.id_num,
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
        patient_name: event.id_num,
        doctor: event.counter_name,
        announcement_at: event.announcement_at
      }))
    });
  }

  return {
    settings: settings,
    storage_mode: getQueueStorageMode(),
    queue_settings: getQueueSettings(),
    voice_announcements: voiceAnnouncements,
    recent_accepted: recentAccepted,
    all_serving: allServing,
    serving_count: allServing.length,
    now_serving: allServing[0] || null,
    next_in_line: nextInLine,
    waiting_count: waitingQueue.length,
    recent_called: recentCalled,
    waiting_queue: waitingQueue,
    counters: counters
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

async function getAnalytics(startDate, endDate, filters = {}) {
  const rows = await getFilteredPatients({ ...filters, startDate, endDate });
  const serviceGroups = new Map();
  const dayGroups = new Map();
  const hourGroups = new Map();
  const statusGroups = new Map();

  let totalWaitMinutes = 0;
  let totalServiceMinutes = 0;
  let waitSamples = 0;
  let serviceSamples = 0;

  rows.forEach((row) => {
    serviceGroups.set(row.service_type, (serviceGroups.get(row.service_type) || 0) + 1);
    statusGroups.set(row.status, (statusGroups.get(row.status) || 0) + 1);

    const createdAt = new Date(row.created_at);
    const dayLabel = getDateLabel(createdAt);
    dayGroups.set(dayLabel, (dayGroups.get(dayLabel) || 0) + 1);

    const hourLabel = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "2-digit", hourCycle: "h23" }).format(createdAt) + ":00";
    hourGroups.set(hourLabel, (hourGroups.get(hourLabel) || 0) + 1);

    if (row.called_at) {
      totalWaitMinutes += Math.round((new Date(row.called_at) - createdAt) / 60000);
      waitSamples += 1;
    } else if (row.completed_at) {
      totalWaitMinutes += Math.round((new Date(row.completed_at) - createdAt) / 60000);
      waitSamples += 1;
    }

    const serviceDuration = getServiceDurationSeconds(row);
    if (serviceDuration != null) {
      totalServiceMinutes += serviceDuration / 60;
      serviceSamples += 1;
    }
  });

  const completionCount = rows.filter((row) => row.status === "completed").length;
  const tableData = Array.from(serviceGroups.entries())
    .map(([serviceType, total]) => {
      const serviceRows = rows.filter((row) => row.service_type === serviceType);
      const completed = serviceRows.filter((row) => row.status === "completed").length;
      const cancelled = serviceRows.filter((row) => row.status === "cancelled").length;

      const waitDurations = serviceRows
        .filter((row) => row.called_at || row.completed_at)
        .map((row) => Math.round((new Date(row.called_at || row.completed_at) - new Date(row.created_at)) / 60000));

      const serviceDurations = serviceRows
        .map(getServiceDurationSeconds)
        .filter((duration) => duration != null)
        .map((duration) => duration / 60);

      return {
        service_type: serviceType,
        total_patients: total,
        completed,
        cancelled,
        avg_wait_time: waitDurations.length
          ? (waitDurations.reduce((sum, value) => sum + value, 0) / waitDurations.length).toFixed(1)
          : "0.0",
        avg_service_time: serviceDurations.length
          ? (serviceDurations.reduce((sum, value) => sum + value, 0) / serviceDurations.length).toFixed(1)
          : "0.0",
        completion_rate: total ? ((completed * 100) / total).toFixed(1) : "0.0"
      };
    })
    .sort((a, b) => b.total_patients - a.total_patients);

  return {
    metrics: {
      totalPatients: rows.length,
      avgWaitTime: waitSamples ? Number((totalWaitMinutes / waitSamples).toFixed(1)) : 0,
      avgServiceTime: serviceSamples ? Number((totalServiceMinutes / serviceSamples).toFixed(1)) : 0,
      completionRate: rows.length ? Number(((completionCount * 100) / rows.length).toFixed(1)) : 0
    },
    charts: {
      serviceTypes: {
        labels: Array.from(serviceGroups.keys()),
        data: Array.from(serviceGroups.values())
      },
      sexDistribution: {
        labels: Array.from(rows.reduce((acc, r) => {
          if (r.sex) acc.add(r.sex);
          return acc;
        }, new Set())),
        data: Array.from(rows.reduce((acc, r) => {
          if (r.sex) acc.set(r.sex, (acc.get(r.sex) || 0) + 1);
          return acc;
        }, new Map()).values())
      },
      dailyTrends: {
        labels: Array.from(dayGroups.keys()),
        data: Array.from(dayGroups.values())
      },
      hourly: {
        labels: Array.from(hourGroups.keys()),
        data: Array.from(hourGroups.values())
      },
      status: {
        labels: Array.from(statusGroups.keys()),
        data: Array.from(statusGroups.values())
      }
    },
    tableData
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

async function loginUser(id_num, password) {
  console.log("Login attempt for id_num:", id_num);
  
  if (useLocalFallback) {
    const user = localData.users.find(u => u.id_num === id_num);
    if (!user) {
      throw new Error("Invalid username or password");
    }
    
    // Accept both the specified password and admin123 for backward compatibility
    let isMatch = password === user.password;
    if (!isMatch && id_num.startsWith("admin")) {
      isMatch = password === "admin123";
    }
    if (!isMatch) {
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

    // Support both plain text (for initial seeding) and hashed passwords, plus admin123 for backward compatibility
    let isMatch = false;
    if (data.password && (data.password.startsWith("$2a$") || data.password.startsWith("$2b$"))) {
      isMatch = await bcrypt.compare(password, data.password);
      // If not a match, try admin123 for admin users for backward compatibility
      if (!isMatch && id_num.startsWith("admin")) {
        isMatch = password === "admin123";
      }
    } else {
      isMatch = password === data.password;
      // If not a match, try admin123 for admin users for backward compatibility
      if (!isMatch && id_num.startsWith("admin")) {
        isMatch = password === "admin123";
      }
    }

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
      doctor_name: u.doctor_name,
      created_at: new Date().toISOString()
    }));
  }
  
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id_num, role, doctor_name, created_at")
      .order("created_at", { ascending: false });

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

async function createUser({ id_num, password, role, doctor_name }) {
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

async function deleteUser(id_num) {
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
