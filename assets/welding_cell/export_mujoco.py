"""Build and smoke-test a fullbright MuJoCo scene containing only splat-derived assets."""
from __future__ import annotations

import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import mujoco

ROOT = Path(__file__).resolve().parents[2]
WORKCELL = ROOT / "assets" / "welding_cell"
OUTPUT = WORKCELL / "mujoco" / "welding_cell.xml"

VISUAL_MESHES = (
    ("welding_table_visual", "welding_table_visual.obj", "0.18 0.22 0.25 1"),
    ("metal_clamp_front", "metal_clamp_front.obj", "0.50 0.52 0.54 1"),
    ("metal_clamp_rear", "metal_clamp_rear.obj", "0.50 0.52 0.54 1"),
    ("metal_welding_sample", "metal_welding_sample.obj", "0.62 0.64 0.65 1"),
    ("robot_mount_plate", "robot_mount_plate.obj", "0.44 0.47 0.50 1"),
    ("workcell_floor", "workcell_floor.obj", "0.18 0.19 0.21 1"),
    ("workcell_wall_x", "workcell_wall_x.obj", "0.67 0.69 0.70 1"),
    ("workcell_wall_y", "workcell_wall_y.obj", "0.67 0.69 0.70 1"),
    ("workcell_wall_ribs", "workcell_wall_ribs.obj", "0.67 0.69 0.70 1"),
    ("workcell_wall_rails", "workcell_wall_rails.obj", "0.44 0.47 0.50 1"),
)


def values(items):
    return " ".join(f"{float(value):.9g}" for value in items)




def build():
    manifest = json.loads((WORKCELL / "manifest.json").read_text(encoding="utf-8"))
    root = ET.Element("mujoco", {"model": "welding_cell_environment"})
    ET.SubElement(root, "compiler", {"angle": "radian", "meshdir": "../meshes"})
    ET.SubElement(root, "option", {"timestep": "0.001", "integrator": "implicitfast"})
    visual = ET.SubElement(root, "visual")
    ET.SubElement(visual, "headlight", {
        "ambient": "0 0 0",
        "diffuse": "0 0 0",
        "specular": "0 0 0",
    })
    asset = ET.SubElement(root, "asset")
    for name, filename, rgba in VISUAL_MESHES:
        ET.SubElement(asset, "mesh", {"name": name, "file": filename})
        ET.SubElement(asset, "material", {
            "name": f"{name}_fullbright",
            "rgba": rgba,
            "emission": "1",
            "specular": "0",
            "shininess": "0",
        })
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "camera", {"name": "overview", "pos": "2.3 -2.6 2.0", "xyaxes": "0.75 0.66 0 -0.30 0.34 0.89"})
    for name, _, _ in VISUAL_MESHES:
        ET.SubElement(world, "geom", {
            "name": f"visual_{name}", "type": "mesh", "mesh": name,
            "material": f"{name}_fullbright",
            "contype": "0", "conaffinity": "0", "group": "2",
        })
    for box in manifest["collision_boxes"]:
        ET.SubElement(world, "geom", {
            "name": box["name"], "type": "box", "pos": values(box["pos"]),
            "quat": values(box["quat"]), "size": values(value / 2 for value in box["size"]),
            "friction": "0.8 0.01 0.001", "group": "3", "rgba": "0 0 0 0",
        })
    ET.indent(root, space="  ")
    temporary_output = OUTPUT.with_name(f".{OUTPUT.stem}.tmp{OUTPUT.suffix}")
    temporary_output.write_text(ET.tostring(root, encoding="unicode") + "\n", encoding="utf-8")
    return temporary_output


def smoke(model_path):
    model = mujoco.MjModel.from_xml_path(str(model_path))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    for _ in range(10):
        mujoco.mj_step(model, data)
    if model.nq or model.nv or model.nu:
        raise RuntimeError("asset-only workcell unexpectedly contains robot state or actuators")
    if model.nlight:
        raise RuntimeError("fullbright workcell unexpectedly contains scene lights")
    return {
        "model": str(OUTPUT),
        "nq": model.nq,
        "nv": model.nv,
        "nu": model.nu,
        "nbody": model.nbody,
        "ngeom": model.ngeom,
        "nmesh": model.nmesh,
        "nlight": model.nlight,
        "simulation_time_s": data.time,
        "finite_time": math.isfinite(data.time),
    }


if __name__ == "__main__":
    temporary_output = build()
    try:
        result = smoke(temporary_output)
    except BaseException:
        temporary_output.unlink(missing_ok=True)
        raise
    temporary_output.replace(OUTPUT)
    print(json.dumps(result, indent=2))
