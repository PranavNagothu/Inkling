// "Where the class slowed down": a quiet bar sparkline of class-wide erasing per 30 s of a lecture
// (lib/hotspots; on Tiger Data the numbers come from a TimescaleDB continuous aggregate). Server
// component: plain SVG with a native tooltip per bar and a screen-reader table.
import { slowestStretches, type HotspotBar } from "@/lib/hotspots";
import { formatClock } from "@/lib/time";

const W = 1000;
const H = 44;
const GAP = 2; // px of surface between bars (viewBox units ≈ px at typical widths)
const MIN_BAR = 2;

const range = (b: HotspotBar) => `${formatClock(b.startMs)}–${formatClock(b.endMs)}`;

export default function HotspotSparkline({
  bars,
  durationMs,
  source,
  lectureTitle,
}: {
  bars: HotspotBar[];
  durationMs: number;
  /** Where the numbers come from (hotspotSourceLabel). */
  source: string;
  lectureTitle: string;
}) {
  const total = bars.reduce((n, b) => n + b.erased, 0);
  const [peak, second] = slowestStretches(bars, 2);
  const step = bars.length ? W / bars.length : W;
  const summary = peak
    ? `Class erasing per 30 seconds of ${lectureTitle}: most at ${range(peak)} (${peak.erased} erased)${
        second ? `, then ${range(second)} (${second.erased})` : ""
      }.`
    : `No erasing recorded yet for ${lectureTitle}.`;

  return (
    <figure
      data-testid="hotspots"
      data-peak-ms={peak?.startMs ?? ""}
      data-source={source}
      className="flex flex-col gap-2 panel px-4 pt-3 pb-2.5"
    >
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-semibold text-ink">Where the class slowed down</span>
        <span className="text-xs text-ink-subtle">
          Erased strokes per 30 s, every session of this lecture
          {peak ? (
            <>
              {" "}
              · most at <span className="font-mono tabular-nums text-ink-muted">{formatClock(peak.startMs)}</span>
            </>
          ) : null}
        </span>
      </figcaption>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary} className="block h-11 w-full">
          {bars.map((b, i) => {
            const h = b.erased > 0 ? Math.max(MIN_BAR * 2, b.level * (H - 4)) : MIN_BAR;
            const x = i * step + GAP / 2;
            return (
              <g key={b.startMs}>
                <title>{`${range(b)} · ${b.erased} erased of ${b.strokes} strokes`}</title>
                {/* Hit target: the whole column, not just the bar. */}
                <rect x={x - GAP / 2} y={0} width={step} height={H} fill="transparent" />
                <rect
                  x={x}
                  y={H - h}
                  width={Math.max(1, step - GAP)}
                  height={h}
                  rx={2}
                  className={b.erased > 0 ? (b === peak ? "fill-ghost" : "fill-ghost/55") : "fill-line"}
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div aria-hidden="true" className="flex justify-between font-mono text-[11px] tabular-nums text-ink-subtle">
        <span>00:00</span>
        <span className="font-sans">
          {total} erased · {source}
        </span>
        <span>{formatClock(durationMs)}</span>
      </div>

      <div className="sr-only">
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">Lecture time</th>
              <th scope="col">Erased</th>
              <th scope="col">Strokes</th>
            </tr>
          </thead>
          <tbody>
            {bars
              .filter((b) => b.strokes > 0)
              .map((b) => (
                <tr key={b.startMs}>
                  <td>{range(b)}</td>
                  <td>{b.erased}</td>
                  <td>{b.strokes}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
