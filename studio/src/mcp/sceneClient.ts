import { setTimeout as sleep } from "node:timers/promises";

import {
  parseSceneCommandResult,
  parseSceneSnapshot,
  type SceneCommandResult,
  type SceneSnapshot,
} from "../api/scene-control-contract";
import type { BuildResult, BuildTarget } from "../domain/types";
import type { StudioCommand } from "../state/commands";

const DEFAULT_STUDIO_URL = "http://127.0.0.1:4174";
const MAX_COMMANDS_PER_BATCH = 100;
const MAX_MUTATION_ATTEMPTS = 3;

interface ErrorPayload {
  error?: unknown;
  current?: unknown;
}

export class SceneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SceneApiError";
  }
}

export type SceneCommandBuilder = (
  snapshot: SceneSnapshot,
) => readonly StudioCommand[] | Promise<readonly StudioCommand[]>;

export interface SceneMutation {
  /** Snapshot the committed commands were built from. */
  before: SceneSnapshot;
  after: SceneCommandResult;
}

function errorMessage(payload: ErrorPayload, status: number): string {
  return typeof payload.error === "string" && payload.error.length > 0
    ? payload.error
    : `Scene Studio returned HTTP ${status}`;
}

export interface SceneApiClientOptions {
  fetchImpl?: typeof fetch;
  /**
   * Called when the scene API refuses the connection. It should start the
   * API; the client then waits for `/api/health` and retries the request once.
   */
  startServer?: () => Promise<void>;
  startTimeoutMs?: number;
}

export class SceneApiClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly startServer?: () => Promise<void>;
  private readonly startTimeoutMs: number;
  private starting: Promise<void> | null = null;

  constructor(
    value = process.env.SCENE_STUDIO_URL?.trim() || DEFAULT_STUDIO_URL,
    options: SceneApiClientOptions = {},
  ) {
    this.baseUrl = new URL(value.endsWith("/") ? value : `${value}/`);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.startServer = options.startServer;
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
  }

  /** Fetches from the scene API, starting it once if the connection is refused. */
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (!this.startServer) {
        throw new SceneApiError(
          `Scene API at ${this.baseUrl.origin} is unreachable (${error instanceof Error ? error.message : String(error)}). Start it with \`bun run dev:server\` in studio/.`,
          503,
        );
      }
      this.starting ??= this.startAndWait().finally(() => {
        this.starting = null;
      });
      await this.starting;
      return this.fetchImpl(url, init);
    }
  }

  private async startAndWait(): Promise<void> {
    await this.startServer!();
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(new URL("api/health", this.baseUrl));
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(200);
    }
    throw new SceneApiError(
      `Started the scene API but ${this.baseUrl.origin}/api/health did not respond within ${this.startTimeoutMs} ms (${lastError}). See .asset-studio/scene-server.log.`,
      503,
    );
  }

  async snapshot(): Promise<SceneSnapshot> {
    const response = await this.request("api/scene", {
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new SceneApiError(
        errorMessage(payload as ErrorPayload, response.status),
        response.status,
      );
    }
    return parseSceneSnapshot(payload);
  }

  /**
   * Builds commands from the current snapshot and posts them with optimistic
   * concurrency. On a revision conflict the commands are rebuilt from the
   * refreshed snapshot, never replayed; after three conflicts a 409
   * SceneApiError is thrown.
   */
  async mutate(build: SceneCommandBuilder): Promise<SceneMutation> {
    let before = await this.snapshot();
    let conflictMessage = "";
    for (let attempt = 1; attempt <= MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const commands = await build(before);
      if (commands.length === 0) return { before, after: { ...before, changed: false } };
      if (commands.length > MAX_COMMANDS_PER_BATCH) {
        throw new Error(`A Scene MCP call may apply at most ${MAX_COMMANDS_PER_BATCH} commands.`);
      }
      const { response, payload } = await this.postCommands(before.revision, commands);
      if (response.ok) return { before, after: parseSceneCommandResult(payload) };
      const error = payload as ErrorPayload;
      if (response.status !== 409) {
        throw new SceneApiError(errorMessage(error, response.status), response.status);
      }
      conflictMessage = errorMessage(error, response.status);
      if (attempt < MAX_MUTATION_ATTEMPTS) {
        before = error.current === undefined ? await this.snapshot() : parseSceneSnapshot(error.current);
      }
    }
    throw new SceneApiError(
      `The scene kept changing concurrently; gave up after ${MAX_MUTATION_ATTEMPTS} attempts (${conflictMessage}). Inspect the scene and retry.`,
      409,
    );
  }

  async build(target: BuildTarget): Promise<BuildResult> {
    const response = await this.request("api/build", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: this.baseUrl.origin,
      },
      body: JSON.stringify({ target }),
    });
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object"
      || payload === null
      || !("ok" in payload)
      || !("target" in payload)
      || payload.target !== target
      || !("assetId" in payload)
      || !("packageDirectory" in payload)
    ) {
      throw new SceneApiError(
        errorMessage(payload as ErrorPayload, response.status),
        response.status,
      );
    }
    return payload as BuildResult;
  }

  private async postCommands(
    expectedRevision: number,
    commands: readonly StudioCommand[],
  ): Promise<{ response: Response; payload: unknown }> {
    const response = await this.request("api/scene/commands", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: this.baseUrl.origin,
      },
      body: JSON.stringify({ expectedRevision, commands }),
    });
    return { response, payload: await response.json() };
  }
}
