"use client";

import { useEffect, useRef, useState } from "react";
import type { TimelineData } from "@/lib/types";
import type { TimelineStatus } from "./Timeline";

/**
 * A session's learning timeline. Pages hand over a stored, up-to-date analysis when there is one;
 * otherwise (e.g. opened from the home list) the session is analysed on mount. `retry` re-runs a
 * failed analysis. `onAnalyzed` fires after a fresh analysis lands.
 */
export function useSessionTimeline(sessionId: string, initial: TimelineData | null, onAnalyzed?: () => void) {
  const [timeline, setTimeline] = useState<TimelineData | null>(initial);
  const [status, setStatus] = useState<TimelineStatus>(initial ? "ready" : "analyzing");
  const onAnalyzedRef = useRef(onAnalyzed);
  useEffect(() => {
    onAnalyzedRef.current = onAnalyzed;
  });

  useEffect(() => {
    if (status !== "analyzing") return;
    const ctrl = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/analyze`, { method: "POST", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`analyze failed: ${res.status}`);
        setTimeline((await res.json()) as TimelineData);
        setStatus("ready");
        onAnalyzedRef.current?.();
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("error");
      });
    return () => ctrl.abort();
  }, [status, sessionId]);

  return { timeline, setTimeline, status, retry: () => setStatus("analyzing") };
}
