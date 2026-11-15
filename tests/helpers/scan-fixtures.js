export function makeGLB(document, binary = new Uint8Array()) {
  const json = Buffer.from(JSON.stringify(document));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const binarySize = Math.ceil(binary.byteLength / 4) * 4;
  const output = Buffer.alloc(20 + jsonSize + (binarySize ? 8 + binarySize : 0), 32);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonSize, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  if (binarySize) {
    output.writeUInt32LE(binarySize, 20 + jsonSize);
    output.writeUInt32LE(0x004e4942, 24 + jsonSize);
    output.set(binary, 28 + jsonSize);
  }
  return output;
}

export function triangleGLB({ indices, triangles = 1, instances } = {}) {
  const vertices = triangles * 3;
  indices ||= Array.from({ length: vertices }, (_, index) => index);
  const positionsSize = vertices * 12;
  const translationsOffset = Math.ceil((positionsSize + indices.length * 2) / 4) * 4;
  const binary = new Uint8Array(translationsOffset + (instances || 0) * 12);
  const positions = new Float32Array(binary.buffer, 0, vertices * 3);
  for (let triangle = 0; triangle < triangles; triangle++)
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], triangle * 9);
  new Uint16Array(binary.buffer, positionsSize, indices.length).set(indices);
  const document = {
    asset: { version: "2.0" }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteLength: positionsSize },
      { buffer: 0, byteOffset: positionsSize, byteLength: indices.length * 2 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
  };
  if (instances) {
    document.extensionsUsed = ["EXT_mesh_gpu_instancing"];
    document.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } };
    document.bufferViews.push({ buffer: 0, byteOffset: translationsOffset, byteLength: instances * 12 });
    document.accessors.push({ bufferView: 2, componentType: 5126, count: instances, type: "VEC3" });
  }
  return makeGLB(document, binary);
}
