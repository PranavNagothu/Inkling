import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { getProgress } from "@/lib/gaps";
import { hotspotBars, hotspotSourceLabel } from "@/lib/hotspots";
import { listLectures } from "@/lib/lecture";
import HotspotSparkline from "@/components/HotspotSparkline";
import { RESOLVED_SHORT, formatDay, ordinal, type ProgressThread } from "@/lib/progress";
import { formatClock } from "@/lib/time";
import { MomentGlyph } from "@/components/Timeline";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { BackLink, TopBar } from "@/components/ui";

export const metadata: Metadata = { title: "Progress · Inkling" };

type Filter = "open" | "resolved" | "all";
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function ThreadRow({ t }: { t: ProgressThread }) {
  const open = t.status === "open";
  return (
    <li>
      <Link
        href={`/review/${t.latest.sessionId}?moment=${encodeURIComponent(t.latest.eventId)}`}
        data-testid="progress-thread"
        data-status={t.status}
        data-root-id={t.rootId}
        data-event-id={t.latest.eventId}
        data-resolved-by={t.resolvedBy ?? ""}
        className="group flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-chrome-hover focus-visible:relative"
      >
        <span
          aria-hidden="true"
          className={`inline-flex size-8 shrink-0 items-center justify-center rounded-pill ${
            open ? "bg-gap-soft" : "bg-breakthrough-soft text-breakthrough-strong"
          }`}
        >
          {open ? <MomentGlyph type="unresolved_gap" size={12} /> : <CheckIcon size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink" data-testid="progress-thread-label">
            {t.label}
          </span>
          <span className="flex flex-wrap gap-x-1.5 text-sm text-ink-subtle">
            <span className="font-mono tabular-nums">{formatClock(t.latest.lectureMs)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">First seen {formatDay(t.firstSeenIso)}</span>
            {t.occurrences > 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="progress-thread-repeat" className="font-medium text-gap-strong">
                  {ordinal(t.occurrences)} time
                </span>
              </>
            ) : null}
            {!open && t.resolvedBy ? (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="progress-thread-resolved" className="text-breakthrough-strong">
                  {RESOLVED_SHORT[t.resolvedBy]}
                  {t.resolvedAtIso ? ` ${formatDay(t.resolvedAtIso)}` : ""}
                </span>
              </>
            ) : null}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-pill px-2 py-0.5 text-xs font-semibold ${
            open ? "bg-gap-soft text-gap-strong" : "bg-breakthrough-soft text-breakthrough-strong"
          }`}
        >
          {open ? "Open" : "Resolved"}
        </span>
        <ChevronRightIcon size={16} className="shrink-0 text-ink-subtle transition-colors group-hover:text-accent" />
      </Link>
    </li>
  );
}

export default async function ProgressPage(props: PageProps<"/progress">) {
  await connection();
  const [progress, searchParams] = await Promise.all([getProgress(), props.searchParams]);
  const requested = searchParams.status;
  const filter: Filter = requested === "open" || requested === "resolved" ? requested : "all";
  const counts: Record<Filter, number> = {
    open: progress.openCount,
    resolved: progress.resolvedCount,
    all: progress.openCount + progress.resolvedCount,
  };
  const lectures = progress.lectures
    .map((l) => ({ ...l, threads: l.threads.filter((t) => filter === "all" || t.status === filter) }))
    .filter((l) => l.threads.length > 0);

  // Class-wide context per lecture: where everyone erased most (Tiger Data continuous aggregate on
  // Timescale; the same numbers computed in SQL/TypeScript elsewhere). Best effort.
  const db = getDb();
  const [info, allLectures] = await Promise.all([db.info().catch(() => null), listLectures()]);
  const durations = new Map(allLectures.map((l) => [l.id, l.durationMs]));
  const hotspots = new Map(
    await Promise.all(
      lectures.map(async (l) => {
        const list = await db.lectureInkHotspots(l.lectureId).catch(() => []);
        return [l.lectureId, hotspotBars(list, durations.get(l.lectureId) ?? 0)] as const;
      }),
    ),
  );
  const source = info ? hotspotSourceLabel(info) : "";

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Progress toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="truncate text-base font-semibold text-ink">Progress</h1>
        </div>
      </TopBar>
      <main
        data-testid="progress-page"
        data-filter={filter}
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pt-8 pb-16 sm:px-8 sm:pt-12"
      >
        <header className="flex flex-col gap-2">
          <h2 className="font-display text-[2rem] leading-tight tracking-tight text-balance text-ink">Gaps over time</h2>
          <p className="max-w-xl text-pretty text-ink-muted">
            Every moment you got stuck, per lecture. A gap resolves when you write through that part calmly in a later
            session, or when you say you get it.
          </p>
        </header>

        <nav aria-label="Filter gaps" className="inline-flex self-start rounded-md bg-chrome-press p-0.5">
          {FILTERS.map((f) => {
            const active = f.value === filter;
            return (
              <Link
                key={f.value}
                href={f.value === "all" ? "/progress" : `/progress?status=${f.value}`}
                data-testid={`progress-filter-${f.value}`}
                aria-current={active ? "page" : undefined}
                className={`press inline-flex min-h-11 items-center gap-2 rounded-[8px] px-3.5 text-sm font-medium ${
                  active ? "bg-chrome text-ink shadow-raised" : "text-ink-muted hover:text-ink"
                }`}
              >
                {f.label}
                <span className="tabular-nums text-ink-subtle">{counts[f.value]}</span>
              </Link>
            );
          })}
        </nav>

        {lectures.length === 0 ? (
          <div
            data-testid="progress-empty"
            className="paper flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-line px-6 py-10 text-center"
          >
            <p className="font-medium text-ink">
              {filter === "open" ? "No open gaps" : filter === "resolved" ? "Nothing resolved yet" : "No gaps yet"}
            </p>
            <p className="max-w-sm text-sm text-pretty text-ink-muted">
              {filter === "open"
                ? "Everything you got stuck on has been worked through."
                : "When your notes show you got stuck, it shows up here — and follows you to the next session."}
            </p>
          </div>
        ) : (
          lectures.map((l) => (
            <section
              key={l.lectureId}
              data-testid="progress-lecture"
              data-lecture-id={l.lectureId}
              aria-labelledby={`lecture-${l.lectureId}`}
              className="flex flex-col gap-3"
            >
              <div className="flex items-baseline justify-between gap-4 px-1">
                <h3 id={`lecture-${l.lectureId}`} className="truncate text-sm font-semibold text-ink">
                  {l.lectureTitle}
                </h3>
                <span className="shrink-0 text-sm tabular-nums text-ink-subtle">
                  {l.openCount} open · {l.resolvedCount} resolved
                </span>
              </div>
              {(hotspots.get(l.lectureId) ?? []).some((b) => b.strokes > 0) ? (
                <HotspotSparkline
                  bars={hotspots.get(l.lectureId)!}
                  durationMs={durations.get(l.lectureId) ?? 0}
                  source={source}
                  lectureTitle={l.lectureTitle}
                />
              ) : null}
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-chrome shadow-hairline">
                {l.threads.map((t) => (
                  <ThreadRow key={t.rootId} t={t} />
                ))}
              </ul>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
