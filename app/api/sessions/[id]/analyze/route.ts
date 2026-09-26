import { after } from "next/server";
import { aiService } from "@/lib/ai/service";
import { analyzeSession } from "@/lib/analyze";
import { sameOriginOnly } from "@/lib/http";

/** Runs (or re-runs) the analysis pipeline for a session. Idempotent: same ink → same event ids. */
export const POST = sameOriginOnly(async (req: Request, ctx: RouteContext<"/api/sessions/[id]/analyze">) => {
  const headers = req.headers;
  const { id } = await ctx.params;
  try {
    const result = await analyzeSession(id);
    if (!result) return Response.json({ error: "session not found" }, { status: 404 });
    // Optional (AI_PREFETCH=1): warm the help cards of the top 3 moments after responding. Off by
    // default so nothing is generated for moments the student never opens.
    if (process.env.AI_PREFETCH === "1" && result.events.length > 0) {
      after(async () => {
        try {
          await aiService(headers).prefetchHelp(id, 3);
        } catch (err) {
          console.warn(`help prefetch failed for ${id}`, err instanceof Error ? err.message : err);
        }
      });
    }
    return Response.json(result);
  } catch (err) {
    console.error(`analyze failed for session ${id}`, err);
    return Response.json({ error: "Could not analyze this session.", sessionId: id }, { status: 500 });
  }
});
