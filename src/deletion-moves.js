const PAGE_SIZE = 20;

// Keep the plan independent of the visible page. Large inventories must not
// create one full destination list for every item and container at once.
export function createDeletionMoves({ rootId, containers, items, index, esc, destinations }) {
  const fields = `<label>How to move contents<select name="move-layout"><option value="together">Keep nested contents together</option><option value="separate">Choose destinations separately</option></select></label>
    <label>Destination<select name="destination" required><option value="">Choose a room or container</option>${destinations}</select></label>
    <p class="modal-description" data-delete-default-help hidden>Optional: use this destination for containers and loose items without an individual choice below. Nested contents stay in their containers.</p>
    <fieldset data-delete-together><p class="modal-description">Containers keep all their nested containers, items, and scans. Loose items move to the same destination.</p></fieldset>
    <fieldset data-delete-separate hidden disabled></fieldset>`;

  function bind(dialog) {
    const layout = dialog.querySelector('[name="move-layout"]');
    const destination = dialog.querySelector('[name="destination"]');
    const split = dialog.querySelector("[data-delete-separate]");
    const together = dialog.querySelector("[data-delete-together]");
    const containerDestinations = new Map(), itemDestinations = new Map();
    let records, page = 0, bulkValue = destination.value, active = false;
    const ensureRecords = () => records ||= [
      ...containers.map((entry, offset) => ({ ...entry, kind: "container", field: `container-destination-${offset}` })),
      ...items.map((item, offset) => ({ ...item, parentId: item.locationId, kind: "item", field: `item-destination-${offset}` })),
    ];
    const choices = (record) => record.kind === "container" ? containerDestinations : itemDestinations;
    const fallback = (record) => record.parentId === rootId ? bulkValue : record.parentId;
    const selected = (record) => choices(record).has(record.id) ? choices(record).get(record.id) : fallback(record);
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
        split.innerHTML = `<p class="modal-description">Choose a destination for each container and loose item. Nested contents stay in their current container unless you choose another destination below.</p><div data-delete-rows></div><nav class="deletion-pagination" aria-label="Contents pages"><button type="button" class="secondary" data-delete-page="-1">Previous contents</button><span role="status" data-delete-page-status></span><button type="button" class="secondary" data-delete-page="1">Next contents</button></nav>`;
        split.querySelectorAll("[data-delete-page]").forEach((button) => button.onclick = () => {
          rememberPage();
          page += Number(button.dataset.deletePage);
          renderPage();
          split.querySelector("[data-delete-record]")?.focus();
        });
      }
      const rows = split.querySelector("[data-delete-rows]");
      rows.querySelectorAll("select").forEach((select) => select.replaceChildren());
      rows.innerHTML = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((record, offset, visible) => {
        const position = page * PAGE_SIZE + offset;
        const options = index.sortedLocations().filter((target) => target.id !== rootId &&
          target.id !== record.parentId && !(record.kind === "container" && target.id === record.id))
          .map((target) => `<option value="${esc(target.id)}">${esc(target.path)}</option>`).join("");
        const keep = record.parentId === rootId ? '<option value="">Choose a room or container</option>'
          : `<option value="${esc(record.parentId)}">Keep in ${esc(index.byId.get(record.parentId).name)} (moves with it)</option>`;
        const heading = !offset || visible[offset - 1].kind !== record.kind
          ? `<h3 class="deletion-group-heading">${record.kind === "container" ? "Containers" : "Items"}</h3>` : "";
        return `${heading}<label class="deletion-destination">Destination for ${esc(record.name)}<small>${esc(index.path(record.kind === "container" ? record.id : record.parentId))}</small><select name="${record.field}" data-delete-record="${position}" required>${keep}${options}</select></label>`;
      }).join("");
      rows.querySelectorAll("[data-delete-record]").forEach((select) => {
        select.value = selected(entries[Number(select.dataset.deleteRecord)]);
        select.onchange = rememberPage;
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
        const options = { mode: "move", destinationId: data.get("destination") };
        if (data.get("move-layout") !== "separate") return options;
        rememberPage();
        bulkValue = destination.value;
        const missing = ensureRecords().findIndex((record) => !selected(record));
        if (missing >= 0) {
          page = Math.floor(missing / PAGE_SIZE);
          renderPage();
          throw Error(`Choose a destination for ${records[missing].name}, or set the default destination above.`);
        }
        return { ...options, containerDestinations: new Map(containerDestinations), itemDestinations: new Map(itemDestinations) };
      },
    };
  }
  return { fields, bind };
}
