import { analyzeSession } from "@/lib/analyze";
import { getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";
import { buildNotabilityExport, exportFileName } from "@/lib/notabilityExport";

/**
 * "Send to Notability": the session as a PDF to import into Notability — the notes with ghost ink
 * and every moment outlined (page 1), then the moments list (page 2). Uses the stored analysis
 * when it matches the ink; a missing or stale one is re-run first (deterministic and idempotent,
 * as the review and compare pages do), so the PDF's moments always match their counts. Always a
 * download (attachment) with nosniff.
 */
export const GET = sameOriginOnly(async (_request: Request, ctx: RouteContext<"/api/sessions/[id]/export">) => {
  const { id } = await ctx.params;
  const db = getDb();
  const session = await db.getSession(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });
  let analysis = await db.getAnalysis(id);
  if (!analysis || analysis.stale) {
    await analyzeSession(id);
    analysis = await db.getAnalysis(id);
  }
  // Read after the analysis, so the ink is at least as new as the moments drawn over it.
  const [strokes, lecture] = await Promise.all([db.getStrokes(id), db.getLecture(session.lectureId)]);

  let pdf: Uint8Array;
  try {
    pdf = await buildNotabilityExport({
      title: session.title,
      lectureTitle: lecture?.lecture.title ?? null,
      strokes,
      events: analysis?.events ?? [],
      revisions: analysis?.revisions ?? [],
    });
  } catch (err) {
    console.error(`[inkling] export ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "Could not build the PDF." }, { status: 500 });
  }

  const name = exportFileName(session.title);
  return new Response(pdf as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Length": String(pdf.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
