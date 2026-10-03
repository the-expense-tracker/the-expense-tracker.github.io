// Tiny helper for building page elements. Text is always set as text, never as
// HTML, so nothing in a bank file can turn into code on the page.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Finds an element by its data-focus-key, safely: keys can hold ids from saved data.
export function byFocusKey(root, key) {
  return root.querySelector(`[data-focus-key="${CSS.escape(String(key))}"]`);
}

// Appends children, skipping null/false placeholders (element.append would print "null").
export function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatDate(iso, { short = false } = {}) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return (short ? shortFmt : dateFmt).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatRange(first, last) {
  if (!first) return "";
  if (first === last) return formatDate(first);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${sameYear ? formatDate(first, { short: true }) : formatDate(first)} – ${formatDate(last)}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export const KIND_LABELS = { checking: "Checking", savings: "Savings", card: "Credit card", unknown: "Account" };
