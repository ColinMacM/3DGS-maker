import {
  Material,
  Object3D,
  Texture,
} from "three";

type DisposableGeometry = { dispose(): void };

interface StudioSplat extends Object3D {
  dispose(): void;
}

function isStudioSplat(object: Object3D): object is StudioSplat {
  const candidate = object as Object3D & { dispose?: unknown };
  return (
    object.userData.studioSplat === true &&
    typeof candidate.dispose === "function"
  );
}

function disposeMaterialTextures(
  material: Material,
  disposedTextures: Set<Texture>,
): void {
  for (const value of Object.values(material)) {
    if (!(value instanceof Texture) || disposedTextures.has(value)) {
      continue;
    }
    disposedTextures.add(value);
    value.dispose();
  }
}

/** Dispose all GPU resources owned by an object subtree, even when shared. */
export function disposeObject3D(root: Object3D): void {
  const geometries = new Set<DisposableGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const splats = new Set<StudioSplat>();

  root.traverse((object) => {
    if (isStudioSplat(object)) {
      splats.add(object);
      return;
    }

    const geometry = (object as Object3D & {
      geometry?: DisposableGeometry;
    }).geometry;
    if (geometry) {
      geometries.add(geometry);
    }

    const objectMaterial = (object as Object3D & {
      material?: Material | Material[];
    }).material;
    if (Array.isArray(objectMaterial)) {
      for (const material of objectMaterial) materials.add(material);
    } else if (objectMaterial) {
      materials.add(objectMaterial);
    }
  });

  for (const splat of splats) {
    if (splat.userData.studioDisposed === true) continue;
    splat.userData.studioDisposed = true;
    splat.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    disposeMaterialTextures(material, textures);
    material.dispose();
  }

  root.removeFromParent();
  root.clear();
}

export function replaceGroupContents(
  group: Object3D,
  replacement: Object3D | null,
): void {
  for (const child of [...group.children]) disposeObject3D(child);
  if (replacement) group.add(replacement);
}
