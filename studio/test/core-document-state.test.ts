import { createDefaultStudioDocument } from "../src/domain/defaultDocument";
import {
  parseStudioDocumentJson,
  serializeStudioDocument,
  StudioDocumentValidationError,
  validateStudioDocument,
} from "../src/domain/schema";
import { isCatalogAssetShown } from "../src/domain/sceneRules";
import type { ReferenceLayer } from "../src/domain/types";
import { encodeOccupancy } from "../src/domain/voxels";
import { createStudioHistory, reduceStudioHistory } from "../src/state/history";
import { reduceStudioDocument } from "../src/state/reducer";

function reference(id: string): ReferenceLayer {
  return {
    id,
    name: `${id}.ply`,
    kind: "point-cloud",
    objectUrl: `blob:https://studio.test/${id}`,
    transform: { position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
    opacity: 0.75,
    visible: true,
  };
}

const TABLE_PARAMETERS = {
  width: 0.762,
  length: 1.3716,
  topThickness: 0.1016,
  topHeight: 0.6477,
  holeDiameter: 0.01905,
  holePitch: 0.0508,
  rows: 26,
  columns: 13,
  edgeToHole: 0.0508,
  legSize: 0.0508,
};

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
  material: { color: "#d88a32", opacity: 1 },
};

describe("core studio document schema", () => {
  it("accepts a detached default asset document", () => {
    const original = createDefaultStudioDocument(new Date("2026-01-02T03:04:05.000Z"));
    const parsed = validateStudioDocument(original);

    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(parsed.entities).toEqual([]);
    expect(parsed.collisions).toEqual([]);
    expect(parsed.layers.assetVisuals).toBe(true);
    expect(parsed.units).toBe("m");
    expect(parsed.upAxis).toBe("Z");
  });

  it("migrates persisted v1 lighting state to the fullbright v2 contract", () => {
    const current = createDefaultStudioDocument();
    const legacy = {
      ...current,
      schemaVersion: 1,
      assetVersion: "1.0.0",
      viewport: {
        overheadLight: {
          enabled: true,
          color: "#ffffff",
          intensity: 4,
          position: [0, 0, 4],
          target: [0, 0, 0],
        },
      },
      entities: [
        {
          id: "fixture",
          name: "Fixture",
          kind: "box",
          visible: true,
          transform: { position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
          size: [1, 1, 1],
          material: { color: "#808080", metalness: 0.8, roughness: 0.2, opacity: 1 },
        },
        {
          id: "old-light",
          name: "Old light",
          kind: "point-light",
          visible: true,
          transform: { position: [0, 0, 2], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
          color: "#ffffff",
          intensity: 3,
          distance: 0,
        },
      ],
      table: TABLE_PARAMETERS,
      tableTransform: IDENTITY_TRANSFORM,
    };

    const migrated = validateStudioDocument(legacy);

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.assetVersion).toBe("1.2.0");
    expect(migrated.viewport).toEqual({ preset: "perspective" });
    // welding-cell 1.1.0 hid the built-in table, so the hidden table is dropped.
    expect(migrated.entities).toHaveLength(1);
    expect(migrated.entities[0]).toMatchObject({
      id: "fixture",
      material: { color: "#808080", opacity: 1 },
    });
  });

  it("migrates a shown v2 built-in table to a visible procedural entity", () => {
    const current = createDefaultStudioDocument();
    const migrated = validateStudioDocument({
      ...current,
      schemaVersion: 2,
      assetId: "custom-cell",
      layers: { ...current.layers, parametricModel: true },
      table: TABLE_PARAMETERS,
      tableTransform: IDENTITY_TRANSFORM,
    });

    expect(migrated.entities).toEqual([expect.objectContaining({
      id: "generated-fixture",
      kind: "procedural",
      visible: true,
      parameters: TABLE_PARAMETERS,
    })]);
    expect(isCatalogAssetShown(migrated)).toBe(false);
  });

  it("drops a hidden v2 built-in table instead of migrating an invisible entity", () => {
    const current = createDefaultStudioDocument();
    const migrated = validateStudioDocument({
      ...current,
      schemaVersion: 2,
      assetId: "custom-cell",
      layers: { ...current.layers, parametricModel: false },
      table: TABLE_PARAMETERS,
      tableTransform: IDENTITY_TRANSFORM,
    });

    expect(migrated.entities).toEqual([]);
    expect(isCatalogAssetShown(migrated)).toBe(true);
  });

  it("adds 3D asset visibility to earlier current documents", () => {
    const current = createDefaultStudioDocument();
    const { assetVisuals: _assetVisuals, ...legacyLayers } = current.layers;

    const migrated = validateStudioDocument({
      ...current,
      layers: legacyLayers,
    });

    expect(migrated.layers.catalogVisuals).toBe(true);
    expect(migrated.layers.assetVisuals).toBe(true);
  });

  it("reports deterministic field paths for invalid input", () => {
    const invalid = { ...createDefaultStudioDocument(), schemaVersion: 99, units: "mm" };

    expect(() => validateStudioDocument(invalid)).toThrow(StudioDocumentValidationError);
    try {
      validateStudioDocument(invalid);
    } catch (error) {
      const validation = error as StudioDocumentValidationError;
      expect(validation.issues).toEqual(expect.arrayContaining([
        { path: "$.schemaVersion", message: "must equal 3" },
        { path: "$.units", message: 'must equal "m"' },
      ]));
    }
  });

  it("rejects scene complexity that exceeds renderer bounds", () => {
    const oversized = {
      ...createDefaultStudioDocument(),
      measurements: Array.from({ length: 129 }, (_, index) => ({
        id: `measurement-${index}`,
        label: `${index} m`,
        start: [0, 0, 0],
        end: [1, 0, 0],
      })),
    };

    expect(() => validateStudioDocument(oversized)).toThrow(StudioDocumentValidationError);
  });

  it("omits process-local Blob URLs from JSON exports", () => {
    const document = {
      ...createDefaultStudioDocument(),
      references: [reference("scan")],
    };
    const text = serializeStudioDocument(document);
    const imported = parseStudioDocumentJson(text);

    expect(text).not.toContain("blob:");
    expect(imported.references[0]).toMatchObject({ id: "scan", visible: false });
    expect(imported.references[0].objectUrl).toBeUndefined();
  });

  it("validates viewport.frameRequest as a nonnegative integer", () => {
    const current = createDefaultStudioDocument();

    expect(validateStudioDocument({ ...current, viewport: { preset: "top", frameRequest: 4 } }).viewport)
      .toEqual({ preset: "top", frameRequest: 4 });
    for (const frameRequest of [-1, 1.5, "2"]) {
      expect(() => validateStudioDocument({ ...current, viewport: { preset: "top", frameRequest } }))
        .toThrow(StudioDocumentValidationError);
    }
  });

  it("accepts run-length voxel overlays and rejects occupancy that does not match the grid", () => {
    const current = createDefaultStudioDocument();
    const occupied = Uint8Array.of(1, 0, 0, 1, 1, 0);
    const overlay = {
      id: "voxel-query:table",
      label: "Voxels · table",
      position: [0, 0, 0],
      quaternionXyzw: [0, 0, 0, 1],
      size: [0.3, 0.2, 0.1],
      voxels: { voxelSizeM: 0.1, dimensions: [3, 2, 1], occupancy: encodeOccupancy(occupied) },
    };

    expect(validateStudioDocument({ ...current, bounds: [overlay] }).bounds[0].voxels?.dimensions)
      .toEqual([3, 2, 1]);
    expect(() => validateStudioDocument({
      ...current,
      bounds: [{ ...overlay, voxels: { ...overlay.voxels, dimensions: [3, 3, 1] } }],
    })).toThrow(StudioDocumentValidationError);
    expect(() => validateStudioDocument({
      ...current,
      bounds: [{ ...overlay, voxels: { ...overlay.voxels, occupancy: "not base64!" } }],
    })).toThrow(StudioDocumentValidationError);
  });
});

describe("catalog asset rule", () => {
  const group = {
    id: "rig",
    name: "Rig",
    kind: "group" as const,
    visible: true,
    transform: IDENTITY_TRANSFORM,
  };

  it("shows the catalog GLB for an empty scene", () => {
    expect(isCatalogAssetShown(createDefaultStudioDocument())).toBe(true);
  });

  it("hides the catalog GLB once any entity is effectively visible", () => {
    const document = { ...createDefaultStudioDocument(), entities: [FIXTURE_BOX] };

    expect(isCatalogAssetShown(document)).toBe(false);
  });

  it("keeps the catalog GLB when every entity is invisible", () => {
    const document = {
      ...createDefaultStudioDocument(),
      entities: [{ ...FIXTURE_BOX, visible: false }],
    };

    expect(isCatalogAssetShown(document)).toBe(true);
  });

  it("treats a visible child under a hidden ancestor as hidden", () => {
    const document = {
      ...createDefaultStudioDocument(),
      entities: [{ ...group, visible: false }, { ...FIXTURE_BOX, parentId: "rig" }],
    };

    expect(isCatalogAssetShown(document)).toBe(true);
    expect(isCatalogAssetShown({
      ...document,
      entities: [group, { ...FIXTURE_BOX, parentId: "rig" }],
    })).toBe(false);
  });
});

describe("viewport frame command", () => {
  it("increments frameRequest on every viewport.frame, even with an unchanged preset", () => {
    const before = createDefaultStudioDocument(new Date("2026-01-01T00:00:00.000Z"));
    const once = reduceStudioDocument(before, { type: "viewport.frame" }, "2026-01-01T00:00:01.000Z");
    const twice = reduceStudioDocument(once, { type: "viewport.frame" }, "2026-01-01T00:00:02.000Z");

    expect(before.viewport.frameRequest).toBeUndefined();
    expect(once.viewport).toEqual({ preset: before.viewport.preset, frameRequest: 1 });
    expect(twice.viewport.frameRequest).toBe(2);
    expect(twice.updatedAt).toBe("2026-01-01T00:00:02.000Z");
  });

  it("keeps frameRequest when the preset changes", () => {
    const framed = reduceStudioDocument(createDefaultStudioDocument(), { type: "viewport.frame" });
    const top = reduceStudioDocument(framed, { type: "viewport.preset.set", preset: "top" });

    expect(top.viewport).toEqual({ preset: "top", frameRequest: 1 });
  });
});

describe("core immutable history", () => {
  it("does not mutate the prior document", () => {
    const before = createDefaultStudioDocument(new Date("2026-01-01T00:00:00.000Z"));
    const after = reduceStudioDocument(
      before,
      { type: "entity.upsert", entity: FIXTURE_BOX },
      "2026-01-01T00:00:01.000Z",
    );

    expect(before.entities).toEqual([]);
    expect(after.entities).toEqual([FIXTURE_BOX]);
    expect(after.entities).not.toBe(before.entities);
  });

  it("selects a catalog package as one atomic document edit", () => {
    const before = createDefaultStudioDocument();
    const after = reduceStudioDocument(
      before,
      { type: "asset.select", assetId: "warehouse", assetVersion: "2.0.0" },
      "2026-01-01T00:00:01.000Z",
    );

    expect(after.assetId).toBe("warehouse");
    expect(after.assetVersion).toBe("2.0.0");
    expect(before.assetId).toBe("welding-cell");
  });

  it("bounds undo history and clears redo after a new edit", () => {
    let history = createStudioHistory(createDefaultStudioDocument());
    for (let index = 0; index < 4; index += 1) {
      history = reduceStudioHistory(history, {
        type: "command",
        command: { type: "layer.visibility.set", layer: "collisions", visible: index % 2 === 0 },
        updatedAt: `2026-01-01T00:00:0${index}.000Z`,
      }, 2);
    }
    expect(history.past).toHaveLength(2);

    history = reduceStudioHistory(history, { type: "undo" }, 2);
    expect(history.future).toHaveLength(1);
    history = reduceStudioHistory(history, {
      type: "command",
      command: { type: "layer.visibility.set", layer: "collisions", visible: false },
      updatedAt: "2026-01-01T00:00:10.000Z",
    }, 2);
    expect(history.future).toHaveLength(0);
  });

  it("hydrates runtime reference URLs without adding an undo step", () => {
    const { objectUrl: _discarded, ...detachedReference } = reference("scan");
    let history = createStudioHistory({
      ...createDefaultStudioDocument(new Date("2026-01-01T00:00:00.000Z")),
      references: [detachedReference],
    });
    history = reduceStudioHistory(history, {
      type: "command",
      command: { type: "layer.visibility.set", layer: "collisions", visible: true },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const updatedAt = history.present.updatedAt;
    history = reduceStudioHistory(history, {
      type: "references.hydrate",
      references: [{ id: "scan", objectUrl: "blob:https://studio.test/fresh-scan" }],
    });

    expect(history.past).toHaveLength(1);
    expect(history.present.updatedAt).toBe(updatedAt);
    expect(history.present.references[0].objectUrl).toBe("blob:https://studio.test/fresh-scan");
    history = reduceStudioHistory(history, { type: "undo" });
    expect(history.present.references[0].objectUrl).toBe("blob:https://studio.test/fresh-scan");
  });

  it("rejects invalid replacements without changing existing history", () => {
    const history = createStudioHistory(createDefaultStudioDocument());
    const invalid = { ...history.present, units: "mm" } as unknown;

    expect(() => reduceStudioHistory(history, { type: "replace", document: invalid as never })).toThrow();
    expect(history.present.units).toBe("m");
    expect(history.past).toHaveLength(0);
  });
});
