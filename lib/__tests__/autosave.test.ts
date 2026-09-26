import { describe, expect, it } from 'vitest';
import {
  KEEPALIVE_MAX_BYTES,
  MAX_BATCH_BYTES,
  MAX_BATCH_ITEMS,
  MAX_STROKES_BODY_BYTES,
  chunkBatch,
  classifySaveFailure,
  retryDelayMs,
  splitLongStroke,
} from '../autosave';
import { MAX_STROKE_POINTS, isStroke } from '../validate';
import { buildStroke } from '../ink';
import type { EraseEvent, Point, Stroke } from '../types';

const pts = (n: number, t0 = 0): Point[] => Array.from({ length: n }, (_, i) => [i, i % 7, 0.5, t0 + i * 4] as Point);
const stroke = (id: string, n = 10): Stroke => buildStroke(id, 'sess', pts(n), 'mouse');
const event = (id: string): EraseEvent => ({ id, sessionId: 'sess', atMs: 1, strokeIds: ['a'], by: 'eraser' });

describe('splitLongStroke', () => {
  it('leaves a stroke within the limit alone', () => {
    const p = pts(50);
    expect(splitLongStroke(p, 100)).toEqual([p]);
    expect(splitLongStroke(pts(100), 100)).toHaveLength(1);
  });

  it('cuts an over-long stroke into consecutive pieces that share their joining point', () => {
    const p = pts(250);
    const pieces = splitLongStroke(p, 100);
    expect(pieces.map((c) => c.length)).toEqual([100, 100, 52]);
    // Continuous ink: each piece starts where the previous one ended.
    expect(pieces[1][0]).toEqual(pieces[0][99]);
    expect(pieces[2][0]).toEqual(pieces[1][99]);
    expect(pieces[2][51]).toEqual(p[249]);
    // Nothing lost or reordered.
    expect(pieces.flatMap((c, i) => (i === 0 ? c : c.slice(1)))).toEqual(p);
  });

  it('every piece of a stroke at the server limit passes the server validator', () => {
    const pieces = splitLongStroke(pts(MAX_STROKE_POINTS * 2 + 5), MAX_STROKE_POINTS);
    for (const [i, piece] of pieces.entries()) {
      expect(piece.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
      expect(isStroke(buildStroke(`p${i}`, 'sess', piece, 'pen'))).toBe(true);
    }
  });

  it('rejects a limit below 2 (pieces could not overlap)', () => {
    expect(() => splitLongStroke(pts(5), 1)).toThrow();
  });
});

describe('chunkBatch', () => {
  it('sends everything in one request when it fits', () => {
    const chunks = chunkBatch([stroke('a'), stroke('b')], [event('e1')]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].strokes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(chunks[0].eraseEvents.map((e) => e.id)).toEqual(['e1']);
    expect(JSON.parse(chunks[0].body)).toEqual({ strokes: chunks[0].strokes, eraseEvents: chunks[0].eraseEvents });
    expect(chunks[0].bytes).toBe(new TextEncoder().encode(chunks[0].body).length);
  });

  it('returns no chunks for nothing to send', () => {
    expect(chunkBatch([], [])).toEqual([]);
  });

  it('never puts more than maxItems strokes or events in one request', () => {
    const strokes = Array.from({ length: 12 }, (_, i) => stroke(`s${i}`, 2));
    const events = Array.from({ length: 7 }, (_, i) => event(`e${i}`));
    const chunks = chunkBatch(strokes, events, { maxItems: 5 });
    for (const c of chunks) {
      expect(c.strokes.length).toBeLessThanOrEqual(5);
      expect(c.eraseEvents.length).toBeLessThanOrEqual(5);
    }
    expect(chunks.flatMap((c) => c.strokes.map((s) => s.id))).toEqual(strokes.map((s) => s.id));
    expect(chunks.flatMap((c) => c.eraseEvents.map((e) => e.id))).toEqual(events.map((e) => e.id));
  });

  it('keeps each request under the byte budget (a single item larger than it goes alone)', () => {
    const strokes = [stroke('a', 400), stroke('b', 400), stroke('huge', 3000), stroke('c', 400)];
    const maxBytes = 30_000;
    const chunks = chunkBatch(strokes, [], { maxBytes });
    expect(chunks.map((c) => c.strokes.map((s) => s.id))).toEqual([['a', 'b'], ['huge'], ['c']]);
    for (const c of chunks) if (c.strokes.length > 1) expect(c.bytes).toBeLessThanOrEqual(maxBytes);
  });

  it('defaults stay within what the server accepts', () => {
    expect(MAX_BATCH_ITEMS).toBeLessThanOrEqual(5000);
    // The largest possible request: a full byte budget plus one maximal stroke.
    const maximal = JSON.stringify(buildStroke('x'.repeat(40), 'sess', pts(MAX_STROKE_POINTS, 3_600_000), 'pen'));
    expect(MAX_BATCH_BYTES + maximal.length * 2).toBeLessThan(MAX_STROKES_BODY_BYTES);
    expect(KEEPALIVE_MAX_BYTES).toBeLessThan(64 * 1024);
  });
});

describe('classifySaveFailure', () => {
  it('retries network errors, server errors, timeouts and rate limits', () => {
    expect(classifySaveFailure('network')).toBe('transient');
    for (const status of [500, 502, 503, 504, 408, 429]) expect(classifySaveFailure(status)).toBe('transient');
  });

  it('does not retry the same payload after other client errors', () => {
    for (const status of [400, 403, 404, 413, 415, 422]) expect(classifySaveFailure(status)).toBe('permanent');
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially up to a cap', () => {
    expect([0, 1, 2, 3].map((n) => retryDelayMs(n))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(20)).toBe(30_000);
  });
});
