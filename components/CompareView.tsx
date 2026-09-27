"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import Link from "next/link";
import type { NotabilityImport, Session, Stroke, TimelineData, TimelineEventType } from "@/lib/types";
import { DEFAULT_REVEAL, hiddenStats, revealAt, revealForKey } from "@/lib/compare";
import { notabilityFileUrl } from "@/lib/notability";
import { PageNav, PdfPage, usePdfDocument, type PageRect, type PdfDocState } from "./NotabilityPdf";
import { NotabilityDropzone, ReplacePdfButton, UploadError, useNotabilityUpload } from "./NotabilityUpload";
import ProcessView from "./ProcessView";
import { MomentGlyph } from "./Timeline";
import { ChevronLeftIcon, ChevronRightIcon, DocumentIcon } from "./icons";
import { Mark, TopBar, btnSecondary, iconBtn } from "./ui";
import { useSessionTimeline } from "./useSessionTimeline";

type Mode = "side" | "overlay";

interface Props {
  session: Session;
  strokes: Stroke[];
  /** Stored, up-to-date analysis; null when the session still needs analysing (done on mount). */
  initialTimeline: TimelineData | null;
  /** The session's current Notability PDF, if one was uploaded. */
  initialImport: NotabilityImport | null;
}

const MOMENT_STATS: Array<{ key: "corrections" | "gaps" | "breakthroughs"; type: TimelineEventType; one: string; many: string; testId: string }> = [
  { key: "corrections", type: "misconception_corrected", one: "correction", many: "corrections", testId: "hidden-corrections" },
  { key: "gaps", type: "unresolved_gap", one: "unresolved gap", many: "unresolved gaps", testId: "hidden-gaps" },
  { key: "breakthroughs", type: "breakthrough", one: "breakthrough", many: "breakthroughs", testId: "hidden-breakthroughs" },
];

function HiddenStat({ value, label, testId, icon }: { value: number | null; label: string; testId: string; icon: ReactNode }) {
  return (
    <li className="flex min-h-11 items-center gap-2.5 rounded-pill border border-line bg-chrome px-3.5 py-1.5 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <span aria-hidden="true" className="inline-flex w-4 justify-center">
        {icon}
      </span>
      <span data-testid={testId} className="text-xl leading-none font-extrabold tracking-tight tabular-nums text-ink">
        {value ?? "–"}
      </span>
      <span className="text-sm leading-tight text-ink-muted">{label}</span>
    </li>
  );
}

/** Segmented "Side by side | Overlay" control: a radio group with arrow-key navigation. */
function ModeToggle({ mode, onChange, overlayDisabled }: { mode: Mode; onChange: (m: Mode) => void; overlayDisabled: boolean }) {
  const refs = useRef<Record<Mode, HTMLButtonElement | null>>({ side: null, overlay: null });
  const options: Array<{ value: Mode; label: string }> = [
    { value: "side", label: "Side by side" },
    { value: "overlay", label: "Overlay" },
  ];
  const onKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next: Mode = e.key === "Home" ? "side" : e.key === "End" ? "overlay" : mode === "side" ? "overlay" : "side";
    if (next === "overlay" && overlayDisabled) return;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Layout"
      data-testid="compare-mode"
      data-mode={mode}
      onKeyDown={onKeyDown}
      className="inline-flex gap-0.5 rounded-pill border border-line bg-chrome-press/70 p-0.5"
    >
      {options.map((o) => {
        const checked = mode === o.value;
        const disabled = o.value === "overlay" && overlayDisabled;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[o.value] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            title={disabled ? "Upload a Notability PDF first" : undefined}
            data-testid={`mode-${o.value}`}
            onClick={() => onChange(o.value)}
            className={`press inline-flex min-h-11 items-center rounded-pill px-4 text-sm font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${
              checked ? "bg-ink text-white shadow-raised" : "text-ink-muted hover:bg-chrome hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A titled card holding one side of the comparison. */
function Panel({ title, note, actions, children, labelId }: { title: string; note: ReactNode; actions?: ReactNode; children: ReactNode; labelId: string }) {
  return (
    <section aria-labelledby={labelId} className="flex min-h-[440px] min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-chrome shadow-card">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3.5 py-1.5">
        <div className="flex min-w-0 flex-col">
          <h2 id={labelId} className="truncate text-sm font-bold tracking-tight text-ink">
            {title}
          </h2>
          <p className="truncate text-xs text-ink-subtle">{note}</p>
        </div>
        {actions}
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  );
}

/** What the Notability side shows for each state of the PDF. */
function FinalPage({
  pdf,
  page,
  upload,
  onPageRect,
}: {
  pdf: PdfDocState;
  page: number;
  upload: ReturnType<typeof useNotabilityUpload>;
  onPageRect?: (rect: PageRect) => void;
}) {
  if (pdf.status === "idle") {
    return (
      <div className="absolute inset-0 overflow-y-auto bg-desk/60">
        <NotabilityDropzone upload={upload.upload} state={upload.state} />
      </div>
    );
  }
  if (pdf.status === "loading") {
    return (
      <p role="status" data-testid="notability-loading" className="absolute inset-0 flex items-center justify-center gap-2 bg-desk/60 text-sm text-ink-muted">
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-pill bg-accent" />
        Opening your PDF…
      </p>
    );
  }
  if (pdf.status === "error") {
    return (
      <div className="absolute inset-0 overflow-y-auto bg-desk/60">
        <NotabilityDropzone upload={upload.upload} state={upload.state} title="This PDF can’t be shown">
          <p role="alert" data-testid="notability-error" data-kind={pdf.kind} className="text-sm text-pretty text-danger">
            {pdf.message}
          </p>
        </NotabilityDropzone>
      </div>
    );
  }
  return <PdfPage doc={pdf.doc} pageNumber={page} className="bg-desk/60" onPageRect={onPageRect} />;
}

/**
 * Overlay: the final page underneath and the process laid exactly over it, revealed from the page's
 * left edge up to a draggable divider (a slider: arrow keys, Page Up/Down, Home/End). Until the page
 * is drawn, the whole stage stands in for it.
 */
function OverlayStage({
  reveal,
  onReveal,
  renderFinalPage,
  process,
}: {
  reveal: number;
  onReveal: (v: number) => void;
  renderFinalPage: (onPageRect: (rect: PageRect) => void) => ReactNode;
  process: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [pageRect, setPageRect] = useState<PageRect | null>(null);
  const area = pageRect ?? { x: 0, y: 0, width: 0, height: 0 };
  const areaStyle = pageRect
    ? { left: area.x, top: area.y, width: area.width, height: area.height }
    : { left: 0, top: 0, right: 0, bottom: 0 };

  const move = (clientX: number) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    onReveal(revealAt(clientX, pageRect ? { left: stage.left + pageRect.x, width: pageRect.width } : stage));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    dragging.current = e.pointerId;
    move(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === e.pointerId) move(e.clientX);
  };
  const stop = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === e.pointerId) dragging.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = revealForKey(reveal, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    onReveal(next);
  };

  return (
    <div
      ref={stageRef}
      data-testid="compare-stage"
      data-reveal={reveal}
      className="relative min-h-[480px] flex-1 overflow-hidden rounded-lg border border-line bg-chrome shadow-card"
    >
      <div className="absolute inset-0">{renderFinalPage(setPageRect)}</div>
      <div
        data-testid="overlay-process"
        className="absolute overflow-hidden rounded-sm"
        style={{ ...areaStyle, clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
      >
        {process}
      </div>

      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-3 left-3 z-10 rounded-pill bg-ink/85 px-2.5 py-1 text-xs font-semibold text-paper transition-opacity duration-150 ${
          reveal > 3 ? "opacity-100" : "opacity-0"
        }`}
      >
        ← Inkling — the process
      </span>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-3 right-3 z-10 rounded-pill border border-line bg-chrome/95 px-2.5 py-1 text-xs font-semibold text-ink-muted transition-opacity duration-150 ${
          reveal < 97 ? "opacity-100" : "opacity-0"
        }`}
      >
        Notability — final page →
      </span>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Reveal the process over the final page"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={reveal}
        aria-valuetext={`${Math.round(reveal)}% of the process shown`}
        data-testid="overlay-divider"
        data-reveal={reveal}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        onKeyDown={onKeyDown}
        className="group absolute z-20 flex w-11 -translate-x-1/2 cursor-ew-resize touch-none justify-center outline-none select-none"
        style={{
          // The focus ring goes on the knob (group-focus-visible), not the full-height hit strip.
          // Inline because the global :focus-visible rule is unlayered and would beat a utility.
          boxShadow: "none",
          ...(pageRect
            ? { left: area.x + (reveal / 100) * area.width, top: area.y, height: area.height }
            : { left: `${reveal}%`, top: 0, bottom: 0 }),
        }}
      >
        <span aria-hidden="true" className="h-full w-0.5 bg-ink/80 shadow-[0_0_0_1px_rgb(255_255_255/0.7)]" />
        <span
          aria-hidden="true"
          className="absolute top-1/2 inline-flex h-11 w-9 -translate-y-1/2 items-center justify-center rounded-pill border border-line-strong bg-chrome text-ink shadow-raised transition-[transform,box-shadow] duration-150 group-hover:scale-105 group-focus-visible:shadow-[var(--focus-ring)] group-active:scale-95"
        >
          <ChevronLeftIcon size={14} className="-mr-1" />
          <ChevronRightIcon size={14} className="-ml-1" />
        </span>
      </div>
    </div>
  );
}

export default function CompareView({ session, strokes, initialTimeline, initialImport }: Props) {
  const { timeline, status } = useSessionTimeline(session.id, initialTimeline);
  const [current, setCurrent] = useState<NotabilityImport | null>(initialImport);
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<Mode>("side");
  const [reveal, setReveal] = useState(DEFAULT_REVEAL);

  const upload = useNotabilityUpload(session.id, (imported) => {
    setCurrent(imported);
    setPage(1);
  });
  const pdf = usePdfDocument(current ? notabilityFileUrl(session.id, current.id) : null);
  const pageCount = pdf.status === "ready" ? pdf.numPages : 0;
  const shownPage = Math.min(page, Math.max(1, pageCount));
  const overlayReady = pdf.status === "ready";
  const effectiveMode: Mode = overlayReady ? mode : "side";

  const events = timeline?.events ?? [];
  const revisions = timeline?.revisions ?? [];
  const stats = hiddenStats(strokes, events);
  const ready = status === "ready";
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const finalPage = <FinalPage pdf={pdf} page={shownPage} upload={upload} />;
  const pageNav = <PageNav page={shownPage} count={pageCount} onChange={setPage} />;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Compare toolbar">
        <div className="flex min-w-[10rem] flex-1 items-center gap-1">
          <Link href={`/review/${encodeURIComponent(session.id)}`} aria-label="Back to review" className={iconBtn}>
            <ChevronLeftIcon size={22} />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-xs font-bold tracking-wide text-accent-press uppercase">Compare with Notability</p>
            <h1 className="truncate text-base leading-tight font-bold tracking-tight text-ink">{session.title}</h1>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {effectiveMode === "overlay" ? pageNav : null}
          <ModeToggle mode={effectiveMode} onChange={setMode} overlayDisabled={!overlayReady} />
          {current ? <ReplacePdfButton upload={upload.upload} state={upload.state} /> : null}
        </div>
      </TopBar>

      <section
        aria-labelledby="hidden-heading"
        data-testid="hidden-stats"
        data-status={status}
        aria-busy={!ready}
        className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2.5 border-b border-line bg-desk px-3 py-3 sm:px-4"
      >
        <div className="flex min-w-0 flex-col">
          <h2 id="hidden-heading" className="text-2xl leading-tight font-extrabold tracking-[-0.03em] text-balance text-ink">
            What the final page <Mark>hides</Mark>
          </h2>
          <p className="mt-1 text-sm text-pretty text-ink-muted">Notability keeps the final page. Here’s what it hides.</p>
        </div>
        <ul aria-label="Hidden by the final page" className="flex flex-wrap gap-2">
          <HiddenStat
            value={stats.erased}
            label={plural(stats.erased, "erased piece kept", "erased pieces kept")}
            testId="hidden-erased"
            icon={<span className="inline-block w-4 border-t-2 border-dashed border-ghost" />}
          />
          {MOMENT_STATS.map((m) => (
            <HiddenStat
              key={m.key}
              value={ready ? stats[m.key] : null}
              label={plural(stats[m.key], m.one, m.many)}
              testId={m.testId}
              icon={<MomentGlyph type={m.type} size={14} />}
            />
          ))}
        </ul>
        <div className="flex flex-col items-start gap-1 sm:ml-auto sm:items-end">
          {/* A download (attachment): the notes with ghost ink and every moment, then the moments list. */}
          <a
            href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
            download
            data-testid="export-notability"
            aria-describedby="export-hint"
            className={btnSecondary}
          >
            <DocumentIcon size={16} />
            Export for Notability (PDF)
          </a>
          <p id="export-hint" className="max-w-[19rem] text-xs text-pretty text-ink-subtle sm:text-right">
            Import this PDF into Notability to keep your process next to your notes.
          </p>
        </div>
        {status === "error" ? (
          <p role="alert" className="text-sm text-danger">
            Couldn’t analyze this session — open the review to try again.
          </p>
        ) : null}
      </section>

      {current && upload.state.status === "error" ? (
        <div className="shrink-0 border-b border-line bg-gap-soft/60 px-3 py-2 sm:px-4">
          <UploadError state={upload.state} />
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
        {effectiveMode === "side" ? (
          <div data-testid="compare-side" className="grid flex-1 grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 md:grid-rows-1">
            <Panel
              labelId="final-heading"
              title="Notability — final page"
              note={current ? current.fileName : "Only what survived to the end"}
              actions={pdf.status === "ready" ? pageNav : null}
            >
              {finalPage}
            </Panel>
            <Panel
              labelId="process-heading"
              title="Inkling — the process"
              note={
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block w-3 border-t-2 border-dashed border-ghost" />
                  Ghost ink = erased, kept · tap a moment to open it
                </span>
              }
            >
              <ProcessView sessionId={session.id} strokes={strokes} events={events} revisions={revisions} />
            </Panel>
          </div>
        ) : (
          <OverlayStage
            reveal={reveal}
            onReveal={setReveal}
            renderFinalPage={(onPageRect) => <FinalPage pdf={pdf} page={shownPage} upload={upload} onPageRect={onPageRect} />}
            process={
              <ProcessView sessionId={session.id} strokes={strokes} events={events} revisions={revisions} visibleUntil={reveal / 100} />
            }
          />
        )}
      </main>
    </div>
  );
}
