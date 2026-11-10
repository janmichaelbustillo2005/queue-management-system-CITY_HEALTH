// The one source of the Types of Services for every screen. A visit stores the
// `value` (patients.service_type); the `label` is what people read and must stay
// exactly as City Health lists it. Change a service here, not in a page.

// The 13 services offered at registration, in the order City Health lists them.
export const OFFERED_SERVICES = [
  { value: "medical_consultation", label: "Medical consultation" },
  { value: "maternal_healthcare", label: "Maternal healthcare" },
  { value: "family_planning", label: "Family planning" },
  { value: "child_healthcare", label: "Child healthcare" },
  { value: "dental_healthcare", label: "Dental healthcare" },
  { value: "nutrition", label: "Nutrition" },
  { value: "diagnostic_imaging", label: "Diagnostic imaging" },
  { value: "womens_health", label: "Women's health" },
  { value: "mental_healthcare", label: "Mental healthcare" },
  { value: "medical_documentation", label: "Medical documentation" },
  { value: "marriage_preparation", label: "Marriage preparation" },
  { value: "environmental_health", label: "Environmental health" },
  { value: "food_safety", label: "Food safety" }
];

// Former services: no longer offered at registration, but earlier visits still carry
// these keys, so they keep their names in history and stay filterable.
export const FORMER_SERVICES = [
  { value: "consultation", label: "General Consultation" },
  { value: "checkup", label: "Medical Check-up" },
  { value: "prenatal", label: "Prenatal" },
  { value: "maternity", label: "Maternity" }
];

// Older keys found on historical visits only; named for display, never offered or filtered.
const HISTORICAL_LABELS = {
  laboratory: "Laboratory",
  dental: "Dental",
  obgyne: "Obstetrics and Gynecology"
};

export const SERVICE_LABELS = {
  ...HISTORICAL_LABELS,
  ...Object.fromEntries([...FORMER_SERVICES, ...OFFERED_SERVICES].map(({ value, label }) => [value, label]))
};

// Filters over history: the offered services, then the former ones marked as such.
export const SERVICE_FILTER_OPTIONS = [
  ...OFFERED_SERVICES,
  ...FORMER_SERVICES.map(({ value, label }) => ({ value, label: `${label} (former)` }))
];

// A visit's service name; an unknown key is shown as stored rather than hidden.
export function serviceName(value) {
  return SERVICE_LABELS[value] || value || "";
}
