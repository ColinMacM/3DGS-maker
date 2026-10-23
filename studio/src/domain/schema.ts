import { isBlobObjectUrl, markReferenceUnavailable } from "./referenceAvailability";
import type {
  LayerVisibility,
  Measurement,
  SceneEntity,
  SceneEntityKind,
  SceneMaterial,
  ReferenceKind,
  ReferenceLayer,
  StudioDocument,
  ViewportSettings,
  TableParameters,
  Transform,
  Vec3,
} from "./types";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class StudioDocumentValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const detail = issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
    super(`Invalid studio document${detail ? ` — ${detail}` : ""}`);
    this.name = "StudioDocumentValidationError";
    this.issues = issues;
  }
}

const DOCUMENT_KEYS = [
  "schemaVersion", "id", "name", "units", "upAxis", "assetId", "assetVersion",
  "table", "tableTransform", "layers", "viewport", "entities", "references",
  "measurements", "updatedAt",
] as const;
const TABLE_KEYS = [
  "width", "length", "topThickness", "topHeight", "holeDiameter", "holePitch",
  "rows", "columns", "edgeToHole", "legSize",
] as const;
const TRANSFORM_KEYS = ["position", "quaternionXyzw", "scale"] as const;
const LAYER_KEYS = ["catalogVisuals", "parametricModel", "collisions", "reference", "measurements"] as const;
const REFERENCE_KEYS = ["id", "name", "kind", "objectUrl", "transform", "opacity", "visible"] as const;
const MEASUREMENT_KEYS = ["id", "label", "start", "end"] as const;
const VIEWPORT_KEYS: readonly string[] = [];
const ENTITY_BASE_KEYS = ["id", "name", "kind", "visible", "parentId", "transform"] as const;
const MATERIAL_KEYS = ["color", "opacity"] as const;
const ENTITY_KINDS: Readonly<Record<SceneEntityKind, true>> = {
  box: true,
  sphere: true,
  cylinder: true,
  capsule: true,
  model: true,
  group: true,
  label: true,
};
const ENTITY_KIND_KEYS: Readonly<Record<SceneEntityKind, readonly string[]>> = {
  box: ["size", "material"],
  sphere: ["radius", "material"],
  cylinder: ["radius", "height", "material"],
  capsule: ["radius", "height", "material"],
  model: ["source"],
  group: [],
  label: ["text", "color", "backgroundColor", "size"],
};

function requireRecord(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return {};
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record).sort()) {
    if (!known.has(key)) issues.push({ path: `${path}.${key}`, message: "is not a recognized property" });
  }
}

function requiredString(value: unknown, path: string, issues: ValidationIssue[], maximumLength = 256): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return "";
  }
  if (value.length > maximumLength) {
    issues.push({ path, message: `must contain at most ${maximumLength} characters` });
  }
  return value;
}

function finiteNumber(value: unknown, path: string, issues: ValidationIssue[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "must be a finite number" });
    return 0;
  }
  return value;
}

function positiveNumber(value: unknown, path: string, issues: ValidationIssue[], maximum = Number.MAX_VALUE): number {
  const result = finiteNumber(value, path, issues);
  if (typeof value === "number" && Number.isFinite(value) && (result <= 0 || result > maximum)) {
    issues.push({ path, message: `must be greater than zero and at most ${maximum}` });
  }
  return result;
}

function nonnegativeNumber(value: unknown, path: string, issues: ValidationIssue[], maximum = Number.MAX_VALUE): number {
  const result = finiteNumber(value, path, issues);
  if (typeof value === "number" && Number.isFinite(value) && (result < 0 || result > maximum)) {
    issues.push({ path, message: `must be between zero and ${maximum}` });
  }
  return result;
}

function integer(value: unknown, path: string, issues: ValidationIssue[], maximum: number): number {
  const result = finiteNumber(value, path, issues);
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || value < 1 || value > maximum)) {
    issues.push({ path, message: `must be an integer between 1 and ${maximum}` });
  }
  return result;
}

function boolean(value: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (typeof value !== "boolean") {
    issues.push({ path, message: "must be a boolean" });
    return false;
  }
  return value;
}

function color(value: unknown, path: string, issues: ValidationIssue[]): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    issues.push({ path, message: "must be a six-digit hexadecimal color" });
    return "#ffffff";
  }
  return value.toLowerCase();
}

function tuple(
  value: unknown,
  size: 3 | 4,
  path: string,
  issues: ValidationIssue[],
): readonly number[] {
  if (!Array.isArray(value) || value.length !== size) {
    issues.push({ path, message: `must be an array of exactly ${size} finite numbers` });
    return Array.from({ length: size }, () => 0);
  }
  return value.map((component, index) => finiteNumber(component, `${path}[${index}]`, issues));
}

function parseTransform(value: unknown, path: string, issues: ValidationIssue[]): Transform {
  const record = requireRecord(value, path, issues);
  rejectUnknownKeys(record, TRANSFORM_KEYS, path, issues);
  const position = tuple(record.position, 3, `${path}.position`, issues) as Vec3;
  const quaternionXyzw = tuple(record.quaternionXyzw, 4, `${path}.quaternionXyzw`, issues) as Transform["quaternionXyzw"];
  const scale = tuple(record.scale, 3, `${path}.scale`, issues) as Vec3;

  if (quaternionXyzw.every((component) => component === 0)) {
    issues.push({ path: `${path}.quaternionXyzw`, message: "must not be the zero quaternion" });
  }
  scale.forEach((component, index) => {
    if (component <= 0 || component > 1000) issues.push({ path: `${path}.scale[${index}]`, message: "must be greater than zero and at most 1000" });
  });
  return { position, quaternionXyzw, scale };
}

function parseTable(value: unknown, path: string, issues: ValidationIssue[]): TableParameters {
  const record = requireRecord(value, path, issues);
  rejectUnknownKeys(record, TABLE_KEYS, path, issues);
  return {
    width: positiveNumber(record.width, `${path}.width`, issues, 100),
    length: positiveNumber(record.length, `${path}.length`, issues, 100),
    topThickness: positiveNumber(record.topThickness, `${path}.topThickness`, issues, 100),
    topHeight: positiveNumber(record.topHeight, `${path}.topHeight`, issues, 100),
    holeDiameter: positiveNumber(record.holeDiameter, `${path}.holeDiameter`, issues, 10),
    holePitch: positiveNumber(record.holePitch, `${path}.holePitch`, issues, 10),
    rows: integer(record.rows, `${path}.rows`, issues, 100),
    columns: integer(record.columns, `${path}.columns`, issues, 100),
    edgeToHole: nonnegativeNumber(record.edgeToHole, `${path}.edgeToHole`, issues, 100),
    legSize: positiveNumber(record.legSize, `${path}.legSize`, issues, 100),
  };
}

function parseLayers(value: unknown, path: string, issues: ValidationIssue[]): LayerVisibility {
  const record = requireRecord(value, path, issues);
  rejectUnknownKeys(record, LAYER_KEYS, path, issues);
  return {
    catalogVisuals: boolean(record.catalogVisuals, `${path}.catalogVisuals`, issues),
    parametricModel: boolean(record.parametricModel, `${path}.parametricModel`, issues),
    collisions: boolean(record.collisions, `${path}.collisions`, issues),
    reference: boolean(record.reference, `${path}.reference`, issues),
    measurements: boolean(record.measurements, `${path}.measurements`, issues),
  };
}

function parseViewport(value: unknown, path: string, issues: ValidationIssue[]): ViewportSettings {
  const input = requireRecord(value, path, issues);
  const { toby: _removedToby, ...record } = input;
  rejectUnknownKeys(record, VIEWPORT_KEYS, path, issues);
  return {};
}

function parseMaterial(value: unknown, path: string, issues: ValidationIssue[]): SceneMaterial {
  const record = requireRecord(value, path, issues);
  rejectUnknownKeys(record, MATERIAL_KEYS, path, issues);
  const opacity = finiteNumber(record.opacity, `${path}.opacity`, issues);
  if (opacity < 0 || opacity > 1) issues.push({ path: `${path}.opacity`, message: "must be between 0 and 1" });
  return {
    color: color(record.color, `${path}.color`, issues),
    opacity,
  };
}

function positiveVec3(value: unknown, path: string, issues: ValidationIssue[]): Vec3 {
  const result = tuple(value, 3, path, issues) as Vec3;
  result.forEach((component, index) => {
    if (component <= 0 || component > 1000) {
      issues.push({ path: `${path}[${index}]`, message: "must be greater than zero and at most 1000" });
    }
  });
  return result;
}

function parseEntity(value: unknown, path: string, issues: ValidationIssue[]): SceneEntity {
  const record = requireRecord(value, path, issues);
  const rawKind = record.kind;
  const kind = (
    typeof rawKind === "string"
    && ENTITY_KINDS[rawKind as SceneEntityKind] === true
  ) ? rawKind as SceneEntityKind : "group";
  if (kind !== rawKind) {
    issues.push({
      path: `${path}.kind`,
      message: `must be one of: ${Object.keys(ENTITY_KINDS).join(", ")}`,
    });
  }
  rejectUnknownKeys(record, [...ENTITY_BASE_KEYS, ...ENTITY_KIND_KEYS[kind]], path, issues);
  const parentId = record.parentId === undefined
    ? undefined
    : requiredString(record.parentId, `${path}.parentId`, issues);
  const base = {
    id: requiredString(record.id, `${path}.id`, issues),
    name: requiredString(record.name, `${path}.name`, issues),
    visible: boolean(record.visible, `${path}.visible`, issues),
    ...(parentId ? { parentId } : {}),
    transform: parseTransform(record.transform, `${path}.transform`, issues),
  };

  switch (kind) {
    case "box":
      return {
        ...base,
        kind,
        size: positiveVec3(record.size, `${path}.size`, issues),
        material: parseMaterial(record.material, `${path}.material`, issues),
      };
    case "sphere":
      return {
        ...base,
        kind,
        radius: positiveNumber(record.radius, `${path}.radius`, issues, 1000),
        material: parseMaterial(record.material, `${path}.material`, issues),
      };
    case "cylinder":
    case "capsule":
      return {
        ...base,
        kind,
        radius: positiveNumber(record.radius, `${path}.radius`, issues, 1000),
        height: positiveNumber(record.height, `${path}.height`, issues, 1000),
        material: parseMaterial(record.material, `${path}.material`, issues),
      };
    case "model": {
      const source = requiredString(record.source, `${path}.source`, issues, 1024);
      if (
        !source.startsWith("/")
        || source.startsWith("//")
        || source.split("/").includes("..")
        || !/\.glb(?:[?#].*)?$/i.test(source)
      ) {
        issues.push({
          path: `${path}.source`,
          message: "must be a same-origin absolute GLB path without parent traversal",
        });
      }
      return { ...base, kind, source };
    }
    case "label":
      return {
        ...base,
        kind,
        text: requiredString(record.text, `${path}.text`, issues),
        color: color(record.color, `${path}.color`, issues),
        backgroundColor: color(record.backgroundColor, `${path}.backgroundColor`, issues),
        size: positiveNumber(record.size, `${path}.size`, issues, 100),
      };
    case "group":
      return { ...base, kind };
  }
}

function validateEntityHierarchy(
  entities: readonly SceneEntity[],
  path: string,
  issues: ValidationIssue[],
): void {
  const byId = new Map(entities.map((entity) => [entity.id, entity] as const));
  const indexById = new Map(entities.map((entity, index) => [entity.id, index] as const));

  entities.forEach((entity, index) => {
    if (!entity.parentId) return;
    const parent = byId.get(entity.parentId);
    if (!parent) {
      issues.push({ path: `${path}[${index}].parentId`, message: `does not match an entity id` });
      return;
    }
    if (parent.kind !== "group") {
      issues.push({ path: `${path}[${index}].parentId`, message: "must reference a group entity" });
    }
  });

  for (const entity of entities) {
    const visited = new Set<string>([entity.id]);
    let parentId = entity.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        const index = indexById.get(entity.id) ?? 0;
        issues.push({ path: `${path}[${index}].parentId`, message: "must not form a cycle" });
        break;
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
}

function parseReference(value: unknown, path: string, issues: ValidationIssue[]): ReferenceLayer {
  const record = requireRecord(value, path, issues);
  rejectUnknownKeys(record, REFERENCE_KEYS, path, issues);
  const kind = record.kind;
  if (kind !== "splat" && kind !== "mesh" && kind !== "point-cloud") {
    issues.push({ path: `${path}.kind`, message: "must be one of: splat, mesh, point-cloud" });
  }
  if (record.objectUrl !== undefined && (typeof record.objectUrl !== "string" || record.objectUrl.length === 0)) {
    issues.push({ path: `${path}.objectUrl`, message: "must be a non-empty string when provided" });
  }
  const opacity = finiteNumber(record.opacity, `${path}.opacity`, issues);
  if (opacity < 0 || opacity > 1) {
    issues.push({ path: `${path}.opacity`, message: "must be between 0 and 1" });
  }
  return {
    id: requiredString(record.id, `${path}.id`, issues),
    name: requiredString(record.name, `${path}.name`, issues),
    kind: kind as ReferenceKind,
    ...(typeof record.objectUrl === "string" ? { objectUrl: record.objectUrl } : {}),
    transform: parseTransform(record.transform, `${path}.transform`, issues),
    opacity,
    visible: boolean(record.visible, `${path}.visible`, issues),
  };
}

function parseMeasurement(value: unknown, path: string, issues: ValidationIssue[]): Measurement {
  const record = requireRecord(value, path, issues);
  rejectUnknownKeys(record, MEASUREMENT_KEYS, path, issues);
  return {
    id: requiredString(record.id, `${path}.id`, issues),
    label: requiredString(record.label, `${path}.label`, issues),
    start: tuple(record.start, 3, `${path}.start`, issues) as Vec3,
    end: tuple(record.end, 3, `${path}.end`, issues) as Vec3,
  };
}

function parseArray<T>(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maximumLength: number,
  itemParser: (item: unknown, itemPath: string, issues: ValidationIssue[]) => T,
): T[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return [];
  }
  if (value.length > maximumLength) {
    issues.push({ path, message: `must contain at most ${maximumLength} items` });
  }
  return value.slice(0, maximumLength).map((item, index) => itemParser(item, `${path}[${index}]`, issues));
}

function rejectDuplicateIds(values: readonly { id: string }[], path: string, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  values.forEach(({ id }, index) => {
    if (id && seen.has(id)) issues.push({ path: `${path}[${index}].id`, message: `duplicates id ${JSON.stringify(id)}` });
    seen.add(id);
  });
}

function migrateVersion1(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== 1) return value;

  const entities = Array.isArray(document.entities)
    ? document.entities
        .filter((entity) => (
          typeof entity !== "object"
          || entity === null
          || Array.isArray(entity)
          || !["directional-light", "point-light"].includes(
            String((entity as Record<string, unknown>).kind),
          )
        ))
        .map((entity) => {
          if (typeof entity !== "object" || entity === null || Array.isArray(entity)) return entity;
          const record = entity as Record<string, unknown>;
          const material = record.material;
          if (typeof material !== "object" || material === null || Array.isArray(material)) {
            return entity;
          }
          const {
            metalness: _removedMetalness,
            roughness: _removedRoughness,
            ...fullbrightMaterial
          } = material as Record<string, unknown>;
          return { ...record, material: fullbrightMaterial };
        })
    : document.entities;

  return {
    ...document,
    schemaVersion: 2,
    assetVersion: document.assetId === "welding-cell" && document.assetVersion === "1.0.0"
      ? "1.1.0"
      : document.assetVersion,
    viewport: {},
    entities,
  };
}

/** Validates v2 input, migrating persisted v1 lighting state to fullbright data. */
export function validateStudioDocument(value: unknown): StudioDocument {
  const issues: ValidationIssue[] = [];
  const record = requireRecord(migrateVersion1(value), "$", issues);
  rejectUnknownKeys(record, DOCUMENT_KEYS, "$", issues);
  if (record.schemaVersion !== 2) issues.push({ path: "$.schemaVersion", message: "must equal 2" });
  if (record.units !== "m") issues.push({ path: "$.units", message: 'must equal "m"' });
  if (record.upAxis !== "Z") issues.push({ path: "$.upAxis", message: 'must equal "Z"' });


  const references = parseArray(record.references, "$.references", issues, 32, parseReference);
  const entities = parseArray(record.entities ?? [], "$.entities", issues, 256, parseEntity);
  const measurements = parseArray(record.measurements, "$.measurements", issues, 128, parseMeasurement);
  rejectDuplicateIds(references, "$.references", issues);
  rejectDuplicateIds(measurements, "$.measurements", issues);
  rejectDuplicateIds(entities, "$.entities", issues);
  validateEntityHierarchy(entities, "$.entities", issues);

  const updatedAt = requiredString(record.updatedAt, "$.updatedAt", issues);
  if (updatedAt && Number.isNaN(Date.parse(updatedAt))) {
    issues.push({ path: "$.updatedAt", message: "must be a valid date-time string" });
  }

  const document: StudioDocument = {
    schemaVersion: 2,
    id: requiredString(record.id, "$.id", issues),
    name: requiredString(record.name, "$.name", issues),
    units: "m",
    upAxis: "Z",
    assetId: requiredString(record.assetId, "$.assetId", issues),
    assetVersion: requiredString(record.assetVersion, "$.assetVersion", issues),
    table: parseTable(record.table, "$.table", issues),
    tableTransform: parseTransform(record.tableTransform, "$.tableTransform", issues),
    layers: parseLayers(record.layers, "$.layers", issues),
    viewport: parseViewport(record.viewport ?? {}, "$.viewport", issues),
    entities,
    references,
    measurements,
    updatedAt,
  };

  if (issues.length > 0) throw new StudioDocumentValidationError(issues);
  return document;
}

export function parseStudioDocumentJson(text: string): StudioDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new StudioDocumentValidationError([{ path: "$", message: `must be valid JSON (${detail})` }]);
  }
  const document = validateStudioDocument(value);
  return {
    ...document,
    references: document.references.map((reference) => (
      !reference.objectUrl || isBlobObjectUrl(reference.objectUrl)
        ? markReferenceUnavailable(reference)
        : reference
    )),
  };
}

/** Serializes a document without persisting process-local Blob URLs. */
export function serializeStudioDocument(document: StudioDocument): string {
  const valid = validateStudioDocument(document);
  const durable: StudioDocument = {
    ...valid,
    references: valid.references.map((reference) => {
      if (reference.objectUrl && !isBlobObjectUrl(reference.objectUrl)) return reference;
      const { objectUrl: _discarded, ...metadata } = reference;
      return { ...metadata, visible: false };
    }),
  };
  return `${JSON.stringify(durable, null, 2)}\n`;
}
