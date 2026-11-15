import { readFileSync } from "node:fs";
import { test, expect } from "./fixture.js";
import { initialState } from "../src/store.js";
import { makeGLB, triangleGLB } from "../tests/helpers/scan-fixtures.js";

const room = readFileSync(new URL("./fixtures/room.obj", import.meta.url), "utf8");
function inventory() {
  const state = initialState();
  state.items = [{ id: "keys", name: "Keys", notes: "By the door", locationId: "living-room" }];
  state.scans = [{ id: "scan", assetId: "room-file", locationId: "living-room", name: "room.obj", format: "obj" }];
  state.markers = [{ id: "pin", scanId: "scan", kind: "item", targetId: "keys", position: [0, 1, 0] }];
  return state;
}
async function open(page) {
  await page.getByRole("button", { name: "Open Living room", exact: true }).click();
  await page.getByRole("button", { name: "Open 3D scan", exact: true }).click();
  await expect(page.locator(".scan-status")).toContainText("Loaded room.obj");
}
async function seed(page, markers = true) {
  await page.goto("/");
  const state = inventory();
  if (!markers) state.markers = [];
  await page.evaluate(async ({ state, room }) => {
    localStorage.setItem("haven-inventory", JSON.stringify(state));
    await (await import("/src/scan-storage.js")).putAsset("room-file", new Blob([room]), null);
  }, { state, room });
  await page.reload();
}
async function cloud(page) {
  await page.route("**/src/firebase-config.json*", (route) => route.fulfill({ contentType: "application/javascript",
    body: 'export default {apiKey:"test",authDomain:"test.invalid",projectId:"test",appId:"test"};' }));
  await page.route("**/src/firebase-service.js*", (route) => route.fulfill({ contentType: "application/javascript", body: `
    export async function createFirebaseService() {
      let value=${JSON.stringify(inventory())}, revision=1, listener;
      window.scannerCloud={async replace(next){value=next;await listener({revision:++revision});}};
      return {watchAuth(cb){queueMicrotask(()=>cb({uid:'scanner-review',displayName:'Scanner Review'}));return ()=>{};},
        watch(uid,cb){listener=cb;queueMicrotask(()=>cb({revision}));return ()=>{};},async read(){return value;},
        async publish(){throw Error('Offline test');}};
    }` }));
  await page.goto("/");
  await expect(page.locator("[data-save-status]").first()).toContainText("Account is up to date");
  await page.evaluate(async (room) => {
    await (await import("/src/scan-storage.js")).putAsset("room-file", new Blob([room]), "scanner-review");
  }, room);
}
async function place(page) {
  const box = await page.locator(".scan-stage canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.locator("[data-add-scan-item]").click();
}
const filePresent = (page, id = "room-file", scope = "scanner-review") => page.evaluate(async ({ id, scope }) =>
  !!await (await import("/src/scan-storage.js")).getAsset(id, scope), { id, scope });

test("same-scan cloud changes reconcile dots and details without discarding a placement draft", async ({ page }) => {
  await cloud(page); await open(page);
  await page.getByRole("button", { name: "Item marker: Keys", exact: true }).click();
  const renamed = inventory(); renamed.items[0].name = "Renamed keys";
  await page.evaluate((next) => scannerCloud.replace(next), renamed);
  await expect(page.locator(".scan-panel h3")).toHaveText("Renamed keys");
  await expect(page.getByRole("button", { name: "Item marker: Renamed keys", exact: true })).toHaveCount(1);
  await place(page);
  await page.getByLabel("Choose an option").selectOption("new");
  await page.getByRole("textbox", { name: "Item name", exact: true }).fill("Unfinished draft");
  await page.getByRole("textbox", { name: "Details", exact: true }).fill("Keep this text");
  const changed = inventory();
  changed.items.push({ id: "book", name: "Book", notes: "New cloud item", locationId: "living-room" });
  changed.markers = [{ id: "book-pin", scanId: "scan", kind: "item", targetId: "book", position: [1, 1, 0] }];
  await page.evaluate((next) => scannerCloud.replace(next), changed);
  await expect(page.getByRole("button", { name: "Item marker: Book", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Item marker:.*keys/i })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Item name", exact: true })).toHaveValue("Unfinished draft");
  await expect(page.getByRole("textbox", { name: "Details", exact: true })).toHaveValue("Keep this text");
  await page.getByRole("button", { name: "Cancel placement", exact: false }).click();
  await expect(page.locator(".marker-list")).toContainText("Book");
  changed.markers = [];
  await page.evaluate((next) => scannerCloud.replace(next), changed);
  await expect(page.locator(".scan-dot")).toHaveCount(0);
  await expect(page.locator(".scan-panel h3")).toHaveText("On the map 0");
});

test("portrait fit includes every room corner and orbit drags preserve placement mode", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await seed(page, false);
  await page.evaluate(async () => {
    await import("/src/scan-viewer.js");
    const url = performance.getEntriesByType("resource").find((entry) => /\/deps\/three\.js\?/.test(entry.name)).name;
    const THREE = await import(url), update = THREE.PerspectiveCamera.prototype.updateProjectionMatrix;
    window.scanTHREE = THREE;
    THREE.PerspectiveCamera.prototype.updateProjectionMatrix = function () { update.call(this); window.scanCamera = this; };
  });
  await open(page);
  for (const reset of [false, true]) {
    if (reset) await page.getByRole("button", { name: "Reset view", exact: true }).click();
    expect(await page.evaluate(() => {
      const points = [];
      for (const x of [-2, 2]) for (const y of [0, 3]) for (const z of [-2, 2])
        points.push(new scanTHREE.Vector3(x, y, z).project(scanCamera));
      return points.every((point) => Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1);
    })).toBe(true);
  }
  await page.getByRole("button", { name: "Place marker", exact: true }).click();
  const box = await page.locator(".scan-stage canvas").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 65, y + 20, { steps: 10 }); await page.mouse.up();
  await expect(page.locator(".scan-context")).toBeHidden();
  await expect(page.locator("[data-place-marker]")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(x, y);
  await expect(page.locator(".scan-context")).toBeVisible();
  await expect(page.locator("[data-place-marker]")).toHaveAttribute("aria-pressed", "false");
});

test("offline removal keeps the file needed by a later account-version conflict choice", async ({ page }) => {
  await cloud(page); await open(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove scan", exact: true }).click();
  await expect(page.locator(".scan-dialog")).toHaveCount(0);
  expect(await filePresent(page)).toBe(true);
  const incoming = inventory(); incoming.items[0].notes = "Other device edit";
  await page.evaluate((next) => scannerCloud.replace(next), incoming);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Use account version", exact: true }).click();
  await expect(page.locator("[data-save-status]").first()).toContainText("Account is up to date");
  await page.getByRole("button", { name: "Close account", exact: true }).click();
  await open(page);
  expect(await filePresent(page)).toBe(true);
});

test("recovery exports keep their scan files after removal from the active inventory", async ({ page }) => {
  await cloud(page); await open(page); await place(page);
  await page.getByLabel("Choose an option").selectOption("new");
  await page.getByRole("textbox", { name: "Item name", exact: true }).fill("Local book");
  await page.getByRole("button", { name: "Save marker", exact: true }).click();
  await page.getByRole("button", { name: "Close scan", exact: true }).click();
  const incoming = inventory(); incoming.items[0].notes = "Other device edit";
  await page.evaluate((next) => scannerCloud.replace(next), incoming);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Use this device’s version", exact: true }).click();
  await page.getByRole("button", { name: "Close account", exact: true }).click();
  await page.getByRole("button", { name: "Open 3D scan", exact: true }).click();
  await expect(page.locator(".scan-status")).toContainText("Loaded room.obj");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove scan", exact: true }).click();
  expect(await page.evaluate(async () => {
    const inventory = JSON.parse(localStorage.getItem("haven-recovery:scanner-review"));
    const backup = await (await import("/src/scan-storage.js")).createBackupBlob(inventory, "scanner-review");
    return JSON.parse(await backup.text()).assets.length;
  })).toBe(1);
});

test("cloud removal cleans orphan files while retaining other account scopes", async ({ page }) => {
  await cloud(page);
  await page.evaluate(async (room) => {
    await (await import("/src/scan-storage.js")).putAsset("other-file", new Blob([room]), "another-user");
  }, room);
  const incoming = inventory(); incoming.scans = []; incoming.markers = [];
  await page.evaluate((next) => scannerCloud.replace(next), incoming);
  await expect.poll(() => filePresent(page)).toBe(false);
  expect(await filePresent(page, "other-file", "another-user")).toBe(true);
});

test("startup retries an interrupted file deletion and staged files survive sweeps", async ({ page }) => {
  await seed(page); await open(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (id) {
      const request = original.call(this, id);
      if (id === "room-file" && !window.cleanupFailed) { window.cleanupFailed = true; this.transaction.abort(); }
      return request;
    };
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove scan", exact: true }).click();
  await page.waitForFunction(() => window.cleanupFailed);
  expect(await filePresent(page, "room-file", null)).toBe(true);
  await page.reload();
  await expect.poll(() => filePresent(page, "room-file", null)).toBe(false);
  expect(await page.evaluate(async () => {
    const { putAsset, getAsset, commitAssets, reconcileAssets } = await import("/src/scan-storage.js");
    await putAsset("staged", new Blob(["pending bytes"]), null, { staged: true });
    await reconcileAssets(() => new Set(), null);
    const protectedFile = !!await getAsset("staged", null);
    await commitAssets(["staged"], null);
    await reconcileAssets(() => new Set(), null);
    return { protectedFile, cleaned: !await getAsset("staged", null) };
  })).toEqual({ protectedFile: true, cleaned: true });
});

function texturedGLB(uri) {
  const base = triangleGLB(), length = base.readUInt32LE(12);
  const document = JSON.parse(base.subarray(20, 20 + length).toString());
  document.images = [{ uri }]; document.textures = [{ source: 0 }];
  document.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  document.meshes[0].primitives[0].material = 0;
  return makeGLB(document, base.subarray(28 + length));
}

test("native texture decoding succeeds for valid images and rejects broken replacements without leaked URLs", async ({ page }) => {
  await seed(page); await open(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png");
  });
  const valid = texturedGLB(png);
  expect(await page.evaluate(async (bytes) => {
    const { readObject, disposeObject } = await import("/src/scan-model.js");
    const object = await readObject(new Blob([new Uint8Array(bytes)]), "glb");
    const width = object.children[0].material.map.image.width;
    disposeObject(object); return width;
  }, [...valid])).toBe(2);
  const original = await page.evaluate(() => localStorage.getItem("haven-inventory"));
  const broken = Buffer.alloc(24); broken.set([137, 80, 78, 71, 13, 10, 26, 10]);
  broken.writeUInt32BE(13, 8); broken.write("IHDR", 12); broken.writeUInt32BE(2, 16); broken.writeUInt32BE(2, 20);
  await page.evaluate(() => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    window.textureURLs = new Set();
    URL.createObjectURL = function (blob) { const url = create.call(this, blob); textureURLs.add(url); return url; };
    URL.revokeObjectURL = function (url) { textureURLs.delete(url); return revoke.call(this, url); };
  });
  for (const [uri, message] of [[`data:image/png;base64,${broken.toString("base64")}`, "could not be decoded"],
    ["https://example.invalid/room.jpg", "self-contained GLB"]]) {
    await page.locator("[data-scan-file]").setInputFiles({ name: "broken.glb", mimeType: "model/gltf-binary", buffer: texturedGLB(uri) });
    await expect(page.locator(".scan-error")).toContainText(message);
    expect(await page.evaluate(() => localStorage.getItem("haven-inventory"))).toBe(original);
    expect(await page.evaluate(() => textureURLs.size)).toBe(0);
    await expect(page.getByRole("button", { name: "Item marker: Keys", exact: true })).toHaveCount(1);
  }
});
