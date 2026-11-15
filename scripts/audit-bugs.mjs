import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { initialState, validState } from '../src/store.js';
import { addHouse, inventoryForHouse } from '../src/houses.js';
import { createAuditSession, saveAuditResult, auditDirectory } from './audit-runtime.mjs';

const session = await createAuditSession({ label: 'bugs' });
const { page, baseURL, errors } = session;
page.setDefaultTimeout(5000);
const cases = [];
async function check(name, fn) {
  try { const detail = await fn(); cases.push({ name, status: 'pass', detail }); }
  catch (error) { cases.push({ name, status: 'fail', detail: error.message }); }
}
async function seed(value) {
  await page.goto(baseURL);
  await page.evaluate(value => { localStorage.clear(); localStorage.setItem('haven-inventory', typeof value === 'string' ? value : JSON.stringify(value)); }, value);
  await page.reload();
}
async function addRoom(name) {
  await page.locator('main [data-add-root]').click();
  await page.locator('#editor [name=name]').fill(name);
  await page.locator('#editor button[type=submit]').click();
}
function sample() {
  const data = addHouse(initialState(), 'Lake', 'lake');
  data.locations.push({ id: 'lake-room', parentId: null, houseId: 'lake', name: 'Cabin', description: '', color: 'blue' });
  data.items.push({ id: 'home-item', locationId: 'living-room', name: 'Home key', notes: '' }, { id: 'lake-item', locationId: 'lake-room', name: 'Lake key', notes: '' });
  return data;
}
try {
  await check('corrupt persistence remains intact after ordinary edit', async () => {
    const raw = '{"valuable":"recoverable fragment"';
    await seed(raw);
    assert.match(await page.locator('main .warning').innerText(), /could not be loaded/i);
    const download = page.waitForEvent('download');
    await page.locator('[data-export]:visible').first().click();
    const recovery = await download;
    assert.match(recovery.suggestedFilename(), /raw-recovery/);
    assert.equal(await readFile(await recovery.path(), 'utf8'), raw, 'Recovery must export the original raw value');
    await addRoom('New room');
    const after = await page.evaluate(() => localStorage.getItem('haven-inventory'));
    assert.equal(after, raw, 'Ordinary edits must not overwrite the original corrupt value');
  });
  await check('temporary read failure does not overwrite valid data', async () => {
    const data = sample();
    await seed(data);
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      let once = true;
      Storage.prototype.getItem = function(key) { if (key === 'haven-inventory' && once) { once = false; throw Error('temporary read failure'); } return get.call(this, key); };
    });
    await page.reload();
    assert.match(await page.locator('main .warning').innerText(), /could not be loaded/i);
    await addRoom('Accidental replacement');
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
    assert.ok(JSON.stringify(after) === JSON.stringify(data), `Previously valid ${data.houses.length}-house inventory replaced by ${after.houses.length} house(s), losing ${data.items.length} items`);
  });
  await page.close();
  const clean = await session.context.newPage();
  clean.on('pageerror', error => errors.push(error.message));
  clean.setDefaultTimeout(5000);
  session.page = clean;
  await check('house switch, navigation history and reload preserve isolation', async () => {
    const data = sample();
    await clean.goto(baseURL);
    await clean.evaluate(data => { localStorage.clear(); localStorage.setItem('haven-inventory', JSON.stringify(data)); }, data);
    await clean.reload();
    await clean.getByRole('button', { name: 'Open Living room' }).click();
    await clean.locator('[data-house-toggle]').click();
    await clean.locator('[data-house-list]').getByRole('button', { name: 'Lake', exact: true }).click();
    await clean.getByRole('button', { name: 'Open Cabin' }).click();
    await clean.goBack();
    await clean.goBack();
    const state = await clean.evaluate(() => ({ hash: location.hash, house: document.querySelector('[data-house-name]').textContent, heading: document.querySelector('h1').textContent }));
    await clean.reload();
    const after = await clean.evaluate(() => ({ house: document.querySelector('[data-house-name]').textContent, heading: document.querySelector('h1').textContent, stored: JSON.parse(localStorage.getItem('haven-inventory')) }));
    assert.deepEqual(after.stored, data);
    assert.ok(state.house === 'My home' && state.heading === 'Living room', `Back returned to ${state.hash}, but displayed house ${state.house} and heading ${state.heading}; reload displayed ${after.house} / ${after.heading}`);
  });
  await check('inactive house survives edits and deletion in active house', async () => {
    const before = sample();
    await clean.evaluate(data => { localStorage.setItem('haven-inventory', JSON.stringify(data)); localStorage.removeItem('haven-active-house:guest'); }, before);
    await clean.goto(baseURL);
    await addRoomClean(clean, 'Temporary room');
    await clean.getByRole('button', { name: 'Open Temporary room' }).click();
    await clean.getByRole('button', { name: 'Delete location' }).click();
    await clean.locator('#editor button[type=submit]').click();
    const after = await clean.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
    assert.ok(validState(after));
    assert.deepEqual(inventoryForHouse(after, 'lake'), inventoryForHouse(before, 'lake'));
  });
  await check('house name markup remains inert at mobile width', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const data = addHouse(sample(), name, 'evil');
    await clean.setViewportSize({ width: 320, height: 700 });
    await clean.evaluate(data => { localStorage.setItem('haven-inventory', JSON.stringify(data)); }, data);
    await clean.reload();
    await clean.locator('[data-house-toggle]').click();
    assert.equal(await clean.locator('[data-house-switcher] img').count(), 0);
    await clean.locator('[data-house-list]').getByRole('button', { name, exact: true }).click();
    assert.equal(await clean.locator('[data-house-name]').innerText(), name);
    assert.equal(await clean.evaluate(() => document.documentElement.scrollWidth), 320);
  });
  await check('restore confirmation is invalidated by external inventory replacement', async () => {
    const data = sample();
    await clean.evaluate(data => { localStorage.setItem('haven-inventory', JSON.stringify(data)); localStorage.removeItem('haven-active-house:guest'); }, data);
    await clean.reload();
    const chooser = clean.waitForEvent('filechooser');
    await clean.locator('[data-import]:visible').first().click();
    await (await chooser).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initialState())) });
    await clean.getByText('Restore this backup?').waitFor();
    const changed = structuredClone(data); changed.locations[0].name = 'External change';
    await clean.evaluate(changed => { localStorage.setItem('haven-inventory', JSON.stringify(changed)); window.dispatchEvent(new StorageEvent('storage', { key: 'haven-inventory' })); }, changed);
    await clean.getByRole('button', { name: 'Open External change' }).waitFor();
    assert.deepEqual(await clean.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory'))), changed);
  });
} finally {
  const result = { date: new Date().toISOString(), cases, pageErrors: errors, limitations: ['Headless desktop Edge; no physical mobile, camera, or live Firebase.', 'Auth and scan staging races not newly exercised by this script.'] };
  await saveAuditResult('bugs', result);
  await writeFile(`${auditDirectory}/bugs.md`, '# Bug audit\n\n' + cases.map(entry => `- **${entry.status.toUpperCase()}** ${entry.name}: ${typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : entry.detail || 'verified'}`).join('\n') + '\n\nPage errors: ' + JSON.stringify(errors) + '\n');
  process.exitCode = cases.some(entry => entry.status === 'fail') || errors.length ? 1 : 0;
  await session.close();
}
async function addRoomClean(targetPage, name) {
  await targetPage.locator('main [data-add-root]').click();
  await targetPage.locator('#editor [name=name]').fill(name);
  await targetPage.locator('#editor button[type=submit]').click();
}
