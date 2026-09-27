import { getDb } from "@/lib/db";
import { readJsonBody, sameOriginOnly } from "@/lib/http";
import { LIVE_DEMO_MESSAGE, liveLectureDisabled } from "@/lib/liveLecture";
import { sanitizeTitle } from "@/lib/upload";

/** A new Live lecture is a title; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Creates a Live lecture (no media yet; transcribed in the browser while it happens) and a session
 * on it: `{ title? }` → 201 `{ lecture, session }`. The recording is attached later by
 * POST /api/lectures/[id]/recording. Disabled in DEMO_MODE (403), so a public demo never collects
 * audio or fills its disk.
 */
export const POST = sameOriginOnly(async (request: Request) => {
  if (liveLectureDisabled(process.env)) return Response.json({ error: LIVE_DEMO_MESSAGE }, { status: 403 });
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const body = read.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "body must be an object" }, { status: 400 });
  }
  const { title: rawTitle } = body as { title?: unknown };
  if (rawTitle !== undefined && (typeof rawTitle !== "string" || rawTitle.length > 200)) {
    return Response.json({ error: "title must be a string (<=200 chars)" }, { status: 400 });
  }
  const title = sanitizeTitle(rawTitle, `Live lecture — ${new Date().toLocaleDateString("en-US")}`);
  const db = getDb();
  const lecture = await db.createLecture({
    title,
    courseId: "general",
    // No recording yet: the media fields are filled in when the browser uploads it.
    mediaPath: "",
    mediaType: "audio",
    mime: "audio/webm",
    durationMs: 0,
    words: [],
    transcriptSource: "live",
  });
  const session = await db.createSession({ title, lectureId: lecture.id, courseId: lecture.courseId });
  return Response.json({ lecture, session }, { status: 201 });
});
