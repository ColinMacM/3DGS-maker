import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { deflateSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import {
  Matrix4,
  Quaternion,
  Vector3,
} from "three";

import type {
  BoxTextureFace,
  BoxSceneEntity,
  SceneEntity,
  SceneTexture,
  Transform,
  Vec3,
} from "../domain/types";

const NGSP_MAGIC = 0x5053474e;
const LEGACY_HEADER_BYTES = 16;
const MAX_SPLAT_POINTS = 20_000_000;
const REPOSITORY_ROOT = resolve(decodeURIComponent(new URL("../../../", import.meta.url).pathname));
const ASSETS_ROOT = resolve(REPOSITORY_ROOT, "assets");
/**
 * Decoded clouds keyed by source path. An entry is reused only while the file's
 * mtime/size and the catalog transform are unchanged, so edits to the SPZ or to
 * `catalog.json` (re-read on every call) are picked up without a restart.
 */
const cloudCache = new Map<string, { signature: string; cloud: Promise<SplatCloud> }>();

export interface SplatCloud {
  readonly source: string;
  readonly pointCount: number;
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly opacities: Uint8Array;
  readonly scales: Float32Array;
  readonly rotations: Float32Array;
}

export interface SplatAnalysisOptions {
  readonly lowerQuantile: number;
  readonly upperQuantile: number;
  readonly paddingM: number;
  readonly surfaceBandM: number;
  readonly opacityThreshold: number;
  readonly maxSamples: number;
}

export interface SplatBoxQuery {
  readonly id: string;
  readonly name: string;
  readonly size: Vec3;
  readonly worldMatrix: Matrix4;
}

export interface SplatBoxAnalysis {
  readonly id: string;
  readonly name: string;
  readonly currentSizeM: Vec3;
  readonly lowerEdgeOffsetM: Vec3;
  readonly upperEdgeOffsetM: Vec3;
  readonly estimatedSizeM: Vec3;
  readonly estimatedCenterOffsetM: Vec3;
  readonly supportCount: number;
  readonly retainedSamples: number;
  readonly surfaceSupportCount: number;
  readonly surfaceColor?: string;
  readonly confidence: "low" | "medium" | "high";
}

export interface SplatTextureBake {
  readonly texture?: SceneTexture;
  readonly supportCount: number;
  readonly seededPixelCount: number;
  readonly seededCoverage: number;
  readonly averageColor?: string;
}

interface CatalogSplatDefinition {
  readonly sourcePath: string;
  readonly transform: Transform;
}

const DEFAULT_ANALYSIS_OPTIONS: SplatAnalysisOptions = {
  lowerQuantile: 0.03,
  upperQuantile: 0.97,
  paddingM: 0.02,
  surfaceBandM: 0.018,
  opacityThreshold: 0.1,
  maxSamples: 50_000,
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireVec3(value: unknown, label: string, positive = false): Vec3 {
  if (
    !Array.isArray(value)
    || value.length !== 3
    || value.some((component) => typeof component !== "number" || !Number.isFinite(component))
    || (positive && value.some((component) => component <= 0))
  ) {
    throw new Error(`${label} must contain three ${positive ? "positive " : ""}finite numbers.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function requireTransform(value: unknown, label: string): Transform {
  const record = requireRecord(value, label);
  const quaternion = record.quaternionXyzw;
  if (
    !Array.isArray(quaternion)
    || quaternion.length !== 4
    || quaternion.some((component) => typeof component !== "number" || !Number.isFinite(component))
    || quaternion.every((component) => component === 0)
  ) {
    throw new Error(`${label}.quaternionXyzw must contain a nonzero finite quaternion.`);
  }
  return {
    position: requireVec3(record.position, `${label}.position`),
    quaternionXyzw: [
      quaternion[0] as number,
      quaternion[1] as number,
      quaternion[2] as number,
      quaternion[3] as number,
    ],
    scale: requireVec3(record.scale, `${label}.scale`, true),
  };
}

function safeAssetPath(url: string): string {
  const relative = url.split(/[?#]/, 1)[0].replace(/^\/+/, "");
  if (!relative || relative.includes("\\") || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Catalog SPZ URL must be a safe asset-relative path.");
  }
  const path = resolve(ASSETS_ROOT, relative);
  if (path !== ASSETS_ROOT && !path.startsWith(`${ASSETS_ROOT}${sep}`)) {
    throw new Error("Catalog SPZ URL escapes the asset directory.");
  }
  return path;
}

async function catalogSplatDefinition(assetId: string, assetVersion: string): Promise<CatalogSplatDefinition> {
  const catalog = requireRecord(JSON.parse(await readFile(resolve(ASSETS_ROOT, "catalog.json"), "utf8")), "Asset catalog");
  if (!Array.isArray(catalog.assets)) throw new Error("Asset catalog must contain an assets array.");
  const entry = catalog.assets
    .map((value, index) => requireRecord(value, `Asset catalog entry ${index + 1}`))
    .find((value) => value.id === assetId && value.version === assetVersion);
  if (!entry) throw new Error(`Asset package is not in the catalog: ${assetId}@${assetVersion}`);
  const browser = requireRecord(entry.browser, `Catalog asset ${assetId} browser`);
  const spz = requireRecord(browser.spz, `Catalog asset ${assetId} browser.spz`);
  if (typeof spz.url !== "string" || !spz.url.toLowerCase().split(/[?#]/, 1)[0].endsWith(".spz")) {
    throw new Error(`Catalog asset ${assetId} does not provide an SPZ source.`);
  }
  return {
    sourcePath: safeAssetPath(spz.url),
    transform: requireTransform(spz.transform, `Catalog asset ${assetId} browser.spz.transform`),
  };
}

function signedInt24(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  return (value & 0x800000) === 0 ? value : value | 0xff000000;
}

function transformedPositions(
  positionBytes: Uint8Array,
  pointCount: number,
  fractionalBits: number,
  transform: Transform,
): Float32Array {
  const result = new Float32Array(pointCount * 3);
  // Implicit Rx(180°) before `browser.spz.transform`, matching the viewport
  // (ThreeViewport.tsx loadCatalog): studio = transform · Rx(180°) · source.
  const sourceToStudio = new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion(...transform.quaternionXyzw).normalize(),
    new Vector3(...transform.scale),
  ).multiply(new Matrix4().makeRotationX(Math.PI));
  const point = new Vector3();
  const fixedScale = 1 / (2 ** fractionalBits);
  for (let index = 0; index < pointCount; index += 1) {
    const sourceOffset = index * 9;
    point.set(
      signedInt24(positionBytes, sourceOffset) * fixedScale,
      signedInt24(positionBytes, sourceOffset + 3) * fixedScale,
      signedInt24(positionBytes, sourceOffset + 6) * fixedScale,
    ).applyMatrix4(sourceToStudio);
    const outputOffset = index * 3;
    result[outputOffset] = point.x;
    result[outputOffset + 1] = point.y;
    result[outputOffset + 2] = point.z;
  }
  return result;
}

function decodedGaussianGeometry(
  scaleBytes: Uint8Array,
  rotationBytes: Uint8Array,
  pointCount: number,
  version: number,
  transform: Transform,
): { scales: Float32Array; rotations: Float32Array } {
  const rotationBytesPerPoint = version === 2 ? 3 : 4;
  if (
    scaleBytes.byteLength !== pointCount * 3
    || rotationBytes.byteLength !== pointCount * rotationBytesPerPoint
  ) {
    throw new Error("SPZ scale or rotation stream has an invalid size.");
  }
  const scales = new Float32Array(pointCount * 3);
  const rotations = new Float32Array(pointCount * 4);
  // Same implicit Rx(180°) as transformedPositions.
  const sourceToStudio = new Quaternion(...transform.quaternionXyzw)
    .normalize()
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI));
  const metricScale = Math.cbrt(
    Math.abs(transform.scale[0] * transform.scale[1] * transform.scale[2]),
  );
  const sourceRotation = new Quaternion();
  const worldRotation = new Quaternion();
  const components = new Float32Array(4);
  const rotationView = new DataView(
    rotationBytes.buffer,
    rotationBytes.byteOffset,
    rotationBytes.byteLength,
  );
  for (let index = 0; index < pointCount; index += 1) {
    const scaleOffset = index * 3;
    scales[scaleOffset] = Math.exp(scaleBytes[scaleOffset] / 16 - 10) * metricScale;
    scales[scaleOffset + 1] = Math.exp(scaleBytes[scaleOffset + 1] / 16 - 10) * metricScale;
    scales[scaleOffset + 2] = Math.exp(scaleBytes[scaleOffset + 2] / 16 - 10) * metricScale;
    if (version === 2) {
      const x = rotationBytes[index * 3] / 127.5 - 1;
      const y = rotationBytes[index * 3 + 1] / 127.5 - 1;
      const z = rotationBytes[index * 3 + 2] / 127.5 - 1;
      sourceRotation.set(x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)));
    } else {
      components.fill(0);
      let packed = rotationView.getUint32(index * 4, true);
      const largest = packed >>> 30;
      let sumSquares = 0;
      for (let component = 3; component >= 0; component -= 1) {
        if (component === largest) continue;
        const magnitude = packed & 0x1ff;
        const negative = ((packed >>> 9) & 1) === 1;
        packed >>>= 10;
        const value = Math.SQRT1_2 * magnitude / 0x1ff * (negative ? -1 : 1);
        components[component] = value;
        sumSquares += value * value;
      }
      components[largest] = Math.sqrt(Math.max(0, 1 - sumSquares));
      sourceRotation.set(components[0], components[1], components[2], components[3]);
    }
    worldRotation.copy(sourceToStudio).multiply(sourceRotation).normalize();
    const rotationOffset = index * 4;
    rotations[rotationOffset] = worldRotation.x;
    rotations[rotationOffset + 1] = worldRotation.y;
    rotations[rotationOffset + 2] = worldRotation.z;
    rotations[rotationOffset + 3] = worldRotation.w;
  }
  return { scales, rotations };
}

function validatePointCount(pointCount: number): void {
  if (pointCount === 0 || pointCount > MAX_SPLAT_POINTS) {
    throw new Error(`SPZ point count must be between 1 and ${MAX_SPLAT_POINTS}.`);
  }
}

function cloudFromStreams(
  positionBytes: Uint8Array,
  opacityBytes: Uint8Array,
  colorBytes: Uint8Array,
  scaleBytes: Uint8Array,
  rotationBytes: Uint8Array,
  pointCount: number,
  fractionalBits: number,
  version: number,
  transform: Transform,
  source: string,
): SplatCloud {
  if (
    positionBytes.byteLength !== pointCount * 9
    || opacityBytes.byteLength !== pointCount
    || colorBytes.byteLength !== pointCount * 3
  ) {
    throw new Error("SPZ position, opacity, or color stream has an invalid size.");
  }
  return {
    source,
    pointCount,
    positions: transformedPositions(positionBytes, pointCount, fractionalBits, transform),
    colors: colorBytes.slice(),
    opacities: opacityBytes.slice(),
    ...decodedGaussianGeometry(scaleBytes, rotationBytes, pointCount, version, transform),
  };
}

function decodeSpzV4(
  encoded: Uint8Array,
  transform: Transform,
  source: string,
): SplatCloud {
  if (encoded.byteLength < 32) throw new Error("SPZ v4 file is shorter than its header.");
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const pointCount = view.getUint32(8, true);
  validatePointCount(pointCount);
  const shDegree = view.getUint8(12);
  if (shDegree > 4) throw new Error("SPZ v4 spherical-harmonic degree must be between 0 and 4.");
  const fractionalBits = view.getUint8(13);
  if (fractionalBits > 24) throw new Error("SPZ v4 fractionalBits is invalid.");
  const streamCount = view.getUint8(15);
  const tocOffset = view.getUint32(16, true);
  if (streamCount < 3 || tocOffset < 32 || tocOffset + streamCount * 16 > encoded.byteLength) {
    throw new Error("SPZ v4 table of contents is invalid.");
  }
  const streams: Array<{ compressedOffset: number; compressedSize: number; uncompressedSize: number }> = [];
  let compressedOffset = tocOffset + streamCount * 16;
  for (let index = 0; index < streamCount; index += 1) {
    const entryOffset = tocOffset + index * 16;
    const compressedSizeBig = view.getBigUint64(entryOffset, true);
    const uncompressedSizeBig = view.getBigUint64(entryOffset + 8, true);
    if (compressedSizeBig > BigInt(Number.MAX_SAFE_INTEGER) || uncompressedSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("SPZ v4 stream size exceeds the JavaScript safe integer range.");
    }
    const compressedSize = Number(compressedSizeBig);
    const uncompressedSize = Number(uncompressedSizeBig);
    if (compressedSize > encoded.byteLength - compressedOffset) {
      throw new Error("SPZ v4 compressed stream extends past the file.");
    }
    streams.push({ compressedOffset, compressedSize, uncompressedSize });
    compressedOffset += compressedSize;
  }
  if (compressedOffset !== encoded.byteLength) throw new Error("SPZ v4 compressed stream sizes do not match the file.");
  const expectedSizes = [
    pointCount * 9,
    pointCount,
    pointCount * 3,
    pointCount * 3,
    pointCount * 4,
  ] as const;
  const decoded = expectedSizes.map((expectedSize, index) => {
    const stream = streams[index];
    if (!stream || stream.uncompressedSize !== expectedSize) {
      throw new Error(`SPZ v4 stream ${index} has an invalid decoded size.`);
    }
    const result = new Uint8Array(zstdDecompressSync(
      encoded.subarray(stream.compressedOffset, stream.compressedOffset + stream.compressedSize),
    ));
    if (result.byteLength !== expectedSize) throw new Error(`SPZ v4 stream ${index} decompressed to an invalid size.`);
    return result;
  });
  return cloudFromStreams(
    decoded[0],
    decoded[1],
    decoded[2],
    decoded[3],
    decoded[4],
    pointCount,
    fractionalBits,
    4,
    transform,
    source,
  );
}

export function decodeSpz(
  encoded: Uint8Array,
  transform: Transform,
  source = "source.spz",
): SplatCloud {
  const isGzip = encoded[0] === 0x1f && encoded[1] === 0x8b;
  const raw = isGzip ? new Uint8Array(gunzipSync(encoded)) : encoded;
  if (raw.byteLength < LEGACY_HEADER_BYTES) throw new Error("SPZ file is shorter than its header.");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== NGSP_MAGIC) {
    throw new Error("SPZ source does not contain the NGSP header.");
  }
  const version = view.getUint32(4, true);
  if (!isGzip && version === 4) return decodeSpzV4(raw, transform, source);
  if (version < 2 || version > 3) {
    throw new Error(`SPZ version ${version} is unsupported for metric analysis.`);
  }
  const pointCount = view.getUint32(8, true);
  validatePointCount(pointCount);
  const shDegree = view.getUint8(12);
  if (shDegree > 3) throw new Error("Legacy SPZ spherical-harmonic degree must be between 0 and 3.");
  const fractionalBits = view.getUint8(13);
  if (fractionalBits > 24) throw new Error("Legacy SPZ fractionalBits is invalid.");
  const rotationBytes = version >= 3 ? 4 : 3;
  const shDimensions = shDegree * (shDegree + 2);
  const bytesPerPoint = 9 + 1 + 3 + 3 + rotationBytes + shDimensions * 3;
  const minimumBytes = LEGACY_HEADER_BYTES + pointCount * bytesPerPoint;
  if (raw.byteLength < minimumBytes) throw new Error("SPZ attribute streams are truncated.");

  const positionOffset = LEGACY_HEADER_BYTES;
  const alphaOffset = positionOffset + pointCount * 9;
  const colorOffset = alphaOffset + pointCount;
  const scaleOffset = colorOffset + pointCount * 3;
  const rotationOffset = scaleOffset + pointCount * 3;
  return cloudFromStreams(
    raw.subarray(positionOffset, alphaOffset),
    raw.subarray(alphaOffset, colorOffset),
    raw.subarray(colorOffset, scaleOffset),
    raw.subarray(scaleOffset, rotationOffset),
    raw.subarray(rotationOffset, rotationOffset + pointCount * rotationBytes),
    pointCount,
    fractionalBits,
    version,
    transform,
    source,
  );
}

export async function loadCatalogSplat(assetId: string, assetVersion: string): Promise<SplatCloud> {
  const definition = await catalogSplatDefinition(assetId, assetVersion);
  return loadSplatFile(definition.sourcePath, definition.transform);
}

/** Decodes an SPZ file into studio coordinates, reusing the cached cloud while the file is unchanged. */
export async function loadSplatFile(sourcePath: string, transform: Transform): Promise<SplatCloud> {
  const { mtimeMs, size } = await stat(sourcePath);
  const signature = JSON.stringify([mtimeMs, size, transform]);
  const cached = cloudCache.get(sourcePath);
  if (cached?.signature === signature) return cached.cloud;

  const cloud = readFile(sourcePath).then((bytes) => (
    decodeSpz(new Uint8Array(bytes), transform, sourcePath)
  ));
  const entry = { signature, cloud };
  cloudCache.set(sourcePath, entry);
  cloud.catch(() => {
    if (cloudCache.get(sourcePath) === entry) cloudCache.delete(sourcePath);
  });
  return cloud;
}

function transformMatrix(transform: Transform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion(...transform.quaternionXyzw).normalize(),
    new Vector3(...transform.scale),
  );
}

export function boxQueryForEntity(entities: readonly SceneEntity[], entityId: string): SplatBoxQuery {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const matrices = new Map<string, Matrix4>();
  const visiting = new Set<string>();
  const worldMatrix = (id: string): Matrix4 => {
    const cached = matrices.get(id);
    if (cached) return cached;
    const entity = byId.get(id);
    if (!entity) throw new Error(`Scene object does not exist: ${id}`);
    if (visiting.has(id)) throw new Error(`Scene object hierarchy contains a cycle at ${id}.`);
    visiting.add(id);
    const local = transformMatrix(entity.transform);
    const matrix = entity.parentId ? worldMatrix(entity.parentId).clone().multiply(local) : local;
    visiting.delete(id);
    matrices.set(id, matrix);
    return matrix;
  };

  const entity = byId.get(entityId);
  if (!entity) throw new Error(`Scene object does not exist: ${entityId}`);
  if (entity.kind !== "box") throw new Error(`Splat piece analysis currently requires a box object: ${entityId}`);
  return {
    id: entity.id,
    name: entity.name,
    size: entity.size,
    worldMatrix: worldMatrix(entity.id),
  };
}

function sampleQuantile(values: Float32Array, count: number, quantile: number): number {
  const sorted = Array.from(values.subarray(0, count)).sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)));
  return sorted[index];
}

function deterministicReservoirIndex(seen: number): number {
  let value = Math.imul(seen, 0x9e3779b1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  return value % seen;
}

function rgbHex(red: number, green: number, blue: number): string {
  const component = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${component(red)}${component(green)}${component(blue)}`;
}

export function analyzeSplatBox(
  cloud: SplatCloud,
  query: SplatBoxQuery,
  provided: Partial<SplatAnalysisOptions> = {},
): SplatBoxAnalysis {
  const options = { ...DEFAULT_ANALYSIS_OPTIONS, ...provided };
  if (!(options.lowerQuantile >= 0 && options.lowerQuantile < options.upperQuantile && options.upperQuantile <= 1)) {
    throw new Error("Splat edge quantiles must satisfy 0 <= lower < upper <= 1.");
  }
  if (options.paddingM <= 0 || options.surfaceBandM <= 0 || options.maxSamples < 100) {
    throw new Error("Splat analysis padding, surface band, and sample capacity must be positive.");
  }
  if (!(options.opacityThreshold >= 0 && options.opacityThreshold <= 1)) {
    throw new Error("Splat opacity threshold must be between 0 and 1.");
  }

  const inverse = query.worldMatrix.clone().invert();
  const worldScaleVector = new Vector3().setFromMatrixScale(query.worldMatrix);
  const worldScale: Vec3 = [worldScaleVector.x, worldScaleVector.y, worldScaleVector.z];
  if (worldScale.some((component) => component <= 0)) throw new Error(`Scene object has a singular transform: ${query.id}`);
  const half: Vec3 = [query.size[0] / 2, query.size[1] / 2, query.size[2] / 2];
  const paddingLocal: Vec3 = [
    options.paddingM / worldScale[0],
    options.paddingM / worldScale[1],
    options.paddingM / worldScale[2],
  ];
  const surfaceBandLocal: Vec3 = [
    options.surfaceBandM / worldScale[0],
    options.surfaceBandM / worldScale[1],
    options.surfaceBandM / worldScale[2],
  ];
  const samples = [
    new Float32Array(options.maxSamples),
    new Float32Array(options.maxSamples),
    new Float32Array(options.maxSamples),
  ] as const;
  const point = new Vector3();
  const local = new Vector3();
  let supportCount = 0;
  let retainedSamples = 0;
  let surfaceSupportCount = 0;
  let colorWeight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (let index = 0; index < cloud.pointCount; index += 1) {
    const opacity = cloud.opacities[index] / 255;
    if (opacity < options.opacityThreshold) continue;
    const positionOffset = index * 3;
    point.set(
      cloud.positions[positionOffset],
      cloud.positions[positionOffset + 1],
      cloud.positions[positionOffset + 2],
    );
    local.copy(point).applyMatrix4(inverse);
    const coordinates: Vec3 = [local.x, local.y, local.z];
    if (coordinates.some((coordinate, axis) => Math.abs(coordinate) > half[axis] + paddingLocal[axis])) continue;

    supportCount += 1;
    const reservoirIndex = supportCount <= options.maxSamples
      ? supportCount - 1
      : deterministicReservoirIndex(supportCount);
    if (reservoirIndex < options.maxSamples) {
      samples[0][reservoirIndex] = coordinates[0];
      samples[1][reservoirIndex] = coordinates[1];
      samples[2][reservoirIndex] = coordinates[2];
    }
    retainedSamples = Math.min(supportCount, options.maxSamples);

    let surfaceDistanceM = Number.POSITIVE_INFINITY;
    for (let axis = 0; axis < 3; axis += 1) {
      let insideFace = true;
      for (let otherAxis = 0; otherAxis < 3; otherAxis += 1) {
        if (otherAxis !== axis && Math.abs(coordinates[otherAxis]) > half[otherAxis] + surfaceBandLocal[otherAxis]) {
          insideFace = false;
          break;
        }
      }
      if (insideFace) {
        surfaceDistanceM = Math.min(
          surfaceDistanceM,
          Math.abs(Math.abs(coordinates[axis]) - half[axis]) * worldScale[axis],
        );
      }
    }
    if (surfaceDistanceM > options.surfaceBandM) continue;
    const weight = opacity * Math.exp(-4 * (surfaceDistanceM / options.surfaceBandM) ** 2);
    const colorOffset = index * 3;
    red += cloud.colors[colorOffset] * weight;
    green += cloud.colors[colorOffset + 1] * weight;
    blue += cloud.colors[colorOffset + 2] * weight;
    colorWeight += weight;
    surfaceSupportCount += 1;
  }

  if (retainedSamples === 0) {
    return {
      id: query.id,
      name: query.name,
      currentSizeM: [query.size[0] * worldScale[0], query.size[1] * worldScale[1], query.size[2] * worldScale[2]],
      lowerEdgeOffsetM: [0, 0, 0],
      upperEdgeOffsetM: [0, 0, 0],
      estimatedSizeM: [0, 0, 0],
      estimatedCenterOffsetM: [0, 0, 0],
      supportCount,
      retainedSamples,
      surfaceSupportCount,
      confidence: "low",
    };
  }

  const lowerEdgeOffsetM: Vec3 = [
    sampleQuantile(samples[0], retainedSamples, options.lowerQuantile) * worldScale[0],
    sampleQuantile(samples[1], retainedSamples, options.lowerQuantile) * worldScale[1],
    sampleQuantile(samples[2], retainedSamples, options.lowerQuantile) * worldScale[2],
  ];
  const upperEdgeOffsetM: Vec3 = [
    sampleQuantile(samples[0], retainedSamples, options.upperQuantile) * worldScale[0],
    sampleQuantile(samples[1], retainedSamples, options.upperQuantile) * worldScale[1],
    sampleQuantile(samples[2], retainedSamples, options.upperQuantile) * worldScale[2],
  ];
  const estimatedSizeM: Vec3 = [
    upperEdgeOffsetM[0] - lowerEdgeOffsetM[0],
    upperEdgeOffsetM[1] - lowerEdgeOffsetM[1],
    upperEdgeOffsetM[2] - lowerEdgeOffsetM[2],
  ];
  const estimatedCenterOffsetM: Vec3 = [
    (upperEdgeOffsetM[0] + lowerEdgeOffsetM[0]) / 2,
    (upperEdgeOffsetM[1] + lowerEdgeOffsetM[1]) / 2,
    (upperEdgeOffsetM[2] + lowerEdgeOffsetM[2]) / 2,
  ];
  const ratios = estimatedSizeM.map((value, axis) => value / (query.size[axis] * worldScale[axis]));
  const plausible = ratios.every((ratio) => ratio >= 0.25 && ratio <= 2);
  const confidence = supportCount >= 500 && plausible
    ? "high"
    : supportCount >= 100 && plausible
      ? "medium"
      : "low";

  return {
    id: query.id,
    name: query.name,
    currentSizeM: [query.size[0] * worldScale[0], query.size[1] * worldScale[1], query.size[2] * worldScale[2]],
    lowerEdgeOffsetM,
    upperEdgeOffsetM,
    estimatedSizeM,
    estimatedCenterOffsetM,
    supportCount,
    retainedSamples,
    surfaceSupportCount,
    ...(colorWeight > 0 ? { surfaceColor: rgbHex(red / colorWeight, green / colorWeight, blue / colorWeight) } : {}),
    confidence,
  };
}

type AxisIndex = 0 | 1 | 2;

interface FaceProjection {
  readonly axis: AxisIndex;
  readonly sign: -1 | 1;
  readonly uAxis: AxisIndex;
  readonly vAxis: AxisIndex;
}

const FACE_PROJECTIONS: Readonly<Record<BoxTextureFace, FaceProjection>> = {
  "x-positive": { axis: 0, sign: 1, uAxis: 1, vAxis: 2 },
  "x-negative": { axis: 0, sign: -1, uAxis: 1, vAxis: 2 },
  "y-positive": { axis: 1, sign: 1, uAxis: 0, vAxis: 2 },
  "y-negative": { axis: 1, sign: -1, uAxis: 0, vAxis: 2 },
  "z-positive": { axis: 2, sign: 1, uAxis: 0, vAxis: 1 },
  "z-negative": { axis: 2, sign: -1, uAxis: 0, vAxis: 1 },
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function encodeRgbPng(width: number, height: number, pixels: Uint8Array): string {
  const stride = width * 3;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (stride + 1);
    raw[outputOffset] = 0;
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), outputOffset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return `data:image/png;base64,${Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}

/**
 * Projects nearby Gaussian base colors onto one box face. The output is a
 * compact PNG texture; unsupported texels inherit the nearest sampled texel.
 */
export function bakeSplatBoxTexture(
  cloud: SplatCloud,
  query: SplatBoxQuery,
  options: {
    readonly face: BoxTextureFace;
    readonly resolution: number;
    readonly surfaceBandM: number;
    readonly opacityThreshold: number;
  },
): SplatTextureBake {
  if (!Number.isInteger(options.resolution) || options.resolution < 1 || options.resolution > 256) {
    throw new Error("Texture resolution must be an integer between 1 and 256.");
  }
  const projection = FACE_PROJECTIONS[options.face];
  const resolution = options.resolution;
  const pixelCount = resolution * resolution;
  const red = new Float64Array(pixelCount);
  const green = new Float64Array(pixelCount);
  const blue = new Float64Array(pixelCount);
  const weights = new Float64Array(pixelCount);
  const inverse = query.worldMatrix.clone().invert();
  const scaleVector = new Vector3().setFromMatrixScale(query.worldMatrix);
  const worldScale: Vec3 = [scaleVector.x, scaleVector.y, scaleVector.z];
  const half: Vec3 = [query.size[0] / 2, query.size[1] / 2, query.size[2] / 2];
  const point = new Vector3();
  const local = new Vector3();
  const coordinates = new Float64Array(3);
  const kernelRadius = Math.max(1, Math.round(resolution / 32));
  const kernelScale = Math.max(1, kernelRadius * kernelRadius * 0.7);
  let supportCount = 0;
  let averageRed = 0;
  let averageGreen = 0;
  let averageBlue = 0;
  let averageWeight = 0;

  for (let index = 0; index < cloud.pointCount; index += 1) {
    const opacity = cloud.opacities[index] / 255;
    if (opacity < options.opacityThreshold) continue;
    const positionOffset = index * 3;
    point.set(
      cloud.positions[positionOffset],
      cloud.positions[positionOffset + 1],
      cloud.positions[positionOffset + 2],
    );
    local.copy(point).applyMatrix4(inverse);
    coordinates[0] = local.x;
    coordinates[1] = local.y;
    coordinates[2] = local.z;
    const uCoordinate = coordinates[projection.uAxis];
    const vCoordinate = coordinates[projection.vAxis];
    if (
      Math.abs(uCoordinate) > half[projection.uAxis]
      || Math.abs(vCoordinate) > half[projection.vAxis]
    ) continue;
    const faceCoordinate = projection.sign * half[projection.axis];
    const faceDistanceM = Math.abs(coordinates[projection.axis] - faceCoordinate)
      * worldScale[projection.axis];
    if (faceDistanceM > options.surfaceBandM) continue;

    const u = (uCoordinate / query.size[projection.uAxis]) + 0.5;
    const v = (vCoordinate / query.size[projection.vAxis]) + 0.5;
    const centerX = Math.max(0, Math.min(resolution - 1, Math.round(u * (resolution - 1))));
    const centerY = Math.max(0, Math.min(resolution - 1, Math.round((1 - v) * (resolution - 1))));
    const depthWeight = opacity * Math.exp(-4 * (faceDistanceM / options.surfaceBandM) ** 2);
    const colorOffset = index * 3;
    const sampleRed = cloud.colors[colorOffset];
    const sampleGreen = cloud.colors[colorOffset + 1];
    const sampleBlue = cloud.colors[colorOffset + 2];
    supportCount += 1;
    averageRed += sampleRed * depthWeight;
    averageGreen += sampleGreen * depthWeight;
    averageBlue += sampleBlue * depthWeight;
    averageWeight += depthWeight;

    const minY = Math.max(0, centerY - kernelRadius);
    const maxY = Math.min(resolution - 1, centerY + kernelRadius);
    const minX = Math.max(0, centerX - kernelRadius);
    const maxX = Math.min(resolution - 1, centerX + kernelRadius);
    for (let pixelY = minY; pixelY <= maxY; pixelY += 1) {
      for (let pixelX = minX; pixelX <= maxX; pixelX += 1) {
        const distanceSquared = ((pixelX - centerX) ** 2) + ((pixelY - centerY) ** 2);
        const weight = depthWeight * Math.exp(-distanceSquared / kernelScale);
        const pixelIndex = (pixelY * resolution) + pixelX;
        red[pixelIndex] += sampleRed * weight;
        green[pixelIndex] += sampleGreen * weight;
        blue[pixelIndex] += sampleBlue * weight;
        weights[pixelIndex] += weight;
      }
    }
  }

  if (supportCount === 0 || averageWeight === 0) {
    return { supportCount: 0, seededPixelCount: 0, seededCoverage: 0 };
  }

  const pixels = new Uint8Array(pixelCount * 3);
  const filled = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueRead = 0;
  let queueWrite = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (weights[pixelIndex] === 0) continue;
    const outputOffset = pixelIndex * 3;
    pixels[outputOffset] = Math.round(red[pixelIndex] / weights[pixelIndex]);
    pixels[outputOffset + 1] = Math.round(green[pixelIndex] / weights[pixelIndex]);
    pixels[outputOffset + 2] = Math.round(blue[pixelIndex] / weights[pixelIndex]);
    filled[pixelIndex] = 1;
    queue[queueWrite] = pixelIndex;
    queueWrite += 1;
  }
  const seededPixelCount = queueWrite;
  const neighborOffsets = [-resolution, resolution, -1, 1] as const;
  while (queueRead < queueWrite) {
    const pixelIndex = queue[queueRead];
    queueRead += 1;
    const x = pixelIndex % resolution;
    for (const offset of neighborOffsets) {
      if ((offset === -1 && x === 0) || (offset === 1 && x === resolution - 1)) continue;
      const neighbor = pixelIndex + offset;
      if (neighbor < 0 || neighbor >= pixelCount || filled[neighbor] !== 0) continue;
      const sourceOffset = pixelIndex * 3;
      const targetOffset = neighbor * 3;
      pixels[targetOffset] = pixels[sourceOffset];
      pixels[targetOffset + 1] = pixels[sourceOffset + 1];
      pixels[targetOffset + 2] = pixels[sourceOffset + 2];
      filled[neighbor] = 1;
      queue[queueWrite] = neighbor;
      queueWrite += 1;
    }
  }

  return {
    texture: {
      dataUrl: encodeRgbPng(resolution, resolution, pixels),
      face: options.face,
      width: resolution,
      height: resolution,
    },
    supportCount,
    seededPixelCount,
    seededCoverage: seededPixelCount / pixelCount,
    averageColor: rgbHex(
      averageRed / averageWeight,
      averageGreen / averageWeight,
      averageBlue / averageWeight,
    ),
  };
}

export function boxEntityForUpdate(entities: readonly SceneEntity[], entityId: string): BoxSceneEntity {
  const entity = entities.find(({ id }) => id === entityId);
  if (!entity) throw new Error(`Scene object does not exist: ${entityId}`);
  if (entity.kind !== "box") throw new Error(`Splat material transfer currently requires a box object: ${entityId}`);
  return structuredClone(entity);
}
