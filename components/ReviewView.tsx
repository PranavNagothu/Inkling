"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AiStatus } from "@/lib/ai/types";
import type {
  EraseEvent,
  Lecture,
  Revision,
  Session,
  Stroke,
  TimelineData,
  TimelineEvent,
  TimelineEventType,
  TranscriptWord,
} from "@/lib/types";
import { hiddenStats } from "@/lib/compare";
import type { CarriedThread, LectureGapsPayload, SelfAction } from "@/lib/progress";
import CarriedOver from "./CarriedOver";
import { activeStrokes, inkCounts } from "@/lib/ink";
import { lectureMediaUrl } from "@/lib/media";
import { MOMENT_META } from "@/lib/moments";
import InkCanvas from "./InkCanvas";
import LectureMedia from "./LectureMedia";
import MomentDetail from "./MomentDetail";
import Timeline, { MomentGlyph } from "./Timeline";
import { CompareIcon, PenIcon } from "./icons";
import { useSessionTimeline } from "./useSessionTimeline";
import { BackLink, GhostToggle, TopBar, btnSecondary } from "./ui";

interface Props {
  session: Session;
  lecture: Lecture;
  /** The lecture's word-level transcript ([] when it has none). */
  words: TranscriptWord[];
  strokes: Stroke[];
  eraseEvents: EraseEvent[];
  /** Stored, up-to-date analysis; null when the session still needs analysing (done on mount). */
  initialTimeline: TimelineData | null;
  /** Moment to open first (from ?moment=<eventId>). */
  initialMomentId?: string | null;
  /** Gaps from earlier sessions of this lecture, as seen from this one. */
  initialCarried: CarriedThread[];
  /** Whether AI explanations are available (and from which provider). */
  ai: AiStatus;
}

function Stat({
  label,
  value,
  testId,
  ghost = false,
  moment,
}: {
  label: string;
  value: number;
  testId: string;
  ghost?: boolean;
  moment?: TimelineEventType;
}) {
  return (
    <li className="inline-flex min-h-9 items-center gap-2 rounded-pill border border-line bg-chrome px-3.5 text-sm">
      {ghost ? (
        <span aria-hidden="true" className="inline-block w-3.5 border-t-2 border-dashed border-ghost" />
      ) : null}
      {moment ? <MomentGlyph type={moment} size={12} /> : null}
      <span className="font-semibold tabular-nums text-ink" data-testid={testId}>
        {value}
      </span>
      <span className="text-ink-muted">{label}</span>
    </li>
  );
}

const plural = (type: TimelineEventType, n: number) => MOMENT_META[type].plural[n === 1 ? 0 : 1];

export default function ReviewView({
  session,
  lecture,
  words,
  strokes,
  eraseEvents,
  initialTimeline,
  initialMomentId = null,
  initialCarried,
  ai,
}: Props) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialMomentId);
  const [carried, setCarried] = useState<CarriedThread[]>(initialCarried);

  const refreshCarried = useCallback(async () => {
    try {
      const res = await fetch(`/api/lectures/${encodeURIComponent(lecture.id)}/open-gaps?session=${encodeURIComponent(session.id)}`);
      if (res.ok) setCarried(((await res.json()) as LectureGapsPayload).carried);
    } catch (err) {
      console.error("Could not refresh carried-over gaps", err);
    }
  }, [lecture.id, session.id]);

  // Opened without a fresh analysis (e.g. from the home list): analysed on mount. A fresh analysis
  // may have resolved gaps from earlier sessions, so "Carried over" is refreshed after it.
  const { timeline, setTimeline, status, retry } = useSessionTimeline(session.id, initialTimeline, () => void refreshCarried());

  // The page as it is (strokes cut by a partial erase are represented by their pieces)…
  const active = useMemo(() => activeStrokes(strokes), [strokes]);
  // …but the summary counts lines the student drew ("1 stroke", not its 3 pieces).
  const drawn = useMemo(() => inkCounts(strokes).drawn, [strokes]);
  const strokesById = useMemo(() => new Map(strokes.map((s) => [s.id, s])), [strokes]);

  const events = useMemo(() => timeline?.events ?? [], [timeline]);
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const revision = selected?.revisionId ? timeline?.revisions.find((r) => r.id === selected.revisionId) : undefined;
  // Shared with the compare page ("What the final page hides") so the two always agree.
  const stats = hiddenStats(strokes, events);
  const erased = stats.erased;
  const counts = {
    misconception_corrected: stats.corrections,
    unresolved_gap: stats.gaps,
    breakthrough: stats.breakthroughs,
  };
  const highlight = useMemo(
    () => (selected && revision ? { bbox: revision.bbox, color: MOMENT_META[selected.type].color } : null),
    [selected, revision],
  );

  /** "I get it now" / "Still confused" on the selected gap; merges the stored result. */
  const selfAction = useCallback(
    async (action: SelfAction) => {
      if (!selectedId) return;
      const res = await fetch(`/api/events/${encodeURIComponent(selectedId)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
      const { events: updated } = (await res.json()) as { events: TimelineEvent[] };
      const byId = new Map(updated.map((e) => [e.id, e]));
      setTimeline((t) => (t ? { ...t, events: t.events.map((e) => byId.get(e.id) ?? e) } : t));
      void refreshCarried();
    },
    [selectedId, refreshCarried, setTimeline],
  );

  /** Events the server changed (check answers, better concept labels): merge by id. */
  const mergeEvents = useCallback(
    (updated: TimelineEvent[]) => {
      if (updated.length === 0) return;
      const byId = new Map(updated.map((e) => [e.id, e]));
      setTimeline((t) => (t ? { ...t, events: t.events.map((e) => byId.get(e.id) ?? e) } : t));
      // A check answer can resolve (or reopen) a gap: keep "Carried over" in step.
      if (updated.some((e) => e.type === "unresolved_gap" || e.checkAttempts.length > 0)) void refreshCarried();
    },
    [setTimeline, refreshCarried],
  );

  const updateRevision = useCallback(
    (rev: Revision) => setTimeline((t) => (t ? { ...t, revisions: t.revisions.map((r) => (r.id === rev.id ? rev : r)) } : t)),
    [setTimeline],
  );

  const close = useCallback(() => {
    const id = selectedId;
    setSelectedId(null);
    // Return focus to the marker that opened the panel.
    if (id) document.querySelector<HTMLElement>(`[data-testid="timeline-marker"][data-event-id="${CSS.escape(id)}"]`)?.focus();
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedId, close]);

  return (
    // Wide screens: one viewport tall, so the moment panel scrolls on its own beside the page and
    // the timeline stays in view while reading an explanation.
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <TopBar label="Review toolbar">
        <div className="flex min-w-[10rem] flex-1 items-center gap-1">
          <BackLink />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium tracking-wide text-ink-subtle uppercase">
              Review <span className="normal-case tracking-normal">· {lecture.title}</span>
            </p>
            <h1 className="truncate text-base leading-tight font-semibold text-ink">{session.title}</h1>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <GhostToggle checked={showGhost} onChange={setShowGhost} />
          <Link href={`/compare/${session.id}`} data-testid="compare-link" className={btnSecondary}>
            <CompareIcon size={16} />
            Compare with Notability
          </Link>
          <Link href={`/session/${session.id}`} className={btnSecondary}>
            <PenIcon size={16} />
            Continue notes
          </Link>
        </div>
      </TopBar>

      <div className="flex shrink-0 flex-col gap-3 border-b border-line bg-desk px-3 py-3 sm:px-4">
        <ul aria-label="Session summary" className="flex flex-wrap gap-2">
          <Stat label={drawn === 1 ? "stroke" : "strokes"} value={drawn} testId="count-strokes" />
          <Stat label="erased · kept as ghost" value={erased} testId="count-erased" ghost />
          <Stat
            label={eraseEvents.length === 1 ? "erase event" : "erase events"}
            value={eraseEvents.length}
            testId="count-erase-events"
          />
          <li aria-hidden="true" className="mx-1 hidden w-px self-stretch bg-line sm:block" />
          <Stat
            label={plural("misconception_corrected", counts.misconception_corrected)}
            value={counts.misconception_corrected}
            testId="count-corrected"
            moment="misconception_corrected"
          />
          <Stat
            label={plural("unresolved_gap", counts.unresolved_gap)}
            value={counts.unresolved_gap}
            testId="count-gaps"
            moment="unresolved_gap"
          />
          <Stat
            label={plural("breakthrough", counts.breakthrough)}
            value={counts.breakthrough}
            testId="count-breakthroughs"
            moment="breakthrough"
          />
        </ul>

        <Timeline
          status={status}
          durationMs={timeline?.durationMs ?? lecture.durationMs}
          events={events}
          windows={timeline?.windows ?? []}
          baseline={timeline?.baseline ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRetry={retry}
        />

        <CarriedOver threads={carried} sessionId={session.id} />
      </div>

      {/* One shared, persistent media element for replays. A video lecture shows as a compact
          floating player (collapsible); audio has no visual. */}
      <LectureMedia
        src={lectureMediaUrl(lecture.id)}
        mediaType={lecture.mediaType}
        title={lecture.title}
        mediaRef={mediaRef}
        className="fixed bottom-4 left-4 z-30"
      />

      <main className="flex min-h-[420px] flex-1 flex-col lg:min-h-0 lg:flex-row">
        {selected && timeline ? (
          <aside
            aria-label="Moment details"
            className="order-first shrink-0 border-b border-line bg-chrome px-4 py-4 lg:order-last lg:w-[22rem] lg:overflow-y-auto lg:overscroll-contain lg:border-b-0 lg:border-l"
          >
            <MomentDetail
              key={selected.id}
              event={selected}
              words={words}
              transcriptSource={lecture.transcriptSource}
              mediaRef={mediaRef}
              windows={timeline.windows}
              revision={revision}
              pageStrokes={active}
              strokesById={strokesById}
              onClose={close}
              onSelfAction={selfAction}
              ai={ai}
              onEventsChange={mergeEvents}
              onRevisionChange={updateRevision}
            />
          </aside>
        ) : null}
        <InkCanvas
          strokes={strokes}
          showGhost={showGhost}
          readOnly
          testId="review-canvas"
          highlight={highlight}
          className="paper min-h-[420px] flex-1"
        />
      </main>
    </div>
  );
}
