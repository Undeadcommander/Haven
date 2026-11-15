import { createAuditSession, pageMetrics, saveAuditResult } from './audit-runtime.mjs';
import { initialState } from '../src/store.js';
import { addHouse } from '../src/houses.js';
import { writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';

const inventory = addHouse(initialState(), 'Lake house', 'lake');
const photo = { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64') };
const session = await createAuditSession({ label: 'leaks' });
const { page, cdp } = session;
const result = { generated: new Date().toISOString(), batches: {}, errors: session.errors, assertions: [] };
try {
  await page.addInitScript(seed => {
    localStorage.setItem('haven-inventory', JSON.stringify(seed));
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {
      if (this.type === 'file' && this.accept.includes('application/json')) {
        const data = new DataTransfer();
        data.items.add(new File([JSON.stringify(seed)], 'backup.json', { type: 'application/json' }));
        this.files = data.files;
        queueMicrotask(() => this.dispatchEvent(new Event('change', { bubbles: true })));
        return;
      }
      return click.call(this);
    };
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener, active = new Map();
    const key = (target, type, capture) => `${target === window ? 'window' : 'document'}:${type}:${!!capture}`;
    EventTarget.prototype.addEventListener = function(type, fn, options) {
      if ((this === window || this === document) && fn) {
        const listenerKey = key(this, type, typeof options === 'boolean' ? options : options?.capture);
        if (!active.has(listenerKey)) active.set(listenerKey, new Set());
        active.get(listenerKey).add(fn);
      }
      return add.call(this, type, fn, options);
    };
    EventTarget.prototype.removeEventListener = function(type, fn, options) {
      if (this === window || this === document) active.get(key(this, type, typeof options === 'boolean' ? options : options?.capture))?.delete(fn);
      return remove.call(this, type, fn, options);
    };
    let contexts = 0, losses = 0;
    const get = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const ctx = get.call(this, type, ...args);
      if (ctx && /^webgl2?$/.test(type) && !seen.has(ctx)) {
        seen.add(ctx); contexts++;
        const extension = ctx.getExtension.bind(ctx);
        ctx.getExtension = function(name) {
          const value = extension(name);
          if (name === 'WEBGL_lose_context' && value && !value.__auditWrapped) {
            const lose = value.loseContext.bind(value);
            value.loseContext = () => { losses++; return lose(); };
            value.__auditWrapped = true;
          }
          return value;
        };
      }
      return ctx;
    };
    window.auditCounts = () => ({ globals: Object.fromEntries([...active].map(([listenerKey,listeners]) => [listenerKey,listeners.size]).filter(([,count]) => count)), contexts, losses });
  }, inventory);
  await page.goto(session.baseURL);
  await page.locator('[data-house-toggle]').waitFor();
  async function measure(label) {
    await page.waitForTimeout(200);
    const metrics = await pageMetrics(cdp);
    return { label, heapUsed: metrics.heap.usedSize, documents: metrics.dom.documents, nodes: metrics.dom.nodes, listeners: metrics.dom.jsEventListeners, instrumentation: await page.evaluate(() => window.auditCounts()) };
  }
  async function choose(name) {
    await page.locator('[data-house-toggle]').click();
    await page.getByRole('searchbox', { name: 'Search houses' }).fill(name);
    await page.locator('[data-house-list]').getByRole('button', { name, exact: true }).click();
    await page.locator('[data-house-name]').getByText(name, { exact: true }).waitFor();
  }
  async function houseCycle() {
    await choose('Lake house'); await choose('My home');
    await page.locator('[data-house-toggle]').click();
    await page.getByRole('searchbox', { name: 'Search houses' }).fill('missing');
    await page.keyboard.press('Escape');
  }
  async function dialogCycle() {
    await page.locator('[data-add-root]').first().click();
    await page.evaluate(({ bytes, name, mime }) => { const input = document.querySelector('[data-image-upload]'), data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(bytes), character => character.charCodeAt(0))], name, { type: mime })); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); }, { bytes: photo.buffer.toString('base64'), name: photo.name, mime: photo.mimeType });
    await page.locator('[data-photo-editor]').waitFor();
    await page.getByRole('button', { name: 'Use photo', exact: true }).click();
    await page.locator('[data-image-status]').getByText('Photo ready', { exact: false }).waitFor();
    await page.locator('#editor').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Open Living room', exact: true }).click();
    await page.getByRole('button', { name: 'Add item', exact: true }).first().click();
    await page.locator('#editor').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('[data-home]').first().click();
    await page.getByRole('button', { name: 'Restore a backup', exact: true }).first().click();
    await page.locator('#editor').getByText('Restore this backup?').waitFor();
    await page.locator('#editor').getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  async function scanCycle(iteration) {
    await page.getByRole('button', { name: 'Open Living room', exact: true }).click();
    await page.getByRole('button', { name: /^(Add|Open) 3D scan$/ }).click();
    await page.locator('[data-scan-file]').waitFor({ state: 'attached' });
    await page.locator('[data-import-scan]:enabled').waitFor();
    for (let replacement = 0; replacement < 2; replacement++) {
      const name = `triangle${iteration * 2 + replacement}.obj`;
      await page.evaluate(({ name, text }) => { const input = document.querySelector('[data-scan-file]'), data = new DataTransfer(); data.items.add(new File([text], name, { type: 'text/plain' })); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); }, { name, text: `v 0 0 0\nv ${iteration + replacement + 1} 0 0\nv 0 1 0\nf 1 2 3\n` });
      await page.locator('.scan-status').getByText(`Loaded ${name}`, { exact: false }).waitFor();
      await page.locator('[data-import-scan]:enabled').waitFor();
    }
    await page.getByRole('button', { name: 'Close scan', exact: true }).click();
    await page.locator('.scan-dialog').waitFor({ state: 'detached' });
    await page.locator('[data-home]').first().click();
  }
  async function batches(name, cycle, size) {
    for (let iteration = 0; iteration < size; iteration++) await cycle(iteration);
    const samples = [await measure('warmup')];
    for (let batch = 1; batch <= 3; batch++) {
      for (let iteration = 0; iteration < size; iteration++) await cycle(batch * size + iteration);
      samples.push(await measure(`batch ${batch}`));
    }
    result.batches[name] = { cyclesPerBatch: size, samples };
  }
  await batches('houses', houseCycle, 8);
  await batches('dialogs', dialogCycle, 4);
  await batches('scans', scanCycle, 3);
  const snapshot = createWriteStream('test-results/audit/leaks.heapsnapshot');
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => snapshot.write(chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await new Promise((resolve, reject) => { snapshot.on('error', reject); snapshot.end(resolve); });
  await cdp.send('DOM.enable');
  const detached = await cdp.send('DOM.getDetachedDomNodes');
  result.detached = { count: detached.detachedNodes.length, roots: detached.detachedNodes.reduce((counts, { treeNode }) => { counts[treeNode.nodeName] = (counts[treeNode.nodeName] || 0) + 1; return counts; }, {}) };
  await page.evaluate(() => { const text = File.prototype.text; File.prototype.text = async function() { window.readWaiting = true; await new Promise(resolve => window.releaseRead = resolve); return text.call(this); }; });
  await page.getByRole('button', { name: 'Restore a backup', exact: true }).first().click();
  await page.waitForFunction(() => window.readWaiting);
  await choose('Lake house'); await choose('My home');
  await page.evaluate(() => window.releaseRead());
  await page.locator('#toast').getByText('Your account or inventory changed', { exact: false }).waitFor();
  assert.equal(await page.locator('#editor').evaluate(element => element.open), false);
  result.assertions.push('Late backup read rejected after switching away and back');
  const samples = result.batches.houses.samples;
  for (const listenerKey of ['document:click:true', 'window:resize:false', 'window:scroll:true']) assert.equal(samples.at(-1).instrumentation.globals[listenerKey] || 0, samples[0].instrumentation.globals[listenerKey] || 0, `global listener imbalance: ${listenerKey}`);
  result.assertions.push('Switcher global listeners return to warmup baseline');
  const counts = result.batches.scans.samples.at(-1).instrumentation;
  assert.ok(counts.contexts > 0, 'scan workload must create WebGL contexts');
  assert.equal(counts.contexts, counts.losses, 'created WebGL contexts should be explicitly lost');
  result.assertions.push('Each observed scan WebGL context explicitly lost');
  assert.deepEqual(session.errors, []);
} catch (error) {
  result.failure = error.stack;
  result.failureState = await page.evaluate(() => ({ url: location.href, status: document.querySelector('.scan-status')?.textContent || null })).catch(() => null);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await saveAuditResult('leaks', result);
  const rows = Object.entries(result.batches).flatMap(([name, batch]) => batch.samples.map(sample => `| ${name} | ${sample.label} | ${sample.heapUsed} | ${sample.documents} | ${sample.nodes} | ${sample.listeners} | ${sample.instrumentation.contexts}/${sample.instrumentation.losses} |`));
  await writeFile('test-results/audit/leaks.md', `# Leak audit\n\nRun: ${result.generated}. Isolated headless Edge with blocked external network and disabled Firebase; one warmup and three equal batches per workload, forced CDP GC before each measurement. See leaks.json for full instrumentation.\n\n| Workload | Sample | Heap bytes | Documents | Nodes | JS listeners | WebGL created/lost |\n|---|---|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\nHouse batches use 8 switch-away/switch-back and picker/filter/close cycles; dialog batches use 4 room editor/photo, item editor, navigation and cancelled backup restore cycles; scan batches use 3 viewer open/two OBJ imports/close cycles. The same page is used across workloads, so compare within each workload.\n\nGlobal document/window listener instrumentation only counts explicit add/remove, and does not model once/signal removal; the switcher listeners under test use explicit removal. A late backup read was released after switching houses away and back. Assertions: ${result.assertions.join('; ') || 'none completed'}. Errors: ${JSON.stringify(result.errors)}. ${result.failure ? `Failure: ${result.failure}` : ''}\n\nThe first file-chooser-based run showed increasing detached DOM and listeners. Snapshot retaining paths included Global handles → DevTools console → file input → detached form, so the final run injects files in-page, avoiding that automation artifact. The final snapshot precedes the detached DOM query and is saved as leaks.heapsnapshot; detached DOM query returned ${result.detached?.count ?? 'unknown'} root records (some are attributes, not separate trees). Heap growth alone is not proof of a leak: V8, Three.js, browser and automation caches remain possible owners. No process RSS, GPU VRAM, timer/subscription totals, physical GPU, mobile XR, long duration, large scans or many-house scale was measured. Explicit context loss is a call count, not a measurement of GPU resource reclamation.\n`);
  await session.close();
}
