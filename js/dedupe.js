// Recognizing transactions that are already saved.
//
// Exact matches (same account, date, amount, and description) are counted rather
// than simply skipped: if a day really had two identical $35 charges and the
// earlier import had both, a new file with both adds nothing; a new file with
// three adds one.
//
// Near matches (same amount, a few days apart, similar description) usually mean
// the bank changed a pending charge when it posted. Those are added but marked as
// possible duplicates so the user decides.

export function normDesc(description) {
  return String(description ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

export function exactKey(postedDate, amount, description) {
  return `${postedDate}|${amount}|${normDesc(description)}`;
}

export function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

function words(description) {
  return new Set(normDesc(description).replace(/[^A-Z ]/g, " ").split(" ").filter((w) => w.length > 2));
}

function similar(a, b) {
  if (a.vendorKey && a.vendorKey === b.vendorKey) return true;
  const wa = words(a.description);
  const wb = words(b.description);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.5;
}

// records: cleaned rows from the file. existing: transactions already in the account.
// Returns { toAdd, skipped, possible } where possible maps a record to an existing id.
export function planAgainst(records, existing) {
  const remaining = new Map();
  for (const t of existing) {
    const k = exactKey(t.postedDate, t.amount, t.description);
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  const fileKeys = new Set(records.map((r) => exactKey(r.postedDate, r.amount, r.description)));
  const toAdd = [];
  let skipped = 0;
  for (const r of records) {
    const k = exactKey(r.postedDate, r.amount, r.description);
    const left = remaining.get(k) || 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      skipped++;
    } else {
      toAdd.push(r);
    }
  }

  // Only saved transactions the new file doesn't contain exactly can be "changed" versions.
  const candidates = existing.filter((t) => !fileKeys.has(exactKey(t.postedDate, t.amount, t.description)));
  const byAmount = new Map();
  for (const t of candidates) {
    if (!byAmount.has(t.amount)) byAmount.set(t.amount, []);
    byAmount.get(t.amount).push(t);
  }
  const claimed = new Set();
  const possible = new Map();
  for (const r of toAdd) {
    const pool = byAmount.get(r.amount);
    if (!pool) continue;
    let best = null;
    for (const t of pool) {
      if (claimed.has(t.id)) continue;
      const gap = Math.abs(daysBetween(r.postedDate, t.postedDate));
      if (gap > 4 || !similar(r, t)) continue;
      if (!best || gap < best.gap) best = { t, gap };
    }
    if (best) {
      claimed.add(best.t.id);
      possible.set(r, best.t.id);
    }
  }
  return { toAdd, skipped, possible };
}

// Share of the file's rows already saved in each account (exact matches).
export function overlapByAccount(records, transactions) {
  if (!records.length) return new Map();
  const keysByAccount = new Map();
  for (const t of transactions) {
    if (!keysByAccount.has(t.accountId)) keysByAccount.set(t.accountId, new Set());
    keysByAccount.get(t.accountId).add(exactKey(t.postedDate, t.amount, t.description));
  }
  const out = new Map();
  for (const [accountId, keys] of keysByAccount) {
    let hits = 0;
    for (const r of records) if (keys.has(exactKey(r.postedDate, r.amount, r.description))) hits++;
    out.set(accountId, hits / records.length);
  }
  return out;
}
