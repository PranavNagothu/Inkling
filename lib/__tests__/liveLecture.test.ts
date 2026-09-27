import { describe, expect, it } from 'vitest';
import {
  LIVE_LANGUAGES,
  MAX_CUES_PER_REQUEST,
  MIN_WORD_MS,
  clockNow,
  cuesToLiveWords,
  distributeWords,
  isLiveLanguage,
  isRunning,
  liveLectureDisabled,
  mergeLiveWords,
  newLiveClock,
  normalizeCueText,
  parseCueBatch,
  pauseClock,
  pickRecordingMime,
  resultToCue,
  startClock,
} from '../liveLecture';

describe('live session clock', () => {
  it('is wall-clock time since Start, minus pauses', () => {
    let c = newLiveClock();
    expect(clockNow(c, 5000)).toBe(0); // not started: frozen at 0
    c = startClock(c, 1000);
    expect(isRunning(c)).toBe(true);
    expect(clockNow(c, 3500)).toBe(2500);
    c = pauseClock(c, 4000);
    expect(isRunning(c)).toBe(false);
    expect(clockNow(c, 60_000)).toBe(3000); // paused: frozen
    c = startClock(c, 10_000);
    expect(clockNow(c, 12_000.4)).toBe(5000);
    c = pauseClock(c, 13_000);
    expect(clockNow(c, 99_999)).toBe(6000);
  });

  it('starting twice or pausing a paused clock changes nothing', () => {
    const running = startClock(newLiveClock(), 100);
    expect(startClock(running, 5000)).toBe(running);
    const paused = pauseClock(running, 600);
    expect(pauseClock(paused, 9000)).toBe(paused);
    expect(clockNow(paused, 0)).toBe(500);
  });

  it('resumes from an offset and never runs backwards', () => {
    const c = startClock(newLiveClock(42_000), 1000);
    expect(clockNow(c, 1000)).toBe(42_000);
    expect(clockNow(c, 500)).toBe(42_000); // a timestamp before the start
    expect(clockNow(newLiveClock(-5), 0)).toBe(0);
  });
});

describe('speech result → cue → words', () => {
  it('normalises text: control characters, whitespace, length cap', () => {
    expect(normalizeCueText('  the\u0000 chain\n\trule​ ')).toBe('the chain rule');
    expect(normalizeCueText('a'.repeat(1500))).toHaveLength(1000);
  });

  it('distributes word times evenly across the span', () => {
    expect(distributeWords('the chain rule', 1000, 1600)).toEqual([
      { w: 'the', startMs: 1000, endMs: 1200 },
      { w: 'chain', startMs: 1200, endMs: 1400 },
      { w: 'rule', startMs: 1400, endMs: 1600 },
    ]);
    expect(distributeWords('one two', 0, 1001)).toEqual([
      { w: 'one', startMs: 0, endMs: 501 },
      { w: 'two', startMs: 501, endMs: 1001 },
    ]);
    expect(distributeWords('   ', 0, 100)).toEqual([]);
    // A zero span still gives every word a (shared) time.
    expect(distributeWords('a b', 50, 50).map((w) => w.startMs)).toEqual([50, 50]);
  });

  it('turns a final result into a cue after the previous one, with room for every word', () => {
    expect(resultToCue(' differentiate both sides ', 2000, 3500, 1000)).toEqual({
      startMs: 2000,
      endMs: 3500,
      text: 'differentiate both sides',
    });
    // Starts no earlier than the previous cue ended.
    expect(resultToCue('with respect to time', 900, 3000, 1500)).toMatchObject({ startMs: 1500, endMs: 3000 });
    // Too short a span (the final result arrived almost at once): MIN_WORD_MS per word.
    expect(resultToCue('one two three four', 5000, 5010, 0)).toEqual({
      startMs: 5000,
      endMs: 5000 + 4 * MIN_WORD_MS,
      text: 'one two three four',
    });
    expect(resultToCue('  ', 0, 100)).toBeNull();
  });

  it('consecutive cues never share a word start (so re-sent batches merge cleanly)', () => {
    const a = resultToCue('x y z', 1000, 1000, 0)!;
    const b = resultToCue('next words', a.endMs, a.endMs, a.endMs)!;
    const words = cuesToLiveWords([a, b]);
    const aWords = words.slice(0, 3);
    expect(Math.max(...aWords.map((w) => w.startMs))).toBeLessThan(b.startMs);
    expect(words.map((w) => w.startMs)).toEqual([...words.map((w) => w.startMs)].sort((p, q) => p - q));
  });

  it('merges batches idempotently: a retried batch replaces instead of duplicating', () => {
    const first = [{ startMs: 0, endMs: 1000, text: 'related rates' }];
    const second = [
      { startMs: 1000, endMs: 2000, text: 'the ladder' },
      { startMs: 2000, endMs: 3000, text: 'slides down' },
    ];
    const once = mergeLiveWords(mergeLiveWords([], first), second);
    const twice = mergeLiveWords(once, second);
    expect(twice).toEqual(once);
    expect(once.map((w) => w.w)).toEqual(['related', 'rates', 'the', 'ladder', 'slides', 'down']);
    expect(mergeLiveWords(once, [])).toBe(once);
  });
});

describe('cue batch validation', () => {
  it('accepts ordered cues and cleans their text', () => {
    const res = parseCueBatch({
      cues: [
        { startMs: 0, endMs: 900, text: ' hello\nworld ' },
        { startMs: 900, endMs: 900, text: '   ' }, // nothing heard: dropped
        { startMs: 950, endMs: 1200.6, text: 'again' },
      ],
      durationMs: 1500.4,
    });
    expect(res).toEqual({
      ok: true,
      value: {
        cues: [
          { startMs: 0, endMs: 900, text: 'hello world' },
          { startMs: 950, endMs: 1201, text: 'again' },
        ],
        durationMs: 1500,
      },
    });
    expect(parseCueBatch({ cues: [] })).toEqual({ ok: true, value: { cues: [], durationMs: null } });
  });

  it.each([
    ['not an object', []],
    ['no cues', {}],
    ['negative time', { cues: [{ startMs: -1, endMs: 5, text: 'a' }] }],
    ['end before start', { cues: [{ startMs: 10, endMs: 5, text: 'a' }] }],
    ['NaN', { cues: [{ startMs: Number.NaN, endMs: 5, text: 'a' }] }],
    ['too long ago', { cues: [{ startMs: 0, endMs: 7 * 3600 * 1000, text: 'a' }] }],
    ['text not a string', { cues: [{ startMs: 0, endMs: 5, text: 3 }] }],
    ['text too long', { cues: [{ startMs: 0, endMs: 5, text: 'a'.repeat(1001) }] }],
    ['overlapping', { cues: [{ startMs: 0, endMs: 50, text: 'a' }, { startMs: 40, endMs: 60, text: 'b' }] }],
    ['bad duration', { cues: [], durationMs: 'long' }],
    ['too many cues', { cues: Array.from({ length: MAX_CUES_PER_REQUEST + 1 }, (_, i) => ({ startMs: i, endMs: i, text: 'a' })) }],
  ])('rejects %s', (_label, body) => {
    expect(parseCueBatch(body).ok).toBe(false);
  });
});

describe('languages, recording formats and DEMO_MODE', () => {
  it('offers US English first, then the app languages, with no duplicates', () => {
    expect(LIVE_LANGUAGES[0].tag).toBe('en-US');
    expect(LIVE_LANGUAGES.length).toBe(10);
    expect(new Set(LIVE_LANGUAGES.map((l) => l.tag)).size).toBe(LIVE_LANGUAGES.length);
    expect(isLiveLanguage('es-US')).toBe(true);
    expect(isLiveLanguage('xx-YY')).toBe(false);
  });

  it('prefers WebM/Opus, falls back to MP4 (Safari), else lets the browser pick', () => {
    expect(pickRecordingMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecordingMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordingMime(() => false)).toBe('');
  });

  it('is disabled in DEMO_MODE only', () => {
    expect(liveLectureDisabled({ DEMO_MODE: '1' })).toBe(true);
    expect(liveLectureDisabled({ DEMO_MODE: ' true ' })).toBe(true);
    expect(liveLectureDisabled({ DEMO_MODE: '' })).toBe(false);
    expect(liveLectureDisabled({})).toBe(false);
  });
});
