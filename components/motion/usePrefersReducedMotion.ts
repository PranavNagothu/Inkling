"use client";

// prefers-reduced-motion as a hydration-safe hook: the server snapshot (and the hydration render)
// is always `false`, then React re-renders with the real value — so markup that differs between
// the two (e.g. a Pause button that only exists when motion is allowed) never mismatches.
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
