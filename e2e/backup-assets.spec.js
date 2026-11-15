import { test, expect } from "./fixture.js";

test("shared restore files decode once and validate once per declared format", async ({ page }) => {
  const validate = "export async function validateScanAsset(blob, format) {";
  await page.route("**/src/scan-model.js*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    expect(source).toContain(validate);
    await route.fulfill({ response,
      body: source.replace(validate, `${validate}\n  (window.validatedFormats ||= []).push(format);`),
    });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { stageBackup, getAsset } = await import("/src/scan-storage.js");
    const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const scans = Array.from({ length: 20 }, (_, index) => ({
      id: `scan-${index}`, assetId: "shared", format: "obj",
    }));
    const assets = [{ id: "shared", data: `data:application/octet-stream;base64,${btoa(obj)}` }];
    const original = window.atob;
    let decodes = 0;
    window.atob = (...args) => { decodes++; return original(...args); };
    try {
      const staged = await stageBackup({ inventory: { scans }, assets }, "shared-test");
      const formats = [...window.validatedFormats];
      const bytes = await (await getAsset("shared", "shared-test")).text();
      await staged.rollback();
      const sharedDecodes = decodes;
      window.validatedFormats = [];
      let error = "";
      try {
        await stageBackup({ inventory: { scans: [scans[0], { ...scans[1], format: "glb" }] }, assets }, "mismatch-test");
      } catch (failure) { error = failure.message; }
      return { formats, bytes, obj, sharedDecodes, error,
        mismatchFormats: window.validatedFormats,
        rolledBack: !(await getAsset("shared", "mismatch-test")) };
    } finally { window.atob = original; }
  });
  expect(result.formats).toEqual(["obj"]);
  expect(result.sharedDecodes).toBe(1);
  expect(result.bytes).toBe(result.obj);
  expect(result.mismatchFormats).toEqual(["obj", "glb"]);
  expect(result.error).toContain("Invalid GLB");
  expect(result.rolledBack).toBe(true);
});

test("portable asset IDs survive restores, collisions, and overlapping rollbacks", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { putAsset, getAsset, createBackupBlob, stageBackup } = await import("/src/scan-storage.js");
    const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const scan = (id, assetId) => ({ id, assetId, locationId: "room", name: "room.obj", format: "obj" });
    const inventory = { scans: [scan("one", "shared"), scan("two", "shared")] };
    await putAsset("shared", new Blob([obj]), "device-a");
    const backup = JSON.parse(await (await createBackupBlob(inventory, "device-a")).text());
    const first = await stageBackup(backup, "device-b");
    const second = await stageBackup(backup, "device-b");
    await first.rollback();
    await second.rollback();
    const portable = first.inventory.scans.map((item) => item.assetId);
    const deviceB = await (await getAsset("shared", "device-b")).text();
    const deviceA = await (await getAsset(portable[0], "device-a")).text();

    await putAsset("collision", new Blob(["original bytes"]), "device-b");
    const collisionBackup = { inventory: { scans: [scan("new", "new"), scan("collision", "collision")] },
      assets: ["new", "collision"].map((id) => ({ id, data: backup.assets[0].data })) };
    let error = "";
    try { await stageBackup(collisionBackup, "device-b"); } catch (e) { error = e.message; }
    const rolledBack = !(await getAsset("new", "device-b"));
    const collision = await (await getAsset("collision", "device-b")).text();

    const replacement = await stageBackup({ inventory: { scans: [scan("replacement", "replacement")] },
      assets: [{ id: "replacement", data: backup.assets[0].data }] }, "device-b");
    await putAsset("replacement", new Blob(["changed"]), "device-b");
    await replacement.rollback();
    return { portable, deviceA, deviceB, obj, error, rolledBack, collision,
      replacement: await (await getAsset("replacement", "device-b")).text() };
  });
  expect(result.portable).toEqual(["shared", "shared"]);
  expect(result.deviceA).toBe(result.obj);
  expect(result.deviceB).toBe(result.obj);
  expect(result.error).toContain("different content");
  expect(result.rolledBack).toBe(true);
  expect(result.collision).toBe("original bytes");
  expect(result.replacement).toBe("changed");
});

test("scoped asset IDs cannot read, overwrite, or delete another account's files", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { putAsset, getAsset, deleteAssets, stageBackup } = await import("/src/scan-storage.js");
    const { initialState } = await import("/src/store.js");
    const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    await putAsset("original", new Blob([obj]), "alice");
    await putAsset("guest-file", new Blob([obj]), null, { staged: true });
    const inventory = initialState();
    inventory.scans = [{ id: "scan", assetId: "alice:original", locationId: "living-room", name: "room.obj", format: "obj" }];
    const backup = { inventory, assets: [{ id: "alice:original", data: `data:application/octet-stream;base64,${btoa(obj)}` }] };
    const errors = [];
    for (const operation of [
      () => stageBackup(backup, null),
      () => getAsset("alice:original", null),
      () => putAsset("alice:original", new Blob(["changed"]), null),
      () => deleteAssets(["guest-file", "alice:original"], null),
    ]) {
      try { await operation(); errors.push(""); }
      catch (error) { errors.push(error.message); }
    }
    return { errors, account: await (await getAsset("original", "alice")).text(),
      guest: await (await getAsset("guest-file", null)).text(), obj };
  });
  expect(result.errors).toHaveLength(4);
  for (const error of result.errors) expect(error).toContain("scan file ID is invalid");
  expect(result.account).toBe(result.obj);
  expect(result.guest).toBe(result.obj);
});
