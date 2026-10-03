// The import area: choose or drop CSV files, review each one, pick its account,
// and see what was added. Also the review list for possible duplicates.

import { h, add, formatDate, formatRange, plural, KIND_LABELS } from "./dom.js";
import { analyzeFile, rebuild, previewPlan, commitImport, suggestAccount, possibleDuplicates, keepBoth, removeDuplicate } from "./importer.js";
import { formatCents, ValidationError, vendorDisplayName } from "./model.js";

const FIELD_LABELS = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  debit: "Money out (debit)",
  credit: "Money in (credit)",
  checkNumber: "Check number",
  status: "Status",
};

export function createImportUI({ store, root, toast, banner, restoreFile }) {
  const queue = [];
  let current = null; // { analysis, choice: { accountId, newName }, showColumns, error }
  let result = null;
  let busy = false;

  const zone = root.querySelector("#import-zone");
  const input = root.querySelector("#import-input");
  const reviewBox = root.querySelector("#import-review");
  const resultBox = root.querySelector("#import-result");
  const dupBox = root.querySelector("#dup-review");

  // The whole drop area opens the file chooser; the "choose files" link is the keyboard way in.
  zone.addEventListener("click", () => input.click());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("change", () => {
    addFiles([...input.files]);
    input.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragging");
    addFiles([...(e.dataTransfer?.files || [])]);
  });

  function addFiles(files) {
    // A backup dropped here is meant to be restored, not imported.
    const backups = files.filter((f) => /\.xlsx$/i.test(f.name) || /^expense-tracker-backup.*\.json$/i.test(f.name));
    if (backups.length && restoreFile) restoreFile(backups[0]);
    files = files.filter((f) => !backups.includes(f));
    if (!files.length) return;
    queue.push(...files);
    if (!current && !busy) next();
    else render();
  }

  async function next() {
    current = null;
    const file = queue.shift();
    if (!file) { render(); return; }
    busy = true;
    render();
    try {
      const analysis = await analyzeFile(file, store);
      current = {
        analysis,
        choice: { accountId: analysis.suggestion.accountId, newName: analysis.suggestion.newName },
        showColumns: !analysis.layout.recognized,
        error: "",
      };
    } catch (err) {
      banner("import", "alert", err instanceof ValidationError ? err.message : `${file.name} couldn't be read. Make sure it's a CSV file downloaded from your bank.`);
      busy = false;
      next();
      return;
    }
    busy = false;
    render();
    reviewBox.querySelector("button.btn-primary")?.focus();
  }

  function cancel() {
    current = null;
    next();
  }

  async function confirm() {
    const { analysis, choice } = current;
    busy = true;
    render();
    try {
      result = await commitImport(analysis, { accountId: choice.accountId, newAccountName: choice.newName }, store);
      busy = false;
      next();
    } catch (err) {
      busy = false;
      if (err instanceof ValidationError) current.error = err.message;
      render();
    }
  }

  // ---------- Review panel ----------

  function columnSelect(field) {
    const a = current.analysis;
    const header = a.layout.header;
    const sampleRow = a.rawRows[a.layout.hasHeader ? a.layout.headerRow + 1 : 0] || [];
    const width = Math.max(...a.rawRows.slice(0, 10).map((r) => r.length));
    const sel = h("select", { id: `col-${field}`, onchange: (e) => setColumn(field, e.target.value) },
      h("option", { value: "" }, field === "date" || field === "description" ? "Choose a column" : "Not in this file"));
    for (let i = 0; i < width; i++) {
      const name = header ? header[i] || `Column ${i + 1}` : `Column ${i + 1}`;
      const sample = (sampleRow[i] || "").slice(0, 28);
      sel.append(h("option", { value: i, selected: a.layout.columns[field] === i }, sample ? `${name} (${sample})` : name));
    }
    return h("label", { class: "field" }, h("span", {}, FIELD_LABELS[field]), sel);
  }

  function setColumn(field, value) {
    const cols = { ...current.analysis.layout.columns };
    if (value === "") delete cols[field];
    else cols[field] = Number(value);
    if (field === "amount" && value !== "") { delete cols.debit; delete cols.credit; }
    if ((field === "debit" || field === "credit") && value !== "") delete cols.amount;
    rebuild(current.analysis, { columns: cols });
    current.analysis.suggestion = suggestAccount(current.analysis, store);
    render();
  }

  function setFlip(flip) {
    rebuild(current.analysis, { flip });
    render();
  }

  function renderReview() {
    reviewBox.replaceChildren();
    if (busy && !current) {
      reviewBox.hidden = false;
      add(reviewBox, h("p", { class: "lede" }, "Reading the file…"));
      return;
    }
    if (!current) { reviewBox.hidden = true; return; }
    reviewBox.hidden = false;
    const a = current.analysis;
    const records = a.records;
    const recognized = a.layout.recognized && records.length > 0;

    const facts = [];
    if (recognized) {
      facts.push(plural(records.length, "transaction"));
      facts.push(formatRange(a.firstDate, a.lastDate));
      if (a.kind !== "unknown") facts.push(`looks like a ${KIND_LABELS[a.kind].toLowerCase()} account`);
    }
    add(reviewBox, 
      h("div", { class: "review-head" },
        h("h3", {}, `Adding ${a.fileName}`),
        queue.length ? h("span", { class: "queue-note" }, `${plural(queue.length, "more file")} after this one`) : null),
      recognized ? h("p", { class: "facts" }, facts.join(" · ")) : h("p", { class: "facts warn-text" }, "The app couldn't tell which columns hold the date, description, and amount. Choose them below."),
    );

    const notes = [];
    if (a.pending) notes.push(`${plural(a.pending, "pending transaction")} skipped. They'll come in once your bank posts them.`);
    if (a.unreadable.length) notes.push(`${plural(a.unreadable.length, "line")} couldn't be read and will be left out (usually balance or summary lines).`);
    if (notes.length) add(reviewBox, h("ul", { class: "notes" }, notes.map((n) => h("li", {}, n))));
    if (a.unreadable.length) {
      add(reviewBox, h("details", { class: "unreadable" },
        h("summary", {}, "Show lines left out"),
        h("ul", {}, a.unreadable.slice(0, 12).map((u) => h("li", {}, `Line ${u.line}: ${u.text}`)))));
    }

    // Columns
    const colToggle = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { current.showColumns = !current.showColumns; render(); } },
      current.showColumns ? "Hide columns" : "Change columns");
    add(reviewBox, h("div", { class: "row-between" }, h("h4", {}, "Columns"), recognized ? colToggle : null));
    if (current.showColumns) {
      const usesSplit = "debit" in a.layout.columns || "credit" in a.layout.columns;
      add(reviewBox, h("div", { class: "columns-grid" },
        columnSelect("date"), columnSelect("description"),
        usesSplit ? [columnSelect("debit"), columnSelect("credit")] : columnSelect("amount"),
        columnSelect("checkNumber"), columnSelect("status")),
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => {
          const cols = { ...a.layout.columns };
          if (usesSplit) { delete cols.debit; delete cols.credit; } else { delete cols.amount; }
          rebuild(a, { columns: cols });
          render();
        } }, usesSplit ? "This file has one amount column" : "This file has separate money-in and money-out columns"));
    } else if (recognized) {
      const c = a.layout.columns;
      const names = Object.keys(c).map((f) => FIELD_LABELS[f]);
      add(reviewBox, h("p", { class: "lede small" }, `Found ${names.join(", ")}.`));
    }

    if (!recognized) {
      add(reviewBox, h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: cancel }, "Cancel")));
      return;
    }

    // Preview and signs
    const sample = records.slice(0, 6);
    const showLoc = sample.some((r) => r.location);
    add(reviewBox, 
      h("h4", {}, "How they'll look"),
      h("div", { class: "table-wrap" }, h("table", { class: "preview" },
        h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Vendor"), showLoc ? h("th", {}, "Location") : null, h("th", { class: "num" }, "Amount"))),
        h("tbody", {}, sample.map((r) => h("tr", {},
          h("td", {}, formatDate(r.postedDate, { short: true })),
          h("td", {}, r.cleanName, r.memo ? h("span", { class: "memo" }, ` · ${r.memo}`) : null),
          showLoc ? h("td", { class: "muted" }, r.location) : null,
          h("td", { class: `num ${r.amount < 0 ? "out" : "in"}` }, formatCents(r.amount, { signed: true }))))))),
      h("label", { class: "check" },
        h("input", { type: "checkbox", id: "flip-signs", checked: a.flip, onchange: (e) => setFlip(e.target.checked) }),
        h("span", {}, "This file shows purchases as positive numbers. Flip the signs so money out is negative."),
      ),
      a.flipSuggested ? h("p", { class: "lede small" }, "Turned on because card payments in this file are negative while purchases are positive.") : null,
    );

    // Account choice
    const accounts = store.list("accounts").sort((x, y) => x.order - y.order);
    const choice = current.choice;
    const radios = accounts.map((acc) => {
      const suggested = a.suggestion.accountId === acc.id;
      return h("label", { class: `choice${choice.accountId === acc.id ? " chosen" : ""}` },
        h("input", { type: "radio", name: "import-account", value: acc.id, checked: choice.accountId === acc.id, onchange: () => { choice.accountId = acc.id; current.error = ""; render(); } }),
        h("span", { class: "choice-text" },
          h("strong", {}, acc.name),
          suggested && a.suggestion.reason ? h("span", { class: "suggest" }, `Suggested: ${a.suggestion.reason}`) : null));
    });
    const newRadio = h("label", { class: `choice${!choice.accountId ? " chosen" : ""}` },
      h("input", { type: "radio", name: "import-account", value: "", checked: !choice.accountId, onchange: () => { choice.accountId = null; render(); reviewBox.querySelector("#new-account-name")?.focus(); } }),
      h("span", { class: "choice-text" },
        h("strong", {}, "A new account"),
        h("input", { type: "text", id: "new-account-name", class: "inline-input", placeholder: "Wells Fargo Checking", value: choice.newName, "aria-label": "New account name",
          onfocus: () => { if (choice.accountId) { choice.accountId = null; render(); reviewBox.querySelector("#new-account-name")?.focus(); } },
          oninput: (e) => { choice.newName = e.target.value; current.error = ""; } })));
    add(reviewBox, h("h4", {}, "Which account is this from?"), h("div", { class: "choices" }, radios, newRadio));

    const plan = previewPlan(a, choice.accountId, store);
    const planBits = [`${plural(plan.toAdd.length, "new transaction")}`];
    if (plan.skipped) planBits.push(`${plan.skipped.toLocaleString("en-US")} already here`);
    if (plan.possible.size) planBits.push(`${plural(plan.possible.size, "possible duplicate")} to review`);
    add(reviewBox, h("p", { class: "plan" }, planBits.join(" · ")));
    if (current.error) add(reviewBox, h("p", { class: "error-text", role: "alert" }, current.error));

    const label = plan.toAdd.length ? `Add ${plural(plan.toAdd.length, "transaction")}` : "Nothing new to add";
    add(reviewBox, h("div", { class: "actions" },
      h("button", { type: "button", class: "btn btn-primary", disabled: busy || !plan.toAdd.length, onclick: confirm }, busy ? "Adding…" : label),
      h("button", { type: "button", class: "btn", disabled: busy, onclick: cancel }, "Cancel")));
  }

  // ---------- Result ----------

  function renderResult() {
    resultBox.replaceChildren();
    if (!result) { resultBox.hidden = true; return; }
    resultBox.hidden = false;
    const r = result;
    const lines = [];
    if (r.skipped) lines.push(`${plural(r.skipped, "transaction")} ${r.skipped === 1 ? "was" : "were"} already here, and your sorting was kept.`);
    if (r.possible) lines.push(`${plural(r.possible, "possible duplicate")} to review below.`);
    if (r.paired) lines.push(`${plural(r.paired, "payment or transfer", "payments and transfers")} matched a transaction in another account.`);
    if (r.unmatchedPayments) lines.push(`${plural(r.unmatchedPayments, "card payment")} had no match. If you pay other cards from this account, importing them will show where that money went.`);
    if (r.pending) lines.push(`${plural(r.pending, "pending transaction")} skipped.`);
    if (r.unreadable) lines.push(`${plural(r.unreadable, "line")} left out because they weren't transactions.`);
    const vendors = (t) => vendorDisplayName(store.get("vendors", t.vendorKey), t);
    add(resultBox, 
      h("div", { class: "row-between" },
        h("h3", {}, `Added ${plural(r.added, "transaction")} to ${r.accountName}`),
        h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { result = null; render(); } }, "Dismiss")),
      lines.length ? h("ul", { class: "notes" }, lines.map((l) => h("li", {}, l))) : null,
      r.sample.length ? h("p", { class: "lede small" }, "A few of them: ", [...new Set(r.sample.map((t) => vendors(t)))].slice(0, 6).join(", "), ".") : null,
    );
  }

  // ---------- Possible duplicates ----------

  function renderDuplicates() {
    dupBox.replaceChildren();
    const list = possibleDuplicates(store);
    if (!list.length) { dupBox.hidden = true; return; }
    dupBox.hidden = false;
    const name = (t) => vendorDisplayName(store.get("vendors", t.vendorKey), t);
    add(dupBox, 
      h("h3", {}, `Possible Duplicates (${list.length})`),
      h("p", { class: "lede small" }, "Banks sometimes change a charge's description or date when it posts. Each new transaction below looks like one you already had."),
      h("ul", { class: "dup-list" }, list.slice(0, 50).map(({ tx, original }) => h("li", {},
        h("div", { class: "dup-pair" },
          h("div", {}, h("span", { class: "tag" }, "New"), ` ${formatDate(tx.postedDate, { short: true })} · ${name(tx)} · ${formatCents(tx.amount, { signed: true })}`, h("div", { class: "muted small" }, tx.description)),
          h("div", {}, h("span", { class: "tag" }, "Saved"), ` ${formatDate(original.postedDate, { short: true })} · ${name(original)} · ${formatCents(original.amount, { signed: true })}`, h("div", { class: "muted small" }, original.description))),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn btn-small", onclick: () => keepBoth(store, tx.id).then(() => toast("Kept both")) }, "Keep both"),
          h("button", { type: "button", class: "btn btn-small", onclick: () => removeDuplicate(store, tx.id).then(() => toast("Removed the new copy")) }, "Remove the new one"))))),
    );
  }

  function render() {
    zone.classList.toggle("compact", store.count("accounts") > 0);
    renderReview();
    renderResult();
    renderDuplicates();
  }

  store.addEventListener("change", () => { if (!current) render(); else renderDuplicates(); });
  render();
  return { addFiles, render };
}
