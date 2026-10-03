// IndexedDB access. Everything here stays inside this browser.
//
// Two kinds of versions exist:
//  - SCHEMA steps (below) create object stores and indexes. They run once per
//    browser when the app is first opened after an update that adds a step.
//  - DATA_VERSION (model.js) describes the shape of the records themselves.
//    Record upgrades live in migrations.js and are shared with backup restore.

// The preview build (for trying the app inside Claude) keeps its own separate
// database, so it can never touch real data saved by the app.
export const DB_NAME = globalThis.__ET_PREVIEW__ ? "the-expense-tracker-preview" : "the-expense-tracker";

export const STORE_NAMES = ["accounts", "imports", "transactions", "vendors", "categories", "settings"];

const SCHEMA_STEPS = [
  // Step 1: initial stores.
  (db) => {
    db.createObjectStore("accounts", { keyPath: "id" });
    const imports = db.createObjectStore("imports", { keyPath: "id" });
    imports.createIndex("accountId", "accountId");
    const tx = db.createObjectStore("transactions", { keyPath: "id" });
    tx.createIndex("accountId", "accountId");
    tx.createIndex("importId", "importId");
    tx.createIndex("postedDate", "postedDate");
    db.createObjectStore("vendors", { keyPath: "key" });
    db.createObjectStore("categories", { keyPath: "id" });
    db.createObjectStore("settings", { keyPath: "key" });
  },
  // Future steps are appended here. Never edit or reorder an existing step.
];

export const DB_VERSION = SCHEMA_STEPS.length;

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StorageError";
    this.cause = cause;
  }
}

function describe(err) {
  const name = err?.name || "";
  if (name === "QuotaExceededError") return "This browser is out of storage space for the app, so the last change wasn't saved.";
  if (name === "InvalidStateError" || name === "SecurityError") return "This browser isn't allowing the app to save data. Private windows and some privacy settings block storage.";
  if (name === "VersionError") return "This browser has data from a newer version of the app. Reload the page to get the latest version.";
  return "The app couldn't save to this browser's storage.";
}

export function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new StorageError(describe(err), err));
      return;
    }
    req.onupgradeneeded = (event) => {
      const db = req.result;
      for (let v = event.oldVersion; v < DB_VERSION; v++) SCHEMA_STEPS[v](db, req.transaction);
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab opens a newer version, close so it can upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new StorageError(describe(req.error), req.error));
    req.onblocked = () => reject(new StorageError("The app is open in another tab with an older version. Close the other tab and reload.", null));
  });
}

// Runs fn(tx) in one transaction; resolves when the browser confirms it's written.
export function runTx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(new StorageError(describe(err), err));
      return;
    }
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(new StorageError(describe(tx.error), tx.error));
    tx.onerror = (e) => e.preventDefault(); // handled by onabort
    try {
      result = fn(tx);
    } catch (err) {
      try { tx.abort(); } catch { /* already finished */ }
      reject(err);
    }
  });
}

export function getAll(db, storeName) {
  return runTx(db, [storeName], "readonly", (tx) => {
    const out = { records: [] };
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => { out.records = req.result; };
    return out;
  }).then((out) => out.records);
}

export async function readSnapshot(db) {
  const snapshot = {};
  await runTx(db, STORE_NAMES, "readonly", (tx) => {
    for (const name of STORE_NAMES) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { snapshot[name] = req.result; };
    }
  });
  return snapshot;
}

// Replaces every store's contents in a single all-or-nothing transaction.
export function writeSnapshot(db, snapshot) {
  return runTx(db, STORE_NAMES, "readwrite", (tx) => {
    for (const name of STORE_NAMES) {
      const store = tx.objectStore(name);
      store.clear();
      for (const rec of snapshot[name] || []) store.put(rec);
    }
  });
}
