import { writeFile, unlink } from "node:fs/promises";
import { getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";
import {
  MAX_PDF_BYTES,
  MAX_PDF_UPLOAD_BYTES,
  PDF_HEADER_BYTES,
  checkPdfFile,
  countPdfPages,
  isPdfHeader,
  sanitizePdfDisplayName,
  storedPdfName,
} from "@/lib/notability";
import { pdfUploadTarget } from "@/lib/storage";

const fail = (status: number, error: string) => Response.json({ error }, { status });

/** The session's current Notability import (metadata only), or null. */
export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[id]/notability">) {
  const { id } = await ctx.params;
  const db = getDb();
  if (!(await db.getSession(id))) return fail(404, "session not found");
  const record = await db.getNotabilityImport(id);
  return Response.json({ import: record?.import ?? null });
}

/**
 * Upload a Notability PDF export for a session: multipart/form-data with `file`. Replacing an
 * earlier upload keeps its history row but makes this one current.
 *
 * Route handlers have no body-size limit of their own in Next 16, so the limit is enforced here
 * from Content-Length before the body is read (as for lecture uploads).
 */
export const POST = sameOriginOnly(async (request: Request, ctx: RouteContext<"/api/sessions/[id]/notability">) => {
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isFinite(length) || length < 0) return fail(411, "Content-Length is required.");
  if (length > MAX_PDF_UPLOAD_BYTES) return fail(413, "PDFs can be at most 50 MB.");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return fail(415, "Expected multipart/form-data.");
  }

  const { id } = await ctx.params;
  const db = getDb();
  if (!(await db.getSession(id))) return fail(404, "session not found");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "Could not read the upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "A PDF file is required.");
  if (file.size > MAX_PDF_BYTES) return fail(413, "PDFs can be at most 50 MB.");
  const check = checkPdfFile(file);
  if (!check.ok) return fail(400, check.error);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPdfHeader(bytes.subarray(0, PDF_HEADER_BYTES))) {
    return fail(400, "That file isn’t a PDF. In Notability, use Share → Export → PDF.");
  }

  const storedName = storedPdfName();
  const abs = pdfUploadTarget(storedName);
  try {
    // "wx": never overwrite; 0o600: readable by the server user only.
    await writeFile(abs, bytes, { flag: "wx", mode: 0o600 });
    const saved = await db.addNotabilityImport({
      sessionId: id,
      fileName: sanitizePdfDisplayName(file.name),
      storedName,
      pageCount: countPdfPages(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")),
      size: bytes.byteLength,
    });
    return Response.json({ import: saved }, { status: 201 });
  } catch (err) {
    await unlink(abs).catch((cleanupErr: NodeJS.ErrnoException) => {
      // ENOENT: nothing was written. Anything else leaves an orphaned file behind — say so.
      if (cleanupErr.code !== "ENOENT") console.error("notability upload cleanup failed", abs, cleanupErr.message);
    });
    console.error("notability upload failed", err instanceof Error ? err.message : err);
    return fail(500, "Could not save the PDF.");
  }
});
