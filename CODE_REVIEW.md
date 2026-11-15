# Code review and fixes

## Current status

The review originally reported ten findings. Reinspection withdrew the camera-cap claim: 600,000 coordinates represent 200,000 points, matching the documentation. The other nine findings have now received targeted fixes or mitigations. Finding numbers below are retained for traceability.

The original browser probes reproduced malformed backup acceptance and orphaned files after a failed guest copy. They have been converted to ordinary regression tests and expanded to eight browser cases. No expected-failure exemptions remain. Application changes were made after the user explicitly authorized fixes.

A follow-up scanner review found six additional issues. All six now have targeted fixes and regression coverage, documented as findings 11-16.

## 1. Malformed scan bytes accepted during restore - Fixed

**Original defect:** Restore checked the data URL and file size without parsing the scan. An empty point cloud, truncated GLB, or invalid OBJ could replace the active inventory before the viewer discovered the bad file.

**Change:** [src/scan-model.js](src/scan-model.js) contains the parser and geometry checks shared by the viewer and restore. `stageBackup()` in [src/scan-storage.js](src/scan-storage.js) validates each scan before storing it, stages files under new IDs, and rolls back earlier staged files if a later file fails. Validation creates no WebGL renderer. Conflicting duplicate asset IDs are rejected; identical duplicate entries from older exports remain accepted.

**Verification:** Four browser cases restore a valid first scan followed by empty points, truncated points, an OBJ without geometry, or a truncated GLB. Each preserves the entire original inventory, keeps the error dialog available, and removes all staged assets. Unit tests also check non-finite coordinates, unusable dimensions, valid points, and OBJ parsing. Existing browser coverage verifies valid OBJ backups still round-trip and valid GLBs still load.

**Limit:** An unavailable storage backend can also prevent rollback. The user receives a failure; cleanup cannot be guaranteed when the browser refuses storage operations.

## 2. Repeated ancestor walks in deep trees - Fixed, with inherent path-size limits

**Original cost:** Validation walked from every location to its root, giving O(L squared) work for a chain of L locations. Uncached full paths also repeated ancestor traversal.

**Change:** [src/location-tree.js](src/location-tree.js) traverses roots iteratively and builds subtree intervals. `validState()` checks that every location is reachable from a root, rejecting cycles and orphan chains in linear structural work. Path construction in [src/store.js](src/store.js) reuses cached ancestor prefixes without eagerly materializing paths for every ancestor. Wide-tree traversal avoids spreading whole child lists into function arguments.

**Verification:** A deterministic unit test validates a 10,000-location chain while counting parent-property reads and enforcing a linear bound. It checks the deepest path, ancestor membership, and rejection of a disconnected cycle. Existing tree, transfer, search-path, and orphan tests pass.

**Limit:** Complete path strings for every node of a deep chain inherently contain a quadratic number of characters. Those strings are still needed when displaying or searching all paths. Arbitrary depth does not have bounded memory use.

## 3. Entire visible inventory rebuilt after edits - Mitigated

**Original cost:** All items were rendered at once, and every edit replaced the application DOM and rebound its controls.

**Change:** Item lists in [src/main.js](src/main.js) render at most 100 rows per page. Controls retain keyboard focus, navigation resets pagination, deletion clamps the selected page, and search opens the page containing its target. Adding or editing an item selects the page containing the saved item when it belongs to the visible list.

**Verification:** Browser coverage uses 205 items to check the row cap, next-page navigation, search highlighting on the last page, deletion, All items reset, and newly added item visibility. Existing desktop, mobile, theme, drag, and gear-edit flows pass.

**Remaining work:** The shell still uses a full render. Room/container cards and sidebar rooms are not paginated. A full incremental-rendering or virtualization rewrite is deferred until profiling establishes a need; item pagination removes the directly identified unbounded item-row cost.

## 4. Repeated scan and marker target searches - Fixed

**Original cost:** The viewer searched the scan array inside the global marker filter, costing O(K times S) for K markers and S scans. Marker-panel refresh also searched the complete item/location array for every target.

**Change:** The inventory index includes item-by-ID, scan-by-location, and marker-by-scan maps. [src/scan-viewer.js](src/scan-viewer.js) reuses the application's current index; its fallback rebuilds only when the inventory object changes. Marker target lookup is constant-time, and camera repaint visits only the active scan's markers. The room scan summary uses the same maps.

**Verification:** Unit tests check index contents. Existing browser tests cover creating, selecting, removing, and moving markers, scan replacement, navigation, restore, and depth capture.

**Limit:** Projecting and updating M visible marker buttons still requires O(M) work. Large-marker rendering has not been benchmarked on physical mobile hardware.

## 5. Large backup memory and repeated asset lookup - Mitigated

**Original cost:** Export retained all base64 assets and then serialized the complete backup again. Restore searched the assets array once for every scan. Export could generate a file larger than the 250 MB restore limit.

**Change:** `createBackupBlob()` in [src/scan-storage.js](src/scan-storage.js) assembles metadata and individual encoded assets as Blob parts. It no longer creates a second JSON string for the entire backup, deduplicates shared asset IDs, and enforces the same 250 MB limit as restore. A base64-size lower bound is checked before encoding each asset, followed by an exact output-size check. Account recovery export uses this path too. Restore builds an asset map once, replacing O(S times A) lookup with O(S + A) work.

**Verification:** Existing image/scan backup browser tests pass with the unchanged version-2 JSON envelope, including scan restore and embedded photo preservation. An additional browser case verifies that two scans sharing an asset export only one file, restore to distinct validated files, and roll back without deleting the source. It also rejects conflicting duplicate asset entries.

**Remaining work:** Restore still reads and parses the whole JSON file, retains its base64 text while staging, and validates one scan at a time. Peak memory near 250 MB has not been measured. A streaming backup format requires a separate compatibility and product decision; these changes preserve existing backups.

## 6. Camera point-cap mismatch - Withdrawn; no change needed

`points.push(p.x, p.y, p.z)` appends three coordinates per point. The 600,000-entry limit in [src/capture-depth.js](src/capture-depth.js) is exactly 200,000 points. The final Float32 coordinate payload at the cap is 2,400,000 bytes, excluding temporary structures and Blob overhead. The earlier claim of a threefold excess was incorrect.

The point array, voxel keys, and conversion allocate memory, but their presence alone does not establish a defect. Existing depth tests pass. A real-device cap/memory benchmark remains optional future work.

## 7. Failed Firestore pruning lost obsolete snapshot IDs - Fixed

**Original defect:** Cleanup attempted to delete only `remote.previous`, discarded rejection, and then lost that ID as the account pointer advanced. Failed cleanup could leave chunks until account deletion.

**Change:** [src/firestore-cleanup.js](src/firestore-cleanup.js) discovers obsolete snapshots directly from stored chunks, including leftovers from prior sessions. It deletes up to eight candidates per transaction and rereads the account pointer inside that transaction, protecting current and previous snapshots if another device publishes concurrently. It stops for missing/deleting accounts. Small cleanup transactions avoid adding old chunk sizes to a potentially large inventory upload transaction.

Cleanup runs on server snapshots and successful publishes. Failures retry with exponential delays from 30 seconds to five minutes while the account is active; account changes cancel obsolete retries. A new publish during a sweep requests another pass. The existing owner rules and default `snapshotId` field index support this; no rules deployment is required.

**Verification:** Unit tests cover retry/backoff, cancellation on sign-out, and a publish during cleanup. Firestore emulator tests sweep multiple pages of historical chunks, retain current/previous files, confirm a second sweep is harmless, and reject cleanup by another account.

**Limits/tradeoffs:** Cleanup adds reads and deletes to Firebase usage. It resumes after interruption when an active client connects; it is not a server job. Administratively created documents without `snapshotId` are outside this query and are still handled by full account deletion. Production credentials and installed production rules were not used in testing.

## 8. Failed guest copy left account-scoped blobs - Fixed

**Original defect:** Copying scan files preceded the inventory save. A missing later source or failed cache write left earlier copies unreferenced in IndexedDB.

**Change:** `copyAssets()` in [src/scan-storage.js](src/scan-storage.js) rolls back partial copies and returns a rollback handle for subsequent metadata failure. [src/account.js](src/account.js) uses that handle until inventory is committed, prevents simultaneous copies, and checks both account identity/epoch and inventory identity before saving. Changes received during a copy cause it to abort safely rather than overwrite newer inventory.

**Verification:** Browser cases reproduce a missing second source and a failed account-cache write after both assets have copied. Both leave no account-scoped staged files, preserve guest assets, and leave account inventory uncommitted. Existing successful guest-copy and account-isolation flows pass.

**Limit:** If IndexedDB refuses cleanup itself, the error explicitly reports that copied files could not be removed. Account deletion continues to enumerate all local assets for that account.

## 9. Quadratic scan cleanup and marker ancestry on every save - Fixed

**Original cost:** Every old scan searched all remaining scans for its asset ID, and every marker walked its target's ancestor chain.

**Change:** [src/main.js](src/main.js) builds sets of retained/removed asset IDs and deletes removed assets in one storage transaction. [src/scan-data.js](src/scan-data.js) uses tree intervals for constant-time marker subtree checks after one iterative tree pass. Structural pruning is O(L + I + S + K) for locations, items, scans, and markers.

**Verification:** Existing transfer tests and scan browser flows check that external pins are removed, internal pins remain, and subtree deletion/replacement preserves unrelated inventory. Deep-tree tests exercise the interval structure.

## 10. Repeated search normalization and destination sorting - Fixed

**Original cost:** Location text was normalized for every query term; all result objects were allocated before the 30-result slice. Destination dialogs sorted full paths repeatedly while inventory was unchanged.

**Change:** [src/store.js](src/store.js) precomputes location search text alongside item text. `searchInventory()` counts all matches but allocates at most 30 visible results and computes location paths only for those results. Sorted destination paths are cached for the lifetime of the current inventory index. Index rebuilds invalidate caches after mutations.

**Verification:** Unit tests check total match counts, item-first ordering, normalization, empty searches, location results, and destination-cache reuse. Browser tests check the 30-result cap and total count after deleting an item from a paginated inventory.

## 11. Malformed GLB indices could corrupt inventory - Fixed

**Original defect:** The model validator checked vertex coordinates but not index bounds or layout. A GLB referencing a nonexistent vertex could produce a non-finite ray hit, which was saved as a marker. JSON converted those coordinates to null and the inventory failed validation after reload.

**Change:** [src/scan-model.js](src/scan-model.js) rejects out-of-range indices, unsupported index layouts, and incomplete triangles. [src/scan-viewer.js](src/scan-viewer.js) checks hit coordinates, placement coordinates, and marker coordinates before persistence. Restore uses the same model validator.

**Verification:** Unit tests cover invalid indices, float index buffers, incomplete triangles, and valid GLBs. Browser regressions preserve the previous scan and markers across reload, reject injected non-finite ray hits, and roll back backup staging after a malformed GLB.

## 12. Small GLBs could allocate enormous buffers before rejection - Fixed

**Original defect:** The vertex limit ran after model loading. A 260-byte GLB could request a 1.2 GB typed array before validation reached that limit.

**Change:** [src/scan-limits.js](src/scan-limits.js) preflights GLB headers, accessor counts, combined declared buffer-view/accessor allocations, and bounded scene hierarchies before invoking Three.js. OBJ preflight counts source vertices and triangulated/line/point expansion before parsing; point-cloud counts are checked before geometry creation.

**Verification:** Tests replace the loaders with fail-fast mocks and confirm oversized accessors, overlapping buffer-view budgets, excessive decoded attribute data, oversized OBJ expansion, cyclic hierarchies, and excessive nesting are rejected without invoking a loader.

**Limits:** This bounds the checked geometry and declared buffer allocations, not all browser/GPU memory, image decompression, or main-thread latency. Near-limit mobile memory use still needs physical-device profiling.

## 13. Shared scan files were deleted while still referenced - Fixed

**Original defect:** The viewer unconditionally deleted a removed/replaced scan's asset even if another valid scan referenced that same asset ID.

**Change:** Viewer cleanup checks references and account scope before deleting an old asset. The application's existing reference-aware cleanup remains in place.

**Verification:** Browser tests remove and replace one room's scan, then reload and successfully open another room referencing the same original file.

## 14. Stale model coordinates could be saved against a replacement scan - Fixed

**Original defect:** Remote inventory updates changed the active scan ID while the open viewer and placement form retained the old geometry and coordinates.

**Change:** The main application notifies viewers about inventory replacements. The viewer snapshots scan identity, invalidates stale geometry/forms, and rechecks identity, asset, format, scope, and location around placement and asynchronous imports. Closing or invalidating a viewer aborts its camera capture. Imports that become stale discard their staged file instead of overwriting newer metadata.

**Verification:** Browser tests replace a scan through a simulated account update while a form or file read is pending, and confirm the replacement is preserved. A viewer without subscriptions also rejects a placement after in-place metadata mutation.

## 15. Instanced and indexed workloads bypassed the complexity guard - Fixed

**Original defect:** Counting base position attributes alone allowed small GLBs with many instances or repeated indices to perform far more rendering and picking work than the documented cap suggested.

**Change:** Preflight and loaded-model checks budget geometry using the larger of position/index counts, multiplied by instance counts. Scene-node references contribute to the same budget. Supported small instanced models remain valid.

**Verification:** Unit tests confirm a 900-vertex, 10,000-instance model is rejected before loader allocation, along with excessive indexed work across repeated meshes. Browser tests preserve the active scan when such an import fails.

## 16. Camera cancellation was inactive during startup - Fixed

**Original defect:** Cancel handlers were installed only after session permission, graphics compatibility, and reference-space setup finished. A slow or stuck startup left a busy viewer with an inert Cancel button.

**Change:** Capture registers cancellation before starting asynchronous setup, resolves cancellation immediately, and closes late sessions. Abort signals connect viewer cleanup and invalidation to capture cleanup. Finish is disabled until setup is ready. Setup/session/shutdown failures settle the operation and release graphics resources.

**Verification:** Unit tests cover cancellation during permission, graphics, and reference-space setup, late permission rejection, aborts, early session loss, and failed shutdown. Browser tests exercise all three startup phases and forced viewer closure, while existing simulated-depth tests still save and reload point clouds.

## Initial review validation

- Unit suite: 43 passed, including scan validation, deep-tree complexity, search/index behavior, and cleanup scheduling.
- Full Playwright suite: 43 passed using installed Microsoft Edge, including all eight new regression cases. Expected-failure annotations were removed.
- Firestore emulator/rules suite: 6 passed using the demo project, including paginated obsolete-snapshot cleanup and account isolation.
- Production build: passed. Vite still reports large lazy-loaded Three.js and Firebase chunks; splitting beyond the existing lazy boundaries was not part of these fixes.
- Whitespace checks: clean.

Node 24.11.1 and Java 21 were used from temporary local runtime directories; no system PATH or production service was changed. Test/build outputs were directed to temporary directories where configurable. Near-limit backup memory and physical WebXR hardware performance have not been measured.

## Follow-up scanner validation

- Unit suite: 58 passed, including malformed geometry, pre-allocation complexity limits, and camera startup cancellation.
- Full Playwright rerun: 58 passed using installed Microsoft Edge, including 27 scanner and review regression cases.
- An earlier full browser run had one transient theme-color assertion failure. All three theme tests passed in isolation, followed by the clean full-suite rerun; no unrelated theme changes were made.
- Production build: passed. Existing large Three.js and Firebase chunk warnings remain.
- Whitespace checks: clean.

The follow-up did not change Firestore rules; the emulator suite was not rerun. Camera lifecycle tests use simulated WebXR sessions; physical-device capture and near-limit memory performance still require hardware testing.
