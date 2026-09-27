import "server-only";

// Optional Whisper transcription: OpenAI (whisper-1) when OPENAI_API_KEY is set, else Groq
// (whisper-large-v3-turbo, GROQ_TRANSCRIBE_MODEL to change) when GROQ_API_KEY is set. Both take a
// multipart upload with response_format=verbose_json and timestamp_granularities[]=word, and both
// cap direct uploads at 25 MB (Groq: console.groq.com/docs/speech-to-text). Never called by tests
// against the network (they pass a mock fetch).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { envKey, trimSlash, type Env } from "./ai/compat";
import { isDemoMode } from "./demoMode";
import { GROQ_BASE_URL } from "./ai/groq";
import { whisperToWords, type WhisperVerboseResponse } from "./whisper";
import type { TranscriptWord } from "./types";

/** OpenAI's and Groq's audio endpoints both reject direct uploads above 25 MB. */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

export const DEFAULT_GROQ_TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Transcriber {
  provider: "openai" | "groq";
  /** Shown in error messages. */
  label: string;
  url: string;
  apiKey: string;
  model: string;
  maxBytes: number;
}

/**
 * Which Whisper service transcribes lectures, or null (no key, INKLING_DISABLE_AI=1, or DEMO_MODE:
 * the public demo is offline even when GROQ_API_KEY is set for the landing assistant).
 */
export function selectTranscriber(env: Env = process.env): Transcriber | null {
  if (env.INKLING_DISABLE_AI === "1" || isDemoMode(env)) return null;
  const openai = envKey(env, "OPENAI_API_KEY");
  if (openai) {
    return {
      provider: "openai",
      label: "OpenAI",
      url: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: openai,
      model: "whisper-1",
      maxBytes: TRANSCRIBE_MAX_BYTES,
    };
  }
  const groq = envKey(env, "GROQ_API_KEY");
  if (groq) {
    return {
      provider: "groq",
      label: "Groq",
      url: `${trimSlash(envKey(env, "GROQ_BASE_URL") ?? GROQ_BASE_URL)}/audio/transcriptions`,
      apiKey: groq,
      model: envKey(env, "GROQ_TRANSCRIBE_MODEL") ?? DEFAULT_GROQ_TRANSCRIBE_MODEL,
      maxBytes: TRANSCRIBE_MAX_BYTES,
    };
  }
  return null;
}

const tooLarge = (t: Transcriber) =>
  new TranscribeError(
    `Auto-transcribe with ${t.label} works on files up to ${Math.round(t.maxBytes / (1024 * 1024))} MB. Upload captions instead, or compress the audio (e.g. 16 kHz mono).`,
    413,
  );

export async function transcribeFile(
  absPath: string,
  mime: string,
  size: number,
  deps: { env?: Env; fetch?: typeof fetch } = {},
): Promise<TranscriptWord[]> {
  const t = selectTranscriber(deps.env ?? process.env);
  if (!t) throw new TranscribeError("AI not configured", 503);
  if (size > t.maxBytes) throw tooLarge(t);

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(await readFile(absPath))], { type: mime }), basename(absPath));
  form.append("model", t.model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(t.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch {
    throw new TranscribeError("Could not reach the transcription service.", 502);
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    console.error(`${t.provider} whisper transcription failed`, res.status);
    if (res.status === 413) throw tooLarge(t);
    throw new TranscribeError("Transcription failed.", 502);
  }
  const words = whisperToWords((await res.json()) as WhisperVerboseResponse);
  if (words.length === 0) throw new TranscribeError("No speech was recognised.", 422);
  return words;
}
