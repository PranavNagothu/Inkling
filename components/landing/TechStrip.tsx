"use client";

// "Powered by" strip: text wordmarks (no third-party logos) scrolling slowly; pauses off screen,
// on hover, and never moves under reduced motion.
import { useRef } from "react";
import { useInView } from "motion/react";

const TECH = [
  { name: "Groq", role: "Fast AI re-teach" },
  { name: "Google Gemini", role: "AI provider" },
  { name: "ElevenLabs", role: "Read-aloud voices" },
  { name: "Tiger Data", role: "TimescaleDB time series" },
  { name: "Notability", role: "Compare + PDF export" },
  { name: "Whisper", role: "Lecture transcription" },
  { name: "Next.js", role: "App framework" },
  { name: "PostgreSQL", role: "Or local SQLite" },
];

function Row({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul className="flex shrink-0 items-center gap-12 pr-12" aria-hidden={hidden || undefined}>
      {TECH.map((t) => (
        <li key={t.name} className="flex items-baseline gap-2.5 whitespace-nowrap">
          <span className="text-[17px] font-semibold tracking-tight text-ink/80">{t.name}</span>
          <span className="text-[13px] text-ink-subtle">{t.role}</span>
        </li>
      ))}
    </ul>
  );
}

export function TechStrip() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0 });
  return (
    <div
      ref={ref}
      data-paused={!inView}
      className="marquee relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]"
    >
      <div className="marquee-track flex w-max">
        <Row />
        <Row hidden />
      </div>
    </div>
  );
}
