// "Carried over": gaps from earlier sessions of this lecture, seen from the session under review —
// resolved here (written through calmly), came up again here, or still open.
import Link from "next/link";
import type { CarriedThread } from "@/lib/progress";
import { formatClock } from "@/lib/time";
import { MomentGlyph } from "./Timeline";
import { CheckIcon } from "./icons";

const STATE: Record<CarriedThread["here"], { text: string; className: string }> = {
  resolved: { text: "Resolved this session", className: "bg-breakthrough-soft text-breakthrough-strong" },
  repeated: { text: "Came up again", className: "bg-gap-soft text-gap-strong" },
  open: { text: "Still open", className: "bg-chrome-press text-ink-muted" },
};

export default function CarriedOver({ threads, sessionId }: { threads: CarriedThread[]; sessionId: string }) {
  if (threads.length === 0) return null;
  const resolved = threads.filter((t) => t.here === "resolved").length;
  return (
    <section data-testid="carried-over" aria-labelledby="carried-heading" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="carried-heading" className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
          Carried over
        </h2>
        <p className="text-xs text-ink-muted tabular-nums">
          {threads.length} {threads.length === 1 ? "gap" : "gaps"} from earlier sessions
          {resolved > 0 ? ` · ${resolved} resolved this session` : ""}
        </p>
      </div>
      <ul className="flex flex-wrap gap-2">
        {threads.map((t) => {
          // The most recent occurrence from an earlier session (the one this session carried over).
          const earlier = [...t.gaps].reverse().find((g) => g.sessionId !== sessionId) ?? t.latest;
          const state = STATE[t.here];
          return (
            <li key={t.rootId} className="min-w-0">
              <Link
                href={`/review/${earlier.sessionId}?moment=${encodeURIComponent(earlier.eventId)}`}
                data-testid="carried-over-item"
                data-state={t.here}
                data-event-id={earlier.eventId}
                className="press group flex min-h-11 max-w-full items-center gap-2 rounded-pill border border-line bg-chrome py-1 pr-1.5 pl-3 text-sm shadow-hairline hover:bg-chrome-hover"
              >
                {t.here === "resolved" ? (
                  <CheckIcon size={14} className="shrink-0 text-breakthrough-strong" />
                ) : (
                  <MomentGlyph type="unresolved_gap" size={12} className="shrink-0" />
                )}
                <span className="max-w-[24rem] truncate text-ink">{t.label}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-ink-subtle">{formatClock(earlier.lectureMs)}</span>
                <span className={`shrink-0 rounded-pill px-2 py-0.5 text-xs font-semibold ${state.className}`}>{state.text}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
