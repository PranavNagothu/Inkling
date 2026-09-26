// Concept tagging without AI: a moment belongs to the transcript sentence (or caption cue) being
// spoken when it happened; with no speech nearby (or no transcript) it falls back to a 30 s bucket.
// Pure; used by lib/analyze.ts. Phase 5 upgrades the labels with AI (lib/ai/service, stored per
// lecture; lib/gaps conceptTaggerFor applies them through withConceptLabels, ids unchanged).
import { formatClock as clock } from './time';
import type { TranscriptWord } from './types';

export const CONCEPT_CONFIG = {
  /** Fallback bucket size when no sentence is near the moment. */
  bucketMs: 30_000,
  /** A silence this long ends a segment even without punctuation (auto captions have none). */
  silenceMs: 2_000,
  /** A run-on segment is cut once it spans this long. */
  maxSegmentMs: 30_000,
  /** A moment in a pause this close after (or before) a sentence still belongs to it. */
  snapMs: 3_000,
  /** Words kept in a readable label. */
  labelWords: 8,
} as const;

export interface TranscriptSegmentSpan {
  startMs: number;
  endMs: number;
  text: string;
}

/** A concept a moment is about. `id` is `${lectureId}@${segmentStartMs}`. */
export interface ConceptSegment {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
}

export interface ConceptTagger {
  conceptFor(lectureMs: number): ConceptSegment;
}

const SENTENCE_END = /[.?!]["')\]]?$/;

/** Sentences (or silence-/length-bounded runs of words) with their time spans. */
export function segmentTranscript(
  words: TranscriptWord[],
  cfg: Pick<typeof CONCEPT_CONFIG, 'silenceMs' | 'maxSegmentMs'> = CONCEPT_CONFIG,
): TranscriptSegmentSpan[] {
  const out: TranscriptSegmentSpan[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    out.push({
      startMs: cur[0].startMs,
      endMs: cur[cur.length - 1].endMs,
      text: cur.map((w) => w.w).join(' '),
    });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.startMs - prev.endMs >= cfg.silenceMs || w.endMs - cur[0].startMs > cfg.maxSegmentMs)) flush();
    cur.push(w);
    if (SENTENCE_END.test(w.w)) flush();
  }
  flush();
  return out;
}

/** The first ~8 words of a segment, without trailing punctuation; "…" when cut short. */
export function conceptLabel(text: string, maxWords: number = CONCEPT_CONFIG.labelWords): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = tokens.slice(0, maxWords).join(' ').replace(/[\s.,;:!?"')\]…-]+$/, '');
  return tokens.length > maxWords ? `${kept}…` : kept;
}

/** The fallback concept: the 30 s bucket holding the moment. */
export function bucketConcept(lectureId: string, lectureMs: number, bucketMs: number = CONCEPT_CONFIG.bucketMs): ConceptSegment {
  const startMs = Math.max(0, Math.floor(lectureMs / bucketMs) * bucketMs);
  return { id: `${lectureId}@${startMs}`, label: `Moment at ${clock(startMs)}`, startMs, endMs: startMs + bucketMs };
}

/** The default tagger: transcript sentences, falling back to buckets. */
export function createConceptTagger(
  lectureId: string,
  words: TranscriptWord[],
  cfg: typeof CONCEPT_CONFIG = CONCEPT_CONFIG,
): ConceptTagger {
  const segments = segmentTranscript(words, cfg);
  const toConcept = (s: TranscriptSegmentSpan): ConceptSegment => ({
    id: `${lectureId}@${s.startMs}`,
    label: conceptLabel(s.text, cfg.labelWords) || `Moment at ${clock(s.startMs)}`,
    startMs: s.startMs,
    endMs: s.endMs,
  });
  return {
    conceptFor(lectureMs: number) {
      // Last segment that has started (binary search).
      let lo = 0;
      let hi = segments.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segments[mid].startMs <= lectureMs) {
          at = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const before = at >= 0 ? segments[at] : undefined;
      if (before && lectureMs <= before.endMs + cfg.snapMs) return toConcept(before);
      const after = segments[at + 1];
      if (after && after.startMs - lectureMs <= cfg.snapMs) return toConcept(after);
      return bucketConcept(lectureId, lectureMs, cfg.bucketMs);
    },
  };
}

/**
 * Overrides labels (e.g. AI-generated concept names in Phase 5) while keeping the base tagger's
 * ids and ranges, so stored concept ids never change when labels improve.
 */
export function withConceptLabels(
  base: ConceptTagger,
  labelFor: (segment: ConceptSegment) => string | null | undefined,
): ConceptTagger {
  return {
    conceptFor(lectureMs: number) {
      const seg = base.conceptFor(lectureMs);
      const label = labelFor(seg);
      return label ? { ...seg, label } : seg;
    },
  };
}
