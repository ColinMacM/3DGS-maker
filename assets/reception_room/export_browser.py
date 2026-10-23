"""Export the authored reception counter as a browser- and Unreal-ready GLB."""
from __future__ import annotations

import json
from pathlib import Path

import bpy

PACKAGE = Path(__file__).resolve().parent
SOURCE = PACKAGE / "reception_room.blend"
OUTPUT = PACKAGE / "browser" / "reception_room.glb"


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Blender source not found: {SOURCE}")
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE), load_ui=False)
    visuals = sorted(
        (obj for obj in bpy.data.objects if obj.get("role") == "visual"),
        key=lambda obj: obj.name,
    )
    if len(visuals) != 17 or any(obj.type != "MESH" for obj in visuals):
        raise RuntimeError("Reception visual composition is incomplete")

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
        export_yup=False,
    )
    if not OUTPUT.is_file() or OUTPUT.stat().st_size == 0:
        raise RuntimeError(f"Blender did not create a non-empty GLB: {OUTPUT}")
    print(json.dumps({
        "artifact": OUTPUT.relative_to(PACKAGE).as_posix(),
        "visual_objects": [obj.name for obj in visuals],
        "bytes": OUTPUT.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
