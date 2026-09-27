import { failResponse } from "@/lib/ai/http";
import { languageFromBody } from "@/lib/ai/languages";
import { aiService } from "@/lib/ai/service";
import { readBodyText, sameOriginOnly } from "@/lib/http";

/** An empty body, `{}` or `{ "language": "es" }`; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 256;

/**
 * The session's spoken recap: ≤ 90 words on its corrections, gaps and breakthroughs, the concept
 * that came up most and what to review next (lib/recap), in the student's language. Responds
 * `{ text, language, source, languageFallback?, audioUrl?, voice? }`; `audioUrl` (POST, same body)
 * gives the mp3 when a server voice is configured, otherwise the client speaks `text` itself.
 * Nothing from the client is spoken: the text is built on the server from the stored timeline.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/sessions/[id]/recap">) => {
  const { id } = await ctx.params;
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const lang = languageFromBody(body.value);
  if (!lang.ok) return Response.json({ error: lang.error }, { status: 400 });
  try {
    const res = await aiService(request.headers).recap(id, lang.language);
    if (!res.ok) return failResponse(res);
    return Response.json(res.recap, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(`recap failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t prepare your recap." }, { status: 500 });
  }
});
