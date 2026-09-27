// Presentation helpers for learning-timeline moments. Pure; safe on client and server.
import { SCORING_CONFIG } from "./scoring";
import type { ConfusionWindow, Revision, Stroke, TimelineEvent, TimelineEventType } from "./types";

export const MOMENT_META: Record<
  TimelineEventType,
  { label: string; legend: string; plural: [one: string, many: string]; color: string }
> = {
  // `color` mirrors the --color-* tokens in app/(product)/globals.css (canvas drawing needs literal colours).
  misconception_corrected: {
    label: "Corrected misconception",
    legend: "Corrected",
    plural: ["corrected", "corrected"],
    color: "#0284c7",
  },
  unresolved_gap: { label: "Unresolved gap", legend: "Unresolved gap", plural: ["gap", "gaps"], color: "#d97706" },
  breakthrough: { label: "Breakthrough", legend: "Breakthrough", plural: ["breakthrough", "breakthroughs"], color: "#1e293b" },
};

export const MOMENT_ORDER: TimelineEventType[] = ["misconception_corrected", "unresolved_gap", "breakthrough"];

/** The scoring window an event belongs to (the one it was linked to, else the one containing it). */
export function windowFor(event: TimelineEvent, windows: ConfusionWindow[]): ConfusionWindow | undefined {
  const start =
    event.windowStartMs ?? Math.floor(event.lectureMs / SCORING_CONFIG.windowMs) * SCORING_CONFIG.windowMs;
  return windows.find((w) => w.bucketStartMs === start);
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Human-readable "why was this flagged" lines for a moment. Never empty. */
export function reasonsFor(
  event: TimelineEvent,
  windows: ConfusionWindow[],
  revision: Revision | undefined,
  strokesById: Map<string, Stroke>,
): string[] {
  const out = [...(windowFor(event, windows)?.reasons ?? [])];
  if (revision) {
    const after = revision.afterStrokeIds.map((id) => strokesById.get(id)).filter((s): s is Stroke => !!s);
    if (after.length > 0) {
      const firstAfter = Math.min(...after.map((s) => s.startMs));
      const secs = Math.max(0, Math.round((firstAfter - revision.lectureMs) / 1000));
      out.push(secs <= 1 ? "erased this and rewrote it right away" : `erased this and rewrote it ${secs}s later`);
    }
  }
  if (out.length === 0) {
    out.push(event.type === "unresolved_gap" ? "your writing rhythm changed sharply here" : "you revised your notes here");
  }
  return out.map(capitalize);
}
