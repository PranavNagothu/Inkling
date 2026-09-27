import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoEntryFor, demoTranslation, parseDemoFixtures, type DemoFixtures } from '../ai/demo';
import { mathTokens, validateConceptLabel, validateHelpCard, validateLocalizedHelpCard, validateRevisionReading } from '../ai/validate';

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

describe('public/demo/ai-cache.json translations (multilingual re-teach)', () => {
  const fixtures = parseDemoFixtures(raw);
  // Maya's seeded moments: the 01:02 correction, the 01:40 sin(x^2) correction, the 04:07 gap.
  const MAYA_MS = [62_000, 100_000, 250_000];
  const squash = (s: string) => s.replace(/\s+/g, '');

  it('has Spanish and Hindi for every seeded Maya moment', () => {
    for (const ms of MAYA_MS) {
      const entry = demoEntryFor(fixtures, DEMO, ms)!;
      expect(Object.keys(entry.i18n ?? {}).sort()).toEqual(['es', 'hi']);
    }
  });

  it('every translation passes the live translation validator, unchanged, graded by the English answerIdx', () => {
    for (const e of fixtures.entries) {
      for (const [lang, t] of Object.entries(e.i18n ?? {})) {
        const v = validateLocalizedHelpCard(t, e.help);
        expect(v, `${e.label} (${lang})`).toEqual({ ok: true, value: { ...t, mcq: { ...t!.mcq, answerIdx: e.help.mcq.answerIdx } } });
        expect(demoTranslation(e, lang as 'es')).toEqual(v.ok ? v.value : null);
      }
    }
  });

  it('keeps every piece of math identical to the English card (reexplain, question, options, why)', () => {
    for (const e of fixtures.entries) {
      for (const [lang, t] of Object.entries(e.i18n ?? {})) {
        const pairs: Array<[string, string]> = [
          [e.help.reexplain, t!.reexplain],
          [e.help.mcq.q, t!.mcq.q],
          [e.help.mcq.why, t!.mcq.why],
          ...e.help.mcq.options.map((o, i): [string, string] => [o, t!.mcq.options[i]]),
        ];
        for (const [en, other] of pairs) {
          for (const m of mathTokens(en)) expect(squash(other), `${e.label} (${lang}): ${m}`).toContain(squash(m));
        }
      }
    }
  });

  it('is really in the target language (not English copied over)', () => {
    for (const e of fixtures.entries) {
      if (e.i18n?.hi) expect(e.i18n.hi.reexplain).toMatch(/[\u0900-\u097F]/);
      if (e.i18n?.es) expect(e.i18n.es.reexplain).not.toBe(e.help.reexplain);
    }
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
    const entry = { fromMs: 0, toMs: 1, label: 'Chain rule basics', help: {} };
    expect(() => parseDemoFixtures({ lectureId: DEMO, entries: [{ ...entry, i18n: { xx: {} } }] })).toThrow();
    expect(() => parseDemoFixtures({ lectureId: DEMO, entries: [{ ...entry, i18n: { es: {} } }] })).not.toThrow();
  });
});
