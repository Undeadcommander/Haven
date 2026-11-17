import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountSync, accountKey } from "../src/account-sync.js";
import { initialState } from "../src/store.js";

async function controller(t) {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const sync = new AccountSync({ storage, delay: 60_000, replace() {}, notify() {}, remote: {
    watch: () => () => {}, read: async () => initialState(), publish: async () => 1,
  } });
  t.after(() => sync.select(null));
  await sync.select("alice");
  await sync.receive(null);
  return { sync, storage };
}

function rejectLocks(t, successful = 0, customRequest = null) {
  const previous = new Map(["window", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let calls = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    async request(_name, _options, callback) {
      if (customRequest) return customRequest(callback);
      if (calls++ < successful) return callback();
      throw Error("Write lock unavailable");
    },
  } } });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

test("a failed background download lock reports an error without rejecting or changing durable data", async (t) => {
  const { sync, storage } = await controller(t);
  const before = storage.getItem(accountKey("alice"));
  rejectLocks(t);
  await assert.doesNotReject(sync.receive({ revision: 2 }));
  assert.equal(sync.status, "error");
  assert.match(sync.message, /lock unavailable/);
  assert.equal(storage.getItem(accountKey("alice")), before);
});

for (const successful of [0, 1]) {
  test(`a failed ${successful ? "acknowledgment" : "upload"} lock releases pending sync and preserves the dirty cache`, async (t) => {
    const { sync, storage } = await controller(t);
    await sync.saveLocal({ ...initialState(), items: [{ id: "keys", name: "Keys", notes: "", locationId: "living-room" }] });
    const before = storage.getItem(accountKey("alice"));
    rejectLocks(t, successful);
    await assert.doesNotReject(sync.flush());
    assert.equal(sync.status, "error");
    assert.equal(sync.inFlight, null);
    assert.equal(sync.record.dirty, true);
    assert.equal(storage.getItem(accountKey("alice")), before);
  });
}

test("a failed conflict-resolution lock preserves the dirty cache and reports the failure", async (t) => {
  const { sync, storage } = await controller(t);
  await sync.saveLocal(initialState());
  await sync.receive({ revision: 2 });
  assert.equal(sync.status, "conflict");
  const before = storage.getItem(accountKey("alice"));
  rejectLocks(t);
  await assert.doesNotReject(sync.resolve("cloud"));
  assert.equal(sync.status, "error");
  assert.equal(storage.getItem(accountKey("alice")), before);
  assert.equal(storage.getItem("haven-recovery:alice"), null);
});

test("a mutex abort after reserving an upload cannot strand inFlight or account deletion", async (t) => {
  const { sync } = await controller(t);
  await sync.saveLocal(initialState());
  let first = true;
  rejectLocks(t, 0, (callback) => {
    const result = callback();
    if (first) { first = false; throw Error("Transaction aborted after reservation"); }
    return result;
  });
  await assert.doesNotReject(sync.flush());
  assert.equal(sync.status, "error");
  assert.equal(sync.inFlight, null);
  assert.equal(sync.record.dirty, true);
  await sync.pauseForDeletion();
  assert.equal(sync.status, "deleting");
});
