import { selfResolveGap } from "@/lib/gaps";
import { readJsonBody, sameOriginOnly } from "@/lib/http";

/** `{ "action": "self" | "reopen" }` — nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 1024;

/**
 * "I get it now" (action "self") / "Still confused" (action "reopen") on an unresolved gap.
 * Responds with the gap's session's gaps as stored afterwards (with history).
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/events/[id]/resolve">) => {
  const { id } = await ctx.params;
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const body = read.value;
  const action = body && typeof body === "object" && !Array.isArray(body) ? (body as { action?: unknown }).action : undefined;
  if (action !== "self" && action !== "reopen") {
    return Response.json({ error: 'action must be "self" or "reopen"' }, { status: 400 });
  }
  const result = await selfResolveGap(id, action);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ events: result.events });
});
