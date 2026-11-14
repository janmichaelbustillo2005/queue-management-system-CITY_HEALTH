// RES1: a patient's residency is limited to Cabadbaran City, Agusan del Norte. The Residency
// search bar holds one text, "[<Purok / Street / House No.>, ]Brgy. <Barangay>, Cabadbaran City,
// Agusan del Norte", which is also what is saved; the backend checks it again with the same rules
// (backend/src/lib/residency.js; a test keeps the two equal).
// Addresses saved before RES1 are shown exactly as stored and never rewritten here.

// The 31 barangays of Cabadbaran City (PSA PSGC 160203000), checked 2026-11-14.
export const CABADBARAN_BARANGAYS = Object.freeze([
  "Antonio Luna", "Bay-ang", "Bayabas", "Caasinan", "Cabinet", "Calamba", "Calibunan", "Comagascas",
  "Concepcion", "Del Pilar", "Katugasan", "Kauswagan", "La Union", "Mabini", "Mahaba",
  "Poblacion 1", "Poblacion 2", "Poblacion 3", "Poblacion 4", "Poblacion 5", "Poblacion 6",
  "Poblacion 7", "Poblacion 8", "Poblacion 9", "Poblacion 10", "Poblacion 11", "Poblacion 12",
  "Puting Bato", "Sanghan", "Soriano", "Tolosa"
]);
export const RESIDENCY_CITY = "Cabadbaran City";
export const RESIDENCY_PROVINCE = "Agusan del Norte";
export const RESIDENCY_STREET_MAX = 45;
export const RESIDENCY_REQUIRED = "Residency is required. Search and select an address within Cabadbaran City, Agusan del Norte.";
export const RESIDENCY_INVALID = "Please select a valid address within Cabadbaran City, Agusan del Norte.";
export const RESIDENCY_DETAIL_REPEATS = "The Purok / Street / House No. cannot name a barangay, city or province again. Select the address once.";
// RES2 (forms only): an address must come from a suggestion or the manual form, not just be typed.
export const RESIDENCY_NOT_SELECTED = "Select an address from the suggestions, or choose “Enter address manually”.";
export const RESIDENCY_STREET_TOO_LONG = `Purok / Street / House No. can have at most ${RESIDENCY_STREET_MAX} characters.`;

// "Brgy. Tolosa", "Brgy.Tolosa", "Bgy Tolosa" and "Barangay Tolosa" all name Tolosa.
const BARANGAY_PREFIX = /^(?:(?:brgy|bgy)(?:\.\s*|\s+|$)|barangay(?:\s+|$))/i;
const cleanText = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const BARANGAY_BY_KEY = new Map(CABADBARAN_BARANGAYS.map((name) => [name.toLowerCase(), name]));

export function findBarangay(value) {
  return BARANGAY_BY_KEY.get(cleanText(value).replace(BARANGAY_PREFIX, "").toLowerCase()) || null;
}

export function formatResidency({ street, barangay }) {
  return [cleanText(street), `Brgy. ${barangay}`, RESIDENCY_CITY, RESIDENCY_PROVINCE].filter(Boolean).join(", ");
}

// { street, barangay } for a RES1 address, otherwise null (an older or out-of-area address).
export function parseResidency(value) {
  const parts = cleanText(value).split(",").map(cleanText).filter(Boolean);
  if (parts.length < 3) return null;
  const [barangayPart, city, province] = parts.slice(-3);
  if (city.toLowerCase() !== RESIDENCY_CITY.toLowerCase() || province.toLowerCase() !== RESIDENCY_PROVINCE.toLowerCase()) return null;
  const barangay = findBarangay(barangayPart);
  return barangay ? { street: parts.slice(0, -3).join(", "), barangay } : null;
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

// The message for a Purok / Street / House No. that cannot be saved, or "" when it can.
export function residencyDetailProblem(detail) {
  return streetProblem(cleanText(detail));
}

// The message for a residency text that cannot be saved, or "" when it can.
export function residencyProblem(value, { required = true } = {}) {
  if (value != null && typeof value !== "string") return RESIDENCY_INVALID;
  if (!cleanText(value)) return required ? RESIDENCY_REQUIRED : "";
  const parsed = parseResidency(value);
  return parsed ? streetProblem(parsed.street) : RESIDENCY_INVALID;
}

// The text to send for a valid address (canonical spelling), or "" when it cannot be saved.
export function normalizeResidency(value) {
  return residencyProblem(value) ? "" : formatResidency(parseResidency(value));
}

// ---------------------------------------------------------------------------------------------
// Search: what the Front Desk types becomes suggestions built only from the verified barangay
// list. Whatever else was typed ("Purok 3, Rizal St.") is kept as the detail; no purok, street or
// house number is ever invented. City, province and "Brgy." words are ignored, since they are
// always added.
// ---------------------------------------------------------------------------------------------
const IGNORED_WORDS = [/\bcabadbaran(?:\s+city)?\b/gi, /\bagusan\s+del\s+norte\b/gi, /\bphilippines\b/gi, /(?<=^|[\s,])(?:brgy|bgy)(?:\.|(?=[\s,]|$))/gi, /\bbarangay\b/gi];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_PATTERNS = CABADBARAN_BARANGAYS.map((name) => new RegExp(`(^|[^a-z0-9])(${escapeRegExp(name.toLowerCase())})(?![a-z0-9])`, "i"));

function tidyDetail(text) {
  return text.split(",").map((part) => cleanText(part).replace(/^[\s\-–#,.]+$/, "")).filter(Boolean).join(", ");
}

// Where the words of term start consecutive words of the barangay name: "pob 1" -> "Poblacion 1".
function wordPrefixMatch(name, term) {
  const nameWords = name.toLowerCase().split(" ");
  const termWords = term.toLowerCase().split(" ");
  for (let start = 0; start + termWords.length <= nameWords.length; start += 1) {
    if (termWords.every((word, index) => nameWords[start + index].startsWith(word))) {
      const offset = nameWords.slice(0, start).reduce((sum, word) => sum + word.length + 1, 0);
      const length = termWords.length === 1 ? termWords[0].length
        : nameWords.slice(start, start + termWords.length - 1).reduce((sum, word) => sum + word.length + 1, 0) + termWords.at(-1).length;
      return { rank: start === 0 ? 1 : 2, match: [offset, offset + length] };
    }
  }
  return null;
}

function suggestion(barangay, street, match) {
  return { barangay, street, label: formatResidency({ street, barangay }), match };
}

// Up to limit suggestions for what was typed, best first. Each has barangay, street (the detail
// typed), label (the address to show and save) and match ([start, end] of the barangay name
// that matched, for highlighting). Empty text lists every barangay.
export function suggestResidencies(query, { limit = 8 } = {}) {
  const text = cleanText(query);
  if (!text) return CABADBARAN_BARANGAYS.map((name) => suggestion(name, "", null));
  const current = parseResidency(text);
  if (current) return [suggestion(current.barangay, current.street, [0, current.barangay.length])];

  const stripped = cleanText(IGNORED_WORDS.reduce((value, pattern) => value.replace(pattern, " "), text));
  // The barangay still being typed at the end ("Purok 3, Cali"): the longest trailing words that
  // begin a barangay name; whatever came before is the detail.
  const lastComma = stripped.lastIndexOf(",");
  const head = lastComma >= 0 ? stripped.slice(0, lastComma + 1) : "";
  const tailWords = cleanText(stripped.slice(lastComma + 1)).split(" ").filter(Boolean);
  let partial = [];
  let termStart = stripped.length;
  for (let count = tailWords.length; count >= 1 && !partial.length; count -= 1) {
    const term = tailWords.slice(-count).join(" ");
    if (term.replace(/\s/g, "").length < 2) continue;
    const detail = tidyDetail(`${head} ${tailWords.slice(0, -count).join(" ")}`);
    partial = CABADBARAN_BARANGAYS.map((name) => {
      const prefix = wordPrefixMatch(name, term);
      if (prefix) return { ...suggestion(name, detail, prefix.match), rank: prefix.rank };
      const at = term.length >= 3 ? name.toLowerCase().indexOf(term.toLowerCase()) : -1;
      return at >= 0 ? { ...suggestion(name, detail, [at, at + term.length]), rank: 3 } : null;
    }).filter(Boolean);
    if (partial.length) termStart = stripped.length - term.length;
  }

  // A barangay named in full ("Purok 3 Calibunan"): the rest is the detail. An address names the
  // barangay last, so only the last full mention counts ("Mabini St., Calibunan" is Calibunan),
  // and none before a barangay still being typed at the end.
  const whole = NAME_PATTERNS.map((pattern, index) => {
    const hit = pattern.exec(stripped);
    if (!hit) return null;
    const start = hit.index + hit[1].length;
    const end = start + hit[2].length;
    const detail = tidyDetail(`${stripped.slice(0, start)} ${stripped.slice(end)}`);
    return { ...suggestion(CABADBARAN_BARANGAYS[index], detail, [0, hit[2].length]), rank: 0, start, end };
  }).filter(Boolean);
  const lastStart = Math.max(...whole.map((item) => item.start));
  const found = [
    ...whole.filter((item) => item.start === lastStart && !(partial.length && item.end <= termStart)),
    ...partial
  ];

  const order = (name) => CABADBARAN_BARANGAYS.indexOf(name);
  found.sort((a, b) => a.rank - b.rank || order(a.barangay) - order(b.barangay));
  const seen = new Set();
  return found.filter((item) => !seen.has(item.barangay) && seen.add(item.barangay))
    .slice(0, limit)
    .map(({ barangay, street, label, match }) => ({ barangay, street, label, match }));
}
