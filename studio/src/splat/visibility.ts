import type { QuaternionXyzw, Vec3 } from "../domain/types";
import type { SplatCloud } from "./analysis";

export interface GaussianVisibilityOptions {
  /** Query box centre, orientation and size in world metres. */
  readonly position: Vec3;
  readonly quaternionXyzw: QuaternionXyzw;
  readonly size: Vec3;
  /** Gaussians within this distance outside the box also act as occluders. */
  readonly marginM: number;
  /** Unit directions from the box towards each orthographic camera (world, +Z up). */
  readonly directions: readonly Vec3[];
  /** Pixel edge length of each view, in metres. */
  readonly pixelSizeM: number;
  /**
   * A Gaussian is visible when its blend weight `alpha * G * T` reaches this in
   * at least one pixel of one view. 1/255 is the smallest change an 8-bit image shows.
   */
  readonly minimumWeight: number;
  readonly minimumSplatOpacity: number;
}

/**
 * Camera directions of the Studio viewport presets (see `ThreeViewport.setView`):
 * Top looks down, Front looks along +Y, Right looks along -X, and Perspective
 * looks from (-1, 1.25, 0.85). The user's own orbit camera is not stored.
 */
export const VIEWPORT_PRESET_DIRECTIONS: Readonly<Record<"perspective" | "top" | "front" | "right", Vec3>> = {
  perspective: normalize([-1, 1.25, 0.85]),
  top: [0, 0, 1],
  front: [0, -1, 0],
  right: [1, 0, 0],
};

/** `count` directions spread evenly (Fibonacci lattice) from the horizon up to straight down. */
export function hemisphereDirections(count: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, view) => {
    const z = (view + 0.5) / count;
    const radius = Math.sqrt(1 - z * z);
    return [radius * Math.cos(golden * view), radius * Math.sin(golden * view), z] as Vec3;
  });
}

export interface GaussianVisibility {
  /** 1 for Gaussians that are candidates and visible, indexed like the cloud. Non-candidates are 0. */
  readonly visible: Uint8Array;
  /** 1 for every Gaussian that was tested (inside the box plus margin). */
  readonly candidate: Uint8Array;
  readonly candidateCount: number;
  readonly visibleCount: number;
}

/** Alpha is clamped like the 3DGS rasterizer, and fragments below 1/255 are skipped. */
const MAX_ALPHA = 0.99;
const MIN_ALPHA = 1 / 255;
/** Front-to-back blending stops once transmittance falls below this (3DGS uses 1e-4). */
const MIN_TRANSMITTANCE = 1e-4;
/** Screen-space low-pass filter added to every projected covariance, in pixels² (as in 3DGS). */
const LOW_PASS_PX2 = 0.3;

/**
 * Marks which Gaussians near a query box are actually visible from outside it.
 *
 * The box is rendered orthographically from each of `directions`. Each view is the exact,
 * depth-sorted 3DGS front-to-back blend: per pixel a Gaussian contributes
 * `w = alpha * G * T`, where `T` is the transmittance left by everything in front
 * of it. A Gaussian whose `w` never reaches `minimumWeight` cannot change any of
 * those images: it is too faint, or hidden behind opaque Gaussians. This is the
 * acceptance criterion of stochastic transparency (a fragment is kept with
 * probability alpha and only the closest accepted one is seen), evaluated in
 * expectation instead of by sampling, so the result is deterministic.
 */
export function visibleGaussians(cloud: SplatCloud, options: GaussianVisibilityOptions): GaussianVisibility {
  const [qx, qy, qz, qw] = options.quaternionXyzw;
  const half: Vec3 = [
    options.size[0] / 2 + options.marginM,
    options.size[1] / 2 + options.marginM,
    options.size[2] / 2 + options.marginM,
  ];
  const candidate = new Uint8Array(cloud.pointCount);
  const indices: number[] = [];
  for (let gaussian = 0; gaussian < cloud.pointCount; gaussian += 1) {
    if (cloud.opacities[gaussian] / 255 < options.minimumSplatOpacity) continue;
    const offset = gaussian * 3;
    const [lx, ly, lz] = rotate(
      cloud.positions[offset] - options.position[0],
      cloud.positions[offset + 1] - options.position[1],
      cloud.positions[offset + 2] - options.position[2],
      -qx, -qy, -qz, qw,
    );
    if (Math.abs(lx) > half[0] || Math.abs(ly) > half[1] || Math.abs(lz) > half[2]) continue;
    candidate[gaussian] = 1;
    indices.push(gaussian);
  }

  // World covariance (upper triangle: xx, xy, xz, yy, yz, zz) per candidate.
  const count = indices.length;
  const covariance = new Float32Array(count * 6);
  for (let index = 0; index < count; index += 1) {
    const gaussian = indices[index];
    const r = gaussian * 4;
    const x = cloud.rotations[r];
    const y = cloud.rotations[r + 1];
    const z = cloud.rotations[r + 2];
    const w = cloud.rotations[r + 3];
    const m = [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
    const s = gaussian * 3;
    const s0 = cloud.scales[s] ** 2;
    const s1 = cloud.scales[s + 1] ** 2;
    const s2 = cloud.scales[s + 2] ** 2;
    const entry = (a: number, b: number): number => (
      m[a * 3] * m[b * 3] * s0 + m[a * 3 + 1] * m[b * 3 + 1] * s1 + m[a * 3 + 2] * m[b * 3 + 2] * s2
    );
    const c = index * 6;
    covariance[c] = entry(0, 0);
    covariance[c + 1] = entry(0, 1);
    covariance[c + 2] = entry(0, 2);
    covariance[c + 3] = entry(1, 1);
    covariance[c + 4] = entry(1, 2);
    covariance[c + 5] = entry(2, 2);
  }

  const maxWeight = new Float32Array(count);
  const depth = new Float32Array(count);
  const order = new Uint32Array(count);
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const [cx, cy, cz] = rotate(sx * half[0], sy * half[1], sz * half[2], qx, qy, qz, qw);
        corners.push([cx + options.position[0], cy + options.position[1], cz + options.position[2]]);
      }
    }
  }
  const pixel = options.pixelSizeM;
  const lowPass = LOW_PASS_PX2 * pixel * pixel;

  for (const [dx, dy, dz] of options.directions) {
    // Screen axes u, v perpendicular to the view direction d (camera sits at +d).
    let ux = -dy;
    let uy = dx;
    let uz = 0;
    if (ux * ux + uy * uy < 1e-12) {
      ux = 1;
      uy = 0;
    }
    const uLength = Math.hypot(ux, uy, uz);
    ux /= uLength;
    uy /= uLength;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const [cx, cy, cz] of corners) {
      const cu = cx * ux + cy * uy + cz * uz;
      const cv = cx * vx + cy * vy + cz * vz;
      minU = Math.min(minU, cu);
      maxU = Math.max(maxU, cu);
      minV = Math.min(minV, cv);
      maxV = Math.max(maxV, cv);
    }
    const width = Math.ceil((maxU - minU) / pixel) + 1;
    const height = Math.ceil((maxV - minV) / pixel) + 1;
    const transmittance = new Float32Array(width * height).fill(1);

    for (let index = 0; index < count; index += 1) {
      const p = indices[index] * 3;
      depth[index] = cloud.positions[p] * dx + cloud.positions[p + 1] * dy + cloud.positions[p + 2] * dz;
      order[index] = index;
    }
    order.sort((left, right) => depth[right] - depth[left]);

    for (let rank = 0; rank < count; rank += 1) {
      const index = order[rank];
      const gaussian = indices[index];
      const alpha = cloud.opacities[gaussian] / 255;
      const c = index * 6;
      const xx = covariance[c];
      const xy = covariance[c + 1];
      const xz = covariance[c + 2];
      const yy = covariance[c + 3];
      const yz = covariance[c + 4];
      const zz = covariance[c + 5];
      // 2D covariance J Σ Jᵀ with J = [u; v].
      const a = ux * (xx * ux + xy * uy + xz * uz) + uy * (xy * ux + yy * uy + yz * uz) + uz * (xz * ux + yz * uy + zz * uz) + lowPass;
      const b = ux * (xx * vx + xy * vy + xz * vz) + uy * (xy * vx + yy * vy + yz * vz) + uz * (xz * vx + yz * vy + zz * vz);
      const d = vx * (xx * vx + xy * vy + xz * vz) + vy * (xy * vx + yy * vy + yz * vz) + vz * (xz * vx + yz * vy + zz * vz) + lowPass;
      const determinant = a * d - b * b;
      if (!(determinant > 0)) continue;
      const inverseA = d / determinant;
      const inverseB = -b / determinant;
      const inverseD = a / determinant;
      const p = gaussian * 3;
      const centerU = (cloud.positions[p] * ux + cloud.positions[p + 1] * uy + cloud.positions[p + 2] * uz - minU) / pixel;
      const centerV = (cloud.positions[p] * vx + cloud.positions[p + 1] * vy + cloud.positions[p + 2] * vz - minV) / pixel;
      // Radius where alpha * G drops below 1/255, capped at 3 sigma.
      const cutoff = Math.min(9, 2 * Math.log(Math.max(1, alpha * 255)));
      if (cutoff <= 0) continue;
      const extentU = Math.sqrt(a * cutoff) / pixel;
      const extentV = Math.sqrt(d * cutoff) / pixel;
      const u0 = Math.max(0, Math.floor(centerU - extentU));
      const u1 = Math.min(width - 1, Math.ceil(centerU + extentU));
      const v0 = Math.max(0, Math.floor(centerV - extentV));
      const v1 = Math.min(height - 1, Math.ceil(centerV + extentV));
      let best = maxWeight[index];
      for (let row = v0; row <= v1; row += 1) {
        const offsetV = (row - centerV) * pixel;
        for (let column = u0; column <= u1; column += 1) {
          const offsetU = (column - centerU) * pixel;
          const power = -0.5 * (inverseA * offsetU * offsetU + 2 * inverseB * offsetU * offsetV + inverseD * offsetV * offsetV);
          const fragment = Math.min(MAX_ALPHA, alpha * Math.exp(power));
          if (fragment < MIN_ALPHA) continue;
          const cell = row * width + column;
          const remaining = transmittance[cell];
          if (remaining < MIN_TRANSMITTANCE) continue;
          const weight = fragment * remaining;
          if (weight > best) best = weight;
          transmittance[cell] = remaining * (1 - fragment);
        }
      }
      maxWeight[index] = best;
    }
  }

  const visible = new Uint8Array(cloud.pointCount);
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (maxWeight[index] >= options.minimumWeight) {
      visible[indices[index]] = 1;
      visibleCount += 1;
    }
  }
  return { visible, candidate, candidateCount: count, visibleCount };
}

function rotate(
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): Vec3 {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
