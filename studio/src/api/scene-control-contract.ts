import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "../state/commands";

export const SCENE_CONTROL_SCHEMA_VERSION = 1 as const;
/** The browser polls the scene server (and reports viewer status) at this interval. */
export const SCENE_POLL_INTERVAL_MS = 1_000;
/** A viewer counts as connected when its latest status report is at most this old. */
export const VIEWER_HEARTBEAT_TIMEOUT_MS = 5_000;
export const MAX_VIEWER_RENDER_ERRORS = 32;
export const MAX_VIEWER_RENDER_ERROR_LENGTH = 512;

export interface SceneViewerStatus {
  connected: boolean;
  lastSeenAt: string | null;
  renderErrors: string[];
}

export interface SceneSnapshot {
  schemaVersion: typeof SCENE_CONTROL_SCHEMA_VERSION;
  revision: number;
  persisted: boolean;
  document: StudioDocument;
  viewer: SceneViewerStatus;
}

/** Result of every scene mutation; `changed: false` means the document and revision were left untouched. */
export type SceneCommandResult = SceneSnapshot & { changed: boolean };

export interface SceneViewerStatusRequest {
  renderErrors: string[];
}

/** Response to POST /api/scene/viewer-status; the browser uses it to detect new revisions. */
export interface SceneRevisionMarker {
  instanceId: string;
  revision: number;
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

export interface ScenePythonResult extends SceneCommandResult {
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

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseViewerRenderErrors(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("renderErrors must be an array of strings");
  if (value.length > MAX_VIEWER_RENDER_ERRORS) {
    throw new Error(`renderErrors may contain at most ${MAX_VIEWER_RENDER_ERRORS} entries`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`renderErrors[${index}] must be a string`);
    if (entry.length > MAX_VIEWER_RENDER_ERROR_LENGTH) {
      throw new Error(`renderErrors[${index}] exceeds ${MAX_VIEWER_RENDER_ERROR_LENGTH} characters`);
    }
    return entry;
  });
}

function parseViewerStatus(raw: unknown): SceneViewerStatus {
  const value = requireObject(raw, "Scene API response viewer");
  const { connected, lastSeenAt } = value;
  if (typeof connected !== "boolean") {
    throw new Error("Scene API response viewer.connected must be a boolean");
  }
  if (lastSeenAt !== null && typeof lastSeenAt !== "string") {
    throw new Error("Scene API response viewer.lastSeenAt must be a string or null");
  }
  return {
    connected,
    lastSeenAt: lastSeenAt as string | null,
    renderErrors: parseViewerRenderErrors(value.renderErrors),
  };
}

export function parseSceneSnapshot(raw: unknown): SceneSnapshot {
  const value = requireObject(raw, "Scene API response");
  if (value.schemaVersion !== SCENE_CONTROL_SCHEMA_VERSION) {
    throw new Error("Scene API response has an unsupported schemaVersion");
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("Scene API response revision must be a nonnegative integer");
  }
  if (typeof value.persisted !== "boolean") {
    throw new Error("Scene API response persisted must be a boolean");
  }
  return {
    schemaVersion: SCENE_CONTROL_SCHEMA_VERSION,
    revision: value.revision as number,
    persisted: value.persisted,
    document: validateStudioDocument(value.document),
    viewer: parseViewerStatus(value.viewer),
  };
}

export function parseSceneCommandResult(value: unknown): SceneCommandResult {
  const snapshot = parseSceneSnapshot(value);
  const changed = (value as Record<string, unknown>).changed;
  if (typeof changed !== "boolean") {
    throw new Error("Scene API mutation response changed must be a boolean");
  }
  return { ...snapshot, changed };
}

export function parseSceneRevisionMarker(raw: unknown): SceneRevisionMarker {
  const value = requireObject(raw, "Scene revision marker");
  if (
    typeof value.instanceId !== "string"
    || !Number.isInteger(value.revision)
    || (value.revision as number) < 0
  ) {
    throw new Error("Scene revision marker is invalid");
  }
  return { instanceId: value.instanceId, revision: value.revision as number };
}
