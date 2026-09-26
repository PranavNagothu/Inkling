import "server-only";

// Postgres repository (Tiger Data / Timescale Cloud in production, PGlite in tests): the same Db
// contract as the SQLite one in ./db, on the same logical schema translated to Postgres types
// (JSONB, TIMESTAMPTZ, BOOLEAN, identity columns), with versioned migrations in schema_migrations.
//
// Ink time series: every live stroke also gets one summary row in `ink_samples` (per stroke, not
// per point: a stroke's points are already stored as JSONB, and one row with its speed, mean
// pressure and ink length keeps the series ~100x smaller while carrying everything the window
// statistics need). Its time column is `lecture_ts` = 2000-01-01T00:00Z + the stroke's lecture ms,
// so lecture time is a real timestamp axis. When the TimescaleDB extension is available,
// ink_samples becomes a hypertable, per-window statistics use time_bucket, and class-wide hotspots
// come from a continuous aggregate. Without it (plain Postgres, PGlite) the same queries run with
// date_bin on the plain table — identical results.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import type { Pool, PoolClient, CustomTypesConfig } from "pg";
import demoTranscript from "@/public/demo/lecture.transcript.json";
import { newId } from "./ink";
import { DEMO_LECTURE, DEMO_MEDIA_PATH } from "./demo";
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
import {
  HOTSPOT_BUCKET_MS,
  LOCAL_STUDENT_ID,
  SESSION_STROKE_COUNTS_SQL,
  assertStatsWindowMs,
  carryForward,
  toStrokeCounts,
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
  type InkHotspot,
  type InkWindowStat,
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

// ── Drivers ─────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export interface SqlRunner {
  query<R = Row>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
  /** Runs one or more statements without parameters. */
  exec(text: string): Promise<void>;
}

export interface SqlDriver extends SqlRunner {
  readonly kind: "pg" | "pglite";
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const JSON_OID = 114;
const JSONB_OID = 3802;
/** JSON columns come back as their text (the shared row mappers parse them, as with SQLite). */
const rawJson = (value: string) => value;

export interface PgConnectionOptions {
  /** The URL without sslmode (applied through `ssl`). Never logged. */
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean };
}

const MANAGED_TIMESCALE_HOST = /\.(tsdb\.cloud\.timescale\.com|timescale\.com)$/i;

/**
 * Whether the server is on this machine: a unix socket (a host starting with "/", URL-encoded or as
 * libpq's ?host=), no host at all (libpq's default socket), localhost, 127.0.0.0/8 or ::1. Several
 * hosts (h1,h2) are loopback only if every one of them is.
 */
function isLoopbackHost(parsed: URL): boolean {
  let hostname = parsed.hostname;
  try {
    hostname = decodeURIComponent(hostname);
  } catch {
    // not percent-encoded after all: compare it as written
  }
  const hosts = (parsed.searchParams.get("host") || hostname).split(",");
  return hosts.every((raw) => {
    const host = raw.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return (
      host === "" ||
      host.startsWith("/") ||
      host === "localhost" ||
      host === "::1" ||
      /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)
    );
  });
}

/**
 * Connection options for a postgres:// URL. sslmode follows libpq: disable → plain; require →
 * encrypted without certificate verification; verify-ca / verify-full → encrypted and verified.
 * Without sslmode (or with prefer / allow) the connection is encrypted (like `require`) unless the
 * server is on this machine (isLoopbackHost: unix socket, localhost, 127.0.0.0/8, ::1), so a
 * remote database never gets the password or the students' notes in plaintext by default; use
 * sslmode=disable for a remote server without TLS. Tiger Cloud (…tsdb.cloud.timescale.com) is
 * always remote and only accepts TLS. Errors never echo the URL (it carries the password).
 */
export function pgConnectionOptions(url: string): PgConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL (expected postgres://user:password@host:port/database).");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://.");
  }
  const mode = parsed.searchParams.get("sslmode")?.toLowerCase() ?? null;
  parsed.searchParams.delete("sslmode");
  let ssl: PgConnectionOptions["ssl"];
  switch (mode) {
    case "disable":
      ssl = false;
      break;
    case "verify-ca":
    case "verify-full":
      ssl = { rejectUnauthorized: true };
      break;
    case "require":
    case "no-verify":
      ssl = { rejectUnauthorized: false };
      break;
    case null:
    case "prefer":
    case "allow":
      ssl =
        MANAGED_TIMESCALE_HOST.test(parsed.hostname) || !isLoopbackHost(parsed) ? { rejectUnauthorized: false } : false;
      break;
    default:
      throw new Error("DATABASE_URL has an unsupported sslmode (use disable, require, verify-ca or verify-full).");
  }
  return { connectionString: parsed.toString(), ssl };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function pgDriver(options: PgConnectionOptions): Promise<SqlDriver> {
  const pg = (await import("pg")).default;
  const getTypeParser = ((oid: number, format?: string) =>
    oid === JSON_OID || oid === JSONB_OID
      ? rawJson
      : pg.types.getTypeParser(oid, format as "text")) as CustomTypesConfig["getTypeParser"];
  const pool: Pool = new pg.Pool({
    connectionString: options.connectionString,
    ssl: options.ssl,
    max: positiveInt(process.env.PG_POOL_MAX, 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: "inkling",
    types: { getTypeParser },
  });
  // An idle client dropped by the server must not crash the process (the pool replaces it).
  pool.on("error", (err) => console.error(`[inkling] postgres: idle connection error: ${err.message}`));
  const runnerOf = (client: Pool | PoolClient): SqlRunner => ({
    async query<R>(text: string, params: unknown[] = []) {
      const res = await client.query(text, params);
      return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
    },
    async exec(text: string) {
      await client.query(text);
    },
  });
  return {
    kind: "pg",
    ...runnerOf(pool),
    async transaction<T>(fn: (tx: SqlRunner) => Promise<T>) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const result = await fn(runnerOf(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          broken = rollbackErr as Error; // don't return a connection in an unknown state
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/** Runs tasks one at a time (PGlite's transaction handle must not interleave queries). */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
}

/** Embedded WASM Postgres (devDependency): tests, and DATABASE_URL=pglite:… for local runs. */
async function pgliteDriver(dataDir: string | undefined): Promise<SqlDriver> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  const db = await PGlite.create({ dataDir, parsers: { [types.JSON]: rawJson, [types.JSONB]: rawJson } });
  type Q = Pick<InstanceType<typeof PGlite>, "query" | "exec">;
  const runnerOf = (q: Q, run: ReturnType<typeof serial> = (t) => t()): SqlRunner => ({
    query<R>(text: string, params: unknown[] = []) {
      return run(async () => {
        const res = await q.query<R>(text, params);
        return { rows: res.rows, rowCount: res.affectedRows ?? 0 };
      });
    },
    exec(text: string) {
      return run(async () => {
        await q.exec(text);
      });
    },
  });
  return {
    kind: "pglite",
    ...runnerOf(db),
    transaction: (fn) => db.transaction((tx) => fn(runnerOf(tx, serial()))),
    close: () => db.close(),
  };
}

// ── Migrations ──────────────────────────────────────────────────────────────────────────────

/** pg_advisory_xact_lock key: one migrator at a time across app instances. */
const MIGRATION_LOCK = 7_310_422;

/**
 * Forward-only, append-only: never edit a migration that has shipped — add the next version.
 * Column names match the SQLite schema so both backends share the row mappers.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  lecture_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at_iso TIMESTAMPTZ NOT NULL,
  input_kind TEXT,
  has_pressure BOOLEAN NOT NULL DEFAULT FALSE,
  ink_version INTEGER NOT NULL DEFAULT 0,
  analyzed_version INTEGER,
  analyzed_at_iso TIMESTAMPTZ,
  analysis_duration_ms DOUBLE PRECISION
);
CREATE INDEX sessions_student_lecture ON sessions (student_id, lecture_id, created_at_iso);
CREATE INDEX sessions_created ON sessions (created_at_iso);

CREATE TABLE strokes (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  start_ms DOUBLE PRECISION NOT NULL,
  end_ms DOUBLE PRECISION NOT NULL,
  points JSONB NOT NULL,
  pointer_type TEXT NOT NULL,
  bbox JSONB NOT NULL,
  ink_len DOUBLE PRECISION NOT NULL,
  median_speed DOUBLE PRECISION NOT NULL,
  erased BOOLEAN NOT NULL DEFAULT FALSE,
  erased_at_ms DOUBLE PRECISION,
  erased_by TEXT,
  is_scribble BOOLEAN NOT NULL DEFAULT FALSE,
  split_from TEXT,
  replaced_by JSONB
);
CREATE INDEX strokes_session ON strokes (session_id, start_ms, seq);

CREATE TABLE erase_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  at_ms DOUBLE PRECISION NOT NULL,
  stroke_ids JSONB NOT NULL,
  "by" TEXT NOT NULL
);
CREATE INDEX erase_events_session ON erase_events (session_id, at_ms, seq);

CREATE TABLE confusion_windows (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  bucket_start_ms DOUBLE PRECISION NOT NULL,
  features JSONB NOT NULL,
  scores JSONB NOT NULL,
  is_spike BOOLEAN NOT NULL DEFAULT FALSE,
  reasons JSONB NOT NULL,
  PRIMARY KEY (session_id, bucket_start_ms)
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  lecture_ms DOUBLE PRECISION NOT NULL,
  kind TEXT NOT NULL,
  before_ids JSONB NOT NULL,
  after_ids JSONB NOT NULL,
  bbox JSONB NOT NULL,
  vision JSONB
);
CREATE INDEX revisions_session ON revisions (session_id, lecture_ms);

CREATE TABLE timeline_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  lecture_ms DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  concept_id TEXT,
  revision_id TEXT,
  window_start_ms DOUBLE PRECISION,
  evidence JSONB NOT NULL,
  help JSONB,
  check_attempts JSONB NOT NULL DEFAULT '[]',
  resolved_in_session_id TEXT,
  concept_label TEXT,
  resolved_by TEXT,
  -- Caller-supplied ISO strings, kept verbatim (a TIMESTAMPTZ round trip could re-format them).
  resolved_at_iso TEXT,
  reopened_at_iso TEXT,
  repeat_of TEXT
);
CREATE INDEX timeline_events_session ON timeline_events (session_id, lecture_ms);
CREATE INDEX timeline_events_type ON timeline_events (type, status);
CREATE INDEX timeline_events_concept ON timeline_events (concept_id);

CREATE TABLE lectures (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  media_path TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('audio', 'video')),
  mime TEXT NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL,
  transcript JSONB NOT NULL DEFAULT '[]',
  transcript_source TEXT NOT NULL DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE concept_labels (
  lecture_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (lecture_id, concept_id)
);

CREATE TABLE notability_imports (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  file_name_display TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  page_count INTEGER,
  size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX notability_imports_session ON notability_imports (session_id, created_at);
-- At most one current import per session; replaced ones stay as history.
CREATE UNIQUE INDEX notability_imports_current ON notability_imports (session_id) WHERE is_current;

-- One summary row per live stroke (see the header comment). A hypertable on TimescaleDB.
CREATE TABLE ink_samples (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  lecture_id TEXT NOT NULL,
  lecture_ts TIMESTAMPTZ NOT NULL,
  stroke_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  speed DOUBLE PRECISION NOT NULL,
  pressure DOUBLE PRECISION,
  ink_len DOUBLE PRECISION NOT NULL,
  erased BOOLEAN NOT NULL
);
CREATE INDEX ink_samples_session ON ink_samples (session_id, lecture_ts);
CREATE INDEX ink_samples_stroke ON ink_samples (session_id, stroke_id);
CREATE INDEX ink_samples_lecture ON ink_samples (lecture_id, lecture_ts);
`,
  },
  {
    // Undone strokes (erasedBy 'undo') were taken back, not erased: ink_samples leaves them out
    // (see inkSamples in ./dbShared). Drops the rows older builds wrote for them.
    version: 2,
    name: "ink_samples without undone strokes",
    sql: `
DELETE FROM ink_samples i USING strokes st
WHERE st.session_id = i.session_id AND st.id = i.stroke_id
  AND st.erased AND COALESCE(st.erased_by, '') = 'undo';
`,
  },
];

/** Applies pending migrations in one transaction, under an advisory lock (idempotent). */
export async function migrate(driver: SqlDriver): Promise<number[]> {
  return driver.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATION_LOCK]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Set(
      (await tx.query<{ version: number }>(`SELECT version FROM schema_migrations`)).rows.map((r) => Number(r.version)),
    );
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await tx.exec(m.sql);
      await tx.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
      applied.push(m.version);
    }
    return applied;
  });
}

// ── Timescale ───────────────────────────────────────────────────────────────────────────────

/** Lecture time 0 on the ink_samples time axis. */
export const LECTURE_EPOCH_ISO = "2000-01-01T00:00:00.000Z";
const HOTSPOTS_VIEW = "ink_lecture_hotspots";

const logged = new Set<string>();
function logOnce(message: string) {
  if (logged.has(message)) return;
  logged.add(message);
  console.info(`[inkling] ${message}`);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Rows ────────────────────────────────────────────────────────────────────────────────────

/** Postgres → the shared (SQLite-convention) row shape: timestamps as ISO strings, booleans as 0/1. */
function normaliseRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : typeof value === "boolean" ? (value ? 1 : 0) : value;
  }
  return out;
}

/**
 * Last occurrence of each key wins, at the position of its first occurrence — what a sequence of
 * single-row statements would leave (one set-based statement can't touch a row twice).
 */
function lastByKey<T>(list: T[], key: (item: T) => string, merge: (prev: T, next: T) => T = (_p, n) => n): T[] {
  const byKey = new Map<string, T>();
  for (const item of list) {
    const k = key(item);
    const prev = byKey.get(k);
    byKey.set(k, prev ? merge(prev, item) : item);
  }
  return [...byKey.values()];
}
const byId = (item: { id: string }) => item.id;

/** Rows of a JSON array parameter, in array order: FROM ${recordsFrom("$2", "id text, …")}. */
const recordsFrom = (param: string, columns: string) =>
  `jsonb_array_elements(${param}::jsonb) WITH ORDINALITY AS e(r, ord), jsonb_to_record(e.r) AS x(${columns})`;

const ID_ORDER = `COLLATE "C"`; // byte order, as SQLite compares text

// ── Repository ──────────────────────────────────────────────────────────────────────────────

interface TxScope {
  owner: PostgresDb;
  runner: SqlRunner;
}
/** The running transaction of this async context (Db calls inside transaction(fn) join it). */
const pgTx = new AsyncLocalStorage<TxScope>();

export class PostgresDb implements Db {
  private ready: Promise<SqlDriver> | null = null;
  private closed = false;
  private timescale = false;
  private hotspotsAggregate = false;
  /** Last createdAtIso handed out, so sessions created in the same millisecond still order strictly. */
  private lastCreatedMs = 0;

  constructor(private readonly connect: () => Promise<SqlDriver>) {}

  /** Connects, migrates, sets up Timescale and seeds the demo lecture once (retried after a failure). */
  private start(): Promise<SqlDriver> {
    if (this.closed) return Promise.reject(new Error("database is closed"));
    this.ready ??= this.init().catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async init(): Promise<SqlDriver> {
    const driver = await this.connect();
    try {
      await migrate(driver);
      await this.setupTimescale(driver);
      await driver.query(
        `INSERT INTO lectures (id, course_id, title, media_path, media_type, mime, duration_ms, transcript,
                               transcript_source, created_at)
         VALUES ($1, $2, $3, $4, 'audio', 'audio/wav', $5, $6::jsonb, 'demo', $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          DEMO_LECTURE.lectureId,
          DEMO_LECTURE.courseId,
          DEMO_LECTURE.title,
          DEMO_MEDIA_PATH,
          DEMO_LECTURE.durationMs,
          JSON.stringify(demoTranscript),
          "2000-01-01T00:00:00.000Z",
        ],
      );
    } catch (err) {
      await driver.close().catch(() => {});
      throw err;
    }
    return driver;
  }

  /**
   * TimescaleDB, when the server has it: ink_samples → hypertable (1-hour chunks of lecture time),
   * plus a real-time continuous aggregate of class-wide ink per 30 s with a 1-minute refresh
   * policy. Each step is idempotent and optional: anything unavailable is logged once and the
   * plain-Postgres queries are used instead.
   */
  private async setupTimescale(driver: SqlDriver) {
    this.timescale = false;
    this.hotspotsAggregate = false;
    const installed = await driver.query(`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`);
    if (installed.rows.length === 0) {
      const available = await driver.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'`);
      if (available.rows.length === 0) {
        logOnce("TimescaleDB is not available on this server; ink statistics use plain Postgres (date_bin).");
        return;
      }
      try {
        await driver.exec(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
      } catch (err) {
        logOnce(`TimescaleDB could not be enabled (${errorText(err)}); ink statistics use plain Postgres (date_bin).`);
        return;
      }
    }
    try {
      await driver.query(
        `SELECT create_hypertable('ink_samples', by_range('lecture_ts', INTERVAL '1 hour'),
                                  if_not_exists => TRUE, migrate_data => TRUE)`,
      );
    } catch (err) {
      logOnce(`ink_samples could not become a hypertable (${errorText(err)}); using plain Postgres (date_bin).`);
      return;
    }
    this.timescale = true;
    try {
      // 30 s buckets: the default time_bucket origin (2000-01-03) is 2 days from the lecture epoch,
      // a whole number of buckets, so these align with date_bin(…, epoch) and HOTSPOT_BUCKET_MS.
      await driver.exec(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${HOTSPOTS_VIEW}
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT lecture_id,
               time_bucket(INTERVAL '30 seconds', lecture_ts) AS bucket,
               count(*) AS strokes,
               sum(CASE WHEN erased THEN 1 ELSE 0 END) AS erased,
               sum(ink_len) AS ink_len
        FROM ink_samples
        GROUP BY lecture_id, time_bucket(INTERVAL '30 seconds', lecture_ts)
        WITH NO DATA`);
      this.hotspotsAggregate = true;
      await driver.query(
        `SELECT add_continuous_aggregate_policy('${HOTSPOTS_VIEW}', start_offset => NULL, end_offset => NULL,
                                                schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)`,
      );
    } catch (err) {
      logOnce(`Timescale continuous aggregate unavailable (${errorText(err)}); hotspots query the hypertable directly.`);
    }
  }

  /** The runner of this context's transaction, else the pool. */
  private async runner(): Promise<SqlRunner> {
    const scope = pgTx.getStore();
    if (scope?.owner === this) return scope.runner;
    return this.start();
  }

  private async rows<R>(text: string, params: unknown[] = []): Promise<R[]> {
    const res = await (await this.runner()).query<Row>(text, params);
    return res.rows.map(normaliseRow) as R[];
  }

  private async one<R>(text: string, params: unknown[] = []): Promise<R | undefined> {
    return (await this.rows<R>(text, params))[0];
  }

  private async run(text: string, params: unknown[] = []): Promise<number> {
    return (await (await this.runner()).query(text, params)).rowCount;
  }

  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (pgTx.getStore()?.owner === this) return fn(this);
    const driver = await this.start();
    return driver.transaction((runner) => pgTx.run({ owner: this, runner }, () => fn(this)));
  }

  async info(): Promise<DbInfo> {
    await this.start();
    return { backend: "postgres", timescale: this.timescale };
  }

  async close() {
    const pending = this.ready;
    this.closed = true;
    this.ready = null;
    const driver = pending ? await pending.catch(() => null) : null;
    await driver?.close();
  }

  /** Refreshes the hotspot continuous aggregate now (Timescale only; tests and demos). */
  async refreshInkAggregates(): Promise<void> {
    const driver = await this.start();
    if (this.hotspotsAggregate) await driver.exec(`CALL refresh_continuous_aggregate('${HOTSPOTS_VIEW}', NULL, NULL)`);
  }

  private bumpInkVersion(sessionId: string) {
    return this.run(`UPDATE sessions SET ink_version = ink_version + 1 WHERE id = $1`, [sessionId]);
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
    await this.run(
      `INSERT INTO sessions (id, student_id, lecture_id, course_id, title, created_at_iso, input_kind, has_pressure)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, FALSE)`,
      [s.id, s.studentId, s.lectureId, s.courseId, s.title, s.createdAtIso],
    );
    return s;
  }

  async listSessions() {
    return (await this.rows<SessionRow>(`SELECT * FROM sessions ORDER BY created_at_iso DESC`)).map(toSession);
  }

  async getSession(id: string) {
    const row = await this.one<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
    return row ? toSession(row) : null;
  }

  async deleteSession(id: string) {
    return this.transaction(async () => {
      const files = await this.rows<{ stored_name: string }>(`SELECT stored_name FROM notability_imports WHERE session_id = $1`, [id]);
      // Every per-session table (ink_samples too) references sessions ON DELETE CASCADE.
      const deleted = await this.run(`DELETE FROM sessions WHERE id = $1`, [id]);
      return { deleted: deleted > 0, notabilityFiles: files.map((f) => f.stored_name) };
    });
  }

  async sessionStrokeCounts() {
    return toStrokeCounts(await this.rows<StrokeCountRow>(SESSION_STROKE_COUNTS_SQL));
  }

  async upsertStrokes(sessionId: string, strokes: Stroke[]) {
    if (strokes.length === 0) return;
    const records = lastByKey(strokes, byId, (prev, next) => ({
      ...next,
      // Lineage is sticky within a batch too (see the ON CONFLICT clause).
      splitFrom: next.splitFrom ?? prev.splitFrom ?? null,
      replacedBy: next.replacedBy?.length ? next.replacedBy : prev.replacedBy,
    })).map((s) => ({
      id: s.id,
      start_ms: s.startMs,
      end_ms: s.endMs,
      points: s.points,
      pointer_type: s.pointerType,
      bbox: s.bbox,
      ink_len: s.inkLen,
      median_speed: s.medianSpeed,
      erased: s.erased,
      erased_at_ms: s.erasedAtMs,
      erased_by: s.erasedBy,
      is_scribble: s.isScribble,
      split_from: s.splitFrom ?? null,
      replaced_by: s.replacedBy?.length ? s.replacedBy : null,
    }));
    const ids = JSON.stringify(records.map((r) => r.id));
    await this.transaction(async () => {
      // Row lock: concurrent batches of one session read and write its input kind in turn.
      const session = await this.one<Pick<SessionRow, "input_kind" | "has_pressure">>(
        `SELECT input_kind, has_pressure FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const input = sessionInputAfter(
        { kind: (session?.input_kind as PointerKind | null) ?? null, hasPressure: session?.has_pressure === 1 },
        strokes,
      );
      await this.run(
        `INSERT INTO strokes (id, session_id, start_ms, end_ms, points, pointer_type, bbox, ink_len, median_speed,
                              erased, erased_at_ms, erased_by, is_scribble, split_from, replaced_by)
         SELECT x.id, $1, x.start_ms, x.end_ms, x.points, x.pointer_type, x.bbox, x.ink_len, x.median_speed,
                x.erased, x.erased_at_ms, x.erased_by, x.is_scribble, x.split_from, x.replaced_by
         FROM ${recordsFrom(
           "$2",
           `id text, start_ms float8, end_ms float8, points jsonb, pointer_type text, bbox jsonb, ink_len float8,
            median_speed float8, erased boolean, erased_at_ms float8, erased_by text, is_scribble boolean,
            split_from text, replaced_by jsonb`,
         )}
         ORDER BY e.ord
         ON CONFLICT (id) DO UPDATE SET
           start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms, points = EXCLUDED.points,
           pointer_type = EXCLUDED.pointer_type, bbox = EXCLUDED.bbox, ink_len = EXCLUDED.ink_len,
           median_speed = EXCLUDED.median_speed, erased = EXCLUDED.erased, erased_at_ms = EXCLUDED.erased_at_ms,
           erased_by = EXCLUDED.erased_by, is_scribble = EXCLUDED.is_scribble,
           -- Lineage is sticky: once cut into pieces a stroke stays replaced even if a stale copy is re-sent.
           split_from = COALESCE(EXCLUDED.split_from, strokes.split_from),
           replaced_by = COALESCE(EXCLUDED.replaced_by, strokes.replaced_by)
         WHERE strokes.session_id = EXCLUDED.session_id`,
        [sessionId, JSON.stringify(records)],
      );
      // The ink time series follows the strokes as stored: one row per live stroke of this session.
      await this.run(
        `DELETE FROM ink_samples WHERE session_id = $1 AND stroke_id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
        [sessionId, ids],
      );
      await this.run(
        `INSERT INTO ink_samples (session_id, lecture_id, lecture_ts, stroke_id, kind, speed, pressure, ink_len, erased)
         SELECT st.session_id, s.lecture_id, $3::timestamptz + make_interval(secs => st.start_ms / 1000.0), st.id,
                st.pointer_type, st.median_speed,
                (SELECT avg((p ->> 2)::float8) FROM jsonb_array_elements(st.points) AS p),
                st.ink_len, st.erased
         FROM strokes st JOIN sessions s ON s.id = st.session_id
         WHERE st.session_id = $1 AND st.id IN (SELECT jsonb_array_elements_text($2::jsonb))
           AND (st.replaced_by IS NULL OR jsonb_array_length(st.replaced_by) = 0) AND NOT st.is_scribble
           AND NOT (st.erased AND COALESCE(st.erased_by, '') = 'undo')`,
        [sessionId, ids, LECTURE_EPOCH_ISO],
      );
      await this.run(
        `UPDATE sessions SET input_kind = $1, has_pressure = $2, ink_version = ink_version + 1 WHERE id = $3`,
        [input.kind, input.hasPressure, sessionId],
      );
    });
  }

  async addEraseEvents(sessionId: string, events: EraseEvent[]) {
    if (events.length === 0) return;
    const records = lastByKey(events, byId).map((e) => ({ id: e.id, at_ms: e.atMs, stroke_ids: e.strokeIds, by: e.by }));
    await this.transaction(async () => {
      await this.run(
        `INSERT INTO erase_events (id, session_id, at_ms, stroke_ids, "by")
         SELECT x.id, $1, x.at_ms, x.stroke_ids, x."by"
         FROM ${recordsFrom("$2", `id text, at_ms float8, stroke_ids jsonb, "by" text`)}
         ORDER BY e.ord
         ON CONFLICT (id) DO UPDATE SET at_ms = EXCLUDED.at_ms, stroke_ids = EXCLUDED.stroke_ids, "by" = EXCLUDED."by"
         WHERE erase_events.session_id = EXCLUDED.session_id`,
        [sessionId, JSON.stringify(records)],
      );
      await this.bumpInkVersion(sessionId);
    });
  }

  async getStrokes(sessionId: string) {
    const rows = await this.rows<StrokeRow>(`SELECT * FROM strokes WHERE session_id = $1 ORDER BY start_ms, seq`, [
      sessionId,
    ]);
    return rows.map(toStroke);
  }

  async getEraseEvents(sessionId: string) {
    const rows = await this.rows<EraseRow>(`SELECT * FROM erase_events WHERE session_id = $1 ORDER BY at_ms, seq`, [
      sessionId,
    ]);
    return rows.map(toEraseEvent);
  }

  async getInkVersion(sessionId: string) {
    const row = await this.one<Pick<AnalysisStateRow, "ink_version">>(`SELECT ink_version FROM sessions WHERE id = $1`, [
      sessionId,
    ]);
    return row?.ink_version ?? 0;
  }

  async saveAnalysis(sessionId: string, analysis: AnalysisToSave) {
    return this.transaction(async () => {
      await this.run(`SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
      const prev = new Map(
        (
          await this.rows<PrevEventRow>(
            `SELECT id, type, status, help, check_attempts, resolved_in_session_id, resolved_by, resolved_at_iso,
                    reopened_at_iso, repeat_of
             FROM timeline_events WHERE session_id = $1`,
            [sessionId],
          )
        ).map((r) => [r.id, r]),
      );
      // Analysis rows are derived data: replace this session's rows wholesale (idempotent re-runs).
      for (const table of ["confusion_windows", "revisions", "timeline_events"]) {
        await this.run(`DELETE FROM ${table} WHERE session_id = $1`, [sessionId]);
      }

      if (analysis.windows.length) {
        const windows = analysis.windows.map((w) => ({
          bucket_start_ms: w.bucketStartMs,
          features: { pause: w.pause, slowdown: w.slowdown, erase: w.erase, pressure: w.pressure, phase: w.phase },
          scores: { rawScore: w.rawScore, emaScore: w.emaScore },
          is_spike: w.isSpike,
          reasons: w.reasons,
        }));
        await this.run(
          `INSERT INTO confusion_windows (session_id, bucket_start_ms, features, scores, is_spike, reasons)
           SELECT $1, x.bucket_start_ms, x.features, x.scores, x.is_spike, x.reasons
           FROM ${recordsFrom("$2", "bucket_start_ms float8, features jsonb, scores jsonb, is_spike boolean, reasons jsonb")}
           ORDER BY e.ord`,
          [sessionId, JSON.stringify(windows)],
        );
      }
      if (analysis.revisions.length) {
        const revisions = analysis.revisions.map((r) => ({
          id: r.id,
          lecture_ms: r.lectureMs,
          kind: r.kind,
          before_ids: r.beforeStrokeIds,
          after_ids: r.afterStrokeIds,
          bbox: r.bbox,
          vision: r.vision ?? null,
        }));
        await this.run(
          `INSERT INTO revisions (id, session_id, lecture_ms, kind, before_ids, after_ids, bbox, vision)
           SELECT x.id, $1, x.lecture_ms, x.kind, x.before_ids, x.after_ids, x.bbox, x.vision
           FROM ${recordsFrom(
             "$2",
             "id text, lecture_ms float8, kind text, before_ids jsonb, after_ids jsonb, bbox jsonb, vision jsonb",
           )}
           ORDER BY e.ord`,
          [sessionId, JSON.stringify(revisions)],
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
        stored.push(carryForward(fresh, sessionId, prev.get(fresh.id)));
      }
      if (stored.length) {
        const events = stored.map((e) => ({
          id: e.id,
          lecture_ms: e.lectureMs,
          type: e.type,
          status: e.status,
          concept_id: e.conceptId,
          revision_id: e.revisionId ?? null,
          window_start_ms: e.windowStartMs ?? null,
          evidence: e.evidence,
          help: e.help ?? null,
          check_attempts: e.checkAttempts,
          resolved_in_session_id: e.resolvedInSessionId ?? null,
          concept_label: e.conceptLabel ?? null,
          resolved_by: e.resolvedBy ?? null,
          resolved_at_iso: e.resolvedAtIso ?? null,
          reopened_at_iso: e.reopenedAtIso ?? null,
          repeat_of: e.repeatOf ?? null,
        }));
        await this.run(
          `INSERT INTO timeline_events (id, session_id, lecture_ms, type, status, concept_id, revision_id, window_start_ms,
                                        evidence, help, check_attempts, resolved_in_session_id, concept_label,
                                        resolved_by, resolved_at_iso, reopened_at_iso, repeat_of)
           SELECT x.id, $1, x.lecture_ms, x.type, x.status, x.concept_id, x.revision_id, x.window_start_ms,
                  x.evidence, x.help, x.check_attempts, x.resolved_in_session_id, x.concept_label,
                  x.resolved_by, x.resolved_at_iso, x.reopened_at_iso, x.repeat_of
           FROM ${recordsFrom(
             "$2",
             `id text, lecture_ms float8, type text, status text, concept_id text, revision_id text,
              window_start_ms float8, evidence jsonb, help jsonb, check_attempts jsonb, resolved_in_session_id text,
              concept_label text, resolved_by text, resolved_at_iso text, reopened_at_iso text, repeat_of text`,
           )}
           ORDER BY e.ord`,
          [sessionId, JSON.stringify(events)],
        );
      }

      await this.run(
        `UPDATE sessions SET analyzed_version = $1, analyzed_at_iso = $2, analysis_duration_ms = $3 WHERE id = $4`,
        [analysis.inkVersion, new Date().toISOString(), analysis.durationMs, sessionId],
      );
      return stored;
    });
  }

  async updateEvent(event: TimelineEvent) {
    await this.updateEvents([event]);
  }

  /** One statement (atomic on its own); a repeated id applies its last copy, like sequential updates. */
  async updateEvents(events: TimelineEvent[]) {
    if (events.length === 0) return;
    const records = lastByKey(events, (e) => `${e.sessionId}\u0000${e.id}`).map((e) => ({
      id: e.id,
      session_id: e.sessionId,
      type: e.type,
      status: e.status,
      help: e.help ?? null,
      check_attempts: e.checkAttempts,
      resolved_in_session_id: e.resolvedInSessionId ?? null,
      resolved_by: e.resolvedBy ?? null,
      resolved_at_iso: e.resolvedAtIso ?? null,
      reopened_at_iso: e.reopenedAtIso ?? null,
      repeat_of: e.repeatOf ?? null,
    }));
    await this.run(
      `UPDATE timeline_events t
       SET type = x.type, status = x.status, help = x.help, check_attempts = x.check_attempts,
           resolved_in_session_id = x.resolved_in_session_id, resolved_by = x.resolved_by,
           resolved_at_iso = x.resolved_at_iso, reopened_at_iso = x.reopened_at_iso, repeat_of = x.repeat_of
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, session_id text, type text, status text, help jsonb,
            check_attempts jsonb, resolved_in_session_id text, resolved_by text, resolved_at_iso text,
            reopened_at_iso text, repeat_of text)
       WHERE t.id = x.id AND t.session_id = x.session_id`,
      [JSON.stringify(records)],
    );
  }

  async getEvent(id: string) {
    const row = await this.one<EventRow>(`SELECT * FROM timeline_events WHERE id = $1`, [id]);
    return row ? toEvent(row) : null;
  }

  async listStudentSessions(studentId: string, lectureId?: string) {
    const rows = await this.rows<SessionRow & { analyzed_version: number | null }>(
      `SELECT * FROM sessions WHERE student_id = $1 AND ($2::text IS NULL OR lecture_id = $2)
       ORDER BY created_at_iso, id ${ID_ORDER}`,
      [studentId, lectureId ?? null],
    );
    return rows.map((r) => ({ ...toSession(r), analyzed: r.analyzed_version != null }));
  }

  async listGaps(studentId: string, lectureId?: string) {
    const rows = await this.rows<EventRow>(
      `SELECT e.* FROM timeline_events e JOIN sessions s ON s.id = e.session_id
       WHERE e.type = 'unresolved_gap' AND s.student_id = $1 AND ($2::text IS NULL OR s.lecture_id = $2)
       ORDER BY s.created_at_iso, e.lecture_ms, e.id ${ID_ORDER}`,
      [studentId, lectureId ?? null],
    );
    return rows.map(toEvent);
  }

  async setEventHelp(eventId: string, help: HelpCard | null) {
    await this.run(`UPDATE timeline_events SET help = $1::jsonb WHERE id = $2`, [help ? JSON.stringify(help) : null, eventId]);
  }

  async getRevision(id: string) {
    const row = await this.one<RevisionRow>(`SELECT * FROM revisions WHERE id = $1`, [id]);
    return row ? toRevision(row) : null;
  }

  async setRevisionVision(id: string, vision: RevisionReading) {
    await this.run(`UPDATE revisions SET vision = $1::jsonb WHERE id = $2`, [JSON.stringify(vision), id]);
  }

  async getAiCache(key: string): Promise<AiCacheEntry | null> {
    const row = await this.one<AiCacheRow>(
      `SELECT key, kind, provider, model, value, created_at FROM ai_cache WHERE key = $1`,
      [key],
    );
    return row ? toAiCacheEntry(row) : null;
  }

  async putAiCache(entry: Omit<AiCacheEntry, "createdAtIso">) {
    await this.run(
      `INSERT INTO ai_cache (key, kind, provider, model, value, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, created_at = EXCLUDED.created_at`,
      [entry.key, entry.kind, entry.provider, entry.model, JSON.stringify(entry.value), new Date().toISOString()],
    );
  }

  async getConceptLabels(lectureId: string) {
    const rows = await this.rows<{ concept_id: string; label: string }>(
      `SELECT concept_id, label FROM concept_labels WHERE lecture_id = $1`,
      [lectureId],
    );
    return new Map(rows.map((r) => [r.concept_id, r.label]));
  }

  async setConceptLabel(lectureId: string, conceptId: string, label: string) {
    await this.transaction(async () => {
      await this.run(
        `INSERT INTO concept_labels (lecture_id, concept_id, label, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (lecture_id, concept_id) DO UPDATE SET label = EXCLUDED.label`,
        [lectureId, conceptId, label, new Date().toISOString()],
      );
      await this.run(`UPDATE timeline_events SET concept_label = $1 WHERE concept_id = $2`, [label, conceptId]);
    });
  }

  private static readonly LECTURE_COLS = `id, course_id, title, media_path, media_type, mime, duration_ms,
    transcript_source, created_at, jsonb_array_length(transcript) AS word_count`;

  async createLecture(input: NewLecture) {
    const id = input.id ?? newId("l_");
    await this.run(
      `INSERT INTO lectures (id, course_id, title, media_path, media_type, mime, duration_ms, transcript,
                             transcript_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        id,
        input.courseId,
        input.title,
        input.mediaPath,
        input.mediaType,
        input.mime,
        input.durationMs,
        JSON.stringify(input.words),
        input.transcriptSource,
        new Date().toISOString(),
      ],
    );
    return (await this.getLecture(id))!.lecture;
  }

  async listLectures() {
    const rows = await this.rows<LectureRow>(
      `SELECT ${PostgresDb.LECTURE_COLS} FROM lectures
       ORDER BY (transcript_source = 'demo') DESC, created_at DESC, id ${ID_ORDER}`,
    );
    return rows.map(toLecture);
  }

  async getLecture(id: string): Promise<LectureRecord | null> {
    const row = await this.one<LectureRow & { transcript: string }>(
      `SELECT ${PostgresDb.LECTURE_COLS}, transcript FROM lectures WHERE id = $1`,
      [id],
    );
    if (!row) return null;
    return { lecture: toLecture(row), words: JSON.parse(row.transcript) as TranscriptWord[], mediaPath: row.media_path };
  }

  async setLectureTranscript(id: string, words: TranscriptWord[], source: TranscriptSource) {
    const changed = await this.run(`UPDATE lectures SET transcript = $1::jsonb, transcript_source = $2 WHERE id = $3`, [
      JSON.stringify(words),
      source,
      id,
    ]);
    if (changed === 0) return null;
    return (await this.getLecture(id))!.lecture;
  }

  async addNotabilityImport(input: NewNotabilityImport) {
    const id = newId("n_");
    return this.transaction(async () => {
      await this.run(`SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]);
      // Strictly increasing within a session so "newest first" is unambiguous.
      const last = await this.one<{ at: string | null }>(
        `SELECT MAX(created_at) AS at FROM notability_imports WHERE session_id = $1`,
        [input.sessionId],
      );
      const createdMs = Math.max(Date.now(), last?.at ? Date.parse(last.at) + 1 : 0);
      await this.run(`UPDATE notability_imports SET is_current = FALSE WHERE session_id = $1 AND is_current`, [
        input.sessionId,
      ]);
      await this.run(
        `INSERT INTO notability_imports (id, session_id, file_name_display, stored_name, page_count, size, created_at, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
        [id, input.sessionId, input.fileName, input.storedName, input.pageCount, input.size, new Date(createdMs).toISOString()],
      );
      const row = await this.one<NotabilityRow>(`SELECT * FROM notability_imports WHERE id = $1`, [id]);
      return toNotabilityImport(row!);
    });
  }

  async getNotabilityImport(sessionId: string): Promise<NotabilityImportRecord | null> {
    const row = await this.one<NotabilityRow>(`SELECT * FROM notability_imports WHERE session_id = $1 AND is_current`, [
      sessionId,
    ]);
    return row ? { import: toNotabilityImport(row), storedName: row.stored_name } : null;
  }

  async listNotabilityImports(sessionId: string) {
    const rows = await this.rows<NotabilityRow>(
      `SELECT * FROM notability_imports WHERE session_id = $1 ORDER BY created_at DESC, seq DESC`,
      [sessionId],
    );
    return rows.map(toNotabilityImport);
  }

  async getAnalysis(sessionId: string): Promise<StoredAnalysis | null> {
    const state = await this.one<AnalysisStateRow>(
      `SELECT ink_version, analyzed_version, analyzed_at_iso, analysis_duration_ms FROM sessions WHERE id = $1`,
      [sessionId],
    );
    if (!state || state.analyzed_version == null || !state.analyzed_at_iso) return null;
    const [windows, revisions, events] = await Promise.all([
      this.rows<WindowRow>(`SELECT * FROM confusion_windows WHERE session_id = $1 ORDER BY bucket_start_ms`, [sessionId]),
      this.rows<RevisionRow>(`SELECT * FROM revisions WHERE session_id = $1 ORDER BY lecture_ms, id ${ID_ORDER}`, [
        sessionId,
      ]),
      this.rows<EventRow>(`SELECT * FROM timeline_events WHERE session_id = $1 ORDER BY lecture_ms, id ${ID_ORDER}`, [
        sessionId,
      ]),
    ]);
    return {
      durationMs: state.analysis_duration_ms ?? 0,
      windows: windows.map(toWindow),
      revisions: revisions.map(toRevision),
      events: events.map(toEvent),
      analyzedAtIso: state.analyzed_at_iso,
      stale: state.ink_version > state.analyzed_version,
    };
  }

  /**
   * Per-window ink statistics in SQL over the ink_samples series: TimescaleDB time_bucket on the
   * hypertable when available, else date_bin (same buckets: both are anchored at the lecture epoch).
   */
  async inkWindowStats(sessionId: string, windowMs: number): Promise<InkWindowStat[]> {
    assertStatsWindowMs(windowMs);
    await this.start();
    const bucket = this.timescale
      ? `time_bucket(make_interval(secs => $2::float8 / 1000), lecture_ts, $3::timestamptz)`
      : `date_bin(make_interval(secs => $2::float8 / 1000), lecture_ts, $3::timestamptz)`;
    const rows = await this.rows<{
      bucket_start_ms: number;
      strokes: number;
      erased: number;
      ink_len: number;
      median_speed: number;
      mean_pressure: number | null;
    }>(
      `SELECT round(extract(epoch FROM ${bucket} - $3::timestamptz) * 1000)::float8 AS bucket_start_ms,
              count(*)::int AS strokes,
              (count(*) FILTER (WHERE erased))::int AS erased,
              sum(ink_len)::float8 AS ink_len,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY speed) AS median_speed,
              avg(pressure) FILTER (WHERE kind = 'pen' AND pressure IS NOT NULL) AS mean_pressure
       FROM ink_samples WHERE session_id = $1
       GROUP BY 1 ORDER BY 1`,
      [sessionId, windowMs, LECTURE_EPOCH_ISO],
    );
    return rows.map((r) => ({
      bucketStartMs: r.bucket_start_ms,
      strokes: r.strokes,
      erased: r.erased,
      inkLen: r.ink_len,
      medianSpeed: r.median_speed,
      meanPressure: r.mean_pressure,
    }));
  }

  /** Class-wide hotspots: the continuous aggregate on Timescale, else a date_bin rollup. */
  async lectureInkHotspots(lectureId: string): Promise<InkHotspot[]> {
    await this.start();
    const sql = this.hotspotsAggregate
      ? `SELECT round(extract(epoch FROM bucket - $2::timestamptz) * 1000)::float8 AS bucket_start_ms,
                strokes::int AS strokes, erased::int AS erased, ink_len::float8 AS ink_len
         FROM ${HOTSPOTS_VIEW} WHERE lecture_id = $1 ORDER BY bucket`
      : `SELECT round(extract(epoch FROM date_bin(make_interval(secs => $3::float8 / 1000), lecture_ts, $2::timestamptz)
                                  - $2::timestamptz) * 1000)::float8 AS bucket_start_ms,
                count(*)::int AS strokes, (count(*) FILTER (WHERE erased))::int AS erased,
                sum(ink_len)::float8 AS ink_len
         FROM ink_samples WHERE lecture_id = $1 GROUP BY 1 ORDER BY 1`;
    const params = this.hotspotsAggregate
      ? [lectureId, LECTURE_EPOCH_ISO]
      : [lectureId, LECTURE_EPOCH_ISO, HOTSPOT_BUCKET_MS];
    const rows = await this.rows<{ bucket_start_ms: number; strokes: number; erased: number; ink_len: number }>(
      sql,
      params,
    );
    return rows.map((r) => ({ bucketStartMs: r.bucket_start_ms, strokes: r.strokes, erased: r.erased, inkLen: r.ink_len }));
  }
}

/**
 * A Postgres repository for DATABASE_URL. `postgres://…` / `postgresql://…` use a pg connection
 * pool (Tiger Data in production); `pglite:memory` or `pglite:<dir>` use embedded PGlite (a
 * devDependency: local runs and tests without a server). Connects lazily on first use.
 */
export function openPostgresDb(url: string): PostgresDb {
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length).replace(/^\/\//, "");
    const dataDir = dir && dir !== "memory" ? resolve(/*turbopackIgnore: true*/ process.cwd(), dir) : undefined;
    return new PostgresDb(() => pgliteDriver(dataDir));
  }
  const options = pgConnectionOptions(url); // validates now; the URL itself is never logged
  return new PostgresDb(() => pgDriver(options));
}
