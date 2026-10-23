# Welding cell assets

Metric, Z-up assets reconstructed against the captured workcell Gaussian splat. This package contains only the environment; it does **not** contain the FR10 robot, URDF, articulation, or controllers.

## Entry points

| Use | File |
|---|---|
| Captured Gaussian source | `source/welding_cell.spz` |
| Blender source | `welding_cell.blend` |
| Isaac Sim / OpenUSD | `isaac/welding_cell.usdc` |
| MuJoCo | `mujoco/welding_cell.xml` |
| Shared dimensions and collision proxies | `manifest.json` |
| Interchange visual meshes | `meshes/*.obj` |
| Browser catalog model | `browser/welding_cell.glb` |
| Browser catalog metadata | `studio.asset.json` |

The exported frame places the floor at `z = 0` and the table top at `z = 0.6477 m`. `+X` crosses the 30-inch table width; `+Y` follows the 54-inch table length.

The SPZ is the 1,338,528-Gaussian refined capture, compressed as legacy-gzip SPZ v3 at SH degree 0. Its transform into the canonical workcell frame is recorded in `manifest.json`, `studio.asset.json`, and the root catalog. Workcell Studio displays this scan and loads the aligned GLB only if the SPZ fails; its generated parametric table starts hidden because the scan already contains the captured table. The OBJ/GLB/Blender/simulator geometry is the semantic approximation aligned to that capture; the SPZ itself is visual reference data, not collision geometry.

Table dimensions:

- Top: `0.762 × 1.3716 × 0.1016 m` (30 × 54 × 4 inches)
- Hole diameter: `0.01905 m` (3/4 inch)
- Hole pitch: `0.0508 m` (2 inches)
- Hole grid: `26 × 14` centers, matching the captured top and its four perforated edges
- Frame: `0.072 m` square legs, lower square-tube rails, caster mounts, and wheels measured from the aligned reconstruction

## Physics representation

The detailed OBJ meshes are visual-only. Physics uses 41 lightweight oriented boxes for the floor, walls, table, mount plate, clamps, and welding sample. This is appropriate for scene layout and robot/contact training without forcing either simulator to collide against dense reconstruction geometry.

The table holes are represented visually, not as through-hole collision geometry. Add explicit hole fixtures only if a task requires pin insertion or contact inside a hole.

All distributed visuals are fullbright: the SPZ uses view-independent SH0 color, Blender and GLB materials are emissive/unlit, OpenUSD materials set `emissiveColor`, and MuJoCo materials use emission with the headlight disabled. The generated files contain no scene lights.

## Regeneration

From the `3DGS-maker` root:

```bash
# Recompress the refined Gaussian source for Spark-compatible browser input.
LichtFeld-Studio convert SOURCE_GAUSSIANS.ply \
  assets/welding_cell/source/welding_cell.spz \
  --sh-degree 0 --spz-version 3 --no-provenance -y

# Re-export semantic meshes and collision proxies from the reconstruction aligned to the splat.
blender --background RECONSTRUCTION_SOURCE.blend \
  --python assets/welding_cell/export_from_blender.py

# Rebuild the clean, fullbright Blender asset from those meshes and the manifest.
blender --background --factory-startup \
  --python assets/welding_cell/build_blender_asset.py

# Browser catalog GLB for Workcell Studio.
blender --background assets/welding_cell/welding_cell.blend \
  --python assets/welding_cell/export_browser.py

# Fullbright OpenUSD export and structural validation.
uv run --with usd-core --no-project \
  python assets/welding_cell/export_isaac.py

# Fullbright MuJoCo export and a 10-step compile/simulation smoke test.
python assets/welding_cell/export_mujoco.py
```

`export_from_blender.py` writes `source_spz_transform` into the manifest. If the authored table alignment changes, copy that transform into `assets/catalog.json` and `studio.asset.json` before rebuilding the browser bundle.

`export_mujoco.py` requires the `mujoco` Python package. Both simulator files are standalone environment assets intended to be composed with a robot separately.
