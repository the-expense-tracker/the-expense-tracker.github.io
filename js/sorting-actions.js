// Everything that changes how transactions are sorted: moving them into or out of
// categories (with undo), splitting, changing the month a transaction counts
// toward, and editing, reordering, or deleting categories. Nothing here ever
// sorts on its own; every change starts with something the user did.

import { ValidationError, newId, isMonthKey, CATEGORY_TYPES, FREQUENCIES } from "./model.js";
import { nameTaken } from "./categories.js";

// Inbox and panel items are identified as "<transaction id>:<part id>".
export function parseItemId(id) {
  const i = id.lastIndexOf(":");
  return { txId: id.slice(0, i), partId: id.slice(i + 1) };
}

// Puts the given items into a category (or back to To Sort with null).
// Returns { moved, undo } where undo() restores exactly what was there before.
export async function assignItems(store, itemIds, categoryId) {
  if (categoryId && !store.get("categories", categoryId)) throw new ValidationError("That category no longer exists.");
  const byTx = new Map();
  for (const id of itemIds) {
    const { txId, partId } = parseItemId(id);
    if (!byTx.has(txId)) byTx.set(txId, new Set());
    byTx.get(txId).add(partId);
  }
  const previous = []; // [txId, partId, oldCategoryId]
  const updated = [];
  for (const [txId, partIds] of byTx) {
    const tx = store.get("transactions", txId);
    if (!tx) continue;
    let changed = false;
    const parts = tx.parts.map((p) => {
      if (!partIds.has(p.id) || p.categoryId === categoryId) return p;
      previous.push([txId, p.id, p.categoryId]);
      changed = true;
      return { ...p, categoryId };
    });
    if (changed) updated.push({ ...tx, parts });
  }
  if (updated.length) await store.put("transactions", updated);
  return {
    moved: previous.length,
    undo: async () => {
      const restore = new Map();
      for (const [txId, partId, old] of previous) {
        const tx = restore.get(txId) || store.get("transactions", txId);
        if (!tx) continue;
        restore.set(txId, { ...tx, parts: tx.parts.map((p) => (p.id === partId ? { ...p, categoryId: old } : p)) });
      }
      const valid = [...restore.values()].filter((t) => t.parts.every((p) => !p.categoryId || store.get("categories", p.categoryId)));
      if (valid.length) await store.put("transactions", valid);
    },
  };
}

// ---------- Splits ----------

// amounts: whole cents, all with the same sign as the transaction, summing to it.
export async function splitTransaction(store, txId, amounts) {
  const tx = store.get("transactions", txId);
  if (!tx) throw new ValidationError("That transaction no longer exists.");
  if (amounts.length < 2) throw new ValidationError("A split needs at least two parts.");
  if (amounts.some((a) => !Number.isInteger(a) || a === 0)) throw new ValidationError("Every part needs an amount.");
  if (amounts.some((a) => Math.sign(a) !== Math.sign(tx.amount))) throw new ValidationError("Parts can't be bigger than the whole transaction.");
  const sum = amounts.reduce((n, a) => n + a, 0);
  if (sum !== tx.amount) throw new ValidationError("The parts have to add up to the full amount.");
  const parts = amounts.map((amount, i) => ({ id: i === 0 ? tx.parts[0].id : newId(), amount, categoryId: null }));
  await store.put("transactions", { ...tx, parts });
}

export async function undoSplit(store, txId) {
  const tx = store.get("transactions", txId);
  if (!tx || tx.parts.length < 2) return;
  await store.put("transactions", { ...tx, parts: [{ id: tx.parts[0].id, amount: tx.amount, categoryId: null }] });
}

// ---------- Counts toward ----------

export async function setCountsToward(store, txId, monthKey) {
  const tx = store.get("transactions", txId);
  if (!tx) return;
  const posted = tx.postedDate.slice(0, 7);
  const value = !monthKey || monthKey === posted ? null : monthKey;
  if (value !== null && !isMonthKey(value)) throw new ValidationError("That isn't a month this app recognizes.");
  if (value === tx.countsToward) return;
  await store.put("transactions", { ...tx, countsToward: value });
}

// Months offered for "Counts toward": three before the posted month to two after.
export function countsTowardOptions(postedDate) {
  const [y, m] = postedDate.split("-").map(Number);
  const out = [];
  for (let d = -3; d <= 2; d++) {
    const total = y * 12 + (m - 1) + d;
    out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

// ---------- Categories ----------

export async function updateCategory(store, id, changes) {
  const cat = store.get("categories", id);
  if (!cat) return;
  const next = { ...cat };
  if ("name" in changes) {
    const name = String(changes.name).replace(/\s+/g, " ").trim();
    if (!name) throw new ValidationError("A category needs a name.");
    if (name.length > 40) throw new ValidationError("Keep category names to 40 characters or fewer.");
    if (nameTaken(store, name, id)) throw new ValidationError(`You already have a category named ${name}.`);
    next.name = name;
  }
  if ("type" in changes) {
    if (!(changes.type in CATEGORY_TYPES)) throw new ValidationError("Choose a type for the category.");
    next.type = changes.type;
  }
  if ("frequency" in changes) {
    if (!(changes.frequency in FREQUENCIES)) throw new ValidationError("Choose how often this is paid.");
    next.frequency = changes.frequency;
  }
  await store.put("categories", next);
}

export async function reorderCategories(store, orderedIds) {
  const cats = orderedIds.map((id, i) => ({ ...store.get("categories", id), order: i })).filter((c) => c.id);
  await store.put("categories", cats);
}

// Deletes a category. Its transactions, in every year, go back to To Sort.
export async function deleteCategory(store, id) {
  const touched = [];
  let parts = 0;
  for (const tx of store.list("transactions")) {
    if (!tx.parts.some((p) => p.categoryId === id)) continue;
    touched.push({ ...tx, parts: tx.parts.map((p) => (p.categoryId === id ? (parts++, { ...p, categoryId: null }) : p)) });
  }
  await store.apply({ transactions: { put: touched }, categories: { remove: [id] } });
  return parts;
}

export function countInCategoryAllYears(store, id) {
  let n = 0;
  for (const tx of store.list("transactions")) for (const p of tx.parts) if (p.categoryId === id) n++;
  return n;
}
