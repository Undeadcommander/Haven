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
export async function getAsset(id, scope = activeScope) {
  let blob = await transaction("readonly", (s) => s.get(key(id, scope)));
  return blob;
}
export const putAsset = (id, blob, scope = activeScope) =>
  transaction("readwrite", (s) => s.put(blob, key(id, scope)));
export const deleteAsset = (id, scope = activeScope) =>
  transaction("readwrite", (s) => s.delete(key(id, scope)));
export const deleteAssets = (ids, scope = activeScope) => ids.length
  ? transaction("readwrite", (store) => {
      for (const id of ids) store.delete(key(id, scope));
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
      if (typeof entry.key === "string" && entry.key.startsWith(`${uid}:`))
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
// Stage under new IDs so a failed restore never overwrites the active inventory's files.
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
  const rollback = () => deleteAssets(created, scope);
  try {
    const validate = inventory.scans?.length
      ? (await import("./scan-model.js")).validateScanAsset : null;
    for (const scan of inventory.scans || []) {
      const data = assets.get(scan.assetId);
      if (!data || !/^data:[\w/+.-]*;base64,[A-Za-z0-9+/=]*$/.test(data))
        throw Error("A scan file is missing or invalid in this backup.");
      const encoded = data.slice(data.indexOf(",") + 1);
      if (encoded.length > 45_000_000)
        throw Error("A scan in this backup exceeds the 30 MB limit.");
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      if (bytes.byteLength > 30_000_000)
        throw Error("A scan in this backup is too large.");
      const blob = new Blob([bytes]);
      // Use the same parser and geometry checks as normal scan import, before
      // any inventory can be replaced. Validation does not create a renderer.
      await validate(blob, scan.format);
      scan.assetId = crypto.randomUUID();
      await putAsset(scan.assetId, blob, scope);
      created.push(scan.assetId);
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
