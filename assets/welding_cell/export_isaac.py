"""Build a self-contained OpenUSD stage from the Blender-authored workcell assets."""
from __future__ import annotations

import json
from pathlib import Path
import re

from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdPhysics, UsdShade

ROOT = Path(__file__).resolve().parents[2]
WORKCELL = ROOT / "assets" / "welding_cell"
OUTPUT = WORKCELL / "isaac" / "welding_cell.usdc"


def safe(name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_]", "_", name.replace("+", "_plus_").replace("-", "_minus_"))
    return "_" + value if value and value[0].isdigit() else value


def parse_obj(path: Path):
    points, faces = [], []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            points.append(tuple(float(value) for value in line.split()[1:4]))
        elif line.startswith("f "):
            faces.append(tuple(int(value.split("/")[0]) - 1 for value in line.split()[1:4]))
    return points, faces


def material(stage, name, color, metallic, roughness):
    path = f"/World/Looks/{name}"
    result = UsdShade.Material.Define(stage, path)
    shader = UsdShade.Shader.Define(stage, path + "/PreviewSurface")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))
    shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(metallic)
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(roughness)
    result.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
    return result


def add_mesh(stage, path, obj_path, appearance):
    points, faces = parse_obj(obj_path)
    mesh = UsdGeom.Mesh.Define(stage, path)
    mesh.CreatePointsAttr(points)
    mesh.CreateFaceVertexCountsAttr([3] * len(faces))
    mesh.CreateFaceVertexIndicesAttr([index for face in faces for index in face])
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    mesh.CreateDoubleSidedAttr(True)
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(appearance)


def add_box(stage, box, appearance=None, visible=False):
    cube = UsdGeom.Cube.Define(stage, f"/World/Environment/Colliders/{safe(box['name'])}")
    cube.CreateSizeAttr(1.0)
    xform = UsdGeom.Xformable(cube)
    xform.AddTranslateOp().Set(Gf.Vec3d(*box["pos"]))
    q = box["quat"]
    xform.AddOrientOp().Set(Gf.Quatf(q[0], Gf.Vec3f(*q[1:])))
    xform.AddScaleOp().Set(Gf.Vec3d(*box["size"]))
    if appearance:
        UsdShade.MaterialBindingAPI.Apply(cube.GetPrim()).Bind(appearance)
    if not visible:
        cube.CreateVisibilityAttr().Set(UsdGeom.Tokens.invisible)
    UsdPhysics.CollisionAPI.Apply(cube.GetPrim())


def build():
    manifest = json.loads((WORKCELL / "manifest.json").read_text(encoding="utf-8"))
    OUTPUT.unlink(missing_ok=True)
    stage = Usd.Stage.CreateNew(str(OUTPUT))
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    world = UsdGeom.Xform.Define(stage, "/World")
    stage.SetDefaultPrim(world.GetPrim())
    stage.SetMetadata("comment", "Metric welding cell exported from the Blender-authored assets")
    UsdGeom.Xform.Define(stage, "/World/Looks")
    UsdGeom.Xform.Define(stage, "/World/Environment")
    UsdGeom.Xform.Define(stage, "/World/Environment/Visuals")
    UsdGeom.Xform.Define(stage, "/World/Environment/Colliders")
    looks = {
        "table": material(stage, "DarkSteel", (0.18, 0.22, 0.25), 0.82, 0.24),
        "fixture": material(stage, "FixtureSteel", (0.50, 0.52, 0.54), 0.90, 0.18),
        "sample": material(stage, "WeldingSample", (0.62, 0.64, 0.65), 0.92, 0.20),
        "aluminum": material(stage, "MountAluminum", (0.44, 0.47, 0.50), 0.86, 0.24),
        "floor": material(stage, "Floor", (0.18, 0.19, 0.21), 0.05, 0.72),
        "wall": material(stage, "Wall", (0.67, 0.69, 0.70), 0.05, 0.58),
    }
    meshes = (
        ("welding_table_visual.obj", "WeldingTable", looks["table"]),
        ("metal_clamp_front.obj", "FrontClamp", looks["fixture"]),
        ("metal_clamp_rear.obj", "RearClamp", looks["fixture"]),
        ("metal_welding_sample.obj", "WeldingSample", looks["sample"]),
        ("robot_mount_plate.obj", "RobotMountPlate", looks["aluminum"]),
        ("workcell_floor.obj", "Floor", looks["floor"]),
        ("workcell_wall_x.obj", "WallX", looks["wall"]),
        ("workcell_wall_y.obj", "WallY", looks["wall"]),
        ("workcell_wall_ribs.obj", "WallRibs", looks["wall"]),
        ("workcell_wall_rails.obj", "WallRails", looks["aluminum"]),
    )
    for filename, name, appearance in meshes:
        add_mesh(stage, f"/World/Environment/Visuals/{name}", WORKCELL / "meshes" / filename, appearance)
    for box in manifest["collision_boxes"]:
        add_box(stage, box)
    physics = UsdPhysics.Scene.Define(stage, "/World/PhysicsScene")
    physics.CreateGravityDirectionAttr().Set(Gf.Vec3f(0, 0, -1))
    physics.CreateGravityMagnitudeAttr().Set(9.81)
    light = UsdLux.DomeLight.Define(stage, "/World/StudioLight")
    light.CreateIntensityAttr().Set(900.0)
    light.CreateColorAttr().Set(Gf.Vec3f(0.92, 0.95, 1.0))
    stage.GetRootLayer().Save()


def validate():
    stage = Usd.Stage.Open(str(OUTPUT))
    prims = list(stage.Traverse()) if stage else []
    colliders = [prim for prim in prims if prim.HasAPI(UsdPhysics.CollisionAPI)]
    meshes = [prim for prim in prims if prim.IsA(UsdGeom.Mesh)]
    rigid_bodies = [prim for prim in prims if prim.HasAPI(UsdPhysics.RigidBodyAPI)]
    joints = [prim for prim in prims if prim.IsA(UsdPhysics.Joint)]
    if not stage or not stage.GetDefaultPrim() or len(meshes) != 10 or len(colliders) != 41:
        raise RuntimeError("exported OpenUSD stage has incomplete workcell geometry")
    if rigid_bodies or joints:
        raise RuntimeError("asset-only OpenUSD stage unexpectedly contains a robot articulation")
    return {
        "stage": str(OUTPUT),
        "bytes": OUTPUT.stat().st_size,
        "prims": len(prims),
        "visual_meshes": len(meshes),
        "colliders": len(colliders),
        "rigid_bodies": len(rigid_bodies),
        "joints": len(joints),
    }


if __name__ == "__main__":
    build()
    print(json.dumps(validate(), indent=2))
