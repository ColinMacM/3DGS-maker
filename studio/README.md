# Asset Studio

Local-first browser workspace for one portable asset pipeline:

```text
Gaussian splat → 3D asset → Isaac Sim / MuJoCo / Unreal Engine
```

Asset Studio is catalog-driven rather than tied to one scene type. An asset package contributes a source splat, generated GLB, collision manifest, and target artifacts. The repository includes `assets/welding_cell` and `assets/reception_room` as reference packages; the reception package demonstrates an aligned source-splat/coffee-table mesh review. The editor, scene document, package selector, local source imports, and target contract remain generic.

## Run locally

Requires [Bun](https://bun.sh/). From this directory:

```bash
bun install

# Terminal 1: scene-control and export API on loopback port 4174
bun run dev:server

# Terminal 2: React/Vite editor on loopback port 4173
bun run dev
```

Open `http://127.0.0.1:4173`. Vite proxies `/api` to the local service.

Production bundle and server:

```bash
bun run build
bun run serve
```

`bun run dev:server` and `bun run serve` run the same script (`server.ts`). The server always serves the scene-control API and `/api/build`. It also serves `studio/dist` if a build exists, then repo `assets/` (both safe-path), all from `http://127.0.0.1:4174`. In dev, Vite serves `assets/` as its public directory.

Agents should read the repository-root [`AGENTS.md`](../AGENTS.md) first.

## Workflow

1. **Splat** — select a packaged source or add a local `.ply`, `.splat`, `.ksplat`, or `.spz` file.
2. **3D asset** — review the generated GLB independently from the source splat. Toggle collision geometry and add local `.glb` or `.obj` references when needed.
3. **Export** — build the active asset profile for Isaac Sim (`.usdc`), MuJoCo (`.xml`), or Unreal Engine (`.glb`).

The source and generated asset are loaded into separate viewport layers, so they can be compared directly. Splats above 250,000 Gaussians receive a worker-built LOD and render against a 250,000-splat budget while the complete source remains stored.

Select, Move, Rotate, Measure, orthographic views, Focus, undo, and redo operate directly in the viewport. Move and Rotate edit selected semantic objects. Scene state is saved locally; reference bytes live in IndexedDB, while transient Blob URLs are never persisted.

Asset recipes use `.asset.json`. Binary sources are intentionally external and must be re-imported if their IndexedDB entry is unavailable.

## Asset package contract

`assets/catalog.json` contains selectable packages. Every package is metric and Z-up. The catalog is the only browser-side copy of package metadata and transforms. The viewer applies an implicit `Rx(180°)` to the source splat **before** `browser.spz.transform`. URLs are rooted at repo `assets/`.

```json
{
  "schemaVersion": 1,
  "id": "example-asset",
  "version": "1.0.0",
  "name": "Example asset",
  "description": "Source splat and generated simulator-ready asset.",
  "units": "m",
  "upAxis": "Z",
  "browser": {
    "spz": {
      "url": "/example/source/example.spz",
      "transform": {
        "position": [0, 0, 0],
        "quaternionXyzw": [0, 0, 0, 1],
        "scale": [1, 1, 1]
      }
    },
    "glb": "/example/browser/example.glb"
  },
  "manifest": "/example/manifest.json",
  "simulator": {
    "isaac": "/example/isaac/example.usdc",
    "mujoco": "/example/mujoco/example.xml",
    "unreal": "/example/unreal/example.glb"
  },
  "capabilities": ["gaussian-splat", "collision-boxes", "isaac-sim", "mujoco", "unreal"]
}
```

The collision manifest exposes `collision_boxes` in metric Z-up coordinates. A package can omit `browser.spz` when only a generated mesh is available; `browser.glb`, the manifest, and all three target paths are required.

## Local scene-control API

The server is the durable semantic-scene authority. It stores runtime state in the ignored file `.asset-studio/scene.json` at the **repository root**, not in `studio/`. Browser edits are pushed after 120 ms. Every 1000 ms (`POLL_INTERVAL_MS`), the browser sends a heartbeat to `POST /api/scene/viewer-status`, which returns `{ instanceId, revision }`. It fetches `/api/scene` only when that marker changes, so external revisions appear within about one second when a browser is open. The state file is `{ stateFileVersion: 1, revision, document }`, so the revision survives restarts.

When the state file is missing, the server reports `persisted: false`. The first browser to connect then PUTs its localStorage document as the server scene. Deleting the file while a browser is open therefore restores the browser's old scene. Close the tabs or clear the site's localStorage to start fresh, or use the `scene_reset` MCP tool.

The response envelope has its own `schemaVersion: 1`. The `document` inside has `schemaVersion: 3`. Every mutation uses optimistic concurrency: read the current `revision`, then submit it as `expectedRevision`. A stale writer receives HTTP `409`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/scene` | Read the snapshot `{ schemaVersion: 1, revision, persisted, document, viewer }` |
| `PUT` | `/api/scene` | Replace the complete validated document. Returns the snapshot plus `changed` |
| `POST` | `/api/scene/commands` | Apply up to 100 semantic commands atomically. Returns the snapshot plus `changed` |
| `POST` | `/api/scene/viewer-status` | Browser heartbeat and poll with `{ renderErrors: string[] }` (max 32 × 512 chars). Returns `{ instanceId, revision }` |
| `POST` | `/api/scene/python` | Run one constrained Python scene script |
| `POST` | `/api/build` | Build one fixed target (`isaac`, `mujoco`, or `unreal`) for the selected package. Returns `assetId`, `packageDirectory`, `exportsSceneEntities: false` |
| `GET` | `/api/health` | Read `{ ok, buildInProgress, pythonInProgress, sceneRevision, viewer }` |

`viewer` is `{ connected, lastSeenAt, renderErrors }`. `connected` means a browser polled within the last 5 s. `renderErrors` lists the browser's current load failures, such as a catalog splat/GLB, an entity model GLB or a reference, each as `"<what>: <message>"`. A command batch that leaves the document unchanged returns `changed: false`; the revision isn't bumped and nothing is persisted.

Semantic commands include asset selection, viewport reframing (`viewport.frame`), layer visibility, entity upsert/removal, reference add/removal, measurement add/removal, and reset. Reusing an entity `id` replaces it atomically. Supported entity kinds are `box`, `sphere`, `cylinder`, `capsule`, `model`, `procedural`, `group`, and `label`.

Example:

```bash
curl -sS http://127.0.0.1:4174/api/scene

curl -sS \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Content-Type: application/json' \
  --data '{
    "expectedRevision": 0,
    "commands": [{
      "type": "entity.upsert",
      "entity": {
        "id": "asset-origin",
        "name": "Asset origin",
        "kind": "sphere",
        "visible": true,
        "transform": {
          "position": [0, 0, 0],
          "quaternionXyzw": [0, 0, 0, 1],
          "scale": [1, 1, 1]
        },
        "radius": 0.025,
        "material": { "color": "#f3c85b", "opacity": 1 }
      }
    }]
  }' \
  http://127.0.0.1:4174/api/scene/commands
```

## Scene MCP

`bun run mcp:scene` starts a stdio MCP server that turns scene edits into concise function calls. It talks to the same revisioned scene authority as the browser, so accepted calls appear in the viewport within one second and persist in `.asset-studio/scene.json`. The browser polls a lightweight revision marker and only transfers the full scene after a change; a server-instance marker also forces refresh after an API restart reuses a revision number. Start `bun run serve` (or `dev:server`) before connecting the MCP server. The MCP process keeps the code it was started with, so reconnect the MCP client after you edit server or domain code.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "asset-studio-scene": {
      "command": "bun",
      "args": [
        "run",
        "/home/colin/code/3DGS-maker/studio/src/mcp/server.ts"
      ],
      "env": {
        "SCENE_STUDIO_URL": "http://127.0.0.1:4174"
      }
    }
  }
}
```

The server exposes:

| Function | Purpose |
|---|---|
| `scene_inspect` | Read the selected asset, layers, objects (local and world transforms, `rotationDegrees`, `worldSize`), authored collisions, unexpired overlays, `catalogAssetShown`, and `viewer` |
| `scene_list_assets` | List the catalog packages that can be selected |
| `scene_select_asset` | Select a catalog package as the scene's `assetId` |
| `scene_add_object` | Add or replace one box, sphere, cylinder, capsule, GLB (its `source` must exist under repo `assets/`), or label; `collision: true` links a collider to a box |
| `scene_create_assembly` | Create one transform group and its parent-local child objects atomically, including linked box colliders. Rerunning with the same id removes children that are no longer listed (`removedStaleIds`) |
| `scene_update_object` | Patch placement, visibility, material, dimensions, label text/colours/size, or model source. Rejects fields the entity kind cannot take; `keepWorldTransform` keeps the object in place when reparenting |
| `scene_remove_object` | Remove an object or complete group hierarchy and its linked colliders. Returns an error for an unknown id |
| `scene_clear_objects` | Remove all semantic objects. The packaged catalog GLB is shown again |
| `scene_add_measurement` | Add a point-to-point measurement |
| `scene_remove_measurement` | Remove one measurement |
| `scene_reset` | Replace the scene with the default document: the welding-cell asset, no entities, colliders, overlays, measurements or references. The reset is persisted, and an open browser adopts it |
| `scene_measure_splat_piece` | Estimate a box piece’s robust local edges and thickness from nearby Gaussian centers |
| `scene_fit_splat_bounds` | Fit selected axes and publish `splat-bound:` overlays to the live viewport |
| `scene_clear_splat_bounds` | Remove all overlays without changing objects or collisions |
| `scene_transfer_splat_color` | Apply one opacity- and distance-weighted SPZ surface color when sample support is sufficient |
| `scene_transfer_splat_texture` | Project spatially varying SPZ colors onto a selected box face as a PNG texture |
| `scene_inspect_splat_voxels` | Voxelize any oriented world-space splat region and return the occupied cells. Shows temporary `voxel-query:` overlays and never changes the 3D asset |
| `scene_set_collision` | Add or replace an explicit box collider or a collider linked to a box entity. Turns on the `collisions` layer |
| `scene_remove_collision` | Remove one authored collider |
| `scene_clear_collisions` | Remove all authored colliders |
| `scene_set_view` | Set the Perspective, Top, Front, or Right camera preset and reframe the visible scene, even when the preset is unchanged |
| `scene_set_layer` | Show or hide a viewport layer |
| `scene_build_target` | Build the selected package (`document.assetId`) for Isaac Sim, MuJoCo, or Unreal through a fixed exporter. **Scene entities and colliders are not exported** |

Every mutation reports `changed`, plus `viewer` (`connected`, `renderErrors`). `changed: false` means nothing happened, for example a missing id. `connected: false` means no browser is rendering the change. On a revision conflict the tools re-read the scene and rebuild their commands, up to three attempts.

Conventions:

- Units are metres, +Z up.
- `rotationDegrees` is a Three.js intrinsic XYZ Euler: R = Rx·Ry·Rz. It is stored as a normalized `[x, y, z, w]` quaternion.
- Child transforms are parent-local.
- A box or sphere `position` is its geometric centre. Cylinders and capsules run along local +Z. Capsule total length = `height + 2·radius`.
- A label is a billboard sprite. Rotation is ignored, and `size` is the text height in metres.
- Model GLBs must be Z-up. `source` URLs are rooted at repo `assets/`, for example `/fr10/browser/fr10_home.glb`.
- `catalogVisuals` is the source **splat** layer. `assetVisuals` is the **3D asset** layer.
- MCP-created objects belong to the 3D asset layer. The packaged catalog GLB is shown only when no entity is effectively visible (the entity and all its ancestors are visible). `scene_inspect` reports this as `catalogAssetShown`.
- Authored colliders replace package-manifest colliders. The `collisions` layer starts hidden.
- Overlays are transient and namespaced per tool.

Prefer linked colliders for authored boxes. They resolve the entity hierarchy, dimensions, rotation, and scale every time the document changes, so moving or resizing an object updates its collision overlay in the same viewport polling interval. Explicit colliders remain available for compound or intentionally simplified collision geometry. Package-manifest collision boxes are used only when the scene has no authored colliders. A linked collider still resolves while its box is hidden.

Splat fitting treats an existing box as the semantic seed region, transforms SPZ Gaussian centers into that box’s local frame, rejects low-opacity samples, and uses configurable lower/upper percentiles as robust bounding-box edges. `scene_fit_splat_bounds` can fit only the requested axes; use `axes: [\"z\"]` for tabletop thickness without changing its width or depth. `shared: true` applies median bounds across repeated pieces such as slats. Every call replaces only the prior `splat-bound:` overlays and keeps other tools' overlays. It enables the **Measurements** layer, and publishes the overlays within the same one-second viewport polling interval—even with `apply: false`. A viewport-only **AGENT SEES BOUNDING BOX** label identifies the published bounds for 10 seconds, after which both the label and wireframes disappear automatically. The overlays and label are analysis aids, not collision geometry or export content; use `scene_clear_splat_bounds` to remove all overlays earlier. Expired overlays are left out of `scene_inspect`. The decoder supports legacy gzip SPZ v2/v3 and independently compressed SPZ v4 streams.

Color transfer has two levels. `scene_transfer_splat_color` computes one opacity- and Gaussian-distance-weighted base color per box from samples near its six faces. `scene_transfer_splat_texture` instead projects nearby colors into a configurable raster for one face (faces are in the box's local frame, so `z-positive` is the top only for an unrotated box; a box holds one texture, so baking another face replaces it), fills unsupported texels from the nearest sampled texel, embeds the PNG in the scene document, and displays it on the authored mesh. Samples below `minimumSupport` are reported but not applied. The texture preserves spatial variation visible in the splat, including baked lighting and occluding objects; it is not guaranteed to be intrinsic material albedo. A calibrated multi-view UV bake with visibility and exposure handling remains the higher-fidelity option.

`scene_inspect_splat_voxels` accepts an arbitrary position, XYZ rotation, and size in world space. It follows SplatTransform’s Gaussian-density strategy: each splat contributes within its oriented 3-sigma extent, voxel opacity is `1 - exp(-sum(density))`, and a cell is occupied when that opacity reaches `opacityCutoff`. The result reports the grid in the query box’s local frame (`localMinCornerM`, `voxelSizeM`, `dimensions`, occupied cells per Z layer), every occupied cell as per-layer `j:i-ranges` row runs (capped by `maxReturnedRuns`), and six-neighbor connected components with world centers and opacity-weighted SPZ mean colors. Components are geometric object estimates, not semantic classifications. The tool creates no entity, mesh, or file. With `showOverlay: true` (the default) it replaces only the prior `voxel-query:` overlays and keeps fitted splat bounds. It shows a blue wireframe of the search box and a red wireframe of the exposed voxel edges for `overlaySeconds` (default 60), and enables the **Measurements** layer that hosts them. When the cell wireframe would exceed 250,000 edges (fine grids), the viewport draws only the edges where the voxel surface bends, so flat areas show their outline instead of a sub-pixel grid. `voxelSizeM` (default 0.004 m) and `maxGridCells` (default 12,000,000) bound CPU and memory. A grid can have at most 16,000,000 cells. A 1.5 × 0.95 × 0.5 m box at 4 mm takes about 3 s. Below about 1 cm, the detail you get is limited by Gaussian size, not voxel size: the median sigma is about 13 mm in the reception splat. The overlay sends occupancy run-length encoded.

Floor clutter (rugs, cushions) blurs into the feet of furniture because large flat Gaussians reach several centimetres upward within their 3-sigma extent. `excludeUpFacingBelowZ` (world metres, default off) ignores every Gaussian centred below that height whose surface normal—its flattest axis—is within 32° of vertical. Vertical surfaces such as table legs are kept, so the legs reach the floor while the rug drops out; the result reports `excludedUpFacingGaussianCount`. For the reception coffee table, `0.14` cuts the rug layer from 99% to 12% occupancy and leaves the table, legs and teapot as one 1.40 × 0.88 × 0.40 m component. The viewport lists active overlays in an HTML legend at the top left; its × removes every overlay from the scene, like `scene_clear_splat_bounds`.

Two further controls keep every visible Gaussian. `densityModel: "optical-depth"` (the default) treats each Gaussian as a volume whose line integral along its thinnest axis equals its opacity (`-ln(1 - α)`). A voxel then receives `τ · min(1, Δ / (√(2π) · σ_min))`, so thin surface Gaussians keep their full opacity while thick, blurry ones spread theirs over their thickness instead of filling a slab. On the reception table this cut the blur fill in the 4–10 cm floor band from 37% to 9% and thinned the leg halos, with the tabletop layer unchanged. `"opacity"` restores the earlier model. `fillEnclosed` (default on) makes cavities enclosed on all sides solid. `cullInvisible` (default on) renders the box plus 10 cm with exact depth-sorted 3DGS blending and drops Gaussians whose blend weight `α·G·T` never reaches 1/255 in any pixel. This is the visibility criterion of stochastic transparency, computed in expectation, so the result is deterministic. `visibilityViews` is either a count of directions spread over the upper hemisphere (default 16) or a list of viewport presets (`perspective`, `top`, `front`, `right`). A preset list also drops the sides none of those cameras see. The reception splat is already pruned: 16 views cull 27 of 21,891 Gaussians, and the four presets cull 427.


The MCP boundary is the supported agent interface. `scene_build_target` hides the target-specific implementation behind one validated function call; callers do not supply Python or shell source. It exports the package manifest only, and the result says so: `assetId`, `packageDirectory`, `exportsSceneEntities: false`.

## Python scene scripts

Python scripts receive a mutable `scene` dictionary and generic asset/entity helpers:

```python
select_asset("example-asset", "1.0.0")
set_splat_visible(True)
set_asset_visible(True)

marker_id = add_sphere(
    "Asset origin",
    entity_id="asset-origin",
    radius=0.025,
    position=[0, 0, 0],
    color="#f3c85b",
)
move_entity(marker_id, position=[0.1, 0, 0])
```

Python helpers take rotations as `quaternion_xyzw`. To use the MCP Euler convention, call `euler_degrees(x, y, z)`, which returns `[x, y, z, w]` for a Three.js intrinsic XYZ rotation (R = Rx·Ry·Rz). Defaults match MCP: primitive colour `#b7834f`, label size `0.08`, label background `#1a2026`. `remove_entity` removes the entity, its descendants and their linked colliders.

Available lifecycle helpers include `upsert_entity`, `remove_entity`, `move_entity`, `set_entity_visible`, `add_box`, `add_sphere`, `add_cylinder`, `add_capsule`, `add_model`, `add_group`, `add_label`, and `euler_degrees`. `set_layer` controls any validated layer.

Run a file or pipe a script:

```bash
bun run scene:python -- adjust_scene.py
printf 'set_asset_visible(False)\n' | bun run scene:python -- -
```

The runner has no file, process, network, import, `eval`, or nested `exec` builtins. It runs in isolated Python (`-I -S`) with a 10-second, 64 KiB source, and 256 KiB output limit. This is a convenience boundary for trusted local automation, not a hardened sandbox for hostile Python.

## Coordinates

- Units: metres.
- Semantic up axis: `+Z`.
- Quaternions: `[x, y, z, w]`. MCP Euler input: Three.js intrinsic XYZ, R = Rx·Ry·Rz.
- Child transforms are parent-local.
- Source splat: implicit `Rx(180°)`, then `browser.spz.transform`.
- Model GLBs: Z-up, with no axis conversion.
- Collision manifest quaternions: `[w, x, y, z]`, converted at the viewport boundary.
- Three.js receives one canonical `Z-up → Y-up` root transform.
- Simulator exporters consume canonical Z-up data.
- Scene document schema version: `3`. API envelope schema version: `1`.

## Export profiles

`server.ts` accepts only `isaac`, `mujoco`, or `unreal`; request data is never used as a command or path. Export scripts are configured at server startup, keeping the HTTP boundary fixed while allowing another asset package to supply its own exporters.

`/api/build` exports the package of the current scene's `assetId`, resolved through `assets/catalog.json`, and reads only that package's `manifest.json`. Authored scene entities and colliders are not exported. You can still override the package with environment variables:

| Variable | Purpose |
|---|---|
| `ASSET_PACKAGE_DIR` | Repository-relative package directory |
| `ASSET_BASENAME` | Output filename stem |
| `ISAAC_EXPORT_SCRIPT` / `ISAAC_ARTIFACT` | Isaac Sim exporter and `.usdc` output |
| `MUJOCO_EXPORT_SCRIPT` / `MUJOCO_ARTIFACT` | MuJoCo exporter and `.xml` output |
| `UNREAL_EXPORT_SCRIPT` / `UNREAL_ARTIFACT` | Blender-driven Unreal interchange exporter and `.glb` output |
| `BLENDER_BIN` | Absolute Blender executable path |
| `MUJOCO_PYTHON` | Python executable with MuJoCo installed |
| `SCENE_PYTHON` | Python executable for scene scripts; defaults to `python3` |

The service is loopback-only, allows one export at a time, limits request/output size and duration, and never contacts simulator hardware.

## Verification

```bash
bun run test
bun run build
```

Browser verification should additionally exercise package selection, independent Splat/3D asset layers, local source import, one semantic object transform, measurements, and the export drawer at desktop and mobile widths.
