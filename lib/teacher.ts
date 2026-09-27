import "server-only";

// "Where did the class get lost?" — the teacher view of one lecture (/teacher/[lectureId], GET
// /api/lectures/[id]/class). Privacy first: every student's sessions of the lecture are reduced to
// anonymous writing signals (when they hesitated, when they erased), aggregated per 30 s of lecture,
// and only then shown. No names, ids or ink leave this module; a head count below CLASS_K is never
// shown (k-anonymity), and a class smaller than CLASS_K gets no view at all.
//
// The erasing row of the heatmap is Db.lectureInkHotspots — on Tiger Data a TimescaleDB continuous
// aggregate. The "students who struggled" row and the re-teach picks are computed here in TS.
// Client components import only types from this module.
import { analysisDurationMs } from "./analyze";
import { HOTSPOT_BUCKET_MS, getDb, type InkHotspot } from "./db";
import { hotspotBars, hotspotSourceLabel } from "./hotspots";
import { isReversedErase, scoreSession } from "./scoring";
import type { ConfusionWindow, EraseEvent, LectureMediaType, Stroke, TranscriptWord } from "./types";

/** Smallest group whose size is ever shown (k-anonymity). */
export const CLASS_K = 3;
/** How many stretches the teacher is asked to re-teach. */
export const RETEACH_COUNT = 3;
const EXCERPT_WORDS = 28;

/** One student's anonymous writing signals over a lecture (lecture-clock ms), across their sessions. */
export interface StudentSignals {
  /** Starts of the scoring windows flagged as a hesitation spike. */
  hesitationMs: number[];
  /** Times of real erases (not Undo, not an erase that was taken straight back). */
  eraseMs: number[];
}

/** One column of the class heatmap. */
export interface ClassBucket {
  startMs: number;
  endMs: number;
  /** Class-wide strokes started here (hotspots query). */
  strokes: number;
  /** How many of them were erased later (hotspots query). */
  erased: number;
  /** erased / the busiest bucket's erased (0..1). */
  erasedLevel: number;
  /** Students who hesitated or erased here; null when fewer than CLASS_K (never shown). */
  students: number | null;
  /** students / class size (0..1); 0 when suppressed. */
  studentLevel: number;
}

/** A stretch of the lecture to re-teach. */
export interface ReteachMoment {
  rank: number;
  startMs: number;
  endMs: number;
  /** Distinct students who hesitated or erased in the stretch; null when fewer than CLASS_K. */
  students: number | null;
  /** "4 students" or "fewer than 3 students". */
  studentsLabel: string;
  /** Class-wide erased strokes in the stretch. */
  erased: number;
  /** What the lecturer said then ("" without a transcript). */
  excerpt: string;
}

export type ClassView =
  | { status: "empty" }
  | { status: "too-few" }
  | { status: "ready"; classSize: number; buckets: ClassBucket[]; moments: ReteachMoment[] };

/** What the page and the API serve. Contains no session or student ids. */
export interface ClassReport {
  lecture: { id: string; title: string; durationMs: number; mediaType: LectureMediaType };
  bucketMs: number;
  /** Where the erasing numbers come from (hotspotSourceLabel). */
  source: string;
  timescale: boolean;
  view: ClassView;
}

const kAnon = (n: number, k: number): number | null => (n >= k ? n : null);

export function studentsLabel(n: number | null, k: number = CLASS_K): string {
  return n !== null && n >= k ? `${n} students` : `fewer than ${k} students`;
}

/** The words spoken in [startMs, endMs), capped at `maxWords` (then "…"). */
export function rangeExcerpt(words: TranscriptWord[], startMs: number, endMs: number, maxWords: number = EXCERPT_WORDS): string {
  const inRange = words.filter((w) => w.startMs >= startMs && w.startMs < endMs).map((w) => w.w);
  return inRange.length > maxWords ? `${inRange.slice(0, maxWords).join(" ")}…` : inRange.join(" ");
}

/** One session's signals (pure). Hesitations are the scoring's spikes; erases skip Undo and take-backs. */
export function studentSignalsFrom(input: { windows: ConfusionWindow[]; eraseEvents: EraseEvent[]; strokes: Stroke[] }): StudentSignals {
  return {
    hesitationMs: input.windows.filter((w) => w.isSpike).map((w) => w.bucketStartMs),
    eraseMs: input.eraseEvents.filter((e) => e.by !== "undo" && !isReversedErase(e, input.strokes)).map((e) => e.atMs),
  };
}

interface Cell {
  startMs: number;
  endMs: number;
  /** Anonymous student indices (never leave this module). */
  students: Set<number>;
  erased: number;
}

export interface PickedRange {
  startMs: number;
  endMs: number;
  students: Set<number>;
  erased: number;
}

/**
 * The `n` stretches where the most distinct students struggled (ties: more erasing, then earlier).
 * A pick absorbs a directly adjacent bucket where at least half as many students struggled (the same
 * confusing passage straddling a bucket edge); buckets touching a pick are never picked again.
 * Cells are equal-length buckets; missing ones count as quiet.
 */
export function pickReteachMoments(cells: Cell[], n: number = RETEACH_COUNT): PickedRange[] {
  const order = cells
    .filter((c) => c.students.size > 0)
    .sort((a, b) => b.students.size - a.students.size || b.erased - a.erased || a.startMs - b.startMs);
  const byStart = new Map(cells.map((c) => [c.startMs, c]));
  const blocked = new Set<Cell>();
  const picked: PickedRange[] = [];
  for (const c of order) {
    if (picked.length >= n) break;
    if (blocked.has(c)) continue;
    const len = c.endMs - c.startMs;
    const join = Math.max(1, Math.ceil(c.students.size / 2));
    const members = [c];
    for (const nb of [byStart.get(c.startMs - len), byStart.get(c.endMs)]) {
      if (nb && !blocked.has(nb) && nb.students.size >= join) members.push(nb);
    }
    members.sort((a, b) => a.startMs - b.startMs);
    const startMs = members[0].startMs;
    const endMs = members[members.length - 1].endMs;
    const students = new Set<number>();
    let erased = 0;
    for (const m of members) {
      for (const s of m.students) students.add(s);
      erased += m.erased;
    }
    picked.push({ startMs, endMs, students, erased });
    // The pick and the buckets touching it are taken.
    for (const other of cells) if (other.endMs >= startMs && other.startMs <= endMs) blocked.add(other);
  }
  return picked;
}

/** The class view (pure): heatmap buckets + the stretches to re-teach, k-anonymous throughout. */
export function buildClassView(input: {
  durationMs: number;
  hotspots: InkHotspot[];
  students: StudentSignals[];
  words: TranscriptWord[];
  bucketMs?: number;
  k?: number;
}): ClassView {
  const k = input.k ?? CLASS_K;
  const bucketMs = input.bucketMs ?? HOTSPOT_BUCKET_MS;
  const classSize = input.students.length;
  if (classSize === 0) return { status: "empty" };
  if (classSize < k) return { status: "too-few" };

  const bars = hotspotBars(input.hotspots, input.durationMs, bucketMs);
  const cells: Cell[] = bars.map((b) => ({ startMs: b.startMs, endMs: b.endMs, students: new Set<number>(), erased: b.erased }));
  const cellAt = (ms: number) => cells[Math.min(cells.length - 1, Math.max(0, Math.floor(ms / bucketMs)))];
  input.students.forEach((s, idx) => {
    for (const ms of [...s.hesitationMs, ...s.eraseMs]) cellAt(ms)?.students.add(idx);
  });

  const buckets: ClassBucket[] = bars.map((b, i) => {
    const students = kAnon(cells[i].students.size, k);
    return {
      startMs: b.startMs,
      endMs: b.endMs,
      strokes: b.strokes,
      erased: b.erased,
      erasedLevel: b.level,
      students,
      studentLevel: students === null ? 0 : Math.round((students / classSize) * 100) / 100,
    };
  });
  const moments = pickReteachMoments(cells).map((r, i): ReteachMoment => {
    const students = kAnon(r.students.size, k);
    return {
      rank: i + 1,
      startMs: r.startMs,
      endMs: r.endMs,
      students,
      studentsLabel: studentsLabel(students, k),
      erased: r.erased,
      excerpt: rangeExcerpt(input.words, r.startMs, r.endMs),
    };
  });
  return { status: "ready", classSize, buckets, moments };
}

/**
 * Loads every session of the lecture, reduces each student to anonymous signals and builds the view.
 * Stored, up-to-date analyses are reused; other sessions (e.g. classmates never opened on this
 * device) are scored in memory with the app's own engine — nothing is written. null = unknown lecture.
 */
export async function loadClassReport(lectureId: string): Promise<ClassReport | null> {
  const db = getDb();
  const record = await db.getLecture(lectureId);
  if (!record) return null;
  const { lecture, words } = record;
  const [sessions, hotspots, info] = await Promise.all([db.listSessions(), db.lectureInkHotspots(lectureId), db.info()]);
  const hasTranscript = lecture.transcriptSource !== "none" && words.length > 0;

  const byStudent = new Map<string, StudentSignals>();
  for (const session of sessions.filter((s) => s.lectureId === lectureId)) {
    const [strokes, eraseEvents, stored] = await Promise.all([
      db.getStrokes(session.id),
      db.getEraseEvents(session.id),
      db.getAnalysis(session.id),
    ]);
    if (strokes.length === 0 && eraseEvents.length === 0) continue;
    const windows =
      stored && !stored.stale
        ? stored.windows
        : scoreSession({
            sessionId: session.id,
            strokes,
            eraseEvents,
            words,
            durationMs: analysisDurationMs(lecture.durationMs, strokes, eraseEvents),
            hasTranscript,
          });
    const signals = studentSignalsFrom({ windows, eraseEvents, strokes });
    const prev = byStudent.get(session.studentId);
    byStudent.set(
      session.studentId,
      prev ? { hesitationMs: [...prev.hesitationMs, ...signals.hesitationMs], eraseMs: [...prev.eraseMs, ...signals.eraseMs] } : signals,
    );
  }

  return {
    lecture: { id: lecture.id, title: lecture.title, durationMs: lecture.durationMs, mediaType: lecture.mediaType },
    bucketMs: HOTSPOT_BUCKET_MS,
    source: hotspotSourceLabel(info),
    timescale: info.timescale,
    // Map order is insertion order; the view only ever sees anonymous indices.
    view: buildClassView({ durationMs: lecture.durationMs, hotspots, students: [...byStudent.values()], words }),
  };
}
