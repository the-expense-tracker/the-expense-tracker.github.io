// Reads one sheet's first column out of an .xlsx file, using only what the
// browser has built in (DecompressionStream and DOMParser). Restoring a backup
// needs nothing more, and this keeps working on files that Excel, Numbers,
// LibreOffice, or Google Sheets have opened and saved again.
//
// An .xlsx file is a zip archive of XML files. This reads the zip's directory,
// unpacks just the files needed, and pulls out the column's text.

const SIG_END = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// Far more than any real backup needs (about 600 MB of text for a million transactions would be extreme).
const MAX_UNPACKED = 400 * 1024 * 1024;

export const canReadXlsx = () => typeof DecompressionStream === "function" && typeof DOMParser === "function";

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error("damaged zip directory");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name.replace(/^\//, ""), { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { view, entries };
}

async function readEntry(bytes, zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const { view } = zip;
  if (view.getUint32(e.local, true) !== SIG_LOCAL) throw new Error("damaged zip entry");
  const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
  const data = bytes.subarray(start, start + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error("unsupported compression");
  // Unpack in pieces and stop at a sensible size, so a booby-trapped file that
  // expands enormously ("zip bomb") can't freeze or crash the page.
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const pieces = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UNPACKED) { await reader.cancel(); throw new Error("file too large"); }
    pieces.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(out);
}

// The page requires "Trusted Types" for anything parsed as markup. Parsing a
// backup's XML never runs code, so this policy passes the text through as XML.
let xmlPolicy = null;
const trusted = (xml) => {
  if (!globalThis.trustedTypes) return xml;
  xmlPolicy ??= globalThis.trustedTypes.createPolicy("xml-reader", { createHTML: (s) => s });
  return xmlPolicy.createHTML(xml);
};
const parse = (xml) => new DOMParser().parseFromString(trusted(xml), "application/xml");
const byTag = (doc, tag) => [...doc.getElementsByTagNameNS("*", tag)];
const attr = (el, local) => {
  for (const a of el.attributes) if (a.localName === local) return a.value;
  return null;
};
// All the text of a shared or inline string, including rich-text runs.
const textOf = (el) => byTag(el, "t").map((t) => t.textContent).join("");

function resolveTarget(target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `xl/${target}`.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

// Returns an array of the text in column A (index 0 = row 1), or null when the
// workbook has no sheet with that name. Throws if the file isn't a readable workbook.
export async function readSheetColumnA(arrayBuffer, sheetName) {
  const bytes = new Uint8Array(arrayBuffer);
  const zip = zipEntries(bytes);
  const workbook = await readEntry(bytes, zip, "xl/workbook.xml");
  const rels = await readEntry(bytes, zip, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("not a workbook");
  const sheet = byTag(parse(workbook), "sheet").find((s) => s.getAttribute("name") === sheetName);
  if (!sheet) return null;
  const relId = attr(sheet, "id");
  const rel = byTag(parse(rels), "Relationship").find((r) => r.getAttribute("Id") === relId);
  if (!rel) throw new Error("sheet link missing");
  const sheetXml = await readEntry(bytes, zip, resolveTarget(rel.getAttribute("Target")));
  if (!sheetXml) throw new Error("sheet missing");
  const sharedXml = await readEntry(bytes, zip, "xl/sharedStrings.xml");
  const shared = sharedXml ? byTag(parse(sharedXml), "si").map(textOf) : [];

  const column = [];
  for (const c of byTag(parse(sheetXml), "c")) {
    const ref = c.getAttribute("r") || "";
    const m = /^A(\d+)$/.exec(ref);
    if (!m) continue;
    const type = c.getAttribute("t");
    const v = byTag(c, "v")[0]?.textContent ?? "";
    let value;
    if (type === "s") value = shared[Number(v)] ?? "";
    else if (type === "inlineStr") value = textOf(byTag(c, "is")[0] || c);
    else value = v;
    column[Number(m[1]) - 1] = value;
  }
  return column;
}
