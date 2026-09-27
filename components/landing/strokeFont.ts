// A tiny single-line "handwriting" stroke font for the hero animation: just the glyphs needed for
// `d/dx sin(x²) = cos(x²)` and `= 2x cos(x²)`. Each glyph is a list of pen strokes in a local box
// (baseline at y = 0, up is negative, x-height 22). Layout bakes position, scale and a slight
// forward slant into absolute coordinates, so every stroke keeps the same line width when drawn.

type Glyph = { w: number; strokes: string[]; scale?: number; rise?: number };

const TWO = "M1 -24 C2 -30 7 -33 11 -32 C16 -31 17 -25 13 -19 L0 0 L17 0";

const GLYPHS: Record<string, Glyph> = {
  d: {
    w: 20,
    strokes: [
      "M17 -15 C15 -20 12 -22 8.5 -22 C3.5 -22 0 -17 0 -10.5 C0 -4 3.5 0 8 0 C12.5 0 17 -4 17 -11",
      "M17 -40 L17.5 0",
    ],
  },
  "/": { w: 15, strokes: ["M15 -40 L1 6"] },
  x: { w: 17, strokes: ["M0 -22 C5 -15 11 -6 16 0", "M16 -22 C11 -15 5 -6 0 0"] },
  s: {
    w: 16,
    strokes: ["M15 -19 C13 -22 8 -23 4.5 -21 C1 -19 1.5 -14.5 7 -12.5 C12.5 -10.5 16 -8 15 -4 C14 0 7 1 1 -2.5"],
  },
  i: { w: 5, strokes: ["M2 -22 L2 0", "M2.4 -31 L2.6 -30.2"] },
  n: { w: 17, strokes: ["M0 -22 L0 0", "M0 -13 C2 -19 5.5 -22 10 -22 C14 -22 16 -19 16 -14 L16 0"] },
  "(": { w: 10, strokes: ["M10 -42 C1 -30 1 -4 10 8"] },
  ")": { w: 10, strokes: ["M2 -42 C11 -30 11 -4 2 8"] },
  "2": { w: 18, strokes: [TWO] },
  "²": { w: 17, strokes: [TWO], scale: 0.55, rise: 21 },
  "=": { w: 20, strokes: ["M0 -15 L20 -15", "M0 -6 L20 -6"] },
  c: {
    w: 16,
    strokes: ["M16 -17.5 C13.5 -21.5 9 -22.5 5.5 -21 C1.5 -19 0 -15 0 -10.5 C0 -4 3.5 0 8.5 0 C12 0 14.5 -1.5 16 -4"],
  },
  o: {
    w: 18,
    strokes: ["M9 -22 C3.5 -22 0 -16.5 0 -10.5 C0 -4 3.5 0 9 0 C14 0 17.5 -4.5 17.5 -11 C17.5 -18 14 -22 9 -22"],
  },
  " ": { w: 7, strokes: [] },
};

const TRACKING = 4; // space after each glyph, in glyph units
const SLANT = 0.14; // forward lean: x shifts right by this much per unit of height

export type Stroke = { d: string; glyph: number; char: string };
export type Line = { strokes: Stroke[]; width: number; glyphX: number[] };

/** Transform a path of absolute M/L/C commands (numbers come in x,y pairs). */
function place(d: string, s: number, dx: number, dy: number, baselineY: number): string {
  let isX = true;
  let pendingX = 0;
  return d.replace(/-?\d*\.?\d+/g, (num) => {
    const v = parseFloat(num);
    if (isX) {
      pendingX = v;
      isX = false;
      return "\u0000"; // placeholder; the x depends on the y (slant), filled in below
    }
    isX = true;
    const y = v * s + dy; // relative to the baseline (negative is up)
    const x = pendingX * s + dx - y * SLANT;
    return `${round(x)} ${round(y + baselineY)}`;
  })
    .replace(/\u0000\s*/g, "")
    .replace(/\s+/g, " ");
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Lay out `text` starting at (x, baselineY), glyphs scaled by `size`. */
export function layoutLine(text: string, x: number, baselineY: number, size: number): Line {
  const strokes: Stroke[] = [];
  const glyphX: number[] = [];
  let cursor = x;
  Array.from(text).forEach((char, glyph) => {
    const g = GLYPHS[char];
    if (!g) throw new Error(`strokeFont: no glyph for ${JSON.stringify(char)}`);
    glyphX.push(cursor);
    const gs = (g.scale ?? 1) * size;
    const rise = (g.rise ?? 0) * size;
    for (const d of g.strokes) strokes.push({ d: place(d, gs, cursor, -rise, baselineY), glyph, char });
    cursor += (g.w * (g.scale ?? 1) + TRACKING) * size;
  });
  return { strokes, width: cursor - x, glyphX };
}
