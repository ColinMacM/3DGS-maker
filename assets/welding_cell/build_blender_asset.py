"""Build a clean .blend containing only the modeled welding-cell assets."""
from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

ROOT = Path(__file__).resolve().parents[2]
WORKCELL = ROOT / "assets" / "welding_cell"
OUTPUT = WORKCELL / "welding_cell.blend"

VISUALS = (
    ("Welding_Table_Visual", "welding_table_visual.obj", "Dark Steel"),
    ("Metal_Clamp_Front", "metal_clamp_front.obj", "Fixture Steel"),
    ("Metal_Clamp_Rear", "metal_clamp_rear.obj", "Fixture Steel"),
    ("Metal_Welding_Sample", "metal_welding_sample.obj", "Welding Sample"),
    ("Robot_Mount_Plate", "robot_mount_plate.obj", "Aluminum"),
    ("Workcell_Floor", "workcell_floor.obj", "Floor"),
    ("Workcell_Wall_X", "workcell_wall_x.obj", "Wall"),
    ("Workcell_Wall_Y", "workcell_wall_y.obj", "Wall"),
    ("Workcell_Wall_Ribs", "workcell_wall_ribs.obj", "Wall"),
    ("Workcell_Wall_Rails", "workcell_wall_rails.obj", "Aluminum"),
)

MATERIALS = {
    "Dark Steel": ((0.18, 0.22, 0.25, 1.0), 0.82, 0.24),
    "Fixture Steel": ((0.50, 0.52, 0.54, 1.0), 0.90, 0.18),
    "Welding Sample": ((0.62, 0.64, 0.65, 1.0), 0.92, 0.20),
    "Aluminum": ((0.44, 0.47, 0.50, 1.0), 0.86, 0.24),
    "Floor": ((0.18, 0.19, 0.21, 1.0), 0.05, 0.72),
    "Wall": ((0.67, 0.69, 0.70, 1.0), 0.05, 0.58),
}


def reset():
    for datablocks in (bpy.data.objects, bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights, bpy.data.materials):
        for datablock in list(datablocks):
            datablocks.remove(datablock, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)


def make_material(name):
    color, metallic, roughness = MATERIALS[name]
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return material


def read_obj(path):
    vertices, faces = [], []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            vertices.append(tuple(float(value) for value in line.split()[1:4]))
        elif line.startswith("f "):
            faces.append(tuple(int(value.split("/")[0]) - 1 for value in line.split()[1:4]))
    return vertices, faces


def add_visual(collection, name, filename, material):
    vertices, faces = read_obj(WORKCELL / "meshes" / filename)
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj["role"] = "visual"
    collection.objects.link(obj)
    return obj


def add_collider(collection, box):
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    obj = bpy.context.object
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)
    obj.name = "COL_" + box["name"]
    obj.location = box["pos"]
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Quaternion(box["quat"])
    obj.scale = [value / 2 for value in box["size"]]
    obj.display_type = "WIRE"
    obj.hide_render = True
    obj["role"] = "collision"
    obj["shape"] = "box"
    obj["size_m"] = box["size"]
    return obj


def main():
    reset()
    scene = bpy.context.scene
    scene.name = "Welding Cell Assets"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene["coordinate_frame"] = "Z-up; floor z=0; table top z=0.6477 m"
    scene["contents"] = "Blender-authored assets only; no Gaussian splat or robot"
    visuals = bpy.data.collections.new("Visuals")
    collisions = bpy.data.collections.new("Collision Proxies")
    scene.collection.children.link(visuals)
    scene.collection.children.link(collisions)
    collisions.hide_render = True
    collisions.hide_viewport = True
    materials = {name: make_material(name) for name in MATERIALS}
    for name, filename, material_name in VISUALS:
        add_visual(visuals, name, filename, materials[material_name])
    manifest = json.loads((WORKCELL / "manifest.json").read_text(encoding="utf-8"))
    for box in manifest["collision_boxes"]:
        add_collider(collisions, box)

    camera_data = bpy.data.cameras.new("Asset Camera")
    camera = bpy.data.objects.new("Asset Camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (2.3, -2.6, 2.0)
    camera.rotation_euler = ((Vector((0, 0, 0.65)) - camera.location).to_track_quat("-Z", "Y")).to_euler()
    camera_data.lens = 48
    scene.camera = camera

    light_data = bpy.data.lights.new("Asset Key Light", "AREA")
    light_data.energy = 1700
    light_data.shape = "DISK"
    light_data.size = 4.0
    light = bpy.data.objects.new("Asset Key Light", light_data)
    scene.collection.objects.link(light)
    light.location = (0, -0.2, 3.5)

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.035, 0.04, 0.05, 1.0)
    background.inputs["Strength"].default_value = 0.45
    scene.world = world

    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT), compress=True)
    print(json.dumps({
        "blend": str(OUTPUT),
        "visual_objects": len(VISUALS),
        "collision_proxies": len(manifest["collision_boxes"]),
        "bytes": OUTPUT.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
