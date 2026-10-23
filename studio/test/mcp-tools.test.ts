import { Matrix4, Quaternion } from "three";

import { createDefaultStudioDocument } from "../src/domain/defaultDocument";
import type { BoxSceneEntity, SceneBounds, SceneEntity, StudioDocument, Transform } from "../src/domain/types";
import { assertModelSourceExists } from "../src/mcp/assetFiles";
import {
  entityWorldPoses,
  eulerDegreesFromQuaternion,
  quaternionFromEulerDegrees,
} from "../src/mcp/sceneMath";
import {
  OVERLAY_NAMESPACES,
  activeBounds,
  mergeOverlayBounds,
  patchEntity,
  planAssembly,
  sceneObject,
  type AssemblyInput,
  type SceneObjectInput,
} from "../src/mcp/sceneTools";
import { reduceStudioDocument } from "../src/state/reducer";

const IDENTITY: Transform = { position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] };

function box(id: string, overrides: Partial<BoxSceneEntity> = {}): BoxSceneEntity {
  return {
    id,
    name: id,
    kind: "box",
    visible: true,
    transform: IDENTITY,
    size: [1, 1, 1],
    material: { color: "#b7834f", opacity: 1 },
    ...overrides,
  };
}

function group(id: string, transform: Transform = IDENTITY, parentId?: string): SceneEntity {
  return { id, name: id, kind: "group", visible: true, transform, ...(parentId ? { parentId } : {}) };
}

function documentWith(entities: SceneEntity[]): StudioDocument {
  return { ...createDefaultStudioDocument(new Date("2026-01-01T00:00:00Z")), entities };
}

describe("Euler conversion", () => {
  it("round-trips Three.js intrinsic XYZ Euler degrees", () => {
    const samples: Array<[number, number, number]> = [
      [0, 0, 0], [90, 0, 0], [0, 45, 0], [0, 0, -120], [30, -60, 170], [-179, 89, 12.5], [10, -20, 30],
    ];
    for (const rotation of samples) {
      const roundTrip = eulerDegreesFromQuaternion(quaternionFromEulerDegrees(rotation));
      roundTrip.forEach((value, index) => expect(value).toBeCloseTo(rotation[index], 5));
    }
  });

  it("composes R = Rx · Ry · Rz", () => {
    const [x, y, z] = [25, -40, 70].map((degrees) => degrees * Math.PI / 180);
    const expected = new Quaternion().setFromRotationMatrix(
      new Matrix4().makeRotationX(x).multiply(new Matrix4().makeRotationY(y)).multiply(new Matrix4().makeRotationZ(z)),
    );
    const actual = quaternionFromEulerDegrees([25, -40, 70]);
    expect(Math.abs(expected.dot(new Quaternion(...actual)))).toBeCloseTo(1, 9);
  });

  it("returns an equivalent rotation for gimbal-lock inputs", () => {
    const quaternion = quaternionFromEulerDegrees([30, 90, 10]);
    const back = quaternionFromEulerDegrees(eulerDegreesFromQuaternion(quaternion));
    expect(Math.abs(new Quaternion(...quaternion).dot(new Quaternion(...back)))).toBeCloseTo(1, 6);
  });
});

describe("world poses", () => {
  it("resolves parent-local child transforms into world pose and size", () => {
    const parent = group("table", {
      position: [1, 2, 0],
      quaternionXyzw: quaternionFromEulerDegrees([0, 0, 90]),
      scale: [2, 2, 2],
    });
    const leg = box("leg", {
      parentId: "table",
      transform: { position: [0.5, 0, 0.25], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
      size: [0.1, 0.2, 0.5],
    });
    const poses = entityWorldPoses([parent, leg]);
    const pose = poses.get("leg")!;
    expect(pose.worldPosition[0]).toBeCloseTo(1, 9);
    expect(pose.worldPosition[1]).toBeCloseTo(3, 9);
    expect(pose.worldPosition[2]).toBeCloseTo(0.5, 9);
    expect(pose.worldRotationDegrees[2]).toBeCloseTo(90, 6);
    expect(pose.localSize).toEqual([0.1, 0.2, 0.5]);
    expect(pose.worldSize).toEqual([0.2, 0.4, 1]);
    expect(pose.effectivelyVisible).toBe(true);
  });

  it("reports capsule length including caps and no size for labels", () => {
    const capsule: SceneEntity = {
      id: "c", name: "c", kind: "capsule", visible: true, transform: IDENTITY,
      radius: 0.1, height: 1, material: { color: "#b7834f", opacity: 1 },
    };
    const label: SceneEntity = {
      id: "l", name: "l", kind: "label", visible: true, transform: IDENTITY,
      text: "hi", color: "#ffffff", backgroundColor: "#000000", size: 0.1,
    };
    const poses = entityWorldPoses([capsule, label]);
    expect(poses.get("c")!.localSize).toEqual([0.2, 0.2, 1.2]);
    expect(poses.get("l")!.worldSize).toBeNull();
  });
});

describe("overlay namespaces", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const overlay = (id: string, expiresAt?: string): SceneBounds => ({
    id,
    label: id,
    position: [0, 0, 0],
    quaternionXyzw: [0, 0, 0, 1],
    size: [1, 1, 1],
    ...(expiresAt ? { expiresAt } : {}),
  });

  it("replaces only the calling tool's overlays and drops expired ones", () => {
    const current = [
      overlay("splat-bound:old", "2026-01-01T00:00:05Z"),
      overlay("voxel-query:search", "2026-01-01T00:01:00Z"),
      overlay("voxel-query:stale", "2025-12-31T23:59:00Z"),
      overlay("manual"),
    ];
    const merged = mergeOverlayBounds(current, OVERLAY_NAMESPACES.fit, [overlay("splat-bound:new")], now);
    expect(merged.map(({ id }) => id)).toEqual(["voxel-query:search", "manual", "splat-bound:new"]);
  });

  it("rejects overlays outside the namespace", () => {
    expect(() => mergeOverlayBounds([], OVERLAY_NAMESPACES.voxels, [overlay("splat-bound:x")], now))
      .toThrow(/outside namespace/);
  });

  it("filters expired bounds for inspection", () => {
    expect(activeBounds([overlay("a", "2025-01-01T00:00:00Z"), overlay("b")], now).map(({ id }) => id)).toEqual(["b"]);
  });
});

describe("patchEntity", () => {
  const label: SceneEntity = {
    id: "sign", name: "Sign", kind: "label", visible: true, transform: IDENTITY,
    text: "A", color: "#ffffff", backgroundColor: "#1a2026", size: 0.08,
  };

  it("rejects fields the kind cannot take", () => {
    expect(() => patchEntity([box("b")], "b", { radius: 2 })).toThrow(/Cannot set radius on box "b"/);
    expect(() => patchEntity([label], "sign", { opacity: 0.5 })).toThrow(/Cannot set opacity on label/);
    expect(() => patchEntity([group("g")], "g", { color: "#ffffff" })).toThrow(/Cannot set color on group/);
    expect(() => patchEntity([box("b")], "b", { size: 2 })).toThrow(/Box size must be/);
    expect(() => patchEntity([label], "sign", { size: [1, 1, 1] })).toThrow(/Label size is one number/);
    expect(() => patchEntity([box("b")], "b", {})).toThrow(/at least one field/);
    expect(() => patchEntity([box("b")], "missing", { name: "x" })).toThrow(/does not exist/);
  });

  it("patches label text, colours and scalar size", () => {
    const patched = patchEntity([label], "sign", { text: "Exit", color: "#FF0000", backgroundColor: "#000000", size: 0.2 });
    expect(patched).toMatchObject({ text: "Exit", color: "#ff0000", backgroundColor: "#000000", size: 0.2 });
  });

  it("patches model source and box material", () => {
    const model: SceneEntity = { id: "m", name: "m", kind: "model", visible: true, transform: IDENTITY, source: "/a.glb" };
    expect(patchEntity([model], "m", { source: "/b.glb" })).toMatchObject({ source: "/b.glb" });
    expect(patchEntity([box("b")], "b", { color: "#ABCDEF", opacity: 0.5 })).toMatchObject({
      material: { color: "#abcdef", opacity: 0.5 },
    });
  });

  it("keeps the world pose when reparenting with keepWorldTransform", () => {
    const parent = group("g", { position: [1, 0, 0], quaternionXyzw: quaternionFromEulerDegrees([0, 0, 90]), scale: [2, 2, 2] });
    const item = box("b", { transform: { position: [1, 1, 1], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] } });
    const patched = patchEntity([parent, item], "b", { parentId: "g", keepWorldTransform: true });
    expect(patched.parentId).toBe("g");
    const world = entityWorldPoses([parent, patched]).get("b")!;
    world.worldPosition.forEach((value, index) => expect(value).toBeCloseTo([1, 1, 1][index], 9));
    world.worldScale.forEach((value) => expect(value).toBeCloseTo(1, 9));

    const moved = patchEntity([parent, item], "b", { parentId: "g" });
    expect(moved.transform.position).toEqual([1, 1, 1]);
  });

  it("validates reparenting", () => {
    const outer = group("outer");
    const inner = group("inner", IDENTITY, "outer");
    expect(() => patchEntity([outer, inner], "outer", { parentId: "inner" })).toThrow(/own descendant/);
    expect(() => patchEntity([box("a"), box("b")], "b", { parentId: "a" })).toThrow(/only group entities/);
    expect(() => patchEntity([box("b")], "b", { keepWorldTransform: true })).toThrow(/requires parentId/);
    expect(() => patchEntity([outer, box("b")], "b", { parentId: "outer", keepWorldTransform: true, position: [0, 0, 0] }))
      .toThrow(/cannot be combined/);
  });
});

describe("planAssembly", () => {
  const object = (id: string, collision = false) => sceneObject.parse({ kind: "box", id, name: id, size: [1, 1, 1], collision });
  const input = (objects: SceneObjectInput[]): AssemblyInput => ({
    name: "Table",
    position: [0, 0, 0],
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    visible: true,
    objects,
  });

  it("removes descendants that are no longer listed", () => {
    let document = documentWith([]);
    const first = planAssembly(document, "table", input([object("top", true), object("leg-1", true), object("leg-2")]));
    for (const command of first.commands) document = reduceStudioDocument(document, command);
    document = reduceStudioDocument(document, { type: "entity.upsert", entity: group("drawer", IDENTITY, "table") });
    document = reduceStudioDocument(document, { type: "entity.upsert", entity: box("knob", { parentId: "drawer" }) });
    expect(document.collisions.map(({ id }) => id)).toEqual(["top:collision", "leg-1:collision"]);
    expect(document.layers.collisions).toBe(true);

    const second = planAssembly(document, "table", input([object("top"), object("leg-2")]));
    expect(new Set(second.removedIds)).toEqual(new Set(["leg-1", "drawer", "knob"]));
    expect(second.commands.slice(0, 2)).toEqual([
      { type: "entity.remove", id: "leg-1" },
      { type: "entity.remove", id: "drawer" },
    ]);
    for (const command of second.commands) document = reduceStudioDocument(document, command);
    expect(document.entities.map(({ id }) => id).sort()).toEqual(["leg-2", "table", "top"]);
    expect(document.collisions).toEqual([]);
  });

  it("rejects reusing a non-group id and duplicate child ids", () => {
    const document = documentWith([box("table")]);
    expect(() => planAssembly(document, "table", input([object("a")]))).toThrow(/already belongs to a box/);
    expect(() => planAssembly(documentWith([]), "t", input([object("a"), object("a")]))).toThrow(/unique/);
  });
});

describe("model sources", () => {
  it("accepts files under repo assets/ and explains the URL root otherwise", async () => {
    await expect(assertModelSourceExists("/fr10/browser/fr10_home.glb")).resolves.toBeUndefined();
    await expect(assertModelSourceExists("/assets/fr10/browser/fr10_home.glb"))
      .rejects.toThrow(/drop the leading "\/assets"/);
    await expect(assertModelSourceExists("/../secret.glb")).rejects.toThrow(/safe path/);
  });
});
