// The app's single source of truth. All records are held in memory for speed and
// written through to IndexedDB. Memory is only updated after the browser confirms
// a write, so what the screen shows always matches what is saved.
//
// If the browser refuses storage (some privacy settings, some embedded previews),
// the store runs in memory only: everything works, but nothing is kept after the
// page closes. The app tells the user when this happens.

import { openDb, readSnapshot, writeSnapshot, runTx, STORE_NAMES, StorageError } from "./db.js";
import { DATA_VERSION, VALIDATORS } from "./model.js";
import { migrateSnapshot, validateSnapshot, emptySnapshot } from "./migrations.js";

const KEY_FIELD = { vendors: "key", settings: "key" };
const keyOf = (name, rec) => rec[KEY_FIELD[name] || "id"];

export class Store extends EventTarget {
  constructor() {
    super();
    this.db = null;
    this.memoryOnly = false;
    this.openError = null;
    this.data = {};
    for (const name of STORE_NAMES) this.data[name] = new Map();
  }

  async open() {
    let snap;
    try {
      this.db = await openDb();
      snap = await readSnapshot(this.db);
    } catch (err) {
      // Storage is blocked or unreadable: keep working in memory, and leave
      // whatever is saved in the browser untouched.
      this.db = null;
      this.memoryOnly = true;
      this.openError = err;
      snap = emptySnapshot();
      setSettingIn(snap, "dataVersion", DATA_VERSION);
      this.#load(snap);
      return this;
    }
    const versionRec = snap.settings.find((s) => s.key === "dataVersion");
    const isEmpty = STORE_NAMES.every((n) => n === "settings" || snap[n].length === 0);
    const storedVersion = versionRec ? versionRec.value : isEmpty ? DATA_VERSION : 1;

    try {
      if (storedVersion < DATA_VERSION) {
        snap = validateSnapshot(migrateSnapshot(snap, storedVersion));
        setSettingIn(snap, "dataVersion", DATA_VERSION);
        await writeSnapshot(this.db, snap);
      } else if (storedVersion > DATA_VERSION) {
        throw new StorageError("This browser has data from a newer version of the app. Reload the page to get the latest version.");
      } else if (!versionRec) {
        setSettingIn(snap, "dataVersion", DATA_VERSION);
        await this.#write("settings", [{ key: "dataVersion", value: DATA_VERSION }], []);
      }
    } catch (err) {
      // Saved data couldn't be upgraded. It stays exactly as it was; the app runs in memory.
      this.db = null;
      this.memoryOnly = true;
      this.openError = err;
      snap = emptySnapshot();
      setSettingIn(snap, "dataVersion", DATA_VERSION);
    }
    this.#load(snap);
    return this;
  }

  #load(snap) {
    for (const name of STORE_NAMES) {
      this.data[name] = new Map((snap[name] || []).map((rec) => [keyOf(name, rec), rec]));
    }
  }

  list(name) {
    return [...this.data[name].values()];
  }

  get(name, key) {
    return this.data[name].get(key);
  }

  count(name) {
    return this.data[name].size;
  }

  getSetting(key, fallback = null) {
    const rec = this.data.settings.get(key);
    return rec ? rec.value : fallback;
  }

  setSetting(key, value) {
    return this.put("settings", { key, value });
  }

  // Saves one record or many in one all-or-nothing write.
  async put(name, records) {
    const list = Array.isArray(records) ? records : [records];
    for (const rec of list) VALIDATORS[name](rec);
    await this.#write(name, list, []);
  }

  async remove(name, keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    await this.#write(name, [], list);
  }

  // Writes to several stores in one transaction: changes = { storeName: { put: [], remove: [] } }
  async apply(changes) {
    const names = Object.keys(changes);
    for (const name of names) for (const rec of changes[name].put || []) VALIDATORS[name](rec);
    try {
      if (!this.memoryOnly) await runTx(this.db, names, "readwrite", (tx) => {
        for (const name of names) {
          const store = tx.objectStore(name);
          for (const rec of changes[name].put || []) store.put(rec);
          for (const key of changes[name].remove || []) store.delete(key);
        }
      });
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
    const keys = {};
    for (const name of names) {
      keys[name] = { put: [], remove: [...(changes[name].remove || [])] };
      for (const rec of changes[name].put || []) {
        this.data[name].set(keyOf(name, rec), rec);
        keys[name].put.push(keyOf(name, rec));
      }
      for (const key of changes[name].remove || []) this.data[name].delete(key);
    }
    this.#changed(names, keys);
  }

  async #write(name, puts, removes) {
    try {
      if (!this.memoryOnly) await runTx(this.db, [name], "readwrite", (tx) => {
        const store = tx.objectStore(name);
        for (const rec of puts) store.put(rec);
        for (const key of removes) store.delete(key);
      });
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
    for (const rec of puts) this.data[name].set(keyOf(name, rec), rec);
    for (const key of removes) this.data[name].delete(key);
    this.#changed([name], { [name]: { put: puts.map((r) => keyOf(name, r)), remove: [...removes] } });
  }

  snapshot() {
    const snap = {};
    for (const name of STORE_NAMES) snap[name] = structuredClone(this.list(name));
    return snap;
  }

  // Replaces everything with an already-validated snapshot (used by restore).
  async replaceAll(snapshot) {
    const snap = validateSnapshot(structuredClone(snapshot));
    setSettingIn(snap, "dataVersion", DATA_VERSION);
    try {
      if (!this.memoryOnly) await writeSnapshot(this.db, snap);
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
    this.#load(snap);
    this.#changed(STORE_NAMES);
  }

  async eraseAll() {
    const snap = emptySnapshot();
    snap.settings.push({ key: "dataVersion", value: DATA_VERSION });
    try {
      if (!this.memoryOnly) await writeSnapshot(this.db, snap);
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
    this.#load(snap);
    this.#changed(STORE_NAMES);
  }

  // keys (when known) lists exactly which records were saved or removed, so screens
  // can redraw only what changed. Without keys, treat everything as changed.
  #changed(names, keys = null) {
    this.dispatchEvent(new CustomEvent("change", { detail: { stores: names, keys } }));
  }

  #reportError(err) {
    const message = err instanceof StorageError ? err.message : "Something went wrong saving your change, so it wasn't saved.";
    this.dispatchEvent(new CustomEvent("storage-error", { detail: { message, error: err } }));
  }
}

function setSettingIn(snap, key, value) {
  const existing = snap.settings.find((s) => s.key === key);
  if (existing) existing.value = value;
  else snap.settings.push({ key, value });
}
