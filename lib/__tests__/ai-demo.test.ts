import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoEntryFor, parseDemoFixtures, type DemoFixtures } from '../ai/demo';
import { validateConceptLabel, validateHelpCard, validateRevisionReading } from '../ai/validate';

const raw = JSON.parse(readFileSync(new URL('../../public/demo/ai-cache.json', import.meta.url), 'utf8')) as unknown;
const DEMO = 'demo-chain-rule';

describe('public/demo/ai-cache.json', () => {
  const fixtures = parseDemoFixtures(raw);

  it('parses, and is for the demo lecture', () => {
    expect(fixtures.lectureId).toBe(DEMO);
    expect(fixtures.entries.length).toBeGreaterThanOrEqual(8);
  });

  it('every entry passes the same validators as live model output, unchanged', () => {
    for (const e of fixtures.entries) {
      expect(validateHelpCard(e.help)).toEqual({ ok: true, value: e.help });
      expect(validateConceptLabel({ label: e.label })).toEqual({ ok: true, value: e.label });
      if (e.revision) expect(validateRevisionReading(e.revision)).toEqual({ ok: true, value: e.revision });
    }
  });

  it('covers the whole 6-minute lecture without overlaps', () => {
    const sorted = [...fixtures.entries].sort((a, b) => a.fromMs - b.fromMs);
    expect(sorted[0].fromMs).toBe(0);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].fromMs).toBe(sorted[i - 1].toMs);
    expect(sorted[sorted.length - 1].toMs).toBeGreaterThanOrEqual(360_000);
  });

  it('covers the demo scenario moments (correction at 02:30, gap at 03:40) with readings for corrections', () => {
    expect(demoEntryFor(fixtures, DEMO, 150_000)?.revision).toBeTruthy();
    expect(demoEntryFor(fixtures, DEMO, 220_000)?.help.mcq.options).toHaveLength(4);
  });
});

describe('demoEntryFor', () => {
  const fixtures: DemoFixtures = {
    lectureId: DEMO,
    entries: [
      {
        fromMs: 0,
        toMs: 10_000,
        label: 'Chain rule basics',
        help: { reexplain: 'r', mcq: { q: 'q', options: ['a', 'b', 'c', 'd'], answerIdx: 0, why: 'w' } },
      },
    ],
  };

  it('matches by lecture and half-open time range', () => {
    expect(demoEntryFor(fixtures, DEMO, 0)?.label).toBe('Chain rule basics');
    expect(demoEntryFor(fixtures, DEMO, 9_999)).toBeTruthy();
    expect(demoEntryFor(fixtures, DEMO, 10_000)).toBeNull();
    expect(demoEntryFor(fixtures, 'other-lecture', 5_000)).toBeNull();
  });

  it('rejects malformed fixture files', () => {
    expect(() => parseDemoFixtures({})).toThrow();
    expect(() => parseDemoFixtures({ lectureId: DEMO, entries: [{ fromMs: 'x' }] })).toThrow();
  });
});
