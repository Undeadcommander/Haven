import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MAX_SCAN_VERTICES, MAX_SCAN_OBJECTS, detailError, preflightGLB, preflightOBJ } from "./scan-limits.js";
import { decodeScanImages } from "./scan-images.js";

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

async function readGLB(buffer) {
  const { images } = preflightGLB(buffer);
  // Decode before Three's texture loader can suppress an image error. This
  // also avoids its embedded-image Blob URLs entirely in modern browsers.
  const decoded = await decodeScanImages(images), textures = new Set(), meshes = new Set();
  let failed = false;
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("data:"))
      throw Error("Export a self-contained GLB with embedded textures and buffers. External scan resources are not loaded.");
    return url;
  });
  const loader = new GLTFLoader(manager);
  loader.register((parser) => {
    const loadMesh = parser.loadMesh.bind(parser);
    parser.loadMesh = (index) => loadMesh(index).then((mesh) => {
      meshes.add(mesh);
      if (failed) disposeObject(mesh);
      return mesh;
    });
    parser.loadImageSource = async (index) => {
      if (!decoded[index]) throw Error("A required scan texture is missing.");
      const texture = new THREE.Texture(decoded[index]);
      texture.needsUpdate = true;
      texture.userData.mimeType = images[index].mimeType;
      textures.add(texture);
      return texture;
    };
    return {
      name: "HavenStaticScan",
      beforeRoot() {
        const scene = parser.json.scenes?.[parser.json.scene || 0];
        if (!scene) throw Error("This file does not contain a 3D scene.");
        // A room scan displays one static scene. Do not expand alternate scenes
        // or animation-only nodes that will never be displayed or disposed.
        parser.json.scenes = [scene];
        parser.json.scene = 0;
        parser.json.animations = [];
      },
    };
  });
  try {
    const result = await loader.parseAsync(buffer, ""), used = new Set();
    result.scene.traverse((child) => {
      for (const material of (Array.isArray(child.material) ? child.material : [child.material]).filter(Boolean))
        for (const value of Object.values(material))
          if (value?.isTexture) used.add(value.source?.data);
    });
    for (const image of decoded) if (!used.has(image)) image.close?.();
    return result.scene;
  } catch (error) {
    failed = true;
    disposeObject({ traverse(visitor) { for (const mesh of meshes) mesh.traverse(visitor); } });
    for (const texture of textures) texture.dispose();
    for (const image of decoded) image.close?.();
    throw error;
  }
}

function validateAttribute(attribute, count, name) {
  const sizes = { position: [3], normal: [3], tangent: [4], color: [3, 4],
    uv: [2], uv1: [2], uv2: [2], uv3: [2], skinIndex: [4], skinWeight: [4], instanceMatrix: [16] };
  if (attribute.count !== count || !Number.isInteger(attribute.itemSize) ||
      attribute.itemSize < 1 || attribute.itemSize > (name === "instanceMatrix" ? 16 : 4) ||
      (sizes[name] && !sizes[name].includes(attribute.itemSize)))
    throw Error(`This scan contains an invalid ${name} attribute. Export consistent geometry attributes.`);
  for (let index = 0; index < count; index++)
    for (let component = 0; component < attribute.itemSize; component++)
      if (!Number.isFinite(attribute.getComponent(index, component)))
        throw Error(`This scan contains invalid ${name} coordinates.`);
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
      object = await readGLB(buffer);
    }
    let vertices = 0, objects = 0;
    object.traverse((child) => {
      const positions = child.geometry?.getAttribute("position");
      if (positions) {
        objects += Math.max(1, child.geometry.groups.length);
        if (objects > MAX_SCAN_OBJECTS)
          throw Error("This scan has too many objects or material groups. Export a simplified scan.");
        const indices = child.geometry.index;
        if (indices && (indices.itemSize !== 1 || indices.normalized ||
            ![Uint8Array, Uint16Array, Uint32Array].some((Type) => indices.array instanceof Type)))
          throw Error("This scan contains invalid geometry indices.");
        if (child.isMesh && (indices?.count || positions.count) % 3 !== 0)
          throw Error("This scan contains incomplete triangles.");
        vertices += Math.max(positions.count, indices?.count || 0) *
          (child.isInstancedMesh ? child.count : 1);
        if (vertices > MAX_SCAN_VERTICES) throw detailError();
        for (const [name, attribute] of Object.entries(child.geometry.attributes))
          validateAttribute(attribute, positions.count, name);
        for (const [name, attributes] of Object.entries(child.geometry.morphAttributes))
          for (const attribute of attributes) validateAttribute(attribute, positions.count, name);
        for (let index = 0; index < (indices?.count || 0); index++) {
          const vertex = indices.getX(index);
          if (!Number.isInteger(vertex) || vertex < 0 || vertex >= positions.count)
            throw Error("This scan contains invalid geometry indices.");
        }
        // Accessor min/max values are hints, not validated geometry bounds.
        child.geometry.computeBoundingBox();
        child.geometry.computeBoundingSphere();
        if (child.isInstancedMesh) {
          validateAttribute(child.instanceMatrix, child.count, "instanceMatrix");
          child.computeBoundingBox();
          child.computeBoundingSphere();
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
    object.traverse((child) => {
      if (!child.matrixWorld.elements.every(Number.isFinite)) throw Error("This scan contains invalid transforms.");
    });
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
