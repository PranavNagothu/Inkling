import { getTimeline } from "@/lib/analyze";
import { shapeSignalLab } from "@/lib/insights";

/** Signal Lab data for a session: per-window features and scores from the stored analysis (never computes). */
export async function GET(_req: Request, ctx: RouteContext<"/api/sessions/[id]/insights">) {
  const { id } = await ctx.params;
  const timeline = await getTimeline(id);
  if (!timeline) return Response.json({ error: "session not found" }, { status: 404 });
  return Response.json({ analyzed: timeline.analyzed, stale: timeline.stale, ...shapeSignalLab(timeline) });
}
