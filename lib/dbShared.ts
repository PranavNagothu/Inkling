import "server-only";

// Backend-neutral storage contract: the Db interface both repositories implement (SQLite in
// ./db, Postgres / Tiger Data in ./dbPostgres), the row shapes they read (SQLite conventions:
// JSON columns as text, booleans as 0/1 — the Postgres driver normalises to these), the row → type
// mappers, and the TypeScript reference for the per-window ink statistics.
import type {
  BBox,
  CheckAttempt,
  ConfusionWindow,
  EraseEvent,
  HelpCard,
  Lecture,
  LectureMediaType,
  NotabilityImport,
  PointerKind,
  Point,
  ResolvedBy,
  Revision,
  RevisionReading,
  Session,
  Stroke,
  TimelineData,
  TimelineEvent,
  TranscriptSource,
  TranscriptWord,
} from "./types";
import { activeStrokes, type InkCounts } from "./ink";

/** The single local student (no accounts yet); sessions keep a studentId so this can grow. */
export const LOCAL_STUDENT_ID = "demo-student";

/** A session plus whether it has a stored analysis. */
export type SessionWithAnalysis = Session & { analyzed: boolean };

/** Which storage backend is live (GET /api/health). Never includes connection details. */
export interface DbInfo {
  backend: "sqlite" | "postgres";
  /** True when the TimescaleDB extension is active (hypertable + time_bucket + continuous aggregate). */
  timescale: boolean;
}

/**
 * Ink activity in one lecture-time window of a session (GET /api/sessions/[id]/ink-stats). Counts
 * the session's live ink: strokes not replaced by a partial erase and not scribble-outs, by the
 * window their first point falls in. Windows without ink are omitted.
 */
export interface InkWindowStat {
  bucketStartMs: number;
  /** Strokes started in the window. */
  strokes: number;
  /** How many of them were erased later. */
  erased: number;
  /** Their total ink length (px). */
  inkLen: number;
  /** Median of their median speeds (px/ms), linear interpolation (percentile_cont(0.5)). */
  medianSpeed: number;
  /** Mean pen pressure (0..1) of the pen strokes; null without pen strokes. */
  meanPressure: number | null;
}

/** Class-wide ink per lecture-time bucket, over every session of a lecture. */
export interface InkHotspot {
  bucketStartMs: number;
  strokes: number;
  erased: number;
  inkLen: number;
}

/** Hotspot bucket size (fixed: Timescale's continuous aggregate materialises this bucket). */
export const HOTSPOT_BUCKET_MS = 30_000;
export const MIN_STATS_WINDOW_MS = 1_000;
export const MAX_STATS_WINDOW_MS = 3_600_000;

/**
 * Storage repository. All methods are async so a networked implementation
 * (Postgres / Tiger Data) can satisfy the same interface.
 */
export interface Db {
  /**
   * `id` and `createdAtIso` are for seeding only (scripts/seed-demo): the app always lets the
   * repository pick them (a fresh id, a strictly increasing start time).
   */
  createSession(input: NewSession): Promise<Session>;
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  /**
   * Deletes a session and everything stored for it (ink, analysis, Notability import rows).
   * Returns the stored Notability file names so the caller can remove the files. Seeding only.
   */
  deleteSession(id: string): Promise<{ deleted: boolean; notabilityFiles: string[] }>;
  /**
   * Per-session stroke counts for the session list, in one aggregate query: lines drawn and erased
   * parts, by exactly the rules of inkCounts in ./ink. Sessions without strokes are absent.
   */
  sessionStrokeCounts(): Promise<Map<string, InkCounts>>;
  /** Insert or replace strokes by id (idempotent). */
  upsertStrokes(sessionId: string, strokes: Stroke[]): Promise<void>;
  /** Insert erase events by id; re-sending the same id is a no-op update. */
  addEraseEvents(sessionId: string, events: EraseEvent[]): Promise<void>;
  getStrokes(sessionId: string): Promise<Stroke[]>;
  getEraseEvents(sessionId: string): Promise<EraseEvent[]>;
  /** Monotonic counter bumped on every ink/erase write; lets analysis detect when it is stale. */
  getInkVersion(sessionId: string): Promise<number>;
  /**
   * Replaces the session's analysis rows (windows, revisions, events) atomically. Events whose
   * deterministic id already exists keep their student-facing state (status, check attempts, help,
   * cross-session resolution). Returns the events as stored.
   */
  saveAnalysis(sessionId: string, analysis: AnalysisToSave): Promise<TimelineEvent[]>;
  /** The stored analysis, or null when the session was never analysed. */
  getAnalysis(sessionId: string): Promise<StoredAnalysis | null>;
  /** Persists student-facing changes to one event (type/status/help/check attempts/resolution). */
  updateEvent(event: TimelineEvent): Promise<void>;
  /** updateEvent for several events in one transaction. */
  updateEvents(events: TimelineEvent[]): Promise<void>;
  /** One stored event by id, or null. */
  getEvent(id: string): Promise<TimelineEvent | null>;
  /** A student's sessions (optionally of one lecture), oldest first, with whether each was analysed. */
  listStudentSessions(studentId: string, lectureId?: string): Promise<SessionWithAnalysis[]>;
  /** Stored unresolved_gap events of a student's sessions (optionally of one lecture). */
  listGaps(studentId: string, lectureId?: string): Promise<TimelineEvent[]>;
  /** Stores (or clears) one event's help card without touching anything else on it. */
  setEventHelp(eventId: string, help: HelpCard | null): Promise<void>;
  /** One stored revision by id, or null. */
  getRevision(id: string): Promise<Revision | null>;
  /** Stores what a model read from a revision (kept across re-analysis by lib/analyze). */
  setRevisionVision(id: string, vision: RevisionReading): Promise<void>;

  /** A cached AI result (see lib/ai/cache), or null. */
  getAiCache(key: string): Promise<AiCacheEntry | null>;
  /** Stores an AI result; the same key overwrites. */
  putAiCache(entry: Omit<AiCacheEntry, "createdAtIso">): Promise<void>;
  /** AI concept labels of a lecture, by concept id (`${lectureId}@${segmentStartMs}`). */
  getConceptLabels(lectureId: string): Promise<Map<string, string>>;
  /**
   * Upgrades one concept's readable label (ids never change): stores it for future analyses and
   * relabels the stored events of that concept, in one transaction.
   */
  setConceptLabel(lectureId: string, conceptId: string, label: string): Promise<void>;

  createLecture(input: NewLecture): Promise<Lecture>;
  /** Lectures without transcripts, the demo lecture first, then newest first. */
  listLectures(): Promise<Lecture[]>;
  /** Full record (server only: includes the media path and the word-level transcript). */
  getLecture(id: string): Promise<LectureRecord | null>;
  /** Replaces a lecture's transcript (e.g. after Whisper). Returns null for an unknown lecture. */
  setLectureTranscript(id: string, words: TranscriptWord[], source: TranscriptSource): Promise<Lecture | null>;
  /**
   * Updates a lecture's media fields (a Live lecture's recording and length); omitted fields keep
   * their value. Returns null for an unknown lecture.
   */
  setLectureMedia(id: string, patch: LectureMediaPatch): Promise<Lecture | null>;
  /**
   * Deletes a lecture row and its concept labels (never the bundled demo lecture). Sessions on it
   * are the caller's job (deleteSession, for their files). Returns the stored media path so the
   * caller can remove the file. Demo reset only.
   */
  deleteLecture(id: string): Promise<{ deleted: boolean; mediaPath: string | null }>;

  /** Stores a Notability PDF import as the session's current one (earlier imports stay as history). */
  addNotabilityImport(input: NewNotabilityImport): Promise<NotabilityImport>;
  /** The session's current import (server only: includes the stored file name), or null. */
  getNotabilityImport(sessionId: string): Promise<NotabilityImportRecord | null>;
  /** Every import of a session, newest first. */
  listNotabilityImports(sessionId: string): Promise<NotabilityImport[]>;

  /**
   * Per-window ink statistics of a session (see InkWindowStat), oldest window first. `windowMs` is
   * an integer in [MIN_STATS_WINDOW_MS, MAX_STATS_WINDOW_MS] (RangeError otherwise). Postgres
   * computes it in SQL (TimescaleDB time_bucket on the ink_samples hypertable, else date_bin).
   */
  inkWindowStats(sessionId: string, windowMs: number): Promise<InkWindowStat[]>;
  /** Class-wide ink per HOTSPOT_BUCKET_MS bucket of a lecture (Timescale: continuous aggregate). */
  lectureInkHotspots(lectureId: string): Promise<InkHotspot[]>;

  /**
   * Runs `fn` atomically: every Db call made while it runs (through `fn`'s argument or getDb(),
   * in its async context) is part of one transaction, committed when `fn` resolves and rolled back
   * when it throws. Nested calls join the outer transaction. Calls from outside wait (SQLite) or run
   * on another connection (Postgres); never await another request's work inside `fn`.
   */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  info(): Promise<DbInfo>;
  /** Releases the connection(s). The instance is unusable afterwards. */
  close(): Promise<void>;
}

export interface NewSession {
  title?: string;
  lectureId: string;
  courseId: string;
  studentId?: string;
  /** Seeding only. */
  id?: string;
  /** Seeding only; must be later than the student's earlier sessions it should follow. */
  createdAtIso?: string;
}

/**
 * One aggregate query for every session's InkCounts, valid on both backends (`TRUE`/`FALSE`
 * literals work in SQLite ≥ 3.23 and Postgres; CAST keeps Postgres from returning bigint strings).
 * Must match isDrawnStroke / isErasedPart in ./ink. Both backends store an empty `replaced_by` as NULL.
 */
export const SESSION_STROKE_COUNTS_SQL = `
  SELECT session_id,
         CAST(SUM(CASE WHEN split_from IS NULL AND is_scribble = FALSE
                        AND NOT (erased = TRUE AND COALESCE(erased_by, '') = 'undo') THEN 1 ELSE 0 END) AS INTEGER) AS drawn,
         CAST(SUM(CASE WHEN replaced_by IS NULL AND erased = TRUE AND is_scribble = FALSE
                        AND COALESCE(erased_by, '') <> 'undo' THEN 1 ELSE 0 END) AS INTEGER) AS erased_parts
  FROM strokes
  GROUP BY session_id`;

export interface StrokeCountRow {
  session_id: string;
  drawn: number;
  erased_parts: number;
}

export const toStrokeCounts = (rows: StrokeCountRow[]): Map<string, InkCounts> =>
  new Map(rows.map((r) => [r.session_id, { drawn: Number(r.drawn), erasedParts: Number(r.erased_parts) }]));

export interface AiCacheEntry {
  key: string;
  kind: string;
  provider: string;
  model: string;
  /** JSON-serialisable result. */
  value: unknown;
  createdAtIso: string;
}

export interface NewNotabilityImport {
  sessionId: string;
  /** Sanitised display name (lib/notability sanitizePdfDisplayName). */
  fileName: string;
  /** Server-generated file name inside the Notability upload folder (lib/notability storedPdfName). */
  storedName: string;
  pageCount: number | null;
  size: number;
}

export interface NotabilityImportRecord {
  import: NotabilityImport;
  storedName: string;
}

export interface NewLecture {
  id?: string;
  title: string;
  courseId: string;
  /** Relative to the project root; server-generated, never from the client. */
  mediaPath: string;
  mediaType: LectureMediaType;
  mime: string;
  durationMs: number;
  words: TranscriptWord[];
  transcriptSource: TranscriptSource;
}

export interface LectureMediaPatch {
  /** Relative to the project root; server-generated, never from the client. */
  mediaPath?: string;
  mediaType?: LectureMediaType;
  mime?: string;
  durationMs?: number;
}

export interface LectureRecord {
  lecture: Lecture;
  words: TranscriptWord[];
  mediaPath: string;
}

/** What an analysis run stores; the baseline zones are derived from the windows' phases when read. */
export type AnalysisToSave = Omit<TimelineData, "baseline"> & { inkVersion: number };

export interface StoredAnalysis extends Omit<TimelineData, "baseline"> {
  analyzedAtIso: string;
  /** True when ink was written after this analysis ran. */
  stale: boolean;
}

// ── Rows (SQLite conventions; see normaliseRow in ./dbPostgres) ─────────────────────────────

export interface SessionRow {
  id: string;
  student_id: string;
  lecture_id: string;
  course_id: string;
  title: string;
  created_at_iso: string;
  input_kind: string | null;
  has_pressure: number;
}
export interface AnalysisStateRow {
  ink_version: number;
  analyzed_version: number | null;
  analyzed_at_iso: string | null;
  analysis_duration_ms: number | null;
}
export interface WindowRow {
  session_id: string;
  bucket_start_ms: number;
  features: string;
  scores: string;
  is_spike: number;
  reasons: string;
}
export interface RevisionRow {
  id: string;
  session_id: string;
  lecture_ms: number;
  kind: string;
  before_ids: string;
  after_ids: string;
  bbox: string;
  vision: string | null;
}
export interface EventRow {
  id: string;
  session_id: string;
  lecture_ms: number;
  type: string;
  status: string;
  concept_id: string | null;
  revision_id: string | null;
  window_start_ms: number | null;
  evidence: string;
  help: string | null;
  check_attempts: string;
  resolved_in_session_id: string | null;
  concept_label: string | null;
  resolved_by: string | null;
  resolved_at_iso: string | null;
  reopened_at_iso: string | null;
  repeat_of: string | null;
}
/** The columns saveAnalysis carries over from an event's previous copy. */
export type PrevEventRow = Pick<
  EventRow,
  | "id"
  | "type"
  | "status"
  | "help"
  | "check_attempts"
  | "resolved_in_session_id"
  | "resolved_by"
  | "resolved_at_iso"
  | "reopened_at_iso"
  | "repeat_of"
>;
export interface StrokeRow {
  id: string;
  session_id: string;
  start_ms: number;
  end_ms: number;
  points: string;
  pointer_type: string;
  bbox: string;
  ink_len: number;
  median_speed: number;
  erased: number;
  erased_at_ms: number | null;
  erased_by: string | null;
  is_scribble: number;
  split_from: string | null;
  replaced_by: string | null;
}
export interface LectureRow {
  id: string;
  course_id: string;
  title: string;
  media_path: string;
  media_type: string;
  mime: string;
  duration_ms: number;
  transcript_source: string;
  created_at: string;
  word_count: number;
}
export interface NotabilityRow {
  id: string;
  session_id: string;
  file_name_display: string;
  stored_name: string;
  page_count: number | null;
  size: number;
  created_at: string;
  is_current: number;
}
export interface EraseRow {
  id: string;
  session_id: string;
  at_ms: number;
  stroke_ids: string;
  by: string;
}
export interface AiCacheRow {
  key: string;
  kind: string;
  provider: string;
  model: string;
  value: string;
  created_at: string;
}

// ── Row → type mappers ──────────────────────────────────────────────────────────────────────

export const toSession = (r: SessionRow): Session => ({
  id: r.id,
  studentId: r.student_id,
  lectureId: r.lecture_id,
  courseId: r.course_id,
  title: r.title,
  createdAtIso: r.created_at_iso,
  inputKind: r.input_kind as PointerKind | null,
  hasPressure: r.has_pressure === 1,
});

export const toStroke = (r: StrokeRow): Stroke => ({
  id: r.id,
  sessionId: r.session_id,
  startMs: r.start_ms,
  endMs: r.end_ms,
  points: JSON.parse(r.points) as Point[],
  pointerType: r.pointer_type as PointerKind,
  bbox: JSON.parse(r.bbox) as BBox,
  inkLen: r.ink_len,
  medianSpeed: r.median_speed,
  erased: r.erased === 1,
  erasedAtMs: r.erased_at_ms,
  erasedBy: r.erased_by as Stroke["erasedBy"],
  isScribble: r.is_scribble === 1,
  splitFrom: r.split_from ?? null,
  replacedBy: r.replaced_by ? (JSON.parse(r.replaced_by) as string[]) : null,
});

export const toEraseEvent = (r: EraseRow): EraseEvent => ({
  id: r.id,
  sessionId: r.session_id,
  atMs: r.at_ms,
  strokeIds: JSON.parse(r.stroke_ids) as string[],
  by: r.by as EraseEvent["by"],
});

export const toWindow = (r: WindowRow): ConfusionWindow => {
  const f = JSON.parse(r.features) as Pick<ConfusionWindow, "pause" | "slowdown" | "erase" | "pressure" | "phase">;
  const sc = JSON.parse(r.scores) as Pick<ConfusionWindow, "rawScore" | "emaScore">;
  return {
    sessionId: r.session_id,
    bucketStartMs: r.bucket_start_ms,
    pause: f.pause,
    slowdown: f.slowdown,
    erase: f.erase,
    pressure: f.pressure,
    rawScore: sc.rawScore,
    emaScore: sc.emaScore,
    isSpike: r.is_spike === 1,
    reasons: JSON.parse(r.reasons) as string[],
    // Stored alongside the features (no schema change); absent on analyses from before Phase 6.
    ...(f.phase ? { phase: f.phase } : {}),
  };
};

export const toRevision = (r: RevisionRow): Revision => {
  const rev: Revision = {
    id: r.id,
    sessionId: r.session_id,
    lectureMs: r.lecture_ms,
    beforeStrokeIds: JSON.parse(r.before_ids) as string[],
    afterStrokeIds: JSON.parse(r.after_ids) as string[],
    bbox: JSON.parse(r.bbox) as BBox,
    kind: r.kind as Revision["kind"],
  };
  if (r.vision) rev.vision = JSON.parse(r.vision) as Revision["vision"];
  return rev;
};

export const toEvent = (r: EventRow): TimelineEvent => {
  const e: TimelineEvent = {
    id: r.id,
    sessionId: r.session_id,
    lectureMs: r.lecture_ms,
    type: r.type as TimelineEvent["type"],
    status: r.status as TimelineEvent["status"],
    conceptId: r.concept_id,
    evidence: JSON.parse(r.evidence) as TimelineEvent["evidence"],
    checkAttempts: JSON.parse(r.check_attempts) as CheckAttempt[],
  };
  if (r.revision_id != null) e.revisionId = r.revision_id;
  if (r.window_start_ms != null) e.windowStartMs = r.window_start_ms;
  if (r.help) e.help = JSON.parse(r.help) as HelpCard;
  if (r.resolved_in_session_id) e.resolvedInSessionId = r.resolved_in_session_id;
  e.conceptLabel = r.concept_label ?? null;
  if (r.resolved_by) e.resolvedBy = r.resolved_by as ResolvedBy;
  if (r.resolved_at_iso) e.resolvedAtIso = r.resolved_at_iso;
  if (r.reopened_at_iso) e.reopenedAtIso = r.reopened_at_iso;
  if (r.repeat_of) e.repeatOf = r.repeat_of;
  return e;
};

export const toLecture = (r: LectureRow): Lecture => {
  const lecture: Lecture = {
    id: r.id,
    courseId: r.course_id,
    title: r.title,
    mediaType: r.media_type as LectureMediaType,
    mime: r.mime,
    durationMs: r.duration_ms,
    transcriptSource: r.transcript_source as TranscriptSource,
    wordCount: r.word_count,
    createdAtIso: r.created_at,
  };
  // A Live lecture before its recording exists (the media path itself never leaves the server).
  if (r.transcript_source === 'live' && !r.media_path) lecture.live = true;
  return lecture;
};

export const toNotabilityImport = (r: NotabilityRow): NotabilityImport => ({
  id: r.id,
  sessionId: r.session_id,
  fileName: r.file_name_display,
  pageCount: r.page_count,
  size: r.size,
  createdAtIso: r.created_at,
  current: r.is_current === 1,
});

export function toAiCacheEntry(row: AiCacheRow): AiCacheEntry | null {
  try {
    return {
      key: row.key,
      kind: row.kind,
      provider: row.provider,
      model: row.model,
      value: JSON.parse(row.value) as unknown,
      createdAtIso: row.created_at,
    };
  } catch {
    return null;
  }
}

// ── Shared write-side rules ─────────────────────────────────────────────────────────────────

export const KIND_RANK: Record<PointerKind, number> = { mouse: 1, touch: 2, pen: 3 };

/** The session's input kind (strongest seen) and whether real pen pressure was seen, after `strokes`. */
export function sessionInputAfter(
  current: { kind: PointerKind | null; hasPressure: boolean },
  strokes: Stroke[],
): { kind: PointerKind | null; hasPressure: boolean } {
  let { kind, hasPressure } = current;
  for (const s of strokes) {
    if (!kind || KIND_RANK[s.pointerType] > KIND_RANK[kind]) kind = s.pointerType;
    // Mouse reports a constant 0.5 while pressed; real pressure varies.
    if (s.pointerType === "pen" && s.points.some((p) => p[2] > 0 && p[2] !== 0.5)) hasPressure = true;
  }
  return { kind, hasPressure };
}

/**
 * The student-facing state saveAnalysis keeps when a fresh event has the id of a stored one
 * (same deterministic id = same moment).
 */
export function carryForward(fresh: TimelineEvent, sessionId: string, old: PrevEventRow | undefined): TimelineEvent {
  const e: TimelineEvent = { ...fresh, sessionId };
  if (!old) return e;
  const attempts = JSON.parse(old.check_attempts) as CheckAttempt[];
  e.checkAttempts = attempts;
  e.status = old.status as TimelineEvent["status"];
  // A check answer can turn a correction into a breakthrough (or a gap); keep that outcome.
  if (attempts.length > 0) e.type = old.type as TimelineEvent["type"];
  if (old.help) e.help = JSON.parse(old.help) as HelpCard;
  if (old.resolved_in_session_id) e.resolvedInSessionId = old.resolved_in_session_id;
  // Gaps over time: how it was resolved (self / revisit / check) and its thread link survive;
  // lib/gaps.ts re-derives the revisit fields right after.
  if (old.resolved_by) e.resolvedBy = old.resolved_by as ResolvedBy;
  if (old.resolved_at_iso) e.resolvedAtIso = old.resolved_at_iso;
  if (old.reopened_at_iso) e.reopenedAtIso = old.reopened_at_iso;
  if (old.repeat_of) e.repeatOf = old.repeat_of;
  return e;
}

// ── Ink statistics (TypeScript reference; Postgres computes the same in SQL) ────────────────

/** One stroke's summary row in the ink time series (Postgres: the ink_samples hypertable). */
export interface InkSample {
  strokeId: string;
  startMs: number;
  kind: PointerKind;
  speed: number;
  /** Mean pressure over the stroke's points; null for a stroke without points. */
  pressure: number | null;
  inkLen: number;
  erased: boolean;
}

/**
 * Live ink only: pieces replace their parent, scribble-outs are erase gestures (not ink), and an
 * undone stroke (erasedBy 'undo') was taken back — neither drawn nor erased (isDrawnStroke /
 * isErasedPart in ./ink) — so it is left out. Must match the ink_samples INSERT in ./dbPostgres.
 */
export function inkSamples(strokes: Stroke[]): InkSample[] {
  return activeStrokes(strokes)
    .filter((s) => !s.isScribble && !(s.erased && s.erasedBy === "undo"))
    .map((s) => ({
      strokeId: s.id,
      startMs: s.startMs,
      kind: s.pointerType,
      speed: s.medianSpeed,
      pressure: s.points.length ? s.points.reduce((a, p) => a + p[2], 0) / s.points.length : null,
      inkLen: s.inkLen,
      erased: s.erased,
    }));
}

export function assertStatsWindowMs(windowMs: number): void {
  if (!Number.isInteger(windowMs) || windowMs < MIN_STATS_WINDOW_MS || windowMs > MAX_STATS_WINDOW_MS) {
    throw new RangeError(`windowMs must be an integer between ${MIN_STATS_WINDOW_MS} and ${MAX_STATS_WINDOW_MS}`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bucketOf(samples: InkSample[], windowMs: number): Map<number, InkSample[]> {
  const buckets = new Map<number, InkSample[]>();
  for (const s of samples) {
    const start = Math.floor(s.startMs / windowMs) * windowMs;
    buckets.set(start, [...(buckets.get(start) ?? []), s]);
  }
  return new Map([...buckets].sort(([a], [b]) => a - b));
}

export function computeInkWindowStats(strokes: Stroke[], windowMs: number): InkWindowStat[] {
  assertStatsWindowMs(windowMs);
  return [...bucketOf(inkSamples(strokes), windowMs)].map(([bucketStartMs, list]) => {
    const pen = list.filter((s) => s.kind === "pen" && s.pressure != null).map((s) => s.pressure!);
    return {
      bucketStartMs,
      strokes: list.length,
      erased: list.filter((s) => s.erased).length,
      inkLen: list.reduce((a, s) => a + s.inkLen, 0),
      medianSpeed: median(list.map((s) => s.speed)),
      meanPressure: pen.length ? pen.reduce((a, p) => a + p, 0) / pen.length : null,
    };
  });
}

export function computeInkHotspots(strokes: Stroke[]): InkHotspot[] {
  return [...bucketOf(inkSamples(strokes), HOTSPOT_BUCKET_MS)].map(([bucketStartMs, list]) => ({
    bucketStartMs,
    strokes: list.length,
    erased: list.filter((s) => s.erased).length,
    inkLen: list.reduce((a, s) => a + s.inkLen, 0),
  }));
}
