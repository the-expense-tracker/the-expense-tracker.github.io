// Category helpers: creating categories, the starter suggestions, and counting.

import { makeCategory, ValidationError, CATEGORY_TYPES, monthKeyOf } from "./model.js";

// Shown greyed out on a new grid, each with its own "Add" button. A third entry
// sets how often it comes up (see FREQUENCIES), so the Report averages it right.
export const STARTER_CATEGORIES = [
  ["Mortgage or Rent", "spending"], ["Electricity", "spending"], ["Water", "spending"],
  ["Natural Gas", "spending"], ["Trash", "spending"], ["Pest Control", "spending"], ["Internet", "spending"],
  ["Phone", "spending"], ["Lawn Care", "spending"], ["Cable or Streaming", "spending"],
  ["Groceries", "spending"], ["Eating Out", "spending"], ["Car Payment", "spending"], ["Gas", "spending"],
  ["Car Maintenance", "spending"], ["Car Insurance", "spending"], ["Vehicle Registration", "spending", "yearly"],
  ["Home Maintenance", "spending"], ["Home Improvement", "spending"], ["Household", "spending"], ["Healthcare", "spending"],
  ["Personal Care", "spending"], ["Kids", "spending"], ["Childcare", "spending"], ["Pets", "spending"],
  ["Subscriptions", "spending"], ["Clothing", "spending"], ["Gifts", "spending"],
  ["Tithe", "giving"], ["Extra Generosity", "giving"], ["Travel", "spending"],
  ["Leisure or Entertainment", "spending"], ["Taxes", "spending"], ["Paycheck", "income"],
  ["Retirement", "saving"], ["Card Payments and Transfers", "excluded"],
].map(([name, type, frequency = "regular"]) => ({ name, type, frequency }));

// The order categories appear in everywhere (the grid, Move to, the Report, the
// Excel file): the person's own arrangement, or A to Z. Editing always uses their own.
export const CATEGORY_ORDERS = ["mine", "az"];
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export function categoryOrder(store) {
  return store.getSetting("categoryOrder", "mine") === "az" ? "az" : "mine";
}

export function sortedCategories(store, mode = categoryOrder(store)) {
  const cats = store.list("categories").sort((a, b) => a.order - b.order || byName(a, b));
  return mode === "az" ? cats.sort(byName) : cats;
}

export function nameTaken(store, name, exceptId = null) {
  const n = name.trim().toLowerCase();
  return store.list("categories").some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === n);
}

export async function createCategory(store, { name, type = "spending", frequency = "regular" }) {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!clean) throw new ValidationError("Give the category a name.");
  if (clean.length > 40) throw new ValidationError("Keep category names to 40 characters or fewer.");
  if (!(type in CATEGORY_TYPES)) throw new ValidationError("Choose a type for the category.");
  if (nameTaken(store, clean)) throw new ValidationError(`You already have a category named ${clean}.`);
  const order = Math.max(-1, ...store.list("categories").map((c) => c.order)) + 1;
  const cat = makeCategory({ name: clean, type, frequency, order });
  await store.put("categories", cat);
  return cat;
}

// Set up for everyone on a fresh start, so card payments have somewhere to go from
// day one (sorting them as spending would count purchases twice). Added once; if
// someone deletes it, it stays deleted.
export const DEFAULT_CATEGORIES = [{ name: "Card Payments and Transfers", type: "excluded" }];

export async function addDefaultCategories(store) {
  if (store.getSetting("defaultCategoriesAdded")) return;
  if (store.count("categories") === 0) {
    for (const c of DEFAULT_CATEGORIES) if (!nameTaken(store, c.name)) await createCategory(store, c);
  }
  await store.setSetting("defaultCategoriesAdded", true);
}

export function remainingSuggestions(store) {
  return STARTER_CATEGORIES.filter((s) => !nameTaken(store, s.name));
}

// Number of sorted transaction parts in each category for one year ("all" for every year).
export function categoryCounts(store, year) {
  const counts = new Map();
  for (const t of store.list("transactions")) {
    if (year !== "all" && monthKeyOf(t).slice(0, 4) !== year) continue;
    for (const p of t.parts) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) || 0) + 1);
  }
  return counts;
}
