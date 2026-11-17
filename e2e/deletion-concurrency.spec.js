import { test, expect } from '@playwright/test';
import { initialState } from '../src/store.js';
import { addHouse } from '../src/houses.js';

const seed = () => {
  const inventory = addHouse(initialState(), 'Lake', 'lake');
  inventory.locations.push({id:'cabin', parentId:null, houseId:'lake', name:'Cabin', description:'', color:'sage'},
    {id:'box', parentId:'living-room', name:'Box', description:'', color:'sage'});
  inventory.items = [{id:'keys', name:'Keys', notes:'', locationId:'living-room'},
    {id:'book', name:'Book', notes:'', locationId:'box'}];
  return inventory;
};
const mockService = `export async function createFirebaseService() { return {
  watchAuth(callback) { window.__auditAuth = callback; queueMicrotask(() => callback({uid:'audit',displayName:'Audit'})); return () => {}; },
  watch(uid, callback) { queueMicrotask(() => callback({revision:1})); return () => {}; },
  async read() { return JSON.parse(localStorage.getItem('haven-account:audit')).inventory; },
  async publish(uid, inventory, revision) { return revision + 1; },
  async login() {}, async logout() { await window.__auditAuth(null); }
}; }`;

async function tabs(browser, baseURL, account = false) {
  const context = await browser.newContext({baseURL, serviceWorkers:'block'});
  const blocked = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin) { blocked.push(url.href); return route.abort(); }
    if (url.pathname === '/src/firebase-config.json') return route.fulfill({contentType:'application/javascript', body:account
      ? 'export default {apiKey:"mock",authDomain:"mock.invalid",projectId:"mock",appId:"mock"};'
      : 'export default {enabled:false};'});
    if (url.pathname === '/src/firebase-service.js') return route.fulfill({contentType:'application/javascript',body:mockService});
    if (url.pathname === '/src/account.js') {
      const response = await route.fetch();
      const source = (await response.text()).replaceAll('\r\n','\n');
      const anchor = '  return {\n    bind()';
      expect(source.split(anchor)).toHaveLength(2);
      return route.fulfill({response,body:source.replace(anchor,'  sync.delay = 60_000;\n  return window.__auditAccount = {\n    bind()')});
    }
    return route.continue();
  });
  await context.addInitScript(({inventory,account}) => {
    const key = account ? 'haven-account:audit' : 'haven-inventory';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(account
      ? {inventory,revision:1,dirty:false} : inventory));
    window.__auditHold = false;
    window.__auditQueued = 0;
    const pending = [];
    const listen = window.addEventListener;
    window.addEventListener = function(type, listener, options) {
      if (type !== 'storage') return listen.call(this,type,listener,options);
      return listen.call(this,type,event => {
        if (window.__auditHold) { pending.push(() => listener.call(this,event)); window.__auditQueued++; }
        else listener.call(this,event);
      },options);
    };
    window.__auditRelease = () => { window.__auditHold = false; pending.splice(0).forEach(deliver => deliver()); };
  },{inventory:seed(),account});
  const pages = [];
  for (let i=0;i<2;i++) {
    const page = await context.newPage(); pages.push(page);
    await page.goto('/');
    await page.waitForFunction(account => window.__auditAccount?.ready && (!account || window.__auditAccount.sync.remoteKnown),account);
  }
  const read = page => page.evaluate(account => {
    const data = JSON.parse(localStorage.getItem(account ? 'haven-account:audit' : 'haven-inventory'));
    return account ? data.inventory : data;
  },account);
  return {context,first:pages[0],second:pages[1],read,blocked};
}
async function gearDelete(page,name,kind) {
  await page.getByRole('button',{name:`Settings for ${name}`,exact:true}).click();
  await page.locator('#editor').getByRole('button',{name:`Delete ${kind}`,exact:true}).click();
}
async function addRoom(page,name) {
  await page.locator('.heading-actions [data-add-root]').click();
  await page.locator('#editor [name=name]').fill(name);
  await page.locator('#editor [type=submit]').click();
  await expect(page.locator('#editor')).toBeHidden();
}
async function submitEditor(page) {
  await page.locator('#editor [type=submit]').click();
  await expect.poll(() => page.locator('#editor').evaluate(dialog =>
    !dialog.open || !dialog.querySelector('[type=submit]')?.disabled)).toBe(true);
}

for (const account of [false,true]) {
  const mode = account ? 'account' : 'guest';
  for (const operation of ['room-delete','container-move-delete','item-delete','house-delete','house-move-delete','ordinary-edit']) {
    test(`${mode}: delayed storage event, ${operation} must preserve immediately preceding sibling save`,async ({browser,baseURL}) => {
      const {context,first,second,read,blocked} = await tabs(browser,baseURL,account);
      try {
        await second.evaluate(() => window.__auditHold = true);
        if (operation === 'room-delete') await gearDelete(second,'Bathroom','room');
        if (operation === 'container-move-delete') {
          await second.getByRole('button',{name:'Open Living room',exact:true}).click();
          await gearDelete(second,'Box','container');
          await second.locator('#editor [name=destination]').selectOption('garage');
        }
        if (operation === 'item-delete') {
          await second.getByRole('button',{name:'Open Living room',exact:true}).click();
          await gearDelete(second,'Keys','item');
        }
        if (operation === 'house-delete' || operation === 'house-move-delete') {
          await second.locator('[data-house-toggle]').click();
          await second.getByRole('button',{name:'Delete house',exact:true}).click();
          if (operation === 'house-delete') {
            await second.locator('#editor').getByRole('radio',{name:/Delete everything/}).check();
            await second.locator('#editor').getByRole('button',{name:'Continue',exact:true}).click();
          } else await second.locator('#editor [name=destination]').selectOption('lake');
        }
        if (operation === 'ordinary-edit') {
          await second.getByRole('button',{name:'Settings for Garage',exact:true}).click();
          await second.locator('#editor [name=name]').fill('Edited garage');
        }
        await addRoom(first,'Sibling saved room');
        expect((await read(first)).locations.map(l => l.name)).toContain('Sibling saved room');
        await expect.poll(() => second.evaluate(() => window.__auditQueued)).toBeGreaterThan(0);
        await submitEditor(second);
        const after = await read(second);
        expect(after.locations.map(l => l.name)).toContain('Sibling saved room');
        if (operation.startsWith('house-')) expect(after.houses.map(house => house.id)).toContain('my-home');
        if (account) {
          await expect(second.locator('#editor [data-settings-error]')).toBeVisible();
          expect(await second.evaluate(() => window.__auditAccount.sync.status)).toBe('stale');
        }
        expect(blocked).toEqual([]);
      } finally { await context.close(); }
    });
  }
  test(`${mode}: delivered sibling save invalidates an open deletion`, async ({browser,baseURL}) => {
    const {context,first,second,read} = await tabs(browser,baseURL,account);
    try {
      await gearDelete(second,'Bathroom','room');
      await addRoom(first,'Delivered room');
      if (account) {
        await expect.poll(() => second.evaluate(() => window.__auditAccount.ready)).toBe(false);
        await second.locator('#editor [type=submit]').click();
        await expect(second.locator('#editor [data-settings-error]')).toBeVisible();
      } else await expect(second.locator('#editor')).toBeHidden();
      const after = await read(second);
      expect(after.locations.some(l => l.id === 'bathroom')).toBe(true);
      expect(after.locations.some(l => l.name === 'Delivered room')).toBe(true);
    } finally { await context.close(); }
  });
}

test('guest: stale deletion overwrites a sibling save in an inactive house',async ({browser,baseURL}) => {
  const {context,first,second,read} = await tabs(browser,baseURL);
  try {
    await second.evaluate(() => window.__auditHold = true);
    await gearDelete(second,'Bathroom','room');
    await first.evaluate(() => localStorage.setItem('haven-active-house:guest','lake'));
    await first.reload();
    await addRoom(first,'New lake room');
    expect((await read(first)).locations.map(l => l.name)).toContain('New lake room');
    await expect.poll(() => second.evaluate(() => window.__auditQueued)).toBeGreaterThan(0);
    await submitEditor(second);
    expect((await read(second)).locations.map(l => l.name)).toContain('New lake room');
  } finally { await context.close(); }
});

test('account: auth scope switch closes stale deletion and keeps both inventories',async ({browser,baseURL}) => {
  const {context,second,read} = await tabs(browser,baseURL,true);
  try {
    const before = await read(second);
    await gearDelete(second,'Bathroom','room');
    await second.evaluate(async () => {
      localStorage.setItem('haven-inventory', JSON.stringify({version:1,locations:[],items:[]}));
      await window.__auditAuth(null);
    });
    await expect(second.locator('#editor')).toBeHidden();
    expect(await read(second)).toEqual(before);
    expect(await second.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')))).toEqual({version:1,locations:[],items:[]});
  } finally { await context.close(); }
});

for (const account of [false,true]) {
  for (const race of ['move-before-final-delete','delete-before-stale-edit']) {
    test(`${account ? 'account' : 'guest'}: competing ${race} preserves the sibling result`,async ({browser,baseURL}) => {
      const {context,first,second,read} = await tabs(browser,baseURL,account);
      try {
        await second.evaluate(() => window.__auditHold = true);
        if (race === 'move-before-final-delete') {
          await gearDelete(second,'Living room','room');
          await second.locator('#editor [name=delete-mode][value=delete]').check();
          await second.locator('#editor [type=submit]').click();
          await expect(second.locator('#editor h2')).toHaveText('Delete everything in Living room?');
          await first.getByRole('button',{name:'Open Living room',exact:true}).click();
          await first.getByRole('button',{name:'Settings for Keys',exact:true}).click();
          await first.locator('#editor [name=location]').selectOption('garage');
          await submitEditor(first);
          expect((await read(first)).items.find(item => item.id === 'keys')?.locationId).toBe('garage');
        } else {
          await second.getByRole('button',{name:'Settings for Garage',exact:true}).click();
          await second.locator('#editor [name=name]').fill('Stale edit');
          await first.getByRole('button',{name:'Open Living room',exact:true}).click();
          await gearDelete(first,'Keys','item');
          await submitEditor(first);
          expect((await read(first)).items.some(item => item.id === 'keys')).toBe(false);
        }
        await expect.poll(() => second.evaluate(() => window.__auditQueued)).toBeGreaterThan(0);
        // No artificial time gap between the acknowledged sibling operation and submit.
        await submitEditor(second);
        const after = await read(second);
        if (race === 'move-before-final-delete') {
          expect(after.items.find(item => item.id === 'keys')?.locationId).toBe('garage');
        } else expect(after.items.some(item => item.id === 'keys')).toBe(false);
        if (account) await expect(second.locator('#editor [data-settings-error]')).toBeVisible();
      } finally { await context.close(); }
    });
  }
}

for (const account of [false, true]) for (const delayed of [false, true]) {
  test(`${account ? 'account' : 'guest'}: sibling storage clear is safe with ${delayed ? 'delayed' : 'delivered'} events`, async ({ browser, baseURL }) => {
    const { context, first, second, read } = await tabs(browser, baseURL, account);
    const key = account ? 'haven-account:audit' : 'haven-inventory';
    try {
      if (delayed) await second.evaluate(() => { window.__auditHold = true; });
      await gearDelete(second, 'Bathroom', 'room');
      await first.evaluate(() => localStorage.clear());
      if (delayed) await expect.poll(() => second.evaluate(() => window.__auditQueued)).toBeGreaterThan(0);
      else if (account) await expect.poll(() => second.evaluate(() => window.__auditAccount.ready)).toBe(false);
      else await expect(second.locator('#editor')).toBeHidden();
      if (account || delayed) {
        await second.locator('#editor [type=submit]').click();
        await expect(second.locator('#editor [data-settings-error]')).toBeVisible();
      }
      expect(await second.evaluate(key => localStorage.getItem(key), key)).toBeNull();
      if (delayed) await second.evaluate(() => window.__auditRelease());
      if (account) await expect.poll(() => second.evaluate(() => window.__auditAccount.ready)).toBe(false);
      else {
        await expect(second.locator('#editor')).toBeHidden();
        await addRoom(second, 'After storage clear');
        const after = await read(second);
        expect(after.items).toEqual([]);
        expect(after.locations.some(location => location.id === 'box')).toBe(false);
        expect(after.locations.some(location => location.name === 'After storage clear')).toBe(true);
      }
    } finally { await context.close(); }
  });
}
