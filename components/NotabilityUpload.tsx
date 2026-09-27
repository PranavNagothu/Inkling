"use client";

import { useId, useState, type DragEvent, type ReactNode } from "react";
import type { NotabilityImport } from "@/lib/types";
import { PDF_ACCEPT, PDF_HEADER_BYTES, checkPdfFile, isPdfHeader } from "@/lib/notability";
import { DocumentIcon, UploadIcon } from "./icons";
import { btnPrimary, btnSecondary } from "./ui";
import { PDF_DEMO_MESSAGE } from "@/lib/demoMode";

type UploadState = { status: "idle" } | { status: "uploading"; name: string } | { status: "error"; error: string };

/**
 * Checks a PDF in the browser (name, type, size and the "%PDF-" signature — the server checks all of
 * it again) and uploads it as the session's current Notability import. `available` is false in
 * DEMO_MODE: the controls are shown disabled with a note (and the server answers 403 anyway).
 */
export function useNotabilityUpload(sessionId: string, onUploaded: (imported: NotabilityImport) => void, available = true) {
  const [state, setState] = useState<UploadState>({ status: "idle" });

  const upload = async (file: File | null) => {
    if (!available || !file || state.status === "uploading") return;
    const check = checkPdfFile(file);
    if (!check.ok) return setState({ status: "error", error: check.error });
    const head = new Uint8Array(await file.slice(0, PDF_HEADER_BYTES).arrayBuffer());
    if (!isPdfHeader(head)) {
      return setState({ status: "error", error: "That file isn’t a PDF. In Notability, use Share → Export → PDF." });
    }
    setState({ status: "uploading", name: file.name });
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notability`, { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { import?: NotabilityImport; error?: string };
      if (!res.ok || !json.import) throw new Error(json.error || "Upload failed — try again.");
      setState({ status: "idle" });
      onUploaded(json.import);
    } catch (err) {
      setState({ status: "error", error: err instanceof Error ? err.message : "Upload failed — try again." });
    }
  };

  return { state, upload, available, dismiss: () => setState({ status: "idle" }) };
}

/** A visually hidden file input inside a label: stays in the tab order, the label is the target. */
function FileInput({
  testId,
  label,
  onFile,
  disabled,
  describedBy,
}: {
  testId: string;
  label: string;
  onFile: (f: File | null) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      type="file"
      accept={PDF_ACCEPT}
      data-testid={testId}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className="sr-only"
      onChange={(e) => {
        onFile(e.target.files?.[0] ?? null);
        e.target.value = "";
      }}
    />
  );
}

export function UploadError({ state }: { state: UploadState }) {
  if (state.status !== "error") return null;
  return (
    <p role="alert" data-testid="notability-upload-error" className="text-sm text-pretty text-danger">
      {state.error}
    </p>
  );
}

/** "Share → Export → PDF" as small steps. */
function ExportSteps() {
  const steps = ["Share", "Export", "PDF"];
  return (
    <ol aria-label="How to export from Notability" className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-ink-muted">
      {steps.map((s, i) => (
        <li key={s} className="inline-flex items-center gap-1.5">
          <span className="rounded-pill border border-line bg-chrome px-2.5 py-0.5 font-medium text-ink shadow-[0_1px_2px_rgb(15_23_42/0.04)]">{s}</span>
          {i < steps.length - 1 ? <span aria-hidden="true" className="text-ink-subtle">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** Empty state of the "Notability — final page" panel: explanation, drop zone and export steps. */
export function NotabilityDropzone({
  upload,
  state,
  title = "Add your Notability page",
  available = true,
  children,
}: {
  upload: (file: File | null) => void;
  state: UploadState;
  title?: string;
  /** False in DEMO_MODE: the drop zone is shown disabled, with a note. */
  available?: boolean;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const headingId = useId();
  const noteId = useId();
  const busy = state.status === "uploading";
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (available) void upload(e.dataTransfer.files?.[0] ?? null);
  };

  return (
    <section aria-labelledby={headingId} className="mx-auto flex w-full max-w-md flex-col items-center gap-5 px-4 py-8 text-center">
      <span aria-hidden="true" className="inline-flex size-12 items-center justify-center rounded-lg border border-teal-200 bg-accent-soft text-accent-press shadow-raised">
        <DocumentIcon size={24} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h3 id={headingId} className="text-xl font-extrabold tracking-tight text-balance text-ink">
          {title}
        </h3>
        {children ?? (
          <p className="text-sm text-pretty text-ink-muted">
            Notability keeps the final page. Upload its PDF export to see, right next to it, everything that page hides.
          </p>
        )}
      </div>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="notability-dropzone"
        data-over={over ? "true" : "false"}
        data-available={available ? "true" : "false"}
        className={`flex w-full flex-col items-center gap-3 rounded-lg border border-dashed px-5 py-6 transition-[background-color,border-color,box-shadow] duration-150 focus-within:shadow-[var(--focus-ring)] ${
          !available
            ? "cursor-not-allowed border-line-strong bg-paper opacity-70"
            : over
              ? "cursor-pointer border-accent bg-accent-soft"
              : "cursor-pointer border-line-strong bg-paper hover:border-ink-subtle hover:bg-chrome"
        } ${busy ? "pointer-events-none opacity-70" : ""}`}
      >
        <span className={`${btnPrimary} pointer-events-none`} aria-hidden="true">
          <UploadIcon size={16} />
          {busy ? "Uploading…" : "Choose PDF"}
        </span>
        {available ? (
          <span className="text-sm text-ink-subtle">or drop it here · up to 50 MB</span>
        ) : (
          <span id={noteId} data-testid="notability-demo-note" className="text-sm text-pretty text-ink-muted">
            {PDF_DEMO_MESSAGE}
          </span>
        )}
        <FileInput
          testId="notability-upload"
          label="Upload a Notability PDF export"
          onFile={(f) => void upload(f)}
          disabled={busy || !available}
          describedBy={available ? undefined : noteId}
        />
      </label>

      <div role="status" aria-live="polite" className="sr-only">
        {busy ? `Uploading ${state.name}` : ""}
      </div>
      <UploadError state={state} />

      <div className="flex flex-col items-center gap-2">
        <p className="text-xs font-bold tracking-wide text-ink-muted uppercase">In Notability</p>
        <ExportSteps />
        <p className="text-xs text-pretty text-ink-subtle">Open the note, then save the PDF to Files and pick it here.</p>
      </div>
    </section>
  );
}

/** Toolbar button that swaps in a newer export (the earlier one is kept as history). */
export function ReplacePdfButton({
  upload,
  state,
  available = true,
}: {
  upload: (file: File | null) => void;
  state: UploadState;
  /** False in DEMO_MODE: shown disabled, the note as its tooltip and description. */
  available?: boolean;
}) {
  const busy = state.status === "uploading";
  const noteId = useId();
  if (!available) {
    return (
      <button
        type="button"
        disabled
        data-testid="notability-replace-disabled"
        title={PDF_DEMO_MESSAGE}
        aria-describedby={noteId}
        className={`${btnSecondary} cursor-not-allowed opacity-60`}
      >
        <UploadIcon size={16} />
        Replace PDF
        <span id={noteId} className="sr-only">
          {PDF_DEMO_MESSAGE}
        </span>
      </button>
    );
  }
  return (
    <label className={`${btnSecondary} cursor-pointer focus-within:shadow-[var(--focus-ring)] ${busy ? "opacity-60" : ""}`}>
      <UploadIcon size={16} />
      {busy ? "Uploading…" : "Replace PDF"}
      <FileInput testId="notability-replace" label="Replace the Notability PDF" onFile={(f) => void upload(f)} disabled={busy} />
    </label>
  );
}
