import { failResponse } from "@/lib/ai/http";
import { aiService } from "@/lib/ai/service";
import { readBodyText, sameOriginOnly } from "@/lib/http";

/** Takes no parameters; an empty body or `{}` is all that's expected. */
const MAX_BODY_BYTES = 1024;

/**
 * The moment's re-explanation and check question: generated (and cached) on first open, stored on
 * the event, then served from there. The answer index never leaves the server. 503 {error: "AI not
 * configured"} without a provider (the UI shows a quiet "needs an API key" card).
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/events/[id]/help">) => {
  const { id } = await ctx.params;
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  try {
    const res = await aiService(request.headers).getHelp(id);
    if (!res.ok) return failResponse(res);
    return Response.json({ help: res.help, event: res.event });
  } catch (err) {
    console.error(`help failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t prepare an explanation." }, { status: 500 });
  }
});
