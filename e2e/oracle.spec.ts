import { expect, test, type APIRequestContext } from "@playwright/test";
import { buildMayaSession1 } from "../lib/demoScenario";
import type { TimelineData } from "../lib/types";

// Oracle of the Deep: the Signal Lab (per-window hesitation signals behind every flagged moment)
// and the model evaluation (precision / recall against the labeled demo set, with a threshold sweep).
// The seeded Maya scenario is stored through the API and analysed by the app's own pipeline.

test.use({ viewport: { width: 1180, height: 820 } });

async function seedMaya(request: APIRequestContext, title: string) {
  const created = await request.post("/api/sessions", { data: { title } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const { strokes, eraseEvents } = buildMayaSession1(session.id);
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);
  const analyzed = await request.post(`/api/sessions/${session.id}/analyze`);
  expect(analyzed.status()).toBe(200);
  return { sessionId: session.id, analysis: (await analyzed.json()) as TimelineData };
}

test("signal lab: chart with a spike, tooltip reasons, and the spike opens its review moment", async ({ page, request }) => {
  const { sessionId, analysis } = await seedMaya(request, "Maya — Signal Lab");
  const gap = analysis.events.find((e) => e.type === "unresolved_gap");
  expect(gap, "the scenario's product-vs-chain gap").toBeDefined();

  // The JSON behind the chart.
  const api = await request.get(`/api/sessions/${sessionId}/insights`);
  expect(api.status()).toBe(200);
  const data = (await api.json()) as { spikeCount: number; points: Array<{ isSpike: boolean; eventId: string | null }> };
  expect(data.spikeCount).toBeGreaterThanOrEqual(1);
  expect(data.points.find((p) => p.isSpike)?.eventId).toBe(gap!.id);

  await page.goto(`/insights/${sessionId}`);
  await expect(page.getByTestId("signal-lab")).toBeVisible();
  const chart = page.getByTestId("signal-chart");
  await expect(chart).toBeVisible();
  await expect(page.getByTestId("signal-strip")).toHaveCount(4);
  await expect(page.getByTestId("signal-baseline").first()).toBeAttached();
  await expect(page.getByTestId("signal-event-marker")).toHaveCount(analysis.events.length);
  await expect(page.getByTestId("signal-legend")).toContainText("How Inkling decides you were stuck");

  const spikes = page.getByTestId("signal-spike");
  expect(await spikes.count()).toBeGreaterThanOrEqual(1);
  const spike = spikes.first();
  await expect(spike).toHaveAttribute("data-event-id", gap!.id);
  await expect(spike).toHaveAccessibleName(/Spike at \d\d:\d\d, score 0\.\d\d/);

  // Hover → tooltip with the window's feature values and the reasons it was flagged.
  await spike.hover();
  const tip = page.getByTestId("signal-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Spike");
  await expect(tip).toContainText("Slowdown");
  const reasons = page.getByTestId("signal-tooltip-reason");
  expect(await reasons.count()).toBeGreaterThanOrEqual(2);
  await expect(reasons.first()).toContainText(/paused|slower|erased/);

  // Keyboard: the plot is one tab stop; arrows step through windows and the tooltip follows.
  await page.mouse.move(5, 5);
  await chart.getByRole("group").focus();
  await page.keyboard.press("Home");
  await expect(tip).toHaveAttribute("data-start-ms", "0");
  await page.keyboard.press("ArrowRight");
  await expect(tip).toHaveAttribute("data-start-ms", "10000");

  // A screen-reader table carries every scored window.
  await expect(page.getByTestId("signal-table").locator("tbody tr")).not.toHaveCount(0);

  // Click the spike → the review page opens on that moment.
  await spike.click();
  await page.waitForURL((url) => url.pathname === `/review/${sessionId}` && url.searchParams.get("moment") === gap!.id);
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-type", "unresolved_gap");
});

test("progress and about link to the Signal Lab and the model evaluation", async ({ page, request }) => {
  const { sessionId } = await seedMaya(request, "Maya — links");
  await page.goto("/progress");
  const link = page.locator(`[data-testid="progress-signal-lab"][data-session-id="${sessionId}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(new RegExp(`/insights/${sessionId}$`));
  await expect(page.getByTestId("signal-lab")).toBeVisible();

  await page.goto("/about");
  await page.getByTestId("about-evaluation").click();
  await page.waitForURL(/\/insights\/evaluation$/);
  await expect(page.getByTestId("evaluation")).toBeVisible();
});

test("model evaluation: numeric precision / recall on the labeled demo set, per-label matches, sweep", async ({ page, request }) => {
  const api = await request.get("/api/evaluation");
  expect(api.status()).toBe(200);
  const body = (await api.json()) as { report: { spikes: { precision: number | null; recall: number | null }; labelCount: number } };
  expect(body.report.labelCount).toBe(3);
  expect(typeof body.report.spikes.precision).toBe("number");
  expect(typeof body.report.spikes.recall).toBe("number");

  await page.goto("/insights/evaluation");
  await expect(page.getByTestId("evaluation")).toBeVisible();
  await expect(page.getByTestId("evaluation-caveat")).toContainText("Small labeled demo set");

  for (const detector of ["spikes", "moments"]) {
    for (const metric of ["precision", "recall", "f1"]) {
      await expect(page.getByTestId(`metric-${detector}-${metric}`)).toHaveText(/^\d\.\d\d$/);
    }
  }
  // Same ink and labels everywhere, so these are exact.
  await expect(page.getByTestId("metric-spikes-precision")).toHaveText("1.00");
  await expect(page.getByTestId("metric-spikes-recall")).toHaveText("0.33");
  await expect(page.getByTestId("metric-moments-recall")).toHaveText("1.00");

  const confusion = page.getByTestId("evaluation-confusion");
  await expect(confusion.locator('[data-detector="spikes"] [data-testid="confusion-tp"]')).toHaveText("1");
  await expect(confusion.locator('[data-detector="spikes"] [data-testid="confusion-fn"]')).toHaveText("2");

  const rows = page.getByTestId("label-row");
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-testid="label-row"][data-spike="tp"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="label-row"][data-moment="tp"]')).toHaveCount(3);

  // Sensitivity sweep: 0.35..0.80; above the peak score nothing is flagged.
  await expect(page.getByTestId("sweep-column")).toHaveCount(10);
  await page.locator('[data-testid="sweep-column"][data-threshold="0.8"]').hover();
  await expect(page.getByTestId("sweep-tooltip")).toContainText("precision is undefined");
});
