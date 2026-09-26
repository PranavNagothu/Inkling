// The seeded demo story on the bundled chain-rule lecture (scripts/seed-demo): what Maya wrote, in
// realistic handwriting (./handwriting), timed to what the lecturer was saying. Pure builders; the
// seed stores them and runs the real analysis over them.
//
// Session 1 (yesterday)
//   00:03–02:40  steady notes (the first two minutes of her writing calibrate "her normal")
//   ~01:02       CORRECTION → answered already: wrote dy/dx = 2(3x+1), erased it, rewrote 6(3x+1)
//   ~01:40       CORRECTION (the live demo moment): wrote d/dx sin(x²) = cos(x²), erased cos(x²),
//                rewrote cos(x²) · 2x — she forgot the inner derivative
//   ~04:07       GAP: product vs chain rule — slow, hesitant writing, erased, never rewritten, then
//                20 s of silence while the lecture goes on
// Session 2 (today) rewatches 03:30–04:45 and writes the product/chain example through calmly —
// that resolves the gap by revisit.
// Classmates: a few other students' sessions of the lecture (not listed on the home page) so the
// class-wide hotspots (Tiger Data continuous aggregate) have a shape.
import { handwrite } from "./handwriting";
import type { EraseEvent, Stroke } from "./types";

export const DEMO_SESSIONS = {
  s1: { id: "demo-maya-1", title: "Maya — Session 1" },
  s2: { id: "demo-maya-2", title: "Maya — Session 2" },
} as const;

export const DEMO_CLASSMATES = 5;
export const classmateSessionId = (i: number) => `demo-classmate-${i}`;
export const classmateStudentId = (i: number) => `demo-classmate-${i}`;

/** Lecture times of the story's moments (ms), for the seed and its tests. */
export const DEMO_TIMES = {
  /** 3x+1 correction (erase time = the moment's lectureMs). Answered in the seed → breakthrough. */
  breakthroughEraseMs: 62_000,
  /** sin(x²) correction: the demo's live moment. */
  correctionEraseMs: 100_000,
  /** Product-vs-chain hesitation: the gap's window is around here. */
  gapFromMs: 240_000,
  gapToMs: 280_000,
} as const;

const COL_X = [36, 440] as const;
/** Ruled lines of the notebook paper (globals.css .paper: 32 px apart, first at 47 px). */
export const baselineOf = (row: number) => 79 + row * 32;

export interface ScenarioPage {
  strokes: Stroke[];
  eraseEvents: EraseEvent[];
}

class PageWriter {
  readonly strokes: Stroke[] = [];
  readonly eraseEvents: EraseEvent[] = [];
  private lastEnd = 0;
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private seed: number,
  ) {}

  /**
   * Writes `text` at (col,row) — or continuing at `x` — starting no earlier than `atMs`, and never
   * before the pen lifted from the previous words. Returns the strokes and where the line ends.
   */
  write(text: string, where: { col: 0 | 1; row: number; x?: number; dy?: number; atMs?: number; pace?: number }) {
    const t0 = Math.max(where.atMs ?? 0, this.lastEnd + 380);
    const res = handwrite(text, {
      sessionId: this.sessionId,
      idPrefix: `${this.sessionId}-k${++this.seq}`,
      x: where.x ?? COL_X[where.col],
      baseline: baselineOf(where.row) + (where.dy ?? 0),
      t0,
      seed: this.seed++,
      pace: where.pace,
    });
    this.strokes.push(...res.strokes);
    this.lastEnd = res.endMs;
    return { ...res, nextX: res.endX + 6 };
  }

  /** Erases whole strokes with the eraser at `atMs` (one gesture = one erase event). */
  erase(strokes: Stroke[], atMs: number) {
    const ids = new Set(strokes.map((s) => s.id));
    for (let i = 0; i < this.strokes.length; i++) {
      if (ids.has(this.strokes[i].id)) {
        this.strokes[i] = { ...this.strokes[i], erased: true, erasedAtMs: atMs, erasedBy: "eraser" };
      }
    }
    this.eraseEvents.push({ id: `${this.sessionId}-e${this.eraseEvents.length + 1}`, sessionId: this.sessionId, atMs, strokeIds: [...ids], by: "eraser" });
    this.lastEnd = Math.max(this.lastEnd, atMs + 400);
  }

  page(): ScenarioPage {
    return { strokes: this.strokes, eraseEvents: this.eraseEvents };
  }
}

export function buildMayaSession1(sessionId: string = DEMO_SESSIONS.s1.id): ScenarioPage {
  const p = new PageWriter(sessionId, 101);
  // Column 1
  p.write("chain rule", { col: 0, row: 0, atMs: 3_000 });
  const r1 = p.write("y = f(g(x))", { col: 0, row: 1, atMs: 10_500 });
  p.write("f outer, g inner", { col: 0, row: 1, x: r1.nextX + 8 });
  p.write("dy/dx = f'(g(x)) · g'(x)", { col: 0, row: 2, atMs: 20_700 });
  p.write("f' at the inside, not at x!", { col: 0, row: 3, atMs: 27_000 });
  p.write("ex: y = (3x+1)^{2}", { col: 0, row: 4, atMs: 37_000 });
  p.write("out: u^{2}   in: 3x+1", { col: 0, row: 5, atMs: 43_000 });

  // 01:02 — stops after the outer derivative, catches it, fixes it.
  const lhs = p.write("dy/dx = ", { col: 0, row: 6, atMs: 50_000 });
  const outerOnly = p.write("2(3x+1)", { col: 0, row: 6, x: lhs.nextX, atMs: 54_500 });
  p.erase(outerOnly.strokes, DEMO_TIMES.breakthroughEraseMs);
  // Rewritten in the same spot — never pixel-exact, so the ghost of the attempt peeks out.
  p.write("6(3x+1)", { col: 0, row: 6, x: lhs.nextX + 5, dy: 3, atMs: DEMO_TIMES.breakthroughEraseMs + 1_500 });

  p.write("dy/dx = dy/du · du/dx", { col: 0, row: 8, atMs: 75_000 });

  // 01:40 — forgets the inner derivative of sin(x²), erases, rewrites with the 2x.
  const sinLhs = p.write("d/dx sin(x^{2}) = ", { col: 0, row: 9, atMs: 88_000 });
  const noInner = p.write("cos(x^{2})", { col: 0, row: 9, x: sinLhs.nextX, atMs: 94_500 });
  p.erase(noInner.strokes, DEMO_TIMES.correctionEraseMs);
  p.write("cos(x^{2}) · 2x", { col: 0, row: 9, x: sinLhs.nextX + 6, dy: 3, atMs: DEMO_TIMES.correctionEraseMs + 1_500 });

  p.write("d/dx e^{5x} = 5e^{5x}", { col: 0, row: 11, atMs: 108_000 });
  p.write("√sin(x^{2}) : 3 layers", { col: 0, row: 12, atMs: 120_000 });
  p.write("→ cos(x^{2})·2x / 2√sin(x^{2})", { col: 0, row: 13, atMs: 137_000 });
  p.write("if lost: name u, v", { col: 0, row: 14, atMs: 148_800 });
  p.write("(x^{2}+1)^{10} → 10(x^{2}+1)^{9}·2x", { col: 0, row: 15, atMs: 155_000 });

  // Column 2
  p.write("implicit: d/dx y^{2} = 2y dy/dx", { col: 1, row: 0, atMs: 171_000 });
  p.write("cos(3x) → -3 sin(3x)", { col: 1, row: 1, atMs: 193_000 });
  p.write("1. outer + inner", { col: 1, row: 2, atMs: 209_000 });
  p.write("2. f' keeps the inside", { col: 1, row: 3, atMs: 213_000 });
  p.write("3. × inner'", { col: 1, row: 4, atMs: 216_800 });
  p.write("product vs chain", { col: 1, row: 5, atMs: 222_000 });
  p.write("x·sin x → product", { col: 1, row: 6, atMs: 228_000 });
  p.write("sin(x^{2}) → chain", { col: 1, row: 7, atMs: 234_000 });

  // 04:07 — "both rules in the same problem": slow, unsure, erased, never rewritten; then silence.
  const tryLhs = p.write("x^{2}e^{3x} = ", { col: 1, row: 8, atMs: 246_500, pace: 0.35 });
  const tryRhs = p.write("2x e^{3x}", { col: 1, row: 8, x: tryLhs.nextX, pace: 0.35 });
  p.erase(tryRhs.strokes, Math.max(257_000, tryRhs.endMs + 800));
  p.erase(tryLhs.strokes, Math.max(262_000, tryRhs.endMs + 5_000));

  // Picks up again only after the lecture has moved on (> 20 s later: nothing "rewrites" the attempt).
  p.write("1/(x^{2}+4) = (x^{2}+4)^{-1}", { col: 1, row: 9, atMs: 290_000 });
  p.write("→ -2x / (x^{2}+4)^{2}", { col: 1, row: 10, atMs: 301_000 });
  p.write("sin^{2}x = (sin x)^{2}", { col: 1, row: 11, atMs: 318_000 });
  p.write("→ 2 sin x cos x", { col: 1, row: 12, atMs: 326_000 });
  p.write("not cos^{2}x !", { col: 1, row: 13, atMs: 340_000 });
  p.write("d/dx ln(x^{2}+1) = 2x/(x^{2}+1)", { col: 1, row: 14, atMs: 346_000 });
  return p.page();
}

export function buildMayaSession2(sessionId: string = DEMO_SESSIONS.s2.id): ScenarioPage {
  const p = new PageWriter(sessionId, 202);
  p.write("chain rule review", { col: 0, row: 0, atMs: 211_000 });
  p.write("product: f·g", { col: 0, row: 1, atMs: 221_000 });
  p.write("chain: f(g(x))", { col: 0, row: 2, atMs: 228_000 });
  p.write("x^{2}e^{3x} :", { col: 0, row: 3, atMs: 236_000 });
  p.write("= 2x e^{3x} + x^{2}·3e^{3x}", { col: 0, row: 4, atMs: 249_000 });
  p.write("= x e^{3x}(2 + 3x)", { col: 0, row: 5, atMs: 262_000 });
  p.write("both rules !", { col: 0, row: 6, atMs: 276_000 });
  return p.page();
}

const CLASSMATE_WORDS = ["f(g(x))", "chain", "dy/dx", "cos(x^{2})", "2x", "u^{2}", "e^{5x}", "inner", "outer", "x^{2}+1"];
/** Where the class erased most (the lecture's tricky parts): sin(x²), product vs chain, sin²x. */
const CLASS_TRICKY: Array<[number, number]> = [
  [90_000, 108_000],
  [245_000, 268_000],
  [318_000, 342_000],
];

/** A classmate's notes: a word every ~9 s, with erasing clustered in the lecture's tricky parts. */
export function buildClassmate(i: number): ScenarioPage {
  const p = new PageWriter(classmateSessionId(i), 500 + i * 17);
  let row = 0;
  let col: 0 | 1 = 0;
  for (let k = 0, t = 4_000 + i * 900; t < 350_000; k++, t += 8_000 + ((k * 7 + i * 3) % 5) * 800) {
    const word = CLASSMATE_WORDS[(k + i) % CLASSMATE_WORDS.length];
    const tricky = CLASS_TRICKY.some(([a, b]) => t >= a && t < b);
    const written = p.write(word, { col, row, atMs: t, pace: tricky ? 0.5 : 1 });
    if (tricky && (k + i) % 3 !== 0) p.erase(written.strokes, written.endMs + 2_500);
    if (++row > 15) {
      row = 0;
      col = 1;
    }
  }
  return p.page();
}
