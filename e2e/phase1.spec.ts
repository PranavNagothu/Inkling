import { expect, test, type Page } from "@playwright/test";
import type { EraseEvent, Session, Stroke } from "../lib/types";

async function canvasBox(page: Page, testId = "ink-canvas") {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  return box;
}

/** Draws a horizontal stroke with several intermediate moves. */
async function drawLine(page: Page, x0: number, y: number, x1: number) {
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y + Math.sin(i) * 3);
  }
  await page.mouse.up();
}

/** Counts teal ghost-ink pixels (#0d9488 at 40 %; never ink, never the sky-blue moment outline) on a canvas. */
async function ghostPixelCount(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a > 20 && r < 100 && g > 110 && b < g + 8 && g - r > 60) n++;
    }
    return n;
  });
}

test("home page shows title and tagline", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Inkling" })).toBeVisible();
  await expect(page.getByTestId("tagline")).toHaveText("Every other app deletes your mistakes. We keep them.");
  await expect(page.getByTestId("new-session")).toBeVisible();
});

test("full capture → erase → save → review flow persists ghost ink", async ({ page, request }) => {
  // 1. New session
  await page.goto("/app");
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];
  expect(sessionId).toBeTruthy();
  await expect(page.getByTestId("ink-canvas")).toBeVisible();

  // 2. Lecture plays and the clock advances
  await expect(page.getByTestId("lecture-time")).toHaveText("00:00");
  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-state", "playing");
  await expect(page.getByTestId("lecture-time")).not.toHaveText("00:00", { timeout: 10_000 });

  // 3. Draw three strokes
  const box = await canvasBox(page);
  const x0 = box.x + 60;
  const x1 = box.x + 320;
  const ys = [box.y + 80, box.y + 160, box.y + 240];
  for (const y of ys) await drawLine(page, x0, y, x1);
  const canvas = page.getByTestId("ink-canvas");
  await expect(canvas).toHaveAttribute("data-stroke-count", "3");
  await expect(canvas).toHaveAttribute("data-visible-count", "3");

  // 4. Erase the middle stroke (vertical swipe that only crosses y=160)
  await page.getByTestId("tool-eraser").click();
  await expect(canvas).toHaveAttribute("data-tool", "eraser");
  const ex = box.x + 190;
  await page.mouse.move(ex, ys[1] - 25);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(ex, ys[1] - 25 + i * 5);
  await page.mouse.up();
  // Partial erase: only the rubbed-over part of the middle stroke goes. It is cut into a live left
  // piece, an erased (ghost) middle piece and a live right piece, so the page now holds
  // 2 untouched strokes + 3 pieces = 5 active strokes, 4 of them live.
  await expect(canvas).toHaveAttribute("data-visible-count", "4");
  await expect(canvas).toHaveAttribute("data-stroke-count", "5");
  await expect(canvas).toHaveAttribute("data-erased-count", "1");

  // Ghost toggle on the capture page shows erased ink in red
  expect(await ghostPixelCount(page, "ink-canvas")).toBe(0);
  await page.getByTestId("ghost-toggle").check();
  await expect(canvas).toHaveAttribute("data-ghost", "on");
  expect(await ghostPixelCount(page, "ink-canvas")).toBeGreaterThan(20);
  await page.getByTestId("ghost-toggle").uncheck();
  await page.getByTestId("tool-pen").click();

  // 5. Autosave
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });

  // 6. API reflects saved data
  const res = await request.get(`/api/sessions/${sessionId}`);
  expect(res.status()).toBe(200);
  const data = (await res.json()) as { session: Session; strokes: Stroke[]; eraseEvents: EraseEvent[] };
  expect(data.session.id).toBe(sessionId);
  expect(data.session.lectureId).toBe("demo-chain-rule");
  // Nothing is deleted: the 3 drawn strokes are all stored (the cut one kept for history) plus its 3 pieces.
  expect(data.strokes).toHaveLength(6);
  const drawn = data.strokes.filter((s) => !s.splitFrom);
  expect(drawn).toHaveLength(3);
  const erased = data.strokes.filter((s) => s.erased);
  expect(erased).toHaveLength(1);
  expect(erased[0].erasedBy).toBe("eraser");
  expect(erased[0].erasedAtMs).not.toBeNull();
  expect(data.eraseEvents.length).toBeGreaterThanOrEqual(1);
  expect(data.eraseEvents[0].strokeIds).toContain(erased[0].id);
  for (const s of drawn) {
    expect(s.points.length).toBeGreaterThan(5);
    expect(s.points[0]).toHaveLength(4);
    expect(s.pointerType).toBe("mouse");
    expect(s.startMs).toBeGreaterThan(0); // stamped with lecture time while playing
    expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
    expect(s.inkLen).toBeGreaterThan(200);
  }
  // The cut one is the middle stroke; the erased piece came from it
  const middle = drawn.find((s) => Math.abs(s.bbox[1] - (ys[1] - box.y)) < 10)!;
  expect(middle.erased).toBe(false);
  expect(middle.replacedBy).toHaveLength(3);
  expect(erased[0].splitFrom).toBe(middle.id);

  // 7. Reload shows persisted strokes
  await page.reload();
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-stroke-count", "5");
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-visible-count", "4");

  // 8. End session → review
  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  // Phase 8: the "strokes" chip counts the 3 lines drawn (it used to count the 5 pieces on the page).
  await expect(page.getByTestId("count-strokes")).toHaveText("3");
  await expect(page.getByTestId("count-erased")).toHaveText("1");
  const events = Number(await page.getByTestId("count-erase-events").textContent());
  expect(events).toBeGreaterThanOrEqual(1);
  // Phase 2 replaced the timeline placeholder with the real timeline. This session is short (all
  // of its writing is the student's 120 s scoring baseline) and its erase was never rewritten, so
  // nothing is flagged.
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("timeline-empty")).toBeVisible();

  // 9. Ghost toggle on review changes rendering
  const review = page.getByTestId("review-canvas");
  await expect(review).toHaveAttribute("data-stroke-count", "5");
  await expect(review).toHaveAttribute("data-ghost", "on");
  await expect.poll(() => ghostPixelCount(page, "review-canvas")).toBeGreaterThan(20);
  await page.getByTestId("ghost-toggle").uncheck();
  await expect(review).toHaveAttribute("data-ghost", "off");
  await expect.poll(() => ghostPixelCount(page, "review-canvas")).toBe(0);
});

test("undo marks the last stroke erased with erasedBy=undo", async ({ page, request }) => {
  await page.goto("/app");
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];
  const box = await canvasBox(page);
  await drawLine(page, box.x + 40, box.y + 60, box.x + 200);
  await drawLine(page, box.x + 40, box.y + 120, box.x + 200);
  await page.getByTestId("undo").click();
  const canvas = page.getByTestId("ink-canvas");
  await expect(canvas).toHaveAttribute("data-stroke-count", "2");
  await expect(canvas).toHaveAttribute("data-visible-count", "1");
  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  // The undone stroke is stored (erasedBy=undo, below) but an Undo takes ink back rather than
  // erasing it, so it is not in "erased · kept as ghost" (same rule as isErasedPart / the drawn count).
  await expect(page.getByTestId("count-erased")).toHaveText("0");
  await expect(page.getByTestId("count-strokes")).toHaveText("1");

  const data = await (await request.get(`/api/sessions/${sessionId}`)).json();
  const undone = (data.strokes as Stroke[]).find((s) => s.erased)!;
  expect(undone.erasedBy).toBe("undo");
  expect((data.eraseEvents as EraseEvent[]).some((e) => e.by === "undo" && e.strokeIds.includes(undone.id))).toBe(true);
  // Undone stroke is the second (lower) one
  expect(undone.bbox[1]).toBeGreaterThan(100);
});

test.describe("API", () => {
  test("creates and lists sessions", async ({ request }) => {
    const res = await request.post("/api/sessions", { data: { title: "API test session" } });
    expect(res.status()).toBe(201);
    const { session } = (await res.json()) as { session: Session };
    expect(session.title).toBe("API test session");
    const list = await (await request.get("/api/sessions")).json();
    expect((list.sessions as Session[]).some((s) => s.id === session.id)).toBe(true);
  });

  test("returns 400 for bad payloads", async ({ request }) => {
    const { session } = await (await request.post("/api/sessions", { data: {} })).json();
    const url = `/api/sessions/${session.id}/strokes`;
    expect((await request.post(url, { data: { strokes: "nope" } })).status()).toBe(400);
    expect((await request.post(url, { data: { strokes: [{ id: "x" }] } })).status()).toBe(400);
    expect(
      (await request.post(url, { data: "not json{", headers: { "Content-Type": "application/json" } })).status(),
    ).toBe(400);
    expect((await request.post("/api/sessions", { data: { title: 42 } })).status()).toBe(400);
  });

  test("returns 404 for unknown sessions", async ({ request }) => {
    expect((await request.get("/api/sessions/does-not-exist")).status()).toBe(404);
    expect(
      (await request.post("/api/sessions/does-not-exist/strokes", { data: { strokes: [], eraseEvents: [] } })).status(),
    ).toBe(404);
  });

  test("stroke upsert is idempotent by id", async ({ request }) => {
    const { session } = await (await request.post("/api/sessions", { data: {} })).json();
    const stroke: Stroke = {
      id: "k_idem_1",
      sessionId: session.id,
      startMs: 1000,
      endMs: 1100,
      points: [
        [10, 10, 0.5, 1000],
        [20, 12, 0.5, 1050],
        [30, 14, 0.5, 1100],
      ],
      pointerType: "mouse",
      bbox: [10, 10, 30, 14],
      inkLen: 20.4,
      medianSpeed: 0.2,
      erased: false,
      erasedAtMs: null,
      erasedBy: null,
      isScribble: false,
    };
    const url = `/api/sessions/${session.id}/strokes`;
    expect((await request.post(url, { data: { strokes: [stroke], eraseEvents: [] } })).status()).toBe(200);
    const erasedStroke = { ...stroke, erased: true, erasedAtMs: 2000, erasedBy: "eraser" };
    const ev: EraseEvent = { id: "e_idem_1", sessionId: session.id, atMs: 2000, strokeIds: [stroke.id], by: "eraser" };
    expect((await request.post(url, { data: { strokes: [erasedStroke], eraseEvents: [ev] } })).status()).toBe(200);
    expect((await request.post(url, { data: { strokes: [erasedStroke], eraseEvents: [ev] } })).status()).toBe(200);
    const data = await (await request.get(`/api/sessions/${session.id}`)).json();
    expect(data.strokes).toHaveLength(1);
    expect(data.strokes[0].erased).toBe(true);
    expect(data.eraseEvents).toHaveLength(1);
  });
});
