import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { DEMO_LECTURE_NOTE, aiLabel, lectureAttribution, storageLabel, voiceLabel, type VoiceInfo } from "@/lib/about";
import { aiService } from "@/lib/ai/service";
import { selectTts } from "@/lib/ai/tts";
import { getDb, type DbInfo } from "@/lib/db";
import { DEMO_SESSIONS } from "@/lib/demoScenario";
import { hotspotSourceLabel } from "@/lib/hotspots";
import { listLectures } from "@/lib/lecture";
import { ChevronRightIcon } from "@/components/icons";
import { BackLink, TopBar } from "@/components/ui";

export const metadata: Metadata = {
  title: "About this demo · Inkling",
  description: "What Inkling runs on: storage, time series, AI and voice — and where the lecture comes from.",
};

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

function Row({ label, value, testId, data, note }: { label: string; value: string; testId: string; data?: Record<string, string>; note?: string }) {
  const attrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div className="grid gap-x-6 gap-y-0.5 px-4 py-3 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm text-ink-subtle">{label}</dt>
      <dd className="min-w-0">
        <span data-testid={testId} {...attrs} className="block text-sm font-medium text-pretty text-ink">
          {value}
        </span>
        {note ? <span className="block text-xs text-pretty text-ink-subtle">{note}</span> : null}
      </dd>
    </div>
  );
}

const DEMO_PATH: Array<{ step: string; detail: string }> = [
  { step: "Session 1 review", detail: "Maya's notes with ghost ink: a breakthrough she already earned, a correction, and a gap." },
  { step: "The 01:40 correction", detail: "She wrote cos(x²), erased it, rewrote cos(x²)·2x. The AI reads the before/after: she forgot the inner derivative. Answer the check question → breakthrough." },
  { step: "The 04:10 gap", detail: "Slow, erased, never rewritten while the lecture moved on. Replay 20 s hears what she missed." },
  { step: "Compare with Notability", detail: "The exported final page next to the process it hides." },
  { step: "Progress", detail: "Session 2 wrote that part through calmly — the gap resolved itself; the class hotspots show everyone slowed there too." },
];

export default async function AboutPage() {
  await connection();
  const db = getDb();
  let info: DbInfo | null = null;
  try {
    info = await db.info();
  } catch (err) {
    console.error(`[inkling] about: database unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ai = aiService(await headers()).status();
  const { tts } = selectTts(process.env);
  const voice: VoiceInfo = tts ? (tts.kind === "elevenlabs" ? { kind: "elevenlabs", model: tts.model } : { kind: "openai", model: tts.model, voice: tts.voice }) : null;
  const [lectures, seeded] = await Promise.all([
    listLectures().catch(() => []),
    db.getSession(DEMO_SESSIONS.s1.id).catch(() => null),
  ]);
  const demoMode = truthy(process.env.DEMO_MODE);

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="About toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="truncate text-base font-semibold text-ink">About this demo</h1>
        </div>
      </TopBar>
      <main data-testid="about-page" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
        <header className="flex flex-col gap-2">
          <h2 className="font-display text-[2rem] leading-tight tracking-tight text-balance text-ink">Every other app deletes your mistakes.</h2>
          <p className="max-w-xl text-pretty text-ink-muted">
            Inkling keeps erased handwriting as ghost ink, notices where you hesitated, pairs each erase with its
            correction, and links it to the moment in the lecture — so you can see what you learned, not just what you
            ended up with.
          </p>
        </header>

        <section aria-labelledby="system-heading" className="flex flex-col gap-3">
          <h3 id="system-heading" className="px-1 text-sm font-semibold text-ink">
            System
          </h3>
          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-chrome shadow-hairline">
            <Row
              label="Storage"
              value={info ? storageLabel(info) : "Unavailable — check the server log"}
              testId="about-backend"
              data={{ backend: info?.backend ?? "unknown", timescale: String(info?.timescale ?? false) }}
            />
            <Row
              label="Class hotspots"
              value={info ? hotspotSourceLabel(info) : "—"}
              testId="about-hotspots"
              note="“Where the class slowed down” on Progress: erasing per 30 s over every session of a lecture."
            />
            <Row label="AI re-teach" value={aiLabel(ai)} testId="about-ai" data={{ mode: ai.mode }} note="Help cards, check questions, before/after readings, concept names." />
            <Row label="Read aloud" value={voiceLabel(voice, { demoMode })} testId="about-voice" data={{ kind: voice?.kind ?? "browser" }} />
            <Row
              label="Mode"
              value={demoMode ? "DEMO_MODE — offline: no network requests" : "Standard"}
              testId="about-mode"
              data={{ demo: String(demoMode) }}
            />
          </dl>
        </section>

        <section aria-labelledby="lectures-heading" className="flex flex-col gap-3">
          <h3 id="lectures-heading" className="px-1 text-sm font-semibold text-ink">
            Lectures
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-chrome shadow-hairline">
            {lectures.map((l) => {
              const credit = lectureAttribution(l);
              return (
                <li key={l.id} className="flex flex-col gap-0.5 px-4 py-3">
                  <span className="text-sm font-medium text-ink">{l.title}</span>
                  <span data-testid="about-attribution" data-kind={credit.kind} className="text-xs text-pretty text-ink-subtle">
                    {credit.text ?? "Uploaded on this device."}
                  </span>
                </li>
              );
            })}
          </ul>
          {lectures.some((l) => lectureAttribution(l).kind === "demo") ? null : (
            <p className="px-1 text-xs text-pretty text-ink-subtle">{DEMO_LECTURE_NOTE}</p>
          )}
        </section>

        <section aria-labelledby="path-heading" className="flex flex-col gap-3">
          <h3 id="path-heading" className="px-1 text-sm font-semibold text-ink">
            The two-minute demo
          </h3>
          <ol className="flex flex-col gap-2">
            {DEMO_PATH.map((p, i) => (
              <li key={p.step} className="flex gap-3 rounded-lg border border-line bg-chrome px-4 py-3 shadow-hairline">
                <span aria-hidden="true" className="mt-px font-mono text-sm tabular-nums text-ink-subtle">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-ink">{p.step}</span>
                  <span className="text-sm text-pretty text-ink-muted">{p.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          {seeded ? (
            <Link
              href={`/review/${DEMO_SESSIONS.s1.id}`}
              data-testid="about-start-demo"
              className="press inline-flex min-h-11 items-center gap-1 self-start rounded-pill px-3 text-sm font-semibold text-accent hover:bg-accent-soft"
            >
              Start with Maya — Session 1
              <ChevronRightIcon size={16} />
            </Link>
          ) : (
            <p className="px-1 text-sm text-ink-muted">
              Run <code className="rounded-sm bg-chrome-press px-1 font-mono text-xs">npm run seed:demo</code> to add Maya&apos;s sessions.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
