import { spawn } from "node:child_process";
import { dirname, delimiter } from "node:path";
import { performance } from "node:perf_hooks";
import { acquireAuditLock, saveAuditResult } from "./audit-runtime.mjs";

process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`;
const release = await acquireAuditLock("regression baseline");
const results = [];

async function run(name, args) {
  const started = performance.now();
  const child = spawn(process.execPath, args, { windowsHide: true, env: process.env });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  results.push({ name, args, exitCode, durationMs: performance.now() - started, output });
}

try {
  await run("unit", ["--test", "tests/*.test.js"]);
  await run("build", ["node_modules/vite/bin/vite.js", "build"]);
  if (process.argv.includes("--browser")) {
    await run("browser", [
      "node_modules/@playwright/test/cli.js", "test", "--workers=4",
      "--output=test-results/audit/baseline-browser",
    ]);
  }
  console.log(await saveAuditResult("baseline", { capturedAt: new Date().toISOString(), results }));
  process.exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
} finally {
  await release();
}
