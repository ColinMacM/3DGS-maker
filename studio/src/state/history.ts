import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "./commands";
import { reduceStudioDocument } from "./reducer";

export const DEFAULT_HISTORY_LIMIT = 100;

export interface StudioHistory {
  readonly past: readonly StudioDocument[];
  readonly present: StudioDocument;
  readonly future: readonly StudioDocument[];
}

export interface RuntimeReferenceHydration {
  readonly id: string;
  readonly objectUrl: string;
}

export type HistoryAction =
  | { type: "command"; command: StudioCommand; updatedAt: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "replace"; document: StudioDocument }
  | { type: "references.hydrate"; references: readonly RuntimeReferenceHydration[] }
  | { type: "scene.synchronize"; document: StudioDocument };

export function createStudioHistory(document: unknown): StudioHistory {
  return { past: [], present: validateStudioDocument(document), future: [] };
}

export function hydrateStudioDocumentReferences(
  document: StudioDocument,
  hydratedReferences: readonly RuntimeReferenceHydration[],
): StudioDocument {
  const objectUrls = new Map(hydratedReferences.map(({ id, objectUrl }) => [id, objectUrl]));
  let changed = false;
  const references = document.references.map((reference) => {
    const objectUrl = objectUrls.get(reference.id);
    if (!objectUrl || reference.objectUrl) return reference;
    changed = true;
    return { ...reference, objectUrl };
  });
  return changed ? { ...document, references } : document;
}

export function reduceStudioHistory(
  history: StudioHistory,
  action: HistoryAction,
  limit = DEFAULT_HISTORY_LIMIT,
): StudioHistory {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("History limit must be a positive integer");

  switch (action.type) {
    case "command": {
      const present = reduceStudioDocument(history.present, action.command, action.updatedAt);
      if (present === history.present) return history;
      return {
        past: [...history.past, history.present].slice(-limit),
        present,
        future: [],
      };
    }
    case "undo": {
      const present = history.past.at(-1);
      if (!present) return history;
      return {
        past: history.past.slice(0, -1),
        present,
        future: [history.present, ...history.future].slice(0, limit),
      };
    }
    case "redo": {
      const [present, ...future] = history.future;
      if (!present) return history;
      return {
        past: [...history.past, history.present].slice(-limit),
        present,
        future,
      };
    }
    case "replace": {
      const present = validateStudioDocument(action.document);
      return {
        past: [...history.past, history.present].slice(-limit),
        present,
        future: [],
      };
    }
    case "references.hydrate": {
      const past = history.past.map((document) => (
        hydrateStudioDocumentReferences(document, action.references)
      ));
      const present = hydrateStudioDocumentReferences(history.present, action.references);
      const future = history.future.map((document) => (
        hydrateStudioDocumentReferences(document, action.references)
      ));
      const changed = present !== history.present
        || past.some((document, index) => document !== history.past[index])
        || future.some((document, index) => document !== history.future[index]);
      return changed ? { past, present, future } : history;
    }
    case "scene.synchronize":
      return createStudioHistory(action.document);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
