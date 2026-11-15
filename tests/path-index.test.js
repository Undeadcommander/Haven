import { test } from "node:test";
import assert from "node:assert/strict";
import { createIndex } from "../src/store.js";

test("deepest-first items cache intermediate paths instead of repeatedly traversing ancestors", () => {
  const depth = 1500;
  let parentReads = 0;
  const inventory = { version: 1, locations: [], items: [] };
  for (let position = 0; position < depth; position++) {
    inventory.locations.push({
      id: `location-${position}`, name: `Box ${position}`, description: "", color: "sage",
      get parentId() { parentReads++; return position === 0 ? null : `location-${position - 1}`; },
    });
    inventory.items.unshift({ id: `item-${position}`, name: "Keys", notes: "", locationId: `location-${position}` });
  }
  const index = createIndex(inventory);
  assert.equal(index.path(`location-${depth - 1}`).split(" / ").length, depth);
  assert.ok(parentReads < depth * 20, `${parentReads} parent reads for ${depth} locations`);
  assert.equal(index.path("missing"), "");
  assert.equal(index.search.length, depth);
});
