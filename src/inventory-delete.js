import { createLocationTree } from "./location-tree.js";
import { pruneScanLinks } from "./scan-data.js";

export function removeItem(state, id) {
  if (!state.items.some((item) => item.id === id))
    throw Error("This item no longer exists.");
  return pruneScanLinks({ ...state, items: state.items.filter((item) => item.id !== id) });
}

// Build and validate the entire move before saving anything. Unspecified nested
// contents stay in their containers; only direct contents need a destination.
export function removeLocation(state, id, {
  mode = "move", destinationId = null,
  containerDestinations = new Map(), itemDestinations = new Map(),
} = {}) {
  const tree = createLocationTree(state.locations);
  if (!tree.byId.has(id)) throw Error("This room or container no longer exists.");
  const inside = new Set(tree.order.filter((location) => tree.contains(id, location.id)).map((location) => location.id));
  if (mode === "delete") return pruneScanLinks({
    ...state,
    locations: state.locations.filter((location) => !inside.has(location.id)),
    items: state.items.filter((item) => !inside.has(item.locationId)),
  });
  if (mode !== "move") throw Error("Choose whether to move the contents or delete everything.");

  const surviving = new Set(state.locations.filter((location) => location.id !== id).map((location) => location.id));
  const itemById = new Map(state.items.map((item) => [item.id, item]));
  for (const source of containerDestinations.keys()) {
    if (source === id || !inside.has(source)) throw Error("Choose a container inside the space being deleted.");
  }
  for (const source of itemDestinations.keys()) {
    if (!inside.has(itemById.get(source)?.locationId)) throw Error("Choose an item inside the space being deleted.");
  }
  const checkDestination = (destination) => {
    if (!surviving.has(destination)) throw Error("Choose an existing destination outside the space being deleted.");
    return destination;
  };
  const moved = new Set();
  const locations = state.locations.filter((location) => location.id !== id).map((location) => {
    if (!inside.has(location.id)) return location;
    const parentId = checkDestination(containerDestinations.has(location.id)
      ? containerDestinations.get(location.id)
      : location.parentId === id ? destinationId : location.parentId);
    if (parentId === location.parentId) return location;
    moved.add(location.id);
    return { ...location, parentId };
  });
  if (createLocationTree(locations).order.length !== locations.length)
    throw Error("Containers cannot be moved into themselves or form a cycle. Choose another destination.");

  const movedItems = new Set();
  const items = state.items.map((item) => {
    if (!inside.has(item.locationId)) return item;
    const locationId = checkDestination(itemDestinations.has(item.id)
      ? itemDestinations.get(item.id)
      : item.locationId === id ? destinationId : item.locationId);
    if (locationId === item.locationId) return item;
    movedItems.add(item.id);
    return { ...item, locationId };
  });

  // A moved subtree keeps its internal scan pins. Pins from outside it describe
  // the old position and must be cleared, including independently moved branches.
  const moveGroup = new Map();
  for (const location of tree.order)
    moveGroup.set(location.id, moved.has(location.id) ? location.id : moveGroup.get(location.parentId));
  const scans = new Map((state.scans || []).map((scan) => [scan.id, scan]));
  const markers = (state.markers || []).filter((marker) => {
    if (marker.kind === "item" && movedItems.has(marker.targetId)) return false;
    const target = marker.kind === "item" ? itemById.get(marker.targetId)?.locationId : marker.targetId;
    const group = moveGroup.get(target);
    return !group || group === moveGroup.get(scans.get(marker.scanId)?.locationId);
  });
  return pruneScanLinks({ ...state, locations, items, markers });
}
