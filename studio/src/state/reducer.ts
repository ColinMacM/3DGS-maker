import { createDefaultStudioDocument } from "../domain/defaultDocument";
import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "./commands";
/**
 * Applies one command without mutating the input. The caller supplies the edit
 * timestamp so the reducer remains deterministic and safe under React replay.
 */
export function reduceStudioDocument(
  document: StudioDocument,
  command: StudioCommand,
  updatedAt = document.updatedAt,
): StudioDocument {
  let next: StudioDocument;

  switch (command.type) {
    case "asset.select":
      if (
        document.assetId === command.assetId
        && document.assetVersion === command.assetVersion
      ) return document;
      next = {
        ...document,
        assetId: command.assetId,
        assetVersion: command.assetVersion,
        updatedAt,
      };
      break;
    case "viewport.preset.set":
      if (document.viewport.preset === command.preset) return document;
      next = {
        ...document,
        viewport: { ...document.viewport, preset: command.preset },
        updatedAt,
      };
      break;
    case "viewport.frame":
      next = {
        ...document,
        viewport: {
          ...document.viewport,
          frameRequest: (document.viewport.frameRequest ?? 0) + 1,
        },
        updatedAt,
      };
      break;
    case "layer.visibility.set":
      if (document.layers[command.layer] === command.visible) return document;
      next = {
        ...document,
        layers: { ...document.layers, [command.layer]: command.visible },
        updatedAt,
      };
      break;
    case "entity.upsert": {
      const index = document.entities.findIndex(({ id }) => id === command.entity.id);
      const entities = index < 0
        ? [...document.entities, command.entity]
        : document.entities.map((entity, entityIndex) => (
            entityIndex === index ? command.entity : entity
          ));
      next = { ...document, entities, updatedAt };
      break;
    }
    case "entity.remove": {
      const removedIds = new Set([command.id]);
      let previousSize = -1;
      while (previousSize !== removedIds.size) {
        previousSize = removedIds.size;
        for (const entity of document.entities) {
          if (entity.parentId && removedIds.has(entity.parentId)) {
            removedIds.add(entity.id);
          }
        }
      }
      const entities = document.entities.filter(({ id }) => !removedIds.has(id));
      if (entities.length === document.entities.length) return document;
      const collisions = document.collisions.filter((collision) => (
        collision.kind !== "entity-box" || !removedIds.has(collision.entityId)
      ));
      next = { ...document, entities, collisions, updatedAt };
      break;
    }
    case "collision.upsert": {
      const index = document.collisions.findIndex(({ id }) => id === command.collision.id);
      const collisions = index < 0
        ? [...document.collisions, command.collision]
        : document.collisions.map((collision, collisionIndex) => (
            collisionIndex === index ? command.collision : collision
          ));
      next = { ...document, collisions, updatedAt };
      break;
    }
    case "collision.remove": {
      const collisions = document.collisions.filter(({ id }) => id !== command.id);
      if (collisions.length === document.collisions.length) return document;
      next = { ...document, collisions, updatedAt };
      break;
    }
    case "bounds.set":
      next = { ...document, bounds: command.bounds, updatedAt };
      break;
    case "reference.add":
      next = {
        ...document,
        references: [...document.references, command.reference],
        updatedAt,
      };
      break;
    case "reference.remove": {
      const references = document.references.filter(({ id }) => id !== command.id);
      if (references.length === document.references.length) return document;
      next = { ...document, references, updatedAt };
      break;
    }
    case "measurement.add":
      next = {
        ...document,
        measurements: [...document.measurements, command.measurement],
        updatedAt,
      };
      break;
    case "measurement.remove": {
      const measurements = document.measurements.filter(({ id }) => id !== command.id);
      if (measurements.length === document.measurements.length) return document;
      next = { ...document, measurements, updatedAt };
      break;
    }
    case "reset":
      next = createDefaultStudioDocument(new Date(updatedAt));
      break;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }

  return validateStudioDocument(next);
}
