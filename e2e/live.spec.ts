import { expect, test, type Page } from "@playwright/test";
import type { Lecture } from "../lib/types";

// Live lecture mode: capture an in-person lecture through the microphone. The browser's speech
// recognition and microphone are faked (a scripted recognizer; an oscillator as the mic), so the
// whole flow runs headless: create → Start → write → speech arrives → End → review shows what the
// lecture was saying at the corrected moment, from the live transcript.

test.use({ viewport: { width: 1280, height: 820 } });

type Box = { x: number; y: number; width: number; height: number };

/**
 * window.__speech: a fake SpeechRecognition that emits what the test says (interim, then final
 * 500 ms later), and can "end after silence" like Chrome. window.__mic counts getUserMedia calls;
 * window.__micStream is the fake microphone (an oscillator into a MediaStream destination).
 */
function installFakes({ speech }: { speech: boolean }) {
  type Ev = Event & { resultIndex?: number; results?: unknown; error?: string };
  const w = window as unknown as Record<string, unknown>;
  const state = { starts: 0, active: null as null | FakeRecognition, langs: [] as string[] };
  class FakeRecognition extends EventTarget {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((e: Ev) => void) | null = null;
    onerror: ((e: Ev) => void) | null = null;
    onend: ((e: Ev) => void) | null = null;
    private on = false;
    start() {
      if (this.on) throw new DOMException("already started", "InvalidStateError");
      this.on = true;
      state.starts++;
      state.langs.push(this.lang);
      state.active = this;
    }
    stop() {
      this.end();
    }
    abort() {
      this.end();
    }
    end() {
      if (!this.on) return;
      this.on = false;
      if (state.active === this) state.active = null;
      setTimeout(() => {
        const e = new Event("end") as Ev;
        this.onend?.(e);
        this.dispatchEvent(e);
      }, 0);
    }
    emit(text: string, isFinal: boolean) {
      const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal });
      const e = new Event("result") as Ev;
      e.resultIndex = 0;
      e.results = [result];
      this.onresult?.(e);
    }
  }
  if (speech) {
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  } else {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
  }
  w.__speech = {
    state,
    say(text: string) {
      const rec = state.active;
      if (!rec) return false;
      rec.emit(text.split(" ").slice(0, 2).join(" "), false);
      setTimeout(() => rec.emit(text, true), 500);
      return true;
    },
    silence() {
      state.active?.end();
    },
  };
  w.__mic = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    w.__mic = (w.__mic as number) + 1;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    w.__micStream = dest.stream;
    return dest.stream;
  };
}

const say = async (page: Page, text: string) =>
  expect.poll(() => page.evaluate((t) => (window as unknown as { __speech: { say: (t: string) => boolean } }).__speech.say(t), text)).toBe(true);
const micCalls = (page: Page) => page.evaluate(() => (window as unknown as { __mic: number }).__mic);
const recognizerStarts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __speech: { state: { starts: number } } }).__speech.state.starts);

async function drawWord(page: Page, box: Box, x0: number, x1: number, y: number, amp = 8) {
  await page.mouse.move(box.x + x0, box.y + y);
  await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + x0 + ((x1 - x0) * i) / steps, box.y + y + amp * Math.sin(i * 0.9));
  }
  await page.mouse.up();
}

async function drawZigzag(page: Page, box: Box, x0: number, x1: number, y0: number, y1: number, passes = 8) {
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  for (let p = 1; p <= passes; p++) {
    await page.mouse.move(box.x + (p % 2 ? x1 : x0), box.y + y0 + ((y1 - y0) * p) / passes, { steps: 6 });
  }
  await page.mouse.up();
}

async function expectCounts(page: Page, total: number, live: number, ghost: number) {
  const canvas = page.getByTestId("ink-canvas");
  await expect(canvas).toHaveAttribute("data-stroke-count", String(total));
  await expect(canvas).toHaveAttribute("data-visible-count", String(live));
  await expect(canvas).toHaveAttribute("data-erased-count", String(ghost));
}

async function createLiveViaApi(page: Page, title: string) {
  const res = await page.request.post("/api/lectures/live", { data: { title } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { lecture: Lecture; session: { id: string } };
}

test("live lecture: create → Start → write → speech arrives → End → review shows what the lecture was saying", async ({ page }) => {
  await page.addInitScript(installFakes, { speech: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/app");
  await expect(page.getByTestId("live-lecture-note")).toContainText("only in Live lecture mode, after you press Start");
  await page.getByTestId("live-title").fill("Related rates — live");
  await page.getByTestId("live-start").click();
  await page.waitForURL(/\/session\/[^/]+$/);
  const sessionId = page.url().split("/session/")[1];

  // Nothing is asked of the microphone until Start.
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("mic-pill")).toHaveText("Ready");
  await expect(page.getByTestId("live-note")).toContainText("Speech is transcribed by your browser’s speech service.");
  await expect(page.getByTestId("live-transcript")).toBeVisible();
  await expect(page.getByTestId("lecture-media")).toHaveCount(0);
  expect(await micCalls(page)).toBe(0);
  await expect(page.getByTestId("lecture-time")).toHaveText("00:00");

  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "listening");
  await expect(page.getByTestId("mic-pill")).toContainText("Listening");
  await expect(page.getByTestId("live-note")).toContainText("Microphone on");
  expect(await micCalls(page)).toBe(1);
  await expect.poll(() => recognizerStarts(page)).toBe(1);

  const box = (await page.getByTestId("ink-canvas").boundingBox())!;
  await say(page, "a ladder ten feet long rests against a wall");
  await expect(page.getByTestId("live-cue")).toHaveCount(1);
  await expect(page.getByTestId("live-cue").first()).toContainText("a ladder ten feet long rests against a wall");

  await drawWord(page, box, 200, 360, 200);
  await expectCounts(page, 1, 1, 0);
  // The clock runs so the scribble lands >= 3 s after the word (a correction, not a slip).
  await page.waitForTimeout(3500);
  await say(page, "differentiate both sides with respect to time");
  await expect(page.getByTestId("live-cue")).toHaveCount(2);
  await drawZigzag(page, box, 190, 370, 186, 214);
  await expectCounts(page, 2, 0, 2);
  await drawWord(page, box, 205, 355, 204, 6);
  await expectCounts(page, 3, 1, 2);

  // Chrome ends recognition after silence: it starts again on its own.
  await page.evaluate(() => (window as unknown as { __speech: { silence: () => void } }).__speech.silence());
  await expect.poll(() => recognizerStarts(page)).toBe(2);
  await say(page, "so the rate of change is negative");
  await expect(page.getByTestId("live-cue")).toHaveCount(3);
  await expect(page.getByTestId("scribble-toast")).toHaveCount(0, { timeout: 10_000 });
  await page.mouse.move(box.x + 600, box.y + 500);
  await page.screenshot({ path: "screenshots/live/capture-desktop.png", animations: "disabled" });

  // Pause: the clock stops and recognition is not restarted.
  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "paused");
  const frozen = await page.getByTestId("lecture-time").textContent();
  await page.waitForTimeout(1300);
  await expect(page.getByTestId("lecture-time")).toHaveText(frozen!);
  expect(await recognizerStarts(page)).toBe(2);
  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "listening");
  expect(await micCalls(page)).toBe(1); // the same microphone, not asked again

  // Cues reach the server while the lecture runs.
  await expect
    .poll(async () => {
      const { lectures } = (await (await page.request.get("/api/lectures")).json()) as { lectures: Lecture[] };
      return lectures.find((l) => l.title === "Related rates — live")?.wordCount ?? 0;
    })
    .toBeGreaterThanOrEqual(23);

  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${sessionId}$`));
  // Every microphone track is stopped.
  expect(
    await page.evaluate(() =>
      (window as unknown as { __micStream: MediaStream }).__micStream.getTracks().every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);

  // The lecture now has its transcript and recording: it plays back like an uploaded one.
  const { lectures } = (await (await page.request.get("/api/lectures")).json()) as { lectures: Lecture[] };
  const lecture = lectures.find((l) => l.title === "Related rates — live")!;
  expect(lecture).toMatchObject({ transcriptSource: "live", wordCount: 23, mediaType: "audio" });
  expect(lecture.live).toBeUndefined();
  expect(lecture.durationMs).toBeGreaterThan(4000);
  const media = await page.request.get(`/api/lectures/${lecture.id}/media`);
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toMatch(/^audio\/(webm|mp4)/);

  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  const corrected = page.locator('[data-testid="timeline-marker"][data-type="misconception_corrected"]');
  await expect(corrected).toHaveCount(1);
  await corrected.first().click();
  await expect(page.getByTestId("moment-detail")).toBeVisible();
  await expect(page.getByText("What the lecture was saying")).toBeVisible();
  await expect(page.getByTestId("moment-excerpt")).toContainText("differentiate both sides with respect to time");
  // Replay 20 s plays the microphone recording.
  await page.getByTestId("replay").click();
  await expect
    .poll(() => page.getByTestId("lecture-media").evaluate((el) => (el as HTMLMediaElement).currentTime), { timeout: 10_000 })
    .toBeGreaterThan(0.3);
  await expect(page.getByTestId("media-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("live capture screen at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(installFakes, { speech: true });
  const { session } = await createLiveViaApi(page, "Phone — live");
  await page.goto(`/session/${session.id}`);
  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "listening");
  await say(page, "eigenvalues are the scalars that stretch an eigenvector");
  await expect(page.getByTestId("live-cue")).toHaveCount(1);
  // No horizontal scroll on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "screenshots/live/capture-390.png", animations: "disabled" });
  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "paused");
});

test("unsupported browser: a clear message, and notes still work without a transcript", async ({ page }) => {
  await page.addInitScript(installFakes, { speech: false });
  const { session } = await createLiveViaApi(page, "No speech API — live");
  await page.goto(`/session/${session.id}`);
  await expect(page.getByTestId("live-note")).toContainText("This browser can’t transcribe speech");
  await expect(page.getByTestId("live-transcript-empty")).toContainText("No live transcript in this browser");
  await expect(page.getByTestId("live-language")).toBeDisabled();

  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("mic-pill")).toHaveAttribute("data-state", "listening");
  const box = (await page.getByTestId("ink-canvas").boundingBox())!;
  await drawWord(page, box, 200, 360, 200);
  await expectCounts(page, 1, 1, 0);
  // Timed from Start: the stroke carries session-clock milliseconds.
  await page.getByTestId("end-session").click();
  await page.waitForURL(new RegExp(`/review/${session.id}$`));
  const data = (await (await page.request.get(`/api/sessions/${session.id}`)).json()) as { strokes: Array<{ startMs: number }> };
  expect(data.strokes).toHaveLength(1);
  expect(data.strokes[0].startMs).toBeGreaterThan(0);
});
