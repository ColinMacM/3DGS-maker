import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type {
  LabelSceneEntity,
  SceneEntity,
  SceneMaterial,
} from "../domain/types";
import { applyCanonicalTransform } from "./coordinates";
import { disposeObject3D } from "./dispose";

interface EntityRuntime {
  definition: SceneEntity;
  root: Group;
  signature: string;
}

interface ScaleAnimation {
  root: Group;
  from: Vector3;
  to: Vector3;
  startedAt: number;
  duration: number;
  disposeWhenFinished: boolean;
}

interface PoofAnimation {
  points: Points<BufferGeometry, PointsMaterial>;
  positions: Float32Array;
  velocities: Float32Array;
  startedAt: number;
  previousAt: number;
  duration: number;
  gravity: number;
}

const POOF_PARTICLE_COUNT = 28;
const TMP_BOUNDS = new Box3();
const TMP_CENTER = new Vector3();
const TMP_SIZE = new Vector3();
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function createMaterial(definition: SceneMaterial): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: definition.color,
    metalness: 0.15,
    roughness: 0.65,
    opacity: definition.opacity,
    transparent: definition.opacity < 1,
    depthWrite: definition.opacity >= 1,
  });
}

function markMesh(mesh: Mesh): Mesh {
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function createLabel(definition: LabelSceneEntity): Sprite | null {
  const canvas = window.document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = definition.backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "600 48px 'IBM Plex Mono', monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = definition.color;
  context.fillText(definition.text, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const sprite = new Sprite(new SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
  }));
  sprite.renderOrder = 20;
  const width = definition.size * Math.min(8, Math.max(2, definition.text.length * 0.62));
  sprite.scale.set(width, definition.size, 1);
  return sprite;
}

function createPoofTexture(): CanvasTexture {
  const canvas = window.document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.24, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.58, "rgba(255,255,255,0.42)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function cubicOut(value: number): number {
  return 1 - ((1 - value) ** 3);
}

function depthOf(id: string, definitions: ReadonlyMap<string, SceneEntity>): number {
  let depth = 0;
  let current = definitions.get(id);
  while (current?.parentId) {
    depth += 1;
    current = definitions.get(current.parentId);
  }
  return depth;
}

function hasAncestorInSet(
  id: string,
  ids: ReadonlySet<string>,
  definitions: ReadonlyMap<string, SceneEntity>,
): boolean {
  let parentId = definitions.get(id)?.parentId;
  while (parentId) {
    if (ids.has(parentId)) return true;
    parentId = definitions.get(parentId)?.parentId;
  }
  return false;
}

/** Maintains a validated declarative entity collection without rebuilding unchanged objects. */
export class SceneEntityRenderer {
  private readonly loader = new GLTFLoader();
  private readonly runtimes = new Map<string, EntityRuntime>();
  private readonly scaleAnimations: ScaleAnimation[] = [];
  private readonly poofAnimations: PoofAnimation[] = [];
  private definitions = new Map<string, SceneEntity>();
  private lastEntities: readonly SceneEntity[] | null = null;
  private disposed = false;

  constructor(
    private readonly sceneRoot: Group,
    private readonly reportError: (message: string) => void,
  ) {}

  update(entities: readonly SceneEntity[]): void {
    if (this.disposed || entities === this.lastEntities) return;
    this.lastEntities = entities;

    const nextDefinitions = new Map(entities.map((entity) => [entity.id, entity] as const));
    const nextSignatures = new Map(entities.map((entity) => [entity.id, JSON.stringify(entity)] as const));
    const removedIds = new Set(
      [...this.runtimes.keys()].filter((id) => !nextDefinitions.has(id)),
    );
    const addedIds = new Set(
      entities.filter(({ id }) => !this.runtimes.has(id)).map(({ id }) => id),
    );
    const changed = new Set<string>();

    for (const [id, runtime] of this.runtimes) {
      if (nextSignatures.get(id) !== runtime.signature) changed.add(id);
    }
    for (const entity of entities) {
      if (!this.runtimes.has(entity.id)) changed.add(entity.id);
    }

    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const definition of [...this.definitions.values(), ...entities]) {
        if (definition.parentId && changed.has(definition.parentId) && !changed.has(definition.id)) {
          changed.add(definition.id);
          expanded = true;
        }
      }
    }

    const topRemovedIds = new Set(
      [...removedIds].filter((id) => !hasAncestorInSet(id, removedIds, this.definitions)),
    );
    const removals = [...changed]
      .filter((id) => this.runtimes.has(id))
      .sort((left, right) => depthOf(right, this.definitions) - depthOf(left, this.definitions));
    for (const id of removals) {
      const runtime = this.runtimes.get(id);
      if (!runtime) continue;
      this.cancelScaleAnimations(runtime.root);
      this.runtimes.delete(id);
      if (removedIds.has(id)) {
        if (topRemovedIds.has(id)) this.startDisappearance(runtime);
        continue;
      }
      disposeObject3D(runtime.root);
    }

    for (const entity of entities) {
      if (!changed.has(entity.id)) continue;
      const runtime: EntityRuntime = {
        definition: entity,
        root: new Group(),
        signature: nextSignatures.get(entity.id)!,
      };
      runtime.root.name = entity.name;
      runtime.root.userData.selectionId = `entity:${entity.id}`;
      runtime.root.visible = entity.visible;
      this.runtimes.set(entity.id, runtime);
      this.populate(runtime);
    }

    for (const entity of entities) {
      const runtime = this.runtimes.get(entity.id);
      if (!runtime) continue;
      const parent = entity.parentId ? this.runtimes.get(entity.parentId)?.root : this.sceneRoot;
      (parent ?? this.sceneRoot).add(runtime.root);
    }

    for (const id of addedIds) {
      if (hasAncestorInSet(id, addedIds, nextDefinitions)) continue;
      const runtime = this.runtimes.get(id);
      if (runtime) this.startAppearance(runtime);
    }

    this.definitions = nextDefinitions;
  }

  tick(now = performance.now()): void {
    if (this.disposed) return;

    for (let index = this.scaleAnimations.length - 1; index >= 0; index -= 1) {
      const animation = this.scaleAnimations[index];
      const progress = Math.min(1, (now - animation.startedAt) / animation.duration);
      const eased = animation.disposeWhenFinished ? progress * progress : cubicOut(progress);
      const overshoot = animation.disposeWhenFinished
        ? 0
        : Math.sin(Math.PI * progress) * (1 - progress) * 0.08;
      animation.root.scale.set(
        animation.from.x + ((animation.to.x - animation.from.x) * eased) + (animation.to.x * overshoot),
        animation.from.y + ((animation.to.y - animation.from.y) * eased) + (animation.to.y * overshoot),
        animation.from.z + ((animation.to.z - animation.from.z) * eased) + (animation.to.z * overshoot),
      );
      if (progress < 1) continue;
      this.scaleAnimations.splice(index, 1);
      if (animation.disposeWhenFinished) {
        disposeObject3D(animation.root);
      } else {
        animation.root.scale.copy(animation.to);
      }
    }

    for (let index = this.poofAnimations.length - 1; index >= 0; index -= 1) {
      const animation = this.poofAnimations[index];
      const progress = Math.min(1, (now - animation.startedAt) / animation.duration);
      const deltaSeconds = Math.min(0.05, Math.max(0, now - animation.previousAt) / 1000);
      animation.previousAt = now;
      for (let offset = 0; offset < animation.positions.length; offset += 3) {
        animation.velocities[offset + 2] -= animation.gravity * deltaSeconds;
        animation.positions[offset] += animation.velocities[offset] * deltaSeconds;
        animation.positions[offset + 1] += animation.velocities[offset + 1] * deltaSeconds;
        animation.positions[offset + 2] += animation.velocities[offset + 2] * deltaSeconds;
      }
      const attribute = animation.points.geometry.getAttribute("position") as BufferAttribute;
      attribute.needsUpdate = true;
      animation.points.material.opacity = (1 - progress) ** 1.7;
      if (progress < 1) continue;
      this.poofAnimations.splice(index, 1);
      disposeObject3D(animation.points);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposedRoots = new Set<Group>();
    const roots = [...this.runtimes.values()]
      .sort((left, right) => (
        depthOf(right.definition.id, this.definitions)
        - depthOf(left.definition.id, this.definitions)
      ));
    for (const runtime of roots) {
      disposeObject3D(runtime.root);
      disposedRoots.add(runtime.root);
    }
    for (const animation of this.scaleAnimations) {
      if (!disposedRoots.has(animation.root)) disposeObject3D(animation.root);
    }
    for (const animation of this.poofAnimations) {
      disposeObject3D(animation.points);
    }
    this.scaleAnimations.length = 0;
    this.poofAnimations.length = 0;
    this.runtimes.clear();
    this.definitions.clear();
    this.lastEntities = null;
  }

  private reducedMotionRequested(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private cancelScaleAnimations(root: Group): void {
    for (let index = this.scaleAnimations.length - 1; index >= 0; index -= 1) {
      if (this.scaleAnimations[index].root === root) {
        this.scaleAnimations.splice(index, 1);
      }
    }
  }

  private startAppearance(runtime: EntityRuntime): void {
    const { root } = runtime;
    if (!root.visible || this.reducedMotionRequested()) return;
    this.startPoof(root);
    const target = root.scale.clone();
    const initial = target.clone().multiplyScalar(0.7);
    root.scale.copy(initial);
    this.scaleAnimations.push({
      root,
      from: initial,
      to: target,
      startedAt: performance.now(),
      duration: 340,
      disposeWhenFinished: false,
    });
  }

  private startDisappearance(runtime: EntityRuntime): void {
    const { root } = runtime;
    if (!root.visible || this.reducedMotionRequested()) {
      disposeObject3D(root);
      return;
    }
    this.startPoof(root);
    const initial = root.scale.clone();
    this.scaleAnimations.push({
      root,
      from: initial,
      to: initial.clone().multiplyScalar(0.62),
      startedAt: performance.now(),
      duration: 230,
      disposeWhenFinished: true,
    });
  }

  private startPoof(root: Group): void {
    root.updateWorldMatrix(true, true);
    TMP_BOUNDS.setFromObject(root);
    let spread = 0.1;
    if (TMP_BOUNDS.isEmpty()) {
      root.getWorldPosition(TMP_CENTER);
    } else {
      TMP_BOUNDS.getCenter(TMP_CENTER);
      TMP_BOUNDS.getSize(TMP_SIZE);
      spread = Math.min(0.75, Math.max(0.1, TMP_SIZE.length() * 0.5));
    }
    this.sceneRoot.updateWorldMatrix(true, false);
    this.sceneRoot.worldToLocal(TMP_CENTER);

    const positions = new Float32Array(POOF_PARTICLE_COUNT * 3);
    const velocities = new Float32Array(POOF_PARTICLE_COUNT * 3);
    for (let index = 0; index < POOF_PARTICLE_COUNT; index += 1) {
      const offset = index * 3;
      const z = 1 - (2 * (index + 0.5)) / POOF_PARTICLE_COUNT;
      const planar = Math.sqrt(Math.max(0, 1 - (z * z)));
      const angle = index * GOLDEN_ANGLE;
      const x = Math.cos(angle) * planar;
      const y = Math.sin(angle) * planar;
      const speed = spread * (1.35 + ((index % 5) * 0.11));
      positions[offset] = x * spread * 0.72;
      positions[offset + 1] = y * spread * 0.72;
      positions[offset + 2] = z * spread * 0.72;
      velocities[offset] = x * speed;
      velocities[offset + 1] = y * speed;
      velocities[offset + 2] = (z * speed) + (spread * 0.72);
    }

    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, 3);
    attribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute("position", attribute);
    const material = new PointsMaterial({
      color: 0xffb45c,
      map: createPoofTexture(),
      size: Math.min(0.08, Math.max(0.026, spread * 0.14)),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
    });
    const points = new Points(geometry, material);
    points.name = "Entity poof";
    points.position.copy(TMP_CENTER);
    points.frustumCulled = false;
    points.renderOrder = 30;
    this.sceneRoot.add(points);

    const now = performance.now();
    this.poofAnimations.push({
      points,
      positions,
      velocities,
      startedAt: now,
      previousAt: now,
      duration: 500,
      gravity: spread * 2.7,
    });
  }

  private populate(runtime: EntityRuntime): void {
    const { definition, root } = runtime;


    applyCanonicalTransform(root, definition.transform);
    switch (definition.kind) {
      case "box":
        root.add(markMesh(new Mesh(
          new BoxGeometry(...definition.size),
          createMaterial(definition.material),
        )));
        return;
      case "sphere":
        root.add(markMesh(new Mesh(
          new SphereGeometry(definition.radius, 24, 16),
          createMaterial(definition.material),
        )));
        return;
      case "cylinder": {
        const mesh = markMesh(new Mesh(
          new CylinderGeometry(definition.radius, definition.radius, definition.height, 24, 1),
          createMaterial(definition.material),
        ));
        mesh.rotation.x = Math.PI / 2;
        root.add(mesh);
        return;
      }
      case "capsule": {
        const mesh = markMesh(new Mesh(
          new CapsuleGeometry(definition.radius, definition.height, 8, 16),
          createMaterial(definition.material),
        ));
        mesh.rotation.x = Math.PI / 2;
        root.add(mesh);
        return;
      }
      case "label": {
        const label = createLabel(definition);
        if (label) root.add(label);
        return;
      }
      case "model":
        void this.loader.loadAsync(definition.source).then((gltf) => {
          if (this.disposed || this.runtimes.get(definition.id) !== runtime) {
            disposeObject3D(gltf.scene);
            return;
          }
          root.add(gltf.scene);
        }).catch((error: unknown) => {
          if (this.disposed || this.runtimes.get(definition.id) !== runtime) return;
          this.reportError(`Entity “${definition.name}” failed to load: ${errorMessage(error)}`);
        });
        return;
      case "group":
        return;
    }
  }
}
