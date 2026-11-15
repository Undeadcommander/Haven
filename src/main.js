import { locationImage, itemImage, imageFields, bindImagePicker } from "./location-images.js";
import "./style.css";
import "./features.css";
import "./themes.css";
import "./account.css";
import { setupInventoryDrag } from "./inventory-drag.js";
import { setupAccount } from "./account.js";
import { houseSwitcherMarkup, bindHouseSwitcher } from "./house-switcher.js";
import "./house-switcher.css";
import { addHouse, withHouses, inventoryForHouse, replaceHouseInventory, MAX_HOUSE_NAME_LENGTH } from "./houses.js";
import { pruneScanLinks, transferItem, transferContainer } from "./scan-data.js";
import {
  createBackupBlob,
  MAX_BACKUP_BYTES,
  stageBackup,
  getAssetScope,
} from "./scan-storage.js";
import { initialState, validState, createIndex, descendants, searchInventory, inventoryColors } from "./store.js";
const icons = {
  gear: '<path d="M9.837 5.343L10.437 3.137L13.563 3.137L14.163 5.343L15.178 5.763L17.162 4.628L19.372 6.838L18.237 8.822L18.657 9.837L20.863 10.437L20.863 13.563L18.657 14.163L18.237 15.178L19.372 17.162L17.162 19.372L15.178 18.237L14.163 18.657L13.563 20.863L10.437 20.863L9.837 18.657L8.822 18.237L6.838 19.372L4.628 17.162L5.763 15.178L5.343 14.163L3.137 13.563L3.137 10.437L5.343 9.837L5.763 8.822L4.628 6.838L6.838 4.628L8.822 5.763Z"/><circle cx="12" cy="12" r="3"/>',
  move: '<path d="M3 8h16m-4-4 4 4-4 4M21 16H5m4-4-4 4 4 4"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M7.5 5l9 4"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  leaf: '<path d="M20 3C8 2 2 8 5 15s15 4 15-12ZM5 20 16 8"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1 1 0 0 1 .7-1.7H17a4 4 0 0 0 4-4C21 6.9 17 3 12 3Z"/><circle cx="7.5" cy="10" r=".75"/><circle cx="11" cy="6.5" r=".75"/><circle cx="16" cy="8" r=".75"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.box}</svg>`;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const recoveryMessage = "Saved data could not be loaded. Editing is paused to protect it. Export the raw saved data, reload to retry, or restore a backup.";
let state = initialState(),
  storageIssue = "";
try {
  const raw = localStorage.getItem("haven-inventory");
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!validState(parsed)) throw Error("invalid");
    state = parsed;
  }
} catch {
  storageIssue = recoveryMessage;
}
let inventory = withHouses(state);
const housePreferenceKey = () => `haven-active-house:${getAssetScope() ? `account:${getAssetScope()}` : "guest"}`;
function preferredHouse(houses) {
  let saved;
  try { saved = localStorage.getItem(housePreferenceKey()); } catch {}
  return houses.some((house) => house.id === saved) ? saved : houses[0].id;
}
let activeHouseId = preferredHouse(inventory.houses);
state = inventoryForHouse(inventory, activeHouseId);
let index = createIndex(state),
  current = null,
  query = "",
  view = "rooms",
  highlight = null,
  itemPage = 0;
const ITEMS_PER_PAGE = 100;
const root = document.querySelector("#app");
const inventoryChanges = new EventTarget();
let inventoryEpoch = 0;
let cancelDrag = () => {};
let unbindHouseSwitcher = () => {};
const account = setupAccount({
  storageIssue: () => storageIssue,
  replace(next, options = {}) {
    inventoryEpoch++;
    storageIssue = options.storageIssue || "";
    inventory = withHouses(next);
    activeHouseId = inventory.houses.some((house) => house.id === options.houseId)
      ? options.houseId : preferredHouse(inventory.houses);
    if (options.houseId) rememberHouse();
    state = inventoryForHouse(inventory, activeHouseId);
    index = createIndex(state);
    current = null;
    query = "";
    view = "rooms";
    highlight = null;
    itemPage = 0;
    history.replaceState(historyEntry(), "", "#");
    render();
    inventoryChanges.dispatchEvent(new Event("replace"));
  },
});
function save(next) {
  return saveInventory(replaceHouseInventory(inventory, activeHouseId, pruneScanLinks(next)));
}
function saveInventory(next, options = {}) {
  next = pruneScanLinks(withHouses(next));
  try {
    account.save(next, options);
  } catch (error) {
    toast(
      error.message ||
        "Could not save. Browser storage may be full or unavailable. Export a backup.",
      true,
    );
    return false;
  }
  inventoryEpoch++;
  inventory = next;
  if (!inventory.houses.some((house) => house.id === activeHouseId))
    activeHouseId = preferredHouse(inventory.houses);
  state = inventoryForHouse(inventory, activeHouseId);
  index = createIndex(state);
  return true;
}
function rememberHouse() {
  try {
    localStorage.setItem(housePreferenceKey(), activeHouseId);
    return true;
  } catch {
    return false;
  }
}
function historyEntry() {
  return { houseId: activeHouseId, scope: getAssetScope() };
}
function activateHouse(id) {
  if (id === activeHouseId || !inventory.houses.some((house) => house.id === id)) return;
  inventoryEpoch++;
  activeHouseId = id;
  const remembered = rememberHouse();
  state = inventoryForHouse(inventory, activeHouseId);
  index = createIndex(state);
  document.querySelector("#editor")?.close();
  document.querySelector(".scan-dialog")?.close();
  inventoryChanges.dispatchEvent(new Event("replace"));
  return remembered;
}
function selectHouse(id) {
  const remembered = activateHouse(id);
  if (remembered === undefined) return;
  navigate();
  root.querySelector("[data-house-toggle]")?.focus();
  toast(remembered ? `Switched to ${inventory.houses.find((house) => house.id === id).name}`
    : "House switched for this session. Browser storage is unavailable.");
  return remembered;
}
function createHouse() {
  modal(
    "Add a house",
    "Keep each house’s rooms, containers, items, and scans in its own space. Switch houses anytime from the header.",
    `<label>House name<input name="name" required maxlength="${MAX_HOUSE_NAME_LENGTH}" placeholder="e.g. Lake house" autocomplete="off"></label><p class="warning" data-settings-error role="alert" hidden></p>`,
    (data, dialog) => {
      try {
        const id = crypto.randomUUID();
        const next = addHouse(inventory, data.get("name"), id);
        if (!saveInventory(next)) {
          showSettingsError(dialog, "Could not save this house. Please try again.");
          return;
        }
        dialog.close();
        if (selectHouse(id)) toast("Your new house is ready. Add a room to get started.");
      } catch (error) {
        showSettingsError(dialog, error.message);
      }
    },
    "Add house",
  );
}
function navigate(id = null, itemId = null) {
  current = id;
  highlight = itemId;
  query = "";
  view = "rooms";
  const itemOffset = itemId ? (index.items.get(id) || []).findIndex((item) => item.id === itemId) : 0;
  itemPage = Math.floor(Math.max(0, itemOffset) / ITEMS_PER_PAGE);
  history.pushState(historyEntry(), "", id ? `#room/${encodeURIComponent(id)}` : "#");
  render();
  if (itemId)
    requestAnimationFrame(() =>
      document
        .getElementById(`item-${itemId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
}
function illustration() {
  return locationImage("living");
}
function card(l) {
  const summary = index.summaries.get(l.id),
    direct = summary.preview,
    sub = index.children.get(l.id) || [];
  return `<article class="room-card ${l.color}" data-drop-location="${esc(l.id)}" ${l.parentId !== null ? `draggable="true" data-drag-kind="container" data-drag-id="${esc(l.id)}"` : ""}><button class="card-open" data-open="${esc(l.id)}" aria-label="Open ${esc(l.name)}"><div class="card-image">${locationImage(l.image) || (l.parentId === null ? illustration() : `<div class="container-art">${icon("folder")}</div>`)}<span class="type-tag">${icon(l.parentId === null ? "home" : "folder")}${l.parentId === null ? "ROOM" : "CONTAINER"}</span><span class="open-circle">${icon("arrow")}</span></div><div class="card-body"><div class="card-title"><h3>${esc(l.name)}</h3><span>${summary.count} item${summary.count === 1 ? "" : "s"}</span></div>${view === "containers" ? `<div class="container-path">${esc(index.path(l.parentId))}</div>` : ""}<p>${esc(l.description || "A little space for your things.")}</p><div class="item-preview">${
    direct.length
      ? direct
          .slice(0, 3)
          .map((i) => `<span>${esc(i.name)}</span>`)
          .join("")
      : '<span class="empty-chip">Ready for your first item</span>'
  }${summary.count > 3 ? `<span>+${summary.count - 3}</span>` : ""}</div><div class="card-foot">${icon("box")} ${sub.length ? `${sub.length} container${sub.length === 1 ? "" : "s"}` : "No containers yet. Room to begin."}${icon("chevron")}</div></div></button><button class="icon-button card-settings" data-location-settings="${esc(l.id)}" aria-label="Settings for ${esc(l.name)}" title="${l.parentId === null ? "Edit" : "Edit or move"} ${esc(l.name)}">${icon("gear")}</button></article>`;
}
function render() {
  cancelDrag();
  unbindHouseSwitcher();
  if (current && !index.byId.has(current)) current = null;
  const room = index.byId.get(current),
    rooms = index.children.get(null) || [],
    containers = state.locations.filter((location) => location.parentId !== null),
    children = index.children.get(current) || [],
    own = index.items.get(current) || [];
  root.innerHTML = `<aside class="sidebar"><a href="#" class="brand" aria-label="Haven home">${icon("home")}<span>haven<span class="brand-dot">.</span></span></a><div class="workspace-label">YOUR PERSONAL SPACE</div><button class="nav-link ${!current && view === "rooms" ? "active" : ""}" data-home>${icon("home")} My home <span>${rooms.length}</span></button><button class="nav-link ${view === "containers" ? "active" : ""}" data-all-containers>${icon("folder")} All containers <span>${containers.length}</span></button><button class="nav-link ${view === "items" ? "active" : ""}" data-all>${icon("box")} All items <span>${state.items.length}</span></button><div class="sidebar-section">MY ROOMS <button class="icon-button" data-add-root aria-label="Add room">${icon("plus")}</button></div><nav class="room-nav">${rooms.map((l) => `<button class="nav-link ${current === l.id ? "selected" : ""}" data-open="${esc(l.id)}" data-drop-location="${esc(l.id)}"><span class="room-dot ${l.color}"></span>${esc(l.name)}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="little-house">${icon("leaf")}</div><h4>A little less looking.<br>A little more living.</h4><p>A home for everything you own.</p><div class="local-status"><span></span><span data-save-status>Saved on this device</span></div><button class="backup" data-export>${icon("download")} Export a backup</button><button class="backup" data-import>${icon("folder")} Restore a backup</button></div></aside><div class="main-shell"><header><div class="search-wrap">${icon("search")}<input id="search" type="search" placeholder="Find anything in your home…" value="${esc(query)}" aria-label="Search items and rooms" autocomplete="off"><kbd>/</kbd><div id="search-results" class="search-results" hidden></div></div><div class="header-right"><div class="theme-control">${icon("palette")}<select class="theme-picker" data-theme-picker aria-label="Color theme" title="Color theme"><option value="light">Light</option><option value="dark">Dark</option><option value="oled">OLED black</option><option value="grey">Dark grey</option><option value="rose">Rose</option><option value="aqua">Aqua</option><option value="midnight">Midnight</option><option value="plum">Plum</option><option value="linen">Linen</option><option value="lavender">Lavender</option></select>${icon("chevron", "theme-chevron")}</div><button class="account-button" data-account title="Sign up or sign in with Google">Sign in</button><button class="avatar" type="button" data-account-avatar aria-label="Account" title="Manage your account" hidden>H</button></div></header><div data-account-status hidden></div><main>${storageIssue ? `<div class="warning">${esc(storageIssue)}</div>` : ""}<div class="breadcrumb"><button data-home>My home</button>${room ? breadcrumb(room) : `<span>/</span><span>${view === "containers" ? "All containers" : view === "items" ? "All items" : "Overview"}</span>`}</div><div class="page-heading"><div><div class="eyebrow">${room ? "A PLACE FOR THE DETAILS" : "A PLACE FOR EVERYTHING"}</div><h1>${room ? esc(room.name) : view === "containers" ? "All your containers." : view === "items" ? "All your things." : "Home, organized."}</h1><p>${room ? esc(room.description || "Give every little thing a place to belong.") : view === "containers" ? "Every drawer, shelf, and box, all in one place." : view === "items" ? "Everything you’ve saved, all in one place." : "Less searching. More living. Know exactly where everything belongs."}</p></div><div class="heading-actions">${room ? `${room.parentId !== null ? `<button class="secondary" data-move-container>${icon("move")} Move container</button>` : ""}<button class="icon-button border" data-edit-location aria-label="Edit location">${icon("edit")}</button><button class="icon-button border" data-delete-location aria-label="Delete location">${icon("trash")}</button><button class="primary" data-add-item>${icon("plus")} Add item</button>` : `<button class="primary" data-add-root>${icon("plus")} Add room</button>`}</div></div>${!room && view === "rooms" ? `<div class="stats"><div>${icon("home")}<span><strong>${rooms.length}</strong> Room${rooms.length === 1 ? "" : "s"}</span></div><div>${icon("box")}<span><strong>${state.items.length}</strong> Items tucked away</span></div><div>${icon("folder")}<span><strong>${state.locations.length - rooms.length}</strong> Containers</span></div><div class="stats-note">${icon("check")} A clearer space, a clearer mind.</div></div>` : ""}${room ? scanSection(room) : ""}${view === "containers" ? containerSection(containers) : view === "items" ? itemSection(state.items, true) : `<section><div class="section-heading"><h2>${room ? "Containers & areas" : "Your rooms"} <span>${children.length}</span></h2><span class="section-hint">${room ? "Every space has a place" : "Make yourself at home"}</span></div><div class="room-grid">${children.map(card).join("")}<button class="add-card" data-add-location><span class="add-circle">${icon("plus")}</span><h3>${room ? "Add a container" : "Add a room"}</h3><p>${room ? "A drawer, a shelf, a box…" : "A new space for your things"}</p></button></div></section>${room ? itemSection(own, false) : ""}`}</main><div class="mobile-backup"><button class="backup" data-export>Export a backup</button><button class="backup" data-import>Restore a backup</button></div><footer><span>Less clutter. More calm.</span><span>Made for the things that matter.</span></footer></div><div id="toast" role="status"></div><dialog id="editor"></dialog>`;
  root.querySelector("header").insertAdjacentHTML("afterbegin", houseSwitcherMarkup({ houses: inventory.houses, activeHouseId }));
  root.querySelector(".breadcrumb [data-home]").textContent = inventory.houses.find((house) => house.id === activeHouseId).name;
  bind();
}
function breadcrumb(room) {
  const chain = [];
  let p = room;
  while (p) {
    chain.push(p);
    p = index.byId.get(p.parentId);
  }
  return chain
    .reverse()
    .map(
      (l) =>
        `<span>/</span><button data-open="${esc(l.id)}" data-drop-location="${esc(l.id)}">${esc(l.name)}</button>`,
    )
    .join("");
}
function containerSection(containers) {
  return `<section class="containers-section"><div class="section-heading"><h2>Your containers <span>${containers.length}</span></h2><span class="section-hint">Every space has a place</span></div>${containers.length ? `<div class="room-grid">${containers.map(card).join("")}</div>` : `<div class="empty-items">${icon("folder")}<h3>A place for your first container.</h3><p>Open a room to add a drawer, shelf, or box.</p></div>`}</section>`;
}
function itemSection(items, all) {
  const pages = Math.ceil(items.length / ITEMS_PER_PAGE);
  itemPage = Math.max(0, Math.min(itemPage, pages - 1));
  const visible = items.slice(itemPage * ITEMS_PER_PAGE, (itemPage + 1) * ITEMS_PER_PAGE);
  const pagination = pages > 1 ? `<nav class="item-pagination" aria-label="Inventory pages"><button class="secondary" data-item-page="${itemPage - 1}" ${itemPage === 0 ? "disabled" : ""}>Previous items</button><span role="status">Page ${itemPage + 1} of ${pages}</span><button class="secondary" data-item-page="${itemPage + 1}" ${itemPage + 1 === pages ? "disabled" : ""}>Next items</button></nav>` : "";
  return `<section class="items-section"><div class="section-heading"><h2>${all ? "Your inventory" : "Items in this space"} <span>${items.length}</span></h2>${!all ? `<button class="text-button" data-add-item>${icon("plus")} Add item</button>` : ""}</div>${items.length ? `<div class="item-list">${visible.map((i) => `<article id="item-${esc(i.id)}" class="item-row ${i.color || "sage"} ${highlight === i.id ? "highlight" : ""}" draggable="true" data-drag-kind="item" data-drag-id="${esc(i.id)}"><div class="item-symbol">${itemImage(i.image) || icon("box")}</div><div class="item-info"><h3>${esc(i.name)}</h3><p>${esc(i.notes || "No extra details")}${all ? `<button class="item-path" data-find="${esc(i.id)}">${esc(index.path(i.locationId))} ${icon("arrow")}</button>` : ""}</p></div><button class="icon-button" data-move-item="${esc(i.id)}" aria-label="Move ${esc(i.name)}">${icon("move")}</button><button class="icon-button" data-edit-item="${esc(i.id)}" aria-label="Settings for ${esc(i.name)}" title="Edit or move ${esc(i.name)}">${icon("gear")}</button><button class="icon-button" data-delete-item="${esc(i.id)}" aria-label="Delete ${esc(i.name)}">${icon("trash")}</button></article>`).join("")}</div>${pagination}` : `<div class="empty-items">${icon("box")}<h3>A place for your first find.</h3><p>${all ? "Open a room to add your first item." : "Add an item and a few details so it’s easy to find later."}</p>${!all ? '<button class="secondary" data-add-item>Add your first item</button>' : ""}</div>`}</section>`;
}
function bind() {
  unbindHouseSwitcher = bindHouseSwitcher({
    root, houses: inventory.houses, activeHouseId, onSelect: selectHouse, onAdd: createHouse,
  });
  account.bind();
  root.querySelectorAll("[data-item-page]").forEach((button) => {
    button.onclick = () => {
      const direction = Number(button.dataset.itemPage) > itemPage ? "Next items" : "Previous items";
      itemPage = Number(button.dataset.itemPage);
      render();
      const buttons = [...root.querySelectorAll("[data-item-page]")];
      (buttons.find((entry) => entry.textContent === direction && !entry.disabled)
        || buttons.find((entry) => !entry.disabled))?.focus();
      root.querySelector(".items-section")?.scrollIntoView({ block: "start" });
    };
  });
  root.querySelectorAll("[data-location-settings]").forEach((button) => {
    button.onclick = () => editLocation(index.byId.get(button.dataset.locationSettings), null);
  });
  const picker = root.querySelector("[data-theme-picker]");
  picker.value = document.documentElement.dataset.theme;
  picker.onchange = () => {
    const theme = picker.value;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorScheme =
      ["dark", "oled", "grey", "midnight", "plum"].includes(theme) ? "dark" : "light";
    try {
      localStorage.setItem("haven-theme", theme);
    } catch {
      toast(
        "Theme changed for this session. Browser storage is unavailable.",
        true,
      );
    }
  };
  root
    .querySelector("[data-room-scan]")
    ?.addEventListener("click", showRoomScan);
  root
    .querySelectorAll("[data-move-item]")
    .forEach((b) => (b.onclick = () => moveItem(b.dataset.moveItem)));
  root
    .querySelectorAll("[data-open]")
    .forEach((b) => (b.onclick = () => navigate(b.dataset.open)));
  root
    .querySelectorAll("[data-home]")
    .forEach((b) => (b.onclick = () => navigate()));
  root.querySelector("[data-all-containers]").onclick = () => {
    current = null;
    view = "containers";
    query = "";
    itemPage = 0;
    history.pushState(historyEntry(), "", "#containers");
    render();
  };
  root.querySelector("[data-all]").onclick = () => {
    current = null;
    view = "items";
    query = "";
    itemPage = 0;
    history.pushState(historyEntry(), "", "#items");
    render();
  };
  root
    .querySelectorAll("[data-add-root]")
    .forEach((b) => (b.onclick = () => editLocation(null, null)));
  root
    .querySelector("[data-add-location]")
    ?.addEventListener("click", () => editLocation(null, current));
  root
    .querySelectorAll("[data-add-item]")
    .forEach((b) => (b.onclick = () => editItem()));
  root
    .querySelector("[data-edit-location]")
    ?.addEventListener("click", () =>
      editLocation(index.byId.get(current), null),
    );
  root
    .querySelector("[data-move-container]")
    ?.addEventListener("click", () => moveContainer(current));
  root
    .querySelector("[data-delete-location]")
    ?.addEventListener("click", deleteLocation);
  root
    .querySelectorAll("[data-edit-item]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          editItem(state.items.find((i) => i.id === b.dataset.editItem))),
    );
  root.querySelectorAll("[data-delete-item]").forEach(
    (b) =>
      (b.onclick = () =>
        confirmDelete(
          "Delete this item?",
          "This item will be removed from your inventory.",
          () => {
            if (
              save({
                ...state,
                items: state.items.filter((i) => i.id !== b.dataset.deleteItem),
              })
            )
              render();
          },
        )),
  );
  root.querySelectorAll("[data-find]").forEach(
    (b) =>
      (b.onclick = () => {
        const i = state.items.find((i) => i.id === b.dataset.find);
        navigate(i.locationId, i.id);
      }),
  );
  root.querySelector("#search").oninput = (e) => {
    query = e.target.value;
    showSearch();
  };
  root.querySelector("#search").onfocus = showSearch;
  root
    .querySelectorAll("[data-export]")
    .forEach((b) => (b.onclick = exportData));
  root
    .querySelectorAll("[data-import]")
    .forEach((b) => (b.onclick = importData));
}
function showSearch() {
  const panel = document.querySelector("#search-results"),
    q = query.trim().toLowerCase();
  if (!q) {
    panel.hidden = true;
    return;
  }
  const { total, results } = searchInventory(index, q);
  panel.hidden = false;
  panel.innerHTML = `<div class="results-label">${total} results${total > 30 ? " · showing first 30" : ""}</div>${
    results
      .map(
        (r) =>
          `<button class="search-result" data-target="${esc(r.id)}" data-item="${esc(r.item || "")}">${icon(r.type)}<span><strong>${esc(r.name)}</strong><small>${esc(r.path)}</small></span>${icon("arrow")}</button>`,
      )
      .join("") ||
    '<p class="no-results">No matches yet. Try an item, room, or detail.</p>'
  }`;
  panel
    .querySelectorAll("button")
    .forEach(
      (b) => (b.onclick = () => navigate(b.dataset.target, b.dataset.item)),
    );
}
function clearClosedEditor(event) {
  const dialog = event.currentTarget;
  if (!dialog.open) dialog.replaceChildren();
}
function modal(title, description, fields, onSubmit, label = "Save") {
  const d = document.querySelector("#editor");
  d.innerHTML = `<form><div class="modal-heading"><div><span class="eyebrow">MAKE ROOM</span><h2>${title}</h2></div><button type="button" class="icon-button" data-cancel aria-label="Close dialog">${icon("close")}</button></div><p class="modal-description">${description}</p>${fields}<div class="modal-actions"><button type="button" class="secondary" data-cancel>Cancel</button><button type="submit" class="primary">${label}</button></div></form>`;
  d.querySelectorAll("[data-cancel]").forEach(
    (b) => (b.onclick = () => d.close()),
  );
  d.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    onSubmit(new FormData(e.target), d);
  };
  // Closed forms can retain parsed backups and decoded photo editor images
  // through their handlers until the next navigation or modal is opened.
  d.onclose = clearClosedEditor;
  d.showModal();
}
function colorFields(selected = "sage") {
  return `<fieldset class="color-picker" aria-describedby="photo-color-help"><legend>Color</legend><div class="color-options">${inventoryColors.map((color) => `<label class="color-option ${color}"><input type="radio" name="color" value="${color}" ${selected === color ? "checked" : ""}><span>${color}</span></label>`).join("")}</div><p id="photo-color-help" class="modal-description" data-photo-color-note hidden>Your photo keeps its own colors. Choose artwork to use these colors.</p></fieldset>`;
}
function destinationOptions(selected, excluded = new Set()) {
  return index.sortedLocations().filter((l) => !excluded.has(l.id))
    .map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? "selected" : ""}>${esc(l.path)}${l.id === selected ? " (current)" : ""}</option>`).join("");
}
function showSettingsError(dialog, message) {
  const error = dialog.querySelector("[data-settings-error]");
  error.textContent = message;
  error.hidden = false;
}
function addImportOption(kind, destination) {
  const dialog = document.querySelector("#editor");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary import-existing";
  button.textContent = `Import existing ${kind}`;
  button.onclick = () => importExisting(kind,
    kind === "item" ? dialog.querySelector('[name="location"]').value : destination);
  dialog.querySelector(".modal-description").after(button);
}
function importExisting(kind, destination) {
  const isContainer = kind === "container";
  // A destination's ancestors cannot be moved into it without creating a cycle.
  const excluded = new Set();
  for (let location = index.byId.get(destination); location; location = index.byId.get(location.parentId))
    excluded.add(location.id);
  const candidates = (isContainer ? state.locations : state.items)
    .filter((entry) => isContainer
      ? entry.parentId !== null && entry.parentId !== destination && !excluded.has(entry.id)
      : entry.locationId !== destination)
    .map((entry) => ({
      ...entry,
      path: isContainer ? index.path(entry.id) : `${index.path(entry.locationId)} / ${entry.name}`,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  modal(
    `Import existing ${kind}`,
    `Move an existing ${kind} to <strong>${esc(index.path(destination))}</strong>. ${isContainer
      ? "Everything inside, including nested containers and scans, moves with it. Pins showing its old position in other scans will be cleared."
      : "Its scan pins will be cleared so you can mark its new position."}`,
    `${candidates.length
      ? `<label>Choose ${kind}<select name="source" required><option value="">Select an existing ${kind}</option>${candidates.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.path)}</option>`).join("")}</select></label>`
      : `<p class="modal-description">No ${isContainer ? "containers" : "items"} are available to import into this location. ${isContainer ? "Rooms, this container, its ancestors, and containers already directly here cannot be imported." : "Items already here are not listed."}</p>`}
      <button type="button" class="text-button" data-create-new>Create a new ${kind}</button>
      <p class="warning" data-settings-error role="alert" hidden></p>`,
    (data, dialog) => {
      try {
        const next = isContainer
          ? transferContainer(state, data.get("source"), destination)
          : transferItem(state, data.get("source"), destination);
        if (!save(next)) throw Error(`Could not save this move. Your ${kind} has not moved. Please try again.`);
        dialog.close();
        render();
        toast(`${isContainer ? "Container" : "Item"} moved to ${index.path(destination)}.`);
      } catch (error) {
        showSettingsError(dialog, error.message);
      }
    },
    `Move ${kind} here`,
  );
  const dialog = document.querySelector("#editor");
  const submit = dialog.querySelector('[type="submit"]');
  submit.disabled = true;
  const source = dialog.querySelector('[name="source"]');
  if (source) source.onchange = () => {
    submit.disabled = !source.value;
    dialog.querySelector("[data-settings-error]").hidden = true;
  };
  dialog.querySelector("[data-create-new]").onclick = () => {
    if (isContainer) editLocation(null, destination);
    else {
      editItem();
      dialog.querySelector('[name="location"]').value = destination;
    }
  };
}
function editLocation(l, parent) {
  const isRoom = l ? l.parentId === null : parent === null;
  let getImage;
  modal(
    `${l ? "Edit" : "Add"} ${isRoom ? "a room" : "a container"}`,
    isRoom
      ? "Give this part of your home a name."
      : l ? "Update this container or choose a new destination." : "Create a home for the things inside this space.",
    `<label>Name<input name="name" required maxlength="100" placeholder="${isRoom ? "e.g. Living room" : "e.g. Top drawer"}" value="${esc(l?.name || "")}"></label><label>Description <span>optional</span><textarea name="description" maxlength="500" placeholder="What makes this space yours?">${esc(l?.description || "")}</textarea></label>${colorFields(l?.color)}${imageFields(isRoom)}${l && !isRoom ? `<label>Destination<select name="parent">${destinationOptions(l.parentId, descendants(index, l.id))}</select></label><p class="modal-description">Changing destination moves everything inside. Pins showing the old position in other scans will be cleared.</p>` : ""}<p class="warning" data-settings-error role="alert" hidden></p>`,
    (data, d) => {
      const name = data.get("name").trim();
      if (!name) return;
      let next = state, image;
      try {
        image = getImage();
        if (l && !isRoom) next = transferContainer(state, l.id, data.get("parent"));
      } catch (error) {
        showSettingsError(d, error.message);
        return;
      }
      const entry = {
        id: l?.id || crypto.randomUUID(),
        parentId: l ? (isRoom ? null : data.get("parent")) : parent,
        image,
        name,
        description: data.get("description").trim(),
        color: d.querySelector('input[name="color"]:checked')?.value || "sage",
      };
      if (
        save({
          ...next,
          locations: l
            ? next.locations.map((x) => (x.id === l.id ? entry : x))
            : [...next.locations, entry],
        })
      ) {
        d.close();
        render();
        toast(l ? "Space updated" : "A new space, ready for your things");
      } else {
        showSettingsError(d, "Could not save your changes. Please try again.");
      }
    },
  );
  getImage = bindImagePicker(document.querySelector("#editor"), l?.image,
    isRoom ? illustration() : `<div class="container-art">${icon("folder")}</div>`, locationImage, isRoom ? "living" : null);
  if (!l && !isRoom) addImportOption("container", parent);
}
function editItem(item) {
  let getImage;
  modal(
    item ? "Edit item" : "Add an item",
    "A little detail now makes it easy to find later.",
    `<label>Item name<input name="name" required maxlength="150" placeholder="e.g. Spare keys" value="${esc(item?.name || "")}"></label><label>Description <span>optional · Where exactly?</span><textarea name="notes" maxlength="1000" placeholder="e.g. In the small blue box, behind the books">${esc(item?.notes || "")}</textarea></label><label>Location<select name="location">${state.locations.map((l) => `<option value="${esc(l.id)}" ${l.id === (item?.locationId || current) ? "selected" : ""}>${esc(index.path(l.id))}</option>`).join("")}</select></label>${colorFields(item?.color)}${imageFields("item")}<p class="warning" data-settings-error role="alert" hidden></p>`,
    (data, d) => {
      const name = data.get("name").trim();
      if (!name) return;
      const entry = {
        id: item?.id || crypto.randomUUID(),
        name,
        notes: data.get("notes").trim(),
        locationId: data.get("location"),
        color: d.querySelector('input[name="color"]:checked')?.value || "sage",
      };
      let next;
      try {
        entry.image = getImage();
        next = item ? transferItem(state, item.id, entry.locationId) : state;
      } catch (error) {
        showSettingsError(d, error.message);
        return;
      }
      if (
        save({
          ...next,
          items: item
            ? state.items.map((i) => (i.id === item.id ? entry : i))
            : [...state.items, entry],
        })
      ) {
        d.close();
        const visibleItems = view === "items" ? state.items : index.items.get(current) || [];
        const savedOffset = visibleItems.findIndex((saved) => saved.id === entry.id);
        if (savedOffset >= 0) itemPage = Math.floor(savedOffset / ITEMS_PER_PAGE);
        render();
        toast("Item saved. Right where it belongs.");
      } else {
        showSettingsError(d, "Could not save your changes. Please try again.");
      }
    },
  );
  getImage = bindImagePicker(document.querySelector("#editor"), item?.image,
    `<div class="container-art">${icon("box")}</div>`, itemImage);
  if (!item) addImportOption("item", current);
}
function confirmDelete(title, description, fn, label = "Delete") {
  modal(
    title,
    description,
    "",
    (_, d) => {
      d.close();
      fn();
    },
    label,
  );
}
function deleteLocation() {
  const l = index.byId.get(current),
    ids = descendants(index, current),
    count = state.items.filter((i) => ids.has(i.locationId)).length;
  confirmDelete(
    `Delete ${esc(l.name)}?`,
    `This removes this space, ${ids.size - 1} nested containers, and ${count} items. This cannot be undone.`,
    () => {
      if (
        save({
          ...state,
          locations: state.locations.filter((x) => !ids.has(x.id)),
          items: state.items.filter((i) => !ids.has(i.locationId)),
        })
      )
        navigate(l.parentId);
    },
  );
}
let toastTimer;
function toast(message, error = false) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.className = `visible ${error ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 5000);
}
async function exportData() {
  try {
    const recovering = !!storageIssue && !account.uid;
    toast(recovering ? "Preparing raw recovery metadata…" : "Preparing a full backup, including room scans…");
    let backup;
    if (recovering) {
      const raw = localStorage.getItem("haven-inventory");
      if (raw === null) throw Error("Saved data is unavailable. Reload to retry; no data has been replaced.");
      backup = new Blob([raw], { type: "application/json" });
    } else backup = await createBackupBlob(inventory);
    const url = URL.createObjectURL(backup);
    const a = document.createElement("a");
    a.href = url;
    a.download = `haven-${recovering ? "raw-recovery" : "backup"}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(recovering ? "Raw recovery metadata exported unchanged. Scan files remain on this device."
      : "Backup ready. Keep it somewhere safe.");
  } catch (error) {
    toast(error.message || "Could not export the backup.", true);
  }
}
function importData() {
  const owner = account.authEpoch;
  const version = inventoryEpoch;
  const scope = getAssetScope();
  const isCurrent = () => account.authEpoch === owner && inventoryEpoch === version && getAssetScope() === scope;
  const staleMessage = "Your account or inventory changed. Please choose the backup again.";
  const requireCurrent = () => { if (!isCurrent()) throw Error(staleMessage); };
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    try {
      const file = input.files[0];
      if (!file) return;
      if (file.size > MAX_BACKUP_BYTES)
        throw Error("This backup exceeds the 250 MB restore limit.");
      const text = await file.text();
      requireCurrent();
      const parsed = JSON.parse(text);
      const modern = parsed.format === "haven-backup" && parsed.version === 2;
      const data = modern ? parsed.inventory : parsed;
      if (!validState(data) || (modern && !Array.isArray(parsed.assets)))
        throw Error("That file is not a valid Haven backup.");
      if (!modern && data.scans?.length)
        throw Error(
          "This backup is missing its scan files. Restore a full backup instead.",
        );
      modal(
        "Restore this backup?",
        `Replace all your houses with ${data.houses?.length || 1} house(s), ${data.locations.length} spaces, ${data.items.length} items, and ${data.scans?.length || 0} scans? Export a backup first to keep a copy of every house.`,
        "",
        async (_, dialog) => {
          const form = dialog.querySelector("form");
          const ownsDialog = () => dialog.isConnected && dialog.open && dialog.querySelector("form") === form;
          const buttons = dialog.querySelectorAll("button");
          buttons.forEach((b) => (b.disabled = true));
          const preventClose = (e) => e.preventDefault();
          dialog.addEventListener("cancel", preventClose);
          let staged;
          try {
            requireCurrent();
            if (!ownsDialog()) throw Error(staleMessage);
            staged = modern
              ? await stageBackup(parsed)
              : { inventory: data, rollback: async () => {} };
            if (!isCurrent() || !ownsDialog()) {
              await staged.rollback();
              throw Error(staleMessage);
            }
            if (!saveInventory(staged.inventory, { replaceUnreadable: true })) {
              await staged.rollback();
              throw Error("Could not save the restored inventory.");
            }
            const restoredVersion = inventoryEpoch;
            if (staged.commit) await staged.commit().catch(() => {});
            if (account.authEpoch !== owner || getAssetScope() !== scope ||
                inventoryEpoch !== restoredVersion || !ownsDialog()) return;
            storageIssue = "";
            dialog.close();
            navigate();
            inventoryChanges.dispatchEvent(new Event("replace"));
            toast("All houses, inventory, and scans have been restored.");
          } catch (error) {
            toast(error.message || "Could not restore the backup.", true);
            if (ownsDialog())
              form.querySelector(".modal-description").textContent = error.message;
          } finally {
            dialog.removeEventListener("cancel", preventClose);
            buttons.forEach((b) => (b.disabled = false));
          }
        },
        "Restore",
      );
    } catch (error) {
      toast(error.message || "That file is not a valid Haven backup.", true);
    }
  };
  input.click();
}
function scanSection(room) {
  const scan = index.scanByLocation.get(room.id);
  const count = index.markersByScan.get(scan?.id)?.length || 0;
  return `<section class="scan-entry"><div class="scan-entry-icon">◇</div><div><h2>${scan ? "Your space, mapped out." : "See your space in 3D."}</h2><p>${scan ? `${esc(scan.name)} · ${count} markers` : "Import a room scan or capture depth on a compatible phone. Pin items and containers right where they belong."}</p></div><button class="secondary" data-room-scan>${scan ? "Open 3D scan" : "Add 3D scan"}</button></section>`;
}
let scanOpening = false;
async function showRoomScan() {
  if (scanOpening) return;
  scanOpening = true;
  const id = current;
  const houseId = activeHouseId, owner = account.authEpoch, version = inventoryEpoch;
  try {
    const { openScanViewer } = await import("./scan-viewer.js");
    if (current !== id || activeHouseId !== houseId || account.authEpoch !== owner || inventoryEpoch !== version) return;
    await openScanViewer(id, {
      getState: () => state,
      getIndex: () => index,
      getScope: () => account.uid,
      cleanupAssets: () => account.cleanupAssets(),
      subscribe(listener) {
        inventoryChanges.addEventListener("replace", listener);
        return () => inventoryChanges.removeEventListener("replace", listener);
      },
      save,
      navigate,
      toast,
      esc,
      onClose: render,
    });
  } catch (error) {
    toast(error.message || "Could not open the 3D viewer.", true);
  } finally {
    scanOpening = false;
  }
}
function dropInventory(kind, id, destination) {
  const record = kind === "container" ? index.byId.get(id) : state.items.find((i) => i.id === id);
  if (!record) return;
  try {
    const next = kind === "container"
      ? transferContainer(state, id, destination)
      : transferItem(state, id, destination);
    if (next === state || !save(next)) return;
    render();
    toast(`Moved ${record.name} to ${index.path(destination)}.`);
    return true;
  } catch (error) {
    toast(error.message || "Could not move this item or container.", true);
  }
}
function moveContainer(id) {
  const container = index.byId.get(id);
  if (!container || container.parentId === null) return;
  const excluded = descendants(index, id);
  const options = destinationOptions(container.parentId, excluded);
  const destinationCount = state.locations.length - excluded.size;
  modal(
    `Move ${esc(container.name)}`,
    "Choose a room or another container. Everything inside moves with it. Pins showing its old position in other scans will be cleared.",
    `<label>Destination<select name="destination" required>${options}</select></label>${destinationCount === 1 ? '<p class="modal-description">Add another room or container to create a destination.</p>' : ""}<p class="warning" data-move-error role="alert" hidden></p>`,
    (data, d) => {
      const destination = data.get("destination");
      try {
        const next = transferContainer(state, id, destination);
        if (!save(next))
          throw Error("Could not save this move. Your container has not moved. Please try again.");
        d.close();
        render();
        toast(`Moved ${container.name} to ${index.path(destination)}.`);
      } catch (error) {
        const message = d.querySelector("[data-move-error]");
        message.textContent = error.message;
        message.hidden = false;
      }
    },
    "Move container",
  );
  const dialog = document.querySelector("#editor");
  const submit = dialog.querySelector('[type="submit"]');
  submit.disabled = true;
  dialog.querySelector('[name="destination"]').onchange = (event) => {
    submit.disabled = event.target.value === container.parentId;
    dialog.querySelector("[data-move-error]").hidden = true;
  };
}
function moveItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  modal(
    `Move ${esc(item.name)}`,
    "Choose any room or container. Existing scan markers for this item will be cleared so you can place it at its new location.",
    `<label>Destination<select name="destination">${state.locations.map((l) => `<option value="${esc(l.id)}" ${l.id === item.locationId ? "selected" : ""}>${esc(index.path(l.id))}</option>`).join("")}</select></label>`,
    (data, d) => {
      const destination = data.get("destination");
      if (save(transferItem(state, id, destination))) {
        d.close();
        render();
        toast(`Moved to ${index.path(destination)}.`);
      }
    },
    "Move item",
  );
}
function route() {
  itemPage = 0;
  query = "";
  highlight = null;
  const entry = history.state;
  let unresolvedLegacyRoom = null;
  const foreignHistory = entry?.houseId && entry.scope !== getAssetScope();
  const hash = foreignHistory ? "" : location.hash.slice(1);
  if (!foreignHistory && inventory.houses.some((house) => house.id === entry?.houseId))
    activateHouse(entry.houseId);
  if (hash === "items" || hash === "containers") {
    view = hash;
    current = null;
  } else {
    view = "rooms";
    try {
      current = hash.startsWith("room/")
        ? decodeURIComponent(hash.slice(5))
        : null;
    } catch {
      current = null;
    }
    if (current && !index.byId.has(current)) {
      const locations = new Map(inventory.locations.map((location) => [location.id, location]));
      let location = locations.get(current);
      while (location && location.parentId !== null) location = locations.get(location.parentId);
      if (location) activateHouse(location.houseId);
      if (!index.byId.has(current)) {
        if (!entry?.houseId || entry.pendingRoom === current) unresolvedLegacyRoom = current;
        current = null;
      }
    }
  }
  const nextEntry = historyEntry();
  if (unresolvedLegacyRoom) nextEntry.pendingRoom = unresolvedLegacyRoom;
  history.replaceState(nextEntry, "", unresolvedLegacyRoom ? `#room/${encodeURIComponent(unresolvedLegacyRoom)}`
    : current ? `#room/${encodeURIComponent(current)}`
    : view === "rooms" ? "#" : `#${view}`);
  render();
}
window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    document.querySelector("#search").focus();
  }
  if (e.key === "Escape")
    document.querySelector("#search-results").hidden = true;
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap"))
    document.querySelector("#search-results").hidden = true;
});
window.addEventListener("storage", (e) => {
  try {
    account.externalChange(e.key);
  } catch {
    storageIssue = recoveryMessage;
    inventoryEpoch++;
    render();
    toast(
      recoveryMessage,
      true,
    );
  }
});
cancelDrag = setupInventoryDrag(root, { getState: () => state, getIndex: () => index, onMove: dropInventory });
route();
