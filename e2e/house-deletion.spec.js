import { test, expect } from "./fixture.js";
import { initialState, validState } from "../src/store.js";
import { addHouse, inventoryForHouse } from "../src/houses.js";
import { houseDeletionFixture } from "../scripts/audit-house-deletion.mjs";

function fixture() {
  const data = addHouse(addHouse(initialState(), "Lake house", "lake"), "City apartment", "city");
  data.locations.push(...[
    ["cabinet", "living-room", "Cabinet"],
    ["drawer", "cabinet", "Drawer"],
    ["box", "drawer", "Box"],
    ["cabin", null, "Cabin", "lake"],
    ["city-room", null, "Studio", "city"],
  ].map(([id, parentId, name, houseId]) => ({ id, parentId, name, ...(houseId ? { houseId } : {}), description: "", color: "sage" })));
  data.items = [
    ["lamp", "living-room", "Lamp"], ["book", "cabinet", "Book"],
    ["keys", "box", "Keys"], ["lake-key", "cabin", "Lake key"], ["city-key", "city-room", "City key"],
  ].map(([id, locationId, name]) => ({ id, locationId, name, notes: "" }));
  data.scans = ["living-room", "cabinet", "drawer", "cabin", "city-room"].map((locationId) => ({
    id: `scan-${locationId}`, assetId: `asset-${locationId}`, locationId, name: "scan.obj", format: "obj",
  }));
  data.markers = [
    ["room-cabinet", "living-room", "container", "cabinet"],
    ["room-lamp", "living-room", "item", "lamp"],
    ["cabinet-drawer", "cabinet", "container", "drawer"],
    ["cabinet-book", "cabinet", "item", "book"],
    ["drawer-keys", "drawer", "item", "keys"],
    ["lake-pin", "cabin", "item", "lake-key"],
    ["city-pin", "city-room", "item", "city-key"],
  ].map(([id, location, kind, targetId]) => ({ id, scanId: `scan-${location}`, kind, targetId, position: [0, 0, 0] }));
  return data;
}

async function seed(page, data = fixture()) {
  await page.addInitScript((value) => {
    if (!localStorage.getItem("haven-inventory")) localStorage.setItem("haven-inventory", JSON.stringify(value));
  }, data);
  await page.goto("/");
}
const editor = (page) => page.locator("#editor");
const inventory = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")));
const submit = (page, name) => editor(page).getByRole("button", { name, exact: true });
async function openDelete(page) {
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Delete house", exact: true }).click();
}
async function chooseHouse(page, name) {
  await page.locator("[data-house-toggle]").click();
  await page.locator("[data-house-list]").getByRole("button", { name, exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText(name);
}
async function chooseDeleteEverything(page) {
  await editor(page).getByRole("radio", { name: /Delete everything/ }).check();
  await submit(page, "Continue").click();
  await expect(submit(page, "Cancel")).toBeFocused();
}

test("house deletion is available in the switcher and house editor, with Cancel as the safe default", async ({ page }) => {
  await seed(page);
  const before = await inventory(page);
  await page.locator("[data-house-toggle]").press("ArrowDown");
  await page.getByRole("button", { name: "Delete house", exact: true }).press("Enter");
  await expect(editor(page).getByRole("heading")).toHaveText("Delete My home?");
  await expect(submit(page, "Cancel")).toBeFocused();
  await expect(submit(page, "Cancel")).toHaveClass("primary");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeHidden();
  expect(await inventory(page)).toEqual(before);
  await page.locator("[data-house-toggle]").click();
  await page.getByRole("button", { name: "Rename house", exact: true }).click();
  await submit(page, "Delete house").click();
  await expect(submit(page, "Cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeHidden();
  expect(await inventory(page)).toEqual(before);
});

test("moving house contents together keeps rooms, nested items, scans and pins across reloads", async ({ page }) => {
  await seed(page);
  const before = await inventory(page);
  await page.getByRole("button", { name: "Open Living room", exact: true }).click();
  await openDelete(page);
  const destination = editor(page).getByRole("combobox", { name: "Destination house", exact: true });
  await expect(destination.locator("option")).toHaveText(["Choose a house", "Lake house", "City apartment"]);
  await destination.selectOption("lake");
  await submit(page, "Move contents & delete").click();
  await expect(editor(page)).toBeHidden();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await expect(page.locator("[data-house-toggle]")).toBeFocused();
  await expect(page.locator("h1")).toHaveText("Home, organized.");
  const after = await inventory(page);
  expect(after.houses.map((house) => house.id)).toEqual(["lake", "city"]);
  expect(after.locations).toEqual(before.locations.map((location) => location.houseId === "my-home" ? { ...location, houseId: "lake" } : location));
  expect(after.items).toEqual(before.items);
  expect(after.scans).toEqual(before.scans);
  expect(after.markers).toEqual(before.markers);
  expect(validState(after)).toBe(true);
  await page.reload();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await page.getByRole("searchbox", { name: "Search items and rooms" }).fill("Keys");
  await expect(page.locator(".search-result")).toContainText("Living room / Cabinet / Drawer / Box");
  await page.goBack();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
});

test("separate house destinations split rooms, nested containers and items, clearing only obsolete pins", async ({ page }) => {
  await seed(page);
  await openDelete(page);
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  for (const room of ["Living room", "Garage", "Bathroom"])
    await editor(page).getByLabel(`Destination for ${room}`, { exact: false }).selectOption(room === "Garage" ? "city" : "lake");
  await editor(page).getByLabel("Destination for Drawer", { exact: false }).selectOption("city-room");
  const lamp = editor(page).getByLabel("Destination for Lamp", { exact: false });
  await expect(lamp.locator('option[value="cabin"]')).toHaveText("Lake house / Cabin");
  await lamp.selectOption("cabin");
  await editor(page).getByLabel("Destination for Book", { exact: false }).selectOption("box");
  await submit(page, "Move contents & delete").click();
  await expect(editor(page)).toBeHidden();
  const after = await inventory(page);
  expect(after.locations.find((location) => location.id === "living-room").houseId).toBe("lake");
  expect(after.locations.find((location) => location.id === "garage").houseId).toBe("city");
  expect(after.locations.find((location) => location.id === "drawer").parentId).toBe("city-room");
  expect(after.locations.find((location) => location.id === "box").parentId).toBe("drawer");
  expect(after.items.find((item) => item.id === "lamp").locationId).toBe("cabin");
  expect(after.items.find((item) => item.id === "book").locationId).toBe("box");
  expect(after.items.find((item) => item.id === "keys").locationId).toBe("box");
  expect(after.markers.map((marker) => marker.id)).toEqual(["room-cabinet", "drawer-keys", "lake-pin", "city-pin"]);
  expect(validState(after)).toBe(true);
});

test("separate house moves reject cycles atomically and retain choices for retry", async ({ page }) => {
  await seed(page);
  const before = await inventory(page);
  await openDelete(page);
  await editor(page).getByRole("combobox", { name: "Destination house", exact: true }).selectOption("lake");
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  await editor(page).getByLabel("Destination for Cabinet", { exact: false }).selectOption("drawer");
  await submit(page, "Move contents & delete").click();
  await expect(editor(page).getByRole("alert")).toContainText("cycle");
  expect(await inventory(page)).toEqual(before);
  await editor(page).getByLabel("Destination for Drawer", { exact: false }).selectOption("cabin");
  await submit(page, "Move contents & delete").click();
  await expect(editor(page)).toBeHidden();
  expect(validState(await inventory(page))).toBe(true);
});

test("deleting a house and its contents requires a second confirmation and preserves other houses", async ({ page }) => {
  await seed(page);
  const before = await inventory(page);
  await openDelete(page);
  await chooseDeleteEverything(page);
  await expect(editor(page).getByRole("heading")).toHaveText("Delete everything in My home?");
  expect(await inventory(page)).toEqual(before);
  await page.keyboard.press("Enter");
  expect(await inventory(page)).toEqual(before);
  await openDelete(page);
  await chooseDeleteEverything(page);
  await submit(page, "Delete everything").click();
  await expect(editor(page)).toBeHidden();
  const after = await inventory(page);
  for (const houseId of ["lake", "city"])
    expect(inventoryForHouse(after, houseId)).toEqual({ ...inventoryForHouse(before, houseId), houses: after.houses });
  expect(after.locations.map((location) => location.id)).toEqual(["cabin", "city-room"]);
  expect(after.items.map((item) => item.id)).toEqual(["lake-key", "city-key"]);
  expect(after.scans.map((scan) => scan.locationId)).toEqual(["cabin", "city-room"]);
  expect(after.markers.map((marker) => marker.id)).toEqual(["lake-pin", "city-pin"]);
  expect(validState(after)).toBe(true);
  await page.reload();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await page.locator("[data-house-toggle]").click();
  await expect(page.locator("[data-house-option]")).toHaveCount(2);
});

for (const operation of ["move", "delete"]) {
  test(`failed house ${operation} saves leave everything untouched and allow retry`, async ({ page }) => {
    await seed(page);
    const before = await inventory(page);
    await openDelete(page);
    if (operation === "move") await editor(page).getByRole("combobox", { name: "Destination house", exact: true }).selectOption("city");
    else await chooseDeleteEverything(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "haven-inventory") throw Error("Storage full");
        return original.call(this, key, value);
      };
      window.restoreHouseStorage = () => { Storage.prototype.setItem = original; };
    });
    const label = operation === "move" ? "Move contents & delete" : "Delete everything";
    await submit(page, label).click();
    await expect(editor(page).getByRole("alert")).toContainText("Nothing has been moved or deleted");
    expect(await inventory(page)).toEqual(before);
    await expect(page.locator("[data-house-name]")).toHaveText("My home");
    await page.evaluate(() => window.restoreHouseStorage());
    await submit(page, label).click();
    await expect(editor(page)).toBeHidden();
    const after = await inventory(page);
    expect(after.houses.some((house) => house.id === "my-home")).toBe(false);
    expect(validState(after)).toBe(true);
    await expect(page.locator("[data-house-name]")).toHaveText(operation === "move" ? "City apartment" : "Lake house");
  });
}

test("empty house deletion needs no destination and leaves the other house intact", async ({ page }) => {
  const data = addHouse(fixture(), "Empty house", "empty");
  await seed(page, data);
  await chooseHouse(page, "Empty house");
  await openDelete(page);
  await expect(editor(page)).toContainText("This house is empty");
  await expect(submit(page, "Cancel")).toBeFocused();
  await submit(page, "Delete house").click();
  await expect(editor(page)).toBeHidden();
  expect(await inventory(page)).toEqual({ ...data, houses: data.houses.filter((house) => house.id !== "empty") });
  await expect(page.locator("[data-house-name]")).toHaveText("My home");
});

for (const occupied of [false, true]) {
  test(`last ${occupied ? "occupied" : "empty"} house cannot be deleted until another house is created`, async ({ page }) => {
    if (occupied) await page.setViewportSize({ width: 320, height: 480 });
    const data = initialState();
    if (!occupied) data.locations = [];
    else data.items = [{ id: "keys", locationId: "living-room", name: "Keys", notes: "" }];
    await seed(page, data);
    const before = await inventory(page);
    await page.locator("[data-house-toggle]").click();
    await expect(page.getByRole("button", { name: "Delete house", exact: true })).toBeDisabled();
    await expect(page.locator("[data-house-delete-help]")).toHaveText("Create another house before deleting your last house.");
    await page.getByRole("button", { name: "Rename house", exact: true }).click();
    await expect(submit(page, "Delete house")).toBeDisabled();
    await expect(editor(page).locator("#editor-delete-help")).toHaveText("Create another house before deleting your last house.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await submit(page, "Cancel").click();
    expect(await inventory(page)).toEqual(before);

    await page.locator("[data-house-add]").click();
    await editor(page).getByLabel("House name", { exact: true }).fill("Another home");
    await submit(page, "Add house").click();
    await expect(page.locator("[data-house-name]")).toHaveText("Another home");
    const destinationId = (await inventory(page)).houses.find((house) => house.name === "Another home").id;
    await chooseHouse(page, "My home");
    await openDelete(page);
    if (occupied) await editor(page).getByRole("combobox", { name: "Destination house", exact: true }).selectOption(destinationId);
    await submit(page, occupied ? "Move contents & delete" : "Delete house").click();
    await expect(editor(page)).toBeHidden();
    const after = await inventory(page);
    expect(after.houses).toHaveLength(1);
    expect(after.houses).toEqual([{ id: destinationId, name: "Another home" }]);
    expect(after.locations.map((location) => location.id)).toEqual(data.locations.map((location) => location.id));
    expect(after.items).toEqual(data.items);
    expect(validState(after)).toBe(true);
    await page.reload();
    await expect(page.locator("[data-house-name]")).toHaveText("Another home");
    await page.locator("[data-house-toggle]").click();
    await expect(page.getByRole("button", { name: "Delete house", exact: true })).toBeDisabled();
  });
}

test("the last-house handler rejects a forced click without changing saved inventory", async ({ page }) => {
  await seed(page, initialState());
  const before = await inventory(page);
  await page.locator("[data-house-toggle]").click();
  await page.locator("[data-house-delete]").evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  await expect(page.locator("#toast")).toHaveText("Create another house before deleting your last house.");
  await expect(editor(page)).toBeHidden();
  expect(await inventory(page)).toEqual(before);
});

test("a failed second-house save cannot enable deletion of the last house", async ({ page }) => {
  await seed(page, initialState());
  const before = await inventory(page);
  await page.locator("[data-house-add]").click();
  await editor(page).getByLabel("House name", { exact: true }).fill("Unsaved home");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "haven-inventory") throw Error("Storage full");
      return original.call(this, key, value);
    };
  });
  await submit(page, "Add house").click();
  await expect(editor(page).getByRole("alert")).toContainText("Could not save this house");
  await submit(page, "Cancel").click();
  await page.locator("[data-house-toggle]").click();
  await expect(page.locator("[data-house-option]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Delete house", exact: true })).toBeDisabled();
  expect(await inventory(page)).toEqual(before);
});

test("house deletion choices stay paginated and fit narrow screens in dark mode", async ({ page }) => {
  const data = fixture();
  for (let offset = 0; offset < 25; offset++)
    data.locations.push({ id: `room-${offset}`, parentId: null, houseId: "my-home", name: `Room ${offset}`, description: "", color: "sage" });
  await page.setViewportSize({ width: 320, height: 740 });
  await seed(page, data);
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("dark");
  await openDelete(page);
  await editor(page).getByRole("combobox", { name: "Destination house", exact: true }).selectOption("lake");
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  await expect(editor(page).locator("[data-delete-record]")).toHaveCount(20);
  await editor(page).getByLabel("Destination for Living room", { exact: false }).selectOption("city");
  await submit(page, "Next contents").click();
  await editor(page).getByLabel("Destination for Room 24", { exact: false }).selectOption("city");
  await submit(page, "Previous contents").click();
  await expect(editor(page).getByLabel("Destination for Living room", { exact: false })).toHaveValue("city");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await editor(page).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await submit(page, "Move contents & delete").click();
  await expect(editor(page)).toBeHidden();
  const after = await inventory(page);
  expect(after.locations.find((location) => location.id === "room-24").houseId).toBe("city");
  expect(after.locations.find((location) => location.id === "living-room").houseId).toBe("city");
  expect(after.locations.find((location) => location.id === "room-0").houseId).toBe("lake");
  expect(validState(after)).toBe(true);
});

test("deep destination lists expand one at a time, stay searchable, and preserve off-page choices", async ({ page }) => {
  const data = houseDeletionFixture({ houses: 3, sourceLocations: 160, sourceItems: 200, deep: true });
  await seed(page, data);
  await openDelete(page);
  await editor(page).getByRole("combobox", { name: "Destination house", exact: true }).selectOption("h1");
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  await expect(editor(page).locator("[data-delete-record]")).toHaveCount(20);
  expect(await editor(page).locator("option").count()).toBeLessThan(100);
  await submit(page, "Next contents").click();
  expect(await editor(page).locator("option").count()).toBeLessThan(250);
  const characters = await editor(page).locator("option").evaluateAll((options) => options.reduce((sum, option) => sum + option.textContent.length, 0));
  expect(characters).toBeLessThan(45_000);
  const choice = editor(page).locator('[name="container-destination-19"]');
  await choice.focus();
  await choice.selectOption("l2-0");
  await editor(page).getByRole("searchbox", { name: "Search destinations" }).fill("Space 2-003");
  const next = editor(page).locator('[name="container-destination-20"]');
  await next.focus();
  await expect(next.locator("option")).toHaveCount(2);
  await next.selectOption("l2-3");
  await submit(page, "Previous contents").click();
  await submit(page, "Move contents & delete").click();
  await expect(editor(page)).toBeHidden();
  const after = await inventory(page);
  expect(after.locations.find((location) => location.id === "l0-20").parentId).toBe("l2-0");
  expect(after.locations.find((location) => location.id === "l0-21").parentId).toBe("l2-3");
  expect(after.items).toEqual(data.items);
  expect(validState(after)).toBe(true);
});

for (const operation of ["move", "delete"]) {
  test(`account house ${operation} respects auth changes, syncs the full inventory, and preserves guest houses`, async ({ page }) => {
    const accountData = fixture();
    const guestData = { ...fixture(), houses: [{ id: "guest", name: "Guest home" }], locations: [], items: [], scans: [], markers: [] };
    await page.route("**/src/firebase-config.json*", (route) => route.fulfill({
      contentType: "application/javascript",
      body: 'export default {apiKey:"test",authDomain:"test",projectId:"test",appId:"test"};',
    }));
    await page.route("**/src/firebase-service.js*", (route) => route.fulfill({
      contentType: "application/javascript",
      body: `export async function createFirebaseService() { return {
        watchAuth(callback) { window.changeDeletionAuth = callback; queueMicrotask(() => callback({uid:"house-user",displayName:"House user"})); },
        watch(uid, callback) { queueMicrotask(() => callback({revision:1})); return () => {}; },
        async read() { return JSON.parse(localStorage.getItem("haven-account:house-user")).inventory; },
        async publish(uid, inventory, revision) { window.publishedHouseInventory = inventory; return revision + 1; }
      }; }`,
    }));
    await page.addInitScript((data) => {
      if (!localStorage.getItem("haven-account:house-user"))
        localStorage.setItem("haven-account:house-user", JSON.stringify({ inventory: data, revision: 1, dirty: false }));
    }, accountData);
    await seed(page, guestData);
    await expect(page.locator("[data-account-status]")).toContainText("Account is up to date");
    await openDelete(page);
    await chooseDeleteEverything(page);
    await page.evaluate(async () => { await window.changeDeletionAuth(null); });
    await expect(editor(page)).toBeHidden();
    await expect(page.locator("[data-house-name]")).toHaveText("Guest home");
    expect(await inventory(page)).toEqual(guestData);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-account:house-user")).inventory)).toEqual(accountData);

    await page.evaluate(async () => { await window.changeDeletionAuth({ uid: "house-user", displayName: "House user" }); });
    await expect(page.locator("[data-house-name]")).toHaveText("My home");
    await openDelete(page);
    if (operation === "delete") await chooseDeleteEverything(page);
    else await editor(page).getByRole("combobox", { name: "Destination house", exact: true }).selectOption("city");
    await submit(page, operation === "delete" ? "Delete everything" : "Move contents & delete").click();
    await expect(editor(page)).toBeHidden();
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem("haven-account:house-user")).inventory);
    expect(after.houses.map((house) => house.id)).toEqual(["lake", "city"]);
    expect(after.items).toEqual(operation === "move" ? accountData.items : accountData.items.filter((item) => ["lake-key", "city-key"].includes(item.id)));
    expect(validState(after)).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("haven-account:house-user")).dirty)).toBe(false);
    expect(await page.evaluate(() => window.publishedHouseInventory)).toEqual(after);
    expect(await inventory(page)).toEqual(guestData);
    await page.evaluate(async () => { await window.changeDeletionAuth(null); });
    await expect(page.locator("[data-house-name]")).toHaveText("Guest home");
  });
}
