// Finds the city and state at the end of a card description, even when the bank
// squashes them together or cuts the city short:
//   "TARGET T-1234 COLORADO SPRCO"     -> Colorado Springs, CO
//   "SAFEWAY #0101 SANTA BARBACA"      -> Santa Barbara, CA
//   "UNITED AIR Bag Fee MINN/ST PAUL MN" -> Saint Paul, MN
// The city list ships with the app (js/cities-data.js); nothing is looked up online.

let cityData = null;
const indexCache = new Map();

export async function loadCities() {
  if (!cityData) cityData = (await import("./cities-data.js")).default;
  return cityData;
}

// For tests and the preview build, which can hand the data over directly.
export function setCityData(data) {
  cityData = data;
  indexCache.clear();
}

const normalize = (s) =>
  s.toUpperCase()
    .replace(/\./g, "")
    .replace(/\bSAINT\b/g, "ST")
    .replace(/\bFORT\b/g, "FT")
    .replace(/\bMOUNT\b/g, "MT")
    .replace(/\s+/g, " ")
    .trim();

function stateIndex(state) {
  if (indexCache.has(state)) return indexCache.get(state);
  const full = new Map();
  const prefixes = new Map();
  for (const city of cityData[state].split("|")) {
    const n = normalize(city);
    full.set(n, city);
    for (let len = 8; len < n.length; len++) {
      const p = n.slice(0, len);
      if (!prefixes.has(p)) prefixes.set(p, new Set());
      prefixes.get(p).add(city);
    }
  }
  const idx = { full, prefixes };
  indexCache.set(state, idx);
  return idx;
}

export function titleCaseCity(city) {
  return city.toLowerCase().replace(/(^|[\s\-/'])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

const COUNTRIES = {
  CH: "Switzerland", GB: "United Kingdom", UK: "United Kingdom", FR: "France", IE: "Ireland", JP: "Japan",
  IT: "Italy", ES: "Spain", MX: "Mexico", NL: "Netherlands", AT: "Austria", PT: "Portugal", GR: "Greece",
  KR: "South Korea", TH: "Thailand", SG: "Singapore", AU: "Australia", NZ: "New Zealand", LK: "Sri Lanka",
  IS: "Iceland", BE: "Belgium", DK: "Denmark", SE: "Sweden", NO: "Norway", CR: "Costa Rica", PH: "Philippines",
};

// Purchases abroad usually end with a city and a country code: "CAFE ROSSI ROMA IT".
export function findForeignLocation(description) {
  const text = String(description).toUpperCase().replace(/\s+/g, " ").trim();
  const m = text.match(/^(.+) ([A-Z][A-Z'-]{2,}) ([A-Z]{2})$/);
  if (!m || !(m[3] in COUNTRIES) || (cityData && m[3] in cityData)) return null;
  return { city: titleCaseCity(m[2]), country: COUNTRIES[m[3]], rest: m[1] };
}

// Returns { city, state, rest } where rest is the description with the location
// removed, or null when no confident match is found. Requires loadCities() first.
export function findLocation(description) {
  if (!cityData) return null;
  const text = String(description).toUpperCase().replace(/\s+/g, " ").trim();
  const m = text.match(/^(.*?)\s?([A-Z]{2})$/);
  if (!m || !(m[2] in cityData)) return null;
  const state = m[2];
  const before = m[1].replace(/\s+$/, "");
  if (before.length < 4) return null;
  const { full, prefixes } = stateIndex(state);

  for (let k = Math.min(before.length, 40); k >= 4; k--) {
    const rawSuffix = before.slice(-k);
    if (rawSuffix.startsWith(" ")) continue;
    const suffix = normalize(rawSuffix);
    const prev = before[before.length - k - 1];
    const atBoundary = prev === undefined || !/[A-Z]/.test(prev);
    const city = full.get(suffix);
    if (city && (atBoundary || k >= 5)) {
      return { city: titleCaseCity(city), state, rest: before.slice(0, -k).trim() };
    }
    if (suffix.length >= 8) {
      const set = prefixes.get(suffix);
      if (set && set.size === 1) {
        const [only] = set;
        return { city: titleCaseCity(only), state, rest: before.slice(0, -k).trim() };
      }
    }
  }
  return null;
}
