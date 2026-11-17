const PAGE_SIZE = 20;
const shortPath = (path) => path.length > 160 ? `${path.slice(0, 60)} … ${path.slice(-95)}` : path;

// Keep the plan independent of the visible page. Large inventories must not
// create one full destination list for every item and container at once.
export function createDeletionMoves({ rootId, rooms = [], houses = null, containers, items, index, esc, destinations }) {
  const isHouse = houses !== null;
  const fields = `<label>How to move contents<select name="move-layout"><option value="together">Keep nested contents together</option><option value="separate">Choose destinations separately</option></select></label>
    <label>${isHouse ? "Destination house" : "Destination"}<select name="destination" required><option value="">${isHouse ? "Choose a house" : "Choose a room or container"}</option>${destinations}</select></label>
    <p class="modal-description" data-delete-default-help hidden>${isHouse ? "Optional: use this house for rooms without an individual choice below. Containers and items stay in their rooms unless you choose another destination." : "Optional: use this destination for containers and loose items without an individual choice below. Nested contents stay in their containers."}</p>
    <fieldset data-delete-together><p class="modal-description">${isHouse ? "Rooms keep all their nested containers, items, and scans. All rooms move to the selected house." : "Containers keep all their nested containers, items, and scans. Loose items move to the same destination."}</p></fieldset>
    <fieldset data-delete-separate hidden disabled></fieldset>`;

  function bind(dialog) {
    const layout = dialog.querySelector('[name="move-layout"]');
    const destination = dialog.querySelector('[name="destination"]');
    const split = dialog.querySelector("[data-delete-separate]");
    const together = dialog.querySelector("[data-delete-together]");
    const roomDestinations = new Map(), containerDestinations = new Map(), itemDestinations = new Map();
    let records, page = 0, bulkValue = destination.value, active = false;
    let locationChoices, lazyLocations, focusedChoice = null, destinationQuery = "";
    const targets = (record) => record.kind === "room"
      ? houses.map((house) => ({ id: house.id, path: house.name }))
      : locationChoices ||= index.sortedLocations();
    const lazyChoices = (record) => {
      if (record.kind === "room") return houses.length > 100;
      return lazyLocations ??= targets(record).length > 200 ||
        targets(record).reduce((size, target) => size + target.path.length, 0) > 12_000;
    };
    const ensureRecords = () => records ||= [
      ...rooms.map((entry, offset) => ({ ...entry, parentId: rootId, kind: "room", field: `room-destination-${offset}` })),
      ...containers.map((entry, offset) => ({ ...entry, kind: "container", field: `container-destination-${offset}` })),
      ...items.map((item, offset) => ({ ...item, parentId: item.locationId, kind: "item", field: `item-destination-${offset}` })),
    ];
    const choices = (record) => record.kind === "room" ? roomDestinations : record.kind === "container" ? containerDestinations : itemDestinations;
    const fallback = (record) => record.kind === "room" || (!isHouse && record.parentId === rootId) ? bulkValue : record.parentId;
    const selected = (record) => choices(record).has(record.id) ? choices(record).get(record.id) : fallback(record);
    const option = (target) => `<option value="${esc(target.id)}">${esc(shortPath(target.path))}</option>`;
    function optionsFor(record, expanded) {
      const keep = record.kind === "room" ? '<option value="">Choose a house</option>'
        : !isHouse && record.parentId === rootId ? '<option value="">Choose a room or container</option>'
        : `<option value="${esc(record.parentId)}">Keep in ${esc(index.byId.get(record.parentId).name)} (moves with it)</option>`;
      const value = selected(record), keepValue = record.kind === "room" || (!isHouse && record.parentId === rootId) ? "" : record.parentId;
      const entries = targets(record).filter((target) => (record.kind === "room" || isHouse || target.id !== rootId) &&
        target.id !== keepValue && !(record.kind === "container" && target.id === record.id) &&
        (target.id === value || (expanded && target.path.toLocaleLowerCase().includes(destinationQuery))));
      return keep + entries.map(option).join("");
    }
    function collapseChoice(select) {
      if (!select?.isConnected) return;
      const record = records[Number(select.dataset.deleteRecord)];
      if (!lazyChoices(record)) return;
      select.innerHTML = optionsFor(record, false);
      select.value = selected(record);
      if (focusedChoice === select) focusedChoice = null;
    }
    function expandChoice(select) {
      if (!active || select.disabled || focusedChoice === select) return;
      collapseChoice(focusedChoice);
      const record = records[Number(select.dataset.deleteRecord)];
      if (!lazyChoices(record)) return;
      select.innerHTML = optionsFor(record, true);
      select.value = selected(record);
      focusedChoice = select;
    }
    function rememberPage() {
      split.querySelectorAll("[data-delete-record]").forEach((select) => {
        const record = records[Number(select.dataset.deleteRecord)], plan = choices(record);
        if (select.value === fallback(record)) plan.delete(record.id);
        else plan.set(record.id, select.value);
      });
    }
    function renderPage() {
      const entries = ensureRecords();
      if (!split.hasChildNodes()) {
        split.innerHTML = `<p class="modal-description">${isHouse ? "Choose a house for each room. Containers and items move with their room unless you choose another destination below." : "Choose a destination for each container and loose item. Nested contents stay in their current container unless you choose another destination below."}</p><label>Search destinations<input type="search" data-delete-destination-search placeholder="${isHouse ? "House, room, or container" : "Room or container"}" autocomplete="off"></label><div data-delete-rows></div><nav class="deletion-pagination" aria-label="Contents pages"><button type="button" class="secondary" data-delete-page="-1">Previous contents</button><span role="status" data-delete-page-status></span><button type="button" class="secondary" data-delete-page="1">Next contents</button></nav>`;
        split.querySelector("[data-delete-destination-search]").oninput = (event) => {
          rememberPage();
          destinationQuery = event.target.value.trim().toLocaleLowerCase();
          renderPage();
        };
        split.querySelectorAll("[data-delete-page]").forEach((button) => button.onclick = () => {
          rememberPage();
          page += Number(button.dataset.deletePage);
          renderPage();
          split.querySelector("[data-delete-record]")?.focus();
        });
      }
      const rows = split.querySelector("[data-delete-rows]");
      focusedChoice = null;
      rows.querySelectorAll("select").forEach((select) => select.replaceChildren());
      rows.innerHTML = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((record, offset, visible) => {
        const position = page * PAGE_SIZE + offset;
        const path = index.path(record.kind === "item" ? record.parentId : record.id);
        const heading = !offset || visible[offset - 1].kind !== record.kind
          ? `<h3 class="deletion-group-heading">${record.kind === "room" ? "Rooms" : record.kind === "container" ? "Containers" : "Items"}</h3>` : "";
        return `${heading}<label class="deletion-destination">Destination for ${esc(record.name)}<small title="${esc(path)}">${esc(shortPath(path))}</small><select name="${record.field}" data-delete-record="${position}" required>${optionsFor(record, !lazyChoices(record))}</select></label>`;
      }).join("");
      rows.querySelectorAll("[data-delete-record]").forEach((select) => {
        select.value = selected(entries[Number(select.dataset.deleteRecord)]);
        select.onchange = rememberPage;
        select.onfocus = select.onpointerdown = () => expandChoice(select);
        select.onblur = () => collapseChoice(select);
      });
      const pages = Math.ceil(entries.length / PAGE_SIZE);
      split.querySelector(".deletion-pagination").hidden = pages <= 1;
      split.querySelector("[data-delete-page-status]").textContent = `Page ${page + 1} of ${pages}`;
      split.querySelector('[data-delete-page="-1"]').disabled = page === 0;
      split.querySelector('[data-delete-page="1"]').disabled = page + 1 >= pages;
    }
    destination.onchange = () => {
      if (active) rememberPage();
      bulkValue = destination.value;
      if (active) renderPage();
    };
    return {
      update(moving) {
        if (active) rememberPage();
        bulkValue = destination.value;
        active = moving && layout.value === "separate";
        destination.required = moving && !active;
        together.hidden = together.disabled = !moving || active;
        split.hidden = split.disabled = !active;
        dialog.querySelector("[data-delete-default-help]").hidden = !active;
        if (active) renderPage();
      },
      read(data) {
        const options = { mode: "move", [isHouse ? "destinationHouseId" : "destinationId"]: data.get("destination") || null };
        if (data.get("move-layout") !== "separate") return options;
        rememberPage();
        bulkValue = destination.value;
        const missing = ensureRecords().findIndex((record) => !selected(record));
        if (missing >= 0) {
          page = Math.floor(missing / PAGE_SIZE);
          renderPage();
          throw Error(`Choose a destination for ${records[missing].name}, or set the default destination above.`);
        }
        return { ...options, ...(isHouse ? { roomDestinations: new Map(roomDestinations) } : {}), containerDestinations: new Map(containerDestinations), itemDestinations: new Map(itemDestinations) };
      },
    };
  }
  return { fields, bind };
}
