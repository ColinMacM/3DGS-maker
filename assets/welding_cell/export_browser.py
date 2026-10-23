"""Export the clean, fullbright welding-cell visual assembly as a browser-ready GLB.

Run from the repository root:

    blender --background --factory-startup \
      --python assets/welding_cell/export_browser.py

The exporter opens the checked-in clean asset itself. It deliberately selects only
the ten emissive visual meshes, so collision proxies and the authoring camera never
enter the browser artifact.
"""
from __future__ import annotations

import json
from pathlib import Path

import bpy

WORKCELL = Path(__file__).resolve().parent
SOURCE = WORKCELL / "welding_cell.blend"
OUTPUT = WORKCELL / "browser" / "welding_cell.glb"
VISUAL_OBJECTS = (
    "Welding_Table_Visual",
    "Metal_Clamp_Front",
    "Metal_Clamp_Rear",
    "Metal_Welding_Sample",
    "Robot_Mount_Plate",
    "Workcell_Floor",
    "Workcell_Wall_X",
    "Workcell_Wall_Y",
    "Workcell_Wall_Ribs",
    "Workcell_Wall_Rails",
)


def validated_visuals() -> list[bpy.types.Object]:
    expected = set(VISUAL_OBJECTS)
    tagged = {obj.name for obj in bpy.data.objects if obj.get("role") == "visual"}
    if tagged != expected:
        missing = sorted(expected - tagged)
        unexpected = sorted(tagged - expected)
        raise RuntimeError(
            "Welding-cell visual composition changed; "
            f"missing={missing or 'none'}, unexpected={unexpected or 'none'}"
        )

    visuals = [bpy.data.objects.get(name) for name in VISUAL_OBJECTS]
    missing_objects = [
        name for name, obj in zip(VISUAL_OBJECTS, visuals, strict=True) if obj is None
    ]
    if missing_objects:
        raise RuntimeError(f"Missing visual objects: {missing_objects}")

    wrong_types = [obj.name for obj in visuals if obj.type != "MESH"]
    if wrong_types:
        raise RuntimeError(f"Visual objects must be meshes: {wrong_types}")

    without_materials = [obj.name for obj in visuals if not obj.data.materials]
    if without_materials:
        raise RuntimeError(f"Visual objects must have materials: {without_materials}")

    return visuals


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Clean Blender source not found: {SOURCE}")

    bpy.ops.wm.open_mainfile(filepath=str(SOURCE), load_ui=False)
    visuals = validated_visuals()

    bpy.ops.object.select_all(action="DESELECT")
    for obj in visuals:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = visuals[0]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT),
        check_existing=False,
        export_format="GLB",
        use_selection=True,
        export_materials="EXPORT",
        export_normals=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_apply=True,
        export_yup=False,  # Preserve canonical Z-up; the Three.js boundary converts axes.
    )
    if not OUTPUT.is_file() or OUTPUT.stat().st_size == 0:
        raise RuntimeError(f"Blender did not create a non-empty GLB: {OUTPUT}")

    print(
        json.dumps(
            {
                "artifact": OUTPUT.relative_to(WORKCELL).as_posix(),
                "visual_objects": [obj.name for obj in visuals],
                "bytes": OUTPUT.stat().st_size,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
