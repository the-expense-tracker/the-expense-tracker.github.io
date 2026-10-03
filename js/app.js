// App start-up and the stage 1 page shell.

import { Store } from "./store.js";
import { downloadBackup, readBackupFile } from "./backup.js";
import { checkNetworkLock, requestPersistence, looksLikePrivateWindow } from "./protection.js";
import { createImportUI } from "./import-ui.js";
import { createAccountsUI } from "./accounts-ui.js";
import { loadCities } from "./locations.js";
import { cleanDescription } from "./vendors.js";
import { createSortingUI } from "./sorting-ui.js";
import { createReportUI } from "./report-ui.js";
import { ValidationError } from "./model.js";
import { addDefaultCategories } from "./categories.js";

const $ = (id) => document.getElementById(id);
const BACKUP_NUDGE_DAYS = 14;

const store = new Store();
let pendingRestore = null;
let toastTimer = null;
let reportUI = null;

// Exposed for automated tests and for checking data from the browser console.
// For automated tests on this computer and for the preview build only.
if (["localhost", "127.0.0.1"].includes(location.hostname) || window.__ET_PREVIEW__) window.ExpenseTracker = { store };

// Defense in depth: the app never uses direct peer-to-peer connections, so they're
// switched off. (The page's security policy already blocks every other kind.)
for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch { /* not present */ }
}

function setStatus(dotId, textId, level, text, detail = "") {
  const dot = $(dotId);
  dot.className = `dot ${level}`;
  $(textId).textContent = text;
  $(textId).parentElement.title = detail;
}

// A short message at the bottom of the screen. With an action (like Undo) it
// stays longer, and pausing on it with the mouse or keyboard keeps it open.
function showToast(text, { action, onAction } = {}) {
  const el = $("toast");
  el.replaceChildren();
  const msg = document.createElement("span");
  msg.textContent = text;
  el.append(msg);
  const hide = () => { el.hidden = true; el.replaceChildren(); };
  const arm = (ms) => { clearTimeout(toastTimer); toastTimer = setTimeout(hide, ms); };
  if (action && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      clearTimeout(toastTimer);
      hide();
      try { await onAction(); } catch (err) { showToast(err instanceof ValidationError ? err.message : "That couldn't be undone."); }
    }, { once: true });
    el.append(btn);
  }
  el.hidden = false;
  const ms = action ? 8000 : 3500;
  arm(ms);
  el.onpointerenter = el.onfocusin = () => clearTimeout(toastTimer);
  el.onpointerleave = el.onfocusout = () => arm(ms / 2);
}

// Banners are keyed so the same problem never stacks up twice.
function showBanner(key, level, text, { dismissible = true, actions = [] } = {}) {
  const box = $("banners");
  let el = box.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!el) {
    el = document.createElement("div");
    el.dataset.key = key;
    box.append(el);
  }
  el.className = `banner ${level}`;
  el.replaceChildren();
  const p = document.createElement("p");
  p.textContent = text;
  el.append(p);
  for (const { label, onClick, primary } of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = primary ? "btn btn-primary" : "btn";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    el.append(btn);
  }
  if (dismissible) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Dismiss";
    btn.addEventListener("click", () => el.remove());
    el.append(btn);
  }
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function renderBackupStatus() {
  const last = store.getSetting("lastBackupAt");
  const hasData = store.count("transactions") > 0;
  if (!last) {
    setStatus("backup-dot", "backup-text", hasData ? "warn" : "", "Last backup: never");
    return;
  }
  const days = daysSince(last);
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  setStatus("backup-dot", "backup-text", hasData && days >= BACKUP_NUDGE_DAYS ? "warn" : "good", `Last backup: ${when}`);
}

function renderCounts() {
  const txs = store.list("transactions");
  $("count-accounts").textContent = store.count("accounts");
  $("count-transactions").textContent = txs.length.toLocaleString("en-US");
  $("count-categories").textContent = store.count("categories");
  let parts = 0;
  let sorted = 0;
  for (const t of txs) for (const p of t.parts) { parts++; if (p.categoryId) sorted++; }
  $("count-sorted").textContent = parts ? `${Math.round((sorted / parts) * 100)}%` : "0%";
}

// A gentle nudge to save a backup: once there's real sorting work to lose and no
// backup yet, or when the last one is a couple of weeks old. "Not now" waits a week.
const NUDGE_MIN_SORTED = 100;
function renderBackupNudge() {
  const existing = $("banners").querySelector('[data-key="backup-nudge"]');
  let sorted = 0;
  for (const t of store.list("transactions")) for (const p of t.parts) if (p.categoryId) sorted++;
  const last = store.getSetting("lastBackupAt");
  const snoozed = Date.now() < Date.parse(store.getSetting("backupNudgeSnoozedUntil") || 0);
  const days = last ? daysSince(last) : null;
  const due = !store.memoryOnly && !snoozed && sorted > 0 && (last ? days >= BACKUP_NUDGE_DAYS : sorted >= NUDGE_MIN_SORTED);
  if (!due) { existing?.remove(); return; }
  const text = last
    ? `Your last backup was ${days} days ago. Save a fresh one to keep your recent sorting safe.`
    : `You've sorted ${sorted.toLocaleString("en-US")} transactions. Save a backup so clearing your browser can't erase your work.`;
  if (existing?.querySelector("p")?.textContent === text) return;
  showBanner("backup-nudge", "warn", text, {
    dismissible: false,
    actions: [
      { label: "Save backup", primary: true, onClick: () => onBackup() },
      { label: "Not now", onClick: () => store.setSetting("backupNudgeSnoozedUntil", new Date(Date.now() + 7 * 86_400_000).toISOString()) },
    ],
  });
}

function render() {
  renderCounts();
  renderBackupStatus();
  renderBackupNudge();
  $("restore-hint").hidden = store.count("transactions") > 0 || store.count("accounts") > 0;
}

let savingBackup = false;
async function onBackup() {
  if (savingBackup) return;
  savingBackup = true;
  showToast("Saving your backup…");
  try {
    const name = await downloadBackup(store);
    showToast(`Saved ${name}. It opens in Excel and restores everything.`);
  } catch (err) {
    if (err?.code === "declined") showToast("Backup not saved");
    else showToast("The backup couldn't be created. Try again.");
  } finally {
    savingBackup = false;
  }
}

async function onRestoreFile(file) {
  pendingRestore = null;
  $("restore-confirm").hidden = true;
  try {
    const backup = await readBackupFile(file);
    pendingRestore = backup;
    const c = backup.counts;
    const when = backup.exportedAt ? new Date(backup.exportedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "an unknown date";
    $("data-panel").open = true;
    $("restore-summary").textContent = `This backup from ${when} has ${c.accounts} accounts, ${c.transactions.toLocaleString("en-US")} transactions, and ${c.categories} categories.`;
    $("banners").querySelector('[data-key="restore"]')?.remove();
    $("restore-confirm").hidden = false;
    $("restore-yes").focus();
  } catch (err) {
    const msg = err instanceof ValidationError ? err.message : "That file couldn't be read.";
    showBanner("restore", "alert", msg);
  }
}

async function confirmRestore() {
  if (!pendingRestore) return;
  const backup = pendingRestore;
  pendingRestore = null;
  $("restore-confirm").hidden = true;
  try {
    await store.replaceAll(backup.data);
    if (backup.exportedAt) await store.setSetting("lastBackupAt", backup.exportedAt);
    await fillMissingVendorNames();
    showToast("Backup restored");
  } catch {
    // The storage-error banner explains what happened.
  }
}

async function loadDemo() {
  if (store.list("accounts").some((a) => a.name.startsWith("Demo "))) {
    showToast("Demo data is already loaded");
    return;
  }
  await loadCities();
  // Demo data exists only in the preview build; the published app doesn't include it.
  const { buildDemoData } = await import("./demo.js");
  const demo = buildDemoData();
  // A demo category whose name is already taken (like the ready-made Card Payments
  // and Transfers) uses the existing one instead of making a duplicate.
  const existing = new Map(store.list("categories").map((c) => [c.name.toLowerCase(), c.id]));
  const swap = new Map();
  let nextOrder = Math.max(-1, ...store.list("categories").map((c) => c.order)) + 1;
  const newCats = [];
  for (const c of demo.categories) {
    const id = existing.get(c.name.toLowerCase());
    if (id) swap.set(c.id, id); else newCats.push({ ...c, order: nextOrder++ });
  }
  const txs = demo.transactions.map((t) => ({ ...t, parts: t.parts.map((p) => (swap.has(p.categoryId) ? { ...p, categoryId: swap.get(p.categoryId) } : p)) }));
  try {
    await store.apply({
      accounts: { put: demo.accounts },
      imports: { put: demo.imports },
      categories: { put: newCats },
      transactions: { put: txs },
      vendors: { put: demo.vendors.filter((v) => !store.get("vendors", v.key)) },
    });
    showToast(`Added ${demo.transactions.length} demo transactions`);
  } catch {
    // Banner already shown.
  }
}

async function eraseAll() {
  $("erase-confirm").hidden = true;
  try {
    await store.eraseAll();
    await addDefaultCategories(store);
    showToast("All data erased");
  } catch {
    // Banner already shown.
  }
}

// ---------- Pages ----------

function showPage(name) {
  const page = name === "report" ? "report" : "transactions";
  $("page-transactions").hidden = page !== "transactions";
  $("page-report").hidden = page !== "report";
  for (const b of document.querySelectorAll(".seg-btn[data-page]")) {
    if (b.dataset.page === page) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (page === "report") reportUI?.show(); else reportUI?.hide();
  try {
    if ((location.hash.slice(1) || "transactions") !== page) history.replaceState(null, "", page === "report" ? "#report" : location.pathname + location.search);
  } catch { /* some embedded previews don't allow changing the address */ }
}

// ---------- Backup menu ----------

function setMenu(open) {
  $("backup-menu").hidden = !open;
  $("backup-menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) $("backup-btn").focus();
}

function wireEvents() {
  for (const b of document.querySelectorAll(".seg-btn[data-page]")) b.addEventListener("click", () => showPage(b.dataset.page));
  window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
  showPage(location.hash.slice(1));

  $("backup-menu-btn").addEventListener("click", () => setMenu($("backup-menu").hidden));
  document.addEventListener("click", (e) => { if (!e.target.closest?.(".menu-wrap")) setMenu(false); });
  $("backup-menu").addEventListener("keydown", (e) => {
    const items = [...$("backup-menu").querySelectorAll(".menu-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { setMenu(false); $("backup-menu-btn").focus(); }
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  $("backup-btn").addEventListener("click", () => { setMenu(false); onBackup(); });
  $("restore-btn").addEventListener("click", () => { setMenu(false); $("restore-input").click(); });
  $("restore-hint-btn").addEventListener("click", () => $("restore-input").click());
  $("restore-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) onRestoreFile(file);
  });
  $("restore-yes").addEventListener("click", confirmRestore);
  $("restore-no").addEventListener("click", () => { pendingRestore = null; $("restore-confirm").hidden = true; });
  $("demo-btn").addEventListener("click", loadDemo);
  $("erase-btn").addEventListener("click", () => { $("erase-confirm").hidden = false; $("erase-no").focus(); });
  $("restore-btn").addEventListener("click", () => { $("restore-confirm").hidden = true; });
  $("erase-no").addEventListener("click", () => { $("erase-confirm").hidden = true; });
  $("erase-yes").addEventListener("click", eraseAll);
  store.addEventListener("change", render);
  store.addEventListener("storage-error", (e) => {
    showBanner("storage", "alert", e.detail.message);
    setStatus("persist-dot", "persist-text", "alert", "Last change not saved", e.detail.message);
    $("persist-item").hidden = false;
  });
}

async function runProtectionChecks() {
  checkNetworkLock().then((locked) => {
    if (locked) setStatus("net-dot", "net-text", "good", "Network locked", "The browser is blocking this page from connecting to any server.");
    else setStatus("net-dot", "net-text", "alert", "Network lock not confirmed");
  });

  if (store.memoryOnly) return;
  const persist = await requestPersistence();
  // Saving is automatic, so there's no status for it unless something is wrong.
  void persist;

  if (await looksLikePrivateWindow()) {
    showBanner("private", "warn", "This may be a private window. Private windows erase everything when they close, so open the app in a regular window to keep your work.");
  }
}

async function start() {
  // Another website could show this app inside a frame and trick clicks. The app
  // only works when opened directly (the preview build runs inside Claude on purpose).
  if (window.top !== window.self && !window.__ET_PREVIEW__) {
    showBanner("framed", "alert", "For your privacy, The Expense Tracker only works when you open it directly. Type its address into your browser or use your bookmark.", { dismissible: false });
    for (const el of document.querySelectorAll("main, .toolbar, .data-panel, .accounts-bar")) el.hidden = true;
    return;
  }
  wireEvents();
  await store.open();
  await addDefaultCategories(store).catch(() => {});
  if (store.memoryOnly) {
    const err = store.openError;
    const blocked = !err || err.name === "StorageError" && /isn't allowing|couldn't save/.test(err.message) || /Security|InvalidState/.test(err?.cause?.name || "");
    setStatus("persist-dot", "persist-text", "alert", "Not saving", "This window blocks storage, so work disappears when the page closes.");
    $("persist-item").hidden = false;
    showBanner("storage", "alert", blocked
      ? "This window isn't letting the app save anything. You can try everything, but your work disappears when the page closes. Open the app in a regular Chrome, Edge, or Firefox window to keep your work."
      : `${err.message} Nothing you saved before was changed. Until this is fixed, new work won't be kept.`, { dismissible: false });
  }
  const ui = { store, root: document, toast: showToast, banner: (key, level, text) => showBanner(key, level, text), restoreFile: (file) => onRestoreFile(file) };
  createImportUI(ui);
  createAccountsUI(ui);
  const goTo = (page) => { showPage(page); window.scrollTo({ top: 0 }); };
  createSortingUI({ ...ui, goTo });
  reportUI = createReportUI({ ...ui, goTo });
  if (!$("page-report").hidden) reportUI.show();
  render();
  runProtectionChecks();
  await fillMissingVendorNames();
  if (window.__ET_PREVIEW__) startPreviewMode();
}

// Transactions saved by an older version (or restored from an older backup) may
// lack cleaned vendor names. Fill them in so the inbox never shows raw bank text.
async function fillMissingVendorNames() {
  const missing = store.list("transactions").filter((t) => !t.vendorKey);
  if (!missing.length) return;
  await loadCities();
  const vendors = new Map();
  const txs = missing.map((t) => {
    const c = cleanDescription(t.description, t);
    if (!store.get("vendors", c.vendorKey) && !vendors.has(c.vendorKey)) {
      vendors.set(c.vendorKey, { key: c.vendorKey, cleanName: c.cleanName, customName: null });
    }
    return { ...t, vendorKey: c.vendorKey, location: t.location || c.location, memo: t.memo || c.memo };
  });
  await store.apply({ transactions: { put: txs }, vendors: { put: [...vendors.values()] } });
}

// Any unexpected error shows on screen instead of failing silently.
function reportCrash(message) {
  showBanner("crash", "alert", `Something went wrong: ${message}. Reloading the page usually fixes it. Nothing you saved was changed.`);
}
window.addEventListener("error", (e) => { if (e.message) reportCrash(e.message); });
window.addEventListener("unhandledrejection", (e) => reportCrash(e.reason?.message || String(e.reason)));

// Preview builds run inside Claude's preview window, which blocks file downloads.
// Each new preview version starts over with fresh demo data (about 40% left unsorted),
// so the sorting can be tried again from the beginning.
const PREVIEW_DEMO_VERSION = "2026-10-03g";
async function startPreviewMode() {
  $("demo-btn").hidden = false;
  showBanner("preview", "warn", "Preview with invented demo data. Each new preview version starts over with fresh demo data, so feel free to sort, edit, and erase.");
  if (store.getSetting("previewDemo") !== PREVIEW_DEMO_VERSION) {
    if (store.count("transactions") || store.count("categories")) await store.eraseAll();
    await loadDemo();
    await store.setSetting("previewDemo", PREVIEW_DEMO_VERSION);
  }
}

start().catch((err) => reportCrash(err?.message || String(err)));
