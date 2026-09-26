// Client-safe transcript helpers (no server imports): current-word lookup and paragraphing.
import type { TranscriptWord } from './types';

/**
 * Index of the word being spoken at `ms`: the last word that has started (binary search, O(log n)).
 * Between words it stays on the previous one; -1 before the first word.
 */
export function wordIndexAt(words: TranscriptWord[], ms: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface Paragraph {
  /** Index of the paragraph's first word in the full word list. */
  first: number;
  words: TranscriptWord[];
}

/**
 * Groups words into readable paragraphs: break on a long silence, or at a sentence end once the
 * paragraph is long enough.
 */
export function toParagraphs(words: TranscriptWord[], opts: { gapMs?: number; softMax?: number } = {}): Paragraph[] {
  const gapMs = opts.gapMs ?? 2000;
  const softMax = opts.softMax ?? 45;
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const breakHere =
      !cur ||
      (prev && w.startMs - prev.endMs >= gapMs) ||
      (prev && cur.words.length >= softMax && /[.?!]["')\]]?$/.test(prev.w));
    if (breakHere) {
      cur = { first: i, words: [] };
      out.push(cur);
    }
    cur!.words.push(w);
  });
  return out;
}

/** Words overlapping [startMs, endMs] (inclusive), as index range [from, to). */
export function wordRange(words: TranscriptWord[], startMs: number, endMs: number): [number, number] {
  let from = 0;
  while (from < words.length && words[from].endMs < startMs) from++;
  let to = from;
  while (to < words.length && words[to].startMs <= endMs) to++;
  return [from, to];
}
