import { existsSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { NotabilityImport, TimelineData } from "../lib/types";
import { buildPhase2Scenario } from "./fixtures/phase2-scenario";

// Phase 7: "Notability keeps the final page. Here's what it hides." Upload a Notability PDF export
// for a session and compare it with the process Inkling kept.

test.use({ viewport: { width: 1180, height: 820 } });

const PDF_DIR = "data/e2e-uploads/notability";

/** A small, valid two-page "Notability export" with visible ink on each page. */
async function makePdf(pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Chain rule notes - page ${i}`, { x: 60, y: 720, size: 28, font, color: rgb(0.1, 0.1, 0.1) });
    for (let line = 0; line < 12; line++) {
      page.drawLine({ start: { x: 60, y: 660 - line * 40 }, end: { x: 552, y: 660 - line * 40 }, thickness: 1, color: rgb(0.8, 0.85, 0.9) });
    }
    page.drawRectangle({ x: 60, y: 200 + i * 40, width: 220, height: 90, color: rgb(0.12, 0.31, 0.51) });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function seedSession(request: APIRequestContext, title: string) {
  const created = await request.post("/api/sessions", { data: { title } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const { strokes, eraseEvents } = buildPhase2Scenario(session.id);
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);
  return session.id;
}

async function uploadPdf(request: APIRequestContext, sessionId: string, file: { name: string; mimeType: string; buffer: Buffer }, headers?: Record<string, string>) {
  return request.post(`/api/sessions/${sessionId}/notability`, { multipart: { file }, headers });
}

/** POSTs a tiny multipart body that declares a much larger Content-Length; resolves with the reply. */
function declaredLengthPost(url: string, declared: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(declared) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    // The server answers without reading the body; a reset afterwards is expected.
    req.on("error", (err) => (req.writableEnded ? undefined : reject(err)));
    req.write("--x\r\n");
  });
}

/** Pixels that are clearly not white paper (i.e. something was drawn). */
async function inkedPixels(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    if (c.width === 0 || c.height === 0) return 0;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] + d[i + 1] + d[i + 2] < 600) n++;
    return n;
  });
}

/** Pixels in the teal ghost ink (#0d9488, drawn at 50 % over transparent). */
async function ghostPixels(page: Page) {
  return page.getByTestId("process-canvas").evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 30 && d[i] < 100 && d[i + 1] > 110 && d[i + 2] < d[i + 1] + 8 && d[i + 1] - d[i] > 60) n++;
    return n;
  });
}

test("review → Compare → empty state → upload a PDF → it renders, with page navigation", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — compare");
  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("compare-link").click();
  await page.waitForURL(new RegExp(`/compare/${sessionId}$`));

  // Empty state: explanation, export steps, drop zone; overlay needs a PDF first.
  await expect(page.getByRole("heading", { name: "What the final page hides" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add your Notability page" })).toBeVisible();
  await expect(page.getByRole("list", { name: "How to export from Notability" })).toHaveText(/Share\s*→\s*Export\s*→\s*PDF/);
  await expect(page.getByTestId("notability-pdf")).toHaveCount(0);
  await expect(page.getByTestId("mode-overlay")).toBeDisabled();
  await expect(page.getByTestId("hidden-stats")).toHaveAttribute("data-status", "ready");
  await page.screenshot({ path: "screenshots/phase7-empty.png", animations: "disabled" });

  await page.getByTestId("notability-upload").setInputFiles({ name: "Chain rule.pdf", mimeType: "application/pdf", buffer: await makePdf(2) });
  const pdf = page.getByTestId("notability-pdf");
  await expect(pdf).toHaveAttribute("data-rendered", "true");
  await expect(pdf).toHaveAttribute("data-page-count", "2");
  await expect.poll(() => inkedPixels(page, "notability-pdf-canvas")).toBeGreaterThan(2000);
  await expect(page.getByText("Chain rule.pdf")).toBeVisible();

  // Page navigation.
  await expect(page.getByTestId("pdf-page-label")).toHaveText("Page 1 of 2");
  await expect(page.getByTestId("pdf-prev")).toBeDisabled();
  await page.getByTestId("pdf-next").click();
  await expect(pdf).toHaveAttribute("data-page", "2");
  await expect(pdf).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("pdf-page-label")).toHaveText("Page 2 of 2");
  await expect(page.getByTestId("pdf-next")).toBeDisabled();
  await page.getByTestId("pdf-prev").click();
  await expect(pdf).toHaveAttribute("data-page", "1");
  await expect(pdf).toHaveAttribute("data-rendered", "true");
  await page.screenshot({ path: "screenshots/phase7-compare.png", animations: "disabled" });

  // It's stored: a reload shows it straight away, and the file route serves it safely.
  await page.reload();
  await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-rendered", "true");
  const meta = (await (await request.get(`/api/sessions/${sessionId}/notability`)).json()) as { import: NotabilityImport };
  expect(meta.import).toMatchObject({ fileName: "Chain rule.pdf", pageCount: 2, current: true });
  const file = await request.get(`/api/sessions/${sessionId}/notability/file`);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("application/pdf");
  expect(file.headers()["x-content-type-options"]).toBe("nosniff");
  expect(file.headers()["content-disposition"]).toBe(`inline; filename="Chain rule.pdf"; filename*=UTF-8''Chain%20rule.pdf`);
  expect((await file.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Replacing keeps history but serves the newest (a one-page export).
  await page.getByTestId("notability-replace").setInputFiles({ name: "Chain rule v2.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
  await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-page-count", "1");
  await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("pdf-page-label")).toHaveCount(0);
  expect(readdirSync(PDF_DIR).filter((f) => /^[0-9a-f-]{36}\.pdf$/.test(f)).length).toBeGreaterThanOrEqual(2);
});

test("the process view shows ghost ink and moment markers; stats match the review; a marker opens its moment", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — process");
  const analysis = (await (await request.post(`/api/sessions/${sessionId}/analyze`)).json()) as TimelineData;
  expect(analysis.events.map((e) => e.type)).toEqual(["misconception_corrected", "unresolved_gap"]);

  // Counts on the review page…
  await page.goto(`/review/${sessionId}`);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-status", "ready");
  const review = {
    erased: await page.getByTestId("count-erased").textContent(),
    corrections: await page.getByTestId("count-corrected").textContent(),
    gaps: await page.getByTestId("count-gaps").textContent(),
    breakthroughs: await page.getByTestId("count-breakthroughs").textContent(),
  };
  expect(review).toEqual({ erased: "3", corrections: "1", gaps: "1", breakthroughs: "0" });

  // …match what the compare page says the final page hides.
  await page.goto(`/compare/${sessionId}`);
  const stats = page.getByTestId("hidden-stats");
  await expect(stats).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("hidden-erased")).toHaveText(review.erased!);
  await expect(page.getByTestId("hidden-corrections")).toHaveText(review.corrections!);
  await expect(page.getByTestId("hidden-gaps")).toHaveText(review.gaps!);
  await expect(page.getByTestId("hidden-breakthroughs")).toHaveText(review.breakthroughs!);

  const process = page.getByTestId("inkling-process");
  await expect(process).toHaveAttribute("data-ghost", "on");
  await expect(process).toHaveAttribute("data-erased-count", "3");
  await expect.poll(() => ghostPixels(page)).toBeGreaterThan(50);
  const markers = page.getByTestId("process-marker");
  await expect(markers).toHaveCount(2);

  // The corrected marker sits on its revision's area of the page.
  const corrected = page.locator('[data-testid="process-marker"][data-type="misconception_corrected"]');
  const box = (await corrected.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  const panel = (await process.boundingBox())!;
  expect(box.x).toBeGreaterThan(panel.x - 1);
  expect(box.x + box.width).toBeLessThan(panel.x + panel.width + 1);

  const eventId = await corrected.getAttribute("data-event-id");
  expect(eventId).toBe(analysis.events.find((e) => e.type === "misconception_corrected")!.id);
  await corrected.click();
  await page.waitForURL(new RegExp(`/review/${sessionId}\\?moment=`));
  await expect(page.getByTestId("moment-detail")).toHaveAttribute("data-event-id", eventId!);

  // The moment panel's footer leads back to the comparison.
  await page.getByTestId("moment-compare-link").click();
  await page.waitForURL(new RegExp(`/compare/${sessionId}$`));
  await expect(page.getByTestId("inkling-process")).toBeVisible();
});

test("overlay mode: the divider reveals the process with mouse and keyboard", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — overlay");
  expect((await uploadPdf(request, sessionId, { name: "notes.pdf", mimeType: "application/pdf", buffer: await makePdf(2) })).status()).toBe(201);
  await page.goto(`/compare/${sessionId}`);
  await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-rendered", "true");

  // Switch layout with the keyboard (radio group: arrow keys).
  const mode = page.getByTestId("compare-mode");
  await expect(mode).toHaveAttribute("data-mode", "side");
  await page.getByTestId("mode-side").focus();
  await page.keyboard.press("ArrowRight");
  await expect(mode).toHaveAttribute("data-mode", "overlay");
  await expect(page.getByTestId("mode-overlay")).toBeFocused();

  const stage = page.getByTestId("compare-stage");
  const divider = page.getByTestId("overlay-divider");
  await expect(divider).toHaveAttribute("data-reveal", "50");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("hidden-stats")).toHaveAttribute("data-status", "ready");

  // The process is laid exactly over the drawn page, and the divider runs across that page.
  const layer = page.getByTestId("overlay-process");
  const pdfCanvas = (await page.getByTestId("notability-pdf-canvas").boundingBox())!;
  const p = (await layer.boundingBox())!;
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(p[k] - pdfCanvas[k])).toBeLessThan(1.5);
  const d = (await divider.boundingBox())!;
  expect(Math.abs(d.x + d.width / 2 - (p.x + p.width / 2))).toBeLessThan(1.5);

  // Drag with the mouse to a quarter of the way across the page.
  await page.mouse.move(d.x + d.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width * 0.25, p.y + p.height / 2, { steps: 8 });
  await page.mouse.up();
  const dragged = Number(await divider.getAttribute("data-reveal"));
  expect(Math.abs(dragged - 25)).toBeLessThan(1.5);
  await expect(stage).toHaveAttribute("data-reveal", String(dragged));
  const clip = await layer.evaluate((el) => (el as HTMLElement).style.clipPath);
  expect(clip).toBe(`inset(0px ${100 - dragged}% 0px 0px)`);

  // Keyboard: arrows step by 5, Home/End jump to the ends.
  await expect(divider).toBeFocused();
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("data-reveal", "0");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("data-reveal", "10");
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("data-reveal", "5");
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("data-reveal", "100");
  await page.keyboard.press("PageDown");
  await expect(divider).toHaveAttribute("data-reveal", "75");
  await expect(divider).toHaveAttribute("aria-valuetext", "75% of the process shown");

  await page.keyboard.press("Home");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("data-reveal", "60");
  await page.screenshot({ path: "screenshots/phase7-overlay.png", animations: "disabled" });
});

test.describe("upload guards", () => {
  test("rejects non-PDFs, cross-site and oversized uploads, and leaves nothing behind", async ({ page, request, baseURL }) => {
    const sessionId = await seedSession(request, "Chain rule — guards");
    const before = existsSync(PDF_DIR) ? readdirSync(PDF_DIR).length : 0;
    const text = Buffer.from("These are my notes, honestly a PDF.\n");
    const reject = async (status: number, res: Awaited<ReturnType<typeof uploadPdf>>) => {
      expect(res.status()).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    };

    await reject(400, await uploadPdf(request, sessionId, { name: "notes.txt", mimeType: "text/plain", buffer: text }));
    // A text file renamed to .pdf, even when it claims to be a PDF: the bytes decide.
    await reject(400, await uploadPdf(request, sessionId, { name: "notes.pdf", mimeType: "application/pdf", buffer: text }));
    await reject(400, await uploadPdf(request, sessionId, { name: "notes.pdf", mimeType: "text/plain", buffer: await makePdf(1) }));
    await reject(403, await uploadPdf(request, sessionId, { name: "notes.pdf", mimeType: "application/pdf", buffer: await makePdf(1) }, { Origin: "https://evil.example" }));
    // Oversized: refused from the declared Content-Length before the body is read (sent raw, since
    // Playwright's request context recomputes Content-Length).
    const oversized = await declaredLengthPost(`${baseURL}/api/sessions/${sessionId}/notability`, 60 * 1024 * 1024);
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatch(/at most 50 MB/);
    await reject(404, await uploadPdf(request, "no-such-session", { name: "notes.pdf", mimeType: "application/pdf", buffer: await makePdf(1) }));
    expect((await request.post(`/api/sessions/${sessionId}/notability`, { data: { file: "x" } })).status()).toBe(415);

    expect((await (await request.get(`/api/sessions/${sessionId}/notability`)).json()).import).toBeNull();
    expect((await request.get(`/api/sessions/${sessionId}/notability/file`)).status()).toBe(404);
    expect(existsSync(PDF_DIR) ? readdirSync(PDF_DIR).length : 0).toBe(before);

    // The page refuses a renamed text file before uploading anything.
    await page.goto(`/compare/${sessionId}`);
    await page.getByTestId("notability-upload").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: text });
    await expect(page.getByTestId("notability-upload-error")).toHaveText(/Choose a PDF/);
    await page.getByTestId("notability-upload").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: text });
    await expect(page.getByTestId("notability-upload-error")).toHaveText(/isn’t a PDF/);
    await expect(page.getByTestId("notability-pdf")).toHaveCount(0);
  });

  test("a corrupt PDF shows a friendly error, not a crash", async ({ page, request }) => {
    const sessionId = await seedSession(request, "Chain rule — corrupt");
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(`/compare/${sessionId}`);
    const corrupt = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4000, 0x41), Buffer.from("\n%%EOF\n")]);
    await page.getByTestId("notability-upload").setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: corrupt });

    const error = page.getByTestId("notability-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("data-kind", "invalid");
    await expect(error).toHaveText(/damaged or incomplete/);
    // The rest of the page still works, and a good PDF can be uploaded over it.
    await expect(page.getByTestId("inkling-process")).toBeVisible();
    await expect(page.getByTestId("mode-overlay")).toBeDisabled();
    await page.getByTestId("notability-upload").setInputFiles({ name: "fixed.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
    await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-rendered", "true");
    expect(pageErrors).toEqual([]);
  });
});

test("iPad portrait: both views stay usable", async ({ page, request }) => {
  const sessionId = await seedSession(request, "Chain rule — portrait");
  expect((await uploadPdf(request, sessionId, { name: "notes.pdf", mimeType: "application/pdf", buffer: await makePdf(1) })).status()).toBe(201);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto(`/compare/${sessionId}`);
  await expect(page.getByTestId("notability-pdf")).toHaveAttribute("data-rendered", "true");
  const pdf = (await page.getByTestId("notability-pdf").boundingBox())!;
  const proc = (await page.getByTestId("inkling-process").boundingBox())!;
  expect(pdf.width).toBeGreaterThan(300);
  expect(proc.width).toBeGreaterThan(300);
  // No horizontal scrolling.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
