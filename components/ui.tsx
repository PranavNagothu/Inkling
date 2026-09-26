// Shared chrome primitives: button styles, the top toolbar shell, back link and ghost-ink switch.
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeftIcon, GhostInkIcon } from "./icons";

const btnBase =
  "press inline-flex min-h-11 items-center justify-center gap-2 rounded-pill px-4 text-sm font-semibold whitespace-nowrap select-none disabled:cursor-not-allowed disabled:opacity-60";

export const btnPrimary = `${btnBase} bg-accent text-on-accent shadow-raised hover:bg-accent-hover active:bg-accent-press`;
export const btnSecondary = `${btnBase} border border-line-strong bg-chrome text-ink hover:bg-chrome-hover active:bg-chrome-press`;
export const iconBtn =
  "press inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-chrome-hover hover:text-ink active:bg-chrome-press";

/** Slim fixed-height app toolbar. Wraps onto a second row on narrow screens. */
export function TopBar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <header
      aria-label={label}
      className="relative z-10 flex min-h-[var(--toolbar-h)] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-chrome px-2 py-2 sm:px-3"
    >
      {children}
    </header>
  );
}

export function BackLink() {
  return (
    <Link href="/" aria-label="Back to all sessions" className={iconBtn}>
      <ChevronLeftIcon size={22} />
    </Link>
  );
}

/** Vertical divider between toolbar groups. */
export function Divider() {
  return <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-line sm:block" />;
}

/**
 * Ghost-ink switch. A real checkbox (role="switch") so it stays keyboard/AT friendly and keeps
 * check()/uncheck() semantics; the whole label is the tap target.
 */
export function GhostToggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label
      className={`press flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-pill px-3 text-sm font-medium ${
        checked ? "bg-ghost-soft text-ghost-strong" : "text-ink-muted hover:bg-chrome-hover"
      }`}
    >
      <GhostInkIcon size={18} className={checked ? "text-ghost" : "text-ink-subtle"} />
      <span>Ghost ink</span>
      <input
        type="checkbox"
        role="switch"
        data-testid="ghost-toggle"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="ghost-switch"
      />
    </label>
  );
}
