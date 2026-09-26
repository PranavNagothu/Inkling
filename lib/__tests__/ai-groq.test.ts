import { describe, expect, it, vi } from 'vitest';
import { aiLabel } from '../about';
import { buildChatRequest, createCompatProvider, type CompatConfig } from '../ai/compat';
import {
  DEFAULT_GROQ_MODEL,
  DEFAULT_GROQ_VISION_MODEL,
  GROQ_BASE_URL,
  createGroqProvider,
  groqConfig,
  groqVisionConfig,
} from '../ai/groq';
import { HELP_SCHEMA, LABEL_SCHEMA, buildHelpMessages } from '../ai/prompts';
import { aiStatusFrom, selectProvider } from '../ai/select';
import { AiRequestError, type AiProvider, type HelpContext, type RevisionInput } from '../ai/types';

// Mocked fetch only: nothing here touches the network.
const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
const httpError = (code: number, headers: Record<string, string> = {}) =>
  json({ error: { message: 'nope', type: 'invalid_request_error' } }, { status: code, headers });
/** A Groq chat completion (GPT-OSS answers carry a separate `reasoning` field unless it is excluded). */
const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-groq',
  object: 'chat.completion',
  model: DEFAULT_GROQ_MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content), ...extra } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});

const HELP = {
  reexplain: 'Differentiate the outer function, keep the inner one inside it, then multiply by the derivative of the inner function.',
  mcq: {
    q: 'What is the derivative of sin(x²)?',
    options: ['cos(x²)', 'cos(x²)·2x', '2x', 'sin(2x)'],
    answerIdx: 1,
    why: 'The outer derivative cos stays evaluated at x², then multiply by the inner derivative 2x.',
  },
};
const READING = {
  before: 'cos(x²)',
  after: 'cos(x²)·2x',
  misconception: 'Forgot to multiply by the derivative of the inner function.',
  conceptLabel: 'Chain rule',
  cosmetic: false,
};

const ctx: HelpContext = {
  lectureTitle: 'The Chain Rule',
  conceptLabel: 'Outer and inner functions',
  excerpt: 'Outer function sine, inner function x squared.',
  momentType: 'unresolved_gap',
  clock: '01:31',
  misconception: null,
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const revisionInput: RevisionInput = { beforePng: PNG, afterPng: PNG, excerpt: 'Multiply by the inner derivative.' };

const KEY = 'gsk_test_key';
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const fast = { timeoutMs: 2000, backoffMs: 0 };
const groq = (env: Record<string, string>, fetchImpl: typeof fetch, visionFallback: AiProvider | null = null) =>
  createGroqProvider({ ...groqConfig({ GROQ_API_KEY: KEY, ...env })!, ...fast }, groqVisionConfig({ GROQ_API_KEY: KEY, ...env }), {
    fetch: fetchImpl,
    visionFallback,
    visionTuning: fast,
  });

describe('groqConfig', () => {
  it('needs GROQ_API_KEY (blank counts as unset)', () => {
    expect(groqConfig({})).toBeNull();
    expect(groqConfig({ GROQ_API_KEY: '  ' })).toBeNull();
    expect(groqVisionConfig({})).toBeNull();
  });

  it('defaults: Groq’s OpenAI-compatible endpoint, a strict-JSON-schema model, low reasoning effort', () => {
    const cfg = groqConfig({ GROQ_API_KEY: KEY })!;
    expect(GROQ_BASE_URL).toBe('https://api.groq.com/openai/v1');
    expect(cfg).toMatchObject({ name: 'groq', baseUrl: GROQ_BASE_URL, apiKey: KEY, model: 'openai/gpt-oss-120b' });
    expect(cfg.tokenParam).toBe('max_completion_tokens');
    expect(cfg.extraBody).toEqual({ reasoning_effort: 'low', include_reasoning: false });
    expect(cfg.responseFormat ?? 'json_schema').toBe('json_schema');
  });

  it('GROQ_MODEL, GROQ_BASE_URL and GROQ_REASONING_EFFORT override the defaults', () => {
    const cfg = groqConfig({
      GROQ_API_KEY: KEY,
      GROQ_MODEL: 'openai/gpt-oss-20b',
      GROQ_BASE_URL: 'https://proxy.example/openai/v1/',
      GROQ_REASONING_EFFORT: 'medium',
    })!;
    expect(cfg).toMatchObject({ model: 'openai/gpt-oss-20b', baseUrl: 'https://proxy.example/openai/v1' });
    expect(cfg.extraBody).toMatchObject({ reasoning_effort: 'medium' });
  });

  it('models without strict structured outputs use JSON object mode (the validators + repair retry still apply)', () => {
    const cfg = groqConfig({ GROQ_API_KEY: KEY, GROQ_MODEL: 'llama-3.1-8b-instant' })!;
    expect(cfg.responseFormat).toBe('json_object');
    expect(cfg.extraBody).toEqual({}); // no reasoning params for non-reasoning models (Groq answers 400)
  });

  it('vision: Qwen 3.8 27B by default with reasoning off; GROQ_VISION_MODEL overrides or turns it off', () => {
    const v = groqVisionConfig({ GROQ_API_KEY: KEY })!;
    expect(DEFAULT_GROQ_VISION_MODEL).toBe('qwen/qwen3.8-27b');
    expect(v).toMatchObject({ name: 'groq', model: DEFAULT_GROQ_VISION_MODEL, baseUrl: GROQ_BASE_URL, tokenParam: 'max_completion_tokens' });
    expect(v.extraBody).toEqual({ reasoning_effort: 'none' });
    expect(v.responseFormat ?? 'json_schema').toBe('json_schema');
    expect(groqVisionConfig({ GROQ_API_KEY: KEY, GROQ_VISION_MODEL: 'some/other-vision' })!.model).toBe('some/other-vision');
    for (const off of ['none', 'off', '0', 'false']) expect(groqVisionConfig({ GROQ_API_KEY: KEY, GROQ_VISION_MODEL: off })).toBeNull();
  });
});

describe('Groq chat requests', () => {
  it('posts to /chat/completions with the gsk key as a bearer token and a strict json_schema', () => {
    const { url, init } = buildChatRequest(groqConfig({ GROQ_API_KEY: KEY })!, buildHelpMessages(ctx), HELP_SCHEMA, 900);
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'openai/gpt-oss-120b',
      max_completion_tokens: 900,
      reasoning_effort: 'low',
      include_reasoning: false,
      response_format: { type: 'json_schema', json_schema: { name: 'help_card', strict: true, schema: HELP_SCHEMA.schema } },
    });
    expect(body.max_tokens).toBeUndefined();
    // Groq rejects messages[].name with a 400.
    for (const m of body.messages) expect(m.name).toBeUndefined();
  });

  it('JSON object mode: response_format json_object and the schema spelled out in a system message', () => {
    const cfg: CompatConfig = { ...groqConfig({ GROQ_API_KEY: KEY, GROQ_MODEL: 'llama-3.1-8b-instant' })! };
    const body = JSON.parse(buildChatRequest(cfg, buildHelpMessages(ctx), LABEL_SCHEMA, 50).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const systems = (body.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'system');
    expect(systems.map((m) => m.content).join('\n')).toContain(JSON.stringify(LABEL_SCHEMA.schema));
    expect(body.messages.at(-1).role).toBe('user');
  });
});

describe('createGroqProvider', () => {
  it('helpFor / labelConcept use the text model and parse GPT-OSS answers (reasoning field ignored)', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(completion(HELP, { reasoning: 'Thinking about the chain rule…' })))
      .mockResolvedValueOnce(json(completion({ label: 'Chain rule' })));
    const p = groq({}, f as unknown as typeof fetch);
    expect(p).toMatchObject({ name: 'groq', model: 'openai/gpt-oss-120b' });
    await expect(p.helpFor(ctx)).resolves.toMatchObject({ mcq: { answerIdx: 1 } });
    await expect(p.labelConcept('Outer function sine.')).resolves.toBe('Chain rule');
    expect(bodyOf(f.mock.calls[0]).model).toBe('openai/gpt-oss-120b');
    expect(bodyOf(f.mock.calls[1]).model).toBe('openai/gpt-oss-120b');
  });

  it('readRevision uses the vision model with both crops as image_url parts', async () => {
    const f = vi.fn(async () => json(completion(READING)));
    const reading = await groq({}, f as unknown as typeof fetch).readRevision(revisionInput);
    expect(reading).toMatchObject({ conceptLabel: 'Chain rule', cosmetic: false });
    const body = bodyOf(f.mock.calls[0]);
    expect(body.model).toBe('qwen/qwen3.8-27b');
    expect(body.reasoning_effort).toBe('none');
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'revision_reading', strict: true } });
    const parts = body.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url)).toEqual([PNG, PNG]);
  });

  it('retries a 429 (Retry-After) and then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(httpError(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json(completion({ label: 'Chain rule' })));
    await expect(groq({}, f as unknown as typeof fetch).labelConcept('x')).resolves.toBe('Chain rule');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('an invalid answer gets one repair retry', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(completion({ ...HELP, mcq: { ...HELP.mcq, options: ['a', 'b'] } })))
      .mockResolvedValueOnce(json(completion(HELP)));
    await expect(groq({}, f as unknown as typeof fetch).helpFor(ctx)).resolves.toMatchObject({ mcq: { answerIdx: 1 } });
    expect(JSON.stringify(bodyOf(f.mock.calls[1]).messages)).toMatch(/previous answer was invalid/i);
  });

  it('auth errors are not retried and never leak the key', async () => {
    const f = vi.fn(async () => httpError(401));
    const err = (await groq({}, f as unknown as typeof fetch).helpFor(ctx).catch((e: unknown) => e)) as AiRequestError;
    expect(err).toBeInstanceOf(AiRequestError);
    expect(err.message).toMatch(/^groq: HTTP 401/);
    expect(err.message).not.toContain(KEY);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('Groq vision fallback', () => {
  const fallbackFetch = () => vi.fn(async () => json({ ...completion(READING), model: 'gemini-3.1-flash-lite' }));
  const fallbackProvider = (f: typeof fetch) =>
    createCompatProvider({
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'gemini-key',
      model: 'gemini-3.1-flash-lite',
      tokenParam: 'max_tokens',
      fetch: f,
      ...fast,
    });

  it('falls back to the next provider when the Groq vision model rejects the request (400 / 404)', async () => {
    for (const code of [400, 404]) {
      const g = vi.fn(async () => httpError(code));
      const fb = fallbackFetch();
      const reading = await groq({}, g as unknown as typeof fetch, fallbackProvider(fb as unknown as typeof fetch)).readRevision(revisionInput);
      expect(reading.conceptLabel).toBe('Chain rule');
      expect(g).toHaveBeenCalledTimes(1);
      expect(fb).toHaveBeenCalledTimes(1);
      expect(bodyOf(fb.mock.calls[0]).model).toBe('gemini-3.1-flash-lite');
    }
  });

  it('GROQ_VISION_MODEL=none goes straight to the fallback provider', async () => {
    const g = vi.fn(async () => json(completion(READING)));
    const fb = fallbackFetch();
    await groq({ GROQ_VISION_MODEL: 'none' }, g as unknown as typeof fetch, fallbackProvider(fb as unknown as typeof fetch)).readRevision(revisionInput);
    expect(g).not.toHaveBeenCalled();
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it('without vision and without another provider, readRevision fails cleanly (the service shows its no-reading message)', async () => {
    const g = vi.fn(async () => json(completion(READING)));
    const err = await groq({ GROQ_VISION_MODEL: 'off' }, g as unknown as typeof fetch).readRevision(revisionInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect((err as AiRequestError).retryable).toBe(false);
    expect((err as Error).message).toMatch(/vision/i);
    expect(g).not.toHaveBeenCalled();
  });

  it('transient failures (5xx after retries) are not handed to the fallback: the error surfaces', async () => {
    const g = vi.fn(async () => httpError(503));
    const fb = fallbackFetch();
    const err = await groq({}, g as unknown as typeof fetch, fallbackProvider(fb as unknown as typeof fetch)).readRevision(revisionInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect((err as AiRequestError).status).toBe(503);
    expect(fb).not.toHaveBeenCalled();
  });
});

describe('provider selection with Groq', () => {
  it('auto-detects OpenAI → Groq → Gemini → Grok by available key', () => {
    const all = { OPENAI_API_KEY: 'a', GROQ_API_KEY: KEY, GEMINI_API_KEY: 'b', XAI_API_KEY: 'c' };
    expect(selectProvider(all).provider?.name).toBe('openai');
    expect(selectProvider({ ...all, OPENAI_API_KEY: '' }).provider?.name).toBe('groq');
    expect(selectProvider({ GEMINI_API_KEY: 'b', XAI_API_KEY: 'c' }).provider?.name).toBe('gemini');
    expect(selectProvider({ GROQ_API_KEY: KEY, XAI_API_KEY: 'c' }).provider?.name).toBe('groq');
  });

  it('AI_PROVIDER=groq needs GROQ_API_KEY; unknown names list groq', () => {
    expect(selectProvider({ AI_PROVIDER: 'groq', OPENAI_API_KEY: 'a', GROQ_API_KEY: KEY }).provider?.name).toBe('groq');
    const missing = selectProvider({ AI_PROVIDER: 'groq', XAI_API_KEY: 'c' });
    expect(missing).toMatchObject({ mode: 'off', provider: null });
    expect(missing.reason).toMatch(/GROQ_API_KEY/);
    expect(selectProvider({ AI_PROVIDER: 'nope' }).reason).toMatch(/groq/);
    expect(selectProvider({}).reason).toMatch(/GROQ_API_KEY/);
  });

  it('a Grok (xAI) key never selects Groq, and vice versa', () => {
    expect(selectProvider({ XAI_API_KEY: 'xai-123' }).provider?.name).toBe('grok');
    expect(selectProvider({ GROQ_API_KEY: KEY }).provider?.name).toBe('groq');
  });

  it('DEMO_MODE, fake and INKLING_DISABLE_AI are unchanged by a Groq key', () => {
    expect(selectProvider({ DEMO_MODE: '1', GROQ_API_KEY: KEY }).mode).toBe('demo');
    expect(selectProvider({ AI_PROVIDER: 'fake', GROQ_API_KEY: KEY }).provider?.name).toBe('fake');
    expect(selectProvider({ INKLING_DISABLE_AI: '1', GROQ_API_KEY: KEY }).mode).toBe('off');
  });

  it('status and /about show Groq and its model (never the key)', () => {
    const status = aiStatusFrom(selectProvider({ GROQ_API_KEY: KEY, GROQ_MODEL: 'openai/gpt-oss-20b' }));
    expect(status).toEqual({ enabled: true, mode: 'live', provider: 'groq', model: 'openai/gpt-oss-20b' });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(aiLabel(status)).toBe('Groq · openai/gpt-oss-20b');
  });

  it('with AI_PROVIDER=groq and another key, readRevision falls back to that provider when Groq vision is off', async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith('https://api.openai.com') ? json({ ...completion(READING), model: 'gpt-5-mini' }) : httpError(500),
    );
    const sel = selectProvider(
      { AI_PROVIDER: 'groq', GROQ_API_KEY: KEY, GROQ_VISION_MODEL: 'none', OPENAI_API_KEY: 'sk-a' },
      { fetch: f as unknown as typeof fetch },
    );
    await expect(sel.provider!.readRevision(revisionInput)).resolves.toMatchObject({ conceptLabel: 'Chain rule' });
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://api.openai.com/v1/chat/completions');
  });
});
