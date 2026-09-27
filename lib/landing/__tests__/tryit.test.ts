import { describe, expect, it } from "vitest";
import {
  MIN_KEPT_INK_PX,
  TRYIT_CONFIG,
  addErase,
  bboxOf,
  findCorrection,
  hitsStroke,
  inkLength,
  overlapShare,
  padBBox,
  splitByEraser,
  type BBox,
} from "../tryit";

describe("try-it geometry", () => {
  it("bbox, padding and overlap", () => {
    expect(bboxOf([{ x: 10, y: 5 }, { x: 2, y: 20 }])).toEqual([2, 5, 10, 20]);
    expect(padBBox([0, 0, 10, 10])).toEqual([-16, -16, 26, 26]); // min pad wins on small boxes
    expect(overlapShare([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(overlapShare([0, 0, 10, 10], [5, 0, 20, 10])).toBeCloseTo(0.5);
    expect(overlapShare([0, 0, 10, 10], [50, 50, 60, 60])).toBe(0);
    // A perfectly horizontal line still has area.
    expect(overlapShare([0, 5, 10, 5], [0, 0, 10, 10])).toBe(1);
  });

  it("eraser hit test uses distance to segments", () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    expect(hitsStroke(line, { x: 50, y: 10 }, 14)).toBe(true);
    expect(hitsStroke(line, { x: 50, y: 20 }, 14)).toBe(false);
    expect(hitsStroke([{ x: 0, y: 0 }], { x: 3, y: 4 }, 5)).toBe(true);
  });

  it("groups erases close in time and pairs a rewrite in the same spot", () => {
    const a: BBox = [100, 100, 160, 130];
    let groups = addErase([], a, 1000, 1);
    groups = addErase(groups, [150, 100, 200, 130], 2500, 2); // joins group 1
    expect(groups).toHaveLength(1);
    expect(groups[0].bbox).toEqual([100, 100, 200, 130]);

    // Same spot, soon after: a correction.
    expect(findCorrection(groups, [110, 105, 190, 128], 5000)?.id).toBe(1);
    // Somewhere else: not a correction.
    expect(findCorrection(groups, [400, 300, 450, 330], 5000)).toBeNull();
    // Too late.
    expect(findCorrection(groups, [110, 105, 190, 128], 2500 + TRYIT_CONFIG.correctionWindowMs + 1)).toBeNull();
    // Already corrected groups are not paired twice.
    expect(findCorrection([{ ...groups[0], correctedBy: 7 }], [110, 105, 190, 128], 5000)).toBeNull();
  });

  it("starts a new group after the gap", () => {
    let groups = addErase([], [0, 0, 10, 10], 0, 1);
    groups = addErase(groups, [0, 0, 10, 10], TRYIT_CONFIG.eraseGroupGapMs + 1, 2);
    expect(groups.map((g) => g.id)).toEqual([1, 2]);
  });
});

describe("partial eraser", () => {
  const line = Array.from({ length: 11 }, (_, i) => ({ x: i * 20, y: 0 })); // 0..200 px

  it("returns null when the eraser misses", () => {
    expect(splitByEraser(line, [{ x: 100, y: 50 }], 10)).toBeNull();
  });

  it("cuts a hole in the middle: live, erased, live — with boundary points at the eraser's edge", () => {
    const runs = splitByEraser(line, [{ x: 100, y: 0 }], 10)!;
    expect(runs.map((r) => r.erased)).toEqual([false, true, false]);
    const [left, hole, right] = runs;
    expect(left.points[left.points.length - 1].x).toBeCloseTo(90, 0);
    expect(right.points[0].x).toBeCloseTo(110, 0);
    expect(hole.points[0]).toEqual(left.points[left.points.length - 1]);
    expect(inkLength(hole.points)).toBeCloseTo(20, 0);
    expect(inkLength(left.points) + inkLength(hole.points) + inkLength(right.points)).toBeCloseTo(200, 0);
  });

  it("catches a fast drag between two samples (swept path)", () => {
    const runs = splitByEraser(line, [{ x: 60, y: -40 }, { x: 60, y: 40 }], 5)!;
    expect(runs.map((r) => r.erased)).toEqual([false, true, false]);
  });

  it("erases the end of a stroke, leaving one live piece", () => {
    const runs = splitByEraser(line, [{ x: 200, y: 0 }], 30)!;
    expect(runs.map((r) => r.erased)).toEqual([false, true]);
  });

  it("covering the whole stroke returns one erased run with the original points", () => {
    const short = [{ x: 0, y: 0 }, { x: 4, y: 0 }];
    expect(splitByEraser(short, [{ x: 2, y: 0 }], 20)).toEqual([{ erased: true, points: short }]);
  });

  it("drops live crumbs shorter than MIN_KEPT_INK_PX", () => {
    const runs = splitByEraser(line, [{ x: 12, y: 0 }], 10)!; // leaves ~2px at the start
    expect(runs[0].erased).toBe(true);
    expect(runs.every((r) => r.erased || inkLength(r.points) >= MIN_KEPT_INK_PX)).toBe(true);
  });
});
