import { getTimeline } from "@/lib/analyze";

/** Stored analysis (events + revisions + windows). Does not compute; see POST …/analyze. */
export async function GET(_req: Request, ctx: RouteContext<"/api/sessions/[id]/timeline">) {
  const { id } = await ctx.params;
  const timeline = await getTimeline(id);
  if (!timeline) return Response.json({ error: "session not found" }, { status: 404 });
  return Response.json(timeline);
}
