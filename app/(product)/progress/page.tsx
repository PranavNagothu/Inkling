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
import { Stagger, StaggerItem } from "@/components/motion/Reveal";
import { BackLink, Mark, PageHeader, TopBar, btnLink, panelList } from "@/components/ui";

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
    <StaggerItem as="li">
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
            open ? "bg-gap-soft" : "bg-ok-soft text-ok-strong"
          }`}
        >
          {open ? <MomentGlyph type="unresolved_gap" size={12} /> : <CheckIcon size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-ink" data-testid="progress-thread-label">
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
                <span data-testid="progress-thread-resolved" className="text-ok-strong">
                  {RESOLVED_SHORT[t.resolvedBy]}
                  {t.resolvedAtIso ? ` ${formatDay(t.resolvedAtIso)}` : ""}
                </span>
              </>
            ) : null}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-pill px-2 py-0.5 text-xs font-semibold ${
            open ? "bg-gap-soft text-gap-strong" : "bg-ok-soft text-ok-strong"
          }`}
        >
          {open ? "Open" : "Resolved"}
        </span>
        <ChevronRightIcon size={16} className="shrink-0 text-ink-subtle transition-colors group-hover:text-accent" />
      </Link>
    </StaggerItem>
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
  // Signal Lab links: this student's sessions of each lecture.
  const mySessions = (await db.listSessions().catch(() => [])).filter((s) => s.studentId === progress.studentId);

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Progress toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="truncate text-base font-bold tracking-tight text-ink">Progress</h1>
        </div>
      </TopBar>
      <main
        data-testid="progress-page"
        data-filter={filter}
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pt-8 pb-16 sm:px-8 sm:pt-12"
      >
        <PageHeader
          eyebrow="Progress"
          title={
            <>
              Gaps over <Mark>time</Mark>
            </>
          }
          lede="Every moment you got stuck, per lecture. A gap resolves when you write through that part calmly in a later session, or when you say you get it."
        />

        <nav aria-label="Filter gaps" className="inline-flex gap-0.5 self-start rounded-pill border border-line bg-chrome-press/70 p-0.5">
          {FILTERS.map((f) => {
            const active = f.value === filter;
            return (
              <Link
                key={f.value}
                href={f.value === "all" ? "/progress" : `/progress?status=${f.value}`}
                data-testid={`progress-filter-${f.value}`}
                aria-current={active ? "page" : undefined}
                className={`press inline-flex min-h-11 items-center gap-2 rounded-pill px-4 text-sm font-semibold ${
                  active ? "bg-ink text-white shadow-raised" : "text-ink-muted hover:bg-chrome hover:text-ink"
                }`}
              >
                {f.label}
                <span className={`tabular-nums ${active ? "text-white/75" : "text-ink-subtle"}`}>{counts[f.value]}</span>
              </Link>
            );
          })}
        </nav>

        {lectures.length === 0 ? (
          <div
            data-testid="progress-empty"
            className="panel flex min-h-44 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
          >
            <MomentGlyph type="unresolved_gap" size={18} className="mb-1" />
            <p className="font-semibold text-ink">
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
                <h3 id={`lecture-${l.lectureId}`} className="truncate text-[15px] font-bold tracking-tight text-ink">
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
              <Stagger as="ul" className={panelList}>
                {l.threads.map((t) => (
                  <ThreadRow key={t.rootId} t={t} />
                ))}
              </Stagger>
              {mySessions.some((s) => s.lectureId === l.lectureId) ? (
                <nav aria-label={`Signal Lab for ${l.lectureTitle}`} className="flex flex-wrap items-center gap-x-1 px-1 text-sm">
                  <span className="text-ink-subtle">Signal Lab:</span>
                  {mySessions
                    .filter((s) => s.lectureId === l.lectureId)
                    .slice(0, 8) // newest first
                    .map((s) => (
                      <Link
                        key={s.id}
                        href={`/insights/${encodeURIComponent(s.id)}`}
                        data-testid="progress-signal-lab"
                        data-session-id={s.id}
                        className={`${btnLink} px-2.5`}
                      >
                        {s.title}
                      </Link>
                    ))}
                </nav>
              ) : null}
            </section>
          ))
        )}
      </main>
    </div>
  );
}
