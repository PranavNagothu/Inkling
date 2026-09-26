"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Reads a moment's re-explanation aloud: the server's voice (ElevenLabs / OpenAI TTS, cached mp3)
 * when configured, otherwise the browser's speechSynthesis — see lib/readAloud for the iPad rules.
 * `serverVoice` is AiStatus.tts (known from the page, so the first tap needs no round trip);
 * `voice` names what was used and `hint` explains an error.
 */
export function useReadAloud(eventId: string, text: string, serverVoice?: boolean) {
  const [view, setView] = useState<ReadAloudView>(IDLE);
  const ctrlRef = useRef<ReadAloudController | null>(null);

  useEffect(() => () => ctrlRef.current?.cancel(), [eventId]);

  // Synchronous from the click handler all the way to speak()/play().
  const start = useCallback(() => {
    ctrlRef.current ??= browserController(setView);
    ctrlRef.current.start({ text, ttsUrl: `/api/events/${encodeURIComponent(eventId)}/tts`, serverVoice });
  }, [eventId, text, serverVoice]);

  const stop = useCallback(() => {
    if (ctrlRef.current) ctrlRef.current.stop();
    else setView(IDLE);
  }, []);

  return { state: view.state, voice: view.voice, hint: view.hint, start, stop };
}
