import {
  BoxGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Path,
  Quaternion,
  Shape,
  Vector3,
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
  mesh.name = "Perforated table top";
  return mesh;
}

function addSideHolePattern(
  group: Group,
  parameters: TableParameters,
  material: MeshStandardMaterial,
): void {
  const width = positive(parameters.width);
  const length = positive(parameters.length);
  const thickness = positive(parameters.topThickness);
  const radius = positive(parameters.holeDiameter) / 2;
  const pitch = positive(parameters.holePitch);
  const edge = Math.max(radius, parameters.edgeToHole);
  const columns = Math.min(100, Math.max(0, Math.floor(parameters.columns)));
  const rows = Math.min(100, Math.max(0, Math.floor(parameters.rows)));
  const maximumHoleCount = 2 * (columns + rows);
  const alongY = new Quaternion();
  const alongX = new Quaternion().setFromAxisAngle(
    new Vector3(0, 0, 1),
    Math.PI / 2,
  );
  const z = parameters.topHeight - thickness / 2;
  if (maximumHoleCount === 0) return;

  const geometry = new CylinderGeometry(radius, radius, 0.0015, 16);
  const holes = new InstancedMesh(geometry, material, maximumHoleCount);
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3(1, 1, 1);
  let holeIndex = 0;

  for (let column = 0; column < columns; column += 1) {
    const x = -width / 2 + edge + column * pitch;
    if (x - radius < -width / 2 || x + radius > width / 2) continue;
    position.set(x, -length / 2 - 0.0003, z);
    matrix.compose(position, alongY, scale);
    holes.setMatrixAt(holeIndex, matrix);
    holeIndex += 1;

    position.set(x, length / 2 + 0.0003, z);
    matrix.compose(position, alongY, scale);
    holes.setMatrixAt(holeIndex, matrix);
    holeIndex += 1;
  }

  for (let row = 0; row < rows; row += 1) {
    const y = -length / 2 + edge + row * pitch;
    if (y - radius < -length / 2 || y + radius > length / 2) continue;
    position.set(-width / 2 - 0.0003, y, z);
    matrix.compose(position, alongX, scale);
    holes.setMatrixAt(holeIndex, matrix);
    holeIndex += 1;

    position.set(width / 2 + 0.0003, y, z);
    matrix.compose(position, alongX, scale);
    holes.setMatrixAt(holeIndex, matrix);
    holeIndex += 1;
  }

  holes.count = holeIndex;
  holes.instanceMatrix.needsUpdate = true;
  holes.name = "Table edge holes";
  group.add(holes);
}

/** Build a Z-up table whose topHeight is the finished top-surface elevation. */
export function createParametricTable(parameters: TableParameters): Group {
  const group = new Group();
  group.name = "Parametric welding table";

  const steel = new MeshStandardMaterial({
    color: 0x5e6b72,
    metalness: 0.55,
    roughness: 0.45,
  });
  const edges = new MeshStandardMaterial({
    color: 0x5e6b72,
    metalness: 0.5,
    roughness: 0.5,
  });
  const holeInterior = new MeshStandardMaterial({
    color: 0x151b1e,
    metalness: 0.18,
    roughness: 0.82,
  });
  const frame = new MeshStandardMaterial({
    color: 0x36434a,
    metalness: 0.35,
    roughness: 0.62,
  });
  const feet = new MeshStandardMaterial({
    color: 0x222c31,
    metalness: 0.15,
    roughness: 0.75,
  });

  group.add(makePerforatedTop(parameters, steel, edges));
  addSideHolePattern(group, parameters, holeInterior);

  const width = positive(parameters.width);
  const length = positive(parameters.length);
  const thickness = positive(parameters.topThickness);
  const legSize = Math.min(
    positive(parameters.legSize),
    width / 3,
    length / 3,
  );
  const underside = Math.max(0, parameters.topHeight - thickness);

  // Measurements below come from the reconstructed table mesh aligned to the
  // capture. The top is a 4-inch box on a mobile square-tube frame.
  const legCenterX = Math.max(0, width / 2 - 0.04);
  const legCenterY = Math.max(0, length / 2 - 0.06);
  const wheelRadius = 0.045;
  const wheelWidth = 0.036;
  const casterMountSize: readonly [number, number, number] = [
    0.105,
    0.125,
    0.11,
  ];
  const casterMountZ = 0.1127;
  const legBottom = Math.min(0.1477, Math.max(0, underside - MIN_SIZE));
  const legHeight = Math.max(MIN_SIZE, underside - legBottom);
  const legGeometry = new BoxGeometry(legSize, legSize, legHeight);
  const casterMountGeometry = new BoxGeometry(...casterMountSize);
  const wheelGeometry = new CylinderGeometry(
    wheelRadius,
    wheelRadius,
    wheelWidth,
    24,
  );

  for (const x of [-legCenterX, legCenterX]) {
    for (const y of [-legCenterY, legCenterY]) {
      addBox(
        group,
        legGeometry,
        [x, y, legBottom + legHeight / 2],
        frame,
      );
      addBox(
        group,
        casterMountGeometry,
        [x, y, casterMountZ],
        frame,
      );

      const wheel = new Mesh(wheelGeometry, feet);
      // CylinderGeometry is Y-axis aligned; the captured caster axles run X.
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, y, wheelRadius);
      group.add(wheel);
    }
  }

  const railSize = 0.052;
  const railZ = Math.min(
    0.1927,
    Math.max(railSize / 2, underside - railSize / 2),
  );
  const railLength = Math.max(MIN_SIZE, length - 0.12);
  const railWidth = Math.max(MIN_SIZE, width - 0.08);
  const lengthRailGeometry = new BoxGeometry(
    railSize,
    railLength,
    railSize,
  );
  const widthRailGeometry = new BoxGeometry(
    railWidth,
    railSize,
    railSize,
  );

  addBox(
    group,
    lengthRailGeometry,
    [-legCenterX, 0, railZ],
    frame,
  );
  addBox(
    group,
    lengthRailGeometry,
    [legCenterX, 0, railZ],
    frame,
  );
  addBox(
    group,
    widthRailGeometry,
    [0, -legCenterY, railZ],
    frame,
  );
  addBox(
    group,
    widthRailGeometry,
    [0, legCenterY, railZ],
    frame,
  );

  return group;
}
