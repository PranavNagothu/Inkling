import { describe, expect, it } from 'vitest';
import { buildStroke } from '../ink';
import { LIVE_HESITATION, liveHesitation } from '../liveHesitation';
import type { Point, Stroke, TranscriptWord } from '../types';

/** A handwritten word: `durMs` long, 60 px wide (slower writing = longer duration, same width). */
function word(id: string, x: number, y: number, t0: number, durMs = 1200): Stroke {
  const pts: Point[] = [];
  const n = 30;
  for (let i = 0; i <= n; i++) pts.push([x + (60 * i) / n, y + 6 * Math.sin(i), 0.5, Math.round(t0 + (durMs * i) / n)]);
  return buildStroke(id, 'sess', pts, 'pen');
}

/** Steady writing: one word every 2.5 s over [fromMs, toMs). */
function steady(fromMs: number, toMs: number, prefix = 'w'): Stroke[] {
  const out: Stroke[] = [];
  for (let i = 0, t = fromMs; t < toMs; i++, t += 2500) out.push(word(`${prefix}${i}`, 40 + (i % 8) * 70, 60 + Math.floor(i / 8) * 32, t));
  return out;
}

/** The lecturer speaking two words a second over [fromMs, toMs). */
function speech(fromMs: number, toMs: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (let t = fromMs; t < toMs; t += 500) out.push({ w: 'word', startMs: t, endMs: t + 400 });
  return out;
}

describe('liveHesitation', () => {
  it('calibrates until there is enough of the student’s own writing to compare against', () => {
    expect(liveHesitation({ strokes: [], words: [], nowMs: 10_000 })).toMatchObject({ state: 'calibrating', level: 0 });
    const few = steady(1000, 1000 + 2500 * (LIVE_HESITATION.minBaselineStrokes - 1));
    expect(liveHesitation({ strokes: few, words: [], nowMs: 20_000 }).state).toBe('calibrating');
  });

  it('steady writing at the student’s usual pace reads as steady', () => {
    const strokes = steady(1000, 150_000);
    const res = liveHesitation({ strokes, words: speech(0, 150_000), nowMs: 150_000 });
    expect(res.state).toBe('steady');
    expect(res.level).toBeLessThan(LIVE_HESITATION.slowingAt);
  });

  it('writing much slower than usual while erasing again and again reads as stuck', () => {
    const strokes = steady(1000, 130_000);
    // The last 20 s: three words written four times slower, each erased and tried again.
    for (let k = 0; k < 3; k++) {
      const t = 132_000 + k * 6000;
      const slow = word(`slow${k}`, 40 + k * 70, 400, t, 4800);
      strokes.push({ ...slow, erased: true, erasedAtMs: t + 5000, erasedBy: 'eraser' });
      strokes.push(word(`retry${k}`, 40 + k * 70, 400, t + 5200, 4800));
    }
    const res = liveHesitation({ strokes, words: speech(0, 152_000), nowMs: 151_000 });
    expect(res.state).toBe('stuck');
    expect(res.level).toBeGreaterThanOrEqual(LIVE_HESITATION.stuckAt);
    expect(res.reasons.join(' ')).toMatch(/slower/);
    expect(res.reasons.join(' ')).toMatch(/erased/);
  });

  it('a long silence while the lecturer keeps talking raises it; a silent lecture does not', () => {
    const strokes = steady(1000, 120_000);
    const lastEnd = Math.max(...strokes.map((s) => s.endMs));
    const talking = liveHesitation({ strokes, words: speech(0, 160_000), nowMs: lastEnd + 30_000 });
    expect(talking.state).not.toBe('steady');
    expect(talking.reasons.join(' ')).toMatch(/paused/);
    const quiet = liveHesitation({ strokes, words: speech(0, 110_000), nowMs: lastEnd + 30_000 });
    expect(quiet.state).toBe('steady');
  });

  it('ignores erasing gestures and undone strokes, and ink “from the future” (a reopened session)', () => {
    const strokes = steady(1000, 150_000);
    strokes.push({ ...word('zig', 40, 500, 149_000, 400), isScribble: true, erased: true, erasedAtMs: 149_400, erasedBy: 'scribble' });
    strokes.push({ ...word('undone', 40, 540, 149_500, 400), erased: true, erasedAtMs: 149_900, erasedBy: 'undo' });
    expect(liveHesitation({ strokes, words: [], nowMs: 150_000 }).state).toBe('steady');
    // Reopened at the start of the lecture: the baseline is still the student's earlier writing,
    // and nothing written "before now" can look like a pause or a slowdown.
    expect(liveHesitation({ strokes, words: speech(0, 160_000), nowMs: 0 })).toMatchObject({ state: 'steady', level: 0 });
  });
});
