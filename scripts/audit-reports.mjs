import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditDirectory } from "./audit-runtime.mjs";

const mib = value => ((value || 0) / 1_048_576).toFixed(2);
const statistics = values => {
  const sorted = [...values].sort((first, second) => first - second);
  return `${sorted[Math.floor(sorted.length / 2)].toFixed(1)} / ${sorted[Math.ceil(sorted.length * .95) - 1].toFixed(1)}`;
};

export async function writePerformanceReport(result) {
  const operations = ["projection", "indexActive", "storageWrite", "ui_switchSync", "ui_filterSync"];
  const rows = Object.entries(result.datasets).map(([name, dataset]) =>
    `| ${name} | ${dataset.houses} / ${dataset.items} | ${dataset.jsonUtf8Bytes} | ${operations.map(operation => statistics(dataset.operations[operation].samplesMs)).join(" | ")} |`);
  const deep = Object.entries(result.synthetic.deepTree).map(([depth, samples]) => `| ${depth} | ${statistics(samples)} |`);
  const loads = Object.entries(result.datasets).map(([name, dataset]) => `| ${name} | ${statistics(dataset.loads.cold.samplesMs)} | ${statistics(dataset.loads.warm.samplesMs)} |`);
  await writeFile(resolve(auditDirectory, "performance.md"), `# Performance audit

Run: ${result.environment.date}. ${result.environment.node}, ${result.environment.browser}, ${result.environment.cpu}. Exclusive browser measurement lock; disabled Firebase and blocked external web requests. Median / nearest-rank p95 in milliseconds, 3 warmups and 12 measured samples unless noted.

| Dataset | Houses / items | JSON UTF-8 bytes | House projection | Active index | Serialize + storage write | Switch handler | Picker filter handler |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows.join("\n")}

House projection and saving scale with inactive inventory. The picker still renders every house; virtualization and membership caching remain possible optimizations. Synchronous handlers are not total user-perceived latency. UI frame samples in the raw JSON include two animation-frame callbacks and their scheduling floor. Long tasks overlap batched operations and cannot be attributed to individual user actions.

| Dataset | Cache-cleared reload | Warm reload |
|---|---:|---:|
${loads.join("\n")}

Loads have 2 warmups and 6 measured samples. Cache-cleared reload is not a fresh browser process, OS-cold disk, production-network or mobile measurement. This uses the development server, not the production bundle.

| Adversarial deepest-first depth | Index median / p95 ms |
|---|---:|
${deep.join("\n")}

Deep-tree results use 3 warmups and 6 samples. Intermediate ancestor paths are cached in the corrected implementation, but the total materialized path/search text still grows quadratically with adversarial depth. Larger synthetic projection cases in the JSON are in-memory only, not persisted or rendered. Timings include timer quantization, JIT, GC, OS and machine noise; no universal timing threshold is asserted. Page errors: ${JSON.stringify(result.errors)}.

Reproduce: npm run audit:performance. Raw data: test-results/audit/performance.json.
`);
}

export async function writeRamReport(result) {
  const rows = Object.entries(result.phases).map(([name, phase]) => {
    const settled = phase.settled;
    const peak = phase.samples?.filter(sample => sample.processes).map(sample => sample.processes.privateBytes);
    return `| ${name} | ${mib(settled.heap.usedSize)} | ${mib(settled.heap.backingStorageSize)} | ${mib(settled.processes.workingSetBytes)} | ${mib(settled.processes.privateBytes)} | ${peak?.length ? mib(Math.max(...peak)) : "—"} |`;
  });
  await writeFile(resolve(auditDirectory, "ram.md"), `# RAM audit

Run: ${result.generatedAt}. Dedicated headless Windows Edge session, serialized with other audits, Firebase disabled and external requests blocked. Fixture: ${result.fixture.houses} houses, ${result.fixture.rooms} rooms, ${result.fixture.items} items, ${result.fixture.scanBytes} scan bytes; ${result.fixture.inventoryJsonBytes} inventory JSON UTF-8 bytes.

| Phase | Post-GC JS heap MiB | Backing storage MiB | Working set MiB | Private bytes MiB | Sampled peak private MiB |
|---|---:|---:|---:|---:|---:|
${rows.join("\n")}

Settled snapshots follow forced renderer GC and roughly 1.2 seconds of settling. Backing storage is CDP's separate backing-storage metric, not IndexedDB usage. Process counters include only PIDs listed by the dedicated Chromium session: browser, renderer, GPU and listed utility processes. They exclude the user's browsers and the audit's Node/Vite process. Summed working sets can double-count shared pages; private bytes are committed private virtual memory, not necessarily resident RAM.

The process list and Windows samples are non-atomic and may miss exiting processes. Each operation has only ${result.phases.initialApp.samples.length} coarse samples, including PowerShell startup and 200 ms waits; sampled peaks can miss short transients. Forced page GC does not force browser, GPU or OS memory release. Software rendering, dynamic imports, allocator retention and process churn prevent causal inference from sequential phase differences. Elevated post-viewer memory does not establish a leak. This audit does not test hardware GPU reclamation, physical mobile/WebXR, long-duration use, near-30 MB scans or near-250 MB backups.

Persistent storage is not RAM: raw JSON separately records IndexedDB usage and a localStorage UTF-16 size estimate. Page errors: ${JSON.stringify(result.errors)}. Viewer, export and restore outcomes are in the raw JSON.

Reproduce: npm run audit:ram. Raw data: test-results/audit/ram.json.
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writePerformanceReport(JSON.parse(await readFile(resolve(auditDirectory, "performance.json"), "utf8")));
  await writeRamReport(JSON.parse(await readFile(resolve(auditDirectory, "ram.json"), "utf8")));
}
