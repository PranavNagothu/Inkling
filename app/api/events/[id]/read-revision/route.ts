import { MAX_PNG_BYTES, parsePngDataUrl } from "@/lib/ai/dataUrl";
import { failResponse } from "@/lib/ai/http";
import { aiService } from "@/lib/ai/service";
import { readJsonBody, sameOriginOnly } from "@/lib/http";

/** Two base64 PNGs of at most 200 KB each (4/3 inflation) plus JSON framing. */
const MAX_BODY_BYTES = Math.ceil((MAX_PNG_BYTES * 4) / 3) * 2 + 4096;

/**
 * Reads a correction's before/after crops (`{ beforePng, afterPng }`, PNG data URLs rendered by the
 * review page) with a vision model: what changed and the likely misconception. Stored on the
 * revision; a "cosmetic" reading takes the moment off the timeline on the next analysis.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/events/[id]/read-revision">) => {
  const { id } = await ctx.params;
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const body = read.value as { beforePng?: unknown; afterPng?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "body must be { beforePng, afterPng }" }, { status: 400 });
  }
  const before = parsePngDataUrl(body.beforePng);
  if (!before.ok) return Response.json({ error: `beforePng: ${before.error}` }, { status: before.status });
  const after = parsePngDataUrl(body.afterPng);
  if (!after.ok) return Response.json({ error: `afterPng: ${after.error}` }, { status: after.status });
  try {
    const res = await aiService(request.headers).readRevision(id, { beforePng: before.dataUrl, afterPng: after.dataUrl });
    if (!res.ok) return failResponse(res);
    return Response.json({ revision: res.revision, event: res.event });
  } catch (err) {
    console.error(`read-revision failed for ${id}`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn’t read this revision." }, { status: 500 });
  }
});
