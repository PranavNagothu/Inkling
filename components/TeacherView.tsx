"use client";

// Teacher view of a lecture: "Where did the class get lost?" — the class heatmap, the top stretches
// to re-teach (with what the lecturer said and a lecture replay of each), and the privacy promise.
// Everything shown is anonymous and k-anonymous (lib/teacher); this component only lays it out.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ClassReport, ReteachMoment } from "@/lib/teacher";
import { formatClock } from "@/lib/time";
import TeacherHeatmap from "./TeacherHeatmap";
import { PlayIcon, StopIcon } from "./icons";
import { Reveal } from "./motion/Reveal";
import { BackLink, Mark, TopBar, btnSecondary } from "./ui";

interface Playing {
  startMs: number;
  endMs: number;
}

const range = (r: Playing) => `${formatClock(r.startMs)}–${formatClock(r.endMs)}`;

function ShieldIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Plays one stretch of the lecture media and stops at its end. */
function useStretchPlayer(mediaRef: React.RefObject<HTMLMediaElement | null>) {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playingRef = useRef<Playing | null>(null);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onTime = () => {
      const p = playingRef.current;
      if (p && el.currentTime * 1000 >= p.endMs) el.pause();
    };
    const onPause = () => {
      playingRef.current = null;
      setPlaying(null);
    };
    const onError = () => {
      playingRef.current = null;
      setPlaying(null);
      setError("Couldn’t load the lecture recording.");
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("error", onError);
    };
  }, [mediaRef]);

  const play = useCallback(
    async (stretch: Playing) => {
      const el = mediaRef.current;
      if (!el) return;
      setError(null);
      playingRef.current = stretch;
      setPlaying(stretch);
      el.currentTime = stretch.startMs / 1000;
      try {
        await el.play();
      } catch (err) {
        // A newer play() or a pause() interrupting this one is not a failure.
        if (err instanceof DOMException && err.name === "AbortError") return;
        playingRef.current = null;
        setPlaying(null);
        setError("Couldn’t play the lecture — try again.");
      }
    },
    [mediaRef],
  );
  const stop = useCallback(() => mediaRef.current?.pause(), [mediaRef]);
  return { playing, error, play, stop };
}

function MomentCard({
  moment,
  playing,
  onPlay,
  onStop,
}: {
  moment: ReteachMoment;
  playing: boolean;
  onPlay: () => void;
  onStop: () => void;
}) {
  const timeId = `moment-${moment.rank}-time`;
  return (
    <li
      data-testid="reteach-moment"
      data-rank={moment.rank}
      data-start-ms={moment.startMs}
      data-end-ms={moment.endMs}
      className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4 sm:p-5"
    >
      <span
        aria-hidden="true"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-pill border border-teal-200 bg-accent-soft text-sm font-bold text-accent-press tabular-nums"
      >
        {moment.rank}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h3 id={timeId} className="font-mono text-base font-semibold text-ink tabular-nums">
            <span className="sr-only">Moment {moment.rank}: </span>
            {range(moment)}
          </h3>
          <span data-testid="moment-students" data-count={moment.students ?? ""} className="text-sm text-ink-muted tabular-nums">
            {moment.students === null ? (
              <>
                <span className="font-semibold text-ink">Fewer than 3 students</span> hesitated or erased
              </>
            ) : (
              <>
                <span className="font-semibold text-ink">{moment.studentsLabel}</span> hesitated or erased
              </>
            )}
            {moment.erased > 0 ? ` · ${moment.erased} erased strokes` : null}
          </span>
        </div>
        {moment.excerpt ? (
          <blockquote data-testid="moment-excerpt" className="border-l-2 border-line-strong pl-3 text-sm text-pretty text-ink-muted italic">
            “{moment.excerpt}”
          </blockquote>
        ) : (
          <p className="text-sm text-ink-subtle">No transcript for this stretch — play it to hear what was said.</p>
        )}
      </div>
      <button
        type="button"
        data-testid="play-moment"
        data-state={playing ? "playing" : "idle"}
        aria-describedby={timeId}
        onClick={playing ? onStop : onPlay}
        className={`${btnSecondary} shrink-0 self-start`}
      >
        {playing ? <StopIcon size={16} /> : <PlayIcon size={16} />}
        {playing ? "Stop" : "Play this moment"}
      </button>
    </li>
  );
}

export default function TeacherView({ report, mediaSrc }: { report: ClassReport; mediaSrc: string }) {
  const { lecture, view } = report;
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const { playing, error, play, stop } = useStretchPlayer(mediaRef);

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Teacher view toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <div className="min-w-0">
            <p className="truncate text-xs font-bold tracking-wide text-accent-press uppercase">Teacher view</p>
            <h1 className="truncate text-base leading-tight font-bold tracking-tight text-ink">{lecture.title}</h1>
          </div>
        </div>
      </TopBar>

      <main data-testid="teacher-view" data-status={view.status} className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 pt-8 pb-16 sm:px-8">
        <Reveal as="header" className="flex flex-col gap-3">
          <p className="eyebrow">For teachers</p>
          <h2 className="page-title">
            Where did the class get <Mark>lost?</Mark>
          </h2>
          <p data-testid="equity-line" className="inline-flex max-w-xl items-start gap-2 text-pretty text-ink-muted">
            <ShieldIcon size={18} className="mt-0.5 shrink-0 text-ok" />
            <span>
              <span className="font-semibold text-ink">No names, no cameras — only anonymous writing patterns.</span> Hesitation and
              erasing from everyone’s notes, pooled per 30 seconds. Groups smaller than 3 students are never counted.
            </span>
          </p>
          {view.status === "ready" ? (
            <p data-testid="class-size" data-count={view.classSize} className="text-sm text-ink-subtle tabular-nums">
              From {view.classSize} students’ notes on this lecture.
            </p>
          ) : null}
        </Reveal>

        {view.status === "empty" ? (
          <section
            data-testid="teacher-empty"
            className="panel flex min-h-48 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
          >
            <p className="font-semibold text-ink">No one has taken notes on this lecture yet</p>
            <p className="max-w-sm text-sm text-pretty text-ink-muted">
              Once students write along with it, this page shows where the class hesitated and erased.
            </p>
            <Link href="/app" className={`${btnSecondary} mt-2`}>
              Back to sessions
            </Link>
          </section>
        ) : null}

        {view.status === "too-few" ? (
          <section
            data-testid="teacher-privacy"
            className="panel flex flex-col gap-2 px-5 py-6"
          >
            <p className="inline-flex items-center gap-2 font-medium text-ink">
              <ShieldIcon size={18} className="text-ok" />
              Fewer than 3 students have notes on this lecture
            </p>
            <p className="max-w-xl text-sm text-pretty text-ink-muted">
              To keep everyone anonymous, the class view appears once at least 3 students have written along with it — so no
              pattern can be traced back to one person.
            </p>
          </section>
        ) : null}

        {view.status === "ready" ? (
          <>
            <TeacherHeatmap
              buckets={view.buckets}
              moments={view.moments}
              source={report.source}
              timescale={report.timescale}
              onPlayFrom={(startMs, endMs) => void play({ startMs, endMs })}
            />

            <section aria-labelledby="reteach-heading" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
                <h2 id="reteach-heading" className="text-xl font-extrabold tracking-tight text-ink">
                  Top {Math.min(3, Math.max(1, view.moments.length))} moments to re-teach
                </h2>
                <p className="text-sm text-ink-subtle">Where the most students hesitated or erased</p>
              </div>
              {view.moments.length === 0 ? (
                <p data-testid="reteach-none" className="panel px-4 py-5 text-sm text-ink-muted">
                  No stretch stood out — nobody hesitated or erased much during this lecture.
                </p>
              ) : (
                <ol data-testid="reteach-list" className="flex flex-col gap-3">
                  {view.moments.map((m) => (
                    <MomentCard
                      key={m.rank}
                      moment={m}
                      playing={playing?.startMs === m.startMs && playing.endMs === m.endMs}
                      onPlay={() => void play({ startMs: m.startMs, endMs: m.endMs })}
                      onStop={stop}
                    />
                  ))}
                </ol>
              )}
            </section>

            <div className="flex flex-col gap-2">
              {lecture.mediaType === "video" ? (
                <video
                  ref={mediaRef as React.RefObject<HTMLVideoElement | null>}
                  src={mediaSrc}
                  preload="metadata"
                  playsInline
                  aria-label={`Lecture video: ${lecture.title}`}
                  data-testid="teacher-media"
                  className={`aspect-video w-full max-w-md rounded-lg bg-ink object-contain shadow-page ${playing ? "" : "hidden"}`}
                />
              ) : (
                <audio ref={mediaRef as React.RefObject<HTMLAudioElement | null>} src={mediaSrc} preload="metadata" data-testid="teacher-media" />
              )}
              <p role="status" data-testid="teacher-playing" className="min-h-5 text-sm text-ink-muted tabular-nums">
                {playing ? `Playing the lecture, ${range(playing)}` : ""}
              </p>
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
