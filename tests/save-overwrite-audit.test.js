import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountSync, accountKey } from '../src/account-sync.js';
import { initialState } from '../src/store.js';
import { addHouse, inventoryForHouse, replaceHouseInventory } from '../src/houses.js';
import { removeLocation } from '../src/inventory-delete.js';

// Shared storage deliberately dispatches no events: saveLocal must protect itself.
function setup() {
  const values = new Map();
  const storage = {getItem:key => values.get(key) ?? null,setItem:(key,value) => values.set(key,value)};
  const remote = {watch:() => () => {},read:async () => initialState(),publish:async (_uid,_value,revision) => revision+1};
  const controller = () => new AccountSync({storage,remote,replace(){},notify(){},delay:60_000});
  return {storage,controller};
}
test('account deletion cannot overwrite a sibling save before its storage event arrives',async () => {
  const {storage,controller} = setup();
  storage.setItem(accountKey('audit'),JSON.stringify({inventory:initialState(),revision:1,dirty:false}));
  const first = controller(),second = controller();
  try {
    await first.select('audit'); await second.select('audit');
    const staleDelete = removeLocation(second.record.inventory,'bathroom');
    first.saveLocal({...first.record.inventory,items:[{id:'new',name:'Sibling item',notes:'',locationId:'garage'}]});
    const sibling = storage.getItem(accountKey('audit'));
    assert.throws(() => second.saveLocal(staleDelete),/another tab/);
    assert.equal(storage.getItem(accountKey('audit')),sibling);
    assert.equal(second.status,'stale');
  } finally { await first.select(null); await second.select(null); }
});
test('pending old-account publish cannot overwrite a switched account',async () => {
  const {storage,controller} = setup();
  let finish;
  const sync = controller();
  sync.remote.publish = () => new Promise(resolve => finish=resolve);
  try {
    await sync.select('alice'); await sync.receive(null);
    sync.saveLocal(removeLocation(sync.record.inventory,'bathroom'));
    const pending = sync.flush();
    await sync.select('bob');
    sync.saveLocal({...initialState(),items:[{id:'bob',name:'Bob keys',notes:'',locationId:'garage'}]});
    const bob = storage.getItem(accountKey('bob'));
    finish(1); await pending;
    assert.equal(storage.getItem(accountKey('bob')),bob);
    assert.equal(sync.record.inventory.items[0].id,'bob');
  } finally { await sync.select(null); }
});
test('deletion within active house preserves the current inactive-house snapshot', () => {
  let full = addHouse(initialState(),'Lake','lake');
  full.locations.push({id:'cabin',houseId:'lake',parentId:null,name:'Cabin',description:'',color:'sage'});
  full.items.push({id:'lake-key',locationId:'cabin',name:'Lake key',notes:''});
  const before = inventoryForHouse(full,'lake');
  full = replaceHouseInventory(full,'my-home',removeLocation(inventoryForHouse(full,'my-home'),'bathroom'));
  assert.deepEqual(inventoryForHouse(full,'lake'),before);
});
