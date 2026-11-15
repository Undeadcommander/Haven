const invalidImage = () => Error("A scan texture is invalid or uses an unsupported image format. Export PNG, JPEG, or WebP textures.");

export function decodeDataURI(uri) {
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match) throw Error("Export a self-contained GLB with embedded textures and buffers. External scan resources are not loaded.");
  if (match[2].length > 40_000_000) throw Error("An embedded scan resource exceeds the 30 MB limit.");
  const binary = atob(match[2]), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mimeType: match[1] };
}

// Read dimensions before invoking a browser decoder, which may allocate the
// entire uncompressed image even for a very small compressed file.
export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 &&
      view.getUint32(4) === 0x0d0a1a0a && text(12, 4) === "IHDR" && view.getUint32(8) === 13)
    return { width: view.getUint32(16), height: view.getUint32(20), mimeType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalidImage();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3), mimeType: "image/jpeg" };
      offset += length;
    }
  }
  if (bytes.length >= 30 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    const type = text(12, 4), data = 20;
    if (type === "VP8X" && !(bytes[data] & 2)) {
      const uint24 = (offset) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
      return { width: uint24(data + 4) + 1, height: uint24(data + 7) + 1, mimeType: "image/webp" };
    }
    if (type === "VP8 " && text(data + 3, 3) === "\x9d\x01\x2a")
      return { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff, mimeType: "image/webp" };
    if (type === "VP8L" && bytes[data] === 0x2f)
      return { width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
        height: 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10), mimeType: "image/webp" };
  }
  throw invalidImage();
}

export async function decodeScanImages(sources) {
  const images = [];
  try {
    for (const source of sources) {
      const blob = new Blob([source.bytes], { type: source.mimeType });
      let image;
      if (typeof createImageBitmap === "function") image = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      else {
        const url = URL.createObjectURL(blob);
        try {
          image = await new Promise((resolve, reject) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => reject(invalidImage());
            element.src = url;
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      images.push(image);
      if ((image.width || image.naturalWidth) !== source.width || (image.height || image.naturalHeight) !== source.height)
        throw invalidImage();
    }
    return images;
  } catch {
    for (const image of images) image.close?.();
    throw Error("A scan texture could not be decoded. Export a GLB with valid embedded PNG, JPEG, or WebP textures. The existing scan has not changed.");
  }
}
