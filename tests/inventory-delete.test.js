import { test } from "node:test";
import assert from "node:assert/strict";
import { removeItem, removeLocation } from "../src/inventory-delete.js";
import { initialState, createIndex, searchInventory, validState } from "../src/store.js";

function fixture() {
  const state = initialState();
  for (const [id, parentId, name] of [
    ["office", null, "Office"], ["cabinet", "living-room", "Cabinet"],
    ["drawer", "cabinet", "Drawer"], ["box", "drawer", "Box"],
    ["shelf", "living-room", "Shelf"], ["closet", "office", "Closet"],
  ]) state.locations.push({ id, parentId, name, description: "", color: "sage" });
  state.items = [
    ["lamp", "living-room"], ["book", "cabinet"], ["keys", "box"],
    ["vase", "shelf"], ["coat", "closet"],
  ].map(([id, locationId]) => ({ id, locationId, name: id, notes: "" }));
  state.scans = ["living-room", "cabinet", "drawer", "office"].map((locationId) => ({
    id: `scan-${locationId}`, assetId: `asset-${locationId}`, locationId, name: "scan.obj", format: "obj",
  }));
  state.markers = [
    ["old-cabinet", "living-room", "container", "cabinet"],
    ["old-keys", "living-room", "item", "keys"],
    ["old-lamp", "living-room", "item", "lamp"],
    ["cabinet-drawer", "cabinet", "container", "drawer"],
    ["cabinet-book", "cabinet", "item", "book"],
    ["cabinet-keys", "cabinet", "item", "keys"],
    ["drawer-keys", "drawer", "item", "keys"],
    ["office-coat", "office", "item", "coat"],
  ].map(([id, scan, kind, targetId]) => ({ id, scanId: `scan-${scan}`, kind, targetId, position: [1, 2, 3] }));
  assert.equal(validState(state), true);
  return state;
}
const ids = (records) => records.map((record) => record.id);
const parent = (state, id) => state.locations.find((location) => location.id === id)?.parentId;
const place = (state, id) => state.items.find((item) => item.id === id)?.locationId;

test("moving contents preserves nested parents and internal pins while updating search and counts", () => {
  const state = fixture(), snapshot = structuredClone(state);
  const next = removeLocation(state, "living-room", { mode: "move", destinationId: "office" });
  assert.deepEqual(state, snapshot);
  assert.equal(parent(next, "cabinet"), "office");
  assert.equal(parent(next, "shelf"), "office");
  assert.equal(parent(next, "drawer"), "cabinet");
  assert.equal(parent(next, "box"), "drawer");
  assert.equal(place(next, "lamp"), "office");
  assert.equal(place(next, "keys"), "box");
  assert.deepEqual(ids(next.scans), ["scan-cabinet", "scan-drawer", "scan-office"]);
  assert.deepEqual(ids(next.markers), ["cabinet-drawer", "cabinet-book", "cabinet-keys", "drawer-keys", "office-coat"]);
  assert.equal(validState(next), true);
  const index = createIndex(next);
  assert.equal(index.path("box"), "Office / Cabinet / Drawer / Box");
  assert.equal(index.search.find((entry) => entry.id === "keys").path, index.path("box"));
  assert.equal(index.summaries.get("office").count, 5);
  assert.equal(searchInventory(index, "keys").total, 1);
});

test("independent branch and item overrides preserve only pins inside each moved group", () => {
  const state = fixture(), snapshot = structuredClone(state);
  const next = removeLocation(state, "living-room", {
    mode: "move", destinationId: "office",
    containerDestinations: new Map([["drawer", "closet"], ["shelf", "cabinet"]]),
    itemDestinations: new Map([["book", "drawer"], ["vase", "closet"]]),
  });
  assert.deepEqual(state, snapshot);
  assert.equal(parent(next, "cabinet"), "office");
  assert.equal(parent(next, "drawer"), "closet");
  assert.equal(parent(next, "box"), "drawer");
  assert.equal(parent(next, "shelf"), "cabinet");
  assert.equal(place(next, "book"), "drawer");
  assert.equal(place(next, "vase"), "closet");
  assert.deepEqual(ids(next.markers), ["drawer-keys", "office-coat"]);
  assert.equal(validState(next), true);
  const index = createIndex(next);
  assert.equal(index.path("box"), "Office / Closet / Drawer / Box");
  assert.equal(index.search.find((entry) => entry.id === "book").path, "Office / Closet / Drawer");
  assert.equal(index.summaries.get("closet").count, 4);
});

test("invalid moves and overrides fail atomically, including self and cross cycles", () => {
  const state = fixture(), snapshot = structuredClone(state);
  const cases = [
    ["missing", { destinationId: "office" }],
    ["living-room", { mode: "unknown", destinationId: "office" }],
    ["living-room", { destinationId: null }],
    ["living-room", { destinationId: "missing" }],
    ["living-room", { destinationId: "living-room" }],
    ["living-room", { destinationId: "office", containerDestinations: new Map([["office", "closet"]]) }],
    ["living-room", { destinationId: "office", containerDestinations: new Map([["living-room", "office"]]) }],
    ["living-room", { destinationId: "office", itemDestinations: new Map([["coat", "office"]]) }],
    ["living-room", { destinationId: "office", itemDestinations: new Map([["missing", "office"]]) }],
    ["living-room", { destinationId: "office", itemDestinations: new Map([["keys", "missing"]]) }],
    ["living-room", { destinationId: "office", containerDestinations: new Map([["drawer", "drawer"]]) }],
    ["living-room", { destinationId: "office", containerDestinations: new Map([["cabinet", "drawer"]]) }],
    ["living-room", { destinationId: "office", containerDestinations: new Map([["cabinet", "shelf"], ["shelf", "cabinet"]]) }],
  ];
  for (const [id, options] of cases) {
    assert.throws(() => removeLocation(state, id, options), undefined, JSON.stringify([id, [...(options.containerDestinations || [])]]));
    assert.deepEqual(state, snapshot);
  }
});

test("delete removes the complete subtree and broken scan links, leaving unrelated data searchable", () => {
  const state = fixture(), snapshot = structuredClone(state);
  const next = removeLocation(state, "cabinet", { mode: "delete" });
  assert.deepEqual(state, snapshot);
  assert.deepEqual(ids(next.locations), ids(state.locations).filter((id) => !["cabinet", "drawer", "box"].includes(id)));
  assert.deepEqual(ids(next.items), ["lamp", "vase", "coat"]);
  assert.deepEqual(ids(next.scans), ["scan-living-room", "scan-office"]);
  assert.deepEqual(ids(next.markers), ["old-lamp", "office-coat"]);
  assert.equal(validState(next), true);
  const index = createIndex(next);
  assert.equal(index.summaries.get("living-room").count, 2);
  assert.equal(index.summaries.get("office").count, 1);
  assert.equal(searchInventory(index, "keys").total, 0);
  assert.equal(searchInventory(index, "coat").total, 1);
});

test("removing an item prunes its pins, preserves other data, and rejects missing items", () => {
  const state = fixture(), snapshot = structuredClone(state);
  const next = removeItem(state, "keys");
  assert.deepEqual(state, snapshot);
  assert.deepEqual(ids(next.items), ["lamp", "book", "vase", "coat"]);
  assert.deepEqual(ids(next.markers), ["old-cabinet", "old-lamp", "cabinet-drawer", "cabinet-book", "office-coat"]);
  assert.deepEqual(next.scans, state.scans);
  assert.equal(validState(next), true);
  assert.equal(searchInventory(createIndex(next), "keys").total, 0);
  assert.throws(() => removeItem(state, "missing"), /no longer exists/);
  assert.deepEqual(state, snapshot);
});

test("empty and last rooms can be removed without destinations or optional scan metadata", () => {
  const state = initialState();
  state.locations = state.locations.filter((location) => location.id === "living-room");
  state.items = [];
  delete state.scans;
  delete state.markers;
  const snapshot = structuredClone(state);
  const next = removeLocation(state, "living-room", { mode: "move" });
  assert.deepEqual(state, snapshot);
  assert.deepEqual(next.locations, []);
  assert.deepEqual(next.items, []);
  assert.deepEqual(next.scans, []);
  assert.deepEqual(next.markers, []);
  assert.equal(validState(next), true);
  assert.equal(searchInventory(createIndex(next), "anything").total, 0);
  const deleted = removeLocation(state, "living-room", { mode: "delete" });
  assert.deepEqual(deleted.locations, []);
  assert.equal(validState(deleted), true);
});

