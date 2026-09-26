import "server-only";

// One client for every OpenAI-compatible Chat Completions API (OpenAI, Groq, Gemini's and xAI's
// compatibility endpoints): strict JSON-schema structured output, image inputs as data URLs, an
// overall deadline, retries on 429 / 5xx / network errors, and one repair retry when the answer
// doesn't validate. The API key only ever goes into the Authorization header.
import {
  HELP_SCHEMA,
  LABEL_SCHEMA,
  REVISION_SCHEMA,
  buildHelpMessages,
  buildLabelMessages,
  buildRevisionMessages,
  type ChatMessage,
  type JsonSchemaSpec,
} from './prompts';
import { AiInvalidOutputError, AiRequestError, type AiProvider, type CallOptions, type ProviderName } from './types';
import { validateConceptLabel, validateHelpCard, validateRevisionReading, type Validated } from './validate';

export type Env = Record<string, string | undefined>;

export interface CompatConfig {
  name: Exclude<ProviderName, 'fake'>;
  /** Without the trailing slash, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenAI wants max_completion_tokens; the compatibility endpoints take max_tokens. */
  tokenParam: 'max_completion_tokens' | 'max_tokens';
  /** Extra body fields (e.g. reasoning_effort). */
  extraBody?: Record<string, unknown>;
  /**
   * 'json_schema' (default): strict structured output. 'json_object': JSON mode for models without
   * strict schemas; the schema is then spelled out in a system message, and ./validate plus the
   * repair retry enforce it.
   */
  responseFormat?: 'json_schema' | 'json_object';
  /** Overall deadline per call, retries included. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Base of the exponential backoff between retries. */
  backoffMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULTS = { timeoutMs: 10_000, maxRetries: 2, backoffMs: 400, maxRetryAfterMs: 3_000 } as const;

/** Token caps per kind (a cap, not a cost: usage is billed). Room for minimal reasoning. */
const MAX_TOKENS = { help: 1500, revision: 1000, label: 300 } as const;

/** A key from the environment, or null when unset / blank. */
export function envKey(env: Env, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

export const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** JSON object mode: the schema goes into a system message right after the rules. */
function withSchemaInstruction(messages: ChatMessage[], schema: JsonSchemaSpec): ChatMessage[] {
  const instruction: ChatMessage = {
    role: 'system',
    content: `Reply with one JSON object that matches this JSON Schema exactly (every property required, no others): ${JSON.stringify(schema.schema)}`,
  };
  const at = messages.findIndex((m) => m.role !== 'system');
  const split = at === -1 ? messages.length : at;
  return [...messages.slice(0, split), instruction, ...messages.slice(split)];
}

export function buildChatRequest(
  cfg: CompatConfig,
  messages: ChatMessage[],
  schema: JsonSchemaSpec,
  maxTokens: number,
): { url: string; init: RequestInit } {
  const jsonObject = cfg.responseFormat === 'json_object';
  const body = {
    model: cfg.model,
    messages: jsonObject ? withSchemaInstruction(messages, schema) : messages,
    response_format: jsonObject
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } },
    [cfg.tokenParam]: maxTokens,
    ...cfg.extraBody,
  };
  return {
    url: `${trimSlash(cfg.baseUrl)}/chat/completions`,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null };
  }>;
}

/** The JSON object a chat completion carries. Throws AiInvalidOutputError when there isn't one. */
export function parseChatContent(json: unknown): unknown {
  const choice = (json as ChatResponse | null)?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new AiInvalidOutputError('no message in the response', ['the response had no message']);
  if (message.refusal) throw new AiInvalidOutputError('the model refused', ['the model refused to answer']);
  if (choice.finish_reason === 'length') {
    throw new AiInvalidOutputError('the answer was cut off', ['the answer was cut off; keep it shorter']);
  }
  const text =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((p) => (p?.type === 'text' || p?.type === undefined ? (p?.text ?? '') : '')).join('')
        : '';
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    throw new AiInvalidOutputError('the answer was not JSON', ['the answer must be a single JSON object']);
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export function createCompatProvider(cfg: CompatConfig): AiProvider {
  const timeoutMs = cfg.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRetries = cfg.maxRetries ?? DEFAULTS.maxRetries;
  const backoffMs = cfg.backoffMs ?? DEFAULTS.backoffMs;
  const doFetch = cfg.fetch ?? fetch;

  /** One chat call with retries on transient failures, inside the shared deadline signal. */
  async function chat(messages: ChatMessage[], schema: JsonSchemaSpec, maxTokens: number, signal: AbortSignal): Promise<unknown> {
    const { url, init } = buildChatRequest(cfg, messages, schema, maxTokens);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, signal });
      } catch {
        if (signal.aborted) throw abortError(signal);
        if (attempt >= maxRetries) throw new AiRequestError(`${cfg.name}: network error`, null, true);
        await sleep(backoffMs * 2 ** attempt, signal).catch(() => {
          throw abortError(signal);
        });
        continue;
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          if (signal.aborted) throw abortError(signal);
          throw new AiInvalidOutputError('the response was not JSON', ['the answer must be a single JSON object']);
        }
        return parseChatContent(json);
      }
      void res.body?.cancel().catch(() => {});
      const retryable = RETRYABLE.has(res.status);
      if (!retryable || attempt >= maxRetries) {
        throw new AiRequestError(`${cfg.name}: HTTP ${res.status}`, res.status, retryable);
      }
      const wait = Math.min(retryAfterMs(res) ?? backoffMs * 2 ** attempt, DEFAULTS.maxRetryAfterMs);
      await sleep(wait, signal).catch(() => {
        throw abortError(signal);
      });
    }
  }

  function abortError(signal: AbortSignal): AiRequestError {
    const reason = signal.reason as { name?: string } | undefined;
    return reason?.name === 'TimeoutError'
      ? new AiRequestError(`${cfg.name}: timed out after ${timeoutMs} ms`, null, true)
      : new AiRequestError(`${cfg.name}: aborted`, null, false);
  }

  /** chat + validate, with one repair retry when the answer is invalid. */
  async function generate<T>(
    build: (repair?: string) => ChatMessage[],
    schema: JsonSchemaSpec,
    maxTokens: number,
    validate: (raw: unknown) => Validated<T>,
    opts: CallOptions = {},
  ): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    let issues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: unknown;
      try {
        raw = await chat(build(attempt === 0 ? undefined : issues.join('; ')), schema, maxTokens, signal);
      } catch (err) {
        if (!(err instanceof AiInvalidOutputError)) throw err;
        issues = err.issues;
        continue;
      }
      const v = validate(raw);
      if (v.ok) return v.value;
      issues = v.issues;
    }
    throw new AiInvalidOutputError(`${cfg.name}: invalid answer after a retry`, issues);
  }

  return {
    name: cfg.name,
    model: cfg.model,
    helpFor: (ctx, opts) => generate((r) => buildHelpMessages(ctx, { repair: r }), HELP_SCHEMA, MAX_TOKENS.help, validateHelpCard, opts),
    readRevision: (input, opts) =>
      generate((r) => buildRevisionMessages(input, { repair: r }), REVISION_SCHEMA, MAX_TOKENS.revision, validateRevisionReading, opts),
    labelConcept: (text, opts) =>
      generate((r) => buildLabelMessages(text, { repair: r }), LABEL_SCHEMA, MAX_TOKENS.label, validateConceptLabel, opts),
  };
}
