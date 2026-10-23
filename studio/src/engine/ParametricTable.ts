import {
  BoxGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
} from "three";

import type { TableParameters } from "../domain/types";

const MIN_SIZE = 0.0001;
const MAX_HOLES = 4096;

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_SIZE, value) : MIN_SIZE;
}

function addBox(
  group: Group,
  geometry: BoxGeometry,
  position: readonly [number, number, number],
  material: MeshStandardMaterial,
): void {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function makePerforatedTop(
  parameters: TableParameters,
  topMaterial: MeshStandardMaterial,
  edgeMaterial: MeshStandardMaterial,
): Mesh {
  const width = positive(parameters.width);
  const length = positive(parameters.length);
  const thickness = positive(parameters.topThickness);
  const radius = positive(parameters.holeDiameter) / 2;
  const pitch = positive(parameters.holePitch);
  const edge = Math.max(radius, parameters.edgeToHole);
  const columns = Math.min(100, Math.max(0, Math.floor(parameters.columns)));
  const rows = Math.min(100, Math.max(0, Math.floor(parameters.rows)));

  // Clockwise outer contour with counter-clockwise holes is the convention
  // expected by ShapeUtils' triangulation.
  const shape = new Shape();
  shape.moveTo(-width / 2, -length / 2);
  shape.lineTo(-width / 2, length / 2);
  shape.lineTo(width / 2, length / 2);
  shape.lineTo(width / 2, -length / 2);
  shape.closePath();

  let holeCount = 0;
  for (let row = 0; row < rows && holeCount < MAX_HOLES; row += 1) {
    const y = -length / 2 + edge + row * pitch;
    if (y - radius < -length / 2 || y + radius > length / 2) continue;

    for (
      let column = 0;
      column < columns && holeCount < MAX_HOLES;
      column += 1
    ) {
      const x = -width / 2 + edge + column * pitch;
      if (x - radius < -width / 2 || x + radius > width / 2) continue;

      const hole = new Path();
      hole.absarc(x, y, radius, 0, Math.PI * 2, false);
      shape.holes.push(hole);
      holeCount += 1;
    }
  }

  const geometry = new ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: 16,
    depth: thickness,
    steps: 1,
  });
  geometry.computeVertexNormals();

  const mesh = new Mesh(geometry, [topMaterial, edgeMaterial]);
  mesh.position.z = parameters.topHeight - thickness;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "Perforated table top";
  return mesh;
}

/** Build a Z-up table whose topHeight is the finished top-surface elevation. */
export function createParametricTable(parameters: TableParameters): Group {
  const group = new Group();
  group.name = "Parametric welding table";

  const steel = new MeshStandardMaterial({
    color: 0x5e6b72,
    metalness: 0.82,
    roughness: 0.34,
  });
  const edges = new MeshStandardMaterial({
    color: 0x263137,
    metalness: 0.78,
    roughness: 0.42,
  });
  const frame = new MeshStandardMaterial({
    color: 0x222d33,
    metalness: 0.72,
    roughness: 0.48,
  });
  const feet = new MeshStandardMaterial({
    color: 0x11181c,
    metalness: 0.25,
    roughness: 0.72,
  });

  group.add(makePerforatedTop(parameters, steel, edges));

  const width = positive(parameters.width);
  const length = positive(parameters.length);
  const thickness = positive(parameters.topThickness);
  const legSize = Math.min(
    positive(parameters.legSize),
    width / 3,
    length / 3,
  );
  const underside = Math.max(0, parameters.topHeight - thickness);
  const legHeight = Math.max(MIN_SIZE, underside);
  const insetX = Math.max(0, width / 2 - legSize);
  const insetY = Math.max(0, length / 2 - legSize);
  const legGeometry = new BoxGeometry(legSize, legSize, legHeight);
  const footGeometry = new CylinderGeometry(
    legSize * 0.64,
    legSize * 0.72,
    0.012,
    20,
  );

  for (const x of [-insetX, insetX]) {
    for (const y of [-insetY, insetY]) {
      addBox(
        group,
        legGeometry,
        [x, y, legHeight / 2],
        frame,
      );

      const foot = new Mesh(footGeometry, feet);
      // CylinderGeometry is Y-axis aligned; orient it to canonical Z.
      foot.rotation.x = Math.PI / 2;
      foot.position.set(x, y, 0.006);
      foot.castShadow = true;
      foot.receiveShadow = true;
      group.add(foot);
    }
  }

  const apronDepth = Math.min(0.08, Math.max(0.025, legSize));
  const apronThickness = Math.min(0.035, legSize * 0.45);
  const apronZ = Math.max(apronDepth / 2, underside - apronDepth / 2);
  const railLength = Math.max(MIN_SIZE, length - legSize * 2);
  const railWidth = Math.max(MIN_SIZE, width - legSize * 2);
  const lengthApronGeometry = new BoxGeometry(
    apronThickness,
    railLength,
    apronDepth,
  );
  const widthApronGeometry = new BoxGeometry(
    railWidth,
    apronThickness,
    apronDepth,
  );

  addBox(
    group,
    lengthApronGeometry,
    [-insetX, 0, apronZ],
    frame,
  );
  addBox(
    group,
    lengthApronGeometry,
    [insetX, 0, apronZ],
    frame,
  );
  addBox(
    group,
    widthApronGeometry,
    [0, -insetY, apronZ],
    frame,
  );
  addBox(
    group,
    widthApronGeometry,
    [0, insetY, apronZ],
    frame,
  );

  return group;
}
