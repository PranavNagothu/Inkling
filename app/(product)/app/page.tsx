import Link from "next/link";
import { connection } from "next/server";
import { LOCAL_STUDENT_ID, getDb } from "@/lib/db";
import { countOpenGaps } from "@/lib/gaps";
import { inkCountsLabel } from "@/lib/ink";
import { DEMO_LECTURE } from "@/lib/demo";
import { listLectures } from "@/lib/lecture";
import NewSessionButton from "@/components/NewSessionButton";
import LiveLectureStart from "@/components/LiveLectureStart";
import { liveLectureDisabled } from "@/lib/liveLecture";
import { MomentGlyph } from "@/components/Timeline";
import { ChevronRightIcon, InklingMark, UploadIcon } from "@/components/icons";
import { Reveal, Stagger, StaggerItem } from "@/components/motion/Reveal";
import { Mark, btnLink, btnSecondary, panelList } from "@/components/ui";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export default async function Home(props: PageProps<"/app">) {
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
    <>
      {/* Home only: the landing page's pearl surface, as a static-ish CSS gradient (no WebGL). */}
      <div aria-hidden="true" className="pearl-bg" />
      <header className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-5 sm:px-8 sm:pt-7">
        <h1 className="flex items-center gap-2.5 font-display text-[2.1rem] leading-none tracking-tight text-ink">
          <InklingMark size={30} className="-mt-1" />
          Inkling
        </h1>
        <nav aria-label="App" className="flex flex-wrap items-center gap-1 sm:gap-2">
          <Link href="/progress" className={`${btnLink} text-ink-muted hover:text-ink`}>
            Progress
          </Link>
          <Link href="/about" className={`${btnLink} text-ink-muted hover:text-ink`}>
            About
          </Link>
          <Link href="/lectures/new" data-testid="add-lecture" className={btnSecondary}>
            <UploadIcon size={16} />
            Add lecture
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-4 pt-10 pb-16 sm:px-8 sm:pt-14">
        <Reveal className="flex flex-col gap-4">
          <p className="eyebrow">Handwriting intelligence</p>
          <p data-testid="tagline" className="page-title max-w-2xl sm:text-[3rem]">
            Every other app deletes your mistakes. We keep <Mark>them.</Mark>
          </p>
          <p className="max-w-xl text-[16.5px] leading-relaxed text-pretty text-ink-muted">
            Take notes while the lecture plays. What you erase stays as ghost ink, and every fix lands on a learning timeline.
          </p>
        </Reveal>

        <Reveal as="section" delay={0.05} className="panel flex flex-col gap-3 p-4 sm:p-6" aria-label="Start a session">
          <NewSessionButton key={defaultLectureId} lectures={lectures} defaultLectureId={defaultLectureId} />
          <div aria-hidden="true" className="my-1 border-t border-line" />
          <LiveLectureStart available={!liveLectureDisabled(process.env)} />
        </Reveal>

        {sessions.length > 0 ? (
          <Link
            href="/progress"
            data-testid="open-gaps-link"
            className="group -my-4 flex min-h-12 items-center gap-3 rounded-pill border border-transparent px-4 text-sm transition-colors hover:border-line hover:bg-chrome/80"
          >
            <MomentGlyph type="unresolved_gap" size={14} className="shrink-0" />
            <span className="text-ink">
              Open gaps:{" "}
              <span data-testid="open-gaps-count" className="font-semibold tabular-nums">
                {openGaps}
              </span>
            </span>
            <span className="ml-auto flex items-center gap-1 font-medium text-ink-subtle transition-colors group-hover:text-accent">
              Progress
              <ChevronRightIcon size={16} />
            </span>
          </Link>
        ) : null}

        <section aria-labelledby="sessions-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 id="sessions-heading" className="eyebrow">
              Sessions
            </h2>
            {sessions.length > 0 ? (
              <span className="text-sm tabular-nums text-ink-subtle">
                {sessions.length} {sessions.length === 1 ? "note" : "notes"}
              </span>
            ) : null}
          </div>

          {sessions.length === 0 ? (
            <div className="panel flex min-h-44 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <span
                aria-hidden="true"
                style={{ "--rule-gap": "7px" } as React.CSSProperties}
                className="paper mb-1 size-11 rounded-md border border-line shadow-raised"
              />
              <p className="font-semibold text-ink">No sessions yet</p>
              <p className="max-w-sm text-sm text-pretty text-ink-muted">
                Start one and take notes while the lecture plays.
              </p>
            </div>
          ) : (
            <Stagger as="ul" data-testid="session-list" className={panelList}>
              {sessions.map((s) => {
                const d = new Date(s.createdAtIso);
                const counts = strokeCounts.get(s.id) ?? { drawn: 0, erasedParts: 0 };
                const label = inkCountsLabel(counts);
                return (
                  <StaggerItem as="li" key={s.id} className="flex items-stretch">
                    <Link
                      href={`/session/${s.id}`}
                      data-testid="session-link"
                      className="group flex min-h-16 min-w-0 flex-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-chrome-hover focus-visible:relative"
                    >
                      <span
                        aria-hidden="true"
                        style={{ "--rule-gap": "7px" } as React.CSSProperties}
                        className="paper hidden size-10 shrink-0 rounded-sm border border-line shadow-raised transition-transform duration-200 ease-out group-hover:-rotate-3 sm:block"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">{s.title}</span>
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
                        {label.erased ? <span className="text-xs font-medium text-ghost-strong">{label.erased}</span> : null}
                      </span>
                    </Link>
                    <Link
                      href={`/review/${s.id}`}
                      aria-label={`Review ${s.title}`}
                      className="flex min-h-16 shrink-0 items-center gap-1 border-l border-line px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent-soft hover:text-accent-press focus-visible:relative"
                    >
                      Review
                      <ChevronRightIcon size={16} />
                    </Link>
                  </StaggerItem>
                );
              })}
            </Stagger>
          )}
        </section>

        {lectures.length > 0 ? (
          <section aria-labelledby="teacher-heading" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1">
              <h2 id="teacher-heading" className="eyebrow">
                For teachers
              </h2>
              <span className="text-sm text-ink-subtle">Anonymous class patterns · no names, no cameras</span>
            </div>
            <Stagger as="ul" data-testid="teacher-lecture-list" className={panelList}>
              {lectures.map((l) => (
                <StaggerItem as="li" key={l.id}>
                  <Link
                    href={`/teacher/${encodeURIComponent(l.id)}`}
                    data-testid="teacher-link"
                    aria-label={`Teacher view: ${l.title}`}
                    className="group flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-chrome-hover focus-visible:relative"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-ink">{l.title}</span>
                      <span className="block truncate text-sm text-ink-subtle">Where did the class get lost?</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-accent group-hover:text-accent-press">
                      Teacher view
                      <ChevronRightIcon size={16} />
                    </span>
                  </Link>
                </StaggerItem>
              ))}
            </Stagger>
          </section>
        ) : null}

        <footer className="-mt-4 flex justify-center">
          <Link
            href="/about"
            data-testid="about-link"
            className="inline-flex min-h-11 items-center gap-1 rounded-pill px-3 text-sm text-ink-subtle transition-colors hover:bg-chrome/80 hover:text-ink"
          >
            About this demo · System
            <ChevronRightIcon size={14} />
          </Link>
        </footer>
      </main>
    </>
  );
}
