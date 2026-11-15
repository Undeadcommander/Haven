import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";

const triangle = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
async function assetKeys(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("haven-room-scans", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("assets");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve, reject) => {
      const request = db.transaction("assets", "readonly").objectStore("assets").getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
  });
}

for (const [label, format, data] of [
  ["empty points", "points", Buffer.alloc(0)],
  ["truncated points", "points", Buffer.alloc(3)],
  ["invalid OBJ", "obj", Buffer.from("# no geometry\n")],
  ["truncated GLB", "glb", Buffer.from("glTF")],
]) {
test(`restore rejects ${label} and rolls back earlier staged scans`, async ({ page }) => {
  const original = initialState();
  original.items.push({ id: "keep", name: "Keep this item", notes: "", locationId: "living-room" });
  await page.addInitScript((inventory) => {
    localStorage.setItem("haven-inventory", JSON.stringify(inventory));
  }, original);
  await page.goto("/");

  const broken = initialState();
  broken.locations.push({ id: "office", parentId: null, name: "Office", description: "", color: "sage" });
  broken.scans = [{ id: "good-scan", assetId: "good-asset", locationId: "living-room", name: "room.obj", format: "obj" }, {
    id: "empty-scan",
    assetId: "empty-asset",
    locationId: "office",
    name: "broken scan",
    format,
  }];
  const backup = {
    format: "haven-backup",
    version: 2,
    inventory: broken,
    assets: [
      { id: "good-asset", data: `data:application/octet-stream;base64,${Buffer.from(triangle).toString("base64")}` },
      { id: "empty-asset", data: `data:application/octet-stream;base64,${data.toString("base64")}` },
    ],
  };

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup" }).first().click();
  await (await chooser).setFiles({
    name: "empty-point-cloud.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByRole("button", { name: "Restore", exact: true }).click();

  // The restore handler disables these buttons before its first await. Success
  // replaces the editor; failure enables the buttons again. Wait for either
  // outcome so the original inventory cannot satisfy an assertion too early.
  await expect(page.locator("#editor button:disabled")).toHaveCount(0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("haven-inventory")),
  );
  expect(saved).toEqual(original);
  expect(await assetKeys(page)).toEqual([]);
  await expect(page.locator("#editor")).toBeVisible();
});
}

async function fakeFirebase(page) {
  await page.route("**/src/firebase-config.json*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'export default {apiKey:"test",authDomain:"test.invalid",projectId:"test",appId:"test"};',
  }));
  await page.route("**/src/firebase-service.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      export async function createFirebaseService() {
        let authChanged;
        return {
          watchAuth(callback) { authChanged = callback; queueMicrotask(() => callback(null)); },
          async login() { authChanged({ uid: "test-alice", displayName: "Test Alice", email: "alice@example.test" }); },
          async logout() { authChanged(null); },
          watch(_uid, onValue) { queueMicrotask(() => onValue(null)); return () => {}; },
          async read() { return undefined; },
          async publish(_uid, _inventory, revision) { return revision + 1; },
          async reauthenticate() {},
          async deleteAccount() {},
        };
      }
    `,
  }));
}

for (const failure of ["missing source", "failed metadata save"]) {
test(`guest scan copy rolls back assets after ${failure}`, async ({ page }) => {
  await fakeFirebase(page);

  const guest = initialState();
  guest.locations.push({ id: "office", parentId: null, name: "Office", description: "", color: "sage" });
  guest.scans = [
    { id: "scan-one", assetId: "asset-one", locationId: "living-room", name: "one.obj", format: "obj" },
    { id: "scan-two", assetId: "asset-two", locationId: "office", name: "two.obj", format: "obj" },
  ];
  await page.addInitScript((inventory) => {
    localStorage.setItem("haven-inventory", JSON.stringify(inventory));
  }, guest);
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("haven-room-scans", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("assets");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite");
      tx.objectStore("assets").put(new Blob([
        "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
      ]), "asset-one");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  // Authentication closes the sign-in dialog. Reopen the account controls.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.locator(".account-message")).toContainText("Account is up to date");
  if (failure === "failed metadata save") {
    await page.evaluate(async () => {
      const { putAsset } = await import("/src/scan-storage.js");
      await putAsset("asset-two", new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]), null);
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "haven-account:test-alice") throw Error("Simulated account storage failure");
        return original.call(this, key, value);
      };
    });
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Copy device inventory to account" }).click();
  await expect(page.locator(".account-message")).toContainText(
    failure === "missing source" ? "A device scan is missing" : "Simulated account storage failure",
  );

  const keys = await assetKeys(page);
  const accountKeys = keys.filter((key) => typeof key === "string" && key.startsWith("test-alice:"));
  expect(accountKeys).toHaveLength(0);
  expect(keys).toContain("asset-one");
  expect(await page.evaluate(() => localStorage.getItem("haven-account:test-alice"))).toBeNull();
});
}

test("large inventory pages stay bounded and search opens the page containing its target", async ({ page }) => {
  const inventory = initialState();
  inventory.items = Array.from({ length: 205 }, (_, i) => ({
    id: `item-${i}`, name: `Book ${String(i).padStart(3, "0")}`, notes: "", locationId: "living-room",
  }));
  await page.addInitScript((state) => localStorage.setItem("haven-inventory", JSON.stringify(state)), inventory);
  await page.goto("/#room/living-room");
  await expect(page.locator(".item-row")).toHaveCount(100);
  await page.getByRole("button", { name: "Next items", exact: true }).click();
  await expect(page.locator(".item-pagination")).toContainText("Page 2 of 3");
  await expect(page.locator(".item-row").first()).toContainText("Book 100");
  await page.getByRole("searchbox").fill("Book 204");
  await page.locator(".search-result").click();
  await expect(page.locator(".item-row")).toHaveCount(5);
  await expect(page.locator(".highlight")).toContainText("Book 204");
  await page.getByRole("button", { name: "Delete Book 204", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(4);
  await page.locator("[data-all]").click();
  await expect(page.locator(".item-row")).toHaveCount(100);
  await page.getByRole("searchbox").fill("Book");
  await expect(page.locator(".search-result")).toHaveCount(30);
  await expect(page.locator(".results-label")).toHaveText("204 results · showing first 30");
  await page.getByRole("searchbox").fill("Book 000");
  await page.locator(".search-result").click();
  await page.getByRole("button", { name: "Add item", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Item name" }).fill("Newly added book");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".item-pagination")).toContainText("Page 3 of 3");
  await expect(page.locator(".item-row").last()).toContainText("Newly added book");
});

test("backup export preserves shared assets and restore rejects conflicting duplicates", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (obj) => {
    const { putAsset, getAsset, createBackupBlob, stageBackup } = await import("/src/scan-storage.js");
    const { initialState } = await import("/src/store.js");
    const inventory = initialState();
    inventory.locations.push({ id: "office", parentId: null, name: "Office", description: "", color: "sage" });
    inventory.scans = inventory.locations.map((location) => ({
      id: `scan-${location.id}`, assetId: "shared", locationId: location.id, name: "room.obj", format: "obj",
    }));
    await putAsset("shared", new Blob([obj]), null);
    const blob = await createBackupBlob(inventory, null);
    const backup = JSON.parse(await blob.text());
    const staged = await stageBackup(backup, null);
    const stagedIds = staged.inventory.scans.map((scan) => scan.assetId);
    const stagedFiles = await Promise.all(stagedIds.map((id) => getAsset(id, null)));
    await staged.rollback();
    const rolledBack = await Promise.all(stagedIds.map((id) => getAsset(id, null)));
    let duplicateError = "";
    try {
      await stageBackup({ ...backup, assets: [...backup.assets,
        { id: "shared", data: "data:application/octet-stream;base64,AA==" }] }, null);
    } catch (error) { duplicateError = error.message; }
    return {
      format: backup.format, version: backup.version, assets: backup.assets.length,
      inventoryUnchanged: JSON.stringify(backup.inventory) === JSON.stringify(inventory),
      distinctIds: new Set(stagedIds).size, stagedFilesPresent: stagedFiles.every(Boolean),
      rolledBack: rolledBack.every((file) => !file), original: await (await getAsset("shared", null)).text(),
      duplicateError,
    };
  }, triangle);
  expect(result).toMatchObject({
    format: "haven-backup", version: 2, assets: 1, inventoryUnchanged: true,
    distinctIds: 4, stagedFilesPresent: true, rolledBack: true, original: triangle,
  });
  expect(result.duplicateError).toContain("conflicting copies");
});
