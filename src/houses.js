import { createLocationTree } from "./location-tree.js";

export const DEFAULT_HOUSE_ID = "my-home";
export const MAX_HOUSE_NAME_LENGTH = 80;

export function validHouses(inventory) {
  if (inventory.houses === undefined)
    return inventory.locations.every((location) => location.houseId === undefined);
  if (!Array.isArray(inventory.houses) || !inventory.houses.length) return false;
  const ids = new Set();
  for (const house of inventory.houses) {
    if (!house || typeof house.id !== "string" || !house.id.trim() ||
        ids.has(house.id) || typeof house.name !== "string" ||
        !house.name.trim() || house.name.length > MAX_HOUSE_NAME_LENGTH) return false;
    ids.add(house.id);
  }
  return inventory.locations.every((location) => location.parentId === null
    ? ids.has(location.houseId)
    : location.houseId === undefined);
}

export function withHouses(inventory) {
  if (inventory.houses !== undefined) return inventory;
  return {
    ...inventory,
    houses: [{ id: DEFAULT_HOUSE_ID, name: "My home" }],
    locations: inventory.locations.map((location) => location.parentId === null
      ? { ...location, houseId: DEFAULT_HOUSE_ID }
      : location),
  };
}

export function inventoryForHouse(inventory, houseId) {
  const normalized = withHouses(inventory);
  if (!normalized.houses.some((house) => house.id === houseId))
    throw Error("This house no longer exists. Choose another house.");
  const members = new Set();
  for (const location of createLocationTree(normalized.locations).order) {
    if (location.parentId === null ? location.houseId === houseId : members.has(location.parentId))
      members.add(location.id);
  }
  const scans = (normalized.scans || []).filter((scan) => members.has(scan.locationId));
  const scanIds = new Set(scans.map((scan) => scan.id));
  return {
    ...normalized,
    locations: normalized.locations.filter((location) => members.has(location.id)),
    items: normalized.items.filter((item) => members.has(item.locationId)),
    scans,
    markers: (normalized.markers || []).filter((marker) => scanIds.has(marker.scanId)),
  };
}

export function replaceHouseInventory(inventory, houseId, next) {
  const normalized = withHouses(inventory);
  const previous = inventoryForHouse(normalized, houseId);
  const locationIds = new Set(previous.locations.map((location) => location.id));
  const scanIds = new Set(previous.scans.map((scan) => scan.id));
  return {
    ...normalized,
    locations: [
      ...normalized.locations.filter((location) => !locationIds.has(location.id)),
      ...next.locations.map((location) => location.parentId === null
        ? { ...location, houseId }
        : location),
    ],
    items: [
      ...normalized.items.filter((item) => !locationIds.has(item.locationId)),
      ...next.items,
    ],
    scans: [
      ...(normalized.scans || []).filter((scan) => !locationIds.has(scan.locationId)),
      ...(next.scans || []),
    ],
    markers: [
      ...(normalized.markers || []).filter((marker) => !scanIds.has(marker.scanId)),
      ...(next.markers || []),
    ],
  };
}

export function addHouse(inventory, name, id = crypto.randomUUID()) {
  const normalized = withHouses(inventory);
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_HOUSE_NAME_LENGTH)
    throw Error(`Give your house a name of 1–${MAX_HOUSE_NAME_LENGTH} characters.`);
  if (normalized.houses.some((house) => house.name.toLowerCase() === trimmed.toLowerCase()))
    throw Error("A house with that name already exists. Choose a different name.");
  if (typeof id !== "string" || !id.trim() || normalized.houses.some((house) => house.id === id))
    throw Error("Could not create this house. Please try again.");
  return { ...normalized, houses: [...normalized.houses, { id, name: trimmed }] };
}
