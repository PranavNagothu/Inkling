"use client";

// Sensitivity sweep: precision and recall of hesitation spikes as the spike threshold (spikeScore)
// moves from 0.35 to 0.8, recomputed by scoreSession at each step (lib/evaluation). One y-scale
// (both are 0..1); precision is undefined where nothing was flagged, so its line breaks there.
import { useId, useState, type KeyboardEvent } from "react";
import type { SweepPoint } from "@/lib/evaluation";
import { useWidth } from "./SignalChart";

// Against the white chrome surface: both ≥ 4.5:1, opposite hues (teal vs amber) that stay apart
// under protan/deutan simulation. Precision is the teal accent; recall is the amber of the gap
// marker. Markers differ in shape too, so colour is never the only cue.
const SERIES = [
  { key: "precision", label: "Precision", color: "#0f766e", shape: "circle" },
  { key: "recall", label: "Recall", color: "#b45309", shape: "square" },
] as const;

const M = { top: 28, right: 28, bottom: 34, left: 44 };
const PLOT_H = 200;

const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(2));

function Mark({ shape, x, y, color }: { shape: "circle" | "square"; x: number; y: number; color: string }) {
  return shape === "circle" ? (
    <circle cx={x} cy={y} r={4.5} fill={color} strokeWidth={2} className="stroke-chrome" />
  ) : (
    <rect x={x - 4.5} y={y - 4.5} width={9} height={9} rx={1.5} fill={color} strokeWidth={2} className="stroke-chrome" />
  );
}

export default function EvaluationSweep({ sweep, shipped }: { sweep: SweepPoint[]; shipped: number }) {
  const [ref, width] = useWidth(720);
  const [active, setActive] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const liveId = useId();

  const plotW = Math.max(160, width - M.left - M.right);
  const height = M.top + PLOT_H + M.bottom;
  const lo = sweep[0]?.spikeScore ?? 0;
  const hi = sweep[sweep.length - 1]?.spikeScore ?? 1;
  const x = (t: number) => M.left + (hi > lo ? ((t - lo) / (hi - lo)) * plotW : plotW / 2);
  const y = (v: number) => M.top + (1 - v) * PLOT_H;
  const colW = sweep.length > 1 ? plotW / (sweep.length - 1) : plotW;

  const segments = (key: "precision" | "recall") => {
    const out: string[] = [];
    let cur: string[] = [];
    for (const p of sweep) {
      const v = p[key];
      if (v === null) {
        if (cur.length) out.push(cur.join(" "));
        cur = [];
      } else cur.push(`${x(p.spikeScore).toFixed(1)},${y(v).toFixed(1)}`);
    }
    if (cur.length) out.push(cur.join(" "));
    return out;
  };

  // Direct labels ride the first point of each line (where the lines start apart); dropped when
  // they would collide — the legend below always carries identity.
  const lineLabels = SERIES.map((s) => {
    const first = sweep.find((p) => p[s.key] !== null);
    return first ? { ...s, x: x(first.spikeScore) + 6, y: y(first[s.key]!) - 8 } : null;
  }).filter((l): l is NonNullable<typeof l> => l !== null);
  const labelsCollide = lineLabels.length === 2 && Math.abs(lineLabels[0].y - lineLabels[1].y) < 16;

  const activePoint = active !== null ? sweep[active] : null;
  const describe = (p: SweepPoint) =>
    `Threshold ${p.spikeScore.toFixed(2)}${p.spikeScore === shipped ? " (shipped)" : ""}: precision ${fmt(p.precision)}, recall ${fmt(p.recall)}, F1 ${fmt(p.f1)}; ${p.tp} true positives, ${p.fp} false positives, ${p.fn} missed.`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!sweep.length) return;
    const cur = active ?? -1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(sweep.length - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur < 0 ? 0 : cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = sweep.length - 1;
    if (next !== null) {
      e.preventDefault();
      setKeyboard(true);
      setActive(next);
    }
  };

  const tipW = 220;
  const tipX = activePoint ? x(activePoint.spikeScore) : 0;
  const tipLeft = tipX + 14 + tipW > width ? Math.max(4, tipX - 14 - tipW) : tipX + 14;
  const summary = `Precision and recall of hesitation spikes as the spike threshold goes from ${lo.toFixed(2)} to ${hi.toFixed(2)}. ${
    sweep.find((p) => p.spikeScore === shipped) ? describe(sweep.find((p) => p.spikeScore === shipped)!) : ""
  }`;

  return (
    <figure data-testid="evaluation-sweep" className="flex flex-col gap-3">
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${summary} Use the left and right arrow keys to step through thresholds.`}
        aria-describedby={liveId}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setKeyboard(false);
          setActive(null);
        }}
        className="relative panel outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          className="block max-w-full select-none"
          onPointerLeave={() => !keyboard && setActive(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} strokeWidth={1} className="stroke-line" />
              <text x={M.left - 8} y={y(v) + 3.5} textAnchor="end" className="fill-ink-subtle font-mono text-[10px] tabular-nums">
                {v.toFixed(2)}
              </text>
            </g>
          ))}

          {/* The threshold the app ships with. */}
          <line x1={x(shipped)} x2={x(shipped)} y1={M.top - 6} y2={M.top + PLOT_H} strokeWidth={1} className="stroke-ink/35" />
          <text x={x(shipped)} y={M.top - 10} textAnchor="middle" className="fill-ink-muted text-[10.5px] font-medium">
            shipped {shipped.toFixed(2)}
          </text>

          {activePoint ? (
            <rect x={x(activePoint.spikeScore) - colW / 2} y={M.top} width={colW} height={PLOT_H} className="fill-ink/[0.05]" />
          ) : null}

          {SERIES.map((s) =>
            segments(s.key).map((pts) => (
              <polyline key={`${s.key}-${pts}`} points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            )),
          )}
          {SERIES.map((s) =>
            sweep.map((p) => {
              const v = p[s.key];
              return v === null ? null : <Mark key={`${s.key}-${p.spikeScore}`} shape={s.shape} x={x(p.spikeScore)} y={y(v)} color={s.color} />;
            }),
          )}

          {!labelsCollide
            ? lineLabels.map((l) => (
                <text key={l.key} x={l.x} y={Math.max(12, l.y)} className="fill-ink-muted text-[11px] font-medium">
                  {l.label}
                </text>
              ))
            : null}

          {sweep.map((p) => (
            <text key={p.spikeScore} x={x(p.spikeScore)} y={M.top + PLOT_H + 16} textAnchor="middle" className="fill-ink-subtle font-mono text-[10px] tabular-nums">
              {p.spikeScore.toFixed(2)}
            </text>
          ))}
          <text x={M.left + plotW / 2} y={height - 2} textAnchor="middle" className="fill-ink-muted text-[10.5px]">
            Spike threshold (spikeScore)
          </text>

          {/* Hit columns: the whole column around each threshold. */}
          {sweep.map((p, i) => (
            <rect
              key={`hit-${p.spikeScore}`}
              data-testid="sweep-column"
              data-threshold={p.spikeScore}
              x={x(p.spikeScore) - colW / 2}
              y={M.top}
              width={colW}
              height={PLOT_H}
              fill="transparent"
              onPointerEnter={() => {
                setKeyboard(false);
                setActive(i);
              }}
            />
          ))}
        </svg>

        {activePoint ? (
          <div
            data-testid="sweep-tooltip"
            aria-hidden="true"
            className="pointer-events-none absolute top-6 z-10 flex flex-col gap-1.5 rounded-md border border-line bg-chrome/95 px-3 py-2.5 text-xs shadow-page backdrop-blur-sm"
            style={{ left: tipLeft, width: tipW }}
          >
            <span className="font-mono tabular-nums text-ink-muted">
              threshold {activePoint.spikeScore.toFixed(2)}
              {activePoint.spikeScore === shipped ? " · shipped" : ""}
            </span>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
              {SERIES.map((s) => (
                <div key={s.key} className="contents">
                  <dt className="flex items-center gap-1.5 text-ink-muted">
                    <span aria-hidden="true" className="h-0.5 w-2.5 rounded-pill" style={{ background: s.color }} />
                    {s.label}
                  </dt>
                  <dd className="text-right font-mono font-semibold tabular-nums text-ink">{fmt(activePoint[s.key])}</dd>
                </div>
              ))}
              <div className="contents">
                <dt className="text-ink-subtle">F1</dt>
                <dd className="text-right font-mono tabular-nums text-ink-muted">{fmt(activePoint.f1)}</dd>
              </div>
            </dl>
            <span className="border-t border-line pt-1.5 font-mono tabular-nums text-ink-muted">
              TP {activePoint.tp} · FP {activePoint.fp} · FN {activePoint.fn}
            </span>
            {activePoint.precision === null ? <span className="text-pretty text-ink-subtle">Nothing flagged: precision is undefined.</span> : null}
          </div>
        ) : null}

        <p id={liveId} aria-live="polite" className="sr-only">
          {activePoint && keyboard ? describe(activePoint) : ""}
        </p>
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1 text-xs text-ink-muted">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
              <line x1="1" x2="21" y1="6" y2="6" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
              <Mark shape={s.shape} x={11} y={6} color={s.color} />
            </svg>
            {s.label}
          </span>
        ))}
        <span className="text-ink-subtle">Gaps in the precision line: nothing was flagged at that threshold.</span>
      </figcaption>

      <div className="sr-only">
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">Spike threshold</th>
              <th scope="col">Precision</th>
              <th scope="col">Recall</th>
              <th scope="col">F1</th>
              <th scope="col">True positives</th>
              <th scope="col">False positives</th>
              <th scope="col">Missed</th>
            </tr>
          </thead>
          <tbody>
            {sweep.map((p) => (
              <tr key={p.spikeScore}>
                <th scope="row">
                  {p.spikeScore.toFixed(2)}
                  {p.spikeScore === shipped ? " (shipped)" : ""}
                </th>
                <td>{fmt(p.precision)}</td>
                <td>{fmt(p.recall)}</td>
                <td>{fmt(p.f1)}</td>
                <td>{p.tp}</td>
                <td>{p.fp}</td>
                <td>{p.fn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
