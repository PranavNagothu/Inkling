import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getDb } from "@/lib/db";
import { contentDisposition } from "@/lib/notability";
import { resolvePdfPath } from "@/lib/storage";

/**
 * Streams a session's current Notability PDF. Served as application/pdf, inline, with nosniff so
 * the bytes are never interpreted as anything else. The compare page fetches it and renders it
 * with pdf.js; the ETag (the import id) lets a revisit skip the download.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/notability/file">) {
  const { id } = await ctx.params;
  const record = await getDb().getNotabilityImport(id);
  const abs = record ? resolvePdfPath(record.storedName) : null;
  if (!record || !abs) return Response.json({ error: "no Notability PDF for this session" }, { status: 404 });

  let size: number;
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return Response.json({ error: "PDF not found" }, { status: 404 });
  }

  const etag = `"${record.import.id}"`;
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition(record.import.fileName),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
    ETag: etag,
  });
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  headers.set("Content-Length", String(size));
  const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}
