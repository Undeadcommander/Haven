import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  validState,
  createIndex,
  descendants,
  searchInventory,
} from "../src/store.js";
test("nested location indexing and search preserve the exact item path", () => {
  const s = initialState();
  s.locations.push(
    {
      id: "drawer",
      parentId: "living-room",
      name: "Drawer",
      description: "",
      color: "sage",
    },
    {
      id: "box",
      parentId: "drawer",
      name: "Blue box",
      description: "",
      color: "blue",
    },
  );
  s.items.push({
    id: "keys",
    locationId: "box",
    name: "Keys",
    notes: "Spare car keys",
  });
  assert.equal(validState(s), true);
  const idx = createIndex(s);
  assert.equal(idx.search[0].path, "Living room / Drawer / Blue box");
  assert.match(idx.search[0].text, /spare car keys/);
  assert.equal(idx.summaries.get("living-room").count, 1);
  assert.equal(idx.summaries.get("living-room").preview[0].name, "Keys");
  assert.deepEqual([...descendants(idx, "drawer")], ["drawer", "box"]);
});

test("deep forest validation visits parents linearly and rejects disconnected cycles", () => {
  const state = { version: 1, locations: [], items: [] };
  let parentReads = 0;
  for (let i = 0; i < 10_000; i++) {
    state.locations.push({
      id: `node-${i}`, name: "Box", description: "", color: "sage",
      get parentId() { parentReads++; return i ? `node-${i - 1}` : null; },
    });
  }
  assert.equal(validState(state), true);
  assert.ok(parentReads < 20 * state.locations.length, "validation must not walk every ancestor for every node");
  const index = createIndex(state);
  assert.equal(index.path("node-9999").split(" / ").length, 10_000);
  assert.equal(index.contains("node-100", "node-9999"), true);
  assert.equal(index.contains("node-9999", "node-100"), false);
  state.locations.push(
    { id: "cycle-a", parentId: "cycle-b", name: "A", description: "", color: "sage" },
    { id: "cycle-b", parentId: "cycle-a", name: "B", description: "", color: "sage" },
  );
  assert.equal(validState(state), false);
});

test("search counts all matches, caps result allocation, and indexes locations and markers", () => {
  const state = initialState();
  state.items = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), name: `Book ${i}`, notes: "blue", locationId: "living-room",
  }));
  state.locations[0].description = "Blue book storage";
  state.scans = [{ id: "scan", assetId: "asset", locationId: "living-room", name: "Room", format: "obj" }];
  state.markers = [{ id: "pin", scanId: "scan", kind: "item", targetId: "99", position: [0, 0, 0] }];
  const index = createIndex(state);
  const result = searchInventory(index, " BLUE book ");
  assert.equal(result.total, 101);
  assert.equal(result.results.length, 30);
  assert.deepEqual(result.results.map((entry) => entry.item), state.items.slice(0, 30).map((item) => item.id));
  assert.equal(searchInventory(index, "storage").results[0].type, "folder");
  assert.deepEqual(searchInventory(index, "  "), { total: 0, results: [] });
  assert.equal(index.itemById.get("99"), state.items[99]);
  assert.equal(index.scanByLocation.get("living-room"), state.scans[0]);
  assert.equal(index.markersByScan.get("scan")[0], state.markers[0]);
  assert.equal(index.sortedLocations(), index.sortedLocations(), "reuse destination sorting within an index");
});
test("backup validation rejects cycles, orphan items, and duplicate IDs", () => {
  const s = initialState();
  s.locations[0].parentId = "living-room";
  assert.equal(validState(s), false);
  s.locations[0].parentId = null;
  s.items.push({ id: "a", name: "a", notes: "", locationId: "missing" });
  assert.equal(validState(s), false);
  s.items = [];
  s.locations.push({ ...s.locations[0] });
  assert.equal(validState(s), false);
});
test("location and item colors survive backups, with optional item colors for old inventories", () => {
  const state = initialState();
  const item = { id: "keys", name: "Keys", notes: "Description", locationId: "living-room" };
  state.items.push(item);
  assert.equal(validState(state), true);
  for (const color of ["sage", "sand", "blue", "rose", "mint", "lavender", "terracotta"]) {
    state.locations[0].color = color;
    item.color = color;
    assert.equal(validState(JSON.parse(JSON.stringify(state))), true);
  }
  item.color = "invalid";
  assert.equal(validState(state), false);
  delete item.color;
  state.locations[0].color = "invalid";
  assert.equal(validState(state), false);
});
