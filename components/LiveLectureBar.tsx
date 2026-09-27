"use client";

import { memo, useEffect, useId, useRef, type ReactNode } from "react";
import { LIVE_DEMO_MESSAGE, LIVE_LANGUAGES, type LiveCue } from "@/lib/liveLecture";
import { formatClock } from "@/lib/time";
import { CloseIcon, MicIcon, PauseIcon, PlayIcon } from "./icons";
import { iconBtn } from "./ui";
import type { LiveCapture } from "./useLiveCapture";

/** The session clock as text, updated a few times a second without re-rendering the page. */
function LiveClockText({ getMs }: { getMs: () => number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = formatClock(getMs());
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [getMs]);
  return <span ref={ref} data-testid="lecture-time" />;
}

interface BarProps {
  live: LiveCapture;
  title: string;
  /** False in DEMO_MODE: the controls are shown but disabled, with a note. */
  available: boolean;
  actions?: ReactNode;
  aside?: ReactNode;
}

/**
 * Replaces the lecture player for a Live lecture: Start / Pause, the mic status pill with a level
 * meter, the session clock and the recognition language. A quiet strip underneath says what the
 * microphone is doing and discloses that speech is transcribed by the browser's speech service.
 */
export function LiveLectureBar({ live, title, available, actions, aside }: BarProps) {
  const langId = useId();
  const { status, mic, support, attachLevel, getMs, language, setLanguage, saveError, speechError, start, pause } = live;
  const running = status === "running";
  const listening = running && mic === "on";
  const canStart = available && status !== "starting" && status !== "ended";

  const pill = listening
    ? { label: "Listening", tone: "border-accent/30 bg-accent-soft text-accent-press", dot: "bg-accent" }
    : running
      ? { label: "Notes only", tone: "border-line bg-chrome text-ink-muted", dot: "bg-ink-subtle" }
      : status === "paused"
        ? { label: "Paused", tone: "border-line bg-chrome text-ink-muted", dot: "bg-gap" }
        : status === "starting"
          ? { label: "Starting…", tone: "border-line bg-chrome text-ink-muted", dot: "bg-ink-subtle" }
          : status === "ended"
            ? { label: "Ended", tone: "border-line bg-chrome text-ink-muted", dot: "bg-ink-subtle" }
            : { label: "Ready", tone: "border-line bg-chrome text-ink-muted", dot: "bg-ink-subtle" };

  let note: ReactNode;
  let noteTone = "text-ink-subtle";
  if (!available) {
    note = LIVE_DEMO_MESSAGE;
  } else if (mic === "blocked") {
    noteTone = "text-danger";
    note = "Microphone blocked — allow it from the address bar to transcribe. Your notes are still timed from Start.";
  } else if (mic === "unavailable" || (support && !support.mic)) {
    note = support?.secure === false
      ? "The microphone needs HTTPS or localhost, so there’s no live transcript here. You can still take notes, timed from Start."
      : "No microphone is available, so there’s no live transcript. You can still take notes, timed from Start.";
  } else if (support && !support.speech) {
    note = "This browser can’t transcribe speech (try Chrome or Edge). You can still take notes, timed from Start.";
  } else if (speechError) {
    noteTone = "text-danger";
    note = speechError;
  } else if (mic === "on" && status !== "ended") {
    note = (
      <>
        <span className="font-semibold text-accent-press">Microphone on</span>
        {running ? "" : " (paused, not recording)"} · Speech is transcribed by your browser’s speech service.
      </>
    );
  } else {
    note = "Press Start to begin. Inkling asks for the microphone only then. Speech is transcribed by your browser’s speech service.";
  }

  return (
    <div className="shrink-0 border-b border-line bg-desk">
      <section aria-label="Live lecture" className="flex min-h-[var(--tape-h)] items-center gap-2 px-2 sm:gap-3 sm:px-3">
        <button
          type="button"
          data-testid="live-toggle"
          data-state={running ? "running" : status}
          onClick={() => void (running ? pause() : start())}
          disabled={!canStart}
          aria-label={running ? "Pause live lecture" : status === "paused" ? "Resume live lecture" : "Start live lecture"}
          className="press group inline-flex min-h-11 shrink-0 items-center gap-2 rounded-pill pr-3 pl-1.5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="inline-flex size-8 items-center justify-center rounded-pill bg-ink text-paper transition-colors group-hover:bg-accent group-disabled:group-hover:bg-ink">
            {running ? <PauseIcon size={14} /> : <PlayIcon size={14} className="translate-x-px" />}
          </span>
          {running ? "Pause" : status === "paused" ? "Resume" : "Start"}
        </button>

        <span
          data-testid="mic-pill"
          data-state={listening ? "listening" : status}
          role="status"
          aria-label={listening ? "Microphone on — listening" : pill.label}
          className={`inline-flex min-h-8 shrink-0 items-center gap-2 rounded-pill border px-3 text-xs font-bold tracking-wide uppercase ${pill.tone}`}
        >
          {listening ? <MicIcon size={14} /> : <span aria-hidden="true" className={`size-1.5 rounded-pill ${pill.dot}`} />}
          {pill.label}
          {listening ? (
            <span aria-hidden="true" className="relative hidden h-1.5 w-10 overflow-hidden rounded-pill bg-accent/15 sm:block">
              <span
                ref={attachLevel}
                data-testid="mic-level"
                className="absolute inset-0 origin-left rounded-pill bg-accent"
                style={{ transform: "scaleX(0)" }}
              />
            </span>
          ) : null}
        </span>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 sm:justify-start">
          <span className="hidden max-w-[16rem] truncate text-sm font-medium text-ink-muted md:block">{title}</span>
          <span className="shrink-0 font-mono text-sm tabular-nums text-ink sm:ml-auto">
            <LiveClockText getMs={getMs} />
          </span>
        </div>

        <label htmlFor={langId} className="sr-only">
          Speech language
        </label>
        <select
          id={langId}
          data-testid="live-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={!available || support?.speech === false}
          className="hidden min-h-11 max-w-[9.5rem] cursor-pointer truncate rounded-pill border border-line bg-chrome px-3 text-sm text-ink-muted transition-colors hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60 sm:block"
        >
          {LIVE_LANGUAGES.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.label}
            </option>
          ))}
        </select>
        {actions}
        {aside}
      </section>
      <p data-testid="live-note" className={`border-t border-line/70 px-3 py-1.5 text-xs text-pretty sm:px-4 ${noteTone}`}>
        {note}
        {saveError ? <span className="text-danger"> {saveError}</span> : null}
      </p>
    </div>
  );
}

/** The live transcript: final cues as timestamped lines, the words being heard in grey below. */
export const LiveTranscriptPanel = memo(function LiveTranscriptPanel({
  cues,
  interim,
  speechSupported,
  onClose,
  id,
}: {
  cues: LiveCue[];
  interim: string;
  speechSupported: boolean;
  onClose: () => void;
  id?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Keep the newest words in view unless the student scrolled up to read.
  useEffect(() => {
    const box = scrollRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [cues, interim]);

  return (
    <aside
      id={id}
      aria-label="Live transcript"
      data-testid="live-transcript"
      className="absolute inset-x-0 bottom-0 z-20 flex h-[40%] flex-col rounded-t-lg border-t border-line bg-chrome shadow-page lg:static lg:z-auto lg:h-auto lg:w-[21rem] lg:shrink-0 lg:rounded-none lg:border-t-0 lg:border-l lg:shadow-none"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line pr-1 pl-4">
        <h2 className="text-sm font-bold tracking-tight text-ink">Transcript</h2>
        <span className="text-xs text-ink-subtle">Live</span>
        <button type="button" data-testid="transcript-close" onClick={onClose} aria-label="Close transcript" className={`${iconBtn} ml-auto`}>
          <CloseIcon size={18} />
        </button>
      </header>
      <div
        ref={scrollRef}
        tabIndex={0}
        aria-live="polite"
        aria-label="Live transcript text"
        onScroll={(e) => {
          const b = e.currentTarget;
          stickRef.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 text-[15px] leading-7 text-ink-muted"
      >
        {cues.length === 0 && !interim ? (
          <p data-testid="live-transcript-empty" className="px-1 text-sm text-pretty text-ink-subtle">
            {speechSupported
              ? "What the lecturer says appears here once you press Start."
              : "No live transcript in this browser. Notes still work, and they’re timed from Start."}
          </p>
        ) : null}
        {cues.map((c) => (
          <p key={c.startMs} data-testid="live-cue" className="grid grid-cols-[2.75rem_1fr] gap-x-2">
            <span aria-hidden="true" className="pt-0.5 font-mono text-[11px] tabular-nums text-ink-subtle select-none">
              {formatClock(c.startMs)}
            </span>
            <span className="text-pretty text-ink">{c.text}</span>
          </p>
        ))}
        {interim ? (
          <p data-testid="live-interim" className="grid grid-cols-[2.75rem_1fr] gap-x-2">
            <span aria-hidden="true" />
            <span className="text-pretty text-ink-subtle italic">{interim}</span>
          </p>
        ) : null}
      </div>
    </aside>
  );
});
