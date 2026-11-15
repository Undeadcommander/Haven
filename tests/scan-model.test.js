import test from "node:test";
import assert from "node:assert/strict";
import { readObject, disposeObject, validateScanAsset } from "../src/scan-model.js";

test("scan validation rejects empty, truncated and non-finite point clouds", async () => {
  for (const blob of [new Blob(), new Blob([new Uint8Array(3)]),
    new Blob([new Float32Array([0, 0, 0, NaN, 1, 1])])]) {
    await assert.rejects(validateScanAsset(blob, "points"));
  }
  await assert.rejects(validateScanAsset(new Blob([new Float32Array([0, 0, 0])]), "points"), /dimensions/);
  await validateScanAsset(new Blob([new Float32Array([0, 0, 0, 1, 1, 1])]), "points");
});

test("backup and viewer validation share geometry checks for OBJ and GLB", async () => {
  const model = await readObject(new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]), "obj");
  assert.ok(model.children.length > 0);
  disposeObject(model);
  await assert.rejects(validateScanAsset(new Blob(["# no geometry\n"]), "obj"), /3D surface/);
  await assert.rejects(validateScanAsset(new Blob(["glTF"]), "glb"));
  await assert.rejects(validateScanAsset(new Blob(["unknown"]), "other"), /Unknown scan format/);
});
