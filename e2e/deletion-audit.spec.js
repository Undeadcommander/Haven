import { test, expect } from './fixture.js';
import { initialState, validState } from '../src/store.js';
import { addHouse } from '../src/houses.js';

const strange = '<img src=x onerror="window.auditInjected=1"> & "quoted"';
function fixture() {
  const s = addHouse(initialState(), 'Audit inactive', 'inactive');
  s.locations = [
    { id: 'r', parentId: null, houseId: 'my-home', name: strange },
    { id: 'out', parentId: null, houseId: 'my-home', name: 'Outside' },
    { id: 'a', parentId: 'r', name: 'Ancestor' },
    { id: 'b', parentId: 'a', name: 'Descendant' },
    { id: 'inactive-r', parentId: null, houseId: 'inactive', name: 'Private' },
  ].map(l => ({ ...l, description: '', color: 'sage' }));
  s.items = [['direct', 'r', strange], ['nested', 'b', 'Nested'], ['private', 'inactive-r', 'Private item']].map(([id, locationId, name]) => ({ id, locationId, name, notes: '' }));
  return s;
}
async function seed(page, data = fixture(), route = '/') {
  await page.addInitScript(s => localStorage.setItem('haven-inventory', JSON.stringify(s)), data);
  await page.goto(route);
}
const inventory = page => page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
const dialog = page => page.locator('#editor');
async function openDelete(page) {
  await page.locator('[data-location-settings="r"]').click();
  await dialog(page).getByRole('button', { name: 'Delete room', exact: true }).click();
}

test('audit: separate destinations allow a valid ancestor/descendant reversal', async ({ page }) => {
  await seed(page);
  await openDelete(page);
  await dialog(page).getByLabel('How to move contents').selectOption('separate');
  await dialog(page).getByLabel('Destination for Descendant', { exact: false }).selectOption('out');
  // Final tree Outside > Descendant > Ancestor is acyclic and supported by the pure API.
  await expect(dialog(page).getByLabel('Destination for Ancestor', { exact: false }).locator('option[value="b"]')).toHaveCount(1);
  await dialog(page).getByLabel('Destination for Ancestor', { exact: false }).selectOption('b');
  await dialog(page).getByLabel(`Destination for ${strange}`, { exact: false }).selectOption('out');
  await dialog(page).getByRole('button', { name: 'Move contents & delete', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  const after = await inventory(page);
  expect(after.locations.find(l => l.id === 'a').parentId).toBe('b');
  expect(after.locations.find(l => l.id === 'b').parentId).toBe('out');
  expect(validState(after)).toBe(true);
});

test('audit: switching layouts and destructive mode submits only the active destination fields', async ({ page }) => {
  await seed(page);
  const before = await inventory(page);
  await openDelete(page);
  await expect(dialog(page).getByRole('heading')).toHaveText(`Delete ${strange}?`);
  expect(await page.evaluate(() => window.auditInjected)).toBeUndefined();
  await dialog(page).getByLabel('How to move contents').selectOption('separate');
  await dialog(page).getByLabel('Destination for Ancestor', { exact: false }).selectOption('out');
  await dialog(page).getByRole('radio', { name: /Delete everything/ }).check();
  await dialog(page).getByRole('radio', { name: /Move contents/ }).check();
  await dialog(page).getByLabel('How to move contents').selectOption('together');
  await dialog(page).getByRole('combobox', { name: 'Destination', exact: true }).selectOption('out');
  await dialog(page).getByRole('button', { name: 'Move contents & delete', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  const after = await inventory(page);
  expect(validState(after)).toBe(true);
  expect(after.locations.find(l => l.id === 'b').parentId).toBe('a');
  expect(after.items.find(i => i.id === 'direct').locationId).toBe('out');
  expect(after.locations.filter(l => l.houseId === 'inactive')).toEqual(before.locations.filter(l => l.houseId === 'inactive'));
  expect(after.items.find(i => i.id === 'private')).toEqual(before.items.find(i => i.id === 'private'));
});

test('audit: delete transition disposes active photo crop and cancellation leaves escaped item intact', async ({ page }) => {
  await seed(page, fixture(), '/#room/r');
  const before = await inventory(page);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Edit location', exact: true }).click();
  await dialog(page).locator('[data-image-upload]').setInputFiles({ name: 'audit.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64') });
  await expect(dialog(page).locator('[data-photo-selection]')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Delete room', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(dialog(page).locator('[data-photo-selection]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toBeVisible();
  await expect(dialog(page).locator('form')).toHaveCount(0);
  expect(await inventory(page)).toEqual(before);
  await page.locator('[data-edit-item="direct"]').click();
  await expect(dialog(page).getByLabel('Item name')).toHaveValue(strange);
  await dialog(page).getByRole('button', { name: 'Delete item', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).not.toBeVisible();
  expect(await inventory(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('audit: last empty room remains removable when another house has occupied rooms', async ({ page }) => {
  const s = fixture();
  s.locations = s.locations.filter(l => ['r', 'inactive-r'].includes(l.id));
  s.items = s.items.filter(i => i.id === 'private');
  await seed(page, s);
  await openDelete(page);
  await dialog(page).getByRole('button', { name: 'Delete room', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  const after = await inventory(page);
  expect(after.locations).toEqual(s.locations.filter(l => l.id === 'inactive-r'));
  expect(after.items).toEqual(s.items);
  expect(validState(after)).toBe(true);
});

test('audit: inactive destinations cannot rescue last occupied room; second confirmation Escape is safe', async ({ page }) => {
  const s = fixture();
  s.locations = s.locations.filter(l => l.id !== 'out');
  await seed(page, s);
  const before = await inventory(page);
  await openDelete(page);
  await expect(dialog(page).getByRole('radio', { name: /Move contents/ })).toBeDisabled();
  await expect(dialog(page).getByRole('radio', { name: /Delete everything/ })).not.toBeChecked();
  await dialog(page).getByRole('radio', { name: /Delete everything/ }).check();
  await dialog(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog(page).getByRole('heading')).toHaveText(`Delete everything in ${strange}?`);
  await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toBeVisible();
  expect(await inventory(page)).toEqual(before);
});

test('audit: maximum names keep deletion header and safe controls reachable on a short mobile screen', async ({ page }) => {
  const s = fixture();
  s.locations.find(l => l.id === 'r').name = 'W'.repeat(100);
  s.items.find(i => i.id === 'direct').name = 'W'.repeat(150);
  await page.setViewportSize({ width: 320, height: 480 });
  await seed(page, s);
  await page.getByRole('combobox', { name: 'Color theme' }).selectOption('dark');
  await openDelete(page);
  await dialog(page).getByLabel('How to move contents').selectOption('separate');
  await dialog(page).getByLabel('Destination for Descendant', { exact: false }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/deletion-audit-short-mobile.png' });
  await expect(dialog(page).getByRole('heading', { level: 2 })).toBeInViewport();
  await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  // Partial title visibility alone misses a tall fixed header squeezing every
  // destination field into a zero-height scroll area.
  expect(await dialog(page).locator('.delete-content').evaluate(el => el.clientHeight)).toBeGreaterThan(48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await dialog(page).evaluate(d => d.scrollWidth <= d.clientWidth)).toBe(true);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
});
