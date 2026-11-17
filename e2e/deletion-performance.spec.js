import { test, expect } from '@playwright/test';
import { deletionFixture, isolate, seed, action, structure } from '../scripts/audit-deletion-performance.mjs';
import { validState } from '../src/store.js';

test.beforeEach(async ({ context }) => { await isolate(context); });

test('wide inventory default/delete stays lazy; separate toggles and closes release DOM', async ({ page }) => {
  await seed(page, deletionFixture(100, 1000));
  const samples = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await action(page, 'gear');
    samples.push(await action(page, 'open'));
    expect((await structure(page)).splitSelects).toBe(0);
    await action(page, 'separate');
    const split = await structure(page);
    expect(split.splitSelects).toBeGreaterThan(0);
    expect(split.splitSelects).toBeLessThanOrEqual(20);
    expect(split.options).toBeLessThan(2500);
    await action(page, 'together');
    await action(page, 'separate');
    expect((await structure(page)).options).toBe(split.options);
    await action(page, 'cancel');
    expect((await structure(page)).editorNodes).toBe(0);
  }
  expect((await structure(page)).writes).toHaveLength(0);
  test.info().annotations.push({ type: 'open timings', description: JSON.stringify(samples) });
});

test('deep Delete everything prunes scans and markers with one persisted write', async ({ page }) => {
  await seed(page, deletionFixture(200, 2000, true));
  await action(page, 'gear');
  await action(page, 'open');
  expect((await structure(page)).splitSelects).toBe(0);
  await action(page, 'delete');
  await action(page, 'submit');
  expect((await structure(page)).options).toBe(0);
  expect((await structure(page)).writes).toHaveLength(0);
  const timing = await action(page, 'submit');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
  expect(validState(after)).toBe(true);
  expect(after.locations.map(loc => loc.id)).toEqual(['target']);
  expect(after.items).toEqual([]);
  expect(after.scans.map(scan => scan.locationId)).toEqual(['target']);
  expect(after.markers).toEqual([]);
  expect((await structure(page)).writes).toHaveLength(1);
  test.info().annotations.push({ type: 'commit timing', description: JSON.stringify(timing) });
});

test('container and item gear dialogs stay bounded in a wide inventory', async ({ page }) => {
  await seed(page, deletionFixture(100, 1000));
  await page.getByRole('button', { name: 'Open Source', exact: true }).click();
  for (let cycle = 0; cycle < 5; cycle++) {
    await page.getByRole('button', { name: 'Settings for C000', exact: true }).click();
    await page.locator('#editor').getByRole('button', { name: 'Delete container', exact: true }).click();
    expect((await structure(page)).splitSelects).toBe(0);
    expect((await structure(page)).options).toBeLessThan(110);
    await action(page, 'cancel');
    expect((await structure(page)).editorNodes).toBe(0);
    await page.getByRole('button', { name: 'Settings for Item 0', exact: true }).click();
    await page.locator('#editor').getByRole('button', { name: 'Delete item', exact: true }).click();
    expect((await structure(page)).options).toBe(0);
    await action(page, 'cancel');
    expect((await structure(page)).editorNodes).toBe(0);
  }
  expect((await structure(page)).writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Settings for Item 0', exact: true }).click();
  await page.locator('#editor').getByRole('button', { name: 'Delete item', exact: true }).click();
  await page.locator('#editor').getByRole('button', { name: 'Delete item', exact: true }).click();
  await expect(page.locator('#editor')).toBeHidden();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
  expect(validState(after)).toBe(true);
  expect(after.items).toHaveLength(999);
  expect(after.markers.some(marker => marker.targetId === 'i0')).toBe(false);
  expect((await structure(page)).writes).toHaveLength(1);
});

test('separate plans keep choices across pages, layout changes, defaults, and a failed save', async ({ page }) => {
  const data = deletionFixture(25, 40);
  data.locations.push({ id: 'alternate', parentId: null, name: 'Alternate', description: '', color: 'sage' });
  await seed(page, data);
  await action(page, 'gear');
  await action(page, 'open');
  const editor = page.locator('#editor');
  await editor.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('target');
  await editor.getByLabel('How to move contents').selectOption('separate');
  await editor.locator('[name="container-destination-0"]').selectOption('c1');
  await editor.getByRole('button', { name: 'Next contents', exact: true }).click();
  await editor.locator('[name="item-destination-1"]').selectOption('target');
  await editor.getByRole('button', { name: 'Next contents', exact: true }).click();
  await editor.locator('[name="item-destination-25"]').selectOption('c2');
  await editor.getByRole('button', { name: 'Next contents', exact: true }).click();
  await editor.locator('[name="item-destination-39"]').selectOption('target');
  await editor.getByRole('button', { name: 'Previous contents', exact: true }).click();
  await expect(editor.locator('[name="item-destination-25"]')).toHaveValue('c2');
  await editor.getByRole('button', { name: 'Previous contents', exact: true }).click();
  await expect(editor.locator('[name="item-destination-1"]')).toHaveValue('target');
  await editor.getByRole('button', { name: 'Previous contents', exact: true }).click();
  await expect(editor.locator('[name="container-destination-0"]')).toHaveValue('c1');
  await editor.getByLabel('How to move contents').selectOption('together');
  await editor.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('alternate');
  await editor.getByLabel('How to move contents').selectOption('separate');
  await expect(editor.locator('[name="container-destination-0"]')).toHaveValue('c1');
  await expect(editor.locator('[name="container-destination-1"]')).toHaveValue('alternate');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'haven-inventory') throw Error('Storage full');
      return original.call(this, key, value);
    };
    window.restorePaginatedStorage = () => { Storage.prototype.setItem = original; };
  });
  await editor.getByRole('button', { name: 'Move contents & delete', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Nothing has been moved or deleted');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')))).toEqual(data);
  await page.evaluate(() => window.restorePaginatedStorage());
  await editor.getByRole('button', { name: 'Move contents & delete', exact: true }).click();
  await expect(editor).toBeHidden();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
  expect(validState(after)).toBe(true);
  expect(after.locations.find(location => location.id === 'c0').parentId).toBe('c1');
  expect(after.locations.find(location => location.id === 'c1').parentId).toBe('alternate');
  for (const [id, locationId] of [['i0', 'alternate'], ['i1', 'target'], ['i25', 'c2'], ['i39', 'target']])
    expect(after.items.find(item => item.id === id).locationId).toBe(locationId);
});

test('an unset destination on a hidden page is reviewed before anything is deleted', async ({ page }) => {
  const data = deletionFixture(25, 0);
  await seed(page, data);
  await action(page, 'gear');
  await action(page, 'open');
  const editor = page.locator('#editor');
  await editor.getByLabel('How to move contents').selectOption('separate');
  await editor.locator('[data-delete-record]').evaluateAll(selects => {
    for (const select of selects) { select.value = 'target'; select.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await editor.getByRole('button', { name: 'Move contents & delete', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('C020');
  await expect(editor.locator('[data-delete-page-status]')).toHaveText('Page 2 of 2');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')))).toEqual(data);
  await editor.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('target');
  await editor.getByRole('button', { name: 'Move contents & delete', exact: true }).click();
  await expect(editor).toBeHidden();
  expect(validState(await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory'))))).toBe(true);
});

test('closing separate destinations releases native controls after garbage collection', async ({ page, context }) => {
  await seed(page, deletionFixture(100, 1000));
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const baseline = await cdp.send('Memory.getDOMCounters');
  for (let cycle = 0; cycle < 4; cycle++) {
    await action(page, 'gear');
    await action(page, 'open');
    await action(page, 'separate');
    await action(page, 'cancel');
    expect((await structure(page)).editorNodes).toBe(0);
  }
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const closed = await cdp.send('Memory.getDOMCounters');
  expect(closed.nodes).toBeLessThan(baseline.nodes + 1000);
});
