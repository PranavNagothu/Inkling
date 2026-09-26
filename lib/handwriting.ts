// A tiny single-stroke "pen font" that turns text into realistic handwritten Stroke[] — pen
// pressure, a slight slant, per-stroke wobble and human pen speed, with a timestamp on every point
// — so the seeded demo (scripts/seed-demo) looks and analyses like a student wrote it on an iPad.
// Deterministic for a seed. Supports lowercase letters used in calculus notes, digits, math
// symbols and ^{…} superscripts. Pure; used by the seed and its tests only.
import { computeBBox, inkLength, medianSpeed } from "./ink";
import type { Point, Stroke } from "./types";

// ── Glyphs ───────────────────────────────────────────────────────────────────────────────────
// Units: x-height = 1, baseline y = 0, y grows downward (screen), ascenders ≈ -1.75, digits and
// brackets ≈ -1.45, descenders ≈ +0.7. A glyph is a list of pen strokes; each stroke is a list of
// parts drawn without lifting the pen.

type XY = [number, number];
type Part = XY[];

const L = (...pts: XY[]): Part => pts;
/** Elliptical arc from a0 to a1 degrees (increasing = clockwise on screen). */
function A(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Part {
  const n = Math.max(3, Math.ceil(Math.abs(a1 - a0) / 12));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as XY;
  });
}
const dot = (x: number, y: number): Part[] => [L([x, y], [x + 0.03, y + 0.03])];

interface Glyph {
  w: number;
  strokes: Part[][];
}

const bowl = (): Part => A(0.42, -0.5, 0.37, 0.5, -15, -345);

const GLYPHS: Record<string, Glyph> = {
  a: { w: 0.95, strokes: [[bowl(), L([0.78, -0.37], [0.79, -1], [0.82, 0])]] },
  b: { w: 0.9, strokes: [[L([0.12, -1.75], [0.12, 0], [0.13, -0.55]), A(0.47, -0.5, 0.35, 0.5, -170, 190)]] },
  c: { w: 0.8, strokes: [[A(0.42, -0.5, 0.37, 0.5, -40, -320)]] },
  d: { w: 0.95, strokes: [[bowl(), L([0.78, -0.37], [0.79, -1.75], [0.82, 0])]] },
  e: { w: 0.85, strokes: [[L([0.08, -0.5], [0.79, -0.5]), A(0.42, -0.5, 0.37, 0.5, 0, -320)]] },
  f: { w: 0.6, strokes: [[A(0.52, -1.4, 0.22, 0.35, -40, -180), L([0.3, -1.4], [0.28, 0.1])], [L([0.06, -0.95], [0.56, -0.95])]] },
  g: { w: 0.9, strokes: [[bowl(), L([0.78, -0.37], [0.78, -1], [0.78, 0.4]), A(0.46, 0.4, 0.32, 0.28, 0, 170)]] },
  h: { w: 0.9, strokes: [[L([0.12, -1.75], [0.12, 0], [0.12, -0.55]), A(0.45, -0.55, 0.33, 0.45, 180, 360), L([0.78, -0.55], [0.8, 0])]] },
  i: { w: 0.4, strokes: [[L([0.2, -1], [0.2, 0])], dot(0.2, -1.45)] },
  k: { w: 0.8, strokes: [[L([0.12, -1.75], [0.12, 0])], [L([0.7, -1], [0.14, -0.42], [0.74, 0])]] },
  l: { w: 0.4, strokes: [[L([0.2, -1.75], [0.2, -0.12], [0.3, 0])]] },
  m: {
    w: 1.25,
    strokes: [
      [
        L([0.1, -1], [0.1, 0], [0.1, -0.6]),
        A(0.32, -0.6, 0.22, 0.4, 180, 360),
        L([0.54, -0.6], [0.54, 0], [0.54, -0.6]),
        A(0.77, -0.6, 0.23, 0.4, 180, 360),
        L([1.0, -0.6], [1.02, 0]),
      ],
    ],
  },
  n: { w: 0.9, strokes: [[L([0.1, -1], [0.1, 0], [0.1, -0.6]), A(0.43, -0.6, 0.33, 0.4, 180, 360), L([0.76, -0.6], [0.78, 0])]] },
  o: { w: 0.85, strokes: [[A(0.42, -0.5, 0.37, 0.5, -90, -450)]] },
  p: { w: 0.9, strokes: [[L([0.1, -1], [0.1, 0.7])], [A(0.45, -0.5, 0.35, 0.5, -150, 150)]] },
  r: { w: 0.65, strokes: [[L([0.1, -1], [0.1, 0], [0.1, -0.6]), A(0.35, -0.55, 0.25, 0.4, 180, 300)]] },
  s: { w: 0.75, strokes: [[A(0.4, -0.75, 0.28, 0.25, -20, -270), A(0.4, -0.25, 0.3, 0.25, -90, 160)]] },
  t: { w: 0.6, strokes: [[L([0.28, -1.45], [0.28, -0.1], [0.45, 0])], [L([0.06, -1], [0.54, -1])]] },
  u: { w: 0.9, strokes: [[L([0.1, -1], [0.1, -0.4]), A(0.42, -0.4, 0.32, 0.4, 180, 0), L([0.74, -0.4], [0.74, -1], [0.77, 0])]] },
  v: { w: 0.8, strokes: [[L([0.05, -1], [0.4, 0], [0.75, -1])]] },
  w: { w: 1.15, strokes: [[L([0.05, -1], [0.3, 0], [0.55, -0.7], [0.8, 0], [1.05, -1])]] },
  x: { w: 0.8, strokes: [[L([0.08, -1], [0.72, 0])], [L([0.72, -1], [0.08, 0])]] },
  y: { w: 0.85, strokes: [[L([0.08, -1], [0.42, -0.05])], [L([0.76, -1], [0.25, 0.7])]] },
  "0": { w: 0.8, strokes: [[A(0.38, -0.72, 0.32, 0.72, -90, -450)]] },
  "1": { w: 0.6, strokes: [[L([0.12, -1.15], [0.38, -1.45], [0.38, 0])]] },
  "2": { w: 0.8, strokes: [[A(0.38, -1.07, 0.3, 0.38, -160, 30), L([0.64, -0.88], [0.08, 0], [0.72, 0])]] },
  "3": { w: 0.8, strokes: [[A(0.36, -1.1, 0.28, 0.33, -150, 90), A(0.38, -0.4, 0.32, 0.38, -90, 150)]] },
  "4": { w: 0.85, strokes: [[L([0.55, 0], [0.55, -1.45], [0.06, -0.4], [0.75, -0.4])]] },
  "5": { w: 0.8, strokes: [[L([0.68, -1.45], [0.18, -1.45], [0.14, -0.82]), A(0.38, -0.45, 0.32, 0.42, -130, 150)]] },
  "6": { w: 0.8, strokes: [[L([0.62, -1.42], [0.3, -1.05], [0.1, -0.5]), A(0.4, -0.42, 0.3, 0.42, 180, 540)]] },
  "9": { w: 0.8, strokes: [[A(0.38, -1.0, 0.3, 0.42, 0, -360), L([0.68, -1.0], [0.66, 0])]] },
  "(": { w: 0.45, strokes: [[A(0.6, -0.55, 0.45, 1.0, -125, -235)]] },
  ")": { w: 0.45, strokes: [[A(-0.15, -0.55, 0.45, 1.0, -55, 55)]] },
  "=": { w: 0.85, strokes: [[L([0.08, -0.72], [0.72, -0.72])], [L([0.08, -0.35], [0.72, -0.35])]] },
  "+": { w: 0.85, strokes: [[L([0.42, -0.95], [0.42, -0.15])], [L([0.08, -0.55], [0.76, -0.55])]] },
  "-": { w: 0.7, strokes: [[L([0.08, -0.55], [0.6, -0.55])]] },
  "/": { w: 0.6, strokes: [[L([0.55, -1.5], [0.05, 0.2])]] },
  "'": { w: 0.3, strokes: [[L([0.2, -1.6], [0.12, -1.2])]] },
  "·": { w: 0.45, strokes: [dot(0.2, -0.55)] },
  ".": { w: 0.35, strokes: [dot(0.15, -0.03)] },
  ",": { w: 0.35, strokes: [[L([0.18, -0.1], [0.08, 0.28])]] },
  ":": { w: 0.35, strokes: [dot(0.16, -0.8), dot(0.16, -0.1)] },
  "!": { w: 0.35, strokes: [[L([0.18, -1.5], [0.18, -0.4])], dot(0.18, -0.03)] },
  "→": { w: 1.25, strokes: [[L([0.08, -0.55], [1.08, -0.55])], [L([0.82, -0.8], [1.1, -0.55], [0.82, -0.3])]] },
  "×": { w: 0.7, strokes: [[L([0.12, -0.85], [0.58, -0.25])], [L([0.58, -0.85], [0.12, -0.25])]] },
  "√": { w: 1.0, strokes: [[L([0.02, -0.55], [0.18, -0.65], [0.38, 0], [0.7, -1.55], [0.98, -1.55])]] },
};

/** Every character the pen font writes (besides spaces). */
export const GLYPH_CHARS = Object.keys(GLYPHS).join("");

export interface GlyphRef {
  ch: string;
  sup: boolean;
}

/** Text → glyphs; `^{…}` writes its contents as a superscript. Throws on unknown characters. */
export function parseHandwriting(text: string): GlyphRef[] {
  const out: GlyphRef[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("^{", i)) {
      const end = text.indexOf("}", i);
      if (end < 0) throw new Error(`unclosed ^{ in "${text}"`);
      for (const ch of text.slice(i + 2, end)) out.push(check({ ch, sup: true }));
      i = end;
      continue;
    }
    out.push(check({ ch: text[i], sup: false }));
  }
  return out;
}

function check(g: GlyphRef): GlyphRef {
  if (g.ch !== " " && !GLYPHS[g.ch]) throw new Error(`the pen font can't write "${g.ch}"`);
  return g;
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────

/** mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HandwriteOptions {
  sessionId: string;
  /** Stroke ids are `${idPrefix}-${n}`. */
  idPrefix: string;
  /** Left edge and ruled line (px). */
  x: number;
  baseline: number;
  /** Lecture time of the first pen-down (ms). */
  t0: number;
  seed: number;
  /** x-height in px (default 12). */
  size?: number;
  /** 1 = a steady hand; lower is slower (hesitant writing), higher is faster. */
  pace?: number;
}

export interface Handwritten {
  strokes: Stroke[];
  /** Where the next word would start (px) and when the pen last lifted (ms). */
  endX: number;
  endMs: number;
}

const PEN_SPEED = 0.2; // px per ms: brisk handwriting on a tablet
const SAMPLE_PX = 1.6; // ~ one Pencil sample every 8 ms at that speed
const SLANT = 0.16;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function handwrite(text: string, opts: HandwriteOptions): Handwritten {
  const rand = rng(opts.seed);
  const jitter = (amp: number) => (rand() * 2 - 1) * amp;
  const size = opts.size ?? 12;
  const pace = opts.pace ?? 1;
  const strokes: Stroke[] = [];
  let x = opts.x;
  let t = opts.t0;
  let n = 0;

  for (const g of parseHandwriting(text)) {
    if (g.ch === " ") {
      x += 0.5 * size;
      t += Math.round((260 + jitter(60)) / pace);
      continue;
    }
    const glyph = GLYPHS[g.ch];
    const scale = g.sup ? size * 0.62 : size;
    const lift = g.sup ? -0.95 * size : 0;
    for (const parts of glyph.strokes) {
      // Per-stroke wobble: a whole stroke lands a little off, like a real hand.
      const dx = jitter(0.05 * scale);
      const dy = jitter(0.05 * scale);
      const speed = PEN_SPEED * pace * (0.85 + rand() * 0.3);
      const basePressure = 0.48 + jitter(0.04);
      const path: XY[] = parts.flat().map(([gx, gy]) => [x + (gx - SLANT * gy) * scale + dx, opts.baseline + lift + gy * scale + dy]);
      // Resample evenly along the path (the tablet samples at a steady rate).
      const pts: Point[] = [];
      const total = path.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : 0), 0);
      let walked = 0;
      const push = (px: number, py: number) => {
        const f = total > 0 ? walked / total : 0;
        const pressure = basePressure + 0.1 * Math.sin(Math.PI * f) + jitter(0.015);
        pts.push([r1(px + jitter(0.15)), r1(py + jitter(0.15)), r3(pressure), Math.round(t + walked / speed)]);
      };
      push(path[0][0], path[0][1]);
      for (let i = 1; i < path.length; i++) {
        const [ax, ay] = path[i - 1];
        const [bx, by] = path[i];
        const seg = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.round(seg / SAMPLE_PX));
        for (let k = 1; k <= steps; k++) {
          walked += seg / steps;
          push(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
        }
      }
      // Timestamps must increase: a dot is still a short touch.
      for (let i = 1; i < pts.length; i++) if (pts[i][3] <= pts[i - 1][3]) pts[i][3] = pts[i - 1][3] + 1;
      strokes.push({
        id: `${opts.idPrefix}-${++n}`,
        sessionId: opts.sessionId,
        startMs: pts[0][3],
        endMs: pts[pts.length - 1][3],
        points: pts,
        pointerType: "pen",
        bbox: computeBBox(pts),
        inkLen: r1(inkLength(pts)),
        medianSpeed: r3(medianSpeed(pts)),
        erased: false,
        erasedAtMs: null,
        erasedBy: null,
        isScribble: false,
      });
      t = pts[pts.length - 1][3] + Math.round((90 + jitter(30)) / pace);
    }
    x += (glyph.w + 0.12) * scale;
    t += Math.round((50 + jitter(20)) / pace);
  }
  return { strokes, endX: x, endMs: strokes.length ? strokes[strokes.length - 1].endMs : opts.t0 };
}
