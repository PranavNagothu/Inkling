import { describe, expect, it } from 'vitest';
import { MAX_RECAP_WORDS, buildRecap, recapCounts, type RecapEvent } from '../recap';

// The spoken session recap (lib/recap): counts, pluralisation, the top concept(s), what to review
// next and an encouraging close, in at most 90 words; English, Spanish and Hindi templates.

const ev = (over: Partial<RecapEvent>): RecapEvent => ({
  type: 'misconception_corrected',
  status: 'resolved',
  lectureMs: 10_000,
  conceptLabel: 'Chain rule',
  checkAttempts: [],
  ...over,
});

const words = (s: string) => s.trim().split(/\s+/).length;

const MAYA: RecapEvent[] = [
  ev({ type: 'breakthrough', lectureMs: 62_000, conceptLabel: 'Multiplying the inner derivative', checkAttempts: [{ correct: true }] }),
  ev({ type: 'misconception_corrected', lectureMs: 100_000, conceptLabel: 'Sine of x squared' }),
  ev({ type: 'unresolved_gap', status: 'open', lectureMs: 240_000, conceptLabel: 'Chain versus product rule' }),
];

describe('recapCounts', () => {
  it('counts like the review header: corrections, gaps (and how many are open), breakthroughs', () => {
    expect(recapCounts(MAYA)).toEqual({ corrections: 1, gaps: 1, openGaps: 1, breakthroughs: 1 });
    expect(recapCounts([])).toEqual({ corrections: 0, gaps: 0, openGaps: 0, breakthroughs: 0 });
  });
});

describe('buildRecap (English)', () => {
  it('summarises counts, the top concept and the open gap to review, encouragingly', () => {
    const r = buildRecap({ title: 'Chain rule', events: MAYA }, 'en');
    expect(r.language).toBe('en');
    expect(r.text).toContain('Chain rule');
    expect(r.text).toContain('1 correction, 1 gap and 1 breakthrough');
    expect(r.text).toContain('Next, review Chain versus product rule');
    expect(r.text).toMatch(/breakthrough shows/);
    expect(r.focus).toBe('Chain versus product rule');
    expect(words(r.text)).toBeLessThanOrEqual(MAX_RECAP_WORDS);
  });

  it('pluralises one vs many vs none', () => {
    const one = buildRecap({ title: 'L', events: [ev({})] }, 'en').text;
    expect(one).toContain('1 correction, no gaps and no breakthroughs');
    const many = buildRecap(
      {
        title: 'L',
        events: [
          ev({ type: 'unresolved_gap', status: 'open', conceptLabel: 'A' }),
          ev({ type: 'unresolved_gap', status: 'open', conceptLabel: 'B', lectureMs: 20_000 }),
          ev({ type: 'breakthrough', checkAttempts: [{ correct: true }] }),
          ev({ type: 'breakthrough', checkAttempts: [{ correct: true }], lectureMs: 30_000 }),
          ev({ lectureMs: 40_000 }),
          ev({ lectureMs: 50_000 }),
        ],
      },
      'en',
    ).text;
    expect(many).toContain('2 corrections, 2 gaps and 2 breakthroughs');
    expect(many).toMatch(/breakthroughs show/);
  });

  it('names the most frequent concept(s)', () => {
    const r = buildRecap(
      {
        title: 'L',
        events: [
          ev({ conceptLabel: 'Leibniz notation', lectureMs: 1 }),
          ev({ conceptLabel: 'Sine squared trap', lectureMs: 2 }),
          ev({ conceptLabel: 'Sine squared trap', lectureMs: 3 }),
        ],
      },
      'en',
    );
    expect(r.text).toContain('Most of it was about Sine squared trap and Leibniz notation.');
  });

  it('points at an unconfirmed correction when no gap is open, else says nothing is left', () => {
    const correction = buildRecap({ title: 'L', events: [ev({ conceptLabel: 'Sine of x squared' })] }, 'en');
    expect(correction.text).toContain('try the check question on Sine of x squared');
    const done = buildRecap(
      { title: 'L', events: [ev({ type: 'breakthrough', conceptLabel: 'Nested chain rule', checkAttempts: [{ correct: true }] })] },
      'en',
    );
    expect(done.text).toContain('Nothing is left open');
    expect(done.focus).toBeNull();
  });

  it('a moment without a concept label is named by its time', () => {
    const r = buildRecap({ title: 'L', events: [ev({ type: 'unresolved_gap', status: 'open', conceptLabel: null, lectureMs: 125_000 })] }, 'en');
    expect(r.text).toContain('the moment at 02:05');
  });

  it('an empty session gets a short, encouraging note', () => {
    const r = buildRecap({ title: 'Chain rule', events: [] }, 'en');
    expect(r.text).toMatch(/No corrections, gaps or breakthroughs/);
    expect(r.focus).toBeNull();
    expect(words(r.text)).toBeLessThanOrEqual(MAX_RECAP_WORDS);
  });

  it('cleans and caps untrusted titles / labels, and stays within 90 words', () => {
    const r = buildRecap(
      {
        title: `Evil‮ title ${'x'.repeat(500)}`,
        events: Array.from({ length: 30 }, (_, i) =>
          ev({ type: 'unresolved_gap', status: 'open', lectureMs: i * 1000, conceptLabel: `Label ${'word '.repeat(40)}${i}` }),
        ),
      },
      'en',
    );
    expect(r.text).not.toContain('‮');
    expect(r.text.length).toBeLessThan(900);
    expect(words(r.text)).toBeLessThanOrEqual(MAX_RECAP_WORDS);
  });
});

describe('buildRecap (other languages)', () => {
  it('Spanish template', () => {
    const r = buildRecap({ title: 'Regla de la cadena', events: MAYA }, 'es');
    expect(r.language).toBe('es');
    expect(r.text).toContain('Este es tu resumen de Regla de la cadena.');
    expect(r.text).toContain('1 corrección, 1 duda y 1 avance');
    expect(buildRecap({ title: 'L', events: [ev({}), ev({ lectureMs: 2 })] }, 'es').text).toContain('2 correcciones');
    expect(r.text).toContain('Ahora repasa Chain versus product rule');
    expect(buildRecap({ title: 'L', events: [ev({})] }, 'es').text).toContain('1 corrección, ninguna duda y ningún avance');
  });

  it('Hindi template', () => {
    const r = buildRecap({ title: 'Chain rule', events: MAYA }, 'hi');
    expect(r.language).toBe('hi');
    expect(r.text).toContain('1 सुधार, 1 अधूरा सवाल और 1 बड़ी सफलता');
    expect(buildRecap({ title: 'L', events: [] }, 'hi').text).toContain('अभी तक');
  });

  it('languages without a template fall back to English (the service translates them)', () => {
    const r = buildRecap({ title: 'L', events: MAYA }, 'ko');
    expect(r.language).toBe('en');
    expect(r.text).toContain('Here’s your recap');
  });
});
