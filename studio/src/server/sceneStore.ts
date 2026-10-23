import { createDefaultStudioDocument } from "../domain/defaultDocument";
import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "../state/commands";
import { reduceStudioDocument } from "../state/reducer";
import {
  parseViewerRenderErrors,
  SCENE_CONTROL_SCHEMA_VERSION,
  sceneDocumentSignature,
  VIEWER_HEARTBEAT_TIMEOUT_MS,
  withoutRuntimeReferenceUrls,
  type SceneCommandResult,
  type SceneSnapshot,
  type SceneViewerStatus,
} from "../api/scene-control-contract";

const MAX_COMMANDS_PER_BATCH = 100;
const COMMAND_TYPES: Readonly<Record<StudioCommand["type"], true>> = {
  "asset.select": true,
  "viewport.preset.set": true,
  "viewport.frame": true,
  "layer.visibility.set": true,
  "entity.upsert": true,
  "entity.remove": true,
  "collision.upsert": true,
  "collision.remove": true,
  "bounds.set": true,
  "reference.add": true,
  "reference.remove": true,
  "measurement.add": true,
  "measurement.remove": true,
  reset: true,
};

/** Version of the `.asset-studio/scene.json` wrapper (not the document's own schemaVersion). */
export const SCENE_STATE_FILE_VERSION = 1 as const;

/** Durable scene state: the document plus the revision that published it. */
export interface PersistedSceneState {
  revision: number;
  document: StudioDocument;
}

/**
 * Overlays are transient: expired bounds are discarded before validation so an
 * outdated overlay (including one written in a superseded encoding) never blocks loading.
 */
function withoutExpiredBounds(document: unknown, now: Date): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return document;
  const record = document as Record<string, unknown>;
  if (!Array.isArray(record.bounds)) return document;
  return {
    ...record,
    bounds: record.bounds.filter((item) => {
      const expiresAt = (item as { expiresAt?: unknown } | null)?.expiresAt;
      return typeof expiresAt !== "string" || !(Date.parse(expiresAt) <= now.getTime());
    }),
  };
}

/**
 * Parses `.asset-studio/scene.json`. Current files are
 * `{ stateFileVersion: 1, revision, document }`; older files hold the bare
 * document and load at revision 0.
 */
export function parsePersistedSceneState(value: unknown, now = new Date()): PersistedSceneState {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "stateFileVersion" in value
  ) {
    const state = value as Record<string, unknown>;
    if (state.stateFileVersion !== SCENE_STATE_FILE_VERSION) {
      throw new Error(`Unsupported scene state file version ${String(state.stateFileVersion)}`);
    }
    if (!Number.isInteger(state.revision) || (state.revision as number) < 0) {
      throw new Error("Scene state revision must be a nonnegative integer");
    }
    return {
      revision: state.revision as number,
      document: withoutRuntimeReferenceUrls(validateStudioDocument(withoutExpiredBounds(state.document, now))),
    };
  }
  return {
    revision: 0,
    document: withoutRuntimeReferenceUrls(validateStudioDocument(withoutExpiredBounds(value, now))),
  };
}

export function serializePersistedSceneState(state: PersistedSceneState): string {
  return `${JSON.stringify({
    stateFileVersion: SCENE_STATE_FILE_VERSION,
    revision: state.revision,
    document: state.document,
  }, null, 2)}\n`;
}

export class SceneConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Scene revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`);
    this.name = "SceneConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class SceneRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SceneRequestError";
  }
}

export interface SceneStoreOptions {
  /** State loaded from disk; omit when no scene file exists (the store starts unpersisted at revision 0). */
  state?: PersistedSceneState;
  persist(state: PersistedSceneState): Promise<void>;
  now?: () => Date;
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new SceneRequestError("expectedRevision must be a nonnegative integer");
  }
  return value as number;
}

function parseCommand(value: unknown, index: number): StudioCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SceneRequestError(`commands[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || COMMAND_TYPES[record.type as StudioCommand["type"]] !== true) {
    throw new SceneRequestError(`commands[${index}].type is not supported`);
  }
  return record as unknown as StudioCommand;
}

function parseCommands(value: unknown): StudioCommand[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SceneRequestError("commands must be a non-empty array");
  }
  if (value.length > MAX_COMMANDS_PER_BATCH) {
    throw new SceneRequestError(`commands may contain at most ${MAX_COMMANDS_PER_BATCH} items`);
  }
  return value.map(parseCommand);
}

export class SceneStore {
  private document: StudioDocument;
  private revision: number;
  private persisted: boolean;
  private viewerLastSeen: Date | null = null;
  private viewerRenderErrors: string[] = [];
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly persistState: (state: PersistedSceneState) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: SceneStoreOptions) {
    this.document = withoutRuntimeReferenceUrls(
      options.state?.document ?? createDefaultStudioDocument(),
    );
    this.revision = options.state?.revision ?? 0;
    this.persisted = options.state !== undefined;
    this.persistState = options.persist;
    this.now = options.now ?? (() => new Date());
  }

  get currentRevision(): number {
    return this.revision;
  }

  snapshot(): SceneSnapshot {
    return {
      schemaVersion: SCENE_CONTROL_SCHEMA_VERSION,
      revision: this.revision,
      persisted: this.persisted,
      document: structuredClone(this.document),
      viewer: this.viewerStatus(),
    };
  }

  /** Current document without cloning; callers must not mutate it. */
  currentDocument(): Readonly<StudioDocument> {
    return this.document;
  }

  viewerStatus(): SceneViewerStatus {
    const lastSeen = this.viewerLastSeen;
    return {
      connected: lastSeen !== null
        && this.now().getTime() - lastSeen.getTime() <= VIEWER_HEARTBEAT_TIMEOUT_MS,
      lastSeenAt: lastSeen?.toISOString() ?? null,
      renderErrors: [...this.viewerRenderErrors],
    };
  }

  /** Records a browser heartbeat together with its current render/load failures. */
  reportViewerStatus(renderErrors: unknown): void {
    let parsed: string[];
    try {
      parsed = parseViewerRenderErrors(renderErrors);
    } catch (error) {
      throw new SceneRequestError(
        error instanceof Error ? error.message : "renderErrors is invalid",
        { cause: error },
      );
    }
    this.viewerLastSeen = this.now();
    this.viewerRenderErrors = parsed;
  }

  replace(expectedRevision: unknown, value: unknown): Promise<SceneCommandResult> {
    const revision = requireRevision(expectedRevision);
    return this.enqueue(async () => {
      this.assertRevision(revision);
      const next = withoutRuntimeReferenceUrls(validateStudioDocument(value));
      return this.commit(next);
    });
  }

  applyCommands(expectedRevision: unknown, value: unknown): Promise<SceneCommandResult> {
    return this.enqueue(async () => {
      const revision = requireRevision(expectedRevision);
      const commands = parseCommands(value);
      this.assertRevision(revision);
      let next = this.document;
      const updatedAt = this.now().toISOString();
      try {
        for (const command of commands) {
          next = reduceStudioDocument(next, command, updatedAt);
        }
      } catch (error) {
        throw new SceneRequestError(
          error instanceof Error ? error.message : "Scene command validation failed",
          { cause: error },
        );
      }
      return this.commit(next);
    });
  }

  replaceFromPython(expectedRevision: unknown, value: unknown): Promise<SceneCommandResult> {
    const revision = requireRevision(expectedRevision);
    return this.enqueue(async () => {
      this.assertRevision(revision);
      const input = validateStudioDocument(value);
      const next = withoutRuntimeReferenceUrls({
        ...input,
        updatedAt: this.now().toISOString(),
      });
      return this.commit(next);
    });
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.revision) {
      throw new SceneConflictError(expectedRevision, this.revision);
    }
  }

  /**
   * Publishes `document` as the next revision. A document whose content equals the
   * current one (ignoring `updatedAt`) is a no-op: nothing is persisted, the revision
   * stays, and the result reports `changed: false`.
   */
  private async commit(document: StudioDocument): Promise<SceneCommandResult> {
    const durable = withoutRuntimeReferenceUrls(document);
    if (
      sceneDocumentSignature({ ...durable, updatedAt: this.document.updatedAt })
      === sceneDocumentSignature(this.document)
    ) {
      return { ...this.snapshot(), changed: false };
    }
    const revision = this.revision + 1;
    await this.persistState({ revision, document: durable });
    this.document = durable;
    this.revision = revision;
    this.persisted = true;
    return { ...this.snapshot(), changed: true };
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(mutation, mutation);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
