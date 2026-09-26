import { expect, test, type Page } from "@playwright/test";
import type { EraseEvent, Stroke } from "../lib/types";

// A real eraser removes only the ink it passes over. The rest of the stroke stays live ink, and
// the rubbed-out part is kept as ghost ink (nothing is ever hard-deleted).

async function newSession(page: Page) {
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];
  const box = await page.getByTestId("ink-canvas").boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  return { sessionId, box };
}

/** Perfectly straight horizontal stroke (page coordinates). */
async function drawStraight(page: Page, x0: number, y: number, x1: number) {
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 20 });
  await page.mouse.up();
}

type Pixels = { ink: number; ghost: number };

/** Counts ink-dark and vermilion pixels in a CSS-px rectangle centred on (cx, cy) of a canvas. */
async function pixelsAt(page: Page, testId: string, cx: number, cy: number, halfW: number, halfH: number) {
  return page.getByTestId(testId).evaluate(
    (el, [cx, cy, hw, hh]): Pixels => {
      const c = el as HTMLCanvasElement;
      const k = c.width / c.clientWidth;
      const x = Math.round((cx - hw) * k);
      const y = Math.round((cy - hh) * k);
      const [w, h] = [Math.round(2 * hw * k), Math.round(2 * hh * k)];
      // Not sized yet (its ResizeObserver hasn't fired, e.g. on a cold dev compile): nothing drawn,
      // so an expect.poll caller simply tries again instead of getImageData throwing.
      if (w <= 0 || h <= 0) return { ink: 0, ghost: 0 };
      const data = c.getContext("2d")!.getImageData(x, y, w, h).data;
      let ink = 0;
      let ghost = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a > 150 && r < 90 && g < 90 && b < 90) ink++;
        if (a > 20 && r > 150 && g < 120 && b < 120) ghost++;
      }
      return { ink, ghost };
    },
    [cx, cy, halfW, halfH] as const,
  );
}

async function expectCounts(page: Page, testId: string, total: number, live: number, erased: number) {
  const canvas = page.getByTestId(testId);
  await expect(canvas).toHaveAttribute("data-stroke-count", String(total));
  await expect(canvas).toHaveAttribute("data-visible-count", String(live));
  await expect(canvas).toHaveAttribute("data-erased-count", String(erased));
}

test("rubbing the middle of a stroke erases only that part and keeps it as ghost ink", async ({ page, request }) => {
  const { sessionId, box } = await newSession(page);
  const canvas = page.getByTestId("ink-canvas");

  // One long horizontal line, in canvas coordinates x 100 → 500 at y 200.
  const [lx0, lx1, ly, mid] = [100, 500, 200, 300];
  await drawStraight(page, box.x + lx0, box.y + ly, box.x + lx1);
  await expectCounts(page, "ink-canvas", 1, 1, 0);

  // Eraser: scrub back and forth across the middle only (x 270 → 330).
  await page.getByTestId("tool-eraser").click();
  await page.mouse.move(box.x + mid - 30, box.y + ly - 20);
  await page.mouse.down();
  for (let i = 0; i <= 6; i++) {
    await page.mouse.move(box.x + mid - 30 + i * 10, box.y + ly + (i % 2 ? -20 : 20), { steps: 4 });
  }
  await page.mouse.up();

  // Two live pieces either side, one erased (ghost) piece in the middle.
  await expectCounts(page, "ink-canvas", 3, 2, 1);
  // Changed in Phase 8 (backlog "stroke counter"): the counter shows lines the student drew, not
  // stored pieces — one line with its middle rubbed out is "1 stroke · 1 erased part" (it used to
  // read "2 strokes · 1 ghost"). The piece counts above are unchanged.
  await expect(canvas).toHaveAttribute("data-drawn-count", "1");
  await expect(canvas).toHaveAttribute("data-erased-part-count", "1");
  await expect(page.getByTestId("stroke-counter")).toHaveText("1 stroke · 1 erased part");

  // Ghost off: the middle is blank, both ends are still ink.
  await expect(canvas).toHaveAttribute("data-ghost", "off");
  expect(await pixelsAt(page, "ink-canvas", mid, ly, 20, 5)).toEqual({ ink: 0, ghost: 0 });
  expect((await pixelsAt(page, "ink-canvas", lx0 + 30, ly, 10, 4)).ink).toBeGreaterThan(5);
  expect((await pixelsAt(page, "ink-canvas", lx1 - 30, ly, 10, 4)).ink).toBeGreaterThan(5);

  // Ghost on: the rubbed-out middle shows as vermilion ghost ink; the ends stay black.
  await page.getByTestId("ghost-toggle").check();
  await expect(canvas).toHaveAttribute("data-ghost", "on");
  const middle = await pixelsAt(page, "ink-canvas", mid, ly, 20, 5);
  expect(middle.ghost).toBeGreaterThan(10);
  expect(middle.ink).toBe(0);
  const end = await pixelsAt(page, "ink-canvas", lx0 + 30, ly, 10, 4);
  expect(end.ink).toBeGreaterThan(5);
  expect(end.ghost).toBe(0);
  await page.getByTestId("ghost-toggle").uncheck();

  // Persisted: reload shows the same page.
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
  await page.reload();
  await expectCounts(page, "ink-canvas", 3, 2, 1);
  expect(await pixelsAt(page, "ink-canvas", mid, ly, 20, 5)).toEqual({ ink: 0, ghost: 0 });
  expect((await pixelsAt(page, "ink-canvas", lx1 - 30, ly, 10, 4)).ink).toBeGreaterThan(5);

  // Review shows the same counts.
  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  // Phase 8: the "strokes" chip counts lines drawn (1), no longer pieces (3).
  await expect(page.getByTestId("count-strokes")).toHaveText("1");
  await expect(page.getByTestId("count-erased")).toHaveText("1");
  await expectCounts(page, "review-canvas", 3, 2, 1);
  await expect.poll(async () => (await pixelsAt(page, "review-canvas", mid, ly, 20, 5)).ghost).toBeGreaterThan(10);

  // Storage keeps the original stroke (now replaced) and its three pieces.
  const data = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
    strokes: Stroke[];
    eraseEvents: EraseEvent[];
  };
  expect(data.strokes).toHaveLength(4);
  const parent = data.strokes.find((s) => !s.splitFrom)!;
  expect(parent.erased).toBe(false);
  expect(parent.replacedBy).toHaveLength(3);
  expect(parent.inkLen).toBeGreaterThan(350);
  const pieces = data.strokes.filter((s) => s.splitFrom === parent.id);
  expect(pieces.map((p) => p.id).sort()).toEqual([...parent.replacedBy!].sort());
  const live = pieces.filter((p) => !p.erased);
  const ghost = pieces.filter((p) => p.erased);
  expect(live).toHaveLength(2);
  expect(ghost).toHaveLength(1);
  expect(ghost[0].erasedBy).toBe("eraser");
  expect(ghost[0].erasedAtMs).not.toBeNull();
  // The ghost piece spans the scrubbed area (x 270..330 ± eraser radius), not the whole line.
  expect(ghost[0].bbox[0]).toBeGreaterThan(lx0 + 100);
  expect(ghost[0].bbox[2]).toBeLessThan(lx1 - 100);
  const eraserEvents = data.eraseEvents.filter((e) => e.by === "eraser");
  expect(eraserEvents).toHaveLength(1);
  expect(eraserEvents[0].strokeIds).toEqual([ghost[0].id]);
});

test("erasing across a whole stroke leaves no live ink and one ghost stroke", async ({ page, request }) => {
  const { sessionId, box } = await newSession(page);
  const [lx0, lx1, ly] = [120, 320, 160];
  await drawStraight(page, box.x + lx0, box.y + ly, box.x + lx1);
  await expectCounts(page, "ink-canvas", 1, 1, 0);

  await page.getByTestId("tool-eraser").click();
  await page.mouse.move(box.x + lx0 - 30, box.y + ly);
  await page.mouse.down();
  await page.mouse.move(box.x + lx1 + 30, box.y + ly, { steps: 15 });
  await page.mouse.up();

  await expectCounts(page, "ink-canvas", 1, 0, 1);
  expect((await pixelsAt(page, "ink-canvas", (lx0 + lx1) / 2, ly, 90, 5)).ink).toBe(0);

  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
  const data = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as { strokes: Stroke[] };
  expect(data.strokes).toHaveLength(1);
  expect(data.strokes[0].erased).toBe(true);
  expect(data.strokes[0].erasedBy).toBe("eraser");
  expect(data.strokes[0].replacedBy ?? null).toBeNull();
});
