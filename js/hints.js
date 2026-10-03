// Hints shown on transactions. Hints are labels only: the app never moves or
// sorts anything on its own.

import { daysBetween } from "./dedupe.js";

const CARD_PAYMENT = /AUTOMATIC PAYMENT|ONLINE PAYMENT|AUTOPAY PAYMENT|PAYMENT\s*-?\s*THANK|PAYMENT RECEIVED|INTERNET PAYMENT|MOBILE PAYMENT|\bAUTO ?PAY\b|CRCARDPMT|CREDIT ?CARD|\bCARD ?PMT\b|CARD PAYMENT|\bEPAY\b|TRANSFER\b.*\b(CARD|VISA|MASTERCARD|AMEX|DISCOVER)\b/i;
const TRANSFER = /\bTRANSFER\b|\bXFER\b|\bTRNSFR\b|INSTANT PMT (FROM|TO)/i;
const P2P = /\bZELLE\b|\bVENMO\b|\bPAYPAL\b|\bCASH ?APP\b/i;

export function looksLikeCardPayment(description) {
  return CARD_PAYMENT.test(description);
}

export function looksLikeTransfer(description) {
  return TRANSFER.test(description) && !P2P.test(description);
}

// Pairs a payment or transfer with its other side in a different account:
// opposite amounts, no more than 7 days apart. Returns Map(id -> partner id).
export function findPairs(transactions) {
  const byAbs = new Map();
  for (const t of transactions) {
    const k = Math.abs(t.amount);
    if (!byAbs.has(k)) byAbs.set(k, []);
    byAbs.get(k).push(t);
  }
  const pairs = new Map();
  const candidates = transactions
    .filter((t) => t.amount !== 0 && (looksLikeCardPayment(t.description) || looksLikeTransfer(t.description)))
    .sort((a, b) => a.postedDate.localeCompare(b.postedDate));
  for (const c of candidates) {
    if (pairs.has(c.id)) continue;
    let best = null;
    for (const t of byAbs.get(Math.abs(c.amount))) {
      if (t.id === c.id || pairs.has(t.id) || t.accountId === c.accountId || Math.sign(t.amount) === Math.sign(c.amount)) continue;
      const gap = Math.abs(daysBetween(c.postedDate, t.postedDate));
      if (gap > 7) continue;
      if (!best || gap < best.gap) best = { t, gap };
    }
    if (best) {
      pairs.set(c.id, best.t.id);
      pairs.set(best.t.id, c.id);
    }
  }
  return pairs;
}

function coveredByCardAccount(tx, accounts, imports) {
  return accounts.some((a) =>
    a.kind === "card" && a.id !== tx.accountId &&
    imports.some((i) => i.accountId === a.id && i.firstDate && i.lastDate &&
      daysBetween(tx.postedDate, i.firstDate) >= -7 && daysBetween(i.lastDate, tx.postedDate) >= -7));
}

// Returns { kind, text } or null. kinds: "paired", "card-payment", "missing-account", "transfer".
export function hintFor(tx, { pairs, accountsById, accounts, imports }) {
  const partnerId = pairs.get(tx.id);
  const isPayment = looksLikeCardPayment(tx.description);
  if (partnerId) {
    const partner = pairs.partnerTx ? pairs.partnerTx(partnerId) : null;
    const name = partner ? accountsById.get(partner.accountId)?.name : null;
    if (name) return { kind: "paired", text: isPayment ? `Matches a payment on ${name}` : `Matches a transfer in ${name}` };
    return { kind: "paired", text: "Matches a transaction in another account" };
  }
  if (isPayment) {
    const account = accountsById.get(tx.accountId);
    if (tx.amount < 0 && account?.kind !== "card") {
      // A card covering these dates exists but has no matching payment: likely a different card.
      return coveredByCardAccount(tx, accounts, imports)
        ? { kind: "missing-account", text: "No matching payment on your imported cards. Another card may be missing." }
        : { kind: "missing-account", text: "Payment to a card you haven't imported" };
    }
    return { kind: "card-payment", text: "Looks like a card payment" };
  }
  if (looksLikeTransfer(tx.description)) {
    return { kind: "missing-account", text: tx.amount < 0 ? "Transfer to an account you haven't imported" : "Transfer from an account you haven't imported" };
  }
  return null;
}

// Convenience: computes pairs plus a lookup for the partner's account.
export function buildHintContext(store) {
  const transactions = store.list("transactions");
  const pairs = findPairs(transactions);
  const byId = new Map(transactions.map((t) => [t.id, t]));
  pairs.partnerTx = (id) => byId.get(id);
  const accounts = store.list("accounts");
  return { pairs, accounts, accountsById: new Map(accounts.map((a) => [a.id, a])), imports: store.list("imports") };
}
