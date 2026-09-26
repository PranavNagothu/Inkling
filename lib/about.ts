// Labels for the About / System page: which backend, AI provider, voice and lecture sources are in
// use. Pure and client-safe; never includes keys or connection strings.
import type { AiStatus, ProviderName } from "./ai/types";
import type { DbInfo } from "./dbShared";
import { DEMO_LECTURE } from "./demo";

const PROVIDER: Record<ProviderName, string> = {
  openai: "OpenAI",
  groq: "Groq",
  gemini: "Google Gemini",
  grok: "xAI Grok",
  fake: "Fake provider",
};

export function aiLabel(ai: AiStatus): string {
  if (ai.mode === "demo") return "Demo fixtures (DEMO_MODE, offline) — hand-checked cards for the demo lecture";
  if (ai.mode === "fake") return "Fake provider (deterministic, offline)";
  if (!ai.enabled || !ai.provider) return "Off — add OPENAI_API_KEY, GROQ_API_KEY, GEMINI_API_KEY or XAI_API_KEY to .env.local";
  return `${PROVIDER[ai.provider]} · ${ai.model}`;
}

export type VoiceInfo = { kind: "elevenlabs"; model: string } | { kind: "openai"; model: string; voice: string } | null;

export function voiceLabel(voice: VoiceInfo, opts: { demoMode?: boolean } = {}): string {
  if (!voice && opts.demoMode) return "Browser voice (speechSynthesis) — DEMO_MODE keeps read-aloud offline";
  if (!voice) return "Browser voice (speechSynthesis) — no ElevenLabs / OpenAI voice configured";
  return voice.kind === "elevenlabs" ? `ElevenLabs · ${voice.model}` : `OpenAI TTS · ${voice.model} (${voice.voice})`;
}

export function storageLabel(info: DbInfo): string {
  if (info.backend === "postgres") return info.timescale ? "Postgres + TimescaleDB (Tiger Data)" : "Postgres";
  return "SQLite (local file)";
}

export const MIT_OCW_ATTRIBUTION =
  "Lecture: MIT OpenCourseWare 18.01 Single Variable Calculus, CC BY-NC-SA — ocw.mit.edu";

export const DEMO_LECTURE_NOTE =
  "The bundled demo lecture is synthetic: a generated six-minute chain-rule talk with a word-timed transcript, made for offline demos (scripts/make-demo-audio.mjs, make-demo-transcript.mjs).";

const MIT = /\b18\.01\b|\bMIT\b|OpenCourseWare|\bOCW\b/i;

export function lectureAttribution(lecture: { id: string; title: string }): { kind: "mit" | "demo" | "user"; text: string | null } {
  if (MIT.test(lecture.title)) return { kind: "mit", text: MIT_OCW_ATTRIBUTION };
  if (lecture.id === DEMO_LECTURE.lectureId) return { kind: "demo", text: DEMO_LECTURE_NOTE };
  return { kind: "user", text: null };
}
