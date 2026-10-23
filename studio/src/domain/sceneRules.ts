import type { SceneEntity, StudioDocument } from "./types";

/**
 * True when the entity and every ancestor are `visible`. A hidden parent hides
 * its whole subtree, exactly as the viewport renders it.
 */
export function isEntityEffectivelyVisible(
  entity: SceneEntity,
  entitiesById: ReadonlyMap<string, SceneEntity>,
): boolean {
  let current: SceneEntity | undefined = entity;
  // The validated hierarchy is acyclic; the guard only bounds malformed input.
  for (let depth = 0; current && depth <= entitiesById.size; depth += 1) {
    if (!current.visible) return false;
    if (!current.parentId) return true;
    current = entitiesById.get(current.parentId);
  }
  return false;
}

/**
 * The packaged catalog GLB is a placeholder for an empty scene: it is shown
 * only while no scene entity is effectively visible. Hidden entities (or
 * entities under a hidden ancestor) do not replace it. The `assetVisuals` layer
 * still gates the whole 3D asset layer on top of this rule.
 */
export function isCatalogAssetShown(document: StudioDocument): boolean {
  const entitiesById = new Map(document.entities.map((entity) => [entity.id, entity] as const));
  return !document.entities.some((entity) => isEntityEffectivelyVisible(entity, entitiesById));
}
