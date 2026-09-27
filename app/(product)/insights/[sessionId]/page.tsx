import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { analyzeSession, getTimeline } from "@/lib/analyze";
import { getDb } from "@/lib/db";
import { formatScore, reviewHref, shapeSignalLab } from "@/lib/insights";
import { getSessionLecture } from "@/lib/lecture";
import { formatClock } from "@/lib/time";
import type { TimelineData } from "@/lib/types";
import SignalChart from "@/components/SignalChart";
import SignalLegend from "@/components/SignalLegend";
import { ChevronRightIcon } from "@/components/icons";
import { BackLink, Mark, PageHeader, TopBar, btnLink } from "@/components/ui";

export const metadata: Metadata = {
  title: "Signal Lab · Inkling",
  description: "The hesitation signals behind every flagged moment: pause, slowdown, erasing and pressure over lecture time.",
};

function Stat({ label, value, note, testId }: { label: string; value: string; note?: string; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5 panel rounded-lg px-4 py-3">
      <dt className="text-xs font-bold tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd data-testid={testId} className="text-2xl font-extrabold tracking-tight text-ink tabular-nums">
        {value}
      </dd>
      {note ? <dd className="font-mono text-xs tabular-nums text-ink-subtle">{note}</dd> : null}
    </div>
  );
}

export default async function SignalLabPage(props: PageProps<"/insights/[sessionId]">) {
  const { sessionId } = await props.params;
  const db = getDb();
  const session = await db.getSession(sessionId);
  if (!session) notFound();

  const [stored, { lecture }] = await Promise.all([getTimeline(sessionId), getSessionLecture(session.lectureId)]);
  // Same rule as the review page: never show an analysis that doesn't match the ink. Analysis is
  // deterministic and idempotent, so running it here is what opening the review would do.
  let timeline: TimelineData | null = stored && stored.analyzed && !stored.stale ? stored : null;
  if (!timeline) timeline = await analyzeSession(sessionId);
  if (!timeline) notFound();

  const data = shapeSignalLab(timeline);
  const scored = data.points.filter((p) => p.phase === "scored").length;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Signal Lab toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="shrink-0 text-base font-bold tracking-tight text-ink">Signal Lab</h1>
          <span aria-hidden="true" className="hidden px-1 text-ink-subtle sm:inline">
            ·
          </span>
          <span className="hidden truncate text-sm font-medium text-ink-muted sm:inline">{session.title}</span>
        </div>
        <Link
          href={reviewHref(sessionId, null)}
          className={btnLink}
        >
          Open review
          <ChevronRightIcon size={16} />
        </Link>
      </TopBar>

      <main
        data-testid="signal-lab"
        data-session-id={sessionId}
        className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 pt-8 pb-16 sm:px-8 sm:pt-12"
      >
        <PageHeader
          eyebrow="Signal Lab"
          title={
            <>
              What your pen said, every <Mark>10 seconds</Mark>
            </>
          }
          lede={
            <>
              The four hesitation signals Inkling reads from your handwriting in{" "}
              <span className="font-medium text-ink">{lecture.title}</span>, the score they add up to, and the line a
              window has to cross to be flagged. Hover or use the arrow keys for the details; select a spike to open that
              moment.
            </>
          }
        />

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Spikes flagged" value={String(data.spikeCount)} testId="signal-stat-spikes" />
          <Stat
            label="Highest score"
            value={data.peak ? formatScore(data.peak.score) : "—"}
            note={data.peak ? `at ${formatClock(data.peak.startMs)}` : undefined}
            testId="signal-stat-peak"
          />
          <Stat label="Baseline measured" value={`${Math.round(data.baselineMs / 1000)} s`} note="your normal" testId="signal-stat-baseline" />
          <Stat label="Windows scored" value={String(scored)} note={`of ${data.points.length}`} testId="signal-stat-scored" />
        </dl>

        {data.points.length === 0 ? (
          <div
            data-testid="signal-empty"
            className="panel flex min-h-44 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
          >
            <p className="font-semibold text-ink">No signals yet</p>
            <p className="max-w-sm text-sm text-pretty text-ink-muted">Write some notes in this session and the signals show up here.</p>
          </div>
        ) : (
          <SignalChart data={data} sessionId={sessionId} sessionTitle={session.title} />
        )}

        <SignalLegend />

        <Link
          href="/insights/evaluation"
          data-testid="signal-evaluation-link"
          className={`${btnLink} self-start`}
        >
          How accurate is this? Model evaluation
          <ChevronRightIcon size={16} />
        </Link>
      </main>
    </div>
  );
}
