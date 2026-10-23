import { validateStudioDocument } from "../src/domain/schema";
import { createDefaultStudioDocument } from "../src/domain/defaultDocument";
import {
  mergeRuntimeReferenceUrls,
  withoutRuntimeReferenceUrls,
} from "../src/api/scene-control-contract";
import {
  SceneConflictError,
  SceneRequestError,
  SceneStore,
} from "../src/server/sceneStore";
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
    const persisted: number[] = [];
    const store = new SceneStore({
      document: createDefaultStudioDocument(new Date("2026-01-01T00:00:00.000Z")),
      persist: async (document) => {
        persisted.push(document.table.width);
      },
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });

    const snapshot = await store.applyCommands(0, [
      { type: "table.parameters.update", patch: { width: 0.8 } },
      { type: "layer.visibility.set", layer: "collisions", visible: true },
      { type: "entity.upsert", entity: FIXTURE_BOX },
    ]);

    expect(snapshot.revision).toBe(1);
    expect(snapshot.persisted).toBe(true);
    expect(snapshot.document.table.width).toBe(0.8);
    expect(snapshot.document.layers.collisions).toBe(true);
    expect(snapshot.document.entities).toEqual([FIXTURE_BOX]);
    expect(snapshot.document.updatedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(persisted).toEqual([0.8]);
  });

  it("adds live viewport defaults when loading a document saved by an older Studio", () => {
    const current = createDefaultStudioDocument();
    const { viewport: _viewport, ...legacy } = current;

    expect(validateStudioDocument(legacy).viewport).toEqual(current.viewport);
  });

  it("adds empty live entities when loading an older scene document", () => {
    const current = createDefaultStudioDocument();
    const { entities: _entities, ...legacy } = current;

    expect(validateStudioDocument(legacy).entities).toEqual([]);
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
    ]);

    expect(store.snapshot().document.entities).toHaveLength(2);
    expect(store.snapshot().document.entities[1].name).toBe("Updated child");

    const removed = await store.applyCommands(1, [
      { type: "entity.remove", id: group.id },
    ]);
    expect(removed.document.entities).toEqual([]);
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
      { type: "table.parameters.update", patch: { width: 0.8 } },
    ]);

    await expect(store.applyCommands(0, [
      { type: "table.parameters.update", patch: { width: 0.9 } },
    ])).rejects.toBeInstanceOf(SceneConflictError);
    await expect(store.applyCommands(1, [])).rejects.toBeInstanceOf(SceneRequestError);
    expect(store.snapshot().document.table.width).toBe(0.8);
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
        persisted = next;
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
      command: { type: "table.parameters.update", patch: { width: 0.8 } },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const remote = { ...original, table: { ...original.table, width: 0.9 } };

    history = reduceStudioHistory(history, { type: "scene.synchronize", document: remote });

    expect(history.present.table.width).toBe(0.9);
    expect(history.past).toHaveLength(0);
    expect(history.future).toHaveLength(0);
  });
});
