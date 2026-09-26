import { stat } from "node:fs/promises";
import { getDb } from "@/lib/db";
import { sameOriginOnly } from "@/lib/http";
import { getLecture, isAiConfigured } from "@/lib/lecture";
import { resolveMediaPath } from "@/lib/storage";
import { TranscribeError, transcribeFile } from "@/lib/transcribe";

/**
 * Auto-transcribes a lecture with Whisper (word timestamps: OpenAI, else Groq) and stores the words.
 * Without OPENAI_API_KEY or GROQ_API_KEY it answers 503 {error: "AI not configured"} and the UI
 * shows a quiet note. Files over 25 MB get a 413 with a clear message.
 */
export const POST = sameOriginOnly(async (_request: Request, ctx: RouteContext<"/api/lectures/[id]/transcribe">) => {
  const { id } = await ctx.params;
  const record = await getLecture(id);
  if (!record) return Response.json({ error: "lecture not found" }, { status: 404 });
  if (!isAiConfigured()) return Response.json({ error: "AI not configured" }, { status: 503 });
  if (record.lecture.transcriptSource === "demo") {
    return Response.json({ error: "The demo lecture already has a transcript." }, { status: 409 });
  }
  const abs = resolveMediaPath(record.mediaPath);
  if (!abs) return Response.json({ error: "media not found" }, { status: 404 });

  try {
    const { size } = await stat(abs);
    const words = await transcribeFile(abs, record.lecture.mime, size);
    const lecture = await getDb().setLectureTranscript(id, words, "whisper");
    return Response.json({ lecture, words });
  } catch (err) {
    if (err instanceof TranscribeError) return Response.json({ error: err.message }, { status: err.status });
    console.error("transcribe failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "Transcription failed." }, { status: 500 });
  }
});
