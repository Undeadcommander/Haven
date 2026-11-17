import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountSync, accountKey } from "../src/account-sync.js";
import {
  addHouse, inventoryForHouse, LAST_HOUSE_DELETE_MESSAGE, removeHouse,
  replaceHouseInventory, withHouses,
} from "../src/houses.js";
import { initialState, validState } from "../src/store.js";

function startedCall(object, method) {
  const original = object[method];
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  object[method] = function (...args) {
    object[method] = original;
    started();
    return original.apply(this, args);
  };
  return pending;
}

const uid = "house-delete-user";
const key = accountKey(uid);
const clone = (value) => structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function inventory() {
  const value = addHouse(initialState(), "Lake", "lake");
  value.locations.push({ id: "cabin", parentId: null, houseId: "lake", name: "Cabin", description: "", color: "sage" });
  value.items = ["living-room", "cabin"].map((locationId) => ({
    id: `item-${locationId}`, locationId, name: `Item ${locationId}`, notes: "Keep me",
  }));
  value.scans = ["living-room", "cabin"].map((locationId) => ({
    id: `scan-${locationId}`, locationId, assetId: `asset-${locationId}`, name: "room.obj", format: "obj",
  }));
  value.markers = value.scans.map((scan) => ({
    id: `pin-${scan.locationId}`, scanId: scan.id, kind: "item",
    targetId: `item-${scan.locationId}`, position: [0, 0, 0],
  }));
  assert.equal(validState(value), true);
  return value;
}

function storage(seed = inventory()) {
  const values = new Map([[key, JSON.stringify({ inventory: seed, revision: 1, dirty: false })]]);
  return {
    values, beforeWrite: null, failure: null,
    getItem: (name) => values.get(name) ?? null,
    setItem(name, value) {
      const hook = this.beforeWrite;
      this.beforeWrite = null;
      hook?.(name, value);
      if (this.failure && name === key) throw this.failure;
      values.set(name, value);
    },
  };
}

function remote() {
  return { watch: () => () => {}, read: async () => inventory(),
    publish: async (_uid, _inventory, revision) => revision + 1 };
}

async function tab(t, store, service = remote(), selectedUid = uid) {
  let visible;
  const sync = new AccountSync({ storage: store, remote: service,
    replace: (value) => { visible = value; }, delay: 60_000 });
  t.after(() => sync.disconnect());
  await sync.select(selectedUid);
  await sync.receive({ revision: 1 });
  return { sync, visible: () => visible };
}

test("the last house rejects both removal modes atomically, including legacy and empty inventories", () => {
  const populated = withHouses(initialState());
  populated.items = [{ id: "key", locationId: "living-room", name: "Keys", notes: "" }];
  populated.scans = [{ id: "scan", assetId: "scan-file", locationId: "living-room", name: "room.obj", format: "obj" }];
  populated.markers = [{ id: "pin", scanId: "scan", kind: "item", targetId: "key", position: [0, 0, 0] }];
  const legacy = clone(populated);
  delete legacy.houses;
  for (const room of legacy.locations) delete room.houseId;
  const empty = { version: 1, houses: [{ id: "empty", name: "Empty" }], locations: [], items: [] };
  for (const value of [populated, legacy, empty]) {
    const before = clone(value);
    for (const mode of ["move", "delete"]) {
      assert.throws(() => removeHouse(value, value.houses?.[0].id || "my-home", { mode }),
        { message: LAST_HOUSE_DELETE_MESSAGE });
      assert.deepEqual(value, before, "rooms, items, scans, pins and house identity must survive rejection");
      assert.equal(validState(value), true);
    }
  }
});

for (const firstId of ["my-home", "lake"]) for (const mode of ["delete", "move"]) {
  test(`queued event: deleting ${firstId} by ${mode} prevents a stale tab deleting the other of two houses`, async (t) => {
    const store = storage();
    const first = (await tab(t, store)).sync;
    const second = (await tab(t, store)).sync;
    const otherId = firstId === "my-home" ? "lake" : "my-home";
    // Both dialogs calculated their operations from the same two-house snapshot.
    const competing = removeHouse(second.record.inventory, otherId, { mode: "delete" });
    await first.saveLocal(removeHouse(first.record.inventory, firstId, { mode, destinationHouseId: otherId }));
    const durable = store.getItem(key);
    // No storage event has been dispatched to the second tab.
    await assert.rejects(() => second.saveLocal(competing), /another tab/);
    assert.equal(store.getItem(key), durable);
    assert.equal(second.status, "stale");
    assert.equal(second.retainedAssetIds, null);
    await second.select(uid);
    assert.throws(() => removeHouse(second.record.inventory, otherId, { mode: "delete" }),
      { message: LAST_HOUSE_DELETE_MESSAGE });
    assert.equal(store.getItem(key), durable);
    assert.equal(validState(JSON.parse(durable).inventory), true);
  });
}

test("overlapping write boundaries must not resurrect a house already deleted by the sibling", async (t) => {
  const store = storage();
  const first = (await tab(t, store)).sync;
  const second = (await tab(t, store)).sync;
  const removeHome = removeHouse(first.record.inventory, "my-home", { mode: "delete" });
  const removeLake = removeHouse(second.record.inventory, "lake", { mode: "delete" });
  let siblingSave, writes = 0;
  // Queue a competing save exactly after the first cache comparison, inside
  // setItem. It must wait for the first lock, then reject its obsolete snapshot.
  store.beforeWrite = () => {
    siblingSave = assert.rejects(() => second.saveLocal(removeLake), /another tab/);
    assert.equal(second.edit, 0, "the competing lock callback cannot run reentrantly");
    writes++;
  };
  await first.saveLocal(removeHome);
  const durable = store.getItem(key);
  await siblingSave;
  assert.equal(writes, 1);
  assert.equal(store.getItem(key), durable);
  assert.deepEqual(JSON.parse(durable).inventory, removeHome);
  assert.deepEqual(JSON.parse(durable).inventory.houses.map((house) => house.id), ["lake"]);
  assert.equal(second.status, "stale");
  assert.equal(second.edit, 0);
});

test("a pending deletion retains both scan bases through a failed local write and a failed acknowledgment cache write", async (t) => {
  const store = storage(), service = remote();
  const { sync } = await tab(t, store, service);
  const before = clone(sync.record), raw = store.getItem(key), edit = sync.edit;
  const removed = removeHouse(before.inventory, "my-home", { mode: "delete" });
  store.failure = Error("Quota exceeded");
  await assert.rejects(() => sync.saveLocal(removed), /Quota/);
  assert.deepEqual(sync.record, before);
  assert.equal(sync.edit, edit);
  assert.equal(store.getItem(key), raw);
  store.failure = null;
  await sync.saveLocal(removed);
  const pending = store.getItem(key);
  let committed;
  service.publish = async (_account, value) => {
    committed = clone(value);
    store.failure = Error("Acknowledgment quota exceeded");
    return 2;
  };
  await sync.flush();
  assert.deepEqual(committed, removed);
  assert.equal(sync.status, "error");
  assert.equal(sync.record.dirty, true);
  assert.equal(sync.record.revision, 1);
  assert.equal(store.getItem(key), pending);
  assert.deepEqual(new Set(sync.retainedAssetIds), new Set(["asset-living-room", "asset-cabin"]));
  store.failure = null;
});

test("an in-flight pre-deletion publish keeps active and inactive house edits pending until the deletion acknowledgment", async (t) => {
  const store = storage(), gate = deferred(), service = remote();
  service.publish = () => gate.promise;
  const { sync } = await tab(t, store, service);
  await sync.saveLocal(sync.record.inventory);
  const publishing = startedCall(sync.remote, "publish");  const upload = sync.flush();  await publishing;
  let next = sync.record.inventory;
  for (const houseId of ["my-home", "lake"]) {
    const slice = inventoryForHouse(next, houseId);
    slice.items = slice.items.map((item) => ({ ...item, notes: "Edited before deleting the other house" }));
    next = replaceHouseInventory(next, houseId, slice);
  }
  next = removeHouse(next, "my-home", { destinationHouseId: "lake" });
  await sync.saveLocal(next);
  gate.resolve(2);
  await upload;
  assert.equal(sync.record.dirty, true);
  assert.equal(sync.record.revision, 2);
  assert.deepEqual(sync.record.inventory, next);
  assert.deepEqual(new Set(sync.retainedAssetIds), new Set(["asset-living-room", "asset-cabin"]));
  service.publish = async (_account, value, revision) => {
    assert.equal(revision, 2);
    assert.deepEqual(value, next);
    return 3;
  };
  await sync.flush();
  assert.equal(sync.record.dirty, false);
  assert.ok(sync.record.inventory.items.every((item) => item.notes.startsWith("Edited")));
  assert.equal(sync.record.inventory.houses.length, 1);
});

test("a deletion made during a delayed pre-deletion download is not replaced by the older full inventory", async (t) => {
  const store = storage(), gate = deferred(), service = remote();
  service.read = () => gate.promise;
  const { sync, visible } = await tab(t, store, service);
  const before = visible();
  const reading = startedCall(sync.remote, "read");  const download = sync.receive({ revision: 2 });  await reading;
  const removed = removeHouse(sync.record.inventory, "lake", { mode: "delete" });
  await sync.saveLocal(removed);
  const durable = store.getItem(key);
  gate.resolve(inventory());
  await download;
  assert.equal(sync.status, "conflict");
  assert.equal(store.getItem(key), durable);
  assert.deepEqual(sync.record.inventory, removed);
  assert.equal(visible(), before, "AccountSync must not invoke replace with the old download");
  assert.deepEqual(new Set(sync.retainedAssetIds), new Set(["asset-living-room", "asset-cabin"]));
});

test("a house-deletion acknowledgment cannot cross account scope, including signing back into the same uid", async (t) => {
  const store = storage(), gate = deferred(), service = remote();
  service.publish = () => gate.promise;
  const { sync } = await tab(t, store, service);
  await sync.saveLocal(removeHouse(sync.record.inventory, "my-home", { mode: "delete" }));
  const pendingAlice = store.getItem(key);
  const publishing = startedCall(sync.remote, "publish");  const upload = sync.flush();  await publishing;
  const bobKey = accountKey("other-user");
  const bob = { inventory: withHouses(initialState()), revision: 8, dirty: false };
  store.setItem(bobKey, JSON.stringify(bob));
  await sync.select("other-user");
  assert.deepEqual(sync.record, bob);
  await sync.select(uid);
  gate.resolve(2);
  await upload;
  assert.equal(store.getItem(bobKey), JSON.stringify(bob));
  assert.equal(store.getItem(key), pendingAlice);
  assert.equal(sync.record.dirty, true);
  assert.equal(sync.record.revision, 1);
  assert.deepEqual(sync.record.baseAssets, ["asset-living-room", "asset-cabin"]);
  assert.throws(() => removeHouse(sync.record.inventory, "lake", { mode: "delete" }),
    { message: LAST_HOUSE_DELETE_MESSAGE });
});
