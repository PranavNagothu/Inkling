import { answerCheckQuestion } from "@/lib/gaps";
import { readJsonBody, sameOriginOnly } from "@/lib/http";

/** `{ "choiceIdx": 0..3 }`. */
const MAX_BODY_BYTES = 256;

/**
 * Answers the moment's check question. Graded on the server against the stored card: correct →
 * resolved by check (a corrected misconception becomes a breakthrough); wrong → open again. Gap
 * reconciliation runs in the same step. Responds with the stored moment and every changed event.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/events/[id]/check">) => {
  const { id } = await ctx.params;
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const body = read.value;
  const choiceIdx = body && typeof body === "object" && !Array.isArray(body) ? (body as { choiceIdx?: unknown }).choiceIdx : undefined;
  if (typeof choiceIdx !== "number" || !Number.isInteger(choiceIdx) || choiceIdx < 0 || choiceIdx > 3) {
    return Response.json({ error: "choiceIdx must be an integer from 0 to 3" }, { status: 400 });
  }
  try {
    const result = await answerCheckQuestion(id, choiceIdx);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    const { ok: _ok, ...payload } = result;
    return Response.json(payload);
  } catch (err) {
    console.error(`check failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t save your answer." }, { status: 500 });
  }
});
