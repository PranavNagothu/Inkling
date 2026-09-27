"use client";

// Signal Lab chart: over lecture time, the smoothed hesitation score (line) and raw score (columns)
// against the spike threshold, the baseline stretches, the timeline moments, and — on the same time
// axis — one strip per hesitation feature. Hand-rolled SVG; one y-scale (every value is 0..1).
//
// Interaction: a crosshair snaps to the 10 s window under the pointer and a tooltip lists its
// feature values and reasons. Keyboard: the plot is one tab stop (← → Home End move between
// windows, Enter opens a spike's moment); every spike and moment is also its own link. Screen
// readers get a live description of the focused window and a full data table.
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { FEATURES, describePoint, formatScore, reviewHref, timeTicks, type SignalLabData, type SignalPoint } from "@/lib/insights";
import { MOMENT_META } from "@/lib/moments";
import { formatClock } from "@/lib/time";
import type { TimelineEventType } from "@/lib/types";

const M = { left: 84, right: 20 };
const LANE_H = 28; // moment markers
const SCORE_H = 168;
const STRIP_GAP = 18; // score panel → first strip
const STRIP_H = 26;
const STRIP_STEP = 34;
const AXIS_H = 26;
const BAR_GAP = 2;
const MAX_BAR = 24;

const GLYPH_CLASS: Record<TimelineEventType, string> = {
  misconception_corrected: "fill-corrected stroke-chrome",
  unresolved_gap: "fill-chrome stroke-gap",
  breakthrough: "fill-breakthrough stroke-chrome",
};

function Glyph({ type, x, y }: { type: TimelineEventType; x: number; y: number }) {
  if (type === "breakthrough") {
    return <path d={`M${x} ${y - 7} L${x + 7} ${y} L${x} ${y + 7} L${x - 7} ${y}Z`} strokeWidth={2} strokeLinejoin="round" className={GLYPH_CLASS[type]} />;
  }
  return type === "unresolved_gap" ? (
    <circle cx={x} cy={y} r={5.5} strokeWidth={2.75} className={GLYPH_CLASS[type]} />
  ) : (
    <circle cx={x} cy={y} r={6.5} strokeWidth={2} className={GLYPH_CLASS[type]} />
  );
}

/** Contiguous runs of non-idle windows (the score line breaks where the student wasn't writing). */
function lineRuns(points: SignalPoint[]): SignalPoint[][] {
  const runs: SignalPoint[][] = [];
  let run: SignalPoint[] = [];
  for (const p of points) {
    if (p.phase === "idle") {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

export function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function SignalChart({ data, sessionId, sessionTitle }: { data: SignalLabData; sessionId: string; sessionTitle: string }) {
  const router = useRouter();
  const [wrapRef, width] = useWidth(880);
  const [active, setActive] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const liveId = useId();
  const hatchId = `hatch-${liveId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const { points, durationMs, spikeScore, featureOn } = data;
  const plotW = Math.max(120, width - M.left - M.right);
  const x = (ms: number) => M.left + (durationMs > 0 ? (Math.min(ms, durationMs) / durationMs) * plotW : 0);
  const scoreTop = LANE_H;
  const yScore = (v: number) => scoreTop + (1 - Math.min(1, Math.max(0, v))) * SCORE_H;
  const stripTop = (i: number) => scoreTop + SCORE_H + STRIP_GAP + i * STRIP_STEP;
  const plotBottom = stripTop(FEATURES.length - 1) + STRIP_H;
  const height = plotBottom + AXIS_H;
  const step = points.length && durationMs > 0 ? (data.windowMs / durationMs) * plotW : plotW;
  const barW = Math.max(1, Math.min(MAX_BAR, step - BAR_GAP));

  const runs = useMemo(() => lineRuns(points), [points]);
  const ticks = useMemo(() => timeTicks(durationMs), [durationMs]);
  const activePoint = active !== null ? points[active] ?? null : null;

  const indexAt = (clientX: number, rect: DOMRect) => {
    if (!points.length || durationMs <= 0) return null;
    const ms = ((clientX - rect.left - M.left) / plotW) * durationMs;
    if (ms < 0 || ms > durationMs) return null;
    const i = points.findIndex((p) => ms >= p.startMs && ms < p.endMs);
    return i === -1 ? points.length - 1 : i;
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    setKeyboard(false);
    setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()));
  };

  const open = (p: SignalPoint) => router.push(reviewHref(sessionId, p.eventId));

  const onPlotClick = (e: MouseEvent<SVGSVGElement>) => {
    // Links (spikes, moments) handle their own clicks.
    if ((e.target as Element).closest("a")) return;
    const i = indexAt(e.clientX, e.currentTarget.getBoundingClientRect());
    if (i !== null && points[i]?.isSpike) open(points[i]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!points.length) return;
    const cur = active ?? -1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(points.length - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur < 0 ? 0 : cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    else if (e.key === "Enter" && activePoint?.isSpike) {
      e.preventDefault();
      open(activePoint);
      return;
    } else if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setKeyboard(true);
      setActive(next);
    }
  };

  const summary = `Hesitation signals for ${sessionTitle}, per ${data.windowMs / 1000}-second window over ${formatClock(durationMs)} of lecture: ${
    data.spikeCount === 0 ? "no spikes" : `${data.spikeCount} spike${data.spikeCount === 1 ? "" : "s"}`
  } above the ${formatScore(spikeScore)} threshold${data.peak ? `; highest score ${formatScore(data.peak.score)} at ${formatClock(data.peak.startMs)}` : ""}.`;

  // Tooltip placement: beside the crosshair, flipped when it would overflow the right edge.
  const tipW = 264;
  const tipX = activePoint ? x(activePoint.midMs) : 0;
  const tipLeft = tipX + 14 + tipW > width ? Math.max(4, tipX - 14 - tipW) : tipX + 14;

  return (
    <figure data-testid="signal-chart" data-spike-count={data.spikeCount} className="flex flex-col gap-3">
      <div
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${summary} Use the left and right arrow keys to step through the windows.`}
        aria-describedby={liveId}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setKeyboard(false);
            setActive(null);
          }
        }}
        className="relative panel outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => !keyboard && setActive(null)}
          onClick={onPlotClick}
          className="block max-w-full select-none"
        >
          {/* Baseline stretches: "your normal" — never flagged. Hatched like the review timeline. */}
          <defs>
            <pattern id={hatchId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
              <rect width="7" height="7" className="fill-transparent" />
              <line x1="0" y1="0" x2="0" y2="7" strokeWidth="1" className="stroke-ink/[0.07]" />
            </pattern>
          </defs>
          {data.baseline.map((z, i) => (
            <g key={z.startMs} data-testid="signal-baseline" aria-hidden="true">
              <rect x={x(z.startMs)} y={scoreTop} width={Math.max(1, x(z.endMs) - x(z.startMs))} height={plotBottom - scoreTop} fill={`url(#${hatchId})`} />
              {i === 0 ? (
                <text x={x(z.startMs) + 6} y={scoreTop + 14} className="fill-ink-subtle text-[10px] font-medium tracking-wide uppercase">
                  Baseline · your normal
                </text>
              ) : null}
            </g>
          ))}

          {/* Score panel: gridlines + y ticks (0, 0.5, 1). */}
          <g aria-hidden="true">
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line x1={M.left} x2={M.left + plotW} y1={yScore(v)} y2={yScore(v)} strokeWidth={1} className="stroke-line" />
                <text x={M.left - 8} y={yScore(v) + 3.5} textAnchor="end" className="fill-ink-subtle font-mono text-[10px] tabular-nums">
                  {v.toFixed(1)}
                </text>
              </g>
            ))}
            <text x={12} y={scoreTop + 12} className="fill-ink-muted text-[11px] font-medium">
              Score
            </text>
          </g>

          {/* Crosshair band for the active window. */}
          {activePoint ? (
            <rect
              aria-hidden="true"
              x={x(activePoint.startMs)}
              y={scoreTop}
              width={Math.max(1, x(activePoint.endMs) - x(activePoint.startMs))}
              height={plotBottom - scoreTop}
              className="fill-ink/[0.05]"
            />
          ) : null}

          {/* Raw score: faint columns (what smoothing starts from). */}
          <g aria-hidden="true">
            {points.map((p) =>
              p.phase === "idle" || p.rawScore <= 0 ? null : (
                <rect
                  key={p.startMs}
                  x={x(p.midMs) - barW / 2}
                  y={yScore(p.rawScore)}
                  width={barW}
                  height={Math.max(0, yScore(0) - yScore(p.rawScore))}
                  rx={Math.min(2, barW / 2)}
                  className="fill-accent/[0.13]"
                />
              ),
            )}
          </g>

          {/* Spike threshold: dashed because it is a rule, not data. */}
          <g aria-hidden="true">
            <line
              x1={M.left}
              x2={M.left + plotW}
              y1={yScore(spikeScore)}
              y2={yScore(spikeScore)}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              className="stroke-gap-strong/70"
            />
            <text x={M.left + plotW - 4} y={yScore(spikeScore) - 5} textAnchor="end" className="fill-ink-muted text-[10.5px] font-medium">
              Spike threshold {formatScore(spikeScore)}
            </text>
          </g>

          {/* Smoothed score: the line spikes are judged on. */}
          <g aria-hidden="true">
            {runs.map((run) => (
              <polyline
                key={run[0].startMs}
                points={run.map((p) => `${x(p.midMs).toFixed(1)},${yScore(p.score).toFixed(1)}`).join(" ")}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-accent"
              />
            ))}
          </g>

          {/* Feature strips: one per signal, bars 0..1; solid when the feature is "on". */}
          {FEATURES.map((f, i) => {
            const top = stripTop(i);
            const unused = f.key === "pressure" && !data.pressureUsed;
            return (
              <g key={f.key} data-testid="signal-strip" data-feature={f.key} aria-hidden="true">
                <line x1={M.left} x2={M.left + plotW} y1={top + STRIP_H} y2={top + STRIP_H} strokeWidth={1} className="stroke-line" />
                <text x={12} y={top + STRIP_H / 2 + 1} className="fill-ink-muted text-[11px] font-medium">
                  {f.label}
                </text>
                <text x={12} y={top + STRIP_H / 2 + 13} className="fill-ink-subtle font-mono text-[9.5px] tabular-nums">
                  {Math.round(f.weight * 100)}% weight
                </text>
                {unused ? (
                  <text x={M.left + 8} y={top + STRIP_H / 2 + 4} className="fill-ink-subtle text-[11px]">
                    Not used — no pen pressure in this session
                  </text>
                ) : (
                  points.map((p) => {
                    const v = p[f.key];
                    if (v === null || v <= 0 || p.phase === "idle") return null;
                    const h = Math.max(2, v * STRIP_H);
                    return (
                      <rect
                        key={p.startMs}
                        x={x(p.midMs) - barW / 2}
                        y={top + STRIP_H - h}
                        width={barW}
                        height={h}
                        rx={Math.min(2, barW / 2)}
                        className={v >= featureOn ? "fill-accent" : "fill-accent/35"}
                      />
                    );
                  })
                )}
              </g>
            );
          })}

          {/* Crosshair hairline. */}
          {activePoint ? (
            <line
              aria-hidden="true"
              x1={x(activePoint.midMs)}
              x2={x(activePoint.midMs)}
              y1={scoreTop}
              y2={plotBottom}
              strokeWidth={1}
              className="stroke-ink/40"
            />
          ) : null}

          {/* Moments from the learning timeline, in the lane above the score. */}
          {data.markers.map((m) => (
            <a
              key={m.id}
              href={reviewHref(sessionId, m.id)}
              data-testid="signal-event-marker"
              data-type={m.type}
              data-event-id={m.id}
              aria-label={`${MOMENT_META[m.type].label} at ${formatClock(m.lectureMs)}: ${m.label}. Open in review`}
              onClick={(e) => {
                e.preventDefault();
                router.push(reviewHref(sessionId, m.id));
              }}
              className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-accent"
            >
              <circle cx={x(m.lectureMs)} cy={LANE_H / 2} r={12} className="fill-transparent stroke-transparent" strokeWidth={2} />
              <line x1={x(m.lectureMs)} x2={x(m.lectureMs)} y1={LANE_H / 2 + 7} y2={scoreTop + SCORE_H} strokeWidth={1} className="stroke-ink/15" />
              <Glyph type={m.type} x={x(m.lectureMs)} y={LANE_H / 2} />
            </a>
          ))}

          {/* Spikes: links to the moment they produced. */}
          {points.map((p, i) =>
            p.isSpike ? (
              <a
                key={p.startMs}
                href={reviewHref(sessionId, p.eventId)}
                data-testid="signal-spike"
                data-start-ms={p.startMs}
                data-event-id={p.eventId ?? ""}
                aria-label={`Spike at ${formatClock(p.startMs)}, score ${formatScore(p.score)}${p.reasons.length ? `: ${p.reasons.join("; ")}` : ""}. Open this moment in review`}
                onFocus={() => {
                  setKeyboard(true);
                  setActive(i);
                }}
                onClick={(e) => {
                  e.preventDefault();
                  open(p);
                }}
                className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-accent"
              >
                <circle cx={x(p.midMs)} cy={yScore(p.score)} r={12} strokeWidth={2} className="fill-transparent stroke-transparent" />
                <circle cx={x(p.midMs)} cy={yScore(p.score)} r={5.5} strokeWidth={2} className="fill-gap stroke-chrome" />
              </a>
            ) : null,
          )}

          {/* Time axis. */}
          <g aria-hidden="true">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={plotBottom} y2={plotBottom + 4} strokeWidth={1} className="stroke-line-strong" />
                <text
                  x={x(t)}
                  y={plotBottom + 17}
                  textAnchor={t === 0 ? "start" : t >= durationMs ? "end" : "middle"}
                  className="fill-ink-subtle font-mono text-[10px] tabular-nums"
                >
                  {formatClock(t)}
                </text>
              </g>
            ))}
          </g>
        </svg>

        {activePoint ? <Tooltip point={activePoint} spikeScore={spikeScore} featureOn={featureOn} left={tipLeft} width={tipW} /> : null}

        <p id={liveId} aria-live="polite" className="sr-only">
          {activePoint && keyboard ? describePoint(activePoint, spikeScore) : ""}
        </p>
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1 text-xs text-ink-muted">
        <LegendKey kind="line">Smoothed score</LegendKey>
        <LegendKey kind="column">Raw score (this window only)</LegendKey>
        <LegendKey kind="dash">Spike threshold</LegendKey>
        <LegendKey kind="spike">Spike — click to open the moment</LegendKey>
        <LegendKey kind="bar">Signal on (≥ {formatScore(featureOn)})</LegendKey>
        <LegendKey kind="hatch">Baseline</LegendKey>
      </figcaption>

      <SignalTable data={data} caption={summary} />
    </figure>
  );
}

function LegendKey({ kind, children }: { kind: "line" | "column" | "dash" | "spike" | "bar" | "hatch"; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
        {kind === "line" ? <line x1="1" x2="17" y1="6" y2="6" strokeWidth="2" strokeLinecap="round" className="stroke-accent" /> : null}
        {kind === "column" ? <rect x="5" y="2" width="8" height="10" rx="2" className="fill-accent/[0.13]" /> : null}
        {kind === "dash" ? <line x1="0" x2="18" y1="6" y2="6" strokeWidth="1.5" strokeDasharray="5 4" className="stroke-gap-strong/70" /> : null}
        {kind === "spike" ? <circle cx="9" cy="6" r="4.5" strokeWidth="2" className="fill-gap stroke-chrome" /> : null}
        {kind === "bar" ? (
          <>
            <rect x="2" y="4" width="6" height="8" rx="1.5" className="fill-accent/35" />
            <rect x="10" y="1" width="6" height="11" rx="1.5" className="fill-accent" />
          </>
        ) : null}
        {kind === "hatch" ? <rect x="1" y="1" width="16" height="10" rx="2" className="fill-ink/[0.06] stroke-line-strong" strokeWidth="1" /> : null}
      </svg>
      {children}
    </span>
  );
}

function Tooltip({ point: p, spikeScore, featureOn, left, width }: { point: SignalPoint; spikeScore: number; featureOn: number; left: number; width: number }) {
  const above = p.score >= spikeScore;
  return (
    <div
      data-testid="signal-tooltip"
      data-start-ms={p.startMs}
      aria-hidden="true"
      className="pointer-events-none absolute top-8 z-10 flex flex-col gap-2 rounded-md border border-line bg-chrome/95 px-3 py-2.5 text-xs shadow-page backdrop-blur-sm"
      style={{ left, width }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono tabular-nums text-ink-muted">
          {formatClock(p.startMs)}–{formatClock(p.endMs)}
        </span>
        <span
          className={`rounded-pill px-1.5 py-px text-[10.5px] font-semibold ${
            p.isSpike ? "bg-gap-soft text-gap-strong" : p.phase === "scored" ? "bg-chrome-press text-ink-muted" : "bg-chrome-press text-ink-subtle"
          }`}
        >
          {p.isSpike ? "Spike" : p.phase === "baseline" ? "Baseline" : p.phase === "idle" ? "Not writing" : "Scored"}
        </span>
      </div>
      {p.phase === "idle" ? (
        <p className="text-pretty text-ink-muted">No ink nearby — this stretch isn’t scored.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-lg leading-none font-semibold text-ink">{formatScore(p.score)}</span>
            <span className="text-ink-muted">
              smoothed · {above ? "above" : "below"} {formatScore(spikeScore)}
            </span>
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {FEATURES.map((f) => {
              const v = p[f.key];
              return (
                <div key={f.key} className="contents">
                  <dt className="flex items-center gap-1.5 text-ink-muted">
                    <span aria-hidden="true" className={`h-0.5 w-2.5 rounded-pill ${v !== null && v >= featureOn ? "bg-accent" : "bg-accent/35"}`} />
                    {f.label}
                  </dt>
                  <dd className="text-right font-mono font-medium tabular-nums text-ink">{v === null ? "—" : formatScore(v)}</dd>
                </div>
              );
            })}
            <div className="contents">
              <dt className="text-ink-subtle">Raw score</dt>
              <dd className="text-right font-mono tabular-nums text-ink-muted">{formatScore(p.rawScore)}</dd>
            </div>
          </dl>
          {p.reasons.length ? (
            <ul className="flex flex-col gap-0.5 border-t border-line pt-1.5">
              {p.reasons.map((r) => (
                <li key={r} data-testid="signal-tooltip-reason" className="text-pretty text-ink">
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-line pt-1.5 text-ink-subtle">No signal crossed its “on” level here.</p>
          )}
          {p.note ? (
            <p data-testid="signal-tooltip-note" className="text-pretty text-ink-muted">
              {p.note}
            </p>
          ) : null}
          {p.isSpike ? <p className="font-medium text-accent">Click to open this moment in review</p> : null}
        </>
      )}
    </div>
  );
}

function SignalTable({ data, caption }: { data: SignalLabData; caption: string }) {
  const rows = data.points.filter((p) => p.phase !== "idle");
  return (
    <div className="sr-only">
      <table data-testid="signal-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Lecture time</th>
            <th scope="col">Phase</th>
            {FEATURES.map((f) => (
              <th key={f.key} scope="col">
                {f.label}
              </th>
            ))}
            <th scope="col">Raw score</th>
            <th scope="col">Smoothed score</th>
            <th scope="col">Spike</th>
            <th scope="col">Reasons</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.startMs}>
              <th scope="row">
                {formatClock(p.startMs)}–{formatClock(p.endMs)}
              </th>
              <td>{p.phase}</td>
              {FEATURES.map((f) => {
                const v = p[f.key];
                return <td key={f.key}>{v === null ? "n/a" : formatScore(v)}</td>;
              })}
              <td>{formatScore(p.rawScore)}</td>
              <td>{formatScore(p.score)}</td>
              <td>{p.isSpike ? "yes" : "no"}</td>
              <td>{p.reasons.join("; ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
