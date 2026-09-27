"use client";

import { useEffect, useId, useState } from "react";
import { languageInfo, type LanguageCode } from "@/lib/ai/languages";
import type { RecapPayload } from "@/lib/recap";
import { SpeakerIcon, StopIcon } from "./icons";
import { useHelpLanguage } from "./useHelpLanguage";
import { useReadAloud } from "./useReadAloud";

type Loaded = { key: string; recap: RecapPayload } | { key: string; error: string };

/**
 * "Hear your recap": a ≤ 90-word spoken summary of the session (corrections, gaps, breakthroughs,
 * what to review next) in the student's language, built on the server (POST …/recap). A server
 * voice (ElevenLabs / OpenAI) reads it when one is configured, otherwise the browser does (with
 * lib/readAloud's watchdog); the transcript is shown with it. `version` changes whenever the
 * timeline does (analysis, check answers), so the recap never describes an older state.
 */
export default function SessionRecap({ sessionId, serverVoice, version }: { sessionId: string; serverVoice?: boolean; version: string }) {
  const [language] = useHelpLanguage();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [showText, setShowText] = useState(false);
  const textId = useId();
  const key = `${sessionId}|${language}|${version}`;

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/recap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language }),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Partial<RecapPayload> & { error?: string };
        if (!res.ok || typeof body.text !== "string") {
          setLoaded({ key, error: body.error ?? "Couldn’t prepare your recap." });
          return;
        }
        setLoaded({ key, recap: body as RecapPayload });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoaded({ key, error: "Couldn’t reach the server." });
      });
    return () => ctrl.abort();
    // `key` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, language, version]);

  // Keep showing the previous recap while a newer one loads (no flicker on every check answer).
  const recap = loaded && "recap" in loaded ? loaded.recap : null;
  const stale = !loaded || loaded.key !== key;
  const spoken: LanguageCode = recap?.language ?? "en";
  const info = languageInfo(spoken);

  const { state, voice, hint, start, stop } = useReadAloud({
    resetKey: sessionId,
    text: recap?.text ?? "",
    ttsUrl: recap?.audioUrl ?? "",
    // No audio URL: the server has no voice, so speak in the browser right away (inside the tap).
    serverVoice: recap?.audioUrl ? serverVoice : false,
    language: spoken,
  });
  const active = state === "speaking" || state === "loading";

  return (
    <section data-testid="session-recap" aria-label="Session recap" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          data-testid="recap-play"
          data-state={state}
          aria-pressed={active}
          aria-describedby={showText && recap ? textId : undefined}
          disabled={!recap && !active}
          onClick={() => {
            if (active) return stop();
            setShowText(true);
            start();
          }}
          className={`press inline-flex min-h-11 items-center gap-2 rounded-pill border px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
            active ? "border-accent bg-accent-soft text-accent-press" : "border-line-strong bg-chrome text-ink hover:bg-chrome-hover"
          }`}
        >
          {active ? <StopIcon size={14} /> : <SpeakerIcon size={16} />}
          {state === "loading" ? "Preparing audio…" : state === "speaking" ? "Stop recap" : "Hear your recap"}
        </button>
        {recap && !showText ? (
          <button
            type="button"
            data-testid="recap-show-text"
            aria-expanded={false}
            aria-controls={textId}
            onClick={() => setShowText(true)}
            className="inline-flex min-h-11 items-center rounded-pill px-2 text-sm font-medium text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            Read transcript
          </button>
        ) : null}
        {voice ? (
          <span data-testid="recap-voice" className="text-xs text-ink-subtle">
            Voice: {voice}
          </span>
        ) : null}
        {state === "error" && hint ? (
          <span role="alert" data-testid="recap-hint" className="text-xs text-danger">
            {hint}
          </span>
        ) : null}
        {loaded && "error" in loaded && !stale ? (
          <span role="alert" data-testid="recap-error" className="text-xs text-ink-muted">
            {loaded.error}
          </span>
        ) : null}
      </div>
      {showText && recap ? (
        <div aria-live="polite" className="enter-soft flex max-w-prose flex-col gap-1">
          <p
            id={textId}
            data-testid="recap-text"
            data-language={spoken}
            lang={info.bcp47}
            dir={info.rtl ? "rtl" : "ltr"}
            className={`text-sm leading-relaxed text-pretty text-ink-muted transition-opacity duration-150 ${stale ? "opacity-60" : "opacity-100"}`}
          >
            {recap.text}
          </p>
          {recap.languageFallback ? (
            <p data-testid="recap-language-note" className="text-xs text-ink-subtle">
              {languageInfo(language).native} isn’t available for the recap right now — it’s in English.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
