import { describe, expect, it } from 'vitest';
import { buildStroke } from '../ink';
import { countReversals, detectScribble, isScribbleShape, pairRevisions } from '../pairing';
import { applyScribbleOut, undoScribbleOut } from '../scribble';
import { isReversedErase, scoreSession } from '../scoring';
import type { EraseEvent, Point, Stroke } from '../types';
import { isEraseEvent, isStroke } from '../validate';

// Realistic input generators (CSS px, lecture ms), roughly what a mouse or Pencil produces.

/** Handwriting-like wavy stroke across x0..x1 around y (a "word"). */
function wordPoints(x0: number, x1: number, y: number, t0: number, amp = 8): Point[] {
  const pts: Point[] = [];
  for (let x = x0, i = 0; x <= x1; x += 3, i++) pts.push([x, y + amp * Math.sin(i * 0.9), 0.5, t0 + i * 16]);
  return pts;
}

/** Back-and-forth horizontal scribble over x0..x1, drifting down through y0..y1. */
function hScribblePoints(x0: number, x1: number, y0: number, y1: number, t0: number, passes = 8): Point[] {
  const pts: Point[] = [];
  let t = t0;
  for (let p = 0; p <= passes; p++) {
    const y = y0 + ((y1 - y0) * p) / passes;
    const [a, b] = p % 2 ? [x1, x0] : [x0, x1];
    for (let k = 0; k <= 10; k++) pts.push([a + ((b - a) * k) / 10, y + (k % 2) * 0.4, 0.5, (t += 8)]);
  }
  return pts;
}

/** Tight vertical zig-zag moving right ("WWWW") across x0..x1 between y0..y1. */
function vZigzagPoints(x0: number, x1: number, y0: number, y1: number, t0: number, spacing = 6): Point[] {
  const pts: Point[] = [];
  let t = t0;
  for (let x = x0, i = 0; x <= x1; x += spacing, i++) pts.push([x, i % 2 ? y1 : y0, 0.5, (t += 20)]);
  return pts;
}

let n = 0;
const mk = (points: Point[], id = `s${++n}`) => buildStroke(id, 'sess-1', points, 'mouse');

describe('countReversals', () => {
  it('counts full-width swings and ignores sub-threshold jitter', () => {
    const jitter: Point[] = [];
    for (let i = 0; i < 100; i++) jitter.push([i * 2 + (i % 2 ? 0.3 : -0.3), 0, 0.5, i]);
    expect(countReversals(jitter, 0, 4)).toBe(0);
    const swings = hScribblePoints(0, 100, 0, 20, 0, 6);
    expect(countReversals(swings, 0, 25)).toBe(6);
  });
});

describe('detectScribble (tuned for real input)', () => {
  const word = mk(wordPoints(200, 360, 200, 0), 'word');

  it('detects a horizontal back-and-forth scribble over a word', () => {
    const s = mk(hScribblePoints(190, 370, 186, 214, 5000));
    expect(detectScribble(s, [word])).toEqual(['word']);
  });

  it('detects a vertical zig-zag moving across a word', () => {
    const s = mk(vZigzagPoints(195, 365, 188, 212, 5000));
    expect(isScribbleShape(s)).toBe(true);
    expect(detectScribble(s, [word])).toEqual(['word']);
  });

  it('can scribble out a dead-straight line (zero-height bbox)', () => {
    const line = mk(
      Array.from({ length: 30 }, (_, i) => [100 + i * 5, 300, 0.5, i * 16] as Point),
      'line',
    );
    expect(line.bbox[1]).toBe(line.bbox[3]);
    const s = mk(hScribblePoints(95, 250, 292, 308, 5000));
    expect(detectScribble(s, [line])).toEqual(['line']);
  });

  it('ignores a zig-zag on empty paper and one written beside a word', () => {
    const blank = mk(hScribblePoints(500, 650, 500, 530, 5000));
    expect(isScribbleShape(blank)).toBe(true);
    expect(detectScribble(blank, [word])).toEqual([]);
    const beside = mk(hScribblePoints(380, 520, 186, 214, 5000));
    expect(detectScribble(beside, [word])).toEqual([]);
  });

  it('ignores a straight underline and ordinary handwriting written over the same line', () => {
    const underline = mk(Array.from({ length: 40 }, (_, i) => [195 + i * 4.2, 222, 0.5, i * 10] as Point));
    expect(detectScribble(underline, [word])).toEqual([]);
    // The next word on the line, overlapping the first word's tail a little.
    const next = mk(wordPoints(340, 480, 200, 5000));
    expect(detectScribble(next, [word])).toEqual([]);
  });

  it('does not swallow a stroke its bbox covers but its ink never crosses', () => {
    // Shading packed into the top of the area, with one excursion that stretches the bbox down.
    const pts = hScribblePoints(0, 200, 0, 30, 5000);
    pts.push([200, 100, 0.5, 6000]);
    const s = mk(pts);
    const mark = mk(
      Array.from({ length: 8 }, (_, i) => [95 + i * 1.5, 78 + (i % 2) * 4, 0.5, i * 10] as Point),
      'mark',
    );
    expect(detectScribble(s, [mark])).toEqual([]);
  });

  it('skips strokes that are already erased', () => {
    const ghost = { ...word, id: 'ghost', erased: true, erasedAtMs: 1, erasedBy: 'eraser' as const };
    const s = mk(hScribblePoints(190, 370, 186, 214, 5000));
    expect(detectScribble(s, [ghost])).toEqual([]);
  });
});

describe('applyScribbleOut / undoScribbleOut', () => {
  const word = mk(wordPoints(200, 360, 200, 1000), 'w1');
  const other = mk(wordPoints(200, 360, 300, 2000), 'w2');
  const scribble = mk(hScribblePoints(190, 370, 186, 214, 8000), 'zig');

  it('returns null for ordinary ink', () => {
    expect(applyScribbleOut([word], mk(wordPoints(200, 360, 400, 3000)), 'e1')).toBeNull();
  });

  it('erases covered strokes and stores the zig-zag as ghost, with one scribble EraseEvent', () => {
    const out = applyScribbleOut([word, other], scribble, 'e1')!;
    expect(out).not.toBeNull();
    const atMs = scribble.endMs;
    // `by` tells the toast which pen gesture erased (a strike-through uses the same shape).
    expect(out.scribble).toEqual({ scribbleId: 'zig', coveredIds: ['w1'], atMs, by: 'scribble' });
    expect(out.event).toEqual({ id: 'e1', sessionId: 'sess-1', atMs, strokeIds: ['w1'], by: 'scribble' });
    expect(out.changedIds.sort()).toEqual(['w1', 'zig']);
    const byId = new Map(out.strokes.map((s) => [s.id, s]));
    expect(byId.get('w1')).toMatchObject({ erased: true, erasedBy: 'scribble', erasedAtMs: atMs, isScribble: false });
    expect(byId.get('w2')).toBe(other);
    expect(byId.get('zig')).toMatchObject({ erased: true, erasedBy: 'scribble', erasedAtMs: atMs, isScribble: true });
    expect(out.strokes).toHaveLength(3);
    for (const s of out.strokes) expect(isStroke(s)).toBe(true);
    expect(isEraseEvent(out.event)).toBe(true);
  });

  it('considers only live leaf strokes (not cut parents or ghost ink)', () => {
    const cutParent = { ...word, id: 'parent', replacedBy: ['p1'] };
    const ghost = { ...word, id: 'g', erased: true, erasedAtMs: 500, erasedBy: 'eraser' as const };
    expect(applyScribbleOut([cutParent, ghost], scribble, 'e1')).toBeNull();
  });

  it('undo restores covered ink (live, no erase fields) and marks the zig-zag undone', () => {
    const out = applyScribbleOut([word, other], scribble, 'e1')!;
    const undone = undoScribbleOut(out.strokes, out.scribble, 12000, 'e2')!;
    expect(undone.changedIds.sort()).toEqual(['w1', 'zig']);
    expect(undone.event).toEqual({ id: 'e2', sessionId: 'sess-1', atMs: 12000, strokeIds: ['zig'], by: 'undo' });
    const byId = new Map(undone.strokes.map((s) => [s.id, s]));
    expect(byId.get('w1')).toEqual(word);
    expect(byId.get('zig')).toMatchObject({ erased: true, erasedBy: 'undo', erasedAtMs: 12000, isScribble: true });
    // The restored stroke is a valid upsert payload (un-erase is persisted by upsert).
    for (const s of undone.strokes) expect(isStroke(s)).toBe(true);
    // Undoing twice is a no-op.
    expect(undoScribbleOut(undone.strokes, out.scribble, 13000, 'e3')).toBeNull();
  });
});

describe('scribble-outs in analysis', () => {
  // Word written at 1 s, scribbled out at ~8 s, rewritten in the same spot at 10 s.
  const word = mk(wordPoints(200, 360, 200, 1000), 'word');
  const scribble = mk(hScribblePoints(190, 370, 186, 214, 8000), 'zig');
  const out = applyScribbleOut([word], scribble, 'ev-scribble')!;
  const rewrite = mk(wordPoints(205, 355, 202, 10000), 'rewrite');

  it('scribble + rewrite in the same spot pairs as a correction; the zig-zag is neither before nor after', () => {
    const revisions = pairRevisions({ sessionId: 'sess-1', strokes: [...out.strokes, rewrite], eraseEvents: [out.event] });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('correction');
    expect(revisions[0].beforeStrokeIds).toEqual(['word']);
    expect(revisions[0].afterStrokeIds).toEqual(['rewrite']);
    expect(revisions[0].lectureMs).toBe(scribble.endMs);
  });

  it('a scribble-out with nothing rewritten is a deletion; an undone one is no revision at all', () => {
    expect(pairRevisions({ sessionId: 'sess-1', strokes: out.strokes, eraseEvents: [out.event] }).map((r) => r.kind)).toEqual([
      'deletion',
    ]);
    const undone = undoScribbleOut(out.strokes, out.scribble, 12000, 'ev-undo')!;
    expect(pairRevisions({ sessionId: 'sess-1', strokes: undone.strokes, eraseEvents: [out.event, undone.event] })).toEqual([]);
  });

  it('scoring counts a scribble-out as erasing, but not once it is undone', () => {
    const undone = undoScribbleOut(out.strokes, out.scribble, 12000, 'ev-undo')!;
    expect(isReversedErase(out.event, out.strokes)).toBe(false);
    expect(isReversedErase(out.event, undone.strokes)).toBe(true);
    // Events that name no strokes (or unknown ones) are never treated as reversed.
    const bare: EraseEvent = { id: 'x', sessionId: 'sess-1', atMs: 0, strokeIds: [], by: 'eraser' };
    expect(isReversedErase(bare, undone.strokes)).toBe(false);
    expect(isReversedErase({ ...bare, strokeIds: ['missing'] }, undone.strokes)).toBe(false);

    // A scribble-out right after the student's 2-minute baseline (the baseline follows their own
    // writing, so they take steady notes for the first 120 s), so the erase feature is scored.
    const steady = Array.from({ length: 24 }, (_, i) => mk(wordPoints(40, 100, 400 + i * 2, 1000 + i * 5000), `steady-${i}`));
    const late = (s: Stroke, dt: number): Stroke => ({
      ...s,
      startMs: s.startMs + dt,
      endMs: s.endMs + dt,
      erasedAtMs: s.erasedAtMs == null ? null : s.erasedAtMs + dt,
      points: s.points.map(([x, y, p, t]) => [x, y, p, t + dt] as Point),
    });
    const dt = 120000;
    const shifted = [...steady, ...out.strokes.map((s) => late(s, dt))];
    const ev: EraseEvent = { ...out.event, atMs: out.event.atMs + dt };
    const base = { sessionId: 'sess-1', words: [], durationMs: 140000, config: { emaAlpha: 1 } };
    const bucket = (w: ReturnType<typeof scoreSession>) => w.find((x) => x.bucketStartMs === 120000)!;
    expect(bucket(scoreSession({ ...base, strokes: shifted, eraseEvents: [ev] })).erase).toBe(1);
    const reverted = undoScribbleOut(shifted, out.scribble, 135000, 'u')!;
    expect(
      bucket(scoreSession({ ...base, strokes: reverted.strokes, eraseEvents: [ev, reverted.event] })).erase,
    ).toBe(0);
  });
});
