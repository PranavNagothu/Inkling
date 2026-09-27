// Full-page status screens (not found, something went wrong): the landing page's language — an
// eyebrow pill, a bold title with the teal marker, a short lede — and a way back into the app.
import Link from "next/link";
import type { ReactNode } from "react";
import { InklingMark } from "./icons";
import { Mark, btnPrimary, btnSecondary } from "./ui";

export function StatusScreen({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-16 sm:px-8">
      <Link href="/welcome" aria-label="Inkling" className="inline-flex min-h-11 items-center gap-2 self-start rounded-pill pr-2">
        <InklingMark size={26} />
        <span className="font-display text-[1.75rem] leading-none tracking-tight text-ink">Inkling</span>
      </Link>
      <div className="panel flex flex-col gap-4 p-6 sm:p-8">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        <p className="text-[16.5px] leading-relaxed text-pretty text-ink-muted">{lede}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {actions ?? (
            <>
              <Link href="/app" className={btnPrimary}>
                Go to your sessions
              </Link>
              <Link href="/welcome" className={btnSecondary}>
                About Inkling
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export function NotFoundScreen() {
  return (
    <StatusScreen
      eyebrow="404"
      title={
        <>
          Nothing written <Mark>here</Mark>
        </>
      }
      lede="This page doesn’t exist, or the session it pointed to has been removed. Your notes are safe where you left them."
    />
  );
}
