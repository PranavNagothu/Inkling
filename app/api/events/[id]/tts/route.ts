import { failResponse } from "@/lib/ai/http";
import { languageFromBody } from "@/lib/ai/languages";
import { aiService } from "@/lib/ai/service";
import { readBodyText, sameOriginOnly } from "@/lib/http";

const MAX_BODY_BYTES = 1024;

/**
 * The moment's re-explanation as speech (audio/mpeg), cached on disk under data/tts/<sha>.mp3.
 * Only the stored explanation is spoken (never client text). ElevenLabs if ELEVENLABS_API_KEY, else
 * OpenAI TTS, else 503 — the client then uses the browser's speechSynthesis. `{ "language": "es" }`
 * speaks the stored translation (409 if it hasn't been made yet) with a multilingual voice.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/events/[id]/tts">) => {
  const { id } = await ctx.params;
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const lang = languageFromBody(body.value);
  if (!lang.ok) return Response.json({ error: lang.error }, { status: 400 });
  try {
    const res = await aiService(request.headers).speak(id, lang.language);
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
    console.error(`tts failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t make the audio." }, { status: 500 });
  }
});
