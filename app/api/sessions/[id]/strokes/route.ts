import { MAX_BATCH_ITEMS, MAX_STROKES_BODY_BYTES } from "@/lib/autosave";
import { getDb } from "@/lib/db";
import { readJsonBody, sameOriginOnly } from "@/lib/http";
import type { EraseEvent, Stroke } from "@/lib/types";
import { isEraseEvent, isStroke } from "@/lib/validate";

// Autosave target. The client (components/SessionCapture) chunks its batches to fit these limits
// (lib/autosave), so a 4xx here means a payload that will never be accepted as sent.
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/sessions/[id]/strokes">) => {
  const { id } = await ctx.params;
  const db = getDb();
  const session = await db.getSession(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });

  const read = await readJsonBody(request, MAX_STROKES_BODY_BYTES);
  if (!read.ok) return read.response;
  const body = read.value;
  if (!body || typeof body !== "object") return Response.json({ error: "body must be an object" }, { status: 400 });
  const { strokes = [], eraseEvents = [] } = body as { strokes?: unknown; eraseEvents?: unknown };
  if (!Array.isArray(strokes) || !Array.isArray(eraseEvents)) {
    return Response.json({ error: "strokes and eraseEvents must be arrays" }, { status: 400 });
  }
  if (strokes.length > MAX_BATCH_ITEMS || eraseEvents.length > MAX_BATCH_ITEMS) {
    return Response.json({ error: "batch too large" }, { status: 400 });
  }
  const badStroke = strokes.findIndex((s) => !isStroke(s));
  if (badStroke >= 0) return Response.json({ error: `invalid stroke at index ${badStroke}` }, { status: 400 });
  const badEvent = eraseEvents.findIndex((e) => !isEraseEvent(e));
  if (badEvent >= 0) return Response.json({ error: `invalid erase event at index ${badEvent}` }, { status: 400 });

  // The URL is authoritative for ownership.
  const cleanStrokes = (strokes as Stroke[]).map((s) => ({ ...s, sessionId: id }));
  const cleanEvents = (eraseEvents as EraseEvent[]).map((e) => ({ ...e, sessionId: id }));
  await db.upsertStrokes(id, cleanStrokes);
  await db.addEraseEvents(id, cleanEvents);
  return Response.json({ ok: true, strokes: cleanStrokes.length, eraseEvents: cleanEvents.length });
});
