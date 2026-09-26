import "server-only";

// Google Gemini through its OpenAI-compatible endpoint (structured outputs + image_url data URLs).
// GEMINI_MODEL / GEMINI_BASE_URL override the defaults.
import { envKey, trimSlash, type CompatConfig, type Env } from './compat';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export function geminiConfig(env: Env): CompatConfig | null {
  const apiKey = envKey(env, 'GEMINI_API_KEY');
  if (!apiKey) return null;
  return {
    name: 'gemini',
    baseUrl: trimSlash(envKey(env, 'GEMINI_BASE_URL') ?? GEMINI_BASE_URL),
    apiKey,
    model: envKey(env, 'GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
    tokenParam: 'max_tokens',
  };
}
