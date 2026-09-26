"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type ReplayState = "idle" | "playing" | "done" | "error";

/** Why play() failed, in words a student can act on ("" when the browser gives no reason). */
function playFailureReason(err: unknown, media: HTMLMediaElement): string {
  if (media.error) return mediaErrorReason(media.error);
  if (err instanceof DOMException && err.name === "NotAllowedError") return "The browser blocked playback. Click Replay again.";
  if (err instanceof DOMException && err.name === "NotSupportedError") return "The lecture's audio/video couldn't be loaded.";
  return err instanceof Error ? err.message : "";
}

/** A human reason for a media element error (shared with the load-error banner). */
export function mediaErrorReason(error: MediaError | null): string {
  if (!error) return "";
  const byCode: Record<number, string> = {
    [MediaError.MEDIA_ERR_ABORTED]: "Loading was stopped.",
    [MediaError.MEDIA_ERR_NETWORK]: "A network error interrupted the download.",
    [MediaError.MEDIA_ERR_DECODE]: "The file couldn't be decoded.",
    [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "The file is missing or in a format this browser can't play.",
  };
  return byCode[error.code] ?? error.message ?? "";
}

/**
 * Plays [startMs, endMs] of the lecture on a shared media element and stops at the end.
 * Progress and the per-frame tick are pushed straight to the DOM (barRef / onTick) so a replay
 * doesn't re-render the moment panel every frame. Stops when the range changes or on unmount.
 */
export function useReplay(
  mediaRef: RefObject<HTMLMediaElement | null>,
  startMs: number,
  endMs: number,
  onTick?: (ms: number) => void,
) {
  const [state, setState] = useState<ReplayState>("idle");
  // Set when the last start() could not play (shown by the caller; cleared by the next start()).
  const [error, setError] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const activeRef = useRef(false);
  const tickRef = useRef(onTick);
  useEffect(() => {
    tickRef.current = onTick;
  });

  const setBar = (f: number) => {
    if (barRef.current) barRef.current.style.transform = `scaleX(${Math.min(1, Math.max(0, f))})`;
  };

  const halt = useCallback(
    (next: ReplayState) => {
      cancelAnimationFrame(rafRef.current);
      const wasActive = activeRef.current;
      activeRef.current = false;
      if (wasActive) mediaRef.current?.pause();
      setState(next);
    },
    [mediaRef],
  );

  const start = useCallback(async () => {
    const media = mediaRef.current;
    if (!media) return;
    cancelAnimationFrame(rafRef.current);
    media.currentTime = startMs / 1000;
    activeRef.current = true;
    setBar(0);
    setError(null);
    setState("playing");
    try {
      await media.play();
    } catch (err) {
      const wasActive = activeRef.current;
      activeRef.current = false;
      // AbortError: play() was interrupted on purpose (stopped, or another moment took over).
      if (!wasActive || (err instanceof DOMException && err.name === "AbortError")) {
        setState("idle");
        return;
      }
      console.error("Replay could not play", err);
      setError(playFailureReason(err, media));
      setState("error");
      return;
    }
    const loop = () => {
      if (!activeRef.current) return;
      const t = media.currentTime * 1000;
      const mediaEnd = Number.isFinite(media.duration) && media.duration > 0 ? media.duration * 1000 : endMs;
      const end = Math.min(endMs, mediaEnd);
      setBar(end > startMs ? (t - startMs) / (end - startMs) : 1);
      tickRef.current?.(t);
      if (t >= end || media.ended) {
        setBar(1);
        halt("done");
        return;
      }
      if (media.paused) {
        // Paused from elsewhere (e.g. media keys): give control back.
        activeRef.current = false;
        setState("idle");
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [mediaRef, startMs, endMs, halt]);

  const stop = useCallback(() => halt("idle"), [halt]);

  // A different moment (range) or leaving the panel ends the replay.
  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (activeRef.current) {
        activeRef.current = false;
        media?.pause();
      }
    };
  }, [mediaRef, startMs, endMs]);

  return { state, error, start, stop, barRef };
}
