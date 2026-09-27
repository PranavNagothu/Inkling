import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  EXPORT_FOOTER_PT,
  MAX_LINE_CHARS,
  MAX_PAGE_PT,
  MOMENT_PDF_LABEL,
  buildNotabilityExport,
  exportFileName,
  momentBlocks,
  toWinAnsi,
  wrapText,
} from "../notabilityExport";
import { inkFrame } from "../compare";
import { buildStroke } from "../ink";
import type { Point, Revision, Stroke, TimelineEvent } from "../types";

const line = (id: string, x: number, y: number, t: number, erased = false): Stroke => {
  const pts: Point[] = Array.from({ length: 8 }, (_, i) => [x + i * 6, y + (i % 2) * 3, 0.5, t + i * 30]);
  const s = buildStroke(id, "s1", pts, "pen");
  return erased ? { ...s, erased: true, erasedAtMs: t + 2_000, erasedBy: "eraser" } : s;
};

const event = (over: Partial<TimelineEvent> & Pick<TimelineEvent, "id" | "type" | "lectureMs">): TimelineEvent => ({
  sessionId: "s1",
  status: "open",
  conceptId: null,
  evidence: { excerpt: "", audioStartMs: 0, audioEndMs: 0 },
  checkAttempts: [],
  ...over,
});

const revision = (id: string, before: string[], after: string[], vision?: Revision["vision"]): Revision => ({
  id,
  sessionId: "s1",
  lectureMs: 100_000,
  beforeStrokeIds: before,
  afterStrokeIds: after,
  bbox: [40, 60, 200, 110],
  kind: "correction",
  vision,
});

const strokes = [line("a", 40, 80, 90_000, true), line("b", 40, 80, 101_000), line("c", 60, 300, 250_000, true), line("d", 300, 400, 10_000)];
const revisions = [
  revision("r1", ["a"], ["b"], {
    before: "cos(x²)",
    after: "cos(x²) · 2x",
    misconception: "Forgot the inner derivative → multiply by 2x",
    conceptLabel: "Chain rule",
    cosmetic: false,
  }),
];
const events = [
  event({
    id: "e2",
    type: "unresolved_gap",
    lectureMs: 250_000,
    windowStartMs: 250_000,
    evidence: { excerpt: "the product rule — not the chain rule — applies to x² · e^{3x}", audioStartMs: 240_000, audioEndMs: 260_000 },
    help: { reexplain: "Two factors multiplied → product rule. A function inside a function → chain rule. ∫ √x ≤ π 😀", mcq: { q: "q", options: ["a", "b"], answerIdx: 0, why: "w" } },
  }),
  event({
    id: "e1",
    type: "misconception_corrected",
    lectureMs: 100_000,
    revisionId: "r1",
    conceptLabel: "Chain rule",
    evidence: { excerpt: "d/dx sin(x²) = cos(x²) · 2x", audioStartMs: 90_000, audioEndMs: 110_000 },
  }),
  event({ id: "e3", type: "breakthrough", lectureMs: 62_000, status: "resolved" }),
];

describe("toWinAnsi", () => {
  it("keeps what WinAnsi can encode and substitutes math symbols it can't", () => {
    expect(toWinAnsi("cos(x²) → cos(x²) · 2x — done")).toBe("cos(x²) -> cos(x²) · 2x — done");
    expect(toWinAnsi("x ≤ 2, y ≥ 3, a ≠ b, √x, π, ∞, θ, Δx, −1")).toBe("x <= 2, y >= 3, a != b, sqrtx, pi, inf, theta, Deltax, -1");
    expect(toWinAnsi("x⁴ + a₁")).toBe("x^4 + a_1");
    expect(toWinAnsi("“quotes” … café")).toBe("“quotes” … café");
  });

  it("drops what nothing can stand in for, and flattens whitespace", () => {
    expect(toWinAnsi("ok 😀 漢\nnext\tline")).toBe("ok ? ? next line");
  });

  it("only emits characters the font can encode", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const supported = new Set(font.getCharacterSet());
    const out = toWinAnsi("∫₀¹ f′(x) dx ≈ 𝑥² → ✓ ✨ ∑ λ μ ⋅ ∙", supported);
    expect(() => font.encodeText(out)).not.toThrow();
    expect([...out].every((ch) => supported.has(ch.codePointAt(0)!))).toBe(true);
  });
});

describe("wrapText", () => {
  const measure = (s: string) => s.length * 5;
  it("wraps greedily at word boundaries", () => {
    expect(wrapText("the chain rule says multiply by the inner derivative", 60, measure)).toEqual([
      "the chain", "rule says", "multiply by", "the inner", "derivative",
    ]);
  });
  it("hard-breaks a word longer than the line", () => {
    const out = wrapText("abcdefghijklmnopqrstuvwxyz", 50, measure);
    expect(out).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(out.every((l) => measure(l) <= 50)).toBe(true);
  });
  it("returns no lines for blank text", () => {
    expect(wrapText("   ", 50, measure)).toEqual([]);
  });
});

describe("exportFileName", () => {
  it("is inkling-<safe-title>.pdf", () => {
    expect(exportFileName("Maya — Session 1")).toBe("inkling-maya-session-1.pdf");
    expect(exportFileName("../../etc/passwd")).toBe("inkling-etc-passwd.pdf");
    expect(exportFileName('a"b;c\r\nd')).toBe("inkling-a-b-c-d.pdf");
    expect(exportFileName("")).toBe("inkling-notes.pdf");
    expect(exportFileName("✨✨")).toBe("inkling-notes.pdf");
    expect(exportFileName("x".repeat(300)).length).toBeLessThanOrEqual("inkling-.pdf".length + 60);
  });
});

describe("momentBlocks", () => {
  it("lists moments in lecture order with type, before→after reading, excerpt and re-explanation", () => {
    const blocks = momentBlocks(events, revisions);
    expect(blocks.map((b) => b.heading)).toEqual(["01:02 · Breakthrough", "01:40 · Corrected", "04:10 · Gap"]);
    expect(blocks.map((b) => b.type)).toEqual(["breakthrough", "misconception_corrected", "unresolved_gap"]);
    const corrected = Object.fromEntries(blocks[1].lines.map((l) => [l.label, l.text]));
    expect(corrected).toMatchObject({
      Reading: "cos(x²) → cos(x²) · 2x",
      Lecture: "“d/dx sin(x²) = cos(x²) · 2x”",
      Concept: "Chain rule",
    });
    const gap = Object.fromEntries(blocks[2].lines.map((l) => [l.label, l.text]));
    expect(gap["Re-explanation"]).toContain("product rule");
    expect(gap.Reading).toBeUndefined();
    expect(MOMENT_PDF_LABEL).toEqual({ misconception_corrected: "Corrected", unresolved_gap: "Gap", breakthrough: "Breakthrough" });
  });
});

describe("buildNotabilityExport", () => {
  it("builds a valid 2-page PDF: the notes page (frame + footer) and the moments page", async () => {
    const bytes = await buildNotabilityExport({ title: "Maya — Session 1 → √", lectureTitle: "Chain rule", strokes, events, revisions });
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const [x0, y0, x1, y1] = inkFrame(strokes);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(x1 - x0);
    expect(height).toBeCloseTo(y1 - y0 + EXPORT_FOOTER_PT);
    expect(doc.getTitle()).toBe("Maya — Session 1 → √");
  });

  it("still makes two pages for a session with no ink and no moments", async () => {
    const doc = await PDFDocument.load(await buildNotabilityExport({ title: "Empty", strokes: [], events: [], revisions: [] }));
    expect(doc.getPageCount()).toBe(2);
  });

  it("continues the moments list on another page when it doesn't fit", async () => {
    const long = "a long re-explanation that keeps going ".repeat(12);
    const many = Array.from({ length: 10 }, (_, i) =>
      event({ id: `m${i}`, type: "unresolved_gap", lectureMs: i * 30_000, evidence: { excerpt: long, audioStartMs: 0, audioEndMs: 0 }, help: { reexplain: long, mcq: { q: "", options: [], answerIdx: 0, why: "" } } }),
    );
    const doc = await PDFDocument.load(await buildNotabilityExport({ title: "Many", strokes, events: many, revisions: [] }));
    expect(doc.getPageCount()).toBeGreaterThan(2);
  });

  // Adversarial stored data: stroke boxes and caption text come from clients.
  it("caps the notes page at the PDF size limit however far a stroke's box claims to reach (and stays fast)", async () => {
    const huge: Stroke = { ...line("far", 40, 80, 1_000), bbox: [0, 0, 1e12, 1e12] };
    const started = performance.now();
    const doc = await PDFDocument.load(await buildNotabilityExport({ title: "Far", strokes: [...strokes, huge], events, revisions }));
    expect(performance.now() - started).toBeLessThan(5_000);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeLessThanOrEqual(MAX_PAGE_PT);
    expect(height).toBeLessThanOrEqual(MAX_PAGE_PT);
  });

  it("cuts one enormous caption 'word' and a long title instead of printing hundreds of pages", async () => {
    const blob = "x".repeat(200_000);
    const e = event({ id: "big", type: "unresolved_gap", lectureMs: 1_000, evidence: { excerpt: blob, audioStartMs: 0, audioEndMs: 0 } });
    const [block] = momentBlocks([e], []);
    expect(block.lines.every((l) => l.text.length <= MAX_LINE_CHARS)).toBe(true);
    const doc = await PDFDocument.load(await buildNotabilityExport({ title: "T".repeat(200), lectureTitle: "L".repeat(5_000), strokes, events: [e], revisions: [] }));
    expect(doc.getPageCount()).toBeLessThanOrEqual(3);
  });

  it("handles a large session (thousands of strokes) and odd text (RTL, emoji, controls)", async () => {
    const many = Array.from({ length: 3_000 }, (_, i) => line(`s${i}`, (i % 40) * 15, 60 + Math.floor(i / 40) * 12, i * 100, i % 7 === 0));
    const weird = event({
      id: "w",
      type: "breakthrough",
      lectureMs: 5_000,
      evidence: { excerpt: "مرحبا 你好 \u202e\u0000\u0007 👩‍🎓 x\u0301", audioStartMs: 0, audioEndMs: 0 },
    });
    const doc = await PDFDocument.load(await buildNotabilityExport({ title: "\u202eevil\u0000", strokes: many, events: [weird], revisions: [] }));
    expect(doc.getPageCount()).toBe(2);
  });
});
