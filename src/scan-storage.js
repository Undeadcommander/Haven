let database;
function open() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const req = indexedDB.open("haven-room-scans", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("assets");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(
          Error(
            "Scan storage is unavailable. Allow browser storage and try again.",
          ),
        );
    }).catch((error) => {
      database = null;
      throw error;
    });
  return database;
}
async function transaction(mode, operation) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("assets", mode),
      request = operation(tx.objectStore("assets"));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () =>
      reject(
        Error(
          "Could not save the scan. Browser storage may be full or unavailable.",
        ),
      );
  });
}
let activeScope = null;
export const setAssetScope = (scope) => {
  activeScope = scope;
};
export const getAssetScope = () => activeScope;
const key = (id, scope) => (scope ? `${scope}:${id}` : id);
// Array keys cannot collide with the string keys used for scan files.
const ownerKey = (id, scope) => ["backup-owner", key(id, scope)];
export async function getAsset(id, scope = activeScope) {
  let blob = await transaction("readonly", (s) => s.get(key(id, scope)));
  return blob;
}
export const putAsset = (id, blob, scope = activeScope) =>
  transaction("readwrite", (s) => {
    s.delete(ownerKey(id, scope));
    return s.put(blob, key(id, scope));
  });
export const deleteAsset = (id, scope = activeScope) =>
  transaction("readwrite", (s) => {
    s.delete(ownerKey(id, scope));
    return s.delete(key(id, scope));
  });
export const deleteAssets = (ids, scope = activeScope) => ids.length
  ? transaction("readwrite", (store) => {
      for (const id of ids) {
        store.delete(ownerKey(id, scope));
        store.delete(key(id, scope));
      }
    })
  : Promise.resolve();

// The caller commits inventory metadata only after every copy has succeeded.
export async function copyAssets(assets, fromScope, toScope) {
  const created = [];
  const rollback = () => deleteAssets(created, toScope);
  try {
    for (const [oldId, newId] of assets) {
      const blob = await getAsset(oldId, fromScope);
      if (!blob) throw Error("A device scan is missing. Restore its backup before copying.");
      await putAsset(newId, blob, toScope);
      created.push(newId);
    }
    return { rollback };
  } catch (error) {
    try { await rollback(); }
    catch { throw Error(`${error.message} Copied files could not be cleaned up; browser storage is unavailable.`); }
    throw error;
  }
}
export const deleteAccountAssets = (uid) => {
  if (!uid) throw Error("An account is required to remove account scans.");
  return transaction("readwrite", (store) => {
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if ((typeof entry.key === "string" && entry.key.startsWith(`${uid}:`)) ||
          (Array.isArray(entry.key) && entry.key[0] === "backup-owner" &&
            entry.key[1].startsWith(`${uid}:`)))
        store.delete(entry.key);
      entry.continue();
    };
  });
};
const toDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
export const MAX_BACKUP_BYTES = 250_000_000;
function decodeAsset(data) {
  if (!data || !/^data:[\w/+.-]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw Error("A scan file is missing or invalid in this backup.");
  const start = data.indexOf(",") + 1;
  const length = data.length - start;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (length % 4 === 1 || (padding && length % 4 !== 0))
    throw Error("A scan file is missing or invalid in this backup.");
  const size = Math.floor(length * 3 / 4) - padding;
  if (size > 30_000_000)
    throw Error("A scan in this backup exceeds the 30 MB limit.");
  const bytes = new Uint8Array(size);
  // Decode complete base64 groups into one destination buffer. Avoid a
  // full-size binary string and Uint8Array.from's intermediate number array.
  const chunkSize = 32_768;
  let offset = 0;
  for (let i = start; i < data.length; i += chunkSize) {
    const chunk = atob(data.slice(i, i + chunkSize));
    for (let j = 0; j < chunk.length; j++) bytes[offset++] = chunk.charCodeAt(j);
  }
  return new Blob([bytes]);
}
export async function createBackupBlob(inventory, scope = activeScope) {
  // Blob parts allow each asset's base64/JSON strings to be collected before
  // encoding the next file. Never stringify the full backup a second time.
  const parts = [new Blob([
    '{"format":"haven-backup","version":2,"inventory":',
    JSON.stringify(inventory), ',"assets":[',
  ])];
  let size = parts[0].size + 2;
  const seen = new Set();
  const checkSize = (bytes) => {
    if (bytes > MAX_BACKUP_BYTES)
      throw Error("This backup exceeds the 250 MB restore limit. Remove some scans after keeping separate copies of their original files.");
  };
  checkSize(size);
  for (const scan of inventory.scans || []) {
    if (seen.has(scan.assetId)) continue;
    const blob = await getAsset(scan.assetId, scope);
    if (!blob)
      throw Error(
        `The scan “${scan.name}” is missing. Re-import it or remove it before exporting a full backup.`,
      );
    // Base64 alone already establishes this lower bound before allocating it.
    checkSize(size + 4 * Math.ceil(blob.size / 3));
    const part = new Blob([
      seen.size ? "," : "",
      JSON.stringify({ id: scan.assetId, data: await toDataURL(blob) }),
    ]);
    size += part.size;
    checkSize(size);
    parts.push(part);
    seen.add(scan.assetId);
  }
  parts.push("]}");
  return new Blob(parts, { type: "application/json" });
}
// Compare in bounded chunks, keeping the readwrite transaction alive so the
// comparison and insert are atomic with respect to other tabs and restores.
async function sameBytes(a, b) {
  if (!(a instanceof Blob) || a.size !== b.size) return false;
  const chunk = 1_048_576;
  for (let offset = 0; offset < a.size; offset += chunk) {
    const [left, right] = await Promise.all([
      a.slice(offset, offset + chunk).arrayBuffer(),
      b.slice(offset, offset + chunk).arrayBuffer(),
    ]);
    const x = new Uint8Array(left), y = new Uint8Array(right);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
async function stageAsset(id, blob, scope, owner) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("assets", "readwrite"), store = tx.objectStore("assets");
    let created = false, failure;
    tx.oncomplete = () => resolve(created);
    tx.onabort = tx.onerror = () => reject(failure || Error("Could not save the scan. Browser storage may be full or unavailable."));
    const request = store.get(key(id, scope));
    request.onsuccess = () => {
      const existing = request.result;
      if (existing === undefined) {
        store.add(blob, key(id, scope));
        store.put(owner, ownerKey(id, scope));
        created = true;
        return;
      }
      let comparison;
      const keepAlive = () => {
        if (comparison) {
          if (comparison.error || !comparison.matches) {
            failure = comparison.error || Error("A scan file ID already exists with different content. Restore cannot overwrite it.");
            tx.abort();
          } else {
            // A later restore depends on this file; disarm earlier rollback.
            store.delete(ownerKey(id, scope));
          }
          return;
        }
        const next = store.get(ownerKey(id, scope));
        next.onsuccess = keepAlive;
      };
      keepAlive();
      sameBytes(existing, blob).then((matches) => {
        comparison = { matches };
      }).catch((error) => { comparison = { error }; });
    };
  });
}
async function rollbackStaged(created, scope, owner) {
  if (!created.length) return;
  await transaction("readwrite", (store) => {
    for (const id of created) {
      const request = store.get(ownerKey(id, scope));
      request.onsuccess = () => {
        if (request.result === owner) {
          store.delete(key(id, scope));
          store.delete(ownerKey(id, scope));
        }
      };
    }
  });
}
export async function stageBackup(backup, scope = activeScope) {
  const inventory = structuredClone(backup.inventory),
    created = [];
  const assets = new Map();
  for (const asset of backup.assets) {
    if (!asset || typeof asset.id !== "string" || typeof asset.data !== "string")
      throw Error("A scan file is missing or invalid in this backup.");
    if (assets.has(asset.id) && assets.get(asset.id) !== asset.data)
      throw Error("This backup contains conflicting copies of a scan file.");
    assets.set(asset.id, asset.data);
  }
  const owner = crypto.randomUUID();
  const rollback = () => rollbackStaged(created, scope, owner);
  try {
    const validate = inventory.scans?.length
      ? (await import("./scan-model.js")).validateScanAsset : null;
    const staged = new Set();
    for (const scan of inventory.scans || []) {
      const data = assets.get(scan.assetId);
      const blob = decodeAsset(data);
      // Use the same parser and geometry checks as normal scan import, before
      // any inventory can be replaced. Validation does not create a renderer.
      await validate(blob, scan.format);
      if (!staged.has(scan.assetId)) {
        if (await stageAsset(scan.assetId, blob, scope, owner)) created.push(scan.assetId);
        staged.add(scan.assetId);
      }
    }
    return {
      inventory,
      rollback,
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}
