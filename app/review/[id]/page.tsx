import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { aiService } from "@/lib/ai/service";
import { getDb } from "@/lib/db";
import { getTimeline } from "@/lib/analyze";
import { getLectureGaps } from "@/lib/gaps";
import { getSessionLecture } from "@/lib/lecture";
import ReviewView from "@/components/ReviewView";

export default async function ReviewPage(props: PageProps<"/review/[id]">) {
  const [{ id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const db = getDb();
  const session = await db.getSession(id);
  if (!session) notFound();
  const [strokes, eraseEvents, timeline, { lecture, words }, lectureGaps] = await Promise.all([
    db.getStrokes(id),
    db.getEraseEvents(id),
    getTimeline(id),
    getSessionLecture(session.lectureId),
    getLectureGaps(session.lectureId, { sessionId: id }),
  ]);
  // ?moment=<eventId> opens that moment (links from /progress and "Carried over").
  const moment = typeof searchParams.moment === "string" && searchParams.moment.length <= 300 ? searchParams.moment : null;
  // Only hand over an analysis that matches the ink; otherwise the client re-runs it (shows "Analyzing…").
  const initialTimeline =
    timeline && timeline.analyzed && !timeline.stale
      ? {
          durationMs: timeline.durationMs,
          windows: timeline.windows,
          revisions: timeline.revisions,
          events: timeline.events,
          baseline: timeline.baseline,
        }
      : null;
  return (
    <ReviewView
      session={session}
      lecture={lecture}
      words={words}
      strokes={strokes}
      eraseEvents={eraseEvents}
      initialTimeline={initialTimeline}
      initialMomentId={moment}
      initialCarried={lectureGaps.carried}
      ai={aiService(await headers()).status()}
    />
  );
}
