"use client";

// Capture-page reminder of gaps left open in earlier sessions of this lecture, with "Jump to"
// buttons that seek the lecture to the start of each gap's sentence. Dismissible.
import { useState, type RefObject } from "react";
import type { ProgressThread } from "@/lib/progress";
import { formatClock } from "./LecturePlayer";
import { MomentGlyph } from "./Timeline";
import { CloseIcon } from "./icons";

/** Seeks now, or once the media knows its duration (a seek before metadata may be dropped). */
function seek(media: HTMLMediaElement, ms: number) {
  const apply = () => {
    media.currentTime = ms / 1000;
  };
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
  else media.addEventListener("loadedmetadata", apply, { once: true });
}

export default function OpenGapsBanner({
  threads,
  mediaRef,
}: {
  threads: ProgressThread[];
  mediaRef: RefObject<HTMLMediaElement | null>;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || threads.length === 0) return null;
  const n = threads.length;

  return (
    <aside
      data-testid="open-gaps-banner"
      aria-labelledby="open-gaps-title"
      className="enter-soft absolute right-4 bottom-4 z-10 flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2 rounded-lg border border-line bg-chrome/95 py-2.5 pr-1.5 pl-3.5 shadow-page"
    >
      <div className="flex items-start gap-2">
        <p id="open-gaps-title" className="flex-1 pt-2.5 text-sm font-semibold text-balance text-ink">
          You have <span className="tabular-nums" data-testid="open-gaps-banner-count">{n}</span> open{" "}
          {n === 1 ? "gap" : "gaps"} in this lecture
        </p>
        <button
          type="button"
          data-testid="open-gaps-dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss open gaps"
          className="press inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-chrome-hover hover:text-ink"
        >
          <CloseIcon size={16} />
        </button>
      </div>
      <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto pr-1.5">
        {threads.map((t) => (
          <li key={t.rootId}>
            <button
              type="button"
              data-testid="open-gap-jump"
              data-seek-ms={t.seekMs}
              onClick={() => {
                if (mediaRef.current) seek(mediaRef.current, t.seekMs);
              }}
              className="press group -ml-2 flex min-h-11 w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-chrome-hover"
            >
              <MomentGlyph type="unresolved_gap" size={12} className="shrink-0" />
              <span className="line-clamp-2 min-w-0 flex-1 text-pretty text-ink">{t.label}</span>
              {t.occurrences > 1 ? (
                <span className="shrink-0 text-xs text-gap-strong tabular-nums">×{t.occurrences}</span>
              ) : null}
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink-subtle group-hover:text-accent">
                Jump to {formatClock(t.latest.lectureMs)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
