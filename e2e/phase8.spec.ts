import { expect, test, type Page } from "@playwright/test";
import type { EraseEvent, Stroke } from "../lib/types";

// Phase 8 backlog: the people-facing stroke counter (lines drawn, not pieces) on the capture bar and
// the home list, toolbar Undo after the eraser, strike-through as erasing, and the live hesitation
// meter.

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

async function drawWord(page: Page, box: Box, x0: number, x1: number, y: number, amp = 8) {
  await page.mouse.move(box.x + x0, box.y + y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(box.x + x0 + ((x1 - x0) * i) / 40, box.y + y + amp * Math.sin(i * 0.9));
  await page.mouse.up();
}

async function drawStraight(page: Page, box: Box, x0: number, y0: number, x1: number, y1 = y0) {
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  await page.mouse.move(box.x + x1, box.y + y1, { steps: 20 });
  await page.mouse.up();
}

/** Scrubs the eraser back and forth across x0..x1 around y. */
async function rub(page: Page, box: Box, x0: number, x1: number, y: number) {
  await page.getByTestId("tool-eraser").click();
  await page.mouse.move(box.x + x0, box.y + y - 20);
  await page.mouse.down();
  for (let i = 0; i <= 6; i++) await page.mouse.move(box.x + x0 + ((x1 - x0) * i) / 6, box.y + y + (i % 2 ? -20 : 20), { steps: 4 });
  await page.mouse.up();
  await page.getByTestId("tool-pen").click();
}

/** Dark-ink pixels in a CSS-px rectangle of the capture canvas. */
async function inkAt(page: Page, cx: number, cy: number, hw: number, hh: number) {
  return page.getByTestId("ink-canvas").evaluate(
    (el, [cx, cy, hw, hh]) => {
      const c = el as HTMLCanvasElement;
      const k = c.width / c.clientWidth;
      const data = c.getContext("2d")!.getImageData(Math.round((cx - hw) * k), Math.round((cy - hh) * k), Math.round(2 * hw * k), Math.round(2 * hh * k)).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 150 && data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) ink++;
      return ink;
    },
    [cx, cy, hw, hh] as const,
  );
}

async function saved(page: Page, sessionId: string): Promise<SessionData> {
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
  return (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as SessionData;
}

const canvas = (page: Page) => page.getByTestId("ink-canvas");

test("the stroke counter counts lines drawn, on the capture bar and on the home list", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  await drawStraight(page, box, 100, 150, 500);
  await drawStraight(page, box, 100, 250, 500);
  await expect(page.getByTestId("stroke-counter")).toHaveText("2 strokes");
  await rub(page, box, 270, 330, 150);
  // Cut into 3 pieces, but still 2 lines drawn.
  await expect(canvas(page)).toHaveAttribute("data-stroke-count", "4");
  await expect(canvas(page)).toHaveAttribute("data-drawn-count", "2");
  await expect(page.getByTestId("stroke-counter")).toHaveText("2 strokes · 1 erased part");

  await saved(page, sessionId);
  await page.goto("/app");
  const count = page.locator(`a[href="/session/${sessionId}"] [data-testid="session-stroke-count"]`);
  await expect(count).toHaveAttribute("data-drawn", "2");
  await expect(count).toHaveAttribute("data-erased-parts", "1");
  await expect(count).toContainText("2 strokes");
  await expect(count).toContainText("1 erased part");
});

test("toolbar Undo right after the eraser brings the erased part back, and it stays back", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  await drawStraight(page, box, 100, 200, 500);
  await rub(page, box, 270, 330, 200);
  await expect(canvas(page)).toHaveAttribute("data-erased-part-count", "1");
  await expect.poll(() => inkAt(page, 300, 200, 20, 5)).toBe(0);

  await page.getByTestId("undo").click();
  await expect(canvas(page)).toHaveAttribute("data-erased-part-count", "0");
  await expect(canvas(page)).toHaveAttribute("data-drawn-count", "1");
  await expect(canvas(page)).toHaveAttribute("data-visible-count", "3");
  await expect(page.getByTestId("stroke-counter")).toHaveText("1 stroke");
  await expect.poll(() => inkAt(page, 300, 200, 20, 5)).toBeGreaterThan(5);

  // Persisted: the pieces are live ink again, and an 'undo' event records it.
  const data = await saved(page, sessionId);
  expect(data.strokes.filter((s) => s.erased)).toEqual([]);
  expect(data.eraseEvents.map((e) => e.by)).toEqual(["eraser", "undo"]);
  await page.reload();
  await expect(canvas(page)).toHaveAttribute("data-erased-part-count", "0");
  await expect.poll(() => inkAt(page, 300, 200, 20, 5)).toBeGreaterThan(5);

  // A second Undo takes back the line itself (the stroke before the eraser gesture).
  await page.getByTestId("undo").click();
  await expect(canvas(page)).toHaveAttribute("data-visible-count", "0");
});

test("a straight line through a word, then new writing nearby, erases the word (with undo); an underline stays ink", async ({ page }) => {
  const { sessionId, box } = await newSession(page);
  // Underline: a word, a line under it, more writing next to it → nothing erased.
  await drawWord(page, box, 200, 360, 120);
  await drawStraight(page, box, 195, 142, 365);
  await drawWord(page, box, 380, 480, 120);
  await expect(canvas(page)).toHaveAttribute("data-erased-part-count", "0");
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0);

  // Strike-through: the line alone is still ink…
  await drawWord(page, box, 200, 360, 300);
  await drawStraight(page, box, 190, 301, 370, 299);
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute("data-visible-count", "5");
  // …until the student writes next to it: the word was crossed out.
  await drawWord(page, box, 385, 500, 300);
  const toast = page.getByTestId("scribble-toast");
  await expect(toast).toHaveAttribute("data-kind", "strike");
  await expect(toast).toContainText("Struck through — kept as ghost");
  await expect(canvas(page)).toHaveAttribute("data-erased-part-count", "1");
  await expect(canvas(page)).toHaveAttribute("data-drawn-count", "5");
  await expect(page.getByTestId("stroke-counter")).toHaveText("5 strokes · 1 erased part");

  let data = await saved(page, sessionId);
  const struck = data.strokes.filter((s) => s.erasedBy === "strike");
  expect(struck.map((s) => s.isScribble).sort()).toEqual([false, true]); // the word, and the line as a gesture
  expect(data.eraseEvents.filter((e) => e.by === "strike")).toHaveLength(1);

  // Undo from the toast: the word is ink again, the line becomes an undone stroke.
  await page.getByTestId("scribble-undo").click();
  await expect(canvas(page)).toHaveAttribute("data-erased-part-count", "0");
  data = await saved(page, sessionId);
  expect(data.strokes.filter((s) => s.erasedBy === "strike")).toEqual([]);
  expect(data.strokes.filter((s) => s.erasedBy === "undo")).toHaveLength(1);
});

test("the live hesitation meter calibrates, then reads steady writing as steady; it respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { box } = await newSession(page);
  const meter = page.getByTestId("hesitation-meter");
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute("data-state", "calibrating");
  await expect(meter).toHaveAttribute("role", "meter");
  for (let i = 0; i < 7; i++) await drawWord(page, box, 60 + (i % 4) * 150, 180 + (i % 4) * 150, 100 + Math.floor(i / 4) * 32);
  await expect(meter).toHaveAttribute("data-state", "steady");
  await expect(meter).toHaveAttribute("aria-valuetext", /Steady/);
  // No colour transition under prefers-reduced-motion (the app's reduced-motion CSS clamps to ~0).
  const duration = await meter.locator("span > span").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);
});
