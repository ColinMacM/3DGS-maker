"""Build and smoke-test the reception-counter MuJoCo asset."""
from __future__ import annotations

import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import mujoco

PACKAGE = Path(__file__).resolve().parent
OUTPUT = PACKAGE / "mujoco" / "reception_room.xml"
COLORS = {
    "body": "0.19 0.21 0.22 1",
    "top": "0.40 0.35 0.30 1",
    "inset": "0.07 0.10 0.11 1",
    "trim": "0.55 0.45 0.34 1",
    "plaque": "0.77 0.68 0.54 1",
}


def values(items) -> str:
    return " ".join(f"{float(value):.9g}" for value in items)


def build() -> Path:
    manifest = json.loads((PACKAGE / "manifest.json").read_text(encoding="utf-8"))
    root = ET.Element("mujoco", {"model": "reception_room_asset"})
    ET.SubElement(root, "compiler", {"angle": "radian"})
    ET.SubElement(root, "option", {"timestep": "0.001", "integrator": "implicitfast"})
    asset = ET.SubElement(root, "asset")
    for name, rgba in COLORS.items():
        ET.SubElement(asset, "material", {
            "name": name,
            "rgba": rgba,
            "specular": "0.15",
            "shininess": "0.1",
        })
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "camera", {"name": "overview", "pos": "2.2 -2.7 1.8", "xyaxes": "0.77 0.63 0 -0.25 0.31 0.92"})
    for index, box in enumerate(manifest["visual_boxes"]):
        ET.SubElement(world, "geom", {
            "name": f"visual_{index}_{box['name'].lower().replace(' ', '_')}",
            "type": "box",
            "pos": values(box["pos"]),
            "size": values(value / 2 for value in box["size"]),
            "material": box["material"],
            "contype": "0",
            "conaffinity": "0",
            "group": "2",
        })
    for box in manifest["collision_boxes"]:
        ET.SubElement(world, "geom", {
            "name": box["name"],
            "type": "box",
            "pos": values(box["pos"]),
            "quat": values(box["quat"]),
            "size": values(value / 2 for value in box["size"]),
            "friction": "0.8 0.01 0.001",
            "group": "3",
            "rgba": "0 0 0 0",
        })
    ET.indent(root, space="  ")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_name(f".{OUTPUT.stem}.tmp{OUTPUT.suffix}")
    temporary.write_text(ET.tostring(root, encoding="unicode") + "\n", encoding="utf-8")
    return temporary


def smoke(path: Path) -> dict:
    model = mujoco.MjModel.from_xml_path(str(path))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    for _ in range(10):
        mujoco.mj_step(model, data)
    if model.nq or model.nv or model.nu or model.nlight:
        raise RuntimeError("Asset-only reception scene unexpectedly contains dynamic state, actuators, or lights")
    return {
        "model": str(OUTPUT),
        "nq": model.nq,
        "nv": model.nv,
        "nu": model.nu,
        "nbody": model.nbody,
        "ngeom": model.ngeom,
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
