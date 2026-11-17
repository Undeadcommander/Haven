import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { validState } from '../src/store.js';

export function deletionFixture(containers = 100, items = 1000, deep = false) {
  const location = (id, parentId, name) => ({ id, parentId, name, description: '', color: 'sage' });
  const data = { version: 1, locations: [location('source', null, 'Source'), location('target', null, 'Target')], items: [], scans: [], markers: [] };
  for (let n = 0; n < containers; n++) data.locations.push(location(`c${n}`, deep && n ? `c${n - 1}` : 'source', `C${String(n).padStart(3, '0')}`));
  for (let n = 0; n < items; n++) data.items.push({ id: `i${n}`, name: `Item ${n}`, notes: '', locationId: n % 10 === 0 ? 'source' : `c${n % containers}` });
  for (const loc of data.locations) data.scans.push({ id: `s-${loc.id}`, assetId: `a-${loc.id}`, locationId: loc.id, name: 'fixture.obj', format: 'obj' });
  for (const item of data.items) {
    data.markers.push({ id: `local-${item.id}`, scanId: `s-${item.locationId}`, kind: 'item', targetId: item.id, position: [0, 0, 0] });
    if (item.locationId !== 'source') data.markers.push({ id: `outside-${item.id}`, scanId: 's-source', kind: 'item', targetId: item.id, position: [0, 0, 0] });
  }
  assert(validState(data));
  return data;
}

export async function isolate(context, { instrument = false } = {}) {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://127.0.0.1:5173' ? route.abort() : route.continue();
  });
  await context.route('**/src/firebase-config.json*', route => route.fulfill({ contentType: 'application/javascript', body: 'export default {enabled:false};' }));
  if (instrument) for (const [file, names] of [
    ['store.js', ['createIndex']], ['scan-data.js', ['pruneScanLinks']],
    ['location-tree.js', ['createLocationTree']], ['inventory-delete.js', ['removeLocation', 'removeItem']],
  ]) await context.route(`**/src/${file}*`, async route => {
    const response = await route.fetch();
    let body = await response.text();
    for (const name of names) {
      body = body.replace(`export function ${name}(`, `function auditOriginal_${name}(`);
      body += `\nexport function ${name}(...args) { const started = performance.now(); try { return auditOriginal_${name}(...args); } finally { const log = window.deletionCalls ||= {}; const entry = log['${name}'] ||= {calls:0,ms:0}; entry.calls++; entry.ms += performance.now()-started; } }\n`;
    }
    await route.fulfill({ response, body });
  });
  await context.addInitScript(() => {
    window.deletionWrites = [];
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      const start = performance.now();
      try { return set.call(this, key, value); }
      finally { if (key === 'haven-inventory') window.deletionWrites.push({ ms: performance.now() - start, characters: value.length }); }
    };
  });
}

export async function seed(page, data) {
  await page.goto('http://127.0.0.1:5173');
  await page.evaluate(data => { localStorage.clear(); localStorage.setItem('haven-inventory', JSON.stringify(data)); }, data);
  await page.reload();
  await page.waitForSelector('[data-location-settings="source"]');
  await frame(page);
  await page.evaluate(() => { window.deletionWrites = []; window.deletionCalls = {}; });
}
export const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
export async function action(page, action, argument) {
  return page.evaluate(async ({ action, argument }) => {
    const start = performance.now();
    const editor = () => document.querySelector('#editor');
    let submittedForm;
    const change = (selector, value) => { const el = editor().querySelector(selector); if (el.matches('[data-delete-record]')) el.focus(); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
    if (action === 'gear') document.querySelector('[data-location-settings="source"]').click();
    if (action === 'open') editor().querySelector('.editor-delete').click();
    if (action === 'separate' || action === 'together') change('[name="move-layout"]', action);
    if (action === 'delete') { const radio = editor().querySelector('[value="delete"]'); radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
    if (action === 'destination') change('[name="destination"]', argument);
    if (action === 'chooseSeparate') {
      change('[name="destination"]', 'target');
      while (!editor().querySelector('[name="item-destination-1"]')) {
        const next = editor().querySelector('[data-delete-page="1"]');
        if (!next || next.disabled) throw Error('Nested item destination not found');
        next.click();
      }
      change('[name="item-destination-1"]', 'target');
    }
    if (action === 'submit') { submittedForm = editor().querySelector('form'); submittedForm.requestSubmit(); }
    if (action === 'cancel') editor().querySelector('.modal-actions [data-cancel]').click();
    const syncMs = performance.now() - start;
    while (submittedForm && editor().open && editor().querySelector('form') === submittedForm &&
      submittedForm.querySelector('[type=submit]')?.disabled && performance.now() - start < 10_000)
      await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { syncMs, paintedMs: performance.now() - start };
  }, { action, argument });
}
export async function structure(page) {
  return page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    editorNodes: document.querySelector('#editor').querySelectorAll('*').length,
    splitSelects: document.querySelectorAll('[data-delete-separate] select').length,
    options: document.querySelectorAll('#editor option').length,
    writes: window.deletionWrites,
    calls: window.deletionCalls,
  }));
}
async function memory(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  return { ...(await cdp.send('Runtime.getHeapUsage')), ...(await cdp.send('Memory.getDOMCounters')) };
}
async function open(page) { await action(page, 'gear'); return action(page, 'open'); }
const persisted = page => page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));

export async function runAudit() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--enable-precise-memory-info'] });
  const result = { date: new Date().toISOString(), browser: browser.version(), methodology: 'Existing Vite :5173; external requests blocked; Firebase disabled. Single bounded samples are diagnostic, not timing thresholds. Browser sync dispatch and two animation frames; GC heap/DOM counters. Other agents may contend for CPU. Wrapper timings overlap (inclusive).', datasets: {}, errors: [], sourceHashes: {} };
  await mkdir('test-results', { recursive: true });
  const report = resolve('test-results/deletion-performance-audit.json');
  try {
    for (const file of ['src/main.js', 'src/deletion-moves.js', 'src/inventory-delete.js', 'src/account.js', 'src/store.js', 'src/scan-data.js', 'src/features.css']) result.sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
    for (const [name, containers, items, deep] of [['wide-100', 100, 1000, false], ['wide-200', 200, 2000, false], ['deep-120', 120, 600, true]]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await isolate(context, { instrument: true });
      const page = await context.newPage();
      page.on('pageerror', error => result.errors.push(`${name}: ${error.message}`));
      const cdp = await context.newCDPSession(page);
      const data = deletionFixture(containers, items, deep);
      const entry = result.datasets[name] = { containers, items, deep, fixtureBytes: Buffer.byteLength(JSON.stringify(data)) };
      console.log(`Measuring ${name}`);
      await seed(page, data);
      entry.baseline = await memory(cdp);
      entry.open = await open(page);
      entry.default = await structure(page);
      assert.equal(entry.default.splitSelects, 0, 'Default open must stay lazy');
      entry.deleteChoice = await action(page, 'delete');
      entry.deleteConfirm = await action(page, 'submit');
      entry.confirm = await structure(page);
      assert.equal(entry.confirm.options, 0);
      await action(page, 'cancel');
      assert.equal((await structure(page)).editorNodes, 0);
      assert.equal((await structure(page)).writes.length, 0);
      await open(page);
      entry.separate = await action(page, 'separate');
      entry.separateStructure = await structure(page);
      assert(entry.separateStructure.splitSelects <= 20, 'Only one page of destination controls may exist');
      entry.separateMemory = await memory(cdp);
      await action(page, 'together');
      entry.hiddenSeparate = await structure(page);
      await action(page, 'separate');
      assert.equal((await structure(page)).options, entry.separateStructure.options, 'Toggles must not append controls');
      await action(page, 'cancel');
      entry.afterClose = await memory(cdp);
      assert.equal((await structure(page)).editorNodes, 0);
      // Measure the three commits from identical inventory, including real local persistence.
      for (const mode of ['together', 'separate', 'delete']) {
        await seed(page, data);
        await open(page);
        if (mode === 'delete') { await action(page, 'delete'); await action(page, 'submit'); }
        else if (mode === 'separate') { await action(page, 'separate'); await action(page, 'chooseSeparate'); }
        else await action(page, 'destination', 'target');
        await page.evaluate(() => { window.deletionCalls = {}; window.deletionWrites = []; });
        const timing = await action(page, 'submit');
        const after = await persisted(page);
        assert(validState(after));
        assert(!after.locations.some(loc => loc.id === 'source'));
        assert.equal(after.items.length, mode === 'delete' ? 0 : items);
        assert.equal(after.scans.length, mode === 'delete' ? 1 : containers + 1);
        assert(!after.markers.some(marker => marker.scanId === 's-source'));
        const recorded = await structure(page);
        assert.equal(recorded.writes.length, 1, 'Exactly one committed inventory write');
        entry[`commit-${mode}`] = { timing, calls: recorded.calls, writes: recorded.writes, markersRemaining: after.markers.length };
      }
      await context.close();
      await writeFile(report, JSON.stringify(result, null, 2));
    }
    const context = await browser.newContext();
    await isolate(context);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await seed(page, deletionFixture(40, 400));
    const cycles = result.cycles = [];
    for (let n = 0; n < 16; n++) {
      await open(page);
      await action(page, 'separate');
      await action(page, 'cancel');
      assert.equal((await structure(page)).editorNodes, 0);
      if ([0, 5, 10, 15].includes(n)) cycles.push({ cycle: n + 1, ...await memory(cdp), structure: await structure(page) });
    }
    await context.close();
  } catch (error) { result.failure = error.stack; throw error; }
  finally { await writeFile(report, JSON.stringify(result, null, 2)); await browser.close(); console.log(report); }
  return result;
}

async function retentionProbe() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext();
  const observations = {};
  try {
    await isolate(context);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await seed(page, deletionFixture(30, 150));
    observations.baseline = await memory(cdp);
    await action(page, 'gear');
    await action(page, 'cancel');
    observations.settingsOnlyClosed = await memory(cdp);
    await frame(page);
    observations.settingsOnlyClosedSecondGC = await memory(cdp);
    await open(page);
    await action(page, 'separate');
    observations.open = await memory(cdp);
    await action(page, 'cancel');
    observations.closedFirstGC = await memory(cdp);
    await frame(page);
    observations.closedSecondGC = await memory(cdp);
    await frame(page);
    observations.closedThirdGC = await memory(cdp);
    await action(page, 'gear');
    observations.replacedWithSettings = await memory(cdp);
    await action(page, 'cancel');
    observations.afterSettingsClose = await memory(cdp);
    await frame(page);
    observations.afterSettingsSecondGC = await memory(cdp);
    if (process.argv.includes('--heap')) {
      const chunks = [];
      cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk));
      await cdp.send('HeapProfiler.takeHeapSnapshot');
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/deletion-performance-retention.heapsnapshot', chunks.join(''));
    }
    // Diagnostic only: test whether replacing the empty dialog releases native descendants.
    await page.evaluate(() => { const dialog = document.querySelector('#editor'); const replacement = document.createElement('dialog'); replacement.id = 'editor'; dialog.replaceWith(replacement); });
    observations.afterReplacingDialog = await memory(cdp);
    await frame(page);
    observations.afterReplacingDialogSecondGC = await memory(cdp);
    await seed(page, deletionFixture(30, 150));
    await open(page);
    await action(page, 'separate');
    await page.evaluate(() => {
      const dialog = document.querySelector('#editor');
      const form = dialog.querySelector('form');
      dialog.close();
      form.replaceChildren();
    });
    await frame(page);
    observations.clearFormChildrenFirstGC = await memory(cdp);
    await frame(page);
    observations.clearFormChildrenSecondGC = await memory(cdp);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/deletion-performance-retention.json', JSON.stringify(observations, null, 2));
    console.log(JSON.stringify(observations, null, 2));
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--retention')) await retentionProbe();
  else await runAudit();
}
