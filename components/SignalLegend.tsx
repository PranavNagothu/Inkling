// "How Inkling decides you were stuck": the scoring rules behind the Signal Lab chart in plain
// language, with the live numbers from lib/scoring's SCORING_CONFIG.
import { FEATURES } from "@/lib/insights";
import { SCORING_CONFIG } from "@/lib/scoring";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function SignalLegend() {
  const c = SCORING_CONFIG;
  const steps: Array<{ title: string; body: string }> = [
    {
      title: "Learn your normal",
      body: `The first ${c.baselineMs / 60000} minutes of your own writing are your baseline. Nothing there is ever flagged — it is what the rest is compared against, so a slow writer isn't "stuck" just for being slow.`,
    },
    {
      title: "Read four signals every 10 seconds",
      body: "Each signal is scaled from 0 (like your normal) to 1 (far from it), measured against your baseline — not against other students.",
    },
    {
      title: "Blend and smooth",
      body: `The signals are blended by weight into a score, then smoothed with the previous window (${pct(c.emaAlpha)} new, ${pct(1 - c.emaAlpha)} carried over) so one odd stroke can't set it off.`,
    },
    {
      title: "Flag a spike",
      body: `A window is flagged when the smoothed score reaches ${c.spikeScore.toFixed(2)} and at least ${c.minFeaturesOn} signals are on (≥ ${c.featureOn.toFixed(2)}) at once. Flags are at least ${c.refractoryMs / 1000} s apart, and at most ${c.maxSpikes} per session.`,
    },
  ];
  return (
    <section aria-labelledby="how-heading" data-testid="signal-legend" className="flex flex-col gap-3">
      <h3 id="how-heading" className="eyebrow">
        How Inkling decides you were stuck
      </h3>
      <ol className="grid gap-2 sm:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 panel rounded-lg px-4 py-3">
            <span aria-hidden="true" className="mt-px font-mono text-sm tabular-nums text-ink-subtle">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-ink">{s.title}</span>
              <span className="text-sm text-pretty text-ink-muted">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <dl className="panel divide-y divide-line overflow-hidden">
        {FEATURES.map((f) => (
          <div key={f.key} className="grid gap-x-6 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[9rem_1fr]">
            <dt className="flex items-baseline justify-between gap-2 text-sm font-medium text-ink sm:justify-start">
              {f.label}
              <span className="font-mono text-xs tabular-nums text-ink-subtle">{pct(f.weight)}</span>
            </dt>
            <dd className="text-sm text-pretty text-ink-muted">{f.explain}</dd>
          </div>
        ))}
      </dl>
      <p className="px-1 text-xs text-pretty text-ink-subtle">
        Without a transcript the pause signal is off and its weight is shared by the others; without pen pressure the
        pressure weight is shared the same way.
      </p>
    </section>
  );
}
