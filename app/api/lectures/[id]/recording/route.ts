import { open, unlink } from "node:fs/promises";
import { getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";
import { getLecture } from "@/lib/lecture";
import { LIVE_DEMO_MESSAGE, liveLectureDisabled } from "@/lib/liveLecture";
import { uploadTarget } from "@/lib/storage";
import { MAX_DURATION_MS, MAX_MEDIA_BYTES, sniffContainer, storedFileName, type MediaExt } from "@/lib/upload";

const fail = (status: number, error: string) => Response.json({ error }, { status });

/** What the browser's MediaRecorder produces → how the file is stored and served. */
const FORMATS: Record<string, { container: "webm" | "mp4"; ext: MediaExt; mime: string }> = {
  "audio/webm": { container: "webm", ext: ".webm", mime: "audio/webm" },
  "audio/mp4": { container: "mp4", ext: ".m4a", mime: "audio/mp4" },
};

/**
 * Attaches a Live lecture's microphone recording (the raw MediaRecorder blob as the body,
 * Content-Type audio/webm or audio/mp4, `?durationMs=` on the session clock) as the lecture's media,
 * so Replay 20 s works in review. Same storage, size limit and magic-byte check as uploads. Once a
 * recording is attached the lecture plays back like any uploaded one. 403 in DEMO_MODE.
 */
export const POST = sameOriginOnly(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  if (liveLectureDisabled(process.env)) return fail(403, LIVE_DEMO_MESSAGE);
  const { id } = await ctx.params;

  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) >= 0)) return fail(400, "Bad Content-Length.");
  if (declared !== null && Number(declared) > MAX_MEDIA_BYTES) return fail(413, "Recordings can be at most 300 MB.");
  const format = FORMATS[(request.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim()];
  if (!format) return fail(415, "Expected audio/webm or audio/mp4.");
  const durationMs = Number(new URL(request.url).searchParams.get("durationMs"));
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) {
    return fail(400, "durationMs must be the recording's length in ms.");
  }

  const record = await getLecture(id);
  if (!record) return fail(404, "lecture not found");
  if (!record.lecture.live) return fail(409, "This lecture already has its recording.");
  if (!request.body) return fail(400, "The recording is empty.");

  const { abs, rel } = uploadTarget(storedFileName(format.ext));
  const file = await open(abs, "wx", 0o600);
  let total = 0;
  const head = new Uint8Array(16);
  let headLen = 0;
  let problem: [number, string] | null = null;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        problem = [413, "Recordings can be at most 300 MB."];
        await reader.cancel().catch(() => {});
        break;
      }
      if (headLen < head.length) {
        const take = value.subarray(0, head.length - headLen);
        head.set(take, headLen);
        headLen += take.byteLength;
      }
      await file.write(value);
    }
  } catch {
    problem = [400, "Could not read the recording."];
  } finally {
    await file.close();
  }
  if (!problem && total === 0) problem = [400, "The recording is empty."];
  if (!problem && sniffContainer(head.subarray(0, headLen)) !== format.container) {
    problem = [400, "That doesn't look like a recording in the declared format."];
  }

  const discard = () =>
    unlink(abs).catch((cleanupErr: NodeJS.ErrnoException) => {
      if (cleanupErr.code !== "ENOENT") console.error("live recording cleanup failed", abs, cleanupErr.message);
    });
  if (problem) {
    await discard();
    return fail(problem[0], problem[1]);
  }
  try {
    // Re-checked after the upload: another tab may have attached a recording meanwhile.
    if (!(await getLecture(id))?.lecture.live) {
      await discard();
      return fail(409, "This lecture already has its recording.");
    }
    const lecture = await getDb().setLectureMedia(id, {
      mediaPath: rel,
      mediaType: "audio",
      mime: format.mime,
      durationMs: Math.max(record.lecture.durationMs, Math.round(durationMs)),
    });
    return Response.json({ lecture }, { status: 201 });
  } catch (err) {
    await discard();
    console.error("live recording save failed", err instanceof Error ? err.message : err);
    return fail(500, "Could not save the recording.");
  }
});
