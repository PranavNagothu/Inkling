import "server-only";

// Read-aloud voices. ElevenLabs when ELEVENLABS_API_KEY is set (voice ELEVENLABS_VOICE_ID), else
// OpenAI TTS when OPENAI_API_KEY is set, else none (the client falls back to the browser's
// speechSynthesis). Never on in tests (AI_PROVIDER=fake / INKLING_DISABLE_AI) or DEMO_MODE (offline).
import { sha256 } from './cache';
import { envKey, type Env } from './compat';
import { cleanUntrusted } from './prompts';

export const MAX_TTS_CHARS = 1200;
const DEFAULT_ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel", a stock ElevenLabs voice
const DEFAULT_ELEVEN_MODEL = 'eleven_flash_v2_5';
const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_OPENAI_VOICE = 'alloy';

export type TtsSelection =
  | { kind: 'elevenlabs'; apiKey: string; voiceId: string; model: string }
  | { kind: 'openai'; apiKey: string; voice: string; model: string };

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());
/** Voice ids and names go into URLs / bodies: plain tokens only. */
const safeToken = (v: string | null, fallback: string) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : fallback);

export function selectTts(env: Env = process.env): { tts: TtsSelection | null; reason: string } {
  if (truthy(env.DEMO_MODE)) return { tts: null, reason: 'DEMO_MODE=1 (offline)' };
  if (envKey(env, 'AI_PROVIDER')?.toLowerCase() === 'fake') return { tts: null, reason: 'AI_PROVIDER=fake' };
  if (truthy(env.INKLING_DISABLE_AI)) return { tts: null, reason: 'INKLING_DISABLE_AI=1' };
  const eleven = envKey(env, 'ELEVENLABS_API_KEY');
  if (eleven) {
    return {
      tts: {
        kind: 'elevenlabs',
        apiKey: eleven,
        voiceId: safeToken(envKey(env, 'ELEVENLABS_VOICE_ID'), DEFAULT_ELEVEN_VOICE),
        model: safeToken(envKey(env, 'ELEVENLABS_MODEL'), DEFAULT_ELEVEN_MODEL),
      },
      reason: 'ElevenLabs',
    };
  }
  const openai = envKey(env, 'OPENAI_API_KEY');
  if (openai) {
    return {
      tts: {
        kind: 'openai',
        apiKey: openai,
        voice: safeToken(envKey(env, 'OPENAI_TTS_VOICE'), DEFAULT_OPENAI_VOICE),
        model: safeToken(envKey(env, 'OPENAI_TTS_MODEL'), DEFAULT_OPENAI_TTS_MODEL),
      },
      reason: 'OpenAI TTS',
    };
  }
  return { tts: null, reason: 'No voice key: add ELEVENLABS_API_KEY or OPENAI_API_KEY to .env.local' };
}

/** Shown quietly next to the Read aloud button. */
export function ttsLabel(tts: TtsSelection): string {
  return tts.kind === 'elevenlabs' ? 'ElevenLabs' : `OpenAI · ${tts.voice}`;
}

const speakable = (text: string) => cleanUntrusted(text, MAX_TTS_CHARS - 1).replace(/…$/, '');

export function buildTtsRequest(tts: TtsSelection, text: string): { url: string; init: RequestInit } {
  const input = speakable(text);
  if (tts.kind === 'elevenlabs') {
    return {
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(tts.voiceId)}?output_format=mp3_44100_128`,
      init: {
        method: 'POST',
        headers: { 'xi-api-key': tts.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: input, model_id: tts.model }),
      },
    };
  }
  return {
    url: 'https://api.openai.com/v1/audio/speech',
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${tts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: tts.model, voice: tts.voice, input, response_format: 'mp3' }),
    },
  };
}

export function ttsCacheKey(tts: TtsSelection, text: string): string {
  const voice = tts.kind === 'elevenlabs' ? tts.voiceId : tts.voice;
  return sha256(JSON.stringify([tts.kind, voice, tts.model, speakable(text)]));
}

/** Calls the voice API: mp3 bytes. One retry on 429/5xx; 10 s budget. */
export async function synthesizeSpeech(
  tts: TtsSelection,
  text: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number; backoffMs?: number } = {},
): Promise<Uint8Array> {
  const doFetch = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const { url, init } = buildTtsRequest(tts, text);
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, { ...init, signal });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? '';
      if (!/^audio\//i.test(type)) {
        void res.body?.cancel().catch(() => {});
        throw new Error(`${tts.kind} TTS: expected audio, got ${type || 'no content type'}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    void res.body?.cancel().catch(() => {});
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, opts.backoffMs ?? 500));
      continue;
    }
    throw new Error(`${tts.kind} TTS: HTTP ${res.status}`);
  }
}
