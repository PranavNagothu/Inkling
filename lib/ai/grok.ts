import "server-only";

// xAI Grok through its OpenAI-compatible endpoint (structured outputs + image inputs).
// XAI_MODEL / XAI_BASE_URL override the defaults.
import { envKey, trimSlash, type CompatConfig, type Env } from './compat';

export const DEFAULT_GROK_MODEL = 'grok-4-fast-non-reasoning';
export const XAI_BASE_URL = 'https://api.x.ai/v1';

export function grokConfig(env: Env): CompatConfig | null {
  const apiKey = envKey(env, 'XAI_API_KEY');
  if (!apiKey) return null;
  return {
    name: 'grok',
    baseUrl: trimSlash(envKey(env, 'XAI_BASE_URL') ?? XAI_BASE_URL),
    apiKey,
    model: envKey(env, 'XAI_MODEL') ?? DEFAULT_GROK_MODEL,
    tokenParam: 'max_tokens',
  };
}
