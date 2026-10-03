// Importing a CSV: read it, recognize it, clean it, pick an account, save it.
// Everything happens in the browser; the file is read with the browser's own
// file reader and never sent anywhere.

import { parseCsvText, detectLayout, readRows, suggestFlip, formatKeyOf } from "./csv.js";
import { cleanDescription } from "./vendors.js";
import { loadCities } from "./locations.js";
import { planAgainst, overlapByAccount } from "./dedupe.js";
import { findPairs, looksLikeCardPayment } from "./hints.js";
import { makeAccount, makeImport, makeTransaction, ValidationError } from "./model.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Drops words with digits: dates, account numbers, download codes.
function withoutCodes(name) {
  return String(name)
    .replace(/\.[^.]+$/, "")
    .split(/[\s_-]+/)
    .map((w) => w.replace(/^\d+|\d+$/g, ""))
    .filter((w) => w && !/\d/.test(w))
    .join(" ");
}

export function fileStemOf(fileName) {
  return withoutCodes(fileName)
    .replace(/\(\d+\)/g, "")
    .replace(/\d{4}[-_.]?\d{2}[-_.]?\d{2}|\d+/g, "")
    .replace(/[^a-z]+/gi, " ")
    .trim()
    .toLowerCase();
}

function suggestAccountName(fileName, kind) {
  const base = withoutCodes(fileName)
    .replace(/\(\d+\)/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\d[\d\s]*\b/g, " ")
    .replace(/\b(export|transactions?|download|statement|activity|history|csv)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (base && /[a-z]/i.test(base)) return base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return kind === "card" ? "Credit Card" : kind === "checking" ? "Checking" : kind === "savings" ? "Savings" : "";
}

export function detectKind(records) {
  if (!records.length) return "unknown";
  const cardPayments = records.filter((r) => r.amount > 0 && /PAYMENT\s*-?\s*THANK|AUTOMATIC PAYMENT|ONLINE PAYMENT|PAYMENT RECEIVED|INTERNET PAYMENT|AUTOPAY PAYMENT/i.test(r.description)).length;
  if (cardPayments > 0) return "card";
  const checkingSigns = records.filter((r) => /PAYROLL|DIRECT DEP|\bDEPOSIT\b|\bZELLE\b|\bCHECK\b|\bACH\b/i.test(r.description) || r.checkNumber).length;
  if (checkingSigns / records.length > 0.05) return "checking";
  const located = records.filter((r) => r.location).length;
  if (located / records.length > 0.4 && records.filter((r) => r.amount < 0).length / records.length > 0.8) return "card";
  if (records.length < 40 && records.every((r) => /TRANSFER|INTEREST|DIVIDEND|DEPOSIT|WITHDRAWAL/i.test(r.description))) return "savings";
  return "unknown";
}

function cleanRecords(rows, store) {
  const records = rows.map((r) => ({ ...r, ...cleanDescription(r.description, r) }));
  separateCardNumbers(records, store);
  return records;
}

// Card payments from checking can look identical for two different cards except
// for an account number. When that number repeats across payments it identifies
// the card, so its last four digits go in the name ("Card autopay ••1234").
// When it changes every time (a confirmation number), it's dropped.
function separateCardNumbers(records, store) {
  const counts = new Map();
  const eligible = records.filter((r) => r.accountRef && looksLikeCardPayment(r.description));
  for (const r of eligible) counts.set(r.accountRef, (counts.get(r.accountRef) || 0) + 1);
  for (const r of eligible) {
    const last4 = r.accountRef.slice(-4);
    const key = `${r.vendorKey} ${last4}`;
    if (counts.get(r.accountRef) >= 2 || store?.get("vendors", key)) {
      r.vendorKey = key;
      r.cleanName = `${r.cleanName} \u2022\u2022${last4}`;
    }
  }
}

function dateRange(records) {
  if (!records.length) return { firstDate: null, lastDate: null };
  let first = records[0].postedDate;
  let last = first;
  for (const r of records) {
    if (r.postedDate < first) first = r.postedDate;
    if (r.postedDate > last) last = r.postedDate;
  }
  return { firstDate: first, lastDate: last };
}

// Reads and recognizes a file. Throws ValidationError with a message for the user.
export async function analyzeFile(file, store) {
  if (!/\.(csv|txt|tsv)$/i.test(file.name) && !/csv|text/.test(file.type || "")) {
    throw new ValidationError(`${file.name} isn't a CSV file. Download your transactions from your bank as CSV, then add that file.`);
  }
  if (file.size > MAX_FILE_BYTES) throw new ValidationError(`${file.name} is larger than 20 MB, which is too big for a bank export.`);
  const text = await file.text();
  return analyzeText(file.name, text, store);
}

export async function analyzeText(fileName, text, store) {
  await loadCities();
  const rawRows = parseCsvText(text);
  if (!rawRows.length) throw new ValidationError(`${fileName} is empty.`);
  const layout = detectLayout(rawRows);
  const analysis = {
    fileName,
    fileStem: fileStemOf(fileName),
    rawRows,
    layout,
    formatKey: formatKeyOf(layout, rawRows),
    flip: false,
    flipSuggested: false,
    store,
  };
  if (layout.recognized) {
    const first = readRows(rawRows, layout);
    analysis.flipSuggested = suggestFlip(first.rows);
    analysis.flip = analysis.flipSuggested;
  }
  rebuild(analysis);
  analysis.suggestion = suggestAccount(analysis, store);
  return analysis;
}

// Re-reads the rows after the user changes column choices or the sign setting.
export function rebuild(analysis, { columns, flip } = {}) {
  if (columns) {
    analysis.layout = { ...analysis.layout, columns, recognized: "date" in columns && "description" in columns && ("amount" in columns || "debit" in columns || "credit" in columns) };
  }
  if (flip !== undefined) analysis.flip = flip;
  if (!analysis.layout.recognized) {
    Object.assign(analysis, { records: [], pending: 0, unreadable: [], kind: "unknown", firstDate: null, lastDate: null });
    return analysis;
  }
  const read = readRows(analysis.rawRows, analysis.layout, { flipSigns: analysis.flip });
  analysis.records = cleanRecords(read.rows, analysis.store);
  analysis.pending = read.pending;
  analysis.unreadable = read.unreadable;
  analysis.kind = detectKind(analysis.records);
  Object.assign(analysis, dateRange(analysis.records));
  return analysis;
}

// Picks the most likely account, so adding next month's file is one click.
// The user always confirms.
export function suggestAccount(analysis, store) {
  const accounts = store.list("accounts");
  const newName = uniqueName(suggestAccountName(analysis.fileName, analysis.kind), accounts);
  if (!accounts.length) return { accountId: null, reason: "", newName };

  const overlap = overlapByAccount(analysis.records, store.list("transactions"));
  const bestOverlap = [...overlap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (bestOverlap && bestOverlap[1] >= 0.2) {
    const pct = Math.round(bestOverlap[1] * 100);
    return { accountId: bestOverlap[0], reason: `${pct}% of this file is already in this account.`, newName };
  }
  const imports = store.list("imports").sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  const sameFile = imports.find((i) => i.formatKey === analysis.formatKey && i.fileStem && i.fileStem === analysis.fileStem && store.get("accounts", i.accountId));
  if (sameFile) return { accountId: sameFile.accountId, reason: "Matches a file you added to this account before.", newName };
  const sameKind = imports.filter((i) => i.formatKey === analysis.formatKey && store.get("accounts", i.accountId)?.kind === analysis.kind && analysis.kind !== "unknown");
  const ids = [...new Set(sameKind.map((i) => i.accountId))];
  if (ids.length === 1) return { accountId: ids[0], reason: "Same format and account type as a file you added before.", newName };
  return { accountId: null, reason: "", newName };
}

function uniqueName(name, accounts) {
  if (!name) return "";
  const taken = new Set(accounts.map((a) => a.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

export function previewPlan(analysis, accountId, store) {
  const existing = accountId ? store.list("transactions").filter((t) => t.accountId === accountId) : [];
  return planAgainst(analysis.records, existing);
}

// Saves the import in one all-or-nothing write. Returns a summary for the user.
export async function commitImport(analysis, { accountId = null, newAccountName = "" }, store) {
  if (!analysis.records.length) throw new ValidationError("There are no transactions to add from this file.");
  let account;
  const changes = { accounts: { put: [] }, imports: { put: [] }, transactions: { put: [] }, vendors: { put: [] } };
  if (accountId) {
    account = store.get("accounts", accountId);
    if (!account) throw new ValidationError("That account no longer exists. Choose another.");
    if (account.kind === "unknown" && analysis.kind !== "unknown") {
      account = { ...account, kind: analysis.kind };
      changes.accounts.put.push(account);
    }
  } else {
    const name = String(newAccountName).trim();
    if (!name) throw new ValidationError("Give the new account a name, like Chase Checking.");
    if (store.list("accounts").some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new ValidationError(`You already have an account named ${name}. Choose it from the list, or use a different name.`);
    }
    const order = Math.max(-1, ...store.list("accounts").map((a) => a.order)) + 1;
    account = makeAccount({ name, kind: analysis.kind, order });
    changes.accounts.put.push(account);
  }

  const plan = previewPlan(analysis, accountId, store);
  const imp = makeImport({
    accountId: account.id,
    fileName: analysis.fileName,
    rows: analysis.records.length,
    added: plan.toAdd.length,
    skipped: plan.skipped,
    pending: analysis.pending,
    unreadable: analysis.unreadable.length,
    firstDate: analysis.firstDate,
    lastDate: analysis.lastDate,
    formatKey: analysis.formatKey,
    fileStem: analysis.fileStem,
  });
  changes.imports.put.push(imp);

  const seenVendors = new Set();
  for (const r of plan.toAdd) {
    const tx = makeTransaction({
      accountId: account.id,
      importId: imp.id,
      postedDate: r.postedDate,
      amount: r.amount,
      description: r.description,
      checkNumber: r.checkNumber,
      memo: r.memo,
      vendorKey: r.vendorKey,
      location: r.location,
    });
    tx.dupOf = plan.possible.get(r) || null;
    changes.transactions.put.push(tx);
    if (!seenVendors.has(r.vendorKey) && !store.get("vendors", r.vendorKey)) {
      seenVendors.add(r.vendorKey);
      changes.vendors.put.push({ key: r.vendorKey, cleanName: r.cleanName, customName: null });
    }
  }
  await store.apply(changes);

  const newIds = new Set(changes.transactions.put.map((t) => t.id));
  const pairs = findPairs(store.list("transactions"));
  let paired = 0;
  for (const id of newIds) if (pairs.has(id)) paired++;
  const unmatchedPayments = changes.transactions.put.filter((t) => !pairs.has(t.id) && t.amount < 0 && looksLikeCardPayment(t.description) && account.kind !== "card").length;

  return {
    accountId: account.id,
    accountName: account.name,
    isNewAccount: !accountId,
    added: plan.toAdd.length,
    skipped: plan.skipped,
    possible: plan.possible.size,
    pending: analysis.pending,
    unreadable: analysis.unreadable.length,
    paired,
    unmatchedPayments,
    sample: changes.transactions.put.slice(0, 40),
  };
}

// ---------- Account management ----------

export async function renameAccount(store, accountId, name) {
  const clean = String(name).trim();
  const account = store.get("accounts", accountId);
  if (!account) return;
  if (!clean) throw new ValidationError("An account needs a name.");
  if (store.list("accounts").some((a) => a.id !== accountId && a.name.toLowerCase() === clean.toLowerCase())) {
    throw new ValidationError(`You already have an account named ${clean}.`);
  }
  if (clean !== account.name) await store.put("accounts", { ...account, name: clean });
}

export async function removeAccount(store, accountId) {
  const txIds = store.list("transactions").filter((t) => t.accountId === accountId).map((t) => t.id);
  const gone = new Set(txIds);
  const clearDup = store.list("transactions").filter((t) => t.dupOf && gone.has(t.dupOf) && !gone.has(t.id)).map((t) => ({ ...t, dupOf: null }));
  await store.apply({
    accounts: { remove: [accountId] },
    imports: { remove: store.list("imports").filter((i) => i.accountId === accountId).map((i) => i.id) },
    transactions: { remove: txIds, put: clearDup },
  });
  return txIds.length;
}

// ---------- Possible duplicates ----------

export function possibleDuplicates(store) {
  return store.list("transactions")
    .filter((t) => t.dupOf && store.get("transactions", t.dupOf))
    .map((t) => ({ tx: t, original: store.get("transactions", t.dupOf) }))
    .sort((a, b) => b.tx.postedDate.localeCompare(a.tx.postedDate));
}

export async function keepBoth(store, txId) {
  const t = store.get("transactions", txId);
  if (t) await store.put("transactions", { ...t, dupOf: null });
}

export async function removeDuplicate(store, txId) {
  await store.remove("transactions", txId);
}

// Renames a vendor everywhere it appears, now and in future imports.
export async function renameVendor(store, vendorKey, name) {
  const v = store.get("vendors", vendorKey);
  const clean = String(name).trim();
  if (!v) return;
  await store.put("vendors", { ...v, customName: clean && clean !== v.cleanName ? clean : null });
}
