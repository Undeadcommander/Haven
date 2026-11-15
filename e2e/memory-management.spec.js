import { test, expect } from "./fixture.js";

test("restore decodes scan files in bounded chunks without changing their bytes", async ({ page }) => {
  await page.goto("/");
  const coordinates = Float32Array.from({ length: 30_000 }, (_, index) => index / 1000);
  const encoded = Buffer.from(coordinates.buffer).toString("base64");
  const result = await page.evaluate(async (encoded) => {
    const { stageBackup, getAsset } = await import("/src/scan-storage.js");
    const { initialState } = await import("/src/store.js");
    const inventory = initialState();
    inventory.scans = [{ id: "scan", locationId: "living-room", assetId: "original",
      name: "Depth scan", format: "points" }];
    const backup = { inventory, assets: [{ id: "original", data: `data:application/octet-stream;base64,${encoded}` }] };
    const decode = window.atob;
    const chunks = [];
    window.atob = (text) => { chunks.push(text.length); return decode(text); };
    try {
      const staged = await stageBackup(backup, null);
      try {
        const blob = await getAsset(staged.inventory.scans[0].assetId, null);
        const restored = new Float32Array(await blob.arrayBuffer());
        return { chunks, size: blob.size,
          matches: restored.every((value, index) => value === Math.fround(index / 1000)),
          originalId: backup.inventory.scans[0].assetId };
      } finally {
        await staged.rollback();
      }
    } finally {
      window.atob = decode;
    }
  }, encoded);
  expect(result.chunks.length).toBeGreaterThan(1);
  expect(Math.max(...result.chunks)).toBeLessThanOrEqual(32_768);
  expect(result).toMatchObject({ size: coordinates.byteLength, matches: true, originalId: "original" });
});

test("restore rejects oversized assets before decoding and rejects malformed padding", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { stageBackup } = await import("/src/scan-storage.js");
    const { initialState } = await import("/src/store.js");
    const inventory = initialState();
    inventory.scans = [{ id: "scan", locationId: "living-room", assetId: "asset",
      name: "Depth scan", format: "points" }];
    const decode = window.atob;
    let calls = 0;
    window.atob = (text) => { calls++; return decode(text); };
    const errors = [];
    try {
      for (const encoded of ["A".repeat(40_000_004), "A", "AA=", "AA==AA=="]) {
        try {
          await stageBackup({ inventory, assets: [{ id: "asset",
            data: `data:application/octet-stream;base64,${encoded}` }] }, null);
          errors.push("");
        } catch (error) { errors.push(error.message); }
      }
    } finally {
      window.atob = decode;
    }
    return { calls, errors };
  });
  expect(result.calls).toBe(0);
  expect(result.errors[0]).toContain("30 MB limit");
  for (const message of result.errors.slice(1)) expect(message).toContain("missing or invalid");
});

test("canceling a restore drops the form that holds its parsed backup", async ({ page }) => {
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore a backup" }).first().click();
  const { initialState } = await import("../src/store.js");
  await (await chooser).setFiles({ name: "inventory.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(initialState())) });
  const editor = page.locator("#editor");
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor.locator("form")).toHaveCount(0);
  await expect(editor).toBeHidden();
});

test("canceling a photo editor removes its image and canvas handlers with the form", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add room", exact: true }).first().click();
  await page.locator("[data-image-upload]").setInputFiles({ name: "photo.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64") });
  await expect(page.locator("[data-photo-editor]")).toBeVisible();
  const editor = page.locator("#editor");
  await editor.getByRole("button", { name: "Close dialog" }).click();
  await expect(editor.locator("canvas, form, img")).toHaveCount(0);
});
