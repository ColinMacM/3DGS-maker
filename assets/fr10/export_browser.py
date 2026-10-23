"""Export the FAIRINO FR10 URDF at the coordinator's home pose as a browser GLB.

Run from the repository root:

    blender --background --factory-startup --python assets/fr10/export_browser.py

The source URDF and its pinned STL meshes remain the robot-description authority.
The GLB is a static visual projection for Workcell Studio; it is not an
articulation or physics replacement for the URDF.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector


FR10 = Path(__file__).resolve().parent
URDF = FR10 / "fairino10_v6.urdf"
MESHES = FR10 / "meshes"
OUTPUT = FR10 / "browser" / "fr10_home.glb"
HOME = {
    "j1": 0.0,
    "j2": -math.pi / 2,
    "j3": math.pi / 2,
    "j4": -math.pi / 2,
    "j5": -math.pi / 2,
    "j6": 0.0,
}


def values(text: str | None, length: int, default: tuple[float, ...]) -> tuple[float, ...]:
    if not text:
        return default
    parsed = tuple(float(value) for value in text.split())
    if len(parsed) != length:
        raise ValueError(f"Expected {length} values, got {text!r}")
    return parsed


def origin_matrix(element: ET.Element | None) -> Matrix:
    if element is None:
        return Matrix.Identity(4)
    xyz = values(element.get("xyz"), 3, (0.0, 0.0, 0.0))
    rpy = values(element.get("rpy"), 3, (0.0, 0.0, 0.0))
    return Matrix.Translation(Vector(xyz)) @ Euler(rpy, "XYZ").to_matrix().to_4x4()


def material(name: str, rgba: tuple[float, float, float, float]) -> bpy.types.Material:
    result = bpy.data.materials.new(name=name)
    result.use_nodes = True
    shader = next(node for node in result.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = rgba
    shader.inputs["Metallic"].default_value = 0.08
    shader.inputs["Roughness"].default_value = 0.34
    return result


def main() -> None:
    if not URDF.is_file():
        raise FileNotFoundError(URDF)
    root = ET.parse(URDF).getroot()
    if root.tag != "robot":
        raise ValueError(f"Expected a robot root, got {root.tag!r}")

    links = {link.get("name"): link for link in root.findall("link")}
    joints_by_child: dict[str, ET.Element] = {}
    for joint in root.findall("joint"):
        child = joint.find("child")
        if child is None or not child.get("link"):
            raise ValueError(f"Joint {joint.get('name')} has no child link")
        joints_by_child[child.get("link")] = joint

    matrices: dict[str, Matrix] = {}

    def link_matrix(link_name: str) -> Matrix:
        known = matrices.get(link_name)
        if known is not None:
            return known
        joint = joints_by_child.get(link_name)
        if joint is None:
            result = Matrix.Identity(4)
        else:
            parent = joint.find("parent")
            if parent is None or not parent.get("link"):
                raise ValueError(f"Joint {joint.get('name')} has no parent link")
            result = link_matrix(parent.get("link")) @ origin_matrix(joint.find("origin"))
            angle = HOME.get(joint.get("name"), 0.0)
            axis_element = joint.find("axis")
            axis = Vector(values(
                axis_element.get("xyz") if axis_element is not None else None,
                3,
                (1.0, 0.0, 0.0),
            )).normalized()
            result = result @ Quaternion(axis, angle).to_matrix().to_4x4()
        matrices[link_name] = result
        return result

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    imported: list[bpy.types.Object] = []

    for link_name, link in links.items():
        visual = link.find("visual")
        mesh = visual.find("geometry/mesh") if visual is not None else None
        if mesh is None or not mesh.get("filename"):
            continue
        mesh_path = MESHES / Path(mesh.get("filename")).name
        if not mesh_path.is_file():
            raise FileNotFoundError(mesh_path)

        before = set(bpy.data.objects)
        bpy.ops.wm.stl_import(filepath=str(mesh_path))
        created = [obj for obj in bpy.data.objects if obj not in before]
        if len(created) != 1 or created[0].type != "MESH":
            raise RuntimeError(f"Importing {mesh_path} created {[obj.name for obj in created]}")
        obj = created[0]
        obj.name = link_name
        obj.data.name = f"{link_name}_mesh"
        obj.matrix_world = link_matrix(link_name) @ origin_matrix(visual.find("origin"))
        obj["urdf_link"] = link_name
        obj["home_joint_positions_rad"] = json.dumps(HOME, sort_keys=True)

        color = visual.find("material/color")
        rgba = values(color.get("rgba") if color is not None else None, 4, (0.82, 0.85, 0.88, 1.0))
        obj.data.materials.append(material(f"{link_name}_material", rgba))
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        imported.append(obj)

    if set(obj.name for obj in imported) != set(links):
        raise RuntimeError(
            f"Expected visual meshes for {sorted(links)}, got {sorted(obj.name for obj in imported)}"
        )

    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = imported[0]

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

    world_bounds = []
    for obj in imported:
        world_bounds.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    minimum = [min(point[index] for point in world_bounds) for index in range(3)]
    maximum = [max(point[index] for point in world_bounds) for index in range(3)]
    print(json.dumps({
        "artifact": OUTPUT.relative_to(FR10).as_posix(),
        "bytes": OUTPUT.stat().st_size,
        "links": [obj.name for obj in imported],
        "bounds_m": {"min": minimum, "max": maximum},
        "home_rad": HOME,
    }, indent=2))


if __name__ == "__main__":
    main()
