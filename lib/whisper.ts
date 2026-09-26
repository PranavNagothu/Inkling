// OpenAI Whisper (verbose_json, word timestamps) → TranscriptWord[]. The mapping is pure and
// unit-tested; the network call lives in lib/transcribe.ts (server only).
import { cuesToWords, resolveOverlaps } from './captions';
import type { TranscriptWord } from './types';

export interface WhisperWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperVerboseResponse {
  text?: string;
  duration?: number;
  language?: string;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Maps word timestamps (seconds) to integer-ms words, dropping blanks/garbage and keeping times
 * monotonic. Falls back to spreading segment text when the response has no word timings.
 */
export function whisperToWords(res: WhisperVerboseResponse): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let floor = 0;
  if (Array.isArray(res.words) && res.words.length > 0) {
    for (const w of res.words) {
      if (!w || typeof w.word !== 'string' || !finite(w.start) || !finite(w.end)) continue;
      const text = w.word.trim();
      if (!text) continue;
      const startMs = Math.max(floor, Math.round(w.start * 1000));
      const endMs = Math.max(startMs, Math.round(w.end * 1000));
      out.push({ w: text, startMs, endMs });
      floor = startMs;
    }
    return out;
  }
  const segments = (res.segments ?? []).filter(
    (s) => s && typeof s.text === 'string' && finite(s.start) && finite(s.end) && s.end >= s.start,
  );
  return cuesToWords(
    resolveOverlaps(
      segments.map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text.trim() })),
    ),
  );
}
