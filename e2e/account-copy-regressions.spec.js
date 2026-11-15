import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";
import { readFileSync } from "node:fs";

for (const change of ["sign out", "switch accounts", "edit inventory"]) {
  test(`guest copy completion preserves the current view after ${change}`, async ({ page }) => {
    await page.route("**/src/firebase-config.json*", (route) => route.fulfill({
      contentType: "application/javascript",
      body: 'export default {apiKey:"test",authDomain:"test",projectId:"test",appId:"test"};',
    }));
    await page.route("**/src/firebase-service.js*", (route) => route.fulfill({
      contentType: "application/javascript",
      body: `export async function createFirebaseService() { return {
        watchAuth(cb) { window.changeAuth = cb; queueMicrotask(() => cb(null)); },
        watch(uid, cb) { queueMicrotask(() => cb(null)); return () => {}; },
        async publish(uid, inventory, revision) { return revision + 1; }
      }; }`,
    }));
    const source = readFileSync(new URL("../src/scan-storage.js", import.meta.url), "utf8");
    const commit = "return { rollback, commit: () => commitAssets(created, toScope) };";
    expect(source).toContain(commit);
    await page.route("**/src/scan-storage.js*", (route) => route.fulfill({
      contentType: "application/javascript",
      body: source.replace(commit, `return { rollback, commit: async () => {
        window.copyWaiting = true;
        await new Promise(resolve => window.releaseCopy = resolve);
        try { await commitAssets(created, toScope); }
        finally { window.copyFinished = true; }
      } };`),
    }));
    const guest = initialState(), bob = initialState();
    guest.locations[0].name = "Guest room";
    guest.scans = [{ id: "guest-scan", assetId: "guest-file", locationId: "living-room", name: "room.obj", format: "obj" }];
    bob.locations[0].name = "Bob room";
    await page.addInitScript(({ guest, bob }) => {
      localStorage.setItem("haven-inventory", JSON.stringify(guest));
      localStorage.setItem("haven-account:bob", JSON.stringify({ inventory: bob, revision: 0, dirty: false }));
    }, { guest, bob });
    await page.goto("/");
    await page.waitForFunction(() => window.changeAuth);
    await page.evaluate(async () => {
      const { putAsset } = await import("/src/scan-storage.js");
      await putAsset("guest-file", new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]), null);
      await window.changeAuth({ uid: "alice" });
    });
    await expect(page.locator("[data-account-status]")).toContainText("up to date");
    await page.getByRole("button", { name: "Account", exact: true }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Copy device inventory to account" }).click();
    await page.waitForFunction(() => window.copyWaiting);

    if (change === "edit inventory") {
      await page.keyboard.press("Escape");
      await expect(page.locator(".room-card")).toHaveCount(3);
      await expect(page.locator("[data-house-name]")).toHaveText("My home (device)");
      await page.getByRole("button", { name: "Add room", exact: true }).first().click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("New room after copy");
      await page.getByRole("button", { name: "Save", exact: true }).click();
    } else {
      await page.evaluate(async change => {
        await window.changeAuth(change === "sign out" ? null : { uid: "bob" });
      }, change);
    }
    await page.evaluate(() => window.releaseCopy());
    await page.waitForFunction(() => window.copyFinished);
    await expect(page.locator(".room-card")).toHaveCount(change === "edit inventory" ? 4 : 3);
    const expectedRoom = change === "edit inventory" ? "New room after copy" : change === "sign out" ? "Guest room" : "Bob room";
    await expect(page.getByRole("button", { name: `Open ${expectedRoom}`, exact: true })).toBeVisible();
    const saved = await page.evaluate(async () => {
      const { getAsset } = await import("/src/scan-storage.js");
      const inventory = JSON.parse(localStorage.getItem("haven-account:alice")).inventory;
      return { rooms: inventory.locations.length, hasFile: !!await getAsset(inventory.scans[0].assetId, "alice"),
        guest: JSON.parse(localStorage.getItem("haven-inventory")) };
    });
    expect(saved.rooms).toBe(change === "edit inventory" ? 7 : 6);
    expect(saved.hasFile).toBe(true);
    expect(saved.guest).toEqual(guest);
  });
}
