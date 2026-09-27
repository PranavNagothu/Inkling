import "server-only";

// Groq (GroqCloud, keys start with gsk_ — not xAI's Grok, see ./grok) through its OpenAI-compatible
// endpoint https://api.groq.com/openai/v1 (docs: console.groq.com/docs/openai).
//
// Text (help cards, concept labels): GROQ_MODEL, default openai/gpt-oss-120b — a production model
// with strict JSON-schema structured outputs (console.groq.com/docs/structured-outputs), asked for
// low reasoning effort with the reasoning text left out of the response. Models without strict
// structured outputs fall back to JSON object mode, with ./validate and the repair retry enforcing
// the schema.
//
// Vision (revision reading): GROQ_VISION_MODEL, default qwen/qwen3.8-27b — Groq's only vision model
// (console.groq.com/docs/vision; a preview model), also strict-schema capable; reasoning off. When
// it is turned off (GROQ_VISION_MODEL=none) or rejects the request (400/404/413/415/422: model gone,
// image not accepted), readRevision goes to the next configured provider (OpenAI → Gemini → Grok),
// and without one it fails cleanly, so the service shows its "couldn't read this revision" note.
import { createCompatProvider, envKey, trimSlash, type CompatConfig, type Env } from './compat';
import { AiRequestError, type AiProvider, type CallOptions, type RevisionInput } from './types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';

/** Models that accept response_format json_schema with strict: true (Groq docs, Sept 2026). */
const STRICT_SCHEMA_MODELS = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);

const isGptOss = (model: string) => /^openai\/gpt-oss-(?!safeguard)/i.test(model);
const isQwen3 = (model: string) => /^qwen\/qwen3/i.test(model);

/**
 * Reasoning parameters per model family; other models get none (Groq answers 400 to values a model
 * doesn't support). GPT-OSS: low | medium | high. Qwen 3.x: none | default | low | medium | high.
 */
function reasoningBody(model: string, effort: string | null): Record<string, unknown> {
  if (isGptOss(model)) return { reasoning_effort: effort ?? 'low', include_reasoning: false };
  if (isQwen3(model)) return { reasoning_effort: effort ?? 'none' };
  return {};
}

function baseConfig(env: Env, apiKey: string, model: string, effort: string | null): CompatConfig {
  return {
    name: 'groq',
    baseUrl: trimSlash(envKey(env, 'GROQ_BASE_URL') ?? GROQ_BASE_URL),
    apiKey,
    model,
    tokenParam: 'max_completion_tokens',
    extraBody: reasoningBody(model, effort),
    responseFormat: STRICT_SCHEMA_MODELS.has(model) ? 'json_schema' : 'json_object',
  };
}

/** The text model's config, or null without GROQ_API_KEY. */
export function groqConfig(env: Env): CompatConfig | null {
  const apiKey = envKey(env, 'GROQ_API_KEY');
  if (!apiKey) return null;
  const model = envKey(env, 'GROQ_MODEL') ?? DEFAULT_GROQ_MODEL;
  return baseConfig(env, apiKey, model, envKey(env, 'GROQ_REASONING_EFFORT'));
}

/** The vision model's config; null without a key or when GROQ_VISION_MODEL turns vision off. */
export function groqVisionConfig(env: Env): CompatConfig | null {
  const apiKey = envKey(env, 'GROQ_API_KEY');
  if (!apiKey) return null;
  const model = envKey(env, 'GROQ_VISION_MODEL') ?? DEFAULT_GROQ_VISION_MODEL;
  if (/^(none|off|0|false|no)$/i.test(model)) return null;
  return baseConfig(env, apiKey, model, null);
}

/** Statuses meaning "this model can't take this request", worth another provider. */
const CAPABILITY_STATUSES = new Set([400, 404, 413, 415, 422]);

export interface GroqDeps {
  fetch?: typeof fetch;
  /** Reads handwriting when Groq vision is off or unsupported (the next configured provider). */
  visionFallback?: AiProvider | null;
  /** Deadline / retry overrides for the vision model (tests). */
  visionTuning?: Pick<CompatConfig, 'timeoutMs' | 'maxRetries' | 'backoffMs'>;
}

export function createGroqProvider(text: CompatConfig, vision: CompatConfig | null, deps: GroqDeps = {}): AiProvider {
  const textProvider = createCompatProvider({ ...text, fetch: deps.fetch ?? text.fetch });
  const visionProvider = vision ? createCompatProvider({ ...vision, ...deps.visionTuning, fetch: deps.fetch ?? vision.fetch }) : null;
  const fallback = deps.visionFallback ?? null;

  async function readRevision(input: RevisionInput, opts?: CallOptions) {
    if (visionProvider) {
      try {
        return await visionProvider.readRevision(input, opts);
      } catch (err) {
        const capability = err instanceof AiRequestError && err.status !== null && CAPABILITY_STATUSES.has(err.status);
        if (!fallback || !capability) throw err;
        console.warn(`groq vision (${vision!.model}) unavailable (${err.message}); reading with ${fallback.name}`);
      }
    }
    if (fallback) return fallback.readRevision(input, opts);
    throw new AiRequestError('groq: no vision model (GROQ_VISION_MODEL is off) and no other provider key for reading handwriting', null, false);
  }

  return {
    name: 'groq',
    model: text.model,
    helpFor: textProvider.helpFor,
    labelConcept: textProvider.labelConcept,
    localizeHelp: textProvider.localizeHelp,
    polishRecap: textProvider.polishRecap,
    readRevision,
  };
}
