"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lecture } from "@/lib/types";
import { formatClock } from "./LecturePlayer";
import { ChevronRightIcon, PlusIcon } from "./icons";
import { btnPrimary } from "./ui";

function lectureMeta(l: Lecture): string {
  const kind = l.mediaType === "video" ? "Video" : "Audio";
  const transcript = l.wordCount > 0 ? "transcript" : "no transcript";
  return `${formatClock(l.durationMs)} · ${kind} · ${transcript}`;
}

interface Props {
  lectures: Lecture[];
  /** Pre-selected lecture (the demo lecture unless the page says otherwise). */
  defaultLectureId: string;
}

/** Lecture picker + "New session". Creates a session against the chosen lecture and opens it. */
export default function NewSessionButton({ lectures, defaultLectureId }: Props) {
  const router = useRouter();
  const selectId = useId();
  const [lectureId, setLectureId] = useState(
    lectures.some((l) => l.id === defaultLectureId) ? defaultLectureId : (lectures[0]?.id ?? ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = lectures.find((l) => l.id === lectureId);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lectureId ? { lectureId } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { session } = (await res.json()) as { session: { id: string } };
      router.push(`/session/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create session");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={selectId} className="px-1 text-xs font-medium tracking-wide text-ink-subtle uppercase">
            Lecture
          </label>
          <div className="relative">
            <select
              id={selectId}
              data-testid="lecture-picker"
              value={lectureId}
              onChange={(e) => setLectureId(e.target.value)}
              className="min-h-11 w-full appearance-none truncate rounded-md border border-line-strong bg-paper py-2 pr-10 pl-3.5 text-[15px] font-medium text-ink shadow-hairline transition-colors hover:border-ink-subtle"
            >
              {lectures.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
            <ChevronRightIcon
              size={16}
              className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 rotate-90 text-ink-subtle"
            />
          </div>
        </div>
        <button
          type="button"
          data-testid="new-session"
          onClick={create}
          disabled={busy || !lectureId}
          aria-busy={busy}
          className={btnPrimary}
        >
          <PlusIcon size={18} />
          {busy ? "Creating…" : "New session"}
        </button>
      </div>
      <p data-testid="lecture-meta" className="px-1 text-sm tabular-nums text-ink-subtle">
        {selected ? lectureMeta(selected) : "No lectures yet"}
      </p>
      {error ? (
        <span role="alert" className="px-1 text-sm text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
