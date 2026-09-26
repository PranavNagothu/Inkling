"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import type {
  BBox,
  ConfusionWindow,
  Revision,
  Stroke,
  TimelineEvent,
  TimelineEventType,
  TranscriptSource,
  TranscriptWord,
} from "@/lib/types";
import { CLASSIFY_CONFIG } from "@/lib/classify";
import { MOMENT_META, reasonsFor } from "@/lib/moments";
import { formatDay, historyLine, type SelfAction } from "@/lib/progress";
import type { AiStatus } from "@/lib/ai/types";
import { wordIndexAt, wordRange } from "@/lib/transcript";
import { formatClock } from "./LecturePlayer";
import { CROP_PAD, paintCrop } from "./cropImage";
import HelpPanel from "./HelpPanel";
import { ArrowRightIcon, CheckIcon, CloseIcon, CompareIcon, ReplayIcon, StopIcon } from "./icons";
import RevisionReading from "./RevisionReading";
import { useReplay } from "./useReplay";
import { MomentGlyph } from "./Timeline";
import { iconBtn } from "./ui";

const TITLE_CLASS: Record<TimelineEventType, string> = {
  misconception_corrected: "text-corrected-strong",
  unresolved_gap: "text-gap-strong",
  breakthrough: "text-breakthrough-strong",
};

const intersects = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Draws `focus` strokes (ghost ink for "before", ink for "after") cropped to `bbox`, over the
 * surrounding live ink at low opacity for context. Scales to fit, never zooming in past MAX_ZOOM.
 */
function StrokeCrop({
  focus,
  context,
  bbox,
  ghost,
  testId,
}: {
  focus: Stroke[];
  context: Stroke[];
  bbox: BBox;
  ghost: boolean;
  testId: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!ctx || w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paintCrop(ctx, w, h, dpr, { focus, context, bbox, ghost });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [focus, context, bbox, ghost]);

  return <canvas ref={ref} data-testid={testId} className="block aspect-[3/2] w-full" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{children}</h3>;
}

/**
 * "What the lecture was saying": the excerpt as word spans (so a replay can mark the word being
 * spoken) plus the Replay 20s control. Words inside the replayed range are full strength.
 */
function Evidence({
  event,
  words,
  transcriptSource,
  mediaRef,
}: {
  event: TimelineEvent;
  words: TranscriptWord[];
  transcriptSource: TranscriptSource;
  mediaRef: RefObject<HTMLMediaElement | null>;
}) {
  const { audioStartMs, audioEndMs, excerpt } = event.evidence;
  const excerptRef = useRef<HTMLQuoteElement>(null);
  const currentRef = useRef<HTMLElement | null>(null);

  const slice = useMemo(() => {
    const [from, to] = wordRange(
      words,
      event.lectureMs - CLASSIFY_CONFIG.excerptPadMs,
      event.lectureMs + CLASSIFY_CONFIG.excerptPadMs,
    );
    return words.slice(from, to);
  }, [words, event.lectureMs]);

  const onTick = useCallback(
    (ms: number) => {
      const box = excerptRef.current;
      if (!box) return;
      const el = box.querySelectorAll<HTMLElement>("[data-w]")[wordIndexAt(slice, ms)] ?? null;
      if (el === currentRef.current) return;
      currentRef.current?.removeAttribute("aria-current");
      el?.setAttribute("aria-current", "true");
      currentRef.current = el;
    },
    [slice],
  );

  const { state: replayState, error: replayError, start: startReplay, stop: stopReplay, barRef } = useReplay(
    mediaRef,
    audioStartMs,
    audioEndMs,
    onTick,
  );
  const clear = () => {
    currentRef.current?.removeAttribute("aria-current");
    currentRef.current = null;
  };
  const playing = replayState === "playing";

  let body: React.ReactNode;
  if (slice.length > 0) {
    body = (
      <blockquote
        ref={excerptRef}
        data-testid="moment-excerpt"
        className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-pretty text-ink-muted"
      >
        “…
        {slice.map((w, i) => {
          const inRange = w.endMs >= audioStartMs && w.startMs <= audioEndMs;
          return (
            <span key={i}>
              <span data-w={i} className={`excerpt-word ${inRange ? "" : "opacity-60"}`}>
                {w.w}
              </span>
              {i < slice.length - 1 ? " " : ""}
            </span>
          );
        })}
        …”
      </blockquote>
    );
  } else if (words.length === 0 && transcriptSource === "none") {
    body = (
      <p data-testid="moment-excerpt" className="text-sm text-ink-subtle">
        No transcript for this lecture
      </p>
    );
  } else if (excerpt) {
    body = (
      <blockquote
        data-testid="moment-excerpt"
        className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-pretty text-ink-muted"
      >
        “…{excerpt}…”
      </blockquote>
    );
  } else {
    body = (
      <p data-testid="moment-excerpt" className="text-sm text-ink-subtle">
        No transcript for this part of the lecture.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>What the lecture was saying</SectionLabel>
        <span className="font-mono text-xs tabular-nums text-ink-subtle">
          {formatClock(audioStartMs)}–{formatClock(audioEndMs)}
        </span>
      </div>
      {body}
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="replay"
          data-replay-state={replayState}
          aria-label={playing ? "Stop replay" : `Replay ${formatClock(audioStartMs)} to ${formatClock(audioEndMs)}`}
          onClick={() => {
            clear();
            if (playing) stopReplay();
            else void startReplay();
          }}
          className={`press inline-flex min-h-11 shrink-0 items-center gap-2 rounded-pill border px-4 text-sm font-semibold ${
            playing
              ? "border-accent bg-accent text-on-accent hover:bg-accent-hover"
              : "border-line-strong bg-chrome text-ink hover:bg-chrome-hover"
          }`}
        >
          {playing ? <StopIcon size={14} /> : <ReplayIcon size={16} />}
          {playing ? "Stop" : replayState === "done" ? "Replay again" : `Replay ${Math.round((audioEndMs - audioStartMs) / 1000)}s`}
        </button>
        <div
          aria-hidden="true"
          data-testid="replay-progress"
          className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-pill bg-line"
        >
          <div
            ref={barRef}
            className={`absolute inset-0 origin-left rounded-pill transition-colors ${
              replayState === "done" ? "bg-ok" : "bg-accent"
            }`}
            style={{ transform: "scaleX(0)" }}
          />
        </div>
      </div>
      {replayState === "error" ? (
        <p role="alert" data-testid="replay-error" className="text-sm text-pretty text-danger">
          Couldn’t play this part of the lecture.{replayError ? ` ${replayError}` : ""}
        </p>
      ) : null}
    </div>
  );
}

interface MomentDetailProps {
  event: TimelineEvent;
  /** The session's lecture transcript ([] when it has none) and its source. */
  words: TranscriptWord[];
  transcriptSource: TranscriptSource;
  /** Shared lecture media element used for replays. */
  mediaRef: RefObject<HTMLMediaElement | null>;
  windows: ConfusionWindow[];
  revision: Revision | undefined;
  /** Strokes that exist on the page (activeStrokes), for context around a revision. */
  pageStrokes: Stroke[];
  strokesById: Map<string, Stroke>;
  onClose: () => void;
  /** "I get it now" / "Still confused" on a gap; resolves once the change is stored. */
  onSelfAction?: (action: SelfAction) => Promise<void>;
  /** Which AI provider (if any) can explain moments (Phase 5). */
  ai: AiStatus;
  /** Stored events changed on the server (check answer, better concept label): merge them. */
  onEventsChange: (events: TimelineEvent[]) => void;
  /** A revision got its reading ("What you changed"). */
  onRevisionChange: (revision: Revision) => void;
}

/**
 * The gap's story across sessions ("Open since Sep 25 · 2nd time") and the student's own say:
 * "I get it now" on an open gap, "Still confused" on a resolved one.
 */
function GapProgress({ event, onSelfAction }: { event: TimelineEvent; onSelfAction?: (action: SelfAction) => Promise<void> }) {
  const [pending, setPending] = useState<SelfAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const line = historyLine(event, formatDay);
  const open = event.status === "open";

  const act = async (action: SelfAction) => {
    if (!onSelfAction || pending) return;
    setPending(action);
    setError(null);
    try {
      await onSelfAction(action);
    } catch {
      setError("Couldn’t save that — try again.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line bg-desk/60 px-3 py-3">
      {line ? (
        <p data-testid="moment-history" className="text-sm text-pretty text-ink-muted" suppressHydrationWarning>
          {line}
        </p>
      ) : null}
      {onSelfAction ? (
        <div className="flex flex-wrap items-center gap-2">
          {open ? (
            <button
              type="button"
              data-testid="self-resolve"
              onClick={() => void act("self")}
              disabled={pending !== null}
              aria-busy={pending === "self"}
              className="press inline-flex min-h-11 items-center gap-2 rounded-pill bg-breakthrough-strong px-4 text-sm font-semibold text-white hover:bg-breakthrough-strong/90 disabled:opacity-60"
            >
              <CheckIcon size={16} />
              {pending === "self" ? "Saving…" : "I get it now"}
            </button>
          ) : (
            <button
              type="button"
              data-testid="self-reopen"
              onClick={() => void act("reopen")}
              disabled={pending !== null}
              aria-busy={pending === "reopen"}
              className="press inline-flex min-h-11 items-center gap-2 rounded-pill border border-line-strong bg-chrome px-4 text-sm font-semibold text-ink hover:bg-chrome-hover disabled:opacity-60"
            >
              {pending === "reopen" ? "Saving…" : "Still confused"}
            </button>
          )}
          <span className="text-xs text-pretty text-ink-subtle">
            {open ? "Or write through this part calmly next time — it’ll resolve itself." : "Reopen it if it still feels shaky."}
          </span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function MomentDetail({
  event,
  words,
  transcriptSource,
  mediaRef,
  windows,
  revision,
  pageStrokes,
  strokesById,
  onClose,
  onSelfAction,
  ai,
  onEventsChange,
  onRevisionChange,
}: MomentDetailProps) {
  const meta = MOMENT_META[event.type];
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Opening a moment (a marker, ?moment=, or switching markers: the panel is keyed by the moment)
  // moves focus to its heading so keyboard and screen-reader users land in the panel. The panel
  // scrolls on its own on wide screens and sits right under the timeline on narrow ones, so the
  // page is not scrolled for it. Closing returns focus to the marker (ReviewView).
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const reasons = useMemo(
    () => reasonsFor(event, windows, revision, strokesById),
    [event, windows, revision, strokesById],
  );

  const crop = useMemo(() => {
    if (!revision) return null;
    const pick = (ids: string[]) => ids.map((id) => strokesById.get(id)).filter((s): s is Stroke => !!s);
    const before = pick(revision.beforeStrokeIds);
    const after = pick(revision.afterStrokeIds);
    const own = new Set([...revision.beforeStrokeIds, ...revision.afterStrokeIds]);
    const area: BBox = [
      revision.bbox[0] - CROP_PAD * 4,
      revision.bbox[1] - CROP_PAD * 4,
      revision.bbox[2] + CROP_PAD * 4,
      revision.bbox[3] + CROP_PAD * 4,
    ];
    const context = pageStrokes.filter((s) => !s.erased && !own.has(s.id) && intersects(s.bbox, area));
    return { before, after, context };
  }, [revision, pageStrokes, strokesById]);

  return (
    <section
      key={event.id}
      data-testid="moment-detail"
      data-type={event.type}
      data-event-id={event.id}
      aria-labelledby="moment-title"
      className="enter-soft flex flex-col gap-5"
    >
      <header className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
          <h2
            id="moment-title"
            ref={titleRef}
            tabIndex={-1}
            data-testid="moment-title"
            className={`flex items-center gap-2 text-base leading-tight font-semibold text-balance outline-none focus-visible:shadow-[var(--focus-ring)] ${TITLE_CLASS[event.type]}`}
          >
            <MomentGlyph type={event.type} size={14} className="shrink-0" />
            {meta.label}
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span className="font-mono tabular-nums text-ink" data-testid="moment-time">
              {formatClock(event.lectureMs)}
            </span>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            {event.status === "open" ? (
              <span data-testid="moment-status" className="inline-flex items-center rounded-pill bg-gap-soft px-2 py-0.5 text-xs font-semibold text-gap-strong">
                Open
              </span>
            ) : (
              <span
                data-testid="moment-status"
                className="inline-flex items-center gap-1 rounded-pill bg-breakthrough-soft px-2 py-0.5 text-xs font-semibold text-breakthrough-strong"
              >
                <CheckIcon size={12} />
                Resolved
              </span>
            )}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close moment details" className={`${iconBtn} -mt-1 -mr-2`}>
          <CloseIcon size={18} />
        </button>
      </header>

      {event.conceptLabel ? (
        <p data-testid="moment-concept" className="-mt-2 text-sm text-pretty text-ink">
          <span className="text-ink-subtle">About </span>“{event.conceptLabel}”
        </p>
      ) : null}

      {event.type === "unresolved_gap" ? <GapProgress event={event} onSelfAction={onSelfAction} /> : null}

      <div className="flex flex-col gap-2">
        <SectionLabel>Why it was flagged</SectionLabel>
        <ul data-testid="moment-reasons" className="flex flex-col gap-1.5 text-sm text-ink">
          {reasons.map((r) => (
            <li key={r} className="flex gap-2 text-pretty">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-pill bg-ink-subtle" />
              {r}
            </li>
          ))}
        </ul>
      </div>

      {crop && revision ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>What changed on the page</SectionLabel>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <figure className="flex flex-col gap-1">
              <div className="paper overflow-hidden rounded-md border border-line" style={{ "--rule-gap": "12px" } as React.CSSProperties}>
                <StrokeCrop focus={crop.before} context={crop.context} bbox={revision.bbox} ghost testId="before-canvas" />
              </div>
              <figcaption className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span aria-hidden="true" className="inline-block w-3 border-t-2 border-dashed border-ghost" />
                Before · erased
              </figcaption>
            </figure>
            <ArrowRightIcon size={16} className="mb-5 text-ink-subtle" />
            <figure className="flex flex-col gap-1">
              <div className="paper overflow-hidden rounded-md border border-line" style={{ "--rule-gap": "12px" } as React.CSSProperties}>
                <StrokeCrop focus={crop.after} context={crop.context} bbox={revision.bbox} ghost={false} testId="after-canvas" />
              </div>
              <figcaption className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span aria-hidden="true" className="inline-block w-3 border-t-2 border-ink" />
                After · rewritten
              </figcaption>
            </figure>
          </div>
          <RevisionReading
            eventId={event.id}
            revision={revision}
            crop={crop}
            ai={ai}
            onRevisionChange={onRevisionChange}
            onEventsChange={onEventsChange}
          />
        </div>
      ) : null}

      <Evidence event={event} words={words} transcriptSource={transcriptSource} mediaRef={mediaRef} />

      <HelpPanel event={event} ai={ai} onEventsChange={onEventsChange} />

      <footer className="-mt-1 border-t border-line pt-3">
        <Link
          href={`/compare/${encodeURIComponent(event.sessionId)}`}
          data-testid="moment-compare-link"
          className="press -mx-2 inline-flex min-h-11 items-center gap-2 rounded-pill px-2 text-sm font-semibold text-accent hover:bg-accent-soft"
        >
          <CompareIcon size={16} />
          See what your Notability page hides
          <ArrowRightIcon size={14} />
        </Link>
      </footer>
    </section>
  );
}
