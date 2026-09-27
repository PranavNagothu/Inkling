"use client";

// "How it works": four steps beside a lecture timeline. The timeline fills once when the section
// scrolls into view, with the session's moments (breakthrough, corrected, gap) popping in at their
// lecture seconds. It never hijacks scrolling: a step only expands when it is clicked.
// Reduced motion: the finished timeline, statically.

import { useEffect, useRef, useState } from "react";
import { animate, motion, useInView, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { HeroInk } from "./HeroInk";
import { APP_URL } from "./site";
import { PenIcon, SignalIcon, SparkIcon, GhostInkIcon } from "./icons";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";

const LECTURE_MS = 360_000;

const STEPS = [
  {
    title: "Capture",
    body: "Write while the lecture plays. Every stroke is stamped with the second it belongs to, and nothing you erase is lost.",
    Icon: PenIcon,
  },
  {
    title: "Detect",
    body: "Slower writing, extra erasing and going quiet while the lecturer keeps talking are measured against your own baseline, not a class average.",
    Icon: SignalIcon,
  },
  {
    title: "Pair",
    body: "Each erase is paired with the rewrite that replaced it, so a fixed mistake becomes a corrected misconception instead of vanishing.",
    Icon: GhostInkIcon,
  },
  {
    title: "Re-teach",
    body: "For every moment: a short re-explanation of what the lecturer said at that second and one check question, in your language.",
    Icon: SparkIcon,
  },
] as const;

type Kind = "breakthrough" | "corrected" | "gap";
const MOMENTS: { ms: number; kind: Kind; label: string; caption: string }[] = [
  { ms: 62_000, kind: "breakthrough", label: "Breakthrough", caption: "Outer derivative fixed, then proved on the check question" },
  { ms: 100_000, kind: "corrected", label: "Corrected", caption: "cos(x²) → 2x·cos(x²): forgot the inner derivative" },
  { ms: 250_000, kind: "gap", label: "Gap", caption: "Product vs chain rule: slowed down, erased, never resolved" },
];

const KIND_STYLE: Record<Kind, { dot: string; chip: string }> = {
  breakthrough: { dot: "bg-slate-900 shadow-[0_0_0_4px_rgb(15_23_42/0.12)]", chip: "border-slate-300 bg-slate-100 text-slate-800" },
  corrected: { dot: "bg-cyan-600 shadow-[0_0_0_4px_rgb(8_145_178/0.18)]", chip: "border-cyan-200 bg-cyan-50 text-cyan-800" },
  gap: { dot: "bg-amber-500 shadow-[0_0_0_4px_rgb(245_158_11/0.2)]", chip: "border-amber-200 bg-amber-50 text-amber-800" },
};

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Seconds for the timeline to fill once the section is in view. */
const FILL_SECONDS = 2.8;

function Marker({ m, fill, reduce }: { m: (typeof MOMENTS)[number]; fill: MotionValue<number>; reduce: boolean }) {
  const pos = m.ms / LECTURE_MS;
  const scale = useTransform(fill, [pos - 0.01, pos + 0.025], [0, 1], { clamp: true });
  const opacity = useTransform(fill, [pos - 0.01, pos + 0.02], [0, 1], { clamp: true });
  const style = KIND_STYLE[m.kind];
  return (
    <motion.li
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${pos * 100}%` }}
      data-moment={m.kind}
    >
      <motion.span
        className={`block size-3.5 rounded-full ${style.dot}`}
        style={reduce ? undefined : { scale, opacity }}
        aria-hidden="true"
      />
      <span className="sr-only">
        {clock(m.ms)} {m.label}: {m.caption}
      </span>
    </motion.li>
  );
}

function MomentCard({ m, fill, reduce }: { m: (typeof MOMENTS)[number]; fill: MotionValue<number>; reduce: boolean }) {
  const pos = m.ms / LECTURE_MS;
  const opacity = useTransform(fill, [pos, pos + 0.04], [0, 1], { clamp: true });
  const y = useTransform(fill, [pos, pos + 0.05], [10, 0], { clamp: true });
  const style = KIND_STYLE[m.kind];
  return (
    <motion.li
      aria-hidden="true"
      className="flex items-start gap-3 rounded-xl border border-line bg-chrome-hover/60 px-3 py-2.5"
      style={reduce ? undefined : { opacity, y }}
    >
      <span className="mt-0.5 font-mono text-[12px] text-ink-subtle tabular-nums">{clock(m.ms)}</span>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase ${style.chip}`}>
        {m.label}
      </span>
      <span className="min-w-0 text-[13.5px] leading-snug text-pretty text-ink-muted">{m.caption}</span>
    </motion.li>
  );
}

/** Mini illustration per step (decorative). */
function StepArt({ step }: { step: number }) {
  const common = { width: 148, height: 44, viewBox: "0 0 148 44", fill: "none", "aria-hidden": true as const, className: "shrink-0" };
  if (step === 0)
    return (
      <svg {...common}>
        <path d="M6 28c6-10 10-10 13 0s7 8 11-2 8-9 11 1" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
        <line x1="4" y1="38" x2="144" y2="38" stroke="#cbd5e1" strokeWidth="2" strokeLinecap="round" />
        <circle cx="30" cy="38" r="3.5" fill="#0d9488" />
        <rect x="58" y="10" width="44" height="18" rx="9" fill="#e7f7f4" stroke="#0d9488" strokeOpacity=".3" />
        <text x="80" y="23" textAnchor="middle" fontSize="10" fontFamily="ui-monospace, monospace" fill="#0f766e">00:18</text>
      </svg>
    );
  if (step === 1)
    return (
      <svg {...common}>
        <rect x="4" y="18" width="140" height="12" rx="3" fill="#e7f7f4" />
        <path d="M4 26h18l6-4 6 5 8-3 8 3 8-2 6 2 6-18 6 20 8-3 10 2 12-1 10 1h26" stroke="#0f172a" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="94" cy="8" r="4" fill="#f59e0b" />
      </svg>
    );
  if (step === 2)
    return (
      <svg {...common}>
        <path d="M6 26c5-9 9-9 12 0M22 18l8 14M30 18l-8 14" stroke="#14b8a6" strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" />
        <path d="M52 24h26m-6-5 6 5-6 5" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M94 26c5-9 9-9 12 0M110 18l8 14M118 18l-8 14M124 30c2-4 6-4 8 0" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
        <rect x="88" y="10" width="54" height="28" rx="7" stroke="#0891b2" strokeDasharray="3 3" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="4" y="4" width="80" height="22" rx="8" fill="#fff" stroke="#e2e8f0" />
      <path d="M12 12h56M12 18h40" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
      {[0, 1, 2, 3].map((k) => (
        <rect key={k} x={4 + k * 36} y="32" width="30" height="10" rx="5" fill={k === 1 ? "#0d9488" : "#fff"} stroke={k === 1 ? "#0d9488" : "#e2e8f0"} />
      ))}
    </svg>
  );
}

function Stage({
  fill,
  open,
  reduce,
  onToggle,
  demoHref,
}: {
  fill: MotionValue<number>;
  open: number | null;
  reduce: boolean;
  onToggle: (i: number) => void;
  demoHref: string;
}) {
  const playhead = useTransform(fill, (v) => `${v * 100}%`);
  return (
    <div className="grid w-full items-center gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-12">
      {/* Steps */}
      <ol className="relative grid gap-1 pl-6 lg:gap-2">
        <span aria-hidden="true" className="absolute top-2 bottom-2 left-[5px] w-px bg-line-strong" />
        <motion.span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-[5px] w-[2px] -translate-x-[0.5px] origin-top bg-gradient-to-b from-teal-500 to-cyan-600"
          style={reduce ? undefined : { scaleY: fill }}
        />
        {STEPS.map(({ title, body, Icon }, i) => {
          const current = i === open;
          const detailId = `how-step-${i}-detail`;
          return (
            <li key={title} className="relative">
              <span
                aria-hidden="true"
                className={`absolute top-[1.35rem] -left-[1.4rem] size-[11px] rounded-full border-2 transition-colors duration-300 ${
                  current ? "border-teal-600 bg-teal-500" : "border-teal-600 bg-white"
                }`}
              />
              <div
                className={`rounded-2xl transition-[opacity,background-color,box-shadow] duration-300 ${
                  current ? "bg-white shadow-card ring-1 ring-line" : "hover:bg-white/60"
                }`}
              >
                <button
                  type="button"
                  aria-expanded={current}
                  aria-controls={detailId}
                  onClick={() => onToggle(i)}
                  className="block w-full cursor-pointer rounded-2xl px-4 py-3 text-left max-lg:py-2.5"
                >
                  <span className="flex items-center gap-3">
                    <Icon size={18} className={current ? "text-accent-strong" : "text-ink-subtle"} />
                    <span className="text-lg font-bold tracking-tight text-ink">
                      <span className="mr-2 font-mono text-[12px] font-normal text-accent-strong">0{i + 1}</span>
                      {title}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-[15px] leading-relaxed text-pretty text-ink-muted">
                    {body}
                  </span>
                </button>
                <div id={detailId} hidden={!current} className="px-4 pb-3.5">
                  {current && (
                    <motion.div
                      className="flex items-center justify-between gap-3"
                      initial={reduce ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <StepArt step={i} />
                      <a
                        href={demoHref}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2 text-[14px] font-semibold text-accent-press hover:text-teal-900"
                      >
                        See it in the demo <span aria-hidden="true">→</span>
                      </a>
                    </motion.div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Visual: the ghost-ink card + the lecture timeline */}
      <div className="grid gap-4">
        <div className="hidden md:block">
          <HeroInk />
        </div>
        <div className="card p-4 sm:p-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[13px] text-ink-muted">
              <span className="font-medium text-ink">Learning timeline</span>
              <span className="max-sm:hidden">
                <span aria-hidden="true"> · </span>Calculus I, the chain rule
              </span>
            </p>
            <p className="font-mono text-[12px] whitespace-nowrap text-ink-subtle tabular-nums">00:00–06:00</p>
          </div>
          {/* The playhead is translated up to 100% of the track: clip it horizontally (with a little room). */}
          <div className="-mx-2 overflow-x-clip px-2">
          <div className="relative mt-5 mb-2 h-6">
            <div aria-hidden="true" className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
            <motion.div
              aria-hidden="true"
              className="absolute inset-x-0 top-1/2 h-1.5 origin-left -translate-y-1/2 rounded-full bg-gradient-to-r from-teal-600 via-teal-400 to-cyan-500"
              style={reduce ? undefined : { scaleX: fill }}
            />
            {!reduce && (
              <motion.div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ x: playhead }}>
                <span className="absolute top-1/2 left-0 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-[0_0_0_3px_rgb(255_255_255/0.9)]" />
              </motion.div>
            )}
            <ul aria-label="Moments on the lecture timeline" className="absolute inset-0">
              {MOMENTS.map((m) => (
                <Marker key={m.kind} m={m} fill={fill} reduce={reduce} />
              ))}
            </ul>
          </div>
          </div>
          <ul className="mt-4 grid gap-2">
            {MOMENTS.map((m) => (
              <MomentCard key={m.kind} m={m} fill={fill} reduce={reduce} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** `demoHref`: where "See it in the demo" goes — the seeded demo review in DEMO_MODE, else the app. */
export function StoryTimeline({ demoHref = APP_URL }: { demoHref?: string }) {
  const reduce = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.35 });
  const fill = useMotionValue(0);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (reduce) {
      fill.set(1);
      return;
    }
    if (!inView) return;
    const controls = animate(fill, 1, { duration: FILL_SECONDS, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [fill, inView, reduce]);

  return (
    <div ref={ref} className="py-4" data-story={reduce ? "static" : "animated"}>
      <Stage
        fill={fill}
        open={open}
        reduce={reduce}
        onToggle={(i) => setOpen((o) => (o === i ? null : i))}
        demoHref={demoHref}
      />
    </div>
  );
}
