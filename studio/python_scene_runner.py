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

LAYER_NAMES = {
    "catalogVisuals",
    "parametricModel",
    "collisions",
    "reference",
    "measurements",
}
TABLE_FIELDS = {
    "width",
    "length",
    "topThickness",
    "topHeight",
    "holeDiameter",
    "holePitch",
    "rows",
    "columns",
    "edgeToHole",
    "legSize",
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

    def set_table(**values: float | int) -> None:
        unknown = set(values) - TABLE_FIELDS
        if unknown:
            raise ValueError(f"unknown table fields: {', '.join(sorted(unknown))}")
        scene["table"].update(values)

    def set_table_transform(
        *,
        position: list[float] | tuple[float, float, float] | None = None,
        quaternion_xyzw: list[float] | tuple[float, float, float, float] | None = None,
        scale: list[float] | tuple[float, float, float] | None = None,
    ) -> None:
        transform = scene["tableTransform"]
        if position is not None:
            transform["position"] = list(position)
        if quaternion_xyzw is not None:
            transform["quaternionXyzw"] = list(quaternion_xyzw)
        if scale is not None:
            transform["scale"] = list(scale)

    def set_layer(name: str, visible: bool) -> None:
        if name not in LAYER_NAMES:
            raise ValueError(f"unknown layer: {name}")
        if not isinstance(visible, bool):
            raise TypeError("visible must be a boolean")
        scene["layers"][name] = visible

    def set_overhead_light(
        *,
        enabled: bool | None = None,
        color: str | None = None,
        intensity: float | None = None,
        position: list[float] | tuple[float, float, float] | None = None,
        target: list[float] | tuple[float, float, float] | None = None,
    ) -> None:
        light = scene["viewport"]["overheadLight"]
        if enabled is not None:
            light["enabled"] = enabled
        if color is not None:
            light["color"] = color
        if intensity is not None:
            light["intensity"] = intensity
        if position is not None:
            light["position"] = list(position)
        if target is not None:
            light["target"] = list(target)


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

    def _material(
        color: str,
        metalness: float,
        roughness: float,
        opacity: float,
    ) -> dict[str, Any]:
        return {
            "color": color,
            "metalness": metalness,
            "roughness": roughness,
            "opacity": opacity,
        }

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
        color: str = "#b8c0c4",
        metalness: float = 0,
        roughness: float = 0.7,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "box", name, entity_id, parent_id, position, quaternion_xyzw, scale
        )
        entity["size"] = list(size)
        entity["material"] = _material(color, metalness, roughness, opacity)
        return upsert_entity(entity)

    def add_sphere(
        name: str,
        *,
        radius: float,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        color: str = "#b8c0c4",
        metalness: float = 0,
        roughness: float = 0.7,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "sphere", name, entity_id, parent_id, position, (0, 0, 0, 1), (1, 1, 1)
        )
        entity["radius"] = radius
        entity["material"] = _material(color, metalness, roughness, opacity)
        return upsert_entity(entity)

    def _add_round_primitive(
        kind: str,
        name: str,
        radius: float,
        height: float,
        position: list[float] | tuple[float, float, float],
        quaternion_xyzw: list[float] | tuple[float, float, float, float],
        color: str,
        metalness: float,
        roughness: float,
        opacity: float,
        entity_id: str | None,
        parent_id: str | None,
    ) -> str:
        entity = _base_entity(
            kind, name, entity_id, parent_id, position, quaternion_xyzw, (1, 1, 1)
        )
        entity["radius"] = radius
        entity["height"] = height
        entity["material"] = _material(color, metalness, roughness, opacity)
        return upsert_entity(entity)

    def add_cylinder(
        name: str,
        *,
        radius: float,
        height: float,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        color: str = "#b8c0c4",
        metalness: float = 0,
        roughness: float = 0.7,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        return _add_round_primitive(
            "cylinder", name, radius, height, position, quaternion_xyzw,
            color, metalness, roughness, opacity, entity_id, parent_id
        )

    def add_capsule(
        name: str,
        *,
        radius: float,
        height: float,
        position: list[float] | tuple[float, float, float] = (0, 0, 0),
        quaternion_xyzw: list[float] | tuple[float, float, float, float] = (0, 0, 0, 1),
        color: str = "#b8c0c4",
        metalness: float = 0,
        roughness: float = 0.7,
        opacity: float = 1,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        return _add_round_primitive(
            "capsule", name, radius, height, position, quaternion_xyzw,
            color, metalness, roughness, opacity, entity_id, parent_id
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
        size: float = 0.1,
        color: str = "#ffffff",
        background_color: str = "#111820",
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

    def add_directional_light(
        name: str,
        *,
        position: list[float] | tuple[float, float, float],
        target: list[float] | tuple[float, float, float] = (0, 0, 0),
        color: str = "#ffffff",
        intensity: float = 1,
        entity_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "directional-light", name, entity_id, None, position, (0, 0, 0, 1), (1, 1, 1)
        )
        entity.update({"target": list(target), "color": color, "intensity": intensity})
        return upsert_entity(entity)

    def add_point_light(
        name: str,
        *,
        position: list[float] | tuple[float, float, float],
        color: str = "#ffffff",
        intensity: float = 1,
        distance: float = 0,
        entity_id: str | None = None,
        parent_id: str | None = None,
    ) -> str:
        entity = _base_entity(
            "point-light", name, entity_id, parent_id, position, (0, 0, 0, 1), (1, 1, 1)
        )
        entity.update({"color": color, "intensity": intensity, "distance": distance})
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
        "set_table": set_table,
        "set_table_transform": set_table_transform,
        "set_layer": set_layer,
        "add_measurement": add_measurement,
        "remove_measurement": remove_measurement,
        "set_overhead_light": set_overhead_light,
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
        "add_directional_light": add_directional_light,
        "add_point_light": add_point_light,
    }
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(script, "<workcell-scene-script>", "exec"), globals_dict, {})

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
