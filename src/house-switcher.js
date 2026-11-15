let nextSwitcherId = 0;
const bindings = new WeakMap();

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

export function houseSwitcherMarkup({ houses, activeHouseId }) {
  const id = `haven-house-switcher-${++nextSwitcherId}`;
  const activeHouse = houses.find((house) => house.id === activeHouseId);
  const name = activeHouse ? String(activeHouse.name) : "Choose a house";

  return `<div class="house-switcher" data-house-switcher>
    <div class="house-switcher__controls">
      <button class="house-switcher__trigger" type="button" data-house-toggle aria-expanded="false" aria-controls="${id}-panel" aria-label="Switch house. ${activeHouse ? "Current house: " : ""}${escapeHtml(name)}" title="${escapeHtml(name)}">
        <svg class="house-switcher__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m3 10 9-7 9 7v10H15v-7H9v7H3z"/></svg>
        <span class="house-switcher__name" data-house-name>${escapeHtml(name)}</span>
        <svg class="house-switcher__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path class="house-switcher__chevron-down" d="m6 9 6 6 6-6"/><path class="house-switcher__chevron-up" d="m6 15 6-6 6 6"/></svg>
      </button>
      <button class="house-switcher__add" type="button" data-house-add><svg class="house-switcher__plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg> Add house</button>
    </div>
    <div class="house-switcher__panel" id="${id}-panel" data-house-panel role="region" aria-label="Switch house" hidden>
      <label class="house-switcher__search-label" for="${id}-search">Search houses</label>
      <input class="house-switcher__search" id="${id}-search" data-house-search type="search" placeholder="Find a house…" autocomplete="off" spellcheck="false" aria-controls="${id}-list" aria-describedby="${id}-status">
      <p class="house-switcher__status" id="${id}-status" data-house-status role="status" aria-live="polite" aria-atomic="true">${houses.length ? `${houses.length} house${houses.length === 1 ? "" : "s"}` : "No houses yet. Use Add house to get started."}</p>
      <ul class="house-switcher__list" id="${id}-list" data-house-list aria-label="Houses">${houses.map((house, index) => `<li data-house-row><button class="house-switcher__option" type="button" data-house-option="${index}"${house.id === activeHouseId ? ' aria-current="true"' : ""} title="${escapeHtml(house.name)}"><span class="house-switcher__name">${escapeHtml(house.name)}</span><span class="house-switcher__check" aria-hidden="true">✓</span></button></li>`).join("")}</ul>
      <button class="house-switcher__rename" type="button" data-house-rename${activeHouse ? "" : " disabled"}>Rename house</button>
    </div>
  </div>`;
}

export function bindHouseSwitcher({ root, houses, activeHouseId, onSelect, onAdd, onRename }) {
  const control = root.matches?.("[data-house-switcher]")
    ? root
    : root.querySelector("[data-house-switcher]");
  if (!control) return () => {};
  bindings.get(control)?.();

  const trigger = control.querySelector("[data-house-toggle]");
  const currentName = control.querySelector("[data-house-name]");
  const panel = control.querySelector("[data-house-panel]");
  const search = control.querySelector("[data-house-search]");
  const status = control.querySelector("[data-house-status]");
  const options = [...control.querySelectorAll("[data-house-option]")];
  const records = houses.map((house) => ({ id: house.id, name: String(house.name) }));
  const document = control.ownerDocument;
  const window = document.defaultView;
  let selectCallback = onSelect;
  let addCallback = onAdd;
  let renameCallback = onRename;
  let disposed = false;
  let open = false;

  function setSelection(id) {
    const activeHouse = records.find((house) => house.id === id);
    const name = activeHouse ? activeHouse.name : "Choose a house";
    currentName.textContent = name;
    trigger.title = name;
    trigger.setAttribute("aria-label", `Switch house. ${activeHouse ? "Current house: " : ""}${name}`);
    for (const option of options) {
      if (records[Number(option.dataset.houseOption)]?.id === id) {
        option.setAttribute("aria-current", "true");
      } else {
        option.removeAttribute("aria-current");
      }
    }
  }

  function filterHouses() {
    const query = search.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const option of options) {
      const house = records[Number(option.dataset.houseOption)];
      const matches = Boolean(house && house.name.toLocaleLowerCase().includes(query));
      option.closest("[data-house-row]").hidden = !matches;
      if (matches) count++;
    }
    status.textContent = count
      ? `${count} house${count === 1 ? "" : "s"}${query ? " found" : ""}`
      : records.length
        ? "No matching houses. Try another search or use Add house."
        : "No houses yet. Use Add house to get started.";
  }

  function positionPanel() {
    if (!open || disposed) return;
    const bounds = control.getBoundingClientRect();
    const gutter = 12;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const width = panel.getBoundingClientRect().width;
    const below = viewportHeight - bounds.bottom - gutter - 8;
    const above = bounds.top - gutter - 8;
    const openAbove = below < 440 && above > below;
    panel.style.maxHeight = `${Math.max(0, Math.min(440, openAbove ? above : below))}px`;
    panel.style.left = `${Math.max(gutter, Math.min(bounds.left, viewportWidth - width - gutter))}px`;
    panel.style.top = `${openAbove ? Math.max(gutter, bounds.top - panel.getBoundingClientRect().height - 8) : bounds.bottom + 8}px`;
  }

  function outsideClick(event) {
    if (!control.contains(event.target)) close();
  }

  function close(restoreFocus = false) {
    open = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outsideClick, true);
    window.removeEventListener("resize", positionPanel);
    window.removeEventListener("scroll", positionPanel, true);
    if (restoreFocus && !disposed && trigger.isConnected) trigger.focus();
  }

  function show() {
    if (disposed || open) return;
    open = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.value = "";
    filterHouses();
    positionPanel();
    search.focus({ preventScroll: true });
    document.addEventListener("click", outsideClick, true);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
  }

  function click(event) {
    if (disposed) return;
    const button = event.target.closest?.("button");
    if (!button || !control.contains(button)) return;
    if (button === trigger) {
      if (open) close();
      else show();
    } else if (button.matches("[data-house-add]")) {
      close(true);
      addCallback?.();
    } else if (button.matches("[data-house-rename]")) {
      close(true);
      renameCallback?.();
    } else if (button.matches("[data-house-option]")) {
      const house = records[Number(button.dataset.houseOption)];
      if (!house || button.closest("[data-house-row]").hidden) return;
      setSelection(house.id);
      close(true);
      selectCallback?.(house.id);
    }
  }

  function keydown(event) {
    if (disposed || event.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.target === trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      show();
      return;
    }
    if (!open || (event.target !== search && !options.includes(event.target))) return;
    const visible = options.filter((option) => !option.closest("[data-house-row]").hidden);
    const index = visible.indexOf(event.target);
    let next;
    if (event.key === "ArrowDown") next = visible[index + 1] || visible[0];
    else if (event.key === "ArrowUp") {
      next = index === 0 ? search : visible[index - 1] || visible[visible.length - 1];
    } else if (event.target !== search && event.key === "Home") next = visible[0];
    else if (event.target !== search && event.key === "End") next = visible[visible.length - 1];
    else return;
    event.preventDefault();
    next?.focus();
  }

  function focusout(event) {
    if (open && !control.contains(event.relatedTarget)) close();
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    close();
    control.removeEventListener("click", click);
    control.removeEventListener("keydown", keydown);
    control.removeEventListener("focusout", focusout);
    search.removeEventListener("input", filterHouses);
    selectCallback = null;
    addCallback = null;
    renameCallback = null;
    if (bindings.get(control) === cleanup) bindings.delete(control);
  }

  setSelection(activeHouseId);
  close();
  control.addEventListener("click", click);
  control.addEventListener("keydown", keydown);
  control.addEventListener("focusout", focusout);
  search.addEventListener("input", filterHouses);
  bindings.set(control, cleanup);
  return cleanup;
}
