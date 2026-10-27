// Records filters, mapped to the keys and exact values get_central_records
// accepts (backend/scripts/20261023-phase-b2-records.sql). Labels are for people;
// `value` is what the server compares against, so never send a label.

const SERVICE_OPTIONS = [
  { value: "consultation", label: "General Consultation" },
  { value: "checkup", label: "Medical Check-up" },
  { value: "prenatal", label: "Prenatal" },
  { value: "maternity", label: "Maternity" },
  { value: "family_planning", label: "Family Planning" }
];

const STATUS_OPTIONS = [
  { value: "waiting", label: "Waiting" },
  { value: "serving", label: "Being served" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no-show", label: "No-show" }
];

// Counter names. The server resolves aliases ("doctor 1", "1") to the counter; patients
// match their stored assignment, or the service routing when none is stored.
const DOCTOR_OPTIONS = ["Doctor 1", "Doctor 2", "Doctor 3"].map((value) => ({ value, label: value }));

// Stored users.role values.
const ROLE_OPTIONS = [
  { value: "superadmin", label: "Super Admin" },
  { value: "admin", label: "Admin (doctors & front desk)" }
];

// Position is derived by the server: superadmin -> Super Admin; an admin with no doctor
// assignment (or the legacy "Front Desk" label) -> Frontdesk; any other admin -> Doctor.
const POSITION_OPTIONS = [
  { value: "Super Admin", label: "Super Admin" },
  { value: "Doctor", label: "Doctor" },
  { value: "Frontdesk", label: "Front desk" }
];

const PRESENCE_OPTIONS = [
  { value: "online", label: "Online now" },
  { value: "offline", label: "Offline" }
];

const field = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

export const RECORD_FILTERS = {
  patients: {
    primary: [
      field("search", "Search patients", "search", { placeholder: "Name or ticket number" }),
      field("date", "Registration date", "date", { hint: "Manila", hintTitle: "Registration date in Manila time (Asia/Manila)" }),
      field("service", "Service", "select", { options: SERVICE_OPTIONS, allLabel: "All services" }),
      field("doctor", "Assigned doctor", "select", { options: DOCTOR_OPTIONS, allLabel: "All doctors" }),
      field("status", "Queue status", "select", { options: STATUS_OPTIONS, allLabel: "All statuses" })
    ],
    advanced: []
  },
  staff: {
    primary: [
      field("search", "Search staff", "search", { placeholder: "Name or account ID" }),
      field("position", "Position", "select", { options: POSITION_OPTIONS, allLabel: "All positions" }),
      field("presence", "Presence", "select", { options: PRESENCE_OPTIONS, allLabel: "Any presence" })
    ],
    advanced: [
      field("role", "Stored role", "select", { options: ROLE_OPTIONS, allLabel: "All roles" }),
      field("doctor", "Doctor assignment", "select", { options: DOCTOR_OPTIONS, allLabel: "All doctor assignments" })
    ]
  },
  accounts: {
    primary: [
      field("search", "Search accounts", "search", { placeholder: "Account ID or name" }),
      field("role", "Account role", "select", { options: ROLE_OPTIONS, allLabel: "All roles" }),
      field("position", "Position", "select", { options: POSITION_OPTIONS, allLabel: "All positions" })
    ],
    advanced: [
      field("presence", "Session presence", "select", { options: PRESENCE_OPTIONS, allLabel: "Any presence" }),
      field("doctor", "Linked doctor", "select", { options: DOCTOR_OPTIONS, allLabel: "All doctor links" })
    ]
  },
  // Historical Waiting Backlog (GET /api/queue/backlog), not get_central_records. Every row is
  // already waiting, so there is no status filter; search matches the ticket number only.
  backlog: {
    primary: [
      field("search", "Ticket number", "search", { placeholder: "Search ticket number" }),
      field("date", "Registration date", "date", { hint: "Manila", hintTitle: "Registration date in Manila time (Asia/Manila)" }),
      field("service", "Service", "select", { options: SERVICE_OPTIONS, allLabel: "All services" }),
      field("doctor", "Assigned doctor", "select", { options: DOCTOR_OPTIONS, allLabel: "All doctors" })
    ],
    advanced: []
  }
};

export function recordFields(category) {
  const config = RECORD_FILTERS[category];
  return config ? [...config.primary, ...config.advanced] : [];
}

// Keeps only this category's keys with a usable value: trimmed text, a valid
// date, or a select value the server knows. Anything else is dropped, so a
// filter from another category or a stale option can never reach the request.
export function cleanRecordFilters(category, values = {}) {
  const cleaned = {};
  for (const { key, type, options } of recordFields(category)) {
    const value = typeof values[key] === "string" ? values[key].trim() : "";
    if (!value) continue;
    if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    if (type === "select" && !options.some((option) => option.value === value)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function recordsQuery(category, applied, page, limit = 20) {
  return new URLSearchParams({ ...cleanRecordFilters(category, applied), page: String(page), limit: String(limit) }).toString();
}

export function sameRecordFilters(category, left, right) {
  const a = cleanRecordFilters(category, left), b = cleanRecordFilters(category, right);
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function readableDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
  });
}

// One chip per applied filter, in the order the controls appear.
export function recordFilterChips(category, applied) {
  const cleaned = cleanRecordFilters(category, applied);
  return recordFields(category).filter(({ key }) => key in cleaned).map(({ key, label, type, options }) => {
    const value = cleaned[key];
    const display = type === "date" ? readableDate(value)
      : type === "select" ? options.find((option) => option.value === value).label
      : `“${value}”`;
    return { key, label: type === "search" ? "Search" : label, value: display };
  });
}
