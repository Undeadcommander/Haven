import { validLocationImage, validItemImage } from "./location-images.js";
import { validScanData } from "./scan-data.js";
import { createLocationTree } from "./location-tree.js";
export function initialState() {
  return {
    version: 1,
    locations: [
      {
        id: "living-room",
        parentId: null,
        name: "Living room",
        description:
          "The heart of the home. Keep track of the little things that make it yours.",
        color: "sage",
      },
    ],
    items: [],
  };
}
export function validState(s) {
  if (
    !s ||
    s.version !== 1 ||
    !Array.isArray(s.locations) ||
    !Array.isArray(s.items)
  )
    return false;
  if (
    !s.locations.every((l) => l && typeof l === "object") ||
    !s.items.every((i) => i && typeof i === "object")
  )
    return false;
  const ids = new Set(s.locations.map((l) => l.id));
  if (ids.size !== s.locations.length) return false;
  for (const l of s.locations) {
    if (
      !validLocationImage(l.image) ||
      typeof l.id !== "string" ||
      typeof l.name !== "string" ||
      typeof l.description !== "string" ||
      (l.parentId !== null && typeof l.parentId !== "string") ||
      !["sage", "sand", "blue", "rose"].includes(l.color)
    )
      return false;
  }
  // Cycles and orphan chains cannot be reached from any root.
  if (createLocationTree(s.locations).order.length !== s.locations.length) return false;
  return (
    validScanData(s) &&
    new Set(s.items.map((i) => i.id)).size === s.items.length &&
    s.items.every(
      (i) =>
        validItemImage(i.image) &&
        typeof i.id === "string" &&
        typeof i.name === "string" &&
        typeof i.notes === "string" &&
        (i.color === undefined || ["sage", "sand", "blue", "rose"].includes(i.color)) &&
        ids.has(i.locationId),
    )
  );
}
export function createIndex(state) {
  const { byId, children, order, contains } = createLocationTree(state.locations);
  const items = new Map(), itemById = new Map();
  for (const i of state.items) {
    itemById.set(i.id, i);
    if (!items.has(i.locationId)) items.set(i.locationId, []);
    items.get(i.locationId).push(i);
  }
  const paths = new Map();
  function path(id) {
    if (paths.has(id)) return paths.get(id);
    const parts = [];
    let cur = byId.get(id);
    while (cur && !paths.has(cur.id)) {
      parts.push(cur.name);
      cur = byId.get(cur.parentId);
    }
    const prefix = cur ? paths.get(cur.id) : "";
    const suffix = parts.reverse().join(" / ");
    const value = cur ? `${prefix} / ${suffix}` : suffix;
    paths.set(id, value);
    return value;
  }
  const search = state.items.map((i) => ({
    id: i.id, name: i.name, locationId: i.locationId,
    path: path(i.locationId),
    text: `${i.name} ${i.notes} ${path(i.locationId)}`.toLowerCase(),
  }));
  const locationSearch = state.locations.map((l) => ({
    id: l.id, name: l.name, text: `${l.name} ${l.description}`.toLowerCase(),
  }));
  const summaries = new Map();
  for (let n = order.length - 1; n >= 0; n--) {
    const l = order[n],
      direct = items.get(l.id) || [];
    let count = direct.length;
    const preview = direct.slice(0, 3);
    for (const child of children.get(l.id) || []) {
      const summary = summaries.get(child.id);
      count += summary.count;
      preview.push(...summary.preview.slice(0, 3 - preview.length));
    }
    summaries.set(l.id, { count, preview });
  }
  const scanByLocation = new Map((state.scans || []).map((scan) => [scan.locationId, scan]));
  const markersByScan = new Map();
  for (const marker of state.markers || []) {
    if (!markersByScan.has(marker.scanId)) markersByScan.set(marker.scanId, []);
    markersByScan.get(marker.scanId).push(marker);
  }
  let destinations;
  const sortedLocations = () => destinations ||= state.locations
    .map((l) => ({ id: l.id, path: path(l.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { byId, children, items, itemById, path, search, locationSearch, summaries,
    contains, scanByLocation, markersByScan, sortedLocations };
}

export function searchInventory(index, query, limit = 30) {
  const terms = query.trim().toLowerCase().split(/\s+/);
  const results = [];
  let total = 0;
  if (!query.trim()) return { total, results };
  for (const item of index.search) {
    if (!terms.every((term) => item.text.includes(term))) continue;
    total++;
    if (results.length < limit) results.push({
      id: item.locationId, item: item.id, name: item.name, path: item.path, type: "box",
    });
  }
  for (const location of index.locationSearch) {
    if (!terms.every((term) => location.text.includes(term))) continue;
    total++;
    if (results.length < limit) results.push({
      id: location.id, name: location.name, path: index.path(location.id), type: "folder",
    });
  }
  return { total, results };
}
export function descendants(index, id) {
  const found = new Set(),
    stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    found.add(cur);
    for (const c of index.children.get(cur) || []) stack.push(c.id);
  }
  return found;
}
