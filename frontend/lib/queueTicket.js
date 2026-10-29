import { request } from "./api";
import { SYSTEM_BRANDING } from "./branding";

const SERVICE_LABELS = {
  consultation: "General Consultation",
  checkup: "Medical Check-up",
  prenatal: "Prenatal",
  maternity: "Maternity",
  family_planning: "Family Planning",
  laboratory: "Laboratory",
  dental: "Dental",
  obgyne: "Obstetrics and Gynecology"
};
const STATUS_LABELS = {
  waiting: "Waiting",
  serving: "Called / in service",
  completed: "Completed",
  cancelled: "Cancelled",
  "no-show": "No-show"
};
export const QUEUE_PASS_WIDTH = 760;
export const QUEUE_PASS_HEIGHT = 820;

// D1: the backend's dispatch_mode. In "shared" dispatch (provisional) a waiting visit has no
// doctor until it is called; any available general doctor may take it.
export const SHARED_DISPATCH = "shared";
export const NEXT_AVAILABLE_DOCTOR = "Next available doctor";

// Mirror the existing backend service mapping; this is display information only.
function doctorForService(service) {
  if (service === "prenatal" || service === "maternity") return "Doctor 2";
  if (service === "family_planning") return "Doctor 3";
  return "Doctor 1";
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

/** Deliberately whitelist ticket data; never carry the patient row into exports. */
export function createQueueTicket(patient, { dispatchMode } = {}) {
  if (!patient || patient.id == null || !String(patient.id).trim() || !patient.queue_number) {
    throw new Error("The saved patient record does not have a queue ticket.");
  }
  const registeredAt = new Date(patient.created_at);
  const validDate = patient.created_at && Number.isFinite(registeredAt.getTime());
  const knownStatus = Object.prototype.hasOwnProperty.call(STATUS_LABELS, patient.status);
  // The stored doctor once called; before that the service's doctor, or none in shared dispatch.
  const assignedDoctor = ["Doctor 1", "Doctor 2", "Doctor 3"].includes(patient.counter_id)
    ? patient.counter_id : dispatchMode === SHARED_DISPATCH ? NEXT_AVAILABLE_DOCTOR : doctorForService(patient.service_type);
  return {
    patientId: patient.id,
    queueNumber: String(patient.queue_number),
    serviceLabel: SERVICE_LABELS[patient.service_type] || "Service unavailable",
    doctorName: assignedDoctor,
    registeredDate: validDate ? registeredAt.toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila"
    }) : "Unavailable",
    registeredTime: validDate ? registeredAt.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Manila"
    }) : "Unavailable",
    status: knownStatus ? patient.status : "unknown",
    statusLabel: knownStatus ? STATUS_LABELS[patient.status] : "Status unavailable",
    isActive: patient.status === "waiting" || patient.status === "serving"
  };
}

/** Waiting-only snapshot of the backend's WPS order, scoped to its service doctor (or the whole
 * shared queue in shared dispatch). */
export function getPatientsAheadSnapshot(rows, patient, dispatchMode) {
  if (!Array.isArray(rows) || patient?.status !== "waiting") return null;
  const doctor = doctorForService(patient.service_type);
  const sameQueue = (row) => dispatchMode === SHARED_DISPATCH || doctorForService(row.service_type) === doctor;
  const waiting = rows.filter(row => row.status === "waiting" && sameQueue(row))
    .slice().sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) ||
      new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id));
  const index = waiting.findIndex(row => sameId(row.id, patient.id));
  return index < 0 ? null : index;
}

/** Existing authenticated /queue read only. A missing ID never becomes a new ticket. */
export async function fetchExistingQueueTicket(patientId) {
  if (patientId == null || !String(patientId).trim()) throw new Error("A saved patient ID is required.");
  const data = await request("/queue");
  if (data?.error) throw new Error(data.error);
  if (!Array.isArray(data?.patients)) throw new Error("Ticket information could not be verified. Please retry.");
  const patient = data.patients.find(row => sameId(row.id, patientId));
  if (!patient) throw new Error("This ticket is no longer available in today's patient queue. No new registration was created.");
  return createQueueTicket(patient, { dispatchMode: data.dispatch_mode });
}

export function escapeTicketText(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

export function queueTicketFilename(queueNumber) {
  const safeNumber = String(queueNumber || "ticket").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return `Queue-Ticket-${safeNumber || "ticket"}.png`;
}

// One SVG drawing powers the on-screen component and the exported PNG.
export function queuePassSvgContents(ticket, logoHref = SYSTEM_BRANDING.logoSrc) {
  if (!ticket) throw new Error("A saved ticket is required.");
  const esc = escapeTicketText;
  const numberSize = Math.min(132, Math.max(34, 1060 / Math.max(1, ticket.queueNumber.length)));
  const active = ticket.isActive;
  const statusColor = active ? "#0b3d2e" : "#7c2d12";
  const statusBackground = active ? "#eaf4ed" : "#fff0e8";
  const serviceSize = ticket.serviceLabel.length > 23 ? 32 : 38;
  return `
    <rect x="1" y="1" width="758" height="818" rx="28" fill="#ffffff" stroke="#a6c4b0" stroke-width="2"/>
    <path d="M29 1 H731 Q759 1 759 29 V140 H1 V29 Q1 1 29 1" fill="#0b3d2e"/>
    <circle cx="83" cy="70" r="47" fill="#ffffff"/>
    <image href="${esc(logoHref)}" x="40" y="27" width="86" height="86" preserveAspectRatio="xMidYMid meet"/>
    <g font-family="Arial, Helvetica, sans-serif">
      <text x="150" y="59" fill="#ffffff" font-size="30" font-weight="700">CITY HEALTH OFFICE</text>
      <text x="150" y="96" fill="#ffffff" font-size="22">Family Planning Center · Cabadbaran City</text>
      <text x="380" y="200" text-anchor="middle" fill="#355347" font-size="26" font-weight="700" letter-spacing="3">YOUR QUEUE NUMBER</text>
      <text x="380" y="340" text-anchor="middle" fill="#167d3f" font-size="${numberSize}" font-weight="800">${esc(ticket.queueNumber)}</text>
      <rect x="48" y="371" width="664" height="139" rx="18" fill="#f1f7f3"/>
      <text x="380" y="410" text-anchor="middle" fill="#355347" font-size="22" font-weight="700">SERVICE</text>
      <text x="380" y="456" text-anchor="middle" fill="#0b3d2e" font-size="${serviceSize}" font-weight="700">${esc(ticket.serviceLabel)}</text>
      <text x="380" y="492" text-anchor="middle" fill="#355347" font-size="25">${ticket.doctorName === NEXT_AVAILABLE_DOCTOR ? "Doctor assigned when called" : `Assigned to ${esc(ticket.doctorName)}`}</text>
      <path d="M25 549 H735" fill="none" stroke="#9cb9a7" stroke-width="2" stroke-dasharray="9 9"/>
      <circle cx="1" cy="549" r="14" fill="#f6f8f7"/><circle cx="759" cy="549" r="14" fill="#f6f8f7"/>
      <text x="48" y="598" fill="#355347" font-size="22" font-weight="700">REGISTERED · PHT</text>
      <text x="48" y="640" fill="#0b3d2e" font-size="31" font-weight="700">${esc(ticket.registeredDate)}</text>
      <text x="48" y="678" fill="#355347" font-size="28">${esc(ticket.registeredTime)}</text>
      <rect x="400" y="575" width="312" height="118" rx="16" fill="${statusBackground}"/>
      <text x="556" y="614" text-anchor="middle" fill="${statusColor}" font-size="22" font-weight="700">TICKET STATUS</text>
      <text x="556" y="655" text-anchor="middle" fill="${statusColor}" font-size="${ticket.statusLabel.length > 16 ? 25 : 31}" font-weight="700">${esc(ticket.statusLabel)}</text>
      <text x="380" y="744" text-anchor="middle" fill="${statusColor}" font-size="24" font-weight="700">${active ? "Watch the live queue for your number." : "INACTIVE TICKET · No new queue position"}</text>
      <text x="380" y="785" text-anchor="middle" fill="#355347" font-size="20">Saved ticket snapshot · Photos and downloads do not update</text>
    </g>`;
}

export function createQueuePassSvg(ticket, logoHref = SYSTEM_BRANDING.logoSrc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${QUEUE_PASS_WIDTH}" height="${QUEUE_PASS_HEIGHT}" viewBox="0 0 ${QUEUE_PASS_WIDTH} ${QUEUE_PASS_HEIGHT}">${queuePassSvgContents(ticket, logoHref)}</svg>`;
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The official logo could not be read."));
    reader.readAsDataURL(blob);
  });
}

export async function downloadQueueTicket(ticket, { isCancelled = () => false } = {}) {
  if (isCancelled()) return false;
  const logoUrl = new URL(SYSTEM_BRANDING.logoSrc, window.location.origin);
  if (logoUrl.origin !== window.location.origin) throw new Error("The ticket logo must be served by this application.");
  const response = await fetch(logoUrl.href, { credentials: "same-origin" });
  if (!response.ok) throw new Error("The official logo could not be loaded. Please retry the download.");
  const logo = await blobDataUrl(await response.blob());
  if (isCancelled()) return false;
  const svgBlob = new Blob([createQueuePassSvg(ticket, logo)], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const graphic = new Image();
    await new Promise((resolve, reject) => {
      graphic.onload = resolve;
      graphic.onerror = () => reject(new Error("The ticket image could not be generated."));
      graphic.src = svgUrl;
    });
    if (isCancelled()) return false;
    const canvas = document.createElement("canvas");
    canvas.width = QUEUE_PASS_WIDTH * 3;
    canvas.height = QUEUE_PASS_HEIGHT * 3;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image download is unavailable in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(graphic, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The PNG image could not be created.")), "image/png"));
    if (isCancelled()) return false;
    const pngUrl = URL.createObjectURL(png);
    const link = document.createElement("a");
    link.href = pngUrl;
    link.download = queueTicketFilename(ticket.queueNumber);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser time to consume the download URL, without storing the image.
    window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
    return true;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

export function openThermalTicketWindow() {
  const popup = window.open("", "_blank", "width=300,height=600");
  if (!popup) throw new Error("Allow pop-ups for this application to print the thermal ticket.");
  return popup;
}

export function thermalTicketHtml(ticket) {
  const esc = escapeTicketText;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Queue Ticket ${esc(ticket.queueNumber)}</title>
    <style>body{font-family:'Courier New',Courier,monospace;width:280px;margin:0 auto;text-align:center;padding:20px}.header{font-weight:bold;font-size:16px;margin-bottom:5px}.subheader{font-size:12px;margin-bottom:20px;border-bottom:1px dashed #000;padding-bottom:10px}.queue-num{font-size:48px;font-weight:bold;margin:20px 0;overflow-wrap:anywhere}.info{font-size:14px;margin-bottom:10px;text-align:left}.footer{font-size:10px;margin-top:30px;border-top:1px dashed #000;padding-top:10px}.inactive{font-weight:bold;border:1px solid #000;padding:8px}</style></head>
    <body><div class="header">CHO &amp; Family Planning Center</div><div class="subheader">Cabadbaran City</div>
    <div class="info">Service: ${esc(ticket.serviceLabel)}</div><div class="queue-num">${esc(ticket.queueNumber)}</div>
    <div class="info">Assigned: ${esc(ticket.doctorName)}</div><div class="info">Registered: ${esc(ticket.registeredDate)}</div><div class="info">Time: ${esc(ticket.registeredTime)} PHT</div>
    <div class="info">Status: ${esc(ticket.statusLabel)}</div>${ticket.isActive ? "" : '<div class="inactive">INACTIVE TICKET<br>No new queue position</div>'}
    <div class="footer">${ticket.isActive ? "Please watch the live queue for your number.<br>Thank you for your patience." : "Copy of the original ticket. This is not a new waiting ticket."}<br>Saved ticket snapshot; status may change.</div>
    <script>window.onload=function(){window.print();window.close();};</script></body></html>`;
}

export function printQueueTicket(ticket, printWindow) {
  const popup = printWindow || openThermalTicketWindow();
  if (popup.closed) throw new Error("The print window was closed. Please select Print Thermal Ticket again.");
  popup.document.write(thermalTicketHtml(ticket));
  popup.document.close();
}
