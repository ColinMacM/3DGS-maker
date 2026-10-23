# Agent guide

This repository holds two separate products:

- **AR Pose Capture** (`ar-pose-capture/`). The iOS app (`ar-pose-capture/ARPoseCapture/`, `ar-pose-capture/ARPoseCapture.xcodeproj`) and its desktop receiver (`ar-pose-capture/receive_capture.py`). For any work there, follow `ar-pose-capture/AGENTS.md` and `ar-pose-capture/README.md` instead of this guide. Camera poses use the ARKit convention: Y up, −Z forward.
- **Asset Studio** (`studio/`). A Bun + Vite + React + Three.js workspace that turns a Gaussian splat into a simulator-ready 3D asset. Packages live in `assets/<package>/` and are listed in `assets/catalog.json`. See `studio/README.md`.

The two products share no code. Most agent work happens in Asset Studio; the rest of this guide covers only it and does not apply to `ar-pose-capture/`.

## Starting the stack

Run these from `studio/` (`bun install` first):

| Command | What it runs | Port |
|---|---|---|
| `bun run dev` | Vite editor (proxies `/api` to 4174, serves repo `assets/` in dev) | 4173 |
| `bun run dev:server` | Scene-control and export API (`server.ts`) | 4174 |
| `bun run serve` | The same script as `dev:server`. It also serves `studio/dist` (after `bun run build`) and repo `assets/` | 4174 |
| `bun run mcp:scene` | stdio MCP server (`src/mcp/server.ts`) that talks to 4174 | — |

Open `http://127.0.0.1:4173` (dev) or `http://127.0.0.1:4174` (serve). Changes only appear in a browser if one is open.

## The MCP-first rule

Use the `scene_*` MCP tools to edit the live scene. Don't hand-edit `.asset-studio/scene.json` or curl the API while MCP is available. The tools validate input, retry on revision conflicts, and report what actually happened.

**The MCP process keeps the code it started with.** If you edit `studio/src/mcp/**`, `src/domain/**` or `src/splat/**`, the next tool call still runs the old code until the MCP client reconnects or restarts the server. If you edit `studio/server.ts` or `src/server/**`, restart the API on 4174 as well.

**Where clients find the MCP server.** omp reads `.omp/mcp.json` in its working directory only, so the repo has one at the root and `studio/.omp/mcp.json` links to it. Claude Code reads the root `.mcp.json`. After adding or changing either, run `/mcp reload`, or restart the session.

**The API starts itself.** If nothing is listening on 4174, the first `scene_*` call starts `server.ts` detached, logs to `.asset-studio/scene-server.log` and carries on. If an API is already running, MCP uses it. Set `SCENE_STUDIO_AUTOSTART=0` to turn this off. The browser editor on 4173 is never started automatically, so `viewer.connected` stays false until someone opens it.

## Conventions

- Units are metres. The world is **+Z up**.
- `rotationDegrees` is a Three.js **intrinsic XYZ** Euler: R = Rx·Ry·Rz. It is not roll-pitch-yaw. The document stores normalized `quaternionXyzw` `[x, y, z, w]`. Collision-manifest quaternions are `[w, x, y, z]`.
- **Child transforms are parent-local.** A child's `position` is relative to its `parentId`, so reparenting without changing the numbers moves the object. Pass `keepWorldTransform: true` to `scene_update_object` to keep the object in place.
- A box or sphere `position` is its geometric centre. Cylinders and capsules run along local **+Z**. A capsule's total length is `height + 2·radius`, because `height` excludes the end caps.
- A `label` is a billboard sprite. Rotation is ignored, and `size` is the text height in metres.
- Model GLBs must be **Z-up**. Export from Blender with `export_yup=False`, because no axis conversion is applied. A model `source` URL is rooted at repo `assets/`, for example `/fr10/browser/fr10_home.glb`, not `/assets/fr10/...`.
- The source splat gets an implicit **Rx(180°)** before `browser.spz.transform` is applied. The catalog transform is not the whole mapping.
- Layer names:
  - `catalogVisuals` is the **source splat** layer.
  - `assetVisuals` is the **3D asset** layer (the packaged GLB or the authored entities).
  - `collisions` starts hidden.
  - `measurements` shows the overlays.
  - `reference` holds user-imported references.
- **Authored colliders replace package-manifest colliders.** Once any authored collider exists, the `manifest.json` colliders are no longer shown. A linked collider (`entity-box`) follows its box, even when the box is hidden.
- Overlays (`bounds`) are transient and namespaced per tool. Each tool replaces only its own prefix: `splat-bound:` for `scene_fit_splat_bounds` and `voxel-query:` for `scene_inspect_splat_voxels`. `scene_clear_splat_bounds` clears all of them. Expired bounds are left out of `scene_inspect`.
- A box holds one texture, and the texture `face` is in the box's local frame.
- The reception-room capture is X-right, Y-down, Z-depth at about 20 units per metre. Its catalog transform converts it to metric Z-up.

## Traps and how the tools report them

- **Edits that change nothing.** Every mutation result includes `changed`. Setting a value the scene already has returns `changed: false`. Removing an unknown object id returns an error. The revision isn't bumped and nothing is persisted. Check `changed` before assuming success.
- **No browser, nothing rendered.** Results and `scene_inspect` include `viewer: { connected, lastSeenAt, renderErrors }`. `connected` means a browser polled within the last 5 s. `renderErrors` lists current load failures as `"<what>: <message>"`, for example a model GLB returning 404. If `connected` is false, nobody has seen your change.
- **The packaged GLB disappears.** It is shown only when no entity is effectively visible (the entity and all its ancestors have `visible: true`). `scene_inspect` reports this as `catalogAssetShown`.
- **Reframing.** `scene_set_view` reframes the visible scene even when the preset is already current. It does this through the `viewport.frame` command.
- **Concurrent edits.** Tools re-read the scene and rebuild their commands on HTTP 409, up to 3 attempts. After that they fail rather than overwrite browser edits.
- **Build scope is the package only.** `scene_build_target` builds the package of `document.assetId`, resolved through `assets/catalog.json`. The exporters read only that package's `manifest.json`. **Entities and colliders authored in the scene are not exported.** The result reports `assetId`, `packageDirectory` and `exportsSceneEntities: false`.
- **Voxel queries.** `scene_inspect_splat_voxels` defaults to 4 mm voxels and allows at most 16,000,000 cells. Below about 1 cm, the detail is limited by Gaussian size, not voxel size.
  - By default it uses optical-depth density, fills enclosed cavities, and culls invisible Gaussians from 16 hemisphere views.
  - `visibilityViews` can also take viewport presets, such as `["top", "front"]`. Those also drop the sides the named cameras never see.
  - When a rug or cushions merge into furniture feet, set `excludeUpFacingBelowZ` just above the clutter (0.14 for the reception room).
- **Splat tools read the catalog SPZ on disk** for `assetId`. They don't read local imports or references.

## Where state lives

- The scene document lives at `.asset-studio/scene.json` in the **repository root**, not in `studio/`. It is gitignored. The `GET /api/scene` envelope has `schemaVersion: 1`, and the document inside has `schemaVersion: 3`.
- **The browser restores its own state.** If that file is missing (`persisted: false`), the first browser to connect PUTs its localStorage document as the server scene. Deleting the file while a browser is open therefore brings the old scene back. To truly start over, close the browser tabs or clear the site's localStorage first.
- The package catalog (`assets/catalog.json`) is the only browser-side source of package transforms.

## Verification

From `studio/`:

```bash
bun run test    # vitest
bun run build   # tsc typecheck + Vite production build
```

Both run in CI (`.github/workflows/studio.yml`) and in the `.githooks/pre-push` hook, which blocks `git push` when either fails. Enable the hook once per clone with `git config core.hooksPath .githooks`. Never bypass it with `--no-verify`.

After changing `src/domain/**`, reload every open Studio tab, and run `bun run build` if you are using `serve` on 4174. An outdated tab rejects the new server document with "Workspace needs attention … is not a recognized property".
