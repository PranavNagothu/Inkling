import { describe, expect, it } from 'vitest';
import { toParagraphs, wordIndexAt, wordRange } from '../transcript';
import type { TranscriptWord } from '../types';

const w = (word: string, startMs: number, endMs: number): TranscriptWord => ({ w: word, startMs, endMs });
const words = [w('a', 0, 100), w('b', 200, 300), w('c', 300, 500), w('d.', 5000, 5200), w('e', 5300, 5400)];

describe('wordIndexAt', () => {
  it('finds the last word that has started (binary search)', () => {
    expect(wordIndexAt(words, -1)).toBe(-1);
    expect(wordIndexAt(words, 0)).toBe(0);
    expect(wordIndexAt(words, 150)).toBe(0); // gap: stays on the previous word
    expect(wordIndexAt(words, 200)).toBe(1);
    expect(wordIndexAt(words, 300)).toBe(2);
    expect(wordIndexAt(words, 4999)).toBe(2);
    expect(wordIndexAt(words, 999_999)).toBe(4);
    expect(wordIndexAt([], 10)).toBe(-1);
  });
  it('agrees with a linear scan on a long transcript', () => {
    const long = Array.from({ length: 5000 }, (_, i) => w(`w${i}`, i * 250, i * 250 + 200));
    for (const ms of [0, 1, 249, 250, 12_345, 1_249_999, 2_000_000]) {
      let expected = -1;
      long.forEach((x, i) => x.startMs <= ms && (expected = i));
      expect(wordIndexAt(long, ms)).toBe(expected);
    }
  });
});

describe('toParagraphs', () => {
  it('breaks on long silences and keeps word indices', () => {
    const ps = toParagraphs(words);
    expect(ps.map((p) => [p.first, p.words.map((x) => x.w).join(' ')])).toEqual([
      [0, 'a b c'],
      [3, 'd. e'],
    ]);
  });
  it('breaks long runs at sentence ends', () => {
    const run = Array.from({ length: 12 }, (_, i) => w(i === 4 ? 'end.' : `x${i}`, i * 300, i * 300 + 250));
    expect(toParagraphs(run, { softMax: 5 }).map((p) => p.first)).toEqual([0, 5]);
  });
});

describe('wordRange', () => {
  it('returns the index range of words overlapping a time span', () => {
    expect(wordRange(words, 250, 400)).toEqual([1, 3]);
    expect(wordRange(words, 600, 4000)).toEqual([3, 3]);
    expect(wordRange(words, 0, 99_999)).toEqual([0, 5]);
  });
});
