import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import SiteFrame from "../components/SiteFrame";
import DigitalQueuePass from "../components/DigitalQueuePass";
import PatientRecordSearch, { formatRecordBirthdate } from "../components/PatientRecordSearch";
import QueueTicketActions from "../components/QueueTicketActions";
import QueueTicketDialog from "../components/QueueTicketDialog";
import { request } from "../lib/api";
import { OFFERED_SERVICES } from "../lib/services";
import ResidencySearch from "../components/ResidencySearch";
import { RESIDENCY_NOT_SELECTED, normalizeResidency, parseResidency, residencyProblem } from "../lib/residency";
import { createQueueTicket, getPatientsAheadSnapshot } from "../lib/queueTicket";
import { useAuth } from "../context/AuthContext";

// The 13 Types of Services offered at registration (lib/services.js).
const serviceOptions = OFFERED_SERVICES;

const SERVICE_TO_DOCTOR = {
  consultation: "Doctor 1",
  checkup: "Doctor 1",
  prenatal: "Doctor 2",
  maternity: "Doctor 2",
  family_planning: "Doctor 3"
};

const DOCTOR_AVAILABILITY_KEYS = {
  "Doctor 1": "doctor1Online",
  "Doctor 2": "doctor2Online",
  "Doctor 3": "doctor3Online"
};

const vulnerabilityOptions = [
  { value: "senior", label: "Senior Citizen (60+)", weight: 4 },
  { value: "pwd", label: "Person with Disability (PWD)", weight: 3 },
  { value: "pregnant", label: "Pregnant", weight: 3 },
  { value: "indigenous", label: "Indigenous Person", weight: 2 },
  { value: "solo_parent", label: "Solo Parent", weight: 1 }
];

function computePreviewScore(flags) {
  const weights = { senior: 4, pwd: 3, pregnant: 3, indigenous: 2, solo_parent: 1 };
  const score = flags.reduce((s, f) => s + (weights[f] || 0), 0);
  return score === 0 ? 1 : score; // Base weight 1 for Regular
}

function getDoctorForService(serviceType) {
  return SERVICE_TO_DOCTOR[serviceType] || "Doctor 1";
}

function getDoctorOfflineMessage(doctorName) {
  return `${doctorName} is currently offline and unavailable. Please select another available doctor.`;
}

function isDoctorAvailableInSettings(settings, doctorName) {
  const key = DOCTOR_AVAILABILITY_KEYS[doctorName];
  if (!key) return true;
  return settings?.[key] !== false;
}

// D1 shared dispatch: registration assigns no doctor, so any enabled doctor counter is enough.
const SHARED_DISPATCH = "shared";
const SHARED_DOCTOR_LABEL = "Next available doctor";
// RR1 round-robin dispatch: the backend assigns the doctor; the service never chooses it.
const ROUND_ROBIN = "round_robin";
const ROUND_ROBIN_DOCTOR_LABEL = "Any available doctor — automatically assigned";
const ROUND_ROBIN_METHOD_LABEL = "Automatic round robin";
const NO_DOCTOR_AVAILABLE = "No doctor is currently available. Ask Super Admin to enable a doctor counter before registering patients.";

async function fetchDoctorAvailability(doctorName, onDispatchMode = () => {}) {
  const displayData = await request("/display");
  const counter = !displayData?.error && Array.isArray(displayData?.counters)
    ? displayData.counters.find((item) => item.id_num === doctorName || item.name === doctorName)
    : null;
  const shared = !displayData?.error && displayData?.dispatch_mode === SHARED_DISPATCH;
  if (!displayData?.error && displayData?.dispatch_strategy === ROUND_ROBIN) {
    onDispatchMode(SHARED_DISPATCH, displayData);
    return { available: true, shared: true };
  }

  if (counter && !shared) {
    return { available: counter.is_online !== false, shared: false };
  }
  if (!displayData?.error) onDispatchMode(shared ? SHARED_DISPATCH : "service", displayData);
  if (shared && Array.isArray(displayData.counters)) {
    return { available: displayData.counters.some((item) => item.is_online !== false), shared: true };
  }

  const settingsData = await request("/settings");
  if (!settingsData?.error && settingsData?.settings) {
    return { available: isDoctorAvailableInSettings(settingsData.settings, doctorName), shared: false };
  }

  return { available: true, shared: false };
}

const emptyForm = {
  firstName: "",
  middleInitial: "",
  lastName: "",
  serviceType: "",
  mobileNumber: "",
  // RES1: the Residency search bar's text, e.g. "Purok 3, Brgy. Calibunan, Cabadbaran City, Agusan del Norte".
  residency: "",
  philhealthId: "",
  birthdate: "",
  sex: "",
  vulnerabilityFlags: []
};

function cleanNamePart(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

// Stored as a single name in patients.id_num, e.g. "Juan D. Dela Cruz"
function buildFullName({ firstName, middleInitial, lastName }) {
  const initial = String(middleInitial || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return [cleanNamePart(firstName), initial ? `${initial}.` : "", cleanNamePart(lastName)]
    .filter(Boolean)
    .join(" ");
}

function validateName({ firstName, lastName }) {
  if (!cleanNamePart(firstName)) return "First Name is required.";
  if (!cleanNamePart(lastName)) return "Last Name is required.";
  return "";
}

// FRS-01: Automatically compute age and validate senior citizen status (>= 60)
function withSeniorFlag(form) {
  if (!form.birthdate) return form;
  const today = new Date();
  const birthDate = new Date(form.birthdate);
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  const others = form.vulnerabilityFlags.filter(f => f !== "senior");
  return { ...form, vulnerabilityFlags: age >= 60 ? [...others, "senior"] : others };
}

// The saved details of a selected patient record, in the form's own fields. The saved address
// is shown exactly as stored, including one saved before RES1.
function formFromRecord(record) {
  return {
    firstName: record.first_name || "",
    middleInitial: record.middle_initial || "",
    lastName: record.last_name || "",
    mobileNumber: record.mobile_number || "",
    residency: record.residency || "",
    philhealthId: record.philhealth_id || "",
    birthdate: record.birthdate || "",
    sex: record.sex || ""
  };
}

export default function FillUpFormPage() {
  const { user } = useAuth();
  const isFrontdesk = user?.id_num === "frontdesk";
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState({ type: "", text: "", queue: "", priorityScore: 0, serviceType: "" });
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [waitingCount, setWaitingCount] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [dialogTicket, setDialogTicket] = useState(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketError, setTicketError] = useState("");
  const submittingRef = useRef(false);
  const registrationSavedRef = useRef(false);
  const ticketLoadingRef = useRef(false);
  const focusFormRef = useRef(false);
  const successHeadingRef = useRef(null);
  const ticketGenerationRef = useRef(0);
  const savedPatientIdRef = useRef(null);
  const canIssueTicket = isFrontdesk || user?.role === "superadmin";
  // Staff registrations save a permanent patient record (or reuse a selected one); the API
  // enforces the same Frontdesk/Superadmin rule. Others keep the original registration.
  const canUsePatientRecords = isFrontdesk || user?.role === "superadmin";
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState(null);
  const [recordLoading, setRecordLoading] = useState(false);
  const recordRequestRef = useRef(0);
  const canIssueTicketRef = useRef(canIssueTicket);
  canIssueTicketRef.current = canIssueTicket;
  const [residencyError, setResidencyError] = useState("");
  // RES2: how the address in the bar was entered ({ chosen, place }); typing clears it.
  const [residencySelection, setResidencySelection] = useState(null);
  const [currentDate, setCurrentDate] = useState("");
  const [dispatchMode, setDispatchModeState] = useState("service");
  const sharedDispatch = dispatchMode === SHARED_DISPATCH;
  // RR1: who assigns, and the services the general doctors are approved to take (null = no limit
  // reported, as in service mode, where the backend keeps its existing routing).
  const [roundRobin, setRoundRobin] = useState(false);
  const [approvedServices, setApprovedServices] = useState(null);
  const setDispatchMode = (mode, data) => {
    setDispatchModeState(mode);
    if (data) {
      setRoundRobin(data.dispatch_strategy === ROUND_ROBIN);
      setApprovedServices(Array.isArray(data.approved_services) ? data.approved_services : null);
    }
  };
  const serviceApproved = (value) => !approvedServices || approvedServices.includes(value);

  useEffect(() => {
    // The review line names the routed doctor only when services still have fixed doctors.
    request("/display").then((data) => {
      if (!data?.error) setDispatchMode(data?.dispatch_mode === SHARED_DISPATCH ? SHARED_DISPATCH : "service", data);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Keep server and initial browser markup identical, including across midnight.
    const updateDate = () => setCurrentDate(new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Manila"
    }));
    updateDate();
    const dateTimer = setInterval(updateDate, 60000);
    return () => clearInterval(dateTimer);
  }, []);

  useEffect(() => {
    if (isSuccess) successHeadingRef.current?.focus();
    else if (focusFormRef.current) {
      focusFormRef.current = false;
      document.getElementById("patient-first-name")?.focus();
    }
  }, [isSuccess]);

  useEffect(() => {
    if (!canIssueTicket) {
      ticketGenerationRef.current += 1;
      savedPatientIdRef.current = null;
      setTicket(null);
      setDialogTicket(null);
      setWaitingCount(null);
    }
  }, [canIssueTicket]);

  function updateCurrentTicket(updated) {
    if (canIssueTicketRef.current && savedPatientIdRef.current != null && String(updated?.patientId) === String(savedPatientIdRef.current)) {
      setTicket(updated);
    }
  }

  function viewCurrentTicket(updated) {
    if (canIssueTicketRef.current && savedPatientIdRef.current != null && String(updated?.patientId) === String(savedPatientIdRef.current)) {
      setDialogTicket(updated);
    }
  }

  async function loadSavedTicket(queueNumber, captureSnapshot = false) {
    if (ticketLoadingRef.current) return;
    if (!canIssueTicketRef.current) {
      setTicketError("Ticket retrieval is available to authorized Frontdesk staff.");
      return;
    }
    const generation = ticketGenerationRef.current;
    ticketLoadingRef.current = true;
    setTicketLoading(true);
    setTicketError("");
    try {
      const data = await request("/queue");
      if (generation !== ticketGenerationRef.current || !canIssueTicketRef.current) return;
      if (data.error) throw new Error(data.error);
      // The registration response contains the saved queue number. Resolve its
      // unique record before showing a pass; never reconstruct one from form input.
      const matches = (data.patients || []).filter((row) => row.queue_number === queueNumber);
      if (matches.length !== 1) throw new Error("The saved ticket could not be found in today's queue. Check Patient Management; do not register this patient again.");
      const savedPatient = matches[0];
      savedPatientIdRef.current = savedPatient.id;
      setTicket(createQueueTicket(savedPatient, { dispatchMode: data.dispatch_mode, dispatchStrategy: data.dispatch_strategy, doctorNames: data.doctor_display_names }));
      if (captureSnapshot) setWaitingCount(getPatientsAheadSnapshot(data.patients, savedPatient, data.dispatch_mode, data.dispatch_strategy));
    } catch (error) {
      if (generation === ticketGenerationRef.current) setTicketError(error.message || "Unable to load the saved ticket. Please retry.");
    } finally {
      ticketLoadingRef.current = false;
      setTicketLoading(false);
    }
  }

  const handleBirthdateChange = (e) => {
    const birthdate = e.target.value;
    setForm(prev => withSeniorFlag({ ...prev, birthdate }));
  };

  // Reads the selected record from the server by its id and fills the form with it. Reading
  // changes nothing; the visit is only created when the form is submitted.
  async function selectPatientRecord(row) {
    if (submittingRef.current || !canUsePatientRecords) return;
    const version = ++recordRequestRef.current;
    setRecordLoading(true);
    setMessage({ type: "", text: "", queue: "" });
    let data;
    try {
      data = await request(`/patient-records/${encodeURIComponent(row.id)}`);
    } catch (error) {
      data = { error: error.message || "Unable to load the patient record. Please retry." };
    }
    if (version !== recordRequestRef.current) return;
    setRecordLoading(false);
    if (data?.error || !data?.patient) {
      setMessage({ type: "danger", text: data?.error || "Unable to load the patient record. Please retry.", queue: "" });
      return;
    }
    setResidencyError("");
    setResidencySelection(null);
    setDuplicateCandidates(null);
    setSelectedPatient(data.patient);
    setForm(prev => withSeniorFlag({ ...prev, ...formFromRecord(data.patient) }));
  }

  // Back to a new patient: the record's details leave the form; the visit choices stay.
  function clearSelectedPatient() {
    if (submittingRef.current) return;
    recordRequestRef.current += 1;
    setRecordLoading(false);
    setSelectedPatient(null);
    setResidencySelection(null);
    setForm(prev => ({ ...emptyForm, serviceType: prev.serviceType, vulnerabilityFlags: prev.vulnerabilityFlags.filter(f => f !== "senior") }));
  }

  const handleResidencyChange = (text, selection) => {
    setForm(prev => ({ ...prev, residency: text }));
    setResidencySelection(selection || null);
    setResidencyError("");
  };

  async function handleSubmit(event, { confirmNewRecord = false } = {}) {
    event.preventDefault();
    if (submittingRef.current || registrationSavedRef.current || isSuccess || recordLoading) return;

    const nameError = validateName(form);
    if (nameError) {
      setMessage({ type: "danger", text: nameError, queue: "" });
      return;
    }
    // A returning patient's stored address is used as saved, so only a new address is checked.
    if (!selectedPatient) {
      const problem = residencyProblem(form.residency) || (residencySelection?.chosen ? "" : RESIDENCY_NOT_SELECTED);
      setResidencyError(problem);
      if (problem) {
        setMessage({ type: "", text: "", queue: "" });
        if (typeof document !== "undefined") document.getElementById("patient-residency")?.focus();
        return;
      }
    }
    if (!form.serviceType) {
      setMessage({ type: "danger", text: "Please select a service.", queue: "" });
      return;
    }

    submittingRef.current = true;
    ticketGenerationRef.current += 1;
    savedPatientIdRef.current = null;
    setIsLoading(true);
    setMessage({ type: "", text: "", queue: "" });

    try {
      const routedDoctor = getDoctorForService(form.serviceType);
      const { available, shared } = await fetchDoctorAvailability(routedDoctor, setDispatchMode);
      const doctorName = shared ? SHARED_DOCTOR_LABEL : routedDoctor;
      if (!available) {
        setMessage({ type: "danger", text: shared ? NO_DOCTOR_AVAILABLE : getDoctorOfflineMessage(doctorName), queue: "" });
        return;
      }

      let route = "/queue/website";
      let payload = {
        fullName: buildFullName(form),
        serviceType: form.serviceType,
        mobileNumber: form.mobileNumber,
        residency: normalizeResidency(form.residency),
        philhealthId: form.philhealthId,
        birthdate: form.birthdate,
        sex: form.sex,
        vulnerabilityFlags: form.vulnerabilityFlags
      };
      if (canUsePatientRecords) {
        route = "/patient-records/visits";
        // A selected patient is identified by record id only; the server uses the stored
        // details, so the permanent record is never overwritten from this form.
        payload = selectedPatient
          ? { patientRecordId: selectedPatient.id, serviceType: form.serviceType, vulnerabilityFlags: form.vulnerabilityFlags }
          : {
              firstName: cleanNamePart(form.firstName),
              middleInitial: form.middleInitial,
              lastName: cleanNamePart(form.lastName),
              serviceType: form.serviceType,
              mobileNumber: form.mobileNumber,
              residency: normalizeResidency(form.residency),
              // Proof that a map place was verified by the backend; it decides map vs manual itself.
              ...(residencySelection?.place?.token ? { residencyPlaceToken: residencySelection.place.token } : {}),
              philhealthId: form.philhealthId,
              birthdate: form.birthdate,
              sex: form.sex,
              vulnerabilityFlags: form.vulnerabilityFlags,
              ...(confirmNewRecord ? { confirmNewRecord: true } : {})
            };
      }

      const data = await request(route, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (data.error) {
        const details = data.details || {};
        if (Array.isArray(details.possible_duplicates) && details.possible_duplicates.length) {
          // Shown as its own choice below the form instead of a plain error.
          setDuplicateCandidates(details.possible_duplicates);
          setMessage({ type: "", text: "", queue: "" });
        } else if (details.patient_record) {
          // The new record was saved but its visit was not: retrying registers against it.
          setSelectedPatient(details.patient_record);
          setDuplicateCandidates(null);
          setMessage({ type: "danger", text: `Patient record ${details.patient_record.patient_code} was saved, but no queue number was generated: ${data.error} Submit again to register this visit.`, queue: "" });
        } else {
          setMessage({ type: "danger", text: data.error, queue: "" });
        }
        setIsLoading(false);
        return;
      }

      registrationSavedRef.current = true;
      // RR1: the doctor the round robin assigned at submit, "Name (Doctor N)" when a display name is set.
      const assignedDoctor = typeof data.assigned_doctor === "string" && data.assigned_doctor.trim() ? data.assigned_doctor.trim() : "";
      const assignedDoctorName = typeof data.assigned_doctor_name === "string" ? data.assigned_doctor_name.trim() : "";
      const assignedDoctorLabel = assignedDoctor ? (assignedDoctorName ? `${assignedDoctorName} (${assignedDoctor})` : assignedDoctor) : "";
      setMessage({
        type: "success",
        text: "Your queue number has been generated successfully!",
        queue: data.queue_number,
        priorityScore: data.priority_score || 0,
        serviceType: form.serviceType,
        doctorName: assignedDoctorLabel || doctorName,
        assignedDoctor: assignedDoctorLabel,
        patientCode: data.patient_record?.patient_code || "",
        recordCreated: Boolean(data.patient_record_created)
      });
      setIsSuccess(true);
      setForm(emptyForm);
      setSelectedPatient(null);
      setDuplicateCandidates(null);
      setResidencyError("");
      setResidencySelection(null);
      // A retrieval failure must not turn a committed registration into a
      // submission error, which could cause an accidental duplicate patient.
      await loadSavedTicket(data.queue_number, true);
    } catch (error) {
      setMessage({ type: "danger", text: error.message, queue: "" });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  }

  const handleMobileChange = (e) => {
    const value = e.target.value.replace(/[^0-9]/g, "");
    setForm({ ...form, mobileNumber: value });
  };

  const handleVulnerabilityToggle = (flag) => {
    const flags = form.vulnerabilityFlags.includes(flag)
      ? form.vulnerabilityFlags.filter(f => f !== flag)
      : [...form.vulnerabilityFlags, flag];
    setForm({ ...form, vulnerabilityFlags: flags });
  };

  const resetForm = () => {
    if (submittingRef.current || ticketLoadingRef.current) return;
    setForm(emptyForm);
    recordRequestRef.current += 1;
    setRecordLoading(false);
    setSelectedPatient(null);
    setDuplicateCandidates(null);
    setMessage({ type: "", text: "", queue: "" });
    setIsSuccess(false);
    ticketGenerationRef.current += 1;
    savedPatientIdRef.current = null;
    focusFormRef.current = true;
    registrationSavedRef.current = false;
    setTicket(null);
    setDialogTicket(null);
    setTicketError("");
    setWaitingCount(null);
    setResidencyError("");
    setResidencySelection(null);
  };

  return (
    <SiteFrame
      contentClassName="frontdesk-page"
    >
      <div className="frontdesk-fullpage-wrapper">
        <div className="frontdesk-shell">
          <div className="frontdesk-fit-card frontdesk-form-card">
            <div className={`frontdesk-card-header${isSuccess ? " registration-success-header" : ""}`}>
              {!isSuccess ? (
                <>
                  <h5 className="card-title fw-bold brand-text" style={{fontSize: '1rem'}}><i className="bi bi-person-plus-fill text-csu-primary"></i> Join the Queue</h5>
                  <p className="brand-text-muted" style={{fontSize: '0.78rem'}}><i className="bi bi-clock-history me-1"></i> {currentDate}</p>
                </>
              ) : (
                // The only success message on this screen.
                <div className="registration-success-title" role="status">
                  <i className="bi bi-check-circle-fill" aria-hidden="true" />
                  <div>
                    <h2 ref={successHeadingRef} tabIndex={-1}>Patient registered successfully.</h2>
                    <p>Print the ticket, then register the next patient.</p>
                    {message.assignedDoctor ? (
                      <p className="registration-patient-code" data-assigned-doctor>Assigned doctor: {message.assignedDoctor}</p>
                    ) : null}
                    {message.patientCode ? (
                      <p className="registration-patient-code">Patient ID {message.patientCode} · {message.recordCreated ? "new patient record saved" : "returning patient"}</p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>

            <div className="frontdesk-card-body">
              {!isSuccess ? (
                <>
                  {message.text ? (
                    <div role="alert" className={`alert alert-${message.type} text-center py-2 small`}>{message.text}</div>
                  ) : null}

                  {canUsePatientRecords ? (
                    <PatientRecordSearch onSelect={selectPatientRecord} disabled={isLoading || recordLoading} selectedId={selectedPatient?.id ?? null} />
                  ) : null}

                  <form onSubmit={handleSubmit}>
                    <div className="frontdesk-demographics-panel brand-bg-subtle p-3 p-md-4 rounded-3 border brand-border mb-3">
                      <h2 className="frontdesk-section-title">
                        <i className="bi bi-person-lines-fill"></i>
                        Patient Information
                      </h2>
                      {recordLoading ? <p className="patient-record-status" role="status">Loading the patient record…</p> : null}
                      {selectedPatient ? (
                        <div className="patient-record-selected" role="status">
                          <div>
                            <p className="patient-record-selected-name">Returning patient: {selectedPatient.full_name}</p>
                            <p>Patient ID <strong>{selectedPatient.patient_code}</strong> · Born {formatRecordBirthdate(selectedPatient.birthdate)} · {selectedPatient.sex || "Sex not recorded"}</p>
                            <p className="patient-record-selected-note">Saved details are filled in from the patient record and are not edited here. Verify the patient&apos;s identity, then choose this visit&apos;s service.</p>
                          </div>
                          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={clearSelectedPatient} disabled={isLoading}>
                            Change Patient
                          </button>
                        </div>
                      ) : null}
                      <div className="frontdesk-form-grid">
                      <div className="grid-full row g-2 mb-3">
                        <div className="col-12 col-md-5">
                          <label htmlFor="patient-first-name" className="brand-text form-label fw-semibold small">First Name <span className="text-danger">*</span></label>
                          <input
                            id="patient-first-name"
                            readOnly={Boolean(selectedPatient)}
                            type="text"
                            className="brand-input form-control form-control-sm"
                            placeholder="e.g. Juan"
                            value={form.firstName}
                            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                            maxLength={50}
                            required
                            disabled={isLoading}
                          />
                        </div>
                        <div className="col-12 col-md-2">
                          <label htmlFor="patient-middle-initial" className="brand-text form-label fw-semibold small">Middle Initial (Optional)</label>
                          <input
                            id="patient-middle-initial"
                            readOnly={Boolean(selectedPatient)}
                            type="text"
                            className="brand-input form-control form-control-sm"
                            placeholder="e.g. D"
                            value={form.middleInitial}
                            onChange={(e) =>
                              setForm({ ...form, middleInitial: e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase() })
                            }
                            maxLength={2}
                            disabled={isLoading}
                          />
                        </div>
                        <div className="col-12 col-md-5">
                          <label htmlFor="patient-last-name" className="brand-text form-label fw-semibold small">Last Name <span className="text-danger">*</span></label>
                          <input
                            id="patient-last-name"
                            readOnly={Boolean(selectedPatient)}
                            type="text"
                            className="brand-input form-control form-control-sm"
                            placeholder="e.g. Dela Cruz"
                            value={form.lastName}
                            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                            maxLength={50}
                            required
                            disabled={isLoading}
                          />
                        </div>
                      </div>

                      <div className="mb-3">
                        <label htmlFor="patient-mobile" className="brand-text form-label fw-semibold small">Mobile Number (Optional)</label>
                        <div className="input-group input-group-sm">
                          <span className="input-group-text brand-border bg-white border-end-0">+63</span>
                          <input
                            id="patient-mobile"
                            readOnly={Boolean(selectedPatient)}
                            type="text"
                            className="brand-input form-control border-start-0 ps-1"
                            placeholder="9123456789"
                            value={form.mobileNumber}
                            onChange={handleMobileChange}
                            maxLength="10"
                            disabled={isLoading}
                          />
                        </div>
                      </div>

                      <div className="mb-3">
                        <label htmlFor="patient-philhealth" className="brand-text form-label fw-semibold small">PhilHealth / YAKAP ID (Optional)</label>
                        <input
                          id="patient-philhealth"
                          readOnly={Boolean(selectedPatient)}
                          type="text"
                          className="brand-input form-control form-control-sm"
                          placeholder="PhilHealth or YAKAP ID No."
                          value={form.philhealthId}
                          onChange={(e) => setForm({ ...form, philhealthId: e.target.value })}
                          disabled={isLoading}
                        />
                      </div>

                      <div className="mb-3">
                        <label htmlFor="patient-sex" className="brand-text form-label fw-semibold small">Sex <span className="text-danger">*</span></label>
                        <select
                          id="patient-sex"
                          className="brand-input form-select form-select-sm"
                          value={form.sex}
                          onChange={(e) => setForm({ ...form, sex: e.target.value })}
                          required
                          disabled={isLoading || Boolean(selectedPatient)}
                        >
                          <option value="">Select Sex</option>
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                        </select>
                      </div>

                      <div className="mb-3">
                        <label htmlFor="patient-birthdate" className="brand-text form-label fw-semibold small">Birthdate <span className="text-danger">*</span></label>
                        <input
                          id="patient-birthdate"
                          readOnly={Boolean(selectedPatient)}
                          type="date"
                          className="brand-input form-control form-control-sm"
                          value={form.birthdate}
                          onChange={handleBirthdateChange}
                          required
                          disabled={isLoading}
                        />
                      </div>

                      <div className="frontdesk-residency mb-3">
                        <ResidencySearch
                          id="patient-residency"
                          labelClassName="brand-text form-label fw-semibold small"
                          value={form.residency}
                          selection={residencySelection}
                          onChange={handleResidencyChange}
                          mapSearch={canUsePatientRecords}
                          error={residencyError}
                          disabled={isLoading}
                          readOnly={Boolean(selectedPatient)}
                          notice={selectedPatient && !parseResidency(selectedPatient.residency) ? (
                            // Saved before RES1, or outside Cabadbaran City: shown and kept exactly as stored.
                            <p className="form-text small text-warning-emphasis mb-0">
                              <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
                              {selectedPatient.residency ? "This saved address is not a Cabadbaran City barangay address." : "No address is saved for this patient."} It is kept unchanged and this visit can still be registered. Report patient {selectedPatient.patient_code} to the administrator for address review.
                            </p>
                          ) : null}
                        />
                      </div>
                      </div>
                    </div>

                    <div className="mb-3">
                      <div className="frontdesk-wide-split">
                        <div className="mb-3">
                          <h2 className="frontdesk-section-title"><i className="bi bi-hospital-fill" aria-hidden="true" /> Service Selection</h2>
                          <label htmlFor="patient-service" className="brand-text form-label fw-semibold small">Type of Service <span className="text-danger">*</span></label>
                          <select
                            id="patient-service"
                            className="brand-input form-select form-select-sm"
                            value={form.serviceType}
                            onChange={(e) => setForm({ ...form, serviceType: e.target.value })}
                            required
                            disabled={isLoading}
                            suppressHydrationWarning
                          >
                            <option value="" disabled>-- Select Service --</option>
                            {serviceOptions.map((option) => (
                              <option key={option.value} value={option.value} disabled={!serviceApproved(option.value)}>
                                {option.label}{serviceApproved(option.value) ? "" : " (not yet approved for general doctors)"}
                              </option>
                            ))}
                          </select>
                          <div className="form-text brand-text-muted mt-1 small" style={{fontSize: '0.78rem'}}>
                            <i className="bi bi-info-circle me-1"></i>
                            Assigned to doctor automatically.
                          </div>
                        </div>

                        <div className="mb-3">
                          <h2 className="frontdesk-section-title"><i className="bi bi-star" aria-hidden="true" /> Priority Classification</h2>
                          <label className="brand-text form-label fw-semibold small">Vulnerability <span className="brand-text-muted fw-normal">(auto-computed)</span></label>
                          <div className="frontdesk-vulnerability bg-white p-3 rounded-3 border brand-border">
                            {vulnerabilityOptions.map((opt) => (
                              <div className="form-check form-check-inline mb-1" key={opt.value}>
                                <input
                                  className="form-check-input"
                                  type="checkbox"
                                  id={`vuln-${opt.value}`}
                                  value={opt.value}
                                  checked={form.vulnerabilityFlags.includes(opt.value)}
                                  onChange={() => handleVulnerabilityToggle(opt.value)}
                                  disabled={isLoading}
                                />
                                <label className="form-check-label small" htmlFor={`vuln-${opt.value}`}>
                                  {opt.label} <span className="brand-text-muted">(+{opt.weight})</span>
                                </label>
                              </div>
                            ))}
                            {form.vulnerabilityFlags.length > 0 && (
                              <div className="frontdesk-vulnerability-score mt-2 small brand-text-primary fw-semibold">
                                <i className="bi bi-calculator me-1"></i>
                                Computed Priority Score: {computePreviewScore(form.vulnerabilityFlags)}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <section className="registration-review" aria-labelledby="registration-review-title">
                      <h3 id="registration-review-title">Review and Submit</h3>
                      {roundRobin ? (
                        <>
                          <p>{buildFullName(form) || "Enter the patient information above."}{selectedPatient ? ` (${selectedPatient.patient_code})` : ""}</p>
                          <p data-review-service>Service: {serviceOptions.find((option) => option.value === form.serviceType)?.label || "Select a service"}</p>
                          <p data-review-doctor>Doctor assignment: {ROUND_ROBIN_DOCTOR_LABEL}</p>
                          <p data-review-method>Assignment method: {ROUND_ROBIN_METHOD_LABEL}</p>
                        </>
                      ) : (
                        <p>{buildFullName(form) || "Enter the patient information above."}{selectedPatient ? ` (${selectedPatient.patient_code})` : ""} · {serviceOptions.find((option) => option.value === form.serviceType)?.label || "Select a service"}{form.serviceType ? ` · ${sharedDispatch ? SHARED_DOCTOR_LABEL : getDoctorForService(form.serviceType)}` : ""}</p>
                      )}
                      <p className="registration-review-note">Check the patient details and classification before generating one queue number.</p>
                    </section>
                    {duplicateCandidates ? (
                      <div role="alert" className="alert alert-warning small patient-record-duplicates">
                        <p className="fw-semibold mb-1">A patient record with the same name, sex and birthdate already exists.</p>
                        <p className="mb-2">If this is the same person, select the existing record. Register a new record only for a different person.</p>
                        <ul className="list-unstyled mb-2">
                          {duplicateCandidates.map((candidate) => (
                            <li key={candidate.id} className="d-flex flex-wrap align-items-center gap-2 mb-1">
                              <span>{candidate.full_name} · <strong>{candidate.patient_code}</strong> · Born {formatRecordBirthdate(candidate.birthdate)} · {candidate.sex || "Sex not recorded"}</span>
                              <button type="button" className="btn btn-sm btn-csu-primary" onClick={() => selectPatientRecord(candidate)} disabled={isLoading || recordLoading}>
                                Select {candidate.patient_code}
                              </button>
                            </li>
                          ))}
                        </ul>
                        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={(event) => handleSubmit(event, { confirmNewRecord: true })} disabled={isLoading || recordLoading}>
                          Register as a Different Person
                        </button>
                      </div>
                    ) : null}
                    <div className="d-flex gap-2 mt-3 mt-md-3 justify-content-end">
                      <button 
                        type="button"
                        onClick={resetForm}
                        className="btn btn-outline-secondary py-1.5 rounded fw-semibold px-3"
                        disabled={isLoading}
                      >
                        <i className="bi bi-arrow-counterclockwise me-1"></i>
                        Clear
                      </button>
                      <button 
                        type="submit" 
                        className="btn btn-csu-primary py-1.5 rounded fw-bold px-4 d-flex align-items-center justify-content-center gap-2"
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <>
                            <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                            Processing...
                          </>
                        ) : (
                          <>
                            <i className="bi bi-ticket-perforated-fill" />
                            Generate Queue Number
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <div className="registration-complete">
                  <div className="registration-ticket-layout">
                    {/* Left: the saved ticket exactly as it is printed, photographed or downloaded. */}
                    <section className="registration-ticket-preview" aria-labelledby="ticket-preview-title">
                      <div className="registration-preview-heading">
                        <h3 id="ticket-preview-title">Ticket preview</h3>
                        <span className="registration-saved-badge"><i className="bi bi-lock" aria-hidden="true" /> Saved copy</span>
                      </div>
                      {ticket && canIssueTicket ? (
                        <div className="registration-pass-frame"><DigitalQueuePass ticket={ticket} /></div>
                      ) : (
                        <div className="registration-ticket-fallback" aria-live="polite">
                          <p className="registration-saved-number">Saved queue number <strong>{message.queue}</strong></p>
                          <p>{ticketLoading ? "Loading the saved queue ticket…" : "Load the saved ticket to view or print it."}</p>
                          <button type="button" className="registration-button" disabled={ticketLoading || !canIssueTicket} onClick={() => loadSavedTicket(message.queue)}>
                            {ticketLoading ? "Loading…" : "Retry Loading Ticket"}
                          </button>
                        </div>
                      )}
                      {ticketError ? <p role="alert" className="registration-ticket-error">{ticketError}</p> : null}
                    </section>

                    {/* Right: deliver the ticket, then move on to the next patient. */}
                    <section className="registration-actions-panel" aria-labelledby="ticket-delivery-title">
                      <div className="registration-delivery">
                        <h3 id="ticket-delivery-title">Deliver the ticket</h3>
                        <p>Print the thermal ticket. The digital pass and image show the same saved queue number.</p>
                        {ticket && canIssueTicket ? (
                          <QueueTicketActions ticket={ticket} primaryAction="print" onView={viewCurrentTicket} onTicketUpdate={updateCurrentTicket} />
                        ) : <p>{ticketLoading ? "Preparing ticket actions…" : canIssueTicket ? "Ticket actions appear once the saved ticket loads." : "Ticket delivery is available to authorized Frontdesk staff."}</p>}
                      </div>

                      {waitingCount !== null && canIssueTicket ? (
                        <div className="registration-snapshot">
                          <p className="registration-snapshot-title"><i className="bi bi-clock-history" aria-hidden="true" /> Registration snapshot</p>
                          <p><strong>{waitingCount} waiting {waitingCount === 1 ? "patient" : "patients"} ahead</strong> in {sharedDispatch && !(roundRobin && message.assignedDoctor) ? "the shared queue" : `${ticket?.doctorName}'s queue`} when this patient was registered. Priority arrivals and queue activity can change the order.</p>
                        </div>
                      ) : null}

                      <div className="registration-next">
                        <button type="button" onClick={resetForm} disabled={isLoading || ticketLoading} className="registration-button registration-button--next">
                          <i className="bi bi-person-plus" aria-hidden="true" /> Register Another Patient
                        </button>
                        <nav className="registration-links" aria-label="Other Frontdesk pages">
                          <Link href="/patient-management" className="registration-link">
                            <i className="bi bi-people" aria-hidden="true" /> Patient Management
                          </Link>
                          <Link href="/queue-display" className="registration-link">
                            <i className="bi bi-display" aria-hidden="true" /> View Live Queue
                          </Link>
                        </nav>
                      </div>
                    </section>
                  </div>
                </div>
              )}
            </div>
          </div>

          {!isSuccess && (
            <p className="frontdesk-disclaimer brand-text-muted small">
              Review the patient details before submitting. A lost ticket can be retrieved through Patient Management.
            </p>
          )}
        </div>
      </div>
      {dialogTicket && canIssueTicket ? <QueueTicketDialog ticket={dialogTicket} onClose={() => setDialogTicket(null)} onTicketUpdate={updateCurrentTicket} /> : null}
    </SiteFrame>
  );
}
