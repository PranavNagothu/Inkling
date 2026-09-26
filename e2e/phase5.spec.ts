import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ProgressPayload } from "../lib/progress";
import type { Lecture, TimelineData, TimelineEvent, TranscriptWord } from "../lib/types";
import { SCENARIO_TIMES, buildPhase2Scenario } from "./fixtures/phase2-scenario";
import { captionsFromWords } from "./fixtures/phase6-scenario";

// Phase 5: AI re-teach. Runs in the "ai" project against the deterministic fake provider
// (AI_PROVIDER=fake: offline, same input → same card). Each test uploads its own copy of the demo
// lecture (demo audio + captions from its transcript) so gaps from other sessions can't interfere.
//
// The fake provider's check question always has "Multiply by the derivative of the inside" as the
// right answer (at an input-dependent position), so the test picks options by text.

test.use({ viewport: { width: 1180, height: 820 } });

const RIGHT = "Multiply by the derivative of the inside";
const WRONG = "Stop after the outer derivative";
const WAV = readFileSync("public/demo/lecture.wav");
const DEMO_WORDS = JSON.parse(readFileSync("public/demo/lecture.transcript.json", "utf8")) as TranscriptWord[];
const VTT = Buffer.from(captionsFromWords(DEMO_WORDS));
const AI_OFF = { "x-inkling-ai": "off" };
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64")}`;

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

/** A session with the Phase 2 scenario (a correction at 02:30, a gap at 03:40), analysed. */
async function seeded(request: APIRequestContext, title: string) {
  const lecture = await uploadLecture(request, title);
  const created = await request.post("/api/sessions", { data: { title, lectureId: lecture.id } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const { strokes, eraseEvents } = buildPhase2Scenario(session.id);
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);
  const res = await request.post(`/api/sessions/${session.id}/analyze`);
  expect(res.status()).toBe(200);
  const analysis = (await res.json()) as TimelineData;
  expect(analysis.events.map((e) => [e.type, e.lectureMs])).toEqual([
    ["misconception_corrected", SCENARIO_TIMES.correctionEraseMs],
    ["unresolved_gap", SCENARIO_TIMES.gapWindowMs],
  ]);
  const [corrected, gap] = analysis.events;
  return { lecture, sessionId: session.id, corrected, gap };
}

const marker = (page: Page, eventId: string) => page.locator(`[data-testid="timeline-marker"][data-event-id="${eventId}"]`);

async function openMoment(page: Page, eventId: string) {
  await marker(page, eventId).click();
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-event-id", eventId);
}

async function answer(page: Page, text: string) {
  await page.getByTestId("check-option").filter({ hasText: text }).click();
  await page.getByTestId("check-submit").click();
}

/**
 * Scrolls the (sticky, wide-screen) moment panel — not the page — so `testId`'s bottom edge sits
 * near the bottom of the viewport: the timeline stays in the screenshot.
 */
async function showInPanel(page: Page, testId: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('aside[aria-label="Moment details"]').evaluate((aside, id) => {
    const el = aside.querySelector(`[data-testid="${id}"]`)!;
    aside.scrollTop += el.getBoundingClientRect().bottom - (window.innerHeight - 16);
  }, testId);
}

async function storedEvent(request: APIRequestContext, sessionId: string, eventId: string) {
  const res = await request.get(`/api/sessions/${sessionId}/timeline`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as TimelineData;
  return { event: body.events.find((e) => e.id === eventId) as TimelineEvent, raw: JSON.stringify(body) };
}

test("(a) corrected moment → help card → right answer is a Breakthrough that persists", async ({ page, request }) => {
  const { sessionId, corrected } = await seeded(request, "Phase 5 — breakthrough");
  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("count-corrected")).toHaveText("1");
  await expect(page.getByTestId("count-breakthroughs")).toHaveText("0");
  await openMoment(page, corrected.id);

  const card = page.getByTestId("help-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("help-reexplain")).toContainText("Let’s rebuild this one step at a time.");
  await expect(page.getByTestId("help-source")).toHaveText(/AI · fake/);
  await expect(page.getByTestId("check-option")).toHaveCount(4);
  await expect(page.getByRole("radio")).toHaveCount(4);
  await expect(page.getByTestId("check-question").locator("legend")).toContainText("what finishes a chain-rule derivative?");
  await expect(page.getByTestId("moment-concept")).not.toContainText("If you ever get lost");
  await expect(page.getByTestId("check-submit")).toBeDisabled();
  // The concept got a short AI label (ids unchanged).
  await expect(page.getByTestId("moment-concept")).toBeVisible();
  await expect(page.getByTestId("revision-reading")).toBeVisible();
  await showInPanel(page, "check-submit");
  await page.screenshot({ path: "screenshots/phase5-help.png", animations: "disabled" });

  // The answer never reaches the client before answering.
  const { raw } = await storedEvent(request, sessionId, corrected.id);
  expect(raw).not.toContain("answerIdx");

  await answer(page, RIGHT);
  const feedback = page.getByTestId("check-feedback");
  await expect(feedback).toHaveAttribute("data-result", "correct");
  await expect(feedback).toContainText("Breakthrough!");
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-type", "breakthrough");
  await expect(marker(page, corrected.id)).toHaveAttribute("data-type", "breakthrough");
  await expect(page.getByTestId("count-breakthroughs")).toHaveText("1");
  await expect(page.getByTestId("count-corrected")).toHaveText("0");
  await expect(page.getByTestId("check-option").filter({ hasText: RIGHT })).toHaveAttribute("data-state", "correct");
  await showInPanel(page, "check-feedback");
  await page.screenshot({ path: "screenshots/phase5-breakthrough.png", animations: "disabled" });

  // Persists: stored, and after a reload.
  const { event } = await storedEvent(request, sessionId, corrected.id);
  expect(event).toMatchObject({ type: "breakthrough", status: "resolved" });
  expect(event.checkAttempts).toHaveLength(1);
  expect(event.help).toBeUndefined();
  await page.reload();
  await expect(marker(page, corrected.id)).toHaveAttribute("data-type", "breakthrough");
  await expect(page.getByTestId("count-breakthroughs")).toHaveText("1");
  await openMoment(page, corrected.id);
  await expect(page.getByTestId("check-feedback")).toContainText("Breakthrough!");
  await expect(page.getByTestId("check-submit")).toHaveCount(0);
});

test("(b) gap: a wrong answer keeps it open with the why; the right one resolves it by check", async ({ page, request }) => {
  const { lecture, sessionId, gap } = await seeded(request, "Phase 5 — gap check");
  await page.goto(`/review/${sessionId}`);
  await openMoment(page, gap.id);
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  await expect(page.getByTestId("check-option")).toHaveCount(4);

  await answer(page, WRONG);
  const feedback = page.getByTestId("check-feedback");
  await expect(feedback).toHaveAttribute("data-result", "wrong");
  await expect(page.getByTestId("check-why")).toContainText("multiplied by the derivative of the inside");
  await expect(page.getByTestId("check-option").filter({ hasText: WRONG })).toHaveAttribute("data-state", "wrong");
  await expect(page.getByTestId("moment-status")).toHaveText("Open");
  await expect(marker(page, gap.id)).toHaveAttribute("data-status", "open");
  const afterWrong = (await storedEvent(request, sessionId, gap.id)).event;
  expect(afterWrong).toMatchObject({ status: "open" });
  expect(afterWrong.reopenedAtIso).toBeTruthy();

  // Retry.
  await answer(page, RIGHT);
  await expect(feedback).toHaveAttribute("data-result", "correct");
  await expect(feedback).toContainText("gap resolved");
  await expect(page.getByTestId("moment-status")).toHaveText("Resolved");
  await expect(marker(page, gap.id)).toHaveAttribute("data-status", "resolved");
  expect((await storedEvent(request, sessionId, gap.id)).event).toMatchObject({ status: "resolved", resolvedBy: "check" });

  // Gaps over time: resolved with a check question.
  const progress = (await (await request.get("/api/progress")).json()) as ProgressPayload;
  expect(progress.lectures.find((l) => l.lectureId === lecture.id)!.threads[0]).toMatchObject({ status: "resolved", resolvedBy: "check" });
  await page.goto("/progress?status=resolved");
  const thread = page.locator(`[data-testid="progress-lecture"][data-lecture-id="${lecture.id}"]`).getByTestId("progress-thread");
  await expect(thread).toHaveAttribute("data-resolved-by", "check");
  await expect(thread.getByTestId("progress-thread-resolved")).toContainText("Check question");
});

test("(c) a correction's revision is read: “What you changed” and the likely mix-up", async ({ page, request }) => {
  const { sessionId, corrected } = await seeded(request, "Phase 5 — revision reading");
  await page.goto(`/review/${sessionId}`);
  const reading = page.waitForResponse((r) => r.url().includes("/read-revision") && r.request().method() === "POST");
  await openMoment(page, corrected.id);
  expect((await reading).status()).toBe(200);
  const view = page.getByTestId("revision-reading");
  await expect(view).toContainText("What you changed:");
  await expect(page.getByTestId("revision-before")).toContainText("a first attempt at this step");
  await expect(page.getByTestId("revision-after")).toContainText("a rewritten version");
  await expect(page.getByTestId("revision-misconception")).toContainText("Mixed up a step");

  // Stored on the revision, and served from there after a reload (no second reading).
  const t = (await (await request.get(`/api/sessions/${sessionId}/timeline`)).json()) as TimelineData;
  expect(t.revisions.find((r) => r.id === corrected.revisionId)!.vision).toMatchObject({ cosmetic: false });
  let posted = 0;
  page.on("request", (r) => {
    if (r.url().includes("/read-revision")) posted++;
  });
  await page.reload();
  await openMoment(page, corrected.id);
  await expect(page.getByTestId("revision-reading")).toContainText("What you changed:");
  expect(posted).toBe(0);
});

/**
 * Stubs window.speechSynthesis. "speaks": onstart, then onend 150 ms later (a working voice);
 * "silent": speak() is accepted but nothing ever fires (what iPad Safari does when it refuses).
 * Records each spoken text and whether speak() ran inside the click (navigator.userActivation).
 */
async function stubSpeech(page: Page, mode: "speaks" | "silent") {
  await page.addInitScript((m) => {
    const w = window as unknown as { __spoken: string[]; __inGesture: boolean[]; __cancels: number };
    w.__spoken = [];
    w.__inGesture = [];
    w.__cancels = 0;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        pending: false,
        paused: false,
        getVoices: () => [],
        cancel: () => {
          w.__cancels++;
        },
        pause: () => {},
        resume: () => {},
        speak: (u: SpeechSynthesisUtterance) => {
          w.__spoken.push(u.text);
          w.__inGesture.push(navigator.userActivation?.isActive ?? true);
          if (m === "silent") return;
          setTimeout(() => u.onstart?.(new Event("start") as SpeechSynthesisEvent), 20);
          setTimeout(() => u.onend?.(new Event("end") as SpeechSynthesisEvent), 150);
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  }, mode);
}

const spoken = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __spoken: string[]; __inGesture: boolean[]; __cancels: number };
    return { spoken: w.__spoken, inGesture: w.__inGesture, cancels: w.__cancels };
  });

test("(d) Read aloud: no server voice → the browser voice speaks right in the tap (no /tts round trip)", async ({ page, request }) => {
  await stubSpeech(page, "speaks");
  const { sessionId, gap } = await seeded(request, "Phase 5 — read aloud");
  // The page already knows there is no server voice (AI_PROVIDER=fake has none): the first tap
  // must not wait for a 503 before speaking — iPad Safari only speaks from inside the tap.
  let ttsRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/tts")) ttsRequests++;
  });
  await page.goto(`/review/${sessionId}`);
  await openMoment(page, gap.id);
  const text = (await page.getByTestId("help-reexplain").textContent())!.trim();
  expect(text.length).toBeGreaterThan(20);

  const button = page.getByTestId("read-aloud");
  await button.click();
  await expect.poll(async () => (await spoken(page)).spoken).toEqual([text]);
  expect((await spoken(page)).inGesture).toEqual([true]);
  await expect(page.getByTestId("read-aloud-voice")).toHaveText("Voice: Browser voice");
  // Normal flow: onstart keeps it speaking past the watchdog, onend returns to idle.
  await expect(button).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("read-aloud-hint")).toHaveCount(0);
  expect(ttsRequests).toBe(0);
});

test("(d2) Read aloud: speech that never starts → an error hint within ~1 s, not a stuck “Stop reading”", async ({ page, request }) => {
  await stubSpeech(page, "silent");
  const { sessionId, gap } = await seeded(request, "Phase 5 — read aloud watchdog");
  await page.goto(`/review/${sessionId}`);
  await openMoment(page, gap.id);
  await expect(page.getByTestId("help-reexplain")).toBeVisible();

  const button = page.getByTestId("read-aloud");
  const clickedAt = Date.now();
  await button.click();
  await expect(button).toHaveAttribute("data-state", "error", { timeout: 1_500 });
  expect(Date.now() - clickedAt).toBeLessThan(1_500);
  await expect(page.getByTestId("read-aloud-hint")).toHaveText("Voice unavailable on this device.");
  await expect(button).toHaveText("Read aloud");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  const after = await spoken(page);
  expect(after.spoken).toHaveLength(1);
  expect(after.cancels).toBeGreaterThanOrEqual(1); // the stuck utterance was cancelled

  // Tapping again tries again, inside the new tap.
  await button.click();
  await expect(button).toHaveAttribute("data-state", "speaking");
  await expect(page.getByTestId("read-aloud-hint")).toHaveCount(0);
  await expect.poll(async () => (await spoken(page)).spoken.length).toBe(2);
  await expect(button).toHaveAttribute("data-state", "error", { timeout: 1_500 });
});

test("(e) new routes: 403 cross-site, 413 oversized, 404 unknown moment, 400 bad input", async ({ request }) => {
  const { sessionId, corrected, gap } = await seeded(request, "Phase 5 — guards");
  const url = (id: string, route: string) => `/api/events/${encodeURIComponent(id)}/${route}`;
  const evil = { origin: "https://evil.example" };

  // Cross-site: refused before anything runs.
  expect((await request.post(url(gap.id, "help"), { headers: evil })).status()).toBe(403);
  expect((await request.post(url(gap.id, "check"), { data: { choiceIdx: 0 }, headers: evil })).status()).toBe(403);
  expect((await request.post(url(corrected.id, "read-revision"), { data: { beforePng: PNG, afterPng: PNG }, headers: evil })).status()).toBe(403);
  expect((await request.post(url(gap.id, "tts"), { headers: evil })).status()).toBe(403);
  expect((await storedEvent(request, sessionId, gap.id)).event.checkAttempts).toEqual([]);

  // Oversized bodies.
  expect((await request.post(url(gap.id, "help"), { data: { pad: "x".repeat(4096) } })).status()).toBe(413);
  expect((await request.post(url(gap.id, "check"), { data: { choiceIdx: 0, pad: "x".repeat(1024) } })).status()).toBe(413);
  expect((await request.post(url(gap.id, "tts"), { data: { pad: "x".repeat(4096) } })).status()).toBe(413);
  expect((await request.post(url(corrected.id, "read-revision"), { data: { beforePng: PNG, afterPng: PNG, pad: "x".repeat(700_000) } })).status()).toBe(
    413,
  );
  const bigPng = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(210 * 1024)]).toString("base64")}`;
  expect((await request.post(url(corrected.id, "read-revision"), { data: { beforePng: bigPng, afterPng: PNG } })).status()).toBe(413);

  // Unknown moment.
  expect((await request.post(url("nope", "help"))).status()).toBe(404);
  expect((await request.post(url("nope", "check"), { data: { choiceIdx: 1 } })).status()).toBe(404);
  expect((await request.post(url("nope", "read-revision"), { data: { beforePng: PNG, afterPng: PNG } })).status()).toBe(404);
  expect((await request.post(url("nope", "tts"))).status()).toBe(404);

  // Bad input.
  for (const choiceIdx of [4, -1, 1.5, "1", null]) {
    expect((await request.post(url(gap.id, "check"), { data: { choiceIdx } })).status()).toBe(400);
  }
  expect((await request.post(url(gap.id, "check"), { data: {} })).status()).toBe(400);
  expect((await request.post(url(corrected.id, "read-revision"), { data: { beforePng: "data:image/svg+xml;base64,PHN2Zz4=", afterPng: PNG } })).status()).toBe(400);
  expect((await request.post(url(gap.id, "read-revision"), { data: { beforePng: PNG, afterPng: PNG } })).status()).toBe(400); // no revision
  // Answering before there is a question: 409.
  expect((await request.post(url(gap.id, "check"), { data: { choiceIdx: 0 } })).status()).toBe(409);

  // A same-origin help request works, never includes the answer, and TTS then says "no voice" (503).
  const help = await request.post(url(gap.id, "help"));
  expect(help.status()).toBe(200);
  const body = (await help.json()) as { help: { mcq: { options: string[] } } };
  expect(body.help.mcq.options).toHaveLength(4);
  expect(JSON.stringify(body)).not.toMatch(/answerIdx|"why"/);
  expect((await request.post(url(gap.id, "tts"))).status()).toBe(503);
});

test.describe("(f) without an AI key", () => {
  // Same server, AI switched off for these requests (test-only header, ignored in production).
  test.use({ extraHTTPHeaders: AI_OFF });

  test("shows the quiet “needs an API key” card and everything else keeps working", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { sessionId, corrected, gap } = await seeded(request, "Phase 5 — no key");
    let aiCalls = 0;
    page.on("request", (r) => {
      if (/\/api\/events\/[^/]+\/(help|read-revision|tts)$/.test(new URL(r.url()).pathname)) aiCalls++;
    });

    await page.goto(`/review/${sessionId}`);
    await openMoment(page, corrected.id);
    const nokey = page.getByTestId("help-nokey");
    await expect(nokey).toHaveText("AI explanations need an API key — add OPENAI_API_KEY to .env.local");
    await expect(page.getByTestId("help-card")).toHaveCount(0);
    await expect(page.getByTestId("revision-reading")).toHaveCount(0);
    // The rest of the panel works.
    await expect(page.getByTestId("replay")).toBeVisible();
    await expect(page.getByTestId("before-canvas")).toBeVisible();
    await showInPanel(page, "help-nokey");
    await page.screenshot({ path: "screenshots/phase5-nokey.png", animations: "disabled" });

    await openMoment(page, gap.id);
    await expect(page.getByTestId("help-nokey")).toBeVisible();
    await page.getByTestId("self-resolve").click();
    await expect(page.getByTestId("moment-status")).toHaveText("Resolved");
    expect(aiCalls).toBe(0);

    const res = await request.post(`/api/events/${encodeURIComponent(gap.id)}/help`);
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: "AI not configured" });
    expect(errors).toEqual([]);
  });
});
