import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MAX_SCAN_VERTICES, detailError, preflightGLB, preflightOBJ } from "./scan-limits.js";

export function disposeObject(object) {
  const textures = new Set(),
    materials = new Set(),
    geometries = new Set(),
    skeletons = new Set();
  object?.traverse((child) => {
    // Instance buffers and bone textures belong to the object/skeleton, not
    // its geometry or material. Release them when replacing a scan too.
    if (child.isInstancedMesh) child.dispose();
    if (child.skeleton) skeletons.add(child.skeleton);
    if (child.geometry) geometries.add(child.geometry);
    for (const material of (Array.isArray(child.material)
      ? child.material
      : [child.material]
    ).filter(Boolean)) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value?.isTexture) textures.add(value);
    }
  });
  for (const texture of textures) {
    texture.source?.data?.close?.();
    texture.dispose();
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
export async function readObject(blob, format) {
  let object;
  try {
    if (!blob.size) throw Error("The scan file is empty.");
    if (blob.size > 30_000_000) throw Error("Choose a scan smaller than 30 MB.");
    if (!["obj", "glb", "points"].includes(format))
      throw Error("Unknown scan format.");
    if (format === "obj") object = new OBJLoader().parse(preflightOBJ(await blob.text()));
    else if (format === "points") {
      const buffer = await blob.arrayBuffer();
      if (buffer.byteLength % 12 !== 0 || buffer.byteLength < 12)
        throw Error("Invalid depth scan.");
      if (buffer.byteLength / 12 > MAX_SCAN_VERTICES) throw detailError();
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(buffer), 3),
      );
      object = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: 0x9abda5,
          size: 0.035,
          sizeAttenuation: true,
        }),
      );
    } else {
      const buffer = await blob.arrayBuffer();
      preflightGLB(buffer);
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (!url.startsWith("blob:") && !url.startsWith("data:"))
          throw Error(
            "Export a self-contained GLB with embedded textures. External scan resources are not loaded.",
          );
        return url;
      });
      object = (
        await new GLTFLoader(manager).parseAsync(buffer, "")
      ).scene;
    }
    let vertices = 0;
    object.traverse((child) => {
      const positions = child.geometry?.getAttribute("position");
      if (positions) {
        const indices = child.geometry.index;
        if (indices && (indices.itemSize !== 1 || indices.normalized ||
            ![Uint8Array, Uint16Array, Uint32Array].some((Type) => indices.array instanceof Type)))
          throw Error("This scan contains invalid geometry indices.");
        if (child.isMesh && (indices?.count || positions.count) % 3 !== 0)
          throw Error("This scan contains incomplete triangles.");
        vertices += Math.max(positions.count, indices?.count || 0) *
          (child.isInstancedMesh ? child.count : 1);
        if (vertices > MAX_SCAN_VERTICES) throw detailError();
        if (positions.itemSize !== 3) throw Error("Invalid scan coordinates.");
        for (let index = 0; index < positions.count; index++)
          if (!Number.isFinite(positions.getX(index)) ||
              !Number.isFinite(positions.getY(index)) ||
              !Number.isFinite(positions.getZ(index)))
            throw Error("This scan contains invalid coordinates.");
        for (let index = 0; index < (indices?.count || 0); index++) {
          const vertex = indices.getX(index);
          if (!Number.isInteger(vertex) || vertex < 0 || vertex >= positions.count)
            throw Error("This scan contains invalid geometry indices.");
        }
      }
      if (child.isMesh) {
        for (const m of Array.isArray(child.material)
          ? child.material
          : [child.material])
          m.side = THREE.DoubleSide;
      }
    });
    if (!vertices)
      throw Error("This file does not contain a 3D surface or depth points.");
    object.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(object),
      size = bounds.getSize(new THREE.Vector3());
    if (
      bounds.isEmpty() ||
      !Number.isFinite(size.length()) ||
      size.length() < 0.00001
    )
      throw Error("This scan has no usable dimensions.");
    return object;
  } catch (error) {
    disposeObject(object);
    throw Error(
      error.message?.includes("DRACO")
        ? "This scan uses Draco compression. Export an uncompressed GLB or OBJ."
        : error.message ||
            "Could not read this scan. Export a GLB or OBJ and try again.",
    );
  }
}

export async function validateScanAsset(blob, format) {
  const object = await readObject(blob, format);
  disposeObject(object);
}
