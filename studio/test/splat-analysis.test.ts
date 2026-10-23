import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { Matrix4 } from "three";

import {
  analyzeSplatBox,
  bakeSplatBoxTexture,
  boxQueryForEntity,
  decodeSpz,
  loadSplatFile,
  type SplatCloud,
} from "../src/splat/analysis";
import { voxelizeSplatBox } from "../src/splat/voxel-grid";
import { VIEWPORT_PRESET_DIRECTIONS, hemisphereDirections, visibleGaussians } from "../src/splat/visibility";
import type { SceneEntity, Transform } from "../src/domain/types";

const IDENTITY_TRANSFORM: Transform = {
  position: [0, 0, 0],
  quaternionXyzw: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

function writeInt24(bytes: Uint8Array, offset: number, value: number): void {
  const encoded = value < 0 ? value + 0x1000000 : value;
  bytes[offset] = encoded & 0xff;
  bytes[offset + 1] = (encoded >>> 8) & 0xff;
  bytes[offset + 2] = (encoded >>> 16) & 0xff;
}
function gaussianGeometry(pointCount: number, scale = 0.05): Pick<SplatCloud, "scales" | "rotations"> {
  const rotations = new Float32Array(pointCount * 4);
  for (let index = 0; index < pointCount; index += 1) rotations[index * 4 + 3] = 1;
  const scales = new Float32Array(pointCount * 3);
  scales.fill(scale);
  return { scales, rotations };
}


function encodedSpz(): Uint8Array {
  const pointCount = 2;
  const raw = new Uint8Array(16 + pointCount * 20);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 3, true);
  view.setUint32(8, pointCount, true);
  view.setUint8(12, 0);
  view.setUint8(13, 10);

  const fixedPoints = [
    [1024, 2048, 3072],
    [-1024, -2048, -3072],
  ];
  fixedPoints.forEach((point, pointIndex) => {
    point.forEach((component, axis) => writeInt24(raw, 16 + pointIndex * 9 + axis * 3, component));
  });
  const alphaOffset = 16 + pointCount * 9;
  raw.set([255, 128], alphaOffset);
  raw.set([10, 20, 30, 200, 210, 220], alphaOffset + pointCount);
  return new Uint8Array(gzipSync(raw));
}

function encodedSpzV4(): Uint8Array {
  const pointCount = 2;
  const positions = new Uint8Array(pointCount * 9);
  const fixedPoints = [
    [1024, 2048, 3072],
    [-1024, -2048, -3072],
  ];
  fixedPoints.forEach((point, pointIndex) => {
    point.forEach((component, axis) => writeInt24(positions, pointIndex * 9 + axis * 3, component));
  });
  const streams = [
    positions,
    new Uint8Array([255, 128]),
    new Uint8Array([10, 20, 30, 200, 210, 220]),
    new Uint8Array(pointCount * 3),
    new Uint8Array(pointCount * 4),
  ];
  const compressed = streams.map((stream) => new Uint8Array(zstdCompressSync(stream)));
  const headerBytes = 32;
  const tocBytes = streams.length * 16;
  const output = new Uint8Array(headerBytes + tocBytes + compressed.reduce((sum, stream) => sum + stream.byteLength, 0));
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, pointCount, true);
  view.setUint8(12, 0);
  view.setUint8(13, 10);
  view.setUint8(15, streams.length);
  view.setUint32(16, headerBytes, true);
  let compressedOffset = headerBytes + tocBytes;
  compressed.forEach((stream, index) => {
    view.setBigUint64(headerBytes + index * 16, BigInt(stream.byteLength), true);
    view.setBigUint64(headerBytes + index * 16 + 8, BigInt(streams[index].byteLength), true);
    output.set(stream, compressedOffset);
    compressedOffset += stream.byteLength;
  });
  return output;
}

describe("SPZ metric analysis", () => {
  it("decodes legacy SPZ positions, opacity, color, and the Studio source transform", () => {
    const cloud = decodeSpz(encodedSpz(), IDENTITY_TRANSFORM);

    expect(cloud.pointCount).toBe(2);
    expect(Array.from(cloud.positions)).toEqual([1, -2, -3, -1, 2, 3]);
    expect(Array.from(cloud.opacities)).toEqual([255, 128]);
    expect(Array.from(cloud.colors)).toEqual([10, 20, 30, 200, 210, 220]);
    expect(cloud.scales).toHaveLength(6);
    expect(cloud.rotations).toHaveLength(8);
  });

  it("decodes independently compressed SPZ v4 attribute streams", () => {
    const cloud = decodeSpz(encodedSpzV4(), IDENTITY_TRANSFORM);

    expect(cloud.pointCount).toBe(2);
    expect(Array.from(cloud.positions)).toEqual([1, -2, -3, -1, 2, 3]);
    expect(Array.from(cloud.opacities)).toEqual([255, 128]);
    expect(Array.from(cloud.colors)).toEqual([10, 20, 30, 200, 210, 220]);
    expect(cloud.scales).toHaveLength(6);
    expect(cloud.rotations).toHaveLength(8);
  });

  it("estimates robust box edges and blends source colors near the surface", () => {
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 4,
      positions: new Float32Array([
        -1, -0.5, -0.2,
        1, 0.5, 0.2,
        -1, 0.5, 0.2,
        1, -0.5, -0.2,
      ]),
      colors: new Uint8Array([
        255, 0, 0,
        0, 0, 255,
        255, 0, 0,
        0, 0, 255,
      ]),
      opacities: new Uint8Array([255, 255, 255, 255]),
      ...gaussianGeometry(4),
    };

    const analysis = analyzeSplatBox(cloud, {
      id: "panel",
      name: "Panel",
      size: [2, 1, 0.4],
      worldMatrix: new Matrix4(),
    }, {
      lowerQuantile: 0,
      upperQuantile: 1,
      paddingM: 0.01,
      surfaceBandM: 0.01,
      opacityThreshold: 0,
      maxSamples: 100,
    });

    expect(analysis.supportCount).toBe(4);
    expect(analysis.estimatedSizeM).toEqual([2, 1, 0.4000000059604645]);
    expect(analysis.surfaceColor).toBe("#800080");
  });

  it("bakes spatially varying splat colors into a PNG box-face texture", () => {
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 2,
      positions: new Float32Array([
        -0.75, 0, 0.2,
        0.75, 0, 0.2,
      ]),
      colors: new Uint8Array([
        255, 0, 0,
        0, 0, 255,
      ]),
      opacities: new Uint8Array([255, 255]),
      ...gaussianGeometry(2),
    };

    const bake = bakeSplatBoxTexture(cloud, {
      id: "panel",
      name: "Panel",
      size: [2, 1, 0.4],
      worldMatrix: new Matrix4(),
    }, {
      face: "z-positive",
      resolution: 16,
      surfaceBandM: 0.01,
      opacityThreshold: 0,
    });

    expect(bake.supportCount).toBe(2);
    expect(bake.averageColor).toBe("#7f007f");
    expect(bake.seededCoverage).toBeGreaterThan(0);
    expect(bake.texture).toMatchObject({
      face: "z-positive",
      width: 16,
      height: 16,
    });
    expect(bake.texture?.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
  });

  it("voxelizes an arbitrarily oriented world-space box in query-local coordinates", () => {
    const halfSqrt = Math.SQRT1_2;
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 2,
      positions: new Float32Array([
        1, 1.7, 3,
        1, 2.3, 3,
      ]),
      colors: new Uint8Array([
        255, 32, 16,
        16, 32, 255,
      ]),
      opacities: new Uint8Array([255, 255]),
      scales: new Float32Array([
        0.06, 0.06, 0.06,
        0.06, 0.06, 0.06,
      ]),
      rotations: new Float32Array([
        0, 0, halfSqrt, halfSqrt,
        0, 0, halfSqrt, halfSqrt,
      ]),
    };

    const result = voxelizeSplatBox(cloud, {
      position: [1, 2, 3],
      quaternionXyzw: [0, 0, halfSqrt, halfSqrt],
      size: [1, 1, 0.5],
      voxelSize: 0.05,
      opacityCutoff: 0.1,
      minimumSplatOpacity: 0.01,
      minimumContribution: 1 / 255,
      minimumNeighbors: 1,
      maxGridCells: 100_000,
      excludeUpFacingBelowZ: null,
      densityModel: "opacity",
      fillEnclosed: false,
      includeMask: null,
    });

    expect(result.dimensions).toEqual([20, 20, 10]);
    expect(result.selectedGaussianCount).toBe(2);
    expect(result.components).toHaveLength(2);
    // The box is yawed +90°, so world -Y (the red Gaussian) lies along local -X.
    const red = result.components.find(({ localBounds }) => localBounds.max[0] < 0);
    const blue = result.components.find(({ localBounds }) => localBounds.min[0] > 0);
    expect(red?.meanColor).toBe("#ff2010");
    expect(blue?.meanColor).toBe("#1020ff");
  });

  it("rejects voxel queries above the configured grid limit", () => {
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 1,
      positions: new Float32Array([0, 0, 0]),
      colors: new Uint8Array([255, 255, 255]),
      opacities: new Uint8Array([255]),
      ...gaussianGeometry(1),
    };
    expect(() => voxelizeSplatBox(cloud, {
      position: [0, 0, 0],
      quaternionXyzw: [0, 0, 0, 1],
      size: [10, 10, 10],
      voxelSize: 0.01,
      opacityCutoff: 0.1,
      minimumSplatOpacity: 0.01,
      minimumContribution: 1 / 255,
      minimumNeighbors: 0,
      maxGridCells: 1_000,
      excludeUpFacingBelowZ: null,
      densityModel: "opacity",
      fillEnclosed: false,
      includeMask: null,
    })).toThrow(/increase voxelSize or maxGridCells/);
  });

  it("drops up-facing Gaussians below the cut height but keeps vertical ones", () => {
    // Gaussian 0: flat floor disc (thin along Z). Gaussian 1: wall-like sheet (thin along X), also low.
    // Gaussian 2: the same floor disc but above the cut height.
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 3,
      positions: new Float32Array([-0.2, 0, 0.02, 0.2, 0, 0.05, 0, 0, 0.3]),
      colors: new Uint8Array(9).fill(200),
      opacities: new Uint8Array([255, 255, 255]),
      scales: new Float32Array([0.04, 0.04, 0.002, 0.002, 0.04, 0.04, 0.04, 0.04, 0.002]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    };
    const options = {
      position: [0, 0, 0.2] as const,
      quaternionXyzw: [0, 0, 0, 1] as const,
      size: [0.8, 0.4, 0.4] as const,
      voxelSize: 0.02,
      opacityCutoff: 0.1,
      minimumSplatOpacity: 0.01,
      minimumContribution: 1 / 255,
      minimumNeighbors: 0,
      maxGridCells: 100_000,
      densityModel: "opacity" as const,
      fillEnclosed: false,
      includeMask: null,
    };

    const kept = voxelizeSplatBox(cloud, { ...options, excludeUpFacingBelowZ: null });
    const filtered = voxelizeSplatBox(cloud, { ...options, excludeUpFacingBelowZ: 0.14 });

    expect(kept.excludedUpFacingGaussianCount).toBe(0);
    expect(kept.components).toHaveLength(3);
    expect(filtered.excludedUpFacingGaussianCount).toBe(1);
    expect(filtered.components).toHaveLength(2);
    // The floor disc reached x ≈ -0.32 m; the remaining parts start at x ≥ -0.13 m.
    expect(filtered.components.every(({ localBounds }) => localBounds.min[0] > -0.2)).toBe(true);
  });

  it("spreads a thick Gaussian's opacity over its thickness under the optical-depth model", () => {
    // Gaussian 0: thin surface disc (sigma 1 mm along Z). Gaussian 1: thick blob (sigma 40 mm), same opacity.
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 2,
      positions: new Float32Array([-0.3, 0, 0, 0.3, 0, 0]),
      colors: new Uint8Array(6).fill(200),
      opacities: new Uint8Array([200, 200]),
      scales: new Float32Array([0.04, 0.04, 0.001, 0.04, 0.04, 0.04]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
    };
    const options = {
      quaternionXyzw: [0, 0, 0, 1] as const,
      size: [0.3, 0.3, 0.3] as const,
      voxelSize: 0.01,
      opacityCutoff: 0.1,
      minimumSplatOpacity: 0.01,
      minimumContribution: 1 / 255,
      minimumNeighbors: 0,
      maxGridCells: 100_000,
      excludeUpFacingBelowZ: null,
      fillEnclosed: false,
      includeMask: null,
    };
    const count = (position: readonly [number, number, number], densityModel: "opacity" | "optical-depth") => (
      voxelizeSplatBox(cloud, { ...options, position, densityModel }).occupiedVoxelCount
    );

    // A thin surface keeps its full optical depth -ln(1 - α) ≥ α, so it never shrinks.
    expect(count([-0.3, 0, 0], "optical-depth")).toBeGreaterThanOrEqual(count([-0.3, 0, 0], "opacity"));
    expect(count([0.3, 0, 0], "optical-depth")).toBeLessThan(count([0.3, 0, 0], "opacity") / 2);
  });

  it("fills cells enclosed by a closed shell only when fillEnclosed is set", () => {
    // Six opaque thin sheets on the faces of a 0.2 m cube.
    const r = Math.SQRT1_2;
    const faces = [
      [0.1, 0, 0, 0, r, 0, r], [-0.1, 0, 0, 0, r, 0, r],
      [0, 0.1, 0, r, 0, 0, r], [0, -0.1, 0, r, 0, 0, r],
      [0, 0, 0.1, 0, 0, 0, 1], [0, 0, -0.1, 0, 0, 0, 1],
    ];
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 6,
      positions: new Float32Array(faces.flatMap(([x, y, z]) => [x, y, z])),
      colors: new Uint8Array(18).fill(200),
      opacities: new Uint8Array(6).fill(255),
      scales: new Float32Array(faces.flatMap(() => [0.06, 0.06, 0.002])),
      rotations: new Float32Array(faces.flatMap(([, , , qx, qy, qz, qw]) => [qx, qy, qz, qw])),
    };
    const options = {
      position: [0, 0, 0] as const,
      quaternionXyzw: [0, 0, 0, 1] as const,
      size: [0.4, 0.4, 0.4] as const,
      voxelSize: 0.02,
      opacityCutoff: 0.1,
      minimumSplatOpacity: 0.01,
      minimumContribution: 1 / 255,
      minimumNeighbors: 0,
      maxGridCells: 100_000,
      excludeUpFacingBelowZ: null,
      densityModel: "optical-depth" as const,
      includeMask: null,
    };
    const centre = 10 + 10 * 20 + 10 * 400;

    const shell = voxelizeSplatBox(cloud, { ...options, fillEnclosed: false });
    const solid = voxelizeSplatBox(cloud, { ...options, fillEnclosed: true });

    expect(shell.occupied[centre]).toBe(0);
    expect(solid.occupied[centre]).toBe(1);
    expect(solid.filledInteriorCellCount).toBe(solid.occupiedVoxelCount - shell.occupiedVoxelCount);
    expect(solid.filledInteriorCellCount).toBeGreaterThan(0);
  });

  it("culls Gaussians that are too faint or hidden behind opaque ones in every view", () => {
    // 0, 1: two stacked opaque discs; 2: Gaussian 2 cm under them; 3: exposed Gaussian; 4: too faint to see.
    const cloud: SplatCloud = {
      source: "fixture.spz",
      pointCount: 5,
      positions: new Float32Array([0, 0, 0.3, 0, 0, 0.29, 0, 0, 0.27, 0.5, 0, 0.1, -0.5, 0, 0.1]),
      colors: new Uint8Array(15).fill(200),
      opacities: new Uint8Array([255, 255, 128, 128, 1]),
      scales: new Float32Array([0.3, 0.3, 0.002, 0.3, 0.3, 0.002, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]),
      rotations: new Float32Array(Array.from({ length: 5 }, () => [0, 0, 0, 1]).flat()),
    };
    const options = {
      position: [0, 0, 0.2] as const,
      quaternionXyzw: [0, 0, 0, 1] as const,
      size: [1.4, 0.4, 0.4] as const,
      marginM: 0,
      pixelSizeM: 0.01,
      minimumWeight: 1 / 255,
      minimumSplatOpacity: 0,
    };

    const fromAbove = visibleGaussians(cloud, { ...options, directions: [VIEWPORT_PRESET_DIRECTIONS.top] });
    const fromSide = visibleGaussians(cloud, { ...options, directions: hemisphereDirections(16) });

    expect(Array.from(fromAbove.visible)).toEqual([1, 1, 0, 1, 0]);
    expect(fromSide.visible[2]).toBe(1);
    expect(fromSide.visible[4]).toBe(0);
  });

  it("resolves parent and child transforms for entity-local splat queries", () => {
    const entities: SceneEntity[] = [
      {
        id: "assembly",
        name: "Assembly",
        kind: "group",
        visible: true,
        transform: { ...IDENTITY_TRANSFORM, position: [2, 3, 4] },
      },
      {
        id: "panel",
        name: "Panel",
        kind: "box",
        visible: true,
        parentId: "assembly",
        transform: { ...IDENTITY_TRANSFORM, position: [0.5, 0.25, 0.125] },
        size: [1, 2, 0.1],
        material: { color: "#ffffff", opacity: 1 },
      },
    ];

    const query = boxQueryForEntity(entities, "panel");
    expect(query.worldMatrix.elements[12]).toBe(2.5);
    expect(query.worldMatrix.elements[13]).toBe(3.25);
    expect(query.worldMatrix.elements[14]).toBe(4.125);
  });
});

describe("SPZ file cache", () => {
  it("reuses a decoded cloud until the file's mtime changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "splat-cache-"));
    try {
      const path = join(directory, "source.spz");
      await writeFile(path, encodedSpz());
      await utimes(path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

      const first = await loadSplatFile(path, IDENTITY_TRANSFORM);
      expect(await loadSplatFile(path, IDENTITY_TRANSFORM)).toBe(first);

      await writeFile(path, encodedSpzV4());
      await utimes(path, new Date("2026-01-01T00:00:05Z"), new Date("2026-01-01T00:00:05Z"));
      const edited = await loadSplatFile(path, IDENTITY_TRANSFORM);

      expect(edited).not.toBe(first);
      expect(edited).toEqual(decodeSpz(encodedSpzV4(), IDENTITY_TRANSFORM, path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
