import { describe, expect, it } from 'vitest';
import { hotspotBars, hotspotSourceLabel, slowestStretches } from '../hotspots';

describe('hotspotBars', () => {
  it('lays out every 30 s bucket of the lecture, empty ones included, scaled to the busiest', () => {
    const bars = hotspotBars(
      [
        { bucketStartMs: 30_000, strokes: 10, erased: 1, inkLen: 500 },
        { bucketStartMs: 90_000, strokes: 12, erased: 4, inkLen: 700 },
      ],
      130_000,
    );
    expect(bars.map((b) => [b.startMs, b.erased, b.level])).toEqual([
      [0, 0, 0],
      [30_000, 1, 0.25],
      [60_000, 0, 0],
      [90_000, 4, 1],
      [120_000, 0, 0],
    ]);
    expect(bars[4].endMs).toBe(130_000);
  });

  it('keeps ink written past the end of the lecture, and is empty without data', () => {
    expect(hotspotBars([{ bucketStartMs: 60_000, strokes: 1, erased: 1, inkLen: 5 }], 45_000)).toHaveLength(3);
    expect(hotspotBars([], 60_000).every((b) => b.level === 0)).toBe(true);
  });
});

describe('slowestStretches', () => {
  it('picks the buckets with the most erasing (earlier first on ties), never empty ones', () => {
    const bars = hotspotBars(
      [
        { bucketStartMs: 0, strokes: 5, erased: 2, inkLen: 1 },
        { bucketStartMs: 30_000, strokes: 5, erased: 5, inkLen: 1 },
        { bucketStartMs: 60_000, strokes: 5, erased: 2, inkLen: 1 },
      ],
      120_000,
    );
    expect(slowestStretches(bars, 2).map((b) => b.startMs)).toEqual([30_000, 0]);
    expect(slowestStretches(hotspotBars([], 60_000))).toEqual([]);
  });
});

describe('hotspotSourceLabel', () => {
  it('names where the numbers come from', () => {
    expect(hotspotSourceLabel({ backend: 'postgres', timescale: true })).toMatch(/TimescaleDB continuous aggregate/);
    expect(hotspotSourceLabel({ backend: 'postgres', timescale: false })).toMatch(/date_bin/);
    expect(hotspotSourceLabel({ backend: 'sqlite', timescale: false })).toMatch(/SQLite/);
  });
});
