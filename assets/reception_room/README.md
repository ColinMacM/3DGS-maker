# Reception Room asset

Metric Z-up package built from `/home/colin/Downloads/Reception room.zip`.

| Stage | Artifact |
|---|---|
| Source splat | `source/reception_room.spz` |
| Authored source | `reception_room.blend` |
| Three.js / Unreal mesh | `browser/reception_room.glb` |
| Isaac Sim | `isaac/reception_room.usdc` |
| MuJoCo | `mujoco/reception_room.xml` |
| Shared dimensions and collisions | `manifest.json` |

The source PLY contains 957,834 Gaussians. It is converted losslessly at the package boundary to SPZ v3 with SH degree 0. The capture uses X-right, Y-down, Z-depth coordinates at approximately 20 units per metre. `source_spz_transform` maps it into the Studio's metric Z-up frame, rotates the room and table by 5 degrees, and centers the coffee table at the origin.

The generated coffee-table mesh is a compact box assembly: one slatted tabletop, four apron rails, and four legs. Its 1.36 × 0.80 m top and 0.275 m height come from the aligned Gaussian surface. `build_asset.py`, the Isaac exporter, and the MuJoCo exporter all consume the same `visual_boxes` and `collision_boxes` in `manifest.json`.

## Regeneration

From the repository root:

```bash
# Convert the extracted PLY to SPZ with the Studio's installed Spark encoder.
cd studio
bun -e 'import { transcodeSpz } from "@sparkjsdev/spark"; const input = new Uint8Array(await Bun.file("/tmp/asset-studio-reception-room/scene.ply").arrayBuffer()); const result = await transcodeSpz({ inputs: [{ fileBytes: input, pathOrUrl: "scene.ply" }], maxSh: 0, fractionalBits: 12, version: 3 }); await Bun.write("../assets/reception_room/source/reception_room.spz", result.fileBytes);'
cd ..

blender --background --factory-startup --python assets/reception_room/build_asset.py
blender --background --factory-startup --python assets/reception_room/export_browser.py
uv run --with usd-core --no-project python assets/reception_room/export_isaac.py
uv run --with mujoco --with numpy --no-project python assets/reception_room/export_mujoco.py
```

When the source splat and generated asset are both visible, Asset Studio adds cyan review edges in Three.js. The review overlay is not baked into GLB, OpenUSD, or MuJoCo outputs.
