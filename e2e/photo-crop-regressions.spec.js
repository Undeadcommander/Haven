import { test, expect } from "./fixture.js";

const settings = page => page.getByRole("button", { name: "Settings for Living room", exact: true }).click();
const cropRect = page => page.locator("[data-photo-selection]").evaluate(element =>
  Object.fromEntries(["left", "top", "width", "height"].map(key => [key, parseFloat(element.style[key])])));

async function uploadPhoto(page, width, height) {
  const base64 = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#d53c30";
    context.fillRect(0, 0, width, height / 2);
    context.fillStyle = "#266cc0";
    context.fillRect(0, height / 2, width, height / 2);
    return canvas.toDataURL("image/png").split(",")[1];
  }, [width, height]);
  await page.getByLabel("Upload your own image").setInputFiles({
    name: "crop.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.locator("[data-photo-editor]")).toBeVisible();
}

async function drag(page, handle, dx, dy) {
  const target = page.locator(handle === "move" ? "[data-photo-selection]" : `[data-crop-handle="${handle}"]`);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const stage = await page.locator("[data-photo-stage]").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * stage.width, y + dy * stage.height, { steps: 5 });
  await page.mouse.up();
}

for (const [shape, width, height] of [["square", 800, 800], ["portrait", 800, 1600], ["panorama", 4000, 400]]) {
  test(`a saved ${shape} crop stays whole and unchanged when reopened and reapplied`, async ({ page }) => {
    await page.goto("/");
    await settings(page);
    await uploadPhoto(page, width, height);
    const initial = await cropRect(page);
    for (const [axis, first, second, backward, forward] of [
      ["left", "w", "e", "ArrowLeft", "ArrowRight"], ["top", "n", "s", "ArrowUp", "ArrowDown"],
    ]) {
      if (!initial[axis]) continue;
      for (const [handle, key] of [[first, backward], [second, forward]]) {
        for (let i = 0; i < 5; i++) await page.locator(`[data-crop-handle="${handle}"]`).press(`Shift+${key}`);
      }
    }
    expect(await cropRect(page)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
    await page.getByRole("button", { name: "Use photo", exact: true }).click();
    const preview = page.locator("[data-image-preview] img");
    const image = await preview.getAttribute("src");
    const dimensions = await preview.evaluate(async element => {
      await element.decode();
      return [element.naturalWidth, element.naturalHeight];
    });
    const scale = Math.min(1, 800 / Math.max(width, height));
    expect(dimensions).toEqual([Math.round(width * scale), Math.round(height * scale)]);
    await expect(preview).toHaveCSS("object-fit", "contain");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open Living room", exact: true }).locator("img")).toHaveCSS("object-fit", "contain");

    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await settings(page);
      await page.getByRole("button", { name: "Adjust photo", exact: true }).click();
      expect(await cropRect(page)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
      await page.getByRole("button", { name: "Use photo", exact: true }).click();
      await expect(preview).toHaveAttribute("src", image);
      await page.getByRole("button", { name: "Save", exact: true }).click();
    }
  });
}

test("keyboard resizing and movement expose live crop size and position", async ({ page }) => {
  await page.goto("/");
  await settings(page);
  await uploadPhoto(page, 1600, 800);
  const status = page.locator("#photo-crop-status");
  const right = page.getByRole("button", { name: "Resize right edge", exact: true });
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await right.press("Shift+ArrowLeft");
  await expect(status).toHaveText("Crop: 1440 by 800 pixels. Position: 0% from left, 0% from top.");
  await expect(right).toHaveAccessibleDescription(/Crop: 1440 by 800 pixels/);
  const selection = page.getByRole("group", { name: "Crop selection", exact: true });
  await selection.press("ArrowRight");
  await expect(status).toContainText("Position: 1% from left, 0% from top.");
  await expect(selection).toHaveAccessibleDescription(/Position: 1% from left/);
});

test.describe("wide mobile photos", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 740 } });

  test("panorama handles and the crop center remain usable, including after fitting and zooming", async ({ page }) => {
    await page.goto("/");
    await settings(page);
    await uploadPhoto(page, 4000, 400);
    const selection = page.locator("[data-photo-selection]");
    await selection.scrollIntoViewIfNeeded();
    const stage = await page.locator("[data-photo-stage]").boundingBox();
    expect(stage.height).toBeGreaterThanOrEqual(79);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const dialogBounds = await page.locator("#editor").boundingBox();
    const pickerBounds = await page.locator(".location-image-picker").boundingBox();
    expect(pickerBounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
    expect(pickerBounds.x + pickerBounds.width).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width);
    const box = await selection.boundingBox();
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).hasAttribute("data-photo-selection"), {
      x: box.x + box.width / 2, y: box.y + box.height / 2,
    })).toBe(true);

    const top = page.getByRole("button", { name: "Resize top edge", exact: true });
    const handle = await top.boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + stage.height * .1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
    expect((await cropRect(page)).top).toBeCloseTo(10, 0);
    expect((await cropRect(page)).height).toBeCloseTo(90, 0);
    await drag(page, "move", .02, 0);
    expect((await cropRect(page)).left).toBeCloseTo(42, 0);
    const resized = await cropRect(page);

    await page.getByRole("button", { name: "Fit photo", exact: true }).click();
    expect(await cropRect(page)).toEqual(resized);
    const fitted = await page.locator("[data-photo-stage]").boundingBox();
    expect(fitted.height).toBeLessThan(44);
    const workspace = await page.locator("[data-photo-viewport]").boundingBox();
    expect(fitted.width).toBeLessThanOrEqual(workspace.width - 36);
    await drag(page, "n", 0, .1);
    expect((await cropRect(page)).top).toBeGreaterThan(resized.top + 8);
    const fittedCrop = await cropRect(page);
    for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(await cropRect(page)).toEqual(fittedCrop);
    await page.setViewportSize({ width: 400, height: 740 });
    expect(await cropRect(page)).toEqual(fittedCrop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
    await page.locator("[data-photo-editor]").screenshot({ path: "test-results/panorama-crop-mobile.png" });
  });
});
