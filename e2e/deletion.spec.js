import { test, expect } from "./fixture.js";
import { initialState, validState } from "../src/store.js";
import { addHouse } from "../src/houses.js";

function fixture() {
  const data = addHouse(initialState(), "Lake house", "lake");
  for (const [id, parentId, name, houseId] of [
    ["office", null, "Office", "my-home"],
    ["cabinet", "living-room", "Cabinet"],
    ["drawer", "cabinet", "Drawer"],
    ["box", "drawer", "Box"],
    ["closet", "office", "Closet"],
    ["cabin", null, "Cabin", "lake"],
  ]) data.locations.push({ id, parentId, name, houseId, description: "", color: "sage" });
  data.items = [
    ["lamp", "living-room", "Lamp"], ["book", "cabinet", "Book"],
    ["keys", "box", "Keys"], ["coat", "closet", "Coat"], ["lake-key", "cabin", "Lake key"],
  ].map(([id, locationId, name]) => ({ id, locationId, name, notes: "" }));
  data.scans = ["living-room", "cabinet", "drawer"].map((locationId) => ({
    id: `scan-${locationId}`, assetId: `asset-${locationId}`, locationId, name: "scan.obj", format: "obj",
  }));
  data.markers = [
    ["old-cabinet", "living-room", "container", "cabinet"],
    ["old-keys", "living-room", "item", "keys"],
    ["old-lamp", "living-room", "item", "lamp"],
    ["cabinet-drawer", "cabinet", "container", "drawer"],
    ["cabinet-book", "cabinet", "item", "book"],
    ["drawer-keys", "drawer", "item", "keys"],
  ].map(([id, scan, kind, targetId]) => ({ id, scanId: `scan-${scan}`, kind, targetId, position: [0, 0, 0] }));
  return data;
}
async function seed(page, data = fixture(), route = "/") {
  await page.addInitScript((inventory) => {
    if (!localStorage.getItem("haven-inventory")) localStorage.setItem("haven-inventory", JSON.stringify(inventory));
  }, data);
  await page.goto(route);
}
const inventory = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")));
const editor = (page) => page.locator("#editor");
const cancel = (page) => editor(page).getByRole("button", { name: "Cancel", exact: true });
async function gearDelete(page, name, kind) {
  await page.getByRole("button", { name: `Settings for ${name}`, exact: true }).click();
  await editor(page).getByRole("button", { name: `Delete ${kind}`, exact: true }).click();
}

test("room, container, and item gear deletion focuses and highlights Cancel; Enter cancels", async ({ page }) => {
  await seed(page);
  const before = await inventory(page);
  await gearDelete(page, "Living room", "room");
  await expect(cancel(page)).toBeFocused();
  await expect(cancel(page)).toHaveClass("primary");
  await page.keyboard.press("Enter");
  await expect(editor(page)).not.toBeVisible();
  expect(await inventory(page)).toEqual(before);

  await page.getByRole("button", { name: "Open Living room", exact: true }).click();
  await gearDelete(page, "Cabinet", "container");
  await expect(cancel(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page)).not.toBeVisible();
  await gearDelete(page, "Lamp", "item");
  await expect(cancel(page)).toBeFocused();
  await expect(cancel(page)).toHaveClass("primary");
  await cancel(page).click();
  expect(await inventory(page)).toEqual(before);
  await gearDelete(page, "Lamp", "item");
  await editor(page).getByRole("button", { name: "Delete item", exact: true }).click();
  await expect(editor(page)).toBeHidden();
  const after = await inventory(page);
  expect(after.items.some((item) => item.id === "lamp")).toBe(false);
  expect(after.markers.some((marker) => marker.targetId === "lamp")).toBe(false);
  expect(validState(after)).toBe(true);
});

test("moving a room's contents together preserves nesting, scans, other houses, and search paths", async ({ page }) => {
  await seed(page);
  await gearDelete(page, "Living room", "room");
  await expect(editor(page).getByRole("combobox", { name: "Destination", exact: true }).locator("option")).toHaveText([
    "Choose a room or container", "Bathroom", "Garage", "Office", "Office / Closet",
  ]);
  await editor(page).getByRole("combobox", { name: "Destination", exact: true }).selectOption("closet");
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page)).not.toBeVisible();
  const data = await inventory(page);
  expect(data.locations.some((location) => location.id === "living-room")).toBe(false);
  expect(data.locations.find((location) => location.id === "cabinet").parentId).toBe("closet");
  expect(data.locations.find((location) => location.id === "drawer").parentId).toBe("cabinet");
  expect(data.locations.find((location) => location.id === "box").parentId).toBe("drawer");
  expect(data.items.find((item) => item.id === "lamp").locationId).toBe("closet");
  expect(data.items.find((item) => item.id === "keys").locationId).toBe("box");
  expect(data.items.find((item) => item.id === "lake-key").locationId).toBe("cabin");
  expect(data.scans.map((scan) => scan.locationId)).toEqual(["cabinet", "drawer"]);
  expect(data.markers.map((marker) => marker.id)).toEqual(["cabinet-drawer", "cabinet-book", "drawer-keys"]);
  expect(validState(data)).toBe(true);
  await page.reload();
  await page.getByRole("searchbox").fill("Keys");
  await expect(page.locator(".search-result")).toContainText("Office / Closet / Cabinet / Drawer / Box");
});

test("separate destinations can split nested branches and items while preserving the rest", async ({ page }) => {
  await seed(page);
  await gearDelete(page, "Living room", "room");
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  await editor(page).getByLabel("Destination for Cabinet", { exact: false }).selectOption("office");
  await editor(page).getByLabel("Destination for Drawer", { exact: false }).selectOption("closet");
  await editor(page).getByLabel("Destination for Lamp", { exact: false }).selectOption("garage");
  await editor(page).getByLabel("Destination for Book", { exact: false }).selectOption("bathroom");
  // Box and Keys keep their existing parents, and travel with Drawer.
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page)).not.toBeVisible();
  const data = await inventory(page);
  expect(data.locations.find((location) => location.id === "cabinet").parentId).toBe("office");
  expect(data.locations.find((location) => location.id === "drawer").parentId).toBe("closet");
  expect(data.locations.find((location) => location.id === "box").parentId).toBe("drawer");
  expect(data.items.find((item) => item.id === "keys").locationId).toBe("box");
  expect(data.items.find((item) => item.id === "lamp").locationId).toBe("garage");
  expect(data.items.find((item) => item.id === "book").locationId).toBe("bathroom");
  expect(data.markers.map((marker) => marker.id)).toEqual(["drawer-keys"]);
  expect(validState(data)).toBe(true);
});

test("separate moves reject cycles and can place contents in another container being kept", async ({ page }) => {
  const data = fixture();
  data.locations.push({ id: "shelf", parentId: "living-room", name: "Shelf", description: "", color: "blue" });
  await seed(page, data);
  const before = await inventory(page);
  await gearDelete(page, "Living room", "room");
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  await editor(page).getByLabel("Destination for Cabinet", { exact: false }).selectOption("shelf");
  await editor(page).getByLabel("Destination for Shelf", { exact: false }).selectOption("cabinet");
  await editor(page).getByLabel("Destination for Lamp", { exact: false }).selectOption("cabinet");
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText("cycle");
  expect(await inventory(page)).toEqual(before);
  await editor(page).getByLabel("Destination for Shelf", { exact: false }).selectOption("office");
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page)).not.toBeVisible();
  const after = await inventory(page);
  expect(after.locations.find((location) => location.id === "cabinet").parentId).toBe("shelf");
  expect(after.items.find((item) => item.id === "lamp").locationId).toBe("cabinet");
  expect(validState(after)).toBe(true);
});

test("container deletion from All containers keeps the current view and can move into its parent", async ({ page }) => {
  await seed(page, fixture(), "/#containers");
  await gearDelete(page, "Cabinet", "container");
  await editor(page).getByRole("combobox", { name: "Destination", exact: true }).selectOption("living-room");
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page)).toBeHidden();
  await expect(page.locator("h1")).toHaveText("All your containers.");
  const data = await inventory(page);
  expect(data.locations.some((location) => location.id === "cabinet")).toBe(false);
  expect(data.locations.find((location) => location.id === "drawer").parentId).toBe("living-room");
  expect(data.items.find((item) => item.id === "book").locationId).toBe("living-room");
  expect(data.markers.map((marker) => marker.id)).toEqual(["old-lamp", "drawer-keys"]);
  expect(validState(data)).toBe(true);
});

test("delete everything requires an additional confirmation and a second Cancel is safe", async ({ page }) => {
  await seed(page, fixture(), "/#room/cabinet");
  const before = await inventory(page);
  await page.getByRole("button", { name: "Delete location", exact: true }).click();
  await editor(page).getByRole("radio", { name: /Delete everything/ }).check();
  await editor(page).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(editor(page).getByRole("heading")).toHaveText("Delete everything in Cabinet?");
  await expect(cancel(page)).toBeFocused();
  await expect(cancel(page)).toHaveClass("primary");
  expect(await inventory(page)).toEqual(before);
  await page.keyboard.press("Enter");
  expect(await inventory(page)).toEqual(before);
  await page.getByRole("button", { name: "Delete location", exact: true }).click();
  await editor(page).getByRole("radio", { name: /Delete everything/ }).check();
  await editor(page).getByRole("button", { name: "Continue", exact: true }).click();
  await editor(page).getByRole("button", { name: "Delete everything", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Living room");
  const data = await inventory(page);
  expect(data.locations.some((location) => ["cabinet", "drawer", "box"].includes(location.id))).toBe(false);
  expect(data.items.map((item) => item.id).sort()).toEqual(["coat", "lake-key", "lamp"]);
  expect(data.scans.map((scan) => scan.locationId)).toEqual(["living-room"]);
  expect(data.markers.map((marker) => marker.id)).toEqual(["old-lamp"]);
  expect(validState(data)).toBe(true);
});

test("last occupied room has no move destination and requires an explicit destructive choice", async ({ page }) => {
  const data = initialState();
  data.locations = data.locations.slice(0, 1);
  data.items = [{ id: "key", name: "Key", notes: "", locationId: "living-room" }];
  await seed(page, data);
  await gearDelete(page, "Living room", "room");
  await expect(cancel(page)).toBeFocused();
  await expect(editor(page).getByRole("radio", { name: /Move contents/ })).toBeDisabled();
  await expect(editor(page).getByRole("radio", { name: /Delete everything/ })).not.toBeChecked();
  await expect(editor(page).getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await editor(page).getByRole("radio", { name: /Delete everything/ }).check();
  await editor(page).getByRole("button", { name: "Continue", exact: true }).click();
  await editor(page).getByRole("button", { name: "Delete everything", exact: true }).click();
  await expect(editor(page)).toBeHidden();
  const after = await inventory(page);
  expect(after.locations).toEqual([]);
  expect(after.items).toEqual([]);
  expect(validState(after)).toBe(true);
  await expect(page.getByRole("button", { name: "Add a room", exact: false })).toBeVisible();
});

test("empty room deletion is available from its gear and can be cancelled", async ({ page }) => {
  await seed(page);
  await gearDelete(page, "Garage", "room");
  await expect(cancel(page)).toBeFocused();
  await expect(editor(page)).toContainText("is empty");
  await cancel(page).click();
  await expect(page.getByRole("button", { name: "Open Garage", exact: true })).toBeVisible();
  await gearDelete(page, "Garage", "room");
  await editor(page).getByRole("button", { name: "Delete room", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Garage", exact: true })).toHaveCount(0);
  expect(validState(await inventory(page))).toBe(true);
});

test("failed move and deletion saves keep contents untouched and allow retry", async ({ page }) => {
  await seed(page);
  await gearDelete(page, "Living room", "room");
  await editor(page).getByRole("combobox", { name: "Destination", exact: true }).selectOption("office");
  const before = await inventory(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "haven-inventory") throw Error("Storage full");
      return original.call(this, key, value);
    };
    window.restoreDeletionStorage = () => { Storage.prototype.setItem = original; };
  });
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText("Nothing has been moved or deleted");
  expect(await inventory(page)).toEqual(before);
  await page.evaluate(() => window.restoreDeletionStorage());
  await editor(page).getByRole("button", { name: "Move contents & delete", exact: true }).click();
  await expect(editor(page)).not.toBeVisible();
  expect(validState(await inventory(page))).toBe(true);
});

for (const kind of ["item", "everything"]) {
  test(`failed ${kind} deletion stays open and can be retried without losing data`, async ({ page }) => {
    await seed(page, fixture(), "/#room/living-room");
    const before = await inventory(page);
    if (kind === "item") await gearDelete(page, "Lamp", "item");
    else {
      await page.getByRole("button", { name: "Delete location", exact: true }).click();
      await editor(page).getByRole("radio", { name: /Delete everything/ }).check();
      await editor(page).getByRole("button", { name: "Continue", exact: true }).click();
    }
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "haven-inventory") throw Error("Storage full");
        return original.call(this, key, value);
      };
      window.restoreDeletionStorage = () => { Storage.prototype.setItem = original; };
    });
    await editor(page).getByRole("button", { name: `Delete ${kind}`, exact: true }).click();
    await expect(editor(page).getByRole("alert")).toContainText("Could not save this deletion");
    expect(await inventory(page)).toEqual(before);
    await page.evaluate(() => window.restoreDeletionStorage());
    await editor(page).getByRole("button", { name: `Delete ${kind}`, exact: true }).click();
    await expect(editor(page)).not.toBeVisible();
    const after = await inventory(page);
    expect(after.items.some((item) => item.id === "lamp")).toBe(false);
    expect(validState(after)).toBe(true);
  });
}

test("delete dialogs and separate destinations fit mobile in dark mode", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("dark");
  await gearDelete(page, "Living room", "room");
  await page.screenshot({ path: "test-results/delete-mobile-together.png" });
  await editor(page).getByLabel("How to move contents").selectOption("separate");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await editor(page).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await expect(cancel(page)).toHaveClass("primary");
  await page.screenshot({ path: "test-results/delete-mobile-separate.png" });
  await editor(page).getByLabel("Destination for Keys", { exact: false }).scrollIntoViewIfNeeded();
  await expect(editor(page).getByRole("heading", { level: 2 })).toBeInViewport();
  await expect(cancel(page)).toBeInViewport();
  await cancel(page).click();
});
