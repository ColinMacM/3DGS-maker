import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "../state/commands";

export const SCENE_CONTROL_SCHEMA_VERSION = 1 as const;

export interface SceneSnapshot {
  schemaVersion: typeof SCENE_CONTROL_SCHEMA_VERSION;
  revision: number;
  persisted: boolean;
  document: StudioDocument;
}

export interface SceneReplaceRequest {
  expectedRevision: number;
  document: StudioDocument;
}

export interface SceneCommandBatchRequest {
  expectedRevision: number;
  commands: StudioCommand[];
}

export interface ScenePythonRequest {
  expectedRevision: number;
  script: string;
}

export interface ScenePythonResult extends SceneSnapshot {
  output: string;
}

export function withoutRuntimeReferenceUrls(document: StudioDocument): StudioDocument {
  return validateStudioDocument({
    ...document,
    references: document.references.map(({ objectUrl: _discarded, ...reference }) => reference),
  });
}

export function sceneDocumentSignature(document: StudioDocument): string {
  return JSON.stringify(withoutRuntimeReferenceUrls(document));
}

export function mergeRuntimeReferenceUrls(
  remote: StudioDocument,
  local: StudioDocument,
): StudioDocument {
  const localUrls = new Map(
    local.references
      .filter((reference) => reference.objectUrl)
      .map((reference) => [reference.id, reference.objectUrl!] as const),
  );
  return validateStudioDocument({
    ...remote,
    references: remote.references.map((reference) => {
      const objectUrl = localUrls.get(reference.id);
      return objectUrl ? { ...reference, objectUrl } : reference;
    }),
  });
}

export function parseSceneSnapshot(value: unknown): SceneSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Scene API response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCENE_CONTROL_SCHEMA_VERSION) {
    throw new Error("Scene API response has an unsupported schemaVersion");
  }
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) {
    throw new Error("Scene API response revision must be a nonnegative integer");
  }
  if (typeof record.persisted !== "boolean") {
    throw new Error("Scene API response persisted must be a boolean");
  }
  return {
    schemaVersion: SCENE_CONTROL_SCHEMA_VERSION,
    revision: record.revision as number,
    persisted: record.persisted,
    document: validateStudioDocument(record.document),
  };
}
