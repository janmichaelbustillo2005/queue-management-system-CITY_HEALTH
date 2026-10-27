// Role-based navigation for the authenticated shell (SiteFrame). The sidebar
// holds work pages only; My Profile and Sign Out live in the header account
// menu. Every link is an existing route; hiding a link never replaces the page
// and API guards.

const DOCTOR_PAGES = { admin1: "/admin1", admin2: "/admin2", admin3: "/admin3" };
const FRONTDESK_LABELS = ["front desk", "frontdesk"];
const RECORD_CATEGORIES = ["patients", "staff", "accounts"];
const DASHBOARD_SECTIONS = ["queue", "staff", "settings"];

// Same reading as the backend (isFrontdeskAssignment): an empty assignment or a
// legacy "Front Desk" label is the front desk, never a doctor.
export function isFrontdeskAssignment(value) {
  const label = String(value ?? "").trim().toLowerCase();
  return !label || FRONTDESK_LABELS.includes(label);
}

// "Doctor 2", "doctor2" and "2" all name counter Doctor 2; anything else is not a doctor counter.
export function normalizeDoctorAssignment(value) {
  const label = String(value ?? "").trim();
  const match = /^(?:doctor\s*)?([123])$/i.exec(label);
  return match ? `Doctor ${match[1]}` : null;
}

// What the signed-in session says about the account: id_num, role and
// doctor_name only. Labels are derived from those fields, never invented.
export function resolveAccount(user) {
  if (!user || typeof user !== "object" || !user.id_num) return null;
  const id = String(user.id_num);
  const storedRole = String(user.role || "");
  const doctor = normalizeDoctorAssignment(user.doctor_name);
  const base = { id, storedRole };
  if (storedRole === "superadmin") {
    return { ...base, kind: "superadmin", roleLabel: "Super Administrator", assignment: "All sections", icon: "fas fa-user-shield", homeHref: "/?section=home" };
  }
  if (storedRole !== "admin") {
    return { ...base, kind: "unknown", roleLabel: "Unrecognized role", assignment: "None", icon: "fas fa-user", homeHref: null };
  }
  if (DOCTOR_PAGES[id]) {
    return { ...base, kind: "doctor", roleLabel: "Doctor", assignment: doctor || "Not recorded in this session", icon: "fas fa-user-md", homeHref: DOCTOR_PAGES[id] };
  }
  if (id === "frontdesk" || isFrontdeskAssignment(user.doctor_name)) {
    return { ...base, kind: "frontdesk", roleLabel: "Front Desk Staff", assignment: "Front desk", icon: "fas fa-id-badge", homeHref: "/fill-up_form" };
  }
  return { ...base, kind: "staff", roleLabel: "Staff", assignment: doctor || String(user.doctor_name), icon: "fas fa-user", homeHref: "/patient-management" };
}

export function readNavLocation(router) {
  const query = router?.query || {};
  const [, hash = ""] = String(router?.asPath || "").split("#");
  return {
    // Before hydration the query is empty; highlighting then would flash the wrong item.
    ready: router?.isReady !== false,
    path: router?.pathname || "",
    section: typeof query.section === "string" ? query.section : "",
    category: typeof query.category === "string" ? query.category : "",
    hash
  };
}

const link = (id, label, icon, href, isActive, extra = {}) => ({ id, label, icon, href, isActive, ...extra });
const liveDisplay = link("live-display", "Live Queue Display", "fas fa-desktop", "/queue-display", () => false, { external: true });
const onDashboard = (at, section) => at.path === "/" && (section === "home"
  ? !DASHBOARD_SECTIONS.includes(at.section) : at.section === section);
// The Records page shows patients for a missing or unknown category.
const onRecords = (at, category) => at.path === "/records" && (category === "patients"
  ? !RECORD_CATEGORIES.slice(1).includes(at.category) : at.category === category);

const SUPERADMIN_GROUPS = [
  { id: "overview", label: "Overview", items: [
    link("dashboard", "Dashboard", "fas fa-home", "/?section=home", (at) => onDashboard(at, "home"))
  ] },
  { id: "queue-operations", label: "Queue Operations", items: [
    link("queue", "Queue Management", "fas fa-list", "/?section=queue",
      (at) => onDashboard(at, "queue") && at.hash !== "doctor-monitoring"),
    link("monitoring", "Doctor & Counter Monitoring", "fas fa-user-md", "/?section=queue#doctor-monitoring",
      (at) => onDashboard(at, "queue") && at.hash === "doctor-monitoring"),
    link("historical-backlog", "Historical Backlog", "fas fa-history", "/queue-backlog", (at) => at.path === "/queue-backlog"),
    liveDisplay
  ] },
  { id: "records", label: "Records Management", items: [
    link("patient-records", "Patient Records", "fas fa-notes-medical", "/records?category=patients", (at) => onRecords(at, "patients")),
    link("staff-records", "Staff Records", "fas fa-id-card-alt", "/records?category=staff", (at) => onRecords(at, "staff")),
    link("user-accounts", "User Accounts", "fas fa-users", "/records?category=accounts", (at) => onRecords(at, "accounts"))
  ] },
  { id: "reports", label: "Reports & Analytics", items: [
    link("analytics", "Analytics", "fas fa-chart-bar", "/analytics", (at) => at.path === "/analytics")
  ] },
  { id: "administration", label: "System Administration", items: [
    link("staff-management", "Staff Management", "fas fa-user-cog", "/?section=staff", (at) => onDashboard(at, "staff")),
    // Pages that own the Settings dialog open it in place; elsewhere this link opens it on the dashboard.
    link("settings", "System Settings", "fas fa-cog", "/?section=settings", (at) => onDashboard(at, "settings"), { opensSettings: true })
  ] }
];

const patientOperations = { id: "patient-operations", label: "Patient Operations", items: [
  link("registration", "Patient Registration", "fas fa-user-plus", "/fill-up_form", (at) => at.path === "/fill-up_form"),
  link("patient-management", "Patient Management", "fas fa-hospital-user", "/patient-management", (at) => at.path === "/patient-management")
] };
const queueMonitoring = { id: "queue-monitoring", label: "Queue Monitoring", items: [liveDisplay] };

export function navigationFor(account) {
  switch (account?.kind) {
    case "superadmin": return SUPERADMIN_GROUPS;
    case "frontdesk":
    case "staff": return [patientOperations, queueMonitoring];
    case "doctor": return [
      { id: "patient-queue", label: "Patient Queue", items: [
        link("my-queue", "My Patient Queue", "fas fa-user-md", account.homeHref, (at) => at.path === account.homeHref)
      ] },
      queueMonitoring
    ];
    // An unrecognized role has no work pages; it keeps only the header account menu.
    default: return [];
  }
}
