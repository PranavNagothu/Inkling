import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import EvaluationSweep from "@/components/EvaluationSweep";
import { ConfusionTable, DetectorCards, LabelTable } from "@/components/EvaluationSummary";
import { ChevronRightIcon } from "@/components/icons";
import { BackLink, Mark, PageHeader, TopBar, btnLink } from "@/components/ui";
import { loadEvaluation } from "./load";

export const metadata: Metadata = {
  title: "Model evaluation · Inkling",
  description: "Precision and recall of Inkling's hesitation detector against hand labels, with a threshold sensitivity sweep.",
};

export default async function EvaluationPage() {
  await connection();
  const { groundTruth, report } = await loadEvaluation();
  const stored = report.cases.every((c) => c.source === "stored");
  const firstLabeled = report.cases.find((c) => c.labels.length > 0);

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar label="Model evaluation toolbar">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <BackLink />
          <h1 className="truncate text-base font-bold tracking-tight text-ink">Model evaluation</h1>
        </div>
      </TopBar>

      <main
        data-testid="evaluation"
        data-label-count={report.labelCount}
        data-source={stored ? "stored" : "scenario"}
        className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-4 pt-8 pb-16 sm:px-8 sm:pt-12"
      >
        <PageHeader
          eyebrow="Model evaluation"
          title={
            <>
              Does it flag the right <Mark>moments?</Mark>
            </>
          }
        >
          <p className="max-w-2xl text-[16.5px] leading-relaxed text-pretty text-ink-muted">
            Inkling&apos;s flags scored against hand labels of where the student was confused. A flag counts when it lands
            within ±{groundTruth.toleranceMs / 1000} s of a label; each label matches at most one flag (nearest first).
          </p>
          <p
            data-testid="evaluation-caveat"
            className="max-w-2xl rounded-md border border-gap/30 bg-gap-soft px-3.5 py-2.5 text-sm text-pretty text-gap-strong"
          >
            <strong className="font-semibold">Small labeled demo set</strong> — {report.sessionCount} sessions,{" "}
            {report.labelCount} labels. A sanity check that the pipeline does what it claims, not a benchmark.
          </p>
        </PageHeader>

        <section aria-labelledby="detectors-heading" className="flex flex-col gap-3">
          <h3 id="detectors-heading" className="eyebrow">
            At the shipped threshold ({report.spikeScore.toFixed(2)})
          </h3>
          <DetectorCards report={report} />
          <ConfusionTable report={report} />
        </section>

        <section aria-labelledby="labels-heading" className="flex flex-col gap-3">
          <h3 id="labels-heading" className="eyebrow">
            Label by label
          </h3>
          <LabelTable report={report} />
          <p className="px-1 text-sm text-pretty text-ink-muted">
            Spikes can&apos;t fire while Inkling is still learning a student&apos;s normal (the first two minutes of
            their writing), so confusion that early is caught only by pairing an erase with its rewrite. That is why the
            full pipeline is the number students actually experience.
          </p>
        </section>

        <section aria-labelledby="sweep-heading" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <h3 id="sweep-heading" className="eyebrow">
              Sensitivity: moving the spike threshold
            </h3>
            <p className="text-sm text-pretty text-ink-muted">
              Every point re-runs the scoring model on the same ink and transcript with a different spikeScore. A spike
              also needs two signals on at once, so lowering the threshold alone adds few flags.
            </p>
          </div>
          <EvaluationSweep sweep={report.sweep} shipped={report.spikeScore} />
        </section>

        <section aria-labelledby="data-heading" className="flex flex-col gap-2">
          <h3 id="data-heading" className="eyebrow">
            About the labels
          </h3>
          <p data-testid="evaluation-note" className="px-1 text-sm text-pretty text-ink-muted">
            {groundTruth.note}
          </p>
          <p className="px-1 text-xs text-pretty text-ink-subtle">
            Ink:{" "}
            {stored
              ? "the seeded sessions as stored in the database."
              : "rebuilt from lib/demoScenario — the same ink `npm run seed:demo` stores (the demo isn't seeded here)."}{" "}
            Labels: public/demo/ground-truth.json · also served as JSON at{" "}
            <a href="/api/evaluation" className="font-mono text-accent underline-offset-2 hover:underline">
              /api/evaluation
            </a>
            .
          </p>
          {firstLabeled && firstLabeled.source === "stored" ? (
            <Link
              href={`/insights/${encodeURIComponent(firstLabeled.sessionId)}`}
              data-testid="evaluation-signal-link"
              className={`${btnLink} self-start`}
            >
              See the signals for {firstLabeled.title}
              <ChevronRightIcon size={16} />
            </Link>
          ) : null}
        </section>
      </main>
    </div>
  );
}
