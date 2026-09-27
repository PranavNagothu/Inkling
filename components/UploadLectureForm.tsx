"use client";

import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseCaptions } from "@/lib/captions";
import type { Lecture, LectureMediaType } from "@/lib/types";
import {
  CAPTIONS_ACCEPT,
  MEDIA_ACCEPT,
  checkCaptionsFile,
  checkMediaFile,
  sanitizeTitle,
  titleFromFileName,
} from "@/lib/upload";
import { formatClock } from "./LecturePlayer";
import { CaptionsIcon, CheckIcon, WaveIcon } from "./icons";
import { btnPrimary, btnSecondary } from "./ui";

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Reads a file's duration with a detached (never shown) media element. Some WebM files report
 * Infinity until the browser has scanned to the end, so those are nudged with a far seek.
 */
function readMediaDuration(file: File, kind: LectureMediaType): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), 15_000);
    const accept = () => {
      // Read before finish(): unloading the element resets its duration.
      const seconds = el.duration;
      if (Number.isFinite(seconds) && seconds > 0) finish(() => resolve(Math.round(seconds * 1000)));
    };
    el.addEventListener("loadedmetadata", () => {
      accept();
      if (!settled) el.currentTime = 1e7;
    });
    el.addEventListener("durationchange", accept);
    el.addEventListener("error", () => finish(() => reject(new Error("unplayable"))));
    el.src = url;
  });
}

type MediaState =
  | { status: "empty" }
  | { status: "reading"; file: File; kind: LectureMediaType }
  | { status: "ready"; file: File; kind: LectureMediaType; durationMs: number }
  | { status: "error"; file?: File; error: string };

type CaptionState =
  | { status: "empty" }
  | { status: "ready"; file: File; cues: number }
  | { status: "error"; file: File; error: string };

/** A file picker styled as a drop zone. The input stays in the tab order (visually hidden). */
function FileZone({
  label,
  hint,
  accept,
  testId,
  icon,
  onFile,
  children,
  invalid,
}: {
  label: string;
  hint: string;
  accept: string;
  testId: string;
  icon: ReactNode;
  onFile: (file: File | null) => void;
  children?: ReactNode;
  invalid?: boolean;
}) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`group relative flex min-h-[4.5rem] cursor-pointer items-center gap-3.5 rounded-lg border border-dashed px-4 py-3.5 transition-[background-color,border-color,box-shadow] duration-150 focus-within:shadow-[var(--focus-ring)] ${
        over
          ? "border-accent bg-accent-soft"
          : invalid
            ? "border-danger/50 bg-paper"
            : "border-line-strong bg-white/70 hover:border-accent/60 hover:bg-white"
      }`}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-teal-200 bg-accent-soft text-accent-press"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {children ?? (
          <>
            <span className="text-[15px] font-medium text-ink">{label}</span>
            <span className="text-sm text-ink-subtle">{hint}</span>
          </>
        )}
      </span>
      <input
        type="file"
        accept={accept}
        data-testid={testId}
        aria-label={label}
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
    </label>
  );
}

export default function UploadLectureForm({ aiConfigured }: { aiConfigured: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [media, setMedia] = useState<MediaState>({ status: "empty" });
  const [captions, setCaptions] = useState<CaptionState>({ status: "empty" });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readToken = useRef(0);
  const titleEdited = useRef(false);

  const chooseMedia = async (file: File | null) => {
    setError(null);
    if (!file) return;
    const check = checkMediaFile(file);
    const token = ++readToken.current;
    if (!check.ok) {
      setMedia({ status: "error", file, error: check.error });
      return;
    }
    if (!titleEdited.current) setTitle(titleFromFileName(file.name));
    setMedia({ status: "reading", file, kind: check.value.mediaType });
    try {
      const durationMs = await readMediaDuration(file, check.value.mediaType);
      if (token === readToken.current) setMedia({ status: "ready", file, kind: check.value.mediaType, durationMs });
    } catch {
      if (token === readToken.current) {
        setMedia({ status: "error", file, error: "This browser can't play that file, so its length is unknown." });
      }
    }
  };

  const chooseCaptions = async (file: File | null) => {
    setError(null);
    if (!file) return;
    const check = checkCaptionsFile(file);
    if (!check.ok) return setCaptions({ status: "error", file, error: check.error });
    const cues = parseCaptions(await file.text()).length;
    setCaptions(
      cues > 0 ? { status: "ready", file, cues } : { status: "error", file, error: "No captions found in that file." },
    );
  };

  const uploading = progress !== null;
  const canSubmit = media.status === "ready" && captions.status !== "error" && !uploading;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (media.status !== "ready" || captions.status === "error") return;
    const form = new FormData();
    form.set("title", sanitizeTitle(title, titleFromFileName(media.file.name) || "Untitled lecture"));
    form.set("durationMs", String(media.durationMs));
    form.set("media", media.file);
    if (captions.status === "ready") form.set("captions", captions.file);

    // XHR (not fetch) for upload progress on large recordings.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/lectures");
    xhr.responseType = "json";
    xhr.upload.onprogress = (ev) => ev.lengthComputable && setProgress(ev.loaded / ev.total);
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { lecture?: Lecture; error?: string };
      if (xhr.status === 201 && body.lecture) {
        setProgress(1);
        router.push(`/app?lecture=${encodeURIComponent(body.lecture.id)}`);
        return;
      }
      setProgress(null);
      setError(body.error || `Upload failed (HTTP ${xhr.status}).`);
    };
    xhr.onerror = () => {
      setProgress(null);
      setError("Upload failed — check your connection and try again.");
    };
    setError(null);
    setProgress(0);
    xhr.send(form);
  };

  const mediaSummary = (() => {
    if (media.status === "empty") return null;
    const f = media.file;
    const kind = media.status === "error" ? null : media.kind === "video" ? "Video" : "Audio";
    return (
      <>
        <span className="truncate text-[15px] font-medium text-ink" title={f?.name}>
          {f?.name}
        </span>
        {media.status === "error" ? (
          <span data-testid="media-error" className="text-sm text-danger">
            {media.error}
          </span>
        ) : (
          <span data-testid="media-info" className="text-sm tabular-nums text-ink-subtle">
            {kind} · {f ? formatBytes(f.size) : ""} ·{" "}
            {media.status === "reading" ? "reading length…" : formatClock(media.durationMs)}
          </span>
        )}
      </>
    );
  })();

  const captionSummary =
    captions.status === "empty" ? null : (
      <>
        <span className="truncate text-[15px] font-medium text-ink" title={captions.file.name}>
          {captions.file.name}
        </span>
        {captions.status === "error" ? (
          <span data-testid="captions-error" className="text-sm text-danger">
            {captions.error}
          </span>
        ) : (
          <span data-testid="captions-info" className="inline-flex items-center gap-1.5 text-sm text-ok">
            <CheckIcon size={14} />
            {captions.cues} {captions.cues === 1 ? "caption" : "captions"} · word timings ready
          </span>
        )}
      </>
    );

  return (
    <form
      onSubmit={submit}
      data-testid="upload-form"
      className="panel flex flex-col gap-6 p-4 sm:p-6"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="lecture-title" className="text-sm font-medium text-ink">
          Title
        </label>
        <input
          id="lecture-title"
          data-testid="title-input"
          value={title}
          maxLength={200}
          placeholder="e.g. Calculus I — Related rates"
          onChange={(e) => {
            titleEdited.current = true;
            setTitle(e.target.value);
          }}
          className="min-h-11 rounded-md border border-line-strong bg-white px-3.5 text-[15px] text-ink shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-colors placeholder:text-ink-subtle/80 hover:border-accent/60"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Recording</span>
        <FileZone
          label="Choose audio or video"
          hint="MP3, M4A, WAV, WebM or MP4 · up to 300 MB"
          accept={MEDIA_ACCEPT}
          testId="media-input"
          icon={<WaveIcon size={20} />}
          onFile={chooseMedia}
          invalid={media.status === "error"}
        >
          {mediaSummary}
        </FileZone>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="flex items-baseline gap-2 text-sm font-medium text-ink">
          Captions <span className="font-normal text-ink-subtle">optional</span>
        </span>
        <FileZone
          label="Choose a captions file"
          hint="WebVTT (.vtt) or SubRip (.srt) · up to 2 MB"
          accept={CAPTIONS_ACCEPT}
          testId="captions-input"
          icon={<CaptionsIcon size={20} />}
          onFile={chooseCaptions}
          invalid={captions.status === "error"}
        >
          {captionSummary}
        </FileZone>
        <p className="px-1 text-sm text-pretty text-ink-subtle">
          Captions become the transcript you can follow while taking notes. Without them the lecture still works, but
          moments won’t show what was said and pauses in your writing aren’t scored.
        </p>
        {!aiConfigured ? (
          <p data-testid="upload-ai-note" className="px-1 text-xs text-ink-subtle">
            Auto-transcribe needs an OpenAI or Groq key
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" data-testid="upload-error" className="rounded-md bg-gap-soft px-3.5 py-2.5 text-sm text-gap-strong">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col-reverse items-stretch gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-end">
        {uploading ? (
          <div className="flex min-w-0 flex-1 items-center gap-3" role="status" aria-live="polite">
            <div className="relative h-1 flex-1 overflow-hidden rounded-pill bg-line">
              <div
                className="absolute inset-0 origin-left rounded-pill bg-accent transition-transform duration-150"
                style={{ transform: `scaleX(${progress})` }}
              />
            </div>
            <span className="w-10 text-right text-sm tabular-nums text-ink-subtle">
              {Math.round((progress ?? 0) * 100)}%
            </span>
          </div>
        ) : null}
        <Link href="/app" className={btnSecondary}>
          Cancel
        </Link>
        <button type="submit" data-testid="upload-submit" disabled={!canSubmit} aria-busy={uploading} className={btnPrimary}>
          {uploading ? "Uploading…" : "Add lecture"}
        </button>
      </div>
    </form>
  );
}
