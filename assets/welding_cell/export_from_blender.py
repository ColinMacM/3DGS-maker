"""Export the metric welding-cell reconstruction aligned against the captured splat.

Run this script in the authored reconstruction .blend. The Gaussian source is
distributed separately as ``source/welding_cell.spz``; visual meshes and collision
proxies are exported in the same canonical metric frame.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

import bpy
from mathutils import Matrix
import numpy as np

SOURCE_PATH = Path(__file__).resolve() if "__file__" in globals() else Path(bpy.data.filepath).resolve()
OUT = SOURCE_PATH.parent
TABLE = bpy.data.objects["Welding_Table_Visual"]
FLOOR_TO_TABLE_TOP = 0.6477
SOURCE_SPZ = "source/welding_cell.spz"
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


def safe(name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_]", "_", name)
    return ("_" + value if value and value[0].isdigit() else value).lower()


def ensure_mount_plate():
    obj = bpy.data.objects.get("Robot_Mount_Plate")
    if obj is None:
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        obj = bpy.context.object
        obj.name = "Robot_Mount_Plate"
        obj.dimensions = (0.3048, 0.2794, 0.01905)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.parent = TABLE
        obj.location = (0.10, 0.50, 0.01905 / 2)
        bevel = obj.modifiers.new("Edge softening", "BEVEL")
        bevel.width = 0.004
        bevel.segments = 3
    return obj


def physics_matrix(obj):
    return Matrix.Translation((0, 0, FLOOR_TO_TABLE_TOP)) @ TABLE.matrix_world.inverted() @ obj.matrix_world

def splat_transform():
    matrix = Matrix.Translation((0, 0, FLOOR_TO_TABLE_TOP)) @ TABLE.matrix_world.inverted()
    position, quaternion, scale = matrix.decompose()
    return {
        "position": [float(value) for value in position],
        "quaternion_xyzw": [
            float(quaternion.x),
            float(quaternion.y),
            float(quaternion.z),
            float(quaternion.w),
        ],
        "scale": [float(value) for value in scale],
    }


def evaluated_geometry(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
    mesh.calc_loop_triangles()
    transform = physics_matrix(obj)
    points = [transform @ vertex.co for vertex in mesh.vertices]
    triangles = [tuple(triangle.vertices) for triangle in mesh.loop_triangles]
    evaluated.to_mesh_clear()
    return points, triangles


def write_obj(obj, path):
    points, triangles = evaluated_geometry(obj)
    with path.open("w", encoding="utf-8", newline="\n") as output:
        output.write(f"# Metric Z-up visual mesh exported from {bpy.data.filepath}\n")
        output.write(f"o {safe(obj.name)}\n")
        for point in points:
            output.write(f"v {point.x:.9g} {point.y:.9g} {point.z:.9g}\n")
        for a, b, c in triangles:
            output.write(f"f {a + 1} {b + 1} {c + 1}\n")


def component_boxes(obj):
    points, triangles = evaluated_geometry(obj)
    adjacency = [set() for _ in points]
    for face in triangles:
        for a, b in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            adjacency[a].add(b)
            adjacency[b].add(a)
    unvisited = set(range(len(points)))
    boxes = []
    while unvisited:
        seed = unvisited.pop()
        stack, component = [seed], [seed]
        while stack:
            current = stack.pop()
            neighbours = adjacency[current] & unvisited
            unvisited.difference_update(neighbours)
            stack.extend(neighbours)
            component.extend(neighbours)
        values = np.asarray([points[index] for index in component], dtype=float)
        if len(values) < 4:
            continue
        centered = values - values.mean(axis=0)
        _, vectors = np.linalg.eigh(np.cov(centered, rowvar=False))
        rotation = vectors[:, ::-1]
        if np.linalg.det(rotation) < 0:
            rotation[:, -1] *= -1
        projected = centered @ rotation
        low, high = projected.min(axis=0), projected.max(axis=0)
        size = np.maximum(high - low, 0.004)
        center = values.mean(axis=0) + ((low + high) / 2) @ rotation.T
        quaternion = Matrix(rotation.tolist()).transposed().to_quaternion().normalized()
        boxes.append({
            "name": f"{obj.name}_part_{len(boxes):02d}",
            "pos": [float(value) for value in center],
            "quat": [quaternion.w, quaternion.x, quaternion.y, quaternion.z],
            "size": [float(value) for value in size],
        })
    return boxes


def collision_boxes():
    boxes = [
        {"name": "floor", "pos": [-0.126, 0.08, -0.04], "quat": [1, 0, 0, 0], "size": [2.848, 2.34, 0.08]},
        {"name": "wall_x", "pos": [1.323, 0.08, 1.17385], "quat": [1, 0, 0, 0], "size": [0.05, 2.34, 2.3477]},
        {"name": "wall_y", "pos": [-0.126, -1.115, 1.17385], "quat": [1, 0, 0, 0], "size": [2.848, 0.05, 2.3477]},
        {"name": "table_top", "pos": [0, 0, FLOOR_TO_TABLE_TOP - 0.0508], "quat": [1, 0, 0, 0], "size": [0.762, 1.3716, 0.1016]},
        {"name": "robot_mount_plate", "pos": [0.10, 0.50, FLOOR_TO_TABLE_TOP + 0.01905 / 2], "quat": [1, 0, 0, 0], "size": [0.3048, 0.2794, 0.01905]},
    ]
    for x in (-0.33, 0.33):
        for y in (-0.635, 0.635):
            boxes.append({"name": f"table_leg_{x:+.2f}_{y:+.2f}", "pos": [x, y, 0.27305], "quat": [1, 0, 0, 0], "size": [0.0762, 0.0762, 0.5461]})
    for name in ("Metal_Clamp_Front", "Metal_Clamp_Rear", "Metal_Welding_Sample"):
        boxes.extend(component_boxes(bpy.data.objects[name]))
    return boxes


def main():
    (OUT / "meshes").mkdir(parents=True, exist_ok=True)
    ensure_mount_plate()
    for name in VISUAL_OBJECTS:
        write_obj(bpy.data.objects[name], OUT / "meshes" / f"{safe(name)}.obj")
    manifest = {
        "schema_version": 1,
        "units": "m",
        "up_axis": "Z",
        "frame": "floor origin below table center; +X across the 30 in table width; +Y along the 54 in table length",
        "source_blend": bpy.data.filepath,
        "floor_to_table_top_m": FLOOR_TO_TABLE_TOP,
        "source_spz": SOURCE_SPZ,
        "source_spz_transform": splat_transform(),
        "table_top_size_m": [0.762, 1.3716, 0.1016],
        "hole_diameter_m": 0.01905,
        "hole_pitch_m": 0.0508,
        "collision_boxes": collision_boxes(),
        "isaac_stage": "isaac/welding_cell.usdc",
        "mujoco_scene": "mujoco/welding_cell.xml",
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    print(json.dumps({"visual_meshes": len(VISUAL_OBJECTS), "collision_boxes": len(manifest["collision_boxes"])}, indent=2))


if __name__ == "__main__":
    main()
