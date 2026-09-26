import { describe, expect, it } from 'vitest';
import { activeStrokes, computeBBox, inkCounts, splitStrokeByEraser } from '../ink';
import type { Point, Stroke } from '../types';

let seq = 0;
const ids = () => `p${++seq}`;

/** Horizontal line at y from x0 to x1, one point every `step` px, 1 ms per px starting at t0. */
function line(x0: number, x1: number, y: number, step = 10, t0 = 1000): Point[] {
  const pts: Point[] = [];
  for (let x = x0; x <= x1; x += step) pts.push([x, y, 0.5, t0 + (x - x0)]);
  return pts;
}

function mkStroke(points: Point[], overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: 'k_orig',
    sessionId: 'sess-1',
    startMs: points[0][3],
    endMs: points[points.length - 1][3],
    points,
    pointerType: 'pen',
    bbox: computeBBox(points),
    inkLen: 200,
    medianSpeed: 1,
    erased: false,
    erasedAtMs: null,
    erasedBy: null,
    isScribble: false,
    ...overrides,
  };
}

const R = 12;

describe('splitStrokeByEraser', () => {
  it('cuts a stroke rubbed in the middle into 2 live pieces and 1 erased piece', () => {
    const s = mkStroke(line(0, 200, 50));
    const res = splitStrokeByEraser(s, [[100, 40], [100, 60]], R, 5000, ids)!;
    expect(res).not.toBeNull();
    const { parent, pieces } = res;
    expect(pieces.map((p) => p.erased)).toEqual([false, true, false]);
    expect(parent.id).toBe(s.id);
    expect(parent.erased).toBe(false);
    expect(parent.points).toEqual(s.points); // original ink is kept intact for history
    expect(parent.replacedBy).toEqual(pieces.map((p) => p.id));

    const [left, gone, right] = pieces;
    for (const p of pieces) {
      expect(p.splitFrom).toBe(s.id);
      expect(p.replacedBy).toBeNull();
      expect(p.pointerType).toBe('pen');
      expect(p.bbox).toEqual(computeBBox(p.points));
      expect(p.startMs).toBe(p.points[0][3]);
      expect(p.endMs).toBe(p.points[p.points.length - 1][3]);
    }
    // Clean cuts at the eraser edge (x = 100 ± 12), with interpolated time.
    expect(left.points[0]).toEqual(s.points[0]);
    expect(left.points.at(-1)![0]).toBeCloseTo(88, 0);
    expect(gone.points[0][0]).toBeCloseTo(88, 0);
    expect(gone.points.at(-1)![0]).toBeCloseTo(112, 0);
    expect(right.points[0][0]).toBeCloseTo(112, 0);
    expect(right.points.at(-1)).toEqual(s.points.at(-1));
    expect(gone.startMs).toBeCloseTo(1088, -1);
    expect(left.inkLen).toBeCloseTo(88, 0);
    expect(gone.inkLen).toBeCloseTo(24, 0);

    expect(left.erased).toBe(false);
    expect(left.erasedAtMs).toBeNull();
    expect(gone.erasedAtMs).toBe(5000);
    expect(gone.erasedBy).toBe('eraser');
  });

  it('cuts one end off: 1 live piece + 1 erased piece', () => {
    const s = mkStroke(line(0, 200, 50));
    const { pieces } = splitStrokeByEraser(s, [[195, 50]], R, 5000, ids)!;
    expect(pieces.map((p) => p.erased)).toEqual([false, true]);
    expect(pieces[0].points[0]).toEqual(s.points[0]);
    expect(pieces[0].points.at(-1)![0]).toBeCloseTo(183, 0);
    expect(pieces[1].points.at(-1)).toEqual(s.points.at(-1));
  });

  it('erases the stroke in place when the eraser covers all of it', () => {
    const s = mkStroke(line(0, 200, 50));
    const { parent, pieces } = splitStrokeByEraser(s, [[-20, 50], [220, 50]], R, 5000, ids)!;
    expect(pieces).toEqual([parent]);
    expect(parent.id).toBe(s.id);
    expect(parent.erased).toBe(true);
    expect(parent.erasedAtMs).toBe(5000);
    expect(parent.erasedBy).toBe('eraser');
    expect(parent.replacedBy ?? null).toBeNull();
    expect(parent.points).toEqual(s.points);
  });

  it('returns null when the eraser does not touch the stroke', () => {
    const s = mkStroke(line(0, 200, 50));
    expect(splitStrokeByEraser(s, [[100, 100]], R, 5000, ids)).toBeNull();
    expect(splitStrokeByEraser(s, [[0, 70], [200, 70]], R, 5000, ids)).toBeNull();
    expect(splitStrokeByEraser(s, [], R, 5000, ids)).toBeNull();
  });

  it('ignores strokes that are already erased or already cut', () => {
    const s = mkStroke(line(0, 200, 50));
    expect(splitStrokeByEraser({ ...s, erased: true, erasedAtMs: 1, erasedBy: 'eraser' }, [[100, 50]], R, 5000, ids)).toBeNull();
    expect(splitStrokeByEraser({ ...s, replacedBy: ['x', 'y'] }, [[100, 50]], R, 5000, ids)).toBeNull();
  });

  it('interpolates a fast eraser drag: a stroke between two eraser samples is still cut', () => {
    // Sparse stroke (2 points) and a fast eraser swipe whose samples are both 50 px away from it.
    const s = mkStroke([
      [0, 50, 0.5, 1000],
      [200, 50, 0.5, 1200],
    ]);
    const res = splitStrokeByEraser(s, [[100, 0], [100, 100]], R, 5000, ids)!;
    expect(res).not.toBeNull();
    expect(res.pieces.map((p) => p.erased)).toEqual([false, true, false]);
    const gone = res.pieces[1];
    expect(gone.points).toHaveLength(2);
    expect(gone.points[0][0]).toBeCloseTo(88, 0);
    expect(gone.points[1][0]).toBeCloseTo(112, 0);
    expect(gone.points[0][3]).toBeCloseTo(1088, -1);
  });

  it('splits a piece again on a later pass', () => {
    const s = mkStroke(line(0, 200, 50));
    const first = splitStrokeByEraser(s, [[100, 50]], R, 5000, ids)!;
    const left = first.pieces[0];
    const second = splitStrokeByEraser(left, [[40, 40], [40, 60]], R, 9000, ids)!;
    expect(second.parent.id).toBe(left.id);
    expect(second.parent.splitFrom).toBe(s.id);
    expect(second.parent.replacedBy).toEqual(second.pieces.map((p) => p.id));
    expect(second.pieces.map((p) => p.erased)).toEqual([false, true, false]);
    for (const p of second.pieces) expect(p.splitFrom).toBe(left.id);
    expect(second.pieces[1].erasedAtMs).toBe(9000);

    const all = [first.parent, second.parent, ...first.pieces.slice(1), ...second.pieces];
    const active = activeStrokes(all);
    expect(active.filter((p) => !p.erased)).toHaveLength(3);
    expect(active.filter((p) => p.erased)).toHaveLength(2);
  });
});

describe('activeStrokes', () => {
  it('drops replaced parents and keeps live and erased leaves', () => {
    const base = mkStroke(line(0, 20, 0));
    const strokes: Stroke[] = [
      { ...base, id: 'plain' },
      { ...base, id: 'legacy-no-fields', splitFrom: undefined, replacedBy: undefined },
      { ...base, id: 'ghost', erased: true, erasedAtMs: 1, erasedBy: 'eraser' },
      { ...base, id: 'cut', replacedBy: ['a', 'b'] },
      { ...base, id: 'a', splitFrom: 'cut', replacedBy: null },
      { ...base, id: 'b', splitFrom: 'cut', replacedBy: [], erased: true, erasedAtMs: 2, erasedBy: 'eraser' },
    ];
    expect(activeStrokes(strokes).map((s) => s.id)).toEqual(['plain', 'legacy-no-fields', 'ghost', 'a', 'b']);
  });
});

describe('inkCounts (lines the student drew, not pieces)', () => {
  it('a line with its middle rubbed out is 1 stroke · 1 erased part', () => {
    const s = mkStroke(line(0, 200, 50), { id: 'k_line' });
    const { parent, pieces } = splitStrokeByEraser(s, [[100, 40], [100, 60]], R, 5000, ids)!;
    expect(inkCounts([parent, ...pieces])).toEqual({ drawn: 1, erasedParts: 1 });
  });

  it('a word erased whole in place is 1 stroke · 1 erased part', () => {
    const s = mkStroke(line(0, 60, 50), { id: 'k_w', erased: true, erasedAtMs: 9, erasedBy: 'eraser' });
    expect(inkCounts([s])).toEqual({ drawn: 1, erasedParts: 1 });
  });

  it('a scribble-out: the word counts, the zig-zag gesture does not', () => {
    const word = mkStroke(line(0, 60, 50), { id: 'k_word', erased: true, erasedAtMs: 9, erasedBy: 'scribble' });
    const zig = mkStroke(line(0, 60, 52), { id: 'k_zig', isScribble: true, erased: true, erasedAtMs: 9, erasedBy: 'scribble' });
    expect(inkCounts([word, zig])).toEqual({ drawn: 1, erasedParts: 1 });
  });

  it('a strike-through: the struck word counts as erased, the line itself is a gesture', () => {
    const word = mkStroke(line(0, 60, 50), { id: 'k_word2', erased: true, erasedAtMs: 9, erasedBy: 'strike' });
    const bar = mkStroke(line(0, 60, 50), { id: 'k_bar', isScribble: true, erased: true, erasedAtMs: 9, erasedBy: 'strike' });
    expect(inkCounts([word, bar])).toEqual({ drawn: 1, erasedParts: 1 });
  });

  it('an undone stroke was taken back: neither drawn nor an erased part', () => {
    const kept = mkStroke(line(0, 60, 50), { id: 'k_keep' });
    const undone = mkStroke(line(0, 60, 90), { id: 'k_undo', erased: true, erasedAtMs: 9, erasedBy: 'undo' });
    expect(inkCounts([kept, undone])).toEqual({ drawn: 1, erasedParts: 0 });
  });

  it('empty page', () => {
    expect(inkCounts([])).toEqual({ drawn: 0, erasedParts: 0 });
  });
});
