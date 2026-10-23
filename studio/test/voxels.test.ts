import {
  decodeOccupancy,
  encodeOccupancy,
  occupancyRuns,
  voxelWireframe,
} from "../src/domain/voxels";

describe("voxel occupancy overlay", () => {
  it("round-trips run-length occupancy and rejects run sums that miss the cell count", () => {
    const occupied = Uint8Array.from({ length: 13 }, (_, cell) => (cell % 3 === 0 ? 1 : 0));

    expect(decodeOccupancy(encodeOccupancy(occupied), 13)).toEqual(occupied);
    expect(() => decodeOccupancy(encodeOccupancy(occupied), 40)).toThrow(/expected 40 cells/);
    expect(() => decodeOccupancy(encodeOccupancy(occupied), 5)).toThrow(/expected 5 cells/);
  });

  it("starts with an empty run, so a leading occupied cell encodes a zero-length empty run", () => {
    const occupied = new Uint8Array(300);
    occupied.fill(1, 0, 200);
    const encoded = encodeOccupancy(occupied);
    // Runs: empty 0, occupied 200 (varint 0xc8 0x01), empty 100.
    expect([...atob(encoded)].map((character) => character.charCodeAt(0))).toEqual([0, 0xc8, 0x01, 100]);
    expect(decodeOccupancy(encoded, 300)).toEqual(occupied);
  });

  it("round-trips an all-empty grid as one empty run", () => {
    const empty = new Uint8Array(1_000_000);
    const encoded = encodeOccupancy(empty);

    expect(encoded.length).toBeLessThan(8);
    expect(decodeOccupancy(encoded, empty.length)).toEqual(empty);
  });

  it("emits each exposed voxel edge once, including edges shared by adjacent cells", () => {
    const single = voxelWireframe(Uint8Array.of(1), [1, 1, 1], 0.5, [0, 0, 0]).positions;
    const pair = voxelWireframe(Uint8Array.of(1, 1), [2, 1, 1], 0.5, [-0.5, -0.25, -0.25]);

    expect(single.length / 6).toBe(12);
    // A 2x1x1 bar: 8 edges along X, 6 along Y, 6 along Z.
    expect(pair.outline).toBe(false);
    expect(pair.positions.length / 6).toBe(20);
    expect(Math.min(...pair.positions.filter((_, index) => index % 3 === 0))).toBe(-0.5);
    expect(Math.max(...pair.positions.filter((_, index) => index % 3 === 0))).toBe(0.5);
  });

  it("keeps only bending edges once the cell wireframe exceeds its edge budget", () => {
    const bar = voxelWireframe(Uint8Array.of(1, 1), [2, 1, 1], 0.5, [0, 0, 0], 0);
    // The 4-edge ring where the two cells meet lies on flat faces and disappears.
    expect(bar.outline).toBe(true);
    expect(bar.positions.length / 6).toBe(16);

    // Diagonal cells in a 2x2x1 grid share one Z edge, which still bends the surface.
    const diagonal = voxelWireframe(Uint8Array.of(1, 0, 0, 1), [2, 2, 1], 0.5, [0, 0, 0], 0);
    const sharedZEdges = [];
    for (let offset = 0; offset < diagonal.positions.length; offset += 6) {
      const [x0, y0, , x1, y1] = diagonal.positions.subarray(offset, offset + 6);
      if (x0 === 0.5 && y0 === 0.5 && x1 === 0.5 && y1 === 0.5) sharedZEdges.push(offset);
    }
    // Two cubes x 12 edges, minus the one they share.
    expect(diagonal.positions.length / 6).toBe(23);
    expect(sharedZEdges).toHaveLength(1);
  });

  it("reports occupied cells as +X runs ordered by layer then row", () => {
    // 3x2x2 grid; layer 0 row 0 = [1,1,0], row 1 = [0,0,0]; layer 1 row 0 = [1,0,1], row 1 = [0,1,1].
    const occupied = Uint8Array.of(1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1);

    expect(occupancyRuns(occupied, [3, 2, 2])).toEqual([
      [0, 0, 0, 1],
      [1, 0, 0, 0],
      [1, 0, 2, 2],
      [1, 1, 1, 2],
    ]);
  });
});
