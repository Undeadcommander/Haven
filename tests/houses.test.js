import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, validState, createIndex, searchInventory } from "../src/store.js";
import { addHouse, renameHouse, withHouses, inventoryForHouse, replaceHouseInventory, DEFAULT_HOUSE_ID } from "../src/houses.js";
import { mergeGuestInventory, AccountSync, accountKey } from "../src/account-sync.js";
import { encodeInventory, decodeInventory } from "../src/firestore-inventory.js";

function twoHouses() {
  const inventory = addHouse(initialState(), "Lake house", "lake");
  inventory.locations.push(
    { id: "drawer", parentId: "living-room", name: "Drawer", description: "", color: "sage" },
    { id: "lake-room", parentId: null, houseId: "lake", name: "Boathouse", description: "", color: "blue" },
    { id: "lake-box", parentId: "lake-room", name: "Gear box", description: "", color: "blue" },
  );
  inventory.items.push(
    { id: "keys", name: "Keys", notes: "Only at home", locationId: "drawer" },
    { id: "paddle", name: "Paddle", notes: "Only at the lake", locationId: "lake-box" },
  );
  inventory.scans = [
    { id: "home-scan", locationId: "living-room", assetId: "home-asset", name: "Home", format: "obj" },
    { id: "lake-scan", locationId: "lake-room", assetId: "lake-asset", name: "Lake", format: "obj" },
  ];
  inventory.markers = [
    { id: "home-pin", scanId: "home-scan", kind: "item", targetId: "keys", position: [0, 0, 0] },
    { id: "lake-pin", scanId: "lake-scan", kind: "item", targetId: "paddle", position: [1, 0, 0] },
  ];
  return inventory;
}

test("legacy inventories gain one house without changing IDs, scans, or the original", () => {
  const legacy = initialState();
  const before = structuredClone(legacy);
  const normalized = withHouses(legacy);
  assert.deepEqual(normalized.houses, [{ id: DEFAULT_HOUSE_ID, name: "My home" }]);
  assert.deepEqual(normalized.locations.map((location) => location.id), legacy.locations.map((location) => location.id));
  assert.equal(normalized.locations.every((location) => location.houseId === DEFAULT_HOUSE_ID), true);
  assert.equal(validState(normalized), true);
  assert.equal(withHouses(normalized), normalized);
  assert.deepEqual(legacy, before);
  assert.equal(validState(legacy), true);
});

test("houses have no fixed count limit and new houses start empty", () => {
  let inventory = initialState();
  for (let house = 0; house < 150; house++)
    inventory = addHouse(inventory, `House ${house}`, `house-${house}`);
  assert.equal(inventory.houses.length, 151);
  assert.equal(validState(inventory), true);
  assert.equal(inventoryForHouse(inventory, "house-149").locations.length, 0);
  assert.throws(() => addHouse(inventory, " house 1 "), /already exists/);
  assert.throws(() => addHouse(inventory, "   "), /name/);
  assert.throws(() => addHouse(inventory, "x".repeat(81)), /name/);
  assert.throws(() => addHouse(inventory, "Duplicate ID", "house-1"), /try again/);
});

test("renaming houses preserves IDs, ownership, contents, and the original inventory", () => {
  const inventory = twoHouses();
  const before = structuredClone(inventory);
  const renamed = renameHouse(inventory, "lake", "  Mountain cabin  ");
  assert.deepEqual(renamed, {
    ...inventory,
    houses: [{ id: DEFAULT_HOUSE_ID, name: "My home" }, { id: "lake", name: "Mountain cabin" }],
  });
  assert.equal(validState(renamed), true);
  assert.deepEqual(inventory, before);
  assert.deepEqual(renameHouse(inventory, "lake", "Lake house"), inventory);
  assert.equal(renameHouse(inventory, "lake", "LAKE HOUSE").houses[1].name, "LAKE HOUSE");
  assert.equal(renameHouse(inventory, "lake", "x".repeat(80)).houses[1].name.length, 80);
});

test("house renaming rejects invalid names and missing houses without changing inventory", () => {
  const inventory = twoHouses();
  const before = structuredClone(inventory);
  for (const name of ["", "   ", "x".repeat(81)])
    assert.throws(() => renameHouse(inventory, "lake", name), /name/);
  assert.throws(() => renameHouse(inventory, "lake", " my HOME "), /already exists/);
  assert.throws(() => renameHouse(inventory, "missing", "New house"), /no longer exists/);
  assert.deepEqual(inventory, before);
});

test("legacy inventory can rename My home without changing room IDs or mutating the original", () => {
  const legacy = initialState();
  const before = structuredClone(legacy);
  const renamed = renameHouse(legacy, DEFAULT_HOUSE_ID, "Family home");
  assert.equal(validState(renamed), true);
  assert.deepEqual(renamed.houses, [{ id: DEFAULT_HOUSE_ID, name: "Family home" }]);
  assert.deepEqual(renamed.locations, withHouses(legacy).locations);
  assert.deepEqual(legacy, before);
});

test("house views isolate nested spaces, search, items, scans, and markers", () => {
  const inventory = twoHouses();
  assert.equal(validState(inventory), true);
  const home = inventoryForHouse(inventory, DEFAULT_HOUSE_ID);
  const lake = inventoryForHouse(inventory, "lake");
  assert.equal(validState(home), true);
  assert.equal(validState(lake), true);
  assert.deepEqual(lake.locations.map((location) => location.id), ["lake-room", "lake-box"]);
  assert.deepEqual(lake.items.map((item) => item.id), ["paddle"]);
  assert.deepEqual(lake.scans.map((scan) => scan.id), ["lake-scan"]);
  assert.deepEqual(lake.markers.map((marker) => marker.id), ["lake-pin"]);
  assert.equal(searchInventory(createIndex(home), "Paddle").total, 0);
  assert.equal(searchInventory(createIndex(lake), "Keys").total, 0);
  assert.equal(searchInventory(createIndex(lake), "Paddle").total, 1);
  assert.throws(() => inventoryForHouse(inventory, "missing"), /no longer exists/);
});

test("editing or emptying one house retains every other house and its scan files", () => {
  const inventory = twoHouses();
  const before = structuredClone(inventory);
  const lake = inventoryForHouse(inventory, "lake");
  const updated = replaceHouseInventory(inventory, "lake", {
    ...lake,
    locations: [...lake.locations, { id: "lake-shed", parentId: null, name: "Shed", description: "", color: "sage" }],
    items: lake.items.map((item) => ({ ...item, name: "Long paddle" })),
  });
  assert.equal(updated.locations.find((location) => location.id === "lake-shed").houseId, "lake");
  assert.equal(validState(updated), true);
  assert.deepEqual(inventoryForHouse(updated, DEFAULT_HOUSE_ID), inventoryForHouse(inventory, DEFAULT_HOUSE_ID));
  const emptied = replaceHouseInventory(updated, "lake", { ...lake, locations: [], items: [], scans: [], markers: [] });
  assert.equal(validState(emptied), true);
  assert.equal(emptied.houses.length, 2);
  assert.deepEqual(emptied.scans.map((scan) => scan.assetId), ["home-asset"]);
  assert.deepEqual(inventory, before);
});

test("backups reject invalid house metadata and ambiguous room ownership", () => {
  for (const change of [
    (inventory) => { inventory.houses = []; },
    (inventory) => { inventory.houses.push({ ...inventory.houses[0] }); },
    (inventory) => { inventory.houses[0].name = " "; },
    (inventory) => { inventory.houses[0].name = "x".repeat(81); },
    (inventory) => { inventory.houses[0].id = ""; },
    (inventory) => { inventory.locations[0].houseId = "missing"; },
    (inventory) => { delete inventory.locations[0].houseId; },
    (inventory) => { inventory.locations.find((location) => location.id === "drawer").houseId = "lake"; },
    (inventory) => { delete inventory.houses; },
  ]) {
    const inventory = twoHouses();
    change(inventory);
    assert.equal(validState(inventory), false);
  }
});

test("copying guest data preserves separate houses and remaps ownership and scan links", () => {
  const guest = twoHouses();
  const before = structuredClone(guest);
  let sequence = 0;
  const merged = mergeGuestInventory(twoHouses(), guest, () => `copy-${++sequence}`);
  assert.equal(validState(merged.inventory), true);
  assert.equal(merged.inventory.houses.length, 4);
  assert.equal(new Set(merged.inventory.houses.map((house) => house.name)).size, 4);
  assert.equal(merged.houseId, merged.inventory.houses[2].id);
  const copiedHome = inventoryForHouse(merged.inventory, merged.houseId);
  assert.deepEqual(copiedHome.items.map((item) => item.name), ["Keys"]);
  assert.notEqual(copiedHome.items[0].id, "keys");
  assert.equal(copiedHome.markers[0].targetId, copiedHome.items[0].id);
  assert.equal(merged.assets.size, 2);
  assert.deepEqual(guest, before);
});

test("cloud chunks and account caches retain the full collection and inactive assets", async () => {
  const inventory = renameHouse(twoHouses(), "lake", "Mountain cabin");
  const strings = encodeInventory(inventory);
  const decoded = decodeInventory(
    { snapshotId: "houses", chunkCount: strings.length },
    strings.map((payload, index) => ({ snapshotId: "houses", index, payload })),
  );
  assert.deepEqual(decoded, inventory);
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  let visible;
  const sync = new AccountSync({
    storage,
    remote: { watch: () => () => {}, publish: async () => 1 },
    replace: (next) => { visible = next; },
    delay: 100000,
  });
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(inventory);
  await sync.flush();
  assert.deepEqual([...sync.retainedAssetIds].sort(), ["home-asset", "lake-asset"]);
  assert.deepEqual(JSON.parse(storage.getItem(accountKey("alice"))).inventory, inventory);
  await sync.select("alice");
  assert.deepEqual(visible, inventory);
  await sync.select(null);
});
