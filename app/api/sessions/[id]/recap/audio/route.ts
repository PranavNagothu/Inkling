import { failResponse } from "@/lib/ai/http";
import { languageFromBody } from "@/lib/ai/languages";
import { aiService } from "@/lib/ai/service";
import { readBodyText, sameOriginOnly } from "@/lib/http";

const MAX_BODY_BYTES = 256;

/**
 * The session recap as speech (audio/mpeg), through the same disk cache as Read aloud
 * (data/tts/<sha>.mp3, keyed by voice, model, text and language). `{ "language": "es" }`.
 * 503 without a server voice — the client then speaks the recap with the browser's voice.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/sessions/[id]/recap/audio">) => {
  const { id } = await ctx.params;
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const lang = languageFromBody(body.value);
  if (!lang.ok) return Response.json({ error: lang.error }, { status: 400 });
  try {
    const res = await aiService(request.headers).speakRecap(id, lang.language);
    if (!res.ok) return failResponse(res);
    return new Response(new Uint8Array(res.audio), {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(res.audio.byteLength),
        "cache-control": "private, max-age=86400",
        "x-voice": res.voice,
      },
    });
  } catch (err) {
    console.error(`recap audio failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t make the audio." }, { status: 500 });
  }
});
