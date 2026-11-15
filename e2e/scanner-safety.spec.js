import { readFileSync } from "node:fs";
import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";
import { makeGLB, triangleGLB } from "../tests/helpers/scan-fixtures.js";

const room = readFileSync(new URL("./fixtures/room.obj", import.meta.url), "utf8");
function inventory(shared = false) {
  const state = initialState();
  state.items = [{ id: "keys", name: "Keep these keys", notes: "Keep", locationId: "living-room" }];
  state.scans = [{ id: "old-scan", assetId: "shared-asset", locationId: "living-room", name: "room.obj", format: "obj" }];
  if (shared) state.scans.push({ ...state.scans[0], id: "garage-scan", locationId: "garage" });
  state.markers = [{ id: "old-marker", scanId: "old-scan", kind: "item", targetId: "keys", position: [0, 1, 0] }];
  return state;
}
async function seed(page, shared = false) {
  await page.goto("/");
  await page.evaluate(async ({ state, room }) => {
    const { putAsset } = await import("/src/scan-storage.js");
    localStorage.setItem("haven-inventory", JSON.stringify(state));
    await putAsset("shared-asset", new Blob([room]));
  }, { state: inventory(shared), room });
  await page.reload();
  await open(page);
}
async function open(page, location = "Living room") {
  if (new URL(page.url()).hash) await page.goto("/");
  await page.getByRole("button", { name: "Open " + location, exact: true }).click();
  await page.getByRole("button", { name: "Open 3D scan", exact: true }).click();
  await expect(page.locator(".scan-status")).toContainText("Loaded room.obj");
}
const upload = (page, name, bytes) => page.locator("[data-scan-file]").setInputFiles({
  name, mimeType: "model/gltf-binary", buffer: bytes,
});
async function markerForm(page) {
  const bounds = await page.locator(".scan-stage canvas").boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: "right" });
  await page.locator("[data-add-scan-item]").click();
}

test("bad GLB indices preserve inventory, markers and files across reload", async ({ page }) => {
  await seed(page);
  const original = await page.evaluate(() => localStorage.getItem("haven-inventory"));
  await upload(page, "bad-indices.glb", triangleGLB({ indices: [0, 1, 65535] }));
  await expect(page.locator(".scan-error")).toContainText("invalid geometry indices");
  expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(original);
  await page.getByRole("button", { name: "Close scan" }).click();
  await page.reload();
  await open(page);
  await expect(page.getByRole("button", { name: "Item marker: Keep these keys", exact: true })).toBeVisible();
});

test("oversized accessor and instance workloads never replace the active scan", async ({ page }) => {
  await seed(page);
  const original = await page.evaluate(() => localStorage.getItem("haven-inventory"));
  const oversized = makeGLB({ asset: { version: "2.0" }, accessors: [{ componentType: 5126, count: 5_000_000, type: "VEC3" }] });
  for (const bytes of [oversized, triangleGLB({ triangles: 300, instances: 10_000 })]) {
    await upload(page, "oversized.glb", bytes);
    await expect(page.locator(".scan-error")).toContainText("too detailed");
    expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(original);
  }
});

for (const operation of ["remove", "replace"]) {
  test(operation + " preserves scan files still referenced by another room", async ({ page }) => {
    await seed(page, true);
    if (operation === "remove") {
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Remove scan", exact: true }).click();
    } else {
      await upload(page, "replacement.glb", triangleGLB());
      await expect(page.locator(".scan-status")).toContainText("Loaded replacement.glb");
      await page.getByRole("button", { name: "Close scan" }).click();
    }
    await expect(page.locator(".scan-dialog")).toHaveCount(0);
    expect(await page.evaluate(async () => {
      const { getAsset } = await import("/src/scan-storage.js");
      return !!await getAsset("shared-asset");
    })).toBe(true);
    await page.reload();
    await open(page, "Garage");
  });
}

test("non-finite ray hits cannot open a placement form or corrupt inventory", async ({ page }) => {
  await seed(page);
  const original = await page.evaluate(() => localStorage.getItem("haven-inventory"));
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").find((entry) => /\/deps\/three\.js\?/.test(entry.name)).name;
    const { Raycaster, Vector3 } = await import(url);
    Raycaster.prototype.intersectObject = () => [{ object: { isPoints: false }, point: new Vector3(NaN, NaN, NaN) }];
  });
  const bounds = await page.locator(".scan-stage canvas").boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: "right" });
  await expect(page.locator(".scan-error")).toContainText("invalid coordinates");
  await expect(page.locator(".scan-context")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(original);
});

async function cloudInventory(page) {
  await page.route("**/src/firebase-config.json*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'export default {enabled:true,apiKey:"test",authDomain:"test.invalid",projectId:"test",appId:"test"};',
  }));
  const initial = JSON.stringify(inventory());
  await page.route("**/src/firebase-service.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "export async function createFirebaseService(){" +
      "let revision=1, value=" + initial + ", listener;" +
      "window.scanCloud={async replace(){value={...value,scans:[{...value.scans[0],id:'remote-scan',assetId:'remote-asset'}],markers:[]};revision++;await listener({revision});}};" +
      "return {watchAuth(callback){queueMicrotask(()=>callback({uid:'scanner-test',displayName:'Scanner test'}));return ()=>{};}," +
      "watch(uid,callback){listener=callback;queueMicrotask(()=>callback({revision}));return ()=>{};}," +
      "async read(){return value;},async publish(uid,next){value=next;return ++revision;}};}",
  }));
  await page.goto("/");
  await expect(page.locator("[data-save-status]").first()).toContainText("Account is up to date");
  await page.evaluate(async (room) => {
    const { putAsset } = await import("/src/scan-storage.js");
    await putAsset("shared-asset", new Blob([room]), "scanner-test");
  }, room);
  await open(page);
}

test("cloud scan replacement invalidates an open placement before it can save", async ({ page }) => {
  await cloudInventory(page);
  await markerForm(page);
  await page.evaluate(() => window.scanCloud.replace());
  await expect(page.locator(".scan-error")).toContainText("scan or account changed");
  await expect(page.getByRole("button", { name: "Save marker", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Place marker", exact: true })).toBeDisabled();
  await expect(page.locator(".scan-dot")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const record = JSON.parse(localStorage.getItem("haven-account:scanner-test"));
    return { markers: record.inventory.markers.length, dirty: record.dirty, scan: record.inventory.scans[0].id };
  })).toEqual({ markers: 0, dirty: false, scan: "remote-scan" });
});

test("a cloud replacement during file reading cannot be overwritten by an older import", async ({ page }) => {
  await cloudInventory(page);
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File && this.name === "pending.glb") {
        const result = original.call(this);
        return new Promise((resolve) => { window.resumeScanRead = () => resolve(result); });
      }
      return original.call(this);
    };
  });
  await upload(page, "pending.glb", triangleGLB());
  await page.waitForFunction(() => !!window.resumeScanRead);
  await page.evaluate(() => window.scanCloud.replace());
  await page.evaluate(() => window.resumeScanRead());
  await expect(page.locator(".scan-error")).toContainText("Reopen");
  await expect(page.getByRole("button", { name: "Import scan", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("haven-account:scanner-test")).inventory.scans[0].id)).toBe("remote-scan");
});

test("placement also checks identity without update subscriptions or immutable metadata", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async ({ state, room }) => {
    const { putAsset } = await import("/src/scan-storage.js");
    const { openScanViewer } = await import("/src/scan-viewer.js");
    window.customScanState = state;
    window.customScanSaves = 0;
    await putAsset("shared-asset", new Blob([room]));
    await openScanViewer("living-room", {
      getState: () => window.customScanState, esc: String, navigate() {},
      save() { window.customScanSaves++; return true; },
    });
  }, { state: inventory(), room });
  await markerForm(page);
  await page.evaluate(() => { window.customScanState.scans[0].assetId = "replacement-asset"; });
  await page.getByRole("button", { name: "Save marker", exact: true }).click();
  await expect(page.locator(".scan-error")).toContainText("scan or account changed");
  expect(await page.evaluate(() => window.customScanSaves)).toBe(0);
});

async function pendingCamera(page, phase) {
  await page.evaluate((phase) => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (options?.xrCompatible) return {
        makeXRCompatible: () => phase === "graphics" ? new Promise((resolve) => { window.resumeXR = resolve; }) : Promise.resolve(),
        getExtension: () => null,
      };
      return original.call(this, type, options);
    };
    window.XRWebGLLayer = class { framebuffer = {}; };
    window.xrEnds = 0;
    window.xrFrames = 0;
    class Session extends EventTarget {
      renderState = {};
      updateRenderState(state) { this.renderState = state; }
      requestReferenceSpace() {
        return phase === "reference" ? new Promise((resolve) => { window.resumeXR = () => resolve({}); }) : Promise.resolve({});
      }
      requestAnimationFrame() { window.xrFrames++; }
      async end() { window.xrEnds++; this.dispatchEvent(new Event("end")); }
    }
    Object.defineProperty(navigator, "xr", { configurable: true, value: {
      requestSession: () => phase === "permission"
        ? new Promise((resolve) => { window.resumeXR = () => resolve(new Session()); })
        : Promise.resolve(new Session()),
    } });
  }, phase);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Scan with camera", exact: true }).click();
  await page.waitForFunction(() => !!window.resumeXR);
}

for (const phase of ["permission", "graphics", "reference"]) {
  test("camera cancellation during " + phase + " is immediate and preserves the old scan", async ({ page }) => {
    await seed(page);
    const original = await page.evaluate(() => localStorage.getItem("haven-inventory"));
    await pendingCamera(page, phase);
    await expect(page.getByRole("button", { name: "Finish scan", exact: true })).toBeDisabled();
    await page.locator("[data-cancel-capture]").click();
    await expect(page.locator(".capture-overlay")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Import scan", exact: true })).toBeEnabled();
    await page.evaluate(() => window.resumeXR());
    await page.waitForFunction(() => window.xrEnds === 1);
    expect(await page.evaluate(() => window.xrFrames)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(original);
  });
}

test("closing the viewer aborts pending camera setup and closes any late session", async ({ page }) => {
  await seed(page);
  await pendingCamera(page, "permission");
  await page.evaluate(() => document.querySelector(".scan-dialog").close());
  await expect(page.locator(".scan-dialog")).toHaveCount(0);
  await page.evaluate(() => window.resumeXR());
  await page.waitForFunction(() => window.xrEnds === 1);
  expect(await page.evaluate(() => window.xrFrames)).toBe(0);
});
