import { test as base, expect } from "@playwright/test";
import { initialState, validState } from "../src/store.js";
import { addHouse, LAST_HOUSE_DELETE_MESSAGE, removeHouse, withHouses } from "../src/houses.js";

const uid = "house-sync-user";
const accountKey = `haven-account:${uid}`;
const copy = (value) => structuredClone(value);
function startingInventory() {
  const value = addHouse(initialState(), "Lake", "lake");
  value.locations.push({ id: "cabin", parentId: null, houseId: "lake", name: "Cabin", description: "", color: "sage" });
  value.items = ["living-room", "cabin"].map((locationId) => ({
    id: `item-${locationId}`, locationId, name: `Item ${locationId}`, notes: "Keep me",
  }));
  value.scans = ["living-room", "cabin"].map((locationId) => ({
    id: `scan-${locationId}`, assetId: `asset-${locationId}`, locationId, name: "room.obj", format: "obj",
  }));
  value.markers = value.scans.map((scan) => ({
    id: `pin-${scan.locationId}`, scanId: scan.id, kind: "item",
    targetId: `item-${scan.locationId}`, position: [0, 0, 0],
  }));
  return value;
}
const firebaseService = "export " + async function createFirebaseService() {
  return {
    watchAuth(callback) {
      window.__houseAuth = callback;
      queueMicrotask(() => callback({ uid: "house-sync-user", displayName: "House sync user" }));
      return () => {};
    },
    watch(account, callback, failed) {
      let active = true;
      window.__houseDeliver = (value) => active && callback(value);
      window.__houseRpc({ op: "watch", uid: account }).then((value) => active && callback(value)).catch(failed);
      return () => { active = false; };
    },
    async read(account, metadata) { return (await window.__houseRpc({ op: "read", uid: account, metadata })).inventory; },
    async publish(account, inventory, revision) {
      const result = await window.__houseRpc({ op: "publish", uid: account, inventory, revision });
      if (result.error) throw Object.assign(Error(result.error), result);
      return result.revision;
    },
    async login() {}, async logout() { await window.__houseAuth(null); },
  };
}.toString();

async function createSession(browser, baseURL, { account = false, inventory = startingInventory(), count = 2 } = {}) {
  const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const remote = { inventory: copy(inventory), revision: 1, log: [], hold: null };
  const pages = [], errors = [], blocked = [];
  const origin = new URL(baseURL).origin;
  await context.exposeBinding("__houseRpc", async ({ page }, request) => {
    if (request.uid !== uid) throw Error("Unexpected mocked account");
    const entry = { tab: pages.indexOf(page), ...copy(request) };
    remote.log.push(entry);
    if (request.op === "watch") return { revision: remote.revision };
    if (request.op === "read") return { inventory: copy(remote.inventory) };
    if (request.op !== "publish") throw Error("Unexpected mocked operation");
    if (request.revision !== remote.revision)
      return { error: "CAS conflict", code: "sync/conflict", remote: { revision: remote.revision } };
    remote.inventory = copy(request.inventory);
    const revision = ++remote.revision;
    entry.committedRevision = revision;
    if (remote.hold) await remote.hold;
    entry.acknowledged = true;
    return { revision };
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blocked.push(url.href); return route.abort("blockedbyclient"); }
    if (url.pathname === "/src/firebase-config.json") return route.fulfill({
      contentType: "application/javascript", body: account
        ? 'export default {apiKey:"mock",authDomain:"mock.invalid",projectId:"mock",appId:"mock"};'
        : 'export default {enabled:false};',
    });
    if (url.pathname === "/src/firebase-service.js") return route.fulfill({ contentType: "application/javascript", body: firebaseService });
    if (url.pathname === "/src/account.js") {
      const response = await route.fetch();
      const source = (await response.text()).replaceAll("\r\n", "\n");
      const anchor = "  return {\n    bind()";
      const cleanupAnchor = "const nextExpiry = await reconcileAssets(";
      expect(source.split(anchor)).toHaveLength(2);
      expect(source.split(cleanupAnchor)).toHaveLength(2);
      return route.fulfill({ response, body: source
        .replace(cleanupAnchor, "const nextExpiry = await window.__houseReconcile(")
        .replace(anchor, "  sync.delay = 60_000;\n" +
          "  window.__houseCleanupCount = 0;\n" +
          "  window.__houseReconcile = (...args) => {\n" +
          "    window.__houseCleanupCount++;\n" +
          "    return window.__houseCleanupPromise = reconcileAssets(...args);\n" +
          "  };\n  return window.__houseAccount = {\n    bind()") });
    }
    return route.continue();
  });
  await context.addInitScript(({ inventory, key }) => {
    if (!localStorage.getItem("haven-inventory")) localStorage.setItem("haven-inventory", JSON.stringify(inventory));
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ inventory, revision: 1, dirty: false }));
    const queued = [], listen = window.addEventListener;
    window.__houseHoldEvents = false;
    window.__houseQueued = 0;
    window.addEventListener = function (type, listener, options) {
      if (type !== "storage") return listen.call(this, type, listener, options);
      return listen.call(this, type, (event) => {
        if (window.__houseHoldEvents) { queued.push(() => listener.call(this, event)); window.__houseQueued++; }
        else listener.call(this, event);
      }, options);
    };
    window.__houseReleaseEvents = () => {
      window.__houseHoldEvents = false;
      for (const deliver of queued.splice(0)) deliver();
    };
  }, { inventory, key: accountKey });
  try {
    for (let i = 0; i < count; i++) {
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/");
      await page.waitForFunction((signedIn) => window.__houseAccount?.ready &&
        (!signedIn || window.__houseAccount.sync.remoteKnown), account);
    }
    return { context, pages, first: pages[0], second: pages[1], remote, errors, blocked,
      key: account ? accountKey : "haven-inventory" };
  } catch (error) { await context.close(); throw error; }
}

const test = base.extend({
  session: async ({ browser, baseURL }, use) => {
    const sessions = [];
    await use(async (options) => {
      const value = await createSession(browser, baseURL, options);
      sessions.push(value);
      return value;
    });
    for (const value of sessions) {
      value.remote.release?.();
      try { expect(value.errors).toEqual([]); expect(value.blocked).toEqual([]); }
      finally { await value.context.close(); }
    }
  },
});
const editor = (page) => page.locator("#editor");
async function stored(session, page = session.first) {
  const value = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), session.key);
  return session.key === accountKey ? value.inventory : value;
}
async function chooseHouse(page, name) {
  await page.locator("[data-house-toggle]").click();
  await page.locator("[data-house-list]").getByRole("button", { name, exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText(name);
}
async function prepareDelete(page) {
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Delete house", exact: true }).click();
  await editor(page).getByRole("radio", { name: /Delete everything/ }).check();
  await editor(page).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(editor(page).getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
}
async function submitDelete(page, { wait = true } = {}) {
  await editor(page).getByRole("button", { name: "Delete everything", exact: true }).click();
  if (wait) await expect.poll(() => editor(page).evaluate((dialog) =>
    !dialog.open || !dialog.querySelector('[type="submit"]')?.disabled)).toBe(true);
}
async function observeWriteLocks(page, pause = false) {
  await page.evaluate((pause) => {
    const request = navigator.locks.request.bind(navigator.locks);
    let next = pause;
    window.__inventoryLockRequests = [];
    navigator.locks.request = (name, ...args) => {
      const callback = args.pop();
      window.__inventoryLockRequests.push(name);
      return request(name, ...args, async (lock) => {
        if (next) {
          next = false;
          window.__inventoryPausedLock = name;
          await new Promise((resolve) => { window.__resumeInventoryWrite = resolve; });
        }
        return callback(lock);
      });
    };
  }, pause);
}
async function cleanup(page) {
  const previous = await page.evaluate(() => window.__houseCleanupCount);
  await page.evaluate(() => window.__houseAccount.cleanupAssets(0));
  await expect.poll(() => page.evaluate(() => window.__houseCleanupCount)).toBeGreaterThan(previous);
  await page.evaluate(() => window.__houseCleanupPromise);
}

for (const account of [false, true]) {
  test(`${account ? "account" : "guest"}: simultaneous opposing deletions serialize the cache check and write`, async ({ session }) => {
    const value = await session({ account });
    const { first, second } = value;
    const before = await stored(value);
    await first.evaluate(() => { window.__houseHoldEvents = true; });
    await second.evaluate(() => { window.__houseHoldEvents = true; });
    await chooseHouse(second, "Lake");
    await prepareDelete(first);
    await prepareDelete(second);
    await observeWriteLocks(first, true);
    await observeWriteLocks(second);
    try {
      await submitDelete(first, { wait: false });
      await first.waitForFunction(() => !!window.__resumeInventoryWrite);
      await submitDelete(second, { wait: false });
      await expect.poll(() => second.evaluate(() => window.__inventoryLockRequests.length)).toBeGreaterThan(0);
      const lockName = await first.evaluate(() => window.__inventoryPausedLock);
      const locks = await second.evaluate(() => navigator.locks.query());
      expect(locks.held.some((lock) => lock.name === lockName)).toBe(true);
      expect(locks.pending.some((lock) => lock.name === lockName)).toBe(true);
      expect(await stored(value)).toEqual(before);
      await first.evaluate(() => window.__resumeInventoryWrite());
      await expect(editor(first)).toBeHidden();
      await expect(editor(second).getByRole("alert")).toBeVisible();
      const accepted = await stored(value);
      expect(accepted).toEqual(removeHouse(before, "my-home", { mode: "delete" }));
      expect(validState(accepted)).toBe(true);
      await second.reload();
      await expect(second.locator("[data-house-name]")).toHaveText("Lake");
      await second.locator("[data-house-toggle]").click();
      await expect(second.getByRole("button", { name: "Delete house", exact: true })).toBeDisabled();
    } finally {
      await first.evaluate(() => window.__resumeInventoryWrite?.()).catch(() => {});
    }
  });
}

for (const account of [false, true]) {
  test(`${account ? "account" : "guest"}: IndexedDB fallback serializes competing deletions without Web Locks`, async ({ session }) => {
    const value = await session({ account });
    const { first, second } = value;
    const before = await stored(value);
    for (const page of [first, second]) await page.evaluate(() => {
      window.__houseHoldEvents = true;
      Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    });
    await chooseHouse(second, "Lake");
    await prepareDelete(first);
    await prepareDelete(second);
    await Promise.all([submitDelete(first), submitDelete(second)]);
    const accepted = await stored(value);
    expect(accepted.houses).toHaveLength(1);
    const removed = accepted.houses[0].id === "lake" ? "my-home" : "lake";
    expect(accepted).toEqual(removeHouse(before, removed, { mode: "delete" }));
    expect(validState(accepted)).toBe(true);
    const rejected = removed === "my-home" ? second : first;
    await expect(editor(rejected).getByRole("alert")).toBeVisible();
    await rejected.reload();
    await rejected.locator("[data-house-toggle]").click();
    await expect(rejected.getByRole("button", { name: "Delete house", exact: true })).toBeDisabled();
  });
}

test("cancelling a queued guest deletion prevents its later write and leaves new dialogs usable", async ({ session }) => {
  const value = await session({ count: 1 });
  const { first } = value;
  const before = await stored(value);
  await prepareDelete(first);
  await observeWriteLocks(first, true);
  try {
    await submitDelete(first, { wait: false });
    await first.waitForFunction(() => !!window.__resumeInventoryWrite);
    await editor(first).getByRole("button", { name: "Cancel", exact: true }).click();
    await first.locator("[data-house-add]").click();
    await editor(first).getByRole("textbox", { name: "House name" }).fill("New home");
    await first.evaluate(() => window.__resumeInventoryWrite());
    await expect(editor(first).getByRole("heading")).toHaveText("Add a house");
    expect(await stored(value)).toEqual(before);
    await editor(first).getByRole("button", { name: "Add house", exact: true }).click();
    await expect(editor(first)).toBeHidden();
    await expect(first.locator("[data-house-name]")).toHaveText("New home");
    expect((await stored(value)).houses).toHaveLength(3);
  } finally {
    await first.evaluate(() => window.__resumeInventoryWrite?.()).catch(() => {});
  }
});

for (const account of [false, true]) {
  test(`${account ? "account" : "guest"}: cancellation after an IndexedDB write preserves committed data and newer edits`, async ({ session }) => {
    const value = await session({ account, count: 1 });
    const { first } = value;
    const before = await stored(value);
    await prepareDelete(first);
    await first.evaluate(() => {
      Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
      let pause = true;
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
        ...descriptor,
        set(callback) {
          descriptor.set.call(this, function (event) {
            if (pause && this.db.name === "haven-inventory-write-locks") {
              pause = false;
              window.__resumeInventoryWrite = () => callback.call(this, event);
            } else callback.call(this, event);
          });
        },
      });
    });
    try {
      await submitDelete(first, { wait: false });
      await first.waitForFunction(() => !!window.__resumeInventoryWrite);
      const committed = await stored(value);
      expect(committed).toEqual(removeHouse(before, "my-home", { mode: "delete" }));
      await editor(first).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(first.locator("[data-house-name]")).toHaveText("Lake");
      await first.locator(".heading-actions [data-add-root]").click();
      await editor(first).getByRole("textbox", { name: "Name", exact: true }).fill("After committed deletion");
      await editor(first).getByRole("button", { name: "Save", exact: true }).click();
      await expect(editor(first)).toBeHidden();
      const newest = await stored(value);
      expect(newest.houses).toEqual(committed.houses);
      expect(newest.locations.some((location) => location.name === "After committed deletion" && location.houseId === "lake")).toBe(true);
      await first.evaluate(() => window.__resumeInventoryWrite());
      await expect(first.getByRole("button", { name: "Open After committed deletion", exact: true })).toBeVisible();
      expect(await stored(value)).toEqual(newest);
      await first.reload();
      await expect(first.getByRole("button", { name: "Open After committed deletion", exact: true })).toBeVisible();
      expect(validState(await stored(value))).toBe(true);
    } finally {
      await first.evaluate(() => window.__resumeInventoryWrite?.()).catch(() => {});
    }
  });
}

test("an auth change while an account deletion waits for its lock preserves both scopes", async ({ session }) => {
  const value = await session({ account: true, count: 1 });
  const { first } = value;
  const before = await stored(value);
  const guest = await first.evaluate(() => localStorage.getItem("haven-inventory"));
  await prepareDelete(first);
  await observeWriteLocks(first, true);
  try {
    await submitDelete(first, { wait: false });
    await first.waitForFunction(() => !!window.__resumeInventoryWrite);
    await first.evaluate(async () => window.__houseAuth(null));
    await expect(editor(first)).toBeHidden();
    await first.evaluate(() => window.__resumeInventoryWrite());
    expect(await stored(value)).toEqual(before);
    expect(await first.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(guest);
    await expect(first.locator("[data-house-name]")).toHaveText("My home");
    await first.locator(".heading-actions [data-add-root]").click();
    await editor(first).getByRole("textbox", { name: "Name", exact: true }).fill("Guest room");
    await editor(first).getByRole("button", { name: "Save", exact: true }).click();
    await expect(first.getByRole("button", { name: "Open Guest room", exact: true })).toBeVisible();
    expect(await stored(value)).toEqual(before);
  } finally {
    await first.evaluate(() => window.__resumeInventoryWrite?.()).catch(() => {});
  }
});

for (const account of [false, true]) for (const delayed of [false, true]) {
  test(`${account ? "account" : "guest"}: opposing two-house deletions preserve the survivor with ${delayed ? "queued" : "delivered"} events`, async ({ session }) => {
    const value = await session({ account });
    const { first, second } = value;
    const before = await stored(value);
    await chooseHouse(second, "Lake");
    if (delayed) await second.evaluate(() => { window.__houseHoldEvents = true; });
    await prepareDelete(second);
    await prepareDelete(first);
    await submitDelete(first);
    const accepted = await stored(value);
    expect(accepted).toEqual(removeHouse(before, "my-home", { mode: "delete" }));
    expect(accepted.houses.map((house) => house.id)).toEqual(["lake"]);
    if (delayed) await expect.poll(() => second.evaluate(() => window.__houseQueued)).toBeGreaterThan(0);
    if (account || delayed) {
      if (account && !delayed) await expect.poll(() => second.evaluate(() => window.__houseAccount.ready)).toBe(false);
      await submitDelete(second);
      await expect(editor(second).getByRole("alert")).toBeVisible();
    } else await expect(editor(second)).toBeHidden();
    expect(await stored(value, second)).toEqual(accepted);
    await second.evaluate(() => window.__houseReleaseEvents());
    await second.reload();
    await expect(second.locator("[data-house-name]")).toHaveText("Lake");
    await second.locator("[data-house-toggle]").click();
    await expect(second.getByRole("button", { name: "Delete house", exact: true })).toBeDisabled();
    expect(await stored(value, second)).toEqual(accepted);
    expect(validState(accepted)).toBe(true);
  });
}

for (const account of [false, true]) for (const occupied of [false, true]) {
  test(`${account ? "account" : "guest"}: last ${occupied ? "populated" : "empty"} house survives both UI boundaries and direct helper calls`, async ({ session }) => {
    const inventory = occupied ? removeHouse(startingInventory(), "lake", { mode: "delete" })
      : { ...withHouses(initialState()), locations: [], items: [], scans: [], markers: [] };
    const value = await session({ account, inventory, count: 1 });
    const { first } = value;
    const before = await stored(value);
    await first.locator("[data-house-toggle]").click();
    const switcherDelete = first.getByRole("button", { name: "Delete house", exact: true });
    await expect(switcherDelete).toBeDisabled();
    await expect(first.locator("[data-house-delete-help]")).toHaveText(LAST_HOUSE_DELETE_MESSAGE);
    // Exercise the callback guard even if a stale/modified control is enabled.
    await switcherDelete.evaluate((button) => { button.disabled = false; button.click(); });
    await expect(editor(first)).toBeHidden();
    await expect(first.locator("#toast")).toHaveText(LAST_HOUSE_DELETE_MESSAGE);
    await first.locator("[data-house-toggle]").click();
    await first.getByRole("button", { name: "Rename house", exact: true }).click();
    const editorDelete = editor(first).getByRole("button", { name: "Delete house", exact: true });
    await expect(editorDelete).toBeDisabled();
    await expect(first.locator("#editor-delete-help")).toHaveText(LAST_HOUSE_DELETE_MESSAGE);
    await editorDelete.evaluate((button) => { button.disabled = false; button.click(); });
    await expect(editor(first)).toBeHidden();
    const errors = await first.evaluate(async (state) => {
      const { removeHouse } = await import("/src/houses.js");
      return ["move", "delete"].map((mode) => {
        try { removeHouse(state, state.houses[0].id, { mode }); return "unexpected success"; }
        catch (error) { return error.message; }
      });
    }, before);
    expect(errors).toEqual([LAST_HOUSE_DELETE_MESSAGE, LAST_HOUSE_DELETE_MESSAGE]);
    expect(await stored(value)).toEqual(before);
    await first.reload();
    expect(await stored(value)).toEqual(before);
    expect(value.remote.log.filter((entry) => entry.op === "publish")).toEqual([]);
  });
}

for (const account of [false, true]) {
  test(`${account ? "account" : "guest"}: a queued inactive-house edit survives a stale whole-house deletion`, async ({ session }) => {
    const value = await session({ account });
    const { first, second } = value;
    await second.evaluate(() => { window.__houseHoldEvents = true; });
    await prepareDelete(second);
    await chooseHouse(first, "Lake");
    await first.getByRole("button", { name: "Settings for Cabin", exact: true }).click();
    await editor(first).getByRole("textbox", { name: "Name", exact: true }).fill("Cabin edited in sibling");
    await editor(first).getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor(first)).toBeHidden();
    const accepted = await stored(value);
    expect(accepted.locations.find((room) => room.id === "cabin").name).toBe("Cabin edited in sibling");
    await expect.poll(() => second.evaluate(() => window.__houseQueued)).toBeGreaterThan(0);
    await submitDelete(second);
    await expect(editor(second).getByRole("alert")).toBeVisible();
    expect(await stored(value)).toEqual(accepted);
    expect(accepted.houses).toHaveLength(2);
    expect(accepted.items).toEqual(startingInventory().items);
    expect(accepted.scans).toEqual(startingInventory().scans);
    expect(accepted.markers).toEqual(startingInventory().markers);
  });
}

test("account: failed house-deletion persistence keeps files, full cache and visible selection, then retries", async ({ session }) => {
  const value = await session({ account: true, count: 1 });
  const { first } = value;
  const before = await stored(value);
  await first.evaluate(async (account) => {
    const { putAsset } = await import("/src/scan-storage.js");
    await putAsset("asset-living-room", new Blob(["scan contents"]), account);
  }, uid);
  await prepareDelete(first);
  await first.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw Error("Account cache quota exceeded");
      return original.call(this, name, value);
    };
    window.__houseRestoreStorage = () => { Storage.prototype.setItem = original; };
  }, accountKey);
  await submitDelete(first);
  await expect(editor(first).getByRole("alert")).toContainText("Nothing has been moved or deleted");
  expect(await stored(value)).toEqual(before);
  await expect(first.locator("[data-house-name]")).toHaveText("My home");
  await cleanup(first);
  expect(await first.evaluate(async (account) => !!await (await import("/src/scan-storage.js")).getAsset("asset-living-room", account), uid)).toBe(true);
  expect(value.remote.log.filter((entry) => entry.op === "publish")).toEqual([]);
  await first.evaluate(() => window.__houseRestoreStorage());
  await submitDelete(first);
  await expect(editor(first)).toBeHidden();
  expect((await stored(value)).houses.map((house) => house.id)).toEqual(["lake"]);
});

test("account: deleted house files survive delayed acknowledgment and recovery, then cleanup respects guest scope", async ({ session }) => {
  const value = await session({ account: true });
  const { first, second, remote } = value;
  const before = await stored(value);
  await first.evaluate(async (account) => {
    const { putAsset } = await import("/src/scan-storage.js");
    for (const id of ["asset-living-room", "asset-cabin"]) {
      await putAsset(id, new Blob(["account file"]), account);
      await putAsset(id, new Blob(["guest file"]), null);
    }
  }, uid);
  await prepareDelete(first);
  await submitDelete(first);
  await expect.poll(() => second.evaluate(() => window.__houseAccount.ready)).toBe(false);
  for (const page of [first, second]) {
    await cleanup(page);
    expect(await page.evaluate(async (account) => !!await (await import("/src/scan-storage.js")).getAsset("asset-living-room", account), uid)).toBe(true);
  }
  remote.hold = new Promise((resolve) => { remote.release = resolve; });
  await first.evaluate(() => { window.__houseFlush = window.__houseAccount.sync.flush(); });
  await expect.poll(() => remote.revision).toBe(2);
  await cleanup(first);
  expect(await first.evaluate(async (account) => !!await (await import("/src/scan-storage.js")).getAsset("asset-living-room", account), uid)).toBe(true);
  await first.evaluate(({ account, inventory }) => localStorage.setItem(`haven-recovery:${account}`, JSON.stringify(inventory)), { account: uid, inventory: before });
  remote.release();
  await first.evaluate(() => window.__houseFlush);
  await cleanup(first);
  expect(await first.evaluate(async (account) => !!await (await import("/src/scan-storage.js")).getAsset("asset-living-room", account), uid)).toBe(true);
  await first.evaluate((account) => localStorage.removeItem(`haven-recovery:${account}`), uid);
  await cleanup(first);
  expect(await first.evaluate(async (account) => {
    const { getAsset } = await import("/src/scan-storage.js");
    return { removed: !!await getAsset("asset-living-room", account), survivor: !!await getAsset("asset-cabin", account),
      guest: !!await getAsset("asset-living-room", null) };
  }, uid)).toEqual({ removed: false, survivor: true, guest: true });
  expect(remote.inventory).toEqual(await stored(value));
  expect(remote.log.filter((entry) => entry.op === "publish")).toHaveLength(1);
});

test("account: delayed deletion acknowledgment cannot replace the guest view or scan scope", async ({ session }) => {
  const value = await session({ account: true, count: 1 });
  const { first, remote } = value;
  const guestBefore = await first.evaluate(() => localStorage.getItem("haven-inventory"));
  await prepareDelete(first);
  await submitDelete(first);
  const pending = await first.evaluate((key) => localStorage.getItem(key), accountKey);
  remote.hold = new Promise((resolve) => { remote.release = resolve; });
  await first.evaluate(() => { window.__houseFlush = window.__houseAccount.sync.flush(); });
  await expect.poll(() => remote.revision).toBe(2);
  await first.evaluate(() => window.__houseAuth(null));
  await expect(first.locator("[data-house-name]")).toHaveText("My home");
  remote.release();
  await first.evaluate(() => window.__houseFlush);
  expect(await first.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(guestBefore);
  expect(await first.evaluate((key) => localStorage.getItem(key), accountKey)).toBe(pending);
  expect(await first.evaluate(async () => (await import("/src/scan-storage.js")).getAssetScope())).toBe(null);
  await expect(first.locator("[data-house-name]")).toHaveText("My home");
});
