"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LIVE_DEMO_MESSAGE } from "@/lib/liveLecture";
import { MicIcon } from "./icons";
import { btnSecondary } from "./ui";

/**
 * "Live lecture": a title, then Start. Creates a lecture with no recording plus a session on it
 * and opens the capture screen, where the microphone is asked for only when the student presses
 * Start there. Shown but disabled in DEMO_MODE.
 */
export default function LiveLectureStart({ available }: { available: boolean }) {
  const router = useRouter();
  const titleId = useId();
  const noteId = useId();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!available || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lectures/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(title.trim() ? { title: title.trim() } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { session?: { id: string }; error?: string };
      if (!res.ok || !body.session) throw new Error(body.error || `HTTP ${res.status}`);
      router.push(`/session/${body.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a live lecture");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={create} data-testid="live-lecture-form" aria-label="Live lecture" className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={titleId} className="px-1 text-xs font-bold tracking-wide text-ink-muted uppercase">
            Live lecture
          </label>
          <input
            id={titleId}
            data-testid="live-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Lecture title, e.g. Linear algebra — week 5"
            disabled={!available}
            aria-describedby={noteId}
            className="min-h-11 w-full rounded-pill border border-line-strong bg-white px-4 text-[15px] text-ink shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-colors placeholder:text-ink-subtle hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          data-testid="live-start"
          disabled={!available || busy}
          aria-busy={busy}
          className={`${btnSecondary} cursor-pointer`}
        >
          <MicIcon size={17} />
          {busy ? "Starting…" : "Start live lecture"}
        </button>
      </div>
      <p id={noteId} data-testid="live-lecture-note" className="px-1 text-sm text-pretty text-ink-subtle">
        {available
          ? "Taking notes in class? Inkling listens through your microphone and transcribes as you write. The mic is used only in Live lecture mode, after you press Start."
          : LIVE_DEMO_MESSAGE}
      </p>
      {error ? (
        <span role="alert" className="px-1 text-sm text-danger">
          {error}
        </span>
      ) : null}
    </form>
  );
}
