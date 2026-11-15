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


test("photo crops start centered with a landscape frame inside the source", async () => {
  const { photoCrop } = await import("../src/photo-editor.js");
  assert.deepEqual(photoCrop(1600, 800), { x: 0, y: 0, width: 1600, height: 800 });
  assert.deepEqual(photoCrop(800, 1600), { x: 0, y: 600, width: 800, height: 400 });
  for (const [width, height] of [[1600, 800], [800, 1600], [1, 1], [5000, 30]]) {
    const crop = photoCrop(width, height);
    assert.ok(crop.x >= 0 && crop.y >= 0);
    assert.ok(crop.x + crop.width <= width);
    assert.ok(crop.y + crop.height <= height);
    assert.equal(crop.width / crop.height, 2);
  }
});

test("each crop handle resizes its edges and leaves the opposite edges anchored", async () => {
  const { adjustPhotoCrop } = await import("../src/photo-editor.js");
  const rect = { x: 100, y: 100, width: 600, height: 300 };
  for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
    const crop = adjustPhotoCrop(rect, handle, 25, 30, 1000, 500);
    assert.equal(crop.x, handle.includes("w") ? 125 : 100);
    assert.equal(crop.y, handle.includes("n") ? 130 : 100);
    assert.equal(crop.x + crop.width, handle.includes("e") ? 725 : 700);
    assert.equal(crop.y + crop.height, handle.includes("s") ? 430 : 400);
  }
});

test("crop handles cannot cross or leave the image, and moving preserves size", async () => {
  const { adjustPhotoCrop, photoCrop } = await import("../src/photo-editor.js");
  for (const [width, height] of [[1600, 800], [800, 1600], [1, 1], [5000, 30]]) {
    const rect = photoCrop(width, height);
    for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw", "move"]) {
      for (const dx of [-10000, 0, 10000]) for (const dy of [-10000, 0, 10000]) {
        const crop = adjustPhotoCrop(rect, handle, dx, dy, width, height);
        assert.ok(crop.x >= 0 && crop.y >= 0);
        assert.ok(crop.width > 0 && crop.height > 0);
        assert.ok(crop.x + crop.width <= width + .00001);
        assert.ok(crop.y + crop.height <= height + .00001);
        if (handle === "move") {
          assert.equal(crop.width, rect.width);
          assert.equal(crop.height, rect.height);
        }
      }
    }
  }
});
