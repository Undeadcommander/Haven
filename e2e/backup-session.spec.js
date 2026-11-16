import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";
import { readFileSync } from "node:fs";

async function setup(page) {
  await page.route("**/src/firebase-config.json*", r => r.fulfill({ contentType: "application/javascript", body: 'export default {apiKey:"test",authDomain:"test",projectId:"test",appId:"test"};' }));
  await page.route("**/src/firebase-service.js*", r => r.fulfill({ contentType: "application/javascript", body: `
    export async function createFirebaseService() {
      let listener;
      return {
        watchAuth(cb) { window.changeAuth = cb; queueMicrotask(() => cb(null)); },
        watch(uid, cb) { listener = cb; window.cloudUpdate = cb; queueMicrotask(() => cb(null)); return () => {}; },
        async read() { return window.cloudInventory; },
        async publish() { return 1; },
        async login() {}, async logout() {}
      };
    }` }));
  const source = readFileSync(new URL("../src/scan-storage.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  await page.route("**/src/scan-storage.js*", r => r.fulfill({ contentType: "application/javascript", body: source.replace('    return {\n      inventory,\n      rollback,', '    if (window.pauseStage) { window.stageWaiting = true; await new Promise(resolve => window.releaseStage = resolve); }\n    return {\n      inventory,\n      rollback,') }));
  await page.goto("/");
  await page.waitForFunction(() => window.changeAuth);
}
async function choose(page, backup) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup" }).first().click();
  await (await chooser).setFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
}
const user = uid => ({ uid, displayName: uid });
const backup = () => ({ format: "haven-backup", version: 2, inventory: initialState(), assets: [] });

test("auth round trip during file read rejects before confirmation", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function() { window.readWaiting = true; await new Promise(resolve => window.releaseRead = resolve); return original.call(this); };
  });
  await choose(page, backup());
  await page.waitForFunction(() => window.readWaiting);
  await page.evaluate(async () => { await window.changeAuth({ uid: "alice" }); await window.changeAuth({ uid: "bob" }); await window.changeAuth({ uid: "alice" }); window.releaseRead(); });
  await expect(page.getByText("Your account or inventory changed. Please choose the backup again.")).toBeVisible();
  await expect(page.getByText("Restore this backup?")).toHaveCount(0);
});

test("external replacement invalidates an open confirmation", async ({ page }) => {
  await setup(page);
  await choose(page, backup());
  await expect(page.getByText("Restore this backup?")).toBeVisible();
  const replacement = initialState(); replacement.locations[0].name = "External room";
  await page.evaluate(value => { localStorage.setItem("haven-inventory", JSON.stringify(value)); window.dispatchEvent(new StorageEvent("storage", { key: "haven-inventory" })); }, replacement);
  // Replacement detaches the old editor; its callback must not be able to save.
  await expect(page.getByRole("button", { name: "Open External room" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")))).toEqual(replacement);
});

test("cloud replacement during staging rolls back staged scans", async ({ page }) => {
  await setup(page);
  await page.evaluate(async u => { await window.changeAuth(u); }, user("alice"));
  await page.waitForTimeout(50);
  const data = backup();
  data.inventory.scans = [{ id: "scan", assetId: "old", locationId: "living-room", name: "room.obj", format: "obj" }];
  data.assets = [{ id: "old", data: `data:application/octet-stream;base64,${Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").toString("base64")}` }];
  await page.evaluate(() => { window.pauseStage = true; });
  await choose(page, data);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.waitForFunction(() => window.stageWaiting);
  const replacement = initialState(); replacement.locations[0].name = "Cloud room";
  await page.evaluate(async value => { window.cloudInventory = value; await window.cloudUpdate({ revision: 1 }); }, replacement);
  await page.evaluate(() => window.releaseStage());
  await expect(page.getByRole("button", { name: "Open Cloud room" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => { const db = await new Promise(resolve => { const r = indexedDB.open("haven-room-scans", 1); r.onsuccess = () => resolve(r.result); }); return await new Promise(resolve => { const r = db.transaction("assets").objectStore("assets").getAllKeys(); r.onsuccess = () => resolve(r.result.length); }); })).toBe(0);
});



test("same-account external change rejects at confirmation", async ({ page }) => {
  await setup(page);
  await page.evaluate(async u => { await window.changeAuth(u); }, user("alice"));
  await choose(page, backup());
  await expect(page.getByText("Restore this backup?")).toBeVisible();
  const replacement = initialState();
  replacement.locations[0].name = "External room";
  const inventory = await page.evaluate((value) => {
    const record = JSON.stringify({ inventory: value, revision: 1, dirty: false });
    localStorage.setItem("haven-account:alice", record);
    window.dispatchEvent(new StorageEvent("storage", { key: "haven-account:alice" }));
    return record;
  }, replacement);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator("#editor .modal-description")).toHaveText("Your account or inventory changed. Please choose the backup again.");
  expect(await page.evaluate(() => localStorage.getItem("haven-account:alice"))).toBe(inventory);
});

for (const source of ["cloud", "another tab", "account switch", "guest tab"]) {
  test(`rollback preserves a staged asset adopted by ${source}`, async ({ page }) => {
    await setup(page);
    if (source !== "guest tab")
      await page.evaluate(async u => { await window.changeAuth(u); }, user("alice"));
    const data = backup();
    data.inventory.scans = [{ id: "scan", assetId: "adopted", locationId: "living-room", name: "room.obj", format: "obj" }];
    const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    data.assets = [{ id: "adopted", data: `data:application/octet-stream;base64,${Buffer.from(obj).toString("base64")}` }];
    await page.evaluate(() => { window.pauseStage = true; });
    await choose(page, data);
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.waitForFunction(() => window.stageWaiting);
    const replacement = structuredClone(data.inventory);
    replacement.locations[0].name = "Adopted room";
    await page.evaluate(async ({ inventory, source }) => {
      if (source === "cloud") {
        window.cloudInventory = inventory;
        await window.cloudUpdate({ revision: 1 });
      } else if (source === "guest tab") {
        localStorage.setItem("haven-inventory", JSON.stringify(inventory));
        window.dispatchEvent(new StorageEvent("storage", { key: "haven-inventory" }));
      } else {
        localStorage.setItem("haven-account:alice", JSON.stringify({ inventory, revision: 1, dirty: false }));
        if (source === "account switch") await window.changeAuth({ uid: "bob" });
        else window.dispatchEvent(new StorageEvent("storage", { key: "haven-account:alice" }));
      }
      window.releaseStage();
    }, { inventory: replacement, source });
    await expect(page.getByText("Your account or inventory changed. Please choose the backup again.").first()).toBeVisible();
    const result = await page.evaluate(async source => {
      const { getAsset } = await import("/src/scan-storage.js");
      const record = JSON.parse(localStorage.getItem(source === "guest tab" ? "haven-inventory" : "haven-account:alice"));
      return { inventory: source === "guest tab" ? record : record.inventory,
        bytes: await (await getAsset("adopted", source === "guest tab" ? null : "alice"))?.text() };
    }, source);
    expect(result.inventory).toEqual(replacement);
    expect(result.bytes).toBe(obj);
  });
}

test("failed save rolls back staged scans", async ({ page }) => {
  await setup(page);
  const data = backup();
  data.inventory.scans = [{ id: "scan", assetId: "old", locationId: "living-room", name: "room.obj", format: "obj" }];
  data.assets = [{ id: "old", data: `data:application/octet-stream;base64,${Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").toString("base64")}` }];
  await choose(page, data);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === "haven-inventory") throw Error("blocked"); return original.call(this, key, value); }; });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator("#editor .modal-description")).toHaveText("Could not save the restored inventory.");
  expect(await page.evaluate(async () => { const db = await new Promise(resolve => { const r = indexedDB.open("haven-room-scans", 1); r.onsuccess = () => resolve(r.result); }); return await new Promise(resolve => { const r = db.transaction("assets").objectStore("assets").getAllKeys(); r.onsuccess = () => resolve(r.result.length); }); })).toBe(0);
});

