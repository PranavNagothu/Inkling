// Shared chrome primitives: button styles, the top toolbar shell, page headers, back link and the
// ghost-ink switch. The look follows the landing page (/welcome): pill buttons, a pearl-teal metal
// primary (CSS gradient, never WebGL), white panels with hairline borders and soft shadows.
import Link from "next/link";
import type { ReactNode } from "react";
import { Highlight } from "./motion/Highlight";
import { Reveal } from "./motion/Reveal";
import { ChevronLeftIcon, GhostInkIcon } from "./icons";

const btnBase =
  "press inline-flex min-h-11 items-center justify-center gap-2 rounded-pill px-4 text-sm font-semibold whitespace-nowrap select-none disabled:cursor-not-allowed disabled:opacity-60";

/** Primary action: the pearl-teal metal pill. */
export const btnPrimary = `${btnBase} btn-metal px-5`;
/** Secondary action: white pill, hairline border, teal on hover. */
export const btnSecondary = `${btnBase} btn-quiet`;
/** Quiet inline action (links such as "Teacher view", "Retry"): teal text, soft teal hover. */
export const btnLink =
  "press inline-flex min-h-11 items-center gap-1 rounded-pill px-3 text-sm font-semibold text-accent hover:bg-accent-soft hover:text-accent-press";
export const iconBtn =
  "press inline-flex size-11 shrink-0 items-center justify-center rounded-pill text-ink-muted hover:bg-chrome-hover hover:text-ink active:bg-chrome-press";

/** White panel with a hairline border and a soft shadow (lists, forms, cards). */
export const panel = "panel";
/** The same panel as a divided list. */
export const panelList = "panel divide-y divide-line overflow-hidden";

/** Slim app toolbar: white, hairline bottom border. Wraps onto a second row on narrow screens. */
export function TopBar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <header
      aria-label={label}
      className="relative z-10 flex min-h-[var(--toolbar-h)] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-chrome/95 px-2 py-2 shadow-[0_1px_2px_rgb(15_23_42/0.03)] sm:px-3"
    >
      {children}
    </header>
  );
}

export function BackLink() {
  return (
    <Link href="/app" aria-label="Back to all sessions" className={iconBtn}>
      <ChevronLeftIcon size={22} />
    </Link>
  );
}

/**
 * A page's opening: eyebrow pill, bold title (pass a <Mark> around its key word) and a short lede.
 * Titles are h2 on pages whose toolbar already carries the h1.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  as: H = "h2",
  children,
  titleTestId,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  as?: "h1" | "h2";
  children?: ReactNode;
  titleTestId?: string;
}) {
  return (
    <Reveal as="header" className="flex flex-col gap-3">
      <p className="eyebrow">{eyebrow}</p>
      <H className="page-title" data-testid={titleTestId}>
        {title}
      </H>
      {lede ? <p className="max-w-xl text-[16.5px] leading-relaxed text-pretty text-ink-muted">{lede}</p> : null}
      {children}
    </Reveal>
  );
}

/**
 * The teal highlighter-marker swipe behind the key word of a page title. Keep trailing punctuation
 * inside it (`<Mark>lost?</Mark>`): the marker is an inline-block, and Chrome would otherwise name
 * the heading "…lost ?".
 */
export const Mark = Highlight;

/** Section label inside a page (small, bold, uppercase ink). */
export function SectionTitle({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h3 id={id} className={`px-1 text-[13px] font-bold tracking-wide text-ink uppercase ${className}`}>
      {children}
    </h3>
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
      className={`press flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-pill border px-3 text-sm font-medium ${
        checked
          ? "border-ghost/30 bg-ghost-soft text-ghost-strong"
          : "border-transparent text-ink-muted hover:bg-chrome-hover"
      }`}
    >
      <GhostInkIcon size={18} className={checked ? "text-ghost" : "text-ink-subtle"} />
      {/* Narrow phones: icon + switch only; the label stays for screen readers. */}
      <span className="sr-only whitespace-nowrap sm:not-sr-only">Ghost ink</span>
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
