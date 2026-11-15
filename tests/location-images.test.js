import test from "node:test";
import assert from "node:assert/strict";
import { initialState, validState } from "../src/store.js";
import { encodeInventory, decodeInventory } from "../src/firestore-inventory.js";
import { itemImageChoices } from "../src/location-images.js";

test("item images accept item presets and photos, reject unsafe sources, and survive sync", () => {
  const state = initialState();
  state.items.push({ id: "keys", name: "Keys", notes: "", locationId: "living-room" });
  for (const image of [undefined, null, ...itemImageChoices.map(([id]) => id), "data:image/jpeg;base64,/9j/AA=="]) {
    if (image === undefined) delete state.items[0].image;
    else state.items[0].image = image;
    assert.equal(validState(state), true);
    const payloads = encodeInventory(state);
    assert.deepEqual(decodeInventory({ chunkCount: payloads.length, snapshotId: "test" },
      payloads.map((payload, index) => ({ payload, index, snapshotId: "test" }))), state);
  }
  for (const image of ["bedroom", "wardrobe", "https://example.com/image.jpg", 'data:image/svg+xml,<svg/>', {}, "data:image/jpeg;base64," + "a".repeat(180_000)]) {
    state.items[0].image = image;
    assert.equal(validState(state), false);
  }
});

test("location images validate and survive account snapshot encoding", () => {
  const state = initialState();
  assert.equal(validState(state), true);
  for (const image of [null, "bedroom", "garage", "bathroom", "box", "data:image/jpeg;base64,/9j/AA=="]) {
    state.locations[0].image = image;
    assert.equal(validState(state), true);
    const payloads = encodeInventory(state);
    assert.deepEqual(decodeInventory({ chunkCount: payloads.length, snapshotId: "test" },
      payloads.map((payload, index) => ({ payload, index, snapshotId: "test" }))), state);
  }
  for (const image of ["unknown", "https://example.com/photo.jpg", 'data:image/svg+xml,<svg/>', {}, "data:image/jpeg;base64," + "a".repeat(180_000)]) {
    state.locations[0].image = image;
    assert.equal(validState(state), false);
  }
});


test("photo crops keep a landscape frame inside the source at every zoom and position", async () => {
  const { photoCrop } = await import("../src/photo-editor.js");
  assert.deepEqual(photoCrop(1600, 800), { x: 0, y: 0, width: 1600, height: 800 });
  assert.deepEqual(photoCrop(800, 1600), { x: 0, y: 600, width: 800, height: 400 });
  assert.deepEqual(photoCrop(1600, 800, { zoom: 2, x: 1, y: 0 }), { x: 800, y: 0, width: 800, height: 400 });
  assert.deepEqual(photoCrop(1600, 800, { zoom: 2, x: -1, y: 2 }), { x: 0, y: 400, width: 800, height: 400 });
  for (const [width, height] of [[1600, 800], [800, 1600], [1, 1], [5000, 30]]) {
    for (const zoom of [0, 1, 1.5, 3, 4]) {
      for (const x of [0, .5, 1]) for (const y of [0, .5, 1]) {
        const crop = photoCrop(width, height, { zoom, x, y });
        assert.ok(crop.x >= 0 && crop.y >= 0);
        assert.ok(crop.x + crop.width <= width + .00001);
        assert.ok(crop.y + crop.height <= height + .00001);
        assert.equal(crop.width / crop.height, 2);
      }
    }
  }
});
