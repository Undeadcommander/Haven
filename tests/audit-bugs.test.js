import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validState } from '../src/store.js';
import { addHouse, removeHouse, withHouses, inventoryForHouse, replaceHouseInventory } from '../src/houses.js';
import { createLocationTree } from '../src/location-tree.js';

test('deterministic multi-house edit sequences preserve every inactive house', () => {
  let inventory = initialState();
  for (let house = 0; house < 8; house++) inventory = addHouse(inventory, `House ${house}`, `h${house}`);
  let seed = 42731;
  const random = count => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % count; };
  for (let step = 0; step < 400; step++) {
    const id = inventory.houses[random(inventory.houses.length)].id;
    const inactive = new Map(inventory.houses.filter(house => house.id !== id).map(house => [house.id, inventoryForHouse(inventory, house.id)]));
    const active = inventoryForHouse(inventory, id);
    if (step % 3 === 0 && active.locations.length) {
      const root = active.locations.find(location => location.parentId === null);
      active.items.push({ id: `i${step}`, name: `Item ${step}`, notes: '', locationId: root.id });
    } else {
      active.locations.push({ id: `l${step}`, parentId: null, name: `Room ${step}`, description: '', color: 'sage' });
    }
    inventory = replaceHouseInventory(inventory, id, active);
    assert.ok(validState(inventory), `invalid after step ${step}`);
    for (const [houseId, snapshot] of inactive) assert.deepEqual(inventoryForHouse(inventory, houseId), snapshot, `house ${houseId}, step ${step}`);
  }
});

test('deterministic house deletion sequences preserve surviving records and never remove the last house', () => {
  let inventory = withHouses(initialState());
  let seed = 83079;
  const random = count => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % count; };
  for (let step = 0; step < 200; step++) {
    if (inventory.houses.length === 1 || step % 3 === 0) {
      const houseId = `added-house-${step}`, roomId = `added-room-${step}`, containerId = `added-box-${step}`, itemId = `added-item-${step}`;
      inventory = addHouse(inventory, `House ${step}`, houseId);
      inventory.locations.push(
        { id: roomId, houseId, parentId: null, name: 'Room', description: '', color: 'sage' },
        { id: containerId, parentId: roomId, name: 'Box', description: '', color: 'blue' },
      );
      inventory.items.push({ id: itemId, locationId: containerId, name: 'Keys', notes: '' });
      (inventory.scans ||= []).push({ id: `scan-${step}`, locationId: roomId, assetId: `asset-${step}`, name: 'scan.obj', format: 'obj' });
      (inventory.markers ||= []).push({ id: `pin-${step}`, scanId: `scan-${step}`, kind: 'item', targetId: itemId, position: [0, 0, 0] });
    }
    const sourceId = inventory.houses[random(inventory.houses.length)].id;
    const source = inventoryForHouse(inventory, sourceId);
    const sourceLocations = new Set(source.locations.map(location => location.id));
    const sourceScans = new Set(source.scans.map(scan => scan.id));
    const others = inventory.houses.filter(house => house.id !== sourceId);
    const mode = random(3) === 0 ? 'delete' : 'move';
    const roomDestinations = new Map(source.locations.filter(location => location.parentId === null)
      .map(room => [room.id, others[random(others.length)].id]));
    const containerDestinations = new Map(), itemDestinations = new Map();
    const containers = source.locations.filter(location => location.parentId !== null);
    if (containers.length) {
      const container = containers[random(containers.length)];
      const tree = createLocationTree(inventory.locations);
      const targets = inventory.locations.filter(location => !tree.contains(container.id, location.id));
      containerDestinations.set(container.id, targets[random(targets.length)].id);
    }
    if (source.items.length) itemDestinations.set(source.items[random(source.items.length)].id,
      inventory.locations[random(inventory.locations.length)].id);
    const before = structuredClone(inventory);
    const next = removeHouse(inventory, sourceId, { mode, roomDestinations, containerDestinations, itemDestinations });
    assert.deepEqual(inventory, before, `mutation at step ${step}`);
    assert.ok(validState(next), `invalid at step ${step}`);
    assert.equal(next.houses.length, inventory.houses.length - 1);
    for (const location of inventory.locations.filter(location => !sourceLocations.has(location.id)))
      assert.deepEqual(next.locations.find(record => record.id === location.id), location);
    for (const item of inventory.items.filter(item => !sourceLocations.has(item.locationId)))
      assert.deepEqual(next.items.find(record => record.id === item.id), item);
    for (const marker of inventory.markers.filter(marker => !sourceScans.has(marker.scanId)))
      assert.deepEqual(next.markers.find(record => record.id === marker.id), marker);
    assert.equal(next.locations.length, inventory.locations.length - (mode === 'delete' ? source.locations.length : 0));
    assert.equal(next.items.length, inventory.items.length - (mode === 'delete' ? source.items.length : 0));
    assert.equal(next.scans.length, inventory.scans.length - (mode === 'delete' ? source.scans.length : 0));
    if (next.houses.length === 1) {
      const last = structuredClone(next);
      for (const finalMode of ['move', 'delete'])
        assert.throws(() => removeHouse(next, next.houses[0].id, { mode: finalMode }), /Create another house/);
      assert.deepEqual(next, last);
    }
    inventory = next;
  }
});
