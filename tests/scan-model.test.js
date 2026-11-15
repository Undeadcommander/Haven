import test from "node:test";
import assert from "node:assert/strict";
import { readObject, disposeObject, validateScanAsset } from "../src/scan-model.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { makeGLB, triangleGLB } from "./helpers/scan-fixtures.js";

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

test("GLB index validation rejects out-of-range vertices before a scan can be saved", async () => {
  await assert.rejects(validateScanAsset(new Blob([triangleGLB({ indices: [0, 1, 65535] })]), "glb"), /invalid geometry indices/);
  await validateScanAsset(new Blob([triangleGLB()]), "glb");
});

test("invalid index layouts and incomplete triangles are not accepted as scans", async () => {
  const binary = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 2]);
  const document = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "SCALAR" },
    ],
  };
  await assert.rejects(validateScanAsset(new Blob([makeGLB(document, new Uint8Array(binary.buffer))]), "glb"), /invalid geometry indices/);
  await assert.rejects(validateScanAsset(new Blob([triangleGLB({ indices: [0, 1] })]), "glb"), /incomplete triangles/);
});

test("GLB preflight rejects oversized allocations and overlapping buffers before loading", async (context) => {
  const parser = context.mock.method(GLTFLoader.prototype, "parseAsync", () => {
    throw Error("The loader must not run");
  });
  const documents = [
    { asset: { version: "2.0" }, accessors: [{ componentType: 5126, count: 100_000_000, type: "VEC3" }] },
    { asset: { version: "2.0" }, bufferViews: Array.from({ length: 5 }, () => ({ buffer: 0, byteLength: 30_000_000 })) },
    { asset: { version: "2.0" }, accessors: Array.from({ length: 2 }, () => ({ componentType: 5126, count: 2_000_000, type: "MAT4" })) },
  ];
  for (const document of documents)
    await assert.rejects(validateScanAsset(new Blob([makeGLB(document)]), "glb"), /too detailed/);
  assert.equal(parser.mock.callCount(), 0);
});

test("GLB complexity accounts for instances and index workload before allocating meshes", async (context) => {
  await validateScanAsset(new Blob([triangleGLB({ instances: 2 })]), "glb");
  const parser = context.mock.method(GLTFLoader.prototype, "parseAsync", () => {
    throw Error("The loader must not run");
  });
  await assert.rejects(validateScanAsset(new Blob([triangleGLB({ triangles: 300, instances: 10_000 })]), "glb"), /including indices and instances/);
  const document = {
    asset: { version: "2.0" }, nodes: [{ mesh: 0 }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { componentType: 5126, count: 3, type: "VEC3" },
      { componentType: 5123, count: 1_100_000, type: "SCALAR" },
    ],
  };
  await assert.rejects(validateScanAsset(new Blob([makeGLB(document)]), "glb"), /too detailed/);
  assert.equal(parser.mock.callCount(), 0);
});

test("OBJ triangulation is bounded before the parser allocates expanded geometry", async (context) => {
  const parser = context.mock.method(OBJLoader.prototype, "parse", () => {
    throw Error("The loader must not run");
  });
  const text = "v 0 0 0\nv 1 0 0\nv 0 1 0\n" + "f 1 2 3\n".repeat(666_667);
  await assert.rejects(validateScanAsset(new Blob([text]), "obj"), /too detailed/);
  assert.equal(parser.mock.callCount(), 0);
});

test("cyclic GLB node trees and invalid headers are rejected before loading", async (context) => {
  const parser = context.mock.method(GLTFLoader.prototype, "parseAsync", () => {
    throw Error("The loader must not run");
  });
  await assert.rejects(validateScanAsset(new Blob([makeGLB({ asset: { version: "2.0" }, nodes: [{ children: [0] }] })]), "glb"), /Invalid GLB/);
  const deep = Array.from({ length: 131 }, (_, index) => index === 0 ? {} : { children: [index - 1] });
  await assert.rejects(validateScanAsset(new Blob([makeGLB({ asset: { version: "2.0" }, nodes: deep })]), "glb"), /too detailed/);
  const broken = triangleGLB();
  broken.writeUInt32LE(broken.length + 4, 8);
  await assert.rejects(validateScanAsset(new Blob([broken]), "glb"), /Invalid GLB/);
  assert.equal(parser.mock.callCount(), 0);
});
