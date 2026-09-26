import { describe, expect, it } from 'vitest';
import { countWords, validateConceptLabel, validateHelpCard, validateRevisionReading } from '../ai/validate';

const goodCard = {
  reexplain: 'The chain rule multiplies the outer derivative, evaluated at the inside, by the inner derivative.',
  mcq: {
    q: 'What is the derivative of (3x + 1)^2?',
    options: ['2(3x + 1)', '6(3x + 1)', '6x', '2(3x + 1) + 3'],
    answerIdx: 1,
    why: 'Outer derivative 2(3x + 1) times the inner derivative 3.',
  },
};

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('  one two\nthree\t four ')).toBe(4);
    expect(countWords('')).toBe(0);
  });
});

describe('validateHelpCard', () => {
  it('accepts a well-formed card', () => {
    const r = validateHelpCard(goodCard);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(goodCard);
  });

  it('rejects non-objects and missing fields', () => {
    expect(validateHelpCard(null).ok).toBe(false);
    expect(validateHelpCard('{}').ok).toBe(false);
    expect(validateHelpCard({ reexplain: 'x' }).ok).toBe(false);
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, q: undefined } }).ok).toBe(false);
  });

  it('requires exactly 4 distinct, non-empty options', () => {
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, options: ['a', 'b', 'c'] } }).ok).toBe(false);
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, options: ['a', 'b', 'c', 'd', 'e'] } }).ok).toBe(false);
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, options: ['a', 'b', ' ', 'd'] } }).ok).toBe(false);
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, options: ['a', 'B', 'b', 'd'] } }).ok).toBe(false);
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, options: ['a', 'b', 3, 'd'] } }).ok).toBe(false);
  });

  it('requires answerIdx to be an integer in range (repairing a numeric string)', () => {
    for (const bad of [-1, 4, 1.5, 'x', null]) {
      expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, answerIdx: bad } }).ok).toBe(false);
    }
    const r = validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, answerIdx: '2' } });
    expect(r.ok && r.value.mcq.answerIdx).toBe(2);
  });

  it('rejects empty strings anywhere', () => {
    expect(validateHelpCard({ ...goodCard, reexplain: '   ' }).ok).toBe(false);
    expect(validateHelpCard({ ...goodCard, mcq: { ...goodCard.mcq, why: '' } }).ok).toBe(false);
  });

  it('repairs a slightly long re-explanation to at most 80 words, preferring a sentence end', () => {
    const sentence = 'This sentence has exactly ten words in it for testing. ';
    const long = sentence.repeat(9).trim(); // 90 words
    const r = validateHelpCard({ ...goodCard, reexplain: long });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(countWords(r.value.reexplain)).toBeLessThanOrEqual(80);
    expect(r.value.reexplain.endsWith('.')).toBe(true);
  });

  it('rejects a re-explanation far over the limit (the model ignored the brief)', () => {
    expect(validateHelpCard({ ...goodCard, reexplain: 'word '.repeat(200) }).ok).toBe(false);
  });

  it('strips control characters and collapses whitespace', () => {
    const r = validateHelpCard({ ...goodCard, reexplain: 'Outer\u0000 then\u0007  inner.\n\nDone.' });
    expect(r.ok && r.value.reexplain).toBe('Outer then inner. Done.');
  });

  it('drops unknown fields (the schema never grows from model output)', () => {
    const r = validateHelpCard({ ...goodCard, extra: 'x', mcq: { ...goodCard.mcq, hint: 'y' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual(['mcq', 'reexplain']);
      expect(Object.keys(r.value.mcq).sort()).toEqual(['answerIdx', 'options', 'q', 'why']);
    }
  });
});

describe('validateRevisionReading', () => {
  const good = {
    before: 'wrote f prime of x',
    after: 'wrote f prime of g of x',
    misconception: 'Evaluated the outer derivative at x instead of at the inner function.',
    conceptLabel: 'Chain rule evaluation',
    cosmetic: false,
  };

  it('accepts a well-formed reading', () => {
    expect(validateRevisionReading(good)).toEqual({ ok: true, value: good });
  });

  it('repairs "true"/"false" strings for cosmetic, rejects other types', () => {
    const r = validateRevisionReading({ ...good, cosmetic: 'true' });
    expect(r.ok && r.value.cosmetic).toBe(true);
    expect(validateRevisionReading({ ...good, cosmetic: 1 }).ok).toBe(false);
  });

  it('keeps the misconception to 25 words and the label to 2–4 words', () => {
    const r = validateRevisionReading({ ...good, misconception: 'x '.repeat(30), conceptLabel: 'one two three four five' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(countWords(r.value.misconception)).toBeLessThanOrEqual(25);
    expect(r.value.conceptLabel).toBe('one two three four');
    expect(validateRevisionReading({ ...good, conceptLabel: 'Derivatives' }).ok).toBe(false);
  });

  it('allows an empty misconception only for a cosmetic change', () => {
    expect(validateRevisionReading({ ...good, misconception: '' }).ok).toBe(false);
    expect(validateRevisionReading({ ...good, misconception: '', cosmetic: true }).ok).toBe(true);
  });

  it('rejects empty before/after', () => {
    expect(validateRevisionReading({ ...good, before: '' }).ok).toBe(false);
    expect(validateRevisionReading({ ...good, after: ' ' }).ok).toBe(false);
  });
});

describe('validateConceptLabel', () => {
  it('accepts 2–4 words, trimming quotes and trailing punctuation', () => {
    expect(validateConceptLabel({ label: '"Outer and inner functions."' })).toEqual({ ok: true, value: 'Outer and inner functions' });
  });

  it('cuts a long label to 4 words and rejects a single word or empty', () => {
    expect(validateConceptLabel({ label: 'the chain rule for composite functions' })).toEqual({
      ok: true,
      value: 'the chain rule for',
    });
    expect(validateConceptLabel({ label: 'Derivatives' }).ok).toBe(false);
    expect(validateConceptLabel({ label: '' }).ok).toBe(false);
    expect(validateConceptLabel('Chain rule').ok).toBe(false);
  });
});
