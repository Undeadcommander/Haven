import { test } from "node:test";
import assert from "node:assert/strict";
import { removeHouse, withHouses, DEFAULT_HOUSE_ID } from "../src/houses.js";
import { initialState, validState, createIndex, searchInventory } from "../src/store.js";

const ids = (records) => records.map((record) => record.id);
const location = (state, id) => state.locations.find((record) => record.id === id);
const item = (state, id) => state.items.find((record) => record.id === id);

function fixture() {
  const state = {
    version: 1,
    houses: [
      { id: "home", name: "Home", extra: "preserved" },
      { id: "lake", name: "Lake" },
      { id: "cabin", name: "Cabin" },
    ],
    locations: [
      ["room", null, "home"], ["spare", null, "home"],
      ["cabinet", "room"], ["drawer", "cabinet"], ["box", "drawer"], ["shelf", "room"],
      ["lake-room", null, "lake"], ["closet", "lake-room"],
      ["cabin-room", null, "cabin"],
    ].map(([id, parentId, houseId]) => ({
      id, parentId, ...(houseId === undefined ? {} : { houseId }),
      name: id, description: `Description of ${id}`, color: "sage",
      image: "data:image/jpeg;base64,/9j/AA==",
    })),
    items: [
      ["lamp", "room"], ["book", "cabinet"], ["keys", "box"], ["vase", "shelf"],
      ["spare-item", "spare"], ["coat", "closet"], ["cabin-item", "cabin-room"],
    ].map(([id, locationId]) => ({
      id, locationId, name: id, notes: `Notes for ${id}`, color: "blue",
      image: "data:image/jpeg;base64,/9j/AA==",
    })),
    scans: ["room", "spare", "cabinet", "drawer", "shelf", "lake-room", "cabin-room"].map((locationId) => ({
      id: `scan-${locationId}`, locationId, assetId: `asset-${locationId}`, name: "scan.obj", format: "obj",
    })),
    markers: [
      ["room-cabinet", "room", "container", "cabinet"],
      ["room-shelf", "room", "container", "shelf"],
      ["room-keys", "room", "item", "keys"],
      ["room-lamp", "room", "item", "lamp"],
      ["cabinet-drawer", "cabinet", "container", "drawer"],
      ["cabinet-book", "cabinet", "item", "book"],
      ["cabinet-keys", "cabinet", "item", "keys"],
      ["drawer-box", "drawer", "container", "box"],
      ["drawer-keys", "drawer", "item", "keys"],
      ["shelf-vase", "shelf", "item", "vase"],
      ["spare-pin", "spare", "item", "spare-item"],
      ["lake-pin", "lake-room", "item", "coat"],
      ["cabin-pin", "cabin-room", "item", "cabin-item"],
    ].map(([id, scan, kind, targetId]) => ({ id, scanId: `scan-${scan}`, kind, targetId, position: [1, 2, 3] })),
    extra: { preserved: true },
  };
  assert.equal(validState(state), true);
  return state;
}

function assertValid(state) {
  assert.equal(validState(state), true);
  assert.equal(validState(JSON.parse(JSON.stringify(state))), true);
  for (const record of state.locations)
    if (record.parentId !== null) assert.equal(Object.hasOwn(record, "houseId"), false);
}

test("bulk house transfer preserves room IDs, nested contents, scans, pins, photos, and other houses", () => {
  const state = fixture(), before = structuredClone(state);
  const next = removeHouse(state, "home", { destinationHouseId: "lake" });
  assert.deepEqual(next, {
    ...state,
    houses: state.houses.filter((house) => house.id !== "home"),
    locations: state.locations.map((record) => record.houseId === "home" ? { ...record, houseId: "lake" } : record),
  });
  assert.deepEqual(state, before);
  assert.deepEqual(ids(next.locations), ids(state.locations));
  assert.deepEqual(next.items, state.items);
  assert.deepEqual(next.scans, state.scans);
  assert.deepEqual(next.markers, state.markers);
  assert.equal(location(next, "closet"), location(state, "closet"));
  assert.equal(next.houses[0], state.houses[1]);
  assert.equal(createIndex(next).path("box"), "room / cabinet / drawer / box");
  assert.equal(searchInventory(createIndex(next), "keys").total, 1);
  assertValid(next);
});

test("separate room, container, and item moves clear obsolete pins while keeping internal scans and pins", () => {
  const state = fixture(), before = structuredClone(state);
  const options = {
    roomDestinations: new Map([["room", "lake"], ["spare", "cabin"]]),
    containerDestinations: new Map([["cabinet", "closet"], ["drawer", "shelf"], ["shelf", "cabinet"]]),
    itemDestinations: new Map([["book", "drawer"], ["lamp", "closet"]]),
  };
  const assignments = structuredClone(options);
  const next = removeHouse(state, "home", options);
  assert.equal(location(next, "room").houseId, "lake");
  assert.equal(location(next, "spare").houseId, "cabin");
  assert.equal(location(next, "cabinet").parentId, "closet");
  assert.equal(location(next, "drawer").parentId, "shelf");
  assert.equal(location(next, "shelf").parentId, "cabinet");
  assert.equal(location(next, "box").parentId, "drawer");
  assert.equal(item(next, "book").locationId, "drawer");
  assert.equal(item(next, "lamp").locationId, "closet");
  assert.deepEqual(ids(next.markers), ["drawer-box", "drawer-keys", "shelf-vase", "spare-pin", "lake-pin", "cabin-pin"]);
  assert.deepEqual(next.scans, state.scans);
  assert.deepEqual(ids(next.items), ids(state.items));
  assert.deepEqual(next.items.map((record) => record.image), state.items.map((record) => record.image));
  assert.deepEqual(state, before);
  assert.deepEqual(options, assignments);
  assertValid(next);
});

test("room overrides replace a bulk destination and real source rooms/containers can receive separate contents", () => {
  const state = fixture();
  const next = removeHouse(state, "home", {
    destinationHouseId: "lake",
    roomDestinations: new Map([["spare", "cabin"]]),
    containerDestinations: new Map([["cabinet", "spare"]]),
    itemDestinations: new Map([["lamp", "cabinet"], ["vase", "room"]]),
  });
  assert.equal(location(next, "room").houseId, "lake");
  assert.equal(location(next, "spare").houseId, "cabin");
  assert.equal(location(next, "cabinet").parentId, "spare");
  assert.equal(item(next, "lamp").locationId, "cabinet");
  assert.equal(item(next, "vase").locationId, "room");
  assert.deepEqual(ids(next.markers), [
    "room-shelf", "cabinet-drawer", "cabinet-book", "cabinet-keys", "drawer-box", "drawer-keys",
    "spare-pin", "lake-pin", "cabin-pin",
  ]);
  assertValid(next);
});

test("validation uses final parent assignments and no-op assignments retain pins", () => {
  const state = fixture();
  const next = removeHouse(state, "home", {
    destinationHouseId: "lake",
    containerDestinations: new Map([["cabinet", "drawer"], ["drawer", "lake-room"], ["shelf", "room"]]),
    itemDestinations: new Map([["vase", "shelf"]]),
  });
  assert.equal(location(next, "cabinet").parentId, "drawer");
  assert.equal(location(next, "drawer").parentId, "lake-room");
  assert.ok(next.markers.some((marker) => marker.id === "shelf-vase"));
  assert.ok(next.markers.some((marker) => marker.id === "room-shelf"));
  assert.ok(!next.markers.some((marker) => marker.id === "cabinet-drawer"));
  assertValid(next);
});

test("house deletion cascades all source data and broken links while preserving unrelated house data", () => {
  const state = fixture(), before = structuredClone(state);
  const next = removeHouse(state, "home", { mode: "delete" });
  assert.deepEqual(next, {
    ...state,
    houses: state.houses.slice(1),
    locations: state.locations.filter((record) => ["lake-room", "closet", "cabin-room"].includes(record.id)),
    items: state.items.filter((record) => ["coat", "cabin-item"].includes(record.id)),
    scans: state.scans.filter((record) => ["scan-lake-room", "scan-cabin-room"].includes(record.id)),
    markers: state.markers.filter((record) => ["lake-pin", "cabin-pin"].includes(record.id)),
  });
  assert.deepEqual(state, before);
  assert.equal(searchInventory(createIndex(next), "keys").total, 0);
  assertValid(next);

  // Imported stale links must also be cleaned, including pins in surviving scans.
  const stale = structuredClone(state);
  stale.markers.push(
    { id: "stale-target", scanId: "scan-lake-room", kind: "item", targetId: "keys", position: [0, 0, 0] },
    { id: "stale-scan", scanId: "missing", kind: "item", targetId: "coat", position: [0, 0, 0] },
  );
  assert.deepEqual(removeHouse(stale, "home", { mode: "delete" }), next);
});

test("invalid modes, houses, source overrides, destinations, and cycles reject atomically", () => {
  const state = fixture(), before = structuredClone(state);
  const cases = [
    ["missing", { mode: "delete" }],
    ["home", { mode: "unknown", destinationHouseId: "lake" }],
    ["home", {}],
    ["home", { destinationHouseId: "missing" }],
    ["home", { destinationHouseId: "home" }],
    ["home", { destinationHouseId: "lake-room" }],
    ["home", { roomDestinations: new Map([["room", "lake"]]) }],
    ...["missing", "lake-room", "cabinet", "home"].map((source) => ["home", {
      destinationHouseId: "lake", roomDestinations: new Map([[source, "cabin"]]),
    }]),
    ...[null, "missing", "home", "lake-room"].map((destination) => ["home", {
      destinationHouseId: "lake", roomDestinations: new Map([["room", destination]]),
    }]),
    ...["missing", "room", "closet", "home"].map((source) => ["home", {
      destinationHouseId: "lake", containerDestinations: new Map([[source, "lake-room"]]),
    }]),
    ...[null, "missing", "home", "lake"].map((destination) => ["home", {
      destinationHouseId: "lake", containerDestinations: new Map([["cabinet", destination]]),
    }]),
    ...["missing", "coat", "home"].map((source) => ["home", {
      destinationHouseId: "lake", itemDestinations: new Map([[source, "lake-room"]]),
    }]),
    ...[null, "missing", "home", "lake"].map((destination) => ["home", {
      destinationHouseId: "lake", itemDestinations: new Map([["keys", destination]]),
    }]),
    ...[
      [["drawer", "drawer"]], [["cabinet", "box"]],
      [["cabinet", "shelf"], ["shelf", "cabinet"]],
    ].map((assignments) => ["home", { destinationHouseId: "lake", containerDestinations: new Map(assignments) }]),
    ["home", { destinationHouseId: "home", roomDestinations: new Map([["room", "lake"], ["spare", "cabin"]]) }],
  ];
  for (const [id, options] of cases) {
    const assignments = structuredClone(options);
    assert.throws(() => removeHouse(state, id, options), undefined, JSON.stringify([id, options]));
    assert.deepEqual(state, before);
    assert.deepEqual(options, assignments);
  }
});

test("legacy inventory keeps its last house and can transfer after another house is created", () => {
  const state = initialState(), before = structuredClone(state);
  for (const mode of ["move", "delete"])
    assert.throws(() => removeHouse(state, DEFAULT_HOUSE_ID, { mode }), /Create another house/);
  assert.deepEqual(state, before);

  const normalized = withHouses(state);
  normalized.houses.push({ id: "lake", name: "Lake" });
  const moved = removeHouse(normalized, DEFAULT_HOUSE_ID, { destinationHouseId: "lake" });
  assert.deepEqual(ids(moved.locations), ids(state.locations));
  assert.ok(moved.locations.every((record) => record.houseId === "lake"));
  assertValid(moved);
});

test("empty houses can be removed without destinations only when another house exists", () => {
  const state = fixture();
  state.houses.push({ id: "empty", name: "Empty" });
  for (const mode of ["move", "delete"]) {
    const next = removeHouse(state, "empty", { mode });
    assert.deepEqual(next, { ...state, houses: state.houses.slice(0, -1) });
    assertValid(next);

    const last = { version: 1, houses: [{ id: DEFAULT_HOUSE_ID, name: "Former house" }], locations: [], items: [] };
    const snapshot = structuredClone(last);
    assert.throws(() => removeHouse(last, DEFAULT_HOUSE_ID, { mode }), /Create another house/);
    assert.deepEqual(last, snapshot);
    assertValid(last);
  }
  assert.throws(() => removeHouse(state, "empty", { destinationHouseId: "empty" }), /destination house/);
  assert.throws(() => removeHouse(state, "empty", { destinationHouseId: "missing" }), /destination house/);
});

test("last populated house deletion rejects atomically and preserves rooms, items, scans and pins", () => {
  const state = withHouses(initialState());
  state.houses[0] = { id: DEFAULT_HOUSE_ID, name: "Old home", extra: "preserved" };
  location(state, "living-room").id = `${DEFAULT_HOUSE_ID}-2`;
  state.items.push({ id: `${DEFAULT_HOUSE_ID}-3`, name: "Item", notes: "", locationId: `${DEFAULT_HOUSE_ID}-2` });
  state.scans = [{ id: `${DEFAULT_HOUSE_ID}-4`, locationId: `${DEFAULT_HOUSE_ID}-2`, assetId: "asset", name: "scan.obj", format: "obj" }];
  state.markers = [{ id: `${DEFAULT_HOUSE_ID}-5`, scanId: `${DEFAULT_HOUSE_ID}-4`, kind: "item", targetId: `${DEFAULT_HOUSE_ID}-3`, position: [0, 0, 0] }];
  assertValid(state);
  const before = structuredClone(state);
  for (const options of [{}, { mode: "delete" }, { mode: "move" }, { destinationHouseId: DEFAULT_HOUSE_ID }]) {
    assert.throws(() => removeHouse(state, DEFAULT_HOUSE_ID, options), /Create another house/);
    assert.deepEqual(state, before);
    assertValid(state);
  }
});

test("deleting down to one house prevents any further deletion", () => {
  const state = removeHouse(removeHouse(fixture(), "home", { mode: "delete" }), "lake", { destinationHouseId: "cabin" });
  const before = structuredClone(state);
  assert.equal(state.houses.length, 1);
  for (const mode of ["move", "delete"])
    assert.throws(() => removeHouse(state, "cabin", { mode }), /Create another house/);
  assert.deepEqual(state, before);
  assertValid(state);
});

test("virtual roots remain collision safe when house and real record IDs overlap", () => {
  const state = fixture();
  state.houses[0].id = "room";
  state.houses[1].id = "closet";
  for (const record of state.locations) {
    if (record.houseId === "home") record.houseId = "room";
    if (record.houseId === "lake") record.houseId = "closet";
  }
  assertValid(state);
  const moved = removeHouse(state, "room", {
    destinationHouseId: "closet",
    containerDestinations: new Map([["cabinet", "closet"]]),
    itemDestinations: new Map([["lamp", "room"]]),
  });
  assert.equal(location(moved, "room").houseId, "closet");
  assert.equal(location(moved, "cabinet").parentId, "closet");
  assert.equal(item(moved, "lamp").locationId, "room");
  assertValid(moved);
  const deleted = removeHouse(state, "room", { mode: "delete" });
  assert.ok(!location(deleted, "room"));
  assert.ok(location(deleted, "closet"));
  assertValid(deleted);
});
