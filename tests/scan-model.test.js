import test from "node:test";
import assert from "node:assert/strict";
import { readObject, disposeObject, validateScanAsset } from "../src/scan-model.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { Bone, BoxGeometry, DataTexture, Group, InstancedMesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Texture } from "three";
import { makeGLB, triangleGLB } from "./helpers/scan-fixtures.js";
import { decodeScanImages } from "../src/scan-images.js";

function modifyGLB(buffer, update) {
  const length = buffer.readUInt32LE(12);
  const document = JSON.parse(buffer.subarray(20, 20 + length).toString());
  const binary = buffer.subarray(28 + length);
  update(document);
  return makeGLB(document, binary);
}

test("scan bounds come from coordinates even when GLB accessor bounds are false", async () => {
  const buffer = modifyGLB(triangleGLB(), (document) => {
    document.accessors[0].min = [10000, 10000, 10000];
    document.accessors[0].max = [10001, 10001, 10000];
  });
  const object = await readObject(new Blob([buffer]), "glb");
  assert.deepEqual(object.children[0].geometry.boundingBox.min.toArray(), [0, 0, 0]);
  assert.deepEqual(object.children[0].geometry.boundingBox.max.toArray(), [1, 1, 0]);
  disposeObject(object);
});

test("incomplete and non-finite rendering attributes reject a replacement", async () => {
  const buffer = modifyGLB(triangleGLB(), (document) => {
    document.accessors.push({ ...document.accessors[0], count: 1 });
    document.meshes[0].primitives[0].attributes.NORMAL = 2;
  });
  await assert.rejects(readObject(new Blob([buffer]), "glb"), /normal attribute/);
  await assert.rejects(readObject(new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1//5 2//5 3//5\n"]), "obj"), /invalid normal/);
  await assert.rejects(readObject(new Blob(["v 0 0 0 1 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]), "obj"), /color attribute/);
});

test("external images are rejected before Three can silently drop the texture", async (context) => {
  const parse = context.mock.method(GLTFLoader.prototype, "parseAsync", () => { throw Error("Parser must not run"); });
  const buffer = modifyGLB(triangleGLB(), (document) => {
    document.images = [{ uri: "https://example.invalid/room.jpg" }];
  });
  await assert.rejects(readObject(new Blob([buffer]), "glb"), /self-contained GLB/);
  assert.equal(parse.mock.callCount(), 0);
});

test("decoded image dimensions are budgeted before a decoder is invoked", async (context) => {
  const parse = context.mock.method(GLTFLoader.prototype, "parseAsync", () => { throw Error("Parser must not run"); });
  const png = Buffer.alloc(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12);
  png.writeUInt32BE(8192, 16); png.writeUInt32BE(4096, 20);
  const buffer = modifyGLB(triangleGLB(), (document) => {
    document.images = [{ uri: `data:image/png;base64,${png.toString("base64")}` }];
  });
  await assert.rejects(readObject(new Blob([buffer]), "glb"), /textures use too much memory/);
  assert.equal(parse.mock.callCount(), 0);
});

test("failed fallback image decoding always releases its Blob URL", async (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
    set src(value) { queueMicrotask(() => this.onerror()); }
  } });
  context.after(() => { if (original) Object.defineProperty(globalThis, "Image", original); else delete globalThis.Image; });
  const create = context.mock.method(URL, "createObjectURL", () => "blob:test-image");
  const revoke = context.mock.method(URL, "revokeObjectURL", () => {});
  await assert.rejects(decodeScanImages([{ bytes: new Uint8Array([1]), mimeType: "image/png", width: 1, height: 1 }]), /could not be decoded/);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(revoke.mock.calls[0].arguments[0], "blob:test-image");
});

test("alternate scenes do not allocate cloned instances for unused room scenes", async (context) => {
  let allocations = 0;
  const clone = InstancedMesh.prototype.clone;
  context.mock.method(InstancedMesh.prototype, "clone", function (...args) { allocations++; return clone.apply(this, args); });
  const buffer = modifyGLB(triangleGLB({ instances: 1000 }), (document) => {
    document.scenes = Array.from({ length: 100 }, () => ({ nodes: [0] }));
  });
  const object = await readObject(new Blob([buffer]), "glb");
  assert.ok(allocations < 2);
  disposeObject(object);
});

test("tiny primitives and OBJ groups cannot bypass the scene object budget", async (context) => {
  const parse = context.mock.method(GLTFLoader.prototype, "parseAsync", () => { throw Error("Parser must not run"); });
  const buffer = modifyGLB(triangleGLB(), (document) => {
    document.meshes[0].primitives = Array.from({ length: 2001 }, () => ({ attributes: { POSITION: 0 }, indices: 1 }));
  });
  await assert.rejects(readObject(new Blob([buffer]), "glb"), /too many objects/);
  assert.equal(parse.mock.callCount(), 0);
  const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\n" + Array.from({ length: 2001 }, (_, index) => `o part${index}\nf 1 2 3\n`).join("");
  await assert.rejects(readObject(new Blob([obj]), "obj"), /too many objects/);
});

test("disposing a scan releases instance buffers, morph textures and shared skeleton resources", () => {
  const model = new Group();
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  material.map = new Texture();
  const instances = new InstancedMesh(geometry, material, 2);
  instances.morphTexture = new DataTexture();
  const skeleton = new Skeleton([new Bone()]);
  skeleton.computeBoneTexture();
  const meshes = [new SkinnedMesh(geometry, material), new SkinnedMesh(geometry, material)];
  for (const mesh of meshes) mesh.skeleton = skeleton;
  model.add(instances, ...meshes);
  const resources = [instances, instances.instanceMatrix, instances.morphTexture,
    skeleton.boneTexture, geometry, material, material.map];
  const disposals = resources.map(() => 0);
  resources.forEach((resource, index) => resource.addEventListener("dispose", () => disposals[index]++));

  disposeObject(model);

  assert.deepEqual(disposals, resources.map(() => 1));
  assert.equal(skeleton.boneTexture, null);
  assert.equal(instances.morphTexture, null);
});

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
