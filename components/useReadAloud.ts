"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { languageInfo, type LanguageCode } from "@/lib/ai/languages";
import { createReadAloud, type ReadAloudController, type ReadAloudView } from "@/lib/readAloud";

export type { ReadAloudState } from "@/lib/readAloud";

/** Once the server says it has no voice, don't ask again on this page. */
const memo = { noServerVoice: false };

const IDLE: ReadAloudView = { state: "idle", voice: null, hint: null };

function browserController(onChange: (view: ReadAloudView) => void): ReadAloudController {
  const speech = "speechSynthesis" in window ? window.speechSynthesis : null;
  return createReadAloud({
    speech,
    createUtterance: speech && typeof SpeechSynthesisUtterance !== "undefined" ? (text) => new SpeechSynthesisUtterance(text) : null,
    createAudio: typeof Audio !== "undefined" ? () => new Audio() : null,
    fetch: (url, init) => fetch(url, init),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    onChange,
    memo,
  });
}

export interface ReadAloudOptions {
  /** Stops playback when it changes (the moment / session being read). */
  resetKey: string;
  text: string;
  /** POST endpoint returning audio/mpeg (503 without a server voice). */
  ttsUrl: string;
  /** AiStatus.tts: false = speak in the browser right away; undefined = ask the server first. */
  serverVoice?: boolean;
  /** The language `text` is in: sent to the server voice and set on the browser utterance. */
  language?: LanguageCode;
}

/**
 * Reads text aloud: the server's voice (ElevenLabs / OpenAI TTS, cached mp3) when configured,
 * otherwise the browser's speechSynthesis — see lib/readAloud for the iPad rules. `serverVoice`
 * is known from the page, so the first tap needs no round trip; `voice` names what was used and
 * `hint` explains an error. Used for a moment's explanation and for the session recap.
 */
export function useReadAloud({ resetKey, text, ttsUrl, serverVoice, language = "en" }: ReadAloudOptions) {
  const [view, setView] = useState<ReadAloudView>(IDLE);
  const ctrlRef = useRef<ReadAloudController | null>(null);

  useEffect(() => () => ctrlRef.current?.cancel(), [resetKey]);

  // Synchronous from the click handler all the way to speak()/play().
  const start = useCallback(() => {
    ctrlRef.current ??= browserController(setView);
    ctrlRef.current.start({
      text,
      ttsUrl,
      serverVoice,
      lang: languageInfo(language).bcp47,
      body: JSON.stringify({ language }),
    });
  }, [text, ttsUrl, serverVoice, language]);

  const stop = useCallback(() => {
    if (ctrlRef.current) ctrlRef.current.stop();
    else setView(IDLE);
  }, []);

  return { state: view.state, voice: view.voice, hint: view.hint, start, stop };
}
