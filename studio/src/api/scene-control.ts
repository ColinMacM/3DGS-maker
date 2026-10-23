import {
  parseSceneCommandResult,
  parseSceneRevisionMarker,
  parseSceneSnapshot,
  withoutRuntimeReferenceUrls,
  type SceneCommandResult,
  type SceneRevisionMarker,
  type SceneSnapshot,
} from "./scene-control-contract";
import type { StudioDocument } from "../domain/types";

export class SceneControlApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SceneControlApiError";
    this.status = status;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SceneControlApiError(
      `Scene-control API returned invalid JSON (HTTP ${response.status})`,
      response.status,
    );
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = payload.error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return `Scene-control request failed with HTTP ${status}`;
}

async function checkedPayload<T>(response: Response, parse: (payload: unknown) => T): Promise<T> {
  const payload = await responseJson(response);
  if (!response.ok) throw new SceneControlApiError(errorMessage(payload, response.status), response.status);
  try {
    return parse(payload);
  } catch (error) {
    throw new SceneControlApiError(
      error instanceof Error ? error.message : "Scene-control response is invalid",
      response.status,
    );
  }
}

export async function fetchControlledScene(signal?: AbortSignal): Promise<SceneSnapshot> {
  return checkedPayload(await fetch("/api/scene", {
    headers: { Accept: "application/json" },
    signal,
  }), parseSceneSnapshot);
}

/**
 * Browser heartbeat: reports the viewport's current render errors and returns the
 * server's revision marker, which the poll loop uses to detect new revisions.
 */
export async function reportControlledViewerStatus(
  renderErrors: readonly string[],
  signal?: AbortSignal,
): Promise<SceneRevisionMarker> {
  return checkedPayload(await fetch("/api/scene/viewer-status", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ renderErrors }),
    signal,
  }), parseSceneRevisionMarker);
}

export async function replaceControlledScene(
  expectedRevision: number,
  document: StudioDocument,
  signal?: AbortSignal,
): Promise<SceneCommandResult> {
  return checkedPayload(await fetch("/api/scene", {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision,
      document: withoutRuntimeReferenceUrls(document),
    }),
    signal,
  }), parseSceneCommandResult);
}
