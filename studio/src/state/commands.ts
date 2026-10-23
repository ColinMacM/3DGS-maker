import type {
  LayerVisibility,
  Measurement,
  ReferenceLayer,
  SceneEntity,
  TableParameters,
  Transform,
  ViewportSettings,
} from "../domain/types";

export interface ViewportSettingsPatch {
  overheadLight?: Partial<ViewportSettings["overheadLight"]>;
}

export type StudioCommand =
  | { type: "table.parameters.update"; patch: Partial<TableParameters> }
  | { type: "table.transform.update"; transform: Transform }
  | { type: "layer.visibility.set"; layer: keyof LayerVisibility; visible: boolean }
  | { type: "viewport.settings.update"; patch: ViewportSettingsPatch }
  | { type: "entity.upsert"; entity: SceneEntity }
  | { type: "entity.remove"; id: string }
  | { type: "reference.add"; reference: ReferenceLayer }
  | { type: "reference.remove"; id: string }
  | { type: "measurement.add"; measurement: Measurement }
  | { type: "measurement.remove"; id: string }
  | { type: "reset" };
