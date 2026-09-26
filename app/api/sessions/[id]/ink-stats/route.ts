import { MAX_STATS_WINDOW_MS, MIN_STATS_WINDOW_MS, getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";

const DEFAULT_WINDOW_MS = 10_000;

/**
 * Per-window ink activity of a session (`?windowMs=`, default 10 s): strokes, erased, ink length,
 * median speed and mean pen pressure per lecture-time window. On Tiger Data this is a TimescaleDB
 * time_bucket query over the ink_samples hypertable.
 */
export const GET = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/sessions/[id]/ink-stats">) => {
  const { id } = await ctx.params;
  const param = new URL(request.url).searchParams.get("windowMs");
  const windowMs = param === null ? DEFAULT_WINDOW_MS : Number(param);
  if (!/^\d{1,7}$/.test(param ?? String(DEFAULT_WINDOW_MS)) || windowMs < MIN_STATS_WINDOW_MS || windowMs > MAX_STATS_WINDOW_MS) {
    return Response.json(
      { error: `windowMs must be an integer between ${MIN_STATS_WINDOW_MS} and ${MAX_STATS_WINDOW_MS}` },
      { status: 400 },
    );
  }
  const db = getDb();
  if (!(await db.getSession(id))) return Response.json({ error: "session not found" }, { status: 404 });
  return Response.json({ sessionId: id, windowMs, windows: await db.inkWindowStats(id, windowMs) });
});
