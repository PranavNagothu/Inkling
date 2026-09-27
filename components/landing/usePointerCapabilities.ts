"use client";

// "Can this device hover with a precise pointer?" — gates pointer-driven flourishes (tilt,
// magnetic buttons, cursor glow) so touch devices never get half-working hover effects.
// Hydration-safe: the server snapshot is false.
import { useSyncExternalStore } from "react";

const QUERY = "(hover: hover) and (pointer: fine)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
