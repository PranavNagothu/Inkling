import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Notability imports on a throwaway SQLite file: one current import per session, history kept.
const dir = mkdtempSync(join(tmpdir(), 'inkling-notability-'));
const file = join(dir, 'test.db');
process.env.INKLING_DB_PATH = file;

let db: ReturnType<typeof import('../db')['getDb']>;

beforeAll(async () => {
  db = (await import('../db')).getDb();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const input = (sessionId: string, n: number) => ({
  sessionId,
  fileName: `export ${n}.pdf`,
  storedName: `00000000-0000-4000-8000-00000000000${n}.pdf`,
  pageCount: n,
  size: 1000 + n,
});

describe('notability imports', () => {
  it('returns null before anything is uploaded', async () => {
    const s = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 't' });
    expect(await db.getNotabilityImport(s.id)).toBeNull();
    expect(await db.listNotabilityImports(s.id)).toEqual([]);
  });

  it('stores an import as the current one, without leaking the stored name', async () => {
    const s = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 't' });
    const saved = await db.addNotabilityImport(input(s.id, 1));
    expect(saved).toMatchObject({ sessionId: s.id, fileName: 'export 1.pdf', pageCount: 1, size: 1001, current: true });
    expect(saved.id).toMatch(/^n_/);
    expect(saved.createdAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(saved)).not.toContain('00000000-0000');

    const current = await db.getNotabilityImport(s.id);
    expect(current).toEqual({ import: saved, storedName: input(s.id, 1).storedName });
  });

  it('replacing keeps the history and marks only the latest as current', async () => {
    const s = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 't' });
    const first = await db.addNotabilityImport(input(s.id, 1));
    const second = await db.addNotabilityImport({ ...input(s.id, 2), pageCount: null });

    const current = await db.getNotabilityImport(s.id);
    expect(current?.import.id).toBe(second.id);
    expect(current?.import.pageCount).toBeNull();
    expect(current?.storedName).toBe(input(s.id, 2).storedName);

    const history = await db.listNotabilityImports(s.id);
    expect(history.map((h) => [h.id, h.current])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
  });

  it('keeps imports per session', async () => {
    const a = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 'a' });
    const b = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 'b' });
    await db.addNotabilityImport(input(a.id, 3));
    expect(await db.getNotabilityImport(b.id)).toBeNull();
    expect((await db.getNotabilityImport(a.id))?.import.fileName).toBe('export 3.pdf');
  });

  // Inspects the SQLite file directly; the Postgres partial unique index is checked in dbPostgres.test.ts.
  it.skipIf(!!process.env.DATABASE_URL)('allows at most one current import per session at the database level', () => {
    const raw = new Database(file);
    try {
      const s = raw.prepare(`SELECT id FROM sessions LIMIT 1`).get() as { id: string };
      const insert = raw.prepare(
        `INSERT INTO notability_imports (id, session_id, file_name_display, stored_name, page_count, size, created_at, is_current)
         VALUES (?, ?, 'x.pdf', ?, NULL, 1, '2026-01-01T00:00:00.000Z', 1)`,
      );
      raw.prepare(`UPDATE notability_imports SET is_current = 0 WHERE session_id = ?`).run(s.id);
      insert.run('n_raw1', s.id, '00000000-0000-4000-8000-0000000000a1.pdf');
      expect(() => insert.run('n_raw2', s.id, '00000000-0000-4000-8000-0000000000a2.pdf')).toThrow(/UNIQUE/);
    } finally {
      raw.close();
    }
  });
});

describe('migration', () => {
  it('adds the notability table to a database created before it existed', async () => {
    const oldFile = join(dir, 'old.db');
    const old = new Database(oldFile);
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, lecture_id TEXT NOT NULL,
      course_id TEXT NOT NULL, title TEXT NOT NULL, created_at_iso TEXT NOT NULL, input_kind TEXT,
      has_pressure INTEGER NOT NULL DEFAULT 0)`);
    old.close();

    const { openDb } = await import('../db');
    const migrated = openDb(oldFile);
    const s = await migrated.createSession({ lectureId: 'demo-chain-rule', courseId: 'c', title: 'old' });
    const saved = await migrated.addNotabilityImport(input(s.id, 4));
    expect((await migrated.getNotabilityImport(s.id))?.import.id).toBe(saved.id);
  });
});
