// Turns raw signal (confusion windows from lib/scoring.ts + revisions from
// lib/pairing.ts + the transcript) into the TimelineEvent[] the UI renders.
//
// All times are lecture-clock ms (see ../types).

import type { CheckAttempt, ConfusionWindow, Revision, TimelineEvent, TimelineEventType, TranscriptWord } from './types';

/**
 * Tags a moment with a concept: a bare id, or an id plus a readable label (lib/concepts'
 * ConceptTagger.conceptFor fits). null = unknown (never deduped by concept).
 */
export type ConceptFor = (lectureMs: number) => string | { id: string; label: string } | null;

export const CLASSIFY_CONFIG = {
  linkBeforeMs: 10000,
  linkAfterMs: 45000,
  dedupeMs: 30000,
  maxEvents: 10,
  evidencePadMs: 10000,
  excerptPadMs: 15000,
} as const;

export type ClassifyConfig = typeof CLASSIFY_CONFIG;

/** Higher number = more severe / more worth surfacing. */
const SEVERITY: Record<TimelineEventType, number> = {
  unresolved_gap: 2,
  misconception_corrected: 1,
  breakthrough: 1,
};

export function excerptAround(words: TranscriptWord[], centerMs: number, padMs: number): string {
  const start = centerMs - padMs;
  const end = centerMs + padMs;
  return words
    .filter((w) => w.endMs >= start && w.startMs <= end)
    .map((w) => w.w)
    .join(' ');
}

function buildEvent(opts: {
  sessionId: string;
  type: TimelineEventType;
  status: 'open' | 'resolved';
  lectureMs: number;
  revisionId?: string;
  windowStartMs?: number;
  words: TranscriptWord[];
  conceptFor?: ConceptFor;
  cfg: ClassifyConfig;
}): TimelineEvent {
  const { sessionId, type, status, lectureMs, revisionId, windowStartMs, words, conceptFor, cfg } = opts;
  const concept = conceptFor ? conceptFor(lectureMs) ?? null : null;
  const conceptId = typeof concept === 'string' ? concept : concept?.id ?? null;
  const conceptLabel = typeof concept === 'string' || concept == null ? null : concept.label;
  const event: TimelineEvent = {
    id: `${sessionId}:${type}:${lectureMs}`,
    sessionId,
    lectureMs,
    type,
    status,
    conceptId,
    conceptLabel,
    evidence: {
      excerpt: excerptAround(words, lectureMs, cfg.excerptPadMs),
      audioStartMs: Math.max(0, lectureMs - cfg.evidencePadMs),
      audioEndMs: lectureMs + cfg.evidencePadMs,
    },
    checkAttempts: [],
  };
  if (revisionId !== undefined) event.revisionId = revisionId;
  if (windowStartMs !== undefined) event.windowStartMs = windowStartMs;
  return event;
}

/**
 * Merge events that are close in time (<= dedupeMs) and share the same
 * non-null conceptId, keeping the more severe of the pair. Events with a null
 * conceptId are never deduped against each other (we have no evidence they
 * refer to the same concept).
 */
function dedupe(eventsSortedByTime: TimelineEvent[], dedupeMs: number): TimelineEvent[] {
  const kept: TimelineEvent[] = [];
  for (const candidate of eventsSortedByTime) {
    let mergedIndex = -1;
    if (candidate.conceptId != null) {
      mergedIndex = kept.findIndex(
        (k) => k.conceptId === candidate.conceptId && Math.abs(k.lectureMs - candidate.lectureMs) <= dedupeMs,
      );
    }
    if (mergedIndex === -1) {
      kept.push(candidate);
      continue;
    }
    const existing = kept[mergedIndex];
    if (SEVERITY[candidate.type] > SEVERITY[existing.type]) {
      kept[mergedIndex] = candidate;
    }
    // else keep the existing (earlier, since input is time-sorted) event.
  }
  return kept;
}

/**
 * Cap policy (documented choice, exercised by a test): sort by severity
 * (unresolved_gap first, since open gaps are the most actionable for a
 * student) and, within the same severity, by earliest lectureMs -- then keep
 * the first maxEvents. This favors surfacing every open gap before filling
 * remaining slots with resolved corrections, rather than truncating purely by
 * time.
 */
function cap(events: TimelineEvent[], maxEvents: number): TimelineEvent[] {
  if (events.length <= maxEvents) return events;
  return [...events]
    .sort((a, b) => SEVERITY[b.type] - SEVERITY[a.type] || a.lectureMs - b.lectureMs)
    .slice(0, maxEvents);
}

/**
 * Event ids are `session:type:lectureMs` (stable across re-runs, so a student's check answers
 * survive re-analysis). Two events of one type at the same instant (e.g. two corrections made by one
 * erase gesture) would collide, so later ones get their revision (or window) appended.
 */
function uniqueIds(events: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  return events.map((e) => {
    let id = e.id;
    if (seen.has(id)) id = `${e.id}:${e.revisionId ?? e.windowStartMs ?? 'x'}`;
    for (let n = 2; seen.has(id); n++) id = `${e.id}:${n}`;
    seen.add(id);
    return id === e.id ? e : { ...e, id };
  });
}

export function buildTimeline(input: {
  sessionId: string;
  windows: ConfusionWindow[];
  revisions: Revision[];
  words: TranscriptWord[];
  conceptFor?: ConceptFor;
  config?: Partial<ClassifyConfig>;
}): TimelineEvent[] {
  const cfg: ClassifyConfig = { ...CLASSIFY_CONFIG, ...input.config };
  const { sessionId, windows, revisions, words, conceptFor } = input;

  // micro/cosmetic revisions (and non-corrections like deletions) never
  // produce events and never act as link targets for spikes.
  const corrections = revisions.filter((r) => r.kind === 'correction' && r.vision?.cosmetic !== true);
  const spikes = windows.filter((w) => w.isSpike);

  // Each correction explains at most one spike. Candidate (spike, correction) links are taken
  // closest first (ties: the stronger spike, then the earlier one); a spike whose correction was
  // taken by a closer spike may still link to another correction in its own range.
  const links: Array<{ spike: ConfusionWindow; rev: Revision; diff: number }> = [];
  for (const spike of spikes) {
    const t = spike.bucketStartMs;
    for (const rev of corrections) {
      if (rev.lectureMs >= t - cfg.linkBeforeMs && rev.lectureMs <= t + cfg.linkAfterMs) {
        links.push({ spike, rev, diff: Math.abs(rev.lectureMs - t) });
      }
    }
  }
  links.sort(
    (a, b) =>
      a.diff - b.diff || b.spike.emaScore - a.spike.emaScore || a.spike.bucketStartMs - b.spike.bucketStartMs,
  );
  const linkFor = new Map<ConfusionWindow, Revision>();
  const linkedRevisionIds = new Set<string>();
  for (const { spike, rev } of links) {
    if (linkFor.has(spike) || linkedRevisionIds.has(rev.id)) continue;
    linkFor.set(spike, rev);
    linkedRevisionIds.add(rev.id);
  }

  const raw: TimelineEvent[] = [];
  for (const spike of spikes) {
    const t = spike.bucketStartMs;
    const best = linkFor.get(spike);
    if (best) {
      raw.push(
        buildEvent({
          sessionId,
          type: 'misconception_corrected',
          status: 'resolved',
          lectureMs: best.lectureMs,
          revisionId: best.id,
          windowStartMs: t,
          words,
          conceptFor,
          cfg,
        }),
      );
    } else {
      raw.push(
        buildEvent({
          sessionId,
          type: 'unresolved_gap',
          status: 'open',
          lectureMs: t,
          windowStartMs: t,
          words,
          conceptFor,
          cfg,
        }),
      );
    }
  }

  for (const r of corrections) {
    if (linkedRevisionIds.has(r.id)) continue;
    raw.push(
      buildEvent({
        sessionId,
        type: 'misconception_corrected',
        status: 'resolved',
        lectureMs: r.lectureMs,
        revisionId: r.id,
        words,
        conceptFor,
        cfg,
      }),
    );
  }

  const sortedByTime = uniqueIds([...raw].sort((a, b) => a.lectureMs - b.lectureMs));
  const deduped = dedupe(sortedByTime, cfg.dedupeMs);
  const capped = cap(deduped, cfg.maxEvents);
  return capped.sort((a, b) => a.lectureMs - b.lectureMs);
}

export function applyCheckAnswer(event: TimelineEvent, attempt: CheckAttempt): TimelineEvent {
  const checkAttempts = [...event.checkAttempts, attempt];
  const next: TimelineEvent = { ...event, checkAttempts };

  if (attempt.correct) {
    if (event.type === 'misconception_corrected' && event.checkAttempts.length === 0) next.type = 'breakthrough';
    next.status = 'resolved';
    // Gaps over time (lib/progress): a correct answer is how Phase 5 resolves a gap.
    if (next.type === 'unresolved_gap' && event.status !== 'resolved') {
      next.resolvedBy = 'check';
      next.resolvedAtIso = attempt.atIso;
    }
  } else {
    next.type = 'unresolved_gap';
    next.status = 'open';
    delete next.resolvedBy;
    delete next.resolvedInSessionId;
    delete next.resolvedAtIso;
    // Like "Still confused": only sessions started after this answer may resolve it by revisit
    // (lib/progress reconcileGaps), so an earlier calm session can't immediately re-resolve it.
    next.reopenedAtIso = attempt.atIso;
  }
  return next;
}
