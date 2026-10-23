import type { StudioDocument } from "./types";

/** Creates a fresh metric, Z-up document for a catalog-backed asset package. */
export function createDefaultStudioDocument(now = new Date()): StudioDocument {
  return {
    schemaVersion: 3,
    id: "asset-studio-scene",
    name: "Untitled asset",
    units: "m",
    upAxis: "Z",
    assetId: "welding-cell",
    assetVersion: "1.2.0",
    layers: {
      catalogVisuals: true,
      assetVisuals: true,
      collisions: false,
      reference: true,
      measurements: true,
    },
    viewport: { preset: "perspective" },
    entities: [],
    collisions: [],
    bounds: [],
    references: [],
    measurements: [],
    updatedAt: now.toISOString(),
  };
}
