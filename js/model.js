// Data model: record shapes, validation, money and date helpers.
// Money is always stored as whole cents (integers) so totals never drift.
// Dates are stored as "YYYY-MM-DD" strings; months as "YYYY-MM".

export const DATA_VERSION = 2;

// Limits keep a damaged or hostile backup from filling storage or slowing the page.
const MAX_TEXT = 2000;
const MAX_NAME = 200;
// About $1 trillion, well inside the range JavaScript counts exactly.
export const MAX_CENTS = 1e14;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v) => typeof v === "string" && ID_PATTERN.test(v);
const own = (obj, key) => typeof key === "string" && Object.hasOwn(obj, key);


// Category types, in order of importance: income first, then what's given, saved,
// and spent. "label" is the name used when creating and sorting categories;
// "reportLabel" is the shorter name on the Report and in the backup file.
export const CATEGORY_TYPES = {
  income: { label: "Income", reportLabel: "Income", hint: "Paychecks, interest, and other money you earn." },
  giving: { label: "Charitable giving", reportLabel: "Giving", hint: "Donations, tithes, and other generosity." },
  saving: {
    label: "Outbound savings", reportLabel: "Savings",
    hint: "Money you send to investment, retirement, or other long-term savings accounts. (Savings taken out of your paycheck before it's deposited won't appear in your bank files.)",
  },
  spending: { label: "Spending", reportLabel: "Spending", hint: "Regular expenses like housing, bills, food, clothing, gifts, etc. Refunds should also be sorted here to offset expenses." },
  reimbursable: { label: "Reimbursable", reportLabel: "Reimbursable", hint: "Purchases someone pays you back for, and the repayments. They cancel each other out." },
  excluded: {
    label: "Not counted", reportLabel: "Not Included in Totals",
    hint: "Card payments, transfers between your own accounts, and money set aside to spend later this year, like an emergency fund.",
  },
};

export const FREQUENCIES = {
  regular: { label: "Regular", perYear: null },
  yearly: { label: "Yearly", perYear: 1 },
  twice: { label: "Twice a year", perYear: 2 },
  quarterly: { label: "Quarterly", perYear: 4 },
};

export const ACCOUNT_KINDS = ["unknown", "checking", "savings", "card"];

export const MONTHS = [
  { abbr: "JAN", name: "January", color: "#3F6488" },
  { abbr: "FEB", name: "February", color: "#A5445A" },
  { abbr: "MAR", name: "March", color: "#557A33" },
  { abbr: "APR", name: "April", color: "#5E4C96" },
  { abbr: "MAY", name: "May", color: "#B25A3A" },
  { abbr: "JUN", name: "June", color: "#2F7A6C" },
  { abbr: "JUL", name: "July", color: "#8C6A10" },
  { abbr: "AUG", name: "August", color: "#963E72" },
  { abbr: "SEP", name: "September", color: "#737029" },
  { abbr: "OCT", name: "October", color: "#A95717" },
  { abbr: "NOV", name: "November", color: "#744A70" },
  { abbr: "DEC", name: "December", color: "#2F6B4B" },
];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

// ---------- IDs ----------

export function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- Money ----------

// Accepts "1,234.56", "-12.34", "(12.00)", "$5", "−5.10", 5678.9. Returns whole cents.
export function toCents(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`"${value}" isn't a valid amount.`);
    return Math.round(value * 100);
  }
  let s = String(value ?? "").trim();
  if (!s) throw new ValidationError("The amount is empty.");
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/[−‒–—]/g, "-"); // typographic minus signs
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith("+")) { s = s.slice(1).trim(); }
  if (s.endsWith("-")) { negative = !negative; s = s.slice(0, -1).trim(); }
  s = s.replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new ValidationError(`"${value}" isn't a valid amount.`);
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2)) + (Number(frac[2] || 0) >= 5 ? 1 : 0);
  return negative ? -cents : cents;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents, { signed = false } = {}) {
  const text = usd.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${text}`;
  if (signed && cents > 0) return `+${text}`;
  return text;
}

// ---------- Dates ----------

function pad(n) { return String(n).padStart(2, "0"); }

function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Accepts M/D/YY, M/D/YYYY, YYYY-MM-DD, and Date objects. Returns "YYYY-MM-DD".
export function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const s = String(value ?? "").trim();
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [, y, m, d] = match.map(Number);
  } else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    [, m, d, y] = match.map(Number);
    if (y < 100) y += 2000;
  } else {
    throw new ValidationError(`"${s}" isn't a date this app recognizes.`);
  }
  if (!isRealDate(y, m, d)) throw new ValidationError(`"${s}" isn't a real calendar date.`);
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return isRealDate(y, m, d);
}

export function isMonthKey(s) {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// The month a transaction counts toward: the user's override, else the posted month.
export function monthKeyOf(tx) {
  return tx.countsToward || tx.postedDate.slice(0, 7);
}

export function monthInfo(monthKey) {
  const [year, m] = monthKey.split("-").map(Number);
  return { year, ...MONTHS[m - 1] };
}

// ---------- Record factories ----------

export function makeAccount({ name, kind = "unknown", order = 0 }) {
  return validateAccount({ id: newId(), name: String(name ?? "").trim().slice(0, MAX_NAME), kind, order, createdAt: new Date().toISOString() });
}

export function makeCategory({ name, type = "spending", frequency = "regular", order = 0 }) {
  return validateCategory({ id: newId(), name: String(name ?? "").trim(), type, frequency, order, createdAt: new Date().toISOString() });
}

export function makeTransaction({ accountId, importId = null, postedDate, amount, description, checkNumber = "", memo = "", vendorKey = "", location = "" }) {
  const cents = Number.isInteger(amount) ? amount : toCents(amount);
  return validateTransaction({
    id: newId(),
    accountId,
    importId,
    postedDate: isIsoDate(postedDate) ? postedDate : parseDate(postedDate),
    countsToward: null,
    amount: cents,
    description: String(description ?? "").trim().slice(0, MAX_TEXT),
    checkNumber: String(checkNumber ?? "").trim().slice(0, 50),
    memo: String(memo ?? "").trim().slice(0, MAX_TEXT),
    vendorKey: String(vendorKey ?? "").trim().slice(0, MAX_TEXT),
    location: String(location ?? "").trim().slice(0, MAX_NAME),
    // Every transaction has at least one part. A split adds more parts.
    // Each part is sorted into a category on its own; parts always sum to the amount.
    parts: [{ id: newId(), amount: cents, categoryId: null }],
    // Set when an import thinks this may repeat an existing transaction; cleared once the user decides.
    dupOf: null,
    createdAt: new Date().toISOString(),
  });
}

export function makeImport({ accountId, fileName, rows = 0, added = 0, skipped = 0, pending = 0, unreadable = 0, firstDate = null, lastDate = null, formatKey = "", fileStem = "" }) {
  return validateImport({ id: newId(), accountId, fileName: String(fileName ?? "").slice(0, 500), importedAt: new Date().toISOString(), rows, added, skipped, pending, unreadable, firstDate, lastDate, formatKey: String(formatKey).slice(0, MAX_TEXT), fileStem: String(fileStem).slice(0, 500) });
}

// ---------- Validation ----------

function requireString(rec, field, label, { allowEmpty = false, max = MAX_TEXT } = {}) {
  if (typeof rec[field] !== "string") throw new ValidationError(`${label} is missing its ${field}.`);
  if (!allowEmpty && !rec[field].trim()) throw new ValidationError(`${label} needs a ${field}.`);
  if (rec[field].length > max) throw new ValidationError(`${label} has a ${field} that's too long.`);
}

function requireId(rec, label, field = "id") {
  if (!isId(rec[field]) || (field === "id" && rec[field].length < 8)) throw new ValidationError(`${label} has a missing or invalid ${field}.`);
}

export function validateAccount(a) {
  requireId(a, "An account");
  requireString(a, "name", "An account", { max: MAX_NAME });
  if (!ACCOUNT_KINDS.includes(a.kind)) throw new ValidationError(`Account "${a.name}" has an unknown kind.`);
  if (!Number.isFinite(a.order)) throw new ValidationError(`Account "${a.name}" has an invalid order.`);
  return a;
}

export function validateCategory(c) {
  requireId(c, "A category");
  requireString(c, "name", "A category", { max: MAX_NAME });
  if (!own(CATEGORY_TYPES, c.type)) throw new ValidationError(`Category "${c.name}" has an unknown type.`);
  if (!own(FREQUENCIES, c.frequency)) throw new ValidationError(`Category "${c.name}" has an unknown frequency.`);
  if (!Number.isFinite(c.order)) throw new ValidationError(`Category "${c.name}" has an invalid order.`);
  return c;
}

export function validateImport(i) {
  requireId(i, "An import");
  requireId(i, "An import", "accountId");
  requireString(i, "fileName", "An import", { allowEmpty: true, max: 500 });
  for (const f of ["rows", "added", "skipped", "pending", "unreadable"]) {
    if (!Number.isSafeInteger(i[f]) || i[f] < 0) throw new ValidationError(`An import has an invalid ${f} count.`);
  }
  if (typeof i.importedAt !== "string" || i.importedAt.length > 40) throw new ValidationError("An import has an invalid date.");
  for (const f of ["firstDate", "lastDate"]) {
    if (i[f] !== null && !isIsoDate(i[f])) throw new ValidationError(`An import has an invalid ${f}.`);
  }
  requireString(i, "formatKey", "An import", { allowEmpty: true });
  requireString(i, "fileStem", "An import", { allowEmpty: true, max: 500 });
  return i;
}

export function validateTransaction(t) {
  requireId(t, "A transaction");
  requireId(t, "A transaction", "accountId");
  if (t.importId !== null && !isId(t.importId)) throw new ValidationError("A transaction has an invalid import.");
  if (!isIsoDate(t.postedDate)) throw new ValidationError(`A transaction has an invalid date (${t.postedDate}).`);
  if (t.countsToward !== null && !isMonthKey(t.countsToward)) throw new ValidationError("A transaction has an invalid \"counts toward\" month.");
  if (!Number.isSafeInteger(t.amount) || Math.abs(t.amount) > MAX_CENTS) throw new ValidationError("A transaction amount must be whole cents.");
  requireString(t, "description", "A transaction", { allowEmpty: true });
  for (const f of ["checkNumber", "memo", "vendorKey", "location"]) requireString(t, f, "A transaction", { allowEmpty: true });
  if (!Array.isArray(t.parts) || t.parts.length === 0 || t.parts.length > 50) throw new ValidationError("A transaction must have at least one part.");
  let sum = 0;
  for (const p of t.parts) {
    if (!p || typeof p !== "object" || !isId(p.id) || !Number.isSafeInteger(p.amount) || Math.abs(p.amount) > MAX_CENTS) throw new ValidationError("A transaction part is invalid.");
    if (p.categoryId !== null && !isId(p.categoryId)) throw new ValidationError("A transaction part has an invalid category.");
    sum += p.amount;
  }
  if (sum !== t.amount) throw new ValidationError("A transaction's split parts don't add up to its amount.");
  if (t.dupOf !== null && !isId(t.dupOf)) throw new ValidationError("A transaction has an invalid duplicate marker.");
  return t;
}

export function validateVendor(v) {
  if (typeof v.key !== "string" || !v.key || v.key.length > MAX_TEXT) throw new ValidationError("A vendor is missing its original name.");
  if (typeof v.cleanName !== "string" || v.cleanName.length > MAX_NAME) throw new ValidationError("A vendor is missing its cleaned name.");
  if (v.customName !== null && (typeof v.customName !== "string" || v.customName.length > MAX_NAME)) throw new ValidationError("A vendor has an invalid name.");
  return v;
}

// Each setting the app reads, and what its value must look like.
const isIsoTime = (v) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const SETTING_CHECKS = {
  dataVersion: (v) => Number.isInteger(v),
  lastBackupAt: (v) => v === null || isIsoTime(v),
  backupNudgeSnoozedUntil: (v) => v === null || isIsoTime(v),
  hideSuggestions: (v) => typeof v === "boolean",
  defaultCategoriesAdded: (v) => typeof v === "boolean",
  previewDemo: (v) => typeof v === "string",
  frequencyAsked: (v) => Array.isArray(v) && v.length <= 10000 && v.every(isId),
  dismissedFlags: (v) => v !== null && typeof v === "object" && !Array.isArray(v)
    && Object.entries(v).length <= 100000 && Object.entries(v).every(([k, n]) => typeof k === "string" && k.length <= 200 && Number.isFinite(n)),
};

// Only the fields each record type actually has; anything else in a backup is dropped.
export const RECORD_FIELDS = {
  accounts: ["id", "name", "kind", "order", "createdAt"],
  categories: ["id", "name", "type", "frequency", "order", "createdAt"],
  imports: ["id", "accountId", "fileName", "importedAt", "rows", "added", "skipped", "pending", "unreadable", "firstDate", "lastDate", "formatKey", "fileStem"],
  transactions: ["id", "accountId", "importId", "postedDate", "amount", "description", "checkNumber", "memo", "vendorKey", "location", "countsToward", "parts", "dupOf", "createdAt"],
  vendors: ["key", "cleanName", "customName"],
  settings: ["key", "value"],
};
export function pickFields(name, rec) {
  const allowed = RECORD_FIELDS[name];
  const out = {};
  for (const f of Object.keys(rec)) if (allowed.includes(f)) out[f] = rec[f];
  if (name === "transactions" && Array.isArray(out.parts)) {
    out.parts = out.parts.map((p) => (p && typeof p === "object" ? { id: p.id, amount: p.amount, categoryId: p.categoryId ?? null } : p));
  }
  return out;
}

export const VALIDATORS = {
  accounts: validateAccount,
  categories: validateCategory,
  imports: validateImport,
  transactions: validateTransaction,
  vendors: validateVendor,
  settings: (s) => {
    if (typeof s.key !== "string" || !s.key || s.key.length > 100) throw new ValidationError("A setting is missing its name.");
    const check = SETTING_CHECKS[s.key];
    const ok = check ? check(s.value) : s.value === null || ["string", "number", "boolean"].includes(typeof s.value);
    if (!ok) throw new ValidationError(`The "${s.key}" setting has an invalid value.`);
    return s;
  },
};

// Cross-record checks used when restoring a backup.
export function checkReferences(snapshot) {
  const accountIds = new Set(snapshot.accounts.map((a) => a.id));
  const categoryIds = new Set(snapshot.categories.map((c) => c.id));
  for (const i of snapshot.imports) {
    if (!accountIds.has(i.accountId)) throw new ValidationError("An import points to an account that isn't in the backup.");
  }
  for (const t of snapshot.transactions) {
    if (!accountIds.has(t.accountId)) throw new ValidationError("A transaction points to an account that isn't in the backup.");
    for (const p of t.parts) {
      if (p.categoryId !== null && !categoryIds.has(p.categoryId)) throw new ValidationError("A transaction points to a category that isn't in the backup.");
    }
  }
  const txIds = new Set(snapshot.transactions.map((t) => t.id));
  for (const t of snapshot.transactions) {
    if (t.dupOf !== null && !txIds.has(t.dupOf)) t.dupOf = null; // the other transaction is gone; nothing left to review
  }
}

// The name shown for a transaction: the user's rename, else the cleaned name.
export function vendorDisplayName(vendor, tx) {
  if (vendor) return vendor.customName || vendor.cleanName;
  return tx?.description || "";
}
