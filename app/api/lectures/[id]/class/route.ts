import { sameOriginOnly } from "@/lib/http";
import { loadClassReport } from "@/lib/teacher";

/**
 * The teacher view of a lecture ("Where did the class get lost?"): anonymous, k-anonymous class
 * aggregates only — a heatmap of erasing / struggling per 30 s and the top stretches to re-teach.
 * No session ids, student ids or ink ever appear in the response (see lib/teacher).
 */
export const GET = sameOriginOnly(async (_request: Request, ctx: RouteContext<"/api/lectures/[id]/class">) => {
  const { id } = await ctx.params;
  const report = await loadClassReport(id);
  if (!report) return Response.json({ error: "lecture not found" }, { status: 404 });
  return Response.json(report, { headers: { "Cache-Control": "private, no-store" } });
});
