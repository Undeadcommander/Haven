import { createLocationTree } from "./location-tree.js";
import { removeLocation } from "./inventory-delete.js";

export const DEFAULT_HOUSE_ID = "my-home";
export const MAX_HOUSE_NAME_LENGTH = 80;
export const LAST_HOUSE_DELETE_MESSAGE = "Create another house before deleting your last house.";

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

function houseName(houses, name, excludedId) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_HOUSE_NAME_LENGTH)
    throw Error(`Give your house a name of 1–${MAX_HOUSE_NAME_LENGTH} characters.`);
  if (houses.some((house) => house.id !== excludedId && house.name.toLowerCase() === trimmed.toLowerCase()))
    throw Error("A house with that name already exists. Choose a different name.");
  return trimmed;
}

export function addHouse(inventory, name, id = crypto.randomUUID()) {
  const normalized = withHouses(inventory);
  const trimmed = houseName(normalized.houses, name);
  if (typeof id !== "string" || !id.trim() || normalized.houses.some((house) => house.id === id))
    throw Error("Could not create this house. Please try again.");
  return { ...normalized, houses: [...normalized.houses, { id, name: trimmed }] };
}

export function renameHouse(inventory, id, name) {
  const normalized = withHouses(inventory);
  if (!normalized.houses.some((house) => house.id === id))
    throw Error("This house no longer exists. Choose another house.");
  const trimmed = houseName(normalized.houses, name, id);
  return {
    ...normalized,
    houses: normalized.houses.map((house) => house.id === id ? { ...house, name: trimmed } : house),
  };
}

export function removeHouse(inventory, id, {
  mode = "move", destinationHouseId = null,
  roomDestinations = new Map(), containerDestinations = new Map(), itemDestinations = new Map(),
} = {}) {
  const normalized = withHouses(inventory);
  if (!normalized.houses.some((house) => house.id === id))
    throw Error("This house no longer exists. Choose another house.");
  if (normalized.houses.length < 2) throw Error(LAST_HOUSE_DELETE_MESSAGE);
  if (mode !== "move" && mode !== "delete")
    throw Error("Choose whether to move the contents or delete everything.");

  // Symbols cannot collide with any persisted ID. Treat houses as temporary
  // locations so bulk/separate moves share the location deletion invariants.
  const roots = new Map(normalized.houses.map((house) => [house.id, Symbol(house.id)]));
  const rootHouses = new Map([...roots].map(([houseId, root]) => [root, houseId]));
  const locations = new Map(normalized.locations.map((location) => [location.id, location]));
  const rooms = new Set(normalized.locations
    .filter((location) => location.parentId === null && location.houseId === id)
    .map((location) => location.id));
  const assignments = new Map();
  const houseDestination = (houseId) => {
    if (houseId === id || !roots.has(houseId))
      throw Error("Choose an existing destination house other than the house being deleted.");
    return roots.get(houseId);
  };
  if (mode === "move") {
    if (destinationHouseId !== null) houseDestination(destinationHouseId);
    for (const [roomId, houseId] of roomDestinations) {
      if (!rooms.has(roomId)) throw Error("Choose a room inside the house being deleted.");
      assignments.set(roomId, houseDestination(houseId));
    }
    for (const [containerId, destination] of containerDestinations) {
      if (!locations.has(containerId) || locations.get(containerId).parentId === null)
        throw Error("Choose a container inside the house being deleted.");
      if (!locations.has(destination)) throw Error("Choose an existing destination room or container.");
      assignments.set(containerId, destination);
    }
    for (const destination of itemDestinations.values())
      if (!locations.has(destination)) throw Error("Choose an existing destination room or container.");
    for (const roomId of rooms)
      if (!assignments.has(roomId)) assignments.set(roomId, houseDestination(destinationHouseId));
  }

  const next = removeLocation({
    ...normalized,
    locations: [
      ...[...roots.values()].map((root) => ({ id: root, parentId: null })),
      ...normalized.locations.map((location) => {
        if (location.parentId !== null) return location;
        const { houseId, ...room } = location;
        return { ...room, parentId: roots.get(houseId) };
      }),
    ],
  }, roots.get(id), { mode, containerDestinations: assignments, itemDestinations });

  return {
    ...next,
    houses: normalized.houses.filter((house) => house.id !== id),
    locations: next.locations.filter((location) => !rootHouses.has(location.id)).map((location) => {
      if (!rootHouses.has(location.parentId)) return location;
      const houseId = rootHouses.get(location.parentId);
      const original = locations.get(location.id);
      return original.parentId === null && original.houseId === houseId
        ? original : { ...location, parentId: null, houseId };
    }),
  };
}
