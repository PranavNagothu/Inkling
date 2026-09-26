import { describe, expect, it } from 'vitest';
import { fallbackHelpCard } from '../ai/fallback';
import { createFakeProvider } from '../ai/fake';
import { aiStatusFrom, selectProvider } from '../ai/select';
import type { HelpContext } from '../ai/types';
import { countWords, validateConceptLabel, validateHelpCard, validateRevisionReading } from '../ai/validate';

describe('selectProvider', () => {
  it('is off with no keys, saying what to add', () => {
    const s = selectProvider({});
    expect(s).toMatchObject({ mode: 'off', provider: null });
    expect(s.reason).toMatch(/OPENAI_API_KEY/);
  });

  it('treats blank keys as unset (the e2e server sets OPENAI_API_KEY="")', () => {
    expect(selectProvider({ OPENAI_API_KEY: '', GEMINI_API_KEY: '  ' }).mode).toBe('off');
  });

  it('auto-detects by available key: OpenAI, then Gemini, then Grok', () => {
    expect(selectProvider({ OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b', XAI_API_KEY: 'c' }).provider?.name).toBe('openai');
    expect(selectProvider({ GEMINI_API_KEY: 'b', XAI_API_KEY: 'c' }).provider?.name).toBe('gemini');
    expect(selectProvider({ XAI_API_KEY: 'c' }).provider?.name).toBe('grok');
    expect(selectProvider({ OPENAI_API_KEY: 'a' })).toMatchObject({ mode: 'live' });
  });

  it('honours AI_PROVIDER, and needs that provider’s key', () => {
    expect(selectProvider({ AI_PROVIDER: 'grok', OPENAI_API_KEY: 'a', XAI_API_KEY: 'c' }).provider?.name).toBe('grok');
    const missing = selectProvider({ AI_PROVIDER: 'gemini', OPENAI_API_KEY: 'a' });
    expect(missing).toMatchObject({ mode: 'off', provider: null });
    expect(missing.reason).toMatch(/GEMINI_API_KEY/);
    expect(selectProvider({ AI_PROVIDER: 'OpenAI', OPENAI_API_KEY: 'a' }).provider?.name).toBe('openai');
  });

  it('rejects an unknown AI_PROVIDER', () => {
    const s = selectProvider({ AI_PROVIDER: 'skynet', OPENAI_API_KEY: 'a' });
    expect(s.mode).toBe('off');
    expect(s.reason).toMatch(/AI_PROVIDER/);
  });

  it('AI_PROVIDER=fake never needs a key and never touches the network', () => {
    const s = selectProvider({ AI_PROVIDER: 'fake', INKLING_DISABLE_AI: '1' });
    expect(s).toMatchObject({ mode: 'fake' });
    expect(s.provider?.name).toBe('fake');
  });

  it('INKLING_DISABLE_AI=1 turns network providers off', () => {
    expect(selectProvider({ OPENAI_API_KEY: 'a', INKLING_DISABLE_AI: '1' }).mode).toBe('off');
  });

  it('DEMO_MODE=1 serves fixtures offline, whatever keys are set', () => {
    const s = selectProvider({ DEMO_MODE: '1', OPENAI_API_KEY: 'a' });
    expect(s.mode).toBe('demo');
    expect(s.provider?.name).toBe('fake');
  });

  it('passes the configured model through', () => {
    expect(selectProvider({ OPENAI_API_KEY: 'a', OPENAI_MODEL: 'gpt-4.1-mini' }).provider?.model).toBe('gpt-4.1-mini');
  });
});

describe('aiStatusFrom', () => {
  it('is client-safe: mode, provider, model — never keys', () => {
    const status = aiStatusFrom(selectProvider({ OPENAI_API_KEY: 'sk-secret' }));
    expect(status).toEqual({ enabled: true, mode: 'live', provider: 'openai', model: 'gpt-5-mini' });
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    expect(aiStatusFrom(selectProvider({}))).toMatchObject({ enabled: false, mode: 'off', provider: null });
  });
});

const ctx: HelpContext = {
  lectureTitle: 'The Chain Rule',
  conceptLabel: 'Outer and inner functions',
  excerpt: 'So if y equals f of g of x, we have an outer function f and an inner function g.',
  momentType: 'unresolved_gap',
  clock: '00:12',
  misconception: null,
};

describe('fake provider', () => {
  const fake = createFakeProvider();

  it('is deterministic and derived from its input', async () => {
    const a = await fake.helpFor(ctx);
    expect(await fake.helpFor(ctx)).toEqual(a);
    const b = await fake.helpFor({ ...ctx, excerpt: 'The product rule is for two functions multiplied together.' });
    expect(b).not.toEqual(a);
    expect(a.reexplain).toContain('we have an outer function f and an inner function g');
  });

  it('produces cards, readings and labels that pass the validators', async () => {
    const card = await fake.helpFor(ctx);
    expect(validateHelpCard(card)).toEqual({ ok: true, value: card });
    expect(countWords(card.reexplain)).toBeLessThanOrEqual(80);
    const reading = await fake.readRevision({ beforePng: 'data:image/png;base64,AAAA', afterPng: 'data:image/png;base64,BBBBBBBB', excerpt: ctx.excerpt });
    expect(validateRevisionReading(reading)).toEqual({ ok: true, value: reading });
    expect(reading.cosmetic).toBe(false);
    const label = await fake.labelConcept(ctx.excerpt);
    expect(validateConceptLabel({ label })).toEqual({ ok: true, value: label });
  });

  it('puts the right answer at an input-dependent position', async () => {
    const positions = new Set<number>();
    for (const clock of ['00:01', '00:02', '00:03', '00:04', '00:05', '00:06', '00:07', '00:08']) {
      const c = await fake.helpFor({ ...ctx, clock, excerpt: `${ctx.excerpt} ${clock}` });
      positions.add(c.mcq.answerIdx);
      expect(c.mcq.options[c.mcq.answerIdx]).toMatch(/multiply/i);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('honours an abort signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fake.helpFor(ctx, { signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('fallbackHelpCard', () => {
  it('is a valid, safe card built only from the moment (no model)', () => {
    const card = fallbackHelpCard(ctx);
    expect(validateHelpCard(card).ok).toBe(true);
    expect(card.reexplain).toContain('Outer and inner functions');
    expect(card.mcq.options[card.mcq.answerIdx]).toMatch(/own words/i);
  });

  it('works without a transcript or label', () => {
    expect(validateHelpCard(fallbackHelpCard({ ...ctx, excerpt: '', conceptLabel: null })).ok).toBe(true);
  });
});
