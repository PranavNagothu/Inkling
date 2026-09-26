import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildChatRequest, createCompatProvider, parseChatContent, type CompatConfig } from '../ai/compat';
import { geminiConfig } from '../ai/gemini';
import { grokConfig } from '../ai/grok';
import { DEFAULT_OPENAI_MODEL, openAiConfig } from '../ai/openai';
import { HELP_SCHEMA, buildHelpMessages } from '../ai/prompts';
import { AiInvalidOutputError, AiRequestError, type HelpContext } from '../ai/types';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ai/${name}`, import.meta.url), 'utf8');
const ok = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: 'nope' } }), { status: code, headers });

const ctx: HelpContext = {
  lectureTitle: 'The Chain Rule',
  conceptLabel: 'Outer and inner functions',
  excerpt: 'Outer function sine, inner function x squared.',
  momentType: 'unresolved_gap',
  clock: '01:31',
  misconception: null,
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function provider(fetchImpl: typeof fetch, over: Partial<CompatConfig> = {}) {
  return createCompatProvider({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key',
    model: 'gpt-5-mini',
    tokenParam: 'max_completion_tokens',
    timeoutMs: 2000,
    maxRetries: 2,
    backoffMs: 0,
    fetch: fetchImpl,
    ...over,
  });
}

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

describe('buildChatRequest', () => {
  it('posts to /chat/completions with a bearer key, strict json_schema and the token cap', () => {
    const cfg = openAiConfig({ OPENAI_API_KEY: 'sk-a' })!;
    const { url, init } = buildChatRequest(cfg, buildHelpMessages(ctx), HELP_SCHEMA, 900);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-a');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'help_card', strict: true, schema: HELP_SCHEMA.schema },
    });
    expect(body.max_completion_tokens).toBe(900);
    expect(body.messages[0].role).toBe('system');
  });

  it('asks reasoning models for minimal effort and leaves other models alone', () => {
    const reasoning = JSON.parse(buildChatRequest(openAiConfig({ OPENAI_API_KEY: 'k' })!, [], HELP_SCHEMA, 10).init.body as string);
    expect(reasoning.reasoning_effort).toBe('minimal');
    const classic = JSON.parse(
      buildChatRequest(openAiConfig({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-4.1-mini' })!, [], HELP_SCHEMA, 10).init.body as string,
    );
    expect(classic.reasoning_effort).toBeUndefined();
    const custom = JSON.parse(
      buildChatRequest(openAiConfig({ OPENAI_API_KEY: 'k', OPENAI_REASONING_EFFORT: 'low' })!, [], HELP_SCHEMA, 10).init.body as string,
    );
    expect(custom.reasoning_effort).toBe('low');
  });

  it('Gemini and Grok use their OpenAI-compatible endpoints, default models and max_tokens', () => {
    const g = geminiConfig({ GEMINI_API_KEY: 'gk' })!;
    expect(g.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(g.model).toBe('gemini-3.1-flash-lite');
    const gReq = buildChatRequest(g, [], HELP_SCHEMA, 50);
    expect(gReq.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(JSON.parse(gReq.init.body as string).max_tokens).toBe(50);

    const x = grokConfig({ XAI_API_KEY: 'xk' })!;
    expect(buildChatRequest(x, [], HELP_SCHEMA, 50).url).toBe('https://api.x.ai/v1/chat/completions');
    expect(x.model).toBe('grok-4-fast-non-reasoning');
  });

  it('base URLs and models are configurable; missing keys give no config', () => {
    expect(geminiConfig({ GEMINI_API_KEY: 'gk', GEMINI_MODEL: 'gemini-2.5-pro', GEMINI_BASE_URL: 'https://proxy.example/v1/' })).toMatchObject({
      model: 'gemini-2.5-pro',
      baseUrl: 'https://proxy.example/v1',
    });
    expect(grokConfig({ XAI_API_KEY: 'xk', XAI_MODEL: 'grok-4' })!.model).toBe('grok-4');
    expect(openAiConfig({ OPENAI_API_KEY: '' })).toBeNull();
    expect(geminiConfig({})).toBeNull();
    expect(grokConfig({ XAI_API_KEY: '   ' })).toBeNull();
  });
});

describe('parseChatContent', () => {
  it('reads string content, text-part arrays and ```json fences', () => {
    expect(parseChatContent(JSON.parse(fixture('chat-label.json')))).toEqual({ label: 'Outer and inner functions' });
    expect(parseChatContent(JSON.parse(fixture('chat-revision.json')))).toMatchObject({ conceptLabel: 'Chain rule evaluation' });
  });

  it('rejects refusals, truncated output and non-JSON', () => {
    const wrap = (message: object, finish = 'stop') => ({ choices: [{ finish_reason: finish, message }] });
    expect(() => parseChatContent(wrap({ content: null, refusal: 'I cannot help with that.' }))).toThrow(AiInvalidOutputError);
    expect(() => parseChatContent(wrap({ content: '{"label":"Out' }, 'length'))).toThrow(AiInvalidOutputError);
    expect(() => parseChatContent(wrap({ content: 'Sure! Here you go.' }))).toThrow(AiInvalidOutputError);
    expect(() => parseChatContent({})).toThrow(AiInvalidOutputError);
  });
});

describe('createCompatProvider', () => {
  it('helpFor: parses and validates the model JSON', async () => {
    const f = vi.fn(async () => ok(fixture('chat-help.json')));
    const card = await provider(f as unknown as typeof fetch).helpFor(ctx);
    expect(card.mcq.options).toHaveLength(4);
    expect(card.mcq.answerIdx).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('readRevision: sends both crops as image_url parts and validates the reading', async () => {
    const f = vi.fn(async () => ok(fixture('chat-revision.json')));
    const reading = await provider(f as unknown as typeof fetch).readRevision({ beforePng: PNG, afterPng: PNG, excerpt: 'x' });
    expect(reading).toMatchObject({ cosmetic: false, conceptLabel: 'Chain rule evaluation' });
    const parts = bodyOf(f.mock.calls[0]).messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url)).toEqual([PNG, PNG]);
  });

  it('labelConcept returns the validated label', async () => {
    const f = vi.fn(async () => ok(fixture('chat-label.json')));
    await expect(provider(f as unknown as typeof fetch, { name: 'grok' }).labelConcept('Outer function sine.')).resolves.toBe(
      'Outer and inner functions',
    );
  });

  it('invalid JSON: retries once with a repair note, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(ok(fixture('chat-invalid.json'))).mockResolvedValueOnce(ok(fixture('chat-help.json')));
    const card = await provider(f as unknown as typeof fetch).helpFor(ctx);
    expect(card.mcq.answerIdx).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
    const retry = JSON.stringify(bodyOf(f.mock.calls[1]).messages);
    expect(retry).toMatch(/previous answer was invalid/i);
    expect(retry).toMatch(/exactly 4/);
  });

  it('invalid twice: throws AiInvalidOutputError (the service then falls back)', async () => {
    const f = vi.fn(async () => ok(fixture('chat-invalid.json')));
    await expect(provider(f as unknown as typeof fetch).helpFor(ctx)).rejects.toBeInstanceOf(AiInvalidOutputError);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries 429 and 5xx (honouring Retry-After), then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(status(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok(fixture('chat-help.json')));
    await expect(provider(f as unknown as typeof fetch).helpFor(ctx)).resolves.toMatchObject({ mcq: { answerIdx: 1 } });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    const f = vi.fn(async () => status(500));
    const err = await provider(f as unknown as typeof fetch).helpFor(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect((err as AiRequestError).status).toBe(500);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('does not retry auth / bad-request errors, and never leaks the key in the error', async () => {
    const f = vi.fn(async () => status(401));
    const err = (await provider(f as unknown as typeof fetch).helpFor(ctx).catch((e: unknown) => e)) as AiRequestError;
    expect(err).toBeInstanceOf(AiRequestError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('sk-test-key');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(ok(fixture('chat-label.json')));
    await expect(provider(f as unknown as typeof fetch).labelConcept('x y')).resolves.toBe('Outer and inner functions');
  });

  it('times out (overall deadline) without hanging', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    const err = await provider(hang as unknown as typeof fetch, { timeoutMs: 40 }).helpFor(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect((err as Error).message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stops when the caller aborts', async () => {
    const ctrl = new AbortController();
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const p = provider(hang as unknown as typeof fetch).helpFor(ctx, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(AiRequestError);
    expect(hang).toHaveBeenCalledTimes(1);
  });
});
