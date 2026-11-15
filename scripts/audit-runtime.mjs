import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const auditDirectory = resolve("test-results/audit");

export async function acquireAuditLock(label) {
  await mkdir(auditDirectory, { recursive: true });
  const lockPath = resolve(auditDirectory, "browser.lock");
  const token = randomUUID();
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, label, token }));
      await handle.close();
      return async () => {
        const owner = JSON.parse(await readFile(lockPath, "utf8").catch(() => "null"));
        if (owner?.token === token) await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
      if (owner?.pid) {
        try { process.kill(owner.pid, 0); }
        catch (failure) {
          if (failure.code === "ESRCH") await unlink(lockPath).catch(() => {});
        }
      }
      await delay(250);
    }
  }
  throw Error(`Timed out waiting for the browser audit lock: ${label}`);
}

export async function createAuditSession({ label, viewport = { width: 1440, height: 1000 }, args = [] }) {
  const release = await acquireAuditLock(label);
  let server, browser;
  try {
    server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
    await server.listen();
    const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--enable-unsafe-swiftshader", "--enable-precise-memory-info", ...args],
    });
    const context = await browser.newContext({ viewport });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return ["http:", "https:"].includes(url.protocol) && url.origin !== baseURL
        ? route.abort() : route.continue();
    });
    await context.route("**/src/firebase-config.json*", (route) => route.fulfill({
      contentType: "application/javascript", body: "export default {enabled:false};",
    }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    return {
      baseURL, browser, context, page, cdp, errors,
      async close() {
        try { await browser.close(); }
        finally {
          try { await server.close(); }
          finally { await release(); }
        }
      },
    };
  } catch (error) {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { await release(); }
    }
    throw error;
  }
}

export async function pageMetrics(cdp, { collectGarbage = true } = {}) {
  if (collectGarbage) await cdp.send("HeapProfiler.collectGarbage");
  const [heap, dom, performance] = await Promise.all([
    cdp.send("Runtime.getHeapUsage"),
    cdp.send("Memory.getDOMCounters"),
    cdp.send("Performance.getMetrics"),
  ]);
  const metrics = Object.fromEntries(performance.metrics.map((metric) => [metric.name, metric.value]));
  return { heap, dom, metrics };
}

export async function saveAuditResult(name, result) {
  await mkdir(auditDirectory, { recursive: true });
  const path = resolve(auditDirectory, `${name}.json`);
  await writeFile(path, JSON.stringify(result, null, 2) + "\n");
  return path;
}
