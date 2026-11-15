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
export function photoCrop(width, height, { zoom = 1, x = .5, y = .5 } = {}) {
  const cropWidth = Math.min(width, height * 2) / clamp(zoom, 1, 3);
  const cropHeight = cropWidth / 2;
  return {
    x: (width - cropWidth) * clamp(x, 0, 1),
    y: (height - cropHeight) * clamp(y, 0, 1),
    width: cropWidth,
    height: cropHeight,
  };
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
    <p class="modal-description" id="photo-crop-help">Drag to frame your photo, or use the controls below. Arrow keys also move the photo.</p>
    <canvas class="photo-crop-preview" data-photo-canvas width="800" height="400" tabindex="0" role="img" aria-label="Photo crop preview" aria-describedby="photo-crop-help"></canvas>
    <label class="photo-control">Zoom <output data-photo-zoom>100%</output><input type="range" data-photo-control="zoom" aria-label="Zoom" min="1" max="3" step="0.01" value="1"></label>
    <label class="photo-control">Horizontal position<input type="range" data-photo-control="x" min="0" max="1" step="0.01" value="0.5"></label>
    <label class="photo-control">Vertical position<input type="range" data-photo-control="y" min="0" max="1" step="0.01" value="0.5"></label>
    <div class="photo-editor-actions"><button type="button" class="text-button" data-photo-reset>Reset crop</button><button type="button" class="secondary" data-photo-cancel>Cancel crop</button><button type="button" class="primary" data-photo-apply>Use photo</button></div>
  </div>`;
}

export function bindPhotoEditor(editor, image, initial = {}) {
  const framing = { zoom: 1, x: .5, y: .5, ...initial };
  const canvas = editor.querySelector("[data-photo-canvas]");
  const ctx = canvas.getContext("2d");
  const controls = [...editor.querySelectorAll("[data-photo-control]")];
  const crop = () => photoCrop(image.naturalWidth, image.naturalHeight, framing);
  const refresh = () => {
    const rect = crop();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    controls.forEach((control) => {
      const key = control.dataset.photoControl;
      control.value = framing[key];
      control.setAttribute("aria-valuetext", `${Math.round(framing[key] * 100)}%`);
      control.disabled = key === "x" ? image.naturalWidth - rect.width < .001
        : key === "y" ? image.naturalHeight - rect.height < .001 : false;
    });
    editor.querySelector("[data-photo-zoom]").value = `${Math.round(framing.zoom * 100)}%`;
  };
  controls.forEach((control) => {
    control.oninput = () => {
      framing[control.dataset.photoControl] = Number(control.value);
      refresh();
    };
  });
  editor.querySelector("[data-photo-reset]").onclick = () => {
    Object.assign(framing, { zoom: 1, x: .5, y: .5 });
    refresh();
  };
  let drag = null;
  canvas.onpointerdown = (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  canvas.onpointermove = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const rect = crop(), bounds = canvas.getBoundingClientRect();
    const spanX = image.naturalWidth - rect.width, spanY = image.naturalHeight - rect.height;
    if (spanX > 0) framing.x = clamp(framing.x - (event.clientX - drag.x) * rect.width / bounds.width / spanX, 0, 1);
    if (spanY > 0) framing.y = clamp(framing.y - (event.clientY - drag.y) * rect.height / bounds.height / spanY, 0, 1);
    drag.x = event.clientX;
    drag.y = event.clientY;
    refresh();
  };
  canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { drag = null; };
  canvas.onkeydown = (event) => {
    const direction = { ArrowLeft: ["x", 1], ArrowRight: ["x", -1], ArrowUp: ["y", 1], ArrowDown: ["y", -1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    framing[direction[0]] = clamp(framing[direction[0]] + direction[1] * (event.shiftKey ? .1 : .02), 0, 1);
    refresh();
  };
  refresh();
  return { image, crop, framing: () => ({ ...framing }) };
}
