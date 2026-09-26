// Caption files (WebVTT / SubRip) → timed cues → word-level transcript. Pure; shared by the
// upload route and unit tests.
import type { TranscriptWord } from './types';

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export type CaptionFormat = 'vtt' | 'srt';

// "01:02:03.456", "02:03.456", "02:03,4", "1:02:03,456" (SRT uses a comma, VTT a dot).
const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
const TIMING_LINE = /^\s*(\S+)\s*-->\s*(\S+)/;

/** Parses a caption timestamp to ms; null when malformed. Hours are optional. */
export function parseTimestamp(raw: string): number | null {
  const m = TIMESTAMP.exec(raw.trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (minutes > 59 && h !== undefined) return null;
  if (seconds > 59) return null;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return ((Number(h ?? 0) * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Caption markup → plain spoken words: drops tags (<c.x>, <i>, <v Name>, inline <00:01.000>
 * timestamps), SRT {\an8} overrides, entities, ">>" speaker-change markers, ALL-CAPS speaker labels
 * ("PROFESSOR:") and bracketed sound cues ("[Music]", "♪"). Parentheses are kept — lecture
 * captions are full of maths like f(g(x)).
 */
export function cleanCueText(text: string): string {
  // Only tag-shaped markup: a bare "x < 3" in maths captions must survive.
  let s = text.replace(/<\/?(?:[a-zA-Z][^<>]*|\d{1,2}:[\d:.]+)>/g, ' ').replace(/\{\\[^}]*\}/g, ' ');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:>>+\s*|-\s+)/, '')
        .replace(/^\s*[A-Z][A-Z .'-]{1,30}:\s+/, '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/[♪♫]/g, ' '),
    )
    .join(' ');
  return s.replace(/>>+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Guess the format from content (a WEBVTT header, or SRT's comma-millisecond timings). */
export function detectCaptionFormat(text: string): CaptionFormat | null {
  const t = normalize(text).trimStart();
  if (/^WEBVTT(?:[ \t\n]|$)/.test(t)) return 'vtt';
  const timing = t.split('\n').find((l) => l.includes('-->'));
  if (!timing) return null;
  return /\d,\d/.test(timing) ? 'srt' : 'vtt';
}

/** Shared block parser: each blank-line separated block with a "-->" line is a cue. */
function parseBlocks(text: string, skipBlock: (firstLine: string) => boolean): Cue[] {
  const cues: Cue[] = [];
  const blocks = normalize(text).split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0 || skipBlock(lines[0].trim())) continue;
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1 || at > 1) continue; // at most one identifier line before the timing
    const m = TIMING_LINE.exec(lines[at]);
    if (!m) continue;
    const startMs = parseTimestamp(m[1]);
    const endMs = parseTimestamp(m[2]);
    if (startMs === null || endMs === null || endMs < startMs) continue;
    const body = cleanCueText(lines.slice(at + 1).join('\n'));
    if (body) cues.push({ startMs, endMs, text: body });
  }
  return resolveOverlaps(cues);
}

export function parseVtt(text: string): Cue[] {
  return parseBlocks(text, (first) => /^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(first));
}

export function parseSrt(text: string): Cue[] {
  return parseBlocks(text, () => false);
}

/** Auto-detects VTT vs SRT. Returns [] for text that is neither. */
export function parseCaptions(text: string): Cue[] {
  const format = detectCaptionFormat(text);
  if (format === 'vtt') return parseVtt(text);
  if (format === 'srt') return parseSrt(text);
  return [];
}

/**
 * Sorts cues and removes overlap: a cue ends no later than the next one starts (roll-up captions
 * overlap heavily). Cues starting at the same instant are merged.
 */
export function resolveOverlaps(input: Cue[]): Cue[] {
  const sorted = input
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => a.startMs - b.startMs || a.i - b.i);
  const merged: Cue[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && c.startMs === prev.startMs) {
      prev.text = `${prev.text} ${c.text}`;
      prev.endMs = Math.max(prev.endMs, c.endMs);
      continue;
    }
    merged.push({ startMs: c.startMs, endMs: c.endMs, text: c.text });
  }
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i].endMs > merged[i + 1].startMs) merged[i].endMs = merged[i + 1].startMs;
  }
  return merged;
}

/**
 * Spreads each cue's words across its time span in proportion to their length (a long word takes
 * longer to say). Word times are integers, monotonic and inside their cue.
 */
export function cuesToWords(cues: Cue[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let floor = 0;
  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const start = Math.max(Math.round(cue.startMs), floor);
    const end = Math.max(start, Math.round(cue.endMs));
    const weights = tokens.map((t) => Math.max(1, t.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = 0; k < tokens.length; k++) {
      const s = start + Math.round(((end - start) * acc) / total);
      acc += weights[k];
      const e = start + Math.round(((end - start) * acc) / total);
      words.push({ w: tokens[k], startMs: s, endMs: e });
    }
    floor = end;
  }
  return words;
}
