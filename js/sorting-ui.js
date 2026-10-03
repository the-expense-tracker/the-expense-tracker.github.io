// The sorting page: the inbox of unsorted transactions on the left and the
// category boxes on the right. Transactions move by drag-and-drop or with the
// "Move to…" menu; every move can be undone. Clicking a box opens it to show what
// it holds; Edit Categories renames, retypes, reorders, and deletes boxes.

import { h, add, formatDate, plural, byFocusKey, breakAfterSlash } from "./dom.js";
import { CATEGORY_TYPES, FREQUENCIES, MONTHS, formatCents, toCents, monthKeyOf, vendorDisplayName, ValidationError } from "./model.js";
import { buildHintContext, hintFor } from "./hints.js";
import { renameVendor } from "./importer.js";
import { sortedCategories, createCategory, remainingSuggestions, categoryCounts } from "./categories.js";
import {
  parseItemId, assignItems, splitTransaction, undoSplit, setCountsToward, countsTowardOptions,
  updateCategory, reorderCategories, deleteCategory, countInCategoryAllYears,
} from "./sorting-actions.js";
import { openMoveMenu, closeMoveMenu } from "./move-menu.js";

// Short labels for the bar; the full sentence shows in the expanded details.
const HINT_SHORT = {
  paired: "Matched payment",
  "card-payment": "Card payment?",
  "missing-account": "Account not imported?",
};

// Event targets can be text (dragging selected words starts a drag from the text
// itself, not an element), so look things up from the nearest element.
const elementOf = (target) => (target?.nodeType === 1 ? target : target?.parentElement ?? null);

const monthName = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1].name} ${key.slice(0, 4)}`;

export function createSortingUI({ store, toast, goTo }) {
  const $ = (id) => document.getElementById(id);
  const inboxEl = $("inbox");
  const inboxCol = document.querySelector(".inbox-col");
  const gridEl = $("cat-grid");
  const catScroll = document.querySelector(".cat-scroll");
  const sugEl = $("suggestions");
  const searchEl = $("inbox-search");
  const sortEl = $("inbox-sort");
  const editBtn = $("edit-cats");

  const state = {
    year: null,
    search: "",
    sort: "newest",
    selected: new Set(), // inbox selection
    expanded: new Set(),
    renaming: null, // tx id whose vendor is being renamed
    adding: null, // + box form
    openCat: null, // category whose panel is open
    panelSearch: "",
    panelSelected: new Set(),
    panelExpanded: new Set(),
    editing: false,
    confirmDelete: null,
    catErrors: new Map(),
    splitting: null, // { txId, parts: [string, …], error }
  };
  const scopes = {
    inbox: { selected: state.selected, expanded: state.expanded },
    panel: { selected: state.panelSelected, expanded: state.panelExpanded },
  };
  let hintCtx = null;
  let lastShown = [];
  let panelShown = [];
  let drag = null; // { kind: "items", ids, from, fromCat } or { kind: "cat", id }
  let gridCols = 0;
  // Built inbox bars are kept and reused, so searching and sorting only rearrange them.
  const barCache = new Map();

  // ---------- Data shaping ----------

  const vendorName = (tx) => vendorDisplayName(store.get("vendors", tx.vendorKey), tx);

  function years() {
    const set = new Set();
    for (const t of store.list("transactions")) set.add(monthKeyOf(t).slice(0, 4));
    return [...set].sort().reverse();
  }

  // One item per transaction part (a split transaction has several).
  function itemsWhere(categoryId) {
    const items = [];
    for (const tx of store.list("transactions")) {
      const month = monthKeyOf(tx);
      if (state.year && month.slice(0, 4) !== state.year) continue;
      for (const part of tx.parts) {
        if ((part.categoryId || null) !== categoryId) continue;
        items.push({ id: `${tx.id}:${part.id}`, tx, part, month, name: vendorName(tx) });
      }
    }
    return items;
  }

  function matches(item, terms) {
    if (!terms.length) return true;
    const t = item.tx;
    const acct = store.get("accounts", t.accountId)?.name || "";
    const abs = (Math.abs(item.part.amount) / 100).toFixed(2);
    const hay = `${item.name} ${t.description} ${t.memo} ${t.location} ${acct} ${abs} $${abs} ${formatCents(item.part.amount)} ${t.checkNumber}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  }
  const termsOf = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

  const SORTS = {
    newest: (a, b) => b.tx.postedDate.localeCompare(a.tx.postedDate) || a.name.localeCompare(b.name),
    oldest: (a, b) => a.tx.postedDate.localeCompare(b.tx.postedDate) || a.name.localeCompare(b.name),
    az: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || b.tx.postedDate.localeCompare(a.tx.postedDate),
    za: (a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base" }) || b.tx.postedDate.localeCompare(a.tx.postedDate),
  };

  function withFocusKept(fn) {
    const active = document.activeElement;
    const key = active?.dataset?.focusKey;
    const caret = active && "selectionStart" in active ? active.selectionStart : null;
    fn();
    if (!key) return;
    const el = byFocusKey(document, `${CSS.escape(key)}`);
    if (!el) return;
    el.focus();
    if (caret !== null && "setSelectionRange" in el) { try { el.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
  }

  // ---------- Moving ----------

  async function moveItems(ids, categoryId) {
    if (!ids.length) return;
    closeMoveMenu();
    try {
      const { moved, undo } = await assignItems(store, ids, categoryId);
      for (const id of ids) { state.selected.delete(id); state.panelSelected.delete(id); }
      if (!moved) return;
      const where = categoryId ? store.get("categories", categoryId).name : "To Sort";
      toast(`Moved ${plural(moved, "transaction")} ${categoryId ? "to" : "back to"} ${where}`, {
        action: "Undo",
        onAction: async () => { await undo(); toast("Move undone"); },
      });
    } catch (err) {
      if (err instanceof ValidationError) toast(err.message);
    }
  }

  // ---------- Drag-and-drop ----------

  function startItemDrag(e, item, scope) {
    const sel = scopes[scope].selected;
    const ids = sel.has(item.id) ? [...sel] : [item.id];
    drag = { kind: "items", ids, from: scope, fromCat: scope === "panel" ? state.openCat : null };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", plural(ids.length, "transaction"));
    const ghost = h("div", { class: "drag-ghost" }, ids.length === 1 ? item.name : `${plural(ids.length, "transaction")}`);
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    setTimeout(() => ghost.remove(), 0);
    document.body.classList.add("is-dragging");
    if (scope === "panel") inboxCol.classList.add("can-drop");
  }

  function endDrag() {
    drag = null;
    document.body.classList.remove("is-dragging");
    inboxCol.classList.remove("can-drop", "drop-target");
    for (const el of document.querySelectorAll(".drop-target, .drop-before, .drop-after, .cat-dragging")) {
      el.classList.remove("drop-target", "drop-before", "drop-after", "cat-dragging");
    }
  }

  function makeItemDropTarget(el, categoryId) {
    el.addEventListener("dragover", (e) => {
      if (drag?.kind !== "items" || state.editing || drag.fromCat === categoryId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target"); });
    el.addEventListener("drop", (e) => {
      if (drag?.kind !== "items" || state.editing || drag.fromCat === categoryId) return;
      e.preventDefault();
      const ids = drag.ids;
      endDrag();
      moveItems(ids, categoryId);
    });
  }

  // The inbox column takes transactions dragged out of an open box.
  inboxCol.addEventListener("dragover", (e) => {
    if (drag?.kind !== "items" || drag.from !== "panel") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    inboxCol.classList.add("drop-target");
  });
  inboxCol.addEventListener("dragleave", (e) => { if (!inboxCol.contains(e.relatedTarget)) inboxCol.classList.remove("drop-target"); });
  inboxCol.addEventListener("drop", (e) => {
    if (drag?.kind !== "items" || drag.from !== "panel") return;
    e.preventDefault();
    const ids = drag.ids;
    endDrag();
    moveItems(ids, null);
  });
  document.addEventListener("dragend", endDrag);

  // Scroll a column when dragging near its top or bottom edge.
  document.addEventListener("dragover", (e) => {
    if (!drag) return;
    for (const el of [inboxEl, catScroll, document.querySelector(".panel-list")]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) continue;
      const zone = 56;
      if (e.clientY > r.top && e.clientY < r.top + zone) el.scrollTop -= Math.ceil((zone - (e.clientY - r.top)) / 4);
      else if (e.clientY < r.bottom && e.clientY > r.bottom - zone) el.scrollTop += Math.ceil((zone - (r.bottom - e.clientY)) / 4);
    }
  });

  // ---------- Year tabs ----------

  function renderYears() {
    const ys = years();
    if (!ys.includes(state.year)) state.year = ys[0] || null;
    const box = $("year-tabs");
    box.replaceChildren();
    box.hidden = ys.length === 0;
    for (const y of ys) {
      add(box, h("button", {
        type: "button", role: "tab", class: `year-tab${y === state.year ? " active" : ""}`, "aria-selected": y === state.year ? "true" : "false",
        "data-focus-key": `year-${y}`,
        onclick: () => { state.year = y; state.panelSelected.clear(); renderAll(); },
      }, y));
    }
  }

  // ---------- Bars (shared by the inbox and open boxes) ----------

  function hintOf(tx) {
    if (!hintCtx) hintCtx = buildHintContext(store);
    return hintFor(tx, hintCtx);
  }

  function detailRow(label, value, cls = "") {
    if (!value && value !== 0) return null;
    return h("div", { class: `detail ${cls}` }, h("dt", {}, label), h("dd", {}, value));
  }

  function rerender(scope, item) {
    if (scope === "inbox") { barCache.delete(item.id); redrawBar(item.id); } else withFocusKept(() => renderPanelList());
  }

  function renderRename(tx, scope, item) {
    const vendor = store.get("vendors", tx.vendorKey);
    const sameVendor = store.list("transactions").filter((t) => t.vendorKey === tx.vendorKey).length;
    const input = h("input", {
      type: "text", class: "inline-input", value: vendorName(tx), "aria-label": "New vendor name", "data-focus-key": `rename-${tx.id}`,
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter") save();
        if (e.key === "Escape") { state.renaming = null; rerender(scope, item); }
      },
    });
    async function save() {
      state.renaming = null; // before saving, so the redraw shows the finished state
      await renameVendor(store, tx.vendorKey, input.value);
      toast(sameVendor > 1 ? `Renamed ${plural(sameVendor, "transaction")}` : "Renamed");
    }
    return h("div", { class: "rename" },
      input,
      h("div", { class: "actions tight" },
        h("button", { type: "button", class: "btn btn-primary btn-small", onclick: save }, "Save"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => { state.renaming = null; rerender(scope, item); } }, "Cancel")),
      h("p", { class: "muted small" }, sameVendor > 1
        ? `Renames all ${sameVendor} transactions from this vendor, including future imports.`
        : "Also applies to future imports from this vendor."),
      vendor?.customName ? h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: async () => {
        state.renaming = null;
        await renameVendor(store, tx.vendorKey, vendor.cleanName);
        toast("Original name restored");
      } }, `Use the original name (${vendor.cleanName})`) : null);
  }

  function renderSplitEditor(tx, scope, item) {
    const sp = state.splitting;
    const sign = Math.sign(tx.amount);
    const total = Math.abs(tx.amount);
    let entered = 0;
    let bad = false;
    for (const v of sp.parts) {
      if (!v.trim()) continue;
      try { entered += Math.abs(toCents(v)); } catch { bad = true; }
    }
    const remaining = total - entered;
    const rows = sp.parts.map((v, i) => h("label", { class: "split-row" },
      h("span", {}, `Part ${i + 1}`),
      h("input", {
        type: "text", inputmode: "decimal", class: "inline-input", value: v, placeholder: "0.00", "data-focus-key": `split-${tx.id}-${i}`,
        "aria-label": `Amount for part ${i + 1}`,
        oninput: (e) => { sp.parts[i] = e.target.value; sp.error = ""; withFocusKept(() => rerender(scope, item)); },
        onkeydown: (e) => e.stopPropagation(),
      }),
      sp.parts.length > 2 ? h("button", { type: "button", class: "btn btn-quiet btn-small", "aria-label": `Remove part ${i + 1}`, onclick: () => { sp.parts.splice(i, 1); rerender(scope, item); } }, "Remove") : null));
    async function save() {
      try {
        const amounts = sp.parts.map((v) => sign * Math.abs(toCents(v)));
        await splitTransaction(store, tx.id, amounts);
        state.splitting = null;
        toast(`Split into ${amounts.length} parts. Each one sorts on its own.`);
      } catch (err) {
        sp.error = err instanceof ValidationError ? err.message : "Check the amounts.";
        rerender(scope, item);
      }
    }
    return h("div", { class: "split-editor" },
      h("p", { class: "muted small" }, `Divide ${formatCents(tx.amount)} into parts. Each part shows up in To Sort on its own.`),
      rows,
      h("p", { class: `split-remaining${remaining === 0 && !bad ? " done" : ""}` },
        bad ? "One of the amounts isn't a number." : remaining === 0 ? "Parts add up to the full amount." : remaining > 0 ? `${formatCents(remaining)} left to assign` : `${formatCents(-remaining)} too much`),
      sp.error ? h("p", { class: "error-text small", role: "alert" }, sp.error) : null,
      h("div", { class: "actions tight" },
        h("button", { type: "button", class: "btn btn-primary btn-small", disabled: remaining !== 0 || bad, onclick: save }, "Save split"),
        sp.parts.length < 8 ? h("button", { type: "button", class: "btn btn-small", onclick: () => { sp.parts.push(remaining > 0 ? (remaining / 100).toFixed(2) : ""); rerender(scope, item); } }, "Add a part") : null,
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { state.splitting = null; rerender(scope, item); } }, "Cancel")));
  }

  function renderDetails(item, scope) {
    const t = item.tx;
    const hint = hintOf(t);
    const account = store.get("accounts", t.accountId)?.name || "";
    const dupOf = t.dupOf ? store.get("transactions", t.dupOf) : null;
    const vendorRow = state.renaming === t.id
      ? h("div", { class: "detail" }, h("dt", {}, "Vendor"), h("dd", {}, renderRename(t, scope, item)))
      : h("div", { class: "detail" }, h("dt", {}, "Vendor"), h("dd", {},
        item.name, " ",
        h("button", { type: "button", class: "btn btn-quiet btn-small", "data-focus-key": `rename-btn-${t.id}`, onclick: () => { state.renaming = t.id; rerender(scope, item); byFocusKey(document, `rename-${t.id}`)?.focus(); } }, "Rename")));

    const posted = t.postedDate.slice(0, 7);
    const monthSelect = h("select", {
      class: "inline-select", "aria-label": "Month this transaction counts toward", "data-focus-key": `month-${t.id}`,
      onchange: async (e) => {
        const value = e.target.value;
        await setCountsToward(store, t.id, value);
        toast(value === posted ? `Counts toward ${monthName(posted)} again` : `Now counts toward ${monthName(value)}`);
      },
    }, countsTowardOptions(t.postedDate).map((m) => h("option", { value: m, selected: m === item.month }, m === posted ? `${monthName(m)} (when it posted)` : monthName(m))));

    let splitRow = null;
    if (state.splitting?.txId === t.id) {
      splitRow = h("div", { class: "detail" }, h("dt", {}, "Split"), h("dd", {}, renderSplitEditor(t, scope, item)));
    } else if (t.parts.length > 1) {
      splitRow = h("div", { class: "detail" }, h("dt", {}, "Split"), h("dd", {},
        `This part is ${formatCents(item.part.amount)} of ${formatCents(t.amount)}, split into ${t.parts.length} parts. `,
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: async () => {
          await undoSplit(store, t.id);
          toast("Split undone. The whole transaction is back in To Sort.");
        } }, "Undo split")));
    } else if (scope === "inbox") {
      splitRow = h("div", { class: "detail" }, h("dt", {}, "Split"), h("dd", {},
        h("button", { type: "button", class: "btn btn-quiet btn-small", "data-focus-key": `split-btn-${t.id}`, onclick: () => {
          const half = Math.floor(Math.abs(t.amount) / 2);
          state.splitting = { txId: t.id, parts: [(half / 100).toFixed(2), ((Math.abs(t.amount) - half) / 100).toFixed(2)], error: "" };
          rerender(scope, item);
          byFocusKey(document, `split-${t.id}-0`)?.focus();
        } }, "Split across categories")));
    }

    return h("dl", { class: "bar-details", id: `details-${item.id}` },
      vendorRow,
      detailRow("Date", t.countsToward ? `${formatDate(t.postedDate)}, counted in ${monthName(t.countsToward)}` : formatDate(t.postedDate)),
      h("div", { class: "detail" }, h("dt", {}, "Counts toward"), h("dd", {}, monthSelect)),
      detailRow("Account", account),
      detailRow("Location", t.location),
      detailRow("Note", t.memo),
      detailRow("Check", t.checkNumber ? `#${t.checkNumber}` : ""),
      splitRow,
      detailRow("From the bank", t.description, "raw"),
      hint ? detailRow("Hint", hint.text) : null,
      dupOf ? detailRow("Possible duplicate", `Looks like ${vendorName(dupOf)} on ${formatDate(dupOf.postedDate)} (${formatCents(dupOf.amount)}), which was already saved. Review it under Manage accounts.`) : null);
  }

  function barSignature(item) {
    return `${state.selected.has(item.id)}|${state.expanded.has(item.id)}|${state.renaming === item.tx.id}|${state.splitting?.txId === item.tx.id}|${item.name}|${item.part.amount}|${item.month}|${item.tx.dupOf}|${item.tx.parts.length}`;
  }

  function cachedBar(item) {
    const sig = barSignature(item);
    const hit = barCache.get(item.id);
    if (hit && hit.sig === sig) return hit.el;
    const el = renderBar(item, "inbox");
    barCache.set(item.id, { sig, el });
    return el;
  }

  function renderBar(item, scope) {
    const t = item.tx;
    const { selected: sel, expanded: exp } = scopes[scope];
    const selected = sel.has(item.id);
    const expanded = exp.has(item.id);
    const info = MONTHS[Number(item.month.slice(5, 7)) - 1];
    const hint = hintOf(t);
    const pill = t.dupOf ? "Possible duplicate" : hint ? HINT_SHORT[hint.kind] : null;
    const moved = !!t.countsToward;
    const bar = h("div", {
      class: `bar${selected ? " selected" : ""}${expanded ? " expanded" : ""}`, role: "listitem", "data-id": item.id, draggable: "true",
      ondragstart: (e) => {
        if (elementOf(e.target)?.closest("input, select, textarea, .bar-details")) { e.preventDefault(); return; }
        startItemDrag(e, item, scope);
      },
    },
      h("div", {
        class: "bar-main", role: "button", tabindex: "0", "aria-pressed": selected ? "true" : "false", "data-focus-key": `${scope}-bar-${item.id}`,
        title: moved ? `Posted ${formatDate(t.postedDate)}; counts toward ${monthName(item.month)}` : monthName(item.month),
        onclick: () => toggleSelect(item.id, scope),
        onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleSelect(item.id, scope); } },
      },
        h("span", { class: `month-tab${moved ? " moved" : ""}` }, selected ? h("span", { class: "tick", "aria-hidden": "true" }, "✓") : null, info.abbr),
        h("span", { class: "bar-name" }, item.name),
        t.parts.length > 1 ? h("span", { class: "pill" }, "Split") : null,
        pill ? h("span", { class: `pill${t.dupOf ? " pill-warn" : ""}` }, pill) : null,
        h("span", { class: `bar-amount ${item.part.amount < 0 ? "out" : "in"}` }, formatCents(item.part.amount, { signed: true })),
        h("span", { class: "visually-hidden" }, `, ${formatDate(t.postedDate)}${moved ? `, counts toward ${monthName(item.month)}` : ""}${selected ? ", selected" : ""}`)),
      h("button", {
        type: "button", class: "bar-expand", "aria-expanded": expanded ? "true" : "false", "aria-controls": `details-${item.id}`,
        "aria-label": expanded ? `Hide details for ${item.name}` : `Show details for ${item.name}`, "data-focus-key": `${scope}-exp-${item.id}`,
        onclick: () => toggleExpand(item.id, scope),
      }, h("span", { class: "chev", "aria-hidden": "true" }, "›")));
    bar.style.setProperty("--m", info.color);
    if (expanded) bar.append(renderDetails(item, scope));
    return bar;
  }

  // Redraws one inbox bar in place; far faster than redrawing a list of a thousand.
  function redrawBar(id) {
    const item = lastShown.find((i) => i.id === id);
    const el = inboxEl.querySelector(`[data-id="${CSS.escape(CSS.escape(id))}"]`);
    if (!item || !el) { renderInbox(); return; }
    withFocusKept(() => el.replaceWith(cachedBar(item)));
  }

  function paintSelected(el, selected) {
    el.classList.toggle("selected", selected);
    const main = el.querySelector(".bar-main");
    main.setAttribute("aria-pressed", selected ? "true" : "false");
    const tab = el.querySelector(".month-tab");
    const tick = tab.querySelector(".tick");
    if (selected && !tick) tab.prepend(h("span", { class: "tick", "aria-hidden": "true" }, "✓"));
    if (!selected && tick) tick.remove();
    const sr = main.querySelector(".visually-hidden");
    sr.textContent = sr.textContent.replace(/, selected$/, "") + (selected ? ", selected" : "");
  }

  function toggleSelect(id, scope) {
    const sel = scopes[scope].selected;
    const selected = !sel.has(id);
    if (selected) sel.add(id); else sel.delete(id);
    const root = scope === "inbox" ? inboxEl : gridEl.querySelector(".panel-list");
    const el = root?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) paintSelected(el, selected);
    if (scope === "inbox") {
      const hit = barCache.get(id);
      const item = lastShown.find((i) => i.id === id);
      if (hit && item) hit.sig = barSignature(item);
      renderSelectionBar();
    } else {
      renderPanelSelection();
    }
  }

  function toggleExpand(id, scope) {
    const exp = scopes[scope].expanded;
    if (exp.has(id)) exp.delete(id); else exp.add(id);
    const { txId } = parseItemId(id);
    if (!exp.has(id)) {
      if (state.renaming === txId) state.renaming = null;
      if (state.splitting?.txId === txId) state.splitting = null;
    }
    if (scope === "inbox") redrawBar(id); else withFocusKept(() => renderPanelList());
  }

  // ---------- Inbox ----------

  function renderSelectionBar() {
    const box = $("selection-bar");
    box.replaceChildren();
    const n = state.selected.size;
    if (n) {
      const moveBtn = h("button", {
        type: "button", class: "btn btn-primary btn-small", "aria-haspopup": "listbox", "aria-expanded": "false", "data-focus-key": "inbox-move",
        onclick: (e) => openMoveMenu(e.currentTarget, { store, onPick: (catId) => moveItems([...state.selected], catId) }),
      }, "Move to…");
      add(box,
        h("span", { class: "sel-count" }, `${n} selected`),
        h("span", { class: "menu-anchor" }, moveBtn),
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { state.selected.clear(); renderInbox(); } }, "Clear"));
    }
    if (lastShown.length && lastShown.some((i) => !state.selected.has(i.id))) {
      add(box, h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => {
        for (const i of lastShown) state.selected.add(i.id);
        renderInbox();
      } }, state.search ? `Select all ${lastShown.length} shown` : `Select all ${lastShown.length}`));
    }
  }

  // The Report button gets a gentle highlight once a year is fully sorted, until it's opened.
  let seenReport = false;
  const reportBtn = document.querySelector('.seg-btn[data-page="report"]');
  reportBtn?.addEventListener("click", () => { seenReport = true; markReportReady(); });
  function markReportReady(ready = false) {
    reportBtn?.classList.toggle("ready", ready && !seenReport);
  }
  function itemsInYear(year) {
    let n = 0;
    for (const tx of store.list("transactions")) if (monthKeyOf(tx).slice(0, 4) === year) for (const p of tx.parts) if (!p.categoryId) n++;
    return n;
  }

  function renderInbox() {
    const all = itemsWhere(null);
    markReportReady(store.count("transactions") > 0 && all.length === 0 && !!state.year);
    const terms = termsOf(state.search);
    const shown = all.filter((i) => matches(i, terms)).sort(SORTS[state.sort]);
    lastShown = shown;
    const live = new Set(all.map((i) => i.id));
    for (const id of state.selected) if (!live.has(id)) state.selected.delete(id);
    $("inbox-count").textContent = state.year
      ? terms.length ? `${shown.length.toLocaleString("en-US")} of ${all.length.toLocaleString("en-US")}` : all.length.toLocaleString("en-US")
      : "";
    renderSelectionBar();

    const frag = document.createDocumentFragment();
    if (!store.count("transactions")) {
      frag.append(h("div", { class: "empty" },
        h("p", {}, "Add a bank file above and its transactions will appear here, ready to sort."),
        window.__ET_PREVIEW__ ? h("button", { type: "button", class: "btn btn-primary empty-action", onclick: () => document.getElementById("demo-btn").click() }, "Load demo data") : null));
    } else if (!all.length) {
      // All sorted: point to the payoff, the Report.
      const elsewhere = years().filter((y) => y !== state.year && itemsInYear(y) > 0);
      frag.append(h("div", { class: "empty all-sorted" },
        h("p", { class: "all-sorted-title" }, `Everything from ${state.year} is sorted`),
        h("p", {}, "See where your money went, month by month."),
        h("button", { type: "button", class: "btn btn-primary empty-action", "data-focus-key": "see-report", onclick: () => { seenReport = true; markReportReady(); goTo?.("report"); } }, "See your Report"),
        elsewhere.length ? h("p", { class: "muted small other-years" },
          `${elsewhere[0]} still has ${plural(itemsInYear(elsewhere[0]), "transaction")} to sort. `,
          h("button", { type: "button", class: "zone-link", onclick: () => { state.year = elsewhere[0]; renderAll(); } }, `Go to ${elsewhere[0]}`)) : null));
    } else if (!shown.length) {
      frag.append(h("div", { class: "empty" }, h("p", {}, `Nothing matches “${state.search}”.`)));
    } else {
      for (const item of shown) frag.append(cachedBar(item));
    }
    inboxEl.replaceChildren(frag);
  }

  // ---------- Open box panel ----------

  function renderPanelSelection() {
    const box = gridEl.querySelector(".panel-selection");
    if (!box) return;
    box.replaceChildren();
    const n = state.panelSelected.size;
    if (n) {
      const moveBtn = h("button", {
        type: "button", class: "btn btn-primary btn-small", "aria-haspopup": "listbox", "aria-expanded": "false", "data-focus-key": "panel-move",
        onclick: (e) => openMoveMenu(e.currentTarget, { store, excludeId: state.openCat, includeInbox: true, onPick: (catId) => moveItems([...state.panelSelected], catId) }),
      }, "Move to…");
      add(box,
        h("span", { class: "sel-count" }, `${n} selected`),
        h("span", { class: "menu-anchor" }, moveBtn),
        h("button", { type: "button", class: "btn btn-small", onclick: () => moveItems([...state.panelSelected], null) }, "Back to To Sort"),
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { state.panelSelected.clear(); renderPanelList(); } }, "Clear"));
    }
    if (panelShown.length && panelShown.some((i) => !state.panelSelected.has(i.id))) {
      add(box, h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => {
        for (const i of panelShown) state.panelSelected.add(i.id);
        renderPanelList();
      } }, state.panelSearch ? `Select all ${panelShown.length} shown` : `Select all ${panelShown.length}`));
    }
  }

  function renderPanelList() {
    const list = gridEl.querySelector(".panel-list");
    if (!list) return;
    const cat = store.get("categories", state.openCat);
    const all = itemsWhere(state.openCat);
    const live = new Set(all.map((i) => i.id));
    for (const id of state.panelSelected) if (!live.has(id)) state.panelSelected.delete(id);
    panelShown = all.filter((i) => matches(i, termsOf(state.panelSearch))).sort(SORTS.newest);
    list.replaceChildren();
    if (!all.length) {
      add(list, h("p", { class: "panel-empty" }, `Nothing in ${cat.name} for ${state.year} yet. Drag transactions here, or select them in To Sort and use Move to.`));
    } else if (!panelShown.length) {
      add(list, h("p", { class: "panel-empty" }, `Nothing matches “${state.panelSearch}”.`));
    } else {
      for (const item of panelShown) list.append(renderBar(item, "panel"));
    }
    renderPanelSelection();
  }

  function renderPanel(cat, count) {
    const panel = h("section", { class: "cat-panel", id: "cat-panel", "aria-label": `${cat.name} transactions` },
      h("div", { class: "panel-head" },
        h("h3", {}, cat.name),
        cat.type !== "spending" ? h("span", { class: "cat-type" }, CATEGORY_TYPES[cat.type].label) : null,
        h("span", { class: "muted small" }, `${plural(count, "transaction")} in ${state.year}`),
        h("button", { type: "button", class: "btn btn-quiet btn-small panel-close", "aria-label": `Close ${cat.name}`, onclick: () => { state.openCat = null; renderCategories(); gridEl.querySelector(`[data-id="${CSS.escape(cat.id)}"]`)?.focus(); } }, "Close")),
      h("div", { class: "panel-tools" },
        h("input", {
          type: "search", class: "panel-search", placeholder: `Search ${cat.name}`, value: state.panelSearch, "aria-label": `Search ${cat.name}`, "data-focus-key": "panel-search",
          oninput: (e) => { state.panelSearch = e.target.value; renderPanelList(); },
        })),
      h("div", { class: "panel-selection selection-bar" }),
      h("div", { class: "panel-list", role: "list", "aria-label": `${cat.name} transactions` }));
    makeItemDropTarget(panel, cat.id);
    return panel;
  }

  function placePanelArrow(panel, box) {
    const x = box.offsetLeft + box.offsetWidth / 2 - panel.offsetLeft;
    panel.style.setProperty("--arrow-x", `${Math.round(x)}px`);
  }

  // ---------- Categories ----------

  // ---------- "i": what each category type means ----------
  // Opens a small card beside the button, listing every type in order of importance.
  let typeInfo = null;
  function closeTypeInfo({ refocus = false } = {}) {
    if (!typeInfo) return;
    const { pop, btn, onOutside, onKey } = typeInfo;
    pop.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    btn.setAttribute("aria-expanded", "false");
    typeInfo = null;
    if (refocus && btn.isConnected) btn.focus();
  }
  const onScroll = () => closeTypeInfo();
  function openTypeInfo(btn) {
    if (typeInfo?.btn === btn) { closeTypeInfo(); return; }
    closeTypeInfo();
    const pop = h("div", { class: "type-info", id: "type-info", role: "dialog", "aria-label": "Category types", tabindex: "-1" },
      h("p", { class: "type-info-title" }, "Category Types"),
      h("dl", {}, Object.values(CATEGORY_TYPES).map((t) => h("div", { class: "type-info-item" }, h("dt", {}, t.label), h("dd", {}, t.hint)))),
      h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => closeTypeInfo({ refocus: true }) }, "Close"));
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const below = r.bottom + 6 + pop.offsetHeight < window.innerHeight;
    pop.style.setProperty("left", `${left}px`);
    pop.style.setProperty("top", `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - pop.offsetHeight)}px`);
    const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== btn) closeTypeInfo(); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeTypeInfo({ refocus: true }); } };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    btn.setAttribute("aria-expanded", "true");
    typeInfo = { pop, btn, onOutside, onKey };
    pop.focus();
  }
  function typeInfoButton(focusKey) {
    return h("button", {
      type: "button", class: "info-btn", "aria-label": "What do the category types mean?", "aria-haspopup": "dialog", "aria-expanded": "false",
      "aria-controls": "type-info", title: "What do the category types mean?", "data-focus-key": focusKey,
      onclick: (e) => openTypeInfo(e.currentTarget),
    }, "i");
  }

  function renderAddBox(first) {
    if (!state.adding) {
      return h("button", {
        type: "button", class: "cat cat-add", "data-focus-key": "cat-add",
        onclick: () => { state.adding = { name: "", type: "spending", error: "" }; renderCategories(); gridEl.querySelector("#new-cat-name")?.focus(); },
      },
        h("span", { class: "plus", "aria-hidden": "true" }, "+"),
        h("span", {}, first ? "Create Your First Category" : "New Category"),
        first ? h("span", { class: "muted small" }, "Like Groceries or Rent") : null);
    }
    const a = state.adding;
    const nameInput = h("input", {
      type: "text", id: "new-cat-name", class: "inline-input", placeholder: "Category name", value: a.name, maxlength: 40, "aria-label": "Category name",
      oninput: (e) => { a.name = e.target.value; },
      onkeydown: (e) => { if (e.key === "Escape") cancelAdd(); }, // Enter submits the form
    });
    const typeSel = h("select", { id: "new-cat-type", "aria-label": "Category type", onchange: (e) => { a.type = e.target.value; } },
      Object.entries(CATEGORY_TYPES).map(([k, v]) => h("option", { value: k, selected: a.type === k }, v.label)));
    async function submit() {
      if (a.saving) return; // one save at a time, however fast the clicks
      a.saving = true;
      try {
        const cat = await createCategory(store, { name: a.name, type: a.type });
        state.adding = null;
        renderCategories();
        gridEl.querySelector("[data-focus-key=cat-add]")?.focus();
        toast(`Added ${cat.name}`);
      } catch (err) {
        if (err instanceof ValidationError) { a.error = err.message; renderCategories(); gridEl.querySelector("#new-cat-name")?.focus(); }
      } finally {
        a.saving = false;
      }
    }
    function cancelAdd() {
      state.adding = null;
      renderCategories();
      gridEl.querySelector("[data-focus-key=cat-add]")?.focus();
    }
    return h("form", { class: "cat cat-form", onsubmit: (e) => { e.preventDefault(); submit(); } },
      nameInput,
      h("div", { class: "type-row" }, typeSel, typeInfoButton("type-info-new")),
      a.error ? h("p", { class: "error-text small", role: "alert" }, a.error) : null,
      h("div", { class: "actions tight" },
        h("button", { type: "submit", class: "btn btn-primary btn-small" }, "Add"),
        h("button", { type: "button", class: "btn btn-small", onclick: cancelAdd }, "Cancel")));
  }

  function renderBox(c, count) {
    const open = state.openCat === c.id;
    const box = h("article", {
      class: `cat type-${c.type}${open ? " open" : ""}`, "data-id": c.id, role: "button", tabindex: "0",
      "aria-expanded": open ? "true" : "false", "aria-controls": open ? "cat-panel" : null, "data-focus-key": `cat-${c.id}`,
      "aria-label": `${c.name}, ${count ? plural(count, "transaction") : "no transactions yet"}. ${open ? "Close" : "Open"} to see what's inside.`,
      onclick: () => toggleOpen(c.id),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleOpen(c.id); } },
    },
      h("h3", { class: "cat-name" }, breakAfterSlash(c.name)),
      c.type !== "spending" ? h("span", { class: "cat-type" }, CATEGORY_TYPES[c.type].label) : null,
      c.frequency !== "regular" ? h("span", { class: "cat-freq" }, `Paid ${FREQUENCIES[c.frequency].label.toLowerCase()}`) : null,
      h("span", { class: "cat-count" }, count ? plural(count, "transaction") : "None yet"));
    makeItemDropTarget(box, c.id);
    return box;
  }

  async function saveCategory(id, changes, focusKey) {
    state.catErrors.delete(id); // before saving, so the redraw shows the finished state
    try {
      await updateCategory(store, id, changes);
    } catch (err) {
      if (err instanceof ValidationError) { state.catErrors.set(id, { message: err.message, draft: changes.name }); renderCategories(); }
    }
    if (focusKey) byFocusKey(gridEl, `${focusKey}`)?.focus();
  }

  async function moveCategory(id, delta) {
    const ids = sortedCategories(store).map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await reorderCategories(store, ids);
    byFocusKey(gridEl, `${delta < 0 ? "left" : "right"}-${id}`)?.focus();
  }

  function renderEditBox(c, index, total) {
    if (state.confirmDelete === c.id) {
      const n = countInCategoryAllYears(store, c.id);
      return h("article", { class: "cat cat-confirm", "data-id": c.id },
        h("p", {}, n ? `Delete ${c.name}? Its ${plural(n, "transaction")} (all years) go back to To Sort.` : `Delete ${c.name}?`),
        h("div", { class: "actions tight" },
          h("button", { type: "button", class: "btn btn-danger btn-small", "data-focus-key": `del-yes-${c.id}`, onclick: async () => {
            state.confirmDelete = null;
            const moved = await deleteCategory(store, c.id);
            toast(moved ? `Deleted ${c.name}. ${plural(moved, "transaction")} went back to To Sort.` : `Deleted ${c.name}`);
          } }, "Delete"),
          h("button", { type: "button", class: "btn btn-small", onclick: () => { state.confirmDelete = null; renderCategories(); byFocusKey(gridEl, `del-${c.id}`)?.focus(); } }, "Keep")));
    }
    const error = state.catErrors.get(c.id);
    const nameInput = h("input", {
      type: "text", class: "inline-input edit-name", value: error?.draft ?? c.name, maxlength: 40, "aria-label": `Name for ${c.name}`, "data-focus-key": `name-${c.id}`,
      "aria-invalid": error ? "true" : null,
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = c.name; e.target.blur(); } },
      onblur: (e) => {
        const value = e.target.value;
        if (value.replace(/\s+/g, " ").trim() !== c.name) { saveCategory(c.id, { name: value }); return; }
        if (error) { state.catErrors.delete(c.id); renderCategories(); } // back to the saved name
      },
    });
    const handle = h("span", {
      class: "drag-handle", draggable: "true", title: "Drag to reorder", "aria-hidden": "true",
      ondragstart: (e) => {
        drag = { kind: "cat", id: c.id };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.name);
        const box = elementOf(e.target)?.closest(".cat") || handle.closest(".cat");
        e.dataTransfer.setDragImage(box, 20, 20);
        box.classList.add("cat-dragging");
      },
    }, "⠇⠇");
    const box = h("article", { class: `cat editing type-${c.type}`, "data-id": c.id },
      h("div", { class: "edit-top" }, handle, nameInput),
      h("div", { class: "type-row" },
        h("select", { class: "inline-select", "aria-label": `Type for ${c.name}`, "data-focus-key": `type-${c.id}`, onchange: (e) => saveCategory(c.id, { type: e.target.value }, `type-${c.id}`) },
          Object.entries(CATEGORY_TYPES).map(([k, v]) => h("option", { value: k, selected: c.type === k }, v.label))),
        typeInfoButton(`type-info-${c.id}`)),
      h("select", { class: "inline-select", "aria-label": `How often ${c.name} is paid`, "data-focus-key": `freq-${c.id}`, onchange: (e) => saveCategory(c.id, { frequency: e.target.value }, `freq-${c.id}`) },
        Object.entries(FREQUENCIES).map(([k, v]) => h("option", { value: k, selected: c.frequency === k }, k === "regular" ? "Paid regularly" : `Paid ${v.label.toLowerCase()}`))),
      error ? h("p", { class: "error-text small", role: "alert" }, error.message) : null,
      h("div", { class: "edit-actions" },
        h("button", { type: "button", class: "btn btn-quiet btn-small", "aria-label": `Move ${c.name} earlier`, "data-focus-key": `left-${c.id}`, disabled: index === 0, onclick: () => moveCategory(c.id, -1) }, "←"),
        h("button", { type: "button", class: "btn btn-quiet btn-small", "aria-label": `Move ${c.name} later`, "data-focus-key": `right-${c.id}`, disabled: index === total - 1, onclick: () => moveCategory(c.id, 1) }, "→"),
        h("button", { type: "button", class: "btn btn-quiet btn-small del-btn", "data-focus-key": `del-${c.id}`, onclick: () => { state.confirmDelete = c.id; renderCategories(); byFocusKey(gridEl, `del-yes-${c.id}`)?.focus(); } }, "Delete")));
    box.style.setProperty("--wiggle-delay", `${(index % 5) * -0.07}s`);
    box.addEventListener("dragover", (e) => {
      if (drag?.kind !== "cat" || drag.id === c.id) return;
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      box.classList.toggle("drop-after", after);
      box.classList.toggle("drop-before", !after);
    });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("drop-before", "drop-after"); });
    box.addEventListener("drop", async (e) => {
      if (drag?.kind !== "cat" || drag.id === c.id) return;
      e.preventDefault();
      const after = box.classList.contains("drop-after");
      const moving = drag.id;
      endDrag();
      const ids = sortedCategories(store).map((x) => x.id).filter((id) => id !== moving);
      ids.splice(ids.indexOf(c.id) + (after ? 1 : 0), 0, moving);
      await reorderCategories(store, ids);
    });
    return box;
  }

  function toggleOpen(id) {
    if (state.editing) return;
    state.openCat = state.openCat === id ? null : id;
    state.panelSearch = "";
    state.panelSelected.clear();
    state.panelExpanded.clear();
    renderCategories();
    if (state.openCat) gridEl.querySelector("#cat-panel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function columnCount() {
    const cols = getComputedStyle(gridEl).gridTemplateColumns.split(" ").filter(Boolean).length;
    return Math.max(1, cols);
  }

  function renderCategories() {
    closeTypeInfo();
    const cats = sortedCategories(store);
    if (state.openCat && !store.get("categories", state.openCat)) state.openCat = null;
    const counts = categoryCounts(store, state.year || "all");
    $("cats-count").textContent = cats.length ? cats.length.toLocaleString("en-US") : "";
    gridEl.classList.toggle("dense", cats.length > 16);
    gridEl.classList.toggle("very-dense", cats.length > 28);
    gridEl.classList.toggle("editing", state.editing);
    editBtn.hidden = cats.length === 0;
    editBtn.textContent = state.editing ? "Done" : "Edit Categories";
    editBtn.classList.toggle("btn-primary", state.editing);
    editBtn.setAttribute("aria-pressed", state.editing ? "true" : "false");

    const nodes = cats.map((c, i) => (state.editing ? renderEditBox(c, i, cats.length) : renderBox(c, counts.get(c.id) || 0)));
    if (!state.editing) nodes.push(renderAddBox(cats.length === 0));
    gridEl.replaceChildren(...nodes);
    gridCols = columnCount();

    if (state.openCat && !state.editing) {
      const idx = cats.findIndex((c) => c.id === state.openCat);
      const rowEnd = Math.min(nodes.length - 1, Math.floor(idx / gridCols) * gridCols + gridCols - 1);
      const panel = renderPanel(cats[idx], counts.get(state.openCat) || 0);
      nodes[rowEnd].after(panel);
      placePanelArrow(panel, nodes[idx]);
      renderPanelList();
    }
    renderSuggestions(cats.length);
  }

  function renderSuggestions(catCount) {
    const remaining = remainingSuggestions(store);
    const hide = store.getSetting("hideSuggestions", false) || state.editing;
    sugEl.replaceChildren();
    sugEl.hidden = hide || !remaining.length;
    if (sugEl.hidden) return;
    add(sugEl,
      h("div", { class: "row-between" },
        h("h4", {}, "Suggestions"),
        catCount ? h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => store.setSetting("hideSuggestions", true) }, "Hide suggestions") : null),
      h("div", { class: "sug-grid" }, remaining.map((s) => h("div", { class: "sug" },
        h("span", { class: "sug-text" },
          h("span", { class: "sug-name" }, breakAfterSlash(s.name)),
          s.type !== "spending" ? h("span", { class: "cat-type" }, CATEGORY_TYPES[s.type].label) : null,
          s.frequency && s.frequency !== "regular" ? h("span", { class: "cat-type" }, FREQUENCIES[s.frequency].label) : null),
        h("button", { type: "button", class: "btn btn-small", "aria-label": `Add ${s.name}`, onclick: async (e) => {
          if (e.currentTarget.disabled) return;
          e.currentTarget.disabled = true;
          try { await createCategory(store, s); toast(`Added ${s.name}`); } catch (err) { if (err instanceof ValidationError) toast(err.message); }
        } }, "Add")))));
  }

  // ---------- Wiring ----------

  function renderAll() {
    withFocusKept(() => {
      renderYears();
      renderInbox();
      renderCategories();
    });
  }

  editBtn.addEventListener("click", () => {
    state.editing = !state.editing;
    state.openCat = null;
    state.confirmDelete = null;
    state.catErrors.clear();
    closeMoveMenu();
    renderCategories();
    if (state.editing) gridEl.querySelector(".edit-name")?.focus();
  });

  searchEl.addEventListener("input", () => { state.search = searchEl.value; renderInbox(); });
  sortEl.addEventListener("change", () => { state.sort = sortEl.value; renderInbox(); });

  new ResizeObserver(() => {
    if (state.openCat && columnCount() !== gridCols) renderCategories();
  }).observe(gridEl);

  store.addEventListener("change", (e) => {
    const { stores, keys } = e.detail;
    if (stores.includes("accounts") || stores.includes("imports") || keys?.transactions?.remove?.length || !keys) hintCtx = null;
    // New transactions change payment matching; category moves don't.
    if (keys?.transactions?.put?.some((id) => !known.has(id))) hintCtx = null;
    if (!keys || stores.some((s) => s === "vendors" || s === "accounts")) {
      barCache.clear();
    } else if (keys.transactions) {
      const touched = new Set([...keys.transactions.put, ...keys.transactions.remove]);
      for (const id of barCache.keys()) if (touched.has(parseItemId(id).txId)) barCache.delete(id);
    }
    // Saving the last-backup time doesn't change anything on this page.
    if (stores.length === 1 && stores[0] === "settings" && (state.renaming || state.splitting)) return;
    renderAll();
  });

  // Transactions that already existed at the last change, so new ones can be spotted.
  const known = new Set();
  const rememberKnown = () => { known.clear(); for (const t of store.list("transactions")) known.add(t.id); };
  store.addEventListener("change", rememberKnown);
  rememberKnown();

  renderAll();
  return { state, renderAll, shownItems: () => lastShown };
}
