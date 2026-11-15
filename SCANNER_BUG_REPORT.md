# 3D scanner bug check and fixes

Reviewed 2026-11-15 using three parallel Orchestrator V2 review agents, followed by parent review of the findings and relevant code. **All 16 findings are now addressed.** The user subsequently requested implementation by the parent agent, without additional delegation. The existing concurrent restore safeguards were preserved and verified. The duplicate finding about synced markers was counted once.

## Implemented changes

| Findings | Resolution | Current implementation |
| --- | --- | --- |
| 1, 3 | Preserve portable asset IDs, deduplicate staged files, reject collisions, and abort stale restores without deleting files adopted by another inventory. | [scan-storage.js](<C:/T3 Code Projects/Item-finder/src/scan-storage.js>), [main.js](<C:/T3 Code Projects/Item-finder/src/main.js>) |
| 2, 6 | Replace eager deletion with scoped reconciliation. Retain active files, the last account version while edits are pending, and recovery copies. Protect staged imports with expiring leases, check persisted references from other tabs, and retry failed cleanup. | [account-sync.js](<C:/T3 Code Projects/Item-finder/src/account-sync.js>), [account.js](<C:/T3 Code Projects/Item-finder/src/account.js>), [scan-storage.js](<C:/T3 Code Projects/Item-finder/src/scan-storage.js>) |
| 4, 5 | Reject unexpected XR session endings and abort on reference-space resets. Only Finish or point-cap completion exports a capture. | [capture-depth.js](<C:/T3 Code Projects/Item-finder/src/capture-depth.js>) |
| 7 | Reconcile marker dots and details after same-scan updates, preserving draft inputs and updating existing-target choices. | [scan-viewer.js](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js>) |
| 8, 16 | Set the stage aspect before fitting, fit against both fields of view, and distinguish taps from orbit/multi-pointer gestures. Ignore navigation events queued before the viewer opened. | [scan-viewer.js](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js>) |
| 9, 10 | Validate rendering attribute sizes, counts and finite values, then recompute geometry and instance bounds from coordinates. | [scan-model.js](<C:/T3 Code Projects/Item-finder/src/scan-model.js>) |
| 11, 12, 13 | Reject external resources, budget decoded PNG/JPEG/WebP pixels before decoding, explicitly propagate decode failures, and revoke fallback image URLs on every outcome. | [scan-images.js](<C:/T3 Code Projects/Item-finder/src/scan-images.js>), [scan-limits.js](<C:/T3 Code Projects/Item-finder/src/scan-limits.js>), [scan-model.js](<C:/T3 Code Projects/Item-finder/src/scan-model.js>) |
| 14, 15 | Load only the default static room scene and cap expanded renderables/material groups in both GLB and OBJ imports. | [scan-limits.js](<C:/T3 Code Projects/Item-finder/src/scan-limits.js>), [scan-model.js](<C:/T3 Code Projects/Item-finder/src/scan-model.js>) |

The finding descriptions below preserve the original triggers and evidence; their quoted line ranges refer to the code at review time, before these fixes.

P2 indicates a functional, data-integrity, or resource-management bug worth fixing; P3 indicates a smaller interaction defect. No P1 issue was established. The order below puts data preservation first.

## Original findings

### 1. P2 — Restore overwrites cloud edits received during staging

Status: **Addressed by concurrent edits.** The new inventory/auth epochs and pre-commit guard reject a changed inventory; the cloud-replacement-during-staging regression passed in parent verification. Description below records the original finding.

Location: [src/main.js:606](<C:/T3 Code Projects/Item-finder/src/main.js:606>) (restore commit guard; originally 593–605).

Restoring a backup awaits asset decoding and validation, then checks only whether the account scope changed. If a newer inventory arrives in the same account during that await, restore replaces it and marks the backup dirty against the newer revision. Subsequent upload can overwrite those incoming edits without a conflict.

Reproduction paused validation, received revision 2 containing a new item, then resumed restore. The new item disappeared while the local record retained revision 2 and became dirty. Capture inventory identity and account generation before staging; abort and roll back if either changes before commit.

### 2. P2 — Cleanup deletes files needed by conflict resolution and recovery copies

Locations: [src/main.js:99](<C:/T3 Code Projects/Item-finder/src/main.js:99>) (99–102), [src/scan-viewer.js:81](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js:81>) (81–84), and [src/account-sync.js:224](<C:/T3 Code Projects/Item-finder/src/account-sync.js:224>) (224–242).

Cleanup considers only active inventory references. Removing a scan offline deletes its file before a later conflict can restore the account version that still references it. Separately, removing a scan after conflict resolution deletes a file still referenced by the retained recovery inventory.

Both scenarios were reproduced. Choosing the account version restored scan metadata with no file; exporting a recovery copy failed because its scan was missing. Retain assets referenced by recovery inventories and account versions still eligible for conflict resolution, and use that policy in both cleanup paths.

### 3. P2 — Restore changes shared asset identities and breaks other devices

Status: **Addressed by concurrent edits.** Restore now preserves IDs and stages each source asset once, with collision and rollback ownership checks. The portable-ID/shared-asset regression passed in parent verification. Description below records the original finding.

Location: [src/scan-storage.js:247](<C:/T3 Code Projects/Item-finder/src/scan-storage.js:247>) (restore loop; originally 166–174).

Every restored scan gets a new asset ID, even when several scans reference the same source asset. Those new IDs sync to other devices, where the original local blobs still exist under the old IDs. Restoring on one device can therefore make the same account's scans unavailable on another device that already had the files.

Two isolated browser contexts reproduced the broken reference. A second probe restored three references to one asset and produced three distinct blobs and three exported assets. Eight references to a 24 MB file would expand beyond the 250 MB backup limit after base64 encoding; that size consequence was calculated, not exercised with a large allocation. Preserve stable logical asset identities, separate staging keys from logical IDs, and stage each distinct source asset once.

### 4. P2 — Unexpected XR termination commits a partial replacement

Location: [src/capture-depth.js:85](<C:/T3 Code Projects/Item-finder/src/capture-depth.js:85>) (85–96); import call site: [src/scan-viewer.js:599](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js:599>).

The session end handler exports any capture with at least 100 points when no frame error was recorded. It does not distinguish Finish or automatic point-cap completion from browser-initiated session termination. A partial capture can consequently replace the previous scan and remove its markers.

A mocked session captured one frame and dispatched end without Finish; capture successfully returned 256 points. Require an explicit successful completion reason before exporting. Unexpected endings should cancel or reject while preserving the existing scan.

### 5. P2 — Reference-space resets split the captured geometry

Location: [src/capture-depth.js:173](<C:/T3 Code Projects/Item-finder/src/capture-depth.js:173>) (173–177); point accumulation at 119–134.

Tracking recovery can reset the local XR reference-space origin. Capture never handles its reset event, so new points use a different coordinate frame from accumulated points and voxel keys.

A simulated one-metre origin reset produced 512 points on two displaced planes from the same physical surface. Apply the reset transform to accumulated coordinates and rebuild voxel keys, or abort capture with a tracking-recovery message.

### 6. P2 — Cloud removals and failed cleanup permanently orphan scan files

Locations: [src/main.js:70](<C:/T3 Code Projects/Item-finder/src/main.js:70>) (70–80) and [src/main.js:99](<C:/T3 Code Projects/Item-finder/src/main.js:99>) (99–102).

Cloud inventory replacement bypasses asset cleanup. Local deletion also suppresses IndexedDB deletion errors without recording IDs for retry. Both paths leave large files unreachable by inventory and backups while continuing to consume browser quota.

A cloud removal left its local blob after another save and reload. Aborting a deletion transaction during subtree deletion likewise left the blob after reload. Persist pending deletion work or perform scoped reconciliation at startup and inventory replacement, protecting the retained versions described in finding 2.

### 7. P2 — Same-scan cloud updates leave the viewer's markers stale

Location: [src/scan-viewer.js:609](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js:609>) (609–610), with the identity check at 86–89.

The inventory subscription only checks scan identity. When another device changes markers or target names without replacing the scan, it does not reconcile dots or panel contents. Deleted markers remain visible, added markers are missing, and labels/counts stay outdated.

Two agents independently reproduced this through the production account subscription with mocked Firebase. One case had zero persisted markers but one visible dot and a count of one; Reset view did not repair it. Reconcile marker controls and panel contents after valid same-scan updates, preserving or safely invalidating active placement forms.

### 8. P2 — Camera fitting clips scans on narrow screens

Location: [src/scan-viewer.js:213](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js:213>) (213–229).

Fit uses a fixed radius multiplier without considering horizontal field of view or viewport aspect ratio. At a 320 × 844 viewport, Reset view on the existing room.obj fixture left four of eight bounds corners outside the viewport; the maximum absolute projected X was 1.282, beyond the visible limit of 1.

Calculate distance from both horizontal and vertical field of view using the current stage aspect ratio, with padding. Ensure first-load sizing is available before fitting.

### 9. P2 — GLB bounds metadata can make accepted scans invisible

Location: [src/scan-model.js:109](<C:/T3 Code Projects/Item-finder/src/scan-model.js:109>) (109–117).

Validation checks actual position values but trusts Three's cached bounds, which originate from GLB POSITION accessor min/max metadata. Incorrect metadata drives camera fitting and culling away from the real geometry.

A triangle at the origin with reported bounds near [10000, 10000, 10000] passed validation and put actual vertices beyond the fitted camera's far plane. The parent independently confirmed the accepted false bounds. Recompute geometry bounds and bounding spheres from validated coordinates, including appropriate instance and morph handling.

### 10. P2 — Invalid shader attributes pass import validation

Location: [src/scan-model.js:88](<C:/T3 Code Projects/Item-finder/src/scan-model.js:88>) (88–98).

Only positions and indices are validated. Invalid or undersized normals, colours, and other rendering attributes can still be committed as replacements, producing broken shading, colours, or rendering.

Accepted fixtures included three GLB positions with only one normal, OBJ faces referencing nonexistent normals that became NaN, and an OBJ with three positions but one colour. The parent independently reproduced the latter two; a headless GPU probe confirmed changed rendered pixels with the shortened colour buffer. Validate supported attribute layouts, cardinality, and finite components; regenerate/reject invalid normals and fill missing OBJ colours consistently.

### 11. P2 — External texture rejection is swallowed

Location: [src/scan-model.js:64](<C:/T3 Code Projects/Item-finder/src/scan-model.js:64>) (64–73).

The URL modifier rejects external images, but Three catches image-loading failures and substitutes a null texture. Import therefore succeeds with missing textures instead of reporting the intended self-contained-file error; replacement can remove existing markers for an incomplete scan.

A GLB referencing an external HTTPS image resolved successfully with material.map equal to null. No external request was allowed; this is an error-propagation bug, not an observed network-policy bypass. Reject external image URIs during preflight and propagate required texture failures.

### 12. P2 — Failed embedded textures retain Blob URLs

Location: [src/scan-model.js:71](<C:/T3 Code Projects/Item-finder/src/scan-model.js:71>) (71–73 and 119–120).

Three creates a Blob URL for an embedded image, revokes it on successful decoding, and returns null on a decoding failure. The application does not compensate for the failed path. The encoded image remains retained even after model disposal, so repeated imports accumulate memory.

A native Edge decoding test recorded one URL created, zero revoked, and 130,527 retained bytes for a corrupt PNG after disposal. Import still succeeded. Ensure URL cleanup on both success and failure and reject required texture errors.

### 13. P2 — Decoded textures bypass the import memory budget

Location: [src/scan-limits.js:28](<C:/T3 Code Projects/Item-finder/src/scan-limits.js:28>) (28–40).

Preflight budgets encoded buffer views and accessors but not decoded images. Highly compressed textures can pass the file and decoded-allocation limits while consuming much more CPU/GPU memory.

Headless Edge accepted a 131,256-byte GLB with an 8192 × 4096 texture: 134,217,728 bytes of RGBA pixels before GPU upload or mipmaps, already beyond the 128,000,000-byte budget. No crash was deliberately induced. Check image dimensions and aggregate decoded costs before decoding, with per-image limits.

### 14. P2 — Alternate GLB scenes bypass allocation accounting

Locations: [src/scan-model.js:71](<C:/T3 Code Projects/Item-finder/src/scan-model.js:71>) (71–73) and [src/scan-limits.js:55](<C:/T3 Code Projects/Item-finder/src/scan-limits.js:55>) (55–69).

Three loads all scenes and clones reused nodes, while preflight budgets each node once and the application keeps only the default scene. Scene multiplicity can therefore amplify allocations outside the budget.

A 14,136-byte GLB with 100 scenes sharing a 1,000-instance node allocated 100 separate instance matrices totalling 6,400,000 bytes. That measured case demonstrates unaccounted expansion; larger exhaustion was not deliberately induced. Load only the selected scene or budget all scene-expanded allocations before parsing.

### 15. P2 — Vertex limits do not bound renderable objects or draw calls

Location: [src/scan-limits.js:45](<C:/T3 Code Projects/Item-finder/src/scan-limits.js:45>) (45–52 and 100–115).

The GLB node cap excludes objects generated from mesh primitives, and OBJ has no equivalent object cap. Many tiny primitives or groups can produce very large scene graphs and draw-call workloads despite a low vertex count.

A 420,512-byte GLB with one node created 10,001 meshes. A 198,935-byte OBJ created 10,001 meshes from 30,003 vertices. Both passed readObject. Bound expanded renderable objects and material groups before parsing as well as vertices. Device-specific frame-rate impact was not benchmarked.

### 16. P3 — Orbit drags trigger marker placement

Location: [src/scan-viewer.js:206](<C:/T3 Code Projects/Item-finder/src/scan-viewer.js:206>) (206–208).

While Place marker is enabled, the canvas click handler accepts the click generated after an orbit drag. Releasing the drag opens placement and consumes the mode even though the user was adjusting the view.

A real Playwright mouse drag of 65 × 20 pixels opened the context menu and changed aria-pressed to false. Track pointer movement and accept placement only below a tap/click movement threshold; exclude multi-touch gestures.

## Final validation and limits

- `node --test --test-timeout=10000 --test-reporter=spec tests/*.test.js` — **74 passed, 0 failed**.
- Playwright scans, scanner-safety, scanner-regressions, review-regressions, account, memory-management, backup-assets, and backup-session suites — **58 passed, 0 failed**, using installed Edge and the isolated review configuration.
- `vite build` — passed, with the existing chunk-size warnings. `git diff --check` passed.
- Added permanent regression coverage for capture interruption/reset, pending account-file retention, false GLB bounds, invalid attributes, external/oversized textures, fallback URL cleanup, alternate-scene expansion, object limits, cloud marker updates with draft preservation, portrait fitting, orbit dragging, recovery export, orphan cleanup/retry, staging protection, and native image decoding.
- Regression files: [scan-model.test.js](<C:/T3 Code Projects/Item-finder/tests/scan-model.test.js>), [capture-depth.test.js](<C:/T3 Code Projects/Item-finder/tests/capture-depth.test.js>), [account-sync.test.js](<C:/T3 Code Projects/Item-finder/tests/account-sync.test.js>), and [scanner-regressions.spec.js](<C:/T3 Code Projects/Item-finder/e2e/scanner-regressions.spec.js>). Existing restore tests also cover concurrent safeguards.
- WebXR lifecycle/reference-space cases used mocks, not physical depth hardware. Cloud transport was mocked; account subscriptions, browser storage, native image decoding, and rendered viewer interactions used application code.
- Existing legacy dirty account records without a saved base-file list conservatively defer cleanup until their next successful reconciliation rather than risking deletion of a restorable file. Abandoned staging leases expire after one hour.
- The shared workspace changed concurrently. The implementation preserves those changes, and the final checks ran against the combined scanner paths. No additional review agents were started for implementation.

Reproduction artifacts:

- [Viewer fitting and cloud marker probes](<C:/Users/david/AppData/Local/Temp/item-finder-review-tools/repro.mjs>)
- [Viewer interaction probe](<C:/Users/david/AppData/Local/Temp/item-finder-review-tools/interaction.mjs>)
- [Persistence general probes](<C:/tmp/haven-scanner-review/probes.mjs>)
- [Restore and conflict probes](<C:/tmp/haven-scanner-review/restore-probes.mjs>)
- [Deletion and rollback probes](<C:/tmp/haven-scanner-review/persistence-probes.mjs>)
- [Isolated browser test configuration](<C:/tmp/haven-scanner-review/playwright.config.mjs>)

Orchestrator V2 reviews:

- [Scanner viewer and marker bug audit](t3-thread://v2/488bcd86-3c50-4334-b47b-6f52c7c9f296/thread:delegated-task:command%3Amcp%3A52c483dd-db5c-46d8-9cba-e36a7c16458a%3Adelegate-task%3Af97a4266-5136-44ec-9bd9-151590fce69c)
- [Depth capture and model parser bug audit](t3-thread://v2/488bcd86-3c50-4334-b47b-6f52c7c9f296/thread:delegated-task:command%3Amcp%3A52c483dd-db5c-46d8-9cba-e36a7c16458a%3Adelegate-task%3A985f3cfc-34d3-40fb-8059-afb77a4d5bba)
- [Scanner persistence and backup bug audit](t3-thread://v2/488bcd86-3c50-4334-b47b-6f52c7c9f296/thread:delegated-task:command%3Amcp%3A52c483dd-db5c-46d8-9cba-e36a7c16458a%3Adelegate-task%3A05e9258c-ddc2-4d11-8d94-9919fe45509c)
