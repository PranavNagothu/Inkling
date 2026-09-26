import type { Metadata } from "next";
import { connection } from "next/server";
import { isAiConfigured } from "@/lib/lecture";
import UploadLectureForm from "@/components/UploadLectureForm";
import { BackLink, TopBar } from "@/components/ui";

export const metadata: Metadata = { title: "Add lecture · Inkling" };

export default async function NewLecturePage() {
  // Rendered per request: whether auto-transcribe is available depends on the server's env.
  await connection();
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Add lecture toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="truncate text-base font-semibold text-ink">Add lecture</h1>
        </div>
      </TopBar>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        <header className="flex flex-col gap-2">
          <h2 className="font-display text-[2rem] leading-tight tracking-tight text-balance text-ink">
            Bring your own lecture
          </h2>
          <p className="text-pretty text-ink-muted">
            Upload a recording and, if you have them, its captions. Inkling plays it while you take notes and uses
            the words to show what was being said at each moment you hesitated.
          </p>
        </header>
        <UploadLectureForm aiConfigured={isAiConfigured()} />
      </main>
    </div>
  );
}
