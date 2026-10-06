import { useEffect, useState } from "react";
import SiteFrame from "../components/SiteFrame";
import { request } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { frontdeskSidebarLinks } from "../lib/frontdeskNav";

const serviceOptions = [
  { value: "consultation", label: "General Consultation" },
  { value: "checkup", label: "Medical Check-up" },
  { value: "prenatal", label: "Prenatal" },
  { value: "maternity", label: "Maternity" },
  { value: "family_planning", label: "Family Planning" }
];

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

const emptyForm = {
  firstName: "",
  middleInitial: "",
  lastName: "",
  serviceType: "",
  mobileNumber: "",
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

export default function FillUpFormPage() {
  const { user, logout } = useAuth();
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState({ type: "", text: "", queue: "", priorityScore: 0, serviceType: "" });
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [waitingCount, setWaitingCount] = useState(0);
  const [residencySuggestions, setResidencySuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    if (!message.queue) {
      return undefined;
    }

    const redirectTimer = setTimeout(() => {
      // We don't necessarily want to redirect immediately if we show a success view
      // window.location.href = `/queue-display?queue=${encodeURIComponent(message.queue)}`;
    }, 5000);

    return () => clearTimeout(redirectTimer);
  }, [message]);

  const handlePrintTicket = () => {
    const printWindow = window.open('', '_blank', 'width=300,height=600');
    const serviceLabel = serviceOptions.find(s => s.value === message.serviceType)?.label || message.serviceType;
    
    const content = `
      <html>
        <head>
          <title>Queue Ticket</title>
          <style>
            body { font-family: 'Courier New', Courier, monospace; width: 280px; margin: 0 auto; text-align: center; padding: 20px; }
            .header { font-weight: bold; font-size: 16px; margin-bottom: 5px; }
            .subheader { font-size: 12px; margin-bottom: 20px; border-bottom: 1px dashed #000; padding-bottom: 10px; }
            .queue-num { font-size: 48px; font-weight: bold; margin: 20px 0; }
            .info { font-size: 14px; margin-bottom: 10px; text-align: left; }
            .footer { font-size: 10px; margin-top: 30px; border-top: 1px dashed #000; padding-top: 10px; }
          </style>
        </head>
        <body>
          <div class="header">CHO & Family Planning Center</div>
          <div class="subheader">Cabadbaran City</div>
          <div class="info">Service: ${serviceLabel}</div>
          <div class="queue-num">${message.queue}</div>
          <div class="info">Priority Score: ${message.priorityScore}</div>
          <div class="info">Date: ${new Date().toLocaleDateString()}</div>
          <div class="info">Time: ${new Date().toLocaleTimeString()}</div>
          <div class="footer">
            Please wait for your number to be called.<br>
            Thank you for your patience.
          </div>
          <script>
            window.onload = function() { window.print(); window.close(); }
          </script>
        </body>
      </html>
    `;
    
    printWindow.document.write(content);
    printWindow.document.close();
  };

  const handleBirthdateChange = (e) => {
    const birthdate = e.target.value;
    setForm(prev => {
      const newForm = { ...prev, birthdate };
      
      // FRS-01: Automatically compute age and validate senior citizen status (>= 60)
      if (birthdate) {
        const today = new Date();
        const birthDate = new Date(birthdate);
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
          age--;
        }

        if (age >= 60) {
          if (!newForm.vulnerabilityFlags.includes("senior")) {
            newForm.vulnerabilityFlags = [...newForm.vulnerabilityFlags, "senior"];
          }
        } else {
          newForm.vulnerabilityFlags = newForm.vulnerabilityFlags.filter(f => f !== "senior");
        }
      }
      
      return newForm;
    });
  };

  const handleResidencySearch = async (query) => {
    setForm(prev => ({ ...prev, residency: query }));
    if (query.length < 3) {
      setResidencySuggestions([]);
      setShowSuggestions(false);
      return;
    }

    try {
      const data = await request(`/geocode?q=${encodeURIComponent(query)}`);
      if (Array.isArray(data)) {
        setResidencySuggestions(data);
        setShowSuggestions(data.length > 0);
      } else {
        setResidencySuggestions([]);
        setShowSuggestions(false);
      }
    } catch (error) {
      console.error("Residency search failed:", error);
      setResidencySuggestions([]);
      setShowSuggestions(false);
    }
  };

  const selectResidency = (item) => {
    setForm({ ...form, residency: item.display_name });
    setShowSuggestions(false);
  };

  async function handleSubmit(event) {
    event.preventDefault();

    const nameError = validateName(form);
    if (nameError) {
      setMessage({ type: "danger", text: nameError, queue: "" });
      return;
    }

    setIsLoading(true);
    setMessage({ type: "", text: "", queue: "" });

    try {
      const payload = {
        fullName: buildFullName(form),
        serviceType: form.serviceType,
        mobileNumber: form.mobileNumber,
        residency: form.residency,
        philhealthId: form.philhealthId,
        birthdate: form.birthdate,
        sex: form.sex,
        vulnerabilityFlags: form.vulnerabilityFlags
      };

      const data = await request("/queue/website", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (data.error) {
        setMessage({ type: "danger", text: data.error, queue: "" });
        setIsLoading(false);
        return;
      }

      // Fetch current stats to show waiting position
      try {
        const statsRes = await request("/stats");
        if (statsRes.success) {
          setWaitingCount(statsRes.data.waiting);
        }
      } catch (err) {
        console.error("Failed to fetch stats", err);
      }

      setMessage({
        type: "success",
        text: "Your queue number has been generated successfully!",
        queue: data.queue_number,
        priorityScore: data.priority_score || 0,
        serviceType: form.serviceType
      });
      setIsSuccess(true);
      setForm(emptyForm);
    } catch (error) {
      setMessage({ type: "danger", text: error.message, queue: "" });
    } finally {
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
    setForm(emptyForm);
    setMessage({ type: "", text: "", queue: "" });
  };

  return (
    <SiteFrame 
      title="City Health Queue Form" 
      icon="bi bi-people-fill" 
      welcome="Welcome"
      showSidebar={true}
      sidebarTitle="Front Desk Menu"
      sidebarLinks={frontdeskSidebarLinks("/fill-up_form")}
    >
      <div className="frontdesk-fullpage-wrapper">
        <div className="frontdesk-shell">
          <div className="frontdesk-fit-card frontdesk-form-card">
            <div className="frontdesk-card-header">
              {!isSuccess ? (
                <>
                  <h5 className="card-title fw-bold text-dark" style={{fontSize: '1rem'}}><i className="bi bi-person-plus-fill text-csu-primary"></i> Join the Queue</h5>
                  <p className="text-muted" style={{fontSize: '0.78rem'}}><i className="bi bi-clock-history me-1"></i> {new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
                </>
              ) : (
                <>
                  <h5 className="card-title fw-bold text-success"><i className="bi bi-check-circle-fill me-1"></i> Registration Complete</h5>
                  <p className="text-muted small"><i className="bi bi-ticket-detailed me-1"></i> Your queue number has been generated.</p>
                </>
              )}
            </div>

            <div className="frontdesk-card-body">
              {!isSuccess ? (
                <>
                  {message.text ? (
                    <div className={`alert alert-${message.type} text-center py-2 small`}>{message.text}</div>
                  ) : null}

                  <form onSubmit={handleSubmit}>
                    <div className="frontdesk-demographics-panel bg-light p-3 p-md-4 rounded-3 border border-secondary-subtle mb-3">
                      <div className="frontdesk-section-title">
                        <i className="bi bi-person-lines-fill"></i>
                        Patient Demographics
                      </div>
                      <div className="frontdesk-form-grid">
                      <div className="grid-full row g-2 mb-3">
                        <div className="col-12 col-md-5">
                          <label className="form-label fw-semibold small">First Name <span className="text-danger">*</span></label>
                          <input
                            type="text"
                            className="form-control form-control-sm"
                            placeholder="e.g. Juan"
                            value={form.firstName}
                            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                            maxLength={50}
                            required
                            disabled={isLoading}
                          />
                        </div>
                        <div className="col-12 col-md-2">
                          <label className="form-label fw-semibold small">Middle Initial (Optional)</label>
                          <input
                            type="text"
                            className="form-control form-control-sm"
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
                          <label className="form-label fw-semibold small">Last Name <span className="text-danger">*</span></label>
                          <input
                            type="text"
                            className="form-control form-control-sm"
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
                        <label className="form-label fw-semibold small">Mobile Number (Optional)</label>
                        <div className="input-group input-group-sm">
                          <span className="input-group-text bg-white border-end-0">+63</span>
                          <input
                            type="text"
                            className="form-control border-start-0 ps-1"
                            placeholder="9123456789"
                            value={form.mobileNumber}
                            onChange={handleMobileChange}
                            maxLength="10"
                            disabled={isLoading}
                          />
                        </div>
                      </div>

                      <div className="mb-3">
                        <label className="form-label fw-semibold small">PhilHealth / YAKAP ID (Optional)</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          placeholder="PhilHealth or YAKAP ID No."
                          value={form.philhealthId}
                          onChange={(e) => setForm({ ...form, philhealthId: e.target.value })}
                          disabled={isLoading}
                        />
                      </div>

                      <div className="mb-3">
                        <label className="form-label fw-semibold small">Sex <span className="text-danger">*</span></label>
                        <select
                          className="form-select form-select-sm"
                          value={form.sex}
                          onChange={(e) => setForm({ ...form, sex: e.target.value })}
                          required
                          disabled={isLoading}
                        >
                          <option value="">Select Sex</option>
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                        </select>
                      </div>

                      <div className="mb-3">
                        <label className="form-label fw-semibold small">Birthdate <span className="text-danger">*</span></label>
                        <input
                          type="date"
                          className="form-control form-control-sm"
                          value={form.birthdate}
                          onChange={handleBirthdateChange}
                          required
                          disabled={isLoading}
                        />
                      </div>

                      <div className="frontdesk-residency mb-3 position-relative">
                        <label className="form-label fw-semibold small">Residency / Complete Address <span className="text-danger">*</span></label>
                        <div className="input-group input-group-sm">
                          <span className="input-group-text bg-white">
                            <i className="bi bi-geo-alt-fill text-danger" />
                          </span>
                          <input
                            type="text"
                            className="form-control"
                            placeholder="Search and select barangay / city residency..."
                            value={form.residency}
                            onChange={(e) => handleResidencySearch(e.target.value)}
                            onFocus={() => residencySuggestions.length > 0 && setShowSuggestions(true)}
                            required
                            disabled={isLoading}
                            autoComplete="off"
                          />
                        </div>
                        
                        {showSuggestions && residencySuggestions.length > 0 && (
                          <div className="residency-suggestions position-absolute w-100 mt-1 bg-white border rounded shadow-sm overflow-hidden" style={{ zIndex: 1000 }}>
                            {residencySuggestions.map((item, index) => (
                              <div 
                                key={index}
                                className="px-3 py-2 small hover-bg-light cursor-pointer border-bottom text-truncate"
                                onClick={() => selectResidency(item)}
                                style={{ cursor: 'pointer' }}
                              >
                                <i className="bi bi-geo-alt me-2 text-muted" />
                                {item.display_name}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      </div>
                    </div>

                    <div className="mb-3">
                      <div className="frontdesk-section-title">
                        <i className="bi bi-hospital-fill"></i>
                        Service & Priority
                      </div>
                      <div className="frontdesk-wide-split">
                        <div className="mb-3">
                          <label className="form-label fw-semibold small">Type of Service <span className="text-danger">*</span></label>
                          <select
                            className="form-select form-select-sm"
                            value={form.serviceType}
                            onChange={(e) => setForm({ ...form, serviceType: e.target.value })}
                            required
                            disabled={isLoading}
                            suppressHydrationWarning
                          >
                            <option value="" disabled>-- Select Service --</option>
                            {serviceOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <div className="form-text text-muted mt-1 small" style={{fontSize: '0.78rem'}}>
                            <i className="bi bi-info-circle me-1"></i>
                            Assigned to doctor automatically.
                          </div>
                        </div>

                        <div className="mb-3">
                          <label className="form-label fw-semibold small">Vulnerability <span className="text-muted fw-normal">(auto-computed)</span></label>
                          <div className="frontdesk-vulnerability bg-white p-3 rounded-3 border border-secondary-subtle">
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
                                  {opt.label} <span className="text-muted">(+{opt.weight})</span>
                                </label>
                              </div>
                            ))}
                            {form.vulnerabilityFlags.length > 0 && (
                              <div className="frontdesk-vulnerability-score mt-2 small text-primary fw-semibold">
                                <i className="bi bi-calculator me-1"></i>
                                Computed Priority Score: {computePreviewScore(form.vulnerabilityFlags)}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="d-flex gap-2 mt-3 mt-md-3 justify-content-end">
                      <button 
                        type="button"
                        onClick={() => {
                          setForm(emptyForm);
                          setMessage({ text: '', type: 'success' });
                        }}
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
                <div className="frontdesk-success text-center h-100">
                  <div className="frontdesk-success-layout">
                    <div className="mb-3 mb-md-0">
                      <div className="display-1 text-success mb-2">
                        <i className="bi bi-check-circle-fill"></i>
                      </div>
                      <h3 className="fw-bold mb-1 text-dark">Registration Successful!</h3>
                      <p className="text-muted mb-0">{message.text}</p>
                    </div>

                    <div className="bg-light p-4 p-md-5 rounded-4 border border-dashed border-success mb-3">
                      <p className="text-uppercase small fw-bold text-muted mb-2">Your Queue Number</p>
                      <div className="display-2 fw-bold text-csu-primary tracking-tighter mb-3">{message.queue}</div>
                      <div className="d-flex align-items-center justify-content-center gap-3 flex-wrap mb-2">
                        <span className="badge bg-primary fs-6 px-4 py-2">
                          <i className="bi bi-star-fill me-1"></i>
                          Priority Score: {message.priorityScore}
                        </span>
                        {waitingCount > 0 && (
                          <span className="badge bg-light text-dark border px-3 py-2 small">
                            <i className="bi bi-people-fill me-1"></i>
                            {waitingCount - 1} patients ahead
                          </span>
                        )}
                      </div>
                      <p className="text-muted small mb-0 mt-2">
                        <i className="bi bi-hospital me-1"></i>
                        {message.doctorName || 'Assigned Doctor'}
                      </p>
                    </div>
                  </div>

                  <div className="d-grid gap-2 gap-md-3 d-md-flex justify-content-md-center mt-3">
                    <button 
                      onClick={handlePrintTicket}
                      className="btn btn-success py-2 py-md-3 fw-bold d-flex align-items-center justify-content-center gap-2 px-4 px-md-5"
                    >
                      <i className="bi bi-printer-fill fs-5"></i>
                      Print Thermal Ticket
                    </button>
                    <button 
                      onClick={() => window.location.href = `/queue-display?queue=${encodeURIComponent(message.queue)}`}
                      className="btn btn-csu-primary py-2 py-md-3 fw-bold px-4 px-md-5"
                    >
                      <i className="bi bi-display me-1"></i>
                      View Live Queue
                    </button>
                    <button 
                      onClick={() => setIsSuccess(false)}
                      className="btn btn-outline-secondary py-2 py-md-3 fw-semibold px-4 px-md-5"
                    >
                      <i className="bi bi-person-plus me-1"></i>
                      Register Another Patient
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {!isSuccess && (
            <p className="frontdesk-disclaimer text-muted small">
              By joining the queue, you agree to receive SMS notifications <br className="d-none d-sm-block" />
              regarding your status. Standard rates may apply.
            </p>
          )}
        </div>
      </div>
    </SiteFrame>
  );
}
