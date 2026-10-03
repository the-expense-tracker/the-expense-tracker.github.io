// The numbers behind the Report page. Everything here is plain arithmetic on the
// user's own sorting: no guessing, no AI. Amounts are whole cents.
//
// Sign convention for the report: money out is positive for Spending, Long-term
// saving, Reimbursable, and Not counted (a refund or withdrawal subtracts), and
// money in is positive for Income. Transactions count toward their "Counts
// toward" month when one is set.

import { CATEGORY_TYPES, FREQUENCIES, MONTHS, monthKeyOf, vendorDisplayName } from "./model.js";
import { sortedCategories } from "./categories.js";

// Income, then giving, saving, and spending: the order of importance, used everywhere.
export const SECTION_ORDER = ["income", "giving", "saving", "spending", "reimbursable", "excluded"];
export const COUNTED_TYPES = ["income", "giving", "saving", "spending"];
// What's left of income after giving, saving, and spending.
export const NET_LABEL = "Net";
export const NET_HELP = "Net cash flow: income minus giving, savings, and spending.";

// Flags need this many months to compare against, and ignore small differences.
const FLAG_MIN_MONTHS = 3;
const FLAG_MIN_CENTS = 2500;

export const signFor = (type) => (type === "income" ? 1 : -1);
export const monthLabel = (key, style = "name") => {
  const m = MONTHS[Number(key.slice(5, 7)) - 1];
  return style === "abbr" ? m.abbr : `${m.name} ${key.slice(0, 4)}`;
};

// ---------- Dates ----------

const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
function monthBounds(key) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${key}-01`, `${key}-${String(last).padStart(2, "0")}`, last];
}
const shortDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1].name.slice(0, 3)} ${Number(iso.slice(8, 10))}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A bank file's dates run from its first transaction to its last, not from the
// statement's first day to its last. How much slack to allow depends on how often
// the account is used: a busy checking account has something every day or two; a
// card used once a month might start on the 15th and still be complete.
function accountSlack(store) {
  const dates = new Map();
  for (const t of store.list("transactions")) {
    if (!dates.has(t.accountId)) dates.set(t.accountId, new Set());
    dates.get(t.accountId).add(t.postedDate);
  }
  const slack = new Map();
  for (const [id, set] of dates) {
    const days = [...set].map(dayNumber).sort((a, b) => a - b);
    const gaps = days.slice(1).map((d, i) => d - days[i]);
    const usual = gaps.length ? median(gaps) : 30;
    slack.set(id, { start: clamp(Math.round(3 * usual), 6, 35), end: clamp(Math.round(1.5 * usual), 3, 35) });
  }
  return slack;
}

// Each account's imported date ranges, with files that meet (or nearly meet) merged.
export function importRanges(store, slack = accountSlack(store)) {
  const byAccount = new Map();
  for (const imp of store.list("imports")) {
    if (!imp.firstDate || !imp.lastDate || !store.get("accounts", imp.accountId)) continue;
    if (!byAccount.has(imp.accountId)) byAccount.set(imp.accountId, []);
    byAccount.get(imp.accountId).push([imp.firstDate, imp.lastDate]);
  }
  for (const [id, ranges] of byAccount) {
    const join = slack.get(id)?.start ?? 6;
    ranges.sort((a, b) => a[0].localeCompare(b[0]));
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && dayNumber(r[0]) - dayNumber(last[1]) <= join) { if (r[1] > last[1]) last[1] = r[1]; } else merged.push([...r]);
    }
    byAccount.set(id, merged);
  }
  return byAccount;
}

// For each month of the year: how much of it the imported files cover (0 to 1,
// using the best-covered account), and notes about any account that's missing
// part of it. Averages count a half-imported month as half a month; flags skip
// months that aren't fully imported.
function monthCoverage(store, year, txMonths) {
  const slack = accountSlack(store);
  const ranges = importRanges(store, slack);
  const info = new Map();
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const [start, end, length] = monthBounds(key);
    let fraction = 0;
    const notes = [];
    const after = [];
    for (const [accountId, list] of ranges) {
      const name = store.get("accounts", accountId).name;
      const { start: startSlack, end: endSlack } = slack.get(accountId) || { start: 6, end: 3 };
      const overlapping = list.filter(([a, b]) => a <= end && b >= start);
      if (overlapping.length) {
        let days = 0;
        for (const [a, b] of overlapping) days += dayNumber(b < end ? b : end) - dayNumber(a > start ? a : start) + 1;
        const from = overlapping[0][0] > start ? overlapping[0][0] : start;
        const to = overlapping[overlapping.length - 1][1] < end ? overlapping[overlapping.length - 1][1] : end;
        const gapStart = dayNumber(from) - dayNumber(start);
        const gapEnd = dayNumber(end) - dayNumber(to);
        if (gapStart <= startSlack) days += gapStart;
        if (gapEnd <= endSlack) days += gapEnd;
        const f = Math.min(1, days / length);
        fraction = Math.max(fraction, f);
        if (f < 1) {
          const missStart = gapStart > startSlack;
          const missEnd = gapEnd > endSlack;
          notes.push(missStart && missEnd ? `${name} has ${shortDate(from)} to ${shortDate(to)} only`
            : missStart ? `${name} starts ${shortDate(from)}` : missEnd ? `${name} ends ${shortDate(to)}` : `${name} has a gap this month`);
        }
      } else if (list[0][0] < start && list[list.length - 1][1] > end) {
        notes.push(`No ${name} file covers this month`);
      } else if (list[list.length - 1][1] < start && list[list.length - 1][1] >= `${year}-01-01`) {
        after.push(`Nothing from ${name} after ${shortDate(list[list.length - 1][1])}`);
      }
    }
    if (fraction > 0) notes.push(...after);
    if (fraction > 0 || txMonths.has(key)) info.set(key, { fraction, notes });
  }
  const anyCovered = [...info.values()].some((i) => i.fraction > 0);
  for (const [key, entry] of info) {
    if (!anyCovered) entry.fraction = 1; // older data without file dates: trust the transactions
    else if (entry.fraction === 0) entry.notes.unshift("No imported file covers this month; it only has transactions moved here with Counts toward");
    entry.partial = entry.fraction < 1;
    void key;
  }
  return info;
}

// ---------- Small math ----------

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const sum = (values) => values.reduce((n, v) => n + v, 0);

// Average per month. Regular categories: total ÷ months imported (a half-imported
// month counts as half). Lumpy ones (paid yearly, twice a year, or quarterly): the
// typical payment spread across a year, so two $3,000 tax bills read $500 a month.
// With a full year imported, both come out the same: the total ÷ 12.
export function averageFor(values, frequency, monthsCovered, priorYearTotal = 0) {
  if (!monthsCovered) return { cents: 0 };
  const total = sum(values);
  const perYear = FREQUENCIES[frequency]?.perYear;
  if (!perYear) return { cents: total / monthsCovered };
  if (monthsCovered >= 11.5) return { cents: total / 12 };
  const biggest = Math.max(0, ...values);
  if (biggest <= 0 || total <= 0) {
    // Nothing paid yet this year: last year's payments are the best guide.
    return priorYearTotal > 0 ? { cents: priorYearTotal / 12, basis: "prior" } : { cents: 0 };
  }
  // A "payment" is a month with a real share of the bill; refunds and small extra
  // fees count toward the amount but not as payments of their own.
  const payments = values.filter((v) => v > 0 && v >= biggest * 0.25).length;
  return { cents: Math.max((total / payments) * perYear / 12, total / monthsCovered) };
}

// ---------- Flags ----------

function flagsFor(row, months, monthInfo, dismissed) {
  const flags = new Map();
  const full = months.filter((k) => monthInfo.get(k).fraction === 1);
  if (full.length < FLAG_MIN_MONTHS || !COUNTED_TYPES.includes(row.cat.type)) return flags;
  const valueOf = (k) => row.cells.get(k)?.cents || 0;
  const frequency = row.cat.frequency;
  months.forEach((key, index) => {
    const coverage = monthInfo.get(key).fraction;
    if (coverage === 0) return; // nothing imported for this month
    const value = valueOf(key);
    const others = full.filter((k) => k !== key).map(valueOf);
    let flag = null;
    if (frequency !== "regular") {
      // Lumpy costs aren't expected every month, so only an unusually big payment
      // is flagged, plus a quarterly payment that's gone missing.
      const paid = others.filter((v) => v > 0);
      const typical = median(paid);
      if (paid.length && value > typical * 1.5 && value - typical >= FLAG_MIN_CENTS) {
        flag = { kind: "high", typical, value, text: `Payments are usually about ${dollars(typical)}. This month: ${dollars(value)}.` };
      } else if (frequency === "quarterly" && coverage === 1 && index >= 3) {
        const window = months.slice(index - 3, index + 1);
        const quiet = window.slice(1).every((k) => monthInfo.get(k).fraction === 1 && valueOf(k) <= 0);
        if (quiet && valueOf(window[0]) > 0) {
          flag = { kind: "empty", typical, value, text: `Usually paid every 3 months, last in ${MONTHS[Number(window[0].slice(5, 7)) - 1].name}. Nothing since.` };
        }
      }
    } else if (others.length >= FLAG_MIN_MONTHS - 1) {
      const typical = median(others);
      // How far is "far"? At least half the usual amount, at least $25, and well
      // outside how much this category normally swings (3 × its typical spread).
      const swing = 1.4826 * median(others.map((v) => Math.abs(v - typical)));
      const far = Math.max(3 * swing, typical * 0.5, FLAG_MIN_CENTS);
      const usual = others.filter((v) => v > 0).length / others.length >= 0.75;
      if (typical > 0 && value - typical > far) {
        flag = { kind: "high", typical, value, text: `Usually about ${dollars(typical)} a month. This month: ${dollars(value)}.` };
      } else if (typical >= FLAG_MIN_CENTS && coverage === 1) {
        if (value === 0 && usual) flag = { kind: "empty", typical, value, text: `Usually about ${dollars(typical)} a month. Nothing this month.` };
        else if (value !== 0 && typical - value > far) flag = { kind: "low", typical, value, text: `Usually about ${dollars(typical)} a month. This month: ${dollars(value)}.` };
      }
    }
    if (!flag) return;
    const id = `${row.cat.id}:${key}`;
    // A dismissed flag stays away until the amount changes.
    if (dismissed[id] === value) return;
    flags.set(key, { ...flag, id });
  });
  return flags;
}

export const dollars = (cents) => {
  const whole = Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
  return `${cents < 0 ? "−" : ""}$${whole}`;
};

// ---------- "Is it paid twice a year?" ----------

function lumpySuggestion(row, months, monthInfo, asked) {
  const { cat } = row;
  if (cat.frequency !== "regular" || !["spending", "saving", "giving"].includes(cat.type) || asked.includes(cat.id)) return null;
  const full = months.filter((k) => monthInfo.get(k).fraction === 1);
  if (full.length < 6) return null;
  const valueOf = (k) => row.cells.get(k)?.cents || 0;
  const paid = months.filter((k) => valueOf(k) >= 10000);
  const any = months.filter((k) => valueOf(k) !== 0);
  if (!paid.length || any.length !== paid.length) return null;
  const nums = paid.map((k) => Number(k.slice(5, 7)));
  const gaps = nums.slice(1).map((n, i) => n - nums[i]);
  let frequency = null;
  if (paid.length === 1) {
    // One payment could be a one-off, or something that just started; only ask
    // with most of a year to look at, and not about the latest month.
    if (full.length >= 9 && paid[0] !== months[months.length - 1]) frequency = "yearly";
  } else if (paid.length === 2) {
    if (gaps[0] >= 4 && gaps[0] <= 8) frequency = "twice";
  } else if (paid.length <= 4 && full.length >= 9) {
    const mean = sum(gaps) / gaps.length;
    if (gaps.every((g) => g >= 2 && g <= 4) && mean >= 2.5 && mean <= 3.5) frequency = "quarterly";
  }
  if (!frequency) return null;
  const names = paid.map((k) => MONTHS[Number(k.slice(5, 7)) - 1].name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const question = { yearly: "Is it paid once a year?", twice: "Is it paid twice a year?", quarterly: "Is it paid quarterly?" }[frequency];
  return { cat, frequency, text: `${cat.name} only appears in ${list}. ${question}` };
}

// ---------- The report ----------

export function reportYears(store) {
  const set = new Set();
  for (const t of store.list("transactions")) set.add(monthKeyOf(t).slice(0, 4));
  return [...set].sort().reverse();
}

export function buildReport(store, year) {
  const cats = sortedCategories(store);
  const rows = new Map(cats.map((cat) => [cat.id, { cat, cells: new Map(), total: 0, count: 0, prior: 0, average: 0, flags: new Map() }]));
  const txMonths = new Set();
  const unsorted = { count: 0, out: 0, in: 0 };
  const priorYear = String(Number(year) - 1);
  let owed = 0; // reimbursable: spent minus repaid, across every year, as of today

  for (const tx of store.list("transactions")) {
    const month = monthKeyOf(tx);
    const txYear = month.slice(0, 4);
    if (txYear === year) txMonths.add(month);
    for (const part of tx.parts) {
      const row = part.categoryId ? rows.get(part.categoryId) : null;
      if (row?.cat.type === "reimbursable") { owed -= part.amount; row.owed = (row.owed || 0) - part.amount; }
      if (row && txYear === priorYear) row.prior += signFor(row.cat.type) * part.amount;
      if (txYear !== year) continue;
      if (!row) {
        unsorted.count++;
        if (part.amount < 0) unsorted.out -= part.amount; else unsorted.in += part.amount;
        continue;
      }
      const value = signFor(row.cat.type) * part.amount;
      const cell = row.cells.get(month) || { cents: 0, count: 0 };
      cell.cents += value;
      cell.count++;
      row.cells.set(month, cell);
      row.total += value;
      row.count++;
    }
  }

  const monthInfo = monthCoverage(store, year, txMonths);
  const months = [...monthInfo.keys()].sort();
  const monthsCovered = sum(months.map((k) => monthInfo.get(k).fraction));
  const dismissed = store.getSetting("dismissedFlags", {}) || {};
  const asked = store.getSetting("frequencyAsked", []) || [];
  const suggestions = [];

  for (const row of rows.values()) {
    const values = months.map((k) => row.cells.get(k)?.cents || 0);
    // Spreading only applies to money that counts; other types average plainly.
    row.lumpy = row.cat.frequency !== "regular" && COUNTED_TYPES.includes(row.cat.type);
    const avg = averageFor(values, row.lumpy ? row.cat.frequency : "regular", monthsCovered, row.prior);
    row.average = avg.cents;
    row.averageBasis = avg.basis || null;
    row.flags = flagsFor(row, months, monthInfo, dismissed);
    const s = lumpySuggestion(row, months, monthInfo, asked);
    if (s) suggestions.push(s);
  }

  const sections = SECTION_ORDER.map((type) => ({ type, label: CATEGORY_TYPES[type].reportLabel, rows: [...rows.values()].filter((r) => r.cat.type === type) }))
    .filter((s) => s.rows.length);

  const line = (type) => {
    const list = [...rows.values()].filter((r) => r.cat.type === type);
    const cells = new Map(months.map((k) => [k, sum(list.map((r) => r.cells.get(k)?.cents || 0))]));
    return { cells, total: sum(list.map((r) => r.total)), average: sum(list.map((r) => r.average)), count: sum(list.map((r) => r.count)) };
  };
  const income = line("income");
  const giving = line("giving");
  const saving = line("saving");
  const spending = line("spending");
  const out = (k) => giving.cells.get(k) + saving.cells.get(k) + spending.cells.get(k);
  const net = {
    cells: new Map(months.map((k) => [k, income.cells.get(k) - out(k)])),
    total: income.total - giving.total - saving.total - spending.total,
    average: income.average - giving.average - saving.average - spending.average,
  };

  return {
    year,
    months,
    monthInfo,
    monthsCovered,
    rows,
    sections,
    summary: { income, giving, saving, spending, net },
    unsorted,
    owed,
    suggestions,
    hasLumpy: [...rows.values()].some((r) => r.lumpy),
  };
}

// ---------- Vendor view ----------

export function buildVendorReport(store, year, type, monthsCovered) {
  const rows = new Map();
  for (const tx of store.list("transactions")) {
    const month = monthKeyOf(tx);
    if (month.slice(0, 4) !== year) continue;
    for (const part of tx.parts) {
      const cat = part.categoryId ? store.get("categories", part.categoryId) : null;
      if (cat?.type !== type) continue;
      const name = vendorDisplayName(store.get("vendors", tx.vendorKey), tx);
      if (!rows.has(name)) rows.set(name, { name, cells: new Map(), total: 0, count: 0 });
      const row = rows.get(name);
      const value = signFor(type) * part.amount;
      const cell = row.cells.get(month) || { cents: 0, count: 0 };
      cell.cents += value;
      cell.count++;
      row.cells.set(month, cell);
      row.total += value;
      row.count++;
    }
  }
  const list = [...rows.values()];
  for (const r of list) r.average = monthsCovered ? r.total / monthsCovered : 0;
  return list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// ---------- What's behind a number ----------

// filter: { year, month?, categoryId?, type?, vendor?, vendorType? }
export function itemsBehind(store, filter) {
  const items = [];
  for (const tx of store.list("transactions")) {
    const month = monthKeyOf(tx);
    if (month.slice(0, 4) !== filter.year) continue;
    if (filter.month && month !== filter.month) continue;
    let name = null;
    for (const part of tx.parts) {
      const cat = part.categoryId ? store.get("categories", part.categoryId) : null;
      if (filter.categoryId && part.categoryId !== filter.categoryId) continue;
      if (filter.type && cat?.type !== filter.type) continue;
      if (filter.vendor) {
        name ??= vendorDisplayName(store.get("vendors", tx.vendorKey), tx);
        if (name !== filter.vendor || cat?.type !== filter.vendorType) continue;
      }
      items.push({ id: `${tx.id}:${part.id}`, tx, part, cat, month, name: name ?? vendorDisplayName(store.get("vendors", tx.vendorKey), tx) });
    }
  }
  return items.sort((a, b) => a.tx.postedDate.localeCompare(b.tx.postedDate) || a.name.localeCompare(b.name));
}
