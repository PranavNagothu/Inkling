"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { formatClock } from "@/lib/time";
import { PauseIcon, PlayIcon } from "./icons";

// Re-exported for existing client imports; server code uses @/lib/time directly.
export { formatClock };

interface LecturePlayerProps {
  title: string;
  durationMs: number;
  /** The lecture's media element (rendered by <LectureMedia>). */
  mediaRef: RefObject<HTMLMediaElement | null>;
  /** Buttons shown after the clock (e.g. the transcript toggle). */
  actions?: ReactNode;
  /** Optional quiet status shown at the end of the tape. */
  aside?: ReactNode;
}

/** The slim lecture bar: play/pause, progress and clock for the shared media element. */
export default function LecturePlayer({ title, durationMs, mediaRef, actions, aside }: LecturePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const a = mediaRef.current;
    if (!a) return;
    let raf = 0;
    const tick = () => {
      setTimeMs(a.currentTime * 1000);
      if (!a.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      setTimeMs(a.currentTime * 1000);
    };
    const onTime = () => setTimeMs(a.currentTime * 1000);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onPause);
    a.addEventListener("seeked", onTime);
    return () => {
      cancelAnimationFrame(raf);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onPause);
      a.removeEventListener("seeked", onTime);
    };
  }, [mediaRef]);

  const toggle = async () => {
    const a = mediaRef.current;
    if (!a) return;
    if (a.paused) {
      try {
        setError(null);
        await a.play();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not start the lecture");
      }
    } else {
      a.pause();
    }
  };

  const progress = durationMs > 0 ? Math.min(1, timeMs / durationMs) : 0;

  return (
    <section
      aria-label="Lecture"
      className="flex min-h-[var(--tape-h)] shrink-0 items-center gap-3 border-b border-line bg-desk px-2 sm:px-3"
    >
      <button
        type="button"
        data-testid="play-toggle"
        data-state={playing ? "playing" : "paused"}
        onClick={toggle}
        aria-label={playing ? "Pause lecture" : "Play lecture"}
        className="press group inline-flex size-11 shrink-0 items-center justify-center rounded-pill"
      >
        <span className="inline-flex size-8 items-center justify-center rounded-pill bg-ink text-paper transition-colors group-hover:bg-accent">
          {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} className="translate-x-px" />}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="hidden max-w-[16rem] truncate text-sm font-medium text-ink-muted md:block">{title}</span>
        <div aria-hidden="true" className="relative h-[3px] min-w-12 flex-1 overflow-hidden rounded-pill bg-line">
          <div
            className="absolute inset-0 origin-left rounded-pill bg-accent"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
        <div className="shrink-0 font-mono text-sm tabular-nums text-ink">
          <span data-testid="lecture-time">{formatClock(timeMs)}</span>
          <span className="text-ink-subtle"> / {formatClock(durationMs)}</span>
        </div>
      </div>
      {error ? (
        <span role="alert" className="max-w-[12rem] truncate text-sm text-danger" title={error}>
          {error}
        </span>
      ) : null}
      {actions}
      {aside}
    </section>
  );
}
