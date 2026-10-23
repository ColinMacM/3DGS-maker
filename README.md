# 3DGS-maker

This repository holds two independent products. They share no code, build
system or runtime; work on one never requires touching the other.

| Product | Folder | What it is |
| --- | --- | --- |
| **AR Pose Capture** | [`ar-pose-capture/`](ar-pose-capture/README.md) | iPhone ARKit camera app (Xcode project) and the Python desktop receiver that collects its photos and camera poses over USB or Wi-Fi |
| **Asset Studio** | [`studio/`](studio/README.md) | Bun + Vite + React + Three.js workspace that turns a Gaussian splat into a simulator-ready 3D asset; packages live in [`assets/`](assets/) |

Agents should read [`AGENTS.md`](AGENTS.md) first (Asset Studio), or
[`ar-pose-capture/AGENTS.md`](ar-pose-capture/AGENTS.md) for the iOS app and
receiver.

## AR Pose Capture

Open `ar-pose-capture/ARPoseCapture.xcodeproj` in Xcode. To receive photos on
the computer over Wi-Fi:

```sh
cd ar-pose-capture
python3 receive_capture.py --wifi --output captures
```

See [`ar-pose-capture/README.md`](ar-pose-capture/README.md) for signing, capture
modes, USB and Wi-Fi setup, output files and Metashape import.

## Asset Studio

`studio/` is a local browser workspace for a generic asset pipeline:

```text
Gaussian splat → 3D asset → Isaac Sim / MuJoCo / Unreal Engine
```

Catalog packages keep the source splat, generated GLB, collision geometry, and
target artifacts aligned in metric Z-up coordinates. The bundled
`assets/welding_cell` and `assets/reception_room` directories are reference
packages, not product-specific editor constraints. Studio also provides local
source imports, measurements, semantic scene entities, a revisioned loopback
API, a stdio Scene MCP for live object function calls, constrained Python scene
scripts, and configurable fixed-target exporters.

See [`studio/README.md`](studio/README.md) for setup, the package contract,
Scene MCP configuration, scene-control API, Python helpers, coordinate
conventions, and exporter profile configuration.

## License

Apache License 2.0; see [LICENSE](LICENSE).
