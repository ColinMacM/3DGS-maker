import { validateStudioDocument } from "../src/domain/schema";
import { createDefaultStudioDocument } from "../src/domain/defaultDocument";
import {
  mergeRuntimeReferenceUrls,
  sceneDocumentSignature,
  withoutRuntimeReferenceUrls,
  type SceneCommandResult,
  type SceneSnapshot,
} from "../src/api/scene-control-contract";
import { controlledSnapshotChanged } from "../src/api/useSceneControlSync";
import { SceneApiClient, SceneApiError } from "../src/mcp/sceneClient";
import {
  parsePersistedSceneState,
  SceneConflictError,
  SceneRequestError,
  SceneStore,
  serializePersistedSceneState,
  type PersistedSceneState,
} from "../src/server/sceneStore";
import type { StudioCommand } from "../src/state/commands";
import { createStudioHistory, reduceStudioHistory } from "../src/state/history";

const IDENTITY_TRANSFORM = {
  position: [0, 0, 0] as [number, number, number],
  quaternionXyzw: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

const FIXTURE_BOX = {
  id: "fixture-stop",
  name: "Fixture stop",
  kind: "box" as const,
  visible: true,
  transform: IDENTITY_TRANSFORM,
  size: [0.12, 0.04, 0.08] as [number, number, number],
  material: {
    color: "#d88a32",
    opacity: 1,
  },
};

describe("revisioned scene control", () => {
  it("applies a semantic command transaction and persists before publishing it", async () => {
    const persisted: PersistedSceneState[] = [];
    const store = new SceneStore({
      state: {
        revision: 0,
        document: createDefaultStudioDocument(new Date("2026-01-01T00:00:00.000Z")),
      },
      persist: async (state) => {
        persisted.push(state);
      },
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });

    const snapshot = await store.applyCommands(0, [
      { type: "layer.visibility.set", layer: "collisions", visible: true },
      { type: "entity.upsert", entity: FIXTURE_BOX },
    ]);

    expect(snapshot.revision).toBe(1);
    expect(snapshot.changed).toBe(true);
    expect(snapshot.persisted).toBe(true);
    expect(snapshot.document.layers.collisions).toBe(true);
    expect(snapshot.document.entities).toEqual([FIXTURE_BOX]);
    expect(snapshot.document.updatedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(persisted.map((state) => [state.revision, state.document.entities.length])).toEqual([[1, 1]]);
  });

  it("reports no-op batches as unchanged without bumping or persisting the revision", async () => {
    let writes = 0;
    const store = new SceneStore({
      persist: async () => {
        writes += 1;
      },
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });
    const added = await store.applyCommands(0, [{ type: "entity.upsert", entity: FIXTURE_BOX }]);

    const removedMissing = await store.applyCommands(1, [{ type: "entity.remove", id: "missing" }]);
    const sameLayer = await store.applyCommands(1, [
      { type: "layer.visibility.set", layer: "collisions", visible: added.document.layers.collisions },
    ]);
    const sameDocument = await store.replace(1, added.document);

    for (const result of [removedMissing, sameLayer, sameDocument]) {
      expect(result.changed).toBe(false);
      expect(result.revision).toBe(1);
    }
    expect(writes).toBe(1);
  });

  it("keeps an unpersisted scene unpersisted when the browser pushes an identical document", async () => {
    let writes = 0;
    const store = new SceneStore({
      persist: async () => {
        writes += 1;
      },
    });

    const result = await store.replace(0, store.snapshot().document);

    expect(result).toMatchObject({ changed: false, revision: 0, persisted: false });
    expect(writes).toBe(0);
  });

  it("persists the revision with the document and restores it on re-creation", async () => {
    let file = "";
    const persist = async (state: PersistedSceneState): Promise<void> => {
      file = serializePersistedSceneState(state);
    };
    const first = new SceneStore({ persist });
    await first.applyCommands(0, [{ type: "entity.upsert", entity: FIXTURE_BOX }]);
    await first.applyCommands(1, [{ type: "layer.visibility.set", layer: "collisions", visible: true }]);

    const second = new SceneStore({ state: parsePersistedSceneState(JSON.parse(file)), persist });

    expect(second.snapshot()).toMatchObject({ revision: 2, persisted: true });
    expect(second.snapshot().document.entities).toEqual([FIXTURE_BOX]);
    await expect(second.applyCommands(0, [{ type: "entity.remove", id: FIXTURE_BOX.id }]))
      .rejects.toBeInstanceOf(SceneConflictError);
    expect((await second.applyCommands(2, [{ type: "entity.remove", id: FIXTURE_BOX.id }])).revision).toBe(3);
  });

  it("loads a legacy bare-document scene file at revision 0", () => {
    const document = createDefaultStudioDocument();

    const state = parsePersistedSceneState(JSON.parse(JSON.stringify(document)));

    expect(state.revision).toBe(0);
    expect(state.document).toEqual(withoutRuntimeReferenceUrls(document));
  });

  it("discards expired overlays on load even when they no longer validate", () => {
    const document = createDefaultStudioDocument();
    const overlay = {
      id: "voxel-query:voxels",
      label: "Voxels",
      position: [0, 0, 0],
      quaternionXyzw: [0, 0, 0, 1],
      size: [1, 1, 1],
      voxels: { voxelSizeM: 0.5, dimensions: [2, 2, 2], occupancy: "/w==" },
    };
    const raw = {
      stateFileVersion: 1,
      revision: 4,
      document: { ...document, bounds: [{ ...overlay, expiresAt: "2026-01-01T00:00:00.000Z" }] },
    };

    expect(parsePersistedSceneState(raw, new Date("2026-01-02T00:00:00.000Z")).document.bounds).toEqual([]);
    expect(() => parsePersistedSceneState(raw, new Date("2025-12-31T00:00:00.000Z"))).toThrow();
  });

  it("reports the viewer as connected only while browser heartbeats are fresh", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new SceneStore({ persist: async () => undefined, now: () => now });

    expect(store.snapshot().viewer).toEqual({ connected: false, lastSeenAt: null, renderErrors: [] });

    store.reportViewerStatus(["model:chair: HTTP 404"]);
    now = new Date("2026-01-01T00:00:05.000Z");
    expect(store.snapshot().viewer).toEqual({
      connected: true,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      renderErrors: ["model:chair: HTTP 404"],
    });

    now = new Date("2026-01-01T00:00:05.001Z");
    expect(store.snapshot().viewer.connected).toBe(false);

    store.reportViewerStatus([]);
    expect(store.snapshot().viewer).toEqual({
      connected: true,
      lastSeenAt: "2026-01-01T00:00:05.001Z",
      renderErrors: [],
    });
    expect(() => store.reportViewerStatus(new Array(33).fill("x"))).toThrow(SceneRequestError);
    expect(() => store.reportViewerStatus(["x".repeat(513)])).toThrow(SceneRequestError);
    expect(() => store.reportViewerStatus("broken")).toThrow(SceneRequestError);
  });

  it("adds live viewport defaults when loading a document saved by an older Studio", () => {
    const current = createDefaultStudioDocument();
    const { viewport: _viewport, ...legacy } = current;

    expect(validateStudioDocument(legacy).viewport).toEqual(current.viewport);
  });

  it("persists viewport camera presets", async () => {
    const store = new SceneStore({ persist: async () => undefined });

    const snapshot = await store.applyCommands(0, [{
      type: "viewport.preset.set",
      preset: "top",
    }]);

    expect(snapshot.document.viewport).toEqual({ preset: "top" });
  });

  it("accepts restarted-server snapshots when the revision number is reused", () => {
    const current = createDefaultStudioDocument();
    const restarted = {
      ...current,
      assetId: "reception-room",
      assetVersion: "1.0.0",
    };
    const snapshot: SceneSnapshot = {
      schemaVersion: 1 as const,
      revision: 0,
      persisted: true,
      document: restarted,
      viewer: { connected: true, lastSeenAt: null, renderErrors: [] },
    };

    expect(controlledSnapshotChanged(
      snapshot,
      0,
      sceneDocumentSignature(current),
    )).toBe(true);
    expect(controlledSnapshotChanged(
      snapshot,
      0,
      sceneDocumentSignature(restarted),
    )).toBe(false);
  });


  it("adds empty live entities when loading an older scene document", () => {
    const current = createDefaultStudioDocument();
    const { entities: _entities, ...legacy } = current;

    expect(validateStudioDocument(legacy).entities).toEqual([]);
  });
  it("adds empty authored collisions when loading an older scene document", () => {
    const current = createDefaultStudioDocument();
    const { collisions: _collisions, ...legacy } = current;

    expect(validateStudioDocument(legacy).collisions).toEqual([]);
  });

  it("adds empty splat bounds when loading an older scene document", () => {
    const current = createDefaultStudioDocument();
    const { bounds: _bounds, ...legacy } = current;

    expect(validateStudioDocument(legacy).bounds).toEqual([]);
  });

  it("replaces live splat bounds atomically", async () => {
    const store = new SceneStore({ persist: async () => undefined });
    const bounds = [{
      id: "splat-bound:table",
      label: "Table splat bounds",
      color: "#2f8cff",
      position: [1, 2, 3] as [number, number, number],
      quaternionXyzw: [0, 0, 0, 1] as [number, number, number, number],
      size: [1.4, 0.8, 0.05] as [number, number, number],
      expiresAt: "2030-01-01T00:00:00.000Z",
    }];

    const snapshot = await store.applyCommands(0, [{ type: "bounds.set", bounds }]);

    expect(snapshot.document.bounds).toEqual(bounds);
  });


  it("upserts entities by id and recursively removes group descendants", async () => {
    const store = new SceneStore({ persist: async () => undefined });
    const group = {
      id: "fixture",
      name: "Fixture",
      kind: "group" as const,
      visible: true,
      transform: IDENTITY_TRANSFORM,
    };
    const child = {
      ...FIXTURE_BOX,
      id: "child",
      parentId: group.id,
    };
    await store.applyCommands(0, [
      { type: "entity.upsert", entity: group },
      { type: "entity.upsert", entity: child },
      {
        type: "entity.upsert",
        entity: { ...child, name: "Updated child" },
      },
      {
        type: "collision.upsert",
        collision: {
          id: "child:collision",
          name: "Child collision",
          kind: "entity-box",
          entityId: child.id,
        },
      },
    ]);

    expect(store.snapshot().document.entities).toHaveLength(2);
    expect(store.snapshot().document.entities[1].name).toBe("Updated child");
    expect(store.snapshot().document.collisions).toEqual([{
      id: "child:collision",
      name: "Child collision",
      kind: "entity-box",
      entityId: child.id,
    }]);

    const removed = await store.applyCommands(1, [
      { type: "entity.remove", id: group.id },
    ]);
    expect(removed.document.entities).toEqual([]);
    expect(removed.document.collisions).toEqual([]);
  });

  it("rejects cyclic entity hierarchies and unsafe model sources", () => {
    const current = createDefaultStudioDocument();
    const group = (id: string, parentId: string) => ({
      id,
      parentId,
      name: id,
      kind: "group" as const,
      visible: true,
      transform: IDENTITY_TRANSFORM,
    });

    expect(() => validateStudioDocument({
      ...current,
      entities: [group("a", "b"), group("b", "a")],
    })).toThrow("must not form a cycle");
    expect(() => validateStudioDocument({
      ...current,
      entities: [{
        id: "unsafe",
        name: "Unsafe model",
        kind: "model",
        visible: true,
        transform: IDENTITY_TRANSFORM,
        source: "../unsafe.glb",
      }],
    })).toThrow("same-origin absolute GLB path");
  });

  it("drops removed Toby state from previously persisted documents", () => {
    const current = createDefaultStudioDocument();
    const legacy = {
      ...current,
      viewport: {
        ...current.viewport,
        toby: { visible: true, position: [-0.62, 0.48, 0], scale: 1.6 },
      },
    };

    expect(validateStudioDocument(legacy)).toEqual(current);
  });

  it("rejects stale revisions and malformed command batches", async () => {
    const store = new SceneStore({ persist: async () => undefined });
    await store.applyCommands(0, [
      { type: "entity.upsert", entity: FIXTURE_BOX },
    ]);

    await expect(store.applyCommands(0, [
      { type: "entity.upsert", entity: { ...FIXTURE_BOX, name: "Stale update" } },
    ])).rejects.toBeInstanceOf(SceneConflictError);
    await expect(store.applyCommands(1, [])).rejects.toBeInstanceOf(SceneRequestError);
    expect(store.snapshot().document.entities[0].name).toBe("Fixture stop");
  });

  it("never persists runtime object URLs", async () => {
    const original = createDefaultStudioDocument();
    const document = {
      ...original,
      references: [{
        id: "scan",
        name: "scan.ply",
        kind: "splat" as const,
        objectUrl: "blob:http://127.0.0.1/reference",
        transform: { position: [0, 0, 0] as const, quaternionXyzw: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const },
        opacity: 1,
        visible: true,
      }],
    };
    let persisted = original;
    const store = new SceneStore({
      persist: async (next) => {
        persisted = next.document;
      },
    });

    const snapshot = await store.replace(0, document);

    expect(snapshot.document.references[0].objectUrl).toBeUndefined();
    expect(snapshot.document.references[0].visible).toBe(true);
    expect(persisted.references[0].objectUrl).toBeUndefined();
    expect(JSON.stringify(withoutRuntimeReferenceUrls(document))).not.toContain("blob:");
  });

  it("merges browser-only reference URLs into remote revisions", () => {
    const local = {
      ...createDefaultStudioDocument(),
      references: [{
        id: "scan",
        name: "scan.glb",
        kind: "mesh" as const,
        objectUrl: "blob:http://127.0.0.1/scan",
        transform: { position: [0, 0, 0] as const, quaternionXyzw: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const },
        opacity: 1,
        visible: true,
      }],
    };
    const remote = withoutRuntimeReferenceUrls(local);

    expect(mergeRuntimeReferenceUrls(remote, local).references[0].objectUrl)
      .toBe("blob:http://127.0.0.1/scan");
  });

  it("treats remote synchronization as a new undo baseline", () => {
    const original = createDefaultStudioDocument();
    let history = createStudioHistory(original);
    history = reduceStudioHistory(history, {
      type: "command",
      command: { type: "entity.upsert", entity: FIXTURE_BOX },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const remote = { ...original, name: "Remote asset" };

    history = reduceStudioHistory(history, { type: "scene.synchronize", document: remote });

    expect(history.present.name).toBe("Remote asset");
    expect(history.past).toHaveLength(0);
    expect(history.future).toHaveLength(0);
  });

  describe("MCP scene client mutate", () => {
    const BASE_URL = "http://127.0.0.1:4174";

    function fakeStudio(store: SceneStore, beforePost?: (attempt: number) => Promise<void>, up = true) {
      let posts = 0;
      let running = up;
      const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!running) throw new TypeError("Unable to connect. Is the computer able to access the url?");
        const url = new URL(input instanceof Request ? input.url : input);
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
        if (url.pathname === "/api/health") return json({ ok: true });
        if (url.pathname === "/api/scene" && (init?.method ?? "GET") === "GET") return json(store.snapshot());
        if (url.pathname === "/api/scene/commands" && init?.method === "POST") {
          posts += 1;
          await beforePost?.(posts);
          const body = JSON.parse(String(init.body)) as { expectedRevision: number; commands: StudioCommand[] };
          try {
            return json(await store.applyCommands(body.expectedRevision, body.commands));
          } catch (error) {
            if (error instanceof SceneConflictError) {
              return json({ error: error.message, current: store.snapshot() }, 409);
            }
            throw error;
          }
        }
        return json({ error: "not found" }, 404);
      };
      return { fetchImpl: fetchImpl as typeof fetch, posts: () => posts, start: () => { running = true; } };
    }

    it("rebuilds commands from a fresh snapshot after a 409 instead of replaying stale ones", async () => {
      const store = new SceneStore({ persist: async () => undefined });
      await store.applyCommands(0, [{ type: "entity.upsert", entity: FIXTURE_BOX }]);
      const studio = fakeStudio(store, async (attempt) => {
        if (attempt !== 1) return;
        const current = store.snapshot();
        const entity = current.document.entities[0];
        await store.applyCommands(current.revision, [
          { type: "entity.upsert", entity: { ...entity, visible: false } },
        ]);
      });
      const client = new SceneApiClient(BASE_URL, { fetchImpl: studio.fetchImpl });
      const seenRevisions: number[] = [];

      const { before, after } = await client.mutate((snapshot) => {
        seenRevisions.push(snapshot.revision);
        const entity = snapshot.document.entities[0];
        return [{ type: "entity.upsert", entity: { ...entity, name: "Renamed" } }];
      });

      expect(seenRevisions).toEqual([1, 2]);
      expect(studio.posts()).toBe(2);
      expect(before.revision).toBe(2);
      expect(after.changed).toBe(true);
      expect(after.revision).toBe(3);
      expect(after.document.entities[0]).toMatchObject({ name: "Renamed", visible: false });
    });

    it("gives up with a 409 SceneApiError after three conflicting attempts", async () => {
      const store = new SceneStore({ persist: async () => undefined });
      let toggle = false;
      const studio = fakeStudio(store, async () => {
        toggle = !toggle;
        await store.applyCommands(store.currentRevision, [
          { type: "layer.visibility.set", layer: "collisions", visible: toggle },
        ]);
      });
      const client = new SceneApiClient(BASE_URL, { fetchImpl: studio.fetchImpl });

      const failure = client.mutate(() => [{ type: "entity.upsert", entity: FIXTURE_BOX }]);

      await expect(failure).rejects.toBeInstanceOf(SceneApiError);
      await expect(failure).rejects.toMatchObject({ status: 409 });
      expect(studio.posts()).toBe(3);
      expect(store.snapshot().document.entities).toEqual([]);
    });

    it("returns an unchanged result without posting when the builder yields no commands", async () => {
      const store = new SceneStore({ persist: async () => undefined });
      const studio = fakeStudio(store);
      const client = new SceneApiClient(BASE_URL, { fetchImpl: studio.fetchImpl });

      const { before, after }: { before: SceneSnapshot; after: SceneCommandResult } = await client.mutate(() => []);

      expect(studio.posts()).toBe(0);
      expect(after).toEqual({ ...before, changed: false });
    });

    it("starts an unreachable scene API once for concurrent calls, then retries", async () => {
      const store = new SceneStore({ persist: async () => undefined });
      const studio = fakeStudio(store, undefined, false);
      let starts = 0;
      const client = new SceneApiClient(BASE_URL, {
        fetchImpl: studio.fetchImpl,
        startServer: async () => {
          starts += 1;
          studio.start();
        },
      });

      const [first, second] = await Promise.all([client.snapshot(), client.snapshot()]);

      expect(starts).toBe(1);
      expect(first.revision).toBe(second.revision);
    });

    it("reports an unreachable scene API without a starter instead of hanging", async () => {
      const studio = fakeStudio(new SceneStore({ persist: async () => undefined }), undefined, false);
      const client = new SceneApiClient(BASE_URL, { fetchImpl: studio.fetchImpl });

      await expect(client.snapshot()).rejects.toMatchObject({ status: 503, message: /bun run dev:server/ });
    });
  });
});
