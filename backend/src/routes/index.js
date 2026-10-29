const express = require("express");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const env = require("../config/env");
const { getBusinessDate } = require("../lib/businessDay");
const { authenticateToken, authorizeRole } = require("../middleware/auth");
const {
  createAuthSession,
  heartbeatAuthSession,
  revokeAuthSession,
  getDoctorPresence
} = require("../services/presenceService");
const {
  buildCsv,
  callPatient,
  cancelPatient,
  cancelHistoricalWaitingVisit,
  getHistoricalBacklog,
  getHistoricalBacklogVisit,
  authorizeVisitAction,
  noShowPatient,
  recallPatient,
  requeuePatient,
  undoPatientAction,
  clearTodaysQueues,
  completePatient,
  startConsultation,
  getServingPatientForDoctor,
  createQueueEntry,
  getAnalytics,
  getDashboardStats,
  getDisplayData,
  getCounters,
  getPatientById,
  getPatientsForExport,
  getQueueOverview,
  getQueueStorageMode,
  getQueueStats,
  getTransactions,
  seedCounters,
  setCounterOnline,
  loginUser,
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  createAccountCancellationRequest,
  getAccountCancellationRequests,
  getMyAccountCancellationRequest,
  processAccountCancellationRequest
} = require("../services/queueService");
const {
  getQueueSettings,
  saveQueueSettings,
  isAwaitingAccept,
  getAcceptedAt,
  markAccepted,
  clearAwaitingAccept,
  resetAcceptState,
  recordVoiceAnnouncementEvent
} = require("../services/settingsService");

const router = express.Router();

function readRecordFilters(query, defaultDateFilter = "") {
  return {
    status: String(query.status || ""), service: String(query.service || ""), doctor: String(query.doctor || ""),
    dateFilter: String(query.dateFilter ?? defaultDateFilter), date: String(query.date || ""),
    startDate: String(query.startDate || ""), endDate: String(query.endDate || "")
  };
}

function readAnalyticsFilters(query) {
  const filters = readRecordFilters(query);
  if (query.dateFilter === undefined && !filters.date && !filters.startDate && !filters.endDate) {
    filters.startDate = getBusinessDate(new Date(Date.now() - 6 * 86400000));
    filters.endDate = getBusinessDate(new Date());
  }
  return filters;
}

function normalizeDoctorAssignment(value, counters = []) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const counter = counters.find((item) =>
    String(item.id) === raw ||
    String(item.id_num || "").trim() === raw ||
    String(item.name || "").trim() === raw
  );
  if (counter) {
    return String(counter.id_num || counter.name || "").trim();
  }

  const doctorMatch = raw.match(/^doctor\s*(\d+)$/i);
  if (doctorMatch) return `Doctor ${doctorMatch[1]}`;

  if (/^\d+$/u.test(raw)) return `Doctor ${raw}`;

  return raw;
}

router.get("/health", (_req, res) => {
  res.json({ success: true, message: "Backend is running" });
});

router.post("/auth/login", async (req, res) => {
  try {
    const { id_num, password } = req.body;
    const verifiedUser = await loginUser(id_num, password);
    const user = { id_num: verifiedUser.id_num, role: verifiedUser.role, doctor_name: verifiedUser.doctor_name };
    const sessionId = randomUUID();
    const session = await createAuthSession(verifiedUser, sessionId);
    const token = jwt.sign(
      {
        id_num: user.id_num, role: user.role, doctor_name: user.doctor_name,
        jti: sessionId, exp: Math.floor(Date.parse(session.expires_at) / 1000)
      },
      env.jwtSecret,
      { algorithm: "HS256" }
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, token, user });
  } catch (error) {
    res.status(error.statusCode || 401).json({ success: false, message: error.message });
  }
});

router.post("/auth/heartbeat", authenticateToken, async (req, res) => {
  try {
    const session = await heartbeatAuthSession(req.user);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, last_seen_at: session.last_seen_at, expires_at: session.expires_at });
  } catch (error) {
    res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
});

router.post("/auth/logout", authenticateToken, async (req, res) => {
  try {
    await revokeAuthSession(req.user);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, message: "Session logged out" });
  } catch (error) {
    res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
});

router.get("/doctors/presence", authenticateToken, authorizeRole(["superadmin"]), async (_req, res) => {
  try {
    const counters = await getCounters();
    const data = await getDoctorPresence(counters);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, ...data, counters });
  } catch (error) {
    res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
});

router.get("/queue", authenticateToken, async (_req, res) => {
  try {
    const data = await getQueueOverview();
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.post("/queue", authenticateToken, async (req, res) => {
  try {
    const { fullName, service_type, mobile_number, residency, philhealth_id, birthdate, sex, vulnerabilityFlags } = req.body;

    if (!fullName || !service_type) {
      return res.status(400).json({ success: false, message: "Full name and service type are required" });
    }

    const row = await createQueueEntry({
      idNum: fullName,
      serviceType: service_type,
      mobileNumber: mobile_number,
      residency,
      philhealthId: philhealth_id,
      birthdate,
      sex,
      vulnerabilityFlags: vulnerabilityFlags || [],
      source: "admin"
    });

    return res.json({
      success: true,
      queue_number: row.queue_number,
      priority_score: row.priority_score,
      message: "Patient added successfully"
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.post("/queue/website", async (req, res) => {
  try {
    const { fullName, serviceType, mobileNumber, residency, philhealthId, birthdate, sex, vulnerabilityFlags } = req.body;

    if (!fullName || !serviceType) {
      return res.status(400).json({ success: false, message: "Please fill in all required fields." });
    }

    const row = await createQueueEntry({
      idNum: fullName,
      serviceType,
      mobileNumber,
      residency,
      philhealthId,
      birthdate,
      sex,
      vulnerabilityFlags: vulnerabilityFlags || [],
      source: "website"
    });

    return res.json({
      success: true,
      queue_number: row.queue_number,
      priority_score: row.priority_score
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.post("/queue/call", authenticateToken, async (req, res) => {
  try {
    const { patient_id, counterId, counter_id } = req.body;
    if (counterId != null && counter_id != null && counterId !== counter_id) {
      return res.status(400).json({ success: false, message: "Conflicting doctor assignments" });
    }
    const requestedDoctor = counterId ?? counter_id ?? null;
    // Older frontdesk accounts store their display label in doctor_name.
    // Treat that label as unassigned while keeping actual doctor restrictions.
    const accountAssignment = req.user?.doctor_name ?? null;
    const accountDoctor = ["front desk", "frontdesk"].includes(String(accountAssignment ?? "").trim().toLowerCase())
      ? null : accountAssignment;
    if (accountDoctor && requestedDoctor != null && requestedDoctor !== accountDoctor) {
      return res.status(403).json({ success: false, message: "You can only call patients assigned to your doctor." });
    }
    await callPatient(Number(patient_id), requestedDoctor ?? accountDoctor, req.user);
    console.info("[voice][queue-call]", {
      patient_id: Number(patient_id),
      requested_counter: requestedDoctor ?? accountDoctor,
      at: new Date().toISOString()
    });
    res.json({ success: true, message: "Patient called successfully" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/accept", authenticateToken, async (req, res) => {
  try {
    const patientId = Number(req.body.patient_id);
    const patient = await getServingPatientForDoctor(patientId, req.user);
    // A legacy serving row with a missing acceptance file must be explicitly
    // accepted by its doctor; never invent an acceptance/start timestamp.
    if (patient.consultation_started_at || (!isAwaitingAccept(patientId) && getAcceptedAt(patientId))) {
      return res.status(400).json({ success: false, message: "This patient is not waiting to be accepted" });
    }
    const acceptedAt = markAccepted(patientId, patient.called_at);
    const announcement = recordVoiceAnnouncementEvent({ patient, eventType: "accept", eventAt: acceptedAt });
    console.info("[voice][accept]", {
      patient_id: patientId,
      queue_number: patient.queue_number,
      patient_name: patient.id_num,
      doctor: patient.counter_id,
      announcement_key: announcement?.event_id,
      accepted_at: acceptedAt
    });
    res.json({
      success: true,
      accepted_at: acceptedAt,
      announcement_key: announcement?.event_id,
      message: "Patient accepted"
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/start", authenticateToken, async (req, res) => {
  try {
    const patient = await startConsultation(Number(req.body.patient_id), req.user);
    res.json({ success: true, patient, storage_mode: getQueueStorageMode(), message: "Consultation started successfully" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/re-call", authenticateToken, async (req, res) => {
  try {
    const patientId = Number(req.body.patient_id);
    const patient = await getPatientById(patientId);
    if (!patient) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    if (patient.status !== "serving" || !patient.counter_id) {
      return res.status(400).json({ success: false, message: "Only the current serving patient can be re-called" });
    }

    if (isAwaitingAccept(patientId) || (!getAcceptedAt(patientId) && !patient.consultation_started_at)) {
      return res.status(400).json({ success: false, message: "Accept this patient before using Re-Call." });
    }

    // Ownership comes from the stored assignment and the persisted account, not from
    // the token's doctor_name or the body. Doctors may re-call only their own patient;
    // Frontdesk and Superadmin keep their existing ability to re-call any accepted patient.
    try {
      await authorizeVisitAction(patientId, req.user, req.body?.counterId ?? req.body?.counter_id ?? null, {
        denyMessage: "You can only re-call your assigned patient."
      });
    } catch (denied) {
      console.warn("[voice][re-call-denied]", {
        patient_id: patientId,
        queue_number: patient.queue_number,
        patient_counter_id: patient.counter_id,
        user_id: req.user?.id_num || null,
        reason: denied.message
      });
      return res.status(denied.statusCode || 403).json({ success: false, message: denied.message });
    }

    const announcement = recordVoiceAnnouncementEvent({ patient, eventType: "recall" });
    console.info("[voice][re-call]", {
      patient_id: patientId,
      queue_number: patient.queue_number,
      patient_name: patient.id_num,
      doctor: patient.counter_id,
      announcement_key: announcement?.event_id,
      announcement_at: announcement?.event_at
    });
    res.json({
      success: true,
      announcement_key: announcement?.event_id,
      announcement_at: announcement?.event_at,
      message: `Re-call announcement queued for ${patient.queue_number}`
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/complete", authenticateToken, async (req, res) => {
  try {
    const { patient_id, reason, counter_id, counterId } = req.body;
    if (counter_id != null && counterId != null && String(counter_id) !== String(counterId)) {
      return res.status(400).json({ success: false, message: "Conflicting doctor assignments" });
    }
    const patient = await completePatient(Number(patient_id), reason, counter_id ?? counterId ?? null, req.user);
    clearAwaitingAccept(patient_id);
    res.json({ success: true, patient, storage_mode: getQueueStorageMode(), message: "Consultation completed successfully" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/cancel", authenticateToken, async (req, res) => {
  try {
    // Identity comes only from the verified token (req.user). Any role, id_num,
    // doctor_name or similar field in the body is ignored; counter_id/counterId is
    // an optional consistency check against the stored assignment, never authority.
    const { patient_id, reason, counter_id, counterId } = req.body;
    if (counter_id && counterId && String(counter_id) !== String(counterId)) {
      return res.status(400).json({ success: false, message: "Conflicting doctor assignments" });
    }
    const trimmedReason = String(reason || "").trim();
    if (!trimmedReason) {
      return res.status(400).json({ success: false, message: "Reason for cancel is required" });
    }
    if (trimmedReason.length > 1000) {
      return res.status(400).json({ success: false, message: "Reason for cancel is too long (maximum 1000 characters)" });
    }
    const result = await cancelPatient(Number(patient_id), trimmedReason, counter_id || counterId || null, req.user);
    if (result?.already_cancelled) {
      // Idempotent repeat: nothing was written, so no acceptance state is touched either.
      return res.json({ success: true, already_cancelled: true, message: "Patient was already cancelled; no changes were made" });
    }
    clearAwaitingAccept(patient_id);
    res.json({ success: true, message: "Patient cancelled successfully" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

// Historical Waiting Backlog (H1 Stage 1): Superadmin only, by the persisted session's role.
// Reads never write; Cancel is one reviewed visit through the W1 cancellation path.
router.get("/queue/backlog", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const { search, date, service, doctor, page, limit } = req.query;
    const data = await getHistoricalBacklog({ search, date, service, doctor, page, limit });
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, ...data });
  } catch (error) {
    // Unexpected failures never echo database details to the browser.
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Historical backlog is unavailable. Please retry." });
  }
});

router.get("/queue/backlog/:id", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const visit = await getHistoricalBacklogVisit(Number(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, visit });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Historical backlog is unavailable. Please retry." });
  }
});

router.post("/queue/backlog/:id/cancel", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    const { reason, expected_revision, acknowledge_review } = req.body || {};
    const result = await cancelHistoricalWaitingVisit(patientId,
      { reason, expectedRevision: expected_revision, acknowledged: acknowledge_review === true }, req.user);
    if (result?.already_cancelled) {
      return res.json({ success: true, already_cancelled: true, message: "This visit was already cancelled; no changes were made" });
    }
    clearAwaitingAccept(patientId);
    res.json({ success: true, message: "Visit cancelled. Its registration history was kept." });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/no-show", authenticateToken, async (req, res) => {
  try {
    // Identity comes only from the verified token; the stored assignment decides ownership.
    const { patient_id, reason } = req.body;
    const result = await noShowPatient(Number(patient_id), reason, req.user);
    if (result?.already_no_show) {
      return res.json({ success: true, already_no_show: true, message: "Patient was already marked no-show; no changes were made" });
    }
    res.json({ success: true, message: "Patient marked as no-show" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/recall", authenticateToken, async (req, res) => {
  try {
    const { patient_id, counterId } = req.body;
    const result = await recallPatient(Number(patient_id), counterId || req.body.counter_id || null, req.user);
    res.json({
      success: true,
      message: `Patient recalled (${result.recall_count}/${result.max_recalls} recalls used)`,
      ...result
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/requeue", authenticateToken, async (req, res) => {
  try {
    const { patient_id, reason } = req.body;
    await requeuePatient(Number(patient_id), reason, req.user);
    resetAcceptState(patient_id);
    res.json({ success: true, message: "Patient re-queued successfully" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/undo", authenticateToken, async (req, res) => {
  try {
    const { patient_id } = req.body;
    await undoPatientAction(Number(patient_id), req.user);
    resetAcceptState(patient_id);
    res.json({ success: true, message: "Action undone successfully" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

router.post("/queue/clear", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const { archivedPatientIds } = await clearTodaysQueues(req.user);
    for (const patientId of archivedPatientIds) resetAcceptState(patientId);
    res.json({
      success: true,
      message: "Active queues were reset. Transaction history was preserved."
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get("/queue/export", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const patients = await getPatientsForExport(readRecordFilters(req.query, "today"));
    const csv = buildCsv(patients);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="queue_data_${getBusinessDate(new Date())}.csv"`
    );
    res.send(csv);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.post("/counters/availability", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const updates = req.body?.doctors || {};
    const results = [];
    for (const [idNum, isOnline] of Object.entries(updates)) {
      const row = await setCounterOnline(idNum, isOnline);
      results.push(row);
    }
    res.json({ success: true, counters: results, message: "Doctor availability updated" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/settings", async (_req, res) => {
  try {
    res.json({ success: true, settings: getQueueSettings() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put("/settings", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const saved = saveQueueSettings(req.body || {});
    // Keep doctor availability counters in sync with saved toggles
    await setCounterOnline("Doctor 1", !!saved.doctor1Online);
    await setCounterOnline("Doctor 2", !!saved.doctor2Online);
    await setCounterOnline("Doctor 3", !!saved.doctor3Online);
    res.json({ success: true, settings: saved, message: "Settings saved successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/stats/dashboard", authenticateToken, authorizeRole(["superadmin"]), async (_req, res) => {
  try {
    const data = await getDashboardStats();
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const data = await getQueueStats();
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get("/display", async (_req, res) => {
  try {
    const data = await getDisplayData();
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get("/transactions", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const data = await getTransactions({
      ...readRecordFilters(req.query),
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20)
    });

    res.json({ success: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get("/analytics/daily-trends", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const { getDailyTrends } = require("../services/dailyTrendsService");
    const data = await getDailyTrends(req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
});

router.get("/analytics/status", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const { getStatusAnalytics } = require("../services/statusAnalyticsService");
    const data = await getStatusAnalytics(req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
});

router.get("/analytics", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const filters = readAnalyticsFilters(req.query);
    const data = await getAnalytics(filters.startDate, filters.endDate, filters);

    res.json({ success: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get("/analytics/export", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const filters = readAnalyticsFilters(req.query);
    const data = await getAnalytics(filters.startDate, filters.endDate, filters);
    const csv = buildCsv(data.tableData);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="analytics_${filters.startDate || filters.date || "all"}_${filters.endDate || filters.date || "dates"}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

// Maintenance only: startup seeds missing counters itself (src/index.js). Inserts
// absent Doctor 1–3 counters and never changes existing counters or patients.
router.post("/setup/counters", authenticateToken, authorizeRole(["superadmin"]), async (_req, res) => {
  try {
    const result = await seedCounters();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Disabled (S1): renaming a service type rewrites historical patient records and the
// service-to-doctor routing, and no approved maintenance workflow uses it. Kept behind
// Superadmin authentication so the route discloses nothing to other callers.
router.post("/setup/service-type", authenticateToken, authorizeRole(["superadmin"]), (_req, res) => {
  res.status(410).json({
    success: false,
    message: "Service type renaming is disabled. It changes patient history and doctor routing and requires an approved maintenance procedure."
  });
});

// User Management Routes
router.get("/users", authenticateToken, authorizeRole(["superadmin"]), async (_req, res) => {
  try {
    const users = await getUsers();
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/users", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const user = await createUser(req.body);
    res.json({ success: true, user, message: "User created successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.put("/users/:id_num", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const user = await updateUser(req.params.id_num, req.body || {});
    res.json({ success: true, user, message: "User updated successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.delete("/users/:id_num", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    await deleteUser(req.params.id_num, req.user);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

// Doctor account cancellation requests (Doctor submits → Super Admin processes)
router.post("/account-cancellation-requests", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "superadmin") {
      return res.status(403).json({ success: false, message: "Superadmin accounts cannot request cancellation this way" });
    }

    const reason = req.body?.reason;
    const requestRow = await createAccountCancellationRequest({
      doctor_id_num: req.user.id_num,
      doctor_name: req.user.doctor_name || null,
      doctor_role: req.user.role || "admin",
      reason
    });

    res.json({
      success: true,
      request: requestRow,
      message: "Cancellation request submitted. Waiting for Super Admin approval."
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/account-cancellation-requests/mine", authenticateToken, async (req, res) => {
  try {
    const requestRow = await getMyAccountCancellationRequest(req.user.id_num);
    res.json({ success: true, request: requestRow });
  } catch (error) {
    // Soft-fail when migration is not applied yet so doctor pages keep working
    if (/Cancellation requests table is missing/i.test(error.message || "")) {
      return res.json({ success: true, request: null, warning: error.message });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/account-cancellation-requests", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const requests = await getAccountCancellationRequests({ status });
    res.json({ success: true, requests });
  } catch (error) {
    if (/Cancellation requests table is missing/i.test(error.message || "")) {
      return res.json({ success: true, requests: [], warning: error.message });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/account-cancellation-requests/:id/process", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const { action, admin_notes } = req.body || {};
    const requestRow = await processAccountCancellationRequest(req.params.id, {
      action,
      processed_by: req.user.id_num,
      admin_notes
    });

    res.json({
      success: true,
      request: requestRow,
      message: action === "approve"
        ? "Cancellation approved. Doctor account has been removed."
        : "Cancellation request rejected. Doctor account remains active."
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Geocode proxy — forwards address search to Nominatim
router.get("/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    if (q.length < 3) {
      return res.json([]);
    }
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&addressdetails=1&limit=5&countrycodes=ph`;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "CityHealthQueueSystem/1.0"
      }
    });
    if (!response.ok) {
      return res.json([]);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Geocode proxy error:", error.message);
    res.json([]);
  }
});

module.exports = router;
