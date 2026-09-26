import { getDb } from "@/lib/db";
import { DEMO_LECTURE } from "@/lib/demo";
import { readBodyText, sameOriginOnly } from "@/lib/http";
import { getLecture } from "@/lib/lecture";

/** A new-session body is a title and a lecture id; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 16 * 1024;

export async function GET() {
  const sessions = await getDb().listSessions();
  return Response.json({ sessions });
}

export const POST = sameOriginOnly(async (request: Request) => {
  const read = await readBodyText(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  let body: unknown = {};
  const text = read.value;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "body must be an object" }, { status: 400 });
  }
  const { title, lectureId } = body as { title?: unknown; lectureId?: unknown };
  if (title !== undefined && (typeof title !== "string" || title.length > 200)) {
    return Response.json({ error: "title must be a string (<=200 chars)" }, { status: 400 });
  }
  if (lectureId !== undefined && (typeof lectureId !== "string" || lectureId.length > 200)) {
    return Response.json({ error: "lectureId must be a string" }, { status: 400 });
  }
  // Defaults to the demo lecture.
  const record = await getLecture(lectureId ?? DEMO_LECTURE.lectureId);
  if (!record) return Response.json({ error: "unknown lecture" }, { status: 400 });
  const session = await getDb().createSession({
    title,
    lectureId: record.lecture.id,
    courseId: record.lecture.courseId,
  });
  return Response.json({ session }, { status: 201 });
});
