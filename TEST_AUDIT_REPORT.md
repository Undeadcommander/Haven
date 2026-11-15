# Functional, performance, RAM and leak audit

**2026-11-15 — Complete.** Three confirmed functional bugs fixed, repeated deep-index traversal corrected, and no confirmed unbounded application leak in the finite workloads tested.

## Method and scope

Four first-generation GPT-6.1 Terra agents ran with high reasoning, separately assigned to bugs, performance, RAM and leaks. First-generation agents could delegate one useful Terra/high child, with further nesting prohibited. The parent integrated fixes, added deterministic regressions and reran measurements and full suites.

Environment: Windows 10.0.26300, Node 24.22.3, headless Edge 149.0.4022.69, Intel Core Ultra X7 358H, 16 logical CPUs. Dedicated browser sessions and local Vite servers used synthetic data, disabled Firebase and blocked external requests. A lock serialized our browser measurements. No user browser, user inventory or production account was accessed. OS scheduling and unrelated machine activity were not controlled.

## Confirmed findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| High | Failed guest-storage reads loaded starter data; ordinary edits then overwrote recoverable data. Export misleadingly saved the starter inventory. | Block ordinary writes while recovery is unresolved; export original raw metadata; allow replacement only through explicit confirmed restore. Reload/valid replacement clears recovery. |
| Medium | Back/Forward and reload could restore a room URL in the wrong house. | Store house and account scope in history, resolve legacy room ownership, validate stale context, and preserve pending legacy links across duplicate navigation events. |
| Medium | Rendering during scan-import lease cleanup could invalidate the viewer against its own newly saved metadata. | Update accepted model/display identity synchronously before awaiting cleanup; reject genuinely stale work after the await. A deterministic test forces paint in this timing gap. |
| Performance | Deepest-first indexing repeatedly traversed uncached ancestors. | Cache intermediate paths; a parent-read-count regression guards against repeated traversal. Fully materialized path/search text can still grow quadratically with depth. |

Restore completion also rechecks ownership after asynchronous lease cleanup so it cannot reset a newer view. Code: `src/main.js:47`, `src/main.js:105`, `src/main.js:835`, `src/account.js:390`, `src/scan-viewer.js:549`, `src/store.js:93`.

## Final checks

- **85 unit tests passed.** Includes 400 model-based edits across 9 houses, checking validity and every inactive house after each edit.
- **107 browser tests passed, without retries.** Full suite covers nested transfers, search, persistence, mobile overflow, photos, scan validation, account/conflict/deletion simulations and backup rollback.
- **Production build passed.** Existing Firebase/Three.js large-chunk warnings remain.
- Standalone functional audit: **6 passed**, no page errors.
- Performance, RAM and repeated lifecycle audits completed; final runs reported no uncaught page errors.
- New scripts passed syntax checks; Git whitespace check passed.

New regressions specifically cover malformed/transient guest storage, unchanged raw recovery export, explicit restore, invalid external replacement, auth round trips, Back/Forward/reload, duplicate hash/history events, legacy links, late restore completion and scan-import render interleaving.

## Performance

Browser timings use performance.now, 3 warmups and 12 samples, upper-middle median and nearest-rank p95. Deep chains and reloads use 6 measured samples. Approximately 0.1 ms timer resolution means zero readings are below resolution, not free work. These are development-server measurements, not production-network or mobile benchmarks.

| Adversarial deepest-first depth | Before median | After median |
|---|---:|---:|
| 500 | 5.1 ms | 1.8 ms |
| 1,000 | 16.7 ms | 6.0 ms |
| 2,000 | 65.0 ms | 24.3 ms |

At depth 2,000, observed p95 changed from 75.2 to 29.4 ms. The regression verifies traversal behavior, not a fragile timing threshold. This synthetic case is in-memory; total materialized path text remains quadratic. It is not a claim about normal household data or a controlled causal experiment.

| Representative post-fix operation | Fixture | Median / p95 |
|---|---|---:|
| House switch handler | 1,000 houses / 2,000 items | 15.0 / 22.3 ms |
| Picker filter handler | Same 1,000-house fixture | 1.4 / 2.1 ms |
| Serialize + localStorage write | 100 houses / 20,000 items; 2.12 MB UTF-8 JSON | 14.5 / 15.3 ms |
| Active-house index | 2 houses / 10,000 items; 5,000 active | 1.7 / 5.6 ms |
| Active inventory search | Same 5,000-active-item fixture | 0.3 / 0.3 ms |

Cache-cleared reload medians were 181–231 ms across four fixtures; these reloads reused a browser process and are not OS-cold starts. General timings varied between runs; do not attribute all variation to individual patches. UI frame measurements include two animation frames and scheduling, not only handler CPU. Batched long-task entries cannot establish individual-interaction latency.

**Remaining costs:** projection walks all inventory; guest saves synchronously serialize all houses; switching rebuilds the entire UI and all picker rows. A 1,000-house switch p95 exceeded a 16.7 ms frame, and filter-plus-two-frame p95 reached 68 ms. Membership caching, avoiding repeated projections and picker virtualization are reasonable follow-ups at that scale. The largest projection fixture, 40,000 locations plus 40,000 items, was in-memory only, not stored or rendered.

## RAM footprint

Fixture: 11 houses (10 populated, one empty), 100 rooms, 5,000 items, an 840,496-byte untextured GLB with 20,000 triangles; inventory JSON 602,149 UTF-8 bytes. Viewer, export and restore completed. MiB = 1,048,576 bytes.

| Sequential phase | Post-GC page JS heap | Backing storage | Dedicated browser private bytes |
|---|---:|---:|---:|
| Blank browser/page | 0.57 MiB | 0.00 MiB | 210.36 MiB |
| Initial app | 2.52 MiB | 1.14 MiB | 238.19 MiB |
| Populated active house | 3.31 MiB | 1.14 MiB | 271.97 MiB |
| Empty house, same inventory retained | 3.50 MiB | 1.14 MiB | 280.89 MiB |
| Viewer open | 5.92 MiB | 4.14 MiB | 379.93 MiB |
| Viewer closed | 5.77 MiB | 3.34 MiB | 376.86 MiB |
| Backup export | 5.78 MiB | 3.34 MiB | 435.67 MiB |
| Backup restore | 7.14 MiB | 3.34 MiB | 440.24 MiB |

JS heap is renderer V8 memory, not total RAM. Backing storage is a separate CDP metric such as ArrayBuffer storage. Private bytes sum only the dedicated browser's Chromium-listed browser, renderer, GPU and utility PIDs, excluding Node/Vite and user browsers. Private bytes are committed private virtual memory, not necessarily resident physical memory. Separately recorded working sets can double-count shared pages.

Phases are sequential rather than independently reset experiments. The active/empty comparison includes allocation history and cannot isolate per-house cost. Snapshots follow forced page GC and roughly 1.2 seconds of settling; three coarse samples per phase can miss transient peaks. Process lists and Windows samples are non-atomic and can miss exiting processes. Forced GC does not force browser/GPU/OS reclamation. Post-close graphics memory stayed elevated in software rendering; this alone does not establish a leak. Persistent IndexedDB/localStorage bytes are not RAM and are not added to these figures.

## Lifecycle leaks

One warmup plus three equal batches per workload, forced page GC before samples. Compare within a workload: the same page and imported modules carry forward between workloads.

| Workload | Total cycles including warmup | Heap warmup → final | Nodes warmup → final | Listeners warmup → final |
|---|---:|---:|---:|---:|
| House switching/picker/filter/close | 32 | 3.03 → 3.17 MiB | 563 → 563 | 58 → 58 |
| Room/item/photo/backup editors | 16 | 3.33 → 3.49 MiB | 1,016 → 1,014 | 75 → 75 |
| Scan open/two replacements/close | 12 | 5.92 → 6.43 MiB | 1,014 → 1,014 | 74 → 74 |

All 12 observed WebGL contexts received explicit context loss. Switcher global listeners returned to baseline, and a delayed backup read was rejected after switching away and back. Heap rose with smaller final-batch increments, but no retained owner proving an application leak was identified. **This does not prove leak-free behavior.** Explicit context loss is not proof of GPU reclamation; timer/subscription totals were not measured.

An initial file-chooser automation run retained detached forms through DevTools console handles. Final measurement injects generated files in-page instead and takes the heap snapshot before querying detached nodes. A separate rerun timed out during scan replacement, leading to the deterministic render-race investigation and fix; only the subsequent successful complete run is summarized above.

## Reproduction and artifacts

With Node installed and CHROMIUM_PATH set to an appropriate Chromium/Edge executable, run from the repository root:

```powershell
npm run audit:baseline
npm run audit:bugs
npm run audit:performance
npm run audit:ram
npm run audit:leaks
```

The RAM process audit is Windows-specific. Resource scripts default to the standard Windows Edge path unless overridden. They serialize browser measurements and close their browser/server in finally blocks. No new dependencies, commits or PRs were created.

Ignored `test-results/audit/` contains baseline, bugs, performance, ram and leaks JSON; generated Markdown details; and `leaks.heapsnapshot`. Original evidence is retained as `*-before.json`, and the intermediate timing failure as `leaks-import-race.json`. Reproducible scripts are in `scripts/audit-*.mjs`; regressions are in `tests/` and `e2e/`. Later test cleanup can remove raw artifacts; this tracked report preserves the summary.

## Limits

Not tested here: live Google/Firebase, Firestore emulator rules, physical mobile/XR, hardware-GPU reclamation, near-limit scans/backups, multi-hour soak, concurrent real-device sync or a hardware distribution. Existing mock/unit tests are not a substitute. Large photos, complex geometry and low-memory phones can have much larger peaks.

Next investigations: a longer heap-owner comparison soak, hardware-GPU viewer profiling and membership/picker caching or virtualization. No final executed suite has a remaining failure, but these tests cannot establish the absence of every bug or leak.
