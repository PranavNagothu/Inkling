import { expect, test } from "@playwright/test";

// Live lecture in DEMO_MODE (the public demo, on the production build): the option is shown with a
// note, and the server refuses to create Live lectures or take audio, so a public demo can't
// collect recordings or fill its disk.

test.use({ viewport: { width: 1180, height: 820 } });

test("DEMO_MODE: Live lecture is shown but disabled, and the server refuses it", async ({ page, request }) => {
  await page.goto("/app");
  await expect(page.getByTestId("live-lecture-note")).toHaveText("Live lecture is available when you run Inkling yourself.");
  await expect(page.getByTestId("live-start")).toBeDisabled();
  await expect(page.getByTestId("live-title")).toBeDisabled();

  const res = await request.post("/api/lectures/live", { data: { title: "Should not exist" } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "Live lecture is available when you run Inkling yourself." });
  const cues = await request.post("/api/lectures/demo-chain-rule/cues", { data: { cues: [] } });
  expect(cues.status()).toBe(403);
  const audio = await request.post("/api/lectures/demo-chain-rule/recording?durationMs=1000", {
    headers: { "content-type": "audio/webm" },
    data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]),
  });
  expect(audio.status()).toBe(403);

  const { lectures } = (await (await request.get("/api/lectures")).json()) as { lectures: Array<{ title: string }> };
  expect(lectures.some((l) => l.title === "Should not exist")).toBe(false);

  await page.goto("/about");
  await expect(page.getByTestId("about-microphone")).toHaveAttribute("data-live", "false");
});

// Uploads and Whisper in DEMO_MODE: nothing a stranger sends is stored, and nothing spends AI
// credits (GROQ_API_KEY may be set on the public host for the landing assistant alone).
test("DEMO_MODE: lecture upload, Notability PDF import and auto-transcribe are disabled with a note", async ({ page, request }) => {
  const note = (what: string) => `${what} is available when you run Inkling yourself.`;

  const upload = await request.post("/api/lectures", {
    multipart: { title: "Should not exist", media: { name: "x.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFF0000WAVE") } },
  });
  expect(upload.status()).toBe(403);
  expect(await upload.json()).toEqual({ error: note("Adding a lecture") });

  const pdf = await request.post("/api/sessions/demo-maya-1/notability", {
    multipart: { file: { name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") } },
  });
  expect(pdf.status()).toBe(403);
  expect(await pdf.json()).toEqual({ error: note("Importing a Notability PDF") });

  const transcribe = await request.post("/api/lectures/demo-chain-rule/transcribe");
  expect(transcribe.status()).toBe(403);
  expect(await transcribe.json()).toEqual({ error: note("Auto-transcribe") });

  // The seeded PDF is still the current import.
  const current = (await (await request.get("/api/sessions/demo-maya-1/notability")).json()) as { import: { fileName: string } | null };
  expect(current.import?.fileName).toBe("Chain rule — Maya (Notability export).pdf");

  await page.goto("/lectures/new");
  await expect(page.getByTestId("upload-demo-note")).toHaveText(note("Adding a lecture"));
  await expect(page.getByTestId("media-input")).toBeDisabled();
  await expect(page.getByTestId("upload-submit")).toBeDisabled();

  await page.goto("/compare/demo-maya-1");
  await expect(page.getByTestId("notability-pdf-canvas").first()).toBeVisible();
  await expect(page.getByTestId("notability-replace-disabled")).toBeDisabled();
  await expect(page.getByTestId("notability-replace-disabled")).toHaveAttribute("title", note("Importing a Notability PDF"));

  // Session 2 has no PDF: the drop zone is shown, disabled, with the note.
  await page.goto("/compare/demo-maya-2");
  await expect(page.getByTestId("notability-demo-note")).toHaveText(note("Importing a Notability PDF"));
  await expect(page.getByTestId("notability-upload")).toBeDisabled();
  await expect(page.getByTestId("notability-dropzone")).toHaveAttribute("data-available", "false");
});
