# RAM management review

**Latest runtime measurements:** see [TEST_AUDIT_REPORT.md](TEST_AUDIT_REPORT.md) for the 2026-11-15 isolated app RAM and repeated-lifecycle audit. The figures and unmeasured-runtime statements below describe an earlier review.

**Scope:** initial source review and background-process snapshot, followed by an authorized code cleanup and regression checks. The process numbers below belong to the initial audit; live application RAM and savings have not been measured.

## Current RAM measurement

The initial inspection did not identify a running Item Finder tab or Vite server. No browser-tab heap baseline was captured. Browser apps use shared browser processes, so process names alone cannot establish their RAM footprint.

The observable Node and Edge WebView2 processes used **424.8 MiB working set** and **246.1 MiB private bytes** combined. These are not Item Finder measurements: the WebView2 processes belonged to Windows Search, and the Node processes belonged to the Codex computer-use runtime. One runtime Node process accounted for about **39.1 MiB working set / 21.1 MiB private bytes**. Treat these figures as unrelated background-process usage, not as the app's baseline.

## Findings

### Cleanup gaps found and fixed in follow-up

The 3D viewer is loaded only when opened. On close, it aborts active capture, unsubscribes from inventory updates, disconnects its `ResizeObserver`, disposes `OrbitControls` and model resources, disposes and force-loses the WebGL context, removes its dialog, and unregisters window navigation listeners (`src/scan-viewer.js`). Camera capture ends the WebXR session and releases its WebGL context (`src/capture-depth.js`).

The follow-up found concrete issues that the initial review missed:

- **Model disposal omitted instance resources and skeleton textures.** Disposing only geometry/material textures does not release an instanced mesh's own buffers/morph texture or a skeleton's bone textures when replacing a scan. `disposeObject` now disposes instanced meshes and deduplicates skeleton disposal, alongside its existing geometry/material/texture cleanup (`src/scan-model.js`).
- **Closed editor forms retained their submit and canvas handlers.** Those handlers could keep an entire parsed backup or a decoded photo reachable through the hidden dialog until another editor opened or navigation replaced the page. Closing an editor now removes its form and contents. The close handler is defined outside the modal factory so it does not retain the factory's submit callback (`src/main.js`).
- **Restore decoded an entire asset through a binary string and `Uint8Array.from`.** That conversion could create a large intermediate array of numbers in addition to the decoded data. Restore now calculates and checks decoded size before allocation, then decodes base64 in chunks of at most 32,768 characters into one byte buffer. Malformed padding is rejected before decoding (`src/scan-storage.js`).
- **Depth capture accumulated numbers in a growing JavaScript array, then copied them on finish.** It now uses one 2,400,000-byte `Float32Array` for its 200,000-point cap, exports only the used portion, and drops the buffer and voxel entries on completion or cancellation (`src/capture-depth.js`). The voxel `Set` still contributes additional memory.

These changes remove known retention paths and unnecessary temporary allocations. They do not establish a measured whole-app RAM reduction or rule out browser/driver retention.

### Highest memory peaks

1. **Importing and opening a detailed scan.** Files are capped at 30 MB, with a 2-million-vertex limit and a 128 MB declared buffer-view/accessor budget for GLB. Parsing can temporarily keep the file buffer, decoded geometry, validation data, textures, and GPU copies alive together. OBJ parsing also creates a normalized text copy before building geometry. These limits do not cap total RAM or decoded texture pixels, and replacement temporarily overlaps old and new models to preserve the existing scan if import fails (`src/scan-limits.js`, `src/scan-model.js`, `src/scan-viewer.js`).
2. **Restoring a full backup.** Restore accepts up to 250 MB of JSON. It parses the complete JSON, clones inventory metadata, retains encoded asset strings, decodes each asset into bytes and a `Blob`, and validates the scan. A large backup can therefore use several times its on-disk size temporarily (`src/scan-storage.js`; README documents the full-file parse).
3. **Exporting a full backup.** Each scan is encoded to a base64 data URL and JSON `Blob` part. Parts are assembled without stringifying the entire backup again, which helps, but large scan collections still require sizable temporary strings and blobs (`src/scan-storage.js`).
4. **Depth capture.** Capture retains the fixed 2.4 MB point buffer and up to 200,000 voxel keys, with a blob copy at finish. They are released when capture completes; camera/browser resources have additional costs (`src/capture-depth.js`).
5. **Large inventories or embedded photos.** Inventory metadata is held in application state and localStorage; each change rebuilds derived search/index maps. Search results and item rows are capped, which limits DOM growth, but the in-memory state/index still scale with total inventory size (`src/main.js`, `src/store.js`). Saved photos are resized to at most 800 pixels on their longest side with a 180,000-character encoded limit. The landscape crop uses an 800 by 400 canvas. The original image must still be decoded for editing, so its compressed 10 MB file limit does not cap its decoded memory (`src/photo-editor.js`).

Scan files in IndexedDB consume **persistent browser storage**, not ordinary live RAM while idle. They become a RAM concern primarily when parsed/opened or included in backup operations.

## Practical ways to reduce RAM now

- Close the scan dialog when finished. That releases the viewer's graphics resources.
- Keep only one Item Finder tab open. Multiple tabs each hold their own inventory state and, when open, their own browser and graphics resources.
- Prefer simplified scans with fewer vertices and smaller embedded textures. The app's file and vertex limits are validation ceilings, not recommended targets for memory-constrained devices.
- Avoid restoring or exporting a near-250 MB full backup on a low-memory device. Keep fewer/lower-resolution scans in a backup or handle the operation on a machine with more headroom.
- If a tab remains unusually large after closing the viewer, close that tab and reopen it. This clears its page heap and browser graphics context; deleting idle scan files alone mainly reduces storage use.
- For unusually large inventories, remove unneeded records and photos. This reduces persistent data and the state/index rebuilt in memory.

## Measurement follow-up

To determine Item Finder's actual RAM footprint, measure its renderer/tab process with a representative large inventory both with the scan viewer closed and after opening a typical and a largest-allowed scan. Repeat open/close cycles and compare post-close memory after garbage collection or a short settling period. A stable post-close level suggests normal allocation/reclamation; a rising baseline over repeated cycles would justify a heap snapshot and targeted leak investigation. No such runtime memory measurement was performed in this pass.

## Validation of the fixes

- All 61 unit tests passed, including new checks for shared skeleton/instance disposal, the capture point cap, output coordinates, and short-capture buffer slicing.
- All 24 relevant browser tests passed in Microsoft Edge. Coverage includes chunked restore with exact byte preservation, rejecting oversized assets before decoding, malformed padding, closing photo/restore editors, failed-restore rollback, scan replacement, and simulated WebXR capture.
- The production Vite build passed. Vite still reports its existing large-chunk warning for Firebase/Three.js bundles.
- New regression coverage is in `tests/scan-model.test.js`, `tests/capture-depth.test.js`, and `e2e/memory-management.spec.js`. Physical WebXR hardware and actual heap/GPU memory savings were not measured.

