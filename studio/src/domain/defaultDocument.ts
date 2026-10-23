import type { StudioDocument, Transform, ViewportSettings } from "./types";

const IDENTITY_TRANSFORM: Transform = {
  position: [0, 0, 0],
  quaternionXyzw: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** Creates fresh agent-controlled settings for the live Three.js viewport. */
export function createDefaultViewportSettings(): ViewportSettings {
  return {
    overheadLight: {
      enabled: true,
      color: "#fff2d2",
      intensity: 4.4,
      position: [0, 0, 6],
      target: [0, 0, 0.58],
    },
  };
}

/** Creates a fresh metric, Z-up document for the welding-cell catalog asset. */
export function createDefaultStudioDocument(now = new Date()): StudioDocument {
  return {
    schemaVersion: 1,
    id: "welding-cell-scene",
    name: "Welding cell",
    units: "m",
    upAxis: "Z",
    assetId: "welding-cell",
    assetVersion: "1.0.0",
    table: {
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
    },
    tableTransform: {
      position: [...IDENTITY_TRANSFORM.position],
      quaternionXyzw: [...IDENTITY_TRANSFORM.quaternionXyzw],
      scale: [...IDENTITY_TRANSFORM.scale],
    },
    layers: {
      catalogVisuals: true,
      parametricModel: true,
      collisions: false,
      reference: true,
      measurements: true,
    },
    viewport: createDefaultViewportSettings(),
    entities: [],
    references: [],
    measurements: [],
    updatedAt: now.toISOString(),
  };
}
