import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LECTURE_EPOCH_ISO, MIGRATIONS, openPostgresDb, pgConnectionOptions } from '../dbPostgres';
import type { Stroke } from '../types';

// Postgres-specific behaviour (the shared contract is in dbContract.test.ts): connection options,
// versioned migrations, the translated schema, the ink_samples series and graceful degradation
// without TimescaleDB — on embedded PGlite.
const dir = mkdtempSync(join(tmpdir(), 'inkling-pg-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = 's3cr3t-pa55';

describe('pgConnectionOptions', () => {
  it('maps sslmode like libpq and strips it from the connection string', () => {
    const base = `postgres://tsdbadmin:${SECRET}@db.example.com:5432/tsdb`;
    expect(pgConnectionOptions(`${base}?sslmode=disable`).ssl).toBe(false);
    expect(pgConnectionOptions(`${base}?sslmode=require`).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgConnectionOptions(`${base}?sslmode=verify-full`).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgConnectionOptions(`${base}?sslmode=verify-ca`).ssl).toEqual({ rejectUnauthorized: true });
    const opts = pgConnectionOptions(`${base}?sslmode=require&application_name=x`);
    expect(opts.connectionString).not.toContain('sslmode');
    expect(opts.connectionString).toContain('application_name=x');
    expect(pgConnectionOptions(base.replace('postgres:', 'postgresql:')).connectionString).toMatch(/^postgresql:/);
  });

  it('encrypts by default (no sslmode, prefer, allow) for any host that is not on this machine', () => {
    const TLS = { rejectUnauthorized: false };
    for (const host of ['db.example.com', '10.0.0.5', '192.168.1.20', '[2001:db8::1]', 'localhost.example.com', '127.example.com']) {
      const url = `postgres://u:${SECRET}@${host}:5432/db`;
      expect(pgConnectionOptions(url).ssl, host).toEqual(TLS);
      expect(pgConnectionOptions(`${url}?sslmode=prefer`).ssl, `${host} prefer`).toEqual(TLS);
      expect(pgConnectionOptions(`${url}?sslmode=allow`).ssl, `${host} allow`).toEqual(TLS);
      expect(pgConnectionOptions(`${url}?sslmode=disable`).ssl, `${host} disable`).toBe(false);
    }
    // A remote host given as ?host= (libpq style) is not loopback either.
    expect(pgConnectionOptions('postgres:///db?host=db.example.com').ssl).toEqual(TLS);
    // Several hosts: plaintext only if every one is local.
    expect(pgConnectionOptions('postgres:///db?host=localhost,db.example.com').ssl).toEqual(TLS);
    expect(pgConnectionOptions('postgres:///db?host=localhost,127.0.0.1').ssl).toBe(false);
  });

  it('stays plaintext by default only for loopback hosts and unix sockets', () => {
    for (const url of [
      `postgres://u:${SECRET}@localhost:5432/db`,
      `postgres://u:${SECRET}@LOCALHOST/db`,
      `postgres://u:${SECRET}@127.0.0.1:5432/db`,
      `postgres://u:${SECRET}@127.8.9.10/db`,
      `postgres://u:${SECRET}@[::1]:5432/db`,
      'postgres:///db', // no host: libpq's default unix socket
      'postgres:///db?host=/var/run/postgresql',
      `postgres://u:${SECRET}@%2Fvar%2Frun%2Fpostgresql/db`,
      `postgres://u:${SECRET}@localhost/db?sslmode=prefer`,
      `postgres://u:${SECRET}@127.0.0.1/db?sslmode=allow`,
    ]) {
      expect(pgConnectionOptions(url).ssl, url.replace(SECRET, '***')).toBe(false);
    }
    // An explicit sslmode still wins on loopback.
    expect(pgConnectionOptions(`postgres://u:${SECRET}@localhost/db?sslmode=require`).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgConnectionOptions(`postgres://u:${SECRET}@127.0.0.1/db?sslmode=verify-full`).ssl).toEqual({ rejectUnauthorized: true });
    // The host parameter survives; only sslmode is stripped.
    expect(pgConnectionOptions('postgres:///db?host=/tmp&sslmode=disable').connectionString).toBe('postgres:///db?host=%2Ftmp');
  });

  it('requires TLS for Tiger Cloud hosts even without sslmode', () => {
    const tiger = `postgres://tsdbadmin:${SECRET}@abc123.xyz789.tsdb.cloud.timescale.com:34567/tsdb`;
    expect(pgConnectionOptions(tiger).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgConnectionOptions(`${tiger}?sslmode=verify-full`).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('rejects bad URLs without echoing them (they carry the password)', () => {
    for (const bad of [`mysql://u:${SECRET}@h/db`, `not a url ${SECRET}`, `postgres://u:${SECRET}@h/db?sslmode=bogus`]) {
      let message = '';
      try {
        openPostgresDb(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).not.toContain(SECRET);
    }
  });
});

const stroke = (sessionId: string, id: string, startMs: number, over: Partial<Stroke> = {}): Stroke => ({
  id,
  sessionId,
  startMs,
  endMs: startMs + 300,
  points: [
    [0, 0, 0.2, startMs],
    [5, 5, 0.6, startMs + 300],
  ],
  pointerType: 'pen',
  bbox: [0, 0, 5, 5],
  inkLen: 7.07,
  medianSpeed: 0.02,
  erased: false,
  erasedAtMs: null,
  erasedBy: null,
  isScribble: false,
  ...over,
});

describe('PostgresDb on PGlite', () => {
  const dataDir = join(dir, 'pgdata');

  it('migrates once, persists data, and degrades gracefully without TimescaleDB', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const db = openPostgresDb(`pglite:${dataDir}`);
    expect(await db.info()).toEqual({ backend: 'postgres', timescale: false });
    expect(info.mock.calls.flat().join(' ')).toMatch(/TimescaleDB is not available.*date_bin/);
    const s = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 'kept' });
    await db.upsertStrokes(s.id, [
      stroke(s.id, 'p_live', 12_500),
      stroke(s.id, 'p_scribble', 13_000, { isScribble: true }),
      stroke(s.id, 'p_mouse', 1_000, { pointerType: 'mouse' }),
    ]);
    await db.close();

    // Re-opening applies nothing new and keeps the rows; the log line is not repeated.
    const again = openPostgresDb(`pglite:${dataDir}`);
    expect((await again.getSession(s.id))?.title).toBe('kept');
    await again.close();
    expect(info.mock.calls.filter((c) => /TimescaleDB is not available/.test(String(c[0])))).toHaveLength(1);
    info.mockRestore();

    const raw = await PGlite.create({ dataDir });
    try {
      const versions = await raw.query<{ version: number; name: string }>(`SELECT version, name FROM schema_migrations ORDER BY version`);
      expect(versions.rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));

      // One ink_samples row per live stroke (not the scribble-out), on the lecture-time axis.
      const samples = await raw.query<{ stroke_id: string; lecture_ts: Date; kind: string; pressure: number; lecture_id: string }>(
        `SELECT stroke_id, lecture_ts, kind, pressure, lecture_id FROM ink_samples WHERE session_id = $1 ORDER BY lecture_ts`,
        [s.id],
      );
      expect(samples.rows.map((r) => [r.stroke_id, r.lecture_ts.toISOString(), r.kind, r.lecture_id])).toEqual([
        ['p_mouse', new Date(Date.parse(LECTURE_EPOCH_ISO) + 1_000).toISOString(), 'mouse', 'demo-chain-rule'],
        ['p_live', new Date(Date.parse(LECTURE_EPOCH_ISO) + 12_500).toISOString(), 'pen', 'demo-chain-rule'],
      ]);
      expect(samples.rows[1].pressure).toBeCloseTo(0.4, 12);

      // The schema uses native Postgres types.
      const types = await raw.query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE (table_name, column_name) IN (('strokes', 'points'), ('sessions', 'created_at_iso'),
                                             ('sessions', 'has_pressure'), ('timeline_events', 'evidence'),
                                             ('ink_samples', 'lecture_ts'))
         ORDER BY table_name, column_name`,
      );
      expect(types.rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`)).toEqual([
        'ink_samples.lecture_ts:timestamp with time zone',
        'sessions.created_at_iso:timestamp with time zone',
        'sessions.has_pressure:boolean',
        'strokes.points:jsonb',
        'timeline_events.evidence:jsonb',
      ]);

      // At most one current Notability import per session, enforced by the partial unique index.
      const insert = `INSERT INTO notability_imports (id, session_id, file_name_display, stored_name, size, created_at, is_current)
                      VALUES ($1, $2, 'x.pdf', 'y.pdf', 1, now(), TRUE)`;
      await raw.query(insert, ['n_raw1', s.id]);
      await expect(raw.query(insert, ['n_raw2', s.id])).rejects.toThrow(/unique/i);
    } finally {
      await raw.close();
    }
  }, 60_000);

  it('migration 2 removes ink_samples rows of undone strokes written before undo was left out', async () => {
    const legacyDir = join(dir, 'pgdata-undo');
    const db = openPostgresDb(`pglite:${legacyDir}`);
    const s = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 'legacy' });
    await db.upsertStrokes(s.id, [
      stroke(s.id, 'm_live', 1_000),
      stroke(s.id, 'm_undone', 2_000, { erased: true, erasedAtMs: 3_000, erasedBy: 'undo' }),
    ]);
    await db.close();

    // What an older build stored: a sample row for the undone stroke, before migration 2 existed.
    const raw = await PGlite.create({ dataDir: legacyDir });
    try {
      await raw.query(
        `INSERT INTO ink_samples (session_id, lecture_id, lecture_ts, stroke_id, kind, speed, pressure, ink_len, erased)
         VALUES ($1, 'demo-chain-rule', $2::timestamptz + interval '2 seconds', 'm_undone', 'pen', 0.02, 0.4, 7.07, TRUE)`,
        [s.id, LECTURE_EPOCH_ISO],
      );
      await raw.query(`DELETE FROM schema_migrations WHERE version >= 2`);
    } finally {
      await raw.close();
    }

    const again = openPostgresDb(`pglite:${legacyDir}`);
    try {
      expect(await again.inkWindowStats(s.id, 10_000)).toMatchObject([{ bucketStartMs: 0, strokes: 1, erased: 0 }]);
    } finally {
      await again.close();
    }
  }, 60_000);

  it('uses a transaction for analysis saves: a failure leaves the previous analysis intact', async () => {
    const db = openPostgresDb('pglite:memory');
    try {
      const s = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 't' });
      await db.saveAnalysis(s.id, { durationMs: 1, windows: [], revisions: [], events: [], inkVersion: 0 });
      const w = {
        sessionId: s.id, bucketStartMs: 0, pause: 0, slowdown: 0, erase: 0, pressure: null,
        rawScore: 0, emaScore: 0, isSpike: false, reasons: [],
      };
      // Two windows with the same start violate the primary key halfway through the save.
      await expect(
        db.saveAnalysis(s.id, { durationMs: 2, windows: [w, w], revisions: [], events: [], inkVersion: 1 }),
      ).rejects.toThrow();
      expect((await db.getAnalysis(s.id))?.durationMs).toBe(1);
    } finally {
      await db.close();
    }
  }, 60_000);
});

describe('getDb backend selection', () => {
  const g = globalThis as unknown as { __inklingDb?: { close(): Promise<void> } };

  it('uses Postgres when DATABASE_URL is set and SQLite otherwise', async () => {
    const saved = { url: process.env.DATABASE_URL, path: process.env.INKLING_DB_PATH, db: g.__inklingDb };
    try {
      const { getDb } = await import('../db');
      delete g.__inklingDb;
      process.env.DATABASE_URL = 'pglite:memory';
      const pg = getDb();
      expect(await pg.info()).toEqual({ backend: 'postgres', timescale: false });
      await pg.close();

      delete g.__inklingDb;
      process.env.DATABASE_URL = '';
      process.env.INKLING_DB_PATH = join(dir, 'select.db');
      const lite = getDb();
      expect(await lite.info()).toEqual({ backend: 'sqlite', timescale: false });
      await lite.close();
    } finally {
      const restore = (key: string, value: string | undefined) =>
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      restore('DATABASE_URL', saved.url);
      restore('INKLING_DB_PATH', saved.path);
      g.__inklingDb = saved.db;
    }
  }, 60_000);
});
