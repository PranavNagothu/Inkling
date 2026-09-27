import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { EraseEvent, Stroke, TimelineData } from "../lib/types";
import { SCENARIO_TIMES, buildPhase2Scenario, buildSteadyScenario } from "./fixtures/phase2-scenario";

// Phase 2: the review page shows a learning timeline computed from the student's writing.

test.use({ viewport: { width: 1180, height: 820 } });

type Build = (sessionId: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] };

async function seedSession(request: APIRequestContext, title: string, build: Build) {
  const created = await request.post("/api/sessions", { data: { title } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const { strokes, eraseEvents } = build(session.id);
  const saved = await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } });
  expect(saved.status()).toBe(200);
  return session.id;
}

async function analyze(request: APIRequestContext, sessionId: string) {
  const res = await request.post(`/api/sessions/${sessionId}/analyze`);
  expect(res.status()).toBe(200);
  return (await res.json()) as TimelineData;
}

/** Number of painted (non-transparent) pixels on a canvas. */
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

const markers = (page: Page, type?: string) =>
  page.locator(type ? `[data-testid="timeline-marker"][data-type="${type}"]` : `[data-testid="timeline-marker"]`);

test("seeded session: corrected + gap markers, detail panel with before/after and reasons", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — seeded", (id) => buildPhase2Scenario(id));
  const analysis = await analyze(request, sessionId);
  expect(analysis.events.map((e) => e.type)).toEqual(["misconception_corrected", "unresolved_gap"]);

  await page.goto(`/review/${sessionId}`);
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("timeline-empty")).toHaveCount(0);

  const corrected = markers(page, "misconception_corrected");
  const gaps = markers(page, "unresolved_gap");
  await expect(corrected).toHaveCount(1);
  await expect(gaps).toHaveCount(1);
  await expect(corrected.first()).toHaveAttribute("data-status", "resolved");
  await expect(gaps.first()).toHaveAttribute("data-status", "open");
  await expect(corrected.first()).toHaveAccessibleName(/Corrected misconception at 02:30/);

  // Summary chips match the markers.
  await expect(page.getByTestId("count-corrected")).toHaveText(String(await corrected.count()));
  await expect(page.getByTestId("count-gaps")).toHaveText(String(await gaps.count()));
  await expect(page.getByTestId("count-breakthroughs")).toHaveText(String(await markers(page, "breakthrough").count()));

  // Markers sit at their lecture time on the 6-minute track.
  const track = (await timeline.boundingBox())!;
  const cBox = (await corrected.first().boundingBox())!;
  const expectedX = track.x + (SCENARIO_TIMES.correctionEraseMs / analysis.durationMs) * track.width;
  expect(Math.abs(cBox.x + cBox.width / 2 - expectedX)).toBeLessThan(3);
  // Touch-friendly hit area.
  expect(cBox.width).toBeGreaterThanOrEqual(44);
  expect(cBox.height).toBeGreaterThanOrEqual(44);

  // Corrected moment → detail with before/after crops of the revision.
  await expect(page.getByTestId("moment-detail")).toHaveCount(0);
  await corrected.first().click();
  const detail = page.getByTestId("moment-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-type", "misconception_corrected");
  await expect(corrected.first()).toHaveAttribute("aria-pressed", "true");
  await expect(detail.getByRole("heading", { name: "Corrected misconception" })).toBeVisible();
  await expect(page.getByTestId("moment-time")).toHaveText("02:30");
  await expect(page.getByTestId("moment-status")).toHaveText("Resolved");
  await expect(page.getByTestId("moment-reasons")).toContainText(/rewrote it 3s later/);
  await expect(page.getByTestId("moment-excerpt")).toContainText(/\w+ \w+ \w+/);
  // Phase 5 replaced the placeholder; this project runs without AI, so the quiet "needs a key" card shows.
  await expect(detail.getByTestId("help-nokey")).toHaveText("AI explanations need an API key — add OPENAI_API_KEY to .env.local");
  await expect.poll(() => paintedPixels(page, "before-canvas")).toBeGreaterThan(40);
  await expect.poll(() => paintedPixels(page, "after-canvas")).toBeGreaterThan(40);
  await expect(page.getByTestId("review-canvas")).toHaveAttribute("data-highlight", "on");
  await page.screenshot({ path: "screenshots/phase2-corrected.png", animations: "disabled" });

  // Gap moment → reasons explain the hesitation; no before/after (nothing was rewritten).
  await gaps.first().click();
  await expect(detail).toHaveAttribute("data-type", "unresolved_gap");
  await expect(page.getByTestId("moment-time")).toHaveText("03:40");
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  const reasons = page.getByTestId("moment-reasons");
  await expect(reasons).toContainText(/paused \d+s while \d+ words were spoken/i);
  await expect(reasons).toContainText(/erased 1×/i);
  await expect(page.getByTestId("before-canvas")).toHaveCount(0);
  await expect(page.getByTestId("review-canvas")).toHaveAttribute("data-highlight", "off");
  await page.screenshot({ path: "screenshots/phase2-gap.png", animations: "disabled" });

  // Escape closes the panel and returns focus to the marker.
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(gaps.first()).toBeFocused();
});

test("keyboard: opening a moment moves focus into its panel; Escape returns it to the marker", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — keyboard", (id) => buildPhase2Scenario(id));
  const analysis = await analyze(request, sessionId);
  const [corrected, gap] = analysis.events;
  const focusInPanel = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return {
        inPanel: !!el?.closest('[data-testid="moment-detail"]'),
        testId: el?.getAttribute("data-testid") ?? null,
        eventId: el?.closest('[data-testid="moment-detail"]')?.getAttribute("data-event-id") ?? null,
      };
    });

  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  const cMarker = markers(page, "misconception_corrected").first();
  const gMarker = markers(page, "unresolved_gap").first();

  // Keyboard-activate a marker: focus lands on the panel's heading.
  await cMarker.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-event-id", corrected.id);
  await expect.poll(focusInPanel).toEqual({ inPanel: true, testId: "moment-title", eventId: corrected.id });
  await expect(page.getByTestId("moment-title")).toBeFocused();

  // Switching to another marker (Space this time) moves focus into the new panel.
  await gMarker.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-event-id", gap.id);
  await expect.poll(focusInPanel).toEqual({ inPanel: true, testId: "moment-title", eventId: gap.id });

  // Escape closes it and focus goes back to the marker that opened it.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("moment-detail")).toHaveCount(0);
  await expect(gMarker).toBeFocused();

  // The close button does the same.
  await page.keyboard.press("Enter");
  await expect.poll(focusInPanel).toEqual({ inPanel: true, testId: "moment-title", eventId: gap.id });
  await page.getByRole("button", { name: "Close moment details" }).press("Enter");
  await expect(page.getByTestId("moment-detail")).toHaveCount(0);
  await expect(gMarker).toBeFocused();

  // A deep link (?moment=) opens the panel with focus already in it; Escape → its marker.
  await page.goto(`/review/${sessionId}?moment=${encodeURIComponent(corrected.id)}`);
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-event-id", corrected.id);
  await expect.poll(focusInPanel).toEqual({ inPanel: true, testId: "moment-title", eventId: corrected.id });
  await page.keyboard.press("Escape");
  await expect(markers(page, "misconception_corrected").first()).toBeFocused();
});

test("touch-action: the review canvas lets a finger scroll and zoom; the note canvas does not", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — touch", (id) => buildPhase2Scenario(id));
  const touchAction = (testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).touchAction);

  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("review-canvas")).toBeVisible();
  expect(await touchAction("review-canvas")).toBe("manipulation");

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId("ink-canvas")).toBeVisible();
  expect(await touchAction("ink-canvas")).toBe("none");
});

test("draw → erase part → rewrite over it → End session shows a corrected moment", async ({ page }) => {
  await page.goto("/app");
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];

  // Lecture clock must run so the erase happens a few seconds after the ink was written
  // (erasing ink that is < 3 s old counts as a slip of the pen, not a correction).
  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-state", "playing");

  const box = (await page.getByTestId("ink-canvas").boundingBox())!;
  const y = box.y + 200;
  const wavy = async (x0: number, x1: number, amp: number) => {
    await page.mouse.move(x0, y);
    await page.mouse.down();
    const steps = 24;
    for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y + amp * Math.sin(i * 1.3));
    await page.mouse.up();
  };

  await wavy(box.x + 100, box.x + 400, 4);
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-stroke-count", "1");
  await page.waitForTimeout(4000);

  // Scrub out the middle of the stroke.
  await page.getByTestId("tool-eraser").click();
  const mid = box.x + 250;
  await page.mouse.move(mid - 30, y - 20);
  await page.mouse.down();
  for (let i = 0; i <= 6; i++) await page.mouse.move(mid - 30 + i * 10, y + (i % 2 ? -20 : 20), { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-erased-count", "1");

  // Rewrite over the erased spot.
  await page.getByTestId("tool-pen").click();
  await wavy(mid - 30, mid + 35, 6);
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-visible-count", "3");

  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  const corrected = markers(page, "misconception_corrected");
  await expect(corrected).toHaveCount(1);
  await expect(page.getByTestId("count-corrected")).toHaveText("1");

  await corrected.first().click();
  await expect(page.getByTestId("moment-detail")).toBeVisible();
  await expect.poll(() => paintedPixels(page, "before-canvas")).toBeGreaterThan(40);
  await expect.poll(() => paintedPixels(page, "after-canvas")).toBeGreaterThan(40);
});

test("a calm session shows the empty state (analysed on open)", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Calm notes", (id) => buildSteadyScenario(id));
  const before = await (await request.get(`/api/sessions/${sessionId}/timeline`)).json();
  expect(before.analyzed).toBe(false);

  // Opened without an analysis (e.g. from the home list): the page runs it.
  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("timeline-empty")).toBeVisible();
  await expect(markers(page)).toHaveCount(0);
  await expect(page.getByTestId("count-corrected")).toHaveText("0");
  await expect(page.getByTestId("count-gaps")).toHaveText("0");
  await expect(page.getByTestId("count-breakthroughs")).toHaveText("0");

  const after = await (await request.get(`/api/sessions/${sessionId}/timeline`)).json();
  expect(after).toMatchObject({ analyzed: true, stale: false, events: [] });
});

test.describe("analysis API", () => {
  test("404 for unknown sessions", async ({ request }) => {
    expect((await request.post("/api/sessions/does-not-exist/analyze")).status()).toBe(404);
    expect((await request.get("/api/sessions/does-not-exist/timeline")).status()).toBe(404);
  });

  test("re-analysis is idempotent and the timeline endpoint returns what was stored", async ({ request }) => {
    const sessionId = await seedSession(request, "Idempotent", (id) => buildPhase2Scenario(id));
    const first = await analyze(request, sessionId);
    const second = await analyze(request, sessionId);
    expect(first.events.length).toBeGreaterThan(0);
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(second.revisions.map((r) => r.id)).toEqual(first.revisions.map((r) => r.id));
    expect(second.windows).toHaveLength(first.windows.length);

    const stored = await (await request.get(`/api/sessions/${sessionId}/timeline`)).json();
    expect(stored.analyzed).toBe(true);
    expect(stored.stale).toBe(false);
    expect(stored.events).toEqual(second.events);
    expect(stored.revisions).toEqual(second.revisions);
    expect(stored.windows).toEqual(second.windows);
  });
});
