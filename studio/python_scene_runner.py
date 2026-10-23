#!/usr/bin/env python3
"""Execute one trusted local scene script against a JSON StudioDocument.

The server supplies the scene and validates the returned document. This runner
intentionally omits file, process, network, import, eval, and exec builtins. It
is a convenience boundary for trusted local automation, not a hardened Python
sandbox for hostile code.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import sys
import traceback
import uuid
from typing import Any

# Defaults shared with the MCP scene server (src/mcp/server.ts).
DEFAULT_COLOR = "#b7834f"

LAYER_NAMES = {
    "catalogVisuals",
    "assetVisuals",
    "collisions",
    "reference",
    "measurements",
}


def read_request() -> tuple[dict[str, Any], str]:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        raise ValueError("runner request must be an object")
    scene = request.get("scene")
    script = request.get("script")
    if not isinstance(scene, dict):
        raise ValueError("runner scene must be an object")
    if not isinstance(script, str) or not script.strip():
        raise ValueError("runner script must be a non-empty string")
    return scene, script


def main() -> None:
    scene, script = read_request()


    def select_asset(asset_id: str, asset_version: str) -> None:
        if not isinstance(asset_id, str) or not asset_id:
            raise ValueError("asset_id must be a non-empty string")
        if not isinstance(asset_version, str) or not asset_version:
            raise ValueError("asset_version must be a non-empty string")
        scene["assetId"] = asset_id
        scene["assetVersion"] = asset_version

    def set_layer(name: str, visible: bool) -> None:
        if name not in LAYER_NAMES:
            raise ValueError(f"unknown layer: {name}")
        if not isinstance(visible, bool):
            raise TypeError("visible must be a boolean")
        scene["layers"][name] = visible

    def set_splat_visible(visible: bool) -> None:
        set_layer("catalogVisuals", visible)

    def set_asset_visible(visible: bool) -> None:
        set_layer("assetVisuals", visible)

    def add_measurement(
        start: list[float] | tuple[float, float, float],
        end: list[float] | tuple[float, float, float],
        *,
        label: str | None = None,
        measurement_id: str | None = None,
    ) -> str:
        identifier = measurement_id or str(uuid.uuid4())
        start_values = list(start)
        end_values = list(end)
        if label is None:
            distance = math.dist(start_values, end_values)
            label = f"{distance:.3f} m"
        scene["measurements"].append(
            {"id": identifier, "label": label, "start": start_values, "end": end_values}
        )
        return identifier

    def remove_measurement(measurement_id: str) -> None:
        scene["measurements"] = [
            measurement
            for measurement in scene["measurements"]
            if measurement.get("id") != measurement_id
        ]

    def euler_degrees(x: float, y: float, z: float) -> list[float]:
        """Return [x, y, z, w] for MCP rotationDegrees: Three.js intrinsic XYZ, R = Rx*Ry*Rz."""
        hx, hy, hz = (math.radians(value) / 2 for value in (x, y, z))
        c1, c2, c3 = math.cos(hx), math.cos(hy), math.cos(hz)
        s1, s2, s3 = math.sin(hx), math.sin(hy), math.sin(hz)
        return [
            s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3,
            c1 * c2 * c3 - s1 * s2 * s3,
        ]

    def _transform(
        position: list[float] | tuple[float, float, float],
        quaternion_xyzw: list[float] | tuple[float, float, float, float],
        scale: list[float] | tuple[float, float, float],
    ) -> dict[str, Any]:
        return {
            "position": list(position),
            "quaternionXyzw": list(quaternion_xyzw),
            "scale": list(scale),
        }

    def _material(color: str, opacity: float) -> dict[str, Any]:
        return {"color": color, "opacity": opacity}

    def _base_entity(
        kind: str,
        name: str,
        entity_id: str | None,
        parent_id: str | None,
        position: list[float] | tuple[float, float, float],
        quaternion_xyzw: list[float] | tuple[float, float, float, float],
        scale: list[float] | tuple[float, float, float],
    ) -> dict[str, Any]:
        entity = {
            "id": entity_id or str(uuid.uuid4()),
            "name": name,
            "kind": kind,
            "visible": True,
            "transform": _transform(position, quaternion_xyzw, scale),
        }
        if parent_id is not None:
            entity["parentId"] = parent_id
        return entity

    def upsert_entity(entity: dict[str, Any]) -> str:
        if not isinstance(entity, dict):
            raise TypeError("entity must be a dictionary")
        identifier = entity.get("id")
        if not isinstance(identifier, str) or not identifier:
            raise ValueError("entity.id must be a non-empty string")
        entities = scene.setdefault("entities", [])
        for index, existing in enumerate(entities):
            if existing.get("id") == identifier:
                entities[index] = entity
                return identifier
        entities.append(entity)
        return identifier

    def remove_entity(entity_id: str) -> None:
        entities = scene.setdefault("entities", [])
        removed = {entity_id}
        previous_size = -1
        while previous_size != len(removed):
            previous_size = len(removed)
            for entity in entities:
                if entity.get("parentId") in removed:
                    removed.add(entity.get("id"))
        scene["entities"] = [
            entity for entity in entities if entity.get("id") not in removed
        ]
        scene["collisions"] = [
            collision
            for collision in scene.get("collisions", [])
            if not (
                collision.get("kind") == "entity-box"
                and collision.get("entityId") in removed
            )
        ]

    def move_entity(
        entity_id: str,
        *,
        position: list[float] | tuple[float, float, float] | None = None,
        quaternion_xyzw: list[float] | tuple[float, float, float, float] | None = None,
        scale: list[float] | tuple[float, float, float] | None = None,
    ) -> None:
        for entity in scene.setdefault("entities", []):
            if entity.get("id") != entity_id:
                continue
            transform = entity["transform"]
            if position is not None:
                transform["position"] = list(position)
            if quaternion_xyzw is not None:
                transform["quaternionXyzw"] = list(quaternion_xyzw)
            if scale is not None:
                transform["scale"] = list(scale)
            return
        raise ValueError(f"unknown entity: {entity_id}")

    def set_entity_visible(entity_id: str, visible: bool) -> None:
        if not isinstance(visible, bool):
            raise TypeError("visible must be a boolean")
        for entity in scene.setdefault("entities", []):
            if entity.get("id") == entity_id:
                entity["visible"] = visible
                return
        raise ValueError(f"unknown entity: {entity_id}")

    def add_box(
        name: str,
        *,
        size: list[float] | tuple[float, float, float],
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        scale: list[float] | tuple[float, float, float] = (1, 1, 1),
        color: str = DEFAULT_COLOR,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "box", name, entity_id, parent_id, position, quaternion_xyzw, scale
        )
        entity["size"] = list(size)
        entity["material"] = _material(color, opacity)
        return upsert_entity(entity)

    def add_sphere(
        name: str,
        *,
        radius: float,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        color: str = DEFAULT_COLOR,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "sphere", name, entity_id, parent_id, position, (0, 0, 0, 1), (1, 1, 1)
        )
        entity["radius"] = radius
        entity["material"] = _material(color, opacity)
        return upsert_entity(entity)

    def _add_round_primitive(
        kind: str,
        name: str,
        radius: float,
        height: float,
        position: list[float] | tuple[float, float, float],
        quaternion_xyzw: list[float] | tuple[float, float, float, float],
        color: str,
        opacity: float,
        entity_id: str | None,
        parent_id: str | None,
    ) -> str:
        entity = _base_entity(
            kind, name, entity_id, parent_id, position, quaternion_xyzw, (1, 1, 1)
        )
        entity["radius"] = radius
        entity["height"] = height
        entity["material"] = _material(color, opacity)
        return upsert_entity(entity)

    def add_cylinder(
        name: str,
        *,
        radius: float,
        height: float,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        color: str = DEFAULT_COLOR,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        return _add_round_primitive(
            "cylinder", name, radius, height, position, quaternion_xyzw,
            color, opacity, entity_id, parent_id
        )

    def add_capsule(
        name: str,
        *,
        radius: float,
        height: float,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        color: str = DEFAULT_COLOR,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        return _add_round_primitive(
            "capsule", name, radius, height, position, quaternion_xyzw,
            color, opacity, entity_id, parent_id
        )

    def add_model(
        name: str,
        *,
        source: str,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        scale: list[float] | tuple[float, float, float] = (1, 1, 1),
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "model", name, entity_id, parent_id, position, quaternion_xyzw, scale
        )
        entity["source"] = source
        return upsert_entity(entity)

    def add_group(
        name: str,
        *,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        scale: list[float] | tuple[float, float, float] = (1, 1, 1),
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        return upsert_entity(_base_entity(
            "group", name, entity_id, parent_id, position, quaternion_xyzw, scale
        ))

    def add_label(
        name: str,
        *,
        text: str,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        size: float = 0.08,
        color: str = "#ffffff",
        background_color: str = "#1a2026",
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "label", name, entity_id, parent_id, position, (0, 0, 0, 1), (1, 1, 1)
        )
        entity.update({
            "text": text,
            "size": size,
            "color": color,
            "backgroundColor": background_color,
        })
        return upsert_entity(entity)


    safe_builtins = {
        "abs": abs,
        "all": all,
        "any": any,
        "bool": bool,
        "dict": dict,
        "enumerate": enumerate,
        "Exception": Exception,
        "float": float,
        "int": int,
        "len": len,
        "list": list,
        "max": max,
        "min": min,
        "print": print,
        "range": range,
        "reversed": reversed,
        "round": round,
        "set": set,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
        "ValueError": ValueError,
        "zip": zip,
    }
    globals_dict = {
        "__builtins__": safe_builtins,
        "scene": scene,
        "math": math,
        "select_asset": select_asset,
        "set_layer": set_layer,
        "set_splat_visible": set_splat_visible,
        "set_asset_visible": set_asset_visible,
        "add_measurement": add_measurement,
        "remove_measurement": remove_measurement,
        "euler_degrees": euler_degrees,
        "upsert_entity": upsert_entity,
        "remove_entity": remove_entity,
        "move_entity": move_entity,
        "set_entity_visible": set_entity_visible,
        "add_box": add_box,
        "add_sphere": add_sphere,
        "add_cylinder": add_cylinder,
        "add_capsule": add_capsule,
        "add_model": add_model,
        "add_group": add_group,
        "add_label": add_label,
    }
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(script, "<asset-scene-script>", "exec"), globals_dict)

    json.dump(
        {"scene": scene, "output": output.getvalue()},
        sys.stdout,
        separators=(",", ":"),
        allow_nan=False,
    )

if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        traceback.print_exception(type(error), error, error.__traceback__, limit=8, file=sys.stderr)
        raise SystemExit(1)
