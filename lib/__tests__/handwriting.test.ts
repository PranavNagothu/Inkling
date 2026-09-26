import { describe, expect, it } from 'vitest';
import { GLYPH_CHARS, handwrite, parseHandwriting } from '../handwriting';
import { isScribbleShape } from '../pairing';
import { isStroke } from '../validate';

describe('parseHandwriting', () => {
  it('splits text into glyphs, with ^{…} as superscript', () => {
    expect(parseHandwriting('x^{2}+1')).toEqual([
      { ch: 'x', sup: false },
      { ch: '2', sup: true },
      { ch: '+', sup: false },
      { ch: '1', sup: false },
    ]);
  });

  it('refuses characters the pen font cannot write', () => {
    expect(() => parseHandwriting('Q')).toThrow(/Q/);
  });
});

describe('handwrite', () => {
  const opts = { sessionId: 's', idPrefix: 'w', x: 40, baseline: 79, t0: 10_000, seed: 7 };

  it('writes pen strokes left to right on the baseline, in order and in time', () => {
    const { strokes, endX, endMs } = handwrite('d/dx sin(x^{2})', opts);
    expect(strokes.length).toBeGreaterThan(8);
    for (const s of strokes) {
      expect(isStroke(s)).toBe(true);
      expect(s.pointerType).toBe('pen');
      expect(s.sessionId).toBe('s');
      expect(s.startMs).toBeGreaterThanOrEqual(10_000);
      // Everything sits around the ruled line: ascenders above, descenders just below.
      expect(s.bbox[1]).toBeGreaterThan(79 - 30);
      expect(s.bbox[3]).toBeLessThan(79 + 14);
    }
    for (let i = 1; i < strokes.length; i++) expect(strokes[i].startMs).toBeGreaterThan(strokes[i - 1].endMs);
    expect(endX).toBeGreaterThan(40 + 100);
    expect(endMs).toBe(strokes[strokes.length - 1].endMs);
    expect(new Set(strokes.map((s) => s.id)).size).toBe(strokes.length);
  });

  it('is deterministic for a seed and varies with it', () => {
    const a = handwrite('cos(x^{2})', opts).strokes;
    expect(handwrite('cos(x^{2})', opts).strokes).toEqual(a);
    expect(handwrite('cos(x^{2})', { ...opts, seed: 8 }).strokes).not.toEqual(a);
  });

  it('writes like handwriting: real pressure, pen speed in a human range, never a scribble shape', () => {
    const { strokes } = handwrite(GLYPH_CHARS.replace(/\s/g, ''), opts);
    const pressures = strokes.flatMap((s) => s.points.map((p) => p[2]));
    expect(Math.min(...pressures)).toBeGreaterThan(0.2);
    expect(Math.max(...pressures)).toBeLessThan(0.8);
    for (const s of strokes) {
      if (s.inkLen > 6) expect(s.medianSpeed).toBeGreaterThan(0.05);
      expect(s.medianSpeed).toBeLessThan(0.6);
      expect(isScribbleShape(s)).toBe(false);
    }
  });

  it('a slower hand takes longer for the same words', () => {
    const quick = handwrite('2x e^{3x}', opts);
    const slow = handwrite('2x e^{3x}', { ...opts, pace: 0.3 });
    expect(slow.endMs - 10_000).toBeGreaterThan(2.5 * (quick.endMs - 10_000));
  });
});
