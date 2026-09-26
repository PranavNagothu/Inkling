import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getLectureGaps } from "@/lib/gaps";
import { getSessionLecture, isAiConfigured } from "@/lib/lecture";
import SessionCapture from "@/components/SessionCapture";

export default async function SessionPage(props: PageProps<"/session/[id]">) {
  const { id } = await props.params;
  const db = getDb();
  const session = await db.getSession(id);
  if (!session) notFound();
  const [strokes, { lecture, words }, lectureGaps] = await Promise.all([
    db.getStrokes(id),
    getSessionLecture(session.lectureId),
    getLectureGaps(session.lectureId, { sessionId: id }),
  ]);
  return (
    <SessionCapture
      session={session}
      lecture={lecture}
      words={words}
      aiConfigured={isAiConfigured()}
      initialStrokes={strokes}
      openGaps={lectureGaps.open}
    />
  );
}
