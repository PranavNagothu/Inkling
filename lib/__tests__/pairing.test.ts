import { describe, expect, it } from 'vitest';
import { detectScribble, pairRevisions } from '../pairing';
import { computeBBox, splitStrokeByEraser } from '../ink';
import type { BBox, EraseEvent, Point, Stroke } from '../types';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function mkStroke(overrides: Partial<Stroke> = {}): Stroke {
  const id = overrides.id ?? nextId('s');
  return {
    id,
    sessionId: 'sess-1',
    startMs: 0,
    endMs: 100,
    points: [
      [0, 0, 0.5, 0],
      [10, 10, 0.5, 100],
    ] as Point[],
    pointerType: 'pen',
    bbox: [0, 0, 10, 10] as BBox,
    inkLen: 50,
    medianSpeed: 1,
    erased: false,
    erasedAtMs: null,
    erasedBy: null,
    isScribble: false,
    ...overrides,
  };
}

function mkEraseEvent(overrides: Partial<EraseEvent> = {}): EraseEvent {
  return {
    id: nextId('ev'),
    sessionId: 'sess-1',
    atMs: 0,
    strokeIds: [],
    by: 'eraser',
    ...overrides,
  };
}

describe('pairRevisions', () => {
  it('pairs an erase followed by a rewrite in the same spot as a correction', () => {
    const before = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 200,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const after = mkStroke({
      id: 'b',
      startMs: 10500,
      endMs: 10700,
      bbox: [0, 0, 100, 20],
      inkLen: 60,
    });
    const revisions = pairRevisions({
      sessionId: 'sess-1',
      strokes: [before, after],
      eraseEvents: [mkEraseEvent({ atMs: 10000, strokeIds: ['a'] })],
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('correction');
    expect(revisions[0].beforeStrokeIds).toEqual(['a']);
    expect(revisions[0].afterStrokeIds).toEqual(['b']);
    expect(revisions[0].lectureMs).toBe(10000);
  });

  it('classifies an erase with nothing drawn after as a deletion', () => {
    const before = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 200,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [before], eraseEvents: [] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('deletion');
    expect(revisions[0].afterStrokeIds).toEqual([]);
  });

  it('classifies erasing a stroke that was drawn moments ago as micro, even if something is drawn after', () => {
    const before = mkStroke({
      id: 'a',
      startMs: 9000,
      endMs: 9100,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000, // only 1s old -- under microAgeMs (3000)
      erasedBy: 'eraser',
    });
    const after = mkStroke({ id: 'b', startMs: 10500, bbox: [0, 0, 100, 20], inkLen: 60 });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [before, after], eraseEvents: [] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('micro');
  });

  it('classifies erasing a tiny amount of ink as micro regardless of age', () => {
    const before = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 100,
      bbox: [0, 0, 10, 10],
      inkLen: 10, // under minErasedInkPx (40)
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [before], eraseEvents: [] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('micro');
  });

  it('excludes undo-erased strokes entirely', () => {
    const undone = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 100,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'undo',
    });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [undone], eraseEvents: [] });
    expect(revisions).toHaveLength(0);
  });

  it('does not pair a rewrite drawn far away spatially (stays a deletion)', () => {
    const before = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 200,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const farAway = mkStroke({ id: 'b', startMs: 10500, bbox: [500, 500, 600, 520], inkLen: 60 });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [before, farAway], eraseEvents: [] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('deletion');
    expect(revisions[0].afterStrokeIds).toEqual([]);
  });

  it('does not pair a rewrite drawn 25s later (beyond the correction window) -- stays a deletion', () => {
    const before = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 200,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const tooLate = mkStroke({ id: 'b', startMs: 10000 + 25000, bbox: [0, 0, 100, 20], inkLen: 60 });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [before, tooLate], eraseEvents: [] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('deletion');
    expect(revisions[0].afterStrokeIds).toEqual([]);
  });

  it('keeps two simultaneous but spatially separate erasures as two revisions', () => {
    const regionA = mkStroke({
      id: 'a1',
      startMs: 0,
      endMs: 100,
      bbox: [0, 0, 50, 50],
      inkLen: 100,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const regionB = mkStroke({
      id: 'a2',
      startMs: 0,
      endMs: 100,
      bbox: [1000, 1000, 1050, 1050],
      inkLen: 100,
      erased: true,
      erasedAtMs: 10050, // very close in time to regionA
      erasedBy: 'eraser',
    });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [regionA, regionB], eraseEvents: [] });
    expect(revisions).toHaveLength(2);
    const beforeIds = revisions.map((r) => r.beforeStrokeIds[0]).sort();
    expect(beforeIds).toEqual(['a1', 'a2']);
  });

  it('chains repeated erase/rewrite cycles in the same region into a single revision (first before, final after)', () => {
    const first = mkStroke({
      id: 'a',
      startMs: 0,
      endMs: 100,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 10000,
      erasedBy: 'eraser',
    });
    const intermediate = mkStroke({
      id: 'b',
      startMs: 10500,
      endMs: 10700,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
      erased: true,
      erasedAtMs: 20000,
      erasedBy: 'eraser',
    });
    const final = mkStroke({
      id: 'c',
      startMs: 35000,
      endMs: 35200,
      bbox: [0, 0, 100, 20],
      inkLen: 200,
    });
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [first, intermediate, final], eraseEvents: [] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].beforeStrokeIds).toEqual(['a']);
    expect(revisions[0].afterStrokeIds).toEqual(['c']);
    expect(revisions[0].kind).toBe('correction');
  });

  it('pairs a partially erased stroke with a rewrite in the gap as a correction', () => {
    // "x^2 + 1" written as one long stroke at y=50; the student rubs out the middle and rewrites it.
    const pts: Point[] = [];
    for (let x = 0; x <= 200; x += 10) pts.push([x, 50, 0.5, 1000 + x * 5]);
    const original = mkStroke({
      id: 'orig',
      startMs: 1000,
      endMs: 2000,
      points: pts,
      bbox: computeBBox(pts),
      inkLen: 200,
    });
    let n = 0;
    const cut = splitStrokeByEraser(original, [[75, 50], [125, 50]], 12, 10000, () => `piece-${++n}`)!;
    expect(cut.pieces.map((p) => p.erased)).toEqual([false, true, false]);
    const erasedPiece = cut.pieces[1];
    const rewrite = mkStroke({
      id: 'rewrite',
      startMs: 11000,
      endMs: 11400,
      points: [
        [70, 40, 0.5, 11000],
        [130, 60, 0.5, 11400],
      ] as Point[],
      bbox: [70, 40, 130, 60],
      inkLen: 63,
    });
    const revisions = pairRevisions({
      sessionId: 'sess-1',
      // The replaced parent is passed too (as loaded from the DB) and must be ignored.
      strokes: [cut.parent, ...cut.pieces, rewrite],
      eraseEvents: [mkEraseEvent({ atMs: 10000, strokeIds: [erasedPiece.id] })],
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('correction');
    expect(revisions[0].beforeStrokeIds).toEqual([erasedPiece.id]);
    expect(revisions[0].afterStrokeIds).toEqual(['rewrite']);
  });
});

describe('detectScribble', () => {
  it('detects a zig-zagging stroke that covers a word as a scribble', () => {
    const word = mkStroke({ id: 'word', bbox: [0, 0, 100, 20] });
    const scribble = mkStroke({
      id: 'scribble',
      bbox: [0, 0, 50, 20],
      inkLen: 500,
      points: [
        [0, 0, 0.5, 0],
        [50, 20, 0.5, 10],
        [0, 0, 0.5, 20],
        [50, 20, 0.5, 30],
        [0, 0, 0.5, 40],
        [50, 20, 0.5, 50],
        [0, 0, 0.5, 60],
        [50, 20, 0.5, 70],
      ] as Point[],
    });
    expect(detectScribble(scribble, [word])).toEqual(['word']);
  });

  it('does not treat a near-straight underline stroke as a scribble', () => {
    const word = mkStroke({ id: 'word', bbox: [0, 0, 100, 20] });
    const underline = mkStroke({
      id: 'underline',
      bbox: [0, 18, 100, 20],
      inkLen: 100,
      points: [
        [0, 19, 0.5, 0],
        [100, 19, 0.5, 100],
      ] as Point[],
    });
    expect(detectScribble(underline, [word])).toEqual([]);
  });

  it('returns no ids when a scribbly stroke does not cover any earlier stroke', () => {
    const farAway = mkStroke({ id: 'far', bbox: [500, 500, 600, 520] });
    const scribble = mkStroke({
      id: 'scribble',
      bbox: [0, 0, 50, 20],
      inkLen: 500,
      points: [
        [0, 0, 0.5, 0],
        [50, 20, 0.5, 10],
        [0, 0, 0.5, 20],
        [50, 20, 0.5, 30],
        [0, 0, 0.5, 40],
        [50, 20, 0.5, 50],
        [0, 0, 0.5, 60],
        [50, 20, 0.5, 70],
      ] as Point[],
    });
    expect(detectScribble(scribble, [farAway])).toEqual([]);
  });
});
