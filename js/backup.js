// Backup files: an Excel workbook the user keeps (older backups were .json files,
// which still restore). Restoring replaces everything
// in this browser, after the file has been fully checked.

import { DATA_VERSION, ValidationError } from "./model.js";
import { migrateSnapshot, validateSnapshot } from "./migrations.js";
import { buildBackupWorkbook, readBackupFromWorkbook } from "./excel.js";

export const BACKUP_APP_ID = "the-expense-tracker";
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export function buildBackup(store) {
  const data = store.snapshot();
  data.settings = data.settings.filter((s) => s.key !== "lastBackupAt");
  return {
    app: BACKUP_APP_ID,
    dataVersion: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    counts: summarize(data),
    data,
  };
}

export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `expense-tracker-backup-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.xlsx`;
}

// Hands a file to the person. The real app uses an ordinary browser download; the
// preview build runs inside Claude's viewer, which asks the person first.
export async function saveFile(name, blob) {
  if (window.__ET_PREVIEW__ && window.claude?.use) {
    const downloads = await window.claude.use("downloads");
    if (downloads) {
      await downloads.save({ filename: name, data: blob });
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Saves the backup (an Excel file that can also be restored). Returns the file name.
export async function downloadBackup(store) {
  const backup = buildBackup(store);
  const blob = await buildBackupWorkbook(store, backup);
  const name = backupFileName();
  await saveFile(name, blob);
  await store.setSetting("lastBackupAt", backup.exportedAt);
  return name;
}

export function summarize(data) {
  return {
    accounts: data.accounts.length,
    transactions: data.transactions.length,
    categories: data.categories.length,
  };
}

// Reads and fully checks a backup file. Returns { exportedAt, counts, data } or
// throws ValidationError with a message written for the user.
export async function readBackupFile(file) {
  if (file.size > MAX_BACKUP_BYTES) throw new ValidationError("That file is too large to be a backup from this app.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Excel files are zip archives, which start with "PK".
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parseBackupText(await readBackupFromWorkbook(bytes.buffer));
  return parseBackupText(new TextDecoder().decode(bytes));
}

export function parseBackupText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("That file isn't a backup from this app. Backups are files named \"expense-tracker-backup\" that this app saved.");
  }
  if (!parsed || parsed.app !== BACKUP_APP_ID || typeof parsed.data !== "object" || parsed.data === null) {
    throw new ValidationError("That file isn't a backup from this app. Backups are files named \"expense-tracker-backup\" that this app saved.");
  }
  let data;
  try {
    data = validateSnapshot(migrateSnapshot(parsed.data, parsed.dataVersion));
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(`This backup can't be restored: ${lowerFirst(err.message)}`);
    throw err;
  }
  const exportedAt = typeof parsed.exportedAt === "string" && !Number.isNaN(Date.parse(parsed.exportedAt)) ? parsed.exportedAt : null;
  return { exportedAt, counts: summarize(data), data };
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
