import { decodeDataURI, imageDimensions } from "./scan-images.js";
export const MAX_SCAN_VERTICES = 2_000_000;
const MAX_DECODED_BYTES = 128_000_000;
const MAX_SCAN_NODES = 10_000;
export const MAX_SCAN_OBJECTS = 2_000;
const objectError = () => Error("This scan has too many objects or material groups. Export a simplified scan with at most 2,000 renderable objects and material groups.");
export const detailError = () => Error(
  "This scan is too detailed. Export a simplified model with at most two million vertices, including indices and instances.",
);

export function preflightGLB(buffer) {
  const invalid = () => Error("Invalid GLB scan.");
  if (buffer.byteLength < 20) throw invalid();
  const header = new DataView(buffer);
  const jsonSize = header.getUint32(12, true);
  if (header.getUint32(0, true) !== 0x46546c67 ||
      header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== buffer.byteLength ||
      header.getUint32(16, true) !== 0x4e4f534a ||
      !jsonSize || jsonSize % 4 || jsonSize > buffer.byteLength - 20)
    throw invalid();
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonSize)));
  const accessors = document.accessors || [],
    meshes = document.meshes || [],
    nodes = document.nodes || [];
  if (![accessors, meshes, nodes, document.bufferViews || []].every(Array.isArray))
    throw invalid();
  if (nodes.length > MAX_SCAN_NODES) throw detailError();
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 },
    bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let decodedBytes = 0;
  const reserve = (size) => {
    if (!Number.isSafeInteger(size) || size < 0) throw invalid();
    decodedBytes += size;
    if (decodedBytes > MAX_DECODED_BYTES) throw detailError();
  };
  for (const view of document.bufferViews || []) reserve(view?.byteLength);
  for (const accessor of accessors) {
    if (!accessor || !Number.isSafeInteger(accessor.count) || accessor.count < 1 ||
        !components[accessor.type] || !bytes[accessor.componentType]) throw invalid();
    if (accessor.count > MAX_SCAN_VERTICES) throw detailError();
    reserve(accessor.count * components[accessor.type] * bytes[accessor.componentType]);
  }
  const accessorCount = (index) => {
    if (!Number.isInteger(index) || !accessors[index]) throw invalid();
    return accessors[index].count;
  };
  const costs = meshes.map((mesh) => {
    if (!Array.isArray(mesh?.primitives)) throw invalid();
    return mesh.primitives.reduce((total, primitive) => {
      if (primitive.targets !== undefined) {
        if (!Array.isArray(primitive.targets)) throw invalid();
        // Room scans are static. Repeated morph accessors expand into large
        // float textures at render time, outside the ordinary accessor budget.
        if (primitive.targets.length)
          throw Error("This scan contains morph targets. Export a static mesh without morph targets.");
      }
      const positions = accessorCount(primitive.attributes?.POSITION);
      let drawn = primitive.indices === undefined ? positions : accessorCount(primitive.indices);
      if (primitive.mode === 5 || primitive.mode === 6) drawn = Math.max(0, drawn - 2) * 3;
      return total + Math.max(positions, drawn);
    }, 0);
  });
  let vertices = 0, objects = 0;
  for (const node of nodes) {
    if (!node || typeof node !== "object") throw invalid();
    if (node.mesh === undefined) continue;
    if (!Number.isInteger(node.mesh) || costs[node.mesh] === undefined) throw invalid();
    objects += meshes[node.mesh].primitives.length;
    if (objects > MAX_SCAN_OBJECTS) throw objectError();
    let instances = 1;
    const instancing = node.extensions?.EXT_mesh_gpu_instancing;
    if (instancing) {
      const attributes = Object.values(instancing.attributes || {});
      if (!attributes.length) throw invalid();
      instances = accessorCount(attributes[0]);
      if (!attributes.every((index) => accessorCount(index) === instances)) throw invalid();
      reserve(instances * 64);
    }
    vertices += costs[node.mesh] * instances;
    if (vertices > MAX_SCAN_VERTICES) throw detailError();
  }
  const parents = new Uint8Array(nodes.length);
  for (const node of nodes) {
    const children = node.children || [];
    if (!Array.isArray(children) || children.length > MAX_SCAN_NODES) throw invalid();
    for (const child of children) {
      if (!Number.isInteger(child) || !nodes[child] || parents[child]) throw invalid();
      parents[child] = 1;
    }
  }
  const visited = new Uint8Array(nodes.length);
  for (let root = 0; root < nodes.length; root++) {
    if (parents[root]) continue;
    const stack = [{ index: root, exit: false, depth: 0 }];
    while (stack.length) {
      const { index, exit, depth } = stack.pop();
      if (!Number.isInteger(index) || !nodes[index]) throw invalid();
      if (exit) { visited[index] = 2; continue; }
      if (visited[index] === 1) throw invalid();
      if (visited[index] === 2) continue;
      if (depth > 128) throw detailError();
      visited[index] = 1;
      stack.push({ index, exit: true, depth });
      for (const child of nodes[index].children || [])
        stack.push({ index: child, exit: false, depth: depth + 1 });
    }
  }
  if (visited.some((state) => state !== 2)) throw invalid();
  const scenes = document.scenes || [];
  if (!Array.isArray(scenes)) throw invalid();
  for (const scene of scenes) {
    if (!Array.isArray(scene?.nodes || [])) throw invalid();
    const roots = new Set();
    for (const root of scene.nodes || []) {
      if (!Number.isInteger(root) || !nodes[root] || parents[root] || roots.has(root)) throw invalid();
      roots.add(root);
    }
  }
  if (document.scene !== undefined && (!Number.isInteger(document.scene) || !scenes[document.scene])) throw invalid();
  const binaryOffset = 20 + jsonSize;
  let binary = new Uint8Array();
  if (binaryOffset + 8 <= buffer.byteLength) {
    const size = header.getUint32(binaryOffset, true);
    if (header.getUint32(binaryOffset + 4, true) !== 0x004e4942 || size > buffer.byteLength - binaryOffset - 8) throw invalid();
    binary = new Uint8Array(buffer, binaryOffset + 8, size);
  }
  if (!Array.isArray(document.buffers || []) || !Array.isArray(document.images || []) || !Array.isArray(document.textures || [])) throw invalid();
  const buffers = (document.buffers || []).map((entry, index) => {
    const bytes = entry.uri === undefined ? (index === 0 ? binary : null) : decodeDataURI(entry.uri).bytes;
    if (!bytes || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > bytes.byteLength) throw invalid();
    reserve(bytes.byteLength);
    return bytes;
  });
  const images = (document.images || []).map((image) => {
    let bytes;
    if (image.uri !== undefined) bytes = decodeDataURI(image.uri).bytes;
    else {
      const view = document.bufferViews?.[image.bufferView], source = buffers[view?.buffer];
      const offset = view?.byteOffset || 0;
      if (!view || !source || !Number.isSafeInteger(offset) || offset < 0 || offset + view.byteLength > source.byteLength) throw invalid();
      bytes = source.subarray(offset, offset + view.byteLength);
    }
    const dimensions = imageDimensions(bytes);
    if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192)
      throw Error("A scan texture is too large. Export smaller textures (at most 8192 pixels on each side).");
    return { bytes, ...dimensions };
  });
  const uses = images.map(() => 0);
  for (const texture of document.textures || []) {
    const source = texture.extensions?.EXT_texture_webp?.source ?? texture.source;
    if (!Number.isInteger(source) || !images[source]) throw invalid();
    uses[source]++;
  }
  // Include CPU pixels, GPU pixels and mipmaps for every texture allocation.
  for (let i = 0; i < images.length; i++) {
    const size = images[i].width * images[i].height * 12 * Math.max(1, uses[i]);
    if (decodedBytes + size > MAX_DECODED_BYTES)
      throw Error("This scan's textures use too much memory. Export smaller or fewer textures.");
    reserve(size);
  }
  return { document, images };
}

export function preflightOBJ(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\\\n/g, "");
  let sourceVertices = 0, vertices = 0, groups = 0;
  for (const match of normalized.matchAll(/[^\n]+/g)) {
    const line = match[0].trimStart();
    if (/^(?:o|g|usemtl|s)\s/.test(line) && ++groups > MAX_SCAN_OBJECTS) throw objectError();
    if (/^v\s/.test(line) && ++sourceVertices > MAX_SCAN_VERTICES) throw detailError();
    if (!["f", "l", "p"].includes(line[0])) continue;
    let count = 0;
    for (const token of line.slice(1).matchAll(/\S+/g)) {
      count++;
      if (count > MAX_SCAN_VERTICES) throw detailError();
    }
    vertices += line[0] === "f" ? Math.max(0, count - 2) * 3
      : line[0] === "l" ? Math.max(0, count - 1) * 2 : count;
    if (vertices > MAX_SCAN_VERTICES) throw detailError();
  }
  return normalized;
}
