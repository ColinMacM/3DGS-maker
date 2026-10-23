import type { Vec3 } from "./types";

/**
 * Occupancy grid attached to a bounds overlay.
 *
 * The grid lives in the overlay's local frame: cell `[i, j, k]` spans
 * `-size / 2 + [i, j, k] * voxelSizeM` to that corner plus `voxelSizeM` on each axis.
 * `occupancy` is a base64 run-length encoding over the linear cell index
 * `i + j * nx + k * nx * ny` (X fastest, then Y, then Z): run lengths alternate
 * empty, occupied, empty, … starting with an EMPTY run (possibly 0), each written
 * as an unsigned LEB128 varint. The runs sum exactly to the cell count.
 */
export interface VoxelOccupancy {
  voxelSizeM: number;
  dimensions: Vec3;
  occupancy: string;
}

export const MAX_VOXEL_OVERLAY_CELLS = 16_000_000;

export function voxelCellCount(dimensions: Vec3): number {
  return dimensions[0] * dimensions[1] * dimensions[2];
}

export function encodeOccupancy(occupied: Uint8Array): string {
  let bytes = new Uint8Array(1024);
  let length = 0;
  const writeVarint = (value: number): void => {
    if (length + 5 > bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    let remaining = value;
    while (remaining >= 0x80) {
      bytes[length++] = (remaining % 0x80) | 0x80;
      remaining = Math.floor(remaining / 0x80);
    }
    bytes[length++] = remaining;
  };

  let runValue = 0;
  let runLength = 0;
  for (let cell = 0; cell < occupied.length; cell += 1) {
    const value = occupied[cell] ? 1 : 0;
    if (value !== runValue) {
      writeVarint(runLength);
      runValue = value;
      runLength = 0;
    }
    runLength += 1;
  }
  if (runLength > 0 || length === 0) writeVarint(runLength);

  let binary = "";
  for (let offset = 0; offset < length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(length, offset + 0x8000)));
  }
  return btoa(binary);
}

/**
 * Walks the encoded runs, calling `occupiedRun(start, end)` for each occupied
 * run. Throws unless the encoding is well formed and covers exactly `cellCount`.
 */
function walkOccupancyRuns(
  encoded: string,
  cellCount: number,
  occupiedRun: (start: number, end: number) => void,
): void {
  const binary = atob(encoded);
  let cursor = 0;
  let occupiedPhase = false;
  let offset = 0;
  while (offset < binary.length) {
    let run = 0;
    let scale = 1;
    let byte: number;
    do {
      if (offset >= binary.length) throw new Error("Voxel occupancy ends inside a run length.");
      if (scale > 0x80 ** 4) throw new Error("Voxel occupancy run length is too large.");
      byte = binary.charCodeAt(offset++);
      run += (byte & 0x7f) * scale;
      scale *= 0x80;
    } while (byte & 0x80);
    if (cursor + run > cellCount) {
      throw new Error(`Voxel occupancy runs exceed the grid; expected ${cellCount} cells.`);
    }
    if (occupiedPhase && run > 0) occupiedRun(cursor, cursor + run);
    cursor += run;
    occupiedPhase = !occupiedPhase;
  }
  if (cursor !== cellCount) {
    throw new Error(`Voxel occupancy runs cover ${cursor} cells; expected ${cellCount} cells.`);
  }
}

/** Throws unless `encoded` is a well-formed run-length encoding of exactly `cellCount` cells. */
export function validateOccupancy(encoded: string, cellCount: number): void {
  walkOccupancyRuns(encoded, cellCount, () => {});
}

/** Decodes `encodeOccupancy` output; throws unless the runs sum exactly to `cellCount`. */
export function decodeOccupancy(encoded: string, cellCount: number): Uint8Array {
  const occupied = new Uint8Array(cellCount);
  walkOccupancyRuns(encoded, cellCount, (start, end) => occupied.fill(1, start, end));
  return occupied;
}

/** Above this many cell edges the viewport draws only the voxel surface outline (see `voxelWireframe`). */
export const MAX_CELL_WIREFRAME_EDGES = 250_000;

/**
 * Line-segment endpoints for the exposed voxel surface, each edge emitted once, in the grid's
 * local frame offset by `origin` (the grid's minimum corner).
 *
 * When the full cell wireframe (every edge of every exposed face) has at most `maxCellEdges`
 * edges it is returned as is. Otherwise only outline edges remain: edges where the surface
 * bends, i.e. the four cells around the edge are not a flat pair. Flat surfaces then show as
 * their outline instead of a sub-pixel grid that reads as a solid fill.
 */
export function voxelWireframe(
  occupied: Uint8Array,
  dimensions: Vec3,
  voxelSizeM: number,
  origin: Vec3,
  maxCellEdges = MAX_CELL_WIREFRAME_EDGES,
): { positions: Float32Array; outline: boolean } {
  const [nx, ny, nz] = dimensions;
  const vx = nx + 1;
  const vxy = vx * (ny + 1);
  const marked = new Uint8Array(vxy * (nz + 1) * 3);
  const cell: [number, number, number] = [0, 0, 0];
  const start: [number, number, number] = [0, 0, 0];
  let edgeCount = 0;
  const mark = (axis: number): void => {
    const key = (start[0] + start[1] * vx + start[2] * vxy) * 3 + axis;
    if (marked[key]) return;
    marked[key] = 1;
    edgeCount += 1;
  };
  const isOccupied = (x: number, y: number, z: number): boolean => (
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz
    && occupied[x + y * nx + z * nx * ny] === 1
  );
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!isOccupied(x, y, z)) continue;
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
        for (let axis = 0; axis < 3; axis += 1) {
          for (let side = 0; side < 2; side += 1) {
            const step = side === 0 ? -1 : 1;
            if (isOccupied(
              x + (axis === 0 ? step : 0),
              y + (axis === 1 ? step : 0),
              z + (axis === 2 ? step : 0),
            )) continue;
            const b = (axis + 1) % 3;
            const c = (axis + 2) % 3;
            for (let offset = 0; offset < 2; offset += 1) {
              start[axis] = cell[axis] + side;
              start[b] = cell[b];
              start[c] = cell[c] + offset;
              mark(b);
              start[b] = cell[b] + offset;
              start[c] = cell[c];
              mark(c);
            }
          }
        }
      }
    }
  }
  const outline = edgeCount > maxCellEdges;
  if (outline) {
    const vertex: [number, number, number] = [0, 0, 0];
    for (let key = 0; key < marked.length; key += 1) {
      if (!marked[key]) continue;
      const axis = key % 3;
      const index = (key - axis) / 3;
      vertex[0] = index % vx;
      vertex[1] = Math.floor(index / vx) % (ny + 1);
      vertex[2] = Math.floor(index / vxy);
      const b = (axis + 1) % 3;
      const c = (axis + 2) % 3;
      const around = [0, 0, 0, 0];
      for (let corner = 0; corner < 4; corner += 1) {
        cell[axis] = vertex[axis];
        cell[b] = vertex[b] - (corner & 1);
        cell[c] = vertex[c] - (corner >> 1);
        around[corner] = isOccupied(cell[0], cell[1], cell[2]) ? 1 : 0;
      }
      const count = around[0] + around[1] + around[2] + around[3];
      // Two face-adjacent cells form a flat surface; diagonal pairs, one, or three cells bend it.
      const flat = count === 2 && around[0] !== around[3];
      if (flat) {
        marked[key] = 0;
        edgeCount -= 1;
      }
    }
  }
  const positions = new Float32Array(edgeCount * 6);
  let write = 0;
  for (let key = 0; key < marked.length; key += 1) {
    if (!marked[key]) continue;
    const axis = key % 3;
    const vertex = (key - axis) / 3;
    const ix = vertex % vx;
    const iy = Math.floor(vertex / vx) % (ny + 1);
    const iz = Math.floor(vertex / vxy);
    const x = origin[0] + ix * voxelSizeM;
    const y = origin[1] + iy * voxelSizeM;
    const z = origin[2] + iz * voxelSizeM;
    positions[write] = x;
    positions[write + 1] = y;
    positions[write + 2] = z;
    positions[write + 3] = x + (axis === 0 ? voxelSizeM : 0);
    positions[write + 4] = y + (axis === 1 ? voxelSizeM : 0);
    positions[write + 5] = z + (axis === 2 ? voxelSizeM : 0);
    write += 6;
  }
  return { positions, outline };
}

/** Occupied cells as `[k, j, iStart, iEnd]` runs along +X (inclusive), ordered by Z layer then Y row. */
export function occupancyRuns(occupied: Uint8Array, dimensions: Vec3): Array<[number, number, number, number]> {
  const [nx, ny, nz] = dimensions;
  const runs: Array<[number, number, number, number]> = [];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      const row = j * nx + k * nx * ny;
      let i = 0;
      while (i < nx) {
        if (!occupied[row + i]) {
          i += 1;
          continue;
        }
        const first = i;
        while (i + 1 < nx && occupied[row + i + 1]) i += 1;
        runs.push([k, j, first, i]);
        i += 1;
      }
    }
  }
  return runs;
}
