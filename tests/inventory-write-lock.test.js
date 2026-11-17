import { test } from "node:test";
import assert from "node:assert/strict";
import { withInventoryWriteLock } from "../src/inventory-write-lock.js";

function globals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
}

// Model the IndexedDB transaction lifecycle, including store-wide exclusion,
// active request events, commit and abort. No browser or in-tab mutex is used.
function indexedDBModel({ manualCommit = false, openError, blocked = false, transactionError, readError } = {}) {
  const transactions = [], waiting = [];
  let active, closed = 0, opened = 0;
  function advance() {
    if (active || !waiting.length) return;
    active = waiting.shift();
    const transaction = active;
    queueMicrotask(() => {
      transaction.active = true;
      if (readError) {
        transaction.error = readError;
        transaction.abort();
        return;
      }
      transaction.request.onsuccess();
      if (!manualCommit && transaction.active) queueMicrotask(() => transaction.commit());
    });
  }
  const database = {
    createObjectStore(name) { assert.equal(name, "locks"); },
    close() { closed++; },
    transaction(name, mode) {
      assert.equal(name, "locks");
      assert.equal(mode, "readwrite", "readonly would not exclude competing tabs");
      if (transactionError) throw transactionError;
      const transaction = {
        active: false,
        objectStore(store) {
          assert.equal(store, name);
          return { get(key) { transaction.key = key; return transaction.request = {}; } };
        },
        commit() {
          assert.equal(active, transaction);
          transaction.active = false;
          active = null;
          transaction.oncomplete();
          advance();
        },
        abort() {
          assert.equal(active, transaction);
          transaction.active = false;
          active = null;
          queueMicrotask(() => { transaction.onabort(); advance(); });
        },
      };
      transactions.push(transaction);
      waiting.push(transaction);
      advance();
      return transaction;
    },
  };
  return {
    transactions,
    get closed() { return closed; },
    get opened() { return opened; },
    get active() { return active; },
    open(name, version) {
      opened++;
      assert.equal(name, "haven-inventory-write-locks");
      assert.equal(version, 1);
      const request = { result: database, error: openError };
      queueMicrotask(() => {
        if (openError) request.onerror();
        else if (blocked) { request.onblocked(); queueMicrotask(() => request.onsuccess()); }
        else { request.onupgradeneeded(); request.onsuccess(); }
      });
      return request;
    },
  };
}

test("Node queues synchronous callbacks by full storage key and survives callback failure", async () => {
  const order = [];
  let competing;
  const first = withInventoryWriteLock("haven-account:alice", () => {
    order.push("first");
    competing = withInventoryWriteLock("haven-account:alice", () => order.push("second"));
    assert.deepEqual(order, ["first"]);
    throw Error("Quota");
  });
  await assert.rejects(first, /Quota/);
  await competing;
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(await withInventoryWriteLock("haven-inventory", () => 42), 42);
});

test("Web Locks use an exclusive lock named from the entire localStorage key", async (t) => {
  const requests = [];
  globals(t, { window: {}, navigator: { locks: {
    request(name, options, callback) {
      return new Promise((resolve, reject) => requests.push({ name, options, run() {
        try { resolve(callback()); } catch (error) { reject(error); }
      } }));
    },
  } } });
  let called = 0;
  const alice = withInventoryWriteLock("haven-account:alice", () => ++called);
  const bob = withInventoryWriteLock("haven-account:bob", () => ++called);
  const guest = withInventoryWriteLock("haven-inventory", () => ++called);
  assert.equal(called, 0);
  assert.deepEqual(requests.map(({ name }) => name), [
    "haven-inventory-write:haven-account:alice", "haven-inventory-write:haven-account:bob",
    "haven-inventory-write:haven-inventory",
  ]);
  for (const request of requests) {
    assert.deepEqual(request.options, { mode: "exclusive" });
    request.run();
  }
  assert.deepEqual(await Promise.all([alice, bob, guest]), [1, 2, 3]);
});

test("IndexedDB excludes independent tab modules until the readwrite transaction commits", async (t) => {
  const database = indexedDBModel({ manualCommit: true });
  globals(t, { window: {}, navigator: {}, indexedDB: database });
  const tabOne = await import("../src/inventory-write-lock.js?tab-one");
  const tabTwo = await import("../src/inventory-write-lock.js?tab-two");
  let checked, entered;
  const checking = new Promise((resolve) => { checked = resolve; });
  const entering = new Promise((resolve) => { entered = resolve; });
  const order = [];
  const first = tabOne.withInventoryWriteLock("haven-inventory", () => {
    assert.equal(database.active.active, true);
    order.push("first check/write");
    checked();
    return "saved";
  });
  const second = tabTwo.withInventoryWriteLock("haven-inventory", () => {
    assert.equal(database.active.active, true);
    order.push("second check/write");
    entered();
  });
  let firstSettled = false;
  first.then(() => { firstSettled = true; });
  await checking;
  assert.deepEqual(order, ["first check/write"]);
  assert.equal(firstSettled, false, "lock promise waits for transaction completion");
  assert.deepEqual(database.transactions.map((transaction) => transaction.key), ["haven-inventory", "haven-inventory"]);
  database.transactions[0].commit();
  assert.equal(await first, "saved");
  await entering;
  database.transactions[1].commit();
  await second;
  assert.deepEqual(order, ["first check/write", "second check/write"]);
  assert.equal(database.closed, 2);
});

test("IndexedDB abort releases the mutex and propagates the original write error", async (t) => {
  const database = indexedDBModel();
  globals(t, { window: {}, navigator: {}, indexedDB: database });
  const error = Error("Quota exceeded");
  const failed = withInventoryWriteLock("haven-account:alice", () => { throw error; });
  const next = withInventoryWriteLock("haven-account:alice", () => "next save");
  await assert.rejects(failed, (caught) => caught === error);
  assert.equal(await next, "next save");
  assert.equal(database.closed, 2);
});

for (const failure of ["open", "blocked", "transaction", "read"]) {
  test(`browser IndexedDB ${failure} failure never runs an unsafe in-process fallback`, async (t) => {
    const error = Error(`${failure} failed`);
    const database = indexedDBModel({
      openError: failure === "open" ? error : undefined,
      blocked: failure === "blocked",
      transactionError: failure === "transaction" ? error : undefined,
      readError: failure === "read" ? error : undefined,
    });
    globals(t, { window: {}, navigator: {}, indexedDB: database });
    let called = false;
    await assert.rejects(withInventoryWriteLock("haven-inventory", () => { called = true; }),
      failure === "blocked" ? /blocked/ : (caught) => caught === error);
    assert.equal(called, false);
  });
}

test("a rejected Web Lock request fails closed without switching backends", async (t) => {
  const database = indexedDBModel(), error = Error("Web Locks denied");
  globals(t, { window: {}, indexedDB: database, navigator: { locks: {
    request: async () => { throw error; },
  } } });
  await assert.rejects(withInventoryWriteLock("haven-inventory", () => assert.fail("unsafe write")),
    (caught) => caught === error);
  assert.equal(database.opened, 0);
});

for (const surface of ["window", "self"]) {
  test(`${surface} contexts without Web Locks and IndexedDB fail closed`, async (t) => {
    globals(t, { [surface]: {}, navigator: {}, indexedDB: undefined });
    await assert.rejects(withInventoryWriteLock("haven-inventory", () => assert.fail("unsafe write")),
      /Web Locks or IndexedDB/);
  });
}

test("lock callbacks cannot return asynchronous work", async () => {
  await assert.rejects(withInventoryWriteLock("haven-inventory", () => Promise.resolve()), /must be synchronous/);
  assert.equal(await withInventoryWriteLock("haven-inventory", () => "released"), "released");
});
