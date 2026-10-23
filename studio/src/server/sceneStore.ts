import { createDefaultStudioDocument } from "../domain/defaultDocument";
import { validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";
import type { StudioCommand } from "../state/commands";
import { reduceStudioDocument } from "../state/reducer";
import {
  SCENE_CONTROL_SCHEMA_VERSION,
  withoutRuntimeReferenceUrls,
  type SceneSnapshot,
} from "../api/scene-control-contract";

const MAX_COMMANDS_PER_BATCH = 100;
const COMMAND_TYPES: Readonly<Record<StudioCommand["type"], true>> = {
  "table.parameters.update": true,
  "table.transform.update": true,
  "layer.visibility.set": true,
  "viewport.settings.update": true,
  "entity.upsert": true,
  "entity.remove": true,
  "reference.add": true,
  "reference.remove": true,
  "measurement.add": true,
  "measurement.remove": true,
  reset: true,
};

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
  document?: StudioDocument;
  persisted?: boolean;
  persist(document: StudioDocument): Promise<void>;
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
  private revision = 0;
  private persisted: boolean;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly persistDocument: (document: StudioDocument) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: SceneStoreOptions) {
    this.document = withoutRuntimeReferenceUrls(
      options.document ?? createDefaultStudioDocument(),
    );
    this.persisted = options.persisted ?? options.document !== undefined;
    this.persistDocument = options.persist;
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): SceneSnapshot {
    return {
      schemaVersion: SCENE_CONTROL_SCHEMA_VERSION,
      revision: this.revision,
      persisted: this.persisted,
      document: structuredClone(this.document),
    };
  }

  replace(expectedRevision: unknown, value: unknown): Promise<SceneSnapshot> {
    const revision = requireRevision(expectedRevision);
    return this.enqueue(async () => {
      this.assertRevision(revision);
      const next = withoutRuntimeReferenceUrls(validateStudioDocument(value));
      return this.commit(next);
    });
  }

  applyCommands(expectedRevision: unknown, value: unknown): Promise<SceneSnapshot> {
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

  replaceFromPython(expectedRevision: unknown, value: unknown): Promise<SceneSnapshot> {
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

  private async commit(document: StudioDocument): Promise<SceneSnapshot> {
    const durable = withoutRuntimeReferenceUrls(document);
    await this.persistDocument(durable);
    this.document = durable;
    this.revision += 1;
    this.persisted = true;
    return this.snapshot();
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(mutation, mutation);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
