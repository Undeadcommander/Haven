import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeLocation, removeItem } from '../src/inventory-delete.js';
import { initialState, validState } from '../src/store.js';
import { createLocationTree } from '../src/location-tree.js';

function fixture() {
  const s = initialState();
  s.locations = [['r', null], ['out', null], ['a', 'r'], ['b', 'a'], ['c', 'r']].map(([id, parentId]) => ({ id, parentId, name: id, description: '', color: 'sage' }));
  s.items = s.locations.map(l => ({ id: `i-${l.id}`, locationId: l.id, name: l.id, notes: '' }));
  s.scans = s.locations.map(l => ({ id: `s-${l.id}`, locationId: l.id, assetId: `asset-${l.id}`, name: 'scan.obj', format: 'obj' }));
  const t = createLocationTree(s.locations);
  s.markers = s.scans.flatMap(scan => [
    ...s.locations.filter(l => l.id !== scan.locationId && t.contains(scan.locationId, l.id)).map(l => ({ kind: 'container', targetId: l.id })),
    ...s.items.filter(i => t.contains(scan.locationId, i.locationId)).map(i => ({ kind: 'item', targetId: i.id })),
  ].map((m, n) => ({ ...m, id: `${scan.id}-${n}`, scanId: scan.id, position: [1, 2, 3] })));
  assert.equal(validState(s), true);
  return s;
}

test('exhaustive final parent assignments preserve validity, identity, and atomic rejection', () => {
  const s = fixture(), before = structuredClone(s);
  const destinations = ['out', 'a', 'b', 'c', 'r', 'missing', null];
  let accepted = 0, rejected = 0;
  for (const a of destinations) for (const b of destinations) for (const c of destinations) {
    const assignments = new Map([['a', a], ['b', b], ['c', c]]);
    const candidate = s.locations.filter(l => l.id !== 'r').map(l => assignments.has(l.id) ? { ...l, parentId: assignments.get(l.id) } : l);
    const legitimate = [...assignments.values()].every(id => candidate.some(l => l.id === id)) && createLocationTree(candidate).order.length === candidate.length;
    if (!legitimate) {
      assert.throws(() => removeLocation(s, 'r', { containerDestinations: assignments, itemDestinations: new Map([['i-r', 'out']]) }));
      rejected++;
    } else {
      const next = removeLocation(s, 'r', { containerDestinations: assignments, itemDestinations: new Map([['i-r', 'out']]) });
      assert.equal(validState(next), true, JSON.stringify([...assignments]));
      assert.deepEqual(next.items.map(i => i.id), s.items.map(i => i.id));
      assert.deepEqual(next.locations, candidate);
      // A pin is retained exactly when the old path from scan to target has
      // unchanged parent edges, and its item did not change location.
      const parents = new Map(candidate.map(l => [l.id, l.parentId]));
      const expected = s.markers.filter(m => {
        const scan = s.scans.find(scan => scan.id === m.scanId);
        if (scan.locationId === 'r' || m.targetId === 'r' || m.targetId === 'i-r') return false;
        let id = m.kind === 'item' ? s.items.find(i => i.id === m.targetId).locationId : m.targetId;
        while (id !== scan.locationId) {
          const oldParent = s.locations.find(l => l.id === id).parentId;
          if (parents.get(id) !== oldParent) return false;
          id = oldParent;
        }
        return true;
      });
      assert.deepEqual(next.markers, expected);
      accepted++;
    }
    assert.deepEqual(s, before);
  }
  assert.equal(accepted, 16);
  assert.equal(rejected, 327);
});

test('each possible direct/nested item destination clears only changed item pins', () => {
  const s = fixture();
  for (const item of s.items.filter(i => i.locationId !== 'out')) for (const destination of ['out', 'a', 'b', 'c']) {
    const base = removeLocation(s, 'r', { destinationId: 'out' });
    const next = removeLocation(s, 'r', { destinationId: 'out', itemDestinations: new Map([[item.id, destination]]) });
    assert.equal(validState(next), true);
    assert.equal(next.items.find(i => i.id === item.id).locationId, destination);
    assert.deepEqual(next.markers.filter(m => m.targetId !== item.id), base.markers.filter(m => m.targetId !== item.id));
    if (destination !== item.locationId) assert.equal(next.markers.some(m => m.kind === 'item' && m.targetId === item.id), false);
  }
});

test('deletions commute for independent items and disjoint subtrees', () => {
  const s = fixture();
  assert.deepEqual(removeItem(removeItem(s, 'i-a'), 'i-b'), removeItem(removeItem(s, 'i-b'), 'i-a'));
  assert.deepEqual(removeLocation(removeLocation(s, 'a', { mode: 'delete' }), 'c', { mode: 'delete' }), removeLocation(removeLocation(s, 'c', { mode: 'delete' }), 'a', { mode: 'delete' }));
});
