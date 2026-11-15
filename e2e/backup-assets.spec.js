import { test, expect } from "./fixture.js";

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
