import { getLectureGaps } from "@/lib/gaps";
import { sameOriginOnly } from "@/lib/http";
import { getLecture } from "@/lib/lecture";

/**
 * Open gap threads of a lecture. With `?session=<id>`: only those from sessions before it, plus
 * `carried` (what that session resolved or repeated) for the review's "Carried over".
 */
export const GET = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/lectures/[id]/open-gaps">) => {
  const { id } = await ctx.params;
  if (!(await getLecture(id))) return Response.json({ error: "lecture not found" }, { status: 404 });
  const sessionId = new URL(request.url).searchParams.get("session") ?? undefined;
  if (sessionId !== undefined && (sessionId.length === 0 || sessionId.length > 200)) {
    return Response.json({ error: "invalid session" }, { status: 400 });
  }
  return Response.json(await getLectureGaps(id, { sessionId }));
});
