import { createAuditSession, saveAuditResult } from "./audit-runtime.mjs";
import os from "node:os";
import { writePerformanceReport } from "./audit-reports.mjs";

function summarize(samples) {
  const sorted = [...samples].sort((first, second) => first - second);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: samples };
}

function makeInventory(houses, locationsPerHouse, itemsPerHouse) {
  const inventory = { version: 1, houses: [], locations: [], items: [], scans: [], markers: [] };
  for (let house = 0; house < houses; house++) {
    inventory.houses.push({ id: `h${house}`, name: `House ${String(house).padStart(5, "0")}` });
    for (let location = 0; location < locationsPerHouse; location++) {
      inventory.locations.push({
        id: `l${house}-${location}`, parentId: location ? `l${house}-0` : null,
        ...(!location ? { houseId: `h${house}` } : {}), name: `Room ${house}-${location}`,
        description: "Household storage", color: "sage",
      });
    }
    for (let item = 0; item < itemsPerHouse; item++) {
      inventory.items.push({ id: `i${house}-${item}`, locationId: `l${house}-${item % locationsPerHouse}`, name: `Item ${house}-${item}`, notes: "Household object searchable note" });
    }
  }
  return inventory;
}

const session = await createAuditSession({ label: "performance" });
const { page, cdp } = session;
try {
  await page.addInitScript(() => {
    window.auditLongTasks = [];
    new PerformanceObserver(list => window.auditLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: "longtask", buffered: true });
  });
  await page.goto(session.baseURL);
  const result = {
    environment: { node: process.version, platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), browser: session.browser.version(), viewport: { width: 1440, height: 1000 }, date: new Date().toISOString() },
    methodology: {
      lock: "createAuditSession exclusive browser-audit lock held throughout",
      timer: "performance.now in browser; UI dispatch through two requestAnimationFrame callbacks includes scheduling and rendering; navigation is Playwright wall clock through load and two animation frames",
      statistics: "3 warmups, 12 measured samples, nearest-rank p95; load 2 warmups and 6 samples; deep-tree 3 warmups and 6 samples",
      cold: "HTTP cache disabled and browser cache cleared before each reload; same browser process and localStorage, not a fresh OS/process startup",
      storage: "UTF-8 JSON bytes reported; localStorage quota is browser-dependent; datasets are successfully written before loading",
      network: "external requests blocked; Firebase disabled by audit runtime",
    },
    datasets: {}, synthetic: {}, errors: session.errors,
  };
  const cases = [["typical", 10, 10, 200], ["inactive-heavy", 100, 10, 200], ["many-houses", 1000, 1, 2], ["active-heavy", 2, 100, 5000]];
  for (const [name, houses, locationsPerHouse, itemsPerHouse] of cases) {
    const inventory = makeInventory(houses, locationsPerHouse, itemsPerHouse);
    const json = JSON.stringify(inventory), bytes = Buffer.byteLength(json);
    await page.evaluate(value => { localStorage.clear(); localStorage.setItem("haven-inventory", value); }, json);
    const loads = { cold: [], warm: [] };
    for (const mode of ["cold", "warm"]) {
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: mode === "cold" });
      for (let iteration = 0; iteration < 8; iteration++) {
        if (mode === "cold") await cdp.send("Network.clearBrowserCache");
        const started = performance.now();
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector("[data-house-toggle]");
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (iteration >= 2) loads[mode].push(performance.now() - started);
      }
    }
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
    const browserResult = await page.evaluate(async () => {
      const { inventoryForHouse, replaceHouseInventory } = await import("/src/houses.js");
      const { createIndex, searchInventory, validState } = await import("/src/store.js");
      const inventory = JSON.parse(localStorage.getItem("haven-inventory"));
      const active = inventoryForHouse(inventory, "h0"), index = createIndex(active), samples = {};
      const measure = (key, operation) => {
        const durations = [];
        for (let iteration = 0; iteration < 15; iteration++) {
          const started = performance.now();
          operation(iteration);
          if (iteration >= 3) durations.push(performance.now() - started);
        }
        samples[key] = durations;
      };
      measure("validate", () => validState(inventory));
      measure("projection", () => inventoryForHouse(inventory, "h0"));
      measure("indexActive", () => createIndex(active));
      measure("searchActive", () => searchInventory(index, "item"));
      measure("replaceHouse", () => replaceHouseInventory(inventory, "h0", active));
      measure("stringify", () => JSON.stringify(inventory));
      measure("storageWrite", () => localStorage.setItem("haven-inventory", JSON.stringify(inventory)));
      const ui = { switch: [], filter: [], search: [], switchSync: [], filterSync: [], searchSync: [] };
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (let iteration = 0; iteration < 15; iteration++) {
        document.querySelector("[data-house-toggle]").click();
        let input = document.querySelector("[data-house-search]");
        let started = performance.now();
        input.value = iteration % 2 ? "House 00001" : "not found";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        let syncDuration = performance.now() - started;
        await frame();
        if (iteration >= 3) { ui.filter.push(performance.now() - started); ui.filterSync.push(syncDuration); }
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        started = performance.now();
        document.querySelector(`[data-house-option="${iteration % 2 ? 0 : 1}"]`).click();
        syncDuration = performance.now() - started;
        await frame();
        if (iteration >= 3) { ui.switch.push(performance.now() - started); ui.switchSync.push(syncDuration); }
        input = document.querySelector("#search");
        started = performance.now();
        input.value = iteration % 2 ? "Item" : "not found";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        syncDuration = performance.now() - started;
        await frame();
        if (iteration >= 3) { ui.search.push(performance.now() - started); ui.searchSync.push(syncDuration); }
      }
      return { samples, ui, longTasks: window.auditLongTasks, rows: document.querySelectorAll("[data-house-row]").length, valid: validState(inventory) };
    });
    const uiSamples = Object.fromEntries(Object.entries(browserResult.ui).map(([key, values]) => [`ui_${key}`, values]));
    result.datasets[name] = {
      houses, locations: houses * locationsPerHouse, items: houses * itemsPerHouse,
      activeLocations: locationsPerHouse, activeItems: itemsPerHouse, jsonUtf8Bytes: bytes, jsonUtf16Bytes: json.length * 2,
      valid: browserResult.valid, houseRows: browserResult.rows,
      loads: Object.fromEntries(Object.entries(loads).map(([key, values]) => [key, summarize(values)])),
      operations: Object.fromEntries(Object.entries({ ...browserResult.samples, ...uiSamples }).map(([key, values]) => [key, summarize(values)])),
      longTasks: browserResult.longTasks,
    };
    console.log(name, JSON.stringify({ bytes, operations: Object.fromEntries(Object.entries(result.datasets[name].operations).map(([key, values]) => [key, { median: values.medianMs, p95: values.p95Ms }])) }));
  }
  for (const [name, houses, locationsPerHouse, itemsPerHouse] of [["stress-1", 100, 100, 100], ["stress-2", 200, 100, 100], ["stress-4", 400, 100, 100]]) {
    const inventory = makeInventory(houses, locationsPerHouse, itemsPerHouse);
    const times = await page.evaluate(async inventory => {
      const { inventoryForHouse } = await import("/src/houses.js");
      const { createIndex } = await import("/src/store.js");
      const active = inventoryForHouse(inventory, "h0"), output = { projection: [], indexActive: [] };
      for (let iteration = 0; iteration < 15; iteration++) {
        let started = performance.now();
        inventoryForHouse(inventory, "h0");
        if (iteration >= 3) output.projection.push(performance.now() - started);
        started = performance.now();
        createIndex(active);
        if (iteration >= 3) output.indexActive.push(performance.now() - started);
      }
      return output;
    }, inventory);
    result.synthetic[name] = { houses, locations: houses * locationsPerHouse, items: houses * itemsPerHouse, jsonUtf8Bytes: Buffer.byteLength(JSON.stringify(inventory)), operations: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, summarize(values)])) };
  }
  result.synthetic.deepTree = await page.evaluate(async () => {
    const { createIndex } = await import("/src/store.js");
    const output = {};
    for (const depth of [500, 1000, 2000]) {
      const locations = Array.from({ length: depth }, (unused, position) => ({ id: `l${position}`, parentId: position ? `l${position - 1}` : null, name: "x", description: "", color: "sage" }));
      const items = locations.map((location, position) => ({ id: `i${position}`, locationId: location.id, name: "x", notes: "" })).reverse();
      const inventory = { locations, items }, samples = [];
      for (let iteration = 0; iteration < 9; iteration++) {
        const started = performance.now();
        createIndex(inventory);
        if (iteration >= 3) samples.push(performance.now() - started);
      }
      output[depth] = samples;
    }
    return output;
  });
  await saveAuditResult("performance", result);
  await writePerformanceReport(result);
} finally {
  await session.close();
}
