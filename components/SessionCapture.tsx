"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EraseEvent, Lecture, PointerKind, Point, Session, Stroke, Tool, TranscriptWord } from "@/lib/types";
import { buildStroke, inkCounts, inkCountsLabel, newId } from "@/lib/ink";
import { undoEraseGesture } from "@/lib/eraseUndo";
import { InkSaver, type SaveStatus } from "@/lib/inkSaver";
import { lectureMediaUrl } from "@/lib/media";
import { cuesToLiveWords } from "@/lib/liveLecture";
import { applyScribbleOut, undoScribbleOut, type ScribbleOut } from "@/lib/scribble";
import {
  STRIKE_CONFIG,
  applyStrikeOut,
  detectStrikeThrough,
  isStrikeFollowUp,
  pendingStrike,
  type PendingStrike,
} from "@/lib/strike";
import HesitationMeter from "./HesitationMeter";
import InkCanvas from "./InkCanvas";
import LectureMedia from "./LectureMedia";
import LecturePlayer from "./LecturePlayer";
import { LiveLectureBar, LiveTranscriptPanel } from "./LiveLectureBar";
import { useLiveCapture, type FinishResult } from "./useLiveCapture";
import OpenGapsBanner from "./OpenGapsBanner";
import type { ProgressThread } from "@/lib/progress";
import TranscriptPanel from "./TranscriptPanel";
import { EraserIcon, PenIcon, TranscriptIcon, UndoIcon } from "./icons";
import { BackLink, Divider, GhostToggle, TopBar, btnPrimary, iconBtn } from "./ui";

const STATUS_LABEL: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  retrying: "Save failed — retrying",
  rejected: "Some ink couldn’t be saved",
};

const STATUS_DOT: Record<SaveStatus, string> = {
  saved: "bg-ok",
  unsaved: "bg-ink-subtle",
  saving: "bg-accent",
  retrying: "bg-danger",
  rejected: "bg-danger",
};

/** Autosave heartbeat (retries back off on their own schedule; see lib/inkSaver). */
const AUTOSAVE_MS = 2000;

const segBtn = (active: boolean) =>
  `press inline-flex min-h-11 items-center gap-2 rounded-pill px-4 text-sm font-semibold ${
    active ? "bg-ink text-white shadow-raised" : "text-ink-muted hover:bg-chrome hover:text-ink"
  }`;

/**
 * Undoable actions, newest last: a pen stroke; a pen gesture that erased ink (a scribble-out
 * zig-zag or a confirmed strike-through); or an eraser gesture (what it turned into ghost ink).
 */
type UndoEntry =
  | { kind: "stroke"; id: string }
  | { kind: "scribble"; scribble: ScribbleOut }
  | { kind: "erase"; erasedIds: string[] };

/** How long the "Scribbled out" toast stays up. */
const TOAST_MS = 6000;

interface Props {
  session: Session;
  lecture: Lecture;
  /** Word-level transcript ([] when the lecture has none). */
  words: TranscriptWord[];
  /** Whether auto-transcription (OpenAI or Groq Whisper) is available on the server. */
  aiConfigured: boolean;
  initialStrokes: Stroke[];
  /** Gaps still open from earlier sessions of this lecture (the "Jump to" banner). */
  openGaps?: ProgressThread[];
  /** Live lectures can capture here (false in DEMO_MODE: shown, but disabled with a note). */
  liveAvailable?: boolean;
  /** Auto-transcribe can run (false in DEMO_MODE: shown, but disabled with a note). */
  transcribeAvailable?: boolean;
}

/** Where a Live lecture's clock starts: after everything already captured for it (0 when new). */
function liveOffsetMs(lecture: Lecture, words: TranscriptWord[], strokes: Stroke[]): number {
  let last = lecture.durationMs;
  for (const w of words) last = Math.max(last, w.endMs);
  for (const s of strokes) last = Math.max(last, s.endMs, s.erasedAtMs ?? 0);
  return Math.ceil(last);
}

export default function SessionCapture({
  session,
  lecture,
  words: initialWords,
  aiConfigured,
  initialStrokes,
  openGaps = [],
  liveAvailable = true,
  transcribeAvailable = true,
}: Props) {
  const router = useRouter();
  const audioRef = useRef<HTMLMediaElement>(null);
  // A Live lecture (no recording yet): the microphone and the browser's speech recognition stand
  // in for the media player; the rest of capture is the same.
  const isLive = lecture.live === true;
  const [liveOffset] = useState(() => (isLive ? liveOffsetMs(lecture, initialWords, initialStrokes) : 0));
  const live = useLiveCapture({ lectureId: lecture.id, enabled: isLive && liveAvailable, offsetMs: liveOffset });
  const liveFinishRef = useRef<Promise<FinishResult> | null>(null);
  const recordingUploadedRef = useRef(false);
  const [transcriptOpen, setTranscriptOpen] = useState(isLive);
  const [words, setWords] = useState<TranscriptWord[]>(initialWords);
  const closeTranscript = useCallback(() => setTranscriptOpen(false), []);
  const [strokes, setStrokes] = useState<Stroke[]>(initialStrokes);
  const [tool, setTool] = useState<Tool>("pen");
  const [showGhost, setShowGhost] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [ending, setEnding] = useState<"idle" | "saving" | "uploading" | "analyzing">("idle");
  // Why "End session" could not finish (shown with a Retry next to the button).
  const [endError, setEndError] = useState<string | null>(null);

  // Canonical data lives in refs (updated synchronously in handlers) so saves never miss an edit.
  const strokesRef = useRef<Stroke[]>(initialStrokes);
  // Tracks what is unsaved vs. confirmed saved, retries and the hide-time beacon (lib/inkSaver).
  // Created on mount (below), before any input can arrive.
  const saverRef = useRef<InkSaver | null>(null);
  // Everything undoable this visit, in order (pieces cut by the eraser are resolved back to their
  // stroke for undo). Strokes from earlier visits can be undone too; earlier eraser gestures can't.
  const undoStackRef = useRef<UndoEntry[]>(
    initialStrokes.filter((s) => !s.erased && !s.splitFrom).map((s) => ({ kind: "stroke", id: s.id })),
  );
  // A straight line drawn through a word: it erases the word if new writing follows nearby within
  // 20 s (lib/strike); until then it is ordinary ink.
  const pendingStrikeRef = useRef<PendingStrike | null>(null);
  // The scribble-out / strike-through the toast offers to undo.
  const [scribbleToast, setScribbleToast] = useState<ScribbleOut | null>(null);

  useEffect(() => {
    if (!scribbleToast) return;
    const timer = setTimeout(() => setScribbleToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [scribbleToast]);

  const liveGetMs = live.getMs;
  const getLectureMs = useCallback(
    () => (isLive ? liveGetMs() : Math.round((audioRef.current?.currentTime ?? 0) * 1000)),
    [isLive, liveGetMs],
  );
  // What the hesitation meter reads: the stored transcript plus, live, the words heard so far.
  const meterWords = useMemo(
    () => (isLive && live.cues.length ? [...words, ...cuesToLiveWords(live.cues)] : words),
    [isLive, live.cues, words],
  );

  const commit = (next: Stroke[], changedIds: string[], events: EraseEvent[] = []) => {
    strokesRef.current = next;
    setStrokes(next);
    saverRef.current!.markChanged(changedIds, events);
  };

  // Autosave every 2 s; when the page is hidden, closed or left, hand anything not confirmed saved
  // to the browser (sendBeacon / keepalive) so it outlives the page.
  useEffect(() => {
    const saver = new InkSaver({
      url: `/api/sessions/${session.id}/strokes`,
      getStrokes: () => strokesRef.current,
      onStatus: setStatus,
      sendBeacon: (url, data) => navigator.sendBeacon?.(url, data) ?? false,
    });
    saverRef.current = saver;
    const timer = setInterval(() => void saver.tick(), AUTOSAVE_MS);
    const onHide = () => saver.beaconUnsaved();
    const onVisibility = () => document.visibilityState === "hidden" && onHide();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      onHide(); // client-side navigation away (no pagehide)
    };
  }, [session.id]);

  const handleStrokeEnd = (points: Point[], pointerType: PointerKind) => {
    const stroke = buildStroke(newId("k_"), session.id, points, pointerType);
    // A pen zig-zag over existing ink scribbles it out: same outcome as the eraser (kept as ghost).
    const out = applyScribbleOut(strokesRef.current, stroke, newId("e_"));
    if (out) {
      undoStackRef.current.push({ kind: "scribble", scribble: out.scribble });
      commit(out.strokes, out.changedIds, [out.event]);
      setScribbleToast(out.scribble);
      return;
    }

    let page = strokesRef.current;
    const changedIds: string[] = [];
    const events: EraseEvent[] = [];
    const now = performance.now();
    // New writing next to a word the student just struck through: that word was crossed out.
    const pending = pendingStrikeRef.current;
    if (pending && now - pending.atMs > STRIKE_CONFIG.windowMs) pendingStrikeRef.current = null;
    if (pending && isStrikeFollowUp(pending, stroke, now)) {
      pendingStrikeRef.current = null;
      const struck = applyStrikeOut(page, pending, newId("e_"));
      if (struck) {
        page = struck.strokes;
        changedIds.push(...struck.changedIds);
        events.push(struck.event);
        // The line's own undo entry becomes the strike-through's (undo restores the word).
        const stack = undoStackRef.current;
        const at = stack.findIndex((e) => e.kind === "stroke" && e.id === pending.lineId);
        if (at >= 0) stack[at] = { kind: "scribble", scribble: struck.scribble };
        setScribbleToast(struck.scribble);
      }
    }
    // Is this stroke itself a line through a word? Keep it as ink and wait for the follow-up.
    const struckIds = detectStrikeThrough(stroke, page);
    if (struckIds.length) pendingStrikeRef.current = pendingStrike(stroke, struckIds, page, now);

    undoStackRef.current.push({ kind: "stroke", id: stroke.id });
    commit([...page, stroke], [...changedIds, stroke.id], events);
  };

  /** Reverses a scribble-out / strike-through: covered ink is live again, the gesture becomes an undone stroke. */
  const undoScribble = (scribble: ScribbleOut) => {
    const stack = undoStackRef.current;
    const at = stack.findIndex((e) => e.kind === "scribble" && e.scribble.scribbleId === scribble.scribbleId);
    if (at >= 0) stack.splice(at, 1);
    setScribbleToast((t) => (t?.scribbleId === scribble.scribbleId ? null : t));
    const res = undoScribbleOut(strokesRef.current, scribble, getLectureMs(), newId("e_"));
    if (res) commit(res.strokes, res.changedIds, [res.event]);
  };

  const markErased = (ids: string[], atMs: number, by: "undo", event?: EraseEvent) => {
    const set = new Set(ids);
    const next = strokesRef.current.map((s) =>
      set.has(s.id) && !s.erased ? { ...s, erased: true, erasedAtMs: atMs, erasedBy: by } : s,
    );
    commit(next, ids, event ? [event] : []);
  };

  /** One eraser gesture: upsert cut parents, their pieces and fully erased strokes in one commit. */
  const handleErase = ({ changed, erasedIds }: { changed: Stroke[]; erasedIds: string[] }, atMs: number) => {
    const byId = new Map(changed.map((s) => [s.id, s]));
    const next = strokesRef.current.map((s) => byId.get(s.id) ?? s);
    const known = new Set(strokesRef.current.map((s) => s.id));
    for (const s of changed) if (!known.has(s.id)) next.push(s);
    const events: EraseEvent[] = erasedIds.length
      ? [{ id: newId("e_"), sessionId: session.id, atMs, strokeIds: erasedIds, by: "eraser" }]
      : [];
    if (erasedIds.length) undoStackRef.current.push({ kind: "erase", erasedIds });
    commit(next, changed.map((s) => s.id), events);
  };

  /** Live leaf strokes that stand for `id` now (itself, or the surviving pieces it was cut into). */
  const liveLeaves = (id: string, byId: Map<string, Stroke>): string[] => {
    const s = byId.get(id);
    if (!s) return [];
    if (s.replacedBy?.length) return s.replacedBy.flatMap((child) => liveLeaves(child, byId));
    return s.erased ? [] : [id];
  };

  const handleUndo = () => {
    const stack = undoStackRef.current;
    const byId = new Map(strokesRef.current.map((s) => [s.id, s]));
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.kind === "scribble") {
        const by = byId.get(entry.scribble.scribbleId)?.erasedBy;
        if (by !== "scribble" && by !== "strike") continue; // already undone
        undoScribble(entry.scribble);
        return;
      }
      if (entry.kind === "erase") {
        // The eraser's pieces come back as live ink (persisted; lib/eraseUndo).
        const res = undoEraseGesture(strokesRef.current, entry, getLectureMs(), newId("e_"));
        if (!res) continue; // nothing left to restore
        commit(res.strokes, res.changedIds, [res.event]);
        return;
      }
      const ids = liveLeaves(entry.id, byId);
      if (ids.length) {
        const atMs = getLectureMs();
        markErased(ids, atMs, "undo", { id: newId("e_"), sessionId: session.id, atMs, strokeIds: ids, by: "undo" });
        return;
      }
    }
  };

  const handleEnd = async () => {
    setEnding("saving");
    setEndError(null);
    audioRef.current?.pause();
    // Live: stop listening and recording (once, even if End is retried), then save the transcript.
    let liveResult: FinishResult | null = null;
    if (isLive && liveAvailable) {
      liveFinishRef.current ??= live.finish();
      liveResult = await liveFinishRef.current;
      if (!(await live.flushCues())) {
        setEnding("idle");
        setEndError("Couldn’t save the live transcript — check your connection. Your notes are still here.");
        return;
      }
    }
    const saver = saverRef.current!;
    // An explicit End also re-sends anything the server refused earlier; a network blip gets a
    // second chance. Ink written while saving is sent too.
    let outcome = await saver.flush({ includeRejected: true });
    if (outcome === "transient") outcome = await saver.flush();
    for (let i = 0; outcome === "saved" && saver.hasUnsaved() && i < 3; i++) outcome = await saver.flush();
    if (outcome !== "saved" || saver.hasUnsaved()) {
      // Never leave (or reset) with unsaved ink: say so and let the student retry.
      setEnding("idle");
      setEndError(
        outcome === "rejected"
          ? "Some ink couldn’t be saved, so the session is still open. Your notes are still here."
          : "Couldn’t save your notes — check your connection. Your notes are still here.",
      );
      return;
    }
    // The microphone recording becomes the lecture's media (Replay 20 s). Best effort: the notes
    // and transcript are already saved, so a failed upload never blocks the review.
    if (liveResult?.recording && !recordingUploadedRef.current) {
      setEnding("uploading");
      try {
        const res = await fetch(
          `/api/lectures/${encodeURIComponent(lecture.id)}/recording?durationMs=${liveResult.durationMs}`,
          { method: "POST", headers: { "Content-Type": liveResult.recording.type || "audio/webm" }, body: liveResult.recording },
        );
        if (!res.ok) console.error(`Live recording upload failed: HTTP ${res.status}`);
        recordingUploadedRef.current = true;
      } catch (err) {
        console.error("Live recording upload failed", err);
        recordingUploadedRef.current = true;
      }
    }
    // Build the learning timeline before showing the review. Best effort: if this fails, the
    // review page notices the missing analysis and runs it itself.
    setEnding("analyzing");
    try {
      const res = await fetch(`/api/sessions/${session.id}/analyze`, { method: "POST" });
      if (!res.ok) console.error(`Analysis failed for session ${session.id}: HTTP ${res.status}`);
    } catch (err) {
      console.error(`Analysis request failed for session ${session.id}`, err);
    }
    router.push(`/review/${session.id}`);
  };

  // Lines the student drew (not stored pieces): "1 stroke · 1 erased part" (lib/ink inkCounts).
  const countLabel = inkCountsLabel(inkCounts(strokes));

  const transcriptToggle = (
    <button
      type="button"
      data-testid="transcript-toggle"
      aria-pressed={transcriptOpen}
      aria-controls="transcript-panel"
      onClick={() => setTranscriptOpen((o) => !o)}
      className={`press inline-flex min-h-11 shrink-0 items-center gap-2 rounded-pill px-3 text-sm font-medium ${
        transcriptOpen ? "bg-accent-soft text-accent" : "text-ink-muted hover:bg-chrome-hover hover:text-ink"
      }`}
    >
      <TranscriptIcon size={18} />
      <span className="hidden sm:inline">Transcript</span>
    </button>
  );
  const playerAside = (
    <div className="flex shrink-0 items-center gap-1 pr-1">
      <HesitationMeter strokes={strokes} words={meterWords} getLectureMs={getLectureMs} />
      <span data-testid="stroke-counter" className="hidden text-sm tabular-nums text-ink-subtle lg:block">
        {countLabel.strokes}
        {countLabel.erased ? <span className="text-ghost-strong"> · {countLabel.erased}</span> : null}
      </span>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden overscroll-none">
      <TopBar label="Note toolbar">
        <div className="flex min-w-[10rem] flex-1 items-center gap-1">
          <BackLink />
          <div className="min-w-0">
            <p className="truncate text-xs font-bold tracking-wide text-accent-press uppercase">Notes</p>
            <h1 className="truncate text-base leading-tight font-bold tracking-tight text-ink">{session.title}</h1>
          </div>
        </div>

        <div className="order-last flex basis-full flex-wrap items-center gap-1.5 pl-1 lg:order-none lg:basis-auto lg:pl-0">
          <div role="group" aria-label="Tool" className="inline-flex gap-0.5 rounded-pill border border-line bg-chrome-press/70 p-0.5">
            <button
              type="button"
              data-testid="tool-pen"
              aria-pressed={tool === "pen"}
              className={segBtn(tool === "pen")}
              onClick={() => setTool("pen")}
            >
              <PenIcon size={18} />
              Pen
            </button>
            <button
              type="button"
              data-testid="tool-eraser"
              aria-pressed={tool === "eraser"}
              className={segBtn(tool === "eraser")}
              onClick={() => setTool("eraser")}
            >
              <EraserIcon size={18} />
              Eraser
            </button>
          </div>
          <button type="button" data-testid="undo" aria-label="Undo" title="Undo" className={iconBtn} onClick={handleUndo}>
            <UndoIcon size={20} />
          </button>
          <Divider />
          <GhostToggle checked={showGhost} onChange={setShowGhost} />
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span
            data-testid="save-status"
            data-status={status}
            role="status"
            className={`hidden items-center justify-end gap-2 text-right text-sm sm:flex ${
              status === "rejected" ? "w-auto" : "w-40"
            } ${status === "retrying" || status === "rejected" ? "text-danger" : "text-ink-subtle"}`}
          >
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-pill ${STATUS_DOT[status]}`} />
            <span className="truncate">{STATUS_LABEL[status]}</span>
          </span>
          <button
            type="button"
            data-testid="end-session"
            onClick={handleEnd}
            disabled={ending !== "idle"}
            aria-busy={ending !== "idle"}
            className={btnPrimary}
          >
            {ending === "saving"
              ? "Saving…"
              : ending === "uploading"
                ? "Saving audio…"
                : ending === "analyzing"
                  ? "Analyzing…"
                  : "End session"}
          </button>
        </div>
        {endError ? (
          <div
            role="alert"
            data-testid="end-session-error"
            className="enter-soft absolute top-full right-2 z-20 mt-2 flex max-w-sm items-center gap-3 rounded-pill border border-danger/30 bg-chrome py-1 pr-1 pl-4 text-sm text-danger shadow-page sm:right-3"
          >
            <span className="text-pretty">{endError}</span>
            <button
              type="button"
              data-testid="end-session-retry"
              onClick={handleEnd}
              disabled={ending !== "idle"}
              className="press inline-flex min-h-11 shrink-0 items-center rounded-pill px-3 font-semibold text-accent hover:bg-accent-soft"
            >
              Retry
            </button>
          </div>
        ) : null}
      </TopBar>

      {isLive ? (
        <LiveLectureBar
          live={live}
          title={lecture.title}
          available={liveAvailable}
          actions={transcriptToggle}
          aside={playerAside}
        />
      ) : (
        <LecturePlayer
          title={lecture.title}
          durationMs={lecture.durationMs}
          mediaRef={audioRef}
          actions={transcriptToggle}
          aside={playerAside}
        />
      )}

      <main className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {isLive ? null : (
            <LectureMedia
              src={lectureMediaUrl(lecture.id)}
              mediaType={lecture.mediaType}
              title={lecture.title}
              mediaRef={audioRef}
            />
          )}
          {/* Live region stays mounted so screen readers announce the toast when it appears. */}
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4"
          >
            {scribbleToast ? (
              <div
                key={scribbleToast.scribbleId}
                data-testid="scribble-toast"
                data-kind={scribbleToast.by ?? "scribble"}
                className="enter-soft pointer-events-auto flex items-center gap-3 rounded-pill border border-white/10 bg-ink/95 py-1 pr-1 pl-4 text-sm text-white shadow-page"
              >
                <span aria-hidden="true" className="inline-block w-3.5 border-t-2 border-dashed border-teal-300" />
                <span>{scribbleToast.by === "strike" ? "Struck through" : "Scribbled out"} — kept as ghost</span>
                <button
                  type="button"
                  data-testid="scribble-undo"
                  onClick={() => undoScribble(scribbleToast)}
                  className="press inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 font-semibold text-teal-200 hover:bg-white/10 active:bg-white/15"
                >
                  <UndoIcon size={16} />
                  Undo
                </button>
              </div>
            ) : null}
          </div>
          <InkCanvas
            strokes={strokes}
            showGhost={showGhost}
            tool={tool}
            getLectureMs={getLectureMs}
            onStrokeEnd={handleStrokeEnd}
            onErase={handleErase}
            className="paper min-h-0 flex-1"
          />
          {isLive ? null : <OpenGapsBanner threads={openGaps} mediaRef={audioRef} />}
        </div>
        {transcriptOpen && isLive ? (
          <LiveTranscriptPanel
            id="transcript-panel"
            cues={live.cues}
            interim={live.interim}
            speechSupported={live.support?.speech !== false}
            onClose={closeTranscript}
          />
        ) : transcriptOpen ? (
          <TranscriptPanel
            id="transcript-panel"
            words={words}
            source={words.length > 0 && lecture.transcriptSource === "none" ? "whisper" : lecture.transcriptSource}
            mediaRef={audioRef}
            lectureId={lecture.id}
            aiConfigured={aiConfigured}
            transcribeAvailable={transcribeAvailable}
            onClose={closeTranscript}
            onTranscribed={setWords}
          />
        ) : null}
      </main>
    </div>
  );
}
