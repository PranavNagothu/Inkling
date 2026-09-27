import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getTimeline } from "@/lib/analyze";
import CompareView from "@/components/CompareView";
import { isDemoMode } from "@/lib/demoMode";

export const metadata: Metadata = {
  title: "Compare with Notability · Inkling",
  description: "Notability keeps the final page. Here's what it hides.",
};

export default async function ComparePage(props: PageProps<"/compare/[id]">) {
  const { id } = await props.params;
  const db = getDb();
  const session = await db.getSession(id);
  if (!session) notFound();
  const [strokes, timeline, notability] = await Promise.all([db.getStrokes(id), getTimeline(id), db.getNotabilityImport(id)]);
  // Only hand over an analysis that matches the ink; otherwise the client re-runs it.
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
    <CompareView
      session={session}
      strokes={strokes}
      initialTimeline={initialTimeline}
      initialImport={notability?.import ?? null}
      pdfUploadAvailable={!isDemoMode(process.env)}
    />
  );
}
