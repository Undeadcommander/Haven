import { test as base, expect } from "@playwright/test";
import { initialState } from "../src/store.js";
import { withHouses } from "../src/houses.js";

const uid = "cross-tab-user";
const cacheKey = "haven-account:" + uid;
const copy = (value) => structuredClone(value);
const startingInventory = () => ({ ...withHouses(initialState()), scans: [], markers: [] });

const firebaseService = "export " + async function createFirebaseService() {
  return {
    watchAuth(callback) {
      queueMicrotask(() => callback({ uid: "cross-tab-user", displayName: "Cross-tab user" }));
      return () => {};
    },
    watch(account, callback, failed) {
      let active = true;
      window.__crossTabWatchActive = true;
      const deliver = async (metadata) => {
        if (!active) return false;
        await callback(metadata);
        return true;
      };
      window.__crossTabDeliver = deliver;
      window.__crossTabRpc({ op: "watch", uid: account }).then(deliver).catch(failed);
      return () => { active = false; window.__crossTabWatchActive = false; };
    },
    async read(account, metadata) {
      const result = await window.__crossTabRpc({ op: "read", uid: account, metadata });
      return result.inventory;
    },
    async publish(account, inventory, revision) {
      const result = await window.__crossTabRpc({ op: "publish", uid: account, inventory, revision });
      if (result.error) throw Object.assign(Error(result.error), result);
      return result.revision;
    },
    async login() {},
    async logout() {},
  };
}.toString();

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function createRemote(seed) {
  return {
    revision: seed.revision,
    inventory: copy(seed.inventory),
    snapshots: new Map([[seed.revision, copy(seed.inventory)]]),
    log: [],
    gates: [],
    deliveries: [],
    names: new Map(),
    metadata() {
      return { revision: this.revision, snapshotId: "snapshot-" + this.revision, chunkCount: 1 };
    },
    equivalentRevision() {
      this.revision++;
      this.snapshots.set(this.revision, copy(this.inventory));
      return this.metadata();
    },
    hold(page, operation) {
      const gate = { page, operation, request: null, released: deferred() };
      gate.release = () => gate.released.resolve();
      this.gates.push(gate);
      return gate;
    },
    deliver(page, metadata = this.metadata()) {
      const delivery = page.evaluate((value) => window.__crossTabDeliver(value), metadata);
      this.deliveries.push(delivery);
      delivery.catch(() => {});
      return delivery;
    },
    async request(page, request) {
      if (request.uid !== uid) throw Error("Unexpected mocked account");
      const entry = { page: this.names.get(page), ...copy(request) };
      this.log.push(entry);
      if (request.op === "watch") return this.metadata();
      const gate = this.gates.find((candidate) => candidate.page === page &&
        candidate.operation === request.op && !candidate.request);
      if (request.op === "read") {
        if (!this.snapshots.has(request.metadata.revision)) throw Error("Unknown remote snapshot");
        const inventory = copy(this.snapshots.get(request.metadata.revision));
        if (gate) {
          gate.request = entry;
          await gate.released.promise;
        }
        entry.returned = true;
        return { inventory };
      }
      if (request.op === "publish") {
        if (request.revision !== this.revision) {
          entry.rejected = true;
          return { error: "CAS revision mismatch", code: "sync/conflict", remote: this.metadata() };
        }
        this.inventory = copy(request.inventory);
        const revision = ++this.revision;
        this.snapshots.set(revision, copy(this.inventory));
        entry.committedRevision = revision;
        if (gate) {
          gate.request = entry;
          await gate.released.promise;
        }
        entry.acknowledged = true;
        return { revision };
      }
      throw Error("Unexpected mocked operation: " + request.op);
    },
  };
}

async function snapshot(page) {
  return page.evaluate((key) => ({
    raw: localStorage.getItem(key),
    cache: JSON.parse(localStorage.getItem(key)),
    ready: window.__crossTabAccount?.ready,
    status: window.__crossTabAccount?.sync.status,
    revision: window.__crossTabAccount?.sync.record?.revision,
    remoteKnown: window.__crossTabAccount?.sync.remoteKnown,
    watchActive: window.__crossTabWatchActive,
    events: window.__crossTabEvents,
    errors: window.__crossTabErrors,
    cleanups: window.__crossTabCleanups,
    banner: document.querySelector("[data-account-status]")?.textContent,
  }), cacheKey);
}

async function setupTabs(browser, baseURL, options, seed = {
  inventory: startingInventory(), revision: 1, dirty: false,
}) {
  const context = await browser.newContext({ ...options, baseURL, serviceWorkers: "block" });
  const remote = createRemote(seed);
  const origin = new URL(baseURL).origin;
  await context.exposeBinding("__crossTabRpc", ({ page }, request) => remote.request(page, request));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      remote.log.push({ op: "external-blocked", url: url.href });
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/src/firebase-config.json") return route.fulfill({
      contentType: "application/javascript",
      body: 'export default {apiKey:"mock",authDomain:"mock.invalid",projectId:"mock",appId:"mock"};',
    });
    if (url.pathname === "/src/firebase-service.js") return route.fulfill({
      contentType: "application/javascript", body: firebaseService,
    });
    if (url.pathname === "/src/account.js") {
      const response = await route.fetch();
      const source = (await response.text()).replaceAll("\r\n", "\n");
      const anchor = "  return {\n    bind()";
      const cleanupAnchor = "const nextExpiry = await reconcileAssets(";
      expect(source.split(anchor)).toHaveLength(2);
      expect(source.split(cleanupAnchor)).toHaveLength(2);
      const body = source.replace(cleanupAnchor, "const nextExpiry = await window.__crossTabReconcileAssets(")
        .replace(anchor, "  sync.delay = 60_000;\n" +
          "  window.__crossTabReconcileAssets = (...args) => {\n" +
          "    const cleanup = reconcileAssets(...args);\n" +
          "    window.__crossTabCleanupPromise = cleanup;\n" +
          "    window.__crossTabCleanups++;\n" +
          "    return cleanup;\n" +
          "  };\n  return window.__crossTabAccount = {\n    bind()");
      return route.fulfill({ response, body });
    }
    return route.continue();
  });
  await context.addInitScript(({ key, record }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(record));
    window.__crossTabEvents = [];
    window.__crossTabErrors = [];
    window.__crossTabCleanups = 0;
    window.__crossTabHoldStorage = false;
    const queuedStorage = [];
    const listen = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
      if (type !== "storage") return listen.call(this, type, listener, options);
      return listen.call(this, type, (event) => {
        const deliver = () => listener.call(this, event);
        if (window.__crossTabHoldStorage) queuedStorage.push(deliver);
        else deliver();
      }, options);
    };
    window.__crossTabReleaseStorage = () => {
      window.__crossTabHoldStorage = false;
      for (const deliver of queuedStorage.splice(0)) deliver();
    };
    addEventListener("error", (event) => window.__crossTabErrors.push(event.message));
    addEventListener("unhandledrejection", (event) =>
      window.__crossTabErrors.push(String(event.reason?.stack || event.reason)));
    addEventListener("storage", (event) => {
      if (event.key === key) window.__crossTabEvents.push({
        oldValue: event.oldValue, newValue: event.newValue,
        atDelivery: localStorage.getItem(key), trusted: event.isTrusted,
      });
    });
  }, { key: cacheKey, record: seed });
  const tabs = { context, remote, pages: [] };
  try {
    for (const name of ["A", "B"]) {
      const page = await context.newPage();
      tabs.pages.push(page);
      remote.names.set(page, name);
      await page.goto("/");
      await page.waitForFunction(() => window.__crossTabAccount?.ready &&
        window.__crossTabAccount.sync.remoteKnown);
      await expect(page.locator("[data-account-avatar]")).toBeVisible();
    }
  } catch (error) {
    await context.close();
    throw error;
  }
  [tabs.first, tabs.second] = tabs.pages;
  return tabs;
}

const test = base.extend({
  createTabs: async ({ browser, baseURL, viewport, isMobile, hasTouch }, use, testInfo) => {
    const sessions = [];
    await use(async (seed) => {
      const session = await setupTabs(browser, baseURL, { viewport, isMobile, hasTouch }, seed);
      sessions.push(session);
      return session;
    });
    for (const session of sessions) {
      for (const gate of session.remote.gates) gate.release();
      await Promise.allSettled(session.remote.deliveries);
      try {
        await testInfo.attach("active-tab-evidence", {
          contentType: "application/json",
          body: JSON.stringify({
            remote: { revision: session.remote.revision, inventory: session.remote.inventory,
              log: session.remote.log },
            tabs: await Promise.all(session.pages.map((page) => snapshot(page).catch(() => null))),
          }, null, 2),
        });
        for (const page of session.pages) expect((await snapshot(page)).errors).toEqual([]);
        expect(session.remote.log.filter((entry) => entry.op === "external-blocked")).toEqual([]);
      } finally {
        await session.context.close();
      }
    }
  },
});

async function flush(page) {
  await page.evaluate(async () => {
    clearTimeout(window.__crossTabAccount.sync.timer);
    await window.__crossTabAccount.sync.flush();
  });
}

async function createHouse(page, name) {
  await page.locator("[data-house-add]").click();
  await page.getByRole("textbox", { name: "House name" }).fill(name);
  await page.locator("#editor").getByRole("button", { name: "Add house", exact: true }).click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("[data-house-name]")).toHaveText(name);
}

async function saveLocation(page, name, room = true) {
  await page.locator(room ? ".heading-actions [data-add-root]" : "[data-add-location]").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
}

async function createLocation(page, name, room = true) {
  await saveLocation(page, name, room);
  await expect(page.locator("#editor")).toBeHidden();
  await page.getByRole("button", { name: "Open " + name, exact: true }).click();
  await expect(page.locator("h1")).toHaveText(name);
}

async function createItem(page, name) {
  await page.getByRole("button", { name: "Add item", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Item name" }).fill(name);
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator(".item-row").filter({ hasText: name })).toBeVisible();
}

for (const width of [1440, 390]) {
  test.describe((width === 1440 ? "desktop" : "mobile") + " signed-in active tabs", () => {
    test.use({ viewport: { width, height: 950 }, isMobile: width < 600, hasTouch: width < 600 });

    test("delayed sibling download preserves new house and room, subsequent saves and reload", async ({ createTabs }) => {
      const { first, second, remote } = await createTabs();
      const gate = remote.hold(second, "read");
      const metadata = remote.equivalentRevision();
      const delayed = remote.deliver(second, metadata);
      await expect.poll(() => gate.request?.metadata.revision).toBe(2);
      await remote.deliver(first, metadata);
      await expect.poll(async () => (await snapshot(first)).revision).toBe(2);

      await createHouse(first, "Newly saved house");
      await createLocation(first, "Newly saved room");
      const pending = await snapshot(first);
      expect(pending.cache.dirty).toBe(true);
      expect(pending.cache.inventory.houses.map((house) => house.name)).toContain("Newly saved house");
      expect(pending.cache.inventory.locations.map((location) => location.name)).toContain("Newly saved room");
      await expect.poll(async () => (await snapshot(second)).ready).toBe(false);
      gate.release();
      await delayed;
      expect((await snapshot(first)).raw).toBe(pending.raw);
      expect((await snapshot(first)).ready).toBe(true);
      expect((await snapshot(second)).watchActive).toBe(false);

      await createLocation(first, "Container without reload", false);
      await createItem(first, "Item without reload");
      await flush(first);
      expect(remote.revision).toBe(3);
      expect(remote.inventory.locations.map((location) => location.name)).toEqual(
        expect.arrayContaining(["Newly saved room", "Container without reload"]));
      expect(remote.inventory.items.map((item) => item.name)).toEqual(["Item without reload"]);
      expect(remote.log.filter((entry) => entry.rejected)).toEqual([]);
      expect((await snapshot(first)).cache).toMatchObject({ inventory: remote.inventory, revision: 3, dirty: false });

      await first.reload();
      await expect(first.locator("[data-account-status]")).toContainText("Account is up to date");
      expect((await snapshot(first)).cache.inventory).toEqual(remote.inventory);
      await expect(first.locator("[data-house-name]")).toHaveText("Newly saved house");
      await first.getByRole("button", { name: "Open Newly saved room", exact: true }).click();
      await first.getByRole("button", { name: "Open Container without reload", exact: true }).click();
      await expect(first.locator(".item-row").filter({ hasText: "Item without reload" })).toBeVisible();
      expect(await first.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    });
  });
}

test("delayed old publish acknowledgment cannot overwrite sibling pending newer room", async ({ createTabs }) => {
  const inventory = startingInventory();
  inventory.items.push({ id: "offline-item", locationId: "living-room", name: "Offline pending item", notes: "" });
  const { first, second, remote } = await createTabs({ inventory, revision: 1, dirty: true, baseAssets: [] });
  const gate = remote.hold(first, "publish");
  await first.evaluate(() => { window.__crossTabFlush = window.__crossTabAccount.sync.flush(); });
  await expect.poll(() => gate.request?.committedRevision).toBe(2);
  await createLocation(second, "Sibling pending newer room");
  const pending = await snapshot(second);
  expect(pending.cache.dirty).toBe(true);
  expect(pending.cache.inventory.locations.map((location) => location.name)).toContain("Sibling pending newer room");
  await expect.poll(async () => (await snapshot(first)).ready).toBe(false);

  gate.release();
  await first.evaluate(() => window.__crossTabFlush);
  expect(gate.request.acknowledged).toBe(true);
  expect((await snapshot(second)).raw).toBe(pending.raw);
  expect((await snapshot(second)).ready).toBe(true);
  expect((await snapshot(first)).watchActive).toBe(false);
  expect(remote.inventory).toEqual(inventory);
  await createLocation(second, "Still editable after old acknowledgment", false);
  expect((await snapshot(second)).cache.inventory.locations.map((location) => location.name)).toEqual(
    expect.arrayContaining(["Sibling pending newer room", "Still editable after old acknowledgment"]));
});

test("same-inventory clean newer acknowledgment reconciles CAS base for the next save", async ({ createTabs }) => {
  const { first, second, remote } = await createTabs();
  await first.evaluate(() => window.__crossTabAccount.save(window.__crossTabAccount.sync.record.inventory));
  await flush(first);
  await expect.poll(async () => (await snapshot(second)).events.filter((event) =>
    JSON.parse(event.newValue)?.revision === 2).length).toBeGreaterThan(0);
  const acknowledgment = await snapshot(second);
  expect(acknowledgment.events.every((event) => event.trusted)).toBe(true);
  expect(acknowledgment.cache).toMatchObject({ revision: 2, dirty: false });
  expect(acknowledgment.ready).toBe(true);

  await createLocation(second, "Saved on reconciled revision");
  await flush(second);
  const publishes = remote.log.filter((entry) => entry.op === "publish");
  expect(publishes.map((entry) => entry.revision)).toEqual([1, 2]);
  expect(publishes.filter((entry) => entry.rejected)).toEqual([]);
  expect(remote.revision).toBe(3);
  expect(remote.inventory.locations.map((location) => location.name)).toContain("Saved on reconciled revision");
  expect((await snapshot(second)).cache).toMatchObject({ revision: 3, dirty: false, inventory: remote.inventory });
  expect((await snapshot(second)).ready).toBe(true);
});

test("queued genuine inventory round-trip pauses stale sibling and retains pending baseAssets scan", async ({ createTabs }) => {
  const { first, second, remote } = await createTabs();
  const inventory = startingInventory();
  const withScan = copy(inventory);
  withScan.scans.push({ id: "retained-scan", assetId: "retained-file", locationId: "living-room",
    name: "Referenced account scan", format: "obj" });
  for (const page of [first, second]) {
    const beforeCleanup = (await snapshot(page)).cleanups;
    await page.evaluate(() => window.__crossTabAccount.cleanupAssets(0));
    await expect.poll(async () => (await snapshot(page)).cleanups).toBeGreaterThan(beforeCleanup);
    await page.evaluate(() => window.__crossTabCleanupPromise);
  }
  await first.evaluate(async () => {
    const assets = await import("/src/scan-storage.js");
    await assets.putAsset("retained-file", new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"]),
      "cross-tab-user", { staged: true });
  });
  let pending;
  await second.evaluate(() => { window.__crossTabHoldStorage = true; });
  try {
    await first.evaluate((value) => window.__crossTabAccount.save(value), withScan);
    await flush(first);
    await first.evaluate((value) => window.__crossTabAccount.save(value), inventory);
    pending = await snapshot(first);
    expect(pending.cache.dirty).toBe(true);
    expect(pending.cache.inventory).toEqual(inventory);
    expect(pending.cache.baseAssets).toEqual(["retained-file"]);
    expect(remote.inventory).toEqual(withScan);
  } finally {
    await second.evaluate(() => window.__crossTabReleaseStorage());
  }

  await expect.poll(async () => (await snapshot(second)).events.length).toBeGreaterThanOrEqual(3);
  await first.evaluate(async () => {
    const assets = await import("/src/scan-storage.js");
    await assets.commitAssets(["retained-file"], "cross-tab-user");
  });
  const delivered = await snapshot(second);
  expect(delivered.events.every((event) => event.trusted && event.atDelivery === pending.raw)).toBe(true);
  expect(delivered.events.some((event) => JSON.parse(event.newValue).inventory.scans.length === 1)).toBe(true);
  await expect(second.locator("[data-account-status]")).toContainText("changed in another tab");
  expect(delivered.ready).toBe(false);
  expect(delivered.remoteKnown).toBe(false);
  expect(delivered.watchActive).toBe(false);

  const beforeRetry = remote.log.length;
  await second.evaluate(() => {
    dispatchEvent(new Event("online"));
    window.__crossTabAccount.sync.retry();
  });
  await flush(second);
  expect(remote.log).toHaveLength(beforeRetry);
  await saveLocation(second, "Forbidden stale sibling room");
  await expect(second.locator("#editor")).toBeVisible();
  expect((await snapshot(first)).raw).toBe(pending.raw);

  for (const page of [second, first]) {
    const beforeCleanup = (await snapshot(page)).cleanups;
    await page.evaluate(() => window.__crossTabAccount.cleanupAssets(0));
    await expect.poll(async () => (await snapshot(page)).cleanups).toBeGreaterThan(beforeCleanup);
    await page.evaluate(() => window.__crossTabCleanupPromise);
    expect(await page.evaluate(async () => !!(await (await import("/src/scan-storage.js"))
      .getAsset("retained-file", "cross-tab-user")))).toBe(true);
  }
  expect((await snapshot(first)).cache.baseAssets).toEqual(["retained-file"]);
  expect(remote.inventory.scans).toEqual(withScan.scans);
  expect(remote.log.filter((entry) => entry.op === "publish")).toHaveLength(1);
});
