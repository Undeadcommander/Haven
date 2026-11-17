// Run with Node from the checkout root. Uses synthetic data and the shared audit lock.
// Optional: --workload=typical,wide | --workload=deep --depth=160 | --retention
// Default depth is 80; 160 is a deliberate stress case. Run after source integration settles.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { createAuditSession, pageMetrics, saveAuditResult, auditDirectory } from './audit-runtime.mjs';
import { validState } from '../src/store.js';

export function houseDeletionFixture({ houses = 10, sourceLocations = 60, rooms = 5, sourceItems = 600,
  otherLocations = 4, otherItems = 20, deep = false } = {}) {
  const data = { version: 1, houses: [], locations: [], items: [], scans: [], markers: [] };
  for (let h = 0; h < houses; h++) {
    data.houses.push({ id: `h${h}`, name: `House ${String(h).padStart(3, '0')}` });
    const count = h ? otherLocations : sourceLocations;
    const roots = h ? 1 : deep ? 1 : rooms;
    for (let n = 0; n < count; n++) {
      const id = `l${h}-${n}`, parentId = n < roots ? null : `l${h}-${deep && !h ? n - 1 : n % roots}`;
      data.locations.push({ id, parentId, ...(parentId === null ? { houseId: `h${h}` } : {}),
        name: `Space ${h}-${String(n).padStart(3, '0')}`, description: 'Synthetic audit storage', color: 'sage' });
      data.scans.push({ id: `s${h}-${n}`, assetId: `a${h}-${n}`, locationId: id, name: 'synthetic.obj', format: 'obj' });
    }
    for (let n = 0; n < (h ? otherItems : sourceItems); n++) {
      const location = n % count, id = `i${h}-${n}`;
      data.items.push({ id, locationId: `l${h}-${location}`, name: `Object ${h}-${n}`, notes: 'Synthetic household item' });
      data.markers.push({ id: `m${h}-${n}`, scanId: `s${h}-${location}`, kind: 'item', targetId: id, position: [0, 0, 0] });
      if (location >= roots) data.markers.push({ id: `p${h}-${n}`, scanId: `s${h}-${deep && !h ? 0 : location % roots}`,
        kind: 'item', targetId: id, position: [0, 0, 0] });
    }
  }
  assert(validState(data), 'Synthetic fixture must be valid');
  assert(Buffer.byteLength(JSON.stringify(data)) < 3_000_000, 'Keep fixtures below a bounded storage budget');
  return data;
}

export const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// Dispatch inside the page to avoid Playwright retaining element handles in DOM/heap probes.
export async function houseAction(page, action, value) {
  return page.evaluate(async ({ action, value }) => {
    const started = performance.now(), dialog = document.querySelector('#editor');
    let submittedForm = null;
    const find = selector => {
      const element = document.querySelector(selector);
      if (!element) throw Error(`Missing audit control: ${selector} (${action})`);
      return element;
    };
    const change = (selector, next) => {
      const element = find(selector);
      if (element.matches('[data-delete-record]')) element.focus();
      element.value = next;
      if (element.type === 'radio') element.checked = true;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (action === 'open') {
      find('[data-house-toggle]').click();
      find('[data-house-delete]').click();
    } else if (action === 'layout') change('#editor [name="move-layout"]', value);
    else if (action === 'mode') change(`#editor [name="delete-mode"][value="${value}"]`, value);
    else if (action === 'destination') change('#editor [name="destination"]', value);
    else if (action === 'choice') change(`#editor [name="${value.field}"]`, value.destination);
    else if (action === 'next' || action === 'previous') {
      const element = find(`#editor [data-delete-page="${action === 'next' ? 1 : -1}"]`);
      if (element.disabled) throw Error(`Cannot ${action} contents page`);
      element.click();
    } else if (action === 'cancel') find('#editor .modal-actions [data-cancel]').click();
    else if (action === 'submit') {
      const form = find('#editor form');
      if (!form.reportValidity()) throw Error(`Invalid audit form: ${[...form.querySelectorAll(':invalid')].map(e => e.name).join(',')}`);
      submittedForm = form;
      form.requestSubmit();
    } else if (action === 'house') {
      find('[data-house-toggle]').click();
      find(`[data-house-option="${value}"]`).click();
    } else if (action === 'rename') {
      find('[data-house-toggle]').click(); find('[data-house-rename]').click();
    } else throw Error(`Unknown action ${action}`);
    const syncMs = performance.now() - started;
    // Newer saves await the cross-tab write lock. Include that wait in completion.
    while (submittedForm && dialog.open && dialog.querySelector('form') === submittedForm &&
      submittedForm.querySelector('[type="submit"]')?.disabled && performance.now() - started < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const completedMs = performance.now() - started;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { syncMs, completedMs, paintedMs: performance.now() - started, open: dialog.open };
  }, { action, value });
}

async function structure(page) {
  return page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    editorNodes: document.querySelector('#editor').querySelectorAll('*').length,
    rows: document.querySelectorAll('#editor [data-delete-record]').length,
    options: document.querySelectorAll('#editor option').length,
    optionCharacters: [...document.querySelectorAll('#editor option')].reduce((n, option) => n + option.textContent.length, 0),
    page: document.querySelector('[data-delete-page-status]')?.textContent,
    errors: [...document.querySelectorAll('#editor [role="alert"]:not([hidden])')].map(e => e.textContent),
    writes: window.houseAuditWrites,
  }));
}

const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};
function timingSummary(samples) {
  return Object.fromEntries(Object.keys(samples[0]).map(key => [key, {
    syncMs: summary(samples.map(sample => sample[key].syncMs)),
    completedMs: summary(samples.map(sample => sample[key].completedMs)),
    paintedMs: summary(samples.map(sample => sample[key].paintedMs)),
  }]));
}

export async function runHouseDeletionAudit({ workloads = null, deepLocations = 80 } = {}) {
  assert(Number.isInteger(deepLocations) && deepLocations >= 25 && deepLocations <= 200, '--depth must be an integer from 25 to 200');
  const session = await createAuditSession({ label: 'house-deletion' });
  const { page, cdp } = session;
  // Shared-checkout edits must not inject Vite reloads into a timing cycle.
  await session.context.routeWebSocket('**', socket => socket.close());
  const result = {
    status: 'running', generatedAt: new Date().toISOString(), environment: { browser: session.browser.version(), node: process.version,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, viewport: { width: 1440, height: 1000 } },
    methodology: {
      isolation: 'Shared createAuditSession lock; fresh nonpersistent headless Edge context; loopback Vite only; Firebase disabled, all external HTTP(S) blocked, and WebSockets closed (including Vite HMR). No production/user data.',
      timing: 'performance.now: synchronous in-page DOM dispatch plus two requestAnimationFrame callbacks (paint opportunity, not proof of screen presentation). 3 warmup and 15 measured open/split/page/toggle/cancel cycles per workload. Nearest-rank p95 of 15 samples is diagnostic, not an SLA.',
      retention: 'Post-close two-frame settle, forced CDP GC, two more frames, then shared pageMetrics with another GC. Warmup baseline and 3 equal 5-cycle batches. CDP heap/DOM/listener counts; no retained element handles or heap snapshot. Compare within workload. Not process RSS, GPU, binary scan storage or a long-duration leak proof.',
      commit: 'Each operation starts from identical seeded data. 1 warmup + 3 measured commits per mode, including real guest localStorage persistence. completedMs includes waiting for disabled submit controls to release after an asynchronous save/write lock (bounded 10 seconds). Storage setItem and JSON.stringify inventory timings overlap total submit. Model-only removeHouse also measured independently.',
    }, sourceHashes: {}, workloads: {}, lastHouse: [], assertions: [], errors: session.errors,
  };
  const files = ['src/main.js', 'src/houses.js', 'src/deletion-moves.js', 'src/inventory-delete.js', 'src/scan-data.js', 'src/account.js',
    'src/account-sync.js', 'src/inventory-write-lock.js', 'src/style.css', 'src/features.css', 'src/house-switcher.css'];
  async function hashes() {
    return Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  }
  const check = (value, message) => { assert(value, message); result.assertions.push(message); };
  async function memory() {
    await settled(page); await cdp.send('HeapProfiler.collectGarbage'); await settled(page);
    const sample = await pageMetrics(cdp);
    return { heapUsed: sample.heap.usedSize, heapTotal: sample.heap.totalSize, ...sample.dom,
      connectedNodes: await page.evaluate(() => document.querySelectorAll('*').length) };
  }
  async function seed(data) {
    await page.evaluate(data => {
      localStorage.clear(); localStorage.setItem('haven-inventory', JSON.stringify(data));
      localStorage.setItem('haven-active-house:guest', 'h0');
      // Reload otherwise legitimately restores the previous commit's destination house.
      history.replaceState(null, '', '#');
    }, data);
    await page.reload(); await page.waitForSelector('[data-house-toggle]'); await settled(page);
    await page.evaluate(() => { window.houseAuditWrites = []; window.houseAuditStringifies = []; window.houseAuditLongTasks = []; });
  }
  async function closed() {
    const state = await structure(page);
    assert.equal(state.editorNodes, 0, 'Closed editor must release its descendants');
    assert.equal(state.writes.length, 0, 'Cancelling/toggling must not persist inventory');
  }
  async function cycle(capture = false) {
    const times = {};
    times.open = await houseAction(page, 'open');
    if (capture) {
      const state = await structure(page); result.current.bulk = state;
      assert.equal(state.rows, 0, 'Bulk dialog must not allocate separate-choice rows');
      result.current.bulkMemory = await memory();
    }
    times.separate = await houseAction(page, 'layout', 'separate');
    if (capture) {
      result.current.split = await structure(page);
      assert.equal(result.current.split.rows, 20, 'Separate choices must have one page of 20 rows');
    }
    times.next = await houseAction(page, 'next');
    if (capture) {
      result.current.secondPage = await structure(page);
      result.current.splitMemory = await memory();
    }
    times.previous = await houseAction(page, 'previous');
    times.together = await houseAction(page, 'layout', 'together');
    times.separateAgain = await houseAction(page, 'layout', 'separate');
    times.deleteMode = await houseAction(page, 'mode', 'delete');
    times.moveMode = await houseAction(page, 'mode', 'move');
    times.cancel = await houseAction(page, 'cancel');
    await closed();
    return times;
  }
  try {
    result.sourceHashes = await hashes();
    await session.context.addInitScript(() => {
      window.houseAuditWrites = []; window.houseAuditStringifies = []; window.houseAuditLongTasks = [];
      const original = Storage.prototype.setItem, stringify = JSON.stringify;
      Storage.prototype.setItem = function(key, value) {
        const started = performance.now();
        try { return original.call(this, key, value); }
        finally { if (key === 'haven-inventory') window.houseAuditWrites.push({ ms: performance.now() - started, characters: value.length }); }
      };
      JSON.stringify = function(value, ...args) {
        const tracked = value && Array.isArray(value.houses) && Array.isArray(value.locations) && Array.isArray(value.items);
        const started = performance.now();
        try { return stringify.call(this, value, ...args); }
        finally { if (tracked) window.houseAuditStringifies.push(performance.now() - started); }
      };
      new PerformanceObserver(list => window.houseAuditLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask' });
    });
    await page.goto(session.baseURL);
    const cases = [
      ['typical', { houses: 10, sourceLocations: 60, rooms: 5, sourceItems: 600 }],
      ['wide', { houses: 12, sourceLocations: 180, rooms: 30, sourceItems: 1800 }],
      ['deep', { houses: 8, sourceLocations: deepLocations, sourceItems: 800, deep: true }],
      ['many-houses', { houses: 300, sourceLocations: 30, rooms: 3, sourceItems: 1200, otherLocations: 2, otherItems: 5 }],
      ['inactive-heavy', { houses: 60, sourceLocations: 30, rooms: 3, sourceItems: 1200, otherLocations: 12, otherItems: 100 }],
    ];
    if (workloads) assert(workloads.every(name => cases.some(([candidate]) => candidate === name)), 'Unknown --workload; choose typical,wide,deep,many-houses,inactive-heavy');
    for (const [name, config] of cases.filter(([name]) => !workloads || workloads.includes(name))) {
      console.log(`house deletion: ${name}`);
      const data = houseDeletionFixture(config), entry = result.workloads[name] = { config,
        fixture: { houses: data.houses.length, locations: data.locations.length, items: data.items.length,
          scans: data.scans.length, markers: data.markers.length, bytes: Buffer.byteLength(JSON.stringify(data)) }, samples: [], retention: [], commits: {} };
      // Only a Node-side temporary alias; no browser element/object retention.
      result.current = entry;
      await seed(data);
      entry.freshClosedMemory = await memory();
      for (let n = 0; n < 3; n++) await cycle(n === 2);
      entry.retention.push({ cycle: 0, ...await memory() });
      for (let batch = 1; batch <= 3; batch++) {
        for (let n = 0; n < 5; n++) entry.samples.push(await cycle());
        entry.retention.push({ cycle: batch * 5, ...await memory() });
        console.log(`${name}: completed ${batch * 5}/15 measured cycles`);
      }
      entry.timings = timingSummary(entry.samples);
      entry.longTasks = await page.evaluate(() => window.houseAuditLongTasks);
      // A house switch closes a populated split dialog and invalidates its plan.
      await houseAction(page, 'open'); await houseAction(page, 'layout', 'separate');
      // Programmatic UI switching exercises the same switcher callback while modal is open.
      await houseAction(page, 'house', 1);
      await closed();
      await houseAction(page, 'house', 0);
      for (const mode of ['together', 'separate', 'delete']) {
        const commits = [];
        for (let n = 0; n < 4; n++) {
          await seed(data); await houseAction(page, 'open');
          if (mode === 'delete') {
            await houseAction(page, 'mode', 'delete'); await houseAction(page, 'submit');
            assert.equal((await structure(page)).options, 0, 'Second confirmation must release move choices');
          } else {
            await houseAction(page, 'destination', 'h1');
            if (mode === 'separate') {
              await houseAction(page, 'layout', 'separate');
              await houseAction(page, 'choice', { field: 'room-destination-0', destination: 'h2' });
            }
          }
          await page.evaluate(() => { window.houseAuditWrites = []; window.houseAuditStringifies = []; });
          const timing = await houseAction(page, 'submit');
          const recorded = await page.evaluate(() => ({ data: JSON.parse(localStorage.getItem('haven-inventory')),
            writes: window.houseAuditWrites, stringifies: window.houseAuditStringifies }));
          assert.equal(timing.open, false, `Commit ${mode} must close the dialog: ${JSON.stringify(await structure(page))}`);
          assert(validState(recorded.data), 'Committed inventory and scan links must be valid');
          assert(!recorded.data.houses.some(h => h.id === 'h0'));
          assert.equal(recorded.writes.length, 1, 'A commit must write inventory exactly once');
          const expectedItems = mode === 'delete' ? data.items.filter(i => !i.id.startsWith('i0-')).length : data.items.length;
          assert.equal(recorded.data.items.length, expectedItems);
          assert.equal(recorded.data.scans.length, mode === 'delete' ? data.scans.length - config.sourceLocations : data.scans.length);
          assert.equal(recorded.data.markers.length, mode === 'delete' ? data.markers.filter(m => !m.scanId.startsWith('s0-')).length : data.markers.length);
          if (n) commits.push({ timing, writes: recorded.writes, stringifies: recorded.stringifies });
        }
        entry.commits[mode] = { samples: commits, syncMs: summary(commits.map(x => x.timing.syncMs)),
          completeMs: summary(commits.map(x => x.timing.completedMs)), paintedMs: summary(commits.map(x => x.timing.paintedMs)) };
      }
      entry.modelOnly = await page.evaluate(async data => {
        const { removeHouse } = await import('/src/houses.js');
        const output = {};
        for (const mode of ['move', 'delete']) {
          const samples = [];
          for (let n = 0; n < 9; n++) {
            const started = performance.now(); removeHouse(data, 'h0', { mode, destinationHouseId: 'h1' });
            if (n >= 3) samples.push(performance.now() - started);
          }
          output[mode] = samples;
        }
        return output;
      }, data);
      delete result.current;
      await saveAuditResult('house-deletion', result);
      console.log(JSON.stringify({ name, timings: entry.timings, retention: entry.retention }));
    }
    // Move one container and one item independently; old cross-scan pins must disappear.
    const staleData = houseDeletionFixture({ houses: 3, sourceLocations: 6, rooms: 1, sourceItems: 12 });
    await seed(staleData); await houseAction(page, 'open'); await houseAction(page, 'destination', 'h1');
    await houseAction(page, 'layout', 'separate');
    await houseAction(page, 'choice', { field: 'container-destination-0', destination: 'l2-0' });
    await houseAction(page, 'choice', { field: 'item-destination-2', destination: 'l2-0' });
    await houseAction(page, 'submit');
    result.staleScanLinks = await page.evaluate(() => JSON.parse(localStorage.getItem('haven-inventory')));
    check(validState(result.staleScanLinks), 'Independent split preserves valid scan/marker references');
    check(!result.staleScanLinks.markers.some(m => m.id === 'p0-1' || m.targetId === 'i0-2'), 'Old external pins and independently moved item pins are removed');
    check(result.staleScanLinks.markers.some(m => m.id === 'm0-1'), 'Internal container scan pins survive independent subtree movement');
    for (const occupied of [false, true]) {
      const data = occupied ? houseDeletionFixture({ houses: 1 }) : { version: 1, houses: [{ id: 'h0', name: 'Only home' }], locations: [], items: [], scans: [], markers: [] };
      await seed(data);
      const probe = await page.evaluate(async () => {
        const button = document.querySelector('[data-house-delete]'); button.click();
        const { removeHouse } = await import('/src/houses.js');
        const inventory = JSON.parse(localStorage.getItem('haven-inventory'));
        const errors = [];
        for (const mode of ['move', 'delete']) try { removeHouse(inventory, 'h0', { mode }); } catch (error) { errors.push(error.message); }
        return { disabled: button.disabled, open: document.querySelector('#editor').open, errors, writes: window.houseAuditWrites };
      });
      assert(probe.disabled && !probe.open && probe.writes.length === 0);
      assert.deepEqual(probe.errors, Array(2).fill('Create another house before deleting your last house.'));
      await houseAction(page, 'rename');
      probe.editorDisabled = await page.evaluate(() => document.querySelector('#editor .editor-delete').disabled);
      assert(probe.editorDisabled); await houseAction(page, 'cancel');
      result.lastHouse.push({ occupied, ...probe });
    }
    check(session.errors.length === 0, 'No browser page errors');
    result.sourceHashesAfter = await hashes();
    result.sourceChangedDuringRun = files.filter(file => result.sourceHashes[file] !== result.sourceHashesAfter[file]);
    check(result.sourceChangedDuringRun.length === 0, 'Measured source files remained unchanged throughout the audit');
    result.status = 'complete';
  } catch (error) {
    result.status = 'failed';
    result.failure = error.stack;
    result.failureState = await structure(page).catch(() => null);
    process.exitCode = 1;
    console.error(error.stack);
  } finally {
    delete result.current;
    result.sourceHashesAfter = await hashes();
    result.sourceChangedDuringRun = files.filter(file => result.sourceHashes[file] !== result.sourceHashesAfter[file]);
    await saveAuditResult('house-deletion', result);
    const ms = n => n == null ? '?' : n.toFixed(1);
    const rows = Object.entries(result.workloads).map(([name, entry]) => {
      const t = entry.timings, first = entry.retention[0], last = entry.retention.at(-1);
      return `| ${name} | ${entry.fixture.houses}/${entry.fixture.locations}/${entry.fixture.items} | ${ms(t?.open.syncMs.median)}/${ms(t?.open.syncMs.p95)} | ${ms(t?.separate.syncMs.median)}/${ms(t?.separate.syncMs.p95)} | ${ms(t?.next.syncMs.median)}/${ms(t?.next.syncMs.p95)} | ${entry.split?.options}/${entry.secondPage?.options} | ${first?.heapUsed} → ${last?.heapUsed} | ${first?.nodes} → ${last?.nodes} | ${first?.jsEventListeners} → ${last?.jsEventListeners} |`;
    });
    const commitRows = Object.entries(result.workloads).flatMap(([name, entry]) => Object.entries(entry.commits).map(([mode, commit]) => `| ${name} | ${mode} | ${ms(commit.completeMs.median)} | ${ms(commit.paintedMs.median)} | ${ms(summary(commit.samples.flatMap(x => x.writes.map(w => w.ms))).median)} | ${ms(summary(commit.samples.flatMap(x => x.stringifies)).median)} |`));
    await writeFile(resolve(auditDirectory, 'house-deletion.md'), `# House deletion resource audit\n\nRun: ${result.generatedAt}. ${JSON.stringify(result.environment)}\n\n${Object.values(result.methodology).join('\n\n')}\n\n| Workload | Houses/locations/items | Open sync median/p95 ms | Split sync median/p95 ms | Next sync median/p95 ms | Split/next options | Closed heap bytes | Closed DOM nodes | Closed listeners |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n| Workload | Mode | Commit complete median ms | Two-frame median ms | setItem median ms | stringify median ms |\n|---|---|---:|---:|---:|---:|\n${commitRows.join('\n')}\n\nAssertions: ${result.assertions.join('; ')}. Each cycle also asserts empty closed editor and zero inventory writes; each commit asserts one write, valid state/scan links and expected item/scan/marker counts.\n\nBrowser errors: ${JSON.stringify(result.errors)}. Failure: ${result.failure || 'none'}. Source changes during run: ${JSON.stringify(result.sourceChangedDuringRun)}.\n\nRead JSON for individual samples, open/split GC allocation counters, fixture sizes, model-only samples, and source hashes. A stable short post-GC series does not establish leak freedom; renderer/native caches and long-term behavior remain unmeasured. The split row count is bounded, but option count and full path text per row still scale with total locations and depth.\n`);
    await session.close();
    console.log(resolve(auditDirectory, 'house-deletion.json'));
    console.log(resolve(auditDirectory, 'house-deletion.md'));
  }
  return result;
}

// A focused diagnostic distinguishes bounded last-dialog retention from cumulative growth.
// The last two variants alter only the isolated test DOM, never application source.
export async function runHouseDeletionRetentionProbe() {
  const session = await createAuditSession({ label: 'house-deletion-retention' });
  const { page, cdp } = session;
  await session.context.routeWebSocket('**', socket => socket.close());
  const result = { generatedAt: new Date().toISOString(), browser: session.browser.version(),
    methodology: 'Same synthetic fixture and shared isolated runtime. Double post-frame GC for each sample. No element handles, snapshots, or DOM-inspector queries during samples. Diagnostic DOM replacement/option emptying only after normal lifecycle samples.',
    samples: [], errors: session.errors };
  const data = houseDeletionFixture();
  async function sample(label) {
    await settled(page); await cdp.send('HeapProfiler.collectGarbage'); await settled(page);
    const m = await pageMetrics(cdp);
    const state = await structure(page);
    result.samples.push({ label, heapUsed: m.heap.usedSize, ...m.dom, connectedNodes: state.nodes,
      editorNodes: state.editorNodes, rows: state.rows, options: state.options });
  }
  async function split() {
    await houseAction(page, 'open'); await houseAction(page, 'layout', 'separate');
    await houseAction(page, 'next'); await houseAction(page, 'previous');
  }
  try {
    await page.goto(session.baseURL);
    await page.evaluate(data => {
      localStorage.clear(); localStorage.setItem('haven-inventory', JSON.stringify(data));
      history.replaceState(null, '', '#');
    }, data);
    await page.reload(); await page.waitForSelector('[data-house-toggle]');
    await sample('fresh baseline');
    await houseAction(page, 'open'); await houseAction(page, 'cancel'); await sample('bulk closed');
    await split(); await sample('split open');
    await houseAction(page, 'cancel'); await sample('split closed');
    await sample('split closed repeated GC');
    for (let n = 0; n < 10; n++) { await split(); await houseAction(page, 'cancel'); }
    await sample('10 more split cycles closed');
    await houseAction(page, 'rename'); await houseAction(page, 'cancel');
    await sample('after replacing with rename form');
    await split();
    await page.evaluate(() => { document.querySelectorAll('#editor select').forEach(select => select.replaceChildren()); });
    await houseAction(page, 'cancel'); await sample('diagnostic empty all options before close');
    await page.evaluate(() => {
      const old = document.querySelector('#editor'), next = document.createElement('dialog');
      next.id = old.id; old.replaceWith(next);
    });
    await sample('diagnostic replace empty dialog');
    assert.deepEqual(session.errors, []);
  } catch (error) { result.failure = error.stack; process.exitCode = 1; }
  finally {
    await saveAuditResult('house-deletion-retention', result);
    const rows = result.samples.map(s => `| ${s.label} | ${s.heapUsed} | ${s.nodes} | ${s.jsEventListeners} | ${s.editorNodes} |`);
    await writeFile(resolve(auditDirectory, 'house-deletion-retention.md'), `# House deletion retention probe\n\n${result.methodology}\n\n| Phase | Heap bytes | CDP DOM nodes | Listeners | Connected editor descendants |\n|---|---:|---:|---:|---:|\n${rows.join('\n')}\n\nErrors: ${JSON.stringify(result.errors)}. Failure: ${result.failure || 'none'}. Stable counts across ten cycles only rule out proportional growth in this short workload. Diagnostic variants are evidence about retained option descendants, not a source fix.\n`);
    await session.close();
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--retention')) await runHouseDeletionRetentionProbe();
  else await runHouseDeletionAudit({
    workloads: process.argv.find(value => value.startsWith('--workload='))?.split('=')[1].split(',') || null,
    deepLocations: Number(process.argv.find(value => value.startsWith('--depth='))?.split('=')[1] || 80),
  });
}
