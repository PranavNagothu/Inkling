import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Lecture, TimelineData, TranscriptWord } from "../lib/types";
import { SCENARIO_TIMES, buildPhase2Scenario } from "./fixtures/phase2-scenario";
import { captionsFromWords } from "./fixtures/phase6-scenario";

// Social impact (Aramco track) + MLH ElevenLabs/Gemini: multilingual re-teach for ESL students and
// the spoken session recap. Runs against the dev server's deterministic fake provider
// (AI_PROVIDER=fake): a "translation" is the English text tagged "[es] …", options in the same
// order, so the right answer is still found by its English text. No server voice in tests, so
// Read aloud / the recap speak with the browser voice — stubbed here to record what was spoken.
//
// Runs in the "ai" Playwright project (AI on; no `x-inkling-ai: off` header).
test.use({ viewport: { width: 1180, height: 820 } });

const RIGHT = "Multiply by the derivative of the inside";
const WAV = readFileSync("public/demo/lecture.wav");
const DEMO_WORDS = JSON.parse(readFileSync("public/demo/lecture.transcript.json", "utf8")) as TranscriptWord[];
const VTT = Buffer.from(captionsFromWords(DEMO_WORDS));

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

/** Its own lecture copy + a session with the Phase 2 scenario (a correction at 02:30, a gap at 03:40), analysed. */
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

/** A speechSynthesis that records what it was asked to say (text + lang) and "speaks" instantly. */
async function stubSpeech(page: Page) {
  await page.addInitScript(() => {
    const spoken: Array<{ text: string; lang: string }> = [];
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      onstart: ((e: unknown) => void) | null = null;
      onboundary: ((e: unknown) => void) | null = null;
      onend: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: FakeUtterance });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        pending: false,
        cancel() {},
        getVoices: () => [],
        speak(u: FakeUtterance) {
          spoken.push({ text: u.text, lang: u.lang });
          setTimeout(() => {
            u.onstart?.({});
            setTimeout(() => u.onend?.({}), 50);
          }, 10);
        },
      },
    });
  });
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: Array<{ text: string; lang: string }> }).__spoken);

test("multilingual re-teach: Spanish persists across a reload, and the answer is still graded", async ({ page, request }) => {
  const { sessionId, gap } = await seeded(request, "Impact — Spanish help");
  await page.goto(`/review/${sessionId}?moment=${gap.id}`);
  await expect(page.getByTestId("help-reexplain")).toBeVisible();
  await expect(page.getByTestId("help-reexplain")).not.toContainText("[es]");
  await expect(page.getByTestId("help-language")).toHaveValue("en");

  await page.getByTestId("help-language").selectOption("es");
  await expect(page.getByTestId("help-reexplain")).toContainText("[es] ");
  await expect(page.getByTestId("check-question")).toContainText("[es] ");
  await expect(page.getByTestId("help-language-note")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("help-language")).toHaveValue("es");
  await expect(page.getByTestId("help-reexplain")).toContainText("[es] ");

  // Same order as the English card → the English answerIdx grades it; "why" comes back in Spanish.
  await page.getByTestId("check-option").filter({ hasText: RIGHT }).click();
  await page.getByTestId("check-submit").click();
  const feedback = page.getByTestId("check-feedback");
  await expect(feedback).toHaveAttribute("data-result", "correct");
  await expect(feedback).toContainText("[es] ");

  // The client never sees the answer before answering, in any language.
  const help = await request.post(`/api/events/${gap.id}/help`, { data: { language: "es" } });
  expect(help.status()).toBe(200);
  const body = (await help.json()) as { help: { mcq: Record<string, unknown> }; language: string };
  expect(body.language).toBe("es");
  expect(body.help.mcq).not.toHaveProperty("answerIdx");
  expect(body.help.mcq).not.toHaveProperty("why");
  expect((await request.post(`/api/events/${gap.id}/help`, { data: { language: "xx" } })).status()).toBe(400);
});

test("audio recap: shows the transcript and speaks it (browser voice), in the chosen language", async ({ page, request }) => {
  const { sessionId, corrected } = await seeded(request, "Impact — recap");
  await stubSpeech(page);
  await page.goto(`/review/${sessionId}`);

  const recap = page.getByTestId("session-recap");
  await expect(recap).toBeVisible();
  const play = recap.getByTestId("recap-play");
  await expect(play).toBeEnabled();
  await play.click();
  const text = recap.getByTestId("recap-text");
  await expect(text).toContainText("Here’s your recap");
  await expect(text).toContainText("1 correction, 1 gap and no breakthroughs");
  await expect.poll(async () => (await spoken(page)).length).toBe(1);
  const [first] = await spoken(page);
  expect(first.text).toBe(await text.innerText());
  expect(first.lang).toBe("en-US");
  await expect(play).toHaveAttribute("data-state", "idle");

  // Choosing Spanish on a moment re-voices the recap too.
  await page.locator(`[data-testid="timeline-marker"][data-event-id="${corrected.id}"]`).click();
  await page.getByTestId("help-language").selectOption("es");
  await expect(text).toContainText("[es] ");
  await play.click();
  await expect.poll(async () => (await spoken(page)).length).toBe(2);
  expect((await spoken(page))[1].lang).toBe("es-US");
  expect((await spoken(page))[1].text.startsWith("[es] ")).toBe(true);
});

test("recap route: same-origin only, body limits, unknown session, language whitelist", async ({ request, baseURL }) => {
  const { sessionId } = await seeded(request, "Impact — recap route");
  const url = `/api/sessions/${sessionId}/recap`;

  const ok = await request.post(url, { data: { language: "hi" } });
  expect(ok.status()).toBe(200);
  const body = (await ok.json()) as { text: string; language: string; audioUrl?: string };
  expect(body.language).toBe("hi");
  expect(body.text.length).toBeGreaterThan(0);
  expect(body.audioUrl).toBeUndefined(); // no server voice in tests

  expect((await request.post(url, { data: { language: "en" }, headers: { origin: "https://evil.example" } })).status()).toBe(403);
  expect((await request.post(url, { headers: { origin: baseURL! }, data: { language: "en" } })).status()).toBe(200);
  expect(
    (await request.post(url, { headers: { "content-type": "application/json" }, data: JSON.stringify({ language: "en", pad: "x".repeat(2000) }) })).status(),
  ).toBe(413);
  expect((await request.post(url, { data: { language: "klingon" } })).status()).toBe(400);
  expect((await request.post("/api/sessions/does-not-exist/recap", { data: {} })).status()).toBe(404);
  // No voice configured: the audio endpoint says so (the client then uses the browser voice).
  expect((await request.post(`${url}/audio`, { data: { language: "en" } })).status()).toBe(503);
  expect((await request.post(`${url}/audio`, { data: { language: "en" }, headers: { origin: "https://evil.example" } })).status()).toBe(403);
});
