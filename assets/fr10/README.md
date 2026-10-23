# FAIRINO FR10

`fairino10_v6.urdf` is the FAIRINO FR10 robot description used by Beadlink. Its seven STL meshes are the pinned copies used by job-coordinator. The URDF remains authoritative for links, joint frames, axes, limits, inertials, and simulator articulation.

`browser/fr10_home.glb` is a static visual projection of that URDF at job-coordinator's home pose:

```text
j1 = 0
j2 = -pi/2
j3 = pi/2
j4 = -pi/2
j5 = -pi/2
j6 = 0
```

Regenerate it from the repository root:

```bash
/home/colin/Downloads/blender-5.2.2-linux-x64/blender \
  --background --factory-startup \
  --python assets/fr10/export_browser.py
```

To show it in Asset Studio, add it as a `model` entity with `source: "/fr10/browser/fr10_home.glb"` (URLs are rooted at repo `assets/`); the welding-cell robot mount plate is at `[0.1, 0.5, 0.66675]` metres. The GLB is exported Z-up, as Studio model entities require. The GLB is visual-only; MuJoCo and Isaac Sim should continue to consume the URDF and simulator-specific physics configuration rather than infer articulation from the GLB.
