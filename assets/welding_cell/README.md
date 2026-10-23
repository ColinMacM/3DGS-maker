# Welding cell assets

Metric, Z-up assets reconstructed in Blender from the captured workcell. This package contains only the Blender-authored environment; it does **not** contain the FR10 robot, URDF, articulation, or controllers.

## Entry points

| Use | File |
|---|---|
| Blender source | `welding_cell.blend` |
| Isaac Sim / OpenUSD | `isaac/welding_cell.usdc` |
| MuJoCo | `mujoco/welding_cell.xml` |
| Shared dimensions and collision proxies | `manifest.json` |
| Interchange visual meshes | `meshes/*.obj` |
| Browser catalog model | `browser/welding_cell.glb` |
| Browser catalog metadata | `studio.asset.json` |

The exported frame places the floor at `z = 0` and the table top at `z = 0.6477 m`. `+X` crosses the 30-inch table width; `+Y` follows the 54-inch table length.

Table dimensions:

- Top: `0.762 × 1.3716 × 0.1016 m` (30 × 54 × 4 inches)
- Hole diameter: `0.01905 m` (3/4 inch)
- Hole pitch: `0.0508 m` (2 inches)

## Physics representation

The detailed OBJ meshes are visual-only. Physics uses 41 lightweight oriented boxes for the floor, walls, table, mount plate, clamps, and welding sample. This is appropriate for scene layout and robot/contact training without forcing either simulator to collide against dense reconstruction geometry.

The table holes are represented visually, not as through-hole collision geometry. Add explicit hole fixtures only if a task requires pin insertion or contact inside a hole.

## Regeneration

From the `3DGS-maker` root:

```bash
# Rebuild the clean Blender asset from the checked-in OBJ meshes and manifest.
blender --background --factory-startup \
  --python assets/welding_cell/build_blender_asset.py

# Browser catalog GLB for Workcell Studio.
blender --background assets/welding_cell/welding_cell.blend \
  --python assets/welding_cell/export_browser.py

# OpenUSD export and structural validation.
uv run --with usd-core --no-project \
  python assets/welding_cell/export_isaac.py

# MuJoCo export and a 10-step compile/simulation smoke test.
python assets/welding_cell/export_mujoco.py
```

To refresh the OBJ meshes from the reconstruction source, open that source `.blend` in Blender and run `assets/welding_cell/export_from_blender.py`.

`export_mujoco.py` requires the `mujoco` Python package. Both simulator files are standalone environment assets intended to be composed with a robot separately.
