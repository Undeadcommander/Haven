import { test, expect } from "./fixture.js";
import { readFile } from "node:fs/promises";

const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")));
const save = async (page) => {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#editor")).toBeHidden();
};
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

const cropRect = (page) => page.locator("[data-photo-selection]").evaluate((element) =>
  Object.fromEntries(["left", "top", "width", "height"].map(key => [key, parseFloat(element.style[key])])));

async function dragCrop(page, handle, dx, dy) {
  const target = page.locator(handle === "move" ? "[data-photo-selection]" : `[data-crop-handle="${handle}"]`);
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  const stage = await page.locator("[data-photo-stage]").boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * stage.width, y + dy * stage.height, { steps: 5 });
  await page.mouse.up();
}

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

test("all eight crop handles resize their edges, support the keyboard, and save a freeform crop", async ({ page }) => {
  await page.goto("/");
  await settings(page, "Living room");
  await page.getByLabel("Upload your own image").setInputFiles(await patternedPhoto(page));
  for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    await page.getByRole("button", { name: "Reset crop", exact: true }).click();
    await dragCrop(page, handle, handle.includes("w") ? .1 : -.1, handle.includes("n") ? .1 : -.1);
    const crop = await cropRect(page);
    expect(crop.left).toBeCloseTo(handle.includes("w") ? 10 : 0, 1);
    expect(crop.top).toBeCloseTo(handle.includes("n") ? 10 : 0, 1);
    expect(crop.width).toBeCloseTo(/[ew]/.test(handle) ? 90 : 100, 1);
    expect(crop.height).toBeCloseTo(/[ns]/.test(handle) ? 90 : 100, 1);
  }
  await page.getByRole("button", { name: "Reset crop", exact: true }).click();
  const right = page.getByRole("button", { name: "Resize right edge", exact: true });
  await right.focus();
  await right.press("Shift+ArrowLeft");
  expect((await cropRect(page)).width).toBe(90);
  await right.press("ArrowRight");
  expect((await cropRect(page)).width).toBe(91);
  // Resize only the width: saved pixels must match the freeform selection.
  await page.getByRole("button", { name: "Use photo", exact: true }).click();
  const image = await page.locator("[data-image-preview] img").getAttribute("src");
  const pixels = await photoPixels(page, image);
  expect(pixels.width).toBe(800);
  expect(pixels.height).toBe(Math.round(800 * 800 / (1600 * .91)));
});

test.describe("touch cropping", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 740 } });

  test("touch handles resize a portrait photo and keep the selection inside it", async ({ page }) => {
    await page.goto("/");
    await settings(page, "Living room");
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 1600;
      canvas.getContext("2d").fillRect(0, 0, 800, 1600);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.getByLabel("Upload your own image").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
    const handle = page.getByRole("button", { name: "Resize bottom right corner", exact: true });
    await handle.scrollIntoViewIfNeeded();
    const bounds = await handle.boundingBox();
    const stage = await page.locator("[data-photo-stage]").boundingBox();
    expect(stage.height).toBeCloseTo(320, 0);
    const start = await cropRect(page);
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - stage.width * .25, y: y - stage.height * .05 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const resized = await cropRect(page);
    expect(resized.left).toBe(start.left);
    expect(resized.top).toBe(start.top);
    expect(resized.width).toBeCloseTo(75, 0);
    expect(resized.height).toBeCloseTo(20, 0);
    // Keyboard movement has the same image bounds as a drag.
    const selection = page.locator("[data-photo-selection]");
    await selection.focus();
    for (let i = 0; i < 10; i++) await selection.press("Shift+ArrowDown");
    const moved = await cropRect(page);
    expect(moved.top + moved.height).toBeCloseTo(100, 4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await session.detach();
  });
});

for (const kind of ["room", "container"]) {
  test(`${kind} photos crop by dragging, cancel, and keep their color on mobile`, async ({ page }) => {
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
    await expect(page.locator('[data-photo-editor] input[type="range"]')).toHaveCount(0);
    await dragCrop(page, "nw", .5, .5);
    await page.getByRole("button", { name: "Reset crop", exact: true }).click();
    expect(await cropRect(page)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
    await page.getByRole("button", { name: "Cancel crop", exact: true }).click();
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(page.locator("[data-image-preview] img")).toHaveCount(0);
    await page.getByLabel("Upload your own image").setInputFiles(file);
    await expect(canvas).toBeVisible();
    await dragCrop(page, "nw", .5, .5);
    await dragCrop(page, "move", 0, -.5);
    const moved = await cropRect(page);
    expect(moved.left).toBeCloseTo(50, 0);
    expect(moved.top).toBeCloseTo(0, 0);
    await page.locator("[data-photo-editor]").screenshot({ path: `test-results/${kind}-photo-crop-mobile.png` });
    const selection = page.locator("[data-photo-selection]");
    await selection.focus();
    await selection.press("ArrowRight");
    expect((await cropRect(page)).left).toBeCloseTo(moved.left, 1);
    await selection.press("ArrowLeft");
    expect((await cropRect(page)).left).toBeCloseTo(moved.left - 1, 1);
    await selection.press("ArrowRight");
    await page.getByRole("button", { name: "Use photo", exact: true }).click();
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
    const image = await page.locator("[data-image-preview] img").getAttribute("src");
    expect(image.length).toBeLessThanOrEqual(180000);
    const pixels = await photoPixels(page, image);
    expect(pixels.width).toBeCloseTo(800, -1);
    expect(pixels.height).toBeCloseTo(400, -1);
    expect(pixels.center[0]).toBeLessThan(50);
    expect(pixels.center[1]).toBeGreaterThan(110);
    expect(pixels.center[2]).toBeLessThan(90);
    await page.getByRole("button", { name: "Adjust photo", exact: true }).click();
    expect((await cropRect(page)).width).toBeCloseTo(50, 0);
    await dragCrop(page, "move", 0, .5);
    await page.getByRole("button", { name: "Cancel crop", exact: true }).click();
    await expect(page.locator("[data-image-preview] img")).toHaveAttribute("src", image);
    await save(page);
    await page.reload();
    expect((await saved(page)).locations.find(l => l.name === name)).toMatchObject({ image, color: "rose" });
    await settings(page, name);
    await expect(page.locator('input[name="color"]:enabled')).toHaveCount(0);
    await page.getByRole("button", { name: "Adjust photo", exact: true }).click();
    await expect(canvas).toBeVisible();
    await dragCrop(page, "se", -.5, -.5);
    await page.getByRole("button", { name: "Use photo", exact: true }).click();
    const recropped = await page.locator("[data-image-preview] img").getAttribute("src");
    const resized = await photoPixels(page, recropped);
    expect(resized.width).toBeCloseTo(400, -1);
    expect(resized.height).toBeCloseTo(200, -1);
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
