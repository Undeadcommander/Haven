import { initialState, validState } from "./store.js";
import { withHouses, MAX_HOUSE_NAME_LENGTH } from "./houses.js";
import { deletionKey, isDeletingRecord } from "./delete-account-data.js";
import { withInventoryWriteLock } from "./inventory-write-lock.js";
export const accountKey = (uid) => `haven-account:${uid}`;
const scanAssets = (inventory) => [...new Set((inventory?.scans || []).map((scan) => scan.assetId))];

// Sync is transport-independent so races, retries and account isolation can be tested.
export class AccountSync {
  constructor({ storage, remote, replace, notify, delay = 700 }) {
    Object.assign(this, { storage, remote, replace, notify, delay });
    this.uid = null;
    this.generation = 0;
    this.status = "guest";
    this.record = null;
    this.cacheValue = null;
    this.timer = null;
    this.inFlight = null;
    this.remoteKnown = false;
    this.edit = 0;
    this.readSequence = 0;
  }
  signal(status, message = "") {
    this.status = status;
    this.message = message;
    this.notify?.();
  }
  cache(record = this.record, uid = this.uid) {
    // Low-level write: application callers must hold accountKey(uid)'s lock.
    const value = JSON.stringify(record);
    this.storage.setItem(accountKey(uid), value);
    if (uid === this.uid) this.cacheValue = value;
  }
  reconcileCache(change) {
    if (!this.uid || !this.record || this.status === "stale") return false;
    try {
      let next;
      if (change && (change.oldValue != null || change.newValue != null)) {
        const previous = change.oldValue === this.cacheValue ? this.record : JSON.parse(change.oldValue);
        next = JSON.parse(change.newValue);
        if (!previous || !next ||
            JSON.stringify(previous.inventory) !== JSON.stringify(next.inventory)) return false;
      }
      const value = this.storage.getItem(accountKey(this.uid));
      if (value === this.cacheValue) return true;
      const cached = next && value === change.newValue ? next : JSON.parse(value);
      if (!cached || !Number.isInteger(cached.revision) || cached.revision < this.record.revision ||
          typeof cached.dirty !== "boolean" ||
          JSON.stringify(cached.inventory) !== JSON.stringify(this.record.inventory)) return false;
      const baseAssets = this.record.dirty ? this.record.baseAssets : scanAssets(this.record.inventory);
      if (cached.dirty && (cached.revision !== this.record.revision ||
          JSON.stringify(cached.baseAssets) !== JSON.stringify(baseAssets))) return false;
      this.cacheValue = value;
      if (cached.revision > this.record.revision) {
        this.record = { ...cached, inventory: this.record.inventory };
        clearTimeout(this.timer);
        this.signal("synced", "Account is up to date");
      }
      return true;
    } catch {
      return false;
    }
  }
  ensureCurrentCache() {
    if (this.reconcileCache()) return true;
    this.pauseForExternalChange();
    return false;
  }
  pauseForExternalChange() {
    if (this.status === "stale") return;
    this.disconnect();
    this.signal("stale", "This account changed in another tab. Reload this tab before editing further.");
  }
  disconnect() {
    this.generation++;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingRemote = undefined;
    this.remoteKnown = false;
  }
  async select(uid) {
    this.disconnect();
    this.uid = uid;
    this.inFlight = null;
    this.conflictRecord = undefined;
    if (!uid) {
      this.record = null;
      this.cacheValue = null;
      this.signal("guest");
      return;
    }
    let cached;
    this.cacheValue = null;
    try {
      this.cacheValue = this.storage.getItem(accountKey(uid));
      cached = JSON.parse(this.cacheValue);
    } catch {}
    this.record =
      cached &&
      validState(cached.inventory) &&
      Number.isInteger(cached.revision) &&
      cached.revision >= 0
        ? cached
        : { inventory: initialState(), revision: 0, dirty: false };
    this.replace(this.record.inventory, uid);
    if (this.storage.getItem(deletionKey(uid))) {
      this.signal("deleting", "Account deletion is unfinished. Sync is paused; open Account to finish deletion.");
      return;
    }
    this.connect();
  }
  connect() {
    const generation = this.generation;
    this.signal("connecting", "Connecting to your account…");
    this.unsubscribe = this.remote.watch(
      this.uid,
      (record) => {
        if (generation === this.generation) return this.receive(record, generation);
      },
      (error) => {
        if (generation === this.generation) {
          this.remoteKnown = false;
          clearTimeout(this.timer);
          this.signal(
            "error",
            error.message ||
              "Could not connect. Changes remain on this device.",
          );
        }
      },
    );
  }
  currentScope(uid, generation) {
    return !!uid && uid === this.uid && generation === this.generation;
  }
  reportLockFailure(uid, generation, error) {
    if (!this.currentScope(uid, generation) || ["stale", "deleting"].includes(this.status)) return;
    clearTimeout(this.timer);
    this.remoteKnown = false;
    this.signal("error", error.message || "Could not safely access browser storage. Retry sync to reconnect.");
  }
  // Call only inside this account's inventory lock, immediately before a write
  // or a decision based on the durable cache. Auth may change while queued.
  writable(uid, generation) {
    if (!this.currentScope(uid, generation)) return false;
    if (this.status === "deleting" || this.storage.getItem(deletionKey(uid))) {
      this.disconnect();
      this.signal("deleting", "Account deletion is in progress. Editing and sync are paused.");
      return false;
    }
    return this.ensureCurrentCache() && this.currentScope(uid, generation);
  }
  async saveLocal(inventory, { isCurrent = () => true, onCommitted = () => {} } = {}) {
    const uid = this.uid, generation = this.generation;
    return withInventoryWriteLock(accountKey(uid), () => {
      if (!isCurrent()) {
        const error = typeof DOMException === "function"
          ? new DOMException("This edit is no longer current.", "AbortError")
          : Object.assign(new Error("This edit is no longer current."), { name: "AbortError" });
        throw error;
      }
      if (!this.currentScope(uid, generation))
        throw Error("The active account changed before this edit could be saved.");
      if (!this.writable(uid, generation)) throw Error(this.message);
      // Keep the last account version's files until this edit has been accepted.
      // Older dirty records without this list must defer garbage collection.
      const baseAssets = this.record.dirty ? this.record.baseAssets : scanAssets(this.record.inventory);
      const next = { ...this.record, inventory, dirty: true, baseAssets };
      this.cache(next);
      this.record = next;
      this.edit++;
      onCommitted();
      if (this.status !== "conflict")
        this.signal("pending", "Saved on this device · waiting to sync");
      this.schedule();
    });
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.uid && this.remoteKnown && !["conflict", "deleting", "stale"].includes(this.status))
      this.timer = setTimeout(() => this.flush(), this.delay);
  }
  async receive(remote, generation = this.generation) {
    const uid = this.uid;
    if (!this.currentScope(uid, generation)) return;
    let load;
    try {
      load = await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.currentScope(uid, generation)) return;
        if (isDeletingRecord(remote)) {
          // Deletion signals must also win over stale inventory observations.
          try { this.storage.setItem(deletionKey(uid), "pending"); }
          finally {
            this.disconnect();
            this.signal("deleting", "Account deletion has started. Editing and sync are paused.");
          }
          return;
        }
        if (!this.writable(uid, generation)) return;
        this.remoteKnown = true;
        if (this.inFlight) {
          this.pendingRemote = remote;
          return;
        }
        const sequence = ++this.readSequence;
        const revision = remote?.revision || 0;
        if (revision && revision < this.record.revision) return;
        if (revision === this.record.revision) {
          if (this.record.dirty) this.schedule();
          else this.signal("synced", "Account is up to date");
          return;
        }
        if (this.record.dirty) {
          this.conflictRecord = remote;
          this.signal("conflict", "Another device changed this inventory. Choose which version to keep.");
          return;
        }
        this.signal("connecting", "Loading your account inventory...");
        return { sequence, revision, edit: this.edit };
      });
      if (!load || !this.currentScope(uid, generation)) return;
      const inventory = remote ? await this.remote.read(uid, remote) : initialState();
      await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.currentScope(uid, generation) || load.sequence !== this.readSequence ||
            !this.writable(uid, generation)) return;
        if (load.edit !== this.edit || this.record.dirty) {
          this.conflictRecord = remote;
          this.signal("conflict", "Local and account changes need your review.");
          return;
        }
        if (!validState(inventory))
          throw Error("The account inventory could not be read. Your local copy is unchanged.");
        if (load.revision && load.revision < this.record.revision) return;
        const record = { inventory, revision: load.revision, dirty: false };
        this.cache(record, uid);
        this.record = record;
        this.replace(inventory, uid);
        this.signal("synced", "Account is up to date");
      });
    } catch (error) {
      await withInventoryWriteLock(accountKey(uid), () => {
        if (this.currentScope(uid, generation) && (!load || load.sequence === this.readSequence) &&
            this.writable(uid, generation))
          this.signal("error", error.message || "Could not load your account.");
      }).catch((failure) => this.reportLockFailure(uid, generation, failure));
    }
  }
  async flush() {
    const uid = this.uid, generation = this.generation;
    if (!uid) return;
    let upload;
    try {
      upload = await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.currentScope(uid, generation) || !this.record?.dirty || !this.remoteKnown ||
            ["conflict", "deleting", "stale"].includes(this.status) || this.inFlight ||
            !this.writable(uid, generation) || !this.record.dirty) return;
        const record = this.record, edit = this.edit;
        // Reserve the upload before releasing the mutex, without network I/O
        // inside the critical section. Other flushes/watch events see inFlight.
        let finish;
        const pending = new Promise((resolve) => { finish = resolve; });
        upload = { record, edit, pending, finish };
        this.inFlight = pending;
        this.signal("saving", "Saving to your account...");
        return upload;
      });
      if (!upload) return;
      if (!this.currentScope(uid, generation) || this.status === "deleting") return;
      const revision = await this.remote.publish(uid, upload.record.inventory, upload.record.revision);
      await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.writable(uid, generation) || revision < this.record.revision) return;
        const next = { ...this.record, revision, dirty: this.edit !== upload.edit,
          baseAssets: scanAssets(upload.record.inventory) };
        this.cache(next, uid);
        this.record = next;
        this.signal(next.dirty ? "pending" : "synced",
          next.dirty ? "New changes waiting to sync" : "Saved to your account");
      });
    } catch (error) {
      await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.writable(uid, generation)) return;
        if (error.code === "sync/conflict" && upload && this.record.revision > upload.record.revision &&
            error.remote?.revision <= this.record.revision) {
          this.signal(this.record.dirty ? "pending" : "synced",
            this.record.dirty ? "New changes waiting to sync" : "Account is up to date");
        } else if (error.code === "sync/conflict") {
          this.conflictRecord = error.remote;
          this.signal("conflict", "Another device saved changes first. Choose which version to keep.");
        } else {
          this.signal("error", error.message || "Sync failed. Your changes are saved on this device.");
        }
      }).catch((failure) => this.reportLockFailure(uid, generation, failure));
    } finally {
      // Release pauseForDeletion even if auth changed while the upload settled.
      upload?.finish();
      let pending;
      if (upload) await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.currentScope(uid, generation) || this.inFlight !== upload.pending) return;
        this.inFlight = null;
        pending = this.pendingRemote;
        this.pendingRemote = undefined;
        if (this.record?.dirty && this.status === "pending") this.schedule();
      }).catch((failure) => {
        if (this.currentScope(uid, generation) && this.inFlight === upload.pending) {
          this.inFlight = null;
          this.pendingRemote = undefined;
        }
        this.reportLockFailure(uid, generation, failure);
      });
      if (pending !== undefined) await this.receive(pending, generation);
    }
  }
  retry() {
    if (!this.uid || ["conflict", "deleting", "stale"].includes(this.status) || this.inFlight) return;
    // Recheck the server even for a clean local copy or a failed download.
    // Keep the current inventory and let receive() reconcile revisions before writing.
    this.disconnect();
    this.connect();
  }
  get retainedAssetIds() {
    if (!this.record || ["connecting", "deleting", "stale"].includes(this.status) ||
        (this.record.dirty && !Array.isArray(this.record.baseAssets))) return null;
    return new Set([...scanAssets(this.record.inventory),
      ...(this.record.dirty ? this.record.baseAssets : [])]);
  }
  async pauseForDeletion() {
    const pending = this.inFlight;
    this.disconnect();
    const generation = this.generation;
    this.signal("deleting", "Deleting your account · sync is paused");
    // A previously submitted write must settle before its documents are removed.
    try { await pending; } catch {}
    if (generation === this.generation) this.inFlight = null;
  }
  async resolve(choice) {
    const uid = this.uid, generation = this.generation;
    if (!uid) return;
    let resolution;
    try {
      resolution = await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.currentScope(uid, generation) || this.status !== "conflict" ||
            !this.writable(uid, generation) || this.status !== "conflict") return;
        // Preserve the rejected local inventory before either choice, under the
        // same account lock, so a stale resolver cannot overwrite recovery data.
        this.storage.setItem(`haven-recovery:${uid}`, JSON.stringify(this.record.inventory));
        if (choice === "local") {
          const next = { ...this.record, revision: this.conflictRecord?.revision || 0, dirty: true };
          // Keep baseAssets: the rejected version may still reference files that
          // are needed until the replacement has been accepted by the server.
          this.cache(next, uid);
          this.record = next;
          this.signal("pending", "Saving your chosen version...");
          return { local: true };
        }
        const pending = { remote: this.conflictRecord, edit: this.edit, sequence: ++this.readSequence };
        this.signal("connecting", "Loading your chosen account inventory...");
        return pending;
      });
      if (!resolution || !this.currentScope(uid, generation)) return;
      if (resolution.local) { await this.flush(); return; }
      const inventory = resolution.remote ? await this.remote.read(uid, resolution.remote) : initialState();
      await withInventoryWriteLock(accountKey(uid), () => {
        if (!this.writable(uid, generation) || resolution.sequence !== this.readSequence) return;
        if (resolution.edit !== this.edit || this.conflictRecord !== resolution.remote) {
          this.signal("conflict", "Local and account changes need your review.");
          return;
        }
        if (!validState(inventory))
          throw Error("The account inventory could not be read. Your local copy is unchanged.");
        const revision = resolution.remote?.revision || 0;
        if (revision < this.record.revision) return;
        const next = { inventory, revision, dirty: false };
        this.cache(next, uid);
        this.record = next;
        this.replace(inventory, uid);
        this.signal("synced", "Account is up to date");
      });
    } catch (error) {
      await withInventoryWriteLock(accountKey(uid), () => {
        if (this.writable(uid, generation) && (!resolution || resolution.sequence === this.readSequence))
          this.signal("error", error.message || "Could not resolve your account changes.");
      }).catch((failure) => this.reportLockFailure(uid, generation, failure));
    }
  }
}

export function mergeGuestInventory(
  account,
  guest,
  id = () => crypto.randomUUID(),
) {
  account = withHouses(account);
  guest = withHouses(guest);
  const houseIds = new Map(guest.houses.map((house) => [house.id, id()]));
  const names = new Set(account.houses.map((house) => house.name.toLowerCase()));
  const houses = guest.houses.map((house) => {
    let name = house.name, copy = 1;
    while (names.has(name.toLowerCase())) {
      const suffix = ` (device${copy === 1 ? "" : ` ${copy}`})`;
      name = house.name.slice(0, MAX_HOUSE_NAME_LENGTH - suffix.length) + suffix;
      copy++;
    }
    names.add(name.toLowerCase());
    return { ...house, id: houseIds.get(house.id), name };
  });
  const locations = new Map(guest.locations.map((l) => [l.id, id()])),
    items = new Map(guest.items.map((i) => [i.id, id()])),
    scans = new Map((guest.scans || []).map((s) => [s.id, id()])),
    assets = new Map((guest.scans || []).map((s) => [s.assetId, id()]));
  return {
    inventory: {
      ...account,
      houses: [...account.houses, ...houses],
      locations: [
        ...account.locations,
        ...guest.locations.map((l) => ({
          ...l,
          id: locations.get(l.id),
          ...(l.parentId === null ? { houseId: houseIds.get(l.houseId) } : {}),
          parentId: l.parentId === null ? null : locations.get(l.parentId),
        })),
      ],
      items: [
        ...account.items,
        ...guest.items.map((i) => ({
          ...i,
          id: items.get(i.id),
          locationId: locations.get(i.locationId),
        })),
      ],
      scans: [
        ...(account.scans || []),
        ...(guest.scans || []).map((s) => ({
          ...s,
          id: scans.get(s.id),
          assetId: assets.get(s.assetId),
          locationId: locations.get(s.locationId),
        })),
      ],
      markers: [
        ...(account.markers || []),
        ...(guest.markers || []).map((m) => ({
          ...m,
          id: id(),
          scanId: scans.get(m.scanId),
          targetId: (m.kind === "item" ? items : locations).get(m.targetId),
        })),
      ],
    },
    assets,
    houseId: houses[0].id,
  };
}
