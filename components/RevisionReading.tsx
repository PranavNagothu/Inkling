"use client";

import { useEffect, useState } from "react";
import type { AiStatus } from "@/lib/ai/types";
import type { Revision, Stroke, TimelineEvent } from "@/lib/types";
import { cropToPng } from "./cropImage";

type ReadState = "idle" | "loading" | "error";

/**
 * "What you changed: … → …" and the likely misconception, read by a vision model from the same
 * before/after crops the panel shows. Read once per revision (stored on the server); quiet on
 * failure or without a provider.
 */
export default function RevisionReading({
  eventId,
  revision,
  crop,
  ai,
  onRevisionChange,
  onEventsChange,
}: {
  eventId: string;
  revision: Revision;
  crop: { before: Stroke[]; after: Stroke[]; context: Stroke[] };
  ai: AiStatus;
  onRevisionChange: (revision: Revision) => void;
  onEventsChange: (events: TimelineEvent[]) => void;
}) {
  const vision = revision.vision;
  const needsReading = !vision && ai.enabled && crop.before.length > 0 && crop.after.length > 0;
  const [state, setState] = useState<ReadState>(needsReading ? "loading" : "idle");

  useEffect(() => {
    if (!needsReading) return;
    const ctrl = new AbortController();
    Promise.resolve()
      .then(() => {
        const beforePng = cropToPng({ focus: crop.before, context: crop.context, bbox: revision.bbox, ghost: true });
        const afterPng = cropToPng({ focus: crop.after, context: crop.context, bbox: revision.bbox, ghost: false });
        if (!beforePng || !afterPng) throw new Error("could not render the crops");
        return fetch(`/api/events/${encodeURIComponent(eventId)}/read-revision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ beforePng, afterPng }),
          signal: ctrl.signal,
        });
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(`read-revision failed: ${res.status}`);
        const body = (await res.json()) as { revision: Revision; event: TimelineEvent };
        onRevisionChange(body.revision);
        onEventsChange([body.event]);
        setState("idle");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState("error");
      });
    return () => ctrl.abort();
    // The callbacks are stable merges; this runs once per revision that still needs reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, revision.id, needsReading]);

  if (vision) {
    return (
      <div data-testid="revision-reading" data-cosmetic={vision.cosmetic} className="enter-soft flex flex-col gap-1.5 text-sm text-pretty">
        <p className="text-ink">
          <span className="font-semibold">What you changed: </span>
          <span data-testid="revision-before" className="text-ink-muted line-through decoration-ghost/70">
            {vision.before}
          </span>
          <span aria-hidden="true" className="px-1.5 text-ink-subtle">
            →
          </span>
          <span className="sr-only"> to </span>
          <span data-testid="revision-after">{vision.after}</span>
        </p>
        {vision.cosmetic ? (
          <p className="text-xs text-ink-subtle">Looks like a tidy-up, not a misconception — it’ll drop off the timeline next time this session is analysed.</p>
        ) : vision.misconception ? (
          <p data-testid="revision-misconception" className="text-ink-muted">
            <span className="text-ink-subtle">Likely mix-up: </span>
            {vision.misconception}
          </p>
        ) : null}
      </div>
    );
  }
  if (state === "loading") {
    return (
      <p data-testid="revision-reading-loading" aria-live="polite" className="flex items-center gap-2 text-xs text-ink-subtle">
        <span aria-hidden="true" className="h-2 w-24 rounded-pill bg-line motion-safe:animate-pulse" />
        Reading your handwriting…
      </p>
    );
  }
  return null;
}
