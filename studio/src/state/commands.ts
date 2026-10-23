import type {
  LayerVisibility,
  Measurement,
  ReferenceLayer,
  SceneCollisionBox,
  SceneBounds,
  SceneEntity,
  ViewPreset,
} from "../domain/types";
export type StudioCommand =
  | { type: "asset.select"; assetId: string; assetVersion: string }
  | { type: "viewport.preset.set"; preset: ViewPreset }
  | { type: "viewport.frame" }
  | { type: "layer.visibility.set"; layer: keyof LayerVisibility; visible: boolean }
  | { type: "entity.upsert"; entity: SceneEntity }
  | { type: "entity.remove"; id: string }
  | { type: "collision.upsert"; collision: SceneCollisionBox }
  | { type: "collision.remove"; id: string }
  | { type: "bounds.set"; bounds: SceneBounds[] }
  | { type: "reference.add"; reference: ReferenceLayer }
  | { type: "reference.remove"; id: string }
  | { type: "measurement.add"; measurement: Measurement }
  | { type: "measurement.remove"; id: string }
  | { type: "reset" };
