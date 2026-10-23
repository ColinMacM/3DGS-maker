"""Build the clean metric reception-desk Blender source from the shared manifest."""
from __future__ import annotations

import json
from pathlib import Path

import bpy
from mathutils import Vector

PACKAGE = Path(__file__).resolve().parent
MANIFEST = PACKAGE / "manifest.json"
OUTPUT = PACKAGE / "reception_room.blend"
COLORS = {
    "body": (0.36, 0.20, 0.09, 1.0),
    "top": (0.72, 0.50, 0.27, 1.0),
}


def reset() -> None:
    for datablocks in (
        bpy.data.objects,
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.materials,
    ):
        for datablock in list(datablocks):
            datablocks.remove(datablock, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)


def make_material(name: str) -> bpy.types.Material:
    material = bpy.data.materials.new(name.title())
    material.use_nodes = True
    principled = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    principled.inputs["Base Color"].default_value = COLORS[name]
    principled.inputs["Metallic"].default_value = 0.15 if name in {"trim", "plaque"} else 0.05
    principled.inputs["Roughness"].default_value = 0.45 if name == "plaque" else 0.72
    return material


def add_box(collection: bpy.types.Collection, box: dict, material: bpy.types.Material, role: str) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=box["pos"])
    obj = bpy.context.object
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)
    obj.name = box["name"]
    obj.scale = [value / 2 for value in box["size"]]
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    obj["role"] = role
    obj["size_m"] = box["size"]
    return obj


def main() -> None:
    reset()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    scene = bpy.context.scene
    scene.name = "Reception Room Asset"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene["coordinate_frame"] = "Z-up; floor z=0; coffee table centered at the origin"
    scene["source_spz"] = manifest["source_spz"]

    visuals = bpy.data.collections.new("Visuals")
    collisions = bpy.data.collections.new("Collision Proxies")
    scene.collection.children.link(visuals)
    scene.collection.children.link(collisions)
    collisions.hide_render = True
    collisions.hide_viewport = True

    materials = {name: make_material(name) for name in COLORS}
    for box in manifest["visual_boxes"]:
        add_box(visuals, box, materials[box["material"]], "visual")
    collision_material = materials["body"]
    for box in manifest["collision_boxes"]:
        collider = add_box(collisions, box, collision_material, "collision")
        collider.name = f"COL_{box['name']}"
        collider.display_type = "WIRE"
        collider.hide_render = True

    camera_data = bpy.data.cameras.new("Asset Camera")
    camera = bpy.data.objects.new("Asset Camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (1.8, -2.1, 1.25)
    camera.rotation_euler = ((Vector((0, 0, 0.22)) - camera.location).to_track_quat("-Z", "Y")).to_euler()
    camera_data.lens = 52
    scene.camera = camera

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.025, 0.03, 0.035, 1.0)
    background.inputs["Strength"].default_value = 0.35
    scene.world = world

    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT), compress=True)
    print(json.dumps({
        "blend": str(OUTPUT),
        "visual_objects": len(manifest["visual_boxes"]),
        "collision_proxies": len(manifest["collision_boxes"]),
        "bytes": OUTPUT.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
