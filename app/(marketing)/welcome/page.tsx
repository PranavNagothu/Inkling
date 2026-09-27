import type { ComponentType, ReactNode, SVGProps } from "react";
import { AskLauncher } from "@/components/landing/assistant/AskLauncher";
import { DemoVideo } from "@/components/landing/DemoVideo";
import { Faq } from "@/components/landing/Faq";
import { Highlight } from "@/components/motion/Highlight";
import { Features } from "@/components/landing/Features";
import { MetalFrame } from "@/components/landing/MetalFrame";
import { MetalLink } from "@/components/landing/MetalButton";
import { Reveal, Stagger, StaggerItem } from "@/components/landing/Reveal";
import { StoryTimeline } from "@/components/landing/StoryTimeline";
import { TechStrip } from "@/components/landing/TechStrip";
import { TryIt } from "@/components/landing/TryIt";
import { APP_URL, GITHUB_URL, NAV_LINKS, demoUrl } from "@/components/landing/site";
import ShaderShowcase from "@/components/landing/ui/hero";
import { LiquidMetal } from "@/components/landing/ui/liquid-metal";
import {
  ArrowUpRightIcon,
  HardDriveIcon,
  InklingMark,
  KeyIcon,
  PlayIcon,
  ShieldIcon,
  StudentIcon,
  TeacherIcon,
  WifiOffIcon,
} from "@/components/landing/icons";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const AUDIENCES: { id: string; title: string; icon: Icon; lead: string; points: string[] }[] = [
  {
    id: "students",
    title: "For students",
    icon: StudentIcon,
    lead: "For anyone who has nodded along, then realized three slides later they were lost.",
    points: [
      "Help arrives at the exact second you slowed down, not at the end of the unit",
      "Your pace is the baseline, so learning differences aren't flagged as problems",
      "Studying in a second language? Explanations come in yours, read aloud if you like",
      "Open gaps follow you into the next session until they're resolved",
    ],
  },
  {
    id: "teachers",
    title: "For teachers",
    icon: TeacherIcon,
    lead: "See the lecture the way your students experienced it, not only how they scored.",
    points: [
      "The minutes where the class slowed down or started erasing, in 30-second steps",
      "The three stretches most worth re-teaching, with what you were saying at the time",
      "Anonymous aggregates only: no names, no handwriting, never fewer than three students",
      "On Tiger Data, class hotspots come straight from a TimescaleDB continuous aggregate",
    ],
  },
];

const PRIVACY: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Local-first by default",
    body: "Sessions live in a SQLite file on the machine running Inkling, or in a Postgres database you choose, such as Tiger Data.",
    icon: HardDriveIcon,
  },
  {
    title: "Anonymous class view",
    body: "Teachers see patterns, never people: no names, ids or handwriting, and nothing shared by fewer than three students.",
    icon: ShieldIcon,
  },
  {
    title: "Only what a moment needs",
    body: "AI help receives the lecture excerpt and the before and after of one revision. Provider keys stay on the server and are never logged.",
    icon: KeyIcon,
  },
  {
    title: "Works fully offline",
    body: "Demo mode runs from saved, hand-checked answers with no network at all, ideal for a classroom with unreliable Wi-Fi.",
    icon: WifiOffIcon,
  },
];

function SectionHeader({
  id,
  eyebrow,
  title,
  lead,
  center = false,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  lead?: string;
  center?: boolean;
}) {
  return (
    <Reveal className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <p className="eyebrow">{eyebrow}</p>
      <h2
        id={id}
        className="mt-4 text-[2.25rem] leading-[1.08] font-extrabold tracking-[-0.035em] text-balance text-ink sm:text-[3rem]"
      >
        {title}
      </h2>
      {lead && <p className="mt-4 text-[17px] leading-relaxed text-pretty text-ink-muted">{lead}</p>}
    </Reveal>
  );
}

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-[70] rounded-full bg-ink px-4 py-3 text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <ShaderShowcase />

      <main id="main">
        {/* ───────────── Tech strip ───────────── */}
        <section aria-label="Built with" className="relative py-6">
          <div className="container-x">
            <div className="panel px-4 py-6 sm:px-8">
              <p className="mb-5 text-center text-[13px] font-medium tracking-wide text-ink-subtle">
                Built on a modern AI and data stack
              </p>
              <TechStrip />
            </div>
          </div>
        </section>

        {/* ───────────── Demo video ───────────── */}
        <section id="demo" aria-labelledby="demo-title" className="relative">
          <div className="container-x section-y">
            <SectionHeader
              id="demo-title"
              eyebrow="Demo · 2:59"
              title={<>See it in <Highlight>three minutes</Highlight></>}
              lead="A student takes notes on a chain-rule lecture, gets one step wrong, fixes it, and Inkling shows what the final page would have hidden."
              center
            />
            <Reveal className="mx-auto mt-12 max-w-[1000px]">
              <MetalFrame
                variant="pearl"
                ringRadius="rounded-[1.5rem]"
                className="rounded-[1.5rem] shadow-page"
                innerClassName="rounded-[calc(1.5rem-1px)] p-1.5 sm:p-2"
              >
                <div className="overflow-hidden rounded-[1.1rem]">
                  <DemoVideo />
                </div>
              </MetalFrame>
              {/* CC BY-NC-SA requires crediting the lecture footage next to the video. */}
              <p className="mt-3 text-center text-[12.5px] text-ink-subtle">
                Lecture clip:{" "}
                <a
                  href="https://ocw.mit.edu/courses/18-01-single-variable-calculus-fall-2006/"
                  className="underline decoration-ink/20 underline-offset-4 hover:text-ink"
                  rel="noopener"
                >
                  MIT OpenCourseWare 18.01
                </a>
                , CC BY-NC-SA
              </p>
            </Reveal>
          </div>
        </section>

        {/* ───────────── Try it ───────────── */}
        <section id="try" aria-labelledby="try-title" className="relative">
          <div className="container-x section-y">
            <SectionHeader
              id="try-title"
              eyebrow="Try it"
              title={<>Make a mistake. <Highlight>Watch it stay.</Highlight></>}
              lead="Write, erase, and rewrite in the same spot. This is the core idea behind Inkling, running right here in your browser."
            />
            <Reveal className="mt-12">
              <TryIt />
            </Reveal>
          </div>
        </section>

        {/* ───────────── How it works (scroll story) ───────────── */}
        <section id="how" aria-labelledby="how-title" className="relative">
          <div className="container-x pt-20 sm:pt-28">
            <SectionHeader
              id="how-title"
              eyebrow="How it works"
              title={<>Your mistakes are <Highlight>data</Highlight>. Inkling reads them.</>}
              lead="Four steps, running quietly while you take notes the way you already do."
            />
          </div>
          <div className="container-x pb-12 sm:pb-20">
            <StoryTimeline demoHref={demoUrl()} />
          </div>
        </section>

        {/* ───────────── Features ───────────── */}
        <section id="features" aria-labelledby="features-title" className="relative">
          <div className="container-x section-y">
            <SectionHeader
              id="features-title"
              eyebrow="Features"
              title={<>Everything the final page <Highlight>forgets</Highlight></>}
              lead="Built around one idea: getting something wrong, then right, is where the learning happens."
            />
            <div className="mt-12">
              <Features />
            </div>
          </div>
        </section>

        {/* ───────────── Students / teachers ───────────── */}
        <section id="audiences" aria-labelledby="audiences-title" className="relative">
          <div className="container-x section-y">
            <SectionHeader id="audiences-title" eyebrow="Who it's for" title={<>For <Highlight>both sides</Highlight> of the lecture</>} />
            <Stagger className="mt-12 grid gap-5 md:grid-cols-2">
              {AUDIENCES.map(({ id, title, icon: I, lead, points }) => (
                <StaggerItem key={id} as="article" className="h-full">
                  <MetalFrame className="h-full" innerClassName="p-6 sm:p-8">
                    <div id={id} className="flex items-center gap-3">
                      <span className="inline-flex size-11 items-center justify-center rounded-xl border border-teal-600/15 bg-accent-soft text-accent-strong">
                        <I size={20} />
                      </span>
                      <h3 className="text-2xl font-semibold tracking-tight text-ink">{title}</h3>
                    </div>
                    <p className="mt-5 text-[16.5px] leading-relaxed text-pretty text-ink">{lead}</p>
                    <ul className="mt-5 space-y-3 border-t border-line pt-5">
                      {points.map((p) => (
                        <li key={p} className="flex gap-3 text-[15.5px] leading-relaxed text-pretty text-ink-muted">
                          <span aria-hidden="true" className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-teal-500" />
                          {p}
                        </li>
                      ))}
                    </ul>
                  </MetalFrame>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </section>

        {/* ───────────── Privacy ───────────── */}
        <section id="privacy" aria-labelledby="privacy-title" className="relative">
          <div className="container-x section-y">
            <SectionHeader
              id="privacy-title"
              eyebrow="Privacy"
              title={<>Your notes are <Highlight>yours</Highlight></>}
              lead="Inkling looks closely at how you learn, so it's built to keep that close too."
            />
            <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {PRIVACY.map(({ title, body, icon: I }) => (
                <StaggerItem key={title} as="article" className="card h-full p-6">
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-ink text-white">
                    <I size={19} />
                  </span>
                  <h3 className="mt-5 text-[17px] font-semibold tracking-tight text-ink">{title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-pretty text-ink-muted">{body}</p>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </section>

        {/* ───────────── FAQ ───────────── */}
        <section id="faq" aria-labelledby="faq-title" className="relative">
          <div className="container-x section-y">
            <SectionHeader id="faq-title" eyebrow="FAQ" title={<>Questions, <Highlight>answered</Highlight></>} />
            <div className="mt-12">
              <Faq />
            </div>
          </div>
        </section>

        {/* ───────────── Final CTA ───────────── */}
        <section aria-labelledby="cta-title" className="relative px-4 pb-16 sm:px-8 sm:pb-24">
          <MetalFrame
            variant="pearl"
            ringRadius="rounded-[2rem]"
            className="mx-auto max-w-[1200px] rounded-[2rem] shadow-page"
            innerClassName="rounded-[calc(2rem-1px)] bg-white/55 md:bg-white/45 md:backdrop-blur-md"
          >
            <div className="relative px-6 py-20 text-center sm:py-28">
              <Reveal>
                <InklingMark size={44} className="mx-auto" />
                <h2
                  id="cta-title"
                  className="mt-6 text-[2.6rem] leading-[1.04] font-extrabold tracking-[-0.04em] text-balance text-ink sm:text-[4rem]"
                >
                  <Highlight>Learning</Highlight> is in the{" "}
                  <span className="font-display font-normal italic">
                    <LiquidMetal maskText="process." variant="pearl" speed={0.5} />
                  </span>
                </h2>
                <p className="mx-auto mt-5 max-w-lg text-[17px] text-balance text-ink-muted">
                  Take notes the way you already do. Inkling keeps the part other apps throw away.
                </p>
                <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                  <MetalLink href={APP_URL} className="w-full sm:w-auto">
                    Open Inkling
                    <ArrowUpRightIcon size={15} strokeWidth={2.2} />
                  </MetalLink>
                  <a href="#demo" className="btn btn-secondary">
                    <PlayIcon size={13} />
                    Watch the demo
                  </a>
                </div>
              </Reveal>
            </div>
          </MetalFrame>
        </section>
      </main>

      {/* ───────────── Footer ───────────── */}
      <footer className="relative pb-6">
        <div className="container-x">
          <div className="panel grid gap-10 px-6 py-12 sm:px-10 md:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,0.7fr))]">
            <div>
              <div className="flex items-center gap-2 font-display text-2xl leading-none text-ink">
                <InklingMark size={22} className="-mt-1" />
                Inkling
              </div>
              <p className="mt-4 max-w-xs text-[14.5px] leading-relaxed text-ink-muted">
                Handwriting intelligence for learners. Every other app deletes your mistakes. We keep them.
              </p>
            </div>
            <nav aria-label="Footer: product">
              <h2 className="text-[13px] font-semibold tracking-wide text-ink uppercase">Product</h2>
              <ul className="mt-3 space-y-1">
                {NAV_LINKS.map((l) => (
                  <li key={l.href}>
                    <a
                      href={l.href}
                      className="inline-flex min-h-9 items-center text-[14.5px] text-ink-muted hover:text-ink"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Footer: resources">
              <h2 className="text-[13px] font-semibold tracking-wide text-ink uppercase">Resources</h2>
              <ul className="mt-3 space-y-1">
                <li>
                  <a
                    href="#demo"
                    className="inline-flex min-h-9 items-center text-[14.5px] text-ink-muted hover:text-ink"
                  >
                    Demo video
                  </a>
                </li>
                <li>
                  <a
                    href={APP_URL}
                    className="inline-flex min-h-9 items-center text-[14.5px] text-ink-muted hover:text-ink"
                  >
                    Open the app
                  </a>
                </li>
                <li>
                  <a
                    href={GITHUB_URL}
                    rel="noopener"
                    className="inline-flex min-h-9 items-center gap-1 text-[14.5px] text-ink-muted hover:text-ink"
                  >
                    Source on GitHub
                    <ArrowUpRightIcon size={13} />
                  </a>
                </li>
              </ul>
            </nav>
          </div>
          <p className="px-2 py-6 text-[13px] text-ink-subtle">© 2026 Inkling</p>
        </div>
      </footer>

      <AskLauncher />
    </>
  );
}
