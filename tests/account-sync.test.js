import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountSync,
  accountKey,
  mergeGuestInventory,
} from "../src/account-sync.js";
import { initialState, validState } from "../src/store.js";
const storage = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) || null,
    setItem: (k, v) => map.set(k, v),
  };
};
const edited = (name) => ({
  ...initialState(),
  items: [{ id: "key", name, notes: "", locationId: "living-room" }],
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function controller(remote, store = storage()) {
  let visible;
  const sync = new AccountSync({
    storage: store,
    remote,
    replace: (s) => {
      visible = s;
    },
    notify() {},
    delay: 100000,
  });
  return { sync, store, visible: () => visible };
}
const baseRemote = () => ({
  watch: () => () => {},
  read: async () => initialState(),
  publish: async (_uid, _inventory, revision) => revision + 1,
});

test("equivalent account cache echoes do not count as external inventory changes", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Keys"));
  const pending = structuredClone(sync.record);
  store.setItem(accountKey("alice"), JSON.stringify(pending));
  assert.equal(sync.reconcileCache(), true);
  assert.deepEqual(sync.record, pending);
  store.setItem(accountKey("alice"), JSON.stringify({ ...pending, revision: 1, dirty: false, baseAssets: [] }));
  assert.equal(sync.reconcileCache(), true);
  assert.equal(sync.record.revision, 1);
  assert.equal(sync.record.dirty, false);
  assert.deepEqual(sync.record.inventory, pending.inventory);
  sync.saveLocal(edited("More keys"));
  assert.equal(sync.record.inventory.items[0].name, "More keys");
  await sync.select(null);
});

test("different, missing, unreadable, and invalid account caches remain external changes", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  await sync.receive(null);
  const original = structuredClone(sync.record);
  for (const value of [
    JSON.stringify({ ...original, inventory: edited("Other tab keys") }),
    "null",
    "not json",
    JSON.stringify({ ...original, inventory: { ...original.inventory, items: null } }),
    JSON.stringify({ ...original, revision: -1 }),
    JSON.stringify({ ...original, dirty: "false" }),
  ]) {
    store.setItem(accountKey("alice"), value);
    assert.equal(sync.reconcileCache(), false);
    assert.deepEqual(sync.record, original);
  }
  await sync.select(null);
});

test("queued genuine inventory transitions cannot be hidden by a later equal cache", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  await sync.receive(null);
  const original = { ...sync.record, revision: 1 };
  store.setItem(accountKey("alice"), JSON.stringify(original));
  assert.equal(sync.reconcileCache(), true);
  const intermediate = { ...original, inventory: edited("Temporary sibling edit"), dirty: true };
  const latest = { ...original, revision: 2, dirty: true, baseAssets: ["retained-file"] };
  store.setItem(accountKey("alice"), JSON.stringify(latest));
  assert.equal(sync.reconcileCache({ oldValue: JSON.stringify(original), newValue: JSON.stringify(intermediate) }), false);
  assert.equal(sync.reconcileCache({ oldValue: JSON.stringify(intermediate), newValue: JSON.stringify(latest) }), false);
  assert.throws(() => sync.saveLocal(edited("Must not replace retention")), /another tab/);
  assert.deepEqual(JSON.parse(store.getItem(accountKey("alice"))), latest);
  assert.equal(sync.status, "stale");
  assert.equal(sync.retainedAssetIds, null);
  await sync.select(null);
});

test("cloud watch delivery before a queued equivalent acknowledgment does not manufacture a conflict", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Already accepted"));
  store.setItem(accountKey("alice"), JSON.stringify({ ...sync.record, revision: 1, dirty: false }));
  await sync.receive({ revision: 1 });
  assert.equal(sync.status, "synced");
  assert.equal(sync.record.revision, 1);
  assert.equal(sync.record.dirty, false);
  await sync.select(null);
});

test("dirty cache metadata cannot drop the pending account asset base", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  sync.record = { ...sync.record, dirty: true, baseAssets: ["retained-file"] };
  sync.cache();
  const replacement = { ...sync.record, baseAssets: [] };
  store.setItem(accountKey("alice"), JSON.stringify(replacement));
  assert.equal(sync.reconcileCache(), false);
  assert.deepEqual(sync.record.baseAssets, ["retained-file"]);
  await sync.select(null);
});

test("a sibling edit stops a delayed download before it can overwrite the durable cache", async () => {
  const store = storage(), pending = deferred();
  store.setItem(accountKey("alice"), JSON.stringify({ inventory: initialState(), revision: 1, dirty: false }));
  const writer = controller(baseRemote(), store).sync;
  const { sync, visible } = controller({ ...baseRemote(), read: () => pending.promise }, store);
  await writer.select("alice");
  await sync.select("alice");
  const download = sync.receive({ revision: 2 });
  writer.saveLocal(edited("New sibling room contents"));
  const saved = store.getItem(accountKey("alice"));
  pending.resolve(initialState());
  await download;
  assert.equal(store.getItem(accountKey("alice")), saved);
  assert.equal(sync.status, "stale");
  assert.equal(visible().items.length, 0);
  sync.retry();
  assert.equal(sync.remoteKnown, false);
  writer.saveLocal(edited("Another save without reloading"));
  await sync.select("alice");
  assert.equal(visible().items[0].name, "Another save without reloading");
  await writer.select(null);
  await sync.select(null);
});

test("an old publish acknowledgment cannot overwrite a sibling pending edit", async () => {
  const store = storage(), pending = deferred();
  store.setItem(accountKey("alice"), JSON.stringify({ inventory: edited("Initial"), revision: 1, dirty: true, baseAssets: [] }));
  const { sync } = controller({ ...baseRemote(), publish: () => pending.promise }, store);
  const writer = controller(baseRemote(), store).sync;
  await sync.select("alice");
  await sync.receive({ revision: 1 });
  await writer.select("alice");
  const upload = sync.flush();
  writer.saveLocal(edited("New sibling edit"));
  const saved = store.getItem(accountKey("alice"));
  pending.resolve(2);
  await upload;
  assert.equal(store.getItem(accountKey("alice")), saved);
  assert.equal(sync.status, "stale");
  await writer.select(null);
  await sync.select(null);
});

test("a verified equivalent acknowledgment advances the base of an overlapping conflicted upload", async () => {
  const pending = deferred(), remote = baseRemote();
  remote.publish = () => pending.promise;
  const { sync, store } = controller(remote);
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Accepted equivalent inventory"));
  const upload = sync.flush();
  const oldValue = store.getItem(accountKey("alice"));
  const newValue = JSON.stringify({ ...sync.record, revision: 1, dirty: false });
  store.setItem(accountKey("alice"), newValue);
  assert.equal(sync.reconcileCache({ oldValue, newValue }), true);
  sync.saveLocal(edited("New edit after acknowledgment"));
  pending.reject(Object.assign(Error("Already published"), { code: "sync/conflict", remote: { revision: 1 } }));
  await upload;
  assert.equal(sync.status, "pending");
  assert.equal(sync.record.revision, 1);
  remote.publish = async (_uid, inventory, revision) => {
    assert.equal(revision, 1);
    assert.equal(inventory.items[0].name, "New edit after acknowledgment");
    return 2;
  };
  await sync.flush();
  assert.equal(sync.status, "synced");
  await sync.select(null);
});

test("late older acknowledgments cannot rewind a reconciled revision or asset base", async () => {
  const pending = deferred();
  const { sync, store } = controller({ ...baseRemote(), publish: () => pending.promise });
  const scanned = (assetId) => ({ ...initialState(), scans: [{ id: "scan", assetId, locationId: "living-room", name: "Room", format: "obj" }] });
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(scanned("old-file"));
  const upload = sync.flush();
  sync.saveLocal(scanned("new-file"));
  store.setItem(accountKey("alice"), JSON.stringify({ ...sync.record, revision: 2, dirty: false }));
  assert.equal(sync.reconcileCache(), true);
  sync.saveLocal(initialState());
  const saved = store.getItem(accountKey("alice"));
  pending.resolve(1);
  await upload;
  assert.equal(store.getItem(accountKey("alice")), saved);
  assert.equal(sync.record.revision, 2);
  assert.deepEqual(sync.record.baseAssets, ["new-file"]);
  await sync.select(null);
});

test("pending scan removals retain the account base across reload and concurrent upload edits", async () => {
  const inventory = edited("Keys");
  inventory.scans = [{ id: "scan", assetId: "old-file", locationId: "living-room", name: "room", format: "obj" }];
  const pending = deferred(), remote = { ...baseRemote(), read: async () => inventory, publish: () => pending.promise };
  const { sync, store } = controller(remote);
  await sync.select("alice");
  await sync.receive({ revision: 1 });
  sync.saveLocal(edited("Keys"));
  assert.deepEqual([...sync.retainedAssetIds], ["old-file"]);
  const reloaded = controller(remote, store).sync;
  await reloaded.select("alice");
  await reloaded.receive({ revision: 1 });
  // Until the pending version is reconciled, cleanup is conservatively paused.
  assert.equal(reloaded.retainedAssetIds, null);
  assert.deepEqual(reloaded.record.baseAssets, ["old-file"]);
  await reloaded.select(null);
  const upload = sync.flush();
  const next = edited("Edited during upload");
  next.scans = [{ ...inventory.scans[0], assetId: "new-file" }];
  sync.saveLocal(next);
  pending.resolve(2);
  await upload;
  assert.deepEqual([...sync.retainedAssetIds], ["new-file"]);
  await sync.select(null);
});
test("successful sync stores revision and clears dirty only after remote commit", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Keys"));
  assert.equal(sync.record.dirty, true);
  await sync.flush();
  assert.equal(sync.record.revision, 1);
  assert.equal(sync.record.dirty, false);
  assert.equal(
    JSON.parse(store.getItem(accountKey("alice"))).inventory.items[0].name,
    "Keys",
  );
  await sync.select(null);
});
test("failed cloud upload keeps edits and allows explicit retry", async () => {
  const remote = baseRemote();
  remote.publish = async () => {
    throw Error("Offline");
  };
  const { sync } = controller(remote);
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Offline item"));
  await sync.flush();
  assert.equal(sync.status, "error");
  assert.equal(sync.record.dirty, true);
  remote.publish = async () => 1;
  await sync.flush();
  assert.equal(sync.status, "synced");
  await sync.select(null);
});
test("stale cloud reads cannot replace a different account or edits made during download", async () => {
  const pending = deferred(),
    remote = baseRemote();
  remote.read = () => pending.promise;
  const { sync, visible } = controller(remote);
  await sync.select("alice");
  const load = sync.receive({ revision: 1 });
  await sync.select("bob");
  pending.resolve(edited("Alice private"));
  await load;
  assert.equal(sync.uid, "bob");
  assert.equal(visible().items.length, 0);
  await sync.select(null);
});
for (const choice of ["local", "cloud"]) {
  test(`a ${choice} choice for an already settled conflict preserves the accepted revision`, async () => {
    const store = storage();
    const inventory = edited("Accepted by the other tab");
    store.setItem(accountKey("alice"), JSON.stringify({ inventory, revision: 1, dirty: true, baseAssets: [] }));
    let remoteRevision = 2;
    const attempts = [];
    const remote = {
      ...baseRemote(),
      publish: async (_uid, _inventory, revision) => {
        attempts.push(revision);
        if (revision !== remoteRevision)
          throw Object.assign(Error("CAS conflict"), { code: "sync/conflict", remote: { revision: remoteRevision } });
        return ++remoteRevision;
      },
    };
    const first = controller(remote, store).sync;
    const sibling = controller(remote, store).sync;
    try {
      await first.select("alice");
      await sibling.select("alice");
      await first.receive({ revision: 2 });
      await sibling.receive({ revision: 2 });
      assert.equal(first.status, "conflict");
      await sibling.resolve("local");
      const acceptedCache = store.getItem(accountKey("alice"));
      const recovery = JSON.stringify(edited("Earlier recovery copy"));
      store.setItem("haven-recovery:alice", recovery);

      await first.resolve(choice);

      assert.equal(first.status, "synced");
      assert.equal(first.record.revision, 3);
      assert.equal(first.record.dirty, false);
      assert.equal(store.getItem(accountKey("alice")), acceptedCache);
      assert.equal(store.getItem("haven-recovery:alice"), recovery);
      assert.deepEqual(attempts, [2]);
      first.saveLocal(edited("Next edit after resolution"));
      await first.flush();
      assert.equal(first.status, "synced");
      assert.equal(first.record.revision, 4);
      assert.deepEqual(attempts, [2, 3]);
    } finally {
      await first.select(null);
      await sibling.select(null);
    }
  });
}

test("conflicting edits require a choice and preserve a recovery copy", async () => {
  const { sync, store, visible } = controller({
    ...baseRemote(),
    read: async () => edited("Cloud version"),
  });
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Device version"));
  await sync.receive({ revision: 2 });
  assert.equal(sync.status, "conflict");
  assert.equal(sync.record.inventory.items[0].name, "Device version");
  await sync.resolve("cloud");
  assert.equal(visible().items[0].name, "Cloud version");
  assert.equal(
    JSON.parse(store.getItem("haven-recovery:alice")).items[0].name,
    "Device version",
  );
  await sync.select(null);
});
test("edits made during upload stay pending and subsequent upload uses new revision", async () => {
  const pending = deferred(),
    remote = baseRemote();
  remote.publish = () => pending.promise;
  const { sync } = controller(remote);
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("First"));
  const upload = sync.flush();
  sync.saveLocal(edited("Second"));
  pending.resolve(1);
  await upload;
  assert.equal(sync.record.dirty, true);
  assert.equal(sync.record.revision, 1);
  assert.equal(sync.record.inventory.items[0].name, "Second");
  remote.publish = async (_uid, inventory, revision) => {
    assert.equal(revision, 1);
    assert.equal(inventory.items[0].name, "Second");
    return 2;
  };
  await sync.flush();
  assert.equal(sync.record.dirty, false);
  await sync.select(null);
});
test("own watch notification arriving before commit acknowledgement does not create a false conflict", async () => {
  const pending = deferred(),
    remote = baseRemote();
  remote.publish = () => pending.promise;
  const { sync } = controller(remote);
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Own change"));
  const upload = sync.flush();
  await sync.receive({ revision: 1 });
  pending.resolve(1);
  await upload;
  assert.equal(sync.status, "synced");
  await sync.select(null);
});
test("copying guest data remaps all links and never replaces the account inventory", () => {
  const guest = edited("Guest key");
  guest.locations.push({
    id: "box",
    parentId: "living-room",
    name: "Box",
    description: "",
    color: "sage",
  });
  guest.scans = [
    {
      id: "scan",
      assetId: "asset",
      locationId: "living-room",
      name: "Room",
      format: "obj",
    },
  ];
  guest.markers = [
    {
      id: "pin",
      scanId: "scan",
      kind: "item",
      targetId: "key",
      position: [0, 1, 0],
    },
    {
      id: "box-pin",
      scanId: "scan",
      kind: "container",
      targetId: "box",
      position: [1, 1, 0],
    },
  ];
  let id = 0;
  const { inventory, assets } = mergeGuestInventory(
    edited("Account key"),
    guest,
    () => `new-${++id}`,
  );
  assert.equal(validState(inventory), true);
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.items[0].name, "Account key");
  assert.notEqual(inventory.items[1].id, "key");
  assert.equal(inventory.markers[0].targetId, inventory.items[1].id);
  assert.equal(assets.size, 1);
  assert.equal(guest.items[0].id, "key");
});

test('a slower older download cannot replace a newer account revision',async()=>{
 const first=deferred(),second=deferred();const {sync,visible}=controller({...baseRemote(),read:async(_uid,record)=>record.revision===1?first.promise:second.promise});
 await sync.select('alice');const one=sync.receive({revision:1}),two=sync.receive({revision:2});second.resolve(edited('Newest'));await two;first.resolve(edited('Older'));await one;
 assert.equal(visible().items[0].name,'Newest');assert.equal(sync.record.revision,2);await sync.select(null);
});

test("retry checks the server even when there are no local changes", async () => {
  const remote = baseRemote();
  const listeners = [];
  let stopped = 0;
  remote.watch = (_uid, value, error) => {
    listeners.push({ value, error });
    return () => stopped++;
  };
  remote.read = async () => edited("From another device");
  const { sync, visible } = controller(remote);
  try {
    await sync.select("alice");
    await sync.receive(null);
    sync.retry();
    assert.equal(listeners.length, 2);
    assert.equal(stopped, 1);
    await listeners[1].value(null);
    assert.equal(sync.status, "synced");
    listeners[1].error(Error("Connection lost"));
    sync.retry();
    assert.equal(listeners.length, 3);
    await listeners[2].value({ revision: 1 });
    assert.equal(sync.status, "synced");
    assert.equal(visible().items[0].name, "From another device");
    listeners[0].error(Error("Stale error"));
    assert.equal(sync.status, "synced");
  } finally {
    await sync.select(null);
  }
});

test("retry recovers a failed download without claiming the cached version is synced", async () => {
  const remote = baseRemote();
  let onValue;
  remote.watch = (_uid, value) => {
    onValue = value;
    return () => {};
  };
  remote.read = async () => { throw Error("Download failed"); };
  const { sync, visible } = controller(remote);
  try {
    await sync.select("alice");
    await sync.receive({ revision: 1 });
    assert.equal(sync.status, "error");
    remote.read = async () => edited("Recovered item");
    sync.retry();
    assert.equal(sync.remoteKnown, false);
    await onValue({ revision: 1 });
    assert.equal(sync.status, "synced");
    assert.equal(visible().items[0].name, "Recovered item");
  } finally {
    await sync.select(null);
  }
});

test("retry preserves pending edits and waits for the server revision before upload", async () => {
  const remote = baseRemote();
  let onValue;
  remote.watch = (_uid, value) => {
    onValue = value;
    return () => {};
  };
  remote.publish = async () => { throw Error("Offline"); };
  const { sync, store } = controller(remote);
  try {
    await sync.select("alice");
    await sync.receive(null);
    sync.saveLocal(edited("Unsaved keys"));
    await sync.flush();
    sync.retry();
    assert.equal(sync.remoteKnown, false);
    assert.equal(sync.record.dirty, true);
    assert.equal(JSON.parse(store.getItem(accountKey("alice"))).inventory.items[0].name, "Unsaved keys");
    await onValue({ revision: 2 });
    assert.equal(sync.status, "conflict");
    assert.equal(sync.record.inventory.items[0].name, "Unsaved keys");
  } finally {
    await sync.select(null);
  }
});

test("retry during an upload does not interrupt or duplicate the commit", async () => {
  const pending = deferred(), remote = baseRemote();
  let uploads = 0;
  remote.publish = () => { uploads++; return pending.promise; };
  const { sync } = controller(remote);
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Keys"));
  const upload = sync.flush();
  sync.retry();
  assert.equal(sync.status, "saving");
  assert.equal(uploads, 1);
  pending.resolve(1);
  await upload;
  assert.equal(sync.status, "synced");
  assert.equal(sync.record.dirty, false);
  await sync.select(null);
});

test("deletion pauses pending uploads and survives a reload without restoring cloud data", async () => {
  const remote = baseRemote(), pending = deferred();
  remote.publish = () => pending.promise;
  const { sync, store } = controller(remote);
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("To delete"));
  const upload = sync.flush();
  store.setItem("haven-deleting:alice", "pending");
  const pause = sync.pauseForDeletion();
  assert.equal(sync.status, "deleting");
  assert.throws(() => sync.saveLocal(edited("Cannot restore")), /deletion/);
  pending.resolve(1);
  await Promise.all([pause, upload]);
  assert.equal(sync.status, "deleting");
  sync.retry();
  assert.equal(sync.remoteKnown, false);
  await sync.select("alice");
  assert.equal(sync.status, "deleting");
  await sync.select(null);
});

test("deletion started on another device stops this device from uploading", async () => {
  const { sync, store } = controller(baseRemote());
  await sync.select("alice");
  await sync.receive(null);
  sync.saveLocal(edited("Pending"));
  await sync.receive({ revision: 1, snapshotId: "deleting-test" });
  assert.equal(sync.status, "deleting");
  assert.equal(store.getItem("haven-deleting:alice"), "pending");
  assert.equal(sync.remoteKnown, false);
  await sync.select(null);
});
