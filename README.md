# 3DGS-maker

This repository holds two independent products. They share no code, build
system or runtime; work on one never requires touching the other.

| Product | Folder | What it is |
| --- | --- | --- |
| **AR Pose Capture** | [`ar-pose-capture/`](ar-pose-capture/README.md) | iPhone ARKit camera app (Xcode project) and the Python desktop receiver that collects its photos and camera poses over USB or Wi-Fi |
| **Workcell Studio** | [`studio/`](studio/README.md) | Bun + Vite + Three.js browser editor that turns a captured splat into simulator-ready assets in [`assets/`](assets/) |

## AR Pose Capture

Open `ar-pose-capture/ARPoseCapture.xcodeproj` in Xcode. To receive photos on
the computer over Wi-Fi:

```sh
cd ar-pose-capture
python3 receive_capture.py --wifi --output captures
```

See [`ar-pose-capture/README.md`](ar-pose-capture/README.md) for signing, capture
modes, USB and Wi-Fi setup, output files and Metashape import.

## Workcell Studio

`studio/` is a local browser editor for the reconstructed welding cell in
`assets/welding_cell`. Its catalog displays the captured workcell as a compressed,
view-independent SPZ and keeps the aligned semantic GLB as a fallback. The
captured table is shown by default; the generated parametric table starts hidden
to avoid drawing a second table over the scan. Studio provides a metric, Z-up
Three.js work surface for local scan/splat references, measurements, collision review, a revisioned local
scene-control API, constrained Python scene scripts, and fixed-target
Blender/OpenUSD/MuJoCo builds. Studio uses a balanced multi-axis viewer light rig; generated simulator assets contain no scene lights.

See [`studio/README.md`](studio/README.md) for setup, API and Python examples,
supported reference formats, coordinate conventions, and the loopback service
boundary. The environment assets do not include the robot, URDF, articulation,
controllers, or hardware access.

## License

Apache License 2.0; see [LICENSE](LICENSE).
