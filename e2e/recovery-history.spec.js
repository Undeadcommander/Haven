import { test, expect } from "./fixture.js";
import { readFileSync } from "node:fs";
import { initialState } from "../src/store.js";
import { addHouse } from "../src/houses.js";

function collection() {
  const inventory = addHouse(initialState(), "Lake house", "lake");
  inventory.locations.push({ id: "cabin", parentId: null, houseId: "lake", name: "Cabin", description: "", color: "blue" });
  inventory.items.push({ id: "keys", locationId: "cabin", name: "Lake keys", notes: "Keep these safe" });
  return inventory;
}

async function seed(page, raw, failRead = false) {
  await page.addInitScript(({ raw, failRead }) => {
    localStorage.setItem("haven-inventory", raw);
    if (failRead) {
      const original = Storage.prototype.getItem;
      let pending = true;
      Storage.prototype.getItem = function(key) {
        if (key === "haven-inventory" && pending) {
          pending = false;
          throw Error("Temporary read failure");
        }
        return original.call(this, key);
      };
    }
  }, { raw, failRead });
}

async function attemptRoom(page) {
  await page.getByRole("button", { name: "Add room", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Must not overwrite saved data");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#editor")).toBeVisible();
  await page.locator("#editor").getByRole("button", { name: "Cancel", exact: true }).click();
}

for (const failure of ["malformed", "temporary read"]) {
  test(`${failure} saved data stays read-only and exports its original raw metadata`, async ({ page }) => {
    const raw = failure === "malformed" ? '{"recoverable":"valuable fragment"' : JSON.stringify(collection());
    await seed(page, raw, failure === "temporary read");
    await page.goto("/");
    await expect(page.locator("main .warning")).toContainText("could not be loaded");
    await attemptRoom(page);
    expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(raw);
    await page.locator("[data-house-add]").click();
    await page.getByRole("textbox", { name: "House name" }).fill("Unsaved house");
    await page.locator("#editor").getByRole("button", { name: "Add house", exact: true }).click();
    await expect(page.locator("#editor [data-settings-error]")).toBeVisible();
    await page.locator("#editor").getByRole("button", { name: "Cancel", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export a backup", exact: true }).first().click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toContain("raw-recovery");
    expect(readFileSync(await download.path(), "utf8")).toBe(raw);
    expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(raw);
  });
}

test("an explicit valid restore can replace unreadable saved data", async ({ page }) => {
  await seed(page, "unreadable original");
  await page.goto("/");
  const replacement = collection();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup", exact: true }).first().click();
  await (await chooser).setFiles({ name: "recovery.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(replacement)) });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator("main > .warning")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).items[0].name)).toBe("Lake keys");
  await page.locator("[data-house-add]").click();
  await page.getByRole("textbox", { name: "House name" }).fill("Recovery complete");
  await page.locator("#editor").getByRole("button", { name: "Add house", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText("Recovery complete");
});

test("valid external replacement unlocks recovery while invalid replacement blocks later edits", async ({ page }) => {
  await seed(page, "unreadable original");
  await page.goto("/");
  await page.evaluate((inventory) => {
    localStorage.setItem("haven-inventory", JSON.stringify(inventory));
    window.dispatchEvent(new StorageEvent("storage", { key: "haven-inventory" }));
  }, collection());
  await expect(page.locator("main > .warning")).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem("haven-inventory", "recoverable broken replacement");
    window.dispatchEvent(new StorageEvent("storage", { key: "haven-inventory" }));
  });
  await expect(page.locator("main .warning")).toContainText("could not be loaded");
  await attemptRoom(page);
  expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe("recoverable broken replacement");
});

test("history restores the owning house and room across Back, reload, and Forward", async ({ page }) => {
  await seed(page, JSON.stringify(collection()));
  await page.goto("/");
  await page.getByRole("button", { name: "Open Living room", exact: true }).click();
  await page.locator("[data-house-toggle]").click();
  await page.locator("[data-house-list]").getByRole("button", { name: "Lake house", exact: true }).click();
  await page.getByRole("button", { name: "Open Cabin", exact: true }).click();
  await page.goBack();
  await page.goBack();
  await expect(page.locator("[data-house-name]")).toHaveText("My home");
  await expect(page.locator("h1")).toHaveText("Living room");
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Living room");
  await page.goForward();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await page.goForward();
  await expect(page.locator("h1")).toHaveText("Cabin");
});

test("legacy room links select their house and stale room links fall back safely", async ({ page }) => {
  await seed(page, JSON.stringify(collection()));
  await page.goto("/#room/cabin");
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await expect(page.locator("h1")).toHaveText("Cabin");
  await page.evaluate(() => {
    history.pushState({ houseId: "removed-house", scope: null }, "", "#room/removed-room");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.locator("h1")).toHaveText("Home, organized.");
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("duplicate hash and history events preserve a pending legacy room link until reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("haven-inventory", JSON.stringify({
      version: 1, locations: [{ id: "new-room", parentId: null, name: "New room", description: "", color: "sage" }], items: [],
    }));
    history.pushState(null, "", "#room/new-room");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(await page.evaluate(() => location.hash)).toBe("#room/new-room");
  await page.reload();
  await expect(page.locator("h1")).toHaveText("New room");
});

test("account sign-in and sign-out cannot unlock unreadable guest data", async ({ page }) => {
  await page.route("**/src/firebase-config.json*", route => route.fulfill({
    contentType: "application/javascript",
    body: 'export default {apiKey:"test",authDomain:"test",projectId:"test",appId:"test"};',
  }));
  await page.route("**/src/firebase-service.js*", route => route.fulfill({
    contentType: "application/javascript",
    body: `export async function createFirebaseService() {
      return {
        watchAuth(callback) { window.recoveryAuth = callback; queueMicrotask(() => callback(null)); },
        watch(uid, callback) { queueMicrotask(() => callback(null)); return () => {}; },
        async publish(uid, inventory, revision) { return revision + 1; }
      };
    }`,
  }));
  await seed(page, "original guest recovery fragment");
  await page.goto("/");
  await page.waitForFunction(() => window.recoveryAuth);
  await expect(page.locator("main .warning")).toContainText("could not be loaded");
  await page.evaluate(async () => { await window.recoveryAuth({ uid: "alice", displayName: "Alice" }); });
  await expect(page.locator("main > .warning")).toHaveCount(0);
  await page.locator("[data-house-add]").click();
  await page.getByRole("textbox", { name: "House name" }).fill("Account house");
  await page.locator("#editor").getByRole("button", { name: "Add house", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText("Account house");
  await page.evaluate(async () => { await window.recoveryAuth(null); });
  await expect(page.locator("main .warning")).toContainText("could not be loaded");
  await attemptRoom(page);
  expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe("original guest recovery fragment");
});

test("a restore finishing lease cleanup cannot reset a newer externally replaced view", async ({ page }) => {
  const storageSource = readFileSync(new URL("../src/scan-storage.js", import.meta.url), "utf8")
    .replace("commit: () => commitAssets(created, scope),", `commit: async () => {
      window.restoreCommitWaiting = true;
      await new Promise(resolve => { window.releaseRestoreCommit = resolve; });
      await commitAssets(created, scope);
      window.restoreCommitFinished = true;
    },`);
  await page.route("**/src/scan-storage.js*", route => route.fulfill({ contentType: "application/javascript", body: storageSource }));
  await seed(page, JSON.stringify(collection()));
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup", exact: true }).first().click();
  await (await chooser).setFiles({
    name: "backup.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "haven-backup", version: 2, inventory: collection(), assets: [] })),
  });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.waitForFunction(() => window.restoreCommitWaiting);
  await page.evaluate((inventory) => {
    localStorage.setItem("haven-inventory", JSON.stringify(inventory));
    window.dispatchEvent(new StorageEvent("storage", { key: "haven-inventory" }));
  }, collection());
  await page.getByRole("button", { name: "Open Living room", exact: true }).click();
  await page.evaluate(() => window.releaseRestoreCommit());
  await page.waitForFunction(() => window.restoreCommitFinished);
  await expect(page.locator("h1")).toHaveText("Living room");
  await expect(page.locator("#toast")).not.toContainText("have been restored");
});
