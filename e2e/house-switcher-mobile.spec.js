import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";
import { addHouse } from "../src/houses.js";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((inventory) => {
    if (!localStorage.getItem("haven-inventory"))
      localStorage.setItem("haven-inventory", JSON.stringify(inventory));
  }, addHouse(initialState(), "Lake house", "lake"));
  await page.goto("/");
});

test("opening the house picker by touch leaves search unfocused and houses tappable", async ({ page }) => {
  await page.locator("[data-house-toggle]").tap();
  await expect(page.locator("[data-house-panel]")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search houses" })).not.toBeFocused();
  await page.locator("[data-house-list]").getByRole("button", { name: "Lake house", exact: true }).tap();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
  await expect(page.locator("[data-house-panel]")).toBeHidden();
  await page.reload();
  await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
});

for (const action of ["switch", "rename", "delete"]) {
  test(`dismissing house search does not swallow the next ${action} tap`, async ({ page }) => {
    await page.locator("[data-house-toggle]").tap();
    const search = page.getByRole("searchbox", { name: "Search houses" });
    await search.tap();
    await expect(search).toBeFocused();
    await search.fill("house");
    await expect(page.locator("[data-house-row]:visible")).toHaveCount(1);
    await search.fill("");
    // Mobile browsers can blur search without focusing the tapped button.
    await search.evaluate((input) => input.blur());
    await expect(page.locator("[data-house-panel]")).toBeVisible();
    await expect(page.locator("[data-house-toggle]")).toHaveAttribute("aria-expanded", "true");

    if (action === "switch") {
      await page.locator("[data-house-list]").getByRole("button", { name: "Lake house", exact: true }).tap();
      await expect(page.locator("[data-house-name]")).toHaveText("Lake house");
    } else if (action === "rename") {
      await page.getByRole("button", { name: "Rename house", exact: true }).tap();
      const dialog = page.locator("#editor");
      await expect(dialog.getByRole("heading")).toHaveText("Rename house");
      await page.getByRole("textbox", { name: "House name" }).fill("Main house");
      await dialog.getByRole("button", { name: "Save", exact: true }).tap();
      await expect(dialog).toBeHidden();
      await expect(page.locator("[data-house-name]")).toHaveText("Main house");
    } else {
      const before = await page.evaluate(() => localStorage.getItem("haven-inventory"));
      await page.getByRole("button", { name: "Delete house", exact: true }).tap();
      const dialog = page.locator("#editor");
      await expect(dialog.getByRole("heading")).toHaveText("Delete My home?");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(dialog).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(before);
    }
    await expect(page.locator("[data-house-panel]")).toBeHidden();
  });
}

test("outside taps and keyboard navigation still dismiss the mobile picker", async ({ page }) => {
  const trigger = page.locator("[data-house-toggle]");
  const panel = page.locator("[data-house-panel]");
  await trigger.tap();
  const search = page.getByRole("searchbox", { name: "Search houses" });
  await search.tap();
  await page.getByRole("searchbox", { name: "Search items and rooms" }).tap();
  await expect(panel).toBeHidden();

  await trigger.press("ArrowDown");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: "Delete house", exact: true }).press("Tab");
  await expect(panel).toBeHidden();
});
