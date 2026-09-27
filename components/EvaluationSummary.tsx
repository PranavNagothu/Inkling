// Model evaluation tables: headline precision / recall / F1 for each detector, the TP/FP/FN
// counts, and every label with what matched it (or why nothing did). Server component.
import type { ReactNode } from "react";
import type { CaseResult, EvaluationReport, Metrics } from "@/lib/evaluation";
import { MOMENT_META } from "@/lib/moments";
import { formatClock } from "@/lib/time";

const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const signedS = (ms: number) => `${ms > 0 ? "+" : ms < 0 ? "−" : "±"}${Math.abs(Math.round(ms / 100) / 10)} s`;

export const DETECTORS: Array<{ key: "spikes" | "moments"; title: string; blurb: string }> = [
  {
    key: "spikes",
    title: "Hesitation spikes",
    blurb: "The scoring model alone: 10 s windows whose smoothed score crossed the threshold.",
  },
  {
    key: "moments",
    title: "Full pipeline (moments)",
    blurb: "What the student sees: spikes plus erase → rewrite corrections paired from the ink.",
  },
];

function MetricTile({ label, value, testId }: { label: string; value: number | null; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd data-testid={testId} data-value={value === null ? "" : value.toFixed(4)} className="text-2xl font-semibold text-ink">
        {fmt(value)}
      </dd>
    </div>
  );
}

export function DetectorCards({ report }: { report: EvaluationReport }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {DETECTORS.map((d) => {
        const m: Metrics = report[d.key];
        return (
          <section
            key={d.key}
            data-testid={`evaluation-detector-${d.key}`}
            aria-labelledby={`det-${d.key}`}
            className="flex flex-col gap-3 panel px-4 py-4"
          >
            <div className="flex flex-col gap-0.5">
              <h4 id={`det-${d.key}`} className="text-sm font-semibold text-ink">
                {d.title}
              </h4>
              <p className="text-xs text-pretty text-ink-muted">{d.blurb}</p>
            </div>
            <dl className="grid grid-cols-3 gap-2">
              <MetricTile label="Precision" value={m.precision} testId={`metric-${d.key}-precision`} />
              <MetricTile label="Recall" value={m.recall} testId={`metric-${d.key}-recall`} />
              <MetricTile label="F1" value={m.f1} testId={`metric-${d.key}-f1`} />
            </dl>
          </section>
        );
      })}
    </div>
  );
}

export function ConfusionTable({ report }: { report: EvaluationReport }) {
  return (
    <div className="overflow-x-auto panel">
      <table data-testid="evaluation-confusion" className="w-full text-left text-sm">
        <caption className="sr-only">True positives, false positives and missed labels per detector</caption>
        <thead className="border-b border-line text-xs text-ink-subtle">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Detector
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              <abbr title="True positives: a flag within the tolerance of a label">TP</abbr>
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              <abbr title="False positives: a flag with no label nearby">FP</abbr>
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              <abbr title="False negatives: a label nothing flagged">FN</abbr>
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Precision
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Recall
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              F1
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line font-mono tabular-nums">
          {DETECTORS.map((d) => {
            const m = report[d.key];
            return (
              <tr key={d.key} data-testid="confusion-row" data-detector={d.key}>
                <th scope="row" className="px-4 py-2.5 font-sans font-medium text-ink">
                  {d.title}
                </th>
                <td className="px-3 py-2.5 text-right text-ink" data-testid="confusion-tp">
                  {m.tp}
                </td>
                <td className="px-3 py-2.5 text-right text-ink" data-testid="confusion-fp">
                  {m.fp}
                </td>
                <td className="px-3 py-2.5 text-right text-ink" data-testid="confusion-fn">
                  {m.fn}
                </td>
                <td className="px-3 py-2.5 text-right text-ink-muted">{fmt(m.precision)}</td>
                <td className="px-3 py-2.5 text-right text-ink-muted">{fmt(m.recall)}</td>
                <td className="px-4 py-2.5 text-right text-ink-muted">{fmt(m.f1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function inBaseline(c: CaseResult, ms: number) {
  return c.baseline.some((z) => ms >= z.startMs && ms < z.endMs);
}

function Outcome({ kind, children }: { kind: "tp" | "fn" | "fp"; children: ReactNode }) {
  const cls =
    kind === "tp" ? "bg-ok-soft text-ok-strong" : kind === "fn" ? "bg-corrected-soft text-corrected-strong" : "bg-gap-soft text-gap-strong";
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className={`rounded-pill px-1.5 py-px font-sans text-[11px] font-semibold ${cls}`}>{kind.toUpperCase()}</span>
      <span className="text-ink-muted">{children}</span>
    </span>
  );
}

export function LabelTable({ report }: { report: EvaluationReport }) {
  const rows = report.cases.flatMap((c) =>
    c.labels.map((label, i) => ({
      c,
      label,
      spike: c.spikes.matches.find((m) => m.labelIndex === i),
      moment: c.moments.matches.find((m) => m.labelIndex === i),
    })),
  );
  const falsePositives = report.cases.flatMap((c) => [
    ...c.spikes.falsePositives.map((f) => ({ c, detector: "Spike", atMs: f.detection.atMs })),
    ...c.moments.falsePositives.map((f) => ({ c, detector: "Moment", atMs: f.detection.atMs })),
  ]);
  const unlabeled = report.cases.filter((c) => c.labels.length === 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto panel">
        <table data-testid="evaluation-labels" className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Each ground-truth label and the detection matched to it</caption>
          <thead className="border-b border-line text-xs text-ink-subtle">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Label
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Hesitation spike
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Moment
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ c, label, spike, moment }) => (
              <tr key={`${c.sessionId}-${label.atMs}`} data-testid="label-row" data-at-ms={label.atMs} data-spike={spike ? "tp" : "fn"} data-moment={moment ? "tp" : "fn"}>
                <th scope="row" className="px-4 py-2.5 align-top font-normal">
                  <span className="block font-mono text-ink tabular-nums">{formatClock(label.atMs)}</span>
                  <span className="block text-xs text-pretty text-ink-muted">{label.text}</span>
                  <span className="block text-xs text-ink-subtle">{c.title}</span>
                </th>
                <td className="px-3 py-2.5 align-top font-mono text-xs tabular-nums">
                  {spike ? (
                    <Outcome kind="tp">
                      {formatClock(spike.detection.atMs)} ({signedS(spike.deltaMs)})
                    </Outcome>
                  ) : (
                    <Outcome kind="fn">
                      <span className="font-sans">{inBaseline(c, label.atMs) ? "inside the baseline — never flagged by design" : "missed"}</span>
                    </Outcome>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top font-mono text-xs tabular-nums">
                  {moment ? (
                    <Outcome kind="tp">
                      {formatClock(moment.detection.atMs)} ({signedS(moment.deltaMs)}){" "}
                      <span className="font-sans">
                        {moment.detection.ref && c.momentTypes[moment.detection.ref] ? MOMENT_META[c.momentTypes[moment.detection.ref]].legend.toLowerCase() : ""}
                      </span>
                    </Outcome>
                  ) : (
                    <Outcome kind="fn">
                      <span className="font-sans">missed</span>
                    </Outcome>
                  )}
                </td>
              </tr>
            ))}
            {falsePositives.map((f) => (
              <tr key={`fp-${f.c.sessionId}-${f.detector}-${f.atMs}`} data-testid="fp-row">
                <th scope="row" className="px-4 py-2.5 align-top font-normal">
                  <span className="block text-ink-muted">No label</span>
                  <span className="block text-xs text-ink-subtle">{f.c.title}</span>
                </th>
                <td colSpan={2} className="px-3 py-2.5 align-top font-mono text-xs tabular-nums">
                  <Outcome kind="fp">
                    {f.detector} at {formatClock(f.atMs)}
                  </Outcome>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unlabeled.length ? (
        <p className="px-1 text-xs text-pretty text-ink-subtle">
          {unlabeled.map((c) => c.title).join(", ")}: no labels (calm notes) — any flag there would be a false positive
          {falsePositives.some((f) => unlabeled.includes(f.c)) ? "." : "; none were raised."}
        </p>
      ) : null}
    </div>
  );
}
