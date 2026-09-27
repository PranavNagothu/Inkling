import "server-only";

// Gaps over time, server side: loads a student's sessions of a lecture, runs the pure rules in
// ./progress (revisit resolution, repeats, self actions) and shapes the progress payloads.
import { applyCheckAnswer } from "./classify";
import { createConceptTagger, withConceptLabels, type ConceptTagger } from "./concepts";
import { LOCAL_STUDENT_ID, getDb, type Db } from "./db";
import { toClientEvent, toClientEvents } from "./events";
import { activeStrokes } from "./ink";
import { getSessionLecture } from "./lecture";
import { createKeyedMutex } from "./mutex";
import {
  applySelfAction,
  buildThreads,
  gapChanged,
  reconcileGaps,
  type CarriedThread,
  type GapThread,
  type LectureGapsPayload,
  type LectureProgress,
  type ProgressGap,
  type ProgressPayload,
  type ProgressThread,
  type SelfAction,
  type SessionGaps,
} from "./progress";
import type { Session, TimelineEvent, TranscriptWord } from "./types";

// One student's gaps of one lecture are read, recomputed and written across several awaits
// (analysis, reconciliation, "I get it now", check answers). Those sequences are serialised per
// (student, lecture) so a stale snapshot can never overwrite a newer write. Singleton across Next
// dev hot reloads, like the DB handle.
const g = globalThis as unknown as { __inklingLectureLock?: ReturnType<typeof createKeyedMutex> };
const lectureLock = (g.__inklingLectureLock ??= createKeyedMutex());

/** Runs `task` while holding the (student, lecture) lock (re-entrant within the holding task; lib/mutex). */
export function withLectureLock<T>(studentId: string, lectureId: string, task: () => Promise<T>): Promise<T> {
  return lectureLock.run(`${studentId}\u0000${lectureId}`, task);
}

/** The lecture's concept tagger: transcript sentences, with AI labels (lib/ai) where stored. */
export async function conceptTaggerFor(lectureId: string, words: TranscriptWord[]): Promise<ConceptTagger> {
  const base = createConceptTagger(lectureId, words);
  const labels = await getDb().getConceptLabels(lectureId);
  return labels.size === 0 ? base : withConceptLabels(base, (seg) => labels.get(seg.id));
}

async function lectureTagger(lectureId: string): Promise<{ title: string; tagger: ConceptTagger }> {
  const { lecture, words } = await getSessionLecture(lectureId);
  return { title: lecture.title, tagger: await conceptTaggerFor(lecture.id, words) };
}

/**
 * Re-derives repeat links and revisit resolutions for one student's sessions of one lecture and
 * stores what changed. Idempotent (see reconcileGaps). Only analysed sessions take part.
 */
export async function reconcileLecture(studentId: string, lectureId: string, tagger?: ConceptTagger): Promise<void> {
  await withLectureLock(studentId, lectureId, () => reconcileLectureLocked(studentId, lectureId, { tagger }));
}

/**
 * reconcileLecture for a caller already holding the lock. `pending` are student-facing changes
 * (e.g. a check answer) that take part in the reconciliation and are written together with its
 * result, in one transaction.
 */
export async function reconcileLectureLocked(
  studentId: string,
  lectureId: string,
  opts: { tagger?: ConceptTagger; pending?: TimelineEvent[] } = {},
): Promise<void> {
  // Reads and the resulting writes form one transaction (joins the caller's, e.g. analyzeSession).
  await getDb().transaction((db) => reconcileInTransaction(db, studentId, lectureId, opts));
}

async function reconcileInTransaction(
  db: Db,
  studentId: string,
  lectureId: string,
  opts: { tagger?: ConceptTagger; pending?: TimelineEvent[] },
): Promise<void> {
  const pending = new Map((opts.pending ?? []).map((e) => [e.id, e]));
  const [sessions, stored] = await Promise.all([db.listStudentSessions(studentId, lectureId), db.listGaps(studentId, lectureId)]);
  // Pending changes replace their stored copy; a pending gap that isn't stored as one yet joins in.
  const gaps = stored.filter((e) => !pending.has(e.id));
  for (const e of pending.values()) if (e.type === "unresolved_gap") gaps.push(e);
  const analyzed = sessions.filter((s) => s.analyzed);
  if (analyzed.length === 0 || gaps.length === 0) {
    await db.updateEvents([...pending.values()]);
    return;
  }
  const segmentFor = (opts.tagger ?? (await lectureTagger(lectureId)).tagger).conceptFor;

  const input: SessionGaps[] = await Promise.all(
    analyzed.map(async (s) => {
      const strokes = await db.getStrokes(s.id);
      return {
        sessionId: s.id,
        createdAtIso: s.createdAtIso,
        inkSpans: activeStrokes(strokes)
          .filter((k) => !k.erased && !k.isScribble)
          .map((k) => ({ startMs: k.startMs, endMs: k.endMs })),
        gaps: gaps.filter((g) => g.sessionId === s.id),
      };
    }),
  );
  const before = new Map(stored.map((e) => [e.id, e]));
  const reconciled = reconcileGaps(input, (ms) => segmentFor(ms));
  const writes = new Map([...pending].filter(([, e]) => e.type !== "unresolved_gap"));
  for (const e of reconciled) {
    const old = before.get(e.id);
    if (pending.has(e.id) || !old || gapChanged(old, e)) writes.set(e.id, e);
  }
  await db.updateEvents([...writes.values()]);
}

/** Attaches each gap's history (first seen, "2nd time", thread status) to a session's events. */
export async function attachHistory(session: Session, events: TimelineEvent[]): Promise<TimelineEvent[]> {
  if (!events.some((e) => e.type === "unresolved_gap")) return events;
  const db = getDb();
  const [sessions, gaps] = await Promise.all([
    db.listStudentSessions(session.studentId, session.lectureId),
    db.listGaps(session.studentId, session.lectureId),
  ]);
  const threads = buildThreads(gaps, new Map(sessions.map((s) => [s.id, s])));
  const history = new Map(threads.flatMap((t) => [...t.history]));
  return events.map((e) => {
    const h = e.type === "unresolved_gap" ? history.get(e.id) : undefined;
    return h ? { ...e, history: h } : e;
  });
}

export type SelfResolveResult =
  | { ok: true; events: TimelineEvent[] }
  | { ok: false; status: 400 | 404; error: string };

/**
 * "I get it now" / "Still confused" on a gap. Returns the gap's session's gaps as stored afterwards
 * (with history), so a client can merge them.
 */
export async function selfResolveGap(
  eventId: string,
  action: SelfAction,
  nowIso: string = new Date().toISOString(),
): Promise<SelfResolveResult> {
  const db = getDb();
  const event = await db.getEvent(eventId);
  if (!event) return { ok: false, status: 404, error: "moment not found" };
  if (event.type !== "unresolved_gap") return { ok: false, status: 400, error: "only gaps can be resolved this way" };
  const session = await db.getSession(event.sessionId);
  if (!session) return { ok: false, status: 404, error: "session not found" };

  const after = await withLectureLock(session.studentId, session.lectureId, () =>
    db.transaction(async (tx) => {
      const context = await tx.listGaps(session.studentId, session.lectureId);
      if (!context.some((g) => g.id === eventId)) return null; // changed type meanwhile (a check answer)
      await tx.updateEvents(applySelfAction(context, eventId, action, nowIso));
      return (await tx.listGaps(session.studentId, session.lectureId)).filter((g) => g.sessionId === session.id);
    }),
  );
  if (!after) return { ok: false, status: 400, error: "only gaps can be resolved this way" };
  return { ok: true, events: toClientEvents(await attachHistory(session, after)) };
}

export type CheckAnswerResult =
  | {
      ok: true;
      correct: boolean;
      /** Why the right answer is right (shown after any answer). */
      why: string;
      /** Only revealed once answered correctly. */
      answerIdx?: number;
      /** The moment as stored afterwards (client-safe, with history). */
      event: TimelineEvent;
      /** Every stored event of the moment's session that changed, for the client to merge. */
      events: TimelineEvent[];
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Grades a check-question answer against the moment's stored help card (Phase 5), stores the
 * attempt (applyCheckAnswer: correct → resolved 'check' / breakthrough; wrong → open again,
 * reopened now) and re-runs gap reconciliation — all under the (student, lecture) lock, with the
 * answer and the reconciliation written in one transaction.
 */
export async function answerCheckQuestion(
  eventId: string,
  choiceIdx: number,
  nowIso: string = new Date().toISOString(),
): Promise<CheckAnswerResult> {
  const db = getDb();
  const first = await db.getEvent(eventId);
  if (!first) return { ok: false, status: 404, error: "moment not found" };
  const session = await db.getSession(first.sessionId);
  if (!session) return { ok: false, status: 404, error: "session not found" };

  return withLectureLock(session.studentId, session.lectureId, async (): Promise<CheckAnswerResult> => {
    const event = await db.getEvent(eventId); // re-read under the lock
    if (!event) return { ok: false, status: 404, error: "moment not found" };
    const help = event.help;
    if (!help) return { ok: false, status: 409, error: "This moment has no check question yet." };
    if (!Number.isInteger(choiceIdx) || choiceIdx < 0 || choiceIdx >= help.mcq.options.length) {
      return { ok: false, status: 400, error: "choiceIdx is out of range" };
    }
    const correct = choiceIdx === help.mcq.answerIdx;
    const next = applyCheckAnswer(event, { atIso: nowIso, choiceIdx, correct });
    const beforeSession = (await db.getAnalysis(session.id))?.events ?? [];
    await reconcileLectureLocked(session.studentId, session.lectureId, { pending: [next] });

    const afterSession = (await db.getAnalysis(session.id))?.events ?? [];
    const prev = new Map(beforeSession.map((e) => [e.id, JSON.stringify(e)]));
    const withHistory = await attachHistory(session, afterSession);
    const changed = withHistory.filter((e) => prev.get(e.id) !== JSON.stringify(afterSession.find((x) => x.id === e.id)));
    const stored = withHistory.find((e) => e.id === eventId) ?? next;
    return {
      ok: true,
      correct,
      why: help.mcq.why,
      ...(correct ? { answerIdx: help.mcq.answerIdx } : {}),
      event: toClientEvent(stored),
      events: toClientEvents(changed.some((e) => e.id === eventId) ? changed : [...changed, stored]),
    };
  });
}

function toProgressGap(g: TimelineEvent, sessions: Map<string, Session>, occurrence: number): ProgressGap {
  const s = sessions.get(g.sessionId)!;
  const out: ProgressGap = {
    eventId: g.id,
    sessionId: g.sessionId,
    sessionTitle: s.title,
    sessionCreatedAtIso: s.createdAtIso,
    lectureMs: g.lectureMs,
    status: g.status,
    occurrence,
  };
  if (g.resolvedBy) out.resolvedBy = g.resolvedBy;
  if (g.resolvedAtIso) out.resolvedAtIso = g.resolvedAtIso;
  if (g.resolvedInSessionId) out.resolvedInSessionId = g.resolvedInSessionId;
  return out;
}

function toProgressThread(t: GapThread, sessions: Map<string, Session>, tagger: ConceptTagger): ProgressThread {
  const gaps = t.gaps.map((g, i) => toProgressGap(g, sessions, i + 1));
  const out: ProgressThread = {
    rootId: t.rootId,
    conceptId: t.conceptId,
    label: t.label,
    status: t.status,
    firstSeenIso: t.firstSeenIso,
    occurrences: gaps.length,
    seekMs: Math.max(0, Math.min(t.latest.lectureMs, tagger.conceptFor(t.latest.lectureMs).startMs)),
    latest: gaps[gaps.length - 1],
    gaps,
  };
  if (t.resolvedBy) out.resolvedBy = t.resolvedBy;
  if (t.resolvedAtIso) out.resolvedAtIso = t.resolvedAtIso;
  if (t.resolvedInSessionId) out.resolvedInSessionId = t.resolvedInSessionId;
  return out;
}

const byLectureTime = (a: ProgressThread, b: ProgressThread) => a.latest.lectureMs - b.latest.lectureMs;

/** Every gap thread of a student, per lecture (most recently studied lecture first). */
export async function getProgress(studentId: string = LOCAL_STUDENT_ID): Promise<ProgressPayload> {
  const db = getDb();
  const [sessions, gaps] = await Promise.all([db.listStudentSessions(studentId), db.listGaps(studentId)]);
  const sessionMap = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  const threads = buildThreads(gaps, sessionMap);

  const byLecture = new Map<string, GapThread[]>();
  for (const t of threads) byLecture.set(t.lectureId, [...(byLecture.get(t.lectureId) ?? []), t]);
  const lastActivity = new Map<string, string>();
  for (const s of sessions) lastActivity.set(s.lectureId, s.createdAtIso); // oldest first → last wins

  const lectures: LectureProgress[] = [];
  for (const [lectureId, list] of byLecture) {
    const { title, tagger } = await lectureTagger(lectureId);
    const shaped = list.map((t) => toProgressThread(t, sessionMap, tagger)).sort(byLectureTime);
    lectures.push({
      lectureId,
      lectureTitle: title,
      openCount: shaped.filter((t) => t.status === "open").length,
      resolvedCount: shaped.filter((t) => t.status === "resolved").length,
      threads: shaped,
    });
  }
  lectures.sort((a, b) => ((lastActivity.get(b.lectureId) ?? "") < (lastActivity.get(a.lectureId) ?? "") ? -1 : 1));
  return {
    studentId,
    openCount: lectures.reduce((n, l) => n + l.openCount, 0),
    resolvedCount: lectures.reduce((n, l) => n + l.resolvedCount, 0),
    lectures,
  };
}

/** Number of open gap threads (the home page's quiet "Open gaps: N"). */
export async function countOpenGaps(studentId: string = LOCAL_STUDENT_ID): Promise<number> {
  const db = getDb();
  const [sessions, gaps] = await Promise.all([db.listStudentSessions(studentId), db.listGaps(studentId)]);
  return buildThreads(gaps, new Map(sessions.map((s) => [s.id, s]))).filter((t) => t.status === "open").length;
}

/**
 * A lecture's gap threads as seen from one session: `open` = open threads from earlier sessions
 * (the capture banner), `carried` = those plus the ones this session resolved (the review's
 * "Carried over"). Without a session: every open thread of the local student.
 */
export async function getLectureGaps(
  lectureId: string,
  opts: { sessionId?: string; studentId?: string } = {},
): Promise<LectureGapsPayload> {
  const db = getDb();
  const session = opts.sessionId ? await db.getSession(opts.sessionId) : null;
  const studentId = session?.studentId ?? opts.studentId ?? LOCAL_STUDENT_ID;
  const [sessions, gaps, { tagger }] = await Promise.all([
    db.listStudentSessions(studentId, lectureId),
    db.listGaps(studentId, lectureId),
    lectureTagger(lectureId),
  ]);
  const sessionMap = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  const threads = buildThreads(gaps, sessionMap);

  if (!session) {
    return {
      lectureId,
      open: threads.filter((t) => t.status === "open").map((t) => toProgressThread(t, sessionMap, tagger)).sort(byLectureTime),
      carried: [],
    };
  }

  const isEarlier = (g: TimelineEvent) => {
    const s = sessionMap.get(g.sessionId);
    return !!s && s.createdAtIso < session.createdAtIso;
  };
  const carried: CarriedThread[] = [];
  for (const t of threads) {
    const earlier = t.gaps.filter(isEarlier);
    if (earlier.length === 0) continue;
    const resolvedHere = earlier.some((g) => g.resolvedInSessionId === session.id);
    if (t.status !== "open" && !resolvedHere) continue;
    const here = resolvedHere ? "resolved" : t.gaps.some((g) => g.sessionId === session.id) ? "repeated" : "open";
    carried.push({ ...toProgressThread(t, sessionMap, tagger), here });
  }
  carried.sort(byLectureTime);
  return { lectureId, open: carried.filter((t) => t.status === "open"), carried };
}
