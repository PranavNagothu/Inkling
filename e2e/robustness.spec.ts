import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { EraseEvent, Stroke, TimelineData } from "../lib/types";
import { buildPhase2Scenario, buildSteadyScenario } from "./fixtures/phase2-scenario";

// Hardening: autosave failures, End session errors, cross-site / oversized requests, media errors,
// and the baseline zone following the student's own writing.

test.use({ viewport: { width: 1180, height: 820 } });

const STROKES_ROUTE = "**/api/sessions/*/strokes";
const EVIL = { Origin: "http://evil.example" };

async function newSession(page: Page) {
  await page.goto("/app");
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  await expect(page.getByTestId("ink-canvas")).toBeVisible();
  return page.url().split("/session/")[1];
}

async function drawLine(page: Page, dy = 0) {
  const box = (await page.getByTestId("ink-canvas").boundingBox())!;
  const y = box.y + 120 + dy;
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 60 + i * 20, y + Math.sin(i) * 3);
  await page.mouse.up();
}

async function storedStrokes(request: APIRequestContext, sessionId: string) {
  return ((await (await request.get(`/api/sessions/${sessionId}`)).json()) as { strokes: Stroke[] }).strokes;
}

async function seedSession(
  request: APIRequestContext,
  title: string,
  build: (id: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] },
) {
  const created = await request.post("/api/sessions", { data: { title } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const { strokes, eraseEvents } = build(session.id);
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);
  return session.id;
}

test.describe("autosave", () => {
  test("a 500 is retried and the page ends up Saved", async ({ page, request }) => {
    const sessionId = await newSession(page);
    let calls = 0;
    await page.route(STROKES_ROUTE, async (route) => {
      calls++;
      if (calls === 1) await route.fulfill({ status: 500, json: { error: "boom" } });
      else await route.continue();
    });
    await drawLine(page);
    const status = page.getByTestId("save-status");
    await expect(status).toHaveText("Save failed — retrying", { timeout: 10_000 });
    await expect(status).toHaveAttribute("data-status", "retrying");
    await expect(status).toHaveText("Saved", { timeout: 15_000 });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await storedStrokes(request, sessionId)).toHaveLength(1);
  });

  test("a 400 is reported once, not retried forever", async ({ page }) => {
    await newSession(page);
    let calls = 0;
    await page.route(STROKES_ROUTE, async (route) => {
      calls++;
      await route.fulfill({ status: 400, json: { error: "invalid stroke at index 0" } });
    });
    await drawLine(page);
    const status = page.getByTestId("save-status");
    await expect(status).toHaveText("Some ink couldn’t be saved", { timeout: 10_000 });
    await expect(status).toHaveAttribute("data-status", "rejected");
    const after = calls;
    expect(after).toBe(1);
    // Several autosave ticks later: no more requests, and never "retrying".
    await page.waitForTimeout(5000);
    expect(calls).toBe(after);
    await expect(status).toHaveText("Some ink couldn’t be saved");
  });
});

test("End session with a failing save shows an alert with Retry and stays on the page", async ({ page, request }) => {
  const sessionId = await newSession(page);
  await page.route(STROKES_ROUTE, (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await drawLine(page);
  await page.getByTestId("end-session").click();

  const alert = page.getByTestId("end-session-error");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toHaveAttribute("role", "alert");
  await expect(alert).toContainText("Couldn’t save your notes");
  expect(page.url()).toMatch(new RegExp(`/session/${sessionId}$`));
  // Nothing was reset: the ink is still on the page.
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-stroke-count", "1");
  await expect(page.getByTestId("end-session")).toBeEnabled();

  // The server recovers: Retry saves and ends the session.
  await page.unroute(STROKES_ROUTE);
  await page.getByTestId("end-session-retry").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  expect(await storedStrokes(request, sessionId)).toHaveLength(1);
});

test("End session logs a failed analysis and still opens the review (which analyses itself)", async ({ page }) => {
  const sessionId = await newSession(page);
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  await drawLine(page);
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
  await page.route("**/api/sessions/*/analyze", (route) => route.fulfill({ status: 500, json: { error: "x" } }), {
    times: 1,
  });
  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  expect(errors.some((e) => e.includes(`Analysis failed for session ${sessionId}`))).toBe(true);
});

test.describe("API guards", () => {
  test("cross-site POSTs get 403 on every mutating route and change nothing", async ({ request }) => {
    const sessionId = await seedSession(request, "Guarded", (id) => buildSteadyScenario(id, 2));
    const sessionsBefore = ((await (await request.get("/api/sessions")).json()) as { sessions: unknown[] }).sessions.length;

    const attempts = [
      request.post("/api/sessions", { data: { title: "evil" }, headers: EVIL }),
      request.post(`/api/sessions/${sessionId}/strokes`, {
        data: { strokes: buildSteadyScenario(sessionId, 5).strokes, eraseEvents: [] },
        headers: EVIL,
      }),
      request.post(`/api/sessions/${sessionId}/analyze`, { headers: EVIL }),
      request.post("/api/lectures", { multipart: { title: "evil" }, headers: EVIL }),
      request.post("/api/lectures/demo-chain-rule/transcribe", { headers: EVIL }),
      request.post("/api/events/any-moment/resolve", { data: { action: "self" }, headers: EVIL }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status(), res.url()).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/cross-site/i);
    }

    const sessionsAfter = ((await (await request.get("/api/sessions")).json()) as { sessions: unknown[] }).sessions.length;
    expect(sessionsAfter).toBe(sessionsBefore);
    expect(await storedStrokes(request, sessionId)).toHaveLength(2);
    const timeline = await (await request.get(`/api/sessions/${sessionId}/timeline`)).json();
    expect(timeline.analyzed).toBe(false);
  });

  test("same-origin requests (what the app's own fetch and sendBeacon send) are allowed", async ({ request, baseURL }) => {
    const res = await request.post("/api/sessions", { data: { title: "same origin" }, headers: { Origin: baseURL! } });
    expect(res.status()).toBe(201);
  });

  test("oversized bodies get 413 before they are parsed", async ({ request }) => {
    const sessionId = await seedSession(request, "Big body", (id) => buildSteadyScenario(id, 1));
    const huge = JSON.stringify({ strokes: [], eraseEvents: [], pad: "x".repeat(5 * 1024 * 1024) });
    const strokes = await request.post(`/api/sessions/${sessionId}/strokes`, {
      data: huge,
      headers: { "Content-Type": "application/json" },
    });
    expect(strokes.status()).toBe(413);

    const sessions = await request.post("/api/sessions", {
      data: JSON.stringify({ title: "t", pad: "x".repeat(64 * 1024) }),
      headers: { "Content-Type": "application/json" },
    });
    expect(sessions.status()).toBe(413);
    // Normal-size bodies still work.
    expect((await request.post("/api/sessions", { data: { title: "small" } })).status()).toBe(201);
  });
});

test("a lecture whose media fails to load shows a banner, and Replay explains it can't play", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Broken media", (id) => buildPhase2Scenario(id));
  await page.route("**/api/lectures/*/media", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto(`/review/${sessionId}`);

  const banner = page.getByTestId("media-error");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(banner).toContainText("Couldn’t load this lecture’s audio");

  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await page.locator('[data-testid="timeline-marker"]').first().click();
  await page.getByTestId("replay").click();
  const replayError = page.getByTestId("replay-error");
  await expect(replayError).toBeVisible();
  await expect(replayError).toContainText("Couldn’t play this part of the lecture");
  await expect(page.getByTestId("replay")).toHaveAttribute("data-replay-state", "error");
  // Non-blocking: the rest of the review still works.
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("moment-detail")).toBeVisible();
});

test.describe("baseline zone", () => {
  const zone = (page: Page) => page.getByTestId("timeline-baseline");

  test("covers the first two minutes of writing for a session that starts at the beginning", async ({ page, request }) => {
    const sessionId = await seedSession(request, "Baseline from start", (id) => buildPhase2Scenario(id));
    await page.goto(`/review/${sessionId}`);
    await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
    await expect(zone(page)).toHaveCount(1);
    await expect(zone(page)).toHaveAttribute("data-start-ms", "0");
    await expect(zone(page)).toHaveAttribute("data-end-ms", "120000");
  });

  test("follows a student who starts writing three minutes in", async ({ page, request }) => {
    const shift = 180_000;
    const sessionId = await seedSession(request, "Late start", (id) => {
      const { strokes } = buildSteadyScenario(id, 60);
      return {
        strokes: strokes.map((s) => ({
          ...s,
          startMs: s.startMs + shift,
          endMs: s.endMs + shift,
          points: s.points.map(([x, y, p, t]) => [x, y, p, t + shift] as Stroke["points"][number]),
        })),
        eraseEvents: [],
      };
    });
    const analysis = (await (await request.post(`/api/sessions/${sessionId}/analyze`)).json()) as TimelineData;
    expect(analysis.baseline).toEqual([{ startMs: 180_000, endMs: 300_000 }]);

    await page.goto(`/review/${sessionId}`);
    await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
    await expect(zone(page)).toHaveAttribute("data-start-ms", "180000");
    await expect(zone(page)).toHaveAttribute("data-end-ms", "300000");
    // Drawn where it is on the 6-minute track (half-way to 5:00), not at the start.
    const track = (await page.getByTestId("timeline").boundingBox())!;
    const box = (await zone(page).boundingBox())!;
    expect(Math.abs(box.x - (track.x + (180_000 / analysis.durationMs) * track.width))).toBeLessThan(3);
    expect(Math.abs(box.width - (120_000 / analysis.durationMs) * track.width)).toBeLessThan(3);
  });
});
