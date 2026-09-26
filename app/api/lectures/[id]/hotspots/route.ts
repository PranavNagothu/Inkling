import { HOTSPOT_BUCKET_MS, getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";
import { getLecture } from "@/lib/lecture";

/**
 * Class-wide ink per 30 s of a lecture, over every session of it (counts only; no per-student
 * data). On Tiger Data this reads a TimescaleDB continuous aggregate (refreshed every minute).
 */
export const GET = sameOriginOnly(async (_request: Request, ctx: RouteContext<"/api/lectures/[id]/hotspots">) => {
  const { id } = await ctx.params;
  if (!(await getLecture(id))) return Response.json({ error: "lecture not found" }, { status: 404 });
  return Response.json({ lectureId: id, bucketMs: HOTSPOT_BUCKET_MS, hotspots: await getDb().lectureInkHotspots(id) });
});
