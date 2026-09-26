// "Where the class slowed down": class-wide erasing per 30 s of a lecture (Db.lectureInkHotspots —
// a TimescaleDB continuous aggregate on Tiger Data) shaped for a small bar sparkline. Pure and
// client-safe.
import type { DbInfo, InkHotspot } from "./dbShared";

export const HOTSPOT_MS = 30_000;

export interface HotspotBar {
  startMs: number;
  endMs: number;
  strokes: number;
  erased: number;
  /** erased / the busiest bucket's erased (0..1). */
  level: number;
}

/** One bar per bucket from 0 to the end of the lecture (or the last ink, if later). */
export function hotspotBars(hotspots: InkHotspot[], durationMs: number, bucketMs: number = HOTSPOT_MS): HotspotBar[] {
  const byStart = new Map(hotspots.map((h) => [h.bucketStartMs, h]));
  const lastInk = hotspots.reduce((m, h) => Math.max(m, h.bucketStartMs + bucketMs), 0);
  const end = Math.max(durationMs, lastInk);
  const max = hotspots.reduce((m, h) => Math.max(m, h.erased), 0);
  const bars: HotspotBar[] = [];
  for (let start = 0; start < end; start += bucketMs) {
    const h = byStart.get(start);
    const erased = h?.erased ?? 0;
    bars.push({
      startMs: start,
      endMs: Math.min(start + bucketMs, end),
      strokes: h?.strokes ?? 0,
      erased,
      level: max > 0 ? Math.round((erased / max) * 100) / 100 : 0,
    });
  }
  return bars;
}

/** The `n` stretches with the most erasing (ties: earlier first); stretches without erasing never count. */
export function slowestStretches(bars: HotspotBar[], n = 2): HotspotBar[] {
  return bars
    .filter((b) => b.erased > 0)
    .sort((a, b) => b.erased - a.erased || a.startMs - b.startMs)
    .slice(0, n);
}

/** Which query produced the hotspots (shown on /about and under the sparkline). */
export function hotspotSourceLabel(info: DbInfo): string {
  if (info.backend === "postgres") {
    return info.timescale
      ? "Tiger Data · TimescaleDB continuous aggregate (time_bucket)"
      : "Postgres · date_bin over ink_samples";
  }
  return "SQLite · computed in TypeScript";
}
