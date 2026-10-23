export type Vec3 = readonly [number, number, number];
export type QuaternionXyzw = readonly [number, number, number, number];

export interface Transform {
  position: Vec3;
  quaternionXyzw: QuaternionXyzw;
  scale: Vec3;
}

export interface TableParameters {
  width: number;
  length: number;
  topThickness: number;
  topHeight: number;
  holeDiameter: number;
  holePitch: number;
  rows: number;
  columns: number;
  edgeToHole: number;
  legSize: number;
}

export interface LayerVisibility {
  catalogVisuals: boolean;
  parametricModel: boolean;
  collisions: boolean;
  reference: boolean;
  measurements: boolean;
}

export interface OverheadLightSettings {
  enabled: boolean;
  color: string;
  intensity: number;
  position: Vec3;
  target: Vec3;
}

export interface ViewportSettings {
  overheadLight: OverheadLightSettings;
}

export interface SceneMaterial {
  color: string;
  metalness: number;
  roughness: number;
  opacity: number;
}

export type SceneEntityKind =
  | "box"
  | "sphere"
  | "cylinder"
  | "capsule"
  | "model"
  | "directional-light"
  | "point-light"
  | "group"
  | "label";

interface SceneEntityBase {
  id: string;
  name: string;
  kind: SceneEntityKind;
  visible: boolean;
  parentId?: string;
  transform: Transform;
}

export interface BoxSceneEntity extends SceneEntityBase {
  kind: "box";
  size: Vec3;
  material: SceneMaterial;
}

export interface SphereSceneEntity extends SceneEntityBase {
  kind: "sphere";
  radius: number;
  material: SceneMaterial;
}

export interface CylinderSceneEntity extends SceneEntityBase {
  kind: "cylinder";
  radius: number;
  height: number;
  material: SceneMaterial;
}

export interface CapsuleSceneEntity extends SceneEntityBase {
  kind: "capsule";
  radius: number;
  height: number;
  material: SceneMaterial;
}

export interface ModelSceneEntity extends SceneEntityBase {
  kind: "model";
  source: string;
}

export interface DirectionalLightSceneEntity extends SceneEntityBase {
  kind: "directional-light";
  color: string;
  intensity: number;
  target: Vec3;
}

export interface PointLightSceneEntity extends SceneEntityBase {
  kind: "point-light";
  color: string;
  intensity: number;
  distance: number;
}

export interface GroupSceneEntity extends SceneEntityBase {
  kind: "group";
}

export interface LabelSceneEntity extends SceneEntityBase {
  kind: "label";
  text: string;
  color: string;
  backgroundColor: string;
  size: number;
}

export type SceneEntity =
  | BoxSceneEntity
  | SphereSceneEntity
  | CylinderSceneEntity
  | CapsuleSceneEntity
  | ModelSceneEntity
  | DirectionalLightSceneEntity
  | PointLightSceneEntity
  | GroupSceneEntity
  | LabelSceneEntity;

export interface Measurement {
  id: string;
  label: string;
  start: Vec3;
  end: Vec3;
}

export type ReferenceKind = "splat" | "mesh" | "point-cloud";

export interface ReferenceLayer {
  id: string;
  name: string;
  kind: ReferenceKind;
  objectUrl?: string;
  transform: Transform;
  opacity: number;
  visible: boolean;
}

export interface StudioDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  units: "m";
  upAxis: "Z";
  assetId: string;
  assetVersion: string;
  table: TableParameters;
  tableTransform: Transform;
  layers: LayerVisibility;
  viewport: ViewportSettings;
  entities: SceneEntity[];
  references: ReferenceLayer[];
  measurements: Measurement[];
  updatedAt: string;
}

export interface CollisionBox {
  name: string;
  pos: Vec3;
  quatWxyz: readonly [number, number, number, number];
  size: Vec3;
}

export interface CatalogEntry {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  thumbnail?: string;
  units: "m";
  upAxis: "Z";
  browser: { glb: string };
  manifest: string;
  source: { blend: string };
  simulator: { openUsd: string; mujoco: string };
  capabilities: readonly string[];
}

export type ToolMode = "select" | "translate" | "rotate" | "measure";
export type BuildTarget = "blender" | "openusd" | "mujoco";

export interface BuildResult {
  ok: boolean;
  target: BuildTarget;
  command: string;
  output: string;
  artifact?: string;
}

export interface ViewportStatus {
  ready: boolean;
  cursor: Vec3 | null;
  selectedId: string | null;
  message: string;
}
