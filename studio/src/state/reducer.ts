import { createDefaultStudioDocument } from "../domain/defaultDocument";
import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "./commands";

function sameTransform(
  left: StudioDocument["tableTransform"],
  right: StudioDocument["tableTransform"],
): boolean {
  return left.position.every((value, index) => value === right.position[index])
    && left.quaternionXyzw.every((value, index) => value === right.quaternionXyzw[index])
    && left.scale.every((value, index) => value === right.scale[index]);
}

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
    case "table.parameters.update": {
      const entries = Object.entries(command.patch) as [keyof StudioDocument["table"], number][];
      if (entries.length === 0 || entries.every(([key, value]) => document.table[key] === value)) return document;
      next = { ...document, table: { ...document.table, ...command.patch }, updatedAt };
      break;
    }
    case "table.transform.update":
      if (sameTransform(document.tableTransform, command.transform)) return document;
      next = {
        ...document,
        tableTransform: {
          position: [...command.transform.position],
          quaternionXyzw: [...command.transform.quaternionXyzw],
          scale: [...command.transform.scale],
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
    case "viewport.settings.update":
      next = {
        ...document,
        viewport: {
          overheadLight: {
            ...document.viewport.overheadLight,
            ...command.patch.overheadLight,
          },
        },
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
      next = { ...document, entities, updatedAt };
      break;
    }
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
