import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ProgressPayload } from "../lib/progress";
import type { EraseEvent, Lecture, Stroke, TimelineData, TranscriptWord } from "../lib/types";
import { GAP_MS, buildCalmScenario, buildGapScenario, captionsFromWords } from "./fixtures/phase6-scenario";

// Phase 6: gaps over time. A gap left open in one session follows the student: home shows it,
// the next session of the lecture offers to jump to it, and writing through that part calmly later
// resolves it (or a repeat keeps it open, "2nd time"). Each test uses its own uploaded lecture (the
// demo audio + captions built from the demo transcript) so other specs' sessions can't interfere.

test.use({ viewport: { width: 1180, height: 820 } });

const WAV = readFileSync("public/demo/lecture.wav");
const DEMO_WORDS = JSON.parse(readFileSync("public/demo/lecture.transcript.json", "utf8")) as TranscriptWord[];
const VTT = Buffer.from(captionsFromWords(DEMO_WORDS));

type Build = (sessionId: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] };

async function uploadLecture(request: APIRequestContext, title: string): Promise<Lecture> {
  const res = await request.post("/api/lectures", {
    multipart: {
      title,
      durationMs: "360000",
      media: { name: "lecture.wav", mimeType: "audio/wav", buffer: WAV },
      captions: { name: "lecture.vtt", mimeType: "text/vtt", buffer: VTT },
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { lecture: Lecture }).lecture;
}

async function seedSession(request: APIRequestContext, lectureId: string, title: string, build: Build) {
  const created = await request.post("/api/sessions", { data: { title, lectureId } });
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

async function progress(request: APIRequestContext) {
  const res = await request.get("/api/progress");
  expect(res.status()).toBe(200);
  return (await res.json()) as ProgressPayload;
}

/** Session 2 starts mid-lecture (02:30) and writes calmly through 04:30. */
const calmMidLecture: Build = (id) => buildCalmScenario(id, { fromMs: 150_000, toMs: 270_000 });

const mediaTimeMs = (page: Page) =>
  page.getByTestId("lecture-media").evaluate((el) => Math.round((el as HTMLMediaElement).currentTime * 1000));

test("a gap follows you: home → progress → next session's banner → calm revisit resolves it", async ({ page, request }) => {
  const lecture = await uploadLecture(request, "Gaps over time — revisit");
  const openBefore = (await progress(request)).openCount;

  // (a) Session 1 leaves one gap at 03:40.
  const s1 = await seedSession(request, lecture.id, "Chain rule — first pass", buildGapScenario);
  const a1 = await analyze(request, s1);
  expect(a1.events.map((e) => [e.type, e.lectureMs, e.status])).toEqual([["unresolved_gap", GAP_MS, "open"]]);
  const gap = a1.events[0];
  expect(gap.conceptId).toMatch(new RegExp(`^${lecture.id}@\\d+$`));
  expect(gap.conceptLabel).toBeTruthy();

  await page.goto("/app");
  await expect(page.getByTestId("open-gaps-count")).toHaveText(String(openBefore + 1));
  await page.getByTestId("open-gaps-link").click();
  await page.waitForURL(/\/progress$/);
  await expect(page.getByTestId("progress-page")).toBeVisible();
  const section = page.locator(`[data-testid="progress-lecture"][data-lecture-id="${lecture.id}"]`);
  await expect(section).toContainText("Gaps over time — revisit");
  const thread = section.getByTestId("progress-thread");
  await expect(thread).toHaveCount(1);
  await expect(thread).toHaveAttribute("data-status", "open");
  await expect(thread).toContainText("Open");
  await expect(thread).toContainText("03:40");
  await expect(thread.getByTestId("progress-thread-label")).toHaveText(gap.conceptLabel!);

  // (b) Session 2 (same lecture, started mid-lecture): the banner offers to jump to the gap.
  const s2 = await seedSession(request, lecture.id, "Chain rule — second pass", calmMidLecture);
  await page.goto(`/session/${s2}`);
  const banner = page.getByTestId("open-gaps-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You have 1 open gap in this lecture");
  const jump = banner.getByTestId("open-gap-jump");
  await expect(jump).toHaveCount(1);
  await expect(jump).toContainText(gap.conceptLabel!);
  await expect(jump).toContainText("Jump to 03:40");
  await jump.click();
  // Seeks to the start of the gap's sentence: at or a little before the moment.
  await expect.poll(() => mediaTimeMs(page)).toBeGreaterThan(GAP_MS - 30_000);
  const seeked = await mediaTimeMs(page);
  expect(seeked).toBeLessThanOrEqual(GAP_MS);
  await expect(page.getByTestId("lecture-time")).toHaveText(/^0[34]:\d\d$/);
  await page.screenshot({ path: "screenshots/phase6-banner.png", animations: "disabled" });

  // Dismissible.
  await page.getByTestId("open-gaps-dismiss").click();
  await expect(banner).toHaveCount(0);

  // (c) Ending session 2 (calm writing over 02:30–04:30) resolves the earlier gap by revisit.
  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${s2}$`));
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  const carried = page.getByTestId("carried-over");
  await expect(carried).toBeVisible();
  const item = carried.getByTestId("carried-over-item");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-state", "resolved");
  await expect(item).toContainText("Resolved this session");
  await expect(carried).toContainText("1 resolved this session");
  await page.screenshot({ path: "screenshots/phase6-carried.png", animations: "disabled" });

  await page.goto("/progress?status=resolved");
  await expect(page.getByTestId("progress-page")).toHaveAttribute("data-filter", "resolved");
  const resolved = section.getByTestId("progress-thread");
  await expect(resolved).toHaveAttribute("data-status", "resolved");
  await expect(resolved).toHaveAttribute("data-resolved-by", "revisit");
  await expect(resolved.getByTestId("progress-thread-resolved")).toContainText("Revisited");
  // Not under Open any more.
  await page.getByTestId("progress-filter-open").click();
  await expect(page.getByTestId("progress-page")).toHaveAttribute("data-filter", "open");
  await expect(section).toHaveCount(0);
  await page.getByTestId("progress-filter-resolved").click();
  await expect(page.getByTestId("progress-page")).toHaveAttribute("data-filter", "resolved");

  // The link opens session 1's review with that moment selected.
  await section.getByTestId("progress-thread").click();
  await page.waitForURL(new RegExp(`/review/${s1}\\?moment=`));
  const detail = page.getByTestId("moment-detail");
  await expect(detail).toHaveAttribute("data-event-id", gap.id);
  await expect(page.getByTestId("moment-status")).toHaveText("Resolved");
  await expect(page.getByTestId("moment-concept")).toContainText(gap.conceptLabel!);
  await expect(page.getByTestId("moment-history")).toContainText(/First seen \w+ \d+ · resolved \w+ \d+ by writing through it calmly/);
  await expect(page.getByTestId("self-reopen")).toBeVisible();

  // Home count is back where it started.
  await page.goto("/app");
  await expect(page.getByTestId("open-gaps-count")).toHaveText(String(openBefore));
});

test("a repeat gap keeps it open and says 2nd time", async ({ page, request }) => {
  const lecture = await uploadLecture(request, "Gaps over time — repeat");
  const s1 = await seedSession(request, lecture.id, "Repeat — first", buildGapScenario);
  const g1 = (await analyze(request, s1)).events[0];
  const s2 = await seedSession(request, lecture.id, "Repeat — second", buildGapScenario);
  const a2 = await analyze(request, s2);
  expect(a2.events).toHaveLength(1);
  const g2 = a2.events[0];
  expect(g2).toMatchObject({ type: "unresolved_gap", status: "open", repeatOf: g1.id });
  expect(g2.history).toMatchObject({ occurrence: 2, occurrences: 2, threadStatus: "open" });

  // Review of session 2: the moment says it's the 2nd time; the earlier one "came up again".
  await page.goto(`/review/${s2}?moment=${encodeURIComponent(g2.id)}`);
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-event-id", g2.id);
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  await expect(page.getByTestId("moment-history")).toHaveText(/^Open since \w+ \d+ · 2nd time$/);
  const item = page.getByTestId("carried-over-item");
  await expect(item).toHaveAttribute("data-state", "repeated");
  await expect(item).toContainText("Came up again");

  // Progress: one open thread, 2nd time.
  const p = await progress(request);
  const threads = p.lectures.find((l) => l.lectureId === lecture.id)!.threads;
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({ status: "open", occurrences: 2 });
  await page.goto("/progress");
  const section = page.locator(`[data-testid="progress-lecture"][data-lecture-id="${lecture.id}"]`);
  await expect(section.getByTestId("progress-thread")).toHaveAttribute("data-status", "open");
  await expect(section.getByTestId("progress-thread-repeat")).toHaveText("2nd time");

  // Session 3's banner still counts one gap (the thread), marked ×2.
  const s3 = await seedSession(request, lecture.id, "Repeat — third", (id) => buildCalmScenario(id, { fromMs: 1000, toMs: 60_000 }));
  await page.goto(`/session/${s3}`);
  await expect(page.getByTestId("open-gaps-banner")).toContainText("You have 1 open gap in this lecture");
  await expect(page.getByTestId("open-gap-jump")).toContainText("×2");

  // A progress screenshot with both open and resolved gaps across lectures.
  await page.goto("/progress");
  await page.screenshot({ path: "screenshots/phase6-progress.png", animations: "disabled", fullPage: true });
});

test('"I get it now" persists after reload, and "Still confused" reopens it', async ({ page, request }) => {
  const lecture = await uploadLecture(request, "Gaps over time — self");
  const s1 = await seedSession(request, lecture.id, "Self — first", buildGapScenario);
  const gap = (await analyze(request, s1)).events[0];

  await page.goto(`/review/${s1}`);
  await page.locator('[data-testid="timeline-marker"][data-type="unresolved_gap"]').click();
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  await expect(page.getByTestId("moment-history")).toHaveText(/^Open since \w+ \d+$/);
  await expect(page.getByTestId("moment-concept")).toContainText(gap.conceptLabel!);
  await page.screenshot({ path: "screenshots/phase6-moment.png", animations: "disabled" });
  await page.getByTestId("self-resolve").click();
  await expect(page.getByTestId("moment-status")).toHaveText("Resolved");
  await expect(page.getByTestId("moment-history")).toContainText("you said you get it");
  await expect(page.locator('[data-testid="timeline-marker"][data-type="unresolved_gap"]')).toHaveAttribute(
    "data-status",
    "resolved",
  );

  await page.reload();
  await page.locator('[data-testid="timeline-marker"][data-type="unresolved_gap"]').click();
  await expect(page.getByTestId("moment-status")).toHaveText("Resolved");
  expect(
    (await progress(request)).lectures.find((l) => l.lectureId === lecture.id)!.threads[0],
  ).toMatchObject({ status: "resolved", resolvedBy: "self" });

  await page.getByTestId("self-reopen").click();
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  await expect(page.getByTestId("self-resolve")).toBeVisible();
  await page.goto(`/review/${s1}?moment=${encodeURIComponent(gap.id)}`);
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  expect((await progress(request)).lectures.find((l) => l.lectureId === lecture.id)!.threads[0].status).toBe("open");
});

test("new routes refuse cross-site requests (403) and oversized bodies (413)", async ({ request }) => {
  const lecture = await uploadLecture(request, "Gaps over time — guards");
  const s1 = await seedSession(request, lecture.id, "Guards", buildGapScenario);
  const gap = (await analyze(request, s1)).events[0];
  const resolveUrl = `/api/events/${encodeURIComponent(gap.id)}/resolve`;
  const evil = { origin: "https://evil.example" };

  expect((await request.post(resolveUrl, { data: { action: "self" }, headers: evil })).status()).toBe(403);
  expect((await request.get("/api/progress", { headers: evil })).status()).toBe(403);
  expect((await request.get(`/api/lectures/${lecture.id}/open-gaps`, { headers: evil })).status()).toBe(403);

  const big = await request.post(resolveUrl, { data: { action: "self", pad: "x".repeat(4096) } });
  expect(big.status()).toBe(413);
  expect((await request.post(resolveUrl, { data: { action: "maybe" } })).status()).toBe(400);
  expect((await request.post("/api/events/nope/resolve", { data: { action: "self" } })).status()).toBe(404);
  expect((await request.get("/api/lectures/nope/open-gaps")).status()).toBe(404);

  // Nothing changed through the refused requests; a same-origin one works.
  const ok = await request.post(resolveUrl, { data: { action: "self" } });
  expect(ok.status()).toBe(200);
  const { events } = (await ok.json()) as { events: Array<{ id: string; status: string }> };
  expect(events.find((e) => e.id === gap.id)!.status).toBe("resolved");
  const open = (await (await request.get(`/api/lectures/${lecture.id}/open-gaps`)).json()) as { open: unknown[] };
  expect(open.open).toEqual([]);
});
