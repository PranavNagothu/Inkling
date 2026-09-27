"use client";

import Link from "next/link";
import { StatusScreen } from "@/components/StatusScreen";
import { Mark, btnPrimary, btnSecondary } from "@/components/ui";

// An unexpected error while rendering a page of the app: say so plainly and offer a retry.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StatusScreen
      eyebrow="Something went wrong"
      title={
        <>
          That page didn’t <Mark>load</Mark>
        </>
      }
      lede="Nothing you wrote is lost — ink is saved as you go. Try again, or head back to your sessions."
      actions={
        <>
          <button type="button" onClick={reset} className={btnPrimary}>
            Try again
          </button>
          <Link href="/app" className={btnSecondary}>
            Your sessions
          </Link>
        </>
      }
    />
  );
}
