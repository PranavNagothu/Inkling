import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cleanCueText,
  cuesToWords,
  detectCaptionFormat,
  parseCaptions,
  parseSrt,
  parseTimestamp,
  parseVtt,
  resolveOverlaps,
  type Cue,
} from '../captions';

describe('parseTimestamp', () => {
  it('parses VTT and SRT forms, with and without hours', () => {
    expect(parseTimestamp('00:00:01.500')).toBe(1500);
    expect(parseTimestamp('01:02:03.004')).toBe(3_723_004);
    expect(parseTimestamp('00:01:02,250')).toBe(62_250);
    expect(parseTimestamp('02:03.456')).toBe(123_456);
    expect(parseTimestamp('2:03.4')).toBe(123_400);
    expect(parseTimestamp('00:05')).toBe(5000);
  });
  it('rejects malformed timestamps', () => {
    expect(parseTimestamp('1.5')).toBeNull();
    expect(parseTimestamp('00:61.000')).toBeNull();
    expect(parseTimestamp('aa:bb.ccc')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
  });
});

describe('cleanCueText', () => {
  it('strips tags, entities, speaker markers and sound cues', () => {
    expect(cleanCueText('<v Prof>Hello <c.yellow>there</c></v>')).toBe('Hello there');
    expect(cleanCueText('&gt;&gt; PROFESSOR: The chain rule')).toBe('The chain rule');
    expect(cleanCueText('>> so we differentiate')).toBe('so we differentiate');
    expect(cleanCueText('[Music]')).toBe('');
    expect(cleanCueText('♪ la la ♪')).toBe('la la');
    expect(cleanCueText('<i>Now</i> solve it')).toBe('Now solve it');
    expect(cleanCueText('word<00:00:01.200><c> by</c><00:00:01.500><c> word</c>')).toBe('word by word');
    expect(cleanCueText('{\\an8}Top of screen')).toBe('Top of screen');
    expect(cleanCueText('Tom &amp; Jerry&#39;s &quot;x&quot;')).toBe('Tom & Jerry\'s "x"');
  });
  it('keeps maths intact', () => {
    expect(cleanCueText('f(g(x)) times g prime of x')).toBe('f(g(x)) times g prime of x');
    expect(cleanCueText('if x < 3 then y > 2')).toBe('if x < 3 then y > 2');
    expect(cleanCueText('-3 is negative')).toBe('-3 is negative');
  });
  it('joins multi-line cue text with a space', () => {
    expect(cleanCueText('first line\nsecond line')).toBe('first line second line');
  });
});

const VTT = `WEBVTT
Kind: captions

NOTE a comment
that spans lines

STYLE
::cue { color: yellow }

intro
00:00.000 --> 00:02.000 align:start position:0%
<v Prof>Okay everyone,</v>

00:00:02.000 --> 00:00:05.000
today: the <c.hl>chain</c> rule.
It composes functions.

00:05.000 --> 00:06.000
[Applause]
`;

describe('parseVtt', () => {
  it('parses cues, skipping header/NOTE/STYLE blocks, ids and cue settings', () => {
    expect(parseVtt(VTT)).toEqual([
      { startMs: 0, endMs: 2000, text: 'Okay everyone,' },
      { startMs: 2000, endMs: 5000, text: 'today: the chain rule. It composes functions.' },
    ]);
  });

  it('handles a BOM and CRLF / CR line endings identically', () => {
    const crlf = '﻿' + VTT.replace(/\n/g, '\r\n');
    const cr = VTT.replace(/\n/g, '\r');
    expect(parseVtt(crlf)).toEqual(parseVtt(VTT));
    expect(parseVtt(cr)).toEqual(parseVtt(VTT));
  });

  it('skips cues with broken timings instead of failing', () => {
    const text = 'WEBVTT\n\n00:01.000 --> 00:00.500\nbackwards\n\nnonsense --> 00:02.000\nbad\n\n00:03.000 --> 00:04.000\ngood\n';
    expect(parseVtt(text)).toEqual([{ startMs: 3000, endMs: 4000, text: 'good' }]);
  });

  it('parses the committed e2e fixture', () => {
    const cues = parseVtt(readFileSync(new URL('../../e2e/fixtures/lecture-40s.vtt', import.meta.url), 'utf8'));
    expect(cues.length).toBe(9);
    expect(cues[0]).toMatchObject({ startMs: 1500, text: 'Welcome back. Today we look at related rates.' });
    expect(cues[1].text).toBe('A ladder slides down a wall, and we want how fast the top falls.');
    expect(cues.at(-1)!.endMs).toBe(40_000);
  });
});

const SRT = `1
00:00:01,000 --> 00:00:03,500
- Hello and welcome.

2
00:00:03,500 --> 00:00:06,000
<i>Derivatives</i> measure
rates of change.

3
00:00:06,000 --> 00:00:07,000
{\\an8}[MUSIC PLAYING]
`;

describe('parseSrt', () => {
  it('parses numbered blocks with comma milliseconds and multi-line text', () => {
    expect(parseSrt(SRT)).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello and welcome.' },
      { startMs: 3500, endMs: 6000, text: 'Derivatives measure rates of change.' },
    ]);
  });
  it('tolerates CRLF, a BOM and missing index lines', () => {
    const text = '﻿00:00:01,000 --> 00:00:02,000\r\nNo index here\r\n\r\n';
    expect(parseSrt(text)).toEqual([{ startMs: 1000, endMs: 2000, text: 'No index here' }]);
  });
});

describe('detectCaptionFormat / parseCaptions', () => {
  it('detects by content', () => {
    expect(detectCaptionFormat(VTT)).toBe('vtt');
    expect(detectCaptionFormat('﻿WEBVTT\n')).toBe('vtt');
    expect(detectCaptionFormat(SRT)).toBe('srt');
    expect(detectCaptionFormat('00:01.000 --> 00:02.000\nheaderless vtt')).toBe('vtt');
    expect(detectCaptionFormat('just some text')).toBeNull();
    expect(detectCaptionFormat('')).toBeNull();
  });
  it('parses either format and returns [] for non-captions', () => {
    expect(parseCaptions(SRT)).toEqual(parseSrt(SRT));
    expect(parseCaptions(VTT)).toEqual(parseVtt(VTT));
    expect(parseCaptions('MZ\u0090\u0000binary junk')).toEqual([]);
  });
});

describe('resolveOverlaps', () => {
  it('sorts cues and clamps each end to the next start', () => {
    const cues: Cue[] = [
      { startMs: 4000, endMs: 9000, text: 'c' },
      { startMs: 0, endMs: 5000, text: 'a' },
      { startMs: 2000, endMs: 6000, text: 'b' },
    ];
    expect(resolveOverlaps(cues)).toEqual([
      { startMs: 0, endMs: 2000, text: 'a' },
      { startMs: 2000, endMs: 4000, text: 'b' },
      { startMs: 4000, endMs: 9000, text: 'c' },
    ]);
  });
  it('merges cues that start at the same instant', () => {
    expect(
      resolveOverlaps([
        { startMs: 1000, endMs: 2000, text: 'top line' },
        { startMs: 1000, endMs: 3000, text: 'bottom line' },
      ]),
    ).toEqual([{ startMs: 1000, endMs: 3000, text: 'top line bottom line' }]);
  });
  it('is applied by the parsers (roll-up captions)', () => {
    const text = 'WEBVTT\n\n00:00.000 --> 00:04.000\none two\n\n00:02.000 --> 00:06.000\nthree four\n';
    expect(parseVtt(text).map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 2000],
      [2000, 6000],
    ]);
  });
});

describe('cuesToWords', () => {
  const cues: Cue[] = [
    { startMs: 1000, endMs: 3000, text: 'a chain rule' },
    { startMs: 3000, endMs: 3700, text: 'differentiation   works' },
    { startMs: 10_000, endMs: 10_000, text: 'instant' },
  ];
  const words = cuesToWords(cues);

  it('emits every word in order', () => {
    expect(words.map((w) => w.w)).toEqual(['a', 'chain', 'rule', 'differentiation', 'works', 'instant']);
  });

  it('spreads words proportionally to their length inside the cue', () => {
    // "a chain rule": weights 1, 5, 4 over 2000 ms.
    expect(words.slice(0, 3)).toEqual([
      { w: 'a', startMs: 1000, endMs: 1200 },
      { w: 'chain', startMs: 1200, endMs: 2200 },
      { w: 'rule', startMs: 2200, endMs: 3000 },
    ]);
    const long = words[3];
    const short = words[4];
    expect(long.endMs - long.startMs).toBeGreaterThan(short.endMs - short.startMs);
  });

  it('keeps times integral, monotonic and within cue bounds', () => {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      expect(Number.isInteger(w.startMs) && Number.isInteger(w.endMs)).toBe(true);
      expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
      if (i > 0) {
        expect(w.startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
        expect(w.startMs).toBeGreaterThanOrEqual(words[i - 1].endMs);
      }
    }
    const cueOf = [0, 0, 0, 1, 1, 2];
    words.forEach((w, i) => {
      expect(w.startMs).toBeGreaterThanOrEqual(cues[cueOf[i]].startMs);
      expect(w.endMs).toBeLessThanOrEqual(cues[cueOf[i]].endMs);
    });
  });

  it('stays monotonic even when given unsorted, overlapping cues', () => {
    const out = cuesToWords([
      { startMs: 5000, endMs: 8000, text: 'later words here' },
      { startMs: 4000, endMs: 6000, text: 'earlier overlapping' },
    ]);
    for (let i = 1; i < out.length; i++) expect(out[i].startMs).toBeGreaterThanOrEqual(out[i - 1].endMs);
  });

  it('returns [] for no cues', () => {
    expect(cuesToWords([])).toEqual([]);
  });
});
