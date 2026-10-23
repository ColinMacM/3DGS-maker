import type { ReferenceLayer } from "../src/domain/types";
import { hydrateReferenceBlobs } from "../src/persistence/referenceBlobs";
import {
  MAX_MESH_REFERENCE_BYTES,
  MAX_SPLAT_REFERENCE_BYTES,
  validateReferenceImport,
} from "../src/persistence/referenceImport";

function unavailableReference(id: string): ReferenceLayer {
  return {
    id,
    name: `${id}.ply`,
    kind: "point-cloud",
    transform: { position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
    opacity: 0.75,
    visible: true,
  };
}

describe("reference Blob hydration", () => {
  it("creates fresh runtime URLs for stored bytes and leaves missing references unavailable", async () => {
    const stored = new Blob(["ply bytes"], { type: "application/octet-stream" });
    const references = [unavailableReference("stored"), unavailableReference("missing")];
    const loadedIds: string[] = [];

    const result = await hydrateReferenceBlobs(
      references,
      async (id) => {
        loadedIds.push(id);
        return id === "stored" ? stored : undefined;
      },
      (blob) => blob === stored ? "blob:https://studio.test/fresh" : "blob:unexpected",
    );

    expect(loadedIds).toEqual(["stored", "missing"]);
    expect(result.hydrated).toEqual([
      { id: "stored", objectUrl: "blob:https://studio.test/fresh" },
    ]);
    expect(result.failures).toEqual([]);
    expect(references.every((reference) => reference.objectUrl === undefined)).toBe(true);
    expect(references[1].visible).toBe(true);
  });

  it("reports storage failures without rejecting the whole hydration", async () => {
    const failure = new Error("browser storage denied");
    const result = await hydrateReferenceBlobs(
      [unavailableReference("denied")],
      async () => { throw failure; },
      () => "blob:unused",
    );

    expect(result.hydrated).toEqual([]);
    expect(result.failures).toEqual([
      { id: "denied", name: "denied.ply", error: failure },
    ]);
  });
});

describe("reference import validation", () => {
  it("accepts self-contained formats at their per-kind size limits", () => {
    expect(validateReferenceImport({ name: "fixture.GLB", size: MAX_MESH_REFERENCE_BYTES })).toEqual({
      kind: "mesh",
      maximumBytes: MAX_MESH_REFERENCE_BYTES,
    });
    expect(validateReferenceImport({ name: "scan.ply", size: MAX_SPLAT_REFERENCE_BYTES })).toEqual({
      kind: "splat",
      maximumBytes: MAX_SPLAT_REFERENCE_BYTES,
    });
  });

  it("rejects glTF sidecar documents and oversized references before persistence", () => {
    expect(() => validateReferenceImport({ name: "scene.gltf", size: 10 })).toThrow(
      /Unsupported reference file/,
    );
    expect(() => validateReferenceImport({
      name: "fixture.glb",
      size: MAX_MESH_REFERENCE_BYTES + 1,
    })).toThrow(/512 MiB/);
    expect(() => validateReferenceImport({
      name: "scan.splat",
      size: MAX_SPLAT_REFERENCE_BYTES + 1,
    })).toThrow(/1 GiB/);
  });
});
