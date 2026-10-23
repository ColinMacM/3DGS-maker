import { createDefaultStudioDocument } from "../src/domain/defaultDocument";
import {
  parseStudioDocumentJson,
  serializeStudioDocument,
  StudioDocumentValidationError,
  validateStudioDocument,
} from "../src/domain/schema";
import type { ReferenceLayer } from "../src/domain/types";
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

describe("core studio document schema", () => {
  it("accepts a detached default welding-cell document", () => {
    const original = createDefaultStudioDocument(new Date("2026-01-02T03:04:05.000Z"));
    const parsed = validateStudioDocument(original);

    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(parsed.table.width).toBe(0.762);
    expect(parsed.units).toBe("m");
    expect(parsed.upAxis).toBe("Z");
  });

  it("reports deterministic field paths for invalid input", () => {
    const invalid = { ...createDefaultStudioDocument(), schemaVersion: 2, units: "mm" };

    expect(() => validateStudioDocument(invalid)).toThrow(StudioDocumentValidationError);
    try {
      validateStudioDocument(invalid);
    } catch (error) {
      const validation = error as StudioDocumentValidationError;
      expect(validation.issues).toEqual(expect.arrayContaining([
        { path: "$.schemaVersion", message: "must equal 1" },
        { path: "$.units", message: 'must equal "m"' },
      ]));
    }
  });

  it("rejects scene complexity that exceeds renderer bounds", () => {
    const document = createDefaultStudioDocument();
    const oversized = {
      ...document,
      table: { ...document.table, rows: 1_000_000_000 },
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
});

describe("core immutable history", () => {
  it("does not mutate the prior document", () => {
    const before = createDefaultStudioDocument(new Date("2026-01-01T00:00:00.000Z"));
    const after = reduceStudioDocument(
      before,
      { type: "table.parameters.update", patch: { width: 0.9 } },
      "2026-01-01T00:00:01.000Z",
    );

    expect(before.table.width).toBe(0.762);
    expect(after.table.width).toBe(0.9);
    expect(after.table).not.toBe(before.table);
  });

  it("bounds undo history and clears redo after a new edit", () => {
    let history = createStudioHistory(createDefaultStudioDocument());
    for (let index = 0; index < 4; index += 1) {
      history = reduceStudioHistory(history, {
        type: "command",
        command: { type: "table.parameters.update", patch: { width: 0.8 + index / 10 } },
        updatedAt: `2026-01-01T00:00:0${index}.000Z`,
      }, 2);
    }
    expect(history.past).toHaveLength(2);

    history = reduceStudioHistory(history, { type: "undo" }, 2);
    expect(history.future).toHaveLength(1);
    history = reduceStudioHistory(history, {
      type: "command",
      command: { type: "layer.visibility.set", layer: "collisions", visible: true },
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
