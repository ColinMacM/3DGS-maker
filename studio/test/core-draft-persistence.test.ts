import { createDefaultStudioDocument } from "../src/domain/defaultDocument";
import { getReferenceAvailability } from "../src/domain/referenceAvailability";
import type { ReferenceLayer } from "../src/domain/types";
import {
  DraftPersistenceError,
  loadStudioDraft,
  saveStudioDraft,
  STUDIO_DRAFT_STORAGE_KEY,
} from "../src/persistence/localStorage";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function localReference(): ReferenceLayer {
  return {
    id: "local-scan",
    name: "fixture-scan.ply",
    kind: "point-cloud",
    objectUrl: "blob:https://studio.test/51fbc",
    transform: { position: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
    opacity: 0.6,
    visible: true,
  };
}

describe("core local draft persistence", () => {
  it("persists local reference metadata without pretending its Blob URL is durable", () => {
    const storage = new MemoryStorage();
    const document = { ...createDefaultStudioDocument(), references: [localReference()] };

    saveStudioDraft(document, storage);
    const storedText = storage.getItem(STUDIO_DRAFT_STORAGE_KEY);
    expect(storedText).not.toContain("blob:");

    const restored = loadStudioDraft(storage);
    expect(restored?.references[0]).toMatchObject({
      id: "local-scan",
      name: "fixture-scan.ply",
      kind: "point-cloud",
      visible: true,
    });
    expect(restored?.references[0].objectUrl).toBeUndefined();
    expect(getReferenceAvailability(restored!.references[0])).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("Re-import"),
    });
  });

  it("rejects a corrupt stored envelope", () => {
    const storage = new MemoryStorage();
    storage.setItem(STUDIO_DRAFT_STORAGE_KEY, JSON.stringify({ storageVersion: 9 }));

    expect(() => loadStudioDraft(storage)).toThrow(DraftPersistenceError);
  });
});
