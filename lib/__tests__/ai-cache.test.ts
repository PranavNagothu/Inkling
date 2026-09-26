import { describe, expect, it } from 'vitest';
import { aiCacheKey, normalizeForKey, stableStringify } from '../ai/cache';

describe('stableStringify', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it('drops undefined fields like JSON does', () => {
    expect(stableStringify({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('normalizeForKey', () => {
  it('trims and collapses whitespace in every string', () => {
    expect(normalizeForKey({ t: '  The  chain\n rule ', list: [' a  b '] })).toEqual({ t: 'The chain rule', list: ['a b'] });
  });
});

describe('aiCacheKey', () => {
  const base = { provider: 'openai', model: 'gpt-5-mini', kind: 'help', input: { excerpt: 'The chain rule.' } };

  it('is a sha256 hex digest', () => {
    expect(aiCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable under whitespace and key-order differences', () => {
    expect(aiCacheKey({ ...base, input: { excerpt: '  The chain   rule. ' } })).toBe(aiCacheKey(base));
    expect(aiCacheKey({ ...base, input: { b: 1, a: 2 } })).toBe(aiCacheKey({ ...base, input: { a: 2, b: 1 } }));
  });

  it('differs by provider, model, kind and input', () => {
    const k = aiCacheKey(base);
    expect(aiCacheKey({ ...base, provider: 'gemini' })).not.toBe(k);
    expect(aiCacheKey({ ...base, model: 'gpt-5' })).not.toBe(k);
    expect(aiCacheKey({ ...base, kind: 'label' })).not.toBe(k);
    expect(aiCacheKey({ ...base, input: { excerpt: 'The product rule.' } })).not.toBe(k);
  });

  it('cannot be confused by separators inside fields', () => {
    expect(aiCacheKey({ ...base, provider: 'a|b', model: 'c' })).not.toBe(aiCacheKey({ ...base, provider: 'a', model: 'b|c' }));
  });
});
