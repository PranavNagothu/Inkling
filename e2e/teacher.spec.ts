import { expect, test, type APIRequestContext } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { buildPhase2Scenario } from "./fixtures/phase2-scenario";

// Track tuning: the teacher view ("Where did the class get lost?" — anonymous, k-anonymous class
// patterns over a lecture) and "Export for Notability" (a session exported as a 2-page PDF).
//   • On the e2e server every session belongs to the one local student → the privacy message.
//   • On the seeded demo server (`npm run demo`, port 3101: Maya + 5 classmates) → the heatmap and
//     the top 3 moments to re-teach.

const EVIL = { Origin: "http://evil.example" };
const DEMO_BASE = "http://127.0.0.1:3101";
const DEMO_LECTURE = "demo-chain-rule";

/** Ids that must never appear in a class response. */
const FORBIDDEN = [/"sessionId"/, /"studentId"/, /demo-maya/, /demo-classmate/, /demo-student/];

async function createSessionWithInk(request: APIRequestContext, title: string, { analyze = true } = {}) {
  const created = await request.post("/api/sessions", { data: { title } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string; lectureId: string } };
  const { strokes, eraseEvents } = buildPhase2Scenario(session.id);
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);
  if (analyze) expect((await request.post(`/api/sessions/${session.id}/analyze`)).status()).toBe(200);
  return session;
}

async function expectTwoPagePdf(body: Buffer) {
  expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const doc = await PDFDocument.load(body);
  expect(doc.getPageCount()).toBe(2);
}

test.describe("teacher view and Notability export (e2e server)", () => {
  test("a class smaller than 3 students gets the privacy message, never numbers or ids", async ({ page, request }) => {
    const session = await createSessionWithInk(request, "Teacher privacy");

    const res = await request.get(`/api/lectures/${session.lectureId}/class`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    for (const re of FORBIDDEN) expect(text).not.toMatch(re);
    expect(text).not.toContain(session.id);
    const body = JSON.parse(text) as { view: { status: string; buckets?: unknown }; source: string; bucketMs: number };
    // Every session here is the one local student.
    expect(body.view).toEqual({ status: "too-few" });
    expect(body.bucketMs).toBe(30_000);
    expect(body.source).toMatch(/SQLite|Postgres|Tiger Data/);

    await page.goto(`/teacher/${session.lectureId}`);
    const view = page.getByTestId("teacher-view");
    await expect(view).toHaveAttribute("data-status", "too-few");
    await expect(page.getByRole("heading", { name: "Where did the class get lost?" })).toBeVisible();
    await expect(page.getByTestId("equity-line")).toContainText("No names, no cameras — only anonymous writing patterns.");
    await expect(page.getByTestId("teacher-privacy")).toContainText("Fewer than 3 students");
    await expect(page.getByTestId("teacher-heatmap")).toHaveCount(0);
    await expect(page.getByTestId("reteach-moment")).toHaveCount(0);
  });

  test("home links each lecture to its teacher view", async ({ page }) => {
    await page.goto("/app");
    const link = page.locator(`[data-testid="teacher-link"][href="/teacher/${DEMO_LECTURE}"]`);
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(new RegExp(`/teacher/${DEMO_LECTURE}$`));
    await expect(page.getByTestId("teacher-view")).toBeVisible();
  });

  test("the export is a 2-page PDF download, and the compare page links to it", async ({ page, request }) => {
    const session = await createSessionWithInk(request, "Teacher export");

    const res = await request.get(`/api/sessions/${session.id}/export`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["content-disposition"]).toBe('attachment; filename="inkling-teacher-export.pdf"');
    expect(headers["x-content-type-options"]).toBe("nosniff");
    await expectTwoPagePdf(await res.body());

    await page.goto(`/compare/${session.id}`);
    const button = page.getByTestId("export-notability");
    await expect(button).toHaveText(/Export for Notability \(PDF\)/);
    await expect(button).toHaveAttribute("href", `/api/sessions/${session.id}/export`);
    await expect(button).toHaveAttribute("download", "");
    await expect(page.getByText("Import this PDF into Notability to keep your process next to your notes.")).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
    expect(download.suggestedFilename()).toBe("inkling-teacher-export.pdf");
  });

  test("an export of a never-analysed session analyses it first, so its moments match the review's counts", async ({ request }) => {
    const session = await createSessionWithInk(request, "Teacher export unanalysed", { analyze: false });
    const before = (await (await request.get(`/api/sessions/${session.id}/timeline`)).json()) as { analyzed: boolean };
    expect(before.analyzed).toBe(false);

    const res = await request.get(`/api/sessions/${session.id}/export`);
    expect(res.status()).toBe(200);
    await expectTwoPagePdf(await res.body());

    const after = (await (await request.get(`/api/sessions/${session.id}/timeline`)).json()) as { analyzed: boolean; stale: boolean; events: Array<{ type: string }> };
    expect(after.analyzed).toBe(true);
    expect(after.stale).toBe(false);
    expect(after.events.map((e) => e.type)).toEqual(["misconception_corrected", "unresolved_gap"]);
  });

  test("unknown ids are 404 and cross-site requests are refused", async ({ page, request }) => {
    expect((await request.get("/api/lectures/l_missing/class")).status()).toBe(404);
    expect((await request.get("/api/sessions/s_missing/export")).status()).toBe(404);
    expect((await page.goto("/teacher/l_missing"))?.status()).toBe(404);
    expect((await request.get(`/api/lectures/${DEMO_LECTURE}/class`, { headers: EVIL })).status()).toBe(403);
    const session = await createSessionWithInk(request, "Teacher cross-site");
    expect((await request.get(`/api/sessions/${session.id}/export`, { headers: EVIL })).status()).toBe(403);
  });
});

test.describe("teacher view on the seeded demo (Maya + 5 classmates)", () => {
  test.use({ baseURL: DEMO_BASE });

  test("heatmap and top 3 moments, k-anonymous, with no ids in the API", async ({ page, request }) => {
    const res = await request.get(`/api/lectures/${DEMO_LECTURE}/class`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    for (const re of FORBIDDEN) expect(text).not.toMatch(re);
    const { view } = JSON.parse(text) as {
      view: { status: string; classSize: number; buckets: Array<{ students: number | null }>; moments: Array<{ students: number | null; studentsLabel: string; startMs: number }> };
    };
    expect(view.status).toBe("ready");
    expect(view.classSize).toBe(6);
    expect(view.moments).toHaveLength(3);
    // k-anonymity: a shown count is always at least 3.
    for (const b of view.buckets) if (b.students !== null) expect(b.students).toBeGreaterThanOrEqual(3);
    for (const m of view.moments) {
      if (m.students === null) expect(m.studentsLabel).toBe("fewer than 3 students");
      else expect(m.students).toBeGreaterThanOrEqual(3);
    }
    // The scenario's tricky stretches: sin(x²) (~01:30), product vs chain (~04:00), sin²x (~05:20).
    const starts = view.moments.map((m) => m.startMs).sort((a, b) => a - b);
    expect(starts[0]).toBeGreaterThanOrEqual(60_000);
    expect(starts[0]).toBeLessThan(120_000);
    expect(starts.some((s) => s >= 210_000 && s < 270_000)).toBe(true);

    await page.goto(`/teacher/${DEMO_LECTURE}`);
    await expect(page.getByTestId("teacher-view")).toHaveAttribute("data-status", "ready");
    await expect(page.getByTestId("equity-line")).toContainText("No names, no cameras");
    await expect(page.getByTestId("teacher-heatmap")).toBeVisible();
    await expect(page.getByTestId("heatmap-column")).toHaveCount(12);
    await expect(page.getByTestId("teacher-source")).toHaveText(/SQLite · computed in TypeScript|Postgres · date_bin|Tiger Data · TimescaleDB continuous aggregate/);
    const moments = page.getByTestId("reteach-moment");
    await expect(moments).toHaveCount(3);
    await expect(moments.first().getByTestId("moment-students")).toContainText(/\d+ students|Fewer than 3 students/);
    await expect(moments.first().getByTestId("moment-excerpt")).not.toBeEmpty();

    // Play this moment: the lecture jumps to the stretch and plays.
    const play = moments.first().getByTestId("play-moment");
    await play.click();
    await expect(play).toHaveAttribute("data-state", "playing");
    await expect(page.getByTestId("teacher-playing")).toContainText("Playing the lecture");
    const startMs = Number(await moments.first().getAttribute("data-start-ms"));
    const t = await page.getByTestId("teacher-media").evaluate((m: HTMLMediaElement) => m.currentTime * 1000);
    expect(t).toBeGreaterThanOrEqual(startMs - 1);
    await play.click();
    await expect(play).toHaveAttribute("data-state", "idle");

    // Keyboard: the heatmap's tooltip follows the arrow keys.
    await page.getByRole("group", { name: /Class heatmap/ }).focus();
    await page.keyboard.press("End");
    await expect(page.getByTestId("heatmap-tooltip")).toContainText("05:30–06:00");
  });

  test("Maya's session exports as a 2-page PDF", async ({ request }) => {
    const res = await request.get("/api/sessions/demo-maya-1/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="inkling-maya-session-1.pdf"');
    await expectTwoPagePdf(await res.body());
  });
});
