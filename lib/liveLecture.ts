// Live lecture mode (pure and client-safe): the session clock, speech results → transcript cues
// and words, and the validation the cue route shares with the browser.
//
// A Live lecture has no recording to play. Its clock is wall-clock time since the student pressed
// Start, minus the time it was paused; strokes and transcript words are stamped against it exactly
// like lecture milliseconds, so analysis, "what the lecture was saying", Replay 20 s (once the mic
// recording is uploaded) and AI re-teach all work unchanged after End session.
import type { TranscriptWord } from './types';
import { LANGUAGES } from './ai/languages';
import { MAX_DURATION_MS } from './upload';
import { isDemoMode } from './demoMode';

// ── The session clock ───────────────────────────────────────────────────────────────────────────

/** Accumulated clock time plus, while running, the monotonic timestamp it was (re)started at. */
export interface LiveClock {
  /** Clock time banked by earlier running stretches (and any resume offset), in ms. */
  bankedMs: number;
  /** performance.now() when the current running stretch began; null while paused / not started. */
  runningSince: number | null;
}

/** A stopped clock at `offsetMs` (0 for a new lecture; the lecture's length when resuming one). */
export function newLiveClock(offsetMs = 0): LiveClock {
  return { bankedMs: Math.max(0, offsetMs), runningSince: null };
}

export const isRunning = (c: LiveClock) => c.runningSince !== null;

/** Clock time at monotonic time `now` (whole ms). Never goes backwards if `now` does. */
export function clockNow(c: LiveClock, now: number): number {
  const running = c.runningSince === null ? 0 : Math.max(0, now - c.runningSince);
  return Math.round(c.bankedMs + running);
}

export function startClock(c: LiveClock, now: number): LiveClock {
  return c.runningSince !== null ? c : { bankedMs: c.bankedMs, runningSince: now };
}

export function pauseClock(c: LiveClock, now: number): LiveClock {
  if (c.runningSince === null) return c;
  return { bankedMs: c.bankedMs + Math.max(0, now - c.runningSince), runningSince: null };
}

// ── Speech results → cues → words ───────────────────────────────────────────────────────────────

/** One final speech-recognition result, stamped on the session clock. */
export interface LiveCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Each word gets at least this much of a cue's span, so consecutive cues never share a start. */
export const MIN_WORD_MS = 50;
export const MAX_CUE_CHARS = 1000;
export const MAX_CUES_PER_REQUEST = 200;
/** Cue batches are small JSON bodies; nothing legitimate comes close to this. */
export const MAX_CUES_BODY_BYTES = 256 * 1024;
/** A lecture transcript stops growing here (about 15 hours of fast speech). */
export const MAX_LIVE_WORDS = 200_000;

/** Speech text as stored: control characters stripped, whitespace collapsed, length capped. */
export function normalizeCueText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CUE_CHARS)
    .trim();
}

const tokens = (text: string) => text.split(' ').filter(Boolean);

/**
 * Word timings for a cue. Web Speech gives no per-word times, so the cue's span is shared evenly:
 * word i covers [start + i·slot, start + (i+1)·slot).
 */
export function distributeWords(text: string, startMs: number, endMs: number): TranscriptWord[] {
  const ws = tokens(normalizeCueText(text));
  if (ws.length === 0) return [];
  const span = Math.max(0, endMs - startMs);
  const slot = span / ws.length;
  return ws.map((w, i) => ({
    w,
    startMs: Math.round(startMs + i * slot),
    endMs: Math.round(startMs + (i + 1) * slot),
  }));
}

/**
 * A final speech result as a cue on the session clock: it starts no earlier than the previous cue
 * ended, and spans at least MIN_WORD_MS per word. Null when the result has no words.
 *
 * `startMs` is when the utterance began (the first interim result, or the end of the previous final
 * one); `endMs` is when the final result arrived.
 */
export function resultToCue(text: string, startMs: number, endMs: number, prevEndMs = 0): LiveCue | null {
  const clean = normalizeCueText(text);
  const n = tokens(clean).length;
  if (n === 0) return null;
  const start = Math.round(Math.max(0, startMs, prevEndMs));
  const end = Math.round(Math.max(endMs, start + n * MIN_WORD_MS));
  return { startMs: start, endMs: end, text: clean };
}

/** Words of consecutive cues, in order. */
export function cuesToLiveWords(cues: LiveCue[]): TranscriptWord[] {
  return cues.flatMap((c) => distributeWords(c.text, c.startMs, c.endMs));
}

/**
 * Stores a batch idempotently: every stored word starting at or after the batch's first cue is
 * replaced by the batch's words, so a retried (or re-sent) batch never duplicates words.
 */
export function mergeLiveWords(existing: TranscriptWord[], cues: LiveCue[]): TranscriptWord[] {
  if (cues.length === 0) return existing;
  const fromMs = cues[0].startMs;
  return [...existing.filter((w) => w.startMs < fromMs), ...cuesToLiveWords(cues)];
}

// ── Validation (shared by the cue route and its tests) ──────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DURATION_MS;

/** A cue batch body: `{ cues: LiveCue[], durationMs?: number }`, cues in order and non-overlapping. */
export function parseCueBatch(body: unknown): Parsed<{ cues: LiveCue[]; durationMs: number | null }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const { cues, durationMs } = body as { cues?: unknown; durationMs?: unknown };
  if (durationMs !== undefined && !isMs(durationMs)) return { ok: false, error: 'durationMs must be a length in ms' };
  if (!Array.isArray(cues)) return { ok: false, error: 'cues must be an array' };
  if (cues.length > MAX_CUES_PER_REQUEST) return { ok: false, error: `at most ${MAX_CUES_PER_REQUEST} cues per request` };
  const out: LiveCue[] = [];
  let prevEnd = 0;
  for (const c of cues as unknown[]) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'each cue must be an object' };
    const { startMs, endMs, text } = c as { startMs?: unknown; endMs?: unknown; text?: unknown };
    if (!isMs(startMs) || !isMs(endMs) || endMs < startMs) return { ok: false, error: 'cue times must be ms with endMs >= startMs' };
    if (typeof text !== 'string' || text.length > MAX_CUE_CHARS) {
      return { ok: false, error: `cue text must be a string (<= ${MAX_CUE_CHARS} chars)` };
    }
    if (startMs < prevEnd) return { ok: false, error: 'cues must be in order and must not overlap' };
    prevEnd = endMs;
    const clean = normalizeCueText(text);
    if (clean) out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text: clean });
  }
  return { ok: true, value: { cues: out, durationMs: typeof durationMs === 'number' ? Math.round(durationMs) : null } };
}

// ── Recognition languages ───────────────────────────────────────────────────────────────────────

/** Speech-recognition languages: US English first, then the app's other languages (BCP 47). */
export const LIVE_LANGUAGES: ReadonlyArray<{ tag: string; label: string }> = [
  { tag: 'en-US', label: 'English (US)' },
  ...LANGUAGES.filter((l) => l.bcp47 !== 'en-US').map((l) => ({ tag: l.bcp47, label: l.native })),
];

export const DEFAULT_LIVE_LANGUAGE = 'en-US';

export function isLiveLanguage(tag: unknown): tag is string {
  return typeof tag === 'string' && LIVE_LANGUAGES.some((l) => l.tag === tag);
}

// ── Recording formats ───────────────────────────────────────────────────────────────────────────

/** MediaRecorder formats to try, best first: WebM/Opus (Chrome, Firefox), then MP4 (Safari). */
export const RECORDING_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

/** First MIME type the browser's MediaRecorder supports ('' = let the browser pick). */
export function pickRecordingMime(isSupported: (mime: string) => boolean): string {
  return RECORDING_MIME_CANDIDATES.find((m) => isSupported(m)) ?? '';
}

// ── DEMO_MODE ───────────────────────────────────────────────────────────────────────────────────

export const LIVE_DEMO_MESSAGE = 'Live lecture is available when you run Inkling yourself.';

/** DEMO_MODE (a public demo) never records audio or creates Live lectures. */
export function liveLectureDisabled(env: Record<string, string | undefined>): boolean {
  return isDemoMode(env);
}
