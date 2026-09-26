// Gaps over time. Pure rules for how an unresolved gap moves between sessions of the same student
// and lecture (the caller scopes the input; see lib/gaps.ts):
//   - revisit: a LATER session wrote through the gap's part of the lecture (its concept segment
//     ±15 s) without a gap there → the earlier gap is resolved in that session. A later gap there
//     instead links to the earlier one (repeatOf, "2nd time") and the earlier one stays open.
//   - self: "I get it now" resolves a gap (and the earlier gaps it repeats); "Still confused" reopens.
//   - check: a correct check-question answer (Phase 5; applyCheckAnswer in ./classify sets resolvedBy
//     'check'; a wrong one reopens the gap with reopenedAtIso, like "Still confused").
// reconcileGaps is a function of its input only, so re-running it (re-analysis) never flip-flops.
import { formatClock as clock } from './time';
import type { GapHistory, ResolvedBy, TimeRange, TimelineEvent } from './types';

export const PROGRESS_CONFIG = {
  /** The gap's segment is widened by this much on both sides. */
  revisitPadMs: 15_000,
  /** Strokes a later session needs in that range to count as having written through it. */
  minRevisitStrokes: 2,
} as const;

export type ProgressConfig = typeof PROGRESS_CONFIG;

/** One analysed session of the (student, lecture): when it started, its ink, and its stored gaps. */
export interface SessionGaps {
  sessionId: string;
  createdAtIso: string;
  /** Time spans of the live strokes on the page. */
  inkSpans: TimeRange[];
  /** The session's unresolved_gap events as stored. */
  gaps: TimelineEvent[];
}

export type SelfAction = 'self' | 'reopen';

const bySessionOrder = (a: { createdAtIso: string; sessionId: string }, b: { createdAtIso: string; sessionId: string }) =>
  a.createdAtIso < b.createdAtIso ? -1 : a.createdAtIso > b.createdAtIso ? 1 : a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;

/** Removes the resolution fields (keeps everything else). */
function withoutResolution(g: TimelineEvent): TimelineEvent {
  const rest = { ...g };
  delete rest.resolvedBy;
  delete rest.resolvedInSessionId;
  delete rest.resolvedAtIso;
  return rest;
}

/** A student action ('self' or a Phase 5 'check') that reconciliation must never override. */
const isStudentResolution = (g: TimelineEvent) =>
  g.status === 'resolved' && g.resolvedBy !== 'revisit';

/**
 * Recomputes repeatOf and revisit resolutions for every gap of one student's sessions of one
 * lecture. Returns all gaps (updated copies), in session order then lecture time.
 */
export function reconcileGaps(
  input: SessionGaps[],
  segmentFor: (lectureMs: number) => TimeRange,
  cfg: ProgressConfig = PROGRESS_CONFIG,
): TimelineEvent[] {
  const sessions = [...input].sort(bySessionOrder);
  const rangeCache = new Map<number, TimeRange>();
  const rangeOf = (g: TimelineEvent): TimeRange => {
    let r = rangeCache.get(g.lectureMs);
    if (!r) {
      const seg = segmentFor(g.lectureMs);
      r = { startMs: seg.startMs - cfg.revisitPadMs, endMs: seg.endMs + cfg.revisitPadMs };
      rangeCache.set(g.lectureMs, r);
    }
    return r;
  };
  /** `later` happened where `earlier` did: same concept, or inside earlier's widened segment. */
  const sameSpot = (earlier: TimelineEvent, later: TimelineEvent) => {
    if (earlier.conceptId != null && earlier.conceptId === later.conceptId) return true;
    const r = rangeOf(earlier);
    return later.lectureMs >= r.startMs && later.lectureMs <= r.endMs;
  };
  const wroteThrough = (s: SessionGaps, r: TimeRange) =>
    s.inkSpans.filter((span) => span.endMs >= r.startMs && span.startMs <= r.endMs).length >= cfg.minRevisitStrokes;

  const out: TimelineEvent[] = [];
  sessions.forEach((session, i) => {
    const gaps = [...session.gaps].sort((a, b) => a.lectureMs - b.lectureMs || (a.id < b.id ? -1 : 1));
    for (const original of gaps) {
      let g: TimelineEvent = { ...original };
      delete g.repeatOf;

      // The most recent earlier gap at the same spot.
      for (let j = i - 1; j >= 0 && !g.repeatOf; j--) {
        const prev = [...sessions[j].gaps].reverse().find((h) => sameSpot(h, original));
        if (prev) g.repeatOf = prev.id;
      }

      if (!isStudentResolution(g)) {
        const range = rangeOf(g);
        const resolver = sessions
          .slice(i + 1)
          .find(
            (later) =>
              later.createdAtIso > session.createdAtIso &&
              (!g.reopenedAtIso || later.createdAtIso > g.reopenedAtIso) &&
              wroteThrough(later, range) &&
              !later.gaps.some((x) => sameSpot(g, x)),
          );
        g = withoutResolution(g);
        if (resolver) {
          g.status = 'resolved';
          g.resolvedBy = 'revisit';
          g.resolvedInSessionId = resolver.sessionId;
          g.resolvedAtIso = resolver.createdAtIso;
        } else {
          g.status = 'open';
        }
      }
      out.push(g);
    }
  });
  return out;
}

/** Whether reconciliation changed anything worth storing. */
export function gapChanged(a: TimelineEvent, b: TimelineEvent): boolean {
  return (
    a.status !== b.status ||
    a.resolvedBy !== b.resolvedBy ||
    a.resolvedInSessionId !== b.resolvedInSessionId ||
    a.resolvedAtIso !== b.resolvedAtIso ||
    a.repeatOf !== b.repeatOf
  );
}

/**
 * "I get it now" ('self') / "Still confused" ('reopen') on one gap. `gaps` is the gap's
 * (student, lecture) context; returns only the gaps that changed. 'self' also resolves the open
 * earlier gaps the target repeats, so the whole thread so far is settled.
 */
export function applySelfAction(gaps: TimelineEvent[], targetId: string, action: SelfAction, nowIso: string): TimelineEvent[] {
  const byId = new Map(gaps.map((g) => [g.id, g]));
  const target = byId.get(targetId);
  if (!target) throw new Error(`unknown gap ${targetId}`);
  if (target.type !== 'unresolved_gap') throw new Error(`${targetId} is not a gap`);

  if (action === 'reopen') {
    if (target.status === 'open') return [];
    return [{ ...withoutResolution(target), status: 'open', reopenedAtIso: nowIso }];
  }

  const changed: TimelineEvent[] = [];
  const seen = new Set<string>();
  for (let g: TimelineEvent | undefined = target; g && !seen.has(g.id); g = g.repeatOf ? byId.get(g.repeatOf) : undefined) {
    seen.add(g.id);
    if (g.status === 'open') {
      changed.push({ ...withoutResolution(g), status: 'resolved', resolvedBy: 'self', resolvedAtIso: nowIso });
    }
  }
  return changed;
}

export interface SessionInfo {
  id: string;
  lectureId: string;
  createdAtIso: string;
}

/** A concept that came up as a gap one or more times (linked by repeatOf). */
export interface GapThread {
  /** Id of the first gap in the thread. */
  rootId: string;
  lectureId: string;
  conceptId: string | null;
  label: string;
  status: 'open' | 'resolved';
  firstSeenIso: string;
  /** Oldest first. */
  gaps: TimelineEvent[];
  latest: TimelineEvent;
  /** From the gap resolved last, when the whole thread is resolved. */
  resolvedBy?: ResolvedBy;
  resolvedAtIso?: string;
  resolvedInSessionId?: string;
  history: Map<string, GapHistory>;
}

/** Groups gaps into threads. Gaps whose session is unknown are skipped. Threads oldest first. */
export function buildThreads(gaps: TimelineEvent[], sessions: Map<string, SessionInfo>): GapThread[] {
  const known = gaps.filter((g) => sessions.has(g.sessionId));
  const at = (g: TimelineEvent) => sessions.get(g.sessionId)!.createdAtIso;
  known.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : a.lectureMs - b.lectureMs));
  const byId = new Map(known.map((g) => [g.id, g]));

  const rootOf = (g: TimelineEvent): string => {
    const seen = new Set<string>();
    let cur = g;
    while (cur.repeatOf && byId.has(cur.repeatOf) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.repeatOf)!;
    }
    return cur.id;
  };

  const groups = new Map<string, TimelineEvent[]>();
  for (const g of known) {
    const root = rootOf(g);
    const list = groups.get(root);
    if (list) list.push(g);
    else groups.set(root, [g]);
  }

  const threads: GapThread[] = [];
  for (const [rootId, list] of groups) {
    const root = list[0];
    const latest = list[list.length - 1];
    const status = list.some((g) => g.status === 'open') ? 'open' : 'resolved';
    const firstSeenIso = at(root);
    const thread: GapThread = {
      rootId,
      lectureId: sessions.get(root.sessionId)!.lectureId,
      conceptId: latest.conceptId ?? root.conceptId,
      label: latest.conceptLabel || root.conceptLabel || `Moment at ${clock(latest.lectureMs)}`,
      status,
      firstSeenIso,
      gaps: list,
      latest,
      history: new Map(
        list.map((g, i) => [g.id, { firstSeenIso, occurrence: i + 1, occurrences: list.length, threadStatus: status }]),
      ),
    };
    if (status === 'resolved') {
      const last = [...list].sort((a, b) => ((a.resolvedAtIso ?? '') < (b.resolvedAtIso ?? '') ? -1 : 1)).pop()!;
      if (last.resolvedBy) thread.resolvedBy = last.resolvedBy;
      if (last.resolvedAtIso) thread.resolvedAtIso = last.resolvedAtIso;
      if (last.resolvedInSessionId) thread.resolvedInSessionId = last.resolvedInSessionId;
    }
    threads.push(thread);
  }
  return threads;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

export const RESOLVED_HOW: Record<ResolvedBy, string> = {
  revisit: 'by writing through it calmly',
  self: '— you said you get it',
  check: 'with a check question',
};

/** "Open since Sep 25 · 2nd time" / "First seen Sep 25 · resolved Sep 26 by writing through it calmly". */
export function historyLine(event: TimelineEvent, formatDate: (iso: string) => string): string {
  const h = event.history;
  if (!h) return '';
  const repeat = h.occurrence > 1 ? ` · ${ordinal(h.occurrence)} time` : '';
  if (event.status === 'open') return `Open since ${formatDate(h.firstSeenIso)}${repeat}`;
  const when = event.resolvedAtIso ? ` ${formatDate(event.resolvedAtIso)}` : '';
  const how = event.resolvedBy ? ` ${RESOLVED_HOW[event.resolvedBy]}` : '';
  return `First seen ${formatDate(h.firstSeenIso)} · resolved${when}${how}${repeat}`;
}

// ---- API payloads (client-safe) ------------------------------------------------------------

/** One gap as listed on /progress and in the banners. */
export interface ProgressGap {
  eventId: string;
  sessionId: string;
  sessionTitle: string;
  sessionCreatedAtIso: string;
  lectureMs: number;
  status: 'open' | 'resolved';
  resolvedBy?: ResolvedBy;
  resolvedAtIso?: string;
  resolvedInSessionId?: string;
  occurrence: number;
}

export interface ProgressThread {
  rootId: string;
  conceptId: string | null;
  label: string;
  status: 'open' | 'resolved';
  firstSeenIso: string;
  occurrences: number;
  /** Where "Jump to" seeks: the start of the concept's sentence (or bucket). */
  seekMs: number;
  latest: ProgressGap;
  gaps: ProgressGap[];
  resolvedBy?: ResolvedBy;
  resolvedAtIso?: string;
  resolvedInSessionId?: string;
}

export interface LectureProgress {
  lectureId: string;
  lectureTitle: string;
  openCount: number;
  resolvedCount: number;
  threads: ProgressThread[];
}

export interface ProgressPayload {
  studentId: string;
  openCount: number;
  resolvedCount: number;
  lectures: LectureProgress[];
}

/** A thread from earlier sessions, seen from one session: resolved here, came up again here, or still open. */
export interface CarriedThread extends ProgressThread {
  here: 'resolved' | 'repeated' | 'open';
}

export interface LectureGapsPayload {
  lectureId: string;
  /** Open threads from earlier sessions (all sessions when no session is given). */
  open: ProgressThread[];
  /** Earlier threads as seen from the given session ([] without one). */
  carried: CarriedThread[];
}

const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "Sep 25". */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dayFmt.format(d);
}

/** Short "how" for lists: "Revisited", "You said you get it", "Check question". */
export const RESOLVED_SHORT: Record<ResolvedBy, string> = {
  revisit: 'Revisited',
  self: 'You said you get it',
  check: 'Check question',
};
