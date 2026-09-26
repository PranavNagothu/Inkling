import { describe, expect, it } from 'vitest';
import { buildStroke, inkCounts, splitStrokeByEraser } from '../ink';
import { pairRevisions } from '../pairing';
import { undoEraseGesture } from '../eraseUndo';
import { undoScribbleOut } from '../scribble';
import { isReversedErase } from '../scoring';
import {
  STRIKE_CONFIG,
  applyStrikeOut,
  detectStrikeThrough,
  isStraightLine,
  isStrikeFollowUp,
  pendingStrike,
} from '../strike';
import type { EraseEvent, Point, Stroke } from '../types';
import { isEraseEvent, isStroke } from '../validate';

// Realistic inputs in CSS px / lecture ms: a handwritten "word" is a wavy stroke about 16 px tall.

/** Wavy word across x0..x1 centred on y. */
function wordPoints(x0: number, x1: number, y: number, t0: number, amp = 8): Point[] {
  const pts: Point[] = [];
  for (let x = x0, i = 0; x <= x1; x += 3, i++) pts.push([x, y + amp * Math.sin(i * 0.9), 0.5, t0 + i * 16]);
  return pts;
}

/** A straight pen line from (x0, y0) to (x1, y1) with a little hand wobble. */
function linePoints(x0: number, y0: number, x1: number, y1: number, t0: number, wobble = 0.6): Point[] {
  const pts: Point[] = [];
  const n = 30;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f + (i % 2 ? wobble : -wobble), 0.5, t0 + i * 10]);
  }
  return pts;
}

let n = 0;
const mk = (points: Point[], id = `s${++n}`) => buildStroke(id, 'sess-1', points, 'pen');

describe('isStraightLine', () => {
  it('accepts a hand-drawn straight line, horizontal or gently sloped', () => {
    expect(isStraightLine(mk(linePoints(100, 50, 220, 50, 0)))).toBe(true);
    expect(isStraightLine(mk(linePoints(100, 50, 220, 70, 0)))).toBe(true);
  });

  it('rejects handwriting, short ticks and steep lines', () => {
    expect(isStraightLine(mk(wordPoints(100, 220, 50, 0)))).toBe(false);
    expect(isStraightLine(mk(linePoints(100, 50, 110, 50, 0)))).toBe(false);
    expect(isStraightLine(mk(linePoints(100, 20, 130, 120, 0)))).toBe(false);
  });
});

describe('detectStrikeThrough', () => {
  const word = mk(wordPoints(100, 200, 50, 1000), 'w-cos');

  it('a straight line through the middle of a word strikes it', () => {
    const bar = mk(linePoints(92, 51, 210, 49, 5000));
    expect(detectStrikeThrough(bar, [word])).toEqual(['w-cos']);
  });

  it('an underline below the word stays ink', () => {
    const underline = mk(linePoints(95, 64, 205, 64, 5000));
    expect(detectStrikeThrough(underline, [word])).toEqual([]);
  });

  it('a line over the top edge, or covering only a sliver of the word, strikes nothing', () => {
    expect(detectStrikeThrough(mk(linePoints(92, 43, 210, 43, 5000)), [word])).toEqual([]);
    expect(detectStrikeThrough(mk(linePoints(180, 50, 240, 50, 5000)), [word])).toEqual([]);
  });

  it('a "+" crossbar through a thin vertical mark is not a strike-through', () => {
    const vertical = mk(linePoints(150, 30, 151, 70, 1000, 0), 'w-bar');
    expect(detectStrikeThrough(mk(linePoints(135, 50, 165, 50, 5000)), [vertical])).toEqual([]);
  });

  it('only live ink can be struck; several strokes of one word are struck together', () => {
    const a = mk(wordPoints(100, 150, 50, 1000), 'w-a');
    const b = mk(wordPoints(156, 200, 50, 1800), 'w-b');
    const gone = { ...mk(wordPoints(100, 200, 50, 900), 'w-gone'), erased: true, erasedAtMs: 950, erasedBy: 'eraser' as const };
    const bar = mk(linePoints(95, 50, 205, 50, 5000));
    expect(detectStrikeThrough(bar, [a, b, gone]).sort()).toEqual(['w-a', 'w-b']);
  });

  it('handwriting over a word is never a strike-through', () => {
    expect(detectStrikeThrough(mk(wordPoints(100, 200, 50, 5000)), [word])).toEqual([]);
  });
});

describe('strike-through → erase, when new writing follows nearby', () => {
  const word = mk(wordPoints(100, 200, 50, 1000), 'w1');
  const other = mk(wordPoints(100, 200, 150, 1500), 'w2');
  const bar = mk(linePoints(92, 50, 210, 50, 5000), 'bar');
  const pending = pendingStrike(bar, ['w1'], [word, other], 10_000)!;

  it('only new writing near the struck word within 20 s confirms it', () => {
    const near = mk(wordPoints(215, 290, 50, 7000), 'fix');
    const far = mk(wordPoints(400, 480, 300, 7000), 'far');
    expect(isStrikeFollowUp(pending, near, 10_000 + 3000)).toBe(true);
    expect(isStrikeFollowUp(pending, far, 10_000 + 3000)).toBe(false);
    expect(isStrikeFollowUp(pending, near, 10_000 + STRIKE_CONFIG.windowMs + 1)).toBe(false);
  });

  it('erases the word (erasedBy strike) and stores the line as an erased gesture, like a scribble-out', () => {
    const out = applyStrikeOut([word, other, bar], pending, 'e-strike')!;
    const byId = new Map(out.strokes.map((s) => [s.id, s]));
    expect(byId.get('w1')).toMatchObject({ erased: true, erasedBy: 'strike', erasedAtMs: bar.endMs });
    expect(byId.get('bar')).toMatchObject({ erased: true, erasedBy: 'strike', isScribble: true, erasedAtMs: bar.endMs });
    expect(byId.get('w2')!.erased).toBe(false);
    expect(out.changedIds.sort()).toEqual(['bar', 'w1']);
    expect(out.event).toEqual({ id: 'e-strike', sessionId: 'sess-1', atMs: bar.endMs, strokeIds: ['w1'], by: 'strike' });
    expect(out.scribble).toEqual({ scribbleId: 'bar', coveredIds: ['w1'], atMs: bar.endMs, by: 'strike' });
    // Stored and validated like any erase.
    expect(out.strokes.every(isStroke)).toBe(true);
    expect(isEraseEvent(out.event)).toBe(true);
    expect(inkCounts(out.strokes)).toEqual({ drawn: 2, erasedParts: 1 });
  });

  it('the rewrite becomes a correction of the struck word', () => {
    const out = applyStrikeOut([word, other, bar], pending, 'e-strike')!;
    const fix = mk(wordPoints(110, 210, 52, 7000), 'fix');
    const revs = pairRevisions({ sessionId: 'sess-1', strokes: [...out.strokes, fix], eraseEvents: [out.event] });
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ kind: 'correction', beforeStrokeIds: ['w1'], afterStrokeIds: ['fix'] });
  });

  it('is skipped when the line or the word is no longer live ink', () => {
    const undone = { ...bar, erased: true, erasedAtMs: 6000, erasedBy: 'undo' as const };
    expect(applyStrikeOut([word, other, undone], pending, 'e')).toBeNull();
    const wordGone = { ...word, erased: true, erasedAtMs: 6000, erasedBy: 'eraser' as const };
    expect(applyStrikeOut([wordGone, other, bar], pending, 'e')).toBeNull();
  });

  it('undo restores the word and keeps the line as an undone stroke', () => {
    const out = applyStrikeOut([word, other, bar], pending, 'e-strike')!;
    const back = undoScribbleOut(out.strokes, out.scribble, 9000, 'e-undo')!;
    const byId = new Map(back.strokes.map((s) => [s.id, s]));
    expect(byId.get('w1')).toMatchObject({ erased: false, erasedBy: null, erasedAtMs: null });
    expect(byId.get('bar')).toMatchObject({ erased: true, erasedBy: 'undo' });
    expect(isReversedErase(out.event, back.strokes)).toBe(true);
    expect(inkCounts(back.strokes)).toEqual({ drawn: 2, erasedParts: 0 });
  });
});

describe('undoEraseGesture (toolbar Undo after the eraser)', () => {
  const ids = (() => {
    let k = 0;
    return () => `piece${++k}`;
  })();

  it('a partial erase: the erased piece is live again, so the line reads as drawn, and the erase no longer counts', () => {
    const line = mk(linePoints(0, 50, 200, 50, 1000, 0), 'line');
    const { parent, pieces } = splitStrokeByEraser(line, [[100, 40], [100, 60]], 12, 5000, ids)!;
    const erasedIds = pieces.filter((p) => p.erased).map((p) => p.id);
    const erase: EraseEvent = { id: 'e1', sessionId: 'sess-1', atMs: 5000, strokeIds: erasedIds, by: 'eraser' };
    const page = [parent, ...pieces];
    expect(inkCounts(page)).toEqual({ drawn: 1, erasedParts: 1 });

    const res = undoEraseGesture(page, { erasedIds }, 6000, 'e-undo')!;
    expect(res.changedIds).toEqual(erasedIds);
    expect(res.strokes.filter((s) => s.erased)).toEqual([]);
    expect(res.event).toEqual({ id: 'e-undo', sessionId: 'sess-1', atMs: 6000, strokeIds: erasedIds, by: 'undo' });
    expect(inkCounts(res.strokes)).toEqual({ drawn: 1, erasedParts: 0 });
    expect(isReversedErase(erase, res.strokes)).toBe(true);
    expect(pairRevisions({ sessionId: 'sess-1', strokes: res.strokes, eraseEvents: [erase, res.event] })).toEqual([]);
  });

  it('a stroke erased whole comes back', () => {
    const word = { ...mk(wordPoints(0, 60, 50, 1000), 'gone'), erased: true, erasedAtMs: 5000, erasedBy: 'eraser' as const };
    const res = undoEraseGesture([word], { erasedIds: ['gone'] }, 6000, 'u')!;
    expect(res.strokes[0]).toMatchObject({ erased: false, erasedAtMs: null, erasedBy: null });
  });

  it('returns null when there is nothing left to restore', () => {
    const live = mk(wordPoints(0, 60, 50, 1000), 'live');
    expect(undoEraseGesture([live], { erasedIds: ['live'] }, 6000, 'u')).toBeNull();
    const undone: Stroke = { ...live, erased: true, erasedAtMs: 2000, erasedBy: 'undo' };
    expect(undoEraseGesture([undone], { erasedIds: ['live'] }, 6000, 'u')).toBeNull();
  });
});
