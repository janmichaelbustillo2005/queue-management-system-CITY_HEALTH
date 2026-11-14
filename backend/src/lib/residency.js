// RES1: a patient's residency is limited to Cabadbaran City, Agusan del Norte.
// It is stored in the existing residency column as one canonical text, the same text the
// Residency search bar shows:
//   "[<Purok / Street / House No.>, ]Brgy. <Barangay>, Cabadbaran City, Agusan del Norte"
// so no table changes, and addresses saved before RES1 are kept exactly as they were.
// frontend/lib/residency.js holds the same rules for the forms; a test keeps them equal.

// The 31 barangays of Cabadbaran City (PSA PSGC 160203000), as listed on PhilAtlas and on
// Wikipedia's PSGC table, checked 2026-11-14.
const CABADBARAN_BARANGAYS = Object.freeze([
  "Antonio Luna", "Bay-ang", "Bayabas", "Caasinan", "Cabinet", "Calamba", "Calibunan", "Comagascas",
  "Concepcion", "Del Pilar", "Katugasan", "Kauswagan", "La Union", "Mabini", "Mahaba",
  "Poblacion 1", "Poblacion 2", "Poblacion 3", "Poblacion 4", "Poblacion 5", "Poblacion 6",
  "Poblacion 7", "Poblacion 8", "Poblacion 9", "Poblacion 10", "Poblacion 11", "Poblacion 12",
  "Puting Bato", "Sanghan", "Soriano", "Tolosa"
]);
const RESIDENCY_CITY = "Cabadbaran City";
const RESIDENCY_PROVINCE = "Agusan del Norte";
// Keeps the whole text within patients.residency varchar(100): the longest suffix,
// ", Brgy. Antonio Luna, Cabadbaran City, Agusan del Norte", is 55 characters.
const RESIDENCY_STREET_MAX = 45;

const RESIDENCY_REQUIRED = "Residency is required. Search and select an address within Cabadbaran City, Agusan del Norte.";
const RESIDENCY_INVALID = "Please select a valid address within Cabadbaran City, Agusan del Norte.";
const RESIDENCY_DETAIL_REPEATS = "The Purok / Street / House No. cannot name a barangay, city or province again. Select the address once.";
const RESIDENCY_STREET_TOO_LONG = `Purok / Street / House No. can have at most ${RESIDENCY_STREET_MAX} characters.`;

// "Brgy. Tolosa", "Brgy.Tolosa", "Bgy Tolosa" and "Barangay Tolosa" all name Tolosa.
const BARANGAY_PREFIX = /^(?:(?:brgy|bgy)(?:\.\s*|\s+|$)|barangay(?:\s+|$))/i;
const BARANGAY_BY_KEY = new Map(CABADBARAN_BARANGAYS.map((name) => [name.toLowerCase(), name]));

function cleanText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

// The official spelling of a Cabadbaran City barangay ("Brgy." / "Barangay" allowed), or null.
function findBarangay(value) {
  return BARANGAY_BY_KEY.get(cleanText(value).replace(BARANGAY_PREFIX, "").toLowerCase()) || null;
}

function formatResidency({ street, barangay }) {
  return [cleanText(street), `Brgy. ${barangay}`, RESIDENCY_CITY, RESIDENCY_PROVINCE].filter(Boolean).join(", ");
}

// { street, barangay } for a text in the RES1 format (street may be empty), otherwise null.
// Addresses saved before RES1, or outside Cabadbaran City, return null.
function parseResidency(value) {
  const parts = cleanText(value).split(",").map(cleanText).filter(Boolean);
  if (parts.length < 3) return null;
  const [barangayPart, city, province] = parts.slice(-3);
  if (city.toLowerCase() !== RESIDENCY_CITY.toLowerCase() || province.toLowerCase() !== RESIDENCY_PROVINCE.toLowerCase()) return null;
  const barangay = findBarangay(barangayPart);
  if (!barangay) return null;
  return { street: parts.slice(0, -3).join(", "), barangay };
}

// The detail names each component once. A part that is itself a place name repeats or
// contradicts the address ("Purok 1, Bayabas" before "Brgy. Calibunan", "Butuan City",
// "Agusan del Sur Province"). Names that only contain one are ordinary details: "City Proper"
// (a common purok name), "Cabadbaran City Hall", "Cabadbaran-Butuan Road".
const PLACE_NAME = /^(?:cabadbaran(?:\s+city)?|agusan(?:\s+del\s+(?:norte|sur))?|caraga|philippines)$/i;

function streetProblem(street) {
  if (street.length > RESIDENCY_STREET_MAX) return RESIDENCY_STREET_TOO_LONG;
  const repeats = street.split(",").map(cleanText).some((part) => BARANGAY_PREFIX.test(part) || findBarangay(part) ||
    PLACE_NAME.test(part) || /\S\s+city$/i.test(part) || /\bprovince$/i.test(part));
  return repeats ? RESIDENCY_DETAIL_REPEATS : "";
}

// The message for a residency text that cannot be saved, or "" when it can.
function residencyProblem(value, { required = true } = {}) {
  if (value != null && typeof value !== "string") return RESIDENCY_INVALID;
  if (!cleanText(value)) return required ? RESIDENCY_REQUIRED : "";
  const parsed = parseResidency(value);
  return parsed ? streetProblem(parsed.street) : RESIDENCY_INVALID;
}

function residencyError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// The canonical residency text for a registration, or null when it is blank and not required.
// Anything outside Cabadbaran City, Agusan del Norte, or naming an unknown barangay, is refused.
function readResidency(value, { required = true } = {}) {
  const problem = residencyProblem(value, { required });
  if (problem) throw residencyError(problem);
  if (!cleanText(value)) return null;
  return formatResidency(parseResidency(value));
}

module.exports = {
  CABADBARAN_BARANGAYS,
  RESIDENCY_CITY,
  RESIDENCY_PROVINCE,
  RESIDENCY_STREET_MAX,
  RESIDENCY_INVALID,
  findBarangay,
  formatResidency,
  parseResidency,
  residencyProblem,
  residencyDetailProblem: streetProblem,
  readResidency
};
