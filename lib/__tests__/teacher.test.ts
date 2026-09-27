import { describe, expect, it } from "vitest";
import {
  CLASS_K,
  buildClassView,
  pickReteachMoments,
  rangeExcerpt,
  studentSignalsFrom,
  studentsLabel,
  type StudentSignals,
} from "../teacher";
import type { InkHotspot } from "../dbShared";
import type { ConfusionWindow, EraseEvent, Stroke, TranscriptWord } from "../types";

const B = 30_000;

/** A student who erased at each of the given lecture times (ms). */
const eraser = (...ms: number[]): StudentSignals => ({ hesitationMs: [], eraseMs: ms });
const hesitator = (...ms: number[]): StudentSignals => ({ hesitationMs: ms, eraseMs: [] });

const hot = (bucketStartMs: number, erased: number, strokes = erased + 4): InkHotspot => ({
  bucketStartMs,
  strokes,
  erased,
  inkLen: strokes * 40,
});

const words = (...list: Array<[string, number]>): TranscriptWord[] => list.map(([w, startMs]) => ({ w, startMs, endMs: startMs + 400 }));

describe("studentsLabel (k-anonymity)", () => {
  it("shows a count only at or above k", () => {
    expect(CLASS_K).toBe(3);
    expect(studentsLabel(3)).toBe("3 students");
    expect(studentsLabel(7)).toBe("7 students");
    expect(studentsLabel(null)).toBe("fewer than 3 students");
    expect(studentsLabel(2)).toBe("fewer than 3 students");
    expect(studentsLabel(0)).toBe("fewer than 3 students");
  });
});

describe("pickReteachMoments", () => {
  const cell = (i: number, students: number[], erased = 0) => ({ startMs: i * B, endMs: (i + 1) * B, students: new Set(students), erased });

  it("ranks by distinct students, then erasing, then earlier", () => {
    const picked = pickReteachMoments(
      [cell(0, [1]), cell(2, [1, 2, 3], 2), cell(4, [1, 2, 3], 5), cell(6, [4, 5, 6, 7]), cell(8, [1, 2, 3], 5)],
      3,
    );
    expect(picked.map((m) => m.startMs)).toEqual([6 * B, 4 * B, 8 * B]);
    expect(picked.map((m) => m.students.size)).toEqual([4, 3, 3]);
  });

  it("never picks the same stretch twice: neighbours join the range or are skipped", () => {
    // 4 and 5 are the same confusing stretch (5 strong enough to join 4's range); 6 is adjacent → skipped.
    const picked = pickReteachMoments([cell(4, [1, 2, 3, 4]), cell(5, [3, 4, 5]), cell(6, [6, 7, 8]), cell(9, [1])], 3);
    expect(picked[0]).toMatchObject({ startMs: 4 * B, endMs: 6 * B });
    // Distinct students across the joined range.
    expect(picked[0].students.size).toBe(5);
    expect(picked.map((m) => m.startMs)).toEqual([4 * B, 9 * B]);
  });

  it("ignores stretches nobody struggled in and returns fewer than n when that's all there is", () => {
    expect(pickReteachMoments([cell(0, []), cell(1, [])], 3)).toEqual([]);
    expect(pickReteachMoments([cell(0, [1, 2]), cell(3, [])], 3)).toHaveLength(1);
  });
});

describe("rangeExcerpt", () => {
  it("joins the words spoken in the range and trims long ones", () => {
    const w = words(["before", 1_000], ["the", 31_000], ["chain", 32_000], ["rule", 33_000], ["after", 61_000]);
    expect(rangeExcerpt(w, 30_000, 60_000)).toBe("the chain rule");
    const long = words(...Array.from({ length: 40 }, (_, i) => [`w${i}`, 30_000 + i * 100] as [string, number]));
    const out = rangeExcerpt(long, 30_000, 60_000, 5);
    expect(out).toBe("w0 w1 w2 w3 w4…");
    expect(rangeExcerpt([], 0, 1)).toBe("");
  });
});

describe("studentSignalsFrom", () => {
  it("takes hesitation spikes and real erases (not undo) from one session", () => {
    const win = (bucketStartMs: number, isSpike: boolean): ConfusionWindow => ({
      sessionId: "s",
      bucketStartMs,
      pause: 0,
      slowdown: 0,
      erase: 0,
      pressure: null,
      rawScore: 0,
      emaScore: 0,
      isSpike,
      reasons: [],
      phase: "scored",
    });
    const erase = (id: string, atMs: number, by: EraseEvent["by"]): EraseEvent => ({ id, sessionId: "s", atMs, strokeIds: ["k"], by });
    const stroke = { id: "k", sessionId: "s", startMs: 0, endMs: 1, points: [], pointerType: "pen", bbox: [0, 0, 1, 1], inkLen: 1, medianSpeed: 1, erased: true, erasedAtMs: 5_000, erasedBy: "eraser", isScribble: false } satisfies Stroke;
    const out = studentSignalsFrom({
      windows: [win(10_000, false), win(40_000, true)],
      eraseEvents: [erase("a", 5_000, "eraser"), erase("b", 6_000, "undo")],
      strokes: [stroke],
    });
    expect(out.hesitationMs).toEqual([40_000]);
    expect(out.eraseMs).toEqual([5_000]);
  });
});

describe("buildClassView", () => {
  const w = words(["inner", 95_000], ["derivative", 96_000], ["product", 250_000], ["rule", 251_000]);

  it("is empty without any students", () => {
    expect(buildClassView({ durationMs: 300_000, hotspots: [], students: [], words: w })).toEqual({ status: "empty" });
  });

  it("withholds everything below k students (no heatmap, no moments, no class size)", () => {
    const view = buildClassView({ durationMs: 300_000, hotspots: [hot(90_000, 3)], students: [eraser(95_000), eraser(96_000)], words: w });
    expect(view).toEqual({ status: "too-few" });
  });

  it("builds the heatmap and top 3 with k-anonymous counts", () => {
    const students = [
      eraser(95_000, 250_000),
      eraser(96_000, 255_000),
      hesitator(100_000, 252_000),
      eraser(97_000),
      hesitator(200_000),
    ];
    const view = buildClassView({
      durationMs: 300_000,
      hotspots: [hot(90_000, 6), hot(240_000, 4), hot(180_000, 1)],
      students,
      words: w,
    });
    if (view.status !== "ready") throw new Error(view.status);
    expect(view.classSize).toBe(5);
    expect(view.buckets).toHaveLength(10);
    const at = (ms: number) => view.buckets.find((b) => b.startMs === ms)!;
    expect(at(90_000)).toMatchObject({ erased: 6, students: 4, erasedLevel: 1 });
    expect(at(240_000)).toMatchObject({ erased: 4, students: 3 });
    // One student: suppressed.
    expect(at(180_000)).toMatchObject({ students: null, studentLevel: 0 });
    expect(at(0)).toMatchObject({ erased: 0, students: null, erasedLevel: 0 });

    expect(view.moments.map((m) => [m.rank, m.startMs, m.students])).toEqual([
      [1, 90_000, 4],
      [2, 240_000, 3],
      [3, 180_000, null],
    ]);
    expect(view.moments[0]).toMatchObject({ studentsLabel: "4 students", excerpt: "inner derivative", endMs: 120_000 });
    expect(view.moments[2].studentsLabel).toBe("fewer than 3 students");
  });

  it("counts a student once per stretch however many times they struggled", () => {
    const students = [eraser(91_000, 92_000, 93_000), eraser(94_000), eraser(95_000)];
    const view = buildClassView({ durationMs: 120_000, hotspots: [hot(90_000, 5)], students, words: [] });
    if (view.status !== "ready") throw new Error(view.status);
    expect(view.moments[0].students).toBe(3);
  });

  it("never leaks raw counts below k anywhere in the serialized view", () => {
    const students = [eraser(10_000), eraser(70_000), eraser(130_000)];
    const view = buildClassView({ durationMs: 180_000, hotspots: [], students, words: [] });
    if (view.status !== "ready") throw new Error(view.status);
    expect(view.buckets.every((b) => b.students === null)).toBe(true);
    expect(view.moments.every((m) => m.students === null && m.studentsLabel === "fewer than 3 students")).toBe(true);
  });
});
