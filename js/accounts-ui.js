// The accounts list: editable names, transaction counts, import history, removal.

import { h, add, formatDate, formatRange, plural, KIND_LABELS } from "./dom.js";
import { renameAccount, removeAccount } from "./importer.js";
import { ValidationError } from "./model.js";

export function createAccountsUI({ store, root, toast, banner }) {
  const list = root.querySelector("#accounts-list");
  const manage = root.querySelector("#accounts-manage");
  const toggle = root.querySelector("#manage-toggle");
  const chips = root.querySelector("#account-chips");
  const openHistory = new Set();
  let confirmRemove = null;

  function setOpen(open) {
    manage.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.textContent = open ? "Hide accounts" : "Manage accounts";
  }
  toggle.addEventListener("click", () => setOpen(manage.hidden));

  function renderChips(accounts) {
    chips.replaceChildren();
    for (const a of accounts) {
      const n = store.list("transactions").filter((t) => t.accountId === a.id).length;
      add(chips, h("button", { type: "button", class: "chip", title: "Manage accounts", onclick: () => setOpen(true) },
        h("span", { class: "chip-name" }, a.name), h("span", { class: "chip-count" }, n.toLocaleString("en-US"))));
    }
  }

  function stats(accountId) {
    let count = 0;
    let first = null;
    let last = null;
    for (const t of store.list("transactions")) {
      if (t.accountId !== accountId) continue;
      count++;
      if (!first || t.postedDate < first) first = t.postedDate;
      if (!last || t.postedDate > last) last = t.postedDate;
    }
    return { count, first, last };
  }

  async function saveName(account, input) {
    try {
      await renameAccount(store, account.id, input.value);
      input.classList.remove("invalid");
    } catch (err) {
      if (err instanceof ValidationError) {
        banner("account-name", "alert", err.message);
        input.value = account.name;
      }
    }
  }

  function render() {
    list.replaceChildren();
    const accounts = store.list("accounts").sort((a, b) => a.order - b.order);
    renderChips(accounts);
    toggle.hidden = accounts.length === 0;
    root.querySelector("#accounts-head").hidden = accounts.length === 0;
    if (!accounts.length) setOpen(false);
    for (const account of accounts) {
      const s = stats(account.id);
      const imports = store.list("imports").filter((i) => i.accountId === account.id).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
      const nameInput = h("input", {
        type: "text", class: "account-name", value: account.name, "aria-label": `Name for ${account.name}`, id: `acct-${account.id}`,
        onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = account.name; e.target.blur(); } },
        onblur: (e) => saveName(account, e.target),
      });
      const card = h("article", { class: "account" },
        h("div", { class: "account-top" },
          nameInput,
          h("span", { class: "kind" }, KIND_LABELS[account.kind] || "Account")),
        h("p", { class: "account-meta" }, s.count ? `${plural(s.count, "transaction")} · ${formatRange(s.first, s.last)}` : "No transactions"),
        h("div", { class: "account-actions" },
          h("button", { type: "button", class: "btn btn-quiet btn-small", "aria-expanded": openHistory.has(account.id), onclick: () => {
            if (openHistory.has(account.id)) openHistory.delete(account.id); else openHistory.add(account.id);
            render();
          } }, openHistory.has(account.id) ? "Hide history" : `Import history (${imports.length})`),
          h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { confirmRemove = account.id; render(); } }, "Remove")),
      );
      if (openHistory.has(account.id)) {
        card.append(h("ul", { class: "history" }, imports.map((i) => {
          const bits = [`${i.added.toLocaleString("en-US")} added`];
          if (i.skipped) bits.push(`${i.skipped.toLocaleString("en-US")} already here`);
          if (i.pending) bits.push(`${i.pending} pending skipped`);
          return h("li", {},
            h("strong", {}, i.fileName),
            h("span", { class: "muted" }, ` · added ${formatDate(i.importedAt.slice(0, 10))} · ${formatRange(i.firstDate, i.lastDate)}`),
            h("div", { class: "muted small" }, bits.join(" · ")));
        })));
      }
      if (confirmRemove === account.id) {
        card.append(h("div", { class: "confirm" },
          h("p", {}, `Remove ${account.name} and its ${plural(s.count, "transaction")}? Any sorting you've done for them goes too. This can't be undone unless you have a backup.`),
          h("div", { class: "actions" },
            h("button", { type: "button", class: "btn btn-danger btn-small", onclick: async () => {
              confirmRemove = null;
              const n = await removeAccount(store, account.id);
              toast(`Removed ${account.name} and ${plural(n, "transaction")}`);
            } }, "Remove account"),
            h("button", { type: "button", class: "btn btn-small", onclick: () => { confirmRemove = null; render(); } }, "Cancel"))));
      }
      list.append(card);
    }
  }

  store.addEventListener("change", () => {
    // Don't redraw while someone is typing an account name.
    if (document.activeElement?.classList?.contains("account-name")) return;
    render();
  });
  render();
  return { render };
}
