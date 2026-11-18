# Haven 

A lightweight home inventory app. Start with a living room, garage, and bathroom, add rooms and nested containers, and record exactly where each item belongs. Search by item name, notes, or location; a result opens and highlights the item in its container.

## Multiple houses

Run `npm run audit:house-deletion` for repeatable house-deletion performance and memory checks. Add `-- --depth=160` for the deep nesting stress fixture, or `-- --retention` for a focused dialog-retention probe. Reports are written to `test-results/audit/house-deletion.md` and `house-deletion-retention.md`, alongside raw JSON samples. These checks use isolated synthetic inventory and mocked or disabled account services.

Use the house picker in the header to switch houses or choose **Add house**. Give the new house a name, then add its rooms. The picker includes search for quickly finding a house in a long list and works on desktop and mobile. There is no fixed house-count limit; browser storage and account sync size limits still apply.

Existing inventory stays in **My home**. Each house has its own rooms, nested containers, items, search results, and scan markers. The last selected house is remembered on this device separately for guest mode and each account. Switching houses does not change inventory or trigger a cloud save.

To rename a house, switch to it, open the house picker, and choose **Rename house**. Edit the prefilled name and select **Save**. Names must be unique (ignoring case) and 1–80 characters long. Renaming preserves the house's rooms, items, scans, and current selection, and saves through the same device or account sync as other edits.

Backups include **all houses** and their locally available scan files. Restoring replaces the entire collection after confirmation; older single-home backups are still supported. Account sync includes every house, and copying device inventory into an account adds separate houses without mixing their contents into existing houses.

To delete a house, switch to it and choose **Delete house** in the house picker or house editor. At least one other house must already exist; create another house first if deletion is disabled. Move rooms and their contents together to another house, or choose separate destinations for rooms, containers, and items. **Delete everything** requires a second confirmation and removes the house's rooms, items, scans, and pins. You must always keep at least one house.

If guest inventory cannot be loaded, ordinary edits are blocked rather than replacing the saved value with sample data. Export saves the original raw metadata as a `haven-raw-recovery-*.json` file; it is not a full scan backup and may need repair before restoring. Reload retries loading, and an explicit, confirmed restore can replace the unreadable value. Browser history remembers house context, and existing room links select the house that owns the room.

## Storage and performance

Inventory and marker metadata are stored in this browser's localStorage; binary scans are stored in IndexedDB, on this site's origin. Optional Google accounts sync inventory and scan markers. Guest mode stays local. Export JSON backups from the sidebar (or footer on mobile); restoring replaces the current inventory after confirmation. Clearing browser data removes the inventory. Storage failures are reported and changes are not silently accepted.

The 3D viewer uses Three.js, loaded only when a scan is opened. Room scanning needs no external scanning service or remote fonts. 3D scans from the webpage requires a device that supports OpenXR. 

## GitHub Pages

The `Deploy Haven to GitHub Pages` workflow builds and deploys every push to `main`.
The production build uses `/Haven/` as its asset base path.
In repository **Settings → Pages**, set **Source** to **GitHub Actions** once.
The deployment URL is `https://undeadcommander.github.io/Haven/` after a successful Pages deployment.
Inventory saved on a local preview does not automatically transfer to this URL; export and restore a backup to move it.


## Themes and moving items

Choose **Add item → Import existing item** or **Add a container → Import existing container** to move an existing entry into the current space. The picker shows full location paths. For items, you can change **Location** before opening the picker. Import moves the original; containers bring their nested contents and scans. Entries already directly in the destination are hidden, as are rooms and containers that would create a nesting loop. You can still create a new entry using the usual form.

Use the color theme picker in the header to choose Light, Dark, OLED black, Dark grey, Rose, Aqua, Midnight, Plum, Linen, or Lavender. Midnight and Plum offer dark palettes; Linen and Lavender offer light palettes. OLED black uses a pure black page and card background. The initial theme follows the device setting; an explicit choice is remembered. Each item has a Move button that can transfer it into any room or nested container. Moving an item clears its scan markers because the old coordinates no longer describe its position.

Use the **gear** on any container card or item row to change its name, description, color, and destination without opening the container. Container destinations show the full path and exclude the container itself and everything inside it. The **Move container** button is also available inside a container.

With a mouse, drag a container card or item row onto another container, a room card, or a room under **MY ROOMS** in the sidebar. Breadcrumbs also accept drops into an ancestor. Valid destinations highlight during the drag; dropping elsewhere or pressing Escape cancels it. Gear settings provide the same moves for keyboard and touch users.

All items, nested containers, and their scans move together. Pins in scans outside the moved container are cleared because they describe its old position; pins in its own scans are preserved. Moving an item clears that item's scan pins. Item colors are saved with the inventory and included in backups and account sync; older inventories without item colors remain supported.

## 3D room scans

Open a room or container and choose **Add 3D scan**.

- **Import scan** accepts self-contained GLB (embedded textures, without Draco/KTX2 compression) and OBJ geometry. Export GLBs as static meshes without morph targets; morph targets are rejected before loading to avoid unbounded render allocations. OBJ material sidecar files are not imported. Maximum file size: 30 MB; maximum geometry: two million vertex entries, including repeated indices and instances. GLB preflight also limits declared decoded buffers and accessor data to 128 MB combined, scene nodes to 10,000, and child nesting to 128 levels before model loading. One scan is stored per location.
- **Scan with camera** requests an immersive WebXR AR session with CPU depth sensing and DOM overlay. It requires HTTPS, camera permission, and a compatible phone/browser that exposes those capabilities. Ordinary desktop webcams and browsers without WebXR depth sensing cannot create a depth scan. Import remains available on those devices.
- Move slowly around the room, then choose **Finish scan**. Capture collects an untextured point cloud, with 3 cm sampling and a 200,000-point cap. This is experimental depth capture, not photogrammetry or a textured mesh reconstruction service. Tracking drift and device depth quality affect accuracy.
- Drag to orbit, scroll/pinch to zoom, Shift-drag to pan. Right-click a surface to **Add item** or **Mark container**. On touch screens, select **Place marker**, then tap a surface. Select an existing item/container in this location's subtree or create a new one.
- Click a dot to read details. Container markers open the actual container page, where more items and nested containers can be created. Removing a marker never deletes its inventory target. Replacing a scan clears that scan's old markers after the new file saves successfully.
- Full JSON backups include scan files and markers. Old inventory-only backups still restore. Restore validates scan contents with the same parser used by the viewer, then stages files under new IDs before replacing inventory. A failed restore removes staged files and preserves the active inventory. Export assembles the backup in Blob parts to reduce temporary copies. Export and restore share a 250 MB limit; restore still parses the complete JSON file in memory.

The renderer draws on camera/size changes rather than running a permanent animation loop, caps pixel density at 2, and releases graphics resources when closed. Normal room navigation does not download the 3D engine or read scan files.

Malformed geometry indices and non-finite marker coordinates are rejected before saving. A scan replaced or removed through account sync invalidates the open viewer and any pending placement/import; close and reopen it to continue. Removing or replacing a scan preserves any file still referenced by another scan. Camera cancellation works during permission and graphics setup as well as during capture; a session that arrives after cancellation is immediately closed. Finish scan stays disabled until startup completes.

Validation includes GLB and OBJ loading, mouse/touch placement, linking existing targets, container navigation, transfer cleanup, IndexedDB persistence, full backup restore, unsupported camera handling, and simulated WebXR capture. Physical depth capture has not been verified on real AR hardware in this cloud environment.


## Google sign-in and account sync

See [Firebase account setup](firebase/SETUP.md). The integration requires a real Firebase project with Google Authentication, Firestore, and private access rules. The public configuration is in `src/firebase-config.json`; it now contains the public configuration for `sign-in-for-haven`. Authentication, Firestore setup, and rules must also be enabled in that project. Never commit a service-account key.

Use **Sign in → Continue with Google** to create or access an account. Existing guest data is copied only through the explicit **Copy device inventory to account** action. If a copy fails before its inventory is saved, its staged scan files are removed. Account status reports pending, saving, saved, failed, and conflicting changes. Each account has a separate local cache; scan files remain on the originating device and can be transferred through backups.

Sync acknowledgments and safe cache-only updates with unchanged inventory do not interrupt editing; accepted acknowledgments advance the local sync revision before the next save. If another tab actually changes the inventory, editing and background sync pause and ask you to reload. Queued changes, delayed downloads, and old upload acknowledgments cannot replace a newer tab’s pending cache or discard its retained scan files.

Inventory writes are serialized per guest or account storage key. The saved snapshot is checked inside the same lock as the write, so competing tabs cannot both pass a stale check and overwrite one another. Saves finish before dialogs close; cancellation or a scope change while waiting for the lock cancels the pending write. Web Locks are used where available, with an IndexedDB transaction mutex as the browser fallback.

### Account deletion

Deletion requires a fresh Google verification and removes the Haven authentication account, all Firestore inventory chunks (including older snapshots), the profile, and that account's local cache, recovery copy, and scan files on this browser. The Google account, separate guest inventory, other accounts, downloaded backups, and local copies on other devices are not deleted.

Sync pauses before deletion and waits for any submitted upload to settle. A temporary Firestore revision marker tells active clients to pause too. If cleanup fails, authentication is retained until cloud cleanup succeeds, and the deletion remains paused across reloads; use **Delete account** again to finish. This is a client-driven flow, so keep the page open until it completes.
