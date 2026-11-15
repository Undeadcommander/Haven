import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createAuditSession, pageMetrics, saveAuditResult, auditDirectory } from "./audit-runtime.mjs";
import { triangleGLB } from "../tests/helpers/scan-fixtures.js";
import { resolve } from "node:path";
import { writeRamReport } from "./audit-reports.mjs";

const exec = promisify(execFile);
const inventory = { version: 1, houses: [], locations: [], items: [], scans: [], markers: [] };
for (let houseIndex = 0; houseIndex < 11; houseIndex++) {
  inventory.houses.push({ id: `house-${houseIndex}`, name: houseIndex === 10 ? "Empty house" : `House ${houseIndex}` });
  if (houseIndex === 10) continue;
  for (let roomIndex = 0; roomIndex < 10; roomIndex++) {
    const id = `room-${houseIndex}-${roomIndex}`;
    inventory.locations.push({ id, houseId: `house-${houseIndex}`, parentId: null, name: `Room ${houseIndex}-${roomIndex}`, description: "A room for household belongings.", color: "sage" });
    for (let itemIndex = 0; itemIndex < 50; itemIndex++) inventory.items.push({ id: `item-${houseIndex}-${roomIndex}-${itemIndex}`, locationId: id, name: `Household item ${houseIndex}-${roomIndex}-${itemIndex}`, notes: "Stored here for easy retrieval." });
  }
}
inventory.scans.push({ id: "scan-1", assetId: "asset-1", locationId: "room-0-0", name: "Generated room", format: "glb" });
const glb = triangleGLB({ triangles: 20000 });
const result = { generatedAt: new Date().toISOString(), fixture: { houses: 11, populatedHouses: 10, rooms: 100, items: 5000, scanTriangles: 20000, scanBytes: glb.length, inventoryJsonBytes: Buffer.byteLength(JSON.stringify(inventory)) }, phases: {}, errors: [] };
const session = await createAuditSession({ label: "ram" });
const { page, cdp, browser } = session;
try {
  const browserCDP = await browser.newBrowserCDPSession();
  async function processes() {
    const { processInfo } = await browserCDP.send("SystemInfo.getProcessInfo");
    const ids = processInfo.map((process) => process.id).filter(Number.isInteger);
    const code = `$ErrorActionPreference='SilentlyContinue'; @(Get-Process -Id ${ids.join(",")} | Select-Object Id,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { windowsHide: true });
    const parsed = JSON.parse(stdout || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const byId = new Map(rows.map((process) => [process.Id, process]));
    const entries = processInfo.map((process) => ({ id: process.id, type: process.type, workingSetBytes: byId.get(process.id)?.WorkingSet64 ?? null, privateBytes: byId.get(process.id)?.PrivateMemorySize64 ?? null }));
    return { entries, missingIds: entries.filter((entry) => entry.workingSetBytes === null).map((entry) => entry.id), workingSetBytes: entries.reduce((total, entry) => total + (entry.workingSetBytes || 0), 0), privateBytes: entries.reduce((total, entry) => total + (entry.privateBytes || 0), 0) };
  }
  async function snapshot() {
    const metrics = await pageMetrics(cdp);
    return { heap: metrics.heap, dom: metrics.dom, performance: { JSHeapUsedSize: metrics.metrics.JSHeapUsedSize, JSHeapTotalSize: metrics.metrics.JSHeapTotalSize }, processes: await processes() };
  }
  async function phase(name, operation) {
    const samples = [];
    let running = true;
    const sampler = (async () => {
      while (running) {
        try {
          const heap = await cdp.send("Runtime.getHeapUsage");
          samples.push({ at: Date.now(), heap, processes: await processes() });
        } catch (error) { samples.push({ at: Date.now(), error: error.message }); }
        if (running) await delay(200);
      }
    })();
    let output;
    try { output = await operation(); await delay(1200); }
    finally { running = false; await sampler; }
    result.phases[name] = { output, samples, settled: await snapshot() };
    console.log(name, "samples", samples.length, "heap", result.phases[name].settled.heap.usedSize, "private", result.phases[name].settled.processes.privateBytes);
  }
  result.phases.blank = { settled: await snapshot() };
  await phase("initialApp", async () => { await page.goto(session.baseURL); await page.locator("[data-house-toggle]").waitFor(); });
  await page.evaluate(async ({ inventory, bytes }) => {
    localStorage.setItem("haven-inventory", JSON.stringify(inventory));
    localStorage.setItem("haven-active-house:guest", "house-0");
    const { putAsset } = await import("/src/scan-storage.js");
    await putAsset("asset-1", new Blob([new Uint8Array(bytes)], { type: "model/gltf-binary" }));
  }, { inventory, bytes: [...glb] });
  await phase("populatedHouse", async () => { await page.reload(); await page.locator('[data-open="room-0-0"]').first().waitFor(); });
  result.storage = await page.evaluate(async () => ({ localStorageUtf16Bytes: Object.keys(localStorage).reduce((total, key) => total + 2 * (key.length + localStorage.getItem(key).length), 0), estimate: await navigator.storage.estimate(), assetBytes: (await (await import("/src/scan-storage.js")).getAsset("asset-1")).size }));
  await phase("emptyHouse", async () => { await page.locator("[data-house-toggle]").click(); await page.locator('[data-house-option="10"]').click(); await page.getByRole("heading", { name: "Home, organized." }).waitFor(); });
  await page.locator("[data-house-toggle]").click(); await page.locator('[data-house-option="0"]').click();
  await page.locator('[data-open="room-0-0"]').first().click();
  await phase("viewerOpen", async () => { await page.locator("[data-room-scan]").click(); await page.locator("[data-reset-camera]:enabled").waitFor({ timeout: 30000 }); return await page.locator(".scan-status").textContent(); });
  await phase("viewerClosed", async () => { await page.locator("[data-close-scan]").click(); await page.locator(".scan-dialog").waitFor({ state: "detached" }); });
  let backup;
  await phase("export", async () => { const downloadPromise = page.waitForEvent("download"); await page.locator(".sidebar [data-export]").click(); const download = await downloadPromise; backup = resolve(auditDirectory, "ram-backup.json"); await download.saveAs(backup); return { backupBytes: (await (await import("node:fs/promises")).stat(backup)).size }; });
  await phase("restore", async () => { const chooserPromise = page.waitForEvent("filechooser"); await page.locator(".sidebar [data-import]").click(); const chooser = await chooserPromise; await chooser.setFiles(backup); await page.getByText("Restore this backup?").waitFor(); await page.getByRole("button", { name: "Restore", exact: true }).click(); await page.getByText("All houses, inventory, and scans have been restored.").waitFor({ timeout: 30000 }); });
  result.errors = session.errors;
  await saveAuditResult("ram", result);
  await writeRamReport(result);
} finally { await session.close(); }
