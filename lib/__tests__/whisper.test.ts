import { describe, expect, it } from 'vitest';
import fixture from './fixtures/whisper-verbose.json';
import { whisperToWords, type WhisperVerboseResponse } from '../whisper';

describe('whisperToWords', () => {
  const words = whisperToWords(fixture as WhisperVerboseResponse);

  it('maps word timestamps (s) to trimmed, integer-ms TranscriptWords', () => {
    expect(words.slice(0, 3)).toEqual([
      { w: 'Okay,', startMs: 0, endMs: 420 },
      { w: 'today', startMs: 620, endMs: 980 },
      { w: "we're", startMs: 980, endMs: 1200 },
    ]);
    expect(words.find((w) => w.w === 'looking')).toEqual({ w: 'looking', startMs: 1200, endMs: 1560 });
  });

  it('drops blank words and keeps start times monotonic', () => {
    expect(words.map((w) => w.w)).toEqual(['Okay,', 'today', "we're", 'looking', 'at', 'the', 'chain', 'rule.']);
    for (let i = 1; i < words.length; i++) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
    // "rule." starts 20 ms before "chain" ends in the fixture; it is still after chain's start.
    expect(words.at(-1)).toEqual({ w: 'rule.', startMs: 2080, endMs: 2500 });
  });

  it('skips malformed entries', () => {
    const out = whisperToWords({
      words: [
        { word: 'ok', start: 1, end: 1.5 },
        { word: 'nan', start: NaN, end: 2 },
        { word: 'inf', start: 2, end: Infinity },
        null as unknown as { word: string; start: number; end: number },
        { word: 'back', start: 0.5, end: 0.6 },
      ],
    });
    expect(out).toEqual([
      { w: 'ok', startMs: 1000, endMs: 1500 },
      { w: 'back', startMs: 1000, endMs: 1000 },
    ]);
  });

  it('falls back to spreading segment text when there are no word timings', () => {
    const out = whisperToWords({
      segments: [
        { start: 3, end: 4, text: ' second part' },
        { start: 0, end: 2, text: ' first part here' },
      ],
    });
    expect(out.map((w) => w.w)).toEqual(['first', 'part', 'here', 'second', 'part']);
    expect(out[0].startMs).toBe(0);
    expect(out.at(-1)!.endMs).toBe(4000);
  });

  it('returns [] for an empty response', () => {
    expect(whisperToWords({})).toEqual([]);
  });
});
