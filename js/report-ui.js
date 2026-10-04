// The Report page: one table for a year, categories down the side and months
// across, with totals and monthly averages. Every number opens the transactions
// behind it, where "Move to…" fixes a mis-sorted one. Nothing is dragged here.

import { h, add, formatDate, plural } from "./dom.js";
import { CATEGORY_TYPES, FREQUENCIES, formatCents, ValidationError } from "./model.js";
import {
  buildReport, buildVendorReport, itemsBehind, reportYears, monthLabel, dollars, COUNTED_TYPES, NET_LABEL, NET_HELP,
} from "./report-data.js";
import { assignItems, updateCategory } from "./sorting-actions.js";
import { openMoveMenu, closeMoveMenu } from "./move-menu.js";

const VENDOR_TYPES = [["income", "Income"], ["giving", "Giving"], ["saving", "Savings"], ["spending", "Spending"]];
const VENDOR_PAGE = 60;

// Whole dollars for the table ("$1,234", "−$56"); the drill-down shows cents.
function cellText(cents) {
  const whole = Math.round(Math.abs(cents) / 100);
  return `${cents < 0 && whole ? "−" : ""}$${whole.toLocaleString("en-US")}`;
}

export function createReportUI({ store, toast, goTo }) {
  const root = document.getElementById("report-root");
  const state = {
    year: null,
    view: "category", // or "vendor"
    vendorType: "spending",
    vendorSearch: "",
    vendorLimit: VENDOR_PAGE,
    drill: null, // { filter, title, focusKey, flag }
  };
  let visible = false;
  let report = null;

  // ---------- Drill-down drawer ----------

  const drawer = h("aside", { class: "drill", id: "drill", role: "dialog", "aria-modal": "false", "aria-labelledby": "drill-title", hidden: true });
  document.body.append(drawer);
  // Escape closes the drawer from anywhere (after Undo, focus may be outside it),
  // except when it's closing a "Move to…" menu first.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || drawer.hidden || e.defaultPrevented || e.target.closest?.(".move-menu")) return;
    e.preventDefault();
    closeDrill();
  });

  function openDrill(drill) {
    state.drill = drill;
    renderDrill();
    drawer.querySelector("#drill-title")?.focus();
  }

  function closeDrill() {
    if (!state.drill) return;
    const key = state.drill.focusKey;
    state.drill = null;
    closeMoveMenu();
    drawer.hidden = true;
    root.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
  }

  async function move(ids, categoryId) {
    try {
      const { moved, undo } = await assignItems(store, ids, categoryId);
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

  function renderDrill() {
    const d = state.drill;
    if (!d) return;
    const items = itemsBehind(store, d.filter);
    const flag = d.flagId ? findFlag(d.flagId) : null;
    const mixed = !d.filter.categoryId && new Set(items.map((i) => i.cat?.id)).size > 1;
    const total = items.reduce((n, i) => n + i.part.amount, 0);
    drawer.replaceChildren();
    add(drawer,
      h("div", { class: "drill-head" },
        h("div", {},
          h("h3", { id: "drill-title", tabindex: "-1" }, d.title),
          h("p", { class: "muted small" }, items.length ? `${plural(items.length, "transaction")}, ${formatCents(total, { signed: true })} as the bank shows it` : "Nothing here now.")),
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: closeDrill, "aria-label": "Close" }, "Close")),
      flag ? h("div", { class: `drill-flag ${flag.kind}` },
        h("p", {}, flag.text),
        h("button", { type: "button", class: "btn btn-small", onclick: async () => {
          const dismissed = { ...(store.getSetting("dismissedFlags", {}) || {}) };
          dismissed[flag.id] = flag.value;
          d.flagId = null;
          await store.setSetting("dismissedFlags", dismissed);
          toast("Flag dismissed. It comes back only if this amount changes.");
        } }, "Dismiss flag")) : null,
      items.length ? h("ul", { class: "drill-list" }, items.map((item) => {
        const btn = h("button", {
          type: "button", class: "btn btn-small", "aria-haspopup": "listbox", "aria-expanded": "false",
          "aria-label": `Move ${item.name}, ${formatCents(item.part.amount, { signed: true })}, to another category`,
          onclick: (e) => openMoveMenu(e.currentTarget, { store, includeInbox: true, excludeId: item.cat?.id, onPick: (catId) => move([item.id], catId) }),
        }, "Move to…");
        const account = store.get("accounts", item.tx.accountId)?.name || "";
        const split = item.tx.parts.length > 1 ? `Part of a ${formatCents(item.tx.amount)} split` : "";
        const moved = item.tx.countsToward ? `Counts toward ${monthLabel(item.month)}` : "";
        return h("li", { class: "drill-row" },
          h("span", { class: "drill-date" }, formatDate(item.tx.postedDate, { short: true })),
          h("span", { class: "drill-main" },
            h("span", { class: "drill-name" }, item.name),
            h("span", { class: "muted small" }, [mixed && item.cat ? item.cat.name : "", account, split, moved].filter(Boolean).join(" · "))),
          h("span", { class: `drill-amount ${item.part.amount < 0 ? "out" : "in"}` }, formatCents(item.part.amount, { signed: true })),
          h("span", { class: "menu-anchor" }, btn));
      })) : h("p", { class: "drill-empty" }, "Everything that was here has moved."),
      h("p", { class: "muted small drill-note" }, "Move to… changes a transaction's category everywhere. The report updates right away."));
    drawer.hidden = false;
  }

  function findFlag(flagId) {
    for (const row of report?.rows.values() || []) for (const f of row.flags.values()) if (f.id === flagId) return f;
    return null;
  }

  // ---------- Pieces of the table ----------

  function cell(cents, count, { filter, title, focusKey, flag, cls = "", col = null, month = null } = {}) {
    if (!count) return h("td", { class: `num empty-cell ${cls}`, "data-col": col, "data-month": month }, h("span", { "aria-label": "None" }, "–"));
    const label = `${title}: ${dollars(cents)}, ${plural(count, "transaction")}${flag ? `. Flagged: ${flag.text}` : ""}`;
    return h("td", { class: `num ${cls}${flag ? " flagged" : ""}`, "data-flag": flag ? flag.id : null, "data-col": col, "data-month": month },
      h("button", {
        type: "button", class: "cell-btn", "data-focus-key": focusKey, "aria-label": label, title: flag ? flag.text : null,
        onclick: () => openDrill({ filter, title, focusKey, flagId: flag?.id }),
      }, cellText(cents), flag ? h("span", { class: `flag-dot ${flag.kind}`, "aria-hidden": "true" }) : null));
  }

  function avgCell(cents, { lumpy, cat, basis, cls = "", col = null } = {}) {
    if (!lumpy) return h("td", { class: `num avg ${cls}`, "data-col": col, "data-month": "avg" }, Math.round(cents / 100) ? cellText(cents) : h("span", { class: "muted" }, "–"));
    const f = FREQUENCIES[cat.frequency];
    const why = basis === "prior"
      ? `Paid ${f.label.toLowerCase()} and nothing paid yet in ${report.year}, so this spreads ${Number(report.year) - 1}'s payments across 12 months.`
      : `Paid ${f.label.toLowerCase()}, so this spreads a typical payment across 12 months instead of dividing by the months imported.`;
    return h("td", { class: `num avg ${cls}`, title: why, "data-col": col, "data-month": "avg" },
      h("span", { class: "spread-mark", "aria-hidden": "true" }, "≈ "), Math.round(cents / 100) ? cellText(cents) : "–",
      h("span", { class: "visually-hidden" }, `. ${why}`));
  }

  // Month labels, used in the table's header and again on every section's heading row.
  function monthHeads(cls) {
    return report.months.map((k) => {
      const info = report.monthInfo.get(k);
      const marked = info.partial || info.notes.length;
      const note = info.notes.join(". ");
      return h("th", { scope: "col", class: `num ${cls}${marked ? " partial" : ""}`, title: marked ? `${monthLabel(k)}: ${note || "partly imported"}.` : monthLabel(k) },
        monthLabel(k, "abbr"), marked ? h("span", { class: "partial-mark", "aria-hidden": "true" }, "*") : null,
        marked ? h("span", { class: "visually-hidden" }, ` (${note || "partly imported"})`) : null);
    });
  }
  const AVG_HELP = "Per month. Regular categories: the total ÷ months imported. Categories paid yearly, twice a year, or quarterly: a typical payment spread across 12 months.";

  function headRow(firstLabel) {
    return h("tr", {},
      h("th", { scope: "col", class: "name-col" }, firstLabel),
      monthHeads("month-col"),
      h("th", { scope: "col", class: "num total-col" }, "Total"),
      h("th", { scope: "col", class: "num avg-col", title: AVG_HELP }, "Avg / Month"));
  }

  let countCache = null;
  function itemsCount(type, month) {
    if (!countCache) {
      countCache = new Map();
      for (const row of report.rows.values()) {
        for (const [k, c] of row.cells) {
          for (const key of [`${row.cat.type}|${k}`, `${row.cat.type}|total`]) countCache.set(key, (countCache.get(key) || 0) + c.count);
        }
      }
    }
    return countCache.get(`${type}|${month}`) || 0;
  }

  // Shading: each category's months are tinted by how high they ran, compared with
  // that category's own other months, so spikes and dips show at a glance.
  function heatOf(values, v) {
    if (v <= 0) return null;
    const pos = values.filter((x) => x > 0);
    const lo = Math.min(...pos);
    const hi = Math.max(...pos);
    const t = hi === lo ? 0 : (v - lo) / (hi - lo);
    return (0.07 + 0.45 * t).toFixed(3);
  }

  // ---------- "How often is this paid?" from a column title ----------
  let freqMenu = null;
  function closeFreqMenu({ refocus = false } = {}) {
    if (!freqMenu) return;
    const { pop, btn, onOutside, onKey } = freqMenu;
    pop.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onFreqScroll, true);
    btn.setAttribute("aria-expanded", "false");
    freqMenu = null;
    if (refocus && btn.isConnected) btn.focus();
  }
  const onFreqScroll = () => closeFreqMenu();
  function openFreqMenu(btn, cat) {
    if (freqMenu?.btn === btn) { closeFreqMenu(); return; }
    closeFreqMenu();
    const choose = async (frequency) => {
      closeFreqMenu();
      if (frequency === cat.frequency) return;
      // Answering here also settles any "Is it paid once a year?" question about it.
      const asked = store.getSetting("frequencyAsked", []) || [];
      if (!asked.includes(cat.id)) await store.setSetting("frequencyAsked", [...asked, cat.id]);
      await updateCategory(store, cat.id, { frequency });
      toast(`${cat.name} is now marked as paid ${FREQUENCIES[frequency].label.toLowerCase()}`);
      root.querySelector(`[data-focus-key="freq-${CSS.escape(cat.id)}"]`)?.focus();
    };
    const pop = h("div", { class: "freq-menu", role: "dialog", "aria-label": `How often is ${cat.name} paid?`, tabindex: "-1" },
      h("p", { class: "freq-menu-title" }, `How often is ${cat.name} paid?`),
      h("div", { class: "freq-options" }, Object.entries(FREQUENCIES).map(([k, f]) => h("button", {
        type: "button", class: `freq-option${k === cat.frequency ? " current" : ""}`, "aria-pressed": k === cat.frequency ? "true" : "false",
        onclick: () => choose(k),
      }, k === "regular" ? "Regularly (most months)" : f.label))),
      h("p", { class: "freq-menu-note" }, "Yearly, twice-a-year, and quarterly costs are spread across 12 months in the average."));
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2));
    const below = r.bottom + 6 + pop.offsetHeight < window.innerHeight;
    pop.style.setProperty("left", `${left}px`);
    pop.style.setProperty("top", `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - pop.offsetHeight)}px`);
    const onOutside = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) closeFreqMenu(); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeFreqMenu({ refocus: true }); }
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onFreqScroll, true);
    btn.setAttribute("aria-expanded", "true");
    freqMenu = { pop, btn, onOutside, onKey };
    (pop.querySelector(".freq-option.current") || pop.querySelector(".freq-option")).focus();
  }

  // ---------- The category table: months down, like a spreadsheet ----------
  //
  // Columns: Month | Snapshot (Income, Giving, Savings, Spending, Net) |
  // Details (each category, grouped Income › Giving › Savings › Spending, then
  // Reimbursable and Not Included). Rows: each month, then Total and Avg / Month.
  function snapshotColumns() {
    const has = (type) => report.sections.some((x) => x.type === type);
    const cols = [{ key: "income", type: "income", label: "Income" }];
    if (has("giving")) cols.push({ key: "giving", type: "giving", label: "Giving" });
    if (has("saving")) cols.push({ key: "saving", type: "saving", label: "Savings" });
    cols.push({ key: "spending", type: "spending", label: "Spending" });
    cols.push({ key: "net", type: null, label: NET_LABEL, net: true });
    return cols.map((c) => ({ ...c, line: report.summary[c.key] }));
  }

  function categoryTable() {
    const snap = snapshotColumns();
    const details = report.sections.flatMap((section) => section.rows.map((row, i) => ({ row, section, first: i === 0 })));
    const anyCounted = (k) => COUNTED_TYPES.some((t) => itemsCount(t, k));

    const snapClass = (i) => `snap-col${i === snap.length - 1 ? " snap-last" : ""}`;
    const detClass = (d) => `det-col type-${d.section.type}${d.first ? " group-start" : ""}`;
    const snapHead = (c, i) => h("th", { scope: "col", class: `num col-name ${snapClass(i)}`, "data-snap": String(i), title: c.net ? NET_HELP : null }, c.label);

    // A category's column title. For money that counts, the title opens a small menu
    // to say how often it's paid, right here. Reimbursable shows what's still owed.
    function detailTitle(d) {
      const { cat } = d.row;
      const tag = cat.frequency !== "regular" ? h("span", { class: "freq-tag" }, FREQUENCIES[cat.frequency].label) : null;
      if (cat.type === "reimbursable") {
        const owed = d.row.owed || 0;
        return [h("span", { class: "row-name" }, cat.name),
          h("span", { class: "owed-note", title: "Everything spent minus everything repaid, across all years, as of today." },
            owed > 0 ? `Waiting on ${dollars(owed)}` : owed < 0 ? `Repaid ${dollars(-owed)} extra` : "Nothing waiting")];
      }
      if (!COUNTED_TYPES.includes(cat.type)) return h("span", { class: "row-name" }, cat.name);
      return h("button", {
        type: "button", class: "col-btn", "data-focus-key": `freq-${cat.id}`, "aria-haspopup": "dialog", "aria-expanded": "false",
        "aria-label": `${cat.name}: paid ${FREQUENCIES[cat.frequency].label.toLowerCase()}. Change how often it's paid`,
        title: "How often is this paid? Click to change",
        onclick: (e) => openFreqMenu(e.currentTarget, cat),
      }, h("span", { class: "row-name" }, cat.name), tag);
    }

    // Header: SNAPSHOT and DETAILS, then the detail groups, then column names.
    const groupHead = (section) => {
      let note = null;
      let title = null;
      if (section.type === "excluded") {
        title = "Left out of every total. Money out shows as positive; money coming back in subtracts. When both sides of a card payment or transfer are imported, they cancel to $0.";
      }
      return h("th", { scope: "colgroup", colspan: String(section.rows.length), class: `group-head type-${section.type}`, title },
        h("span", { class: "group-inner" }, h("span", { class: "group-label" }, section.label), note ? h("span", { class: "group-note" }, ` · ${note}`) : null));
    };
    const thead = h("thead", {},
      // One header row: SNAPSHOT, then each group of categories by type.
      h("tr", { class: "head-groups" },
        h("th", { scope: "col", class: "corner", rowspan: "2" }, "Month"),
        h("th", { scope: "colgroup", colspan: String(snap.length), class: "snap-band", "data-snap": "0" }, "Snapshot"),
        report.sections.map(groupHead)),
      h("tr", { class: "head-names" },
        snap.map(snapHead),
        details.map((d) => h("th", { scope: "col", class: `num col-name ${detClass(d)}` }, detailTitle(d)))));

    const snapCell = (c, i, k) => {
      const v = c.line.cells.get(k);
      if (c.net) {
        return h("td", { class: `num ${snapClass(i)}${v < 0 ? " short" : ""}`, "data-snap": String(i), "data-col": "sum:net", "data-month": k },
          anyCounted(k) ? cellText(v) : h("span", { class: "muted" }, "–"));
      }
      const td = cell(v, itemsCount(c.type, k), {
        filter: { year: report.year, month: k, type: c.type }, title: `${c.label}, ${monthLabel(k)}`,
        focusKey: `sum:${c.key}:${k}`, cls: snapClass(i), col: `sum:${c.key}`, month: k,
      });
      td.dataset.snap = String(i);
      return td;
    };
    const detCell = (d, k) => {
      const c = d.row.cells.get(k);
      const td = cell(c?.cents || 0, c?.count || 0, {
        filter: { year: report.year, month: k, categoryId: d.row.cat.id }, title: `${d.row.cat.name}, ${monthLabel(k)}`,
        focusKey: `cat:${d.row.cat.id}:${k}`, flag: d.row.flags.get(k), cls: detClass(d), col: d.row.cat.id, month: k,
      });
      if (COUNTED_TYPES.includes(d.section.type) && c?.count) {
        const values = report.months.map((m) => d.row.cells.get(m)?.cents || 0);
        const heat = heatOf(values, c.cents);
        if (heat) { td.classList.add("heat"); td.style.setProperty("--heat", heat); }
      }
      return td;
    };
    const monthHead = (k) => {
      const info = report.monthInfo.get(k);
      const marked = info.partial || info.notes.length;
      const note = info.notes.join(". ");
      return h("th", { scope: "row", class: `month-label${marked ? " partial" : ""}`, title: marked ? `${monthLabel(k)}: ${note || "partly imported"}.` : monthLabel(k) },
        monthLabel(k, "abbr"), marked ? h("span", { class: "partial-mark", "aria-hidden": "true" }, "*") : null,
        marked ? h("span", { class: "visually-hidden" }, ` (${note || "partly imported"})`) : null);
    };

    const body = h("tbody", {}, report.months.map((k) => h("tr", { class: "month-row", "data-month": k },
      monthHead(k), snap.map((c, i) => snapCell(c, i, k)), details.map((d) => detCell(d, k)))));

    const totalRow = h("tr", { class: "total-row" },
      h("th", { scope: "row", class: "month-label" }, "Total"),
      snap.map((c, i) => {
        if (c.net) return h("td", { class: `num ${snapClass(i)}${c.line.total < 0 ? " short" : ""}`, "data-snap": String(i), "data-col": "sum:net", "data-month": "total" }, cellText(c.line.total));
        const td = cell(c.line.total, itemsCount(c.type, "total"), {
          filter: { year: report.year, type: c.type }, title: `${c.label}, all of ${report.year}`,
          focusKey: `sum:${c.key}:total`, cls: snapClass(i), col: `sum:${c.key}`, month: "total",
        });
        td.dataset.snap = String(i);
        return td;
      }),
      details.map((d) => cell(d.row.total, d.row.count, {
        filter: { year: report.year, categoryId: d.row.cat.id }, title: `${d.row.cat.name}, all of ${report.year}`,
        focusKey: `cat:${d.row.cat.id}:total`, cls: detClass(d), col: d.row.cat.id, month: "total",
      })));
    const avgRow = h("tr", { class: "avg-row" },
      h("th", { scope: "row", class: "month-label", title: AVG_HELP }, "Avg / Mo"),
      snap.map((c, i) => {
        const td = h("td", { class: `num avg ${snapClass(i)}${c.line.average < 0 ? " short" : ""}`, "data-snap": String(i), "data-col": `sum:${c.key}`, "data-month": "avg",
          title: c.net ? "Average income − average giving, savings, and spending." : null }, cellText(c.line.average));
        return td;
      }),
      details.map((d) => avgCell(d.row.average, { lumpy: d.row.lumpy, cat: d.row.cat, basis: d.row.averageBasis, cls: detClass(d), col: d.row.cat.id })));

    const colgroup = h("colgroup", {},
      h("col", { class: "c-month" }), snap.map(() => h("col", { class: "c-snap" })), details.map(() => h("col", { class: "c-det" })));
    const table = h("table", { class: "report-table months-down", "aria-label": `${report.year} by month: snapshot and each category` },
      colgroup, thead, body, h("tfoot", {}, totalRow, avgRow));
    table.style.setProperty("--snap-count", String(snap.length));
    table.style.setProperty("--detail-count", String(details.length));
    return table;
  }

  // The month and Snapshot columns stay put while the details scroll sideways.
  function pinSnapshot(table) {
    const heads = [...table.querySelectorAll("thead .head-names th[data-snap]")];
    const month = table.querySelector("thead .corner");
    if (!heads.length || !month) return;
    let left = month.offsetWidth;
    heads.forEach((th, i) => {
      table.style.setProperty(`--pin-${i}`, `${left}px`);
      left += th.offsetWidth;
    });
    // Detail group labels slide along just right of the pinned columns.
    table.style.setProperty("--pin-end", `${left}px`);
  }

  // ---------- Notices ----------

  function notices() {
    const box = h("div", { class: "report-notices" });
    const u = report.unsorted;
    if (u.count) {
      add(box, h("div", { class: "notice warn" },
        h("p", {}, `${plural(u.count, "transaction")} from ${report.year} ${u.count === 1 ? "isn't" : "aren't"} sorted yet, so ${u.count === 1 ? "it's" : "they're"} left out of these numbers (${dollars(u.out)} out, ${dollars(u.in)} in).`),
        h("button", { type: "button", class: "btn btn-small", onclick: () => goTo("transactions") }, "Sort them")));
    }
    for (const s of report.suggestions) {
      const answer = async (frequency) => {
        const asked = [...(store.getSetting("frequencyAsked", []) || []), s.cat.id];
        await store.setSetting("frequencyAsked", asked);
        if (frequency) {
          await updateCategory(store, s.cat.id, { frequency });
          toast(`${s.cat.name} is now marked as paid ${FREQUENCIES[frequency].label.toLowerCase()}`);
        }
      };
      add(box, h("div", { class: "notice ask" },
        h("p", {}, s.text),
        h("div", { class: "actions tight" },
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => answer(s.frequency) }, `Yes, ${FREQUENCIES[s.frequency].label.toLowerCase()}`),
          h("button", { type: "button", class: "btn btn-small", onclick: () => answer(null) }, "No, it's regular"))));
    }
    return box.children.length ? box : null;
  }

  // ---------- Views ----------

  function vendorTable() {
    const all = buildVendorReport(store, report.year, state.vendorType, report.monthsCovered);
    const terms = state.vendorSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = all.filter((r) => terms.every((t) => r.name.toLowerCase().includes(t)));
    const label = VENDOR_TYPES.find(([k]) => k === state.vendorType)[1];
    const wrap = h("div", { class: "vendor-view" });
    if (!all.length) {
      add(wrap, h("p", { class: "report-empty" }, `Nothing is sorted into ${label} categories for ${report.year} yet.`));
      return wrap;
    }
    const table = h("table", { class: "report-table vendor-table", "aria-label": `${label} by vendor for ${report.year}` },
      h("thead", {}, headRow("Vendor")),
      h("tbody", {}, shown.slice(0, state.vendorLimit).map((row) => h("tr", {},
        h("th", { scope: "row", class: "name-col" }, h("span", { class: "row-name" }, row.name)),
        report.months.map((k) => {
          const c = row.cells.get(k);
          return cell(c?.cents || 0, c?.count || 0, {
            filter: { year: report.year, month: k, vendor: row.name, vendorType: state.vendorType },
            title: `${row.name}, ${monthLabel(k)}`, focusKey: `ven:${row.name}:${k}`,
          });
        }),
        cell(row.total, row.count, { filter: { year: report.year, vendor: row.name, vendorType: state.vendorType }, title: `${row.name}, all of ${report.year}`, focusKey: `ven:${row.name}:total`, cls: "total" }),
        h("td", { class: "num avg" }, cellText(row.average))))));
    add(wrap, shown.length ? h("div", { class: "table-scroll" }, table) : h("p", { class: "report-empty" }, `No vendor matches “${state.vendorSearch}”.`));
    if (shown.length > state.vendorLimit) {
      add(wrap, h("button", { type: "button", class: "btn btn-small show-more", onclick: () => { state.vendorLimit = Infinity; render(); } }, `Show all ${shown.length} vendors`));
    }
    return wrap;
  }

  function controls(years) {
    const yearTabs = h("div", { class: "year-tabs", role: "tablist", "aria-label": "Year" }, years.map((y) => h("button", {
      type: "button", role: "tab", class: `year-tab${y === state.year ? " active" : ""}`, "aria-selected": y === state.year ? "true" : "false", "data-focus-key": `ryear-${y}`,
      onclick: () => { state.year = y; state.vendorLimit = VENDOR_PAGE; closeDrill(); render(); },
    }, y)));
    const viewSwitch = h("div", { class: "page-switch view-switch", role: "group", "aria-label": "Show the table" },
      [["category", "By Category"], ["vendor", "By Vendor"]].map(([k, label]) => h("button", {
        type: "button", class: "seg-btn", "aria-pressed": state.view === k ? "true" : "false", "data-focus-key": `view-${k}`,
        onclick: () => { state.view = k; closeDrill(); render(); },
      }, label)));
    const bar = h("div", { class: "report-controls" }, h("h2", {}, "Report"), viewSwitch, yearTabs);
    if (state.view === "vendor") {
      add(bar, h("div", { class: "vendor-tools" },
        h("div", { class: "page-switch type-switch", role: "group", "aria-label": "Which money" }, VENDOR_TYPES.map(([k, label]) => h("button", {
          type: "button", class: "seg-btn", "aria-pressed": state.vendorType === k ? "true" : "false", "data-focus-key": `vtype-${k}`,
          onclick: () => { state.vendorType = k; state.vendorLimit = VENDOR_PAGE; closeDrill(); render(); },
        }, label))),
        h("input", {
          type: "search", class: "vendor-search", placeholder: "Find a vendor", value: state.vendorSearch, "aria-label": "Find a vendor", "data-focus-key": "vendor-search",
          oninput: (e) => { state.vendorSearch = e.target.value; render(); },
        })));
    }
    return bar;
  }

  function legend() {
    const bits = [];
    if ([...report.monthInfo.values()].some((i) => i.partial || i.notes.length)) bits.push(h("span", {}, h("span", { class: "partial-mark" }, "*"), " Month with missing data. Hover the month to see what's missing"));
    if (state.view === "category") bits.push(h("span", {}, h("span", { class: "heat-swatch", "aria-hidden": "true" }), " Darker gold: a higher month for that category"));
    if (state.view === "category" && report.hasLumpy) bits.push(h("span", {}, h("span", { class: "spread-mark" }, "≈"), " Average spreads a yearly, twice-a-year, or quarterly payment across 12 months"));
    if (state.view === "category" && [...report.rows.values()].some((r) => r.flags.size)) bits.push(h("span", {}, h("span", { class: "flag-dot high legend-dot" }), " Far from that category's usual month. Click it to see why"));
    const covered = Math.round(report.monthsCovered * 10) / 10;
    bits.push(h("span", {}, `Whole dollars. Averages cover the ${covered === 1 ? "1 month" : `${covered.toLocaleString("en-US")} months`} with imported data.`));
    return h("p", { class: "report-legend" }, bits);
  }

  // ---------- Render ----------

  function render() {
    if (!visible) return;
    closeFreqMenu();
    countCache = null;
    const active = document.activeElement;
    const focusKey = root.contains(active) ? active.dataset.focusKey : null;
    const caret = focusKey && "selectionStart" in active ? active.selectionStart : null;
    const scroller = root.querySelector(".table-scroll");
    const scroll = scroller ? [scroller.scrollLeft, scroller.scrollTop] : null;

    const years = reportYears(store);
    root.replaceChildren();
    if (!years.length) {
      report = null;
      add(root, h("section", { class: "panel report-start" },
        h("h2", {}, "Report"),
        h("p", { class: "lede" }, "Once you've imported bank files and sorted some transactions, this page shows each category by month, with totals and monthly averages."),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => goTo("transactions") }, "Go to Transactions"))));
      drawer.hidden = true;
      state.drill = null;
      return;
    }
    if (!years.includes(state.year)) state.year = years[0];
    report = buildReport(store, state.year);

    add(root, controls(years), notices());
    if (state.view === "category") {
      if (![...report.rows.values()].some((r) => r.count)) {
        add(root, h("p", { class: "report-empty" }, `Nothing from ${report.year} is sorted yet. Sort some transactions into categories on the Transactions page, and their totals appear here.`));
      } else {
        add(root, h("div", { class: "table-scroll" }, categoryTable()));
      }
    } else {
      add(root, vendorTable());
    }
    add(root, legend());

    const newScroller = root.querySelector(".table-scroll");
    const grid = root.querySelector(".months-down");
    if (grid) { pinSnapshot(grid); resizeWatch.observe(newScroller); }
    if (scroll && newScroller) [newScroller.scrollLeft, newScroller.scrollTop] = scroll;
    if (focusKey) {
      const el = root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      el?.focus({ preventScroll: true });
      if (el && caret !== null) { try { el.setSelectionRange(caret, caret); } catch { /* not text */ } }
    }
    if (state.drill) renderDrill();
  }

  const resizeWatch = new ResizeObserver(() => {
    const grid = root.querySelector(".months-down");
    if (grid) pinSnapshot(grid);
  });

  // Settings the report reads; others (like the last-backup time) don't change it.
  const REPORT_SETTINGS = new Set(["dismissedFlags", "frequencyAsked", "categoryOrder"]);
  store.addEventListener("change", (e) => {
    const { stores, keys } = e.detail || {};
    const onlySettings = stores?.length === 1 && stores[0] === "settings" && keys?.settings;
    if (onlySettings && !keys.settings.put.some((k) => REPORT_SETTINGS.has(k))) return;
    render();
  });

  return {
    show() { visible = true; render(); },
    hide() { visible = false; closeDrill(); },
    state,
    get report() { return report; },
  };
}
