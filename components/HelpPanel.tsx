"use client";

import { useEffect, useId, useState } from "react";
import type { AiStatus } from "@/lib/ai/types";
import type { PublicHelpCard, TimelineEvent } from "@/lib/types";
import { CheckIcon, SparkleIcon, SpeakerIcon, StopIcon } from "./icons";
import { MomentGlyph } from "./Timeline";
import { useReadAloud } from "./useReadAloud";

type HelpState =
  | { kind: "loading" }
  | { kind: "nokey" }
  | { kind: "error"; message: string }
  | { kind: "ready"; help: PublicHelpCard };

type Feedback =
  | { result: "correct"; why: string; answerIdx: number; type: TimelineEvent["type"] }
  | { result: "wrong"; why: string; chosen: number };

interface CheckResponse {
  correct: boolean;
  why: string;
  answerIdx?: number;
  event: TimelineEvent;
  events: TimelineEvent[];
}

const SOURCE_LABEL: Record<PublicHelpCard["source"], string> = {
  ai: "AI",
  demo: "Demo",
  fallback: "Offline tip",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{children}</h3>;
}

/** Quiet card shown when no AI provider is configured; everything else keeps working. */
function NoKeyCard() {
  return (
    <div data-testid="help-nokey" className="rounded-md border border-dashed border-line-strong px-3 py-3 text-sm text-pretty text-ink-muted">
      AI explanations need an API key — add <code className="font-mono text-xs text-ink">OPENAI_API_KEY</code> to{" "}
      <code className="font-mono text-xs text-ink">.env.local</code>
    </div>
  );
}

function Skeleton() {
  return (
    <div data-testid="help-loading" aria-busy="true" aria-live="polite" className="flex flex-col gap-2.5">
      <span className="sr-only">Preparing an explanation…</span>
      {["w-full", "w-11/12", "w-4/5"].map((w) => (
        <span key={w} aria-hidden="true" className={`h-3 ${w} rounded-pill bg-line motion-safe:animate-pulse`} />
      ))}
      <span aria-hidden="true" className="mt-2 h-3 w-2/3 rounded-pill bg-line motion-safe:animate-pulse" />
      {[0, 1, 2, 3].map((i) => (
        <span key={i} aria-hidden="true" className="h-11 w-full rounded-md border border-line bg-desk/60 motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

function ReadAloud({ eventId, text, serverVoice }: { eventId: string; text: string; serverVoice?: boolean }) {
  const { state, voice, hint, start, stop } = useReadAloud(eventId, text, serverVoice);
  const active = state === "speaking" || state === "loading";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        data-testid="read-aloud"
        data-state={state}
        aria-pressed={active}
        onClick={() => (active ? stop() : start())}
        className={`press inline-flex min-h-11 items-center gap-2 rounded-pill border px-4 text-sm font-semibold ${
          active ? "border-accent bg-accent-soft text-accent-press" : "border-line-strong bg-chrome text-ink hover:bg-chrome-hover"
        }`}
      >
        {active ? <StopIcon size={14} /> : <SpeakerIcon size={16} />}
        {state === "loading" ? "Preparing audio…" : state === "speaking" ? "Stop reading" : "Read aloud"}
      </button>
      {voice ? (
        <span data-testid="read-aloud-voice" className="text-xs text-ink-subtle">
          Voice: {voice}
        </span>
      ) : null}
      {state === "error" && hint ? (
        <span role="alert" data-testid="read-aloud-hint" className="text-xs text-danger">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Phase 5: the moment's re-explanation (lazily generated, cached on the server), a Read aloud
 * button, and a 4-option check question graded on the server. A correct answer on a corrected
 * misconception makes it a breakthrough; a wrong one reopens it (retry allowed).
 */
export default function HelpPanel({
  event,
  ai,
  onEventsChange,
}: {
  event: TimelineEvent;
  ai: AiStatus;
  onEventsChange: (events: TimelineEvent[]) => void;
}) {
  const [state, setState] = useState<HelpState>(ai.enabled ? { kind: "loading" } : { kind: "nokey" });
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [wrong, setWrong] = useState<number[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const name = useId();
  const eventId = event.id;

  useEffect(() => {
    if (!ai.enabled) return;
    const ctrl = new AbortController();
    fetch(`/api/events/${encodeURIComponent(eventId)}/help`, { method: "POST", signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 503) return setState({ kind: "nokey" });
        const body = (await res.json().catch(() => ({}))) as { help?: PublicHelpCard; event?: TimelineEvent; error?: string };
        if (!res.ok || !body.help) {
          setState({ kind: "error", message: body.error ?? "Couldn’t prepare an explanation." });
          return;
        }
        setState({ kind: "ready", help: body.help });
        // The concept may have just been given a better name.
        if (body.event) onEventsChange([body.event]);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ kind: "error", message: "Couldn’t reach the server." });
      });
    return () => ctrl.abort();
    // onEventsChange is a stable merge callback; re-fetching only depends on the moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, ai.enabled, attempt]);

  if (state.kind === "nokey") return <NoKeyCard />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (choice === null || pending) return;
    setPending(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choiceIdx: choice }),
      });
      if (!res.ok) throw new Error(`check failed: ${res.status}`);
      const body = (await res.json()) as CheckResponse;
      onEventsChange(body.events);
      if (body.correct) {
        setFeedback({ result: "correct", why: body.why, answerIdx: body.answerIdx ?? choice, type: body.event.type });
      } else {
        setFeedback({ result: "wrong", why: body.why, chosen: choice });
        setWrong((w) => [...w, choice]);
        setChoice(null);
      }
    } catch {
      setSubmitError("Couldn’t save your answer — try again.");
    } finally {
      setPending(false);
    }
  };

  const last = event.checkAttempts[event.checkAttempts.length - 1];
  // Solved earlier (e.g. after a reload): the card remembers it.
  const solvedBefore = !feedback && !!last?.correct;
  const solved = feedback?.result === "correct" || solvedBefore;
  const breakthrough = event.type === "breakthrough";

  return (
    <section data-testid="help-card" aria-labelledby={`${name}-title`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>
          <span id={`${name}-title`}>Let’s re-explain it</span>
        </SectionLabel>
        {state.kind === "ready" ? (
          <span
            data-testid="help-source"
            data-source={state.help.source}
            className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-press"
          >
            <SparkleIcon size={11} />
            {SOURCE_LABEL[state.help.source]}
            {state.help.source === "ai" ? ` · ${state.help.provider}` : ""}
          </span>
        ) : null}
      </div>

      {state.kind === "loading" ? <Skeleton /> : null}

      {state.kind === "error" ? (
        <div data-testid="help-error" role="alert" className="flex flex-wrap items-center gap-3 text-sm text-pretty text-ink-muted">
          {state.message}
          <button
            type="button"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
            className="press inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-chrome px-4 text-sm font-semibold text-ink hover:bg-chrome-hover"
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <div className="enter-soft flex flex-col gap-4">
          <p data-testid="help-reexplain" className="text-sm leading-relaxed text-pretty text-ink">
            {state.help.reexplain}
          </p>
          <ReadAloud eventId={eventId} text={state.help.reexplain} serverVoice={ai.tts} />

          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <fieldset data-testid="check-question" disabled={solved || pending} className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-semibold text-balance text-ink">{state.help.mcq.q}</legend>
              {state.help.mcq.options.map((option, i) => {
                const isWrong = wrong.includes(i);
                const isRight = feedback?.result === "correct" && feedback.answerIdx === i;
                const selected = choice === i;
                const tone = isRight
                  ? "border-breakthrough bg-breakthrough-soft text-breakthrough-strong"
                  : isWrong
                    ? "border-gap/40 bg-gap-soft/60 text-ink-muted line-through decoration-gap/60"
                    : selected
                      ? "border-accent bg-accent-soft text-ink"
                      : "border-line bg-chrome text-ink hover:bg-chrome-hover";
                return (
                  <label
                    key={i}
                    data-testid="check-option"
                    data-state={isRight ? "correct" : isWrong ? "wrong" : selected ? "selected" : "idle"}
                    className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm text-pretty transition-[background-color,border-color,color] duration-150 has-[:disabled]:cursor-default has-[:focus-visible]:shadow-[var(--focus-ring)] ${tone}`}
                  >
                    <input
                      type="radio"
                      name={name}
                      value={i}
                      checked={selected}
                      onChange={() => {
                        setChoice(i);
                        setSubmitError(null);
                      }}
                      className="size-4 shrink-0 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1">{option}</span>
                    {isRight ? <CheckIcon size={16} className="shrink-0" /> : null}
                  </label>
                );
              })}
            </fieldset>
            {!solved ? (
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  data-testid="check-submit"
                  disabled={choice === null || pending}
                  className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-pill bg-accent px-4 text-sm font-semibold text-on-accent shadow-raised hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {pending ? "Checking…" : feedback?.result === "wrong" ? "Try again" : "Check answer"}
                </button>
                {submitError ? (
                  <span role="alert" className="text-sm text-danger">
                    {submitError}
                  </span>
                ) : null}
              </div>
            ) : null}
          </form>

          <div aria-live="polite">
            {solved ? (
              <div
                data-testid="check-feedback"
                data-result="correct"
                className="enter-soft flex flex-col gap-1 rounded-md border border-breakthrough/30 bg-breakthrough-soft px-3 py-2.5"
              >
                <p className="flex items-center gap-2 text-base font-semibold text-breakthrough-strong">
                  {breakthrough ? <MomentGlyph type="breakthrough" size={14} /> : <CheckIcon size={16} />}
                  {breakthrough ? "Breakthrough!" : event.type === "unresolved_gap" ? "Got it — gap resolved" : "Correct!"}
                </p>
                <p className="text-sm text-pretty text-ink-muted">
                  {feedback?.result === "correct" ? feedback.why : "You answered this check question correctly."}
                </p>
              </div>
            ) : feedback?.result === "wrong" ? (
              <div
                data-testid="check-feedback"
                data-result="wrong"
                className="enter-soft flex flex-col gap-1 rounded-md border border-gap/30 bg-gap-soft/70 px-3 py-2.5"
              >
                <p className="text-sm font-semibold text-gap-strong">Not quite — this stays open for now.</p>
                <p data-testid="check-why" className="text-sm text-pretty text-ink-muted">
                  {feedback.why}
                </p>
                <p className="text-xs text-ink-subtle">Pick another answer and try again.</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
