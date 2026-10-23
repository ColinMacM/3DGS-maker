import { useCallback, useEffect, useReducer } from "react";
import { createDefaultStudioDocument } from "../domain/defaultDocument";
import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import { loadStudioDraft, saveStudioDraft } from "../persistence/localStorage";
import type { StudioCommand } from "./commands";
import {
  createStudioHistory,
  reduceStudioHistory,
  type HistoryAction,
  type RuntimeReferenceHydration,
  type StudioHistory,
} from "./history";

export interface StudioStateApi {
  document: StudioDocument;
  canUndo: boolean;
  canRedo: boolean;
  dispatch: (command: StudioCommand) => void;
  undo: () => void;
  redo: () => void;
  replaceDocument: (document: unknown) => void;
  hydrateReferences: (references: readonly RuntimeReferenceHydration[]) => void;
  synchronizeDocument: (document: StudioDocument) => void;
}

function initializeHistory(): StudioHistory {
  try {
    const draft = loadStudioDraft();
    return createStudioHistory(draft ?? createDefaultStudioDocument());
  } catch (error) {
    console.warn("The saved studio draft could not be loaded; starting with a new document.", error);
    return createStudioHistory(createDefaultStudioDocument());
  }
}

export function useStudioState(): StudioStateApi {
  const [history, send] = useReducer(
    (state: StudioHistory, action: HistoryAction) => reduceStudioHistory(state, action),
    undefined,
    initializeHistory,
  );

  useEffect(() => {
    try {
      saveStudioDraft(history.present);
    } catch (error) {
      console.warn("The studio draft could not be saved.", error);
    }
  }, [history.present]);

  const dispatch = useCallback((command: StudioCommand) => {
    send({ type: "command", command, updatedAt: new Date().toISOString() });
  }, []);
  const undo = useCallback(() => send({ type: "undo" }), []);
  const redo = useCallback(() => send({ type: "redo" }), []);
  const replaceDocument = useCallback((document: unknown) => {
    // Validate synchronously before dispatch so invalid imports never enter or mutate history.
    const valid = validateStudioDocument(document);
    send({ type: "replace", document: valid });
  }, []);
  const hydrateReferences = useCallback((references: readonly RuntimeReferenceHydration[]) => {
    send({ type: "references.hydrate", references });
  }, []);
  const synchronizeDocument = useCallback((document: StudioDocument) => {
    send({ type: "scene.synchronize", document });
  }, []);

  return {
    document: history.present,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dispatch,
    undo,
    redo,
    replaceDocument,
    hydrateReferences,
    synchronizeDocument,
  };
}

export type { StudioCommand } from "./commands";
