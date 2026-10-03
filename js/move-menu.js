// "Move to…" popover: type to filter categories, arrow keys to choose, Enter to move.
// Categories are listed in the same order as the boxes.

import { h, add } from "./dom.js";
import { CATEGORY_TYPES } from "./model.js";
import { sortedCategories } from "./categories.js";

let openMenu = null;

export function closeMoveMenu() {
  if (!openMenu) return;
  const { el, anchor, onOutside } = openMenu;
  el.remove();
  document.removeEventListener("pointerdown", onOutside, true);
  anchor.setAttribute("aria-expanded", "false");
  openMenu = null;
}

// anchor: the button that opened it. options: { store, includeInbox, excludeId, onPick(categoryId|null) }
export function openMoveMenu(anchor, { store, includeInbox = false, excludeId = null, onPick }) {
  if (openMenu?.anchor === anchor) { closeMoveMenu(); return; }
  closeMoveMenu();
  const cats = sortedCategories(store).filter((c) => c.id !== excludeId);
  const listId = `move-list-${Math.random().toString(36).slice(2, 8)}`;
  let active = 0;
  let shown = [];

  const input = h("input", {
    type: "text", class: "move-filter", placeholder: "Type to find a category", "aria-label": "Find a category",
    role: "combobox", "aria-expanded": "true", "aria-controls": listId, autocomplete: "off",
  });
  const list = h("div", { class: "move-list", role: "listbox", id: listId });
  const el = h("div", { class: "move-menu" }, input, list);

  function options() {
    const q = input.value.trim().toLowerCase();
    const out = [];
    if (includeInbox && (!q || "to sort".includes(q) || "back to to sort".includes(q))) out.push({ id: null, name: "Back to To Sort", inbox: true });
    for (const c of cats) if (!q || c.name.toLowerCase().includes(q)) out.push(c);
    return out;
  }

  function render() {
    shown = options();
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    list.replaceChildren();
    if (!shown.length) {
      add(list, h("p", { class: "move-empty" }, cats.length ? "No category matches." : "Create a category first, with the + box."));
      input.removeAttribute("aria-activedescendant");
      return;
    }
    shown.forEach((c, i) => {
      add(list, h("div", {
        role: "option", id: `${listId}-${i}`, class: `move-opt${i === active ? " active" : ""}${c.inbox ? " inbox" : ""}`,
        "aria-selected": i === active ? "true" : "false",
        onpointerdown: (e) => e.preventDefault(), // keep focus in the filter box
        onclick: () => pick(c),
        onpointermove: () => { if (active !== i) { active = i; render(); } },
      },
        h("span", { class: "move-name" }, c.name),
        !c.inbox && c.type !== "spending" ? h("span", { class: "cat-type" }, CATEGORY_TYPES[c.type].label) : null));
    });
    input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    list.querySelector(".move-opt.active")?.scrollIntoView({ block: "nearest" });
  }

  function pick(c) {
    closeMoveMenu();
    onPick(c.inbox ? null : c.id);
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) pick(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); closeMoveMenu(); anchor.focus(); }
    else if (e.key === "Tab") closeMoveMenu();
  });

  const onOutside = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMoveMenu(); };
  document.addEventListener("pointerdown", onOutside, true);
  anchor.setAttribute("aria-expanded", "true");
  anchor.parentElement.append(el);
  openMenu = { el, anchor, onOutside };
  render();
  // Open upward when there isn't room below (near the bottom of a list or drawer).
  const box = el.getBoundingClientRect();
  if (box.bottom > window.innerHeight - 8 && anchor.getBoundingClientRect().top > box.height + 8) el.classList.add("up");
  input.focus();
}
