import { getDb } from "@/lib/db";

export async function GET(_req: Request, ctx: RouteContext<"/api/sessions/[id]">) {
  const { id } = await ctx.params;
  const db = getDb();
  const session = await db.getSession(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });
  const [strokes, eraseEvents] = await Promise.all([db.getStrokes(id), db.getEraseEvents(id)]);
  return Response.json({ session, strokes, eraseEvents });
}
