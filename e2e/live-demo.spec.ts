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
