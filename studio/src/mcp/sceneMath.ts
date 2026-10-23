import { Euler, Matrix4, Quaternion, Vector3 } from "three";

import type { QuaternionXyzw, SceneEntity, Transform, Vec3 } from "../domain/types";
import { isEntityEffectivelyVisible } from "../domain/sceneRules";

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** Rounds away float noise such as 89.99999999999999 without hiding real precision. */
function clean(value: number, digits = 1e9): number {
  const rounded = Math.round(value * digits) / digits;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Three.js intrinsic XYZ Euler angles in degrees: R = Rx · Ry · Rz, i.e. rotate
 * about local X first, then the rotated Y, then the twice-rotated Z.
 */
export function quaternionFromEulerDegrees(rotation: Vec3): QuaternionXyzw {
  const quaternion = new Quaternion().setFromEuler(new Euler(
    rotation[0] / DEGREES_PER_RADIAN,
    rotation[1] / DEGREES_PER_RADIAN,
    rotation[2] / DEGREES_PER_RADIAN,
    "XYZ",
  ));
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

/** Exact inverse of {@link quaternionFromEulerDegrees}; Y is returned in [-90, 90]. */
export function eulerDegreesFromQuaternion(quaternionXyzw: QuaternionXyzw): Vec3 {
  const euler = new Euler().setFromQuaternion(
    new Quaternion(...quaternionXyzw).normalize(),
    "XYZ",
  );
  return [
    clean(euler.x * DEGREES_PER_RADIAN, 1e6),
    clean(euler.y * DEGREES_PER_RADIAN, 1e6),
    clean(euler.z * DEGREES_PER_RADIAN, 1e6),
  ];
}

export function transformMatrix(transform: Transform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion(...transform.quaternionXyzw).normalize(),
    new Vector3(...transform.scale),
  );
}

export function transformFromMatrix(matrix: Matrix4): Transform {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return {
    position: [clean(position.x), clean(position.y), clean(position.z)],
    quaternionXyzw: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    scale: [clean(scale.x), clean(scale.y), clean(scale.z)],
  };
}

/**
 * Resolves every entity's world matrix through its parent chain (child
 * transforms are parent-local). Mirrors the resolution in `boxQueryForEntity`.
 */
export function entityWorldMatrices(entities: readonly SceneEntity[]): Map<string, Matrix4> {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const matrices = new Map<string, Matrix4>();
  const visiting = new Set<string>();
  const resolve = (id: string): Matrix4 => {
    const cached = matrices.get(id);
    if (cached) return cached;
    const entity = byId.get(id);
    if (!entity) throw new Error(`Scene object does not exist: ${id}`);
    if (visiting.has(id)) throw new Error(`Scene object hierarchy contains a cycle at ${id}.`);
    visiting.add(id);
    const local = transformMatrix(entity.transform);
    const matrix = entity.parentId ? resolve(entity.parentId).clone().multiply(local) : local;
    visiting.delete(id);
    matrices.set(id, matrix);
    return matrix;
  };
  for (const entity of entities) resolve(entity.id);
  return matrices;
}

/**
 * Unscaled extent of the entity's geometry along its own local axes, or null
 * when the extent is not known server-side (models, groups, procedural) or not
 * metric (labels are billboards whose `size` is text height).
 */
export function localExtent(entity: SceneEntity): Vec3 | null {
  switch (entity.kind) {
    case "box":
      return entity.size;
    case "sphere":
      return [entity.radius * 2, entity.radius * 2, entity.radius * 2];
    case "cylinder":
      return [entity.radius * 2, entity.radius * 2, entity.height];
    case "capsule":
      return [entity.radius * 2, entity.radius * 2, entity.height + entity.radius * 2];
    case "model":
    case "group":
    case "procedural":
    case "label":
      return null;
  }
}

export interface EntityWorldPose {
  rotationDegrees: Vec3;
  worldPosition: Vec3;
  worldQuaternionXyzw: QuaternionXyzw;
  worldRotationDegrees: Vec3;
  worldScale: Vec3;
  localSize: Vec3 | null;
  worldSize: Vec3 | null;
  effectivelyVisible: boolean;
}

/** World pose and extents of each entity, keyed by id. */
export function entityWorldPoses(entities: readonly SceneEntity[]): Map<string, EntityWorldPose> {
  const matrices = entityWorldMatrices(entities);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return new Map(entities.map((entity) => {
    const world = transformFromMatrix(matrices.get(entity.id)!);
    const extent = localExtent(entity);
    return [entity.id, {
      rotationDegrees: eulerDegreesFromQuaternion(entity.transform.quaternionXyzw),
      worldPosition: world.position,
      worldQuaternionXyzw: world.quaternionXyzw,
      worldRotationDegrees: eulerDegreesFromQuaternion(world.quaternionXyzw),
      worldScale: world.scale,
      localSize: extent,
      worldSize: extent
        ? [
            clean(extent[0] * world.scale[0]),
            clean(extent[1] * world.scale[1]),
            clean(extent[2] * world.scale[2]),
          ]
        : null,
      effectivelyVisible: isEntityEffectivelyVisible(entity, byId),
    }] as const;
  }));
}

/** Local transform under `parentId` (or the root) that preserves the entity's current world pose. */
export function localTransformKeepingWorld(
  entities: readonly SceneEntity[],
  entityId: string,
  parentId: string | undefined,
): Transform {
  const matrices = entityWorldMatrices(entities);
  const world = matrices.get(entityId);
  if (!world) throw new Error(`Scene object does not exist: ${entityId}`);
  if (!parentId) return transformFromMatrix(world);
  const parent = matrices.get(parentId);
  if (!parent) throw new Error(`Parent group does not exist: ${parentId}`);
  return transformFromMatrix(parent.clone().invert().multiply(world));
}
