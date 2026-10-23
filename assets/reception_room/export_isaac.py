"""Build a metric OpenUSD reception-counter asset for Isaac Sim."""
from __future__ import annotations

import json
from pathlib import Path
import re

from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics, UsdShade

PACKAGE = Path(__file__).resolve().parent
OUTPUT = PACKAGE / "isaac" / "reception_room.usdc"
COLORS = {
    "body": (0.36, 0.20, 0.09),
    "top": (0.72, 0.50, 0.27),
}


def safe(name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_]", "_", name)
    return "_" + value if value and value[0].isdigit() else value


def material(stage: Usd.Stage, name: str, color: tuple[float, float, float]) -> UsdShade.Material:
    path = f"/World/Looks/{name.title()}"
    result = UsdShade.Material.Define(stage, path)
    shader = UsdShade.Shader.Define(stage, path + "/PreviewSurface")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.72)
    result.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
    return result


def add_cube(stage: Usd.Stage, path: str, box: dict, appearance: UsdShade.Material | None = None) -> UsdGeom.Cube:
    cube = UsdGeom.Cube.Define(stage, path)
    cube.CreateSizeAttr(1.0)
    xform = UsdGeom.Xformable(cube)
    xform.AddTranslateOp().Set(Gf.Vec3d(*box["pos"]))
    xform.AddScaleOp().Set(Gf.Vec3d(*box["size"]))
    if appearance is not None:
        UsdShade.MaterialBindingAPI.Apply(cube.GetPrim()).Bind(appearance)
    return cube


def build() -> None:
    manifest = json.loads((PACKAGE / "manifest.json").read_text(encoding="utf-8"))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.unlink(missing_ok=True)
    stage = Usd.Stage.CreateNew(str(OUTPUT))
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    world = UsdGeom.Xform.Define(stage, "/World")
    stage.SetDefaultPrim(world.GetPrim())
    stage.SetMetadata("comment", "Coffee table reconstructed against the supplied reception-room Gaussian splat")
    UsdGeom.Xform.Define(stage, "/World/Looks")
    UsdGeom.Xform.Define(stage, "/World/CoffeeTable")
    UsdGeom.Xform.Define(stage, "/World/Colliders")
    materials = {name: material(stage, name, color) for name, color in COLORS.items()}
    for box in manifest["visual_boxes"]:
        add_cube(stage, f"/World/CoffeeTable/{safe(box['name'])}", box, materials[box["material"]])
    for box in manifest["collision_boxes"]:
        cube = add_cube(stage, f"/World/Colliders/{safe(box['name'])}", box)
        cube.CreateVisibilityAttr().Set(UsdGeom.Tokens.invisible)
        UsdPhysics.CollisionAPI.Apply(cube.GetPrim())
    physics = UsdPhysics.Scene.Define(stage, "/World/PhysicsScene")
    physics.CreateGravityDirectionAttr().Set(Gf.Vec3f(0, 0, -1))
    physics.CreateGravityMagnitudeAttr().Set(9.81)
    stage.GetRootLayer().Save()


def validate() -> dict:
    stage = Usd.Stage.Open(str(OUTPUT))
    prims = list(stage.Traverse()) if stage else []
    colliders = [prim for prim in prims if prim.HasAPI(UsdPhysics.CollisionAPI)]
    cubes = [prim for prim in prims if prim.IsA(UsdGeom.Cube)]
    if not stage or not stage.GetDefaultPrim() or len(cubes) != 22 or len(colliders) != 5:
        raise RuntimeError("Exported OpenUSD stage has incomplete coffee-table geometry")
    return {
        "stage": str(OUTPUT),
        "bytes": OUTPUT.stat().st_size,
        "prims": len(prims),
        "visuals": len(cubes) - len(colliders),
        "colliders": len(colliders),
    }


if __name__ == "__main__":
    build()
    print(json.dumps(validate(), indent=2))
