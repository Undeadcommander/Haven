import { roomScene } from "./room-scenes.js";
import { MAX_PHOTO_LENGTH, readPhoto, encodePhoto, photoEditorFields, bindPhotoEditor } from "./photo-editor.js";

export const imageChoices = [
  ["living", "Living room"], ["bedroom", "Bedroom"], ["kitchen", "Kitchen"],
  ["office", "Office"], ["garage", "Garage"], ["bathroom", "Bathroom"],
  ["box", "Box"], ["drawers", "Drawers"],
  ["shelf", "Shelves"], ["wardrobe", "Wardrobe"],
];

export const itemImageChoices = [
  ["keys", "Keys"], ["book", "Book"], ["phone", "Phone"], ["laptop", "Laptop"],
  ["headphones", "Headphones"], ["camera", "Camera"], ["tools", "Tools"],
  ["clothing", "Clothing"], ["shoes", "Shoes"], ["documents", "Documents"],
  ["mug", "Mug"], ["cables", "Cables"],
];
const itemDrawings = {
  keys: '<circle cx="8" cy="8" r="5"/><circle cx="7" cy="7" r="1"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>',
  book: '<path d="M3 4q5-2 9 1 4-3 9-1v16q-5-2-9 1-4-3-9-1ZM12 5v16M6 8h3m6 0h3M6 12h3m6 0h3"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 5h4M10 19h4"/>',
  laptop: '<rect x="4" y="3" width="16" height="13" rx="1"/><path d="m4 16-3 5h22l-3-5M9 18h6"/>',
  headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="5" height="9" rx="2"/><rect x="16" y="12" width="5" height="9" rx="2"/>',
  camera: '<path d="M2 7h5l2-3h6l2 3h5v14H2Z"/><circle cx="12" cy="14" r="4"/><path d="M18 10h1"/>',
  tools: '<path d="m4 3 5 5-2 2-5-5v6l5 2 9 9 5-5-9-9-2-6ZM4 20l5-5m6-10 4-4 3 3-4 4"/>',
  clothing: '<path d="m8 3-6 4 3 6 3-2v11h8V11l3 2 3-6-6-4q-4 5-8 0Z"/>',
  shoes: '<path d="M3 5h6l2 8 10 4v4H2V10Zm8 8-3 2m6-1-3 2m6-1-3 2M2 18h9"/>',
  documents: '<path d="M6 2h10l5 5v12H6ZM16 2v5h5M3 6v16h14M9 11h9m-9 4h7"/>',
  mug: '<path d="M3 7h13v11a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4ZM16 8h3a3 3 0 0 1 0 6h-3M6 2v2m4-3v3m4-2v2"/>',
  cables: '<path d="M4 2v4m4-4v4M3 6h6v5H3Zm3 5v5a5 5 0 0 0 10 0v-3M14 7h6v6h-6Zm1-4h4v4"/>',
};

const drawings = {
  box: '<path d="m85 65 95-35 95 35v70l-95 30-95-30zm0 0 95 35 95-35M180 100v65M130 48l95 35v27"/>',
  drawers: '<rect x="95" y="25" width="170" height="125" rx="5"/><path d="M95 65h170M95 105h170M165 45h30m-30 40h30m-30 40h30M110 150v10m140-10v10"/>',
  shelf: '<path d="M85 20v140M275 20v140M85 70h190M85 140h190M105 70V30h25v40m10 0V25h20v45m10 0-5-35 20-3 5 38M110 140v-45h65v45m30 0v-30h50v30"/>',
  wardrobe: '<rect x="100" y="20" width="160" height="135" rx="5"/><path d="M180 20v135M165 80v20m30-20v20M115 155v7m130-7v7"/>',
};

export function validLocationImage(value) {
  return validImage(value, imageChoices);
}

export function validItemImage(value) {
  return validImage(value, itemImageChoices);
}

function validImage(value, choices) {
  return value === undefined || value === null || choices.some(([id]) => id === value)
    || (typeof value === "string" && value.length <= MAX_PHOTO_LENGTH
      && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value));
}

export function itemImage(value) {
  if (!validItemImage(value) || !value) return "";
  if (value.startsWith("data:")) return locationImage(value);
  return `<svg class="item-art" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${itemDrawings[value]}</svg>`;
}

export function locationImage(value) {
  if (!validLocationImage(value) || !value) return "";
  if (value.startsWith("data:")) return `<img class="location-photo" src="${value}" alt="" draggable="false">`;
  const scene = roomScene(value);
  if (scene) return scene;
  return `<svg class="room-art" viewBox="0 0 360 180" aria-hidden="true" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">${drawings[value]}</svg>`;
}

export async function prepareLocationPhoto(file) {
  return encodePhoto(await readPhoto(file));
}

export function imageFields(kind) {
  const containerPresets = new Set(["box", "drawers", "shelf", "wardrobe"]);
  const choices = kind === "item" ? itemImageChoices : imageChoices.filter(([id]) => kind ? !containerPresets.has(id) : containerPresets.has(id));
  const renderImage = kind === "item" ? itemImage : locationImage;
  const defaultChoice = kind === true ? "" : `<label class="image-option"><input type="radio" name="image-choice" value="default"><span>Default</span></label>`;
  return `<fieldset class="location-image-picker" ${kind === "item" ? "" : "data-crop-enabled"}><legend>Image</legend>
    <div data-image-choices><div class="location-image-preview" data-image-preview></div>
    <button type="button" class="text-button photo-adjust" data-photo-adjust hidden>Adjust photo</button>
    <div class="image-options">${defaultChoice}${choices.map(([id, name]) => `<label class="image-option"><input type="radio" name="image-choice" value="${id}">${renderImage(id)}<span>${name}</span></label>`).join("")}<label class="image-option" data-custom-choice hidden><input type="radio" name="image-choice" value="custom"><span>Your photo</span></label></div>
    <label>Upload your own image<input type="file" data-image-upload accept="image/jpeg,image/png,image/webp" aria-describedby="image-help"></label>
    <p id="image-help" class="modal-description">JPG, PNG, or WebP, up to 10 MB. ${kind === "item" ? "Photos are resized to save space." : "Drag the crop handles after choosing your photo."}</p></div>
    ${kind === "item" ? "" : photoEditorFields()}<p data-image-status role="status"></p></fieldset>`;
}

export function bindImagePicker(dialog, initial, fallback, renderImage = locationImage, defaultSelection = null) {
  let selected = initial ?? defaultSelection, custom = initial?.startsWith("data:") ? initial : null;
  let pending = false, disposed = false, cropSession = null, customSource = null;
  const picker = dialog.querySelector(".location-image-picker");
  const preview = picker.querySelector("[data-image-preview]");
  const status = picker.querySelector("[data-image-status]");
  const submit = dialog.querySelector('[type="submit"]');
  const editor = picker.querySelector("[data-photo-editor]");
  const adjust = picker.querySelector("[data-photo-adjust]");
  const choices = picker.querySelector("[data-image-choices]");
  const colorPicker = dialog.querySelector(".color-picker");
  const colors = [...dialog.querySelectorAll('input[name="color"]')];
  const refreshColor = () => {
    picker.classList.remove(...colors.map((input) => input.value));
    picker.classList.add(colors.find((input) => input.checked)?.value || "sage");
  };
  colors.forEach((input) => input.addEventListener("change", refreshColor));
  refreshColor();
  const refresh = () => {
    preview.innerHTML = renderImage(selected) || fallback;
    picker.querySelector("[data-custom-choice]").hidden = !custom;
    const isPhoto = !!selected?.startsWith("data:");
    adjust.hidden = !editor || !isPhoto;
    if (colorPicker) {
      colorPicker.disabled = isPhoto || pending;
      colorPicker.querySelector("[data-photo-color-note]").hidden = !colorPicker.disabled;
    }
    const choice = selected === custom && custom ? "custom" : selected || "default";
    picker.querySelectorAll('[name="image-choice"]').forEach((input) => { input.checked = input.value === choice; });
    submit.disabled = pending;
  };
  const active = () => !disposed && picker.isConnected && dialog.open;
  const finishCrop = () => {
    cropSession = null;
    pending = false;
    editor.hidden = true;
    choices.hidden = false;
    refresh();
  };
  const startCrop = (image, framing) => {
    cropSession = bindPhotoEditor(editor, image, framing);
    choices.hidden = true;
    editor.hidden = false;
    picker.disabled = false;
    status.textContent = "Adjust your photo, then choose Use photo.";
    refresh();
    editor.querySelector("[data-photo-selection]").focus();
  };
  if (editor) {
    editor.querySelector("[data-photo-apply]").onclick = () => {
      try {
        const image = encodePhoto(cropSession.image, cropSession.crop());
        customSource = { image: cropSession.image, framing: cropSession.framing() };
        selected = custom = image;
        finishCrop();
        status.textContent = "Photo ready. Save to apply your changes.";
        adjust.focus({ preventScroll: true });
      } catch (error) {
        status.textContent = error.message;
      }
    };
    editor.querySelector("[data-photo-cancel]").onclick = () => {
      finishCrop();
      status.textContent = "Crop canceled. Your image is unchanged.";
      (adjust.hidden ? picker.querySelector("[data-image-upload]") : adjust).focus({ preventScroll: true });
    };
    adjust.onclick = async () => {
      pending = true;
      picker.disabled = true;
      status.textContent = "Preparing your photo...";
      refresh();
      try {
        const image = customSource?.image || await readPhoto(custom);
        if (active()) startCrop(image, customSource?.framing);
      } catch (error) {
        if (active()) {
          pending = false;
          status.textContent = error.message;
        }
      } finally {
        picker.disabled = false;
        if (active()) refresh();
      }
    };
  }
  picker.querySelectorAll('[name="image-choice"]').forEach((input) => {
    input.onchange = () => {
      selected = input.value === "default" ? null : input.value === "custom" ? custom : input.value;
      status.textContent = "";
      refresh();
    };
  });
  picker.querySelector("[data-image-upload]").onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    pending = true;
    picker.disabled = true;
    status.textContent = "Preparing your photo...";
    refresh();
    try {
      const image = await readPhoto(file);
      if (!active()) return;
      if (editor) startCrop(image);
      else {
        selected = custom = encodePhoto(image);
        pending = false;
        status.textContent = "Photo ready. Save to apply your changes.";
      }
    } catch (error) {
      if (active()) {
        pending = false;
        status.textContent = error.message;
      }
    } finally {
      picker.disabled = false;
      event.target.value = "";
      if (active()) refresh();
    }
  };
  dialog.addEventListener("close", () => {
    disposed = true;
    cropSession = customSource = null;
  }, { once: true });
  refresh();
  return () => {
    if (pending) throw Error("Finish or cancel your photo crop before saving.");
    return selected;
  };
}
