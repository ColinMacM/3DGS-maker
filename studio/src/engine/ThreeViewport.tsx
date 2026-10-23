import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { CSSProperties } from "react";
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  BoxHelper,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineSegments,
  LinearFilter,
  Material,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  LoadingManager,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Plane,
  Raycaster,
  Scene,
  Sphere,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Intersection } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import type * as SparkTypes from "@sparkjsdev/spark";

import type {
  CatalogEntry,
  CollisionBox,
  Measurement,
  SceneBounds,
  SceneEntity,
  ReferenceLayer,
  StudioDocument,
  ToolMode,
  Transform,
  Vec3,
  ViewPreset,
  ViewportStatus,
} from "../domain/types";
import {
  applyCanonicalTransform,
  canonicalPointToThree,
  configureCanonicalRoot,
  readCanonicalTransform,
  toVec3,
} from "./coordinates";
import {
  disposeObject3D,
  replaceGroupContents,
} from "./dispose";
import { SceneEntityRenderer } from "./SceneEntities";
import { isCatalogAssetShown } from "../domain/sceneRules";
import {
  decodeOccupancy,
  voxelCellCount,
  voxelWireframe,
  type VoxelOccupancy,
} from "../domain/voxels";

export interface ThreeViewportHandle {
  focus(): void;
  setView(view: ViewPreset): void;
}

export interface ThreeViewportProps {
  document: StudioDocument;
  catalog: CatalogEntry | null;
  catalogPending: boolean;
  manifest: { collision_boxes: CollisionBox[] } | null;
  mode: ToolMode;
  onEntityTransformChange(id: string, transform: Transform): void;
  onMeasurement(measurement: Measurement): void;
  onStatus(status: ViewportStatus): void;
}

interface ViewportCallbacks {
  entityTransformChanged(id: string, transform: Transform): void;
  measurementCreated(measurement: Measurement): void;
  statusChanged(status: ViewportStatus): void;
}

interface LoadedReference {
  key: string;
  definition: ReferenceLayer;
  root: Group;
  generation: number;
}

interface PickResult {
  point: Vector3;
  selectionObject: Object3D | null;
  selectionId: string | null;
}

type SparkModule = typeof SparkTypes;
type SparkRendererInstance = InstanceType<SparkModule["SparkRenderer"]>;
const SPLAT_LOD_THRESHOLD = 250_000;



interface StudioSplat extends Object3D {
  opacity: number;
  dispose(): void;
  getBoundingBox(centersOnly?: boolean): Box3;
}

function isStudioSplat(object: Object3D): object is StudioSplat {
  const candidate = object as Object3D & {
    dispose?: unknown;
    getBoundingBox?: unknown;
  };
  return (
    object.userData.studioSplat === true &&
    typeof candidate.dispose === "function" &&
    typeof candidate.getBoundingBox === "function"
  );
}

const VIEWPORT_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  position: "relative",
  overflow: "hidden",
  background: "#0E1418",
};

const TMP_POINTER = new Vector2();
const TMP_DIRECTION = new Vector3();
const TMP_BOX = new Box3();
const TMP_OBJECT_BOX = new Box3();
const TMP_SPHERE = new Sphere();
const FLOOR_PLANE = new Plane(new Vector3(0, 1, 0), 0);
const SPLAT_EXTENSIONS: Readonly<Record<string, true>> = {
  ".ply": true,
  ".splat": true,
  ".ksplat": true,
  ".spz": true,
};

function createLocalReferenceLoadingManager(): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    throw new Error("External model resources are blocked; import a self-contained GLB");
  });
  return manager;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}
function isObjectVisible(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}


function referenceExtension(reference: ReferenceLayer): string {
  const candidates = [reference.name, reference.objectUrl ?? ""];
  for (const candidate of candidates) {
    const path = candidate.split(/[?#]/, 1)[0];
    const match = /\.([a-z0-9]+)$/i.exec(path);
    if (match) return `.${match[1].toLowerCase()}`;
  }
  return "";
}

function setObjectOpacity(root: Object3D, opacity: number): void {
  const layerOpacity = Math.min(1, Math.max(0, opacity));
  root.traverse((object) => {
    if (isStudioSplat(object)) {
      object.opacity = layerOpacity;
      return;
    }

    const value = (object as Object3D & {
      material?: Material | Material[];
    }).material;
    const materials = Array.isArray(value) ? value : value ? [value] : [];
    for (const material of materials) {
      const materialState = material as Material & {
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      };
      if (material.userData.studioBaseOpacity === undefined) {
        material.userData.studioBaseOpacity = materialState.opacity;
        material.userData.studioBaseTransparent = materialState.transparent;
        material.userData.studioBaseDepthWrite = materialState.depthWrite;
      }
      const baseOpacity = Number(material.userData.studioBaseOpacity);
      const nextOpacity = baseOpacity * layerOpacity;
      materialState.opacity = nextOpacity;
      materialState.transparent =
        Boolean(material.userData.studioBaseTransparent) || nextOpacity < 1;
      materialState.depthWrite =
        Boolean(material.userData.studioBaseDepthWrite) && nextOpacity >= 1;
      material.needsUpdate = true;
    }
  });
}

function addAssetReviewEdges(root: Object3D): void {
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  for (const mesh of meshes) {
    const edges = new LineSegments(
      new EdgesGeometry(mesh.geometry, 24),
      new LineBasicMaterial({
        color: 0x35d7ff,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
        depthWrite: false,
      }),
    );
    edges.name = "Asset review edges";
    edges.renderOrder = 12;
    mesh.add(edges);
  }
}

function createMeasurementLabel(measurement: Measurement): Sprite | null {
  const canvas = window.document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const dx = measurement.end[0] - measurement.start[0];
  const dy = measurement.end[1] - measurement.start[1];
  const dz = measurement.end[2] - measurement.start[2];
  const length = Math.hypot(dx, dy, dz);
  const label = `${measurement.label || "Measure"}  ${length.toFixed(3)} m`;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(14, 20, 24, 0.92)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#F3C85B";
  context.lineWidth = 5;
  context.strokeRect(2.5, 2.5, canvas.width - 5, canvas.height - 5);
  context.font = "600 34px 'IBM Plex Mono', monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#EDF2F4";
  context.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const material = new SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new Sprite(material);
  sprite.renderOrder = 20;
  sprite.scale.set(0.42, 0.079, 1);
  sprite.position.set(
    (measurement.start[0] + measurement.end[0]) / 2,
    (measurement.start[1] + measurement.end[1]) / 2,
    (measurement.start[2] + measurement.end[2]) / 2 + 0.035,
  );
  return sprite;
}

function createMeasurements(measurements: Measurement[]): Group {
  const root = new Group();
  root.name = "Measurements";
  if (measurements.length === 0) return root;
  const endpointGeometry = new SphereGeometry(0.009, 16, 10);
  const endpointMaterial = new MeshBasicMaterial({
    color: 0xf3c85b,
    depthTest: false,
  });
  const lineMaterial = new LineBasicMaterial({
    color: 0xf3c85b,
    depthTest: false,
    linewidth: 2,
  });
  const startPoint = new Vector3();
  const endPoint = new Vector3();

  for (const measurement of measurements) {
    startPoint.set(...measurement.start);
    endPoint.set(...measurement.end);
    const lineGeometry = new BufferGeometry().setFromPoints([
      startPoint,
      endPoint,
    ]);
    const line = new Line(lineGeometry, lineMaterial);
    line.renderOrder = 19;
    root.add(line);

    const startEndpoint = new Mesh(endpointGeometry, endpointMaterial);
    startEndpoint.position.copy(startPoint);
    startEndpoint.renderOrder = 19;
    root.add(startEndpoint);
    const endEndpoint = new Mesh(endpointGeometry, endpointMaterial);
    endEndpoint.position.copy(endPoint);
    endEndpoint.renderOrder = 19;
    root.add(endEndpoint);

    const label = createMeasurementLabel(measurement);
    if (label) root.add(label);
  }

  return root;
}
function createVoxelWireframe(boundsItem: SceneBounds & { voxels: VoxelOccupancy }, material: LineBasicMaterial): LineSegments {
  const { voxelSizeM, dimensions, occupancy } = boundsItem.voxels;
  const occupied = decodeOccupancy(occupancy, voxelCellCount(dimensions));
  const origin: Vec3 = [-boundsItem.size[0] / 2, -boundsItem.size[1] / 2, -boundsItem.size[2] / 2];
  const wireframe = voxelWireframe(occupied, dimensions, voxelSizeM, origin);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(wireframe.positions, 3));
  const lines = new LineSegments(geometry, material);
  lines.name = wireframe.outline ? `${boundsItem.label} (surface outline)` : boundsItem.label;
  lines.position.set(...boundsItem.position);
  lines.quaternion.set(...boundsItem.quaternionXyzw).normalize();
  lines.renderOrder = 23;
  return lines;
}

const DEFAULT_BOUNDS_COLOR = "#35d7ff";

/**
 * Renders the active (unexpired) agent overlays. The legend and its dismiss
 * button are HTML (`src/ui/OverlayLegend.tsx`), not part of the 3D scene.
 */
function createBounds(bounds: readonly SceneBounds[]): Group {
  const root = new Group();
  root.name = "Splat bounding boxes";
  if (bounds.length === 0) return root;
  const box = new BoxGeometry(1, 1, 1);
  const geometry = new EdgesGeometry(box);
  box.dispose();
  const materials = new Map<string, LineBasicMaterial>();
  for (const boundsItem of bounds) {
    const overlayColor = boundsItem.color ?? DEFAULT_BOUNDS_COLOR;
    const materialKey = `${overlayColor}:${boundsItem.voxels ? "voxels" : "box"}`;
    let material = materials.get(materialKey);
    if (!material) {
      material = new LineBasicMaterial({
        color: overlayColor,
        transparent: true,
        opacity: boundsItem.voxels ? 0.72 : 0.98,
        depthTest: false,
        depthWrite: false,
      });
      materials.set(materialKey, material);
    }
    if (boundsItem.voxels) {
      root.add(createVoxelWireframe({ ...boundsItem, voxels: boundsItem.voxels }, material));
      continue;
    }
    const lines = new LineSegments(geometry, material);
    lines.name = boundsItem.label;
    lines.position.set(...boundsItem.position);
    lines.quaternion.set(...boundsItem.quaternionXyzw).normalize();
    lines.scale.set(...boundsItem.size);
    lines.renderOrder = 22;
    root.add(lines);
  }
  return root;
}

/**
 * Resolves the collider list shown in the collisions layer. Any authored
 * collider replaces every package-manifest collider (the manifest is only the
 * fallback for scenes without authored colliders).
 *
 * A linked `entity-box` collider resolves from the entity's world transform even
 * when the entity, or one of its ancestors, is hidden: visibility is a display
 * choice, while colliders describe physical geometry. Only a missing entity or
 * a non-box entity yields no collider.
 */
function resolveCollisionBoxes(
  document: StudioDocument,
  fallback: readonly CollisionBox[],
): CollisionBox[] {
  if (document.collisions.length === 0) return [...fallback];

  const entities = new Map(document.entities.map((entity) => [entity.id, entity] as const));
  const worldMatrices = new Map<string, Matrix4>();
  const worldMatrixFor = (entity: SceneEntity): Matrix4 => {
    const cached = worldMatrices.get(entity.id);
    if (cached) return cached;
    const transform = entity.transform;
    const local = new Matrix4().compose(
      new Vector3(...transform.position),
      new Quaternion(...transform.quaternionXyzw).normalize(),
      new Vector3(...transform.scale),
    );
    const world = entity.parentId
      ? new Matrix4().multiplyMatrices(worldMatrixFor(entities.get(entity.parentId)!), local)
      : local;
    worldMatrices.set(entity.id, world);
    return world;
  };

  return document.collisions.flatMap((collision): CollisionBox[] => {
    if (collision.kind === "box") {
      const [x, y, z, w] = collision.quaternionXyzw;
      return [{
        name: collision.name,
        pos: collision.position,
        quatWxyz: [w, x, y, z],
        size: collision.size,
      }];
    }

    const entity = entities.get(collision.entityId);
    if (!entity || entity.kind !== "box") return [];
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    worldMatrixFor(entity).decompose(position, quaternion, scale);
    return [{
      name: collision.name,
      pos: [position.x, position.y, position.z],
      quatWxyz: [quaternion.w, quaternion.x, quaternion.y, quaternion.z],
      size: [
        entity.size[0] * Math.abs(scale.x),
        entity.size[1] * Math.abs(scale.y),
        entity.size[2] * Math.abs(scale.z),
      ],
    }];
  });
}




class ViewportEngine {
  private readonly host: HTMLDivElement;
  private readonly callbacks: ViewportCallbacks;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.005, 500);
  private readonly renderer: WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly transformControls: TransformControls;
  private readonly canonicalRoot = new Group();
  private readonly sourceRoot = new Group();
  private readonly assetRoot = new Group();
  private readonly catalogAssetRoot = new Group();
  private readonly collisionRoot = new Group();
  private readonly referenceRoot = new Group();
  private readonly measurementRoot = new Group();
  private readonly boundsRoot = new Group();
  private readonly entityRoot = new Group();
  private readonly entityRenderer: SceneEntityRenderer;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly gltfLoader = new GLTFLoader();
  private readonly referenceLoadingManager = createLocalReferenceLoadingManager();
  private readonly referenceGltfLoader = new GLTFLoader(this.referenceLoadingManager);
  private readonly referenceObjLoader = new OBJLoader(this.referenceLoadingManager);
  private readonly references = new Map<string, LoadedReference>();
  private readonly pickRootBuffer: Object3D[] = [];
  private readonly intersections: Intersection<Object3D>[] = [];
  private readonly pickResult: PickResult = {
    point: new Vector3(),
    selectionObject: null,
    selectionId: null,
  };
  private readonly resizeObserver: ResizeObserver;
  private sparkRenderer: SparkRendererInstance | null = null;
  private sparkModulePromise: Promise<SparkModule> | null = null;
  private selectionHelper: BoxHelper | null = null;
  private selectedObject: Object3D | null = null;
  private selectedId: string | null = null;
  private currentMode: ToolMode = "select";
  private measurementDefinitions: Measurement[] | null = null;
  private boundsDefinitions: StudioDocument["bounds"] | null = null;
  private boundsExpiryTimer: number | undefined;
  private entityDefinitions: StudioDocument["entities"] | null = null;
  private collisionSignature = "";
  private catalogKey = "";
  private catalogGeneration = 0;
  private referenceGeneration = 0;
  private pendingMeasurement: Vec3 | null = null;
  private pendingMarker: Mesh | null = null;
  private readonly pointerDown = new Vector2();
  private pointerIsDown = false;
  private ignorePointerUp = false;
  private initializedView = false;
  private viewPreset: ViewPreset = "perspective";
  /** Last seen `viewport.frameRequest`; null before the first document. */
  private frameRequest: number | null = null;
  /** Current catalog splat/GLB load failures. */
  private catalogErrors: string[] = [];
  /** Current reference load failures keyed by reference id. */
  private readonly referenceErrors = new Map<string, string>();
  private scenePresented = false;
  private disposed = false;
  private status: ViewportStatus = {
    ready: false,
    cursor: null,
    selectedId: null,
    message: "Initializing viewport…",
    renderErrors: [],
  };

  constructor(host: HTMLDivElement, callbacks: ViewportCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.entityRenderer = new SceneEntityRenderer(
      this.entityRoot,
      (failure) => this.emitRenderErrors(failure),
    );
    this.scene.background = new Color(0x0e1418);

    this.renderer = new WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.opacity = "0";
    this.renderer.domElement.style.transition = "opacity 120ms ease-out";
    this.renderer.domElement.style.touchAction = "none";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(this.renderer.domElement);

    this.camera.position.set(1.7, 1.35, 1.7);
    this.camera.up.set(0, 1, 0);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.55, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;
    this.orbit.minDistance = 0.08;
    this.orbit.maxDistance = 80;
    this.orbit.screenSpacePanning = true;

    configureCanonicalRoot(this.canonicalRoot);
    this.canonicalRoot.name = "Canonical Z-up root";
    this.sourceRoot.name = "Source splat";
    this.sourceRoot.userData.selectionId = "source";
    this.assetRoot.name = "3D asset";
    this.assetRoot.userData.selectionId = "asset";
    this.catalogAssetRoot.name = "Catalog 3D asset";
    this.collisionRoot.name = "Collision proxies";
    this.collisionRoot.userData.selectionId = "collisions";
    this.referenceRoot.name = "References";
    this.measurementRoot.name = "Measurement layers";
    this.boundsRoot.name = "Splat bounding-box overlays";
    this.entityRoot.name = "Scene-authored 3D asset";
    this.assetRoot.add(this.catalogAssetRoot, this.entityRoot);
    this.canonicalRoot.add(
      this.sourceRoot,
      this.assetRoot,
      this.collisionRoot,
      this.referenceRoot,
      this.measurementRoot,
      this.boundsRoot,
    );
    this.scene.add(this.canonicalRoot);

    const grid = new GridHelper(20, 200, 0x435159, 0x263239);
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.56;
    }
    grid.name = "Metric floor grid";
    this.scene.add(grid);

    const ambient = new AmbientLight(0xffffff, 0.55);
    ambient.name = "Viewer ambient fill";
    this.scene.add(ambient);

    const hemisphere = new HemisphereLight(0xdbe9ee, 0x53616a, 1);
    hemisphere.name = "Viewer sky fill";
    this.scene.add(hemisphere);

    const key = new DirectionalLight(0xffffff, 1.8);
    key.name = "Viewer positive-axis key";
    key.position.set(4, 6, 4);
    this.scene.add(key);

    const fill = new DirectionalLight(0xddeeff, 1.2);
    fill.name = "Viewer negative-X fill";
    fill.position.set(-4, 3, 2);
    this.scene.add(fill);

    const rim = new DirectionalLight(0xfff0dc, 0.9);
    rim.name = "Viewer negative-Z fill";
    rim.position.set(0, 4, -5);
    this.scene.add(rim);


    this.transformControls = new TransformControls(
      this.camera,
      this.renderer.domElement,
    );
    this.transformControls.space = "local";
    this.transformControls.size = 0.84;
    this.scene.add(this.transformControls.getHelper());
    this.transformControls.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !Boolean(event.value);
    });
    this.transformControls.addEventListener("mouseDown", () => {
      this.ignorePointerUp = true;
    });
    this.transformControls.addEventListener("mouseUp", () => {
      if (
        this.selectedObject
        && this.selectedId?.startsWith("entity:")
        && this.transformControls.object === this.selectedObject
      ) {
        this.callbacks.entityTransformChanged(
          this.selectedId.slice("entity:".length),
          readCanonicalTransform(this.selectedObject),
        );
      }
    });
    this.transformControls.addEventListener("objectChange", () => {
      this.selectionHelper?.update();
    });

    this.raycaster.params.Points.threshold = 0.018;
    this.raycaster.params.Line.threshold = 0.012;

    this.renderer.domElement.addEventListener(
      "pointerdown",
      this.handlePointerDown,
    );
    this.renderer.domElement.addEventListener(
      "pointerup",
      this.handlePointerUp,
    );
    this.renderer.domElement.addEventListener(
      "pointermove",
      this.handlePointerMove,
    );
    this.renderer.domElement.addEventListener(
      "pointerleave",
      this.handlePointerLeave,
    );

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(this.render);
    this.emitStatus({ ready: true, message: "Viewport ready" });
  }

  update(
    document: StudioDocument,
    catalog: CatalogEntry | null,
    catalogPending: boolean,
    manifest: { collision_boxes: CollisionBox[] } | null,
    mode: ToolMode,
  ): void {
    const viewChanged = this.viewPreset !== document.viewport.preset;
    this.viewPreset = document.viewport.preset;
    const frameRequest = document.viewport.frameRequest ?? 0;
    const frameRequested = this.frameRequest !== null && this.frameRequest !== frameRequest;
    this.frameRequest = frameRequest;

    this.sourceRoot.visible = document.layers.catalogVisuals;
    this.assetRoot.visible = document.layers.assetVisuals;
    this.entityRoot.visible = document.layers.assetVisuals;
    this.catalogAssetRoot.visible = isCatalogAssetShown(document);
    this.collisionRoot.visible = document.layers.collisions;
    this.referenceRoot.visible = document.layers.reference;
    this.measurementRoot.visible = document.layers.measurements;
    this.boundsRoot.visible = document.layers.measurements;

    if (this.measurementDefinitions !== document.measurements) {
      this.measurementDefinitions = document.measurements;
      replaceGroupContents(
        this.measurementRoot,
        createMeasurements(document.measurements),
      );
    }

    if (this.boundsDefinitions !== document.bounds) {
      this.boundsDefinitions = document.bounds;
      this.renderActiveBounds();
    }

    if (this.entityDefinitions !== document.entities) {
      this.entityDefinitions = document.entities;
      this.entityRenderer.update(document.entities);
      if (this.selectedId?.startsWith("entity:")) {
        const entityId = this.selectedId.slice("entity:".length);
        this.select(this.entityRenderer.rootFor(entityId), this.selectedId);
      }
    }


    const collisionBoxes = resolveCollisionBoxes(
      document,
      manifest?.collision_boxes ?? [],
    );
    const collisionSignature = JSON.stringify(collisionBoxes);
    if (this.collisionSignature !== collisionSignature) {
      this.collisionSignature = collisionSignature;
      this.rebuildCollisions(collisionBoxes);
    }

    this.updateCatalog(catalog);
    this.updateReferences(document.references, document.layers.reference);
    this.setMode(mode);
    this.updateSelectionVisibility();

    if (!this.initializedView && !catalogPending && !catalog) this.presentScene();
    if ((viewChanged || frameRequested) && this.initializedView) this.setView(this.viewPreset);
  }

  focus(): void {
    this.host.focus({ preventScroll: true });
    this.frameScene();
  }

  setView(view: ViewPreset): void {
    const bounds = this.visibleBounds();
    bounds.getBoundingSphere(TMP_SPHERE);
    const radius = Math.max(TMP_SPHERE.radius, 0.35);
    const center = TMP_SPHERE.center;

    if (view === "top") {
      canonicalPointToThree([0, 0, 1], TMP_DIRECTION);
      this.camera.up.set(0, 0, -1);
    } else if (view === "front") {
      canonicalPointToThree([0, -1, 0], TMP_DIRECTION);
      this.camera.up.set(0, 1, 0);
    } else if (view === "right") {
      canonicalPointToThree([1, 0, 0], TMP_DIRECTION);
      this.camera.up.set(0, 1, 0);
    } else {
      canonicalPointToThree([-1, 1.25, 0.85], TMP_DIRECTION).normalize();
      this.camera.up.set(0, 1, 0);
    }

    this.placeCamera(center, radius, TMP_DIRECTION);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.catalogGeneration += 1;
    this.referenceGeneration += 1;
    if (this.boundsExpiryTimer !== undefined) {
      window.clearTimeout(this.boundsExpiryTimer);
      this.boundsExpiryTimer = undefined;
    }
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.handlePointerDown,
    );
    this.renderer.domElement.removeEventListener(
      "pointerup",
      this.handlePointerUp,
    );
    this.renderer.domElement.removeEventListener(
      "pointermove",
      this.handlePointerMove,
    );
    this.renderer.domElement.removeEventListener(
      "pointerleave",
      this.handlePointerLeave,
    );
    this.clearPendingMeasurement();
    this.clearSelectionHelper();
    this.transformControls.detach();
    this.transformControls.getHelper().removeFromParent();
    this.transformControls.dispose();
    this.orbit.dispose();

    for (const reference of this.references.values()) {
      disposeObject3D(reference.root);
    }
    this.references.clear();
    this.entityRenderer.dispose();
    disposeObject3D(this.canonicalRoot);

    if (this.sparkRenderer) {
      this.sparkRenderer.removeFromParent();
      this.sparkRenderer.dispose();
      this.sparkRenderer = null;
    }

    for (const object of [...this.scene.children]) {
      disposeObject3D(object);
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private readonly render = (): void => {
    if (this.disposed) return;
    this.entityRenderer.tick();
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };

  private readonly resize = (): void => {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private emitStatus(patch: Partial<ViewportStatus>): void {
    const next: ViewportStatus = { ...this.status, ...patch };
    const sameCursor =
      next.cursor === this.status.cursor ||
      (next.cursor !== null &&
        this.status.cursor !== null &&
        Math.abs(next.cursor[0] - this.status.cursor[0]) < 0.0005 &&
        Math.abs(next.cursor[1] - this.status.cursor[1]) < 0.0005 &&
        Math.abs(next.cursor[2] - this.status.cursor[2]) < 0.0005);
    const sameRenderErrors =
      next.renderErrors === this.status.renderErrors ||
      (next.renderErrors.length === this.status.renderErrors.length &&
        next.renderErrors.every((error, index) => error === this.status.renderErrors[index]));
    if (
      next.ready === this.status.ready &&
      next.selectedId === this.status.selectedId &&
      next.message === this.status.message &&
      sameCursor &&
      sameRenderErrors
    ) {
      return;
    }
    this.status = next;
    this.callbacks.statusChanged(next);
  }

  /**
   * Recomputes `renderErrors` from the current catalog, entity and reference
   * failures. `failure` is a newly added error to surface as the status message.
   */
  private emitRenderErrors(failure: string | null = null): void {
    this.emitStatus({
      renderErrors: [
        ...this.catalogErrors,
        ...this.entityRenderer.loadErrors(),
        ...this.referenceErrors.values(),
      ],
      ...(failure ? { message: failure } : {}),
    });
  }

  /**
   * Shows only unexpired overlays and schedules a re-render at the next expiry,
   * so each overlay disappears at its own `expiresAt` while the rest remain.
   */
  private renderActiveBounds(): void {
    if (this.boundsExpiryTimer !== undefined) {
      window.clearTimeout(this.boundsExpiryTimer);
      this.boundsExpiryTimer = undefined;
    }
    const now = Date.now();
    const activeBounds = (this.boundsDefinitions ?? []).filter(({ expiresAt }) => (
      expiresAt === undefined || Date.parse(expiresAt) > now
    ));
    replaceGroupContents(this.boundsRoot, createBounds(activeBounds));
    const expirations = activeBounds
      .flatMap(({ expiresAt }) => expiresAt === undefined ? [] : [Date.parse(expiresAt)]);
    if (expirations.length === 0) return;
    this.boundsExpiryTimer = window.setTimeout(() => {
      this.boundsExpiryTimer = undefined;
      if (!this.disposed) this.renderActiveBounds();
    }, Math.max(0, Math.min(...expirations) - now));
  }

  private rebuildCollisions(boxes: CollisionBox[]): void {
    if (boxes.length === 0) {
      replaceGroupContents(this.collisionRoot, null);
      return;
    }

    const content = new Group();
    content.name = "Collision box wireframes";
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial({
      color: 0xff8a5b,
      transparent: true,
      opacity: 0.32,
      wireframe: true,
      depthWrite: false,
      side: DoubleSide,
    });

    for (const box of boxes) {
      const mesh = new Mesh(geometry, material);
      mesh.name = box.name;
      mesh.position.set(...box.pos);
      mesh.quaternion
        .set(
          box.quatWxyz[1],
          box.quatWxyz[2],
          box.quatWxyz[3],
          box.quatWxyz[0],
        )
        .normalize();
      mesh.scale.set(...box.size);
      content.add(mesh);
    }
    replaceGroupContents(this.collisionRoot, content);
  }

  private updateCatalog(catalog: CatalogEntry | null): void {
    const key = catalog
      ? JSON.stringify([catalog.id, catalog.version, catalog.browser])
      : "";
    if (key === this.catalogKey) return;
    this.catalogKey = key;
    const generation = ++this.catalogGeneration;
    if (
      this.selectedObject === this.sourceRoot
      || this.selectedObject === this.assetRoot
    ) {
      this.select(null, null);
    }
    replaceGroupContents(this.sourceRoot, null);
    replaceGroupContents(this.catalogAssetRoot, null);
    if (this.catalogErrors.length > 0) {
      this.catalogErrors = [];
      this.emitRenderErrors();
    }
    this.sourceRoot.userData.selectionId = catalog
      ? `source:${catalog.id}`
      : "source";
    this.assetRoot.userData.selectionId = catalog
      ? `asset:${catalog.id}`
      : "asset";

    if (!catalog) return;
    this.emitStatus({ message: `Loading ${catalog.name} source and asset…` });
    void this.loadCatalog(catalog, generation);
  }

  private async loadCatalog(catalog: CatalogEntry, generation: number): Promise<void> {
    const source = catalog.browser.spz
      ? (async (): Promise<Object3D> => {
          const root = new Group();
          try {
            const spark = await this.ensureSparkRenderer();
            applyCanonicalTransform(root, catalog.browser.spz!.transform);
            const splat = new spark.SplatMesh({
              url: catalog.browser.spz!.url,
              fileName: catalog.browser.spz!.url.split("/").pop() || "source.spz",
              raycastable: true,
              lod: true,
              lodAbove: SPLAT_LOD_THRESHOLD,
              enableLod: true,
            });
            // Implicit Rx(180°): the SPZ is flipped about X first and
            // `browser.spz.transform` (on `root`) is applied after it:
            // world = transform · Rx(180°). src/splat/analysis.ts applies the
            // same flip; keep both in sync.
            splat.rotation.x = Math.PI;
            splat.userData.studioSplat = true;
            root.add(splat);
            await splat.initialized;
            if (splat.splats && splat.splats.getNumSplats() > SPLAT_LOD_THRESHOLD) {
              await splat.createLodSplats();
            }
            return root;
          } catch (error) {
            disposeObject3D(root);
            throw error;
          }
        })()
      : Promise.resolve<Object3D | null>(null);
    const asset = this.gltfLoader.loadAsync(catalog.browser.glb)
      .then((gltf) => {
        if (catalog.browser.spz) addAssetReviewEdges(gltf.scene);
        return gltf.scene as Object3D;
      });
    const [sourceResult, assetResult] = await Promise.allSettled([source, asset]);
    const loaded: string[] = [];
    const errors: string[] = [];

    if (this.disposed || generation !== this.catalogGeneration) {
      if (sourceResult.status === "fulfilled" && sourceResult.value) {
        disposeObject3D(sourceResult.value);
      }
      if (assetResult.status === "fulfilled") disposeObject3D(assetResult.value);
      return;
    }

    if (sourceResult.status === "fulfilled" && sourceResult.value) {
      this.sourceRoot.add(sourceResult.value);
      loaded.push("splat");
    } else if (sourceResult.status === "rejected") {
      errors.push(`catalog ${catalog.id} splat ${catalog.browser.spz?.url}: ${errorMessage(sourceResult.reason)}`);
    }
    if (assetResult.status === "fulfilled") {
      this.catalogAssetRoot.add(assetResult.value);
      loaded.push("3D asset");
    } else {
      errors.push(`catalog ${catalog.id} 3D asset ${catalog.browser.glb}: ${errorMessage(assetResult.reason)}`);
    }

    this.presentScene();
    this.catalogErrors = errors;
    this.emitRenderErrors();
    this.emitStatus({
      message: loaded.length > 0
        ? `${catalog.name} loaded (${loaded.join(" + ")})${errors.length ? `; ${errors.join("; ")}` : ""}`
        : `${catalog.name} failed to load: ${errors.join("; ")}`,
    });
  }

  private updateReferences(
    definitions: ReferenceLayer[],
    layerVisible: boolean,
  ): void {
    const ids = new Set(definitions.map((definition) => definition.id));
    let errorsCleared = false;
    for (const [id, loaded] of this.references) {
      if (ids.has(id)) continue;
      if (this.selectedId === `reference:${id}`) this.select(null, null);
      disposeObject3D(loaded.root);
      this.references.delete(id);
      if (this.referenceErrors.delete(id)) errorsCleared = true;
    }

    for (const definition of definitions) {
      const key = [
        definition.objectUrl ?? "",
        definition.kind,
        definition.name,
      ].join("\u0000");
      let loaded = this.references.get(definition.id);
      if (!loaded || loaded.key !== key) {
        if (loaded) {
          if (this.selectedId === `reference:${definition.id}`) {
            this.select(null, null);
          }
          disposeObject3D(loaded.root);
        }
        if (this.referenceErrors.delete(definition.id)) errorsCleared = true;
        const root = new Group();
        root.name = definition.name;
        root.userData.selectionId = `reference:${definition.id}`;
        loaded = {
          key,
          definition,
          root,
          generation: ++this.referenceGeneration,
        };
        this.references.set(definition.id, loaded);
        this.referenceRoot.add(root);
        this.loadReference(loaded);
      }

      loaded.definition = definition;
      applyCanonicalTransform(loaded.root, definition.transform);
      loaded.root.visible =
        layerVisible && definition.visible && definition.opacity > 0;
      setObjectOpacity(loaded.root, definition.opacity);
    }
    if (errorsCleared) this.emitRenderErrors();
  }

  private ensureSparkRenderer(): Promise<SparkModule> {
    if (this.sparkModulePromise) return this.sparkModulePromise;

    this.sparkModulePromise = import("@sparkjsdev/spark").then((spark) => {
      if (this.disposed) {
        throw new Error("Viewport was disposed while loading the splat renderer");
      }
      if (!this.sparkRenderer) {
        const renderer = new spark.SparkRenderer({
          renderer: this.renderer,
          enableLod: true,
          lodSplatCount: SPLAT_LOD_THRESHOLD,
        });
        renderer.name = "Gaussian splat renderer";
        this.scene.add(renderer);
        this.sparkRenderer = renderer;
      }
      return spark;
    });
    return this.sparkModulePromise;
  }

  private async loadReference(reference: LoadedReference): Promise<void> {
    const { definition, root, generation } = reference;
    if (!definition.objectUrl) {
      this.emitStatus({
        message: `Reference “${definition.name}” has no local source`,
      });
      return;
    }

    this.emitStatus({ message: `Loading reference ${definition.name}…` });
    let content: Object3D | null = null;
    try {
      const extension = referenceExtension(definition);
      const isSplatFormat = SPLAT_EXTENSIONS[extension] === true;
      if (definition.kind === "splat" || isSplatFormat) {
        if (!isSplatFormat) {
          throw new Error(
            "Splat references require .ply, .splat, .ksplat, or .spz",
          );
        }
        const spark = await this.ensureSparkRenderer();
        const pending = this.references.get(definition.id);
        if (
          this.disposed ||
          !pending ||
          pending.generation !== generation ||
          pending.root !== root
        ) {
          return;
        }
        const fileName = definition.name
          .toLowerCase()
          .endsWith(extension)
          ? definition.name
          : `reference${extension}`;
        const splat = new spark.SplatMesh({
          url: definition.objectUrl,
          fileName,
          raycastable: true,
          lod: true,
          lodAbove: SPLAT_LOD_THRESHOLD,
          enableLod: true,
        });
        splat.userData.studioSplat = true;
        splat.opacity = Math.min(1, Math.max(0, pending.definition.opacity));
        content = splat;
        root.add(splat);
        await splat.initialized;
        if (splat.splats && splat.splats.getNumSplats() > SPLAT_LOD_THRESHOLD) {
          await splat.createLodSplats();
        }
      } else if (extension === ".glb") {
        const gltf = await this.referenceGltfLoader.loadAsync(definition.objectUrl);
        content = gltf.scene;
        content.rotation.x = Math.PI / 2;
      } else if (extension === ".obj") {
        content = await this.referenceObjLoader.loadAsync(definition.objectUrl);
      } else {
        throw new Error(
          "Unsupported reference format; use GLB, OBJ, PLY, SPLAT, KSPLAT, or SPZ",
        );
      }

      const current = this.references.get(definition.id);
      if (
        this.disposed ||
        !current ||
        current.generation !== generation ||
        current.root !== root
      ) {
        disposeObject3D(content);
        return;
      }
      if (content.parent !== root) root.add(content);
      setObjectOpacity(root, current.definition.opacity);
      this.emitStatus({ message: `Reference ${definition.name} loaded` });
    } catch (error) {
      if (content) disposeObject3D(content);
      const current = this.references.get(definition.id);
      if (
        this.disposed ||
        !current ||
        current.generation !== generation ||
        current.root !== root
      ) {
        return;
      }
      const failure = `reference ${definition.id} (${definition.name}): ${errorMessage(error)}`;
      this.referenceErrors.set(definition.id, failure);
      this.emitRenderErrors(failure);
    }
  }

  private setMode(mode: ToolMode): void {
    if (this.currentMode === mode) {
      this.syncTransformControls();
      return;
    }
    this.currentMode = mode;
    this.renderer.domElement.style.cursor =
      mode === "measure" ? "crosshair" : "default";
    if (mode !== "measure") this.clearPendingMeasurement();
    this.syncTransformControls();
  }

  private syncTransformControls(): void {
    const transformMode =
      this.currentMode === "translate" || this.currentMode === "rotate"
        ? this.currentMode
        : null;
    const canTransform =
      transformMode !== null
      && this.selectedObject !== null
      && isObjectVisible(this.selectedObject)
      && this.selectedId?.startsWith("entity:") === true;
    if (!canTransform || !this.selectedObject) {
      this.transformControls.detach();
      return;
    }
    this.transformControls.setMode(transformMode);
    this.transformControls.attach(this.selectedObject);
  }

  private updateSelectionVisibility(): void {
    if (!this.selectedObject) return;
    if (!isObjectVisible(this.selectedObject)) {
      this.clearSelectionHelper();
    } else if (!this.selectionHelper) {
      this.selectionHelper = new BoxHelper(this.selectedObject, 0x5fc4f0);
      this.scene.add(this.selectionHelper);
    }
    this.selectionHelper?.update();
    this.syncTransformControls();
  }

  private select(object: Object3D | null, id: string | null): void {
    if (object === this.selectedObject && id === this.selectedId) return;
    this.clearSelectionHelper();
    this.selectedObject = object;
    this.selectedId = id;
    if (object && isObjectVisible(object)) {
      this.selectionHelper = new BoxHelper(object, 0x5fc4f0);
      this.selectionHelper.name = "Selection bounds";
      this.scene.add(this.selectionHelper);
    }
    this.emitStatus({
      selectedId: id,
      message: id ? `Selected ${id}` : "Selection cleared",
    });
    this.syncTransformControls();
  }

  private clearSelectionHelper(): void {
    if (!this.selectionHelper) return;
    disposeObject3D(this.selectionHelper);
    this.selectionHelper = null;
  }

  private pointerCoordinates(event: PointerEvent): void {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pickPoint(event: PointerEvent): PickResult | null {
    this.pointerCoordinates(event);
    const pickRoots = this.pickRoots();
    this.intersections.length = 0;
    this.raycaster.intersectObjects(pickRoots, true, this.intersections);
    if (this.intersections.length > 0) {
      const intersection = this.intersections[0];
      let selectionObject: Object3D | null = intersection.object;
      let selectionId: string | null = null;
      while (selectionObject && selectionObject !== this.scene) {
        if (typeof selectionObject.userData.selectionId === "string") {
          selectionId = selectionObject.userData.selectionId;
          break;
        }
        selectionObject = selectionObject.parent;
      }
      this.pickResult.point.copy(intersection.point);
      this.pickResult.selectionObject = selectionId ? selectionObject : null;
      this.pickResult.selectionId = selectionId;
      return this.pickResult;
    }

    const point = this.raycaster.ray.intersectPlane(
      FLOOR_PLANE,
      this.pickResult.point,
    );
    if (!point) return null;
    this.pickResult.selectionObject = null;
    this.pickResult.selectionId = null;
    return this.pickResult;
  }

  private pickRoots(): Object3D[] {
    const roots = this.pickRootBuffer;
    roots.length = 0;
    if (this.sourceRoot.visible && this.sourceRoot.children.length) {
      roots.push(this.sourceRoot);
    }
    if (this.assetRoot.visible && this.assetRoot.children.length) {
      roots.push(this.assetRoot);
    }
    if (this.collisionRoot.visible && this.collisionRoot.children.length) {
      roots.push(this.collisionRoot);
    }
    if (this.referenceRoot.visible) {
      for (const reference of this.references.values()) {
        if (reference.root.visible && reference.root.children.length) {
          roots.push(reference.root);
        }
      }
    }
    return roots;
  }

  private worldPointToCanonical(point: Vector3): Vec3 {
    this.canonicalRoot.updateWorldMatrix(true, false);
    TMP_DIRECTION.copy(point);
    this.canonicalRoot.worldToLocal(TMP_DIRECTION);
    return toVec3(TMP_DIRECTION);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.pointerDown.set(event.clientX, event.clientY);
    this.pointerIsDown = true;
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.pointerIsDown) return;
    this.pointerIsDown = false;
    TMP_POINTER.set(event.clientX, event.clientY);
    const distance = this.pointerDown.distanceTo(TMP_POINTER);
    if (this.ignorePointerUp) {
      this.ignorePointerUp = false;
      return;
    }
    if (distance > 4 || this.transformControls.dragging) return;

    const hit = this.pickPoint(event);
    if (this.currentMode === "measure") {
      if (hit) this.recordMeasurementPoint(this.worldPointToCanonical(hit.point));
      return;
    }
    if (this.currentMode === "select") {
      this.select(hit?.selectionObject ?? null, hit?.selectionId ?? null);
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const hit = this.pickPoint(event);
    this.emitStatus({
      cursor: hit ? this.worldPointToCanonical(hit.point) : null,
    });
  };

  private readonly handlePointerLeave = (): void => {
    this.emitStatus({ cursor: null });
  };

  private recordMeasurementPoint(point: Vec3): void {
    if (!this.pendingMeasurement) {
      this.pendingMeasurement = point;
      const marker = new Mesh(
        new SphereGeometry(0.012, 16, 10),
        new MeshBasicMaterial({ color: 0xf3c85b, depthTest: false }),
      );
      marker.position.set(...point);
      marker.renderOrder = 21;
      this.pendingMarker = marker;
      this.measurementRoot.add(marker);
      this.emitStatus({ message: "Measurement start set; choose an end point" });
      return;
    }

    const start = this.pendingMeasurement;
    const randomUuid = globalThis.crypto?.randomUUID;
    const id = randomUuid
      ? randomUuid.call(globalThis.crypto)
      : `measurement-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const length = Math.hypot(
      point[0] - start[0],
      point[1] - start[1],
      point[2] - start[2],
    );
    this.callbacks.measurementCreated({
      id,
      label: `Measurement ${(this.measurementDefinitions?.length ?? 0) + 1}`,
      start,
      end: point,
    });
    this.clearPendingMeasurement();
    this.emitStatus({ message: `Measured ${length.toFixed(3)} m` });
  }

  private clearPendingMeasurement(): void {
    this.pendingMeasurement = null;
    if (!this.pendingMarker) return;
    disposeObject3D(this.pendingMarker);
    this.pendingMarker = null;
  }

  private visibleBounds(): Box3 {
    TMP_BOX.makeEmpty();
    const roots: Object3D[] = [
      this.sourceRoot,
      this.assetRoot,
      this.collisionRoot,
    ];
    if (this.referenceRoot.visible) {
      for (const reference of this.references.values()) {
        if (reference.root.visible) roots.push(reference.root);
      }
    }
    for (const root of roots) {
      if (!root.visible || root.children.length === 0) continue;
      root.updateWorldMatrix(true, true);
      // traverseVisible skips hidden subtrees (e.g. the catalog GLB while scene
      // entities replace it), so framing matches what is actually drawn.
      root.traverseVisible((object) => {
        if (isStudioSplat(object)) {
          const splatBounds = object.getBoundingBox();
          if (!splatBounds.isEmpty()) {
            splatBounds.applyMatrix4(object.matrixWorld);
            TMP_BOX.union(splatBounds);
          }
          return;
        }
        const geometry = "geometry" in object ? object.geometry : undefined;
        if (!(geometry instanceof BufferGeometry)) return;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
        TMP_OBJECT_BOX.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld);
        TMP_BOX.union(TMP_OBJECT_BOX);
      });
    }
    if (TMP_BOX.isEmpty()) {
      TMP_BOX.min.set(-0.5, 0, -0.5);
      TMP_BOX.max.set(0.5, 1, 0.5);
    }
    return TMP_BOX;
  }

  private presentScene(): void {
    if (this.initializedView) {
      this.frameScene();
    } else {
      this.initializedView = true;
      this.setView(this.viewPreset);
    }
    if (this.scenePresented) return;
    this.scenePresented = true;
    window.requestAnimationFrame(() => {
      if (!this.disposed) this.renderer.domElement.style.opacity = "1";
    });
  }

  private frameScene(): void {
    const bounds = this.visibleBounds();
    bounds.getBoundingSphere(TMP_SPHERE);
    TMP_DIRECTION.subVectors(this.camera.position, this.orbit.target);
    if (TMP_DIRECTION.lengthSq() < 0.0001) TMP_DIRECTION.set(1, 0.7, 1);
    TMP_DIRECTION.normalize();
    this.placeCamera(
      TMP_SPHERE.center,
      Math.max(TMP_SPHERE.radius, 0.35),
      TMP_DIRECTION,
    );
  }

  private placeCamera(
    center: Vector3,
    radius: number,
    direction: Vector3,
  ): void {
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const distance = Math.max(0.5, (radius / Math.sin(halfFov)) * 1.18);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.002, distance / 2_000);
    this.camera.far = Math.max(100, distance * 50);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }
}

export const ThreeViewport = forwardRef<
  ThreeViewportHandle,
  ThreeViewportProps
>(function ThreeViewport(
  {
    document,
    catalog,
    manifest,
    catalogPending,
    mode,
    onEntityTransformChange,
    onMeasurement,
    onStatus,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewportEngine | null>(null);
  const callbacksRef = useRef({
    onEntityTransformChange,
    onMeasurement,
    onStatus,
  });
  callbacksRef.current = {
    onEntityTransformChange,
    onMeasurement,
    onStatus,
  };

  useImperativeHandle(
    ref,
    () => ({
      focus(): void {
        engineRef.current?.focus();
      },
      setView(view): void {
        engineRef.current?.setView(view);
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new ViewportEngine(host, {
      entityTransformChanged(id, transform): void {
        callbacksRef.current.onEntityTransformChange(id, transform);
      },
      measurementCreated(measurement): void {
        callbacksRef.current.onMeasurement(measurement);
      },
      statusChanged(status): void {
        callbacksRef.current.onStatus(status);
      },
    });
    engineRef.current = engine;
    engine.update(document, catalog, catalogPending, manifest, mode);

    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [ViewportEngine]);

  useEffect(() => {
    engineRef.current?.update(document, catalog, catalogPending, manifest, mode);
  }, [catalog, catalogPending, document, manifest, mode]);

  return (
    <div
      ref={hostRef}
      role="application"
      aria-label="Interactive metric Z-up asset viewport"
      tabIndex={0}
      style={VIEWPORT_STYLE}
    />
  );
});
