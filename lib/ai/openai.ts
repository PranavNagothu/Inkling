import "server-only";

// OpenAI (Chat Completions, structured outputs, vision). Default model: gpt-5-mini — current,
// vision-capable, supports strict JSON schemas and is the cheap tier of the GPT-5 family; override
// with OPENAI_MODEL. Reasoning models (gpt-5*, o-series) get reasoning_effort (OPENAI_REASONING_EFFORT,
// default "minimal") so answers come back well inside the 10 s budget.
import { envKey, trimSlash, type CompatConfig, type Env } from './compat';

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const isReasoningModel = (model: string) => /^(gpt-5|o\d)/i.test(model);

export function openAiConfig(env: Env): CompatConfig | null {
  const apiKey = envKey(env, 'OPENAI_API_KEY');
  if (!apiKey) return null;
  const model = envKey(env, 'OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
  const effort = envKey(env, 'OPENAI_REASONING_EFFORT') ?? 'minimal';
  return {
    name: 'openai',
    baseUrl: trimSlash(envKey(env, 'OPENAI_BASE_URL') ?? OPENAI_BASE_URL),
    apiKey,
    model,
    tokenParam: 'max_completion_tokens',
    extraBody: isReasoningModel(model) ? { reasoning_effort: effort } : {},
  };
}
