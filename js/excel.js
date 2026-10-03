// The backup file is an Excel workbook people can actually read: a Report sheet
// for each year (laid out like the Report page), a sheet of every transaction,
// and a short note about the file. A hidden sheet carries the complete backup,
// checksummed, which is what "Restore from backup" reads. Edits made in Excel are
// never restored, so a typo in a cell can't corrupt anyone's data.
//
// ExcelJS is a local copy in vendor/ (no outside connections), loaded only when
// a backup is saved or restored.

import { ValidationError, MONTHS, FREQUENCIES, CATEGORY_TYPES, formatCents, vendorDisplayName } from "./model.js";
import { buildReport, reportYears, monthLabel, dollars, COUNTED_TYPES, NET_LABEL, NET_HELP } from "./report-data.js";
import { canReadXlsx, readSheetColumnA } from "./xlsx-read.js";

export const DATA_SHEET = "Backup Data";
const DATA_MARK = "the-expense-tracker-backup";
const DATA_FORMAT = 1;
const CHUNK = 30000; // Excel cells hold up to 32,767 characters

const COLOR = {
  olive: "FF4A4D37", oliveDeep: "FF2E3023", ochre: "FFB88435", rust: "FF9E5424", sand: "FFCFAD78",
  snapshot: "FFF3EAD6", snapshotAvg: "FFEADDBF", paper: "FFF6F2E8", avg: "FFFAF6EC", card: "FFFFFDF7",
  ink: "FF262819", muted: "FF75765E", line: "FFE0D9C5",
};
const MONEY = '"$"#,##0;-"$"#,##0';
const MONEY_CENTS = '"$"#,##0.00;-"$"#,##0.00';

let loading = null;
let scriptPolicy;
export function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // The page only allows scripts that pass through a named "policy" (Trusted
    // Types); this one accepts exactly one address: the local copy of ExcelJS.
    const url = "vendor/exceljs.min.js";
    scriptPolicy ??= window.trustedTypes?.createPolicy("exceljs", { createScriptURL: (u) => { if (u !== url) throw new Error("blocked"); return u; } }) ?? null;
    const policy = scriptPolicy;
    s.src = policy ? policy.createScriptURL(url) : url;
    s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("The spreadsheet tool didn't load.")));
    s.onerror = () => { loading = null; reject(new Error("The spreadsheet tool couldn't be loaded.")); };
    document.head.append(s);
  });
  return loading;
}

// A small checksum, so a damaged or hand-edited backup is refused instead of half-restored.
export function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const colName = (n) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const toDollars = (cents) => Math.round(cents) / 100;
const utcDate = (iso) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));

// ---------- Report sheet ----------

function addReportSheet(wb, store, year, savedOn) {
  const r = buildReport(store, year);
  const months = r.months;
  const L = colName;
  const has = (type) => r.sections.some((x) => x.type === type);

  // Columns: Month | Snapshot (Income, Giving, Savings, Spending, Net) | each category.
  const snap = [{ key: "income", label: "Income" }];
  if (has("giving")) snap.push({ key: "giving", label: "Giving" });
  if (has("saving")) snap.push({ key: "saving", label: "Savings" });
  snap.push({ key: "spending", label: "Spending" }, { key: "net", label: NET_LABEL, net: true });
  const details = r.sections.flatMap((section) => section.rows.map((row, i) => ({ row, section, first: i === 0 })));
  const firstSnap = 2;
  const firstDet = firstSnap + snap.length;
  const lastCol = Math.max(firstDet + details.length - 1, firstDet - 1);
  snap.forEach((c, i) => { c.col = firstSnap + i; });
  details.forEach((d, i) => { d.col = firstDet + i; });
  const groupCols = new Map(); // type → [first, last] column numbers
  for (const d of details) {
    const g = groupCols.get(d.section.type);
    groupCols.set(d.section.type, g ? [g[0], d.col] : [d.col, d.col]);
  }

  const headTop = 4;
  const nameRow = headTop + 1;
  const firstMonthRow = nameRow + 1;
  const lastMonthRow = firstMonthRow + months.length - 1;
  const totalRow = lastMonthRow + 1;
  const avgRow = totalRow + 1;

  const ws = wb.addWorksheet(`${year} Report`, { views: [{ state: "frozen", xSplit: firstDet - 1, ySplit: nameRow, showGridLines: false }] });
  ws.getColumn(1).width = 11;
  snap.forEach((c) => { ws.getColumn(c.col).width = Math.max(12, c.label.length + 4); });
  details.forEach((d) => {
    const title = `${d.row.cat.name} (${d.row.cat.frequency !== "regular" ? FREQUENCIES[d.row.cat.frequency].label : d.section.type === "reimbursable" ? "waiting on $00,000" : ""})`;
    ws.getColumn(d.col).width = Math.max(12, Math.min(40, title.length + 3));
  });

  ws.getCell("A1").value = `The Expense Tracker: ${year} Report`;
  ws.getCell("A1").font = { name: "Calibri", size: 16, bold: true, color: { argb: COLOR.ink } };
  ws.getCell("A2").value = `Saved ${savedOn}. This file is also your backup: to restore it, open The Expense Tracker and choose Backup, then Restore from backup. Changes made in this spreadsheet aren't restored.`;
  ws.getCell("A2").font = { size: 10, color: { argb: COLOR.muted } };

  const style = (cell, { fillColor, font, align, border } = {}) => {
    if (fillColor) cell.fill = fill(fillColor);
    if (font) cell.font = font;
    if (align) cell.alignment = align;
    if (border) cell.border = border;
  };
  const gold = { style: "medium", color: { argb: COLOR.ochre } };
  const thin = { style: "thin", color: { argb: COLOR.line } };

  // Header bands
  ws.mergeCells(headTop, 1, nameRow, 1);
  ws.getCell(headTop, 1).value = "MONTH";
  style(ws.getCell(headTop, 1), { font: { size: 10, bold: true, color: { argb: COLOR.muted } }, align: { horizontal: "center", vertical: "middle" } });
  // One header row: SNAPSHOT, then each group of categories by type.
  ws.mergeCells(headTop, firstSnap, headTop, firstDet - 1);
  ws.getCell(headTop, firstSnap).value = "SNAPSHOT";
  style(ws.getCell(headTop, firstSnap), { fillColor: COLOR.olive, font: { bold: true, size: 10, color: { argb: COLOR.card } }, align: { horizontal: "center", vertical: "middle" }, border: { right: gold } });
  ws.getRow(headTop).height = 22;
  for (const section of r.sections) {
    const [a, b] = groupCols.get(section.type);
    if (b > a) ws.mergeCells(headTop, a, headTop, b);
    const cell = ws.getCell(headTop, a);
    let label = section.label.toUpperCase();
    cell.value = label;
    if (section.type === "excluded") cell.note = "Left out of every total. Money out shows as positive; money coming back in subtracts.";
    style(cell, { fillColor: COLOR.paper, font: { bold: true, size: 9, color: { argb: COLOR.oliveDeep } }, align: { horizontal: "center", vertical: "middle" }, border: { left: thin, bottom: thin } });
  }
  // Column names
  ws.getRow(nameRow).height = 20;
  for (const c of snap) {
    const cell = ws.getCell(nameRow, c.col);
    cell.value = c.label;
    if (c.net) cell.note = NET_HELP;
    style(cell, { fillColor: COLOR.snapshot, font: { bold: true, color: { argb: COLOR.ink } }, align: { horizontal: "center", vertical: "middle" }, border: { bottom: thin, ...(c.net ? { right: gold } : {}) } });
  }
  for (const d of details) {
    const cell = ws.getCell(nameRow, d.col);
    cell.value = d.row.cat.frequency !== "regular" && COUNTED_TYPES.includes(d.section.type)
      ? `${d.row.cat.name} (${FREQUENCIES[d.row.cat.frequency].label.toLowerCase()})`
      : d.section.type === "reimbursable" && d.row.owed > 0 ? `${d.row.cat.name} (waiting on ${dollars(d.row.owed)})` : d.row.cat.name;
    style(cell, { font: { bold: true, color: { argb: d.section.type === "excluded" ? COLOR.muted : COLOR.ink } }, align: { horizontal: "center", vertical: "middle" }, border: { bottom: thin, ...(d.first ? { left: thin } : {}) } });
  }

  // Formulas: a Snapshot cell adds up its group's category cells in the same row.
  const groupSum = (key, row) => {
    const g = groupCols.get(key);
    return g ? `SUM(${L(g[0])}${row}:${L(g[1])}${row})` : "0";
  };
  const netFormula = (row) => {
    const ref = (key) => snap.find((c) => c.key === key);
    const parts = ["giving", "saving", "spending"].map(ref).filter(Boolean).map((c) => `-${L(c.col)}${row}`).join("");
    return `${L(ref("income").col)}${row}${parts}`;
  };
  const avgCents = (key) => r.sections.filter((x) => x.type === key).flatMap((x) => x.rows).reduce((n, row) => n + toDollars(row.average), 0);

  // Month rows
  months.forEach((k, i) => {
    const rowNo = firstMonthRow + i;
    const info = r.monthInfo.get(k);
    const marked = info.partial || info.notes.length;
    const label = ws.getCell(rowNo, 1);
    label.value = `${MONTHS[Number(k.slice(5, 7)) - 1].abbr}${marked ? "*" : ""}`;
    if (marked) label.note = `${monthLabel(k)}: ${info.notes.join(". ") || "partly imported"}.`;
    style(label, { font: { bold: true, size: 10, color: { argb: marked ? COLOR.ochre : COLOR.muted } }, align: { horizontal: "center" } });
    for (const c of snap) {
      const cents = r.summary[c.key].cells.get(k);
      const cell = ws.getCell(rowNo, c.col);
      cell.value = { formula: c.net ? netFormula(rowNo) : groupSum(c.key, rowNo), result: toDollars(cents) };
      style(cell, { fillColor: COLOR.snapshot, font: { bold: !!c.net, color: { argb: cents < 0 ? COLOR.rust : COLOR.ink } }, border: { bottom: { style: "hair", color: { argb: "FFE6D9BC" } }, ...(c.net ? { right: gold } : {}) } });
      cell.numFmt = MONEY;
      cell.alignment = { horizontal: "center" };
    }
    for (const d of details) {
      const c = d.row.cells.get(k);
      const cell = ws.getCell(rowNo, d.col);
      if (c?.count) cell.value = toDollars(c.cents);
      cell.numFmt = MONEY;
      cell.alignment = { horizontal: "center" };
      style(cell, { font: { color: { argb: d.section.type === "excluded" ? COLOR.muted : COLOR.ink } }, border: { bottom: { style: "hair", color: { argb: COLOR.line } }, ...(d.first ? { left: thin } : {}) } });
    }
  });

  // Total and average rows
  const tl = ws.getCell(totalRow, 1);
  tl.value = "TOTAL";
  const al = ws.getCell(avgRow, 1);
  al.value = "AVG / MO";
  al.note = "Per month. Regular categories: the total ÷ months imported. Categories paid yearly, twice a year, or quarterly: a typical payment spread across 12 months.";
  for (const c of [tl, al]) style(c, { font: { bold: true, size: 10, color: { argb: COLOR.ink } }, align: { horizontal: "center" } });
  const top = { top: { style: "medium", color: { argb: COLOR.olive } } };
  for (const c of snap) {
    const cell = ws.getCell(totalRow, c.col);
    cell.value = { formula: `SUM(${L(c.col)}${firstMonthRow}:${L(c.col)}${lastMonthRow})`, result: toDollars(r.summary[c.key].total) };
    const avg = ws.getCell(avgRow, c.col);
    const snapAvg = c.net
      ? avgCents("income") - avgCents("giving") - avgCents("saving") - avgCents("spending")
      : avgCents(c.key);
    avg.value = { formula: c.net ? netFormula(avgRow) : groupSum(c.key, avgRow), result: Math.round(snapAvg * 100) / 100 };
    for (const [cell2, bg, total] of [[cell, COLOR.snapshot, r.summary[c.key].total], [avg, COLOR.snapshotAvg, snapAvg]]) {
      cell2.numFmt = MONEY;
      cell2.alignment = { horizontal: "center" };
      style(cell2, { fillColor: bg, font: { bold: true, color: { argb: total < 0 ? COLOR.rust : COLOR.ink } }, border: { ...(cell2 === cell ? top : {}), ...(c.net ? { right: gold } : {}) } });
    }
  }
  for (const d of details) {
    const cell = ws.getCell(totalRow, d.col);
    cell.value = { formula: `SUM(${L(d.col)}${firstMonthRow}:${L(d.col)}${lastMonthRow})`, result: toDollars(d.row.total) };
    cell.numFmt = MONEY;
    style(cell, { font: { bold: true }, align: { horizontal: "center" }, border: { ...top, ...(d.first ? { left: thin } : {}) } });
    const avg = ws.getCell(avgRow, d.col);
    avg.value = toDollars(d.row.average);
    avg.numFmt = MONEY;
    style(avg, { fillColor: COLOR.avg, align: { horizontal: "center" }, border: d.first ? { left: thin } : {} });
    if (d.row.lumpy) {
      const f = FREQUENCIES[d.row.cat.frequency].label.toLowerCase();
      avg.note = d.row.averageBasis === "prior"
        ? `Paid ${f} and nothing paid yet in ${year}, so this spreads ${Number(year) - 1}'s payments across 12 months.`
        : `Paid ${f}, so this spreads a typical payment across 12 months instead of dividing by the months imported.`;
    }
    // Shading: darker gold for a higher month, compared with the category's other months.
    if (COUNTED_TYPES.includes(d.section.type) && months.length > 1) {
      ws.addConditionalFormatting({
        ref: `${L(d.col)}${firstMonthRow}:${L(d.col)}${lastMonthRow}`,
        rules: [{ type: "colorScale", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: [{ argb: "FFFAF3E3" }, { argb: "FFE2C38B" }] }],
      });
    }
  }

  // Notes under the table
  let rowNo = avgRow + 1;
  const notes = [];
  const covered = Math.round(r.monthsCovered * 10) / 10;
  notes.push(`Averages cover the ${covered === 1 ? "1 month" : `${covered} months`} with imported data. Cells show whole dollars but hold exact amounts. Darker gold marks a higher month for that category.`);
  if (r.hasLumpy) notes.push("Categories paid yearly, twice a year, or quarterly spread a typical payment across 12 months (hover their average for details).");
  for (const k of months) {
    const info = r.monthInfo.get(k);
    if (info.partial || info.notes.length) notes.push(`* ${monthLabel(k)}: ${info.notes.join(". ") || "partly imported"}.`);
  }
  if (r.unsorted.count) notes.push(`${r.unsorted.count.toLocaleString("en-US")} transactions from ${year} weren't sorted yet and are left out of these numbers.`);
  for (const text of notes) {
    rowNo++;
    ws.getCell(`A${rowNo}`).value = text;
    ws.getCell(`A${rowNo}`).font = { size: 10, color: { argb: COLOR.muted } };
  }
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return ws;
}

// ---------- Transactions sheet ----------

function addTransactionsSheet(wb, store) {
  const ws = wb.addWorksheet("Transactions", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Date", key: "date", width: 13 },
    { header: "Counts Toward", key: "counts", width: 15 },
    { header: "Vendor", key: "vendor", width: 30 },
    { header: "Category", key: "category", width: 26 },
    { header: "Type", key: "type", width: 18 },
    { header: "Amount", key: "amount", width: 13 },
    { header: "Account", key: "account", width: 24 },
    { header: "Split", key: "split", width: 22 },
    { header: "Note", key: "memo", width: 22 },
    { header: "Location", key: "location", width: 20 },
    { header: "From the Bank", key: "raw", width: 48 },
    { header: "Check #", key: "check", width: 9 },
  ];
  const txs = [...store.list("transactions")].sort((a, b) => b.postedDate.localeCompare(a.postedDate) || a.id.localeCompare(b.id));
  for (const tx of txs) {
    const vendor = vendorDisplayName(store.get("vendors", tx.vendorKey), tx);
    const account = store.get("accounts", tx.accountId)?.name || "";
    tx.parts.forEach((part, i) => {
      const cat = part.categoryId ? store.get("categories", part.categoryId) : null;
      ws.addRow({
        date: utcDate(tx.postedDate),
        counts: tx.countsToward ? monthLabel(tx.countsToward) : "",
        vendor,
        category: cat ? cat.name : "(Not sorted yet)",
        type: cat ? CATEGORY_TYPES[cat.type].label : "",
        amount: part.amount / 100,
        account,
        split: tx.parts.length > 1 ? `Part ${i + 1} of ${tx.parts.length} (${formatCents(tx.amount)} total)` : "",
        memo: tx.memo || "",
        location: tx.location || "",
        raw: tx.description,
        check: tx.checkNumber || "",
      });
    });
  }
  ws.getColumn("date").numFmt = "mmm d, yyyy";
  ws.getColumn("amount").numFmt = MONEY_CENTS;
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: COLOR.card } };
  head.fill = fill(COLOR.olive);
  ws.autoFilter = { from: "A1", to: `L${Math.max(1, ws.rowCount)}` };
  return ws;
}

// ---------- About sheet ----------

function addAboutSheet(wb, backup, savedOn) {
  const ws = wb.addWorksheet("About This File", { views: [{ showGridLines: false }] });
  ws.getColumn(1).width = 100;
  const c = backup.counts;
  const lines = [
    ["The Expense Tracker backup", { size: 16, bold: true }],
    [`Saved ${savedOn}: ${c.accounts} accounts, ${c.transactions.toLocaleString("en-US")} transactions, ${c.categories} categories.`],
    [""],
    ["How to restore", { bold: true }],
    ["Open The Expense Tracker, choose Backup, then Restore from backup, and pick this file."],
    ["Restoring replaces everything in that browser with what's in this file."],
    [""],
    ["Good to know", { bold: true }],
    ["The Report and Transactions sheets are for reading, printing, or copying into another tool."],
    ["Changes you make to them aren't restored. The app restores from a hidden copy saved inside this file."],
    ["If the file is damaged or edited in a way that changes that copy, the app will say so and won't restore it."],
    ["This file was made in your browser; the app never sent it anywhere."],
    ["It holds every transaction and isn't password-protected, so keep it somewhere safe, the way you would a bank statement."],
  ];
  lines.forEach(([text, font], i) => {
    const cell = ws.getCell(`A${i + 1}`);
    cell.value = text;
    cell.font = { size: 11, color: { argb: COLOR.ink }, ...(font || {}) };
    cell.alignment = { wrapText: true, vertical: "top" };
  });
  return ws;
}

// ---------- Hidden backup copy ----------

// Cuts text into pieces Excel cells can hold, never between the two halves of an
// emoji or other character that JavaScript stores as a pair (a cut there would
// damage it, and the backup would fail its checksum).
export function splitForCells(text, size = CHUNK) {
  const pieces = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + size, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(text.slice(i, end));
    i = end;
  }
  return pieces;
}

function addDataSheet(wb, backup) {
  const ws = wb.addWorksheet(DATA_SHEET, { state: "veryHidden" });
  const json = JSON.stringify(backup);
  const chunks = splitForCells(json);
  ws.getCell("A1").value = DATA_MARK;
  ws.getCell("A2").value = DATA_FORMAT;
  ws.getCell("A3").value = chunks.length;
  ws.getCell("A4").value = checksum(json);
  ws.getCell("A5").value = json.length;
  chunks.forEach((chunk, i) => { ws.getCell(`A${i + 6}`).value = chunk; });
  return ws;
}

// Builds the whole workbook and returns it as a Blob.
export async function buildBackupWorkbook(store, backup) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = "The Expense Tracker";
  wb.created = new Date(backup.exportedAt);
  const savedOn = new Date(backup.exportedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const years = reportYears(store);
  for (const y of years) addReportSheet(wb, store, y, savedOn);
  addTransactionsSheet(wb, store);
  addAboutSheet(wb, backup, savedOn);
  addDataSheet(wb, backup);
  if (!years.length) wb.views = [{ activeTab: 1 }];
  const buffer = await wb.xlsx.writeBuffer();
  // Read the finished file back before handing it over, so a backup that couldn't
  // be restored is caught now, not on the day it's needed.
  const copy = await readBackupFromWorkbook(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  if (copy !== JSON.stringify(backup)) throw new Error("The backup file didn't read back correctly.");
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// Reads the hidden backup copy back out of a workbook. Returns the backup JSON text.
// Uses the browser's own unzip and XML tools (see xlsx-read.js), which cope with
// files other programs have re-saved; the spreadsheet library is the fallback.
export async function readBackupFromWorkbook(arrayBuffer) {
  let column;
  try {
    column = canReadXlsx() ? await readSheetColumnA(arrayBuffer, DATA_SHEET) : await columnViaExcelJS(arrayBuffer);
  } catch {
    throw new ValidationError("That spreadsheet couldn't be opened. It may be damaged.");
  }
  const text = (i) => (column?.[i] ?? "").toString();
  if (!column || text(0) !== DATA_MARK) {
    throw new ValidationError("That spreadsheet isn't a backup from this app. Backups are files named \"expense-tracker-backup\" that this app saved.");
  }
  if (Number(text(1)) > DATA_FORMAT) throw new ValidationError("This backup was made by a newer version of the app. Reload the page to get the latest version, then try again.");
  const count = Number(text(2));
  if (!Number.isInteger(count) || count < 0 || count > 20000) throw new ValidationError("This backup has been changed or damaged, so it can't be restored safely. Try an earlier backup file.");
  let json = "";
  for (let i = 0; i < count; i++) json += text(i + 5);
  if (json.length !== Number(text(4)) || checksum(json) !== text(3)) {
    throw new ValidationError("This backup has been changed or damaged, so it can't be restored safely. Try an earlier backup file.");
  }
  return json;
}

async function columnViaExcelJS(arrayBuffer) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  const ws = wb.getWorksheet(DATA_SHEET);
  if (!ws) return null;
  const column = [];
  ws.getColumn(1).eachCell({ includeEmpty: false }, (cell, row) => {
    const v = cell.value;
    column[row - 1] = v && typeof v === "object" && Array.isArray(v.richText) ? v.richText.map((t) => t.text).join("") : v;
  });
  return column;
}
