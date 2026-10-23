import {
  Color,
  Material,
  Mesh,
  MeshBasicMaterial,
  Texture,
} from "three";
import type { Object3D } from "three";

interface ColorMaterial extends Material {
  alphaMap?: Texture | null;
  color?: Color;
  map?: Texture | null;
}

function toUnlit(material: Material): MeshBasicMaterial {
  if (material instanceof MeshBasicMaterial) {
    material.toneMapped = false;
    return material;
  }

  const source = material as ColorMaterial;
  const unlit = new MeshBasicMaterial({
    alphaMap: source.alphaMap ?? null,
    alphaTest: material.alphaTest,
    color: source.color?.clone() ?? new Color(0xffffff),
    depthTest: material.depthTest,
    depthWrite: material.depthWrite,
    map: source.map ?? null,
    opacity: material.opacity,
    side: material.side,
    transparent: material.transparent || material.opacity < 1,
    vertexColors: source.vertexColors === true,
  });
  unlit.name = material.name;
  unlit.userData = { ...material.userData };
  unlit.toneMapped = false;
  material.dispose();
  return unlit;
}

export function makeObjectMaterialsUnlit(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.castShadow = false;
    object.receiveShadow = false;
    object.material = Array.isArray(object.material)
      ? object.material.map(toUnlit)
      : toUnlit(object.material);
  });
}
