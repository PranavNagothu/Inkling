import { getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";

/**
 * Which storage backend is live: `{ ok, backend: "sqlite" | "postgres", timescale }`. Never includes
 * connection details; a database that can't be reached answers 503 with a generic body (the
 * reason goes to the server log only).
 */
export const GET = sameOriginOnly(async () => {
  const headers = { "Cache-Control": "no-store" };
  try {
    const info = await getDb().info();
    return Response.json({ ok: true, ...info }, { headers });
  } catch (err) {
    console.error(`[inkling] health: database unavailable: ${err instanceof Error ? err.message : String(err)}`);
    const backend = process.env.DATABASE_URL?.trim() ? "postgres" : "sqlite";
    return Response.json({ ok: false, backend, timescale: false }, { status: 503, headers });
  }
});
