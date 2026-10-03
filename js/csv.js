// Reads bank CSV files and works out which column is which.
// Handles quoted fields, commas inside quotes, CRLF/LF line endings, a byte-order
// mark, tab- or semicolon-separated files, summary lines above the header (Bank of
// America), files with no header row (some Wells Fargo exports), single Amount
// columns, and separate Debit/Credit columns.

import { parseDate, toCents } from "./model.js";

// ---------- Low-level parsing ----------

function detectDelimiter(text) {
  const sample = text.slice(0, 5000).split(/\r?\n/).slice(0, 10).join("\n");
  const counts = { ",": 0, "\t": 0, ";": 0 };
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
}

// Bank exports have a handful of short columns. These limits only stop a broken or
// hostile file from freezing the page; real files never come close.
const MAX_FIELD = 5000;
const MAX_COLUMNS = 200;

export function parseCsvText(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const append = (ch) => { if (field.length < MAX_FIELD) field += ch; };
  const endField = () => { if (row.length < MAX_COLUMNS) row.push(field); field = ""; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { append('"'); i++; }
        else inQuotes = false;
      } else append(ch);
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endField();
      rows.push(row); row = [];
    } else append(ch);
  }
  if (field !== "" || row.length) { endField(); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------- Column recognition ----------

const HEADER_NAMES = {
  date: ["transaction date", "trans. date", "trans date", "date", "posted date", "posting date", "post date", "effective date"],
  description: ["description", "payee", "merchant", "merchant name", "name", "details", "transaction description", "original description"],
  amount: ["amount", "transaction amount", "amount (usd)", "amount usd", "net amount"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "debit amount", "amount debit", "money out", "charges"],
  credit: ["credit", "credits", "deposit", "deposits", "credit amount", "amount credit", "money in", "payments"],
  checkNumber: ["check #", "check number", "check no", "check no.", "check", "chk #", "check or slip #", "cheque number"],
  status: ["status", "transaction status"],
  memo: ["memo", "notes", "note"],
};

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function looksLikeDate(s) {
  try { parseDate(s); return true; } catch { return false; }
}

function looksLikeAmount(s) {
  const t = String(s ?? "").trim();
  if (!t) return false;
  try { toCents(t); return true; } catch { return false; }
}

function matchHeader(cells) {
  const map = {};
  const used = new Set();
  for (const [field, names] of Object.entries(HEADER_NAMES)) {
    for (const name of names) {
      const idx = cells.findIndex((c, i) => !used.has(i) && norm(c) === name);
      if (idx >= 0) { map[field] = idx; used.add(idx); break; }
    }
  }
  return map;
}

function headerScore(map) {
  let score = 0;
  if ("date" in map) score += 2;
  if ("description" in map) score += 2;
  if ("amount" in map || "debit" in map || "credit" in map) score += 2;
  return score;
}

// Guesses columns from the data itself when a file has no header row.
function inferColumns(rows) {
  const sample = rows.slice(0, 40);
  const width = Math.max(...sample.map((r) => r.length));
  const stats = [];
  for (let c = 0; c < width; c++) {
    const vals = sample.map((r) => r[c] ?? "").filter((v) => v.trim() !== "");
    stats.push({
      c,
      dates: vals.filter(looksLikeDate).length / (sample.length || 1),
      amounts: vals.filter((v) => looksLikeAmount(v) && /[.\d]/.test(v) && !looksLikeDate(v)).length / (sample.length || 1),
      avgLen: vals.reduce((n, v) => n + v.length, 0) / (vals.length || 1),
      letters: vals.filter((v) => /[a-z]{3}/i.test(v)).length / (sample.length || 1),
    });
  }
  const map = {};
  const date = stats.filter((s) => s.dates > 0.8).sort((a, b) => a.c - b.c)[0];
  if (date) map.date = date.c;
  const amount = stats.filter((s) => s.c !== map.date && s.amounts > 0.8).sort((a, b) => a.c - b.c)[0];
  if (amount) map.amount = amount.c;
  const desc = stats.filter((s) => s.c !== map.date && s.c !== map.amount && s.letters > 0.6).sort((a, b) => b.avgLen - a.avgLen)[0];
  if (desc) map.description = desc.c;
  return map;
}

// Finds the header row (it may sit below summary lines) and maps the columns.
export function detectLayout(rows) {
  let best = { score: -1 };
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const map = matchHeader(rows[r]);
    const score = headerScore(map);
    if (score > best.score) best = { score, headerRow: r, map };
    if (score === 6) break;
  }
  if (best.score >= 6) {
    return { hasHeader: true, headerRow: best.headerRow, header: rows[best.headerRow], columns: best.map, recognized: true };
  }
  const map = inferColumns(rows);
  const recognized = "date" in map && "description" in map && "amount" in map;
  return { hasHeader: false, headerRow: -1, header: null, columns: map, recognized };
}

export function formatKeyOf(layout, rows) {
  if (layout.hasHeader) return layout.header.map(norm).join("|");
  return `no-header:${Math.max(...rows.slice(0, 10).map((r) => r.length))}`;
}

// ---------- Reading rows ----------

const PENDING = /^(pending|processing|authorized|hold)$/i;

// Turns raw rows into { line, postedDate, amount, description, checkNumber, memo } records.
// flipSigns: true when the file shows charges as positive numbers.
export function readRows(rows, layout, { flipSigns = false } = {}) {
  const c = layout.columns;
  const out = [];
  const unreadable = [];
  let pending = 0;
  const start = layout.hasHeader ? layout.headerRow + 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r];
    const line = r + 1;
    const get = (field) => (field in c ? String(cells[c[field]] ?? "").trim() : "");
    if ("status" in c && PENDING.test(get("status"))) { pending++; continue; }
    const rawDate = get("date");
    const description = get("description");
    let amount;
    try {
      if ("amount" in c) {
        const a = get("amount");
        if (!a) throw new Error("no amount");
        amount = toCents(a);
      } else {
        const d = get("debit");
        const cr = get("credit");
        if (!d && !cr) throw new Error("no amount");
        amount = (cr ? Math.abs(toCents(cr)) : 0) - (d ? Math.abs(toCents(d)) : 0);
      }
      if (flipSigns) amount = -amount;
      const postedDate = parseDate(rawDate);
      out.push({ line, postedDate, amount, description, checkNumber: get("checkNumber"), memo: get("memo") });
    } catch {
      // Summary lines ("Beginning balance as of…") and blank rows end up here.
      if (rawDate || description) unreadable.push({ line, text: cells.join(", ").slice(0, 120) });
    }
  }
  return { rows: out, pending, unreadable };
}

// Card files from some issuers show purchases as positive numbers. Payments are
// the giveaway: when payments are negative and most other lines are positive,
// the signs need flipping.
const PAYMENT_LINE = /PAYMENT\s*-?\s*THANK|AUTOPAY PAYMENT|ONLINE PAYMENT|PAYMENT RECEIVED|MOBILE PAYMENT|AUTOMATIC PAYMENT|INTERNET PAYMENT/i;

export function suggestFlip(records) {
  if (!records.length) return false;
  const payments = records.filter((r) => PAYMENT_LINE.test(r.description));
  const others = records.filter((r) => !PAYMENT_LINE.test(r.description));
  const posShare = others.filter((r) => r.amount > 0).length / (others.length || 1);
  if (payments.length) {
    const negPayments = payments.filter((r) => r.amount < 0).length / payments.length;
    return negPayments > 0.5 && posShare > 0.6;
  }
  return false;
}
