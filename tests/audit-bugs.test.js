import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validState } from '../src/store.js';
import { addHouse, inventoryForHouse, replaceHouseInventory } from '../src/houses.js';

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
