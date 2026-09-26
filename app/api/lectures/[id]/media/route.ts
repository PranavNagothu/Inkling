import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getLecture } from "@/lib/lecture";
import { parseRange } from "@/lib/range";
import { resolveMediaPath } from "@/lib/storage";

/**
 * Streams a lecture's media with HTTP Range support (206 / Content-Range / Accept-Ranges), which
 * seeking needs everywhere and iPad Safari needs to play at all. The demo lecture is served here
 * too, so every lecture takes the same path.
 */
async function serve(request: Request, ctx: RouteContext<"/api/lectures/[id]/media">, withBody: boolean) {
  const { id } = await ctx.params;
  const record = await getLecture(id);
  const abs = record ? resolveMediaPath(record.mediaPath) : null;
  if (!record || !abs) return Response.json({ error: "lecture not found" }, { status: 404 });

  let size: number;
  let mtime: Date;
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
    mtime = st.mtime;
  } catch {
    return Response.json({ error: "media not found" }, { status: 404 });
  }

  const etag = `"${size.toString(36)}-${Math.floor(mtime.getTime()).toString(36)}"`;
  const headers = new Headers({
    "Content-Type": record.lecture.mime,
    "Accept-Ranges": "bytes",
    // no-transform keeps any compression layer away from byte ranges.
    "Cache-Control": "private, max-age=3600, no-transform",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
    "Last-Modified": mtime.toUTCString(),
  });

  // A stale If-Range means the client's cached bytes are from another version: send it all.
  const ifRange = request.headers.get("if-range");
  const rangeHeader = ifRange && ifRange !== etag ? null : request.headers.get("range");
  const range = parseRange(rangeHeader, size);

  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const [start, end] = range.kind === "partial" ? [range.start, range.end] : [0, size - 1];
  headers.set("Content-Length", String(size === 0 ? 0 : end - start + 1));
  if (range.kind === "partial") headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const status = range.kind === "partial" ? 206 : 200;

  if (!withBody || size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(abs, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

export function GET(request: Request, ctx: RouteContext<"/api/lectures/[id]/media">) {
  return serve(request, ctx, true);
}

export function HEAD(request: Request, ctx: RouteContext<"/api/lectures/[id]/media">) {
  return serve(request, ctx, false);
}
