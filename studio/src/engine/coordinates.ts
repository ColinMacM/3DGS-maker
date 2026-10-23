import {
  Object3D,
  Quaternion,
  Vector3,
} from "three";

import type { Transform, Vec3 } from "../domain/types";

/**
 * Three.js is Y-up while studio documents are Z-up. Keeping authored objects
 * below a root with this rotation makes their local transforms remain exactly
 * as stored in the document.
 */
export const CANONICAL_TO_THREE_QUATERNION = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.PI / 2,
);

export function configureCanonicalRoot(root: Object3D): void {
  root.quaternion.copy(CANONICAL_TO_THREE_QUATERNION);
}

export function applyCanonicalTransform(
  object: Object3D,
  transform: Transform,
): void {
  object.position.set(...transform.position);
  object.quaternion.set(...transform.quaternionXyzw).normalize();
  object.scale.set(...transform.scale);
  object.updateMatrix();
}

export function readCanonicalTransform(object: Object3D): Transform {
  const { position, quaternion, scale } = object;
  return {
    position: [position.x, position.y, position.z],
    quaternionXyzw: [
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    ],
    scale: [scale.x, scale.y, scale.z],
  };
}

export function canonicalPointToThree(
  point: Vec3,
  target: Vector3,
): Vector3 {
  return target.set(...point).applyQuaternion(CANONICAL_TO_THREE_QUATERNION);
}

export function toVec3(value: Vector3): Vec3 {
  return [value.x, value.y, value.z];
}
