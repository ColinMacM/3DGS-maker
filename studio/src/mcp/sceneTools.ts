import { z } from "zod";

import type {
  SceneBounds,
  SceneCollisionBox,
  SceneEntity,
  SceneEntityKind,
  StudioDocument,
  Vec3,
} from "../domain/types";
import type { StudioCommand } from "../state/commands";
import {
  entityWorldPoses,
  localTransformKeepingWorld,
  quaternionFromEulerDegrees,
} from "./sceneMath";

/** The scene server applies at most this many commands in one atomic batch. */
export const MAX_COMMANDS_PER_CALL = 100;
/**
 * Splat tools that write back may need one entity.upsert per box plus one
 * bounds.set and one layer.visibility.set, all in one batch.
 */
export const MAX_SPLAT_ENTITY_IDS = MAX_COMMANDS_PER_CALL - 2;

/** Each overlay-producing tool owns the bounds whose id starts with its prefix. */
export const OVERLAY_NAMESPACES = {
  fit: "splat-bound:",
  voxels: "voxel-query:",
} as const;
export const FIT_OVERLAY_COLOR = "#35d7ff";
export const VOXEL_SEARCH_COLOR = "#2f8cff";
export const VOXEL_CELL_COLOR = "#ff3b30";

// ── Shared descriptions ────────────────────────────────────────────────────

export const CONVENTIONS = {
  position: "Position in metres, +Z up. For a child (parentId set) it is in the parent group's local frame; otherwise world. Box/sphere/cylinder/capsule positions are the geometric centre.",
  rotation: "Rotation in degrees as Three.js intrinsic XYZ Euler [x, y, z]: R = Rx·Ry·Rz (rotate about local X, then the new Y, then the new Z). Parent-local for children.",
  scale: "Per-axis scale factors (> 0) applied along the object's local axes; multiplies size/radius/height. Parent-local for children (a parent's scale also scales its children).",
  parentId: "Id of an existing group entity to nest under. The child's position/rotationDegrees/scale are then local to that group (group transform applied first). Omit for a top-level object in world coordinates.",
} as const;

// ── Field schemas ──────────────────────────────────────────────────────────

const finite = z.number().finite();
export const vec3 = z.tuple([finite, finite, finite]);
const positiveVec3 = vec3.refine((value) => value.every((component) => component > 0), {
  message: "All three components must be greater than zero.",
});
export const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, { message: "Use a #rrggbb hex colour." });
export const identifier = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/, {
  message: "Use letters, numbers, dot, underscore, colon, or hyphen.",
});
export const positionField = vec3.default([0, 0, 0]).describe(`${CONVENTIONS.position} Default [0, 0, 0].`);
export const rotationField = vec3.default([0, 0, 0]).describe(`${CONVENTIONS.rotation} Default [0, 0, 0].`);
export const scaleField = positiveVec3.default([1, 1, 1]).describe(`${CONVENTIONS.scale} Default [1, 1, 1].`);
const nameField = z.string().trim().min(1).max(256).describe("Human-readable display name.");

const placementShape = {
  position: positionField,
  rotationDegrees: rotationField,
  scale: scaleField,
  visible: z.boolean().default(true).describe("Whether the object renders. Hidden ancestors also hide it. Default true."),
};
const identityShape = {
  id: identifier.optional().describe("Stable id. Reusing an existing id replaces that object. Omit to generate '<slug>-<random>' (assembly children get '<groupId>-<slug>-<index>')."),
  name: nameField,
  collision: z.boolean().default(false).describe("Box only: also create a collider linked to this box (id '<id>:collision') that follows its transform and size, and turn on the collisions layer. Authored colliders replace the package-manifest colliders in the viewport. Default false."),
};
const materialShape = {
  color: hexColor.default("#b7834f").describe("Surface colour as #rrggbb. Default #b7834f."),
  opacity: z.number().min(0).max(1).default(1).describe("Surface opacity, 0 (invisible) to 1 (opaque). Default 1."),
};
const radiusField = z.number().positive().max(1000).describe("Radius in metres (before scale).");
const labelTextField = z.string().min(1).max(256).describe("Label text. The sprite canvas fits about 17 characters at its fixed width; longer text is clipped.");
const labelSizeField = z.number().positive().max(100).describe("Label text height in metres (before scale).");
const modelSourceField = z.string().startsWith("/").regex(/\.glb(?:[?#].*)?$/i, {
  message: "Model source must be a .glb URL path.",
}).describe("GLB URL path rooted at repo assets/ (e.g. /fr10/browser/fr10_home.glb, not /assets/fr10/...). The file must exist. The GLB must be authored Z-up: no Y-up conversion is applied, so a standard Y-up glTF lies on its side. The position is the GLB origin.");

export const sceneObject = z.discriminatedUnion("kind", [
  z.object({
    ...identityShape,
    ...placementShape,
    ...materialShape,
    kind: z.literal("box").describe("Box centred on its position."),
    size: positiveVec3.describe("Edge lengths [x, y, z] in metres along the box's local axes (before scale)."),
  }).strict(),
  z.object({
    ...identityShape,
    ...placementShape,
    ...materialShape,
    kind: z.literal("sphere").describe("Sphere centred on its position."),
    radius: radiusField,
  }).strict(),
  z.object({
    ...identityShape,
    ...placementShape,
    ...materialShape,
    kind: z.enum(["cylinder", "capsule"]).describe("Cylinder or capsule centred on its position with its axis along local +Z."),
    radius: radiusField,
    height: z.number().positive().max(1000).describe("Cylinder: total length along local Z. Capsule: length of the straight section only; total capsule length = height + 2·radius. Metres, before scale."),
  }).strict(),
  z.object({
    ...identityShape,
    ...placementShape,
    kind: z.literal("model").describe("Static GLB model."),
    source: modelSourceField,
  }).strict(),
  z.object({
    ...identityShape,
    ...placementShape,
    kind: z.literal("label").describe("Text billboard sprite centred on its position. It always faces the camera, so rotation is ignored."),
    text: labelTextField,
    color: hexColor.default("#ffffff").describe("Text colour as #rrggbb. Default #ffffff."),
    backgroundColor: hexColor.default("#1a2026").describe("Background panel colour as #rrggbb. Default #1a2026."),
    size: labelSizeField.default(0.08).describe("Label text height in metres (before scale). Default 0.08."),
  }).strict(),
]);

export type SceneObjectInput = z.infer<typeof sceneObject>;

export const objectPatch = z.object({
  id: identifier.describe("Id of the object to update."),
  name: nameField.optional(),
  visible: z.boolean().optional().describe("Show or hide the object (and therefore its descendants)."),
  parentId: identifier.nullable().optional().describe(`New parent group id, or null to move to top level. ${CONVENTIONS.parentId} Without keepWorldTransform the stored local transform is kept, so the object moves with its new parent.`),
  keepWorldTransform: z.boolean().optional().describe("With parentId: recompute the local transform so the object keeps its current world pose under the new parent. Cannot be combined with position, rotationDegrees, or scale."),
  position: vec3.optional().describe(CONVENTIONS.position),
  rotationDegrees: vec3.optional().describe(`${CONVENTIONS.rotation} Ignored by labels.`),
  scale: positiveVec3.optional().describe(CONVENTIONS.scale),
  color: hexColor.optional().describe("box/sphere/cylinder/capsule: surface colour. label: text colour."),
  opacity: z.number().min(0).max(1).optional().describe("box/sphere/cylinder/capsule only: surface opacity 0-1."),
  backgroundColor: hexColor.optional().describe("label only: background panel colour."),
  text: labelTextField.optional().describe("label only: new text. About 17 characters fit; longer text is clipped."),
  size: z.union([positiveVec3, labelSizeField]).optional().describe("box: edge lengths [x, y, z] in metres. label: a single number, the text height in metres."),
  radius: radiusField.optional().describe("sphere/cylinder/capsule only: radius in metres."),
  height: z.number().positive().max(1000).optional().describe("cylinder/capsule only: cylinder total length, or capsule straight-section length (total = height + 2·radius)."),
  source: modelSourceField.optional(),
}).strict();

export type ObjectPatch = Omit<z.infer<typeof objectPatch>, "id">;

// ── Entity construction ───────────────────────────────────────────────────

export function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "object";
}

export function generatedId(name: string): string {
  return `${slug(name)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function entityFrom(input: SceneObjectInput, parentId?: string, fallbackId?: string): SceneEntity {
  const base = {
    id: input.id ?? fallbackId ?? generatedId(input.name),
    name: input.name,
    visible: input.visible,
    ...(parentId ? { parentId } : {}),
    transform: {
      position: input.position,
      quaternionXyzw: quaternionFromEulerDegrees(input.rotationDegrees),
      scale: input.scale,
    },
  };
  switch (input.kind) {
    case "box":
      return { ...base, kind: input.kind, size: input.size, material: { color: input.color.toLowerCase(), opacity: input.opacity } };
    case "sphere":
      return { ...base, kind: input.kind, radius: input.radius, material: { color: input.color.toLowerCase(), opacity: input.opacity } };
    case "cylinder":
    case "capsule":
      return {
        ...base,
        kind: input.kind,
        radius: input.radius,
        height: input.height,
        material: { color: input.color.toLowerCase(), opacity: input.opacity },
      };
    case "model":
      return { ...base, kind: input.kind, source: input.source };
    case "label":
      return {
        ...base,
        kind: input.kind,
        text: input.text,
        color: input.color.toLowerCase(),
        backgroundColor: input.backgroundColor.toLowerCase(),
        size: input.size,
      };
  }
}

export function linkedCollisionFor(entity: SceneEntity): SceneCollisionBox {
  if (entity.kind !== "box") {
    throw new Error(`collision: true is supported only for box objects; "${entity.id}" is a ${entity.kind}.`);
  }
  return {
    id: `${entity.id}:collision`,
    name: `${entity.name} collision`,
    kind: "entity-box",
    entityId: entity.id,
  };
}

/** Throws when a parent id cannot hold `childId` (missing, not a group, or a cycle). */
export function assertValidParent(entities: readonly SceneEntity[], childId: string, parentId: string): void {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const parent = byId.get(parentId);
  if (!parent) throw new Error(`Parent group does not exist: ${parentId}`);
  if (parent.kind !== "group") {
    throw new Error(`Parent "${parentId}" is a ${parent.kind}; only group entities can have children.`);
  }
  for (let current: SceneEntity | undefined = parent; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
    if (current.id === childId) throw new Error(`Cannot parent "${childId}" under its own descendant "${parentId}".`);
  }
}

// ── scene_update_object ───────────────────────────────────────────────────

const COMMON_PATCH_FIELDS = [
  "name", "visible", "parentId", "keepWorldTransform", "position", "rotationDegrees", "scale",
] as const;
const KIND_PATCH_FIELDS: Readonly<Record<SceneEntityKind, readonly string[]>> = {
  box: ["color", "opacity", "size"],
  sphere: ["color", "opacity", "radius"],
  cylinder: ["color", "opacity", "radius", "height"],
  capsule: ["color", "opacity", "radius", "height"],
  model: ["source"],
  label: ["text", "color", "backgroundColor", "size"],
  group: [],
  procedural: [],
};

/**
 * Applies a patch to a copy of the stored entity. Rejects fields the entity's
 * kind cannot take instead of silently ignoring them.
 */
export function patchEntity(entities: readonly SceneEntity[], id: string, patch: ObjectPatch): SceneEntity {
  const existing = entities.find((entity) => entity.id === id);
  if (!existing) throw new Error(`Scene object does not exist: ${id}`);
  const provided = Object.entries(patch).filter(([, value]) => value !== undefined).map(([key]) => key);
  if (provided.length === 0) throw new Error("Provide at least one field to update.");
  const allowed = new Set<string>([...COMMON_PATCH_FIELDS, ...KIND_PATCH_FIELDS[existing.kind]]);
  const rejected = provided.filter((key) => !allowed.has(key));
  if (rejected.length > 0) {
    throw new Error(
      `Cannot set ${rejected.join(", ")} on ${existing.kind} "${id}". A ${existing.kind} accepts: ${[...allowed].join(", ")}.`,
    );
  }
  if (patch.keepWorldTransform) {
    if (patch.parentId === undefined) throw new Error("keepWorldTransform requires parentId (a group id, or null for top level).");
    if (patch.position || patch.rotationDegrees || patch.scale) {
      throw new Error("keepWorldTransform cannot be combined with position, rotationDegrees, or scale.");
    }
  }
  if (typeof patch.parentId === "string") assertValidParent(entities, id, patch.parentId);

  const entity: SceneEntity = structuredClone(existing);
  if (patch.name !== undefined) entity.name = patch.name;
  if (patch.visible !== undefined) entity.visible = patch.visible;
  if (patch.parentId !== undefined) {
    const parentId = patch.parentId ?? undefined;
    if (patch.keepWorldTransform) entity.transform = localTransformKeepingWorld(entities, id, parentId);
    if (parentId) entity.parentId = parentId;
    else delete entity.parentId;
  }
  entity.transform = {
    position: patch.position ?? entity.transform.position,
    quaternionXyzw: patch.rotationDegrees === undefined
      ? entity.transform.quaternionXyzw
      : quaternionFromEulerDegrees(patch.rotationDegrees),
    scale: patch.scale ?? entity.transform.scale,
  };
  switch (entity.kind) {
    case "box":
      if (patch.size !== undefined) {
        if (!Array.isArray(patch.size)) throw new Error(`Box size must be [x, y, z] edge lengths in metres, not a single number.`);
        entity.size = patch.size;
      }
      break;
    case "sphere":
      if (patch.radius !== undefined) entity.radius = patch.radius;
      break;
    case "cylinder":
    case "capsule":
      if (patch.radius !== undefined) entity.radius = patch.radius;
      if (patch.height !== undefined) entity.height = patch.height;
      break;
    case "model":
      if (patch.source !== undefined) entity.source = patch.source;
      break;
    case "label":
      if (patch.size !== undefined) {
        if (typeof patch.size !== "number") throw new Error("Label size is one number: the text height in metres.");
        entity.size = patch.size;
      }
      if (patch.text !== undefined) entity.text = patch.text;
      if (patch.color !== undefined) entity.color = patch.color.toLowerCase();
      if (patch.backgroundColor !== undefined) entity.backgroundColor = patch.backgroundColor.toLowerCase();
      break;
    case "group":
    case "procedural":
      break;
  }
  if ("material" in entity) {
    entity.material = {
      ...entity.material,
      color: patch.color?.toLowerCase() ?? entity.material.color,
      opacity: patch.opacity ?? entity.material.opacity,
    };
  }
  return entity;
}

// ── scene_create_assembly ─────────────────────────────────────────────────

export interface AssemblyInput {
  name: string;
  position: Vec3;
  rotationDegrees: Vec3;
  scale: Vec3;
  visible: boolean;
  objects: readonly SceneObjectInput[];
}

export interface AssemblyPlan {
  group: SceneEntity;
  children: SceneEntity[];
  /** Previous descendants of the group that are no longer listed (cascade included). */
  removedIds: string[];
  commands: StudioCommand[];
}

function descendantIds(entities: readonly SceneEntity[], rootId: string): Set<string> {
  const ids = new Set<string>();
  let frontier = new Set([rootId]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const entity of entities) {
      if (entity.parentId && frontier.has(entity.parentId) && !ids.has(entity.id)) {
        ids.add(entity.id);
        next.add(entity.id);
      }
    }
    frontier = next;
  }
  return ids;
}

/**
 * Builds the commands that make `groupId` hold exactly the listed children:
 * stale descendants are removed first, then the group and children are upserted.
 */
export function planAssembly(document: StudioDocument, groupId: string, input: AssemblyInput): AssemblyPlan {
  const existing = document.entities.find(({ id }) => id === groupId);
  if (existing && existing.kind !== "group") {
    throw new Error(`Assembly id "${groupId}" already belongs to a ${existing.kind}; choose another id.`);
  }
  const group: SceneEntity = {
    id: groupId,
    name: input.name,
    kind: "group",
    visible: input.visible,
    ...(existing?.parentId ? { parentId: existing.parentId } : {}),
    transform: {
      position: input.position,
      quaternionXyzw: quaternionFromEulerDegrees(input.rotationDegrees),
      scale: input.scale,
    },
  };
  const children = input.objects.map((object, index) => entityFrom(
    object,
    groupId,
    `${groupId}-${slug(object.name)}-${index + 1}`,
  ));
  const listedIds = new Set(children.map(({ id }) => id));
  if (listedIds.size !== children.length || listedIds.has(groupId)) {
    throw new Error("Assembly object ids must be unique and differ from the group id.");
  }

  const previous = existing ? descendantIds(document.entities, groupId) : new Set<string>();
  const stale = new Set([...previous].filter((id) => !listedIds.has(id)));
  const byId = new Map(document.entities.map((entity) => [entity.id, entity]));
  const removedIds = new Set<string>();
  const commands: StudioCommand[] = [];
  for (const id of stale) {
    const parentId = byId.get(id)?.parentId;
    if (parentId && stale.has(parentId)) continue;
    commands.push({ type: "entity.remove", id });
    removedIds.add(id);
    for (const descendant of descendantIds(document.entities, id)) removedIds.add(descendant);
  }
  commands.push({ type: "entity.upsert", entity: group });
  for (const child of children) commands.push({ type: "entity.upsert", entity: child });

  const collisionIds = new Set(document.collisions.map(({ id }) => id));
  input.objects.forEach((object, index) => {
    const child = children[index];
    if (object.collision) {
      commands.push({ type: "collision.upsert", collision: linkedCollisionFor(child) });
    } else if (collisionIds.has(`${child.id}:collision`)) {
      commands.push({ type: "collision.remove", id: `${child.id}:collision` });
    }
  });
  if (input.objects.some(({ collision }) => collision) && !document.layers.collisions) {
    commands.push({ type: "layer.visibility.set", layer: "collisions", visible: true });
  }
  return { group, children, removedIds: [...removedIds], commands };
}

// ── Overlays ──────────────────────────────────────────────────────────────

/** Bounds whose `expiresAt` has not passed (bounds without expiry are permanent). */
export function activeBounds(bounds: readonly SceneBounds[], now = Date.now()): SceneBounds[] {
  return bounds.filter(({ expiresAt }) => expiresAt === undefined || Date.parse(expiresAt) > now);
}

/**
 * Replaces only the overlays in `namespace`, keeping other tools' unexpired
 * overlays, so tools never clear each other's bounds.
 */
export function mergeOverlayBounds(
  current: readonly SceneBounds[],
  namespace: string,
  replacements: readonly SceneBounds[],
  now = Date.now(),
): SceneBounds[] {
  const foreign = replacements.find(({ id }) => !id.startsWith(namespace));
  if (foreign) throw new Error(`Overlay id "${foreign.id}" is outside namespace "${namespace}".`);
  return [
    ...activeBounds(current, now).filter(({ id }) => !id.startsWith(namespace)),
    ...replacements,
  ];
}

// ── Results ───────────────────────────────────────────────────────────────

export function assertCommandBudget(commands: readonly StudioCommand[], what: string): void {
  if (commands.length > MAX_COMMANDS_PER_CALL) {
    throw new Error(
      `${what} needs ${commands.length} scene commands, but the Studio applies at most ${MAX_COMMANDS_PER_CALL} per call. Split it into smaller calls.`,
    );
  }
}

/**
 * Entities as agents should read them: stored fields (texture bytes elided)
 * plus Euler rotation, world pose, local/world size and effective visibility.
 */
export function inspectEntities(entities: readonly SceneEntity[], selected: readonly SceneEntity[] = entities) {
  const poses = entityWorldPoses(entities);
  return selected.map((entity) => {
    const pose = poses.get(entity.id)!;
    if (!("material" in entity) || !entity.material.texture) return { ...entity, ...pose };
    const { dataUrl, ...texture } = entity.material.texture;
    const encodedBytes = Math.floor((dataUrl.length - "data:image/png;base64,".length) * 0.75);
    return {
      ...entity,
      material: { ...entity.material, texture: { ...texture, encodedBytes } },
      ...pose,
    };
  });
}

/** Inspected form of the stored entities with the given ids, in that order. */
export function storedEntities(document: StudioDocument, ids: readonly string[]) {
  const byId = new Map(document.entities.map((entity) => [entity.id, entity]));
  return inspectEntities(
    document.entities,
    ids.flatMap((id) => byId.get(id) ?? []),
  );
}
