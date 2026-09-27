"use client";

/*
 * Inkling hero — light "paper" edition. Transparent over the page-wide LiquidMetal background
 * (components/PageBackground), with a cursor-follow glow, the headline block bottom-left
 * (badge, three-line headline with a liquid-metal key word, lead, CTAs), floating "moment" chips
 * on wide screens, and the Paper Shaders orb with rotating circular text top-right (clear of the
 * floating "Ask Inkling" launcher bottom-right).
 *
 *  - Shaders are client-only; the orb is lazy (next/dynamic, ssr:false) and only mounts with WebGL2.
 *  - prefers-reduced-motion: orb frozen, circular text and chips
 *    still, cursor glow off, entrances land instantly.
 *  - The header is fixed (it gains a white glass bar once you scroll) and has a mobile menu.
 */

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useInView, useMotionValue, useSpring } from "motion/react";
import { APP_URL, NAV_LINKS } from "@/components/landing/site";
import { CloseIcon, MenuIcon, PlayIcon, ArrowUpRightIcon } from "@/components/landing/icons";
import { MetalLink } from "@/components/landing/MetalButton";
import { Magnetic } from "@/components/landing/Magnetic";
import { useFinePointer } from "@/components/landing/usePointerCapabilities";
import { usePrefersReducedMotion } from "@/components/motion/usePrefersReducedMotion";
import { motionTokens, springs } from "@/lib/motion";
import { LiquidMetal } from "./liquid-metal";

const HeroPulse = dynamic(() => import("./hero-shaders").then((m) => m.HeroPulse), { ssr: false });

/* ───────────── client-only environment hooks (hydration-safe: server snapshot = false) ───────────── */

const noopSubscribe = () => () => {};

let webgl2Cache: boolean | undefined;
function detectWebGL2(): boolean {
  if (webgl2Cache !== undefined) return webgl2Cache;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    webgl2Cache = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2Cache = false;
  }
  return webgl2Cache;
}
const useWebGL2 = () => useSyncExternalStore(noopSubscribe, detectWebGL2, () => false);

function subscribeScroll(cb: () => void) {
  window.addEventListener("scroll", cb, { passive: true });
  return () => window.removeEventListener("scroll", cb);
}
const useScrolled = () =>
  useSyncExternalStore(
    subscribeScroll,
    () => window.scrollY > 12,
    () => false,
  );

/* ───────────── header ───────────── */

function InkDropLogo({ reduce }: { reduce: boolean }) {
  return (
    <motion.a
      href="#top"
      aria-label="Inkling, back to top"
      className="group relative flex min-h-11 items-center gap-2.5 rounded-full pr-2"
      whileHover={reduce ? undefined : { scale: motionTokens.scale.pop }}
      transition={springs.snappy}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="size-9">
        <defs>
          <linearGradient id="logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0f766e" />
            <stop offset="55%" stopColor="#0f172a" />
            <stop offset="100%" stopColor="#0d9488" />
          </linearGradient>
        </defs>
        <path d="M16 2.5c-1.2 3.6-8 9.6-8 15a8 8 0 0 0 16 0c0-5.4-6.8-11.4-8-15Z" fill="url(#logo-gradient)" />
        <path
          d="M12.4 18.2a3.8 3.8 0 0 0 3 3.9"
          fill="none"
          stroke="#ccfbf1"
          strokeWidth="1.7"
          strokeLinecap="round"
          opacity=".8"
        />
        <path d="M4 29.5h24" fill="none" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
      </svg>
      <span className="font-display text-[1.75rem] leading-none tracking-tight text-ink">Inkling</span>
    </motion.a>
  );
}

function HeroHeader({ reduce }: { reduce: boolean }) {
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the menu and hands focus back to its button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const solid = scrolled || open;

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,box-shadow] duration-300 ${
        solid
          ? "border-b border-line/80 bg-white/80 shadow-[0_1px_12px_-6px_rgb(15_23_42/0.12)] backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <div className="container-x flex h-[var(--nav-h)] items-center justify-between gap-3">
        <InkDropLogo reduce={reduce} />

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-0.5">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[14px] text-ink-muted transition-colors duration-200 hover:bg-ink/[0.05] hover:text-ink"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <MetalLink href={APP_URL} size="md" magnetic={false} className="max-sm:px-4">
            Open Inkling
            <ArrowUpRightIcon size={14} strokeWidth={2.2} />
          </MetalLink>
          <button
            ref={buttonRef}
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-full border border-line-strong bg-white/80 text-ink backdrop-blur-sm lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.nav
            id="mobile-menu"
            aria-label="Mobile"
            className="border-t border-line lg:hidden"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -motionTokens.distance.sm }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: motionTokens.duration.fast } }}
            transition={{ duration: motionTokens.duration.fast, ease: motionTokens.easing.smooth }}
          >
            <ul className="container-x flex flex-col py-2">
              {NAV_LINKS.map((l) => (
                <li key={l.href} className="border-b border-line last:border-b-0">
                  <a
                    href={l.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-12 items-center justify-between text-[17px] text-ink"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}

/* ───────────── top-right orb with circular text ───────────── */

const RING_TEXT = "INKLING • LEARNING IS IN THE PROCESS • INKLING • LEARNING IS IN THE PROCESS • ";
const RING_R = 40;
const RING_LEN = 2 * Math.PI * RING_R;

function PulseOrb({ webgl, animate }: { webgl: boolean; animate: boolean }) {
  return (
    <div className="relative flex size-20 items-center justify-center">
      {webgl ? (
        <HeroPulse animate={animate} />
      ) : (
        <span
          aria-hidden="true"
          className="size-[60px] rounded-full"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, transparent 52%, rgb(13 148 136 / 0.85) 60%, rgb(94 234 212 / 0.6) 66%, transparent 74%)",
          }}
        />
      )}
      <motion.svg
        aria-hidden="true"
        focusable="false"
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        style={{ scale: 1.6 }}
        animate={animate ? { rotate: 360 } : { rotate: 0 }}
        transition={animate ? { duration: 20, repeat: Infinity, ease: "linear" } : { duration: 0 }}
      >
        <defs>
          <path
            id="orb-circle"
            d={`M 50, 50 m -${RING_R}, 0 a ${RING_R},${RING_R} 0 1,1 ${RING_R * 2},0 a ${RING_R},${RING_R} 0 1,1 -${RING_R * 2},0`}
          />
        </defs>
        <text className="fill-slate-700 font-medium" style={{ fontSize: 5.1, letterSpacing: 0 }}>
          <textPath href="#orb-circle" startOffset="0%" textLength={RING_LEN.toFixed(1)} lengthAdjust="spacing">
            {RING_TEXT}
          </textPath>
        </text>
      </motion.svg>
    </div>
  );
}

/* ───────────── floating moment chips (wide screens) ───────────── */

const CHIPS = [
  {
    t: "01:02",
    label: "Breakthrough",
    note: "outer derivative, proved",
    dot: "bg-slate-900",
    pos: "top-[26%] right-[14%]",
    d: 0,
  },
  {
    t: "01:40",
    label: "Corrected",
    note: "forgot the inner derivative",
    dot: "bg-cyan-600",
    pos: "top-[40%] right-[24%]",
    d: 0.6,
  },
  {
    t: "04:10",
    label: "Gap",
    note: "product vs chain rule",
    dot: "bg-amber-600",
    pos: "top-[55%] right-[11%]",
    d: 1.2,
  },
] as const;

function FloatingChips({ animate, reduce }: { animate: boolean; reduce: boolean }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 hidden xl:block">
      {CHIPS.map((c, i) => (
        <motion.div
          key={c.label}
          className={`absolute ${c.pos}`}
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: motionTokens.distance.lg }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: motionTokens.duration.slow, delay: 0.9 + i * 0.15, ease: motionTokens.easing.smooth }
          }
        >
          <motion.div
            className="flex items-center gap-3 rounded-2xl border border-white/70 bg-white/70 py-2.5 pr-4 pl-3 shadow-[0_12px_32px_-16px_rgb(15_23_42/0.35)] backdrop-blur-md"
            animate={animate ? { y: [0, -8, 0] } : { y: 0 }}
            transition={animate ? { duration: 6, repeat: Infinity, ease: "easeInOut", delay: c.d } : { duration: 0 }}
          >
            <span className={`size-2.5 rounded-full ${c.dot}`} />
            <span className="font-mono text-[12px] text-ink-subtle tabular-nums">{c.t}</span>
            <span className="text-[13.5px] font-semibold text-ink">{c.label}</span>
            <span className="text-[13px] text-ink-muted">· {c.note}</span>
          </motion.div>
        </motion.div>
      ))}
    </div>
  );
}

/* ───────────── cursor-follow glow ───────────── */

function CursorGlow({ active }: { active: boolean }) {
  const x = useMotionValue(-400);
  const y = useMotionValue(-400);
  const sx = useSpring(x, springs.follow);
  const sy = useSpring(y, springs.follow);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!active || !host) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = host.getBoundingClientRect();
      x.set(e.clientX - r.left - 260);
      y.set(e.clientY - r.top - 260);
    };
    host.addEventListener("pointermove", onMove, { passive: true });
    return () => host.removeEventListener("pointermove", onMove);
  }, [active, x, y]);

  return (
    <motion.div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 z-0 size-[520px] rounded-full"
      style={{
        x: sx,
        y: sy,
        opacity: active ? 1 : 0,
        background:
          "radial-gradient(closest-side, rgb(45 212 191 / 0.22), rgb(45 212 191 / 0.08) 55%, transparent 72%)",
      }}
    />
  );
}

/* ───────────── the hero ───────────── */

export default function ShaderShowcase() {
  const sectionRef = useRef<HTMLElement>(null);
  const reduce = usePrefersReducedMotion();
  const fine = useFinePointer();
  const webgl = useWebGL2();
  const inView = useInView(sectionRef, { amount: 0 });
  const animate = inView && !reduce;

  // Same start/end either way (hydration renders the motion-allowed branch first); reduced motion
  // just lands there without the rise.
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: motionTokens.distance.lg },
    animate: { opacity: 1, y: 0 },
    transition: reduce
      ? { duration: 0 }
      : { duration: motionTokens.duration.slow + 0.2, delay, ease: motionTokens.easing.smooth },
  });

  return (
    <>
      <HeroHeader reduce={reduce} />

      {/* Transparent: the page-wide liquid-metal background (PageBackground) shows through. */}
      <section
        id="top"
        ref={sectionRef}
        aria-labelledby="hero-title"
        className="relative flex min-h-[100svh] flex-col overflow-x-clip"
      >
        <CursorGlow active={fine && animate} />
        <FloatingChips animate={animate} reduce={reduce} />

        {/* Bottom-left content block */}
        <div className="relative z-20 container-x flex flex-1 flex-col justify-end pt-[calc(var(--nav-h)+6.5rem)] pb-28 sm:pb-16 md:pt-[calc(var(--nav-h)+3rem)] lg:pb-20">
          <div className="max-w-[60rem] text-left">
            <motion.p
              className="relative mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-white/75 px-4 py-2 text-[13px] font-medium tracking-wide text-ink-muted shadow-[0_1px_2px_rgb(15_23_42/0.05)] backdrop-blur-md sm:text-sm"
              {...rise(0.15)}
            >
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-teal-500 shadow-[0_0_0_3px_rgb(20_184_166/0.18)]"
              />
              Handwriting intelligence for learners
            </motion.p>

            <motion.h1 id="hero-title" className="mb-6 leading-none tracking-tight text-ink" {...rise(0.3)}>
              <span className="mb-2 block text-[clamp(2.1rem,4.6vw,4.1rem)] font-light tracking-[-0.01em] text-ink-muted">
                Every other app
              </span>{" "}
              <span className="block text-[clamp(2.6rem,6.3vw,5.6rem)] leading-[0.98] font-black tracking-[-0.035em] text-balance text-ink">
                deletes your mistakes.
              </span>{" "}
              <span className="mt-1 block font-display text-[clamp(2.9rem,6.6vw,6rem)] leading-[1.04] font-normal text-ink italic">
                We <LiquidMetal maskText="keep" variant="pearl" speed={0.6} className="pr-[0.06em]" /> them.
              </span>
            </motion.h1>

            <motion.p
              className="mb-9 max-w-xl text-base leading-relaxed text-pretty text-ink-muted sm:text-lg"
              {...rise(0.45)}
            >
              Inkling reads how you write during a lecture: the pauses, the erasing, the rewrites. It turns them into a
              learning timeline of mistakes you fixed, gaps you still have, and the exact lecture moment behind each
              one.
            </motion.p>

            <motion.div
              className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4"
              {...rise(0.6)}
            >
              <MetalLink href={APP_URL} className="w-full sm:w-auto">
                Open Inkling
                <ArrowUpRightIcon size={15} strokeWidth={2.2} />
              </MetalLink>
              <Magnetic>
                <a href="#demo" className="btn btn-secondary w-full min-h-12 backdrop-blur-sm sm:w-auto">
                  <PlayIcon size={13} />
                  Watch the demo
                </a>
              </Magnetic>
            </motion.div>
          </div>
        </div>

        {/* Orb: top-right under the header (the assistant launcher owns the bottom-right corner). */}
        <div className="absolute top-[calc(var(--nav-h)+1.5rem)] right-8 z-30 md:right-12">
          <PulseOrb webgl={webgl} animate={animate} />
          <span className="sr-only">Inkling: learning is in the process.</span>
        </div>
      </section>
    </>
  );
}
