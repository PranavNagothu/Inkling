import "server-only";

// Analysis pipeline: raw ink + erase events + transcript → confusion windows, revisions and the
// learning timeline, persisted per session. Deterministic, so re-running is idempotent.
import { buildTimeline } from "./classify";
import { getDb } from "./db";
import { toClientEvents } from "./events";
import { attachHistory, conceptTaggerFor, reconcileLectureLocked, withLectureLock } from "./gaps";
import { getSessionLecture } from "./lecture";
import { pairRevisions } from "./pairing";
import { baselineZones, scoreSession } from "./scoring";
import type { EraseEvent, Stroke, TimelineData } from "./types";

export interface TimelineSnapshot extends TimelineData {
  /** False when the session has never been analysed (all lists empty). */
  analyzed: boolean;
  /** True when ink was written after the stored analysis ran. */
  stale: boolean;
}

/** The track covers the whole lecture, extended if ink was written after the audio ended. */
export function analysisDurationMs(lectureMs: number, strokes: Stroke[], eraseEvents: EraseEvent[]): number {
  let last = lectureMs;
  for (const s of strokes) last = Math.max(last, s.endMs, s.erasedAtMs ?? 0);
  for (const e of eraseEvents) last = Math.max(last, e.atMs);
  return Math.ceil(last);
}

/**
 * Runs scoring → pairing → classification for a session and replaces its stored analysis.
 * Returns null for an unknown session.
 */
export async function analyzeSession(sessionId: string): Promise<TimelineData | null> {
  const db = getDb();
  const session = await db.getSession(sessionId);
  if (!session) return null;

  // Read the version before the ink so a write that lands mid-analysis leaves the result stale.
  const inkVersion = await db.getInkVersion(sessionId);
  const [strokes, eraseEvents] = await Promise.all([db.getStrokes(sessionId), db.getEraseEvents(sessionId)]);
  const { lecture, words } = await getSessionLecture(session.lectureId);
  const durationMs = analysisDurationMs(lecture.durationMs, strokes, eraseEvents);
  // Without a transcript the pause feature is disabled (see scoreSession's hasTranscript).
  const hasTranscript = lecture.transcriptSource !== "none" && words.length > 0;

  const windows = scoreSession({ sessionId, strokes, eraseEvents, words, durationMs, hasTranscript });
  // Each moment is tagged with the transcript sentence it happened in (30 s buckets without one),
  // named by its AI label when one is stored (lib/ai/concepts; ids never change).
  const tagger = await conceptTaggerFor(lecture.id, words);

  const stored = await withLectureLock(session.studentId, session.lectureId, () =>
    // One transaction: the new analysis and the cross-session reconciliation it triggers are
    // stored together or not at all (both backends; see Db.transaction).
    db.transaction(async (tx) => {
      // What a model read from a revision (Phase 5) is kept: revision ids are deterministic, and a
      // reading that says the change was cosmetic keeps it off the timeline (lib/classify).
      const previous = new Map(((await tx.getAnalysis(sessionId))?.revisions ?? []).map((r) => [r.id, r.vision]));
      const revisions = pairRevisions({ sessionId, strokes, eraseEvents }).map((r) => {
        const vision = previous.get(r.id);
        return vision ? { ...r, vision } : r;
      });
      const events = buildTimeline({ sessionId, windows, revisions, words, conceptFor: tagger.conceptFor });
      await tx.saveAnalysis(sessionId, { durationMs, windows, revisions, events, inkVersion });
      // Gaps over time: this session may resolve (or repeat) gaps from earlier sessions of the lecture.
      await reconcileLectureLocked(session.studentId, session.lectureId, { tagger });
      return (await tx.getAnalysis(sessionId))!;
    }),
  );
  return {
    durationMs,
    windows,
    revisions: stored.revisions,
    events: toClientEvents(await attachHistory(session, stored.events)),
    baseline: baselineZones(windows, durationMs),
  };
}

/** The stored analysis for a session (never computes). Returns null for an unknown session. */
export async function getTimeline(sessionId: string): Promise<TimelineSnapshot | null> {
  const db = getDb();
  const session = await db.getSession(sessionId);
  if (!session) return null;
  const stored = await db.getAnalysis(sessionId);
  if (!stored) {
    const { lecture } = await getSessionLecture(session.lectureId);
    return {
      analyzed: false,
      stale: true,
      durationMs: lecture.durationMs,
      windows: [],
      revisions: [],
      events: [],
      baseline: [],
    };
  }
  const { durationMs, windows, revisions, stale } = stored;
  const events = toClientEvents(await attachHistory(session, stored.events));
  return { analyzed: true, stale, durationMs, windows, revisions, events, baseline: baselineZones(windows, durationMs) };
}
