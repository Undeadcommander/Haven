const queues = new Map();
const databaseName = "haven-inventory-write-locks";
const storeName = "locks";

function invoke(callback) {
  const result = callback();
  if (result && typeof result.then === "function")
    throw new TypeError("Inventory write lock callbacks must be synchronous.");
  return result;
}

function indexedDBLock(storageKey, callback) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);
    let settled = false;
    const fail = (error) => { settled = true; reject(error); };
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error("Inventory write lock database is blocked."));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      let transaction, result, callbackError;
      try {
        // Readwrite transactions on this store exclude other tabs until commit.
        // Run the localStorage check/write synchronously inside a request event,
        // while the transaction is active. Never await work inside this mutex.
        transaction = database.transaction(storeName, "readwrite");
        transaction.oncomplete = () => { database.close(); resolve(result); };
        transaction.onabort = transaction.onerror = () => {
          database.close();
          fail(callbackError || transaction.error || new Error("Inventory write lock transaction failed."));
        };
        const read = transaction.objectStore(storeName).get(storageKey);
        read.onsuccess = () => {
          try { result = invoke(callback); }
          catch (error) { callbackError = error; transaction.abort(); }
        };
      } catch (error) {
        database.close();
        fail(error);
      }
    };
  });
}

// Every writer of a localStorage inventory key must use this helper. The callback
// must synchronously compare, mutate and write; network I/O belongs outside it.
export async function withInventoryWriteLock(storageKey, callback) {
  if (typeof storageKey !== "string" || !storageKey || typeof callback !== "function")
    throw new TypeError("An inventory storage key and callback are required.");
  if (typeof window !== "undefined" || typeof self !== "undefined") {
    if (globalThis.navigator?.locks?.request)
      return globalThis.navigator.locks.request(`haven-inventory-write:${storageKey}`,
        { mode: "exclusive" }, () => invoke(callback));
    if (!globalThis.indexedDB)
      throw new Error("Safe inventory writes require Web Locks or IndexedDB. Storage is unavailable.");
    return indexedDBLock(storageKey, callback);
  }
  if (!globalThis.process?.versions?.node)
    throw new Error("Safe inventory writes require Web Locks or IndexedDB.");
  // Node unit tests have no competing browser contexts.
  const previous = queues.get(storageKey) || Promise.resolve();
  const task = previous.then(() => invoke(callback));
  const tail = task.catch(() => {});
  queues.set(storageKey, tail);
  try { return await task; }
  finally { if (queues.get(storageKey) === tail) queues.delete(storageKey); }
}
