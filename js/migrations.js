// Record upgrades between data versions.
//
// MIGRATIONS[n] upgrades a snapshot from data version n to n + 1. A snapshot is
// a plain object with one array per store: { accounts, imports, transactions,
// vendors, categories, settings }. The same chain upgrades the data saved in
// this browser and any older backup file being restored, so an update never
// strands existing work.
//
// Rules: never edit or remove a migration once released; only append.

import { DATA_VERSION, VALIDATORS, ValidationError, checkReferences, pickFields } from "./model.js";
import { STORE_NAMES } from "./db.js";

export const MIGRATIONS = {
  // 1 -> 2 (stage 2, importing): duplicate review marker, richer import history,
  // and a cleaned name on every vendor record.
  1: (snap) => {
    for (const t of snap.transactions) t.dupOf ??= null;
    for (const i of snap.imports) {
      i.pending ??= 0;
      i.unreadable ??= 0;
      i.formatKey ??= "";
      i.fileStem ??= "";
    }
    for (const v of snap.vendors) v.cleanName ??= v.key;
    return snap;
  },
};

export function emptySnapshot() {
  const snap = {};
  for (const name of STORE_NAMES) snap[name] = [];
  return snap;
}

export function migrateSnapshot(snapshot, fromVersion) {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new ValidationError("This data doesn't say which version of the app made it.");
  }
  if (fromVersion > DATA_VERSION) {
    throw new ValidationError("This data was made by a newer version of the app. Reload the page to get the latest version, then try again.");
  }
  let snap = structuredClone(snapshot);
  for (const name of STORE_NAMES) snap[name] ??= [];
  for (let v = fromVersion; v < DATA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new ValidationError(`The app is missing the upgrade from data version ${v}.`);
    snap = step(snap);
  }
  return snap;
}

// Validates every record and the links between them. Throws ValidationError.
export function validateSnapshot(snapshot) {
  for (const name of STORE_NAMES) {
    if (!Array.isArray(snapshot[name])) throw new ValidationError(`The data is missing its ${name} list.`);
    if (snapshot[name].length > 500000) throw new ValidationError(`The ${name} list is too large.`);
    // Keep only the fields each record really has, so nothing unexpected is stored.
    snapshot[name] = snapshot[name].map((rec) => (rec && typeof rec === "object" && !Array.isArray(rec) ? pickFields(name, rec) : rec));
    const seen = new Set();
    const keyField = name === "vendors" || name === "settings" ? "key" : "id";
    for (const rec of snapshot[name]) {
      if (!rec || typeof rec !== "object") throw new ValidationError(`The ${name} list contains an invalid entry.`);
      VALIDATORS[name](rec);
      if (seen.has(rec[keyField])) throw new ValidationError(`The ${name} list contains a duplicate entry.`);
      seen.add(rec[keyField]);
    }
  }
  checkReferences(snapshot);
  return snapshot;
}
