import { expect, test, type Page } from "@playwright/test";
import type { EraseEvent, Stroke } from "../lib/types";

// Phase 3: scribbling a word out with the pen counts as erasing — exactly like the eraser, the
// covered ink (and the zig-zag itself) is kept as ghost ink, never hard-deleted.

test.use({ viewport: { width: 1180, height: 820 } });

type Box = { x: number; y: number; width: number; height: number };
type SessionData = { strokes: Stroke[]; eraseEvents: EraseEvent[] };

async function newSession(page: Page) {
  await page.goto("/app");
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];
  const box = await page.getByTestId("ink-canvas").boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  return { sessionId, box };
}

/** A handwriting-like wavy stroke across canvas x0..x1 around y. */
async function drawWord(page: Page, box: Box, x0: number, x1: number, y: number, amp = 8) {
  await page.mouse.move(box.x + x0, box.y + y);
  await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + x0 + ((x1 - x0) * i) / steps, box.y + y + amp * Math.sin(i * 0.9));
  }
  await page.mouse.up();
}

/** Back-and-forth zig-zag across canvas x0..x1, drifting from y0 to y1 (one reversal per pass). */
async function drawZigzag(page: Page, box: Box, x0: number, x1: number, y0: number, y1: number, passes = 8) {
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  for (let p = 1; p <= passes; p++) {
    await page.mouse.move(box.x + (p % 2 ? x1 : x0), box.y + y0 + ((y1 - y0) * p) / passes, { steps: 6 });
  }
  await page.mouse.up();
}

async function drawStraight(page: Page, box: Box, x0: number, y: number, x1: number) {
  await page.mouse.move(box.x + x0, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x1, box.y + y, { steps: 20 });
  await page.mouse.up();
}

/** The word used throughout, and a scribble that covers it. */
const WORD = { x0: 200, x1: 360, y: 200 };
const writeWord = (page: Page, box: Box) => drawWord(page, box, WORD.x0, WORD.x1, WORD.y);
const scribbleOverWord = (page: Page, box: Box) => drawZigzag(page, box, 190, 370, 186, 214);

type Pixels = { ink: number; ghost: number };

/** Ink-dark and teal ghost-ink pixel counts in a CSS-px rectangle centred on (cx, cy) of a canvas. */
async function pixelsAt(page: Page, cx: number, cy: number, halfW: number, halfH: number, testId = "ink-canvas") {
  return page.getByTestId(testId).evaluate(
    (el, [cx, cy, hw, hh]): Pixels => {
      const c = el as HTMLCanvasElement;
      const k = c.width / c.clientWidth;
      const x = Math.round((cx - hw) * k);
      const y = Math.round((cy - hh) * k);
      const data = c.getContext("2d")!.getImageData(x, y, Math.round(2 * hw * k), Math.round(2 * hh * k)).data;
      let ink = 0;
      let ghost = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a > 150 && r < 90 && g < 90 && b < 90) ink++;
        if (a > 20 && r < 100 && g > 110 && b < g + 8 && g - r > 60) ghost++;
      }
      return { ink, ghost };
    },
    [cx, cy, halfW, halfH] as const,
  );
}
const wordPixels = (page: Page) => pixelsAt(page, (WORD.x0 + WORD.x1) / 2, WORD.y, 90, 16);

/** Number of painted pixels on a canvas. */
async function paintedPixels(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    if (c.width === 0 || c.height === 0) return 0;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 40) n++;
    return n;
  });
}

async function expectCounts(page: Page, total: number, live: number, ghost: number) {
  const canvas = page.getByTestId("ink-canvas");
  await expect(canvas).toHaveAttribute("data-stroke-count", String(total));
  await expect(canvas).toHaveAttribute("data-visible-count", String(live));
  await expect(canvas).toHaveAttribute("data-erased-count", String(ghost));
}

async function savedData(page: Page, sessionId: string): Promise<SessionData> {
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
  return (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as SessionData;
}

test("scribbling over a word erases it into ghost ink, with a toast, and it persists", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  await writeWord(page, box);
  await expectCounts(page, 1, 1, 0);
  expect((await wordPixels(page)).ink).toBeGreaterThan(50);

  await scribbleOverWord(page, box);

  // The word and the zig-zag are both ghost ink now (nothing visible, nothing deleted).
  await expectCounts(page, 2, 0, 2);
  // Phase 8 (stroke counter): the student drew one word (the zig-zag is an erasing gesture, not a
  // line they wrote), now erased — "1 stroke · 1 erased part" instead of "0 strokes · 2 ghost".
  await expect(page.getByTestId("stroke-counter")).toHaveText("1 stroke · 1 erased part");
  const toast = page.getByTestId("scribble-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Scribbled out — kept as ghost");
  await expect(page.getByTestId("scribble-undo")).toBeVisible();

  // Ghost off: once the fade finishes the area holds no ink at all.
  await expect.poll(() => wordPixels(page)).toEqual({ ink: 0, ghost: 0 });

  // Ghost on: the word and the zig-zag show in teal ghost ink, still no black ink.
  await page.getByTestId("ghost-toggle").check();
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-ghost", "on");
  const ghostOn = await wordPixels(page);
  expect(ghostOn.ghost).toBeGreaterThan(100);
  expect(ghostOn.ink).toBe(0);
  await expect(toast).toBeVisible();
  await page.screenshot({ path: "screenshots/phase3-scribble.png", animations: "disabled" });
  await page.getByTestId("ghost-toggle").uncheck();

  // Stored: the word erased by 'scribble' at the scribble's end, the zig-zag kept as a scribble stroke.
  const data = await savedData(page, sessionId);
  expect(data.strokes).toHaveLength(2);
  const zig = data.strokes.find((s) => s.isScribble)!;
  const word = data.strokes.find((s) => !s.isScribble)!;
  expect(word).toMatchObject({ erased: true, erasedBy: "scribble", erasedAtMs: zig.endMs });
  expect(zig).toMatchObject({ erased: true, erasedBy: "scribble", erasedAtMs: zig.endMs });
  const scribbleEvents = data.eraseEvents.filter((e) => e.by === "scribble");
  expect(data.eraseEvents).toHaveLength(1);
  expect(scribbleEvents).toHaveLength(1);
  expect(scribbleEvents[0].strokeIds).toEqual([word.id]);
  expect(scribbleEvents[0].atMs).toBe(zig.endMs);

  // Reload: same page.
  await page.reload();
  await expectCounts(page, 2, 0, 2);
  await expect.poll(() => wordPixels(page)).toEqual({ ink: 0, ghost: 0 });
  await page.getByTestId("ghost-toggle").check();
  await expect.poll(async () => (await wordPixels(page)).ghost).toBeGreaterThan(100);
});

test("toast Undo restores the scribbled-out word as live ink, and it persists", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  await writeWord(page, box);
  await scribbleOverWord(page, box);
  await expectCounts(page, 2, 0, 2);

  await page.getByTestId("scribble-undo").click();
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0);
  // The word is live again; the zig-zag stays stored as an undone (ghost) stroke.
  await expectCounts(page, 2, 1, 1);
  await expect.poll(async () => (await wordPixels(page)).ink).toBeGreaterThan(50);

  const data = await savedData(page, sessionId);
  const zig = data.strokes.find((s) => s.isScribble)!;
  const word = data.strokes.find((s) => !s.isScribble)!;
  expect(word).toMatchObject({ erased: false, erasedBy: null, erasedAtMs: null });
  expect(zig).toMatchObject({ erased: true, erasedBy: "undo" });
  expect(data.eraseEvents.map((e) => e.by).sort()).toEqual(["scribble", "undo"]);
  expect(data.eraseEvents.find((e) => e.by === "undo")!.strokeIds).toEqual([zig.id]);

  await page.reload();
  await expectCounts(page, 2, 1, 1);
  await expect.poll(async () => (await wordPixels(page)).ink).toBeGreaterThan(50);
});

test("toolbar Undo reverses a scribble-out when it was the last action, then undoes strokes as before", async ({
  page,
}) => {
  const { sessionId, box } = await newSession(page);
  await writeWord(page, box);
  await scribbleOverWord(page, box);
  await expectCounts(page, 2, 0, 2);

  await page.getByTestId("undo").click();
  await expectCounts(page, 2, 1, 1);
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0);

  // Next Undo is the ordinary one: the word itself is undone.
  await page.getByTestId("undo").click();
  await expectCounts(page, 2, 0, 2);
  const data = await savedData(page, sessionId);
  expect(data.strokes.map((s) => s.erasedBy).sort()).toEqual(["undo", "undo"]);
});

test("scribble-out then rewrite in the same spot shows a corrected misconception in review", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  // The lecture clock must run so the scribble lands >= 3 s after the word (otherwise it is a
  // 'micro' slip of the pen, not a correction).
  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-state", "playing");

  await writeWord(page, box);
  await expectCounts(page, 1, 1, 0);
  await page.waitForTimeout(4000);
  await scribbleOverWord(page, box);
  await expectCounts(page, 2, 0, 2);

  // Rewrite over the scribbled-out spot (ordinary handwriting, not a scribble).
  await drawWord(page, box, 205, 355, 204, 6);
  await expectCounts(page, 3, 1, 2);

  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("count-erased")).toHaveText("2");
  const corrected = page.locator('[data-testid="timeline-marker"][data-type="misconception_corrected"]');
  await expect(corrected).toHaveCount(1);
  await expect(page.getByTestId("count-corrected")).toHaveText("1");

  await corrected.first().click();
  await expect(page.getByTestId("moment-detail")).toBeVisible();
  await expect.poll(() => paintedPixels(page, "before-canvas")).toBeGreaterThan(40);
  await expect.poll(() => paintedPixels(page, "after-canvas")).toBeGreaterThan(40);

  // The revision's before is the word only (not the zig-zag); its after is the rewrite.
  const timeline = await (await page.request.get(`/api/sessions/${sessionId}/timeline`)).json();
  const data = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as SessionData;
  const byId = new Map(data.strokes.map((s) => [s.id, s]));
  const rev = (timeline.revisions as Array<{ kind: string; beforeStrokeIds: string[]; afterStrokeIds: string[] }>).find(
    (r) => r.kind === "correction",
  )!;
  expect(rev.beforeStrokeIds.map((id) => byId.get(id)!.isScribble)).toEqual([false]);
  expect(rev.afterStrokeIds.map((id) => byId.get(id)!.erased)).toEqual([false]);
});

test("a zig-zag on empty paper is just ink, not a scribble-out", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  // Some unrelated writing elsewhere on the page.
  await drawWord(page, box, 600, 760, 420);
  await drawZigzag(page, box, 190, 370, 186, 214);
  await expectCounts(page, 2, 2, 0);
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0);
  expect((await wordPixels(page)).ink).toBeGreaterThan(50);

  const data = await savedData(page, sessionId);
  expect(data.strokes.every((s) => !s.isScribble && !s.erased)).toBe(true);
  expect(data.eraseEvents).toHaveLength(0);
});

test("a straight underline under a word is not a scribble-out", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  await writeWord(page, box);
  await drawStraight(page, box, WORD.x0 - 5, WORD.y + 16, WORD.x1 + 5);
  await expectCounts(page, 2, 2, 0);
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0);

  const data = await savedData(page, sessionId);
  expect(data.strokes.every((s) => !s.isScribble && !s.erased)).toBe(true);
  expect(data.eraseEvents).toHaveLength(0);
});
