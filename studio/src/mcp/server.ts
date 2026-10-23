import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Matrix4, Quaternion, Vector3 } from "three";

import type { SceneCommandResult, SceneSnapshot, SceneViewerStatus } from "../api/scene-control-contract";
import { isCatalogAssetShown } from "../domain/sceneRules";
import type { SceneBounds, SceneCollisionBox, SceneEntity, Vec3 } from "../domain/types";
import { MAX_VOXEL_OVERLAY_CELLS, encodeOccupancy, occupancyRuns } from "../domain/voxels";
import {
  analyzeSplatBox,
  bakeSplatBoxTexture,
  boxEntityForUpdate,
  boxQueryForEntity,
  loadCatalogSplat,
} from "../splat/analysis";
import { voxelizeSplatBox } from "../splat/voxel-grid";
import { VIEWPORT_PRESET_DIRECTIONS, hemisphereDirections, visibleGaussians } from "../splat/visibility";
import type { StudioCommand } from "../state/commands";
import { assertModelSourceExists, readCatalog } from "./assetFiles";
import { SceneApiClient } from "./sceneClient";
import { localSceneServerStarter } from "./sceneServerLauncher";
import { entityWorldPoses, eulerDegreesFromQuaternion, quaternionFromEulerDegrees } from "./sceneMath";
import {
  CONVENTIONS,
  FIT_OVERLAY_COLOR,
  MAX_COMMANDS_PER_CALL,
  MAX_SPLAT_ENTITY_IDS,
  OVERLAY_NAMESPACES,
  VOXEL_CELL_COLOR,
  VOXEL_SEARCH_COLOR,
  activeBounds,
  assertCommandBudget,
  assertValidParent,
  entityFrom,
  generatedId,
  identifier,
  inspectEntities,
  linkedCollisionFor,
  mergeOverlayBounds,
  objectPatch,
  patchEntity,
  planAssembly,
  positionField,
  rotationField,
  scaleField,
  sceneObject,
  storedEntities,
  vec3,
  type SceneObjectInput,
} from "./sceneTools";

const INSTRUCTIONS = `Edit and inspect the live Asset Studio scene. Every change is stored by the scene server and shown in any open Studio browser within about 1 s.

Units and frames: metres, +Z up. rotationDegrees is a Three.js intrinsic XYZ Euler in degrees, R = Rx·Ry·Rz (rotate about X, then the new Y, then the new Z). Quaternions are [x, y, z, w]. scene_inspect returns each entity's local rotationDegrees plus worldPosition, worldQuaternionXyzw, worldRotationDegrees, worldScale, localSize and worldSize.

Hierarchy: only group entities can be parents. A child's position/rotationDegrees/scale are local to its parent group (the parent's transform, including scale, applies on top). Use scene_create_assembly for furniture and other multi-part objects; re-running it with the same id replaces the group's children exactly.

Geometry: box, sphere, cylinder and capsule positions are the geometric centre. Cylinders and capsules run along local +Z; capsule height excludes the end caps, so total length = height + 2·radius. Labels are camera-facing sprites: rotation is ignored, size is text height in metres, and only about 17 characters fit. Model GLB source URLs are rooted at repo assets/ (e.g. /fr10/browser/fr10_home.glb), must exist, and must be authored Z-up (no Y-up conversion is applied).

Layers: catalogVisuals = the selected asset's source Gaussian splat. assetVisuals = the 3D asset layer: the packaged catalog GLB plus all semantic entities. collisions = collider boxes. reference = reference files added in the browser. measurements = measurement lines and the temporary overlays.

Catalog GLB rule: the packaged catalog GLB is shown only while no entity is effectively visible (the entity and all its ancestors visible). Adding any visible entity hides it; hiding or clearing all entities brings it back. scene_inspect reports this as catalogAssetShown.

Colliders: authored colliders replace the package-manifest colliders in the viewport; with none authored, the manifest colliders are shown. A collider linked to a box entity (kind entity-box) follows that box and still resolves when the box or an ancestor is hidden. Removing an entity removes its linked colliders. Collision tools turn on the collisions layer.

Splat source: splat tools read the SPZ named in assets/catalog.json for the selected asset (document.assetId). The source splat is first rotated by an implicit Rx(180°), then browser.spz.transform is applied. Splat tools ignore references added in the browser. Local reference files (splats, meshes, point clouds) can only be added in the browser UI, not through these tools.

Overlays: overlays are temporary wireframes drawn only for the user; you never see the viewport. Each tool replaces only its own overlays (scene_fit_splat_bounds uses ids starting with "splat-bound:", scene_inspect_splat_voxels uses "voxel-query:"). scene_clear_splat_bounds clears all of them. Expired overlays are omitted from scene_inspect.

Results: each mutating result reports changed (false means nothing in the scene changed and the revision did not move), the stored entities it touched, and viewer: connected (a Studio browser polled in the last 5 s) and renderErrors (that browser's latest load failures, which may lag a new change by about 1 s; re-run scene_inspect to confirm a new GLB loaded). One call applies at most ${MAX_COMMANDS_PER_CALL} scene commands atomically.

Scene API: these tools talk to the scene API at http://127.0.0.1:4174. If it is not running, the first tool call starts it (detached, log in .asset-studio/scene-server.log) and continues; an already running API is reused. It does not start the browser editor: viewer.connected stays false until someone opens http://127.0.0.1:4173 (bun run dev).

Build: scene_build_target exports only the selected asset package's own manifest. Entities, colliders, textures and measurements authored here are NOT exported.`;

const sceneUrl = new URL(process.env.SCENE_STUDIO_URL?.trim() || "http://127.0.0.1:4174");
const client = new SceneApiClient(sceneUrl.href, { startServer: localSceneServerStarter(sceneUrl.origin) });
const server = new McpServer(
  { name: "asset-studio-scene", version: "2.0.0" },
  { instructions: INSTRUCTIONS, maxToolInputElements: 3000 },
);

const nameField = z.string().trim().min(1).max(256);
const entityIdsField = z.array(identifier).min(1).max(MAX_SPLAT_ENTITY_IDS).describe(
  `Ids of existing box entities (at most ${MAX_SPLAT_ENTITY_IDS}: one call writes one update per box plus an overlay and a layer command, within the Studio's ${MAX_COMMANDS_PER_CALL}-command batch limit).`,
);
const paddingField = z.number().positive().max(1).default(0.02).describe(
  "Extra margin in metres added around each box when collecting nearby Gaussians, so slightly misplaced boxes still see their surfaces. Default 0.02.",
);
const opacityThresholdField = z.number().min(0).max(1).default(0.1).describe(
  "Ignore Gaussians whose opacity is below this value (0-1); filters faint floaters. Default 0.1.",
);
const lowerQuantileField = z.number().min(0).max(0.49).default(0.03).describe(
  "Lower percentile (0-0.49) of Gaussian centres along each axis taken as the near edge; trims outliers. Must be below upperQuantile. Default 0.03.",
);
const upperQuantileField = z.number().min(0.51).max(1).default(0.97).describe(
  "Upper percentile (0.51-1) of Gaussian centres along each axis taken as the far edge. Default 0.97.",
);
const maxSamplesField = z.number().int().min(100).max(250_000).default(50_000).describe(
  "Maximum Gaussians sampled per box (deterministic reservoir); higher is slower but steadier. Default 50000.",
);
const minimumSupportField = z.number().int().min(1).max(100_000).default(100).describe(
  "Minimum number of supporting Gaussians required before a result is applied; weaker results are reported but not applied. Default 100.",
);
const surfaceBandField = z.number().positive().max(0.5).default(0.018).describe(
  "Thickness in metres of the shell just inside/outside each box face whose Gaussians contribute colour. Default 0.018.",
);

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function viewerReport(viewer: SceneViewerStatus) {
  if (!viewer.connected) {
    return {
      ...viewer,
      note: "No Studio browser polled in the last 5 s, so nobody sees this change yet. It is stored and appears when the Studio page is opened.",
    };
  }
  if (viewer.renderErrors.length > 0) {
    return {
      ...viewer,
      note: "The browser reports these current load/render failures (its latest report, which may predate this change by about 1 s).",
    };
  }
  return viewer;
}

function mutationResult(action: string, after: SceneCommandResult, extra: Record<string, unknown> = {}) {
  return textResult({
    ok: true,
    action,
    changed: after.changed,
    revision: after.revision,
    ...extra,
    catalogAssetShown: isCatalogAssetShown(after.document),
    viewer: viewerReport(after.viewer),
  });
}

/**
 * Builds commands from the freshest snapshot (rebuilt on revision conflicts)
 * and returns the result computed by the final build.
 */
async function mutateWith<T>(
  what: string,
  build: (snapshot: SceneSnapshot) => Promise<{ commands: StudioCommand[]; result: T }> | { commands: StudioCommand[]; result: T },
): Promise<{ before: SceneSnapshot; after: SceneCommandResult; result: T }> {
  let latest = null as { result: T } | null;
  const { before, after } = await client.mutate(async (snapshot) => {
    const built = await build(snapshot);
    assertCommandBudget(built.commands, what);
    latest = { result: built.result };
    return built.commands;
  });
  if (!latest) throw new Error(`${what} produced no result.`);
  return { before, after, result: latest.result };
}

async function assertModelSources(objects: readonly SceneObjectInput[]): Promise<void> {
  for (const object of objects) {
    if (object.kind === "model") await assertModelSourceExists(object.source);
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function worldScaleOf(matrix: Matrix4): Vec3 {
  const scale = new Vector3().setFromMatrixScale(matrix);
  return [scale.x, scale.y, scale.z];
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

// ── Inspection ────────────────────────────────────────────────────────────

server.registerTool("scene_inspect", {
  title: "Inspect live scene",
  description: "Read the live scene: selected asset, catalogAssetShown, layers, viewport, viewer status, entities (stored fields plus rotationDegrees, worldPosition, worldQuaternionXyzw, worldRotationDegrees, worldScale, localSize, worldSize, effectivelyVisible), colliders, unexpired overlays, measurements and references. localSize/worldSize are extents along the entity's own axes (null for models, groups, procedural entities and labels).",
  inputSchema: z.object({
    query: z.string().trim().optional().describe("Case-insensitive substring matched against ids and names/labels; filters entities, collisions, overlays and measurements. World poses still account for unlisted parents."),
  }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ query }) => {
  const snapshot = await client.snapshot();
  const { document } = snapshot;
  const needle = query?.toLowerCase();
  const matches = (...values: string[]) => !needle || values.some((value) => value.toLowerCase().includes(needle));
  const poses = entityWorldPoses(document.entities);
  const bounds = activeBounds(document.bounds);
  return textResult({
    revision: snapshot.revision,
    persisted: snapshot.persisted,
    asset: { id: document.assetId, version: document.assetVersion },
    catalogAssetShown: isCatalogAssetShown(document),
    layers: document.layers,
    viewport: document.viewport,
    viewer: viewerReport(snapshot.viewer),
    entities: inspectEntities(document.entities, document.entities.filter(({ id, name }) => matches(id, name))),
    collisions: document.collisions
      .filter(({ id, name }) => matches(id, name))
      .map((collision) => collision.kind === "box"
        ? { ...collision, rotationDegrees: eulerDegreesFromQuaternion(collision.quaternionXyzw) }
        : { ...collision, entityEffectivelyVisible: poses.get(collision.entityId)?.effectivelyVisible ?? false }),
    bounds: bounds
      .filter(({ id, label }) => matches(id, label))
      .map(({ voxels, ...overlay }) => ({
        ...overlay,
        rotationDegrees: eulerDegreesFromQuaternion(overlay.quaternionXyzw),
        ...(voxels ? { voxels: { voxelSizeM: voxels.voxelSizeM, dimensions: voxels.dimensions } } : {}),
      })),
    expiredBoundsOmitted: document.bounds.length - bounds.length,
    measurements: document.measurements
      .filter(({ id, label }) => matches(id, label))
      .map((measurement) => ({
        ...measurement,
        lengthM: new Vector3(...measurement.end).distanceTo(new Vector3(...measurement.start)),
      })),
    references: document.references.map(({ objectUrl: _runtimeUrl, ...reference }) => ({
      ...reference,
      rotationDegrees: eulerDegreesFromQuaternion(reference.transform.quaternionXyzw),
    })),
  });
});

server.registerTool("scene_list_assets", {
  title: "List catalog assets",
  description: "List the asset packages in repo assets/catalog.json (id, version, name, description, browser GLB/SPZ URLs, SPZ transform, manifest, simulator outputs, capabilities) and mark the selected one. Use an id with scene_select_asset.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const [catalog, snapshot] = await Promise.all([readCatalog(), client.snapshot()]);
  return textResult({
    selected: { id: snapshot.document.assetId, version: snapshot.document.assetVersion },
    assets: catalog.map((entry) => ({
      ...entry,
      selected: entry.id === snapshot.document.assetId && entry.version === snapshot.document.assetVersion,
    })),
  });
});

// ── Asset and scene state ─────────────────────────────────────────────────

server.registerTool("scene_select_asset", {
  title: "Select catalog asset",
  description: "Switch the scene to another catalog asset package. This changes the source splat (catalogVisuals), the packaged GLB, the splat used by all splat tools, the manifest colliders, and the package scene_build_target exports. Entities, authored colliders, measurements and references are kept.",
  inputSchema: z.object({
    assetId: z.string().trim().min(1).describe("Catalog asset id, from scene_list_assets (e.g. reception-room)."),
    version: z.string().trim().min(1).optional().describe("Catalog version. Omit to use the catalog's version for that id."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ assetId, version }) => {
  const catalog = await readCatalog();
  const entry = catalog.find((candidate) => candidate.id === assetId && (version === undefined || candidate.version === version));
  if (!entry) {
    throw new Error(`No catalog asset ${assetId}${version ? `@${version}` : ""}. Available: ${catalog.map(({ id, version: v }) => `${id}@${v}`).join(", ")}.`);
  }
  const { after } = await mutateWith("Asset selection", () => ({
    commands: [{ type: "asset.select", assetId: entry.id, assetVersion: entry.version }],
    result: undefined,
  }));
  return mutationResult("asset-selected", after, { asset: { id: entry.id, version: entry.version, name: entry.name } });
});

server.registerTool("scene_reset", {
  title: "Reset scene",
  description: "Replace the whole scene document with the default: welding-cell asset, no entities, authored colliders, overlays, measurements or references, default layers (collisions layer off) and perspective view. The reset is persisted and the open browser adopts it.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  const { after } = await mutateWith("Scene reset", () => ({ commands: [{ type: "reset" }], result: undefined }));
  return mutationResult("scene-reset", after, { asset: { id: after.document.assetId, version: after.document.assetVersion } });
});

// ── Entities ──────────────────────────────────────────────────────────────

server.registerTool("scene_add_object", {
  title: "Add scene object",
  description: "Add, or replace by id, one box, sphere, cylinder, capsule, GLB model, or label. Box/sphere/cylinder/capsule positions are geometric centres; cylinders and capsules run along local +Z; capsule total length = height + 2·radius. Labels are camera-facing sprites (rotation ignored, size = text height). Adding a visible entity hides the packaged catalog GLB. Returns the stored entity with its world pose.",
  inputSchema: z.object({
    parentId: identifier.optional().describe(CONVENTIONS.parentId),
    object: sceneObject.describe("The object to add. kind selects which fields apply."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ parentId, object }) => {
  await assertModelSources([object]);
  const entity = entityFrom(object, parentId);
  const { after, result: replaced } = await mutateWith("Adding the object", ({ document }) => {
    if (parentId) assertValidParent(document.entities, entity.id, parentId);
    const commands: StudioCommand[] = [{ type: "entity.upsert", entity }];
    if (object.collision) {
      commands.push({ type: "collision.upsert", collision: linkedCollisionFor(entity) });
      if (!document.layers.collisions) commands.push({ type: "layer.visibility.set", layer: "collisions", visible: true });
    }
    return { commands, result: document.entities.some(({ id }) => id === entity.id) };
  });
  return mutationResult(replaced ? "replaced" : "added", after, {
    entities: storedEntities(after.document, [entity.id]),
    ...(object.collision ? { collisionId: `${entity.id}:collision` } : {}),
  });
});

server.registerTool("scene_create_assembly", {
  title: "Create object assembly",
  description: `Create or replace a named group and its child objects atomically; use it for furniture, fixtures, machines and other multi-part assets. Child positions/rotations/scales are local to the group. Re-running with an existing group id makes the group hold exactly the listed objects: descendants that are no longer listed are removed (with their linked colliders). The group, children, removed stale descendants, collider commands and the collisions-layer command together must fit in ${MAX_COMMANDS_PER_CALL} commands. Returns the stored group and children with their world poses.`,
  inputSchema: z.object({
    id: identifier.optional().describe("Group id. Reuse an existing group id to replace that assembly; omit to generate one. Children without an id get '<groupId>-<slug(name)>-<index>'."),
    name: nameField.describe("Group display name."),
    position: positionField,
    rotationDegrees: rotationField,
    scale: scaleField,
    visible: z.boolean().default(true).describe("Show or hide the whole group. Default true."),
    objects: z.array(sceneObject).min(1).max(MAX_COMMANDS_PER_CALL - 1).describe(`Child objects (at most ${MAX_COMMANDS_PER_CALL - 1}, since the group itself is one command), each in the group's local frame.`),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  await assertModelSources(input.objects);
  const groupId = input.id ?? generatedId(input.name);
  const { after, result: plan } = await mutateWith("This assembly", ({ document }) => {
    const plan = planAssembly(document, groupId, input);
    return { commands: plan.commands, result: plan };
  });
  return mutationResult("assembly-created", after, {
    groupId,
    entities: storedEntities(after.document, [plan.group.id, ...plan.children.map(({ id }) => id)]),
    removedStaleIds: plan.removedIds,
  });
});

server.registerTool("scene_update_object", {
  title: "Update scene object",
  description: "Patch an existing object without resending it. Only fields valid for the object's kind are accepted; any other field is rejected with an error listing the valid ones (box: color, opacity, size[3]; sphere: color, opacity, radius; cylinder/capsule: color, opacity, radius, height; model: source; label: text, color, backgroundColor, size (number); group/procedural: none). All kinds take name, visible, parentId, keepWorldTransform, position, rotationDegrees, scale.",
  inputSchema: objectPatch,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ id, ...patch }) => {
  if (patch.source !== undefined) await assertModelSourceExists(patch.source);
  const { after } = await mutateWith("Updating the object", ({ document }) => ({
    commands: [{ type: "entity.upsert", entity: patchEntity(document.entities, id, patch) }],
    result: undefined,
  }));
  return mutationResult("updated", after, { entities: storedEntities(after.document, [id]) });
});

server.registerTool("scene_remove_object", {
  title: "Remove scene object",
  description: "Remove one entity by id, together with all its descendants and every collider linked to any of them. Fails if the id does not exist.",
  inputSchema: z.object({ id: identifier.describe("Id of the entity to remove.") }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ id }) => {
  const { before, after } = await mutateWith("Removing the object", ({ document }) => {
    if (!document.entities.some((entity) => entity.id === id)) throw new Error(`Scene object does not exist: ${id}`);
    return { commands: [{ type: "entity.remove", id }], result: undefined };
  });
  const remaining = new Set(after.document.entities.map((entity) => entity.id));
  const remainingCollisions = new Set(after.document.collisions.map((collision) => collision.id));
  return mutationResult("removed", after, {
    removedEntityIds: before.document.entities.filter((entity) => !remaining.has(entity.id)).map((entity) => entity.id),
    removedCollisionIds: before.document.collisions.filter((collision) => !remainingCollisions.has(collision.id)).map((collision) => collision.id),
  });
});

server.registerTool("scene_clear_objects", {
  title: "Clear semantic objects",
  description: `Remove every entity (all descendants and their linked colliders included). Keeps the selected asset, explicit (non-linked) colliders, overlays, measurements, references and layer visibility. With no entities left the packaged catalog GLB is shown again. Large scenes are cleared in several atomic batches of up to ${MAX_COMMANDS_PER_CALL} top-level objects.`,
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  const removedTopLevelIds: string[] = [];
  let removedEntityCount = 0;
  let changed = false;
  let after: SceneCommandResult;
  let batch: string[];
  do {
    let before: SceneSnapshot;
    ({ before, after, result: batch } = await mutateWith("Clearing objects", ({ document }) => {
      const ids = document.entities
        .filter(({ parentId }) => parentId === undefined)
        .slice(0, MAX_COMMANDS_PER_CALL)
        .map(({ id }) => id);
      return { commands: ids.map((id) => ({ type: "entity.remove" as const, id })), result: ids };
    }));
    changed ||= after.changed;
    removedTopLevelIds.push(...batch);
    removedEntityCount += before.document.entities.length - after.document.entities.length;
  } while (batch.length > 0);
  return mutationResult("cleared", { ...after, changed }, { removedTopLevelIds, removedEntityCount });
});

// ── Splat analysis ────────────────────────────────────────────────────────

server.registerTool("scene_measure_splat_piece", {
  title: "Estimate piece thickness from splat",
  description: "Read-only. Estimate robust edges and thickness along one axis of each box from nearby source-splat Gaussian centres. Axes are the box's own local axes. Thickness values ending in M are world metres; *LocalSize values are in the box's unscaled local units (what scene_update_object size takes). Returns support and confidence.",
  inputSchema: z.object({
    entityIds: entityIdsField,
    paddingM: paddingField,
    opacityThreshold: opacityThresholdField,
    axis: z.enum(["x", "y", "z", "shortest"]).default("shortest").describe("Box-local axis to measure, or 'shortest' for the box's currently thinnest world dimension. Default shortest."),
    lowerQuantile: lowerQuantileField,
    upperQuantile: upperQuantileField,
    maxSamples: maxSamplesField,
  }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ entityIds, axis, lowerQuantile, upperQuantile, paddingM, opacityThreshold, maxSamples }) => {
  if (lowerQuantile >= upperQuantile) throw new Error("lowerQuantile must be less than upperQuantile.");
  const snapshot = await client.snapshot();
  const cloud = await loadCatalogSplat(snapshot.document.assetId, snapshot.document.assetVersion);
  const measurements = entityIds.map((entityId) => {
    const query = boxQueryForEntity(snapshot.document.entities, entityId);
    const analysis = analyzeSplatBox(cloud, query, { lowerQuantile, upperQuantile, paddingM, opacityThreshold, maxSamples });
    const current = analysis.currentSizeM;
    const index: 0 | 1 | 2 = axis !== "shortest"
      ? AXIS_INDEX[axis]
      : current[1] < current[0] && current[1] <= current[2] ? 1 : current[2] < current[0] ? 2 : 0;
    const worldScale = worldScaleOf(query.worldMatrix)[index];
    return {
      entityId: analysis.id,
      name: analysis.name,
      axis: (["x", "y", "z"] as const)[index],
      currentThicknessM: current[index],
      currentLocalSize: query.size[index],
      estimatedThicknessM: analysis.estimatedSizeM[index],
      estimatedLocalSize: analysis.estimatedSizeM[index] / worldScale,
      lowerEdgeOffsetM: analysis.lowerEdgeOffsetM[index],
      upperEdgeOffsetM: analysis.upperEdgeOffsetM[index],
      estimatedCenterOffsetM: analysis.estimatedCenterOffsetM[index],
      supportCount: analysis.supportCount,
      retainedSamples: analysis.retainedSamples,
      confidence: analysis.confidence,
    };
  });
  const supported = measurements.filter(({ estimatedThicknessM }) => estimatedThicknessM > 0);
  return textResult({
    ok: true,
    asset: { id: snapshot.document.assetId, version: snapshot.document.assetVersion },
    sourcePointCount: cloud.pointCount,
    method: `opacity-filtered Gaussian centres; ${(lowerQuantile * 100).toFixed(1)}-${(upperQuantile * 100).toFixed(1)} percentile edges`,
    measurements,
    aggregateEstimatedThicknessM: median(supported.map(({ estimatedThicknessM }) => estimatedThicknessM)),
    aggregateEstimatedCenterOffsetM: median(supported.map(({ estimatedCenterOffsetM }) => estimatedCenterOffsetM)),
  });
});

server.registerTool("scene_fit_splat_bounds", {
  title: "Fit boxes to splat bounds",
  description: `Fit existing boxes to robust bounds of nearby source-splat Gaussians along the selected box-local axes, and draw a ${FIT_OVERLAY_COLOR} wireframe overlay of each supported fit for 10 s. Overlays replace only previous fit overlays ("splat-bound:" ids). Results give sizes both as world metres (*WorldSizeM) and as unscaled local size (*LocalSize, the value stored in entity.size). shared mode applies one median size and centre offset to all boxes (for repeated pieces). apply:false leaves every entity unchanged, but still publishes the fit overlays and turns on the measurements layer, so the revision still advances.`,
  inputSchema: z.object({
    entityIds: entityIdsField,
    paddingM: paddingField,
    opacityThreshold: opacityThresholdField,
    axes: z.array(z.enum(["x", "y", "z"])).min(1).max(3).default(["x", "y", "z"]).describe("Box-local axes to fit; other axes keep their size and centre. Default all three."),
    lowerQuantile: lowerQuantileField,
    upperQuantile: upperQuantileField,
    maxSamples: maxSamplesField,
    minimumSupport: minimumSupportField,
    shared: z.boolean().default(false).describe("Use the median fitted size and centre offset of all supported boxes for every box, e.g. for identical legs. Default false."),
    apply: z.boolean().default(true).describe("Write fitted size/position into the boxes. false = preview only (overlays and measurements layer still change). Default true."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ entityIds, axes, lowerQuantile, upperQuantile, paddingM, opacityThreshold, maxSamples, minimumSupport, shared, apply }) => {
  if (new Set(axes).size !== axes.length) throw new Error("Splat fit axes must be unique.");
  if (lowerQuantile >= upperQuantile) throw new Error("lowerQuantile must be less than upperQuantile.");
  const axisIndices = axes.map((axis) => ({ axis, index: AXIS_INDEX[axis] }));
  const { after, result } = await mutateWith("This fit", async ({ document }) => {
    const cloud = await loadCatalogSplat(document.assetId, document.assetVersion);
    const fits = entityIds.map((entityId) => {
      const query = boxQueryForEntity(document.entities, entityId);
      return {
        entity: boxEntityForUpdate(document.entities, entityId),
        query,
        analysis: analyzeSplatBox(cloud, query, { lowerQuantile, upperQuantile, paddingM, opacityThreshold, maxSamples }),
      };
    });
    const supportedFits = fits.filter(({ analysis }) => analysis.supportCount >= minimumSupport);
    const sharedSizes = axisIndices.map(({ index }) => median(supportedFits.map(({ analysis }) => analysis.estimatedSizeM[index])));
    const sharedOffsets = axisIndices.map(({ index }) => median(supportedFits.map(({ analysis }) => analysis.estimatedCenterOffsetM[index])));
    const updated: SceneEntity[] = [];
    const overlays: SceneBounds[] = [];
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const results = fits.map(({ entity, query, analysis }) => {
      const supported = analysis.supportCount >= minimumSupport
        && axisIndices.every(({ index }) => analysis.estimatedSizeM[index] > 0);
      const scales = worldScaleOf(query.worldMatrix);
      const currentLocalSize = entity.size;
      const localCenterOffset = new Vector3();
      const size: [number, number, number] = [...entity.size];
      axisIndices.forEach(({ index }, selectedIndex) => {
        const physicalSize = shared ? sharedSizes[selectedIndex] : analysis.estimatedSizeM[index];
        const physicalOffset = shared ? sharedOffsets[selectedIndex] : analysis.estimatedCenterOffsetM[index];
        size[index] = physicalSize / scales[index];
        localCenterOffset.setComponent(index, physicalOffset / scales[index]);
      });
      if (supported) {
        const previewMatrix = query.worldMatrix.clone().multiply(
          new Matrix4().makeTranslation(localCenterOffset.x, localCenterOffset.y, localCenterOffset.z),
        );
        const previewPosition = new Vector3();
        const previewQuaternion = new Quaternion();
        const previewScale = new Vector3();
        previewMatrix.decompose(previewPosition, previewQuaternion, previewScale);
        overlays.push({
          id: `${OVERLAY_NAMESPACES.fit}${entity.id}`,
          label: `Splat fit · ${entity.name}`,
          color: FIT_OVERLAY_COLOR,
          position: [previewPosition.x, previewPosition.y, previewPosition.z],
          quaternionXyzw: [previewQuaternion.x, previewQuaternion.y, previewQuaternion.z, previewQuaternion.w],
          size: [
            size[0] * Math.abs(previewScale.x),
            size[1] * Math.abs(previewScale.y),
            size[2] * Math.abs(previewScale.z),
          ],
          expiresAt,
        });
      }
      if (apply && supported) {
        const parentOffset = localCenterOffset.clone()
          .multiply(new Vector3(...entity.transform.scale))
          .applyQuaternion(new Quaternion(...entity.transform.quaternionXyzw).normalize());
        updated.push({
          ...entity,
          size,
          transform: {
            ...entity.transform,
            position: [
              entity.transform.position[0] + parentOffset.x,
              entity.transform.position[1] + parentOffset.y,
              entity.transform.position[2] + parentOffset.z,
            ],
          },
        });
      }
      return {
        entityId: entity.id,
        name: entity.name,
        supportCount: analysis.supportCount,
        confidence: analysis.confidence,
        currentLocalSize,
        currentWorldSizeM: analysis.currentSizeM,
        measuredWorldSizeM: analysis.estimatedSizeM,
        fittedLocalSize: size,
        fittedWorldSizeM: [size[0] * scales[0], size[1] * scales[1], size[2] * scales[2]],
        centerOffsetAlongBoxAxesM: analysis.estimatedCenterOffsetM,
        applied: apply && supported,
        overlayDrawn: supported,
      };
    });
    const commands: StudioCommand[] = updated.map((entity) => ({ type: "entity.upsert", entity }));
    commands.push({ type: "bounds.set", bounds: mergeOverlayBounds(document.bounds, OVERLAY_NAMESPACES.fit, overlays) });
    if (!document.layers.measurements) commands.push({ type: "layer.visibility.set", layer: "measurements", visible: true });
    return {
      commands,
      result: {
        sourcePointCount: cloud.pointCount,
        sharedSizeM: shared ? Object.fromEntries(axisIndices.map(({ axis }, index) => [axis, sharedSizes[index]])) : null,
        overlayCount: overlays.length,
        results,
        updatedIds: updated.map(({ id }) => id),
      },
    };
  });
  return mutationResult(apply ? "splat-bounds-fitted" : "splat-bounds-previewed", after, {
    method: `local Gaussian-centre bounding box; ${(lowerQuantile * 100).toFixed(1)}-${(upperQuantile * 100).toFixed(1)} percentile edges`,
    axes,
    shared,
    sharedSizeM: result.sharedSizeM,
    sourcePointCount: result.sourcePointCount,
    results: result.results,
    entities: storedEntities(after.document, result.updatedIds),
    overlay: {
      color: FIT_OVERLAY_COLOR,
      style: "box wireframe",
      idPrefix: OVERLAY_NAMESPACES.fit,
      count: result.overlayCount,
      visibleForMs: 10_000,
      replaces: `previous ${OVERLAY_NAMESPACES.fit} overlays only`,
    },
  });
});

server.registerTool("scene_clear_splat_bounds", {
  title: "Clear all overlays",
  description: "Remove every temporary overlay (splat-fit boxes and voxel overlays alike). Entities, colliders and measurements are unchanged.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  const { after } = await mutateWith("Clearing overlays", ({ document }) => ({
    commands: document.bounds.length > 0 ? [{ type: "bounds.set", bounds: [] }] : [],
    result: undefined,
  }));
  return mutationResult("overlays-cleared", after);
});

server.registerTool("scene_transfer_splat_color", {
  title: "Transfer splat color to surfaces",
  description: "Blend nearby source-splat base colours onto each box's material colour (opacity- and distance-weighted). Each box receives one flat colour; this is not a texture bake. Low-support samples are reported but not applied. apply:false only samples and changes nothing.",
  inputSchema: z.object({
    entityIds: entityIdsField,
    paddingM: paddingField,
    opacityThreshold: opacityThresholdField,
    surfaceBandM: surfaceBandField,
    minimumSupport: minimumSupportField,
    apply: z.boolean().default(true).describe("Write the sampled colours into the boxes. false = report only, no scene change. Default true."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ entityIds, paddingM, opacityThreshold, surfaceBandM, minimumSupport, apply }) => {
  const { after, result } = await mutateWith("This colour transfer", async ({ document }) => {
    const cloud = await loadCatalogSplat(document.assetId, document.assetVersion);
    const updated: SceneEntity[] = [];
    const transfers = entityIds.map((entityId) => {
      const analysis = analyzeSplatBox(cloud, boxQueryForEntity(document.entities, entityId), {
        paddingM,
        surfaceBandM,
        opacityThreshold,
      });
      const supported = analysis.surfaceSupportCount >= minimumSupport;
      const applied = apply && supported && analysis.surfaceColor !== undefined;
      if (applied) {
        const entity = boxEntityForUpdate(document.entities, entityId);
        entity.material.color = analysis.surfaceColor!;
        updated.push(entity);
      }
      return {
        entityId: analysis.id,
        name: analysis.name,
        color: analysis.surfaceColor ?? null,
        supportCount: analysis.surfaceSupportCount,
        confidence: analysis.surfaceSupportCount >= 500 ? "high" : supported ? "medium" : "low",
        applied,
      };
    });
    return {
      commands: updated.map((entity) => ({ type: "entity.upsert" as const, entity })),
      result: { sourcePointCount: cloud.pointCount, transfers, updatedIds: updated.map(({ id }) => id) },
    };
  });
  return mutationResult(apply ? "splat-colors-applied" : "splat-colors-sampled", after, {
    method: "opacity-weighted, Gaussian-distance-weighted SPZ base-colour blend near box faces",
    sourcePointCount: result.sourcePointCount,
    transfers: result.transfers,
    entities: storedEntities(after.document, result.updatedIds),
  });
});

server.registerTool("scene_transfer_splat_texture", {
  title: "Bake splat texture onto box surfaces",
  description: "Project spatially varying source-splat base colours onto one face of each box as a PNG texture. The face is in the box's own local frame (z-positive is the top only when the box is unrotated). A box holds one texture: baking another face replaces the previous one. Low-support bakes are reported but not applied. apply:false only bakes and changes nothing.",
  inputSchema: z.object({
    entityIds: entityIdsField,
    face: z.enum(["x-positive", "x-negative", "y-positive", "y-negative", "z-positive", "z-negative"]).default("z-positive").describe("Box-local face to texture, e.g. z-positive = the face whose outward normal is the box's local +Z. Default z-positive."),
    resolution: z.number().int().min(16).max(128).default(64).describe("Texture width and height in pixels (16-128). Default 64."),
    surfaceBandM: surfaceBandField,
    opacityThreshold: opacityThresholdField,
    minimumSupport: minimumSupportField,
    apply: z.boolean().default(true).describe("Store the baked texture on the boxes. false = report only, no scene change. Default true."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ entityIds, face, resolution, surfaceBandM, opacityThreshold, minimumSupport, apply }) => {
  const { after, result } = await mutateWith("This texture bake", async ({ document }) => {
    const cloud = await loadCatalogSplat(document.assetId, document.assetVersion);
    const updated: SceneEntity[] = [];
    const transfers = entityIds.map((entityId) => {
      const entity = boxEntityForUpdate(document.entities, entityId);
      const bake = bakeSplatBoxTexture(cloud, boxQueryForEntity(document.entities, entityId), {
        face,
        resolution,
        surfaceBandM,
        opacityThreshold,
      });
      const applied = apply && bake.supportCount >= minimumSupport && bake.texture !== undefined;
      const replacedFace = entity.material.texture?.face ?? null;
      if (applied) {
        entity.material.texture = bake.texture;
        updated.push(entity);
      }
      return {
        entityId: entity.id,
        name: entity.name,
        face,
        resolution: [resolution, resolution],
        averageColor: bake.averageColor ?? null,
        supportCount: bake.supportCount,
        seededCoverage: bake.seededCoverage,
        encodedBytes: bake.texture ? Math.floor((bake.texture.dataUrl.length - "data:image/png;base64,".length) * 0.75) : 0,
        applied,
        replacedTextureFace: applied ? replacedFace : null,
      };
    });
    return {
      commands: updated.map((entity) => ({ type: "entity.upsert" as const, entity })),
      result: { sourcePointCount: cloud.pointCount, transfers, updatedIds: updated.map(({ id }) => id) },
    };
  });
  return mutationResult(apply ? "splat-textures-applied" : "splat-textures-baked", after, {
    method: "face-projected, opacity- and surface-distance-weighted SPZ base-colour PNG",
    sourcePointCount: result.sourcePointCount,
    transfers: result.transfers,
    entities: storedEntities(after.document, result.updatedIds),
  });
});

server.registerTool("scene_inspect_splat_voxels", {
  title: "Inspect splat voxels",
  description: [
    "Voxelize source-splat Gaussians inside an oriented world-space box and return the occupied cells.",
    "Never creates entities, meshes or files.",
    `With showOverlay the user's viewport temporarily draws the query box as a ${VOXEL_SEARCH_COLOR} wireframe and the occupied voxels as a ${VOXEL_CELL_COLOR} voxel wireframe; this replaces only previous voxel overlays ("voxel-query:" ids) and turns on the measurements layer.`,
    "Cells are reported in the query box's local frame; estimatedObjects are six-connected components with world centres, not semantic classifications.",
    "Cost: about 4 s and 450 MB for a 1.5×0.95×0.42 m box at the default 4 mm, plus about 1.3 s for visibility culling with 16 views. The median Gaussian sigma in the reception splat is about 13 mm, so cells below about 1 cm interpolate Gaussian blobs rather than adding real detail; use voxelSizeM 0.01-0.04 for large regions.",
    "Fine grids exceed maxReturnedRuns and are truncated (runsTruncated); use grid.occupiedCellsPerZLayer and estimatedObjects as the summary.",
  ].join(" "),
  inputSchema: z.object({
    name: nameField.default("Splat voxels").describe("Name shown in the overlay labels. Default 'Splat voxels'."),
    position: vec3.describe("World centre of the query box in metres (+Z up)."),
    rotationDegrees: rotationField,
    size: vec3.refine((value) => value.every((component) => component > 0), {
      message: "Bounding-box dimensions must be greater than zero.",
    }).describe("Query box edge lengths [x, y, z] in metres along its own axes."),
    voxelSizeM: z.number().positive().max(1).default(0.004).describe("Voxel edge length in metres. Default 0.004 (4 mm); use 0.01-0.04 for large regions, since detail below about 1 cm only interpolates Gaussian blobs."),
    opacityCutoff: z.number().gt(0).lt(1).default(0.1).describe("A cell is occupied when its accumulated opacity 1 - exp(-sum(density)) reaches this value. Default 0.1."),
    densityModel: z.enum(["optical-depth", "opacity"]).default("optical-depth").describe("How each Gaussian becomes per-cell density. optical-depth (default): the Gaussian is a volume whose line integral along its thinnest axis equals -ln(1 - opacity), so thin surface Gaussians keep full opacity while thick blurry ones spread it over their thickness instead of filling a slab; every Gaussian still contributes. opacity: the previous model, which deposits the full 2D opacity at every cell within 3 sigma and fattens surfaces by the blur."),
    fillEnclosed: z.boolean().default(true).describe("Also mark empty cells enclosed on all sides by occupied cells (not reachable from the box faces) as occupied, so closed shells become solid. Default true."),
    cullInvisible: z.boolean().default(true).describe("Drop Gaussians that cannot be seen: the region (box plus 10 cm) is rendered with exact depth-sorted 3DGS blending from the visibilityViews cameras, and a Gaussian is kept only if its blend weight opacity·G·transmittance reaches 1/255 in some pixel of some view. Removes faint and occluded Gaussians without touching visible ones. Default true."),
    visibilityViews: z.union([
      z.number().int().min(1).max(128),
      z.array(z.enum(["perspective", "top", "front", "right"])).min(1).max(4),
    ]).default(16).describe("Cameras for cullInvisible (orthographic, 4 mm pixels). A number N spreads N directions evenly from the horizon to straight down, so every side of an object is seen. A list of Studio viewport presets (perspective, top, front, right) uses those camera directions only; then Gaussians seen from none of them are dropped, including the back and the far side of objects. Default 16."),
    minimumSplatOpacity: z.number().min(0).max(1).default(0.01).describe("Ignore Gaussians with opacity below this. Default 0.01."),
    minimumContribution: z.number().gt(0).max(1).default(1 / 255).describe("Skip a Gaussian's contribution to a cell when it is below this density. Default 1/255."),
    minimumNeighbors: z.number().int().min(0).max(6).default(1).describe("Drop occupied cells with fewer occupied face neighbours than this (0 keeps isolated cells). Default 1."),
    maxGridCells: z.number().int().min(1).max(MAX_VOXEL_OVERLAY_CELLS).default(12_000_000).describe(`Refuse grids with more cells than this (max ${MAX_VOXEL_OVERLAY_CELLS}). Default 12000000.`),
    excludeUpFacingBelowZ: z.number().finite().nullable().default(null).describe("World height in metres. Ignore Gaussians centred below it whose surface normal (flattest axis) is within 32° of vertical: floors, rugs and cushion tops. Vertical surfaces such as table legs are kept, so furniture feet separate from the floor. Set it just above the floor clutter (e.g. 0.14 for the reception rug and pillows). Default null keeps every Gaussian."),
    maxReturnedRuns: z.number().int().min(0).max(20_000).default(2_000).describe("Maximum occupied runs listed in voxels.layers; fine grids are truncated. Default 2000."),
    showOverlay: z.boolean().default(true).describe("Draw the temporary overlay for the user. false = no scene change at all. Default true."),
    overlaySeconds: z.number().positive().max(600).default(60).describe("How long the overlay stays visible, in seconds. Default 60."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({
  name,
  position: boxPosition,
  rotationDegrees: boxRotationDegrees,
  size,
  voxelSizeM,
  opacityCutoff,
  minimumSplatOpacity,
  minimumContribution,
  minimumNeighbors,
  maxGridCells,
  excludeUpFacingBelowZ,
  densityModel,
  fillEnclosed,
  cullInvisible,
  visibilityViews,
  maxReturnedRuns,
  showOverlay,
  overlaySeconds,
}) => {
  const quaternionXyzw = quaternionFromEulerDegrees(boxRotationDegrees);
  const snapshot = await client.snapshot();
  const cloud = await loadCatalogSplat(snapshot.document.assetId, snapshot.document.assetVersion);
  const visibility = cullInvisible
    ? visibleGaussians(cloud, {
        position: boxPosition,
        quaternionXyzw,
        size,
        marginM: 0.1,
        directions: typeof visibilityViews === "number"
          ? hemisphereDirections(visibilityViews)
          : visibilityViews.map((preset) => VIEWPORT_PRESET_DIRECTIONS[preset]),
        pixelSizeM: 0.004,
        minimumWeight: 1 / 255,
        minimumSplatOpacity,
      })
    : null;
  const grid = voxelizeSplatBox(cloud, {
    position: boxPosition,
    quaternionXyzw,
    size,
    voxelSize: voxelSizeM,
    opacityCutoff,
    minimumSplatOpacity,
    minimumContribution,
    minimumNeighbors,
    maxGridCells,
    excludeUpFacingBelowZ,
    densityModel,
    fillEnclosed,
    includeMask: visibility?.visible ?? null,
  });
  const queryRotation = new Quaternion(...quaternionXyzw).normalize();
  const queryPosition = new Vector3(...boxPosition);
  const estimatedObjects = grid.components.slice(0, 64).map(({ voxelCount, meanColor, localBounds }) => {
    const { min, max } = localBounds;
    const worldCenter = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
      .applyQuaternion(queryRotation)
      .add(queryPosition);
    return {
      voxelCount,
      meanColor,
      worldCenter: [worldCenter.x, worldCenter.y, worldCenter.z],
      sizeAlongQueryAxesM: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      localBounds,
    };
  });
  const runs = occupancyRuns(grid.occupied, grid.dimensions);
  const returnedRuns = runs.slice(0, maxReturnedRuns);
  const layers: Array<{ k: number; rows: string }> = [];
  for (let index = 0; index < returnedRuns.length; index += 1) {
    const [k, j, first, last] = returnedRuns[index];
    const span = first === last ? `${first}` : `${first}-${last}`;
    const previous = returnedRuns[index - 1];
    if (previous?.[0] !== k) layers.push({ k, rows: `${j}:${span}` });
    else layers[layers.length - 1].rows += previous[1] === j ? `,${span}` : ` ${j}:${span}`;
  }

  const overlay: SceneBounds[] = [];
  if (showOverlay) {
    const expiresAt = new Date(Date.now() + overlaySeconds * 1_000).toISOString();
    overlay.push(
      {
        id: `${OVERLAY_NAMESPACES.voxels}search`,
        label: `Voxel search volume · ${name}`,
        color: VOXEL_SEARCH_COLOR,
        position: boxPosition,
        quaternionXyzw,
        size,
        expiresAt,
      },
      {
        id: `${OVERLAY_NAMESPACES.voxels}voxels`,
        label: `Occupied voxels · ${name} · ${grid.occupiedVoxelCount} cells`,
        color: VOXEL_CELL_COLOR,
        position: boxPosition,
        quaternionXyzw,
        size,
        voxels: { voxelSizeM, dimensions: grid.dimensions, occupancy: encodeOccupancy(grid.occupied) },
        expiresAt,
      },
    );
  }
  const { after } = await mutateWith("Publishing the voxel overlay", ({ document }) => {
    if (overlay.length === 0) return { commands: [], result: undefined };
    const commands: StudioCommand[] = [
      { type: "bounds.set", bounds: mergeOverlayBounds(document.bounds, OVERLAY_NAMESPACES.voxels, overlay) },
    ];
    if (!document.layers.measurements) commands.push({ type: "layer.visibility.set", layer: "measurements", visible: true });
    return { commands, result: undefined };
  });
  return mutationResult("splat-voxels-inspected", after, {
    assetChanged: false,
    asset: { id: after.document.assetId, version: after.document.assetVersion },
    sourcePointCount: cloud.pointCount,
    selectedGaussianCount: grid.selectedGaussianCount,
    excludedUpFacingGaussianCount: grid.excludedUpFacingGaussianCount,
    visibilityCulling: visibility
      ? {
          views: visibilityViews,
          testedGaussianCount: visibility.candidateCount,
          visibleGaussianCount: visibility.visibleCount,
          invisibleGaussianCount: visibility.candidateCount - visibility.visibleCount,
        }
      : null,
    densityModel,
    filledInteriorCellCount: grid.filledInteriorCellCount,
    query: { position: boxPosition, rotationDegrees: boxRotationDegrees, quaternionXyzw, size },
    grid: {
      frame: "Query-box local axes. Cell [i, j, k] spans localMinCornerM + [i, j, k] * voxelSizeM to that corner + voxelSizeM; world = query.position + rotate(query.quaternionXyzw, local).",
      localMinCornerM: [-size[0] / 2, -size[1] / 2, -size[2] / 2],
      voxelSizeM,
      dimensions: grid.dimensions,
      cellCount: grid.gridCellCount,
      occupiedCellCount: grid.occupiedVoxelCount,
      exposedFaceCount: grid.exposedFaceCount,
      occupiedCellsPerZLayer: grid.occupiedCellsPerZLayer,
    },
    voxels: {
      format: "Per Z layer k, rows is space-separated 'j:i-ranges'; e.g. '3:0-12,20' means cells i=0..12 and i=20 of row j=3 are occupied. Layers without occupied cells are omitted.",
      runCount: runs.length,
      layers,
      runsTruncated: runs.length > maxReturnedRuns,
    },
    estimatedObjectCount: grid.components.length,
    estimatedObjects,
    estimatedObjectsTruncated: grid.components.length > estimatedObjects.length,
    overlay: showOverlay
      ? {
          search: { color: VOXEL_SEARCH_COLOR, style: "box wireframe" },
          voxels: { color: VOXEL_CELL_COLOR, style: "exposed voxel edge wireframe" },
          idPrefix: OVERLAY_NAMESPACES.voxels,
          visibleForMs: overlaySeconds * 1_000,
          replaces: `previous ${OVERLAY_NAMESPACES.voxels} overlays only`,
        }
      : null,
    method: densityModel === "optical-depth"
      ? "3-sigma Gaussian voxel density with optical-depth weighting (per-voxel optical depth tau·min(1, voxel/(sqrt(2pi)·thinnest sigma)), tau = -ln(1 - opacity)); occupied when 1 - exp(-sum) >= opacityCutoff"
      : "SplatTransform-style 3-sigma Gaussian voxel density with the full 2D opacity per cell; occupied when 1 - exp(-sum(density)) >= opacityCutoff",
    semanticClassification: false,
  });
});

// ── Colliders ─────────────────────────────────────────────────────────────

const COLLIDER_RULES = "Authored colliders replace the package-manifest colliders in the viewport (the manifest colliders show only while no collider is authored). Turns on the collisions layer.";

server.registerTool("scene_set_collision", {
  title: "Add or replace collision",
  description: `Create or replace an authored collider box. kind entity-box links it to a box entity so it follows that box's world transform and size (it still resolves when the box or an ancestor is hidden, and is removed with the box). kind box is a free world-space box. ${COLLIDER_RULES}`,
  inputSchema: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("entity-box").describe("Collider linked to a box entity."),
      id: identifier.optional().describe("Collider id. Default '<entityId>:collision'."),
      name: nameField.describe("Collider display name."),
      entityId: identifier.describe("Id of an existing box entity."),
    }).strict(),
    z.object({
      kind: z.literal("box").describe("Free collider box in world coordinates."),
      id: identifier.optional().describe("Collider id. Omit to generate one; reuse an id to replace."),
      name: nameField.describe("Collider display name."),
      position: vec3.default([0, 0, 0]).describe("World centre in metres (+Z up). Default [0, 0, 0]."),
      rotationDegrees: vec3.default([0, 0, 0]).describe("World rotation as Three.js intrinsic XYZ Euler degrees, R = Rx·Ry·Rz. Default [0, 0, 0]."),
      size: vec3.refine((value) => value.every((component) => component > 0), {
        message: "Collision dimensions must be greater than zero.",
      }).describe("Edge lengths [x, y, z] in metres along the collider's own axes."),
    }).strict(),
  ]),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const collision: SceneCollisionBox = input.kind === "entity-box"
    ? { id: input.id ?? `${input.entityId}:collision`, name: input.name, kind: input.kind, entityId: input.entityId }
    : {
        id: input.id ?? generatedId(input.name),
        name: input.name,
        kind: input.kind,
        position: input.position,
        quaternionXyzw: quaternionFromEulerDegrees(input.rotationDegrees),
        size: input.size,
      };
  const { after } = await mutateWith("Setting the collider", ({ document }) => {
    if (collision.kind === "entity-box") {
      const entity = document.entities.find(({ id }) => id === collision.entityId);
      if (!entity) throw new Error(`Scene object does not exist: ${collision.entityId}`);
      if (entity.kind !== "box") throw new Error(`Linked colliders need a box entity; "${entity.id}" is a ${entity.kind}.`);
    }
    const commands: StudioCommand[] = [{ type: "collision.upsert", collision }];
    if (!document.layers.collisions) commands.push({ type: "layer.visibility.set", layer: "collisions", visible: true });
    return { commands, result: undefined };
  });
  return mutationResult("collision-upserted", after, {
    collision,
    manifestCollidersShown: after.document.collisions.length === 0,
  });
});

server.registerTool("scene_remove_collision", {
  title: "Remove collision",
  description: "Remove one authored collider by id. Fails if the id does not exist. When the last authored collider is removed, the package-manifest colliders are shown again.",
  inputSchema: z.object({ id: identifier.describe("Id of the authored collider to remove.") }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ id }) => {
  const { after } = await mutateWith("Removing the collider", ({ document }) => {
    if (!document.collisions.some((collision) => collision.id === id)) throw new Error(`Authored collider does not exist: ${id}`);
    return { commands: [{ type: "collision.remove", id }], result: undefined };
  });
  return mutationResult("collision-removed", after, {
    collisionId: id,
    manifestCollidersShown: after.document.collisions.length === 0,
  });
});

server.registerTool("scene_clear_collisions", {
  title: "Clear authored collisions",
  description: `Remove every authored collider (linked and free). The package-manifest colliders become the viewport fallback. Large sets are cleared in atomic batches of up to ${MAX_COMMANDS_PER_CALL}.`,
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  const removedIds: string[] = [];
  let changed = false;
  let after: SceneCommandResult;
  let batch: string[];
  do {
    ({ after, result: batch } = await mutateWith("Clearing colliders", ({ document }) => {
      const ids = document.collisions.slice(0, MAX_COMMANDS_PER_CALL).map(({ id }) => id);
      return { commands: ids.map((id) => ({ type: "collision.remove" as const, id })), result: ids };
    }));
    changed ||= after.changed;
    removedIds.push(...batch);
  } while (batch.length > 0);
  return mutationResult("collisions-cleared", { ...after, changed }, { removedCollisionIds: removedIds, manifestCollidersShown: true });
});

// ── Measurements ──────────────────────────────────────────────────────────

server.registerTool("scene_add_measurement", {
  title: "Add measurement",
  description: "Add, or replace by id, a persistent measurement line between two world points, shown on the measurements layer (turned on if off). Returns its length.",
  inputSchema: z.object({
    id: identifier.optional().describe("Measurement id; reuse an id to replace. Omit to generate one."),
    label: nameField.describe("Text shown with the measurement."),
    start: vec3.describe("World start point in metres (+Z up)."),
    end: vec3.describe("World end point in metres (+Z up)."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ id, label, start, end }) => {
  const measurement = { id: id ?? generatedId(label), label, start, end };
  const { after } = await mutateWith("Adding the measurement", ({ document }) => {
    const commands: StudioCommand[] = [];
    if (document.measurements.some((existing) => existing.id === measurement.id)) {
      commands.push({ type: "measurement.remove", id: measurement.id });
    }
    commands.push({ type: "measurement.add", measurement });
    if (!document.layers.measurements) commands.push({ type: "layer.visibility.set", layer: "measurements", visible: true });
    return { commands, result: undefined };
  });
  return mutationResult("measurement-added", after, {
    measurement: { ...measurement, lengthM: new Vector3(...end).distanceTo(new Vector3(...start)) },
  });
});

server.registerTool("scene_remove_measurement", {
  title: "Remove measurement",
  description: "Remove one measurement by id. Fails if the id does not exist.",
  inputSchema: z.object({ id: identifier.describe("Id of the measurement to remove.") }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ id }) => {
  const { after } = await mutateWith("Removing the measurement", ({ document }) => {
    if (!document.measurements.some((measurement) => measurement.id === id)) throw new Error(`Measurement does not exist: ${id}`);
    return { commands: [{ type: "measurement.remove", id }], result: undefined };
  });
  return mutationResult("measurement-removed", after, { measurementId: id });
});

// ── Viewport ──────────────────────────────────────────────────────────────

server.registerTool("scene_set_view", {
  title: "Set viewport camera",
  description: "Set the live Studio camera to Perspective, Top, Front or Right and re-frame the visible scene. Re-frames even when the preset is already active.",
  inputSchema: z.object({
    preset: z.enum(["perspective", "top", "front", "right"]).describe("Camera preset: perspective, top (looking down -Z), front, or right."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ preset }) => {
  const { after } = await mutateWith("Setting the view", () => ({
    commands: [{ type: "viewport.preset.set", preset }, { type: "viewport.frame" }],
    result: undefined,
  }));
  return mutationResult("viewport-updated", after, { preset });
});

server.registerTool("scene_set_layer", {
  title: "Set scene layer visibility",
  description: "Show or hide one Studio viewport layer.",
  inputSchema: z.object({
    layer: z.union([
      z.literal("catalogVisuals").describe("The selected asset's source Gaussian splat (not the catalog GLB)."),
      z.literal("assetVisuals").describe("The 3D asset layer: the packaged catalog GLB (shown only while no entity is effectively visible) plus all semantic entities."),
      z.literal("collisions").describe("Collider boxes: authored colliders, or the package-manifest colliders while none are authored."),
      z.literal("reference").describe("Reference splats/meshes/point clouds added in the browser."),
      z.literal("measurements").describe("Measurement lines and the temporary fit/voxel overlays."),
    ]).describe("Layer to change."),
    visible: z.boolean().describe("true to show, false to hide."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ layer, visible }) => {
  const { after } = await mutateWith("Setting the layer", () => ({
    commands: [{ type: "layer.visibility.set", layer, visible }],
    result: undefined,
  }));
  return mutationResult("layer-updated", after, { layer, visible });
});

// ── Build ─────────────────────────────────────────────────────────────────

server.registerTool("scene_build_target", {
  title: "Build simulator target",
  description: "Run the fixed exporter of the selected asset package (document.assetId, resolved through assets/catalog.json) and return its artifact path and captured output. The exporter reads only that package's manifest.json: entities, authored colliders, textures and measurements created in the Studio are NOT exported. No arbitrary command or Python source is accepted.",
  inputSchema: z.object({
    target: z.enum(["isaac", "mujoco", "unreal"]).describe("Exporter to run: isaac (USD), mujoco (MJCF XML) or unreal (GLB)."),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ target }) => {
  const result = await client.build(target);
  return textResult({
    ...result,
    note: `The ${result.assetId} exporter reads only ${result.packageDirectory}/manifest.json; scene entities, authored colliders, textures and measurements are not part of the export.`,
  });
});

await server.connect(new StdioServerTransport());
