import { expect, test, type Page } from "@playwright/test";

// Phase 8 — demo-proof. The whole two-minute demo against the production build (`npm run demo`:
// next start, DEMO_MODE=1) on a freshly seeded database (`npm run seed:demo -- --reset`), with every
// non-localhost request blocked. Nothing may try to reach the network, and nothing may log an error.
// Screenshots of each stop land in screenshots/demo-*.png.

test.use({ viewport: { width: 1180, height: 820 } });

const S1 = "demo-maya-1";
const S2 = "demo-maya-2";

const isLocal = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
};

const marker = (page: Page, type: string) => page.locator(`[data-testid="timeline-marker"][data-type="${type}"]`);

/** Scrolls the moment panel (not the page) so `testId` sits near the bottom of the viewport. */
async function showInPanel(page: Page, testId: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('aside[aria-label="Moment details"]').evaluate((aside, id) => {
    const el = aside.querySelector(`[data-testid="${id}"]`);
    if (el) aside.scrollTop += el.getBoundingClientRect().bottom - (window.innerHeight - 16);
  }, testId);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `screenshots/${name}.png`, animations: "disabled" });

test("the two-minute demo runs end to end, offline, with no errors", async ({ page, context }) => {
  test.setTimeout(180_000);
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    if (!isLocal(r.url())) external.push(r.url());
  });
  await context.route((url) => !isLocal(url.toString()), (route) => route.abort("internetdisconnected"));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  // 1. Home: Maya's two sessions (classmates only feed the class hotspots), with stroke counts.
  await page.goto("/app");
  const rows = page.getByTestId("session-link");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Maya — Session 2");
  await expect(rows.nth(1)).toContainText("Maya — Session 1");
  await expect(page.locator(`a[href="/session/${S1}"] [data-testid="session-stroke-count"]`)).toContainText(/\d+ strokes/);
  await expect(page.getByTestId("open-gaps-count")).toHaveText("0");
  await shot(page, "demo-01-home");

  // 2. Session 1 review: a breakthrough already earned, the correction, the gap.
  await page.getByRole("link", { name: "Review Maya — Session 1" }).click();
  await page.waitForURL(new RegExp(`/review/${S1}$`));
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("count-breakthroughs")).toHaveText("1");
  await expect(page.getByTestId("count-corrected")).toHaveText("1");
  await expect(page.getByTestId("count-gaps")).toHaveText("1");

  // 3. The correction: before/after, the AI reading, the help card — then the right answer.
  await marker(page, "misconception_corrected").click();
  const detail = page.getByTestId("moment-detail");
  await expect(detail).toHaveAttribute("data-type", "misconception_corrected");
  await expect(page.getByTestId("moment-time")).toHaveText("01:40");
  await expect(page.getByTestId("before-canvas")).toBeVisible();
  await expect(page.getByTestId("after-canvas")).toBeVisible();
  await expect(page.getByTestId("revision-misconception")).toContainText("inner derivative");
  await expect(page.getByTestId("revision-before")).toContainText("cos(x^2)");
  await expect(page.getByTestId("help-source")).toHaveAttribute("data-source", "demo");
  await expect(page.getByTestId("help-reexplain")).toContainText("inner derivative");
  await expect(page.getByTestId("check-option")).toHaveCount(4);
  await showInPanel(page, "revision-reading");
  await shot(page, "demo-02-review-correction");
  await showInPanel(page, "check-submit");
  await shot(page, "demo-03-help-card");

  await page.getByTestId("check-option").filter({ hasText: "2x cos(x^2)" }).click();
  await page.getByTestId("check-submit").click();
  await expect(page.getByTestId("check-feedback")).toHaveAttribute("data-result", "correct");
  await expect(page.getByTestId("check-feedback")).toContainText("Breakthrough!");
  await expect(detail).toHaveAttribute("data-type", "breakthrough");
  await expect(page.getByTestId("count-breakthroughs")).toHaveText("2");
  await expect(page.getByTestId("count-corrected")).toHaveText("0");
  await showInPanel(page, "check-feedback");
  await shot(page, "demo-04-breakthrough");

  // 4. The gap: resolved later, in Session 2. Replay 20 s plays the lecture at that moment.
  await marker(page, "unresolved_gap").click();
  await expect(detail).toHaveAttribute("data-type", "unresolved_gap");
  await expect(page.getByTestId("moment-status")).toContainText("Resolved");
  await expect(page.getByTestId("moment-history")).toContainText(/resolved/i);
  await expect(page.getByTestId("help-source")).toHaveAttribute("data-source", "demo");
  const replay = page.getByTestId("replay");
  await expect(replay).toHaveText("Replay 20s");
  await replay.click();
  await expect(replay).toHaveAttribute("data-replay-state", "playing");
  await page.waitForTimeout(1200);
  await showInPanel(page, "replay");
  await shot(page, "demo-05-gap-replay");
  await replay.click();
  await expect(replay).not.toHaveAttribute("data-replay-state", "playing");

  // 5. Compare with Notability: the exported final page vs the process it hides.
  await page.getByTestId("compare-link").click();
  await page.waitForURL(new RegExp(`/compare/${S1}$`));
  await expect(page.getByTestId("notability-pdf-canvas")).toBeVisible();
  await expect(page.getByTestId("hidden-breakthroughs")).toHaveText("2");
  await expect(page.getByTestId("hidden-gaps")).toHaveText("1");
  await page.getByTestId("mode-overlay").click();
  await expect(page.getByTestId("compare-mode")).toHaveAttribute("data-mode", "overlay");
  await expect(page.getByTestId("overlay-process")).toBeVisible();
  // The PDF really painted (not a blank canvas).
  await expect
    .poll(() =>
      page.getByTestId("notability-pdf-canvas").evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
        return dark;
      }),
    )
    .toBeGreaterThan(500);
  await shot(page, "demo-06-compare-overlay");

  // 6. Progress: the gap resolved in Session 2 by writing it through; class hotspots from the DB.
  await page.goto("/progress");
  const thread = page.getByTestId("progress-thread");
  await expect(thread).toHaveCount(1);
  await expect(thread).toHaveAttribute("data-status", "resolved");
  await expect(thread).toHaveAttribute("data-resolved-by", "revisit");
  await expect(page.getByTestId("progress-thread-label")).toHaveText("Chain versus product rule");
  const hotspots = page.getByTestId("hotspots");
  await expect(hotspots).toBeVisible();
  await expect(hotspots).toContainText("Where the class slowed down");
  const peak = Number(await hotspots.getAttribute("data-peak-ms"));
  expect([90_000, 240_000, 330_000]).toContain(peak);
  await shot(page, "demo-07-progress-hotspots");

  // 7. Capture with the live hesitation meter (looked at, never written on): Session 2 reads steady;
  // Session 1 with the lecture at 04:24 — right after the slow, erased attempt — reads hesitating.
  await page.goto(`/session/${S2}`);
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-drawn-count", /^[1-9]\d*$/);
  const meter = page.getByTestId("hesitation-meter");
  await expect(meter).toHaveAttribute("data-state", "steady");
  await page.goto(`/session/${S1}`);
  await expect(meter).toHaveAttribute("data-state", "steady");
  await page.locator("audio").evaluate((a) => {
    (a as HTMLAudioElement).currentTime = 264;
  });
  await expect(meter).toHaveAttribute("data-state", "stuck");
  await expect(meter).toHaveAttribute("aria-valuetext", /Hesitating.*slower/);
  await shot(page, "demo-08-capture-meter");

  // 8. About: backend, AI mode, voice and the lecture note — no secrets.
  await page.goto("/about");
  await expect(page.getByTestId("about-backend")).toHaveAttribute("data-backend", /^(sqlite|postgres)$/);
  await expect(page.getByTestId("about-ai")).toHaveAttribute("data-mode", "demo");
  await expect(page.getByTestId("about-mode")).toHaveAttribute("data-demo", "true");
  await expect(page.getByTestId("about-voice")).toHaveAttribute("data-kind", "browser");
  await expect(page.getByTestId("about-attribution").first()).toHaveAttribute("data-kind", "demo");
  await expect(page.getByTestId("about-page")).not.toContainText(/sk-|postgres:\/\/|api_key/i);
  await shot(page, "demo-09-about");

  expect(external, "requests that tried to leave localhost").toEqual([]);
  expect(errors, "console errors").toEqual([]);
});

test("the health check and home page answer on the demo server", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });
  const home = await request.get("/app");
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain("Maya — Session 1");
});
