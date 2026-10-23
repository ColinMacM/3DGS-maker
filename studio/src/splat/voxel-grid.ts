import type { QuaternionXyzw, Vec3 } from "../domain/types";
import type { SplatCloud } from "./analysis";
type MutableVec3 = [number, number, number];
type MutableQuaternion = [number, number, number, number];


export interface SplatVoxelGridOptions {
  readonly position: Vec3;
  readonly quaternionXyzw: QuaternionXyzw;
  readonly size: Vec3;
  readonly voxelSize: number;
  readonly opacityCutoff: number;
  readonly minimumSplatOpacity: number;
  readonly minimumContribution: number;
  readonly minimumNeighbors: number;
  readonly maxGridCells: number;
  /**
   * World height in metres. Gaussians centred below it whose flattest axis
   * (surface normal) is within UP_FACING_NORMAL_COS of world ±Z are ignored.
   * Removes floors, rugs and cushion tops that otherwise bleed into the feet of
   * furniture; vertical surfaces such as legs are kept. `null` keeps everything.
   */
  readonly excludeUpFacingBelowZ: number | null;
  /** How a Gaussian's opacity becomes per-cell density; see `voxelizeSplatBox`. */
  readonly densityModel: VoxelDensityModel;
  /** Mark empty cells that are enclosed by occupied cells (not reachable from the box faces) as occupied. */
  readonly fillEnclosed: boolean;
  /** When set, only Gaussians whose entry is 1 contribute (see `visibleGaussians`). */
  readonly includeMask: Uint8Array | null;
}

export type VoxelDensityModel = "opacity" | "optical-depth";

/** cos(32°): a Gaussian counts as up-facing when its normal is within 32° of ±Z. */
export const UP_FACING_NORMAL_COS = 0.85;
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

export interface VoxelComponent {
  readonly voxelCount: number;
  /** Query-box-local metres; the grid minimum corner is `-size / 2`. */
  readonly localBounds: { readonly min: Vec3; readonly max: Vec3 };
  /** Opacity-weighted SPZ base color of the component's cells. */
  readonly meanColor: string;
}

export interface SplatVoxelGrid {
  readonly dimensions: Vec3;
  readonly gridCellCount: number;
  readonly selectedGaussianCount: number;
  /** Gaussians skipped by `excludeUpFacingBelowZ`. */
  readonly excludedUpFacingGaussianCount: number;
  /** Empty cells turned occupied by `fillEnclosed`. */
  readonly filledInteriorCellCount: number;
  /** One byte per cell, 1 when occupied, indexed `i + j * nx + k * nx * ny`. */
  readonly occupied: Uint8Array;
  readonly occupiedVoxelCount: number;
  readonly exposedFaceCount: number;
  /** Occupied cell count per local Z layer, bottom (k = 0) first. */
  readonly occupiedCellsPerZLayer: readonly number[];
  readonly components: readonly VoxelComponent[];
}

const DIRECTIONS = [
  [-1, 0, 0], [1, 0, 0],
  [0, -1, 0], [0, 1, 0],
  [0, 0, -1], [0, 0, 1],
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rotateInto(
  target: MutableVec3,
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): void {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  target[0] = x + qw * tx + qy * tz - qz * ty;
  target[1] = y + qw * ty + qz * tx - qx * tz;
  target[2] = z + qw * tz + qx * ty - qy * tx;
}

function gaussianExtentInto(
  target: MutableVec3,
  rotation: MutableQuaternion,
  scales: MutableVec3,
): void {
  const [x, y, z, w] = rotation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);
  const sx2 = scales[0] * scales[0];
  const sy2 = scales[1] * scales[1];
  const sz2 = scales[2] * scales[2];
  target[0] = 3 * Math.sqrt(r00 * r00 * sx2 + r01 * r01 * sy2 + r02 * r02 * sz2);
  target[1] = 3 * Math.sqrt(r10 * r10 * sx2 + r11 * r11 * sy2 + r12 * r12 * sz2);
  target[2] = 3 * Math.sqrt(r20 * r20 * sx2 + r21 * r21 * sy2 + r22 * r22 * sz2);
}

function neighborIndex(
  x: number,
  y: number,
  z: number,
  direction: readonly [number, number, number],
  nx: number,
  ny: number,
  nz: number,
): number {
  const tx = x + direction[0];
  const ty = y + direction[1];
  const tz = z + direction[2];
  return tx < 0 || ty < 0 || tz < 0 || tx >= nx || ty >= ny || tz >= nz
    ? -1
    : tx + ty * nx + tz * nx * ny;
}

export function voxelizeSplatBox(
  cloud: SplatCloud,
  options: SplatVoxelGridOptions,
): SplatVoxelGrid {
  if (!cloud.scales || !cloud.rotations) {
    throw new Error("Voxelization requires decoded SPZ Gaussian scales and rotations.");
  }
  if (options.size.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Voxel query size must contain three positive finite values.");
  }
  if (!(options.voxelSize > 0) || !(options.opacityCutoff > 0 && options.opacityCutoff < 1)) {
    throw new Error("Voxel size must be positive and opacity cutoff must be between zero and one.");
  }
  const dimensions: Vec3 = [
    Math.ceil(options.size[0] / options.voxelSize),
    Math.ceil(options.size[1] / options.voxelSize),
    Math.ceil(options.size[2] / options.voxelSize),
  ];
  const [nx, ny, nz] = dimensions;
  const gridCellCount = nx * ny * nz;
  if (!Number.isSafeInteger(gridCellCount) || gridCellCount > options.maxGridCells) {
    throw new Error(`Voxel query requires ${gridCellCount} cells; increase voxelSize or maxGridCells.`);
  }
  const sigma = new Float32Array(gridCellCount);
  const red = new Float32Array(gridCellCount);
  const green = new Float32Array(gridCellCount);
  const blue = new Float32Array(gridCellCount);
  const half: Vec3 = [options.size[0] / 2, options.size[1] / 2, options.size[2] / 2];
  const gridMin: Vec3 = [-half[0], -half[1], -half[2]];
  const [boxQx, boxQy, boxQz, boxQw] = options.quaternionXyzw;
  const inverseBox: QuaternionXyzw = [-boxQx, -boxQy, -boxQz, boxQw];
  const voxelHalf = options.voxelSize / 2;
  const localCenter: MutableVec3 = [0, 0, 0];
  const localRotation: MutableQuaternion = [0, 0, 0, 1];
  const scales: MutableVec3 = [1, 1, 1];
  const extent: MutableVec3 = [0, 0, 0];
  const gaussianLocal: MutableVec3 = [0, 0, 0];
  let selectedGaussianCount = 0;
  let excludedUpFacingGaussianCount = 0;
  for (let gaussian = 0; gaussian < cloud.pointCount; gaussian += 1) {
    const alpha = cloud.opacities[gaussian] / 255;
    if (alpha < options.minimumSplatOpacity) continue;
    if (options.includeMask !== null && options.includeMask[gaussian] !== 1) continue;
    const positionOffset = gaussian * 3;
    if (
      options.excludeUpFacingBelowZ !== null
      && cloud.positions[positionOffset + 2] < options.excludeUpFacingBelowZ
    ) {
      const sx = cloud.scales[positionOffset];
      const sy = cloud.scales[positionOffset + 1];
      const sz = cloud.scales[positionOffset + 2];
      const flattest = sx <= sy ? (sx <= sz ? 0 : 2) : (sy <= sz ? 1 : 2);
      const qx = cloud.rotations[gaussian * 4];
      const qy = cloud.rotations[gaussian * 4 + 1];
      const qz = cloud.rotations[gaussian * 4 + 2];
      const qw = cloud.rotations[gaussian * 4 + 3];
      // World Z component of the rotated flattest axis (row 2 of the rotation matrix).
      const normalZ = flattest === 0
        ? 2 * (qx * qz - qw * qy)
        : flattest === 1
          ? 2 * (qy * qz + qw * qx)
          : 1 - 2 * (qx * qx + qy * qy);
      if (Math.abs(normalZ) >= UP_FACING_NORMAL_COS) {
        excludedUpFacingGaussianCount += 1;
        continue;
      }
    }
    rotateInto(
      localCenter,
      cloud.positions[positionOffset] - options.position[0],
      cloud.positions[positionOffset + 1] - options.position[1],
      cloud.positions[positionOffset + 2] - options.position[2],
      inverseBox[0], inverseBox[1], inverseBox[2], inverseBox[3],
    );
    const rotationOffset = gaussian * 4;
    const bx = cloud.rotations[rotationOffset];
    const by = cloud.rotations[rotationOffset + 1];
    const bz = cloud.rotations[rotationOffset + 2];
    const bw = cloud.rotations[rotationOffset + 3];
    const [ax, ay, az, aw] = inverseBox;
    localRotation[0] = aw * bx + ax * bw + ay * bz - az * by;
    localRotation[1] = aw * by - ax * bz + ay * bw + az * bx;
    localRotation[2] = aw * bz + ax * by - ay * bx + az * bw;
    localRotation[3] = aw * bw - ax * bx - ay * by - az * bz;
    scales[0] = cloud.scales[positionOffset];
    scales[1] = cloud.scales[positionOffset + 1];
    scales[2] = cloud.scales[positionOffset + 2];
    gaussianExtentInto(extent, localRotation, scales);
    if (
      Math.abs(localCenter[0]) > half[0] + extent[0]
      || Math.abs(localCenter[1]) > half[1] + extent[1]
      || Math.abs(localCenter[2]) > half[2] + extent[2]
    ) continue;
    selectedGaussianCount += 1;
    // Peak per-cell contribution. "opacity" deposits the splat's 2D opacity at every cell it
    // covers, so thick Gaussians fill their whole 3-sigma volume. "optical-depth" treats the
    // Gaussian as a volume whose line integral along its thinnest axis (its surface normal)
    // equals -ln(1 - alpha), the splat's own opacity: one voxel of length Δ then receives
    // τ · min(1, Δ / (√(2π) · s_min)). Thin surface Gaussians keep their full opacity; thick,
    // blurry ones spread it over their thickness instead of filling a slab.
    const thinnest = Math.min(scales[0], scales[1], scales[2]);
    const peak = options.densityModel === "optical-depth"
      ? -Math.log(1 - Math.min(alpha, 0.99)) * Math.min(1, options.voxelSize / (SQRT_TWO_PI * thinnest))
      : alpha;
    const minimumX = clamp(Math.floor((localCenter[0] - extent[0] - gridMin[0]) / options.voxelSize), 0, nx - 1);
    const minimumY = clamp(Math.floor((localCenter[1] - extent[1] - gridMin[1]) / options.voxelSize), 0, ny - 1);
    const minimumZ = clamp(Math.floor((localCenter[2] - extent[2] - gridMin[2]) / options.voxelSize), 0, nz - 1);
    const maximumX = clamp(Math.floor((localCenter[0] + extent[0] - gridMin[0]) / options.voxelSize), 0, nx - 1);
    const maximumY = clamp(Math.floor((localCenter[1] + extent[1] - gridMin[1]) / options.voxelSize), 0, ny - 1);
    const maximumZ = clamp(Math.floor((localCenter[2] + extent[2] - gridMin[2]) / options.voxelSize), 0, nz - 1);
    const inverseQx = -localRotation[0];
    const inverseQy = -localRotation[1];
    const inverseQz = -localRotation[2];
    const inverseQw = localRotation[3];
    for (let z = minimumZ; z <= maximumZ; z += 1) {
      const cz = gridMin[2] + (z + 0.5) * options.voxelSize;
      if (Math.abs(cz) > half[2]) continue;
      for (let y = minimumY; y <= maximumY; y += 1) {
        const cy = gridMin[1] + (y + 0.5) * options.voxelSize;
        if (Math.abs(cy) > half[1]) continue;
        for (let x = minimumX; x <= maximumX; x += 1) {
          const cx = gridMin[0] + (x + 0.5) * options.voxelSize;
          if (Math.abs(cx) > half[0]) continue;
          const closestX = clamp(localCenter[0], cx - voxelHalf, cx + voxelHalf) - localCenter[0];
          const closestY = clamp(localCenter[1], cy - voxelHalf, cy + voxelHalf) - localCenter[1];
          const closestZ = clamp(localCenter[2], cz - voxelHalf, cz + voxelHalf) - localCenter[2];
          rotateInto(
            gaussianLocal,
            closestX, closestY, closestZ,
            inverseQx, inverseQy, inverseQz, inverseQw,
          );
          const distanceSquared =
            (gaussianLocal[0] / scales[0]) ** 2
            + (gaussianLocal[1] / scales[1]) ** 2
            + (gaussianLocal[2] / scales[2]) ** 2;
          const contribution = peak * Math.exp(-0.5 * distanceSquared);
          if (contribution < options.minimumContribution) continue;
          const cell = x + y * nx + z * nx * ny;
          const acceptedContribution = Math.min(contribution, 7 - sigma[cell]);
          if (acceptedContribution <= 0) continue;
          sigma[cell] += acceptedContribution;
          const colorOffset = gaussian * 3;
          red[cell] += acceptedContribution * cloud.colors[colorOffset];
          green[cell] += acceptedContribution * cloud.colors[colorOffset + 1];
          blue[cell] += acceptedContribution * cloud.colors[colorOffset + 2];
        }
      }
    }
  }

  const occupied = new Uint8Array(gridCellCount);
  for (let cell = 0; cell < gridCellCount; cell += 1) {
    occupied[cell] = 1 - Math.exp(-sigma[cell]) >= options.opacityCutoff ? 1 : 0;
  }
  if (options.minimumNeighbors > 0) {
    const filtered = occupied.slice();
    for (let cell = 0; cell < gridCellCount; cell += 1) {
      if (!occupied[cell]) continue;
      const x = cell % nx;
      const yz = Math.floor(cell / nx);
      const y = yz % ny;
      const z = Math.floor(yz / ny);
      let neighbors = 0;
      for (const direction of DIRECTIONS) {
        const adjacent = neighborIndex(x, y, z, direction, nx, ny, nz);
        if (adjacent >= 0 && occupied[adjacent]) neighbors += 1;
      }
      if (neighbors < options.minimumNeighbors) filtered[cell] = 0;
    }
    occupied.set(filtered);
  }
  let filledInteriorCellCount = 0;
  if (options.fillEnclosed) {
    // Splats describe surfaces, so solid parts voxelize as shells. Cells that cannot be
    // reached from the grid boundary through empty cells are enclosed and become occupied.
    const outside = new Uint8Array(gridCellCount);
    const queue = new Int32Array(gridCellCount);
    let write = 0;
    for (let cell = 0; cell < gridCellCount; cell += 1) {
      if (occupied[cell]) continue;
      const x = cell % nx;
      const yz = Math.floor(cell / nx);
      const y = yz % ny;
      const z = Math.floor(yz / ny);
      if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
        outside[cell] = 1;
        queue[write++] = cell;
      }
    }
    for (let read = 0; read < write; read += 1) {
      const cell = queue[read];
      const x = cell % nx;
      const yz = Math.floor(cell / nx);
      const y = yz % ny;
      const z = Math.floor(yz / ny);
      for (const direction of DIRECTIONS) {
        const adjacent = neighborIndex(x, y, z, direction, nx, ny, nz);
        if (adjacent >= 0 && !occupied[adjacent] && !outside[adjacent]) {
          outside[adjacent] = 1;
          queue[write++] = adjacent;
        }
      }
    }
    for (let cell = 0; cell < gridCellCount; cell += 1) {
      if (occupied[cell] || outside[cell]) continue;
      occupied[cell] = 1;
      filledInteriorCellCount += 1;
    }
  }

  let occupiedVoxelCount = 0;
  let exposedFaceCount = 0;
  const occupiedCellsPerZLayer = new Array<number>(nz).fill(0);
  for (let cell = 0; cell < gridCellCount; cell += 1) {
    if (!occupied[cell]) continue;
    occupiedVoxelCount += 1;
    const x = cell % nx;
    const yz = Math.floor(cell / nx);
    const y = yz % ny;
    const z = Math.floor(yz / ny);
    occupiedCellsPerZLayer[z] += 1;
    for (const direction of DIRECTIONS) {
      const adjacent = neighborIndex(x, y, z, direction, nx, ny, nz);
      if (adjacent < 0 || !occupied[adjacent]) exposedFaceCount += 1;
    }
  }
  if (occupiedVoxelCount === 0) {
    throw new Error("The selected box produced no occupied voxels; lower opacityCutoff or increase voxelSize.");
  }

  const visited = new Uint8Array(gridCellCount);
  const queue = new Int32Array(occupiedVoxelCount);
  const components: VoxelComponent[] = [];
  for (let start = 0; start < gridCellCount; start += 1) {
    if (!occupied[start] || visited[start]) continue;
    let read = 0;
    let write = 1;
    queue[0] = start;
    visited[start] = 1;
    const min: MutableVec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max: MutableVec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let weight = 0;
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    while (read < write) {
      const cell = queue[read++];
      weight += sigma[cell];
      redSum += red[cell];
      greenSum += green[cell];
      blueSum += blue[cell];
      const x = cell % nx;
      const yz = Math.floor(cell / nx);
      const y = yz % ny;
      const z = Math.floor(yz / ny);
      const coordinates = [x, y, z] as const;
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], gridMin[axis] + coordinates[axis] * options.voxelSize);
        max[axis] = Math.max(max[axis], gridMin[axis] + (coordinates[axis] + 1) * options.voxelSize);
      }
      for (const direction of DIRECTIONS) {
        const adjacent = neighborIndex(x, y, z, direction, nx, ny, nz);
        if (adjacent >= 0 && occupied[adjacent] && !visited[adjacent]) {
          visited[adjacent] = 1;
          queue[write++] = adjacent;
        }
      }
    }
    const meanColor = [redSum, greenSum, blueSum]
      .map((sum) => Math.round(clamp(sum / (weight || 1), 0, 255)).toString(16).padStart(2, "0"))
      .join("");
    components.push({ voxelCount: write, localBounds: { min, max }, meanColor: `#${meanColor}` });
  }
  components.sort((left, right) => right.voxelCount - left.voxelCount);

  return {
    dimensions,
    gridCellCount,
    selectedGaussianCount,
    excludedUpFacingGaussianCount,
    filledInteriorCellCount,
    occupied,
    occupiedVoxelCount,
    exposedFaceCount,
    occupiedCellsPerZLayer,
    components,
  };
}
