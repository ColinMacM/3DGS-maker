import type { BuildResult, BuildTarget } from "../domain/types";

export const BUILD_TARGETS = ["blender", "openusd", "mujoco"] as const satisfies readonly BuildTarget[];

export function isBuildTarget(value: unknown): value is BuildTarget {
  return typeof value === "string" && BUILD_TARGETS.some((target) => target === value);
}

function isBuildResult(value: unknown): value is BuildResult {
  if (typeof value !== "object" || value === null) return false;
  return (
    "ok" in value &&
    typeof value.ok === "boolean" &&
    "target" in value &&
    isBuildTarget(value.target) &&
    "command" in value &&
    typeof value.command === "string" &&
    "output" in value &&
    typeof value.output === "string" &&
    (!("artifact" in value) || value.artifact === undefined || typeof value.artifact === "string")
  );
}

function errorMessage(value: unknown, status: number): string {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = value.error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return `Build request failed with HTTP ${status}`;
}

export class BuildRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BuildRequestError";
    this.status = status;
  }
}

export async function requestBuild(target: BuildTarget, signal?: AbortSignal): Promise<BuildResult> {
  const response = await fetch("/api/build", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target }),
    signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BuildRequestError(`Build server returned invalid JSON (HTTP ${response.status})`, response.status);
  }

  if (isBuildResult(payload) && payload.target === target) return payload;
  throw new BuildRequestError(errorMessage(payload, response.status), response.status);
}
