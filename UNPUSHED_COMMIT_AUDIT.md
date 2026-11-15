# Unpushed commit audit — 2026-11-15

Review and follow-up implementation complete. Three GPT-6.1 Terra agents tested and documented the committed snapshot through Orchestrator V2 in isolated worktrees without changing application code. The user subsequently authorized the parent to implement the remaining fixes. Existing and concurrent workspace edits are preserved.

**All five P2 findings are now addressed for their reported cases in the working tree.** The parent fixed account-copy completion across session changes and rejected morph-target inputs before loading. Earlier local edits address the other three findings. The parent also removed redundant shared-asset validation. Both P3 test problems are corrected. No P1 defect was established.

## Follow-up implementation

- `src/account.js`: display the durably saved copy synchronously, before awaiting lease cleanup. Later sign-out, account changes, or inventory edits retain their own view. Recheck the authentication epoch before updating completion status after cleanup.
- `src/scan-limits.js`: reject nonempty GLB morph-target lists before Three loads the model or any textures are decoded. The import error and README explain that room scans must be exported as static meshes without morph targets. This deliberately rejects small morph-target inputs too; empty lists and ordinary static GLBs remain supported.
- `src/scan-storage.js`: group shared scan references by asset ID and distinct format, decode one file at a time, validate each declared format once, and stage each file once. Mixed-format references cannot bypass validation, and failed validation still rolls back staged files.
- Permanent regressions: `e2e/account-copy-regressions.spec.js` covers sign-out, switching accounts and newer edits during delayed lease cleanup, including retained copied files and unchanged guest storage. `e2e/backup-assets.spec.js` checks one decode/validation for 20 shared references and rejection of a conflicting format. `tests/scan-model.test.js` checks early morph rejection (1, 128 and 1,500 targets), malformed target lists, and acceptance of an empty list.

The original evidence and pre-fix observations below are retained for traceability. Final verification is recorded separately from the initial audit results.

## Final verification after fixes

- **76 unit tests passed**, no failures or forced exit: Node 22.16.0, `node --test --test-reporter=spec tests/*.test.js`.
- **56 browser tests passed** in 32.6 seconds: account-copy regressions, account, backup-assets, backup-session, review-regressions, scanner-regressions, scanner-safety, and memory-management suites. The isolated Playwright configuration used installed headless Edge with SwiftShader and Vite on port 5194. Source and helpers came from the current workspace; copied browser suites, configuration, cache and outputs stayed in the temporary review directory.
- **Production build passed**, using `node node_modules/vite/bin/vite.js build --outDir C:/Users/david/AppData/Local/Temp/item-finder-parent-audit-20261115/fixed-build`. Existing scanner/Firebase chunk-size warnings remain. The external output directory was intentionally not emptied.
- `git diff --check` passed. Existing local edits were preserved; no commit or push was made.
- Account transport and race timing were mocked/injected; no live account, physical XR device, or real storage outage was exercised. GLBs containing morph targets now require a static-mesh export, as stated in the error and README.

## Scope

- Base: `d96d2e0fc88159d2513c84cba16453457b65b906` (`origin/main`, fetched before review).
- Reviewed commits: `dc6569f3ea8939dbeb76bee770c511668e11cfab` and `82dbc1602364eec735346f2997f021568e2c78b6`.
- Committed findings and current workspace status are separate: the workspace contains further uncommitted fixes being made outside this audit.
- All three reviews and parent verification are complete.

## Backup and account findings adjudicated by parent

| Priority | Finding in committed snapshot | Current workspace assessment |
| --- | --- | --- |
| P2 | Guest-copy completion can install the previous account's inventory after sign-out/account switch (`src/account.js`, guest-copy handler). | **Fixed in follow-up.** Before the fix, delayed completion after sign-out showed 6 rooms while guest storage held 3. The saved view is now published before awaiting lease cleanup; permanent tests verify sign-out, switching accounts and newer inventory edits retain the correct view. |
| P2 | Matching overlapping restores remove their staging protection (`src/scan-storage.js`, `stageAsset`). | Original reproduction is addressed locally: parent staging/cleanup probe passed after the local change preserves a lease. This verifies the reported sequence, not all possible interleavings or lease expiry. |
| P2 | Arbitrary backup asset IDs containing `:` alias guest/account IndexedDB keys (`src/scan-storage.js` key construction; `src/scan-data.js` validation). | Parent verified the current storage API rejects the crafted ID and does not create an account asset. Local inventory validation also rejects these IDs. |
| P2 | Lease-release failure reports restore failure after metadata already committed (`src/main.js`; related account copy path). | Parent injected rejection of restore lease cleanup: the UI reported successful restore, closed the dialog, and showed the persisted replacement. The related copy session race is fixed separately as described above. |

Before the fix, the account agent measured repeated validation of a shared asset: 20 references to one 250,564-byte OBJ took 184 ms versus 58.5 ms for one reference in a single run. The implementation now groups references before decoding/validation. The regression confirms 20 references perform exactly one decode and one validation for their shared format, without making a device-level latency or peak-memory claim.

## P2: GLB morph targets bypass expanded allocation budgets

Status: **Fixed in follow-up by rejecting morph-target scans before loading.** Review-time locations: `src/scan-limits.js:37` (each accessor counted once), `src/scan-limits.js:48` (primitive cost counts base positions/indices), and `src/scan-model.js:155` (validation revisits each morph reference). A primitive could repeat the same POSITION accessor as many morph targets. Three packs every target into a float RGBA array texture on first rendering; the old preflight did not reserve this expansion or bound the target count.

The parent independently reproduced both parts before the fix:

- A **74,292-byte GLB** with 6,000 vertices and 128 repeated targets loaded and rendered in headless Edge. Intercepted WebGL calls allocated a 6,000 x 1 x 128 texture and uploaded a **12,288,000-byte** typed array. The reported maximum array layers was 2,048. This is a measured upload-array size, not total process or driver memory.
- A **94,872-byte GLB** with 1,500 targets was accepted in **193 ms**, versus **12 ms** for one target in this single run. Its projected packed morph array is **144,000,000 bytes**, already above the declared 128,000,000-byte decoded budget. This larger array was calculated from the installed Three implementation and was **not allocated/rendered** by the parent probe.

The implemented resolution requires a static export without morph targets, avoiding morph validation and render allocations entirely. New unit tests confirm rejection happens before Three's parser runs, including repeated references and small inputs. Ordinary static geometry remains supported.

The agent's focused 28-test scanner/capture suite passed. Existing tests address the earlier reported examples for false bounds, malformed attributes, external images, fallback URL cleanup, image dimensions, alternate-scene instance cloning and excessive primitives/groups. Passing those examples does not establish exhaustive closure of all related variants.

## Viewer, capture and cropping assessment

No new application defect was established by this review. The committed unit failure above was independently reproduced by both completed agents. The viewer agent also identified a P3 test fixture race in `e2e/review-regressions.spec.js:202`: it creates an unreferenced blob during startup cleanup. A diagnostic delay in its scratch copy removed that failure; the local workspace now explicitly persists the inventory reference before creating the blob, avoiding reliance on a delay.

Targeted probes on the committed snapshot confirmed fixes for earlier report findings #4 and #5 (unexpected XR end and reference-space reset, simulated), #7 (same-scan cloud marker reconciliation, mocked Firebase), #8 (320 x 844 mobile fitting: all eight corners visible, max absolute projected X 0.8703), and #16 (orbit drag leaves placement armed and does not open its menu). Crop suites passed for square, portrait, panoramic, keyboard and 320-pixel touch interactions. The simulated capture cap returned 200,000 points using exactly 2,400,000 bytes. No new performance regression was established in these paths.

## Initial audit validation (before follow-up fixes)

- Agent committed snapshot: unit tests **72 passed, 1 failed**. The failure was an expectation that `retainedAssetIds` was iterable while connection state conservatively exposes `null`. It does not establish data loss. Current workspace corrects this expectation.
- Agent committed snapshot: **15 existing browser tests passed**, plus targeted reproductions described in its report.
- Viewer agent committed snapshot: **48 browser tests passed, 1 failed** (the shared-asset fixture race above). Its diagnostic rerun of that case passed. These overlap other agent coverage; do not add the counts as unique tests.
- Parent current workspace: **74 unit tests passed** using Node 22.16.0 with `--test-force-exit`.
- Parent current workspace: **3 targeted browser tests passed** for overlapping staging, invalid scoped IDs, and restore lease failure. **1 targeted browser test failed** with the reproduced account-switch race (expected 3 rooms; observed 6).
- Parent current workspace: **16 browser regression tests passed** (`review-regressions.spec.js` and `scanner-regressions.spec.js`), including the corrected shared-asset fixture, cloud marker updates, mobile fit/drag placement, conflict/recovery retention, orphan cleanup/retry, and native texture failure cleanup. Initial scratch-run discovery failed because relative source/helper imports were missing; adding scratch junctions to the existing project directories resolved test setup before this successful run.
- Parser agent committed snapshot: **28 focused scanner/capture tests passed**; its full unit suite reproduced the same 72-pass/1-fail result described above.
- Parent current workspace: **1 bounded morph-render observation test passed**, confirming the unbudgeted upload; this passing observation test demonstrates a defect, not successful budget enforcement. Across the parent's targeted browser runs: **20 passed and 1 intentionally exposed the account-switch failure**. No tests were rerun after unrelated edits unless needed to verify a reported issue.
- Parent browser tests used headless installed Edge, Vite at `127.0.0.1:5194`, mocked Firebase/auth, and injected timing/failure. No real account, physical XR hardware, or actual storage outage was exercised.

## Evidence

- [Backup/account agent report](C:/Users/david/AppData/Local/Temp/item-review-67747301c0ff470d80c754b61d0a7663/REVIEW.md)
- [Viewer/capture/cropping agent report](C:/Users/david/AppData/Local/Temp/item-review-5fd7ef60b0874a2ba89998d8910817b1/REPORT.md)
- [Parser/performance agent report](C:/Users/david/AppData/Local/Temp/scanner-review-6132247ceac94f45b21649b442fd178b/REPORT.md)
- [Parent account-switch reproduction](C:/Users/david/AppData/Local/Temp/item-finder-parent-audit-20261115/e2e/review-session.spec.js)
- [Parent local-fix verification](C:/Users/david/AppData/Local/Temp/item-finder-parent-audit-20261115/e2e/current-fixes.spec.js)
- [Parent bounded morph-render observation](C:/Users/david/AppData/Local/Temp/item-finder-parent-audit-20261115/e2e/morph.spec.js)
- [Parent morph parsing probe](C:/Users/david/AppData/Local/Temp/item-finder-parent-audit-20261115/morph-probe.mjs) and [recorded output](C:/Users/david/AppData/Local/Temp/item-finder-parent-audit-20261115/morph-node-output.txt)

## Orchestrator V2 reviews

- [Terra audit: backup and account integrity](t3-thread://v2/488bcd86-3c50-4334-b47b-6f52c7c9f296/thread:delegated-task:command%3Amcp%3A95f9dfd2-3a0c-4e16-8f79-87908d786a58%3Adelegate-task%3A95aed2af-54d8-4e73-9108-7ff4e1690637)
- [Terra audit: scan parser and performance](t3-thread://v2/488bcd86-3c50-4334-b47b-6f52c7c9f296/thread:delegated-task:command%3Amcp%3A95f9dfd2-3a0c-4e16-8f79-87908d786a58%3Adelegate-task%3A03dd691f-9102-48ca-9780-75d0a9483550)
- [Terra audit: viewer capture and cropping](t3-thread://v2/488bcd86-3c50-4334-b47b-6f52c7c9f296/thread:delegated-task:command%3Amcp%3A95f9dfd2-3a0c-4e16-8f79-87908d786a58%3Adelegate-task%3A5abf6fb6-e443-4b21-abc5-a4005bf0fb1e)

All three agents had clean tracked/staged diffs, independently checked by the parent. The initial audit added only this report; the user-authorized follow-up changed the three application files and regression/documentation files described above. Temporary review tooling remains outside the project. No commit or push was made. Separate pre-existing edits, including changes to the older scanner report, were preserved.
