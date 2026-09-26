import { readFileSync, readdirSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Lecture, TimelineData } from "../lib/types";
import { buildCorrectionScenario } from "./fixtures/phase4-scenario";

// Phase 4: lectures are data. Upload a recording (+ captions), follow its transcript while taking
// notes, and replay the 20 s of lecture behind a moment on the review page.

test.use({ viewport: { width: 1180, height: 820 } });

const WAV_PATH = "e2e/fixtures/lecture-40s.wav";
const VTT_PATH = "e2e/fixtures/lecture-40s.vtt";
const WAV = readFileSync(WAV_PATH);
const VTT = readFileSync(VTT_PATH);
const UPLOAD_DIR = "data/e2e-uploads";

type Part = { name: string; mimeType: string; buffer: Buffer };

async function uploadViaApi(
  request: APIRequestContext,
  opts: { title: string; media?: Part; captions?: Part | null; durationMs?: string; headers?: Record<string, string> },
) {
  const multipart: Record<string, string | Part> = {
    title: opts.title,
    media: opts.media ?? { name: "lecture.wav", mimeType: "audio/wav", buffer: WAV },
  };
  if (opts.durationMs !== "") multipart.durationMs = opts.durationMs ?? "40000";
  if (opts.captions) multipart.captions = opts.captions;
  return request.post("/api/lectures", { multipart, headers: opts.headers });
}

async function uploadLecture(request: APIRequestContext, title: string, withCaptions = true): Promise<Lecture> {
  const res = await uploadViaApi(request, {
    title,
    captions: withCaptions ? { name: "lecture.vtt", mimeType: "text/vtt", buffer: VTT } : null,
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { lecture: Lecture }).lecture;
}

async function seededSession(request: APIRequestContext, lectureId: string, title: string) {
  const created = await request.post("/api/sessions", { data: { title, lectureId } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string; lectureId: string } };
  expect(session.lectureId).toBe(lectureId);
  const { strokes, eraseEvents } = buildCorrectionScenario(session.id, { eraseMs: 20_000 });
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);
  const analysis = (await (await request.post(`/api/sessions/${session.id}/analyze`)).json()) as TimelineData;
  expect(analysis.events.map((e) => [e.type, e.lectureMs])).toEqual([["misconception_corrected", 20_000]]);
  expect(analysis.durationMs).toBe(40_000);
  return session.id;
}

const mediaTimeMs = (page: Page) =>
  page.getByTestId("lecture-media").evaluate((el) => Math.round((el as HTMLMediaElement).currentTime * 1000));

const currentWordMs = async (page: Page) =>
  Number(await page.getByTestId("transcript-current").getAttribute("data-ms"));

test("upload a lecture with captions via the form → it appears in the home picker", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("add-lecture").click();
  await page.waitForURL(/\/lectures\/new$/);
  await expect(page.getByRole("heading", { name: "Bring your own lecture" })).toBeVisible();
  await expect(page.getByTestId("upload-submit")).toBeDisabled();
  // No OpenAI key in tests: the page says so, quietly.
  await expect(page.getByTestId("upload-ai-note")).toHaveText("Auto-transcribe needs an OpenAI or Groq key");

  await page.getByTestId("media-input").setInputFiles(WAV_PATH);
  // Duration is read in the browser from a detached media element before submitting.
  await expect(page.getByTestId("media-info")).toHaveText("Audio · 313 KB · 00:40");
  await expect(page.getByTestId("title-input")).toHaveValue("lecture 40s");
  await page.getByTestId("title-input").fill("Related rates — e2e upload");
  await page.getByTestId("captions-input").setInputFiles(VTT_PATH);
  await expect(page.getByTestId("captions-info")).toContainText("9 captions");
  await expect(page.getByTestId("upload-submit")).toBeEnabled();
  await page.screenshot({ path: "screenshots/phase4-upload.png", animations: "disabled" });

  await page.getByTestId("upload-submit").click();
  await page.waitForURL(/\/\?lecture=/);
  const lectureId = new URL(page.url()).searchParams.get("lecture")!;
  const picker = page.getByTestId("lecture-picker");
  await expect(picker).toHaveValue(lectureId);
  await expect(picker.locator("option:checked")).toHaveText("Related rates — e2e upload");
  await expect(page.getByTestId("lecture-meta")).toHaveText("00:40 · Audio · transcript");
  // The demo lecture is still offered first.
  await expect(picker.locator("option").first()).toHaveText(/The Chain Rule \(demo\)/);

  const { lectures } = (await (await page.request.get("/api/lectures")).json()) as { lectures: Lecture[] };
  expect(lectures.find((l) => l.id === lectureId)).toMatchObject({
    durationMs: 40_000,
    mediaType: "audio",
    mime: "audio/wav",
    transcriptSource: "captions",
  });
  expect(lectures.find((l) => l.id === lectureId)!.wordCount).toBeGreaterThan(80);
});

test("transcript panel follows playback, and clicking a later word seeks the lecture", async ({ page, request }) => {
  const lecture = await uploadLecture(request, "Transcript follow — e2e");
  await page.goto(`/?lecture=${lecture.id}`);
  await expect(page.getByTestId("lecture-picker")).toHaveValue(lecture.id);
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];
  await expect(page.getByText("00:00 / 00:40")).toBeVisible();

  await page.getByTestId("transcript-toggle").click();
  await expect(page.getByTestId("transcript-toggle")).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByTestId("transcript-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Welcome back. Today we look at related rates.");
  await expect(panel).not.toContainText("[Music]");
  await expect(panel).toContainText("From captions");
  // Side panel on a wide screen: the canvas sits to its left.
  const panelBox = (await panel.boundingBox())!;
  const canvasBox = (await page.getByTestId("ink-canvas").boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(canvasBox.x + canvasBox.width - 1);

  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-state", "playing");
  await expect(page.getByTestId("transcript-current")).toHaveCount(1, { timeout: 10_000 });
  const first = await currentWordMs(page);
  await expect.poll(() => currentWordMs(page), { timeout: 10_000 }).toBeGreaterThan(first);
  await expect(page.getByTestId("transcript-current")).toHaveCount(1);
  await page.screenshot({ path: "screenshots/phase4-transcript.png", animations: "disabled" });

  // Scrolling the transcript by hand pauses auto-follow; "Follow lecture" resumes it.
  await panel.locator(".transcript").hover();
  await page.mouse.wheel(0, 200);
  await expect(page.getByTestId("transcript-follow")).toBeVisible();
  await page.getByTestId("transcript-follow").click();
  await expect(page.getByTestId("transcript-follow")).toHaveCount(0);

  // Jump ahead: click a word ~30 s in.
  const target = panel.locator('[data-w]').filter({ hasText: /^solve$/ });
  const targetMs = Number(await target.getAttribute("data-ms"));
  expect(targetMs).toBeGreaterThan(27_500);
  await target.click();
  await expect(page.getByTestId("lecture-time")).toHaveText(/^00:(2[89]|3\d)$/);
  expect(await mediaTimeMs(page)).toBeGreaterThanOrEqual(targetMs);
  await expect.poll(() => currentWordMs(page)).toBeGreaterThanOrEqual(targetMs);

  // Narrow (iPad portrait): the panel becomes a bottom sheet over the page.
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(810);
  const sheet = (await panel.boundingBox())!;
  expect(sheet.y).toBeGreaterThan(1180 / 2 - 60);
  await page.screenshot({ path: "screenshots/phase4-transcript-portrait.png", animations: "disabled" });
  await page.setViewportSize({ width: 1180, height: 820 });

  // Close the panel; playback continues.
  await page.getByTestId("transcript-close").click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-state", "playing");

  // Home lists the session with its lecture's title.
  await page.goto("/");
  const row = page.locator("li").filter({ has: page.locator(`a[href="/session/${sessionId}"]`) });
  await expect(row.getByTestId("session-lecture")).toHaveText("Transcript follow — e2e");
});

test.describe("lecture API", () => {
  test("media route streams with Range support (206 / 416)", async ({ request }) => {
    const lecture = await uploadLecture(request, "Range — e2e");
    const url = `/api/lectures/${lecture.id}/media`;

    const full = await request.get(url);
    expect(full.status()).toBe(200);
    expect(full.headers()["accept-ranges"]).toBe("bytes");
    expect(full.headers()["content-type"]).toBe("audio/wav");
    expect(Number(full.headers()["content-length"])).toBe(WAV.length);
    expect(Buffer.compare(await full.body(), WAV)).toBe(0);

    const part = await request.get(url, { headers: { Range: "bytes=0-99" } });
    expect(part.status()).toBe(206);
    expect(part.headers()["content-range"]).toBe(`bytes 0-99/${WAV.length}`);
    expect(part.headers()["content-length"]).toBe("100");
    expect((await part.body()).subarray(0, 4).toString()).toBe("RIFF");

    const tail = await request.get(url, { headers: { Range: "bytes=-10" } });
    expect(tail.status()).toBe(206);
    expect(Buffer.compare(await tail.body(), WAV.subarray(WAV.length - 10))).toBe(0);

    const mid = await request.get(url, { headers: { Range: `bytes=${WAV.length - 50}-` } });
    expect(mid.headers()["content-range"]).toBe(`bytes ${WAV.length - 50}-${WAV.length - 1}/${WAV.length}`);

    const bad = await request.get(url, { headers: { Range: `bytes=${WAV.length + 10}-` } });
    expect(bad.status()).toBe(416);
    expect(bad.headers()["content-range"]).toBe(`bytes */${WAV.length}`);
    expect((await request.get(url, { headers: { Range: "bytes=50-10" } })).status()).toBe(416);

    // The demo lecture goes through the same route.
    const demo = await request.get("/api/lectures/demo-chain-rule/media", { headers: { Range: "bytes=0-15" } });
    expect(demo.status()).toBe(206);
    expect(demo.headers()["content-range"]).toMatch(/^bytes 0-15\/\d+$/);

    expect((await request.get("/api/lectures/nope/media")).status()).toBe(404);
    expect((await request.get("/api/lectures/..%2F..%2Fpackage.json/media")).status()).toBe(404);
  });

  test("upload rejects bad files and leaves nothing behind", async ({ request }) => {
    const before = (await (await request.get("/api/lectures")).json()).lectures.length as number;
    const reject = async (status: number, opts: Parameters<typeof uploadViaApi>[1]) => {
      const res = await uploadViaApi(request, opts);
      expect(res.status(), JSON.stringify(opts.title)).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    };
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2000, 0x90)]);

    await reject(400, { title: "exe", media: { name: "notes.exe", mimeType: "application/x-msdownload", buffer: exe } });
    await reject(400, { title: "wrong mime", media: { name: "lecture.wav", mimeType: "text/html", buffer: WAV } });
    await reject(400, { title: "renamed exe", media: { name: "lecture.wav", mimeType: "audio/wav", buffer: exe } });
    await reject(400, { title: "mp3 named wav", media: { name: "lecture.mp3", mimeType: "audio/mpeg", buffer: WAV } });
    await reject(400, { title: "no duration", durationMs: "" });
    await reject(400, { title: "bad duration", durationMs: "Infinity" });
    await reject(400, { title: "negative duration", durationMs: "-40" });
    const huge = Buffer.concat([VTT, Buffer.alloc(2 * 1024 * 1024, 0x20)]);
    await reject(413, { title: "oversize captions", captions: { name: "big.vtt", mimeType: "text/vtt", buffer: huge } });
    await reject(400, {
      title: "captions exe",
      captions: { name: "subs.exe", mimeType: "application/x-msdownload", buffer: exe },
    });
    await reject(400, {
      title: "empty captions",
      captions: { name: "subs.vtt", mimeType: "text/vtt", buffer: Buffer.from("WEBVTT\n\nnothing here\n") },
    });
    await reject(403, { title: "cross-site", headers: { Origin: "https://evil.example" } });
    expect((await request.post("/api/lectures", { data: { title: "json" } })).status()).toBe(415);

    const after = (await (await request.get("/api/lectures")).json()).lectures as Lecture[];
    expect(after.length).toBe(before);
    // Every stored file belongs to a lecture (rejections never write to disk); names are server-made UUIDs.
    const files = readdirSync(UPLOAD_DIR);
    expect(files.length).toBe(after.filter((l) => l.transcriptSource !== "demo").length);
    for (const f of files) expect(f).toMatch(/^[0-9a-f-]{36}\.(wav|webm|mp3|m4a|mp4)$/);
  });

  test("transcribe answers 503 without an OpenAI key", async ({ request }) => {
    const lecture = await uploadLecture(request, "Transcribe — e2e", false);
    const res = await request.post(`/api/lectures/${lecture.id}/transcribe`);
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: "AI not configured" });
    expect((await request.post("/api/lectures/nope/transcribe")).status()).toBe(404);
  });

  test("sessions can only be created for known lectures", async ({ request }) => {
    expect((await request.post("/api/sessions", { data: { lectureId: "nope" } })).status()).toBe(400);
    const res = await request.post("/api/sessions", { data: {} });
    expect(((await res.json()) as { session: { lectureId: string } }).session.lectureId).toBe("demo-chain-rule");
  });
});

test("review: click a moment → Replay 20s plays the evidence and stops at its end", async ({ page, request }) => {
  const lecture = await uploadLecture(request, "Replay — e2e");
  const sessionId = await seededSession(request, lecture.id, "Replay notes");

  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await expect(page.getByText("Review · Replay — e2e")).toBeVisible();
  const marker = page.locator('[data-testid="timeline-marker"][data-type="misconception_corrected"]');
  await expect(marker).toHaveCount(1);
  await marker.click();
  const detail = page.getByTestId("moment-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("moment-time")).toHaveText("00:20");
  await expect(page.getByTestId("moment-excerpt")).toContainText("Differentiate both sides with respect to time.");

  const replay = page.getByTestId("replay");
  await expect(replay).toHaveText("Replay 20s");
  await expect(replay).toHaveAttribute("data-replay-state", "idle");
  const started = Date.now();
  await replay.click();
  await expect(replay).toHaveAttribute("data-replay-state", "playing");
  await expect.poll(() => mediaTimeMs(page)).toBeGreaterThan(10_000);
  // The word being replayed is marked inside the excerpt.
  await expect(page.locator('[data-testid="moment-excerpt"] [aria-current="true"]')).toHaveCount(1, { timeout: 5000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "screenshots/phase4-replay.png", animations: "disabled" });

  await expect(replay).toHaveAttribute("data-replay-state", "done", { timeout: 25_000 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThan(18_000);
  expect(elapsed).toBeLessThan(25_000);
  const endMs = await mediaTimeMs(page);
  expect(Math.abs(endMs - 30_000)).toBeLessThan(400);
  expect(await page.getByTestId("lecture-media").evaluate((el) => (el as HTMLMediaElement).paused)).toBe(true);
  await expect(replay).toHaveText("Replay again");

  // Replay again, then stop it early.
  await replay.click();
  await expect(replay).toHaveAttribute("data-replay-state", "playing");
  await replay.click();
  await expect(replay).toHaveAttribute("data-replay-state", "idle");
  expect(await page.getByTestId("lecture-media").evaluate((el) => (el as HTMLMediaElement).paused)).toBe(true);
});

test("a lecture without captions works end to end and says it has no transcript", async ({ page, request }) => {
  // Upload through the form, without captions.
  await page.goto("/lectures/new");
  await page.getByTestId("media-input").setInputFiles(WAV_PATH);
  await expect(page.getByTestId("media-info")).toContainText("00:40");
  await page.getByTestId("title-input").fill("No captions — e2e");
  await page.getByTestId("upload-submit").click();
  await page.waitForURL(/\/\?lecture=/);
  const lectureId = new URL(page.url()).searchParams.get("lecture")!;
  await expect(page.getByTestId("lecture-meta")).toHaveText("00:40 · Audio · no transcript");

  // Capture: the transcript panel explains, and auto-transcribe needs a key.
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  await page.getByTestId("transcript-toggle").click();
  await expect(page.getByTestId("transcript-empty")).toContainText("No transcript for this lecture");
  await expect(page.getByTestId("transcribe-note")).toHaveText("Auto-transcribe needs an OpenAI or Groq key");

  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("lecture-time")).not.toHaveText("00:00", { timeout: 10_000 });
  const box = (await page.getByTestId("ink-canvas").boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 80 + i * 10, box.y + 120 + 6 * Math.sin(i));
  await page.mouse.up();
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-stroke-count", "1");
  await page.getByTestId("end-session").click();
  await page.waitForURL(/\/review\/[^/]+$/);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("timeline-empty")).toBeVisible();

  // A moment on this lecture: the evidence says there is no transcript, replay still works.
  const sessionId = await seededSession(request, lectureId, "No-caption notes");
  await page.goto(`/review/${sessionId}`);
  await page.locator('[data-testid="timeline-marker"]').first().click();
  await expect(page.getByTestId("moment-excerpt")).toHaveText("No transcript for this lecture");
  await page.getByTestId("replay").click();
  await expect(page.getByTestId("replay")).toHaveAttribute("data-replay-state", "playing");
  await expect.poll(() => mediaTimeMs(page)).toBeGreaterThan(10_500);
  await page.getByTestId("replay").click();
  await expect(page.getByTestId("replay")).toHaveAttribute("data-replay-state", "idle");
});

test("video lecture: compact video panel collapses without interrupting playback", async ({ page }) => {
  await page.goto("/lectures/new");
  // Record a 3 s WebM in the browser (no binary video fixture needed). MediaRecorder output reports
  // an Infinity duration until scanned, which the upload form handles.
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    const paint = () => {
      ctx.fillStyle = `hsl(${(frame * 9) % 360} 45% 35%)`;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#fff";
      ctx.font = "32px sans-serif";
      ctx.fillText(`dy/dt  ${frame++}`, 24, 100);
    };
    paint();
    const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm;codecs=vp8" });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const timer = setInterval(paint, 66);
    rec.start();
    await new Promise((r) => setTimeout(r, 3000));
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.stop();
    await stopped;
    clearInterval(timer);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  await page
    .getByTestId("media-input")
    .setInputFiles({ name: "board-demo.webm", mimeType: "video/webm", buffer: Buffer.from(base64, "base64") });
  await expect(page.getByTestId("media-info")).toHaveText(/^Video · .+ · 00:0[234]$/);
  await page.getByTestId("upload-submit").click();
  await page.waitForURL(/\/\?lecture=/);
  await expect(page.getByTestId("lecture-meta")).toHaveText(/Video · no transcript$/);
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\/[^/]+$/);

  const panel = page.getByTestId("video-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-collapsed", "false");
  const video = page.getByTestId("lecture-media");
  expect(await video.evaluate((el) => el.tagName)).toBe("VIDEO");
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).videoWidth)).toBe(320);

  await page.getByTestId("play-toggle").click();
  await expect(page.getByTestId("play-toggle")).toHaveAttribute("data-state", "playing");
  await page.getByTestId("video-collapse").click();
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("video-expand")).toBeVisible();
  // Collapsing only hides the video: it keeps playing.
  const t0 = await mediaTimeMs(page);
  await expect.poll(() => mediaTimeMs(page)).toBeGreaterThan(t0 + 300);
  await page.getByTestId("video-expand").click();
  await expect(panel).toHaveAttribute("data-collapsed", "false");
  await expect(video).toBeVisible();
  await page.screenshot({ path: "screenshots/phase4-video.png", animations: "disabled" });
});
