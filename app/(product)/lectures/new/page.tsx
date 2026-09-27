import type { Metadata } from "next";
import { connection } from "next/server";
import { isAiConfigured } from "@/lib/lecture";
import UploadLectureForm from "@/components/UploadLectureForm";
import LiveLectureStart from "@/components/LiveLectureStart";
import { liveLectureDisabled } from "@/lib/liveLecture";
import { BackLink, Mark, PageHeader, TopBar } from "@/components/ui";

export const metadata: Metadata = { title: "Add lecture · Inkling" };

export default async function NewLecturePage() {
  // Rendered per request: whether auto-transcribe is available depends on the server's env.
  await connection();
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Add lecture toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="truncate text-base font-bold tracking-tight text-ink">Add lecture</h1>
        </div>
      </TopBar>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        <PageHeader
          eyebrow="Add lecture"
          title={
            <>
              Bring your own <Mark>lecture</Mark>
            </>
          }
          lede="Upload a recording and, if you have them, its captions. Inkling plays it while you take notes and uses the words to show what was being said at each moment you hesitated."
        />
        <UploadLectureForm aiConfigured={isAiConfigured()} />
        <section aria-labelledby="live-heading" className="panel flex flex-col gap-3 p-4 sm:p-6">
          <div className="flex flex-col gap-1">
            <p id="live-heading" className="eyebrow">
              Or follow it live
            </p>
            <p className="text-sm text-pretty text-ink-muted">
              In the room with no recording? Start a Live lecture: Inkling transcribes the lecturer as you write and keeps the audio for Replay 20 s.
            </p>
          </div>
          <LiveLectureStart available={!liveLectureDisabled(process.env)} />
        </section>
      </main>
    </div>
  );
}
