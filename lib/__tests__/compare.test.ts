import { describe, expect, it } from 'vitest';
import {
  REVEAL_BIG_STEP,
  REVEAL_STEP,
  clampReveal,
  fitContain,
  hiddenStats,
  inkFrame,
  momentAnchors,
  revealAt,
  revealForKey,
  spreadMarkers,
  toScreenRect,
} from '../compare';
import type { BBox, Point, Revision, Stroke, TimelineEvent } from '../types';

function stroke(id: string, bbox: BBox, extra: Partial<Stroke> = {}): Stroke {
  const points: Point[] = [
    [bbox[0], bbox[1], 0.5, extra.startMs ?? 0],
    [bbox[2], bbox[3], 0.5, (extra.startMs ?? 0) + 500],
  ];
  return {
    id,
    sessionId: 's',
    startMs: 0,
    endMs: 500,
    points,
    pointerType: 'mouse',
    bbox,
    inkLen: 10,
    medianSpeed: 0.1,
    erased: false,
    erasedAtMs: null,
    erasedBy: null,
    isScribble: false,
    ...extra,
  };
}

function event(id: string, type: TimelineEvent['type'], lectureMs: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id,
    sessionId: 's',
    lectureMs,
    type,
    status: type === 'unresolved_gap' ? 'open' : 'resolved',
    conceptId: null,
    evidence: { excerpt: '', audioStartMs: 0, audioEndMs: 0 },
    checkAttempts: [],
    ...extra,
  };
}

function revision(id: string, bbox: BBox): Revision {
  return { id, sessionId: 's', lectureMs: 0, beforeStrokeIds: [], afterStrokeIds: [], bbox, kind: 'correction' };
}

describe('hiddenStats', () => {
  it('counts erased pieces on the page and each kind of moment', () => {
    const strokes = [
      stroke('a', [0, 0, 10, 10]),
      stroke('b', [0, 0, 10, 10], { erased: true, erasedAtMs: 5, erasedBy: 'eraser' }),
      // Cut by a partial erase: history only, its pieces count instead.
      stroke('c', [0, 0, 10, 10], { replacedBy: ['c1', 'c2'] }),
      stroke('c1', [0, 0, 5, 10], { splitFrom: 'c' }),
      stroke('c2', [5, 0, 10, 10], { splitFrom: 'c', erased: true, erasedAtMs: 9, erasedBy: 'eraser' }),
      // A scribble-out's zig-zag is stored erased: ghost ink too.
      stroke('z', [0, 0, 10, 10], { erased: true, erasedAtMs: 9, erasedBy: 'scribble', isScribble: true }),
    ];
    const events = [
      event('1', 'misconception_corrected', 1),
      event('2', 'misconception_corrected', 2),
      event('3', 'unresolved_gap', 3),
      event('4', 'breakthrough', 4),
    ];
    expect(hiddenStats(strokes, events)).toEqual({ erased: 3, corrections: 2, gaps: 1, breakthroughs: 1 });
  });

  it('does not count undone strokes as erased (an ordinary Undo takes ink back, it is not an erase)', () => {
    const strokes = [
      stroke('a', [0, 0, 10, 10]),
      stroke('b', [0, 0, 10, 10], { erased: true, erasedAtMs: 5, erasedBy: 'eraser' }),
      // Undo of a plain stroke, and an undone scribble-out (its zig-zag becomes erasedBy 'undo').
      stroke('u', [0, 0, 10, 10], { erased: true, erasedAtMs: 6, erasedBy: 'undo' }),
      stroke('uz', [0, 0, 10, 10], { erased: true, erasedAtMs: 7, erasedBy: 'undo', isScribble: true }),
      // Pen gestures stay hidden ink: the strike-through line and what it struck.
      stroke('s', [0, 0, 10, 10], { erased: true, erasedAtMs: 8, erasedBy: 'strike', isScribble: true }),
      stroke('t', [0, 0, 10, 10], { erased: true, erasedAtMs: 8, erasedBy: 'strike' }),
    ];
    expect(hiddenStats(strokes, []).erased).toBe(3);
  });

  it('is all zeros for an empty session', () => {
    expect(hiddenStats([], [])).toEqual({ erased: 0, corrections: 0, gaps: 0, breakthroughs: 0 });
  });
});

describe('fitContain', () => {
  it('scales content to fit and centres it', () => {
    expect(fitContain({ width: 200, height: 100 }, { width: 400, height: 400 })).toEqual({
      scale: 2,
      x: 0,
      y: 100,
      width: 400,
      height: 200,
    });
    expect(fitContain({ width: 100, height: 200 }, { width: 400, height: 200 })).toEqual({
      scale: 1,
      x: 150,
      y: 0,
      width: 100,
      height: 200,
    });
  });

  it('respects a maximum scale', () => {
    expect(fitContain({ width: 100, height: 100 }, { width: 400, height: 400 }, 1.5)).toEqual({
      scale: 1.5,
      x: 125,
      y: 125,
      width: 150,
      height: 150,
    });
  });

  it('never divides by zero', () => {
    expect(fitContain({ width: 0, height: 0 }, { width: 400, height: 400 }).scale).toBe(0);
    expect(fitContain({ width: 100, height: 100 }, { width: 0, height: 400 }).scale).toBe(0);
  });
});

describe('inkFrame', () => {
  it('is the page from its top-left corner to past the furthest ink', () => {
    const frame = inkFrame([stroke('a', [100, 50, 300, 90]), stroke('b', [20, 400, 60, 420])], { pad: 20, min: [0, 0] });
    expect(frame).toEqual([0, 0, 320, 440]);
  });

  it('ignores replaced strokes and has a minimum size for sparse or empty pages', () => {
    expect(inkFrame([], { pad: 20, min: [600, 400] })).toEqual([0, 0, 600, 400]);
    expect(inkFrame([stroke('a', [0, 0, 5000, 10], { replacedBy: ['x'] })], { pad: 0, min: [100, 100] })).toEqual([
      0, 0, 100, 100,
    ]);
  });
});

describe('momentAnchors', () => {
  const strokes = [
    stroke('early', [10, 10, 60, 20], { startMs: 1_000, endMs: 2_000 }),
    stroke('slow', [300, 300, 360, 320], { startMs: 221_000, endMs: 225_000 }),
    stroke('gone', [100, 100, 150, 120], { startMs: 90_000, endMs: 91_000, erased: true, erasedAtMs: 222_000, erasedBy: 'eraser' }),
    stroke('late', [500, 500, 560, 520], { startMs: 300_000, endMs: 301_000 }),
  ];

  it('uses the revision bbox when the moment has one', () => {
    const events = [event('c', 'misconception_corrected', 150_000, { revisionId: 'r1' })];
    expect(momentAnchors(events, [revision('r1', [1, 2, 3, 4])], strokes)).toEqual([{ event: events[0], bbox: [1, 2, 3, 4] }]);
  });

  it('otherwise covers the ink written or erased in the moment’s scoring window', () => {
    const gap = event('g', 'unresolved_gap', 220_000, { windowStartMs: 220_000 });
    expect(momentAnchors([gap], [], strokes)).toEqual([{ event: gap, bbox: [100, 100, 360, 320] }]);
  });

  it('falls back to the nearest ink in time, and skips moments with nothing on the page', () => {
    // Nothing in its window (330–340 s): the closest ink in time is 'late' (300 s).
    const lone = event('l', 'breakthrough', 335_000);
    expect(momentAnchors([lone], [], strokes)).toEqual([{ event: lone, bbox: [500, 500, 560, 520] }]);
    expect(momentAnchors([lone], [], [])).toEqual([]);
  });

  it('falls back when the linked revision is missing', () => {
    const e = event('c', 'misconception_corrected', 1_500, { revisionId: 'missing', windowStartMs: 0 });
    expect(momentAnchors([e], [], strokes)).toEqual([{ event: e, bbox: [10, 10, 60, 20] }]);
  });
});

describe('toScreenRect', () => {
  it('maps a world bbox through the fitted frame', () => {
    const frame: BBox = [0, 0, 200, 100];
    const fit = fitContain({ width: 200, height: 100 }, { width: 400, height: 400 });
    expect(toScreenRect([10, 20, 110, 70], frame, fit)).toEqual({ left: 20, top: 140, width: 200, height: 100 });
  });
});

describe('spreadMarkers', () => {
  it('nudges markers that would overlap to the right, keeping order', () => {
    expect(
      spreadMarkers(
        [
          { x: 100, y: 100 },
          { x: 105, y: 102 },
          { x: 300, y: 100 },
        ],
        32,
      ),
    ).toEqual([
      { x: 100, y: 100 },
      { x: 132, y: 102 },
      { x: 300, y: 100 },
    ]);
  });

  it('keeps spreading when a nudge lands on another marker', () => {
    const out = spreadMarkers(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      32,
    );
    expect(out.map((p) => p.x)).toEqual([0, 32, 64]);
  });
});

describe('overlay reveal', () => {
  it('clamps to 0–100 and rounds to a tenth', () => {
    expect(clampReveal(-5)).toBe(0);
    expect(clampReveal(140)).toBe(100);
    expect(clampReveal(33.333)).toBe(33.3);
    expect(clampReveal(Number.NaN)).toBe(50);
  });

  it('reads the reveal from a pointer position over the stage', () => {
    expect(revealAt(250, { left: 50, width: 400 })).toBe(50);
    expect(revealAt(0, { left: 50, width: 400 })).toBe(0);
    expect(revealAt(1000, { left: 50, width: 400 })).toBe(100);
    expect(revealAt(100, { left: 0, width: 0 })).toBe(50);
  });

  it('moves with the keyboard like a slider', () => {
    expect(revealForKey(50, 'ArrowRight')).toBe(50 + REVEAL_STEP);
    expect(revealForKey(50, 'ArrowUp')).toBe(50 + REVEAL_STEP);
    expect(revealForKey(50, 'ArrowLeft')).toBe(50 - REVEAL_STEP);
    expect(revealForKey(50, 'ArrowDown')).toBe(50 - REVEAL_STEP);
    expect(revealForKey(50, 'PageUp')).toBe(50 + REVEAL_BIG_STEP);
    expect(revealForKey(50, 'PageDown')).toBe(50 - REVEAL_BIG_STEP);
    expect(revealForKey(50, 'ArrowRight', true)).toBe(50 + REVEAL_BIG_STEP);
    expect(revealForKey(50, 'Home')).toBe(0);
    expect(revealForKey(50, 'End')).toBe(100);
    expect(revealForKey(98, 'ArrowRight')).toBe(100);
    expect(revealForKey(2, 'ArrowLeft')).toBe(0);
    expect(revealForKey(50, 'Enter')).toBeNull();
  });
});
