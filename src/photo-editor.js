export const MAX_PHOTO_LENGTH = 180_000;

export async function readPhoto(source) {
  const isFile = typeof source !== "string";
  if (isFile && !["image/jpeg", "image/png", "image/webp"].includes(source.type))
    throw Error("Choose a JPG, PNG, or WebP image.");
  if (isFile && source.size > 10_000_000) throw Error("Choose an image smaller than 10 MB.");
  const url = isFile ? URL.createObjectURL(source) : source;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw Error("This image could not be read. Try another JPG, PNG, or WebP.");
  } finally {
    if (isFile) URL.revokeObjectURL(url);
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// A landscape crop matches the artwork used on room and container cards.
export function photoCrop(width, height) {
  const cropWidth = Math.min(width, height * 2);
  const cropHeight = cropWidth / 2;
  return {
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight,
  };
}

// Work in source-image pixels so resizing the editor never changes the crop.
export function adjustPhotoCrop(rect, handle, dx, dy, width, height, minimum = {}) {
  if (handle === "move") return {
    ...rect,
    x: clamp(rect.x + dx, 0, width - rect.width),
    y: clamp(rect.y + dy, 0, height - rect.height),
  };
  const minWidth = Math.min(rect.width, Math.max(1, width * .05, minimum.width || 0));
  const minHeight = Math.min(rect.height, Math.max(1, height * .05, minimum.height || 0));
  let left = rect.x, top = rect.y, right = left + rect.width, bottom = top + rect.height;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes("e")) right = clamp(right + dx, left + minWidth, width);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + minHeight, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function encodePhoto(image, crop = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }) {
  const scale = Math.min(1, 800 / Math.max(crop.width, crop.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  for (const quality of [.8, .65, .45, .25]) {
    const result = canvas.toDataURL("image/jpeg", quality);
    if (result.length <= MAX_PHOTO_LENGTH) return result;
  }
  throw Error("This image is too detailed. Try a smaller image.");
}

export function photoEditorFields() {
  return `<div class="photo-editor" data-photo-editor hidden>
    <p class="photo-editor-title">Make it fit your space.</p>
    <p class="modal-description" id="photo-crop-help">Drag the corners or edges to crop. Drag inside the box to move it. You can also focus the box or a handle and use arrow keys; hold Shift for larger steps.</p>
    <div class="photo-crop-stage" data-photo-stage>
      <canvas class="photo-crop-preview" data-photo-canvas role="img" aria-label="Original photo"></canvas>
      <div class="photo-crop-shade" aria-hidden="true"><span data-photo-shade></span></div>
      <div class="photo-crop-selection" data-photo-selection tabindex="0" role="group" aria-label="Crop selection" aria-describedby="photo-crop-help">
        <span class="photo-crop-grid" aria-hidden="true"></span>
        ${[["nw", "top left corner"], ["n", "top edge"], ["ne", "top right corner"], ["e", "right edge"], ["se", "bottom right corner"], ["s", "bottom edge"], ["sw", "bottom left corner"], ["w", "left edge"]].map(([handle, label]) => `<button type="button" class="photo-crop-handle" data-crop-handle="${handle}" aria-label="Resize ${label}" aria-describedby="photo-crop-help"></button>`).join("")}
      </div>
    </div>
    <output class="photo-crop-size" data-photo-size aria-live="off"></output>
    <div class="photo-editor-actions"><button type="button" class="text-button" data-photo-reset>Reset crop</button><button type="button" class="secondary" data-photo-cancel>Cancel crop</button><button type="button" class="primary" data-photo-apply>Use photo</button></div>
  </div>`;
}

export function bindPhotoEditor(editor, image, initial = {}) {
  const width = image.naturalWidth, height = image.naturalHeight;
  let rect = { ...photoCrop(width, height), ...initial };
  const canvas = editor.querySelector("[data-photo-canvas]");
  const stage = editor.querySelector("[data-photo-stage]");
  const selection = editor.querySelector("[data-photo-selection]");
  const shade = editor.querySelector("[data-photo-shade]");
  const scale = Math.min(1, 800 / width, 600 / height);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  stage.style.aspectRatio = `${width} / ${height}`;
  stage.style.width = `min(100%, ${320 * width / height}px)`;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const refresh = () => {
    for (const element of [selection, shade]) Object.assign(element.style, {
      left: `${rect.x / width * 100}%`, top: `${rect.y / height * 100}%`,
      width: `${rect.width / width * 100}%`, height: `${rect.height / height * 100}%`,
    });
    editor.querySelector("[data-photo-size]").value = `Crop: ${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
  };
  editor.querySelector("[data-photo-reset]").onclick = () => {
    rect = photoCrop(width, height);
    refresh();
  };
  let drag = null;
  const minimum = (bounds) => ({ width: 44 * width / bounds.width, height: 44 * height / bounds.height });
  selection.onpointerdown = (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const handle = event.target.closest("[data-crop-handle]");
    (handle || selection).focus({ preventScroll: true });
    selection.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, handle: handle?.dataset.cropHandle || "move", x: event.clientX, y: event.clientY, rect: { ...rect }, bounds: stage.getBoundingClientRect() };
    selection.classList.add("is-dragging");
  };
  selection.onpointermove = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    rect = adjustPhotoCrop(drag.rect, drag.handle,
      (event.clientX - drag.x) * width / drag.bounds.width,
      (event.clientY - drag.y) * height / drag.bounds.height, width, height, minimum(drag.bounds));
    refresh();
  };
  selection.onpointerup = selection.onpointercancel = selection.onlostpointercapture = () => {
    drag = null;
    selection.classList.remove("is-dragging");
  };
  selection.onkeydown = (event) => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? .1 : .01;
    rect = adjustPhotoCrop(rect, event.target.dataset.cropHandle || "move", direction[0] * width * step, direction[1] * height * step, width, height, minimum(stage.getBoundingClientRect()));
    refresh();
  };
  refresh();
  return { image, crop: () => ({ ...rect }), framing: () => ({ ...rect }) };
}
