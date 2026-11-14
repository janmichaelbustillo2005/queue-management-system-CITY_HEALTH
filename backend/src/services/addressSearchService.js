// RES2: Google Places address search for the Residency search bar, called only from the backend so
// the key (GOOGLE_MAPS_API_KEY) never reaches a browser. It is off when no key is set; the form
// then keeps its verified barangay search and manual entry.
//
// A Google result is never trusted for being a search result. The chosen place is read with Place
// Details and accepted only when Google's own address components put it in Cabadbaran City,
// Agusan del Norte, Philippines. Its barangay is taken only from those components and only when it
// is one of the 31 official barangays (lib/residency.js); otherwise the Front Desk chooses it. The
// accepted place is signed with the server's JWT secret so a registration can prove the address
// came from the map, and no browser can claim that for an address it typed.
//
// Requests and their queries are never logged. Only Essentials-tier Place Details fields are
// requested (id, formattedAddress, addressComponents, types). Coordinates are not requested or
// stored; only the place ID is kept with a record, which Google's terms allow to be cached.
const jwt = require("jsonwebtoken");
const { findBarangay, residencyDetailProblem } = require("../lib/residency");

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places/";
const DETAILS_FIELDS = "id,formattedAddress,addressComponents,types";
// Search is restricted to 20 km around Cabadbaran City's center as mapped in OpenStreetMap
// (node 5335101492, 9.1232854 N, 125.5322317 E). The circle also reaches neighbouring towns, so it
// only narrows suggestions; acceptance is decided by the address components above.
const SEARCH_AREA = { circle: { center: { latitude: 9.1232854, longitude: 125.5322317 }, radius: 20000 } };
const REQUEST_TIMEOUT_MS = 8000;
const PLACE_TOKEN_AUDIENCE = "residency-place";
const PLACE_TOKEN_LIFETIME = "4h";

const QUERY_MIN = 3;
const QUERY_MAX = 100;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,36}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{8,300}$/;

const MAP_UNAVAILABLE = "Map search is unavailable right now. Choose the barangay from the list, or enter the address manually.";
const OUTSIDE_CITY = "That place is not in Cabadbaran City, Agusan del Norte. Choose an address within Cabadbaran City, or enter it manually.";

function searchError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

function readQuery(value) {
  const text = clean(value);
  if (text.length < QUERY_MIN) throw searchError(`Type at least ${QUERY_MIN} characters to search the map.`, 400);
  if (text.length > QUERY_MAX) throw searchError(`Map search can have at most ${QUERY_MAX} characters.`, 400);
  return text;
}

function readSessionToken(value) {
  const token = String(value ?? "");
  if (!SESSION_TOKEN.test(token)) throw searchError("The map search session is not valid. Start the search again.", 400);
  return token;
}

async function callGoogle(url, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw searchError(MAP_UNAVAILABLE, 502);
  }
  if (!response.ok) {
    // The status alone: Google's error text can echo the query.
    console.warn(`Google Places request failed with status ${response.status}.`);
    if (response.status === 404 || response.status === 400) return null;
    throw searchError(MAP_UNAVAILABLE, 502);
  }
  return response.json();
}

// Up to five readable suggestions inside Cabadbaran City, each { placeId, mainText, secondaryText, text }.
async function autocompleteAddresses({ query, sessionToken, apiKey, fetchImpl = fetch }) {
  const input = readQuery(query);
  const data = await callGoogle(AUTOCOMPLETE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
    body: JSON.stringify({
      input, sessionToken: readSessionToken(sessionToken), includedRegionCodes: ["ph"], languageCode: "en",
      locationRestriction: SEARCH_AREA
    })
  }, fetchImpl);
  return (data?.suggestions || [])
    .map((suggestion) => suggestion.placePrediction)
    .filter((prediction) => prediction?.placeId && PLACE_ID.test(prediction.placeId))
    .map((prediction) => {
      const text = clean(prediction.text?.text);
      return {
        placeId: prediction.placeId,
        mainText: clean(prediction.structuredFormat?.mainText?.text) || text,
        secondaryText: clean(prediction.structuredFormat?.secondaryText?.text),
        text
      };
    })
    // Only relevant suggestions: Google names the city in the text of places inside it.
    .filter((item) => /\bcabadbaran\b/i.test(item.text))
    .slice(0, 5);
}

const componentsOfType = (components, type) => components.filter((component) => (component.types || []).includes(type));
const componentText = (component) => clean(component?.longText || component?.shortText);

// { placeId, barangay (or null), detail, formattedAddress } for a place inside Cabadbaran City,
// Agusan del Norte, Philippines, from Google's address components; null for any other place.
function readPlaceAddress(place) {
  const components = Array.isArray(place?.addressComponents) ? place.addressComponents : [];
  const inCity = componentsOfType(components, "locality").some((component) => /^cabadbaran(?:\s+city)?$/i.test(componentText(component)));
  const inProvince = components.some((component) => (component.types || []).some((type) => /^administrative_area_level_[12]$/.test(type)) &&
    /^agusan del norte$/i.test(componentText(component)));
  const inCountry = componentsOfType(components, "country").some((component) =>
    clean(component.shortText).toUpperCase() === "PH" || /^philippines$/i.test(componentText(component)));
  if (!inCity || !inProvince || !inCountry) return null;

  // Google files a barangay under different types; it counts only if it is an official name.
  const barangayTypes = ["sublocality_level_1", "sublocality", "neighborhood", "administrative_area_level_3",
    "administrative_area_level_4", "administrative_area_level_5"];
  const barangay = components
    .filter((component) => (component.types || []).some((type) => barangayTypes.includes(type)))
    .map((component) => findBarangay(componentText(component)))
    .find(Boolean) || null;

  // The detail is only what Google's components hold: premise, street number and route.
  const premise = componentText(componentsOfType(components, "premise")[0]);
  const street = [componentText(componentsOfType(components, "street_number")[0]), componentText(componentsOfType(components, "route")[0])]
    .filter(Boolean).join(" ");
  let detail = [premise, street].filter(Boolean).join(", ");
  // A detail that would not be accepted (too long, or naming another place) is left for the Front Desk.
  if (detail && residencyDetailProblem(detail)) detail = "";

  return { placeId: String(place.id || ""), barangay, detail, formattedAddress: clean(place.formattedAddress) };
}

// The Cabadbaran City address of a chosen suggestion, with a signed token for the registration.
async function resolvePlaceAddress({ placeId, sessionToken, apiKey, secret, fetchImpl = fetch }) {
  const id = String(placeId ?? "");
  if (!PLACE_ID.test(id)) throw searchError("Choose a map suggestion again.", 400);
  const url = `${DETAILS_URL}${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(readSessionToken(sessionToken))}&languageCode=en`;
  const place = await callGoogle(url, { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": DETAILS_FIELDS } }, fetchImpl);
  if (!place) throw searchError("That map place could not be found. Search again, or enter the address manually.", 404);
  const address = readPlaceAddress(place);
  if (!address || !address.placeId) throw searchError(OUTSIDE_CITY, 422);
  return { ...address, token: signPlace(address, secret) };
}

function signPlace({ placeId, barangay, detail }, secret) {
  return jwt.sign({ pid: placeId, b: barangay, d: detail }, secret, { audience: PLACE_TOKEN_AUDIENCE, expiresIn: PLACE_TOKEN_LIFETIME });
}

// { placeId, barangay, detail } from a token this server signed, or null (absent, altered or expired).
function verifyPlaceToken(token, secret) {
  if (typeof token !== "string" || !token || token.length > 2000) return null;
  try {
    const payload = jwt.verify(token, secret, { audience: PLACE_TOKEN_AUDIENCE });
    if (typeof payload.pid !== "string" || !PLACE_ID.test(payload.pid)) return null;
    const barangay = payload.b == null ? null : findBarangay(payload.b);
    if (payload.b != null && !barangay) return null;
    return { placeId: payload.pid, barangay, detail: clean(payload.d) };
  } catch {
    return null;
  }
}

module.exports = {
  autocompleteAddresses,
  resolvePlaceAddress,
  readPlaceAddress,
  signPlace,
  verifyPlaceToken,
  readSessionToken
};
