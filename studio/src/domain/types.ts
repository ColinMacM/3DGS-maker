import type { VoxelOccupancy } from "./voxels";

export type Vec3 = readonly [number, number, number];
export type QuaternionXyzw = readonly [number, number, number, number];

export interface Transform {
  position: Vec3;
  quaternionXyzw: QuaternionXyzw;
  scale: Vec3;
}

export interface PerforatedTableParameters {
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
  assetVisuals: boolean;
  collisions: boolean;
  reference: boolean;
  measurements: boolean;
}

export type ViewPreset = "perspective" | "top" | "front" | "right";

export interface ViewportSettings {
  preset: ViewPreset;
  /**
   * Reframe nonce. Every `viewport.frame` command increments it and the viewport
   * reframes the visible scene whenever the value changes. Absent means 0.
   */
  frameRequest?: number;
}

export type BoxTextureFace =
  | "x-positive"
  | "x-negative"
  | "y-positive"
  | "y-negative"
  | "z-positive"
  | "z-negative";

export interface SceneTexture {
  dataUrl: string;
  face: BoxTextureFace;
  width: number;
  height: number;
}

export interface SceneMaterial {
  color: string;
  opacity: number;
  texture?: SceneTexture;
}

export type SceneEntityKind =
  | "box"
  | "sphere"
  | "cylinder"
  | "capsule"
  | "model"
  | "procedural"
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

export interface ProceduralSceneEntity extends SceneEntityBase {
  kind: "procedural";
  generator: "perforated-table";
  parameters: PerforatedTableParameters;
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
  | ProceduralSceneEntity
  | GroupSceneEntity
  | LabelSceneEntity;

export interface Measurement {
  id: string;
  label: string;
  start: Vec3;
  end: Vec3;
}

/**
 * Transient viewport overlay (user-facing only; agents never see the viewport).
 * Without `voxels` it renders as a wireframe box; with `voxels` it renders the
 * exposed voxel edges of that occupancy grid instead of the box outline.
 */
export interface SceneBounds {
  id: string;
  label: string;
  color?: string;
  position: Vec3;
  quaternionXyzw: QuaternionXyzw;
  size: Vec3;
  voxels?: VoxelOccupancy;
  expiresAt?: string;
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

export interface ExplicitSceneCollisionBox {
  id: string;
  name: string;
  kind: "box";
  position: Vec3;
  quaternionXyzw: QuaternionXyzw;
  size: Vec3;
}

export interface LinkedSceneCollisionBox {
  id: string;
  name: string;
  kind: "entity-box";
  entityId: string;
}

export type SceneCollisionBox =
  | ExplicitSceneCollisionBox
  | LinkedSceneCollisionBox;

export interface StudioDocument {
  schemaVersion: 3;
  id: string;
  name: string;
  units: "m";
  upAxis: "Z";
  assetId: string;
  assetVersion: string;
  entities: SceneEntity[];
  collisions: SceneCollisionBox[];
  bounds: SceneBounds[];
  layers: LayerVisibility;
  viewport: ViewportSettings;
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
  browser: {
    glb: string;
    spz?: {
      url: string;
      transform: Transform;
    };
  };
  manifest: string;
  simulator: { isaac: string; mujoco: string; unreal: string };
  capabilities: readonly string[];
}

export type ToolMode = "select" | "translate" | "rotate" | "measure";
export type BuildTarget = "isaac" | "mujoco" | "unreal";

export interface BuildResult {
  ok: boolean;
  target: BuildTarget;
  /** Catalog asset id whose package was exported (`document.assetId`). */
  assetId: string;
  packageDirectory: string;
  /** Exporters read only the package manifest; scene entities/colliders are never exported. */
  exportsSceneEntities: false;
  command: string;
  output: string;
  artifact?: string;
}

export interface ViewportStatus {
  ready: boolean;
  cursor: Vec3 | null;
  selectedId: string | null;
  message: string;
  /**
   * Current load failures (catalog splat/GLB, entity model GLBs, references), each
   * `"<what>: <message>"`. An entry disappears once its failure resolves.
   */
  renderErrors: readonly string[];
}
