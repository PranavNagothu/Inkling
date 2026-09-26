import "server-only";

import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import demoTranscript from "@/public/demo/lecture.transcript.json";
import type {
  EraseEvent,
  HelpCard,
  PointerKind,
  RevisionReading,
  Session,
  Stroke,
  TimelineEvent,
  TranscriptSource,
  TranscriptWord,
} from "./types";
import { newId } from "./ink";
import { DEMO_LECTURE, DEMO_MEDIA_PATH } from "./demo";
import {
  LOCAL_STUDENT_ID,
  SESSION_STROKE_COUNTS_SQL,
  carryForward,
  toStrokeCounts,
  computeInkHotspots,
  computeInkWindowStats,
  sessionInputAfter,
  toAiCacheEntry,
  toEraseEvent,
  toEvent,
  toLecture,
  toNotabilityImport,
  toRevision,
  toSession,
  toStroke,
  toWindow,
  type AiCacheEntry,
  type AiCacheRow,
  type AnalysisStateRow,
  type AnalysisToSave,
  type Db,
  type DbInfo,
  type EraseRow,
  type EventRow,
  type LectureRecord,
  type LectureRow,
  type NewLecture,
  type NewNotabilityImport,
  type NewSession,
  type NotabilityImportRecord,
  type NotabilityRow,
  type PrevEventRow,
  type RevisionRow,
  type SessionRow,
  type StoredAnalysis,
  type StrokeCountRow,
  type StrokeRow,
  type WindowRow,
} from "./dbShared";
import { openPostgresDb } from "./dbPostgres";

// The storage contract lives in ./dbShared; importers keep using "@/lib/db".
export * from "./dbShared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  lecture_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  input_kind TEXT,
  has_pressure INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS strokes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  start_ms REAL NOT NULL,
  end_ms REAL NOT NULL,
  points TEXT NOT NULL,
  pointer_type TEXT NOT NULL,
  bbox TEXT NOT NULL,
  ink_len REAL NOT NULL,
  median_speed REAL NOT NULL,
  erased INTEGER NOT NULL DEFAULT 0,
  erased_at_ms REAL,
  erased_by TEXT,
  is_scribble INTEGER NOT NULL DEFAULT 0,
  split_from TEXT,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS strokes_session ON strokes(session_id, start_ms);
CREATE TABLE IF NOT EXISTS erase_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at_ms REAL NOT NULL,
  stroke_ids TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS erase_events_session ON erase_events(session_id, at_ms);
CREATE TABLE IF NOT EXISTS confusion_windows (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bucket_start_ms REAL NOT NULL,
  features TEXT NOT NULL,
  scores TEXT NOT NULL,
  is_spike INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL,
  PRIMARY KEY (session_id, bucket_start_ms)
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lecture_ms REAL NOT NULL,
  kind TEXT NOT NULL,
  before_ids TEXT NOT NULL,
  after_ids TEXT NOT NULL,
  bbox TEXT NOT NULL,
  vision TEXT
);
CREATE INDEX IF NOT EXISTS revisions_session ON revisions(session_id, lecture_ms);
CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lecture_ms REAL NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  concept_id TEXT,
  revision_id TEXT,
  window_start_ms REAL,
  evidence TEXT NOT NULL,
  help TEXT,
  check_attempts TEXT NOT NULL DEFAULT '[]',
  resolved_in_session_id TEXT,
  concept_label TEXT,
  resolved_by TEXT,
  resolved_at_iso TEXT,
  reopened_at_iso TEXT,
  repeat_of TEXT
);
CREATE INDEX IF NOT EXISTS timeline_events_session ON timeline_events(session_id, lecture_ms);
CREATE TABLE IF NOT EXISTS lectures (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  media_path TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('audio', 'video')),
  mime TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  transcript TEXT NOT NULL DEFAULT '[]',
  transcript_source TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);
`;

/** Lecture columns without the (potentially large) transcript. */
const LECTURE_COLS = `id, course_id, title, media_path, media_type, mime, duration_ms, transcript_source, created_at,
  json_array_length(transcript) AS word_count`;

/** Marks the async context of a running SqliteDb.transaction (value: the database it belongs to). */
const sqliteTx = new AsyncLocalStorage<SqliteDb>();

class SqliteDb implements Db {
  private db: Database.Database;
  /** Settles when the running transaction ends; null when none is running. */
  txTail: Promise<void> | null = null;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.seedDemoLecture();
  }

  /** The bundled demo lecture is always available (inserted once; never overwritten). */
  private seedDemoLecture() {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO lectures (id, course_id, title, media_path, media_type, mime, duration_ms, transcript,
                                         transcript_source, created_at)
         VALUES (?, ?, ?, ?, 'audio', 'audio/wav', ?, ?, 'demo', ?)`,
      )
      .run(
        DEMO_LECTURE.lectureId,
        DEMO_LECTURE.courseId,
        DEMO_LECTURE.title,
        DEMO_MEDIA_PATH,
        DEMO_LECTURE.durationMs,
        JSON.stringify(demoTranscript),
        "2000-01-01T00:00:00.000Z",
      );
  }

  /** Additive migrations for databases created before a column existed. */
  private migrate() {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(strokes)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    // Partial erase lineage (a stroke cut into pieces keeps its row; pieces point back to it).
    if (!cols.has("split_from")) this.db.exec(`ALTER TABLE strokes ADD COLUMN split_from TEXT`);
    if (!cols.has("replaced_by")) this.db.exec(`ALTER TABLE strokes ADD COLUMN replaced_by TEXT`);

    // Phase 2: analysis bookkeeping on sessions (analysis is stale when ink_version > analyzed_version).
    const sessionCols = new Set(
      (this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!sessionCols.has("ink_version")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ink_version INTEGER NOT NULL DEFAULT 0`);
    }
    if (!sessionCols.has("analyzed_version")) this.db.exec(`ALTER TABLE sessions ADD COLUMN analyzed_version INTEGER`);
    if (!sessionCols.has("analyzed_at_iso")) this.db.exec(`ALTER TABLE sessions ADD COLUMN analyzed_at_iso TEXT`);
    if (!sessionCols.has("analysis_duration_ms")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN analysis_duration_ms REAL`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_student_lecture ON sessions(student_id, lecture_id, created_at_iso)`);

    // Phase 6: concepts and gaps over time on timeline events.
    const eventCols = new Set(
      (this.db.prepare(`PRAGMA table_info(timeline_events)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ["concept_label", "resolved_by", "resolved_at_iso", "reopened_at_iso", "repeat_of"]) {
      if (!eventCols.has(col)) this.db.exec(`ALTER TABLE timeline_events ADD COLUMN ${col} TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS timeline_events_type ON timeline_events(type, status)`);

    // Phase 5: AI results cache (keyed by sha256 of provider|model|kind|input) and AI concept labels.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_cache (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS concept_labels (
        lecture_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (lecture_id, concept_id)
      );
      CREATE INDEX IF NOT EXISTS timeline_events_concept ON timeline_events(concept_id);
    `);

    // Phase 7: Notability PDF imports. History rows are kept; the partial unique index guarantees at
    // most one current import per session.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notability_imports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_name_display TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        page_count INTEGER,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS notability_imports_session ON notability_imports(session_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS notability_imports_current ON notability_imports(session_id) WHERE is_current = 1;
    `);
  }

  /** Last createdAtIso handed out, so sessions created in the same millisecond still order strictly. */
  private lastCreatedMs = 0;

  private bumpInkVersion(sessionId: string) {
    this.db.prepare(`UPDATE sessions SET ink_version = ink_version + 1 WHERE id = ?`).run(sessionId);
  }

  async createSession(input: NewSession) {
    // Strictly increasing start times: "a later session" must be unambiguous (lib/progress).
    // A seeded start time (scripts/seed-demo) is taken as given.
    const createdMs = input.createdAtIso ? Date.parse(input.createdAtIso) : Math.max(Date.now(), this.lastCreatedMs + 1);
    if (!input.createdAtIso) this.lastCreatedMs = createdMs;
    const s: Session = {
      id: input.id ?? newId("s_"),
      studentId: input.studentId ?? LOCAL_STUDENT_ID,
      lectureId: input.lectureId,
      courseId: input.courseId,
      title: input.title?.trim() || `Notes — ${new Date().toLocaleString("en-US")}`,
      createdAtIso: new Date(createdMs).toISOString(),
      inputKind: null,
      hasPressure: false,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, student_id, lecture_id, course_id, title, created_at_iso, input_kind, has_pressure)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
      )
      .run(s.id, s.studentId, s.lectureId, s.courseId, s.title, s.createdAtIso);
    return s;
  }

  async listSessions() {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY created_at_iso DESC`).all() as SessionRow[];
    return rows.map(toSession);
  }

  async getSession(id: string) {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async deleteSession(id: string) {
    return this.db.transaction(() => {
      const files = this.db.prepare(`SELECT stored_name FROM notability_imports WHERE session_id = ?`).all(id) as Array<{
        stored_name: string;
      }>;
      // Every per-session table references sessions ON DELETE CASCADE.
      const res = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
      return { deleted: res.changes > 0, notabilityFiles: files.map((f) => f.stored_name) };
    })();
  }

  async sessionStrokeCounts() {
    return toStrokeCounts(this.db.prepare(SESSION_STROKE_COUNTS_SQL).all() as StrokeCountRow[]);
  }

  async upsertStrokes(sessionId: string, strokes: Stroke[]) {
    if (strokes.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO strokes (id, session_id, start_ms, end_ms, points, pointer_type, bbox, ink_len, median_speed,
                            erased, erased_at_ms, erased_by, is_scribble, split_from, replaced_by)
       VALUES (@id, @session_id, @start_ms, @end_ms, @points, @pointer_type, @bbox, @ink_len, @median_speed,
               @erased, @erased_at_ms, @erased_by, @is_scribble, @split_from, @replaced_by)
       ON CONFLICT(id) DO UPDATE SET
         start_ms = excluded.start_ms, end_ms = excluded.end_ms, points = excluded.points,
         pointer_type = excluded.pointer_type, bbox = excluded.bbox, ink_len = excluded.ink_len,
         median_speed = excluded.median_speed, erased = excluded.erased, erased_at_ms = excluded.erased_at_ms,
         erased_by = excluded.erased_by, is_scribble = excluded.is_scribble,
         -- Lineage is sticky: once cut into pieces a stroke stays replaced even if a stale copy is re-sent.
         split_from = COALESCE(excluded.split_from, strokes.split_from),
         replaced_by = COALESCE(excluded.replaced_by, strokes.replaced_by)
       WHERE strokes.session_id = excluded.session_id`,
    );
    const session = this.db.prepare(`SELECT input_kind, has_pressure FROM sessions WHERE id = ?`).get(sessionId) as
      | Pick<SessionRow, "input_kind" | "has_pressure">
      | undefined;
    const input = sessionInputAfter(
      { kind: (session?.input_kind as PointerKind | null) ?? null, hasPressure: session?.has_pressure === 1 },
      strokes,
    );
    const tx = this.db.transaction((list: Stroke[]) => {
      for (const s of list) {
        stmt.run({
          id: s.id,
          session_id: sessionId,
          start_ms: s.startMs,
          end_ms: s.endMs,
          points: JSON.stringify(s.points),
          pointer_type: s.pointerType,
          bbox: JSON.stringify(s.bbox),
          ink_len: s.inkLen,
          median_speed: s.medianSpeed,
          erased: s.erased ? 1 : 0,
          erased_at_ms: s.erasedAtMs,
          erased_by: s.erasedBy,
          is_scribble: s.isScribble ? 1 : 0,
          split_from: s.splitFrom ?? null,
          replaced_by: s.replacedBy?.length ? JSON.stringify(s.replacedBy) : null,
        });
      }
      this.db
        .prepare(`UPDATE sessions SET input_kind = ?, has_pressure = ? WHERE id = ?`)
        .run(input.kind, input.hasPressure ? 1 : 0, sessionId);
      this.bumpInkVersion(sessionId);
    });
    tx(strokes);
  }

  async addEraseEvents(sessionId: string, events: EraseEvent[]) {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO erase_events (id, session_id, at_ms, stroke_ids, by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET at_ms = excluded.at_ms, stroke_ids = excluded.stroke_ids, by = excluded.by
       WHERE erase_events.session_id = excluded.session_id`,
    );
    const tx = this.db.transaction((list: EraseEvent[]) => {
      for (const e of list) stmt.run(e.id, sessionId, e.atMs, JSON.stringify(e.strokeIds), e.by);
      this.bumpInkVersion(sessionId);
    });
    tx(events);
  }

  async getStrokes(sessionId: string) {
    const rows = this.db
      .prepare(`SELECT * FROM strokes WHERE session_id = ? ORDER BY start_ms, rowid`)
      .all(sessionId) as StrokeRow[];
    return rows.map(toStroke);
  }

  async getEraseEvents(sessionId: string) {
    const rows = this.db
      .prepare(`SELECT * FROM erase_events WHERE session_id = ? ORDER BY at_ms, rowid`)
      .all(sessionId) as EraseRow[];
    return rows.map(toEraseEvent);
  }

  async getInkVersion(sessionId: string) {
    const row = this.db.prepare(`SELECT ink_version FROM sessions WHERE id = ?`).get(sessionId) as
      | Pick<AnalysisStateRow, "ink_version">
      | undefined;
    return row?.ink_version ?? 0;
  }

  async saveAnalysis(sessionId: string, analysis: AnalysisToSave) {
    const prevStmt = this.db.prepare(
      `SELECT id, type, status, help, check_attempts, resolved_in_session_id, resolved_by, resolved_at_iso, reopened_at_iso,
              repeat_of
       FROM timeline_events WHERE session_id = ?`,
    );
    const clearStmts = ["confusion_windows", "revisions", "timeline_events"].map((table) =>
      this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`),
    );
    const insertWindow = this.db.prepare(
      `INSERT INTO confusion_windows (session_id, bucket_start_ms, features, scores, is_spike, reasons)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertRevision = this.db.prepare(
      `INSERT INTO revisions (id, session_id, lecture_ms, kind, before_ids, after_ids, bbox, vision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = this.db.prepare(
      `INSERT INTO timeline_events (id, session_id, lecture_ms, type, status, concept_id, revision_id, window_start_ms,
                                    evidence, help, check_attempts, resolved_in_session_id, concept_label, resolved_by,
                                    resolved_at_iso, reopened_at_iso, repeat_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((): TimelineEvent[] => {
      const prev = new Map((prevStmt.all(sessionId) as PrevEventRow[]).map((r) => [r.id, r]));
      // Analysis rows are derived data: replace this session's rows wholesale (idempotent re-runs).
      for (const stmt of clearStmts) stmt.run(sessionId);

      for (const w of analysis.windows) {
        insertWindow.run(
          sessionId,
          w.bucketStartMs,
          JSON.stringify({ pause: w.pause, slowdown: w.slowdown, erase: w.erase, pressure: w.pressure, phase: w.phase }),
          JSON.stringify({ rawScore: w.rawScore, emaScore: w.emaScore }),
          w.isSpike ? 1 : 0,
          JSON.stringify(w.reasons),
        );
      }
      for (const r of analysis.revisions) {
        insertRevision.run(
          r.id,
          sessionId,
          r.lectureMs,
          r.kind,
          JSON.stringify(r.beforeStrokeIds),
          JSON.stringify(r.afterStrokeIds),
          JSON.stringify(r.bbox),
          r.vision ? JSON.stringify(r.vision) : null,
        );
      }

      const stored: TimelineEvent[] = [];
      const insertedIds = new Set<string>();
      for (const fresh of analysis.events) {
        // Ids are unique by construction (lib/classify); never let a repeat abort the whole analysis.
        if (insertedIds.has(fresh.id)) {
          console.warn(`saveAnalysis(${sessionId}): skipped a repeated event id ${fresh.id}`);
          continue;
        }
        insertedIds.add(fresh.id);
        // Same deterministic id = same moment: keep what the student has already done with it.
        const e = carryForward(fresh, sessionId, prev.get(fresh.id));
        insertEvent.run(
          e.id,
          sessionId,
          e.lectureMs,
          e.type,
          e.status,
          e.conceptId,
          e.revisionId ?? null,
          e.windowStartMs ?? null,
          JSON.stringify(e.evidence),
          e.help ? JSON.stringify(e.help) : null,
          JSON.stringify(e.checkAttempts),
          e.resolvedInSessionId ?? null,
          e.conceptLabel ?? null,
          e.resolvedBy ?? null,
          e.resolvedAtIso ?? null,
          e.reopenedAtIso ?? null,
          e.repeatOf ?? null,
        );
        stored.push(e);
      }

      this.db
        .prepare(`UPDATE sessions SET analyzed_version = ?, analyzed_at_iso = ?, analysis_duration_ms = ? WHERE id = ?`)
        .run(analysis.inkVersion, new Date().toISOString(), analysis.durationMs, sessionId);
      return stored;
    });
    return tx();
  }

  private updateEventStmt() {
    return this.db.prepare(
      `UPDATE timeline_events SET type = ?, status = ?, help = ?, check_attempts = ?, resolved_in_session_id = ?,
                                  resolved_by = ?, resolved_at_iso = ?, reopened_at_iso = ?, repeat_of = ?
       WHERE id = ? AND session_id = ?`,
    );
  }

  private runUpdateEvent(stmt: Database.Statement, event: TimelineEvent) {
    stmt.run(
      event.type,
      event.status,
      event.help ? JSON.stringify(event.help) : null,
      JSON.stringify(event.checkAttempts),
      event.resolvedInSessionId ?? null,
      event.resolvedBy ?? null,
      event.resolvedAtIso ?? null,
      event.reopenedAtIso ?? null,
      event.repeatOf ?? null,
      event.id,
      event.sessionId,
    );
  }

  async updateEvent(event: TimelineEvent) {
    this.runUpdateEvent(this.updateEventStmt(), event);
  }

  async updateEvents(events: TimelineEvent[]) {
    if (events.length === 0) return;
    const stmt = this.updateEventStmt();
    this.db.transaction((list: TimelineEvent[]) => {
      for (const e of list) this.runUpdateEvent(stmt, e);
    })(events);
  }

  async getEvent(id: string) {
    const row = this.db.prepare(`SELECT * FROM timeline_events WHERE id = ?`).get(id) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  async listStudentSessions(studentId: string, lectureId?: string) {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE student_id = ? AND (? IS NULL OR lecture_id = ?) ORDER BY created_at_iso, id`,
      )
      .all(studentId, lectureId ?? null, lectureId ?? null) as Array<SessionRow & { analyzed_version: number | null }>;
    return rows.map((r) => ({ ...toSession(r), analyzed: r.analyzed_version != null }));
  }

  async listGaps(studentId: string, lectureId?: string) {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM timeline_events e JOIN sessions s ON s.id = e.session_id
         WHERE e.type = 'unresolved_gap' AND s.student_id = ? AND (? IS NULL OR s.lecture_id = ?)
         ORDER BY s.created_at_iso, e.lecture_ms, e.id`,
      )
      .all(studentId, lectureId ?? null, lectureId ?? null) as EventRow[];
    return rows.map(toEvent);
  }

  async setEventHelp(eventId: string, help: HelpCard | null) {
    this.db.prepare(`UPDATE timeline_events SET help = ? WHERE id = ?`).run(help ? JSON.stringify(help) : null, eventId);
  }

  async getRevision(id: string) {
    const row = this.db.prepare(`SELECT * FROM revisions WHERE id = ?`).get(id) as RevisionRow | undefined;
    return row ? toRevision(row) : null;
  }

  async setRevisionVision(id: string, vision: RevisionReading) {
    this.db.prepare(`UPDATE revisions SET vision = ? WHERE id = ?`).run(JSON.stringify(vision), id);
  }

  async getAiCache(key: string): Promise<AiCacheEntry | null> {
    const row = this.db.prepare(`SELECT * FROM ai_cache WHERE key = ?`).get(key) as AiCacheRow | undefined;
    return row ? toAiCacheEntry(row) : null;
  }

  async putAiCache(entry: Omit<AiCacheEntry, "createdAtIso">) {
    this.db
      .prepare(
        `INSERT INTO ai_cache (key, kind, provider, model, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
      )
      .run(entry.key, entry.kind, entry.provider, entry.model, JSON.stringify(entry.value), new Date().toISOString());
  }

  async getConceptLabels(lectureId: string) {
    const rows = this.db.prepare(`SELECT concept_id, label FROM concept_labels WHERE lecture_id = ?`).all(lectureId) as Array<{
      concept_id: string;
      label: string;
    }>;
    return new Map(rows.map((r) => [r.concept_id, r.label]));
  }

  async setConceptLabel(lectureId: string, conceptId: string, label: string) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO concept_labels (lecture_id, concept_id, label, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(lecture_id, concept_id) DO UPDATE SET label = excluded.label`,
        )
        .run(lectureId, conceptId, label, new Date().toISOString());
      this.db.prepare(`UPDATE timeline_events SET concept_label = ? WHERE concept_id = ?`).run(label, conceptId);
    })();
  }

  async createLecture(input: NewLecture) {
    const id = input.id ?? newId("l_");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lectures (id, course_id, title, media_path, media_type, mime, duration_ms, transcript,
                               transcript_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.courseId,
        input.title,
        input.mediaPath,
        input.mediaType,
        input.mime,
        input.durationMs,
        JSON.stringify(input.words),
        input.transcriptSource,
        createdAt,
      );
    return this.readLecture(id)!.lecture;
  }

  async listLectures() {
    const rows = this.db
      .prepare(`SELECT ${LECTURE_COLS} FROM lectures ORDER BY (transcript_source = 'demo') DESC, created_at DESC, id`)
      .all() as LectureRow[];
    return rows.map(toLecture);
  }

  private readLecture(id: string): LectureRecord | null {
    const row = this.db.prepare(`SELECT ${LECTURE_COLS}, transcript FROM lectures WHERE id = ?`).get(id) as
      | (LectureRow & { transcript: string })
      | undefined;
    if (!row) return null;
    return { lecture: toLecture(row), words: JSON.parse(row.transcript) as TranscriptWord[], mediaPath: row.media_path };
  }

  async getLecture(id: string): Promise<LectureRecord | null> {
    return this.readLecture(id);
  }

  async setLectureTranscript(id: string, words: TranscriptWord[], source: TranscriptSource) {
    const res = this.db
      .prepare(`UPDATE lectures SET transcript = ?, transcript_source = ? WHERE id = ?`)
      .run(JSON.stringify(words), source, id);
    if (res.changes === 0) return null;
    return this.readLecture(id)!.lecture;
  }

  async addNotabilityImport(input: NewNotabilityImport) {
    const id = newId("n_");
    // Strictly increasing within a session so "newest first" is unambiguous.
    const last = this.db
      .prepare(`SELECT MAX(created_at) AS at FROM notability_imports WHERE session_id = ?`)
      .get(input.sessionId) as { at: string | null };
    const createdMs = Math.max(Date.now(), last.at ? Date.parse(last.at) + 1 : 0);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE notability_imports SET is_current = 0 WHERE session_id = ? AND is_current = 1`).run(input.sessionId);
      this.db
        .prepare(
          `INSERT INTO notability_imports (id, session_id, file_name_display, stored_name, page_count, size, created_at, is_current)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(id, input.sessionId, input.fileName, input.storedName, input.pageCount, input.size, new Date(createdMs).toISOString());
    })();
    const row = this.db.prepare(`SELECT * FROM notability_imports WHERE id = ?`).get(id) as NotabilityRow;
    return toNotabilityImport(row);
  }

  async getNotabilityImport(sessionId: string): Promise<NotabilityImportRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM notability_imports WHERE session_id = ? AND is_current = 1`)
      .get(sessionId) as NotabilityRow | undefined;
    return row ? { import: toNotabilityImport(row), storedName: row.stored_name } : null;
  }

  async listNotabilityImports(sessionId: string) {
    const rows = this.db
      .prepare(`SELECT * FROM notability_imports WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(sessionId) as NotabilityRow[];
    return rows.map(toNotabilityImport);
  }

  async getAnalysis(sessionId: string): Promise<StoredAnalysis | null> {
    const state = this.db
      .prepare(`SELECT ink_version, analyzed_version, analyzed_at_iso, analysis_duration_ms FROM sessions WHERE id = ?`)
      .get(sessionId) as AnalysisStateRow | undefined;
    if (!state || state.analyzed_version == null || !state.analyzed_at_iso) return null;
    const windows = this.db
      .prepare(`SELECT * FROM confusion_windows WHERE session_id = ? ORDER BY bucket_start_ms`)
      .all(sessionId) as WindowRow[];
    const revisions = this.db
      .prepare(`SELECT * FROM revisions WHERE session_id = ? ORDER BY lecture_ms, id`)
      .all(sessionId) as RevisionRow[];
    const events = this.db
      .prepare(`SELECT * FROM timeline_events WHERE session_id = ? ORDER BY lecture_ms, id`)
      .all(sessionId) as EventRow[];
    return {
      durationMs: state.analysis_duration_ms ?? 0,
      windows: windows.map(toWindow),
      revisions: revisions.map(toRevision),
      events: events.map(toEvent),
      analyzedAtIso: state.analyzed_at_iso,
      stale: state.ink_version > state.analyzed_version,
    };
  }

  // SQLite has no percentile aggregate: the statistics use the TypeScript reference over the rows.
  async inkWindowStats(sessionId: string, windowMs: number) {
    return computeInkWindowStats(await this.getStrokes(sessionId), windowMs);
  }

  async lectureInkHotspots(lectureId: string) {
    const rows = this.db
      .prepare(
        `SELECT st.* FROM strokes st JOIN sessions s ON s.id = st.session_id
         WHERE s.lecture_id = ? ORDER BY st.start_ms, st.rowid`,
      )
      .all(lectureId) as StrokeRow[];
    return computeInkHotspots(rows.map(toStroke));
  }

  /**
   * better-sqlite3 transactions are synchronous, but `fn` spans awaits: BEGIN/COMMIT are issued by
   * hand and, while `fn` runs, calls from any other async context wait (see gateSqlite) so they
   * can't slip into — or be rolled back with — this transaction. Inner db.transaction() calls
   * become savepoints (better-sqlite3 nests automatically).
   */
  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const self = this.gated ?? this;
    if (sqliteTx.getStore() === this) return fn(self);
    // Check-and-claim with no await in between, so two waiters can't both start.
    while (this.txTail) await this.txTail;
    let release!: () => void;
    this.txTail = new Promise<void>((r) => (release = r));
    try {
      this.db.exec("BEGIN");
      try {
        const result = await sqliteTx.run(this, () => fn(self));
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      this.txTail = null;
      release();
    }
  }

  async info(): Promise<DbInfo> {
    return { backend: "sqlite", timescale: false };
  }

  async close() {
    this.db.close();
  }

  /** The gated proxy handed out by openDb (what `fn` receives in transaction). */
  gated: Db | null = null;
}

/**
 * Wraps a SqliteDb so every call from outside a running transaction waits for it to finish. The
 * wait loop and the (synchronous) better-sqlite3 body run without an await in between, so a
 * transaction can't begin in the gap.
 */
function gateSqlite(db: SqliteDb): Db {
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || prop === "constructor") return value;
      const method = value as (...args: unknown[]) => unknown;
      // transaction does its own waiting (and must see the raw instance as `this`).
      if (prop === "transaction") return method.bind(target);
      return async (...args: unknown[]) => {
        while (target.txTail && sqliteTx.getStore() !== target) await target.txTail;
        return method.apply(target, args);
      };
    },
  }) as unknown as Db;
  db.gated = proxy;
  return proxy;
}

/** Opens (creating or migrating) a database file. The app uses getDb(); tests use this directly. */
export function openDb(file: string): Db {
  return gateSqlite(new SqliteDb(file));
}

// Singleton across Next dev hot reloads.
const g = globalThis as unknown as { __inklingDb?: Db };

/**
 * The app's repository. DATABASE_URL (postgres:// — e.g. a Tiger Data / Timescale Cloud service)
 * selects Postgres; without it, the local SQLite file (INKLING_DB_PATH, default data/inkling.db).
 */
export function getDb(): Db {
  if (!g.__inklingDb) {
    const url = process.env.DATABASE_URL?.trim();
    if (url) {
      g.__inklingDb = openPostgresDb(url);
    } else {
      const file = resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.INKLING_DB_PATH || "data/inkling.db");
      g.__inklingDb = openDb(file);
    }
  }
  return g.__inklingDb;
}
