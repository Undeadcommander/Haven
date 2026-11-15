import { test, expect } from "./fixture.js";
import { readFileSync } from "node:fs";
import { initialState } from "../src/store.js";
import { addHouse } from "../src/houses.js";

async function seed(page, inventory) {
  await page.addInitScript((value) => {
    if (!localStorage.getItem("haven-inventory"))
      localStorage.setItem("haven-inventory", JSON.stringify(value));
  }, inventory);
}

async function chooseHouse(page, name) {
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("searchbox", { name: "Search houses" }).fill(name);
  await page.locator("[data-house-list]").getByRole("button", { name, exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText(name);
}

async function createHouse(page, name) {
  await page.locator("[data-house-add]").click();
  await page.getByRole("textbox", { name: "House name" }).fill(name);
  await page.locator("#editor").getByRole("button", { name: "Add house", exact: true }).click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator("[data-house-name]")).toHaveText(name);
}

function lakeInventory() {
  const inventory = addHouse(initialState(), "Lake house", "lake");
  inventory.locations.push({ id: "cabin", parentId: null, houseId: "lake", name: "Cabin", description: "", color: "blue" });
  inventory.items.push({ id: "keys", locationId: "living-room", name: "Home keys", notes: "Only at home" });
  return inventory;
}

test("renaming the current house preserves contents and selection across reloads", async ({ page }) => {
  const inventory = { ...lakeInventory(), scans: [], markers: [] };
  await seed(page, inventory);
  await page.goto("/");
  await chooseHouse(page, "Lake house");
  await page.getByRole("button", { name: "Open Cabin", exact: true }).click();
  const url = page.url();
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Rename house", exact: true }).click();
  const dialog = page.locator("#editor");
  const name = page.getByRole("textbox", { name: "House name" });
  await expect(name).toHaveValue("Lake house");
  await name.fill("Cancelled name");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")))).toEqual(inventory);

  await page.locator("[data-house-toggle]").press("ArrowDown");
  await page.getByRole("button", { name: "Rename house", exact: true }).press("Enter");
  await name.fill('  <Cabin & "Lake">  ');
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("[data-house-name]")).toHaveText('<Cabin & "Lake">');
  await expect(page.locator(".breadcrumb [data-home]")).toHaveText('<Cabin & "Lake">');
  await expect(page.locator("[data-house-toggle]")).toBeFocused();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")))).toEqual({
    ...inventory,
    houses: [inventory.houses[0], { id: "lake", name: '<Cabin & "Lake">' }],
  });
  await page.reload();
  await expect(page.locator("[data-house-name]")).toHaveText('<Cabin & "Lake">');
  await expect(page.locator("h1")).toHaveText("Cabin");
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Rename house", exact: true }).click();
  await expect(name).toHaveValue('<Cabin & "Lake">');
});

test("renaming validates names and does not apply failed storage writes", async ({ page }) => {
  await seed(page, lakeInventory());
  await page.goto("/");
  await chooseHouse(page, "Lake house");
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Rename house", exact: true }).click();
  const dialog = page.locator("#editor");
  const name = page.getByRole("textbox", { name: "House name" });
  await expect(name).toHaveAttribute("maxlength", "80");
  await name.fill(" my HOME ");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.locator("[data-settings-error]")).toContainText("already exists");
  await name.fill("   ");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.locator("[data-settings-error]")).toContainText("name");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "haven-inventory") throw Error("Storage full");
      return original.call(this, key, value);
    };
  });
  await name.fill("Unsaved name");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.locator("[data-settings-error]")).toContainText("Could not save");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).houses[1].name)).toBe("Lake house");
  await chooseHouse(page, "My home");
  await chooseHouse(page, "Lake house");
});

test("legacy inventory stays intact while users create and switch isolated houses", async ({ page }) => {
  const legacy = initialState();
  legacy.items.push({ id: "keys", locationId: "living-room", name: "Home keys", notes: "" });
  await seed(page, legacy);
  await page.goto("/");
  await expect(page.locator("[data-house-name]")).toHaveText("My home");
  await expect(page.locator(".room-card")).toHaveCount(3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")))).toEqual(legacy);

  await createHouse(page, "Lake house");
  await expect(page.locator(".room-card")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search items and rooms" }).fill("Home keys");
  await expect(page.locator(".no-results")).toBeVisible();
  await page.getByRole("button", { name: "Add room", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Cabin");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Open Cabin", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).first().click();
  await expect(page.locator('select[name="location"] option')).toHaveText(["Cabin"]);
  await page.getByRole("textbox", { name: "Item name" }).fill("Lake paddle");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await chooseHouse(page, "My home");
  await expect(page.locator("h1")).toHaveText("Home, organized.");
  await expect(page.locator(".room-card")).toHaveCount(3);
  await page.getByRole("searchbox", { name: "Search items and rooms" }).fill("Lake paddle");
  await expect(page.locator(".no-results")).toBeVisible();
  await chooseHouse(page, "Lake house");
  await expect(page.getByRole("searchbox", { name: "Search items and rooms" })).toHaveValue("");
  await page.reload();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await expect(page.locator(".room-card")).toHaveCount(1);
  await page.getByRole("button", { name: "All items 1", exact: true }).click();
  await expect(page.locator(".item-row")).toContainText("Lake paddle");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")));
  expect(saved.houses).toHaveLength(2);
  expect(saved.items.map((item) => item.name).sort()).toEqual(["Home keys", "Lake paddle"]);
});

test("large house collections are searchable, keyboard accessible, and fit narrow screens", async ({ page }) => {
  let inventory = initialState();
  for (let house = 0; house < 100; house++)
    inventory = addHouse(inventory, `House ${String(house).padStart(3, "0")}`, `house-${house}`);
  const longName = '<Lake & "mountain"> '.repeat(4).trim();
  inventory = addHouse(inventory, longName, "long-name");
  await seed(page, inventory);
  await page.goto("/");
  const original = await page.evaluate(() => localStorage.getItem("haven-inventory"));
  for (const width of [1920, 1440, 1181, 1180, 1024, 820, 768, 760, 540, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const header = await page.locator("header").boundingBox();
    const search = await page.locator(".search-wrap").boundingBox();
    const switcher = await page.locator("[data-house-switcher]").boundingBox();
    const account = await page.locator(".header-right").boundingBox();
    expect(Math.abs(search.x + search.width / 2 - (header.x + header.width / 2))).toBeLessThanOrEqual(1);
    if (width > 1180) {
      expect(switcher.x + switcher.width).toBeLessThanOrEqual(search.x);
      expect(search.x + search.width).toBeLessThanOrEqual(account.x);
    } else {
      expect(search.y + search.height).toBeLessThanOrEqual(switcher.y);
      expect(search.y + search.height).toBeLessThanOrEqual(account.y);
    }
    await page.locator("[data-house-toggle]").click();
    await page.getByRole("searchbox", { name: "Search houses" }).fill("House 099");
    await expect(page.locator("[data-house-row]:visible")).toHaveCount(1);
    const bounds = await page.locator("[data-house-panel]").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-house-panel]")).toBeHidden();
    await expect(page.locator("[data-house-toggle]")).toBeFocused();
  }
  await page.locator("[data-house-toggle]").press("ArrowDown");
  await page.getByRole("searchbox", { name: "Search houses" }).fill("House 099");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-house-name]")).toHaveText("House 099");
  expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(original);
  await chooseHouse(page, longName);
  await expect(page.locator("[data-house-switcher] script, [data-house-switcher] mountain")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("searchbox", { name: "Search houses" }).fill("missing house");
  await expect(page.locator("[data-house-status]")).toContainText("No matching houses");
  await expect(page.locator("[data-house-add]")).toBeVisible();
  await page.locator("h1").click();
  await expect(page.locator("[data-house-panel]")).toBeHidden();
});

test("house names and failed storage writes never create phantom houses", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-house-add]").click();
  const dialog = page.locator("#editor");
  await page.getByRole("textbox", { name: "House name" }).fill(" my HOME ");
  await dialog.getByRole("button", { name: "Add house", exact: true }).click();
  await expect(dialog.locator("[data-settings-error]")).toContainText("already exists");
  await page.getByRole("textbox", { name: "House name" }).fill("   ");
  await dialog.getByRole("button", { name: "Add house", exact: true }).click();
  await expect(dialog.locator("[data-settings-error]")).toContainText("name");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "haven-inventory") throw Error("Storage full");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("textbox", { name: "House name" }).fill("Unsaved house");
  await dialog.getByRole("button", { name: "Add house", exact: true }).click();
  await expect(dialog.locator("[data-settings-error]")).toContainText("Could not save");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText("My home");
  await page.locator("[data-house-toggle]").click();
  await expect(page.locator("[data-house-option]")).toHaveCount(1);
});

test("backups and scan cleanup include inactive houses and restoring replaces all houses", async ({ page }) => {
  const inventory = lakeInventory();
  inventory.scans = [
    { id: "home-scan", locationId: "living-room", assetId: "home-file", name: "Home", format: "obj" },
    { id: "lake-scan", locationId: "cabin", assetId: "lake-file", name: "Lake", format: "obj" },
  ];
  await seed(page, inventory);
  await page.goto("/");
  await page.evaluate(async () => {
    const { putAsset } = await import("/src/scan-storage.js");
    const blob = new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]);
    await putAsset("home-file", blob, null);
    await putAsset("lake-file", blob, null);
    await putAsset("unreferenced-file", blob, null);
  });
  await chooseHouse(page, "Lake house");
  await expect.poll(() => page.evaluate(async () => {
    const { getAsset } = await import("/src/scan-storage.js");
    return !!await getAsset("unreferenced-file", null);
  })).toBe(false);
  expect(await page.evaluate(async () => {
    const { getAsset } = await import("/src/scan-storage.js");
    return [!!await getAsset("home-file", null), !!await getAsset("lake-file", null)];
  })).toEqual([true, true]);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export a backup", exact: true }).first().click();
  const download = await downloadEvent;
  const backup = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(backup.inventory.houses).toHaveLength(2);
  expect(backup.inventory.items[0].name).toBe("Home keys");
  expect(backup.assets.map((asset) => asset.id).sort()).toEqual(["home-file", "lake-file"]);
  await createHouse(page, "Temporary house");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup", exact: true }).first().click();
  await (await chooser).setFiles({ name: "houses.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator(".modal-description")).toContainText("Replace all your houses");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator("[data-house-name]")).toHaveText("My home");
  await chooseHouse(page, "Lake house");
  await expect(page.getByRole("button", { name: "Open Cabin", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).houses.length)).toBe(2);
});

test("switching houses during backup file reading invalidates the restore even after switching back", async ({ page }) => {
  await seed(page, lakeInventory());
  await page.goto("/");
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function() {
      window.backupReadWaiting = true;
      await new Promise((resolve) => { window.releaseBackupRead = resolve; });
      return original.call(this);
    };
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup", exact: true }).first().click();
  await (await chooser).setFiles({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(initialState())) });
  await page.waitForFunction(() => window.backupReadWaiting);
  await chooseHouse(page, "Lake house");
  await chooseHouse(page, "My home");
  await page.evaluate(() => window.releaseBackupRead());
  await expect(page.locator("#toast")).toContainText("Your account or inventory changed");
  await expect(page.locator("#editor")).not.toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).houses.length)).toBe(2);
});

test("accounts and guests keep separate house collections and selection without syncing switches", async ({ page }) => {
  await page.route("**/src/firebase-config.json*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'export default {apiKey:"test",authDomain:"test",projectId:"test",appId:"test"};',
  }));
  await page.route("**/src/firebase-service.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export async function createFirebaseService() {
      const records = new Map(), listeners = new Map();
      return {
        watchAuth(callback) { window.changeHouseAuth = callback; queueMicrotask(() => callback(null)); },
        watch(uid, callback) {
          listeners.set(uid, callback);
          queueMicrotask(() => callback(records.get(uid)?.record || null));
          return () => listeners.delete(uid);
        },
        async read(uid) { return records.get(uid).inventory; },
        async publish(uid, inventory, revision) {
          const record = { revision: revision + 1 };
          records.set(uid, { inventory, record });
          queueMicrotask(() => listeners.get(uid)?.(record));
          return record.revision;
        }
      };
    }`,
  }));
  await seed(page, lakeInventory());
  await page.goto("/");
  await page.waitForFunction(() => window.changeHouseAuth);
  await chooseHouse(page, "Lake house");
  await page.evaluate(async () => { await window.changeHouseAuth({ uid: "alice", displayName: "Alice" }); });
  await expect(page.locator("[data-house-name]")).toHaveText("My home");
  await createHouse(page, "City house");
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Rename house", exact: true }).click();
  await page.getByRole("textbox", { name: "House name" }).fill("City apartment");
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText("City apartment");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("haven-account:alice"))?.dirty)).toBe(false);
  const saved = await page.evaluate(() => localStorage.getItem("haven-account:alice"));
  await chooseHouse(page, "My home");
  await chooseHouse(page, "City apartment");
  expect(await page.evaluate(() => localStorage.getItem("haven-account:alice"))).toBe(saved);
  await page.evaluate(async () => { await window.changeHouseAuth(null); });
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await expect(page.getByRole("button", { name: "Open Cabin", exact: true })).toBeVisible();
  await page.evaluate(async () => { await window.changeHouseAuth({ uid: "alice", displayName: "Alice" }); });
  await expect(page.locator("[data-house-name]")).toHaveText("City apartment");
  await expect(page.locator(".room-card")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).houses.map((house) => house.name))).toEqual(["My home", "Lake house"]);
});
