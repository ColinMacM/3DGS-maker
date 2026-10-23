# Workcell Studio

Local-first browser editor for the metric, Z-up welding-cell environment in `assets/welding_cell`. The catalog displays the captured workcell SPZ and retains the aligned semantic GLB as a fallback if the scan cannot load; Blender remains the canonical source for derived meshes and collision proxies. The scene intentionally excludes the robot, URDF, articulation, controllers, and hardware access.

## Run locally

Requires [Bun](https://bun.sh/). From this directory:

```bash
bun install

# Terminal 1: scene-control and build API on loopback port 4174
bun run dev:server

# Terminal 2: React/Vite editor on loopback port 4173
bun run dev
```

Open `http://127.0.0.1:4173`. Vite proxies `/api` to the build service during development.

Production bundle and server:

```bash
bun run build
bun run serve
```

`bun run serve` serves `studio/dist`, the scene-control API, and `/api/build` from `http://127.0.0.1:4174`.

## Workflow

- Review the built-in SH0 `.spz` capture; the aligned fullbright GLB is its browser fallback.
- Edit the captured fixture dimensions, 26 × 14 hole grid, mobile square-tube frame, and canonical transform in metres. The generated parametric table starts hidden because the captured table is already present in the scan.
- Toggle catalog scan visuals, generated parametric geometry, collision proxies, local references, and measurements independently.
- Add local `.ply`, `.splat`, `.ksplat`, `.spz`, `.glb`, or `.obj` references. Spark is loaded only when a splat is requested.
- Splats above 250,000 Gaussians receive a worker-built LOD and render against a 250,000-splat budget so the editor remains responsive while retaining the complete source file.
- Use Select, Move, Rotate, Measure, orthographic views, Focus, undo, and redo directly in the viewport.
- Scene state is saved locally. Reference bytes are stored in IndexedDB; transient blob URLs are never written into scene JSON.
- Export/import the semantic scene recipe through **File**. Binary references are intentionally not embedded in JSON and must be re-imported if their local IndexedDB entry is unavailable.
- Open **Build** to regenerate Blender, OpenUSD, or MuJoCo artifacts with the loopback build service.

The viewport leaves Gaussian colors intrinsic and lights mesh geometry with a soft ambient/hemisphere base plus directional fills from three axes. This keeps the table and robot readable without adding shadows. OpenUSD and MuJoCo visuals remain lighting-independent.

## Local scene-control API

The server is the durable semantic-scene authority. It stores runtime state in the ignored file `.workcell-studio/scene.json`; browser edits are pushed after 120 ms and external revisions appear in the viewport within 500 ms. Every mutation uses optimistic concurrency: read the current `revision`, then submit it as `expectedRevision`. A stale writer receives HTTP `409` instead of overwriting newer work. The document survives server restarts; the revision counter is process-local and resets, so agents must read a fresh snapshot after reconnecting.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/scene` | Read `{ revision, persisted, document }` |
| `PUT` | `/api/scene` | Replace the complete validated document |
| `POST` | `/api/scene/commands` | Apply up to 100 semantic commands atomically |
| `POST` | `/api/scene/python` | Run one constrained Python scene script |
| `GET` | `/api/health` | Read build, Python, and scene-revision status |

Add, replace, or remove a live entity with one command. Reusing an `id` replaces that entity atomically:

```bash
# First GET /api/scene and use its current revision below.
curl -sS http://127.0.0.1:4174/api/scene

curl -sS \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Content-Type: application/json' \
  --data '{
    "expectedRevision": 0,
    "commands": [{
      "type": "entity.upsert",
      "entity": {
        "id": "fixture-stop",
        "name": "Fixture stop",
        "kind": "box",
        "visible": true,
        "transform": {
          "position": [0.18, 0.08, 0.72],
          "quaternionXyzw": [0, 0, 0, 1],
          "scale": [1, 1, 1]
        },
        "size": [0.12, 0.04, 0.08],
        "material": {
          "color": "#d88a32",
          "opacity": 1
        }
      }
    }]
  }' \
  http://127.0.0.1:4174/api/scene/commands
```

Supported entity kinds are `box`, `sphere`, `cylinder`, `capsule`, `model`, `group`, and `label`. Materials contain `color` and `opacity`; Studio renders primitives with neutral physically based defaults under the viewer light rig. A model `source` must be a same-origin absolute `.glb` path such as `/welding_cell/browser/model.glb`. `parentId` may target a `group`; removing a group also removes its descendants. Other command types mirror `src/state/commands.ts`: table parameter/transform updates, layer visibility, reference add/remove, measurement add/remove, and reset. Committed changes appear in an open viewport through the 500 ms scene synchronization without source edits, a build, or a page reload.

New and removed entities use a brief welding-spark poof plus a scale transition. The viewport disables both effects when the operating system requests reduced motion.

## Python scene scripts

Python scripts receive a mutable `scene` dictionary plus generic entity helpers. One call is enough to add an object:

```python
fixture_id = add_box(
    "Fixture stop",
    entity_id="fixture-stop",
    size=[0.12, 0.04, 0.08],
    position=[0.18, 0.08, 0.72],
    color="#d88a32",
)
move_entity(fixture_id, position=[0.22, 0.08, 0.72])
print(f"updated {fixture_id}")
```

`upsert_entity()` accepts the complete entity dictionary for capabilities not covered by a convenience helper. The convenience helpers are `add_box`, `add_sphere`, `add_cylinder`, `add_capsule`, `add_model`, `add_group`, and `add_label`. Use `move_entity`, `set_entity_visible`, and `remove_entity` for lifecycle changes. Existing helpers remain available for the table, layers, and measurements.

Run a file or pipe a script:

```bash
bun run scene:python -- adjust_scene.py

printf 'add_sphere("marker", radius=0.04, position=[0, 0, 0.8])\n' \
  | bun run scene:python -- -
```

The helper reads the active revision, executes the script through `/api/scene/python`, prints script output, and reports the committed revision. `math` is preloaded. File, process, network, import, `eval`, and nested `exec` builtins are intentionally unavailable. Scripts run in isolated Python (`-I -S`) with a 10-second, 64 KiB source, and 256 KiB output limit. The server validates the complete returned document before committing it.

This is a convenience boundary for trusted local automation, not a hardened sandbox for hostile Python. The API remains loopback-only and mutating requests require an approved loopback `Origin`.


## Coordinate and data contract

- Units: metres.
- Semantic up axis: `+Z`.
- Table width: `+X`; table length: `+Y`.
- Quaternions in scene JSON: `[x, y, z, w]`.
- Collision quaternions imported from `manifest.json`: `[w, x, y, z]` and converted at the rendering boundary.
- Three.js receives a single canonical `Z-up -> Y-up` root transform. Simulator exporters consume the canonical Z-up data.
- Scene schema version: `2` (`src/domain/types.ts` and `src/domain/schema.ts`).

`assets/catalog.json` is the browser catalog. `assets/welding_cell/studio.asset.json` identifies the aligned SPZ capture and the fallback fullbright GLB. The checked-in SPZ is legacy-gzip SPZ v3 with SH degree 0 for Spark compatibility and view-independent color.

Regenerate the browser inputs from the repository root:

```bash
LichtFeld-Studio convert SOURCE_GAUSSIANS.ply \
  assets/welding_cell/source/welding_cell.spz \
  --sh-degree 0 --spz-version 3 --no-provenance -y

blender --background RECONSTRUCTION_SOURCE.blend \
  --python assets/welding_cell/export_from_blender.py
blender --background --factory-startup \
  --python assets/welding_cell/build_blender_asset.py
blender --background assets/welding_cell/welding_cell.blend \
  --python assets/welding_cell/export_browser.py
```

`export_from_blender.py` records the PLY/SPZ-to-canonical transform in `manifest.json`. Keep the same transform in `catalog.json` and `studio.asset.json` whenever the authored table alignment changes. The viewport applies that transform before its single canonical `Z-up -> Y-up` display conversion.

## Build service boundary

`server.ts` binds only to `127.0.0.1`. The client can select only three fixed targets: `blender`, `openusd`, or `mujoco`. Request values are never interpolated into a shell command. The service limits request size, captured process output, run time, and concurrent builds; it does not contact robot hardware.

Environment overrides:

- `BLENDER_BIN`: absolute Blender executable path.
- `MUJOCO_PYTHON`: Python executable with `mujoco` installed. Without it, the service uses `uv run --with mujoco --with numpy --no-project`.
- `SCENE_PYTHON`: Python executable for scene scripts. Defaults to `python3`.

## Verification

```bash
bun run test
bun run build
```

The tests cover scene validation, coordinate invariants, reducer history, revision conflicts, scene transactions, scene serialization, and IndexedDB draft/blob restoration. Browser verification should additionally exercise table edits, external API updates, Python scripts, reference import, measurements, and at least one simulator build.
