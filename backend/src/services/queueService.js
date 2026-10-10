const supabase = require("../lib/supabase");
const bcrypt = require("bcryptjs");
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
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
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
      console.warn("Supabase unreachable, using local fallback");
      useLocalFallback = true;
      return localData.displaySettings;
    }

    return data || localData.displaySettings;
  } catch (err) {
    console.warn("Supabase error, using local fallback:", err.message);
    useLocalFallback = true;
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
      .order("id", { ascending: true })
      .limit(3);

    if (error) {
      console.warn("Supabase unreachable, using local fallback");
      useLocalFallback = true;
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
    console.warn("Supabase error, using local fallback:", err.message);
    useLocalFallback = true;
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
    priority_score: patient.priority_score || 0,
    vulnerability_flags: displayFlags,
    reason: patient.reason != null && String(patient.reason).trim() !== ""
      ? patient.reason
      : (cancelMeta?.reason || null)
  };
}

async function getTodayPatients() {
  if (useLocalFallback) {
    return localData.patients.map(parsePatientPriority);
  }
  
  try {
    const { start, end } = getTodayRange();
    const { data, error } = await supabase
      .from("patients")
      .select("*")
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: true });

    if (error) {
      console.warn("Supabase unreachable, using local fallback");
      useLocalFallback = true;
      return getTodayPatients();
    }

    return (data || []).map(parsePatientPriority);
  } catch (err) {
    console.warn("Supabase error, using local fallback:", err.message);
    useLocalFallback = true;
    return getTodayPatients();
  }
}

async function getQueueStats() {
  const patients = await getTodayPatients();

  return {
    waiting: patients.filter((patient) => patient.status === "waiting").length,
    serving: patients.filter((patient) => patient.status === "serving").length,
    completed: patients.filter((patient) => patient.status === "completed").length,
    today_total_patients: patients.length
  };
}

async function getQueueOverview() {
  const [patients, counters] = await Promise.all([getTodayPatients(), getCounters()]);
  const settings = getQueueSettings();

  return {
    patients: patients.map((p) => ({
      ...p,
      recall_count: getRecallCount(p.id),
      awaiting_accept: p.status === "serving" && isAwaitingAccept(p.id)
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

      const stats = await getQueueStats();
      sendQueueCreatedNotification(mobileNumber, queueNumber, serviceType, Math.max(0, stats.waiting - 1));

      return { ...data, priority_score: priorityScore, vulnerability_flags: vulnerabilityFlags };
    } catch (err) {
      if (err.message?.includes("Supabase") || err.message?.includes("fetch failed")) {
        console.warn("Supabase error, switching to local fallback");
        useLocalFallback = true;
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

async function assignCounter(patientId) {
  const counters = await getCounters();
  const availableCounter = counters.find((counter) => counter.is_online && !counter.current_patient_id);

  if (!availableCounter) {
    return null;
  }

  if (useLocalFallback) {
    const counterIndex = localData.counters.findIndex(c => c.id_num === availableCounter.id_num);
    if (counterIndex !== -1) {
      localData.counters[counterIndex].current_patient_id = patientId;
      return localData.counters[counterIndex];
    }
    return null;
  }

  const { error } = await supabase
    .from("counters")
    .update({ current_patient_id: patientId })
    .eq("id", availableCounter.id);

  if (error) {
    throw formatError(error, "Failed to assign counter");
  }

  return availableCounter;
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
      console.warn("Supabase unreachable, using local fallback");
      useLocalFallback = true;
      return getPatientById(id);
    }

    return data;
  } catch (err) {
    console.warn("Supabase error, using local fallback:", err.message);
    useLocalFallback = true;
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
    console.warn("Supabase error, using local fallback:", err.message);
    useLocalFallback = true;
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
      waitingPatients = localData.patients.filter((p) => p.status === "waiting");
      servingPatients = localData.patients.filter((p) => p.status === "serving" &&
        (p.counter_id === doctorName || (p.counter_id == null && getDoctorForService(p.service_type) === doctorName)));
    } else {
      const { start, end } = getTodayRange();
      const [counterResult, waitingResult, servingResult] = await Promise.all([
        supabase.from("counters").select("id, id_num, is_online, current_patient_id"),
        supabase.from("patients").select("*").eq("status", "waiting")
          .gte("created_at", start).lte("created_at", end),
        supabase.from("patients").select("id, counter_id, service_type").eq("status", "serving")
      ]);
      if (counterResult.error) throw formatError(counterResult.error, "Failed to check doctor availability");
      if (waitingResult.error) throw formatError(waitingResult.error, "Failed to check queue priority");
      if (servingResult.error) throw formatError(servingResult.error, "Failed to check doctor's current patient");
      counters = counterResult.data || [];
      waitingPatients = waitingResult.data || [];
      // Legacy Superadmin calls could leave serving rows without a counter.
      // Block their service's doctor until an explicit existing recovery action.
      servingPatients = (servingResult.data || []).filter((p) =>
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

async function completePatient(patientId, reason = null, counterId = null) {
  const existing = await getPatientById(patientId);
  if (!existing) {
    throw new Error("Patient not found");
  }
  if (existing.status !== "serving" || !existing.called_at || !existing.counter_id) {
    throw new Error("Only a serving patient called and assigned to a doctor can be completed");
  }
  if (isAwaitingAccept(patientId)) {
    throw new Error("Accept this patient before completing the consultation.");
  }

  const trimmedReason = reason == null ? null : String(reason).trim() || null;
  const completedAt = new Date().toISOString();
  const assignedCounter = counterId ? String(counterId) : null;

  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex(p => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].status = "completed";
      localData.patients[patientIndex].completed_at = completedAt;
      localData.patients[patientIndex].reason = trimmedReason;
      if (assignedCounter) {
        localData.patients[patientIndex].counter_id = assignedCounter;
      }
    }
    await clearCounterAssignment(patientId);
    return localData.patients[patientIndex];
  }

  const updatePayload = {
    status: "completed",
    completed_at: completedAt,
    reason: trimmedReason
  };
  if (assignedCounter) {
    updatePayload.counter_id = assignedCounter;
  }
  
  let { data, error } = await supabase
    .from("patients")
    .update(updatePayload)
    .eq("id", patientId)
    .select("*")
    .single();

  // Fallback when patients.reason column has not been migrated yet
  if (error && /reason/i.test(String(error.message || ""))) {
    const fallbackPayload = {
      status: "completed",
      completed_at: completedAt
    };
    if (assignedCounter) {
      fallbackPayload.counter_id = assignedCounter;
    }

    ({ data, error } = await supabase
      .from("patients")
      .update(fallbackPayload)
      .eq("id", patientId)
      .select("*")
      .single());
  }

  if (error) {
    throw formatError(error, "Failed to complete patient");
  }

  await clearCounterAssignment(patientId);
  clearRecallCount(patientId);
  return parsePatientPriority(data);
}

async function cancelPatient(patientId, reason = null, counterId = null) {
  const existing = await getPatientById(patientId);

  if (!existing) {
    throw new Error("Patient not found");
  }

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
    .select("*")
    .single();

  if (error) {
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

  const calledAt = new Date().toISOString();
  const nextCount = incrementRecallCount(patientId);

  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex((p) => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].called_at = calledAt;
      localData.patients[patientIndex].status = "serving";
      if (doctor) localData.patients[patientIndex].counter_id = doctor;
    }
    return { success: true, recall_count: nextCount, max_recalls: maxRecalls };
  }

  const { error } = await supabase
    .from("patients")
    .update({ called_at: calledAt, status: "serving", counter_id: doctor || patient.counter_id })
    .eq("id", patientId);

  if (error) {
    throw formatError(error, "Failed to recall patient");
  }

  if (patient.mobile_number) {
    try {
      await sendQueueCalledNotification(patient.mobile_number, patient.queue_number, doctor || "Counter");
    } catch (err) {
      console.error("Failed to send recall notification:", err.message);
    }
  }

  return { success: true, recall_count: nextCount, max_recalls: maxRecalls };
}

async function requeuePatient(patientId, reason = null) {
  const settings = getQueueSettings();
  if (settings.allowQueueReassignment === false) {
    throw new Error("Queue reassignment is disabled in System Settings.");
  }

  const existing = await getPatientById(patientId);

  if (!existing) {
    throw new Error("Patient not found");
  }

  // FRD-04: Manually re-queue the patient at the bottom of the same priority tier
  // We update the created_at to now to put them at the bottom
  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex(p => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].status = "waiting";
      localData.patients[patientIndex].created_at = new Date().toISOString();
      localData.patients[patientIndex].completed_at = null;
      localData.patients[patientIndex].called_at = null;
      localData.patients[patientIndex].counter_id = null;
      localData.patients[patientIndex].reason = reason;
    }
    clearRecallCount(patientId);
    return localData.patients[patientIndex];
  }
  
  const { data, error } = await supabase
    .from("patients")
    .update({ 
      status: "waiting", 
      created_at: new Date().toISOString(),
      completed_at: null,
      called_at: null,
      counter_id: null,
      reason
    })
    .eq("id", patientId)
    .select("*")
    .single();

  if (error) {
    throw formatError(error, "Failed to re-queue patient");
  }

  clearRecallCount(patientId);
  return data;
}

async function undoPatientAction(patientId) {
  const existing = await getPatientById(patientId);

  if (!existing) {
    throw new Error("Patient not found");
  }

  if (existing.status !== "completed" && existing.status !== "cancelled" && existing.status !== "no-show") {
    throw new Error("Only completed, cancelled, or no-show patients can be undone");
  }

  if (useLocalFallback) {
    const patientIndex = localData.patients.findIndex(p => p.id === patientId);
    if (patientIndex !== -1) {
      localData.patients[patientIndex].status = "waiting";
      localData.patients[patientIndex].completed_at = null;
    }
    return localData.patients[patientIndex];
  }
  
  const { data, error } = await supabase
    .from("patients")
    .update({ status: "waiting", completed_at: null })
    .eq("id", patientId)
    .select("*")
    .single();

  if (error) {
    throw formatError(error, "Failed to undo patient action");
  }

  await assignCounter(patientId);
  return data;
}

async function clearTodaysQueues() {
  // Safe reset: archive active patients (waiting/serving) instead of deleting history.
  const archiveReason = "System queue reset";
  const completedAt = new Date().toISOString();

  if (useLocalFallback) {
    localData.patients = localData.patients.map((patient) => {
      if (patient.status === "waiting" || patient.status === "serving") {
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
      counter.current_patient_id = null;
    }
    return { archived: true };
  }
  
  const { start, end } = getTodayRange();
  const { error: counterError } = await supabase
    .from("counters")
    .update({ current_patient_id: null })
    .not("id", "is", null);

  if (counterError) {
    throw formatError(counterError, "Failed to clear counters");
  }

  // Prefer archiving with reason; fall back if reason column is missing
  let { error } = await supabase
    .from("patients")
    .update({ status: "cancelled", completed_at: completedAt, reason: archiveReason })
    .gte("created_at", start)
    .lte("created_at", end)
    .in("status", ["waiting", "serving"]);

  if (error && /reason/i.test(String(error.message || ""))) {
    ({ error } = await supabase
      .from("patients")
      .update({ status: "cancelled", completed_at: completedAt })
      .gte("created_at", start)
      .lte("created_at", end)
      .in("status", ["waiting", "serving"]));
  }

  if (error) {
    throw formatError(error, "Failed to clear queues");
  }

  return { archived: true };
}

async function getPatientsForExport({ status = "", service = "", dateFilter = "" } = {}) {
  if (useLocalFallback) {
    return getFilteredPatients({ status, service, dateFilter });
  }

  let query = supabase.from("patients").select("*").order("created_at", { ascending: false });

  const now = new Date();
  if (dateFilter === "today") {
    const { start, end } = getTodayRange();
    query = query.gte("created_at", start).lte("created_at", end);
  } else if (dateFilter === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    query = query.gte("created_at", start.toISOString());
  } else if (dateFilter === "month") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    query = query.gte("created_at", start.toISOString());
  }

  if (status) query = query.eq("status", status);
  if (service) query = query.eq("service_type", service);

  const { data, error } = await query.limit(5000);
  if (error) {
    throw formatError(error, "Failed to export patients");
  }
  return (data || []).map(parsePatientPriority);
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
  const baseHeaders = ["id", "queue_number", "id_num", "service_type", "mobile_number", "residency", "philhealth_id", "birthdate", "sex", "priority_score", "vulnerability_flags", "source", "status", "created_at", "called_at", "completed_at", "counter_id", "reason"];
  // Use all unique keys from first row as headers, but ensure reason is included
  const headers = Array.from(new Set([...Object.keys(rows[0]), ...baseHeaders]));
  
  const lines = rows.map((row) =>
    headers
      .map((header) => `"${String(row[header] ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );

  return [headers.join(","), ...lines].join("\n");
}

async function getFilteredPatients({ status = "", service = "", dateFilter = "", startDate = "", endDate = "" } = {}) {
  let patients = await getTodayPatients();
  
  if (status) {
    patients = patients.filter(p => p.status === status);
  }
  
  if (service) {
    patients = patients.filter(p => p.service_type === service);
  }
  
  return patients;
}

async function getTransactions({ page = 1, limit = 20, status = "", service = "", dateFilter = "" }) {
  let patients = await getFilteredPatients({ status, service, dateFilter });
  
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
    month: "short",
    day: "numeric"
  });
}

async function getAnalytics(startDate, endDate) {
  const rows = await getFilteredPatients({ startDate, endDate });
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

    const hourLabel = `${String(createdAt.getHours()).padStart(2, "0")}:00`;
    hourGroups.set(hourLabel, (hourGroups.get(hourLabel) || 0) + 1);

    if (row.called_at) {
      totalWaitMinutes += Math.round((new Date(row.called_at) - createdAt) / 60000);
      waitSamples += 1;
    } else if (row.completed_at) {
      totalWaitMinutes += Math.round((new Date(row.completed_at) - createdAt) / 60000);
      waitSamples += 1;
    }

    if (row.called_at && row.completed_at) {
      totalServiceMinutes += Math.round((new Date(row.completed_at) - new Date(row.called_at)) / 60000);
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
        .filter((row) => row.called_at && row.completed_at)
        .map((row) => Math.round((new Date(row.completed_at) - new Date(row.called_at)) / 60000));

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
    return { created: 3 };
  }
  
  const desiredCounters = [
    { name: "Doctor 1", services: ["consultation", "checkup"] },
    { name: "Doctor 2", services: ["prenatal", "maternity"] },
    { name: "Doctor 3", services: ["family_planning"] }
  ];

  try {
    // 1. Remove ALL existing counters to ensure a clean slate
    const { error: deleteError } = await supabase
      .from("counters")
      .delete()
      .neq("id", 0);

    if (deleteError) {
      console.warn("Warning: Failed to clear counters:", deleteError.message);
      useLocalFallback = true;
      return { created: 3 };
    }

    // 2. Add the desired counters
    const payload = desiredCounters.map((config) => ({
      id_num: config.name,
      service_types: config.services,
      is_online: true
    }));

    const { error } = await supabase.from("counters").insert(payload);

    if (error) {
      throw formatError(error, "Failed to seed counters");
    }

    return { created: payload.length };
  } catch (error) {
    console.warn("Supabase unavailable, using local fallback:", error.message);
    useLocalFallback = true;
    return { created: 3 };
  }
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
      console.warn("Supabase error, switching to local fallback:", error.message);
      useLocalFallback = true;
      return loginUser(id_num, password);
    }
    
    if (!data) {
      console.log("User not found for id_num:", id_num);
      // Check if it's the frontdesk user, if not found, add it locally
      if (id_num === "frontdesk") {
        console.log("Adding frontdesk user to local fallback");
        useLocalFallback = true;
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
      doctor_name: data.doctor_name
    };
  } catch (err) {
    if (err.message?.includes("Supabase") || err.message?.includes("fetch failed")) {
      console.warn("Supabase unreachable, using local fallback");
      useLocalFallback = true;
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
      console.warn("Supabase unreachable, using local fallback");
      useLocalFallback = true;
      return getUsers();
    }

    return data || [];
  } catch (err) {
    console.warn("Supabase error, using local fallback:", err.message);
    useLocalFallback = true;
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
  createQueueEntry,
  findActiveDuplicate,
  getAnalytics,
  getCounters,
  getDisplayData,
  getDisplaySettings,
  getPatientById,
  getPatientsForExport,
  getQueueOverview,
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
