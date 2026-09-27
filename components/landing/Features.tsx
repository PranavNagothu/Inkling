"use client";

// Features: tilt + spotlight cards that open (click, Enter or Space) into a detail sheet with a
// shared-element (layoutId) expansion — focus trapped, Escape closes, focus returns to the card —
// and a "help in your language" band whose chips are a radio group: pick a language to read the
// same sample re-explanation in it (auto-cycling stops once you pick). Pointer effects only on
// fine pointers; reduced motion gets instant, static states.

import { useCallback, useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { AnimatePresence, LayoutGroup, motion, useInView, useMotionValue, useSpring } from "motion/react";
import { LANGUAGES } from "@/lib/landing/languages";
import { motionTokens, springs } from "@/lib/motion";
import { MetalLink } from "./MetalButton";
import { RadioGroup } from "./RadioGroup";
import { Stagger, StaggerItem } from "./Reveal";
import { APP_URL } from "./site";
import { useDialog } from "./useDialog";
import { useFinePointer } from "./usePointerCapabilities";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";
import { LiquidMetal } from "./ui/liquid-metal";
import { ArrowUpRightIcon, ClassIcon, CloseIcon, CompareIcon, FlaskIcon, GhostInkIcon, GlobeVoiceIcon, TimelineIcon } from "./icons";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

interface Feature {
  id: string;
  title: string;
  body: string;
  detail: string;
  icon: Icon;
}

const FEATURES: Feature[] = [
  {
    id: "ghost",
    title: "Ghost ink",
    body: "What you erase stays on the page as dashed ghost ink. Turn it on in review to see every attempt that came before the right one.",
    detail:
      "Erased strokes are kept, not deleted. In review, switch ghost ink on to see every earlier attempt under the final answer as dashed teal ink. Each erase is paired with the rewrite that replaced it, so you can see exactly what changed.",
    icon: GhostInkIcon,
  },
  {
    id: "timeline",
    title: "Learning timeline",
    body: "Each session becomes a strip of moments: corrected misconceptions, open gaps and breakthroughs, each pinned to its second of the lecture.",
    detail:
      "After a session, its moments line up on the lecture's own clock: corrected misconceptions, open gaps and breakthroughs. Replay the 20 seconds of lecture around any moment. Open gaps carry into your next session until you resolve them.",
    icon: TimelineIcon,
  },
  {
    id: "signal",
    title: "Signal Lab",
    body: "Detection you can inspect: which signals fired and why, checked against hand-labeled sessions.",
    detail:
      "See which signals fired for each moment: slower writing, extra erasing, silence while the lecturer kept talking, and pen pressure. The in-app evaluation page checks detection against hand-labeled demo sessions and shows how the threshold changes what gets flagged.",
    icon: FlaskIcon,
  },
  {
    id: "languages",
    title: "Help in 10 languages",
    body: "Re-explanations, check questions and a spoken session recap in 10 languages, read aloud whenever you'd rather listen.",
    detail:
      "Re-explanations, check questions and the spoken recap come in English, Spanish, Hindi, Mandarin, Arabic, French, Telugu, Korean, Vietnamese and Brazilian Portuguese. Any answer can be read aloud, with an ElevenLabs voice or your browser's own.",
    icon: GlobeVoiceIcon,
  },
  {
    id: "teacher",
    title: "Teacher view",
    body: "Where the class slowed down, on the lecture's own timeline. Anonymous by design: nothing is shown until at least three students share a moment.",
    detail:
      "A heatmap of where the class slowed down or erased, in 30-second steps along the lecture, plus the three stretches most worth re-teaching. No names, ids or handwriting are ever shown, and nothing appears until at least three students share a moment.",
    icon: ClassIcon,
  },
  {
    id: "notability",
    title: "Works with Notability",
    body: "Compare your process with the Notability export of the same notes, then send the session back to Notability as a PDF.",
    detail:
      "Bring in the PDF export of the same notes and compare it with Inkling's process, side by side or with an overlay slider, including a count of what the final page hides. Then send the session back to Notability as a PDF with ghost ink and labeled moments.",
    icon: CompareIcon,
  },
];

/* ───────── small visuals for the detail sheet (decorative) ───────── */

function FeatureArt({ id }: { id: string }) {
  const svg = { width: 240, height: 72, viewBox: "0 0 240 72", fill: "none", "aria-hidden": true as const };
  switch (id) {
    case "ghost":
      return (
        <svg {...svg}>
          <path d="M20 46c8-18 16-18 22 0M48 30l14 24M62 30 48 54" stroke="#14b8a6" strokeWidth="2.5" strokeDasharray="4 4" strokeLinecap="round" />
          <path d="M96 42h40m-8-7 8 7-8 7" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M160 46c8-18 16-18 22 0M188 30l14 24M202 30l-14 24M208 52c3-6 9-6 12 0" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      );
    case "timeline":
      return (
        <svg {...svg}>
          <rect x="10" y="33" width="220" height="6" rx="3" fill="#e2e8f0" />
          <rect x="10" y="33" width="150" height="6" rx="3" fill="#14b8a6" />
          <circle cx="48" cy="36" r="7" fill="#0f172a" />
          <circle cx="78" cy="36" r="7" fill="#0891b2" />
          <circle cx="176" cy="36" r="7" fill="#f59e0b" />
        </svg>
      );
    case "signal":
      return (
        <svg {...svg}>
          <rect x="10" y="40" width="220" height="16" rx="4" fill="#e7f7f4" />
          <path d="M10 52h40l10-6 12 7 12-4 14 3 10-2 10-40 10 42 14-4 18 3 20-2 50 1" stroke="#0f172a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <line x1="10" y1="28" x2="230" y2="28" stroke="#0d9488" strokeDasharray="4 4" />
        </svg>
      );
    case "languages":
      return (
        <svg {...svg}>
          {["Es", "हि", "中", "ع", "Fr", "తె"].map((t, i) => (
            <g key={t}>
              <rect x={10 + i * 38} y="22" width="32" height="28" rx="14" fill={i === 1 ? "#0f766e" : "#fff"} stroke="#cbd5e1" />
              <text x={26 + i * 38} y="41" textAnchor="middle" fontSize="13" fill={i === 1 ? "#fff" : "#0f172a"}>
                {t}
              </text>
            </g>
          ))}
        </svg>
      );
    case "teacher":
      return (
        <svg {...svg}>
          {[4, 7, 5, 12, 18, 9, 6, 14, 20, 8, 5, 4].map((h, i) => (
            <rect key={i} x={12 + i * 18} y={60 - h * 2.4} width="12" height={h * 2.4} rx="3" fill={h > 13 ? "#0d9488" : "#99f6e4"} />
          ))}
        </svg>
      );
    default:
      return (
        <svg {...svg}>
          <rect x="40" y="8" width="72" height="58" rx="6" fill="#fff" stroke="#cbd5e1" />
          <rect x="128" y="8" width="72" height="58" rx="6" fill="#fff" stroke="#0d9488" />
          <path d="M52 30h48M52 42h36M140 30h48M140 42h36" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
          <path d="M140 52h30" stroke="#14b8a6" strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" />
        </svg>
      );
  }
}

/* ───────── cards ───────── */

const RING_MASK: React.CSSProperties = {
  WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  WebkitMaskComposite: "xor",
  mask: "linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)",
};

function FeatureCard({ feature, onOpen, hidden }: { feature: Feature; onOpen: () => void; hidden: boolean }) {
  const { id, title, body, icon: I } = feature;
  const fine = useFinePointer();
  const reduce = usePrefersReducedMotion();
  const on = fine && !reduce;
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, springs.follow);
  const sry = useSpring(ry, springs.follow);
  const gx = useMotionValue(0);
  const gy = useMotionValue(0);
  const [hover, setHover] = useState(false);

  return (
    <motion.div
      className="h-full"
      style={on ? { rotateX: srx, rotateY: sry, transformPerspective: 900 } : undefined}
      onPointerMove={(e) => {
        if (!on || e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        ry.set(((e.clientX - r.left) / r.width - 0.5) * 7);
        rx.set((0.5 - (e.clientY - r.top) / r.height) * 7);
        gx.set(e.clientX - r.left - 180);
        gy.set(e.clientY - r.top - 180);
      }}
      onPointerEnter={() => on && setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        rx.set(0);
        ry.set(0);
      }}
    >
      <motion.button
        type="button"
        layoutId={`feature-${id}`}
        data-feature={id}
        aria-haspopup="dialog"
        onClick={() => {
          rx.set(0);
          ry.set(0);
          onOpen();
        }}
        className="group relative isolate block h-full w-full cursor-pointer rounded-[1.3rem] p-px text-left shadow-card transition-shadow duration-300 hover:shadow-lift"
        style={{ opacity: hidden ? 0 : 1 }}
        transition={reduce ? { duration: 0 } : springs.gentle}
      >
        <LiquidMetal as="span" css variant="teal" speed={0.5} aria-hidden="true" className="absolute inset-0 -z-10 rounded-[1.3rem] p-px" style={RING_MASK} />
        <span className="relative block h-full overflow-hidden rounded-[calc(1.3rem-1px)] bg-white/90 p-6 sm:p-7 md:bg-white/80 md:backdrop-blur-md">
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 size-[360px] rounded-full"
            style={{
              x: gx,
              y: gy,
              opacity: hover ? 1 : 0,
              transition: "opacity 250ms ease-out",
              background: "radial-gradient(closest-side, rgb(45 212 191 / 0.16), transparent 70%)",
            }}
          />
          <span className="relative inline-flex size-11 items-center justify-center rounded-xl border border-teal-600/15 bg-accent-soft text-accent-strong">
            <I size={20} />
          </span>
          <span className="relative mt-6 block text-lg font-bold tracking-tight text-ink">{title}</span>
          <span className="relative mt-2.5 block text-[15px] leading-relaxed text-pretty text-ink-muted">{body}</span>
          <span className="relative mt-4 inline-flex items-center gap-1 text-[14px] font-semibold text-accent-press">
            Learn more
            <span aria-hidden="true" className="transition-transform duration-200 group-hover:translate-x-0.5">
              →
            </span>
          </span>
        </span>
      </motion.button>
    </motion.div>
  );
}

function FeatureSheet({ feature, onClose }: { feature: Feature; onClose: () => void }) {
  const reduce = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  const { id, title, detail, icon: I } = feature;
  return (
    <div className="fixed inset-0 z-[62] flex items-end justify-center p-3 sm:items-center sm:p-6">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-900/25 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: motionTokens.duration.fast } }}
        onClick={onClose}
      />
      <motion.div
        ref={ref}
        layoutId={`feature-${id}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`feature-${id}-title`}
        className="relative isolate w-full max-w-lg rounded-[1.5rem] p-px shadow-[0_30px_80px_-20px_rgb(15_23_42/0.45)]"
        transition={reduce ? { duration: 0 } : springs.gentle}
      >
        <LiquidMetal as="span" css variant="teal" speed={0.5} aria-hidden="true" className="absolute inset-0 -z-10 rounded-[1.5rem] p-px" style={RING_MASK} />
        <motion.div
          className="relative rounded-[calc(1.5rem-1px)] bg-white p-6 sm:p-8"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: { delay: 0.08, duration: motionTokens.duration.normal } }}
        >
          <div className="flex items-start justify-between gap-4">
            <span className="inline-flex size-12 items-center justify-center rounded-xl border border-teal-600/15 bg-accent-soft text-accent-strong">
              <I size={22} />
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex size-11 items-center justify-center rounded-full border border-line text-ink-muted transition-colors hover:bg-chrome-hover hover:text-ink"
            >
              <CloseIcon size={18} />
            </button>
          </div>
          <h3 id={`feature-${id}-title`} className="mt-5 text-2xl font-extrabold tracking-tight text-ink">
            {title}
          </h3>
          <p className="mt-3 text-[16px] leading-relaxed text-pretty text-ink-muted">{detail}</p>
          <div className="mt-6 flex justify-center rounded-2xl border border-line bg-chrome-hover/60 py-4">
            <FeatureArt id={id} />
          </div>
          <div className="mt-6">
            <MetalLink href={APP_URL} size="md" magnetic={false}>
              Try it in Inkling
              <ArrowUpRightIcon size={14} strokeWidth={2.2} />
            </MetalLink>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}

/* ───────── language band ───────── */

function LanguageBand() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!inView || reduce || picked) return;
    const t = window.setInterval(() => setCycle((n) => (n + 1) % LANGUAGES.length), 2600);
    return () => clearInterval(t);
  }, [inView, reduce, picked]);

  const lang = LANGUAGES.find((l) => l.code === picked) ?? LANGUAGES[cycle];
  const fade = { duration: reduce ? 0 : motionTokens.duration.normal, ease: motionTokens.easing.smooth };

  return (
    <div ref={ref} className="card relative overflow-hidden p-6 sm:p-10">
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div>
          <p className="eyebrow">Help in your language</p>
          <p className="mt-5 text-[clamp(1.6rem,3.4vw,2.6rem)] leading-[1.15] font-extrabold tracking-[-0.03em] text-ink">
            <span className="text-ink-muted">“Explain it again in</span>
            {/* One line reserved for the language, so nothing below it moves while it changes. */}
            <span className="grid h-[1.3em] overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={lang.code}
                  className="col-start-1 row-start-1 text-accent-strong"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.5em" }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-0.5em" }}
                  transition={fade}
                >
                  <span lang={lang.code} dir={lang.rtl ? "rtl" : undefined}>
                    {lang.native}
                  </span>
                  <span className="text-ink-muted">”</span>
                </motion.span>
              </AnimatePresence>
            </span>
          </p>
          <p className="mt-4 max-w-md text-[15.5px] leading-relaxed text-pretty text-ink-muted">
            Pick a language to see how Inkling re-explains the same mistake:{" "}
            <span className="font-mono text-[14px] text-ink whitespace-nowrap">d/dx sin(x²) = cos(x²)</span>.
          </p>
        </div>

        <div className="grid gap-5">
          <RadioGroup
            label="Language for the sample explanation"
            value={picked}
            onChange={setPicked}
            className="flex-wrap gap-2 lg:justify-end"
            optionClassName={(checked, code) =>
              `border px-3.5 text-[14px] ${
                checked
                  ? "border-teal-700 bg-teal-700 text-white"
                  : !picked && code === lang.code && !reduce
                    ? "border-teal-600/40 bg-accent-soft text-accent-press"
                    : "border-line bg-white text-ink-muted hover:border-teal-600/40 hover:text-ink"
              }`
            }
            options={LANGUAGES.map((l) => ({
              value: l.code,
              label: l.native === l.name ? l.name : `${l.native} (${l.name})`,
              children: (
                <span lang={l.code} dir={l.rtl ? "rtl" : undefined}>
                  {l.native}
                </span>
              ),
            }))}
          />

          <figure className="rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
            <figcaption className="flex items-center justify-between gap-3 text-[12px] font-medium tracking-wide text-ink-subtle uppercase">
              <span>Re-explanation · corrected misconception</span>
              <span className="normal-case">{lang.name}</span>
            </figcaption>
            <div className="mt-3 grid min-h-[5.5rem]" aria-live={picked ? "polite" : "off"}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={lang.code}
                  data-testid="language-sample"
                  lang={lang.code}
                  dir={lang.rtl ? "rtl" : undefined}
                  className="col-start-1 row-start-1 text-[16.5px] leading-relaxed text-pretty text-ink"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={fade}
                >
                  {lang.sample}
                </motion.p>
              </AnimatePresence>
            </div>
          </figure>
        </div>
      </div>
    </div>
  );
}

export function Features() {
  const [open, setOpen] = useState<string | null>(null);
  const feature = FEATURES.find((f) => f.id === open) ?? null;
  const close = useCallback(() => setOpen(null), []);

  return (
    <div className="grid gap-5">
      <LayoutGroup>
        <Stagger className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <StaggerItem key={f.id} className="h-full">
              <FeatureCard feature={f} onOpen={() => setOpen(f.id)} hidden={open === f.id} />
            </StaggerItem>
          ))}
        </Stagger>
        <AnimatePresence>{feature && <FeatureSheet key={feature.id} feature={feature} onClose={close} />}</AnimatePresence>
      </LayoutGroup>
      <LanguageBand />
    </div>
  );
}
