import "server-only";

// Lectures are data (lib/db.ts `lectures` table). The demo lecture is seeded on startup; others
// come from uploads. Transcripts stay server side except where a page explicitly ships them.
import { getDb, type LectureRecord } from "./db";
import { DEMO_LECTURE } from "./demo";
import { selectTranscriber } from "./transcribe";
import type { Lecture } from "./types";

export type { LectureRecord };

export async function getLecture(id: string): Promise<LectureRecord | null> {
  return getDb().getLecture(id);
}

export async function listLectures(): Promise<Lecture[]> {
  return getDb().listLectures();
}

/**
 * The lecture a session was recorded against. Falls back to the demo lecture when the row is gone
 * (e.g. a session from before lectures were stored), so old sessions keep analysing identically.
 */
export async function getSessionLecture(lectureId: string): Promise<LectureRecord> {
  const found = await getLecture(lectureId);
  if (found) return found;
  const demo = await getLecture(DEMO_LECTURE.lectureId);
  if (!demo) throw new Error("demo lecture missing");
  return demo;
}

/** Whether Whisper auto-transcription can run (OPENAI_API_KEY, else GROQ_API_KEY; see ./transcribe). */
export function isAiConfigured(): boolean {
  return selectTranscriber(process.env) !== null;
}
