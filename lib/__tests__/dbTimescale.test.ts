import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPhase2Scenario } from '../../e2e/fixtures/phase2-scenario';
import { computeInkHotspots, computeInkWindowStats, type InkHotspot, type InkWindowStat } from '../dbShared';
import { openPostgresDb, pgConnectionOptions, type PostgresDb } from '../dbPostgres';

// The TimescaleDB path against a real service (Tiger Data / Timescale Cloud, or a local
// timescale/timescaledb container). Skipped unless TIMESCALE_TEST_URL is set, e.g.
//   TIMESCALE_TEST_URL='postgres://tsdbadmin:…@….tsdb.cloud.timescale.com:…/tsdb?sslmode=require' \
//     npx vitest run --project unit lib/__tests__/dbTimescale.test.ts
// It creates Inkling's tables in that database (use a throwaway service) and namespaces its rows
// with a random run id, so it can be re-run against the same database.
const url = process.env.TIMESCALE_TEST_URL;
const run = randomUUID().slice(0, 8);

function expectClose(actual: InkWindowStat[] | InkHotspot[], expected: InkWindowStat[] | InkHotspot[]) {
  expect(actual.map((w) => w.bucketStartMs)).toEqual(expected.map((w) => w.bucketStartMs));
  actual.forEach((a, i) => {
    const e = expected[i] as unknown as Record<string, number | null>;
    for (const [key, value] of Object.entries(a)) {
      if (value === null || e[key] === null) expect([key, value]).toEqual([key, e[key]]);
      else expect(value, key).toBeCloseTo(e[key] as number, 9);
    }
  });
}

describe.skipIf(!url)('TimescaleDB (TIMESCALE_TEST_URL)', () => {
  let db: PostgresDb;
  let raw: pg.Pool;

  beforeAll(async () => {
    db = openPostgresDb(url!);
    raw = new pg.Pool({ ...pgConnectionOptions(url!), max: 1 });
    await db.info();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await raw?.end();
  });

  it('enables Timescale: ink_samples is a hypertable with a hotspot continuous aggregate', async () => {
    expect(await db.info()).toEqual({ backend: 'postgres', timescale: true });
    const hyper = await raw.query(`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'ink_samples'`);
    expect(hyper.rowCount).toBe(1);
    const cagg = await raw.query(`SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name = 'ink_lecture_hotspots'`);
    expect(cagg.rowCount).toBe(1);
  });

  it('time_bucket window stats equal the TypeScript reference', async () => {
    const s = await db.createSession({ lectureId: `l_ts_${run}`, courseId: 'c', title: 'timescale', studentId: `st_${run}` });
    const { strokes, eraseEvents } = buildPhase2Scenario(s.id);
    const unique = strokes.map((k) => ({ ...k, id: `${k.id}_${run}`, replacedBy: k.replacedBy?.map((r) => `${r}_${run}`) ?? null }));
    await db.upsertStrokes(s.id, unique);
    await db.addEraseEvents(s.id, eraseEvents.map((e) => ({ ...e, id: `${e.id}_${run}` })));
    const stored = await db.getStrokes(s.id);
    for (const windowMs of [10_000, 7_000]) {
      expectClose(await db.inkWindowStats(s.id, windowMs), computeInkWindowStats(stored, windowMs));
    }
  }, 60_000);

  it('class-wide hotspots from the continuous aggregate equal the TypeScript reference', async () => {
    const lectureId = `l_hot_${run}`;
    const all = [];
    for (const student of ['a', 'b']) {
      const s = await db.createSession({ lectureId, courseId: 'c', title: 'hot', studentId: `st_${student}_${run}` });
      const { strokes } = buildPhase2Scenario(s.id);
      const unique = strokes.map((k) => ({ ...k, id: `${k.id}_${student}_${run}`, replacedBy: k.replacedBy?.map((r) => `${r}_${student}_${run}`) ?? null }));
      await db.upsertStrokes(s.id, unique);
      all.push(...(await db.getStrokes(s.id)));
    }
    await db.refreshInkAggregates();
    expectClose(await db.lectureInkHotspots(lectureId), computeInkHotspots(all));
  }, 120_000);
});
