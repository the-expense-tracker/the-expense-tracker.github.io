// Turns raw bank descriptions into readable vendor names, a location, and a memo.
// Everything is rule-based and runs in the browser.
//
// Each result has a vendorKey: the vendor's original name with store numbers,
// locations, and reference codes removed. Renaming a vendor applies to every
// transaction with the same vendorKey, now and in future imports.

import { findLocation, findForeignLocation } from "./locations.js";

// Well-known merchants. Tested against the whole description, uppercase.
const BRANDS = [
  [/\bAMAZON\b|\bAMZN\b/, "Amazon"],
  [/\bWAL-?MART\b|\bWALMART\b/, "Walmart"],
  [/\bTARGET\b/, "Target"],
  [/\bCOSTCO\b/, "Costco"],
  [/\bALDI\b/, "Aldi"],
  [/\bTRADER JOE/, "Trader Joe's"],
  [/\bWHOLE ?FOODS\b|\bWHOLEFDS\b/, "Whole Foods"],
  [/\bSPROUTS\b/, "Sprouts"],
  [/\bRALPHS\b/, "Ralphs"],
  [/\bVONS\b/, "Vons"],
  [/\bSAFEWAY\b/, "Safeway"],
  [/\bKROGER\b/, "Kroger"],
  [/\bSMART (AND|&) FINAL\b/, "Smart & Final"],
  [/\bSTARBUCKS\b/, "Starbucks"],
  [/\bMC ?DONALD'?S?\b/, "McDonald's"],
  [/\bCHICK-?FIL-?A\b/, "Chick-fil-A"],
  [/\bIN-N-OUT\b/, "In-N-Out"],
  [/\bCHIPOTLE\b/, "Chipotle"],
  [/\bPANERA\b/, "Panera Bread"],
  [/\bDOMINO'?S\b/, "Domino's"],
  [/\bHOME ?DEPOT\b/, "Home Depot"],
  [/\bLOWE'?S\b/, "Lowe's"],
  [/\bCVS\b/, "CVS"],
  [/\bWALGREENS\b/, "Walgreens"],
  [/\bAPPLE\.COM|\bAPPLE COM BILL\b/, "Apple"],
  [/\bSPOTIFY\b/, "Spotify"],
  [/\bNETFLIX\b/, "Netflix"],
  [/\bHULU\b/, "Hulu"],
  [/\bDISNEY ?PLUS\b|\bDISNEYPLUS\b/, "Disney+"],
  [/\bAUDIBLE\b/, "Audible"],
  [/\bPATREON\b/, "Patreon"],
  [/\bUBER ?EATS\b/, "Uber Eats"],
  [/\bUBER\b/, "Uber"],
  [/\bLYFT\b/, "Lyft"],
  [/\bCHEVRON\b/, "Chevron"],
  [/\bSHELL OIL\b|^SHELL\b/, "Shell"],
  [/\bARCO\b/, "Arco"],
  [/\bGEICO\b/, "GEICO"],
  [/\bSO ?CAL ?EDISON\b|\bSOUTHERN CALIFORNIA EDISON\b/, "Southern California Edison"],
  [/\bSOCALGAS\b|^SO CAL GAS\b/, "SoCalGas"],
  [/\bFRONTIER COMMUNI/, "Frontier Communications"],
  [/\bMASS ?MUTUAL\b|\bMASSACHUSETTS MU\b/, "MassMutual"],
  [/\bFRANCHISE TAX B/, "CA Franchise Tax Board"],
  [/\bST OF CA DMV\b|\bCA DMV\b/, "CA DMV"],
  [/^IRS\b/, "IRS"],
  [/\bSCHWAB\b/, "Charles Schwab"],
  [/\bSCHOLARSHARE\b/, "ScholarShare"],
  [/\bBRGHTWHL\b|\bBRIGHTWHEEL\b/, "Brightwheel"],
  [/\bPAYPAL\b/, "PayPal"],
  [/\bVENMO\b/, "Venmo"],
  [/\bUNITED AIRLINES\b|\bUNITED \d/, "United Airlines"],
  [/\bDELTA AIR\b/, "Delta Air Lines"],
  [/\bSOUTHWEST\b/, "Southwest Airlines"],
  [/\bHERTZ\b/, "Hertz"],
  [/\bTHE UPS STORE\b/, "The UPS Store"],
  [/\bUSPS\b/, "USPS"],
  [/\bDOORDASH\b/, "DoorDash"],
  [/\bINSTACART\b/, "Instacart"],
  [/\bOLD ?NAVY\b|\bOLDNAVY\b/, "Old Navy"],
  [/\bFIVE BELOW\b/, "Five Below"],
  [/\bRECREATION\.GOV\b/, "Recreation.gov"],
  [/\bSINGAPORE ?AIR/, "Singapore Airlines"],
  [/\bALASKA AIR\b/, "Alaska Airlines"],
  [/\bAIRBNB\b/, "Airbnb"],
  [/\bGOODWILL\b/, "Goodwill"],
  [/\bFRONTIER AI\b|\bFRONTIER AIRLINES\b/, "Frontier Airlines"],
  [/\bAMERICAN AIR/, "American Airlines"],
  [/\bBRITISH AWYS|\bBRITISH AIRWAYS\b/, "British Airways"],
  [/\bEBAY\b/, "eBay"],
  [/\bCARL'?S JR\b/, "Carl's Jr."],
  [/\bRAISING CANE/, "Raising Cane's"],
  [/\bFLYING J\b/, "Flying J"],
  [/\bBASKIN\b/, "Baskin-Robbins"],
  [/\bEXXON\b/, "Exxon"],
  [/\bBARNES ?(&|AND)? ?NOBLE\b/, "Barnes & Noble"],
  [/^AMC\b/, "AMC Theatres"],
  [/\bWENDY'?S\b/, "Wendy's"],
  [/\bDENNY'?S\b/, "Denny's"],
  [/\bSUBWAY\b/, "Subway"],
  [/\bAUTOZONE\b/, "AutoZone"],
  [/\bDOLLAR TREE\b/, "Dollar Tree"],
  [/\bALBERTSONS\b/, "Albertsons"],
  [/\bJIFFY LUBE\b/, "Jiffy Lube"],
  [/\bFANDANGO\b/, "Fandango"],
  [/\bSTEAM ?GAMES\b|\bWL \*\s?STEAM\b/, "Steam"],
];

// Card processors that put their own prefix in front of the merchant.
const PROCESSOR_PREFIX = /^([A-Z0-9]{2,4}|GOOGLE|PAYPAL|PRICELN|SUMUP|GUESTRS)\s?\*\s?(?=[A-Z0-9])/;

// Bank transaction codes worth keeping in the name, with friendlier wording.
const KEEP_DETAIL = {
  PAYROLL: "payroll",
  PAYABLES: "accounts payable",
  "TAX REF": "tax refund",
  CASTTAXRFD: "tax refund",
  USATAXPYMT: "tax payment",
  PAYMENTS: "payment",
  "CLAIM REIM": "claim reimbursement",
  CASHOUT: "cashout",
  "MTG PYMT": "mortgage payment",
  "AUTO PAY": "autopay",
  CRCARDPMT: "card payment",
  "ACH CONTRIB": "contribution",
  CONTRIB: "contribution",
  TRANSFER: "transfer",
  "EXP REIMB": "reimbursement",
};

const SMALL_WORDS = new Set(["and", "of", "the", "at", "for", "to", "in", "on", "a", "an", "or", "by"]);
const ACRONYMS = new Set(["LAX", "SLO", "PTA", "NP", "CU", "FCU", "IRS", "DMV", "CVS", "UPS", "USPS", "ATT", "AT&T", "BP", "HOA", "ACH", "ATM", "LLC", "USA", "CA", "WF", "BC", "TJ", "KFC", "IHOP", "AAA", "YMCA", "DBA"]);
const MONTHS = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/;

export function titleCase(text) {
  const words = text.toLowerCase().split(" ").filter(Boolean);
  return words
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper.replace(/[^A-Z&]/g, ""))) return upper;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.replace(/(^|[-/(])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/'S\b/g, "'s");
    })
    .join(" ");
}

function collapse(s) {
  return s.replace(/\s+/g, " ").trim();
}

function brandOf(text) {
  const up = text.toUpperCase();
  for (const [re, name] of BRANDS) if (re.test(up)) return name;
  return null;
}

function friendlyName(core) {
  return brandOf(core) || titleCase(core);
}

// Removes reference codes, store numbers, phone numbers, masks, and web addresses.
function stripNoise(text) {
  let s = ` ${text} `;
  s = s.replace(/\bREF\s*#?\s*\S+/g, " ");
  s = s.replace(/\bX{3,}\d*\b/g, " ");
  s = s.replace(/\bST-[A-Z0-9]+\b/g, " ");
  s = s.replace(/\b\d{3}[-.]\d{3}[-.]?\d{4}\b|\b\d{3}-\d{5,}\b/g, " ");
  s = s.replace(/#\s?\d+/g, " ");
  s = s.replace(/\*\s?[A-Z0-9]*\d[A-Z0-9]*\b/g, " ");
  s = s.replace(/\b[A-Z0-9]{5,}\b/g, (tok) => (/\d/.test(tok) && /[A-Z]/.test(tok) && !/^[A-Z]+\d{1,2}$/.test(tok) ? " " : tok));
  s = s.replace(/\b\d+[A-Z]{0,2}\b/g, (tok) => (tok.length >= 3 ? " " : tok));
  s = s.replace(/\b([A-Z]{3,})\d{4,}\S*/g, "$1");
  s = s.replace(/\b\d{3,}\b/g, " ");
  s = s.replace(/\S*@\S*/g, " ");
  let words = collapse(s).split(" ");
  words = words.filter((w, i) => !/(\.COM|\.NET|\.ORG|WWW\.)/.test(w) || i === 0 || words.length === 1);
  if (words.length > 1) {
    // "BLUEFINCHGOODS BLUEFINCHGOOCA": a shop name repeated as a squashed web name
    const last = words[words.length - 1].replace(/[^A-Z]/g, "");
    const earlier = words.slice(0, -1).join("").replace(/[^A-Z]/g, "");
    if (last.length >= 6 && earlier.startsWith(last.slice(0, 6))) words.pop();
  }
  while (words.length > 1 && /^(INTERNET|ONLINE|WEB|PURCHASE|POS|DEBIT|RECURRING)$/.test(words[words.length - 1])) words.pop();
  s = words.join(" ");
  s = s.replace(/[\s,&*/-]+$/g, "").replace(/^[\s,&*/-]+/g, "");
  s = s.replace(/\s*,?\s*\b(INC|LLC|CORP|CO INC|LTD)\.?$/g, "");
  s = s.replace(/\s\S+\/$/g, ""); // "…FEE MINN/" left after a location
  s = s.replace(/(\s[A-Z])+$/g, ""); // stray single letters at the end
  s = s.replace(/[\s,&*/-]+$/g, "").replace(/^[\d\s*#-]+(?=[A-Z])/, "");
  return collapse(s);
}

// ---------- Special formats ----------

function zelle(up) {
  const m = up.match(/^ZELLE (TO|FROM)\s+(.+?)\s+ON \d{1,2}\/\d{1,2}\s+REF\s*#\s*\S+\s*(.*)$/);
  if (!m) return null;
  const direction = m[1] === "TO" ? "to" : "from";
  const person = collapse(m[2]);
  return { vendorKey: `ZELLE ${m[1]} ${person}`, cleanName: `Zelle ${direction} ${titleCase(person)}`, memo: collapse(m[3]) };
}

function onlineTransfer(up) {
  let m = up.match(/^(ONLINE|RECURRING) TRANSFER(?: REF\s*#\s*\S+)? (TO|FROM)\s+(.+)$/);
  if (!m) return null;
  const direction = m[2] === "TO" ? "to" : "from";
  let target = m[3];
  let memo = "";
  const refMemo = target.match(/\bREF\s*#\s*\S+\s*(.*)$/);
  if (refMemo) { memo = refMemo[1].replace(/^ON \d{1,2}\/\d{1,2}\/\d{2,4}\s*/, ""); target = target.slice(0, refMemo.index); }
  const onMemo = target.match(/\bON \d{1,2}\/\d{1,2}\/\d{2,4}\s*(.*)$/);
  if (onMemo) { memo = memo || onMemo[1]; target = target.slice(0, onMemo.index); }
  target = target.replace(/\bX{3,}\d*.*$/, "");
  target = stripNoise(collapse(target));
  const kind = m[1] === "RECURRING" ? "Recurring transfer" : "Transfer";
  return { vendorKey: `${m[1]} TRANSFER ${m[2]} ${target}`, cleanName: `${kind} ${direction} ${titleCase(target)}`, memo: collapse(memo) };
}

function instantPayment(up) {
  const m = up.match(/^INSTANT PMT (FROM|TO)\s+(.+?)\s+ON \d{1,2}\/\d{1,2}/);
  if (!m) return null;
  const who = stripNoise(collapse(m[2]));
  return { vendorKey: `INSTANT PMT ${m[1]} ${who}`, cleanName: friendlyName(who), memo: "" };
}

function cardPaymentLine(up) {
  if (/^(AUTOMATIC PAYMENT|ONLINE PAYMENT|AUTOPAY PAYMENT|INTERNET PAYMENT|MOBILE PAYMENT|PAYMENT RECEIVED)\b.*THANK|^PAYMENT THANK YOU|^PAYMENT - THANK YOU/.test(up)) {
    return { vendorKey: "CARD PAYMENT RECEIVED", cleanName: "Card payment received", memo: "" };
  }
  return null;
}

function mobileDeposit(up) {
  if (/^MOBILE DEPOSIT\b/.test(up)) return { vendorKey: "MOBILE DEPOSIT", cleanName: "Mobile deposit", memo: "" };
  if (/^(ATM |)DEPOSIT\b/.test(up) && !/\bINT(EREST)?\b/.test(up)) return { vendorKey: "DEPOSIT", cleanName: "Deposit", memo: "" };
  return null;
}

// Wells Fargo-style ACH lines: a 16-character company name, a short code, then
// dates and reference numbers separated by runs of spaces.
function achLine(raw) {
  if (!/\S\s{3,}\S/.test(raw)) return null;
  let originator;
  let rest;
  const b2b = raw.match(/^BUSINESS TO BUSINESS ACH\s+(.+?)\s{2,}(.+)$/i);
  if (b2b) {
    originator = b2b[1];
    rest = b2b[2];
  } else {
    originator = raw.slice(0, 16);
    rest = raw.slice(16);
    if (raw.length > 16 && raw[16] !== " " && raw[15] !== " ") {
      const cut = raw.search(/\s{2,}/);
      originator = raw.slice(0, cut);
      rest = raw.slice(cut);
    }
  }
  originator = collapse(originator.toUpperCase()).replace(/\s\d+$/, "");
  const detailWords = [];
  for (const tok of collapse(rest.toUpperCase()).split(" ")) {
    if (!/^[A-Z&.'-]{2,}$/.test(tok) || MONTHS.test(tok)) break;
    detailWords.push(tok);
  }
  const detail = detailWords.join(" ").replace(/[-.]+$/, "");
  const keep = KEEP_DETAIL[detail];
  let name = friendlyName(stripNoise(originator) || originator);
  if (name === "Venmo") name = detail === "CASHOUT" ? "Venmo cashout" : "Venmo payment";
  else if (name === "Brightwheel") {
    const school = originator.replace(/^BRGHTWHL\*?\s*/, "");
    name = school ? `Brightwheel (${titleCase(school)})` : name;
  } else if (keep) name = `${name} ${keep}`;
  const vendorKey = collapse(`${stripNoise(originator) || originator} ${detail}`);
  // A long number after the date is often the account being paid. The importer
  // keeps its last four digits only if it repeats (see importer.js).
  const accountRef = (collapse(rest).match(/\b\d{10,}\b/) || [])[0] || "";
  return { vendorKey, cleanName: name, memo: "", accountRef };
}

// Bank of America-style lines.
// ACH: "COMPANY NAME DES:PAYROLL ID:XXXXX123 INDN:LAST,FIRST CO ID:XXXXX456 PPD"
function desLine(up) {
  const m = up.match(/^(.+?)\s+DES:\s*(.*?)(?:\s+ID:.*)?$/);
  if (!m) return null;
  const originator = collapse(m[1]);
  const detail = collapse(m[2]);
  const core = stripNoise(originator) || originator;
  const keep = KEEP_DETAIL[detail];
  const name = friendlyName(core);
  return { vendorKey: collapse(`${core} ${detail}`), cleanName: keep ? `${name} ${keep}` : name, memo: "" };
}

// 'Zelle payment to Pat Lee for "dinner"; Conf# abc123'
function bofaZelle(raw) {
  const m = collapse(raw).match(/^Zelle (?:payment|transfer) (to|from)\s+(.+?)(?:\s+for\s+"(.*)")?\s*;?\s*Conf#.*$/i);
  if (!m) return null;
  const direction = m[1].toLowerCase();
  const person = collapse(m[2]).toUpperCase();
  return { vendorKey: `ZELLE ${direction.toUpperCase()} ${person}`, cleanName: `Zelle ${direction} ${titleCase(person)}`, memo: m[3] ? collapse(m[3]) : "" };
}

// "Online Banking transfer to SAV 4821 Confirmation# 1234567890"
function bofaTransfer(up) {
  const m = up.match(/^ONLINE BANKING TRANSFER (TO|FROM)\s+(CHK|SAV|MMS|CRD)\s*(\d{3,})?/);
  if (!m) return null;
  const kinds = { CHK: "checking", SAV: "savings", MMS: "money market", CRD: "card" };
  const direction = m[1] === "TO" ? "to" : "from";
  const last4 = m[3] ? ` ${m[3].slice(-4)}` : "";
  return { vendorKey: `ONLINE BANKING TRANSFER ${m[1]} ${m[2]}${last4}`, cleanName: `Transfer ${direction} ${kinds[m[2]]}${last4}`, memo: "" };
}

// "BKOFAMERICA ATM 03/06 #000001265 WITHDRWL MAIN ST ANYTOWN CA"
function bofaAtm(up) {
  const m = up.match(/^BKOFAMERICA (?:ATM|MOBILE)\b.*?\b(WITHDRWL|DEPOSIT)\b/);
  if (!m) return null;
  return m[1] === "DEPOSIT"
    ? { vendorKey: "DEPOSIT", cleanName: "Deposit", memo: "" }
    : { vendorKey: "ATM WITHDRAWAL", cleanName: "ATM withdrawal", memo: "" };
}

function checkLine(up, checkNumber) {
  const num = checkNumber || (up.match(/^CHECK\s*#?\s*(\d+)/) || [])[1];
  if (/^CHECK\b/.test(up) && num) return { vendorKey: `CHECK #${num}`, cleanName: `Check #${num}`, memo: "" };
  return null;
}

// ---------- Main entry ----------

// Returns { vendorKey, cleanName, location, memo }.
export function cleanDescription(rawDescription, { checkNumber = "", memo = "" } = {}) {
  const raw = String(rawDescription ?? "").trim();
  const up = collapse(raw.toUpperCase());
  const base = { location: "", memo: memo ? collapse(memo) : "" };
  if (!up) return { vendorKey: "UNKNOWN", cleanName: checkNumber ? `Check #${checkNumber}` : "Unnamed transaction", ...base };

  const special = checkLine(up, checkNumber) || zelle(up) || bofaZelle(raw) || onlineTransfer(up) || bofaTransfer(up) || bofaAtm(up)
    || instantPayment(up) || cardPaymentLine(up) || mobileDeposit(up) || desLine(up);
  if (special) return { ...base, ...special, memo: special.memo || base.memo };

  const ach = achLine(raw);
  if (ach) return { ...base, ...ach };

  // Card purchase: merchant, then city and state.
  let core = up;
  let location = "";
  const loc = findLocation(up);
  const abroad = loc ? null : findForeignLocation(up);
  if (loc) {
    location = `${loc.city}, ${loc.state}`;
    core = loc.rest;
  } else if (abroad) {
    location = `${abroad.city}, ${abroad.country}`;
    core = abroad.rest;
  } else {
    core = core.replace(/\s[A-Z]{2}$/, ""); // a lone state code with no city
  }
  core = core.replace(PROCESSOR_PREFIX, "").replace(/^SP\s+(?=\S+\s)/, "");
  if (/^DD\s?\*/.test(up)) core = core.replace(/\s*DOORDASH\.?COM.*$/, "");
  const starSplit = core.match(/^([A-Z][A-Z0-9 .'&-]{2,})\*\s*(.*)$/);
  if (starSplit) core = /\d/.test(starSplit[2].split(" ")[0] || "") ? starSplit[1] : `${starSplit[1]} ${starSplit[2]}`;
  const cleaned = stripNoise(core) || collapse(core) || up;
  const brand = brandOf(up.replace(/^DD\s?\*.*$/, "")) || brandOf(cleaned);
  let cleanName = brand || titleCase(cleaned);
  if (/^DD\s?\*/.test(up) && cleanName !== "DoorDash") cleanName = `${cleanName} (DoorDash)`;
  const vendorKey = brand ? brand.toUpperCase() : cleaned;
  return { vendorKey, cleanName, location, memo: base.memo };
}
