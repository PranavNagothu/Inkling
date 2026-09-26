"use client";

import { useEffect, useState, type RefObject } from "react";
import type { LectureMediaType } from "@/lib/types";
import { MinimizeIcon, VideoIcon } from "./icons";
import { mediaErrorReason } from "./useReplay";

interface LectureMediaProps {
  src: string;
  mediaType: LectureMediaType;
  title: string;
  mediaRef: RefObject<HTMLMediaElement | null>;
  /** Video only: start collapsed to a small "Show video" pill. */
  defaultCollapsed?: boolean;
  /** Video only: extra classes for the floating panel wrapper (positioning). */
  className?: string;
}

/**
 * The lecture's single media element. Audio has no visual (the lecture bar drives it). Video sits
 * in a compact floating panel that can collapse to a pill; collapsing only hides it, so playback
 * and position are never interrupted.
 */
export default function LectureMedia({
  src,
  mediaType,
  title,
  mediaRef,
  defaultCollapsed = false,
  className = "absolute top-3 right-3 z-10",
}: LectureMediaProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Why the media failed to load (persistent until the page reloads); null while it is fine.
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const onError = () => {
      console.error(`Lecture media failed to load (${src})`, media.error?.code, media.error?.message);
      setLoadError(mediaErrorReason(media.error));
    };
    // The element starts loading from the server-rendered HTML, so it may have failed already.
    if (media.error) onError();
    media.addEventListener("error", onError);
    return () => media.removeEventListener("error", onError);
  }, [mediaRef, src]);

  const banner =
    loadError !== null ? (
      <div
        role="alert"
        data-testid="media-error"
        className="fixed right-4 bottom-4 z-40 max-w-sm rounded-md border border-danger/30 bg-chrome px-3.5 py-2.5 text-sm text-pretty text-danger shadow-raised"
      >
        <span className="font-semibold">Couldn’t load this lecture’s {mediaType === "audio" ? "audio" : "video"}.</span>
        {loadError ? <span className="text-ink-muted"> {loadError}</span> : null}
      </div>
    ) : null;

  if (mediaType === "audio") {
    return (
      <>
        <audio ref={mediaRef as RefObject<HTMLAudioElement | null>} src={src} preload="auto" playsInline data-testid="lecture-media" />
        {banner}
      </>
    );
  }

  return (
    <div data-testid="video-panel" data-collapsed={collapsed ? "true" : "false"} className={className}>
      {banner}
      <div
        className={`group relative w-[min(18rem,42vw)] overflow-hidden rounded-lg bg-ink shadow-page outline outline-1 -outline-offset-1 outline-black/10 ${
          collapsed ? "hidden" : "enter-soft"
        }`}
      >
        <video
          ref={mediaRef as RefObject<HTMLVideoElement | null>}
          src={src}
          preload="auto"
          playsInline
          aria-label={`Lecture video: ${title}`}
          data-testid="lecture-media"
          className="block aspect-video w-full bg-ink object-contain"
        />
        <button
          type="button"
          data-testid="video-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="Hide video"
          title="Hide video"
          className="press absolute top-0 right-0 inline-flex size-11 items-center justify-center"
        >
          <span className="inline-flex size-7 items-center justify-center rounded-pill bg-black/55 text-white transition-colors hover:bg-black/75">
            <MinimizeIcon size={14} />
          </span>
        </button>
      </div>
      {collapsed ? (
        <button
          type="button"
          data-testid="video-expand"
          onClick={() => setCollapsed(false)}
          className="press inline-flex min-h-11 items-center gap-2 rounded-pill border border-line bg-chrome px-3.5 text-sm font-medium text-ink shadow-raised hover:bg-chrome-hover"
        >
          <VideoIcon size={16} />
          Show video
        </button>
      ) : null}
    </div>
  );
}
