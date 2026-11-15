import { test, expect } from "./fixture.js";
import { readFile } from "node:fs/promises";

const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")));
const save = (page) => page.getByRole("button", { name: "Save", exact: true }).click();
const settings = (page, name) => page.getByRole("button", { name: `Settings for ${name}`, exact: true }).click();
const photo = {
  name: "photo.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"),
};

async function artworkColors(page) {
  const colors = await page.locator(".location-image-picker").evaluate((picker) => {
    const palette = (element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor };
    };
    const swatch = picker.closest("form").querySelector('input[name="color"]:checked').closest("label");
    return {
      expected: { color: getComputedStyle(swatch.querySelector("span")).color, background: getComputedStyle(swatch).backgroundColor },
      preview: palette(picker.querySelector("[data-image-preview]")),
      choices: [...picker.querySelectorAll(".image-option:has(.room-art)")].map(palette),
    };
  });
  expect(colors.preview).toEqual(colors.expected);
  for (const choice of colors.choices) expect(choice).toEqual(colors.expected);
  return colors.preview;
}

const cardColors = (page, name) => page.getByRole("button", { name: `Open ${name}`, exact: true }).locator(".card-image").evaluate((element) => {
  const style = getComputedStyle(element);
  return { color: style.color, background: style.backgroundColor };
});

test("room and container images can be chosen at creation and changed through gears", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add room", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Study");
  for (const color of ["sage", "sand", "blue", "rose", "mint", "lavender", "terracotta"]) {
    await page.getByRole("radio", { name: color, exact: true }).check();
    await artworkColors(page);
  }
  await page.getByRole("radio", { name: "mint", exact: true }).check();
  await page.getByRole("radio", { name: "Garage", exact: true }).check();
  const mint = await artworkColors(page);
  await save(page);
  expect(await cardColors(page, "Study")).toEqual(mint);
  expect((await saved(page)).locations.find(l => l.name === "Study")).toMatchObject({ image: "garage", color: "mint" });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("plum");
  const darkMint = await cardColors(page, "Study");
  await settings(page, "Study");
  expect(await artworkColors(page)).toEqual(darkMint);
  await page.getByRole("radio", { name: "rose", exact: true }).check();
  await page.getByRole("radio", { name: "Bathroom", exact: true }).check();
  await artworkColors(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await saved(page)).locations.find(l => l.name === "Study")).toMatchObject({ image: "garage", color: "mint" });
  expect(await cardColors(page, "Study")).toEqual(darkMint);
  await settings(page, "Study");
  await page.getByRole("radio", { name: "lavender", exact: true }).check();
  await page.getByRole("radio", { name: "Bathroom", exact: true }).check();
  const lavender = await artworkColors(page);
  await save(page);
  await page.reload();
  expect((await saved(page)).locations.find(l => l.name === "Study")).toMatchObject({ image: "bathroom", color: "lavender" });
  expect(await cardColors(page, "Study")).toEqual(lavender);
  await page.getByRole("button", { name: "Open Study", exact: true }).click();
  await page.getByRole("button", { name: "Add a container" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Cabinet");
  for (const color of ["sage", "sand", "blue", "rose", "mint", "lavender", "terracotta"]) {
    await page.getByRole("radio", { name: color, exact: true }).check();
    await artworkColors(page);
  }
  await page.getByRole("radio", { name: "Drawers", exact: true }).check();
  const terracotta = await artworkColors(page);
  await save(page);
  expect(await cardColors(page, "Cabinet")).toEqual(terracotta);
  await settings(page, "Cabinet");
  expect(await artworkColors(page)).toEqual(terracotta);
  await page.getByRole("radio", { name: "blue", exact: true }).check();
  await page.getByRole("radio", { name: "Shelves", exact: true }).check();
  const blue = await artworkColors(page);
  await save(page);
  await page.reload();
  expect((await saved(page)).locations.find(l => l.name === "Cabinet")).toMatchObject({ image: "shelf", color: "blue" });
  expect(await cardColors(page, "Cabinet")).toEqual(blue);
  await settings(page, "Cabinet");
  await expect(page.getByRole("radio", { name: "Shelves", exact: true })).toBeChecked();
});

test("uploads persist, invalid files preserve the photo, and the living room preset replaces it", async ({ page }) => {
  await page.goto("/");
  await settings(page, "Living room");
  await page.getByRole("radio", { name: "lavender", exact: true }).check();
  await page.getByLabel("Upload your own image").setInputFiles(photo);
  await expect(page.locator("[data-photo-editor]")).toBeVisible();
  await page.locator("[data-photo-editor]").screenshot({ path: "test-results/photo-crop-desktop.png" });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
  await page.getByRole("button", { name: "Use photo", exact: true }).click();
  await expect(page.locator("[data-image-status]")).toContainText("Photo ready");
  await save(page);
  await page.reload();
  await expect(page.locator(".card-image img")).toBeVisible();
  const image = (await saved(page)).locations[0].image;
  expect((await saved(page)).locations[0].color).toBe("lavender");
  expect(image).toMatch(/^data:image\/jpeg;base64,/);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export a backup", exact: true }).click();
  const download = await downloadEvent;
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(backup.inventory.locations[0].image).toBe(image);
  await page.setViewportSize({ width: 320, height: 740 });
  await settings(page, "Living room");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(page.getByRole("radio", { name: "Your photo" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "lavender", exact: true })).toBeChecked();
  await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
  await page.getByLabel("Upload your own image").setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("bad image") });
  await expect(page.locator("[data-image-status]")).toContainText("could not be read");
  await save(page);
  expect((await saved(page)).locations[0].image).toBe(image);
  await settings(page, "Living room");
  await page.getByRole("radio", { name: "Living room", exact: true }).check();
  await expect(page.locator('input[name="color"]:enabled')).toHaveCount(7);
  await expect(page.getByRole("radio", { name: "lavender", exact: true })).toBeChecked();
  await artworkColors(page);
  await save(page);
  await expect(page.locator(".card-image img")).toHaveCount(0);
  expect((await saved(page)).locations[0].image).toBe("living");
});

test("a custom photo can be uploaded when creating a container", async ({ page }) => {
  await page.goto("/#room/living-room");
  await page.getByRole("button", { name: "Add a container" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Photo box");
  await page.getByLabel("Upload your own image").setInputFiles(photo);
  await expect(page.locator("[data-photo-editor]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
  await page.getByRole("button", { name: "Use photo", exact: true }).click();
  await expect(page.locator("[data-image-status]")).toContainText("Photo ready");
  await save(page);
  await expect(page.locator(".card-image img")).toBeVisible();
  await page.reload();
  await expect(page.locator(".card-image img")).toBeVisible();
});


async function patternedPhoto(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 800;
    const ctx = canvas.getContext("2d");
    for (const [color, x, y] of [["#e33b37", 0, 0], ["#278248", 800, 0], ["#2879d0", 0, 400], ["#f2cb30", 800, 400]]) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 800, 400);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return { name: "quadrants.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

const setRange = (page, name, value) => page.getByRole("slider", { name, exact: true }).evaluate((input, value) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, value);

async function photoPixels(page, source) {
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return {
      width: canvas.width, height: canvas.height,
      center: [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data],
    };
  }, source);
}

for (const kind of ["room", "container"]) {
  test(`${kind} photos crop, zoom, cancel, and keep their color on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(kind === "room" ? "/" : "/#room/living-room");
    if (kind === "room") await page.getByRole("button", { name: "Add room", exact: true }).first().click();
    else await page.locator("[data-add-location]").click();
    const name = `Cropped ${kind}`;
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await page.getByRole("radio", { name: "rose", exact: true }).check();
    const file = await patternedPhoto(page);
    await page.getByLabel("Upload your own image").setInputFiles(file);
    await expect(page.locator("[data-photo-editor]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const canvas = page.locator("[data-photo-canvas]");
    const bounds = await canvas.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await setRange(page, "Zoom", "2");
    await setRange(page, "Horizontal position", "1");
    await setRange(page, "Vertical position", "0");
    await page.getByRole("button", { name: "Reset crop", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Zoom", exact: true })).toHaveValue("1");
    await page.getByRole("button", { name: "Cancel crop", exact: true }).click();
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(page.locator("[data-image-preview] img")).toHaveCount(0);
    await page.getByLabel("Upload your own image").setInputFiles(file);
    await expect(canvas).toBeVisible();
    await setRange(page, "Zoom", "2");
    await canvas.scrollIntoViewIfNeeded();
    const dragBounds = await canvas.boundingBox();
    await page.mouse.move(dragBounds.x + dragBounds.width / 2, dragBounds.y + dragBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBounds.x + dragBounds.width * .75, dragBounds.y + dragBounds.height * .25, { steps: 5 });
    await page.mouse.up();
    expect(Number(await page.getByRole("slider", { name: "Horizontal position", exact: true }).inputValue())).toBeLessThan(.5);
    expect(Number(await page.getByRole("slider", { name: "Vertical position", exact: true }).inputValue())).toBeGreaterThan(.5);
    await setRange(page, "Horizontal position", "1");
    await setRange(page, "Vertical position", "0");
    await page.locator("[data-photo-editor]").screenshot({ path: `test-results/${kind}-photo-crop-mobile.png` });
    await canvas.focus();
    await canvas.press("ArrowLeft");
    await expect(page.getByRole("slider", { name: "Horizontal position", exact: true })).toHaveValue("1");
    await canvas.press("ArrowRight");
    await expect(page.getByRole("slider", { name: "Horizontal position", exact: true })).toHaveValue("0.98");
    await setRange(page, "Horizontal position", "1");
    await page.getByRole("button", { name: "Use photo", exact: true }).click();
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
    const image = await page.locator("[data-image-preview] img").getAttribute("src");
    expect(image.length).toBeLessThanOrEqual(180000);
    const pixels = await photoPixels(page, image);
    expect(pixels.width).toBe(800);
    expect(pixels.height).toBe(400);
    expect(pixels.center[0]).toBeLessThan(50);
    expect(pixels.center[1]).toBeGreaterThan(110);
    expect(pixels.center[2]).toBeLessThan(90);
    await page.getByRole("button", { name: "Adjust photo", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Zoom", exact: true })).toHaveValue("2");
    await setRange(page, "Vertical position", "1");
    await page.getByRole("button", { name: "Cancel crop", exact: true }).click();
    await expect(page.locator("[data-image-preview] img")).toHaveAttribute("src", image);
    await save(page);
    await page.reload();
    expect((await saved(page)).locations.find(l => l.name === name)).toMatchObject({ image, color: "rose" });
    await settings(page, name);
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
    await page.getByRole("button", { name: "Adjust photo", exact: true }).click();
    await expect(canvas).toBeVisible();
    await setRange(page, "Zoom", "2");
    await page.getByRole("button", { name: "Use photo", exact: true }).click();
    const recropped = await page.locator("[data-image-preview] img").getAttribute("src");
    const resized = await photoPixels(page, recropped);
    expect(resized.width).toBe(400);
    expect(resized.height).toBe(200);
    await save(page);
    await page.reload();
    expect((await saved(page)).locations.find(l => l.name === name)).toMatchObject({ image: recropped, color: "rose" });
    await settings(page, name);
    await page.getByLabel("Upload your own image").setInputFiles(file);
    await expect(canvas).toBeVisible();
    await page.getByRole("button", { name: "Cancel crop", exact: true }).click();
    await expect(page.locator("[data-image-preview] img")).toHaveAttribute("src", recropped);
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
    await page.locator(".color-picker").screenshot({ path: `test-results/${kind}-photo-color-disabled-mobile.png` });
    await page.getByRole("radio", { name: kind === "room" ? "Kitchen" : "Drawers", exact: true }).check();
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(7);
    await expect(page.getByRole("radio", { name: "rose", exact: true })).toBeChecked();
    await artworkColors(page);
    await page.getByRole("radio", { name: "Your photo", exact: true }).check();
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
  });
}
