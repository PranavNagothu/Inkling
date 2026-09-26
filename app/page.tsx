import Link from "next/link";
import { connection } from "next/server";
import { LOCAL_STUDENT_ID, getDb } from "@/lib/db";
import { countOpenGaps } from "@/lib/gaps";
import { inkCountsLabel } from "@/lib/ink";
import { DEMO_LECTURE } from "@/lib/demo";
import { listLectures } from "@/lib/lecture";
import NewSessionButton from "@/components/NewSessionButton";
import { MomentGlyph } from "@/components/Timeline";
import { ChevronRightIcon, InklingMark, UploadIcon } from "@/components/icons";
import { btnSecondary } from "@/components/ui";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export default async function Home(props: PageProps<"/">) {
  // Always read fresh sessions at request time (never prerender the list).
  await connection();
  const db = getDb();
  const [allSessions, lectures, searchParams, openGaps, strokeCounts] = await Promise.all([
    db.listSessions(),
    listLectures(),
    props.searchParams,
    countOpenGaps(),
    // One aggregate query for every row (lines drawn / erased parts, as on the capture screen).
    db.sessionStrokeCounts(),
  ]);
  // This device's student only (other students' sessions — e.g. the seeded demo's classmates — only
  // feed the class-wide hotspots).
  const sessions = allSessions.filter((s) => s.studentId === LOCAL_STUDENT_ID);
  const lectureTitles = new Map(lectures.map((l) => [l.id, l.title]));
  // After an upload the new lecture arrives pre-selected (?lecture=<id>).
  const requested = typeof searchParams.lecture === "string" ? searchParams.lecture : undefined;
  const defaultLectureId = requested && lectureTitles.has(requested) ? requested : DEMO_LECTURE.lectureId;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 pt-10 pb-16 sm:px-8 sm:pt-16">
      <header className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="flex items-center gap-2.5 font-display text-[2.5rem] leading-none tracking-tight text-ink">
            <InklingMark size={34} className="-mt-1" />
            Inkling
          </h1>
          <Link href="/lectures/new" data-testid="add-lecture" className={btnSecondary}>
            <UploadIcon size={16} />
            Add lecture
          </Link>
        </div>
        <p data-testid="tagline" className="max-w-xl text-lg text-pretty text-ink-muted">
          Every other app deletes your mistakes. We keep them.
        </p>
      </header>

      <section
        aria-label="Start a session"
        className="rounded-lg border border-line bg-chrome p-4 shadow-hairline sm:p-5"
      >
        <NewSessionButton key={defaultLectureId} lectures={lectures} defaultLectureId={defaultLectureId} />
      </section>

      {sessions.length > 0 ? (
        <Link
          href="/progress"
          data-testid="open-gaps-link"
          className="group -my-4 flex min-h-12 items-center gap-3 rounded-lg px-4 text-sm transition-colors hover:bg-chrome-hover"
        >
          <MomentGlyph type="unresolved_gap" size={14} className="shrink-0" />
          <span className="text-ink">
            Open gaps:{" "}
            <span data-testid="open-gaps-count" className="font-semibold tabular-nums">
              {openGaps}
            </span>
          </span>
          <span className="ml-auto flex items-center gap-1 text-ink-subtle transition-colors group-hover:text-accent">
            Progress
            <ChevronRightIcon size={16} />
          </span>
        </Link>
      ) : null}

      <section aria-labelledby="sessions-heading" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between px-1">
          <h2 id="sessions-heading" className="text-sm font-semibold text-ink">
            Sessions
          </h2>
          {sessions.length > 0 ? (
            <span className="text-sm tabular-nums text-ink-subtle">
              {sessions.length} {sessions.length === 1 ? "note" : "notes"}
            </span>
          ) : null}
        </div>

        {sessions.length === 0 ? (
          <div className="paper flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-line px-6 py-10 text-center">
            <p className="font-medium text-ink">No sessions yet</p>
            <p className="text-sm text-pretty text-ink-muted">
              Start one and take notes while the lecture plays.
            </p>
          </div>
        ) : (
          <ul
            data-testid="session-list"
            className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-chrome shadow-hairline"
          >
            {sessions.map((s) => {
              const d = new Date(s.createdAtIso);
              const counts = strokeCounts.get(s.id) ?? { drawn: 0, erasedParts: 0 };
              const label = inkCountsLabel(counts);
              return (
                <li key={s.id} className="flex items-stretch">
                  <Link
                    href={`/session/${s.id}`}
                    data-testid="session-link"
                    className="group flex min-h-16 min-w-0 flex-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-chrome-hover focus-visible:relative"
                  >
                    <span
                      aria-hidden="true"
                      style={{ "--rule-gap": "7px" } as React.CSSProperties}
                      className="paper hidden size-10 shrink-0 rounded-sm border border-line shadow-hairline sm:block"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{s.title}</span>
                      <span className="flex min-w-0 gap-1.5 text-sm text-ink-subtle">
                        <span className="shrink-0 tabular-nums">
                          {dateFmt.format(d)} · {timeFmt.format(d)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span data-testid="session-lecture" className="truncate">
                          {lectureTitles.get(s.lectureId) ?? "Unknown lecture"}
                        </span>
                      </span>
                    </span>
                    <span
                      data-testid="session-stroke-count"
                      data-drawn={counts.drawn}
                      data-erased-parts={counts.erasedParts}
                      className="hidden shrink-0 flex-col items-end text-right text-sm leading-tight tabular-nums sm:flex"
                    >
                      <span className="text-ink-muted">{label.strokes}</span>
                      {label.erased ? <span className="text-xs text-ghost-strong">{label.erased}</span> : null}
                    </span>
                  </Link>
                  <Link
                    href={`/review/${s.id}`}
                    aria-label={`Review ${s.title}`}
                    className="flex min-h-16 shrink-0 items-center gap-1 border-l border-line px-4 text-sm font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:relative"
                  >
                    Review
                    <ChevronRightIcon size={16} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="-mt-4 flex justify-center">
        <Link
          href="/about"
          data-testid="about-link"
          className="inline-flex min-h-11 items-center gap-1 rounded-pill px-3 text-sm text-ink-subtle transition-colors hover:bg-chrome-hover hover:text-ink"
        >
          About this demo · System
          <ChevronRightIcon size={14} />
        </Link>
      </footer>
    </main>
  );
}
