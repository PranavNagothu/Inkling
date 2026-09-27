import { failResponse } from "@/lib/ai/http";
import { languageFromBody } from "@/lib/ai/languages";
import { aiService } from "@/lib/ai/service";
import { readBodyText, sameOriginOnly } from "@/lib/http";

/** An empty body, `{}` or `{ "language": "es" }`; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 1024;

/**
 * The moment's re-explanation and check question: generated (and cached) on first open, stored on
 * the event, then served from there. The answer index never leaves the server. 503 {error: "AI not
 * configured"} without a provider (the UI shows a quiet "needs an API key" card).
 *
 * `language` (optional, a supported code): the card translated for an ESL student (options in the
 * same order; graded against the English card). `languageFallback: true` when it is English anyway.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/events/[id]/help">) => {
  const { id } = await ctx.params;
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const lang = languageFromBody(body.value);
  if (!lang.ok) return Response.json({ error: lang.error }, { status: 400 });
  try {
    const res = await aiService(request.headers).getHelp(id, lang.language);
    if (!res.ok) return failResponse(res);
    return Response.json({
      help: res.help,
      event: res.event,
      language: res.language,
      ...(res.languageFallback ? { languageFallback: true } : {}),
    });
  } catch (err) {
    console.error(`help failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t prepare an explanation." }, { status: 500 });
  }
});
