const express = require("express");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { authenticateToken, authorizeRole } = require("../middleware/auth");
const {
  buildCsv,
  callPatient,
  cancelPatient,
  noShowPatient,
  recallPatient,
  requeuePatient,
  undoPatientAction,
  clearTodaysQueues,
  completePatient,
  createQueueEntry,
  getAnalytics,
  getDisplayData,
  getCounters,
  getPatientById,
  getPatientsForExport,
  getQueueOverview,
  getQueueStats,
  getTransactions,
  renameServiceType,
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
  markAwaitingAccept,
  markAccepted,
  clearAwaitingAccept,
  resetAcceptState,
  clearAllAwaitingAccept,
  recordVoiceAnnouncementEvent,
  clearAllVoiceAnnouncementEvents
} = require("../services/settingsService");

const router = express.Router();

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
    const user = await loginUser(id_num, password);
    
    const token = jwt.sign(
      { id_num: user.id_num, role: user.role, doctor_name: user.doctor_name },
      env.jwtSecret,
      { expiresIn: "8h" }
    );

    res.json({ success: true, token, user });
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
  }
});

router.get("/queue", authenticateToken, async (_req, res) => {
  try {
    const data = await getQueueOverview();
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
    const { patient_id, counter_id, counterId } = req.body;
    await callPatient(Number(patient_id), counterId || counter_id || null);
    markAwaitingAccept(patient_id);
    console.info("[voice][queue-call]", {
      patient_id: Number(patient_id),
      requested_counter: counterId || counter_id || null,
      at: new Date().toISOString()
    });
    res.json({ success: true, message: "Patient called successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/accept", authenticateToken, async (req, res) => {
  try {
    const patientId = Number(req.body.patient_id);
    const patient = await getPatientById(patientId);
    if (!patient) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }
    if (patient.status !== "serving" || !isAwaitingAccept(patientId)) {
      return res.status(400).json({ success: false, message: "This patient is not waiting to be accepted" });
    }
    const acceptedAt = markAccepted(patientId);
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
    res.status(400).json({ success: false, message: error.message });
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

    if (isAwaitingAccept(patientId)) {
      return res.status(400).json({ success: false, message: "Accept this patient before using Re-Call." });
    }

    const counters = await getCounters();
    const requestedDoctor = normalizeDoctorAssignment(
      req.user?.doctor_name || req.body?.counterId || req.body?.counter_id || patient.counter_id,
      counters
    );
    const assignedDoctor = normalizeDoctorAssignment(patient.counter_id, counters);

    if (!requestedDoctor || !assignedDoctor || assignedDoctor !== requestedDoctor) {
      console.warn("[voice][re-call-denied]", {
        patient_id: patientId,
        queue_number: patient.queue_number,
        patient_counter_id: patient.counter_id,
        assigned_doctor: assignedDoctor,
        requested_doctor: requestedDoctor,
        user_doctor: req.user?.doctor_name || null,
        body_counter: req.body?.counterId || req.body?.counter_id || null
      });
      return res.status(403).json({ success: false, message: "You can only re-call your assigned patient." });
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
    await completePatient(Number(patient_id), reason, counter_id || counterId || null);
    clearAwaitingAccept(patient_id);
    res.json({ success: true, message: "Patient completed successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/cancel", authenticateToken, async (req, res) => {
  try {
    const { patient_id, reason, counter_id } = req.body;
    const trimmedReason = String(reason || "").trim();
    if (!trimmedReason) {
      return res.status(400).json({ success: false, message: "Reason for cancel is required" });
    }
    await cancelPatient(Number(patient_id), trimmedReason, counter_id || null);
    clearAwaitingAccept(patient_id);
    res.json({ success: true, message: "Patient cancelled successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/no-show", authenticateToken, async (req, res) => {
  try {
    const { patient_id, reason } = req.body;
    await noShowPatient(Number(patient_id), reason);
    res.json({ success: true, message: "Patient marked as no-show" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/recall", authenticateToken, async (req, res) => {
  try {
    const { patient_id, counterId } = req.body;
    const result = await recallPatient(Number(patient_id), counterId || null);
    res.json({
      success: true,
      message: `Patient recalled (${result.recall_count}/${result.max_recalls} recalls used)`,
      ...result
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/requeue", authenticateToken, async (req, res) => {
  try {
    const { patient_id, reason } = req.body;
    await requeuePatient(Number(patient_id), reason);
    resetAcceptState(patient_id);
    res.json({ success: true, message: "Patient re-queued successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/undo", authenticateToken, async (req, res) => {
  try {
    const { patient_id } = req.body;
    await undoPatientAction(Number(patient_id));
    resetAcceptState(patient_id);
    res.json({ success: true, message: "Action undone successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/queue/clear", authenticateToken, authorizeRole(["superadmin"]), async (_req, res) => {
  try {
    await clearTodaysQueues();
    clearAllAwaitingAccept();
    clearAllVoiceAnnouncementEvents();
    res.json({
      success: true,
      message: "Active queues were reset. Transaction history was preserved."
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/queue/export", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const patients = await getPatientsForExport({
      status: String(req.query.status || ""),
      service: String(req.query.service || ""),
      dateFilter: String(req.query.dateFilter || "today")
    });
    const csv = buildCsv(patients);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="queue_data_${new Date().toISOString().split("T")[0]}.csv"`
    );
    res.send(csv);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

router.get("/stats", async (_req, res) => {
  try {
    const data = await getQueueStats();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/display", async (_req, res) => {
  try {
    const data = await getDisplayData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/transactions", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const data = await getTransactions({
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20),
      status: String(req.query.status || ""),
      service: String(req.query.service || ""),
      dateFilter: String(req.query.dateFilter || "")
    });

    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/analytics", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const startDate = String(req.query.startDate || new Date(Date.now() - 6 * 86400000).toISOString().split("T")[0]);
    const endDate = String(req.query.endDate || today);
    const data = await getAnalytics(startDate, endDate);

    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/analytics/export", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const startDate = String(req.query.startDate || new Date(Date.now() - 6 * 86400000).toISOString().split("T")[0]);
    const endDate = String(req.query.endDate || today);
    const data = await getAnalytics(startDate, endDate);
    const csv = buildCsv(data.tableData);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="analytics_${startDate}_${endDate}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/setup/counters", async (_req, res) => {
  try {
    const result = await seedCounters();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/setup/service-type", async (req, res) => {
  try {
    const { oldValue = "technical", newValue = "doc_processing" } = req.body;
    await renameServiceType(oldValue, newValue);
    res.json({ success: true, message: "Service type updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
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
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put("/users/:id_num", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    const user = await updateUser(req.params.id_num, req.body);
    res.json({ success: true, user, message: "User updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete("/users/:id_num", authenticateToken, authorizeRole(["superadmin"]), async (req, res) => {
  try {
    await deleteUser(req.params.id_num);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
