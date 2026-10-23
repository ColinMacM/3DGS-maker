import {
  parseSceneSnapshot,
  withoutRuntimeReferenceUrls,
  type ScenePythonResult,
  type SceneSnapshot,
} from "./scene-control-contract";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "../state/commands";

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

async function checkedSnapshot(response: Response): Promise<SceneSnapshot> {
  const payload = await responseJson(response);
  if (!response.ok) throw new SceneControlApiError(errorMessage(payload, response.status), response.status);
  try {
    return parseSceneSnapshot(payload);
  } catch (error) {
    throw new SceneControlApiError(
      error instanceof Error ? error.message : "Scene-control response is invalid",
      response.status,
    );
  }
}

export async function fetchControlledScene(signal?: AbortSignal): Promise<SceneSnapshot> {
  return checkedSnapshot(await fetch("/api/scene", {
    headers: { Accept: "application/json" },
    signal,
  }));
}

export async function replaceControlledScene(
  expectedRevision: number,
  document: StudioDocument,
  signal?: AbortSignal,
): Promise<SceneSnapshot> {
  return checkedSnapshot(await fetch("/api/scene", {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision,
      document: withoutRuntimeReferenceUrls(document),
    }),
    signal,
  }));
}

export async function applyControlledSceneCommands(
  expectedRevision: number,
  commands: readonly StudioCommand[],
  signal?: AbortSignal,
): Promise<SceneSnapshot> {
  return checkedSnapshot(await fetch("/api/scene/commands", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision, commands }),
    signal,
  }));
}

export async function runControlledScenePython(
  expectedRevision: number,
  script: string,
  signal?: AbortSignal,
): Promise<ScenePythonResult> {
  const response = await fetch("/api/scene/python", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision, script }),
    signal,
  });
  const payload = await responseJson(response);
  if (!response.ok) throw new SceneControlApiError(errorMessage(payload, response.status), response.status);
  const snapshot = parseSceneSnapshot(payload);
  if (typeof payload !== "object" || payload === null || !("output" in payload) || typeof payload.output !== "string") {
    throw new SceneControlApiError("Python scene response is missing output", response.status);
  }
  return { ...snapshot, output: payload.output };
}
