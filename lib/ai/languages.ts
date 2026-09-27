// Languages a student can have help cards, check questions and recaps in (equity for ESL
// students). Client-safe: the picker, the server routes and the prompts all read this one list,
// and a language reaches a prompt or a URL only as one of these fixed codes, never as free text.

export interface Language {
  /** ISO 639-1 code: the only form a language takes in requests, cache keys and storage. */
  code: string;
  /** English name, used in prompts ("Write in Spanish"). */
  name: string;
  /** How the language names itself, shown in the picker. */
  native: string;
  /** BCP 47 tag for speech (SpeechSynthesisUtterance.lang) and the `lang` attribute. */
  bcp47: string;
  /** Right-to-left script. */
  rtl?: boolean;
}

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', bcp47: 'en-US' },
  { code: 'es', name: 'Spanish', native: 'Español', bcp47: 'es-US' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', bcp47: 'hi-IN' },
  { code: 'zh', name: 'Mandarin Chinese (Simplified characters)', native: '中文（普通话）', bcp47: 'zh-CN' },
  { code: 'ar', name: 'Arabic (Modern Standard)', native: 'العربية', bcp47: 'ar-SA', rtl: true },
  { code: 'fr', name: 'French', native: 'Français', bcp47: 'fr-FR' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', bcp47: 'te-IN' },
  { code: 'ko', name: 'Korean', native: '한국어', bcp47: 'ko-KR' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', bcp47: 'vi-VN' },
  { code: 'pt', name: 'Portuguese (Brazilian)', native: 'Português', bcp47: 'pt-BR' },
] as const satisfies readonly Language[];

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** localStorage key for the student's choice (a per-device convenience, not account data). */
export const LANGUAGE_STORAGE_KEY = 'inkling.helpLanguage';

const BY_CODE = new Map<string, Language>(LANGUAGES.map((l) => [l.code, l]));

/** A supported language code, or null (anything else: wrong type, unknown code, other casing). */
export function parseLanguage(value: unknown): LanguageCode | null {
  return typeof value === 'string' && BY_CODE.has(value) ? (value as LanguageCode) : null;
}

export function languageInfo(code: LanguageCode): Language {
  return BY_CODE.get(code)!;
}

/**
 * The `language` of a small JSON request body. An empty body (or one without `language`) means
 * English, so older clients keep working; anything else must be a supported code.
 */
export function languageFromBody(text: string): { ok: true; language: LanguageCode; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, language: DEFAULT_LANGUAGE, body: {} };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const raw = (body as { language?: unknown }).language;
  if (raw === undefined) return { ok: true, language: DEFAULT_LANGUAGE, body: body as Record<string, unknown> };
  const language = parseLanguage(raw);
  if (!language) return { ok: false, error: `language must be one of ${LANGUAGES.map((l) => l.code).join(', ')}` };
  return { ok: true, language, body: body as Record<string, unknown> };
}
