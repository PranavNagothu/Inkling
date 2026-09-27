import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { cuesToWords, parseCaptions } from "@/lib/captions";
import { getDb } from "@/lib/db";
import { UPLOAD_DEMO_MESSAGE, demoForbidden, isDemoMode } from "@/lib/demoMode";
import { sameOriginOnly } from "@/lib/http";
import { listLectures } from "@/lib/lecture";
import { uploadTarget } from "@/lib/storage";
import {
  MAX_CAPTIONS_BYTES,
  MAX_MEDIA_BYTES,
  MAX_UPLOAD_BYTES,
  checkCaptionsFile,
  checkMediaFile,
  parseDurationMs,
  sanitizeTitle,
  sniffContainer,
  storedFileName,
  titleFromFileName,
} from "@/lib/upload";
import type { TranscriptWord } from "@/lib/types";

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function GET() {
  return Response.json({ lectures: await listLectures() });
}

/**
 * Upload a lecture: multipart/form-data with `media` (audio/video), optional `captions` (.vtt/.srt),
 * `title` and `durationMs` (read by the browser from the media element).
 *
 * Route handlers have no body-size limit of their own in Next 16 (proxyClientMaxBodySize only
 * applies when a proxy is configured, and this app has none), so the limit is enforced here from
 * Content-Length before the body is read.
 *
 * Disabled in DEMO_MODE (403, before the body is read): a public demo never stores uploads.
 */
export const POST = sameOriginOnly(async (request: Request) => {
  if (isDemoMode(process.env)) return demoForbidden(UPLOAD_DEMO_MESSAGE);
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isFinite(length) || length < 0) return fail(411, "Content-Length is required.");
  if (length > MAX_UPLOAD_BYTES) return fail(413, "Upload is too large.");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return fail(415, "Expected multipart/form-data.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "Could not read the upload.");
  }

  const media = form.get("media");
  if (!(media instanceof File)) return fail(400, "A media file is required.");
  if (media.size > MAX_MEDIA_BYTES) return fail(413, "Media files can be at most 300 MB.");
  const mediaCheck = checkMediaFile(media);
  if (!mediaCheck.ok) return fail(400, mediaCheck.error);

  const duration = parseDurationMs(form.get("durationMs"));
  if (!duration.ok) return fail(400, duration.error);

  // The bytes must agree with the extension and declared type.
  const head = new Uint8Array(await media.slice(0, 16).arrayBuffer());
  if (sniffContainer(head) !== mediaCheck.value.container) {
    return fail(400, "That file doesn't look like the audio/video format its name says.");
  }

  let words: TranscriptWord[] = [];
  const captions = form.get("captions");
  if (captions instanceof File && captions.size > 0) {
    if (captions.size > MAX_CAPTIONS_BYTES) return fail(413, "Captions files can be at most 2 MB.");
    const capCheck = checkCaptionsFile(captions);
    if (!capCheck.ok) return fail(400, capCheck.error);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await captions.arrayBuffer());
    } catch {
      return fail(400, "Captions must be UTF-8 text.");
    }
    words = cuesToWords(parseCaptions(text));
    if (words.length === 0) return fail(400, "No captions found in that file.");
  } else if (captions !== null && typeof captions === "string" && captions !== "") {
    return fail(400, "Captions must be a file.");
  }

  const title = sanitizeTitle(form.get("title"), titleFromFileName(media.name) || "Untitled lecture");
  const { abs, rel } = uploadTarget(storedFileName(mediaCheck.value.ext));
  try {
    await pipeline(
      Readable.fromWeb(media.stream() as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(abs, { flags: "wx", mode: 0o600 }),
    );
    const lecture = await getDb().createLecture({
      title,
      courseId: "general",
      mediaPath: rel,
      mediaType: mediaCheck.value.mediaType,
      mime: mediaCheck.value.mime,
      durationMs: duration.value,
      words,
      transcriptSource: words.length > 0 ? "captions" : "none",
    });
    return Response.json({ lecture }, { status: 201 });
  } catch (err) {
    await unlink(abs).catch((cleanupErr: NodeJS.ErrnoException) => {
      // ENOENT: nothing was written. Anything else leaves an orphaned file behind — say so.
      if (cleanupErr.code !== "ENOENT") {
        console.error("lecture upload cleanup failed", abs, cleanupErr.message);
      }
    });
    console.error("lecture upload failed", err instanceof Error ? err.message : err);
    return fail(500, "Could not save the lecture.");
  }
});
