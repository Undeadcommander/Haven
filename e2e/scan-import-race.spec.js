import { test, expect } from "./fixture.js";

test("scan metadata and displayed identity stay consistent during delayed lease cleanup", async ({ page }) => {
  await page.route("**/src/scan-viewer.js*", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const viewerSource = original.replace(/await commitAssets\(\[assetId\], openScope\)\.catch\(\(\) => \{\s*\}\);/, match => `
      await new Promise(resolve => requestAnimationFrame(() => { paint(); requestAnimationFrame(resolve); }));
      ${match}`);
    expect(viewerSource).not.toBe(original);
    await route.fulfill({ response, body: viewerSource });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Living room", exact: true }).click();
  await page.getByRole("button", { name: "Add 3D scan", exact: true }).click();
  for (const name of ["first.obj", "replacement.obj"]) {
    await page.locator("[data-scan-file]").setInputFiles({
      name, mimeType: "text/plain", buffer: Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    });
    await expect(page.locator(".scan-status")).toContainText(`Loaded ${name}`);
    await expect(page.locator("[data-import-scan]")).toBeEnabled();
    await expect(page.locator("[data-place-marker]")).toBeEnabled();
  }
  await page.getByRole("button", { name: "Close scan", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-inventory")).scans[0].name)).toBe("replacement.obj");
});
