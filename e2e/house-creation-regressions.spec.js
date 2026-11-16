import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";
import { inventoryForHouse } from "../src/houses.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.creationErrors = [];
    window.creationEvents = [];
    window.addEventListener("error", (event) => window.creationErrors.push(event.message));
    window.addEventListener("unhandledrejection", (event) =>
      window.creationErrors.push(String(event.reason?.stack || event.reason)));
    for (const type of ["submit", "close", "cancel"]) {
      document.addEventListener(type, (event) => {
        const dialog = event.target.closest?.("dialog");
        if (!dialog) return;
        window.creationEvents.push({ type, connected: dialog.isConnected,
          open: dialog.open, title: dialog.querySelector("h2")?.textContent });
      }, true);
    }
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach("creation-diagnostics", {
      contentType: "application/json",
      body: JSON.stringify(await page.evaluate(() => ({
        errors: window.creationErrors,
        events: window.creationEvents,
        inventory: JSON.parse(localStorage.getItem("haven-inventory") || "null"),
        account: JSON.parse(localStorage.getItem("haven-account:creation-user") || "null"),
        accountStatus: document.querySelector("[data-account-status]")?.textContent,
        storageEvents: window.creationStorageEvents,
        dialogs: Array.from(document.querySelectorAll("dialog"), (dialog) => ({
          open: dialog.open, modal: dialog.matches(":modal"), html: dialog.innerHTML,
        })),
        activeElement: document.activeElement?.outerHTML,
        url: location.href,
      })), null, 2),
    });
  }
});

async function createHouse(page, name, keyboard = false) {
  await page.locator("[data-house-add]").click();
  const input = page.getByRole("textbox", { name: "House name" });
  await input.fill(name);
  if (keyboard) await input.press("Enter");
  else await page.locator("#editor").getByRole("button", { name: "Add house", exact: true }).click();
  await expect(page.locator("[data-house-name]")).toHaveText(name);
  await expect(page.locator("#editor")).toBeHidden();
}

async function createLocation(page, name, room = false) {
  await page.locator(room ? ".heading-actions [data-add-root]" : "[data-add-location]").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Open " + name, exact: true }).click();
  await expect(page.locator("h1")).toHaveText(name);
}

async function createItem(page, name) {
  await page.getByRole("button", { name: "Add item", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Item name" }).fill(name);
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".item-row").filter({ hasText: name })).toBeVisible();
}

async function assertResponsive(page) {
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  expect(await page.evaluate(() => window.creationErrors)).toEqual([]);
  await page.locator("[data-house-toggle]").click();
  await expect(page.locator("[data-house-panel]")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search houses" }).press("Escape");
  await expect(page.locator("[data-house-panel]")).toBeHidden();
}

async function setupSignedInCreation(page) {
  await page.route("**/src/firebase-config.json*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'export default {apiKey:"test",authDomain:"test",projectId:"test",appId:"test"};',
  }));
  await page.route("**/src/firebase-service.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      export async function createFirebaseService() {
        return {
          watchAuth(callback) {
            queueMicrotask(() => callback({ uid: "creation-user", displayName: "Creation user" }));
          },
          watch(uid, callback) {
            queueMicrotask(() => callback({ revision: 1 }));
            return () => {};
          },
          async read() {
            return JSON.parse(localStorage.getItem("haven-account:creation-user")).inventory;
          },
          publish() {
            if (window.creationHoldPublish) return new Promise(() => {});
            const record = JSON.parse(localStorage.getItem("haven-account:creation-user"));
            return Promise.resolve(record.revision + 1);
          },
          async login() {},
          async logout() {}
        };
      }
    `,
  }));
  await page.addInitScript((inventory) => {
    localStorage.setItem("haven-account:creation-user", JSON.stringify({
      inventory, revision: 1, dirty: false,
    }));
    window.creationDocument = crypto.randomUUID();
    window.creationHoldPublish = true;
    window.creationStorageEvents = [];
    window.addEventListener("storage", (event) => {
      if (event.key !== "haven-account:creation-user") return;
      window.creationStorageEvents.push({
        oldValue: event.oldValue,
        newValue: event.newValue,
        trusted: event.isTrusted,
        local: event.storageArea === localStorage,
      });
    });
  }, initialState());
  await page.goto("/");
  await expect(page.locator("[data-account-status]")).toContainText("Account is up to date");
  await expect(page.locator("[data-account-avatar]")).toBeVisible();
  return page.evaluate(() => window.creationDocument);
}

async function writeSiblingAccount(page, change) {
  const sibling = await page.context().newPage();
  try {
    await sibling.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Sibling account cache writer</title>",
    }));
    await sibling.goto("/");
    const values = await sibling.evaluate((change) => {
      const key = "haven-account:creation-user";
      const oldValue = localStorage.getItem(key);
      const record = JSON.parse(oldValue);
      if (change === "baseAssets") delete record.baseAssets;
      else if (change === "clean acknowledgment") {
        record.revision++;
        record.dirty = false;
      } else record.inventory.locations[0].name = "Sibling changed this room";
      const newValue = JSON.stringify(record);
      localStorage.setItem(key, newValue);
      return { oldValue, newValue };
    }, change);
    expect(values.newValue).not.toBe(values.oldValue);
    await expect.poll(() => page.evaluate(() => window.creationStorageEvents.at(-1))).toEqual({
      ...values, trusted: true, local: true,
    });
    return values;
  } finally {
    await sibling.close();
  }
}

for (const metadata of ["baseAssets", "clean acknowledgment"]) {
  test(`equivalent sibling-tab ${metadata} echo allows immediate house inventory saves`, async ({ page }) => {
    const documentIdentity = await setupSignedInCreation(page);
    if (metadata === "baseAssets") await page.evaluate(() => { window.creationHoldPublish = false; });
    await createHouse(page, "Account house");
    if (metadata === "baseAssets") {
      await expect(page.locator("[data-save-status]")).toHaveText("Saved to your account");
      expect(await page.evaluate(() =>
        JSON.parse(localStorage.getItem("haven-account:creation-user")).dirty)).toBe(false);
      await page.evaluate(() => { window.creationHoldPublish = true; });
    }
    await page.getByRole("button", { name: "Add room", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Immediate account room");
    const values = await writeSiblingAccount(page, metadata);
    expect(JSON.parse(values.newValue).inventory).toEqual(JSON.parse(values.oldValue).inventory);
    await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#editor")).toBeHidden();
    await expect(page.locator("[data-account-status]")).not.toContainText("changed in another tab");
    await page.getByRole("button", { name: "Open Immediate account room", exact: true }).click();
    await createLocation(page, "Immediate account container");
    await createItem(page, "Immediate account item");
    await page.locator(".breadcrumb [data-home]").click();
    await createHouse(page, "Another account house", true);
    await createLocation(page, "Another immediate room", true);
    await createItem(page, "Another immediate item");
    const inventory = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("haven-account:creation-user")).inventory);
    const firstHouse = inventory.houses.find((house) => house.name === "Account house");
    const secondHouse = inventory.houses.find((house) => house.name === "Another account house");
    const room = inventory.locations.find((location) => location.name === "Immediate account room");
    const container = inventory.locations.find((location) => location.name === "Immediate account container");
    const secondRoom = inventory.locations.find((location) => location.name === "Another immediate room");
    expect(room).toMatchObject({ houseId: firstHouse.id, parentId: null });
    expect(container).toMatchObject({ parentId: room.id });
    expect(inventoryForHouse(inventory, firstHouse.id).locations).toContainEqual(container);
    expect(secondRoom).toMatchObject({ houseId: secondHouse.id, parentId: null });
    expect(inventory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Immediate account item", locationId: container.id }),
      expect.objectContaining({ name: "Another immediate item", locationId: secondRoom.id }),
    ]));
    expect(await page.evaluate(() => window.creationDocument)).toBe(documentIdentity);
    await assertResponsive(page);
  });
}

test("genuinely different sibling-tab inventory still blocks an open house inventory save", async ({ page }) => {
  const documentIdentity = await setupSignedInCreation(page);
  await createHouse(page, "Protected account house");
  await page.getByRole("button", { name: "Add room", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Must not overwrite sibling");
  const values = await writeSiblingAccount(page, "inventory");
  expect(JSON.parse(values.newValue).inventory).not.toEqual(JSON.parse(values.oldValue).inventory);
  await expect(page.locator("[data-account-status]")).toContainText(
    "This account changed in another tab. Reload this tab before editing further.",
  );
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Must not overwrite sibling");
  expect(await page.evaluate(() => localStorage.getItem("haven-account:creation-user"))).toBe(values.newValue);
  expect(await page.evaluate(() => window.creationDocument)).toBe(documentIdentity);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test("consecutive houses support immediate inventory and leaving rooms at " + viewport.width + "px", async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const documentIdentity = await page.evaluate(() => {
      window.creationDocument = crypto.randomUUID();
      return window.creationDocument;
    });
    for (const suffix of ["One", "Two", "Three"]) {
      await createHouse(page, "House " + suffix, suffix === "Two");
      await createLocation(page, "Room " + suffix, true);
      await createItem(page, "Room item " + suffix);
      await createLocation(page, "Container " + suffix);
      await createItem(page, "Container item " + suffix);
      await createLocation(page, "Nested container " + suffix);
      await createItem(page, "Nested item " + suffix);
      await page.locator(".breadcrumb [data-home]").click();
      await expect(page.locator("h1")).toHaveText("Home, organized.");
      await createLocation(page, "Second room " + suffix, true);
      await createItem(page, "Second room item " + suffix);
      await page.locator(".breadcrumb [data-home]").click();
      await assertResponsive(page);
    }
    const inventory = await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")));
    expect(inventory.houses).toHaveLength(4);
    for (const suffix of ["One", "Two", "Three"]) {
      const house = inventory.houses.find((entry) => entry.name === "House " + suffix);
      const locations = inventoryForHouse(inventory, house.id).locations;
      expect(locations).toHaveLength(4);
      expect(inventory.items.filter((entry) => locations.some((location) => location.id === entry.locationId))).toHaveLength(4);
    }
    expect(await page.evaluate(() => window.creationDocument)).toBe(documentIdentity);
  });
}

test("back-to-back empty house creation remains interactive before adding inventory", async ({ page }) => {
  await page.goto("/");
  for (let number = 1; number <= 8; number++) await createHouse(page, "Consecutive house " + number);
  await createLocation(page, "Immediate room", true);
  await createLocation(page, "Immediate container");
  await createItem(page, "Immediate item");
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Immediate room");
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Home, organized.");
  await createHouse(page, "After leaving room");
  await createLocation(page, "Still responsive", true);
  await createItem(page, "After leaving item");
  await assertResponsive(page);
});

test("cancel and reopen forms before native close events are delivered", async ({ page }) => {
  await page.goto("/");
  await createHouse(page, "Dialog lifecycle house");
  for (const method of ["cancel", "close", "escape"]) {
    await page.getByRole("button", { name: "Add room", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Discarded room");
    if (method === "escape") {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Add room", exact: true }).first().click();
    } else {
      const reopened = await page.evaluate((method) => {
        const dialog = document.querySelector("#editor");
        const button = method === "cancel" ? dialog.querySelector(".modal-actions [data-cancel]")
          : dialog.querySelector('[aria-label="Close dialog"]');
        button.click();
        document.querySelector("[data-add-root]").click();
        return { sameDialog: dialog === document.querySelector("#editor"), open: dialog.open };
      }, method);
      expect(reopened).toEqual({ sameDialog: true, open: true });
    }
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Room after " + method);
    await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open Room after " + method, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Open Discarded room", exact: true })).toHaveCount(0);
  await assertResponsive(page);
});

test("house submit immediately opens another form before old dialog close events", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-house-add]").click();
  await page.getByRole("textbox", { name: "House name" }).fill("Same task house");
  const result = await page.evaluate(() => {
    const previous = document.querySelector("#editor");
    previous.querySelector("form").requestSubmit();
    document.querySelector("[data-add-root]").click();
    const current = document.querySelector("#editor");
    return { replaced: previous !== current, previousConnected: previous.isConnected,
      open: current.open, title: current.querySelector("h2")?.textContent };
  });
  expect(result).toEqual({ replaced: true, previousConnected: false, open: true, title: "Add a room" });
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Same task room");
  await page.locator("#editor").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Open Same task room", exact: true }).click();
  await createLocation(page, "Same task container");
  await createItem(page, "Same task item");
  await assertResponsive(page);
});

test("a detached house form cannot submit twice and freeze later dialogs", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-house-add]").click();
  await page.getByRole("textbox", { name: "House name" }).fill("Repeated submission house");
  await page.evaluate(() => {
    const form = document.querySelector("#editor form");
    form.requestSubmit();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(page.locator("[data-house-name]")).toHaveText("Repeated submission house");
  await createLocation(page, "After repeated submit", true);
  await createItem(page, "After repeated submit item");
  await assertResponsive(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).houses.length)).toBe(2);
});
